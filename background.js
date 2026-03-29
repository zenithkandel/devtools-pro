/**
 * background.js - DevTools Pro Service Worker
 *
 * Responsibilities:
 *  - Manage chrome.debugger lifecycle
 *  - Intercept HTTP requests for intrude mode (Fetch domain)
 *  - Monitor WebSocket lifecycle and frames (Network domain)
 *  - Relay events between CDP and panel.js
 */

'use strict';

// Maps tabId -> MessagePort
const panelPorts = new Map();

// Maps tabId -> intrude mode: 'no-js' | 'yes-js'
const intrudeTabs = new Map();

// Tabs where WS monitor is active
const wsTabs = new Set();

// Maps requestId -> { tabId, ...CDPParams }
const pendingRequests = new Map();

// Maps tabId -> Map(wsRequestId -> url)
const wsConnectionsByTab = new Map();

chrome.runtime.onConnect.addListener((port) => {
    const match = port.name.match(/^panel_(\d+)$/);
    if (!match) return;

    const tabId = parseInt(match[1], 10);
    panelPorts.set(tabId, port);

    port.onMessage.addListener((msg) => {
        handlePanelMessage(tabId, msg).catch((err) => {
            sendToPanel(tabId, { type: 'error', message: err.message });
        });
    });

    port.onDisconnect.addListener(() => {
        panelPorts.delete(tabId);
        teardownTab(tabId).catch(() => {
            // Ignore teardown errors on disconnect.
        });
    });
});

async function handlePanelMessage(tabId, msg) {
    switch (msg.type) {
        case 'intrude:attach':
            await intrudeAttach(tabId, msg.mode);
            return;

        case 'intrude:detach':
            await intrudeDetach(tabId);
            return;

        case 'intrude:forward':
            await intrudeForward(tabId, msg.requestId, msg.modifications);
            return;

        case 'intrude:drop':
            await intrudeDrop(tabId, msg.requestId);
            return;

        case 'js:enable':
            await jsEnable(tabId);
            return;

        case 'js:disable':
            await jsDisable(tabId);
            return;

        case 'ws:attach':
            await wsAttach(tabId);
            return;

        case 'ws:detach':
            await wsDetach(tabId);
            return;

        case 'ws:forward':
            await wsForward(tabId, msg.messageId, msg.payload);
            return;

        case 'ws:drop':
            await wsDrop(tabId, msg.messageId);
            return;

        case 'ws:create':
            await wsCreateAndSend(tabId, msg.payload);
            return;

        default:
            console.warn('[DevTools Pro] Unknown message type:', msg.type);
            return;
    }
}

async function intrudeAttach(tabId, mode) {
    try {
        await ensureDebuggerAttached(tabId);

        intrudeTabs.set(tabId, mode);

        await cdp(tabId, 'Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
            handleAuthRequests: false,
        });

        await cdp(tabId, 'Debugger.enable', {});

        if (mode === 'no-js') {
            await cdp(tabId, 'Runtime.disable', {});
        } else {
            await cdp(tabId, 'Runtime.enable', {});
        }

        sendToPanel(tabId, { type: 'intrude:attached', mode });
    } catch (err) {
        sendToPanel(tabId, { type: 'error', message: err.message });
    }
}

async function intrudeDetach(tabId) {
    intrudeTabs.delete(tabId);

    for (const [requestId, data] of pendingRequests.entries()) {
        if (data.tabId === tabId) {
            pendingRequests.delete(requestId);
        }
    }

    try {
        await cdp(tabId, 'Fetch.disable', {});
    } catch (_) {
        // Ignore if already disabled/not attached.
    }

    try {
        await cdp(tabId, 'Debugger.disable', {});
    } catch (_) {
        // Ignore if already disabled/not attached.
    }

    try {
        await cdp(tabId, 'Runtime.enable', {});
    } catch (_) {
        // Ignore if already enabled/not attached.
    }

    await detachIfUnmanaged(tabId);
    sendToPanel(tabId, { type: 'intrude:detached' });
}

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

async function intrudeForward(tabId, requestId, modifications) {
    try {
        const params = { requestId };

        if (modifications) {
            if (modifications.url) params.url = modifications.url;
            if (modifications.method) params.method = modifications.method;

            if (modifications.headers) {
                params.headers = Object.entries(modifications.headers).map(([name, value]) => ({
                    name,
                    value,
                }));
            }

            if (modifications.postData !== undefined) {
                params.postData = base64EncodeUnicode(modifications.postData);
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

async function wsAttach(tabId) {
    try {
        await ensureDebuggerAttached(tabId);

        wsTabs.add(tabId);
        ensureWsTabMap(tabId);

        await cdp(tabId, 'Network.enable', {});
        await cdp(tabId, 'Runtime.enable', {});
        await installWsSenderHelper(tabId);

        sendToPanel(tabId, { type: 'ws:attached' });
    } catch (err) {
        sendToPanel(tabId, { type: 'error', message: err.message });
    }
}

async function wsDetach(tabId) {
    wsTabs.delete(tabId);
    wsConnectionsByTab.delete(tabId);

    try {
        await cdp(tabId, 'Network.disable', {});
    } catch (_) {
        // Ignore if domain is already disabled/not attached.
    }

    await detachIfUnmanaged(tabId);
    sendToPanel(tabId, { type: 'ws:detached' });
}

async function wsForward(tabId, messageId, payload) {
    // Frame interception is not synchronous in CDP Network events. When the user
    // edits and forwards, send payload as a new frame through the active socket.
    if (typeof payload === 'string' && payload.length > 0) {
        await wsCreateAndSend(tabId, payload);
    }

    sendToPanel(tabId, { type: 'ws:forwarded', messageId });
}

async function wsDrop(tabId, messageId) {
    // See note in wsForward.
    sendToPanel(tabId, { type: 'ws:dropped', messageId });
}

async function wsCreateAndSend(tabId, payload) {
    try {
        const expression = `(() => {
      if (typeof window.__devtoolsProWsSendCustom !== 'function') return false;
      return window.__devtoolsProWsSendCustom(${JSON.stringify(payload || '')});
    })()`;

        const result = await cdp(tabId, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });

        const ok = Boolean(result && result.result && result.result.value);
        if (!ok) {
            sendToPanel(tabId, {
                type: 'error',
                message: 'No open WebSocket instance found on the page.',
            });
            return;
        }

        sendToPanel(tabId, { type: 'ws:created' });
    } catch (err) {
        sendToPanel(tabId, { type: 'error', message: err.message });
    }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;

    if (method === 'Fetch.requestPaused' && intrudeTabs.has(tabId)) {
        pendingRequests.set(params.requestId, { tabId, ...params });

        sendToPanel(tabId, {
            type: 'intrude:requestPaused',
            requestId: params.requestId,
            url: params.request.url,
            method: params.request.method,
            headers: params.request.headers,
            postData: params.request.postData || null,
            resourceType: params.resourceType,
            frameId: params.frameId,
            networkId: params.networkId,
            timestamp: Date.now(),
        });
        return;
    }

    if (!wsTabs.has(tabId)) {
        return;
    }

    switch (method) {
        case 'Network.webSocketCreated': {
            const wsMap = ensureWsTabMap(tabId);
            wsMap.set(params.requestId, params.url || '');

            sendToPanel(tabId, {
                type: 'ws:socketDetected',
                requestId: params.requestId,
                url: params.url || '',
                timestamp: Date.now(),
            });
            return;
        }

        case 'Network.webSocketClosed': {
            const wsMap = ensureWsTabMap(tabId);
            wsMap.delete(params.requestId);
            return;
        }

        case 'Network.webSocketFrameSent': {
            relayWsFrame(tabId, params, 'sent');
            return;
        }

        case 'Network.webSocketFrameReceived': {
            relayWsFrame(tabId, params, 'recv');
            return;
        }

        default:
            return;
    }
});

chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (!tabId) return;

    intrudeTabs.delete(tabId);
    wsTabs.delete(tabId);
    wsConnectionsByTab.delete(tabId);

    for (const [requestId, data] of pendingRequests.entries()) {
        if (data.tabId === tabId) {
            pendingRequests.delete(requestId);
        }
    }

    sendToPanel(tabId, { type: 'intrude:detached', reason });
    sendToPanel(tabId, { type: 'ws:detached', reason });
});

function relayWsFrame(tabId, params, direction) {
    const wsMap = ensureWsTabMap(tabId);
    const requestId = params.requestId || '';
    const frame = params.response || {};
    const payload = frame.payloadData || '';
    const url = wsMap.get(requestId) || '';

    sendToPanel(tabId, {
        type: 'ws:messagePaused',
        messageId: `ws_${direction}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        requestId,
        url,
        direction,
        payload,
        opcode: frame.opcode,
        timestamp: Date.now(),
    });
}

async function teardownTab(tabId) {
    intrudeTabs.delete(tabId);
    wsTabs.delete(tabId);
    wsConnectionsByTab.delete(tabId);

    for (const [requestId, data] of pendingRequests.entries()) {
        if (data.tabId === tabId) {
            pendingRequests.delete(requestId);
        }
    }

    try {
        await chrome.debugger.detach({ tabId });
    } catch (_) {
        // Ignore if debugger is already detached.
    }
}

async function detachIfUnmanaged(tabId) {
    if (intrudeTabs.has(tabId) || wsTabs.has(tabId)) {
        return;
    }

    try {
        await chrome.debugger.detach({ tabId });
    } catch (_) {
        // Ignore if debugger is already detached.
    }
}

async function ensureDebuggerAttached(tabId) {
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
        const message = err && err.message ? err.message : '';
        if (!message.includes('already attached')) {
            throw err;
        }
    }
}

function ensureWsTabMap(tabId) {
    if (!wsConnectionsByTab.has(tabId)) {
        wsConnectionsByTab.set(tabId, new Map());
    }
    return wsConnectionsByTab.get(tabId);
}

async function installWsSenderHelper(tabId) {
    const helperSource = `
    (() => {
      if (window.__devtoolsProWsHelperInstalled) return;
      window.__devtoolsProWsHelperInstalled = true;

      const NativeWebSocket = window.WebSocket;
      const trackedSockets = [];

      function DevtoolsProWebSocket(...args) {
        const ws = new NativeWebSocket(...args);
        trackedSockets.push(ws);
        return ws;
      }

      DevtoolsProWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(DevtoolsProWebSocket, NativeWebSocket);

      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(NativeWebSocket, key)) {
          DevtoolsProWebSocket[key] = NativeWebSocket[key];
        }
      });

      window.WebSocket = DevtoolsProWebSocket;

      window.__devtoolsProWsSendCustom = (payload) => {
        for (let i = trackedSockets.length - 1; i >= 0; i -= 1) {
          const ws = trackedSockets[i];
          if (ws && ws.readyState === NativeWebSocket.OPEN) {
            ws.send(payload);
            return true;
          }
        }
        return false;
      };
    })();
  `;

    await cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
        source: helperSource,
    });

    await cdp(tabId, 'Runtime.evaluate', {
        expression: helperSource,
    });
}

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
    if (!port) return;

    try {
        port.postMessage(msg);
    } catch (_) {
        // Ignore disconnected port race.
    }
}

function base64EncodeUnicode(input) {
    const text = typeof input === 'string' ? input : '';
    const encoded = unescape(encodeURIComponent(text));
    return btoa(encoded);
}
