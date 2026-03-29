(() => {
  'use strict';

  const CHANNEL = '__DEVTOOLS_PRO__';
  const SOURCE_PAGE = 'page';
  const SOURCE_CONTENT = 'content';

  if (window.__DEVTOOLS_PRO_PAGE_HOOKED__) {
    window.postMessage(
      {
        channel: CHANNEL,
        source: SOURCE_PAGE,
        type: 'PAGE_CONTEXT_READY'
      },
      '*'
    );
    return;
  }

  Object.defineProperty(window, '__DEVTOOLS_PRO_PAGE_HOOKED__', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  let interceptMode = 'off';
  let jsPaused = false;
  const pendingRequests = new Map();

  function createRequestId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

  function headersToObject(headers) {
    if (!headers) return null;

    if (Array.isArray(headers)) {
      return headers.reduce((acc, header) => {
        if (header && header.name) {
          acc[String(header.name)] = header.value == null ? '' : String(header.value);
        }
        return acc;
      }, {});
    }

    if (typeof headers === 'object') {
      return headers;
    }

    return null;
  }

  function postToContent(message) {
    window.postMessage(
      {
        channel: CHANNEL,
        source: SOURCE_PAGE,
        ...message
      },
      '*'
    );
  }

  function applyHeadersToXhr(xhr, headers) {
    const normalized = headersToObject(headers);
    if (!normalized) return;

    Object.entries(normalized).forEach(([name, value]) => {
      try {
        xhr.setRequestHeader(name, value == null ? '' : String(value));
      } catch {
        // Ignore invalid or restricted headers.
      }
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function devtoolsProFetch(input, init) {
    if (interceptMode === 'off') {
      return originalFetch(input, init);
    }

    let request;
    try {
      request = new Request(input, init);
    } catch {
      return originalFetch(input, init);
    }

    const requestId = createRequestId('fetch');

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, {
        forward(modifications = {}) {
          const modifiedInput = modifications.url || input;
          const nextInit = { ...(init || {}) };
          const modifiedHeaders = headersToObject(
            modifications.requestHeaders || modifications.headers
          );

          if (modifications.method) {
            nextInit.method = modifications.method;
          }

          if (modifiedHeaders) {
            nextInit.headers = modifiedHeaders;
          }

          if (Object.prototype.hasOwnProperty.call(modifications, 'requestBody')) {
            nextInit.body = modifications.requestBody;
          }

          originalFetch(modifiedInput, nextInit).then(resolve).catch(reject);
        },

        drop() {
          reject(new Error('Request dropped by DevTools Pro'));
        }
      });

      postToContent({
        type: 'PAGE_INTERCEPT',
        transport: 'fetch',
        requestId,
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: bodyToSerializable(init && init.body)
      });

    });
  };

  const NativeXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class DevToolsProXHR extends NativeXHR {
    constructor(...args) {
      super(...args);
      this._devtoolsProMeta = null;
      this._devtoolsProHeaders = {};
    }

    open(method, url, ...rest) {
      this._devtoolsProMeta = {
        id: createRequestId('xhr'),
        method: method || 'GET',
        url: String(url || '')
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
      if (interceptMode === 'off') {
        return super.send(body);
      }

      if (!this._devtoolsProMeta) {
        this._devtoolsProMeta = {
          id: createRequestId('xhr'),
          method: 'GET',
          url: ''
        };
      }

      const meta = this._devtoolsProMeta;

      pendingRequests.set(meta.id, {
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
          } catch {
            // Ignore abort errors.
          }
        }
      });

      postToContent({
        type: 'PAGE_INTERCEPT',
        transport: 'xhr',
        requestId: meta.id,
        method: meta.method,
        url: meta.url,
        headers: { ...this._devtoolsProHeaders },
        body: bodyToSerializable(body)
      });

      return;
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const payload = event.data;
    if (!payload || payload.channel !== CHANNEL || payload.source !== SOURCE_CONTENT) {
      return;
    }

    if (payload.type === 'SET_INTERCEPT_MODE') {
      const previousPaused = jsPaused;
      interceptMode = payload.mode || 'off';
      jsPaused = interceptMode === 'no-js';

      if (jsPaused && !previousPaused) {
        postToContent({ type: 'JS_PAUSED' });
      }

      if (!jsPaused && previousPaused) {
        postToContent({ type: 'JS_RESUMED' });
      }
      return;
    }

    if (payload.type === 'RESUME_REQUEST') {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) return;

      pendingRequests.delete(payload.requestId);

      if (payload.action === 'drop') {
        pending.drop();
      } else {
        pending.forward(payload.modifications || {});
      }
    }
  });

  postToContent({ type: 'PAGE_CONTEXT_READY' });
})();
