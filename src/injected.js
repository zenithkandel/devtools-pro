// DevTools Pro - Page Context Script (Injected)
// This script runs in the page context and intercepts fetch/XHR

'use strict';

let interceptMode = 'off';
const pendingRequests = new Map(); // requestId -> { forward(modifications), drop() }

// Pause/resume JS execution flags
let jsPaused = false;
let pausedCallbacks = [];

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function bodyToSerializable(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) return '[form-data]';
  if (body instanceof Blob) return `[blob:${body.type || 'binary'}:${body.size}]`;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[binary]';

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function normalizeHeadersForFetchModifications(headers) {
  if (!headers) return null;

  if (Array.isArray(headers)) {
    return headers.reduce((acc, header) => {
      if (header && header.name) {
        acc[header.name] = header.value ?? '';
      }
      return acc;
    }, {});
  }

  if (typeof headers === 'object') {
    return headers;
  }

  return null;
}

function applyHeadersToXhr(xhr, headers) {
  if (!headers) return;

  if (Array.isArray(headers)) {
    headers.forEach((header) => {
      if (!header || !header.name) return;
      try {
        xhr.setRequestHeader(header.name, header.value ?? '');
      } catch (e) { }
    });
    return;
  }

  if (typeof headers === 'object') {
    Object.entries(headers).forEach(([name, value]) => {
      try {
        xhr.setRequestHeader(name, value ?? '');
      } catch (e) { }
    });
  }
}

// Override fetch
const originalFetch = window.fetch;
window.fetch = function (...args) {
  if (interceptMode === 'off') {
    return originalFetch.apply(this, args);
  }

  // Pause if in no-js mode
  if (jsPaused) {
    return new Promise((resolve, reject) => {
      const context = this;
      pausedCallbacks.push(() => {
        originalFetch.apply(context, args).then(resolve).catch(reject);
      });
    });
  }

  let request;
  try {
    request = new Request(...args);
  } catch (error) {
    return originalFetch.apply(this, args);
  }

  const requestId = createRequestId();
  const context = this;

  // Queue the request for interception
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      forward(modifications = {}) {
        const modifiedHeaders = normalizeHeadersForFetchModifications(
          modifications.requestHeaders || modifications.headers
        );
        const hasBodyModification = Object.prototype.hasOwnProperty.call(
          modifications,
          'requestBody'
        );

        if (!modifiedHeaders && !hasBodyModification) {
          originalFetch.apply(context, args).then(resolve).catch(reject);
          return;
        }

        const [input, init = {}] = args;
        const nextInit = { ...init };

        if (modifiedHeaders) {
          nextInit.headers = modifiedHeaders;
        }

        if (hasBodyModification) {
          nextInit.body = modifications.requestBody;
        }

        originalFetch.call(context, input, nextInit).then(resolve).catch(reject);
      },

      drop() {
        reject(new Error('Request dropped by DevTools Pro'));
      }
    });

    try {
      window.postMessage(
        {
          type: 'INTERCEPT_FETCH',
          requestId,
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers.entries()),
          body: bodyToSerializable(args[1] && args[1].body)
        },
        '*'
      );
    } catch (error) {
      const pending = pendingRequests.get(requestId);
      pendingRequests.delete(requestId);
      pending?.forward();
      return;
    }

    // Timeout after 30s if not responded
    setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        pending.forward();
      }
    }, 30000);
  });
};

// Override XMLHttpRequest
const OriginalXHR = window.XMLHttpRequest;
window.XMLHttpRequest = class extends OriginalXHR {
  constructor(...xhrArgs) {
    super(...xhrArgs);
    this._devtoolsProRequest = null;
    this._devtoolsProHeaders = {};
  }

  open(method, url, ...rest) {
    this._devtoolsProRequest = {
      method,
      url,
      id: createRequestId()
    };
    this._devtoolsProHeaders = {};
    return super.open(method, url, ...rest);
  }

  setRequestHeader(name, value) {
    if (this._devtoolsProHeaders) {
      this._devtoolsProHeaders[name] = value;
    }
    return super.setRequestHeader(name, value);
  }

  send(body) {
    if (!this._devtoolsProRequest) {
      this._devtoolsProRequest = {
        method: 'GET',
        url: '',
        id: createRequestId()
      };
      this._devtoolsProHeaders = {};
    }

    if (interceptMode === 'off') {
      return super.send(body);
    }

    if (jsPaused) {
      pausedCallbacks.push(() => {
        this.send(body);
      });
      return;
    }

    const { id, method, url } = this._devtoolsProRequest;

    // Queue XHR for interception
    pendingRequests.set(id, {
      forward: (modifications = {}) => {
        applyHeadersToXhr(this, modifications.requestHeaders || modifications.headers);

        const bodyToSend = Object.prototype.hasOwnProperty.call(
          modifications,
          'requestBody'
        )
          ? modifications.requestBody
          : body;

        super.send(bodyToSend);
      },
      drop: () => {
        try {
          super.abort();
        } catch (e) { }
      }
    });

    try {
      window.postMessage(
        {
          type: 'INTERCEPT_XHR',
          requestId: id,
          method,
          url,
          headers: { ...this._devtoolsProHeaders },
          body: bodyToSerializable(body)
        },
        '*'
      );
    } catch (error) {
      const pending = pendingRequests.get(id);
      pendingRequests.delete(id);
      pending?.forward();
      return;
    }

    // Timeout after 30s
    setTimeout(() => {
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        pending.forward();
      }
    }, 30000);

    return;
  }
};

// Listen for messages from content script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || typeof event.data.type !== 'string') return;

  const { type, requestId, mode, action, modifications } = event.data;

  if (type === 'RESUME_REQUEST') {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    pendingRequests.delete(requestId);

    if (action === 'drop') {
      pending.drop?.();
    } else {
      pending.forward?.(modifications || {});
    }
    return;
  }

  if (type === 'SET_INTERCEPT_MODE') {
    interceptMode = mode;
    if (mode === 'no-js' && !jsPaused) {
      jsPaused = true;
      window.postMessage({ type: 'JS_PAUSED' }, '*');
    } else if (mode !== 'no-js' && jsPaused) {
      jsPaused = false;
      const callbacks = pausedCallbacks;
      pausedCallbacks = [];
      callbacks.forEach((resume) => {
        try {
          resume();
        } catch (e) { }
      });
      window.postMessage({ type: 'JS_RESUMED' }, '*');
    }
  }
});

// Signal that page context is ready
window.postMessage({ type: 'PAGE_CONTEXT_READY' }, '*');
