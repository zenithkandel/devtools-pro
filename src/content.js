// DevTools Pro - Content Script
// Handles fetch/XHR interception and communication with background

const PAGE_CONTEXT_SCRIPT = `
  (function() {
    'use strict';

    let interceptMode = 'off';
    const pendingRequests = new Map(); // requestId -> { resolve, reject, request }

    // Pause/resume JS execution flags
    let jsPaused = false;
    let pausedPromises = [];

    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      const request = new Request(...args);
      const requestId = Math.random().toString(36).substring(7);

      if (interceptMode === 'off') {
        return originalFetch.apply(this, args);
      }

      // Pause if in no-js mode
      if (jsPaused) {
        const pausePromise = new Promise((resolve) => {
          pausedPromises.push(resolve);
        });
        return pausePromise.then(() => originalFetch.apply(this, args));
      }

      // Queue the request for interception
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject, request, args });

        window.postMessage(
          {
            type: 'INTERCEPT_FETCH',
            requestId,
            method: request.method,
            url: request.url,
            headers: Object.fromEntries(request.headers.entries()),
            body: request.body
          },
          '*'
        );

        // Timeout after 30s if not responded
        setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            originalFetch.apply(this, args).then(resolve).catch(reject);
          }
        }, 30000);
      });
    };

    // Override XMLHttpRequest
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends OriginalXHR {
      open(method, url, ...rest) {
        this._devtoolsProRequest = {
          method,
          url,
          id: Math.random().toString(36).substring(7)
        };
        return super.open(method, url, ...rest);
      }

      send(body) {
        const { id, method, url } = this._devtoolsProRequest;

        if (interceptMode === 'off') {
          return super.send(body);
        }

        // Queue XHR for interception
        return new Promise((resolve) => {
          pendingRequests.set(id, {
            resolve: (response) => {
              if (response.skip) {
                super.send(body);
              }
              resolve();
            },
            xhr: this,
            method,
            url,
            body
          });

          const headers = {};
          try {
            const headersList = this.getAllResponseHeaders()
              .split('\\r\\n')
              .filter((h) => h);
            headersList.forEach((h) => {
              const [k, v] = h.split(': ');
              headers[k] = v;
            });
          } catch (e) {}

          window.postMessage(
            {
              type: 'INTERCEPT_XHR',
              requestId: id,
              method,
              url,
              headers,
              body
            },
            '*'
          );

          // Timeout after 30s
          setTimeout(() => {
            if (pendingRequests.has(id)) {
              const pending = pendingRequests.get(id);
              pendingRequests.delete(id);
              if (pending.xhr) {
                super.send(body);
              }
            }
          }, 30000);
        });
      }
    };

    // Listen for messages from content script
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;

      const { type, requestId, mode, action, modifications } = event.data;

      if (type === 'RESUME_REQUEST') {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          if (action === 'drop') {
            pending.reject?.(new Error('Request dropped by DevTools Pro'));
          } else if (action === 'forward') {
            if (modifications) {
              // Apply modifications if available
              if (modifications.headers) {
                Object.entries(modifications.headers).forEach(([k, v]) => {
                  if (pending.xhr?.setRequestHeader) {
                    pending.xhr.setRequestHeader(k, v);
                  }
                });
              }
            }
            pending.resolve?.({ skip: false });
          }
          pendingRequests.delete(requestId);
        }
      }

      if (type === 'SET_INTERCEPT_MODE') {
        interceptMode = mode;
        if (mode === 'no-js' && !jsPaused) {
          jsPaused = true;
          // Pause JS by blocking event loop
          window.postMessage({ type: 'JS_PAUSED' }, '*');
        } else if (mode !== 'no-js' && jsPaused) {
          jsPaused = false;
          // Resume all paused promises
          pausedPromises.forEach((resolve) => resolve());
          pausedPromises = [];
          window.postMessage({ type: 'JS_RESUMED' }, '*');
        }
      }
    });

    // Signal that page context is ready
    window.postMessage({ type: 'PAGE_CONTEXT_READY' }, '*');
  })();
`;

/**
 * Inject the page context script early
 */
function injectPageContextScript() {
  const script = document.createElement('script');
  script.textContent = PAGE_CONTEXT_SCRIPT;
  script.onload = script.onerror = () => script.remove();

  // Inject at document_start if possible
  if (document.documentElement) {
    document.documentElement.insertBefore(script, document.documentElement.firstChild);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('script');
      s.textContent = PAGE_CONTEXT_SCRIPT;
      s.onload = s.onerror = () => s.remove();
      document.head.insertBefore(s, document.head.firstChild);
    });
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
 * Get the current tab ID
 */
chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
  tabId = response.tabId;
});

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

console.log('[DevTools Pro] Content script loaded');
