'use strict';

const MAX_REQUESTS_PER_TAB = 800;
const tabStates = new Map();
const devtoolsPorts = new Map();

function createTabState() {
  return {
    requests: [],
    requestMap: new Map(),
    interceptQueue: [],
    interceptMode: 'off'
  };
}

function ensureTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, createTabState());
  }
  return tabStates.get(tabId);
}

function normalizeHeaders(headers) {
  if (!headers) return [];

  if (Array.isArray(headers)) {
    return headers
      .filter((header) => header && header.name)
      .map((header) => ({
        name: String(header.name),
        value: header.value == null ? '' : String(header.value)
      }));
  }

  if (typeof headers === 'object') {
    return Object.entries(headers).map(([name, value]) => ({
      name: String(name),
      value: value == null ? '' : String(value)
    }));
  }

  return [];
}

function serializeBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function parseWebRequestBody(requestBody) {
  if (!requestBody) return '';

  if (requestBody.formData) {
    try {
      return JSON.stringify(requestBody.formData);
    } catch {
      return '[form-data]';
    }
  }

  if (Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
    const totalBytes = requestBody.raw.reduce(
      (sum, item) => sum + (item.bytes ? item.bytes.byteLength || 0 : 0),
      0
    );
    return `[binary:${totalBytes}]`;
  }

  return '';
}

function cloneRequest(request) {
  return {
    ...request,
    requestHeaders: Array.isArray(request.requestHeaders)
      ? request.requestHeaders.map((header) => ({ ...header }))
      : [],
    responseHeaders: Array.isArray(request.responseHeaders)
      ? request.responseHeaders.map((header) => ({ ...header }))
      : []
  };
}

function cloneQueueItem(item) {
  return {
    requestId: item.requestId,
    status: item.status || 'pending',
    modifications: item.modifications || {},
    request: item.request ? cloneRequest(item.request) : null
  };
}

function trimRequests(state) {
  while (state.requests.length > MAX_REQUESTS_PER_TAB) {
    const removed = state.requests.shift();
    if (removed) {
      state.requestMap.delete(removed.id);
    }
  }
}

function getTabSnapshot(tabId) {
  const state = ensureTabState(tabId);
  return {
    requests: state.requests.map(cloneRequest),
    interceptQueue: state.interceptQueue.map(cloneQueueItem),
    interceptMode: state.interceptMode
  };
}

function notifyPanel(tabId, type, data) {
  const port = devtoolsPorts.get(tabId);
  if (!port) return;

  try {
    port.postMessage({ type, data });
  } catch {
    // Ignore disconnected ports.
  }
}

function sendMessageToTab(tabId, message) {
  if (typeof tabId !== 'number') return;

  chrome.tabs.sendMessage(tabId, message, () => {
    void chrome.runtime.lastError;
  });
}

function createBaseRequest(details) {
  return {
    id: String(details.requestId),
    url: details.url || '',
    method: details.method || 'GET',
    tabId: details.tabId,
    type: details.type || 'other',
    timestamp: Date.now(),
    startTime: performance.now(),
    requestHeaders: [],
    responseHeaders: [],
    requestBody: '',
    responseBody: '',
    statusCode: 0,
    statusText: '',
    duration: 0,
    size: 0,
    intercepted: false
  };
}

function upsertWebRequest(details) {
  const state = ensureTabState(details.tabId);
  const key = String(details.requestId);

  let request = state.requestMap.get(key);
  const isNew = !request;

  if (!request) {
    request = createBaseRequest(details);
    state.requestMap.set(key, request);
    state.requests.push(request);
    trimRequests(state);
  }

  request.url = details.url || request.url;
  request.method = details.method || request.method;
  request.type = details.type || request.type;
  request.tabId = details.tabId;
  request.duration = Math.max(0, performance.now() - request.startTime);

  return { state, request, isNew };
}

function applyInterceptMode(tabId, mode) {
  const normalizedMode = ['off', 'no-js', 'yes-js'].includes(mode) ? mode : 'off';
  const state = ensureTabState(tabId);
  state.interceptMode = normalizedMode;

  sendMessageToTab(tabId, {
    type: 'INTERCEPT_MODE_CHANGED',
    mode: normalizedMode
  });

  return normalizedMode;
}

function removeFromInterceptQueue(state, requestId) {
  state.interceptQueue = state.interceptQueue.filter(
    (item) => item.requestId !== requestId
  );
}

function applyForward(tabId, requestId, modifications) {
  const state = ensureTabState(tabId);
  const request = state.requestMap.get(requestId);

  if (request && modifications) {
    if (Array.isArray(modifications.requestHeaders)) {
      request.requestHeaders = modifications.requestHeaders;
    }

    if (Object.prototype.hasOwnProperty.call(modifications, 'requestBody')) {
      request.requestBody = serializeBody(modifications.requestBody);
    }

    notifyPanel(tabId, 'REQUEST_UPDATED', cloneRequest(request));
  }

  removeFromInterceptQueue(state, requestId);

  sendMessageToTab(tabId, {
    type: 'PROCEED_REQUEST',
    requestId,
    modifications: modifications || {}
  });
}

function applyDrop(tabId, requestId) {
  const state = ensureTabState(tabId);
  removeFromInterceptQueue(state, requestId);

  sendMessageToTab(tabId, {
    type: 'DROP_REQUEST',
    requestId
  });
}

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const { request, isNew } = upsertWebRequest(details);
      request.requestBody = parseWebRequestBody(details.requestBody);

      notifyPanel(details.tabId, isNew ? 'NEW_REQUEST' : 'REQUEST_UPDATED', cloneRequest(request));
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
  );

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const { request } = upsertWebRequest(details);
      request.requestHeaders = normalizeHeaders(details.requestHeaders);

      notifyPanel(details.tabId, 'REQUEST_UPDATED', cloneRequest(request));
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const { request } = upsertWebRequest(details);
      request.statusCode = details.statusCode || request.statusCode;
      request.statusText = details.statusLine || request.statusText;
      request.responseHeaders = normalizeHeaders(details.responseHeaders);

      notifyPanel(details.tabId, 'REQUEST_UPDATED', cloneRequest(request));
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const { request } = upsertWebRequest(details);
      request.statusCode = details.statusCode || request.statusCode;
      request.statusText = 'Completed';
      request.duration = Math.max(0, performance.now() - request.startTime);

      notifyPanel(details.tabId, 'REQUEST_UPDATED', cloneRequest(request));
    },
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const { request } = upsertWebRequest(details);
      request.statusCode = 0;
      request.statusText = details.error || 'Error';
      request.duration = Math.max(0, performance.now() - request.startTime);

      notifyPanel(details.tabId, 'REQUEST_UPDATED', cloneRequest(request));
    },
    { urls: ['<all_urls>'] }
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const actualTabId =
    typeof message.tabId === 'number' ? message.tabId : sender.tab && sender.tab.id;

  switch (message.type) {
    case 'GET_TAB_ID':
      sendResponse({ tabId: sender.tab && sender.tab.id });
      break;

    case 'GET_TAB_DATA':
      if (typeof actualTabId !== 'number') {
        sendResponse({ requests: [], interceptQueue: [], interceptMode: 'off' });
      } else {
        sendResponse(getTabSnapshot(actualTabId));
      }
      break;

    case 'INTERCEPT_REQUEST':
      {
        if (typeof actualTabId !== 'number' || !message.data || !message.data.requestId) {
          sendResponse({ intercepted: false, error: 'Invalid intercept payload' });
          break;
        }

        const state = ensureTabState(actualTabId);
        const requestId = String(message.data.requestId);

        let request = state.requestMap.get(requestId);
        if (!request) {
          request = {
            id: requestId,
            url: message.data.url || '',
            method: message.data.method || 'GET',
            tabId: actualTabId,
            type: message.data.type || 'intercepted',
            timestamp: Date.now(),
            startTime: performance.now(),
            requestHeaders: normalizeHeaders(message.data.headers),
            responseHeaders: [],
            requestBody: serializeBody(message.data.body),
            responseBody: '',
            statusCode: 0,
            statusText: 'Intercepted',
            duration: 0,
            size: 0,
            intercepted: true
          };

          state.requestMap.set(requestId, request);
          state.requests.push(request);
          trimRequests(state);
          notifyPanel(actualTabId, 'NEW_REQUEST', cloneRequest(request));
        } else {
          request.method = message.data.method || request.method;
          request.url = message.data.url || request.url;
          request.requestHeaders = normalizeHeaders(message.data.headers);
          request.requestBody = serializeBody(message.data.body);
          request.intercepted = true;
          request.statusText = 'Intercepted';
          notifyPanel(actualTabId, 'REQUEST_UPDATED', cloneRequest(request));
        }

        let queueItem = state.interceptQueue.find((item) => item.requestId === requestId);
        if (!queueItem) {
          queueItem = {
            requestId,
            status: 'pending',
            modifications: {},
            request
          };
          state.interceptQueue.push(queueItem);
        } else {
          queueItem.request = request;
        }

        notifyPanel(actualTabId, 'REQUEST_INTERCEPTED', {
          requestId,
          request: cloneRequest(request)
        });

        sendResponse({ intercepted: true });
      }
      break;

    case 'SET_INTERCEPT_MODE':
      if (typeof actualTabId !== 'number') {
        sendResponse({ ok: false, error: 'Missing tab id' });
      } else {
        const mode = applyInterceptMode(actualTabId, message.data && message.data.mode);
        sendResponse({ ok: true, mode });
      }
      break;

    case 'FORWARD_REQUEST':
      if (typeof actualTabId !== 'number' || !message.data || !message.data.requestId) {
        sendResponse({ ok: false });
      } else {
        applyForward(
          actualTabId,
          String(message.data.requestId),
          message.data.modifications || {}
        );
        sendResponse({ ok: true });
      }
      break;

    case 'DROP_REQUEST':
      if (typeof actualTabId !== 'number' || !message.data || !message.data.requestId) {
        sendResponse({ ok: false });
      } else {
        applyDrop(actualTabId, String(message.data.requestId));
        sendResponse({ ok: true });
      }
      break;

    case 'CLEAR_REQUESTS':
      if (typeof actualTabId === 'number') {
        const state = ensureTabState(actualTabId);
        state.requests = [];
        state.requestMap.clear();
        state.interceptQueue = [];
        notifyPanel(actualTabId, 'REQUESTS_CLEARED');
      }
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
      break;
  }

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  const match = /^devtools-(\d+)$/.exec(port.name);
  if (!match) {
    return;
  }

  const tabId = Number(match[1]);
  devtoolsPorts.set(tabId, port);
  ensureTabState(tabId);

  port.postMessage({
    type: 'INITIAL_STATE',
    data: getTabSnapshot(tabId)
  });

  port.onMessage.addListener((message) => {
    switch (message.type) {
      case 'SET_INTERCEPT_MODE':
        applyInterceptMode(tabId, message.data && message.data.mode);
        break;

      case 'FORWARD_REQUEST':
        if (message.data && message.data.requestId) {
          applyForward(tabId, String(message.data.requestId), message.data.modifications || {});
        }
        break;

      case 'DROP_REQUEST':
        if (message.data && message.data.requestId) {
          applyDrop(tabId, String(message.data.requestId));
        }
        break;

      case 'CLEAR_REQUESTS':
        {
          const state = ensureTabState(tabId);
          state.requests = [];
          state.requestMap.clear();
          state.interceptQueue = [];
          notifyPanel(tabId, 'REQUESTS_CLEARED');
        }
        break;

      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    const connectedPort = devtoolsPorts.get(tabId);
    if (connectedPort === port) {
      devtoolsPorts.delete(tabId);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  devtoolsPorts.delete(tabId);
});

console.log('[DevTools Pro] Background service worker ready');
