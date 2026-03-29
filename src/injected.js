// DevTools Pro - Page Context Script (Injected)
// This script runs in the page context and intercepts fetch/XHR

'use strict';

let interceptMode = 'off';
const pendingRequests = new Map(); // requestId -> { resolve, reject, request }

// Pause/resume JS execution flags
let jsPaused = false;
let pausedPromises = [];

// Override fetch
const originalFetch = window.fetch;
window.fetch = function (...args) {
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
          .split('\r\n')
          .filter((h) => h);
        headersList.forEach((h) => {
          const [k, v] = h.split(': ');
          headers[k] = v;
        });
      } catch (e) { }

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
