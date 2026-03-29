// DevTools Pro - Content Script
// Handles fetch/XHR interception and communication with background

/**
 * Inject the external page context script
 */
function injectPageContextScript() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/injected.js');
    script.onload = () => script.remove();
    script.onerror = () => {
      console.error('[DevTools Pro] Failed to load injected.js');
      script.remove();
    };

    // Inject at document_start if possible
    if (document.documentElement) {
      document.documentElement.insertBefore(script, document.documentElement.firstChild);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('src/injected.js');
        s.onload = () => s.remove();
        s.onerror = () => s.remove();
        document.head.insertBefore(s, document.head.firstChild);
      });
    }
  } catch (e) {
    console.error('[DevTools Pro] Error injecting script:', e);
  }
}

// Inject page context script immediately
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectPageContextScript);
} else {
  injectPageContextScript();
}

let tabId = null;
let currentInterceptMode = 'off';
const pendingInterceptions = new Map(); // requestId -> { request, timeout }

/**
 * Get the current tab ID immediately
 */
function initTabId() {
  chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
    if (response) {
      tabId = response.tabId;
      console.log('[DevTools Pro] Content script initialized for tab:', tabId);
    }
  });
}

/**
 * Listen for messages from the page context
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  const { type, requestId, method, url, headers, body } = event.data;

  if (!tabId) return;

  switch (type) {
    case 'PAGE_CONTEXT_READY':
      console.log('[DevTools Pro] Page context script injected successfully');
      break;

    case 'INTERCEPT_FETCH':
    case 'INTERCEPT_XHR':
      if (currentInterceptMode !== 'off') {
        // Send to devtools via background
        chrome.runtime.sendMessage({
          type: 'INTERCEPT_REQUEST',
          tabId,
          data: {
            requestId,
            method,
            url,
            headers,
            body
          }
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
  const { type, mode, pauseJs } = request;

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

console.log('[DevTools Pro] Content script loaded');
