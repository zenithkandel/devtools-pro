// DevTools Pro - Content Script
// Handles fetch/XHR interception and communication with background

/**
 * Inject the external page context script
 * This runs in the page context to intercept fetch/XHR
 */
function injectPageContextScript() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/injected.js');
    script.type = 'text/javascript';
    script.onload = () => {
      console.log('[DevTools Pro] injected.js loaded successfully');
      script.remove();
    };
    script.onerror = (error) => {
      console.error('[DevTools Pro] Failed to load injected.js:', error);
      script.remove();
    };

    // Try to insert immediately
    if (document.documentElement) {
      document.documentElement.insertBefore(script, document.documentElement.firstChild);
    } else {
      // If document element doesn't exist, wait for it
      function tryInject() {
        if (document.documentElement) {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('src/injected.js');
          s.type = 'text/javascript';
          s.onload = () => s.remove();
          s.onerror = () => s.remove();
          document.documentElement.insertBefore(s, document.documentElement.firstChild);
        } else {
          setTimeout(tryInject, 10);
        }
      }
      tryInject();
    }
  } catch (e) {
    console.error('[DevTools Pro] Error in injectPageContextScript:', e);
  }
}

// Inject script at the earliest opportunity
if (document.readyState === 'loading') {
  // DOM is still loading
  injectPageContextScript();
  // Also try again on DOMContentLoaded as fallback
  document.addEventListener('DOMContentLoaded', injectPageContextScript, true);
} else {
  // DOM is already loaded
  injectPageContextScript();
}

// Rest of content script code
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
