/**
 * background.js — DevTools Pro Service Worker
 *
 * Features:
 *  1. HTTP Intrude  — Fetch domain hold/modify/release (Burp-style)
 *  2. WS Monitor   — Network domain WebSocket frame events
 *  3. WS Intrude   — Runtime.addBinding + WebSocket.prototype.send patch
 *
 * Debugger is shared: one attachment per tab, multiple features reuse it.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SHARED STATE ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** tabId → chrome.runtime.Port */
const connections = new Map();

/**
 * tabId → {
 *   fetchEnabled    : boolean,
 *   noJsEnabled     : boolean,
 *   networkEnabled  : boolean,
 *   wsIntruding     : boolean,
 *   wsScriptId      : string|null,
 * }
 */
const debuggerState = new Map();

/** HTTP intercept: requestId → { tabId } */
const interceptedRequests = new Map();

/** Runtime binding name used by the WS intercept patch */
const WS_BINDING = '__dtpWsMsg__';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PORT / MESSAGING ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'devtools-pro') return;

  let connectedTabId = null;

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg.type) {

        case 'INIT':
          connectedTabId = msg.tabId;
          connections.set(connectedTabId, port);
          break;

        // ── HTTP Intrude ─────────────────────────────────────────────────────
        case 'ENABLE_INTERCEPT':
          await enableIntercept(connectedTabId, msg.options);
          port.postMessage({ type: 'INTERCEPT_ENABLED', options: msg.options });
          break;

        case 'DISABLE_INTERCEPT':
          await disableIntercept(connectedTabId);
          port.postMessage({ type: 'INTERCEPT_DISABLED' });
          break;

        case 'TOGGLE_JS': {
          const st = debuggerState.get(connectedTabId);
          if (!st) break;
          const nextDisabled = !st.noJsEnabled;
          await cdp(connectedTabId, 'Emulation.setScriptExecutionDisabled', { value: nextDisabled });
          st.noJsEnabled = nextDisabled;
          port.postMessage({ type: 'JS_TOGGLED', disabled: nextDisabled });
          break;
        }

        case 'CONTINUE_REQUEST':
          await continueRequest(connectedTabId, msg.requestId, msg.modifications);
          port.postMessage({ type: 'REQUEST_CONTINUED', requestId: msg.requestId });
          break;

        case 'DROP_REQUEST':
          await dropRequest(connectedTabId, msg.requestId);
          port.postMessage({ type: 'REQUEST_DROPPED', requestId: msg.requestId });
          break;

        case 'FORWARD_ALL':
          await forwardAll(connectedTabId);
          port.postMessage({ type: 'ALL_FORWARDED' });
          break;

        // ── WS Monitor ───────────────────────────────────────────────────────
        case 'WS_MONITOR_START':
          await wsMonitorStart(connectedTabId);
          port.postMessage({ type: 'WS_MONITOR_STARTED' });
          break;

        case 'WS_MONITOR_STOP':
          await wsMonitorStop(connectedTabId);
          port.postMessage({ type: 'WS_MONITOR_STOPPED' });
          break;

        // ── WS Intrude ───────────────────────────────────────────────────────
        case 'WS_INTRUDE_ENABLE':
          await wsIntrudeEnable(connectedTabId);
          port.postMessage({ type: 'WS_INTRUDE_ENABLED' });
          break;

        case 'WS_INTRUDE_DISABLE':
          await wsIntrudeDisable(connectedTabId);
          port.postMessage({ type: 'WS_INTRUDE_DISABLED' });
          break;

        case 'WS_FORWARD':
          await wsForward(connectedTabId, msg.msgId);
          port.postMessage({ type: 'WS_FORWARDED', msgId: msg.msgId });
          break;

        case 'WS_DROP':
          await wsDrop(connectedTabId, msg.msgId);
          port.postMessage({ type: 'WS_DROPPED', msgId: msg.msgId });
          break;

        case 'WS_SEND_CUSTOM':
          await wsInjectSend(connectedTabId, msg.socketUrl, msg.data);
          port.postMessage({ type: 'WS_CUSTOM_SENT' });
          break;
      }
    } catch (err) {
      port.postMessage({ type: 'ERROR', message: err.message });
      console.error('[DevTools Pro BG]', err);
    }
  });

  port.onDisconnect.addListener(() => {
    if (connectedTabId !== null) {
      connections.delete(connectedTabId);
      disableIntercept(connectedTabId).catch(() => {});
      wsMonitorStop(connectedTabId).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DEBUGGER LIFECYCLE (SHARED) ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureAttached(tabId) {
  if (!debuggerState.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerState.set(tabId, {
      fetchEnabled:   false,
      noJsEnabled:    false,
      networkEnabled: false,
      wsIntruding:    false,
      wsScriptId:     null,
    });
  }
}

async function detachIfIdle(tabId) {
  const st = debuggerState.get(tabId);
  if (!st) return;
  if (st.fetchEnabled || st.networkEnabled || st.wsIntruding) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  debuggerState.delete(tabId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HTTP INTRUDE ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function enableIntercept(tabId, options = {}) {
  await ensureAttached(tabId);
  const st = debuggerState.get(tabId);

  if (!st.fetchEnabled) {
    await cdp(tabId, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    st.fetchEnabled = true;
  }

  if (options.disableJs && !st.noJsEnabled) {
    await cdp(tabId, 'Emulation.setScriptExecutionDisabled', { value: true });
    st.noJsEnabled = true;
  }
}

async function disableIntercept(tabId) {
  const st = debuggerState.get(tabId);
  if (!st || !st.fetchEnabled) return;

  await forwardAll(tabId);

  if (st.noJsEnabled) {
    await cdp(tabId, 'Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
    st.noJsEnabled = false;
  }

  await cdp(tabId, 'Fetch.disable', {}).catch(() => {});
  st.fetchEnabled = false;
  await detachIfIdle(tabId);
}

async function continueRequest(tabId, requestId, mods = {}) {
  const cmd = { requestId };
  if (mods.url     !== undefined) cmd.url    = mods.url;
  if (mods.method  !== undefined) cmd.method = mods.method;
  if (Array.isArray(mods.headers) && mods.headers.length) cmd.headers = mods.headers;
  if (mods.postData) cmd.postData = btoa(unescape(encodeURIComponent(mods.postData)));
  await cdp(tabId, 'Fetch.continueRequest', cmd);
  interceptedRequests.delete(requestId);
}

async function dropRequest(tabId, requestId) {
  await cdp(tabId, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  interceptedRequests.delete(requestId);
}

async function forwardAll(tabId) {
  const ids = [];
  interceptedRequests.forEach((data, rid) => {
    if (data.tabId === tabId) ids.push(rid);
  });
  for (const rid of ids) {
    await cdp(tabId, 'Fetch.continueRequest', { requestId: rid }).catch(() => {});
    interceptedRequests.delete(rid);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WS MONITOR ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function wsMonitorStart(tabId) {
  await ensureAttached(tabId);
  const st = debuggerState.get(tabId);
  if (st.networkEnabled) return;
  await cdp(tabId, 'Network.enable', {});
  st.networkEnabled = true;
}

async function wsMonitorStop(tabId) {
  const st = debuggerState.get(tabId);
  if (!st || !st.networkEnabled) return;
  if (st.wsIntruding) await wsIntrudeDisable(tabId);
  await cdp(tabId, 'Network.disable', {}).catch(() => {});
  st.networkEnabled = false;
  await detachIfIdle(tabId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WS INTRUDE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const WS_PATCH_SCRIPT = `
(function() {
  if (window.__dtp_ws_patched__) {
    if(window.__dtpWsSetIntercept__) window.__dtpWsSetIntercept__(true);
    return;
  }
  window.__dtp_ws_patched__   = true;
  window.__dtp_ws_intercept__ = false;

  const _orig    = WebSocket.prototype.send;
  const _pending = new Map();
  let   _nextId  = 0;

  WebSocket.prototype.send = function(data) {
    if (!window.__dtp_ws_intercept__) return _orig.call(this, data);
    const id  = String(++_nextId);
    _pending.set(id, { ws: this, data });

    let payload, dataType;
    if (typeof data === 'string') {
      payload = data; dataType = 'text';
    } else if (data instanceof ArrayBuffer) {
      payload = '[ArrayBuffer ' + data.byteLength + 'B]'; dataType = 'binary';
    } else if (ArrayBuffer.isView(data)) {
      payload = '[TypedArray ' + data.byteLength + 'B]'; dataType = 'binary';
    } else {
      payload = String(data); dataType = 'text';
    }

    try { __dtpWsMsg__(JSON.stringify({ id, url: this.url, data: payload, dataType })); } catch(e) {}
  };

  window.__dtpWsForward__ = function(id) {
    const item = _pending.get(id);
    if (item) { _orig.call(item.ws, item.data); _pending.delete(id); }
  };
  window.__dtpWsDrop__ = function(id) { _pending.delete(id); };
  window.__dtpWsSetIntercept__ = function(on) {
    window.__dtp_ws_intercept__ = on;
    if (!on) { _pending.forEach(item => _orig.call(item.ws, item.data)); _pending.clear(); }
  };
})();
`;

async function wsIntrudeEnable(tabId) {
  await wsMonitorStart(tabId);
  const st = debuggerState.get(tabId);
  if (st.wsIntruding) return;

  await cdp(tabId, 'Runtime.addBinding', { name: WS_BINDING }).catch(() => {});

  const res = await cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
    source: WS_PATCH_SCRIPT,
  }).catch(() => ({ identifier: null }));
  st.wsScriptId = res?.identifier ?? null;

  await cdp(tabId, 'Runtime.evaluate', {
    expression: WS_PATCH_SCRIPT, silent: true,
  }).catch(() => {});

  await cdp(tabId, 'Runtime.evaluate', {
    expression: 'if(window.__dtpWsSetIntercept__)window.__dtpWsSetIntercept__(true);',
    silent: true,
  }).catch(() => {});

  st.wsIntruding = true;
}

async function wsIntrudeDisable(tabId) {
  const st = debuggerState.get(tabId);
  if (!st || !st.wsIntruding) return;

  await cdp(tabId, 'Runtime.evaluate', {
    expression: 'if(window.__dtpWsSetIntercept__)window.__dtpWsSetIntercept__(false);',
    silent: true,
  }).catch(() => {});

  if (st.wsScriptId) {
    await cdp(tabId, 'Page.removeScriptToEvaluateOnNewDocument', {
      identifier: st.wsScriptId,
    }).catch(() => {});
    st.wsScriptId = null;
  }

  await cdp(tabId, 'Runtime.removeBinding', { name: WS_BINDING }).catch(() => {});
  st.wsIntruding = false;
}

async function wsForward(tabId, msgId) {
  await cdp(tabId, 'Runtime.evaluate', {
    expression: `if(window.__dtpWsForward__)window.__dtpWsForward__(${JSON.stringify(String(msgId))});`,
    silent: true,
  }).catch(() => {});
}

async function wsDrop(tabId, msgId) {
  await cdp(tabId, 'Runtime.evaluate', {
    expression: `if(window.__dtpWsDrop__)window.__dtpWsDrop__(${JSON.stringify(String(msgId))});`,
    silent: true,
  }).catch(() => {});
}

async function wsInjectSend(tabId, socketUrl, data) {
  const safeUrl  = JSON.stringify(socketUrl);
  const safeData = JSON.stringify(data);
  const expr = `
    (function(){
      const socks = window.__dtp_ws_sockets__ || [];
      for(const ws of socks){
        if(ws.url===${safeUrl}&&ws.readyState===1){
          const orig=WebSocket.prototype.send.__dtp_orig__||WebSocket.prototype.send;
          orig.call(ws,${safeData}); return true;
        }
      }
      return false;
    })()`;
  await cdp(tabId, 'Runtime.evaluate', { expression: expr, silent: true }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CDP EVENT LISTENER ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const port  = connections.get(tabId);

  switch (method) {

    // HTTP
    case 'Fetch.requestPaused': {
      interceptedRequests.set(params.requestId, { tabId });
      let postData = '';
      if (params.request.postData) {
        try { postData = decodeURIComponent(escape(atob(params.request.postData))); }
        catch { postData = params.request.postData; }
      }
      const headers = Object.entries(params.request.headers || {}).map(([name, value]) => ({ name, value }));
      send(port, { type: 'REQUEST_PAUSED', requestId: params.requestId, url: params.request.url,
        method: params.request.method, headers, postData, resourceType: params.resourceType, timestamp: Date.now() });
      break;
    }

    // WS lifecycle
    case 'Network.webSocketCreated':
      send(port, { type: 'WS_CREATED', requestId: params.requestId, url: params.url, timestamp: Date.now() });
      break;

    case 'Network.webSocketClosed':
      send(port, { type: 'WS_CLOSED', requestId: params.requestId, timestamp: Date.now() });
      break;

    case 'Network.webSocketHandshakeResponseReceived':
      send(port, { type: 'WS_HANDSHAKE', requestId: params.requestId,
        status: params.response?.status, headers: params.response?.headers, timestamp: Date.now() });
      break;

    // WS frames
    case 'Network.webSocketFrameSent':
      send(port, { type: 'WS_FRAME_SENT', requestId: params.requestId,
        data: params.response.payloadData, opcode: params.response.opcode,
        timestamp: params.timestamp ? params.timestamp * 1000 : Date.now() });
      break;

    case 'Network.webSocketFrameReceived':
      send(port, { type: 'WS_FRAME_RECEIVED', requestId: params.requestId,
        data: params.response.payloadData, opcode: params.response.opcode,
        timestamp: params.timestamp ? params.timestamp * 1000 : Date.now() });
      break;

    case 'Network.webSocketFrameError':
      send(port, { type: 'WS_FRAME_ERROR', requestId: params.requestId,
        errorMessage: params.errorMessage, timestamp: Date.now() });
      break;

    // WS intercept binding
    case 'Runtime.bindingCalled': {
      if (params.name !== WS_BINDING) break;
      let payload;
      try { payload = JSON.parse(params.payload); } catch { break; }
      send(port, { type: 'WS_INTERCEPTED', msgId: payload.id, socketUrl: payload.url,
        data: payload.data, dataType: payload.dataType, timestamp: Date.now() });
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  debuggerState.delete(tabId);
  interceptedRequests.forEach((data, rid) => { if (data.tabId === tabId) interceptedRequests.delete(rid); });
  send(connections.get(tabId), { type: 'DEBUGGER_DETACHED', reason });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HELPERS ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function send(port, msg) {
  if (!port) return;
  try { port.postMessage(msg); } catch (_) {}
}
