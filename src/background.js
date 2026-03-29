// DevTools Pro - Background Service Worker
// Manages network request monitoring, interception, and communication

const requestStorage = new Map(); // tabId -> { requests: [], interceptMode, pausedJs }
const devtoolsConnections = new Map(); // tabId -> port

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
      sendResponse(requestStorage.get(tabId) || initTabData(tabId));
      break;

    case 'SET_INTERCEPT_MODE':
      {
        const tabData = initTabData(tabId);
        tabData.interceptMode = data.mode;
        tabData.pausedJs = data.mode === 'no-js';

        // Notify content script of mode change
        chrome.tabs.sendMessage(tabId, {
          type: 'INTERCEPT_MODE_CHANGED',
          mode: data.mode,
          pauseJs: tabData.pausedJs
        });

        sendResponse({ success: true });
      }
      break;

    case 'INTERCEPT_REQUEST':
      {
        const tabData = initTabData(tabId);
        tabData.interceptQueue.push({
          requestId: data.requestId,
          status: 'pending',
          modifications: {}
        });

        // Send message to devtools
        if (devtoolsConnections.has(tabId)) {
          devtoolsConnections.get(tabId).postMessage({
            type: 'REQUEST_INTERCEPTED',
            data: {
              requestId: data.requestId,
              request: tabData.requestMap.get(data.requestId)
            }
          });
        }

        sendResponse({ intercepted: true });
      }
      break;

    case 'FORWARD_REQUEST':
      {
        const tabData = initTabData(tabId);
        // Store modifications if any
        if (data.modifications) {
          const request = tabData.requestMap.get(data.requestId);
          if (request) {
            Object.assign(request, data.modifications);
          }
        }

        // Remove from queue
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        // Notify content script to proceed
        chrome.tabs.sendMessage(tabId, {
          type: 'PROCEED_REQUEST',
          requestId: data.requestId,
          modifications: data.modifications
        });

        sendResponse({ forwarded: true });
      }
      break;

    case 'DROP_REQUEST':
      {
        const tabData = initTabData(tabId);
        tabData.interceptQueue = tabData.interceptQueue.filter(
          (item) => item.requestId !== data.requestId
        );

        chrome.tabs.sendMessage(tabId, {
          type: 'DROP_REQUEST',
          requestId: data.requestId
        });

        sendResponse({ dropped: true });
      }
      break;

    case 'CLEAR_REQUESTS':
      {
        const tabData = initTabData(tabId);
        tabData.requests = [];
        tabData.requestMap.clear();
        sendResponse({ cleared: true });
      }
      break;

    case 'GET_REQUEST_BODY':
      {
        const tabData = requestStorage.get(tabId);
        if (tabData) {
          const request = tabData.requestMap.get(data.requestId);
          sendResponse({ body: request ? request.requestBody : '' });
        }
      }
      break;

    case 'GET_RESPONSE_BODY':
      {
        const tabData = requestStorage.get(tabId);
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
      interceptQueue: tabData.interceptQueue
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
