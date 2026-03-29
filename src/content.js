(() => {
  'use strict';

  const CHANNEL = '__DEVTOOLS_PRO__';
  const SOURCE_CONTENT = 'content';
  const SOURCE_PAGE = 'page';

  let tabId = null;
  let interceptMode = 'off';
  const bufferedIntercepts = [];

  function postToPage(message) {
    window.postMessage(
      {
        channel: CHANNEL,
        source: SOURCE_CONTENT,
        ...message
      },
      '*'
    );
  }

  function sendInterceptToBackground(payload) {
    if (!tabId) {
      bufferedIntercepts.push(payload);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: 'INTERCEPT_REQUEST',
        tabId,
        data: payload
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  function flushBufferedIntercepts() {
    if (!tabId || bufferedIntercepts.length === 0) return;

    while (bufferedIntercepts.length > 0) {
      const nextPayload = bufferedIntercepts.shift();
      sendInterceptToBackground(nextPayload);
    }
  }

  function initTabId() {
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
      if (chrome.runtime.lastError || !response || typeof response.tabId !== 'number') {
        return;
      }

      tabId = response.tabId;
      flushBufferedIntercepts();
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const payload = event.data;
    if (!payload || payload.channel !== CHANNEL || payload.source !== SOURCE_PAGE) {
      return;
    }

    switch (payload.type) {
      case 'PAGE_CONTEXT_READY':
        postToPage({ type: 'SET_INTERCEPT_MODE', mode: interceptMode });
        break;

      case 'PAGE_INTERCEPT':
        if (interceptMode === 'off') return;
        if (!payload.requestId || !payload.url) return;

        sendInterceptToBackground({
          requestId: String(payload.requestId),
          type: payload.transport || 'intercepted',
          method: payload.method || 'GET',
          url: payload.url,
          headers: payload.headers || {},
          body: payload.body || ''
        });
        break;

      case 'JS_PAUSED':
      case 'JS_RESUMED':
      default:
        break;
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
      case 'INTERCEPT_MODE_CHANGED':
        interceptMode = request.mode || 'off';
        postToPage({ type: 'SET_INTERCEPT_MODE', mode: interceptMode });
        sendResponse({ ok: true });
        break;

      case 'PROCEED_REQUEST':
        postToPage({
          type: 'RESUME_REQUEST',
          requestId: request.requestId,
          action: 'forward',
          modifications: request.modifications || {}
        });
        sendResponse({ ok: true });
        break;

      case 'DROP_REQUEST':
        postToPage({
          type: 'RESUME_REQUEST',
          requestId: request.requestId,
          action: 'drop'
        });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false });
        break;
    }

    return true;
  });

  initTabId();
  console.log('[DevTools Pro] Content bridge ready');
})();
