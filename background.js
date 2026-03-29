/**
 * background.js — DevTools Pro Service Worker
 *
 * Responsibilities:
 *  - Manage chrome.debugger lifecycle (attach / detach)
 *  - Enable the CDP Fetch domain to intercept requests
 *  - Optionally disable the Runtime domain (no-js mode)
 *  - Relay CDP Fetch.requestPaused events to the devtools panel
 *  - Accept forward / drop / modify commands from the panel
 */

// ─── Panel Registry ────────────────────────────────────────────────────────────
// Maps tabId → MessagePort (the panel connected for that tab)
const panelPorts = new Map();

// Maps tabId → current intrude mode ('no-js' | 'yes-js' | null)
const attachedTabs = new Map();

// Maps requestId → {tabId, ...CDPParams}
const pendingRequests = new Map();

// Maps tabId -> bool (whether WS Intruder is attached )
const wsAttachedTabs = new Map();
const pendingWsMessages = new Map(); // messageId -> resolve Function or pending data

// ─── Panel Connection ──────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  // Port name convention: "panel_{tabId}"
  const match = port.name.match(/^panel_(\d+)$/);
  if (!match) return;

  const tabId = parseInt(match[1], 10);
  panelPorts.set(tabId, port);

  port.onMessage.addListener((msg) => handlePanelMessage(tabId, msg));

  port.onDisconnect.addListener(() => {
    panelPorts.delete(tabId);
    // Auto-detach when panel closes
    if (attachedTabs.has(tabId)) {
      safeDetach(tabId);
    }
  });
});

// ─── Panel Message Handler ─────────────────────────────────────────────────────
async function handlePanelMessage(tabId, msg) {
  switch (msg.type) {

    case 'intrude:attach':
      await intrudeAttach(tabId, msg.mode);
      break;

    case 'intrude:detach':
      await intrudeDetach(tabId);
      break;

    case 'intrude:forward':
      await intrudeForward(tabId, msg.requestId, msg.modifications);
      break;

    case 'intrude:drop':
      await intrudeDrop(tabId, msg.requestId);
      break;

    case 'js:enable':
      await jsEnable(tabId);
      break;

    case 'js:disable':
      await jsDisable(tabId);
      break;

    case 'ws:attach':
      await wsAttach(tabId);
      break;

    case 'ws:detach':
      await wsDetach(tabId);
      break;

    case 'ws:forward':
      await wsForward(tabId, msg.messageId, msg.payload, msg.direction);
      break;

    case 'ws:drop':
      await wsDrop(tabId, msg.messageId);
      break;

    case 'ws:create':
      await wsCreateAndSend(tabId, msg.payload);
      break;

    default:
      console.warn('[DevTools Pro] Unknown message type:', msg.type);
  }
}

// ─── Debugger Attach / Detach ──────────────────────────────────────────────────
async function intrudeAttach(tabId, mode) {
  try {
    // Detach first if already attached (mode switch)
    if (attachedTabs.has(tabId)) {
      await safeDetach(tabId);
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.set(tabId, mode);

    // Enable Fetch interception – intercept ALL requests at the Request stage
    await cdp(tabId, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: false,
    });

    // Enable Debugger domain (needed for JS pausing)
    await cdp(tabId, 'Debugger.enable', {});

    if (mode === 'no-js') {
      // Disable JS runtime so no new scripts execute
      await cdp(tabId, 'Runtime.disable', {});
    }

    sendToPanel(tabId, { type: 'intrude:attached', mode });
  } catch (err) {
    sendToPanel(tabId, { type: 'error', message: err.message });
  }
}

async function intrudeDetach(tabId) {
  sendToPanel(tabId, { type: 'intrude:detached' });
  await safeDetach(tabId);
}

async function safeDetach(tabId) {
  try {
    // Re-enable everything before detaching
    await cdp(tabId, 'Runtime.enable', {}).catch(() => {});
    await cdp(tabId, 'Debugger.disable', {}).catch(() => {});
    await cdp(tabId, 'Fetch.disable', {}).catch(() => {});
    await chrome.debugger.detach({ tabId });
  } catch (_) { /* already detached */ }
  attachedTabs.delete(tabId);

  // Clear pending requests for this tab
  for (const [reqId, data] of pendingRequests.entries()) {
    if (data.tabId === tabId) pendingRequests.delete(reqId);
  }
}

// ─── JS Enable / Disable ──────────────────────────────────────────────────────
async function jsEnable(tabId) {
  try {
    await cdp(tabId, 'Runtime.enable', {});
    sendToPanel(tabId, { type: 'js:enabled' });
  } catch (err) {
    sendToPanel(tabId, { type: 'error', message: err.message });
  }
}

async function jsDisable(tabId) {
  try {
    await cdp(tabId, 'Runtime.disable', {});
    sendToPanel(tabId, { type: 'js:disabled' });
  } catch (err) {
    sendToPanel(tabId, { type: 'error', message: err.message });
  }
}

// ─── Forward / Drop Intercepted Requests ──────────────────────────────────────
async function intrudeForward(tabId, requestId, modifications) {
  try {
    const params = { requestId };

    if (modifications) {
      if (modifications.url)     params.url      = modifications.url;
      if (modifications.method)  params.method   = modifications.method;

      if (modifications.headers) {
        params.headers = Object.entries(modifications.headers).map(
          ([name, value]) => ({ name, value })
        );
      }

      if (modifications.postData !== undefined) {
        // Chrome CDP expects base64-encoded body
        params.postData = btoa(unescape(encodeURIComponent(modifications.postData)));
      }
    }

    await cdp(tabId, 'Fetch.continueRequest', params);
    pendingRequests.delete(requestId);
    sendToPanel(tabId, { type: 'intrude:forwarded', requestId });
  } catch (err) {
    sendToPanel(tabId, { type: 'error', message: err.message });
  }
}

async function intrudeDrop(tabId, requestId) {
  try {
    await cdp(tabId, 'Fetch.failRequest', {
      requestId,
      errorReason: 'BlockedByClient',
    });
    pendingRequests.delete(requestId);
    sendToPanel(tabId, { type: 'intrude:dropped', requestId });
  } catch (err) {
    sendToPanel(tabId, { type: 'error', message: err.message });
  }
}

// ─── CDP Event Listener ────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  switch (method) {
    case 'Fetch.requestPaused': {
      // Store pending request
      pendingRequests.set(params.requestId, { tabId, ...params });

      // Relay to panel with clean structure
      sendToPanel(tabId, {
        type: 'intrude:requestPaused',
        requestId:       params.requestId,
        url:             params.request.url,
        method:          params.request.method,
        headers:         params.request.headers,
        postData:        params.request.postData || null,
        resourceType:    params.resourceType,
        frameId:         params.frameId,
        networkId:       params.networkId,
        timestamp:       Date.now(),
      });
      break;
    }

    case 'Debugger.paused':
      sendToPanel(tabId, { type: 'js:paused', reason: params.reason });
      break;

    case 'Debugger.resumed':
      sendToPanel(tabId, { type: 'js:resumed' });
      break;
  }
});

// Debugger forcefully detached (user navigated, tab closed, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  attachedTabs.delete(tabId);
  for (const [reqId, data] of pendingRequests.entries()) {
    if (data.tabId === tabId) pendingRequests.delete(reqId);
  }
  sendToPanel(tabId, { type: 'intrude:detached', reason });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function sendToPanel(tabId, msg) {
  const port = panelPorts.get(tabId);
  if (port) {
    try { port.postMessage(msg); } catch (_) { /* panel disconnected */ }
  }
}
