// DevTools Pro - Content Script
// Handles fetch/XHR interception and communication with background

// src/injected.js is now loaded as a MAIN world content script via manifest.
const CSP_SAFE_BUILD_MARKER = 'csp-main-world-2026-03-29';

// Rest of content script code
let tabId = null;
let currentInterceptMode = 'off';
const pendingInterceptions = new Map(); // requestId -> { request, timeout }
const queuedInterceptions = []; // payloads captured before tabId resolves

function sendInterceptToBackground(payload) {
  if (!tabId) {
    queuedInterceptions.push(payload);
    return;
  }

  chrome.runtime.sendMessage({
    type: 'INTERCEPT_REQUEST',
    tabId,
    data: payload
  });
}

function flushQueuedInterceptions() {
  if (!tabId || queuedInterceptions.length === 0) return;

  while (queuedInterceptions.length > 0) {
    const payload = queuedInterceptions.shift();
    sendInterceptToBackground(payload);
  }
}

/**
 * Get the current tab ID immediately
 */
function initTabId() {
  chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
    if (response) {
      tabId = response.tabId;
      console.log('[DevTools Pro] Content script initialized for tab:', tabId);
      flushQueuedInterceptions();
    }
  });
}

/**
 * Listen for messages from the page context
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || typeof event.data.type !== 'string') return;

  const { type, requestId, method, url, headers, body } = event.data;

  switch (type) {
    case 'PAGE_CONTEXT_READY':
      console.log('[DevTools Pro] Page context script injected successfully');

      // If mode changed before MAIN world script initialized, re-sync now.
      window.postMessage(
        {
          type: 'SET_INTERCEPT_MODE',
          mode: currentInterceptMode
        },
        '*'
      );
      break;

    case 'INTERCEPT_FETCH':
    case 'INTERCEPT_XHR':
      if (currentInterceptMode !== 'off') {
        sendInterceptToBackground({
          requestId,
          method,
          url,
          headers,
          body,
          type: type === 'INTERCEPT_FETCH' ? 'fetch' : 'xhr'
        });

        // Set timeout for user response
        const timeout = setTimeout(() => {
          // Auto-forward if no response after 30s
          window.postMessage(
            {
              type: 'RESUME_REQUEST',
              requestId,
              action: 'forward'
            },
            '*'
          );
        }, 30000);

        pendingInterceptions.set(requestId, { timeout });
      }
      break;

    case 'JS_PAUSED':
      console.log('[DevTools Pro] JavaScript execution paused');
      break;

    case 'JS_RESUMED':
      console.log('[DevTools Pro] JavaScript execution resumed');
      break;
  }
});

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, mode } = request;

  switch (type) {
    case 'INTERCEPT_MODE_CHANGED':
      currentInterceptMode = mode;
      window.postMessage(
        {
          type: 'SET_INTERCEPT_MODE',
          mode
        },
        '*'
      );
      sendResponse({ received: true });
      break;

    case 'PROCEED_REQUEST':
      {
        const { requestId, modifications } = request;
        window.postMessage(
          {
            type: 'RESUME_REQUEST',
            requestId,
            action: 'forward',
            modifications
          },
          '*'
        );

        const pending = pendingInterceptions.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingInterceptions.delete(requestId);
        }

        sendResponse({ resumed: true });
      }
      break;

    case 'DROP_REQUEST':
      {
        const { requestId } = request;
        window.postMessage(
          {
            type: 'RESUME_REQUEST',
            requestId,
            action: 'drop'
          },
          '*'
        );

        const pending = pendingInterceptions.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingInterceptions.delete(requestId);
        }

        sendResponse({ dropped: true });
      }
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true;
});

// Initialize tab ID
initTabId();

console.log('[DevTools Pro] Content script loaded:', CSP_SAFE_BUILD_MARKER);
