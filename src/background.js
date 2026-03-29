// DevTools Pro - Background Service Worker
// Manages network request monitoring, interception, and communication

const requestStorage = new Map(); // tabId -> { requests: [], interceptMode, pausedJs }
const devtoolsConnections = new Map(); // tabId -> port

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
      name,
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

function buildInterceptedRequest(tabId, data) {
  return {
    id: data.requestId,
    url: data.url || '',
    method: data.method || 'GET',
    tabId,
    type: data.type || 'intercepted',
    timestamp: Date.now(),
    startTime: performance.now(),
    requestHeaders: normalizeHeaders(data.headers),
    responseHeaders: [],
    statusCode: 0,
    statusText: '',
    requestBody: serializeBody(data.body),
    responseBody: '',
    size: 0,
    duration: 0,
    intercepted: true
  };
}

/**
 * Initialize tab data structure
 */
function initTabData(tabId) {
  if (!requestStorage.has(tabId)) {
    requestStorage.set(tabId, {
      requests: [],
      requestMap: new Map(), // requestId -> fullRequest
      interceptMode: 'off', // 'off', 'no-js', 'yes-js'
      interceptQueue: [], // requestIds waiting for user action
      pausedJs: false
    });
  }
  return requestStorage.get(tabId);
}

/**
 * Listen to webRequest events for network monitoring
 * Note: In Manifest V3, webRequest is inspection-only
 */
if (chrome.webRequest) {
  chrome.webRequest.onBeforeSendHeaders?.addListener(
    (details) => {
      if (details.tabId < 0) return; // Skip non-tab requests

      const tabData = initTabData(details.tabId);
      const requestData = {
        id: details.requestId,
        url: details.url,
        method: details.method,
        tabId: details.tabId,
        type: details.type,
        timestamp: Date.now(),
        startTime: performance.now(),
        requestHeaders: details.requestHeaders || [],
        responseHeaders: [],
        statusCode: 0,
        statusText: '',
        requestBody: '',
        responseBody: '',
        size: 0,
        duration: 0,
        intercepted: false
      };

      tabData.requestMap.set(details.requestId, requestData);
      tabData.requests.push(requestData);

      // Limit stored requests to 500 to prevent memory issues
      if (tabData.requests.length > 500) {
        const oldest = tabData.requests.shift();
        tabData.requestMap.delete(oldest.id);
      }

      // Notify devtools if connected
      if (devtoolsConnections.has(details.tabId)) {
        devtoolsConnections
          .get(details.tabId)
          .postMessage({
            type: 'NEW_REQUEST',
            data: requestData
          });
      }
    },
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onHeadersReceived?.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const tabData = requestStorage.get(details.tabId);
      if (tabData) {
        const request = tabData.requestMap.get(details.requestId);
        if (request) {
          request.statusCode = details.statusCode;
          request.statusText = details.statusLine;
          request.responseHeaders = details.responseHeaders || [];
          request.duration = performance.now() - request.startTime;

          // Notify devtools
          if (devtoolsConnections.has(details.tabId)) {
            devtoolsConnections.get(details.tabId).postMessage({
              type: 'REQUEST_UPDATED',
              data: request
            });
          }
        }
      }
    },
    { urls: ['<all_urls>'] }
  );
}

/**
 * Handle messages from content scripts and devtools
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, tabId, data } = request;
  const actualTabId = tabId || sender.tab?.id;

  switch (type) {
    case 'GET_TAB_ID':
      sendResponse({ tabId: sender.tab?.id });
      break;

    case 'GET_TAB_DATA':
      sendResponse(requestStorage.get(actualTabId) || initTabData(actualTabId));
      break;

    case 'SET_INTERCEPT_MODE':
      {
        const tabData = initTabData(actualTabId);
        tabData.interceptMode = data.mode;
        tabData.pausedJs = data.mode === 'no-js';

        // Notify content script of mode change
        chrome.tabs.sendMessage(actualTabId, {
          type: 'INTERCEPT_MODE_CHANGED',
          mode: data.mode,
          pauseJs: tabData.pausedJs
        });

        sendResponse({ success: true });
      }
      break;

    case 'INTERCEPT_REQUEST':
      {
        if (!actualTabId || !data?.requestId) {
          sendResponse({ intercepted: false, error: 'Invalid interception payload' });
          break;
        }

        const tabData = initTabData(actualTabId);
        let queueItem = tabData.interceptQueue.find(
          (item) => item.requestId === data.requestId
        );

        if (!queueItem) {
          const interceptedRequest = buildInterceptedRequest(actualTabId, data);

          queueItem = {
            requestId: data.requestId,
            request: interceptedRequest,
            status: 'pending',
            modifications: {}
          };

          tabData.interceptQueue.push(queueItem);
          tabData.requestMap.set(data.requestId, interceptedRequest);
          tabData.requests.push(interceptedRequest);

          if (tabData.requests.length > 500) {
            const oldest = tabData.requests.shift();
            tabData.requestMap.delete(oldest.id);
          }
        }

        // Send message to devtools
        if (devtoolsConnections.has(actualTabId)) {
          devtoolsConnections.get(actualTabId).postMessage({
            type: 'REQUEST_INTERCEPTED',
            data: {
              requestId: data.requestId,
              request: queueItem.request
            }
          });
        }

        sendResponse({ intercepted: true });
      }
      break;

    case 'FORWARD_REQUEST':
      {
        const tabData = initTabData(actualTabId);
        // Store modifications if any
        if (data.modifications) {
          const queueItem = tabData.interceptQueue.find(
            (item) => item.requestId === data.requestId
          );
          if (queueItem) {
            queueItem.modifications = data.modifications;
          }

          const requestEntry = tabData.requestMap.get(data.requestId);
          if (requestEntry) {
            if (Array.isArray(data.modifications.requestHeaders)) {
              requestEntry.requestHeaders = data.modifications.requestHeaders;
            }

            if (Object.prototype.hasOwnProperty.call(data.modifications, 'requestBody')) {
              requestEntry.requestBody = serializeBody(data.modifications.requestBody);
            }
          }
        }

        // Remove from queue
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        // Notify content script to proceed
        chrome.tabs.sendMessage(actualTabId, {
          type: 'PROCEED_REQUEST',
          requestId: data.requestId,
          modifications: data.modifications
        });

        sendResponse({ forwarded: true });
      }
      break;

    case 'DROP_REQUEST':
      {
        const tabData = initTabData(actualTabId);
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        chrome.tabs.sendMessage(actualTabId, {
          type: 'DROP_REQUEST',
          requestId: data.requestId
        });

        sendResponse({ dropped: true });
      }
      break;

    case 'CLEAR_REQUESTS':
      {
        const tabData = initTabData(actualTabId);
        tabData.requests = [];
        tabData.requestMap.clear();
        sendResponse({ cleared: true });
      }
      break;

    case 'GET_REQUEST_BODY':
      {
        const tabData = requestStorage.get(actualTabId);
        if (tabData) {
          const request = tabData.requestMap.get(data.requestId);
          sendResponse({ body: request ? request.requestBody : '' });
        }
      }
      break;

    case 'GET_RESPONSE_BODY':
      {
        const tabData = requestStorage.get(actualTabId);
        if (tabData) {
          const request = tabData.requestMap.get(data.requestId);
          sendResponse({ body: request ? request.responseBody : '' });
        }
      }
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true; // Keep the channel open for async responses
});

/**
 * Handle devtools connection
 */
chrome.runtime.onConnect.addListener((port) => {
  // Extract tabId from port name (format: "devtools-{tabId}")
  const match = port.name.match(/devtools-(\d+)/);
  if (!match) {
    port.disconnect();
    return;
  }

  const tabId = parseInt(match[1], 10);
  devtoolsConnections.set(tabId, port);

  // Initialize tab data and send current state
  const tabData = initTabData(tabId);
  port.postMessage({
    type: 'INITIAL_STATE',
    data: {
      requests: tabData.requests,
      interceptMode: tabData.interceptMode,
      interceptQueue: tabData.interceptQueue.map((item) => ({
        requestId: item.requestId,
        request: item.request || tabData.requestMap.get(item.requestId) || null,
        status: item.status || 'pending',
        modifications: item.modifications || {}
      }))
    }
  });

  // Listen for messages from devtools
  port.onMessage.addListener((message) => {
    const { type, data } = message;

    switch (type) {
      case 'SET_INTERCEPT_MODE':
        tabData.interceptMode = data.mode;
        tabData.pausedJs = data.mode === 'no-js';

        // Notify content script
        chrome.tabs.sendMessage(tabId, {
          type: 'INTERCEPT_MODE_CHANGED',
          mode: data.mode,
          pauseJs: tabData.pausedJs
        });
        break;

      case 'FORWARD_REQUEST':
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        chrome.tabs.sendMessage(tabId, {
          type: 'PROCEED_REQUEST',
          requestId: data.requestId,
          modifications: data.modifications
        });
        break;

      case 'DROP_REQUEST':
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        chrome.tabs.sendMessage(tabId, {
          type: 'DROP_REQUEST',
          requestId: data.requestId
        });
        break;

      case 'CLEAR_REQUESTS':
        tabData.requests = [];
        tabData.requestMap.clear();
        port.postMessage({ type: 'REQUESTS_CLEARED' });
        break;
    }
  });

  // Clean up on disconnect
  port.onDisconnect.addListener(() => {
    devtoolsConnections.delete(tabId);
  });
});

/**
 * Clean up when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  requestStorage.delete(tabId);
  devtoolsConnections.delete(tabId);
});

console.log('DevTools Pro - Background service worker loaded');
