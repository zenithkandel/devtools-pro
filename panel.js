/**
 * panel.js — DevTools Pro
 *
 * Runs in the DevTools panel context.
 * Communicates with background.js via chrome.runtime.connect.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STATE ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const tabId = chrome.devtools.inspectedWindow.tabId;

const state = {
  // UI
  activeTab: 'network',   // 'network' | 'intrude'
  activeDetailTab: 'headers',

  // Network tab
  requests: [],           // collected HAR-ish entries
  selectedRequest: null,
  recording: true,
  urlFilter: '',
  methodFilter: 'ALL',

  // Intrude tab
  attached: false,
  intrudeMode: 'no-js',   // 'no-js' | 'yes-js'
  jsEnabled: true,         // runtime JS state while attached
  queue: [],              // intercepted requests pending action
  selectedQueueId: null,
};

// Background port
let port = null;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BACKGROUND PORT ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function connectBackground() {
  port = chrome.runtime.connect({ name: `panel_${tabId}` });
  port.onMessage.addListener(onBackgroundMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    if (state.attached) {
      state.attached = false;
      updateIntrudeUI();
      toast('Background disconnected — intrude detached.', 'warning');
    }
    setTimeout(connectBackground, 1500);
  });
}

function sendBg(msg) {
  if (port) {
    try { port.postMessage(msg); }
    catch (_) { toast('Port error — reconnecting…', 'error'); }
  }
}

function onBackgroundMessage(msg) {
  switch (msg.type) {

    case 'intrude:attached':
      state.attached = true;
      state.jsEnabled = (msg.mode !== 'no-js');
      updateIntrudeUI();
      toast(`Attached in ${msg.mode === 'no-js' ? 'No JS · No Forward' : 'Yes JS · No Forward'} mode.`, 'success');
      break;

    case 'intrude:detached':
      state.attached = false;
      state.queue = [];
      state.selectedQueueId = null;
      updateIntrudeUI();
      renderQueue();
      renderEditor();
      toast(msg.reason ? `Detached: ${msg.reason}` : 'Detached.', 'info');
      break;

    case 'intrude:requestPaused':
      addToQueue(msg);
      break;

    case 'intrude:forwarded':
      removeFromQueue(msg.requestId, 'Forwarded');
      break;

    case 'intrude:dropped':
      removeFromQueue(msg.requestId, 'Dropped');
      break;

    case 'js:enabled':
      state.jsEnabled = true;
      updateJsToggle();
      toast('JavaScript enabled.', 'success');
      break;

    case 'js:disabled':
      state.jsEnabled = false;
      updateJsToggle();
      toast('JavaScript disabled.', 'warning');
      break;

    case 'error':
      toast(msg.message, 'error');
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NETWORK MONITORING ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  if (!state.recording) return;

  const req = harEntry.request;
  const res = harEntry.response;

  const entry = {
    id:         generateId(),
    method:     req.method,
    url:        req.url,
    status:     res.status,
    statusText: res.statusText,
    mimeType:   res.content?.mimeType ?? '',
    size:       res.bodySize > 0 ? res.bodySize : (res.content?.size ?? 0),
    time:       harEntry.time ?? 0,
    startedAt:  harEntry.startedDateTime,
    reqHeaders: req.headers ?? [],
    resHeaders: res.headers ?? [],
    postData:   req.postData ?? null,
    timings:    harEntry.timings ?? {},
    _har:       harEntry,
  };

  state.requests.push(entry);
  appendRequestRow(entry);
  updateStatusBar();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NETWORK TABLE ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function filteredRequests() {
  return state.requests.filter(r => {
    if (state.methodFilter !== 'ALL' && r.method !== state.methodFilter) return false;
    if (state.urlFilter && !r.url.toLowerCase().includes(state.urlFilter.toLowerCase())) return false;
    return true;
  });
}

function rebuildTable() {
  const body = $('request-list-body');
  body.innerHTML = '';
  const empty = $('net-empty');
  const rows = filteredRequests();

  if (rows.length === 0) {
    body.appendChild(createEmpty('📡', 'Listening for network requests…\nReload the page to capture traffic.'));
    return;
  }

  rows.forEach(r => body.appendChild(makeRequestRow(r)));
  updateStatusBar();
}

function appendRequestRow(entry) {
  $('net-empty')?.remove();
  if (!matchesFilter(entry)) return;
  $('request-list-body').appendChild(makeRequestRow(entry));
  updateStatusBar();
}

function matchesFilter(r) {
  if (state.methodFilter !== 'ALL' && r.method !== state.methodFilter) return false;
  if (state.urlFilter && !r.url.toLowerCase().includes(state.urlFilter.toLowerCase())) return false;
  return true;
}

function makeRequestRow(entry) {
  const row = document.createElement('div');
  row.className = 'request-row net-grid';
  row.dataset.id = entry.id;

  const shortUrl = shortenUrl(entry.url);
  const type     = mimeToType(entry.mimeType);

  row.innerHTML = `
    <span class="method-badge m-${entry.method}">${entry.method}</span>
    <span>${statusBadge(entry.status)}</span>
    <span style="color:var(--text-2);font-size:9.5px;">${esc(type)}</span>
    <span class="col-url" title="${esc(entry.url)}">${esc(shortUrl)}</span>
    <span style="color:var(--text-1);">${formatBytes(entry.size)}</span>
    <span style="color:var(--text-1);">${formatTime(entry.time)}</span>
  `;

  row.addEventListener('click', () => selectRequest(entry, row));
  return row;
}

function selectRequest(entry, row) {
  // De-select previous
  document.querySelectorAll('.request-row.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  state.selectedRequest = entry;
  showDetailPane(entry);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DETAIL PANE ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function showDetailPane(entry) {
  const pane = $('request-detail-pane');
  pane.classList.remove('hidden');
  renderDetailTab(state.activeDetailTab, entry);
}

function renderDetailTab(dtab, entry) {
  entry = entry ?? state.selectedRequest;
  if (!entry) return;
  const body = $('detail-content');
  body.innerHTML = '';

  switch (dtab) {
    case 'headers':  renderHeadersTab(body, entry);  break;
    case 'payload':  renderPayloadTab(body, entry);  break;
    case 'response': renderResponseTab(body, entry); break;
    case 'timing':   renderTimingTab(body, entry);   break;
  }
}

function renderHeadersTab(container, entry) {
  // General info
  container.appendChild(kvSection('General', [
    ['Request URL',    entry.url],
    ['Request Method', entry.method],
    ['Status Code',    `${entry.status} ${entry.statusText}`],
    ['MIME Type',      entry.mimeType],
  ]));

  // Response Headers
  container.appendChild(headersSection('Response Headers', entry.resHeaders));

  // Request Headers
  container.appendChild(headersSection('Request Headers', entry.reqHeaders));
}

function renderPayloadTab(container, entry) {
  if (!entry.postData) {
    container.appendChild(createEmpty('📭', 'No request payload for this request.'));
    return;
  }
  const pd = entry.postData;
  container.appendChild(kvSection('Payload Info', [
    ['Content-Type', pd.mimeType ?? ''],
  ]));

  const pre = document.createElement('div');
  pre.className = 'pre-block';
  pre.textContent = pd.text ?? '';
  container.appendChild(pre);
}

function renderResponseTab(container, entry) {
  entry._har.getContent((content, encoding) => {
    const pre = document.createElement('div');
    pre.className = 'pre-block';

    if (encoding === 'base64') {
      try {
        const decoded = atob(content);
        pre.textContent = tryPrettyJson(decoded);
      } catch {
        pre.textContent = '[binary content]';
      }
    } else {
      pre.textContent = tryPrettyJson(content ?? '');
    }

    container.appendChild(pre);
  });
}

function renderTimingTab(container, entry) {
  const t = entry.timings;
  const rows = [
    ['Blocked',     t.blocked,   'ms'],
    ['DNS',         t.dns,       'ms'],
    ['SSL',         t.ssl,       'ms'],
    ['Connect',     t.connect,   'ms'],
    ['Send',        t.send,      'ms'],
    ['Wait (TTFB)', t.wait,      'ms'],
    ['Receive',     t.receive,   'ms'],
    ['Total',       entry.time,  'ms'],
  ].filter(([, v]) => v != null && v >= 0);

  container.appendChild(kvSection('Timings', rows.map(([k,,]) => [k, rows.find(r=>r[0]===k)[1].toFixed(2) + ' ms'])));

  // Simple bar chart
  const total = entry.time || 1;
  const barWrap = document.createElement('div');
  barWrap.style.cssText = 'margin-top:10px;';
  rows.forEach(([label, val]) => {
    if (val <= 0) return;
    const pct = Math.min((val / total) * 100, 100).toFixed(1);
    barWrap.innerHTML += `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="width:90px;color:var(--text-2);font-size:9px;">${label}</span>
        <div style="flex:1;height:8px;background:var(--bg-3);border-radius:2px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:var(--cyan);border-radius:2px;"></div>
        </div>
        <span style="width:55px;text-align:right;color:var(--text-1);font-size:9px;">${val.toFixed(1)}ms</span>
      </div>`;
  });
  container.appendChild(barWrap);
}

// ─── Detail builders ──────────────────────────────────────────────────────────

function kvSection(title, pairs) {
  const wrap = document.createElement('div');
  wrap.className = 'kv-section';
  wrap.innerHTML = `<div class="kv-title">${esc(title)}</div>`;
  pairs.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `<span class="kv-key">${esc(k)}</span><span class="kv-val">${esc(String(v ?? ''))}</span>`;
    wrap.appendChild(row);
  });
  return wrap;
}

function headersSection(title, headers) {
  return kvSection(title, (headers ?? []).map(h => [h.name, h.value]));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── INTRUDE — QUEUE ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function addToQueue(req) {
  state.queue.push(req);
  renderQueue();
  // Auto-select first item if nothing selected
  if (!state.selectedQueueId && state.queue.length === 1) {
    selectQueueItem(req.requestId);
  }
  updateQueueCount();
  toast(`Intercepted: ${req.method} ${shortenUrl(req.url, 50)}`, 'warning');
}

function removeFromQueue(requestId, label) {
  state.queue = state.queue.filter(r => r.requestId !== requestId);
  if (state.selectedQueueId === requestId) {
    state.selectedQueueId = state.queue[0]?.requestId ?? null;
  }
  renderQueue();
  renderEditor();
  updateQueueCount();
  if (label) toast(`${label}: ${requestId.slice(-8)}`, 'info');
}

function renderQueue() {
  const body = $('intercept-queue-body');
  body.innerHTML = '';

  if (state.queue.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.innerHTML = `<div>🟢</div><span>${state.attached ? 'No intercepted requests yet.<br>Traffic will appear here.' : 'Attach to start intercepting.<br>Captured requests appear here.'}</span>`;
    body.appendChild(empty);
    return;
  }

  state.queue.forEach(req => {
    const item = document.createElement('div');
    item.className = 'queue-item' + (req.requestId === state.selectedQueueId ? ' selected' : '');
    item.dataset.id = req.requestId;

    const time = new Date(req.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const type = (req.resourceType ?? 'unknown').toLowerCase();

    item.innerHTML = `
      <div class="qi-top">
        <span class="qi-method">${esc(req.method)}</span>
        <span class="qi-type">${esc(type)}</span>
        <span class="qi-time">${time}</span>
      </div>
      <div class="qi-url" title="${esc(req.url)}">${esc(shortenUrl(req.url, 55))}</div>
    `;
    item.addEventListener('click', () => selectQueueItem(req.requestId));
    body.appendChild(item);
  });
}

function selectQueueItem(requestId) {
  state.selectedQueueId = requestId;
  document.querySelectorAll('.queue-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === requestId);
  });
  renderEditor();
}

function updateQueueCount() {
  $('queue-count').textContent = state.queue.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── INTRUDE — EDITOR ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function renderEditor() {
  const noReq = $('editor-no-request');
  const content = $('editor-content');

  const req = state.queue.find(r => r.requestId === state.selectedQueueId);

  if (!req) {
    noReq.style.display = 'flex';
    content.style.display = 'none';
    return;
  }

  noReq.style.display = 'none';
  content.style.display = 'flex';

  // Populate fields
  $('ed-method').textContent = req.method;
  $('ed-url').textContent = shortenUrl(req.url, 60);
  $('ed-url-input').value = req.url;
  $('ed-method-select').value = req.method;

  // Headers → textarea (name: value per line)
  const headers = req.headers ?? {};
  $('ed-headers').value = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  // Body
  const body = req.postData ?? '';
  $('ed-body').value = body;

  // Body type label
  const ct = (headers['content-type'] ?? headers['Content-Type'] ?? '').split(';')[0].trim();
  $('ed-body-type').textContent = ct || 'raw';
}

// Parse the textarea headers back into an object
function parseHeadersField() {
  const raw = $('ed-headers').value.trim();
  const obj = {};
  for (const line of raw.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (key) obj[key] = val;
  }
  return obj;
}

function buildModifications() {
  return {
    url:      $('ed-url-input').value.trim(),
    method:   $('ed-method-select').value,
    headers:  parseHeadersField(),
    postData: $('ed-body').value,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── INTRUDE CONTROLS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function updateIntrudeUI() {
  const dot     = $('intrude-dot');
  const label   = $('intrude-status-label');
  const attachB = $('attach-btn');
  const modesSel= $('mode-selector');
  const jsTog   = $('js-toggle-btn');

  if (state.attached) {
    dot.classList.add('active');
    label.textContent = `Attached · ${state.intrudeMode === 'no-js' ? 'No JS · No Forward' : 'Yes JS · No Forward'}`;
    attachB.textContent = '✕ Detach';
    attachB.classList.add('detach');
    modesSel.style.opacity = '.4';
    modesSel.style.pointerEvents = 'none';
    jsTog.classList.remove('hidden');
    updateJsToggle();
  } else {
    dot.classList.remove('active');
    label.textContent = 'Not attached — select a mode and attach.';
    attachB.textContent = '⚡ Attach';
    attachB.classList.remove('detach');
    modesSel.style.opacity = '';
    modesSel.style.pointerEvents = '';
    jsTog.classList.add('hidden');
  }
}

function updateJsToggle() {
  const btn = $('js-toggle-btn');
  btn.textContent = `JS: ${state.jsEnabled ? 'ON' : 'OFF'}`;
  btn.className = `js-toggle ${state.jsEnabled ? 'js-on' : 'js-off'}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STATUS BAR ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function updateStatusBar() {
  const visible = filteredRequests();
  const totalSize = visible.reduce((s, r) => s + (r.size > 0 ? r.size : 0), 0);
  const totalTime = visible.reduce((s, r) => s + (r.time > 0 ? r.time : 0), 0);

  $('sb-count').textContent = `${visible.length} request${visible.length !== 1 ? 's' : ''}`;
  $('sb-size').textContent  = formatBytes(totalSize);
  $('sb-time').textContent  = formatTime(totalTime);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RESIZE HANDLE ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function initResizeHandle() {
  const handle  = $('net-resize');
  const detail  = $('request-detail-pane');
  let dragging  = false;
  let startX, startW;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = detail.offsetWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = startX - e.clientX;
    const newW = Math.min(Math.max(startW + dx, 200), window.innerWidth * 0.7);
    detail.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TOASTS ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function toast(msg, type = 'info', duration = 3000) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EVENT WIRING ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function wireEvents() {

  // ── Tab switching ──────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
      $('net-controls').style.display = tab === 'network' ? 'flex' : 'none';
    });
  });

  // ── Network controls ───────────────────────────────────────
  $('btn-record').addEventListener('click', () => {
    state.recording = !state.recording;
    $('btn-record').textContent = state.recording ? '⏸ Pause' : '▶ Record';
    toast(state.recording ? 'Recording resumed.' : 'Recording paused.', 'info');
  });

  $('btn-clear').addEventListener('click', () => {
    state.requests = [];
    state.selectedRequest = null;
    $('request-list-body').innerHTML = '';
    $('request-list-body').appendChild(createEmpty('📡', 'Listening for network requests…\nReload the page to capture traffic.'));
    $('request-detail-pane').classList.add('hidden');
    updateStatusBar();
  });

  $('filter-input').addEventListener('input', (e) => {
    state.urlFilter = e.target.value;
    rebuildTable();
  });

  $('method-filter').addEventListener('change', (e) => {
    state.methodFilter = e.target.value;
    rebuildTable();
  });

  // ── Detail tab switching ───────────────────────────────────
  document.querySelectorAll('.detail-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeDetailTab = btn.dataset.dtab;
      document.querySelectorAll('.detail-tab').forEach(b => b.classList.toggle('active', b === btn));
      renderDetailTab(state.activeDetailTab);
    });
  });

  // ── Intrude: Mode selection ────────────────────────────────
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.intrudeMode = btn.dataset.mode;
    });
  });

  // ── Intrude: Attach / Detach ───────────────────────────────
  $('attach-btn').addEventListener('click', () => {
    if (!state.attached) {
      sendBg({ type: 'intrude:attach', mode: state.intrudeMode });
    } else {
      sendBg({ type: 'intrude:detach' });
    }
  });

  // ── Intrude: JS Toggle ─────────────────────────────────────
  $('js-toggle-btn').addEventListener('click', () => {
    if (state.jsEnabled) {
      sendBg({ type: 'js:disable' });
    } else {
      sendBg({ type: 'js:enable' });
    }
  });

  // ── Intrude: Forward ──────────────────────────────────────
  $('btn-forward').addEventListener('click', () => {
    const reqId = state.selectedQueueId;
    if (!reqId) return;
    const mods = buildModifications();
    sendBg({ type: 'intrude:forward', requestId: reqId, modifications: mods });
  });

  // ── Intrude: Drop ─────────────────────────────────────────
  $('btn-drop').addEventListener('click', () => {
    const reqId = state.selectedQueueId;
    if (!reqId) return;
    sendBg({ type: 'intrude:drop', requestId: reqId });
  });

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + F → focus filter
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.activeTab === 'network') {
      e.preventDefault();
      $('filter-input').focus();
    }
    // Ctrl/Cmd + L → clear network
    if ((e.ctrlKey || e.metaKey) && e.key === 'l' && state.activeTab === 'network') {
      e.preventDefault();
      $('btn-clear').click();
    }
    // F (forward) when in intrude and an item is selected
    if (e.key === 'f' && state.activeTab === 'intrude' && state.selectedQueueId) {
      if (!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
        $('btn-forward').click();
      }
    }
    // D (drop) when in intrude
    if (e.key === 'd' && state.activeTab === 'intrude' && state.selectedQueueId) {
      if (!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
        $('btn-drop').click();
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HELPERS ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateId() {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function shortenUrl(url, maxLen = 80) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const full = u.host + path;
    if (full.length <= maxLen) return full;
    return full.slice(0, maxLen - 1) + '…';
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen - 1) + '…' : url;
  }
}

function statusBadge(code) {
  const cls = code >= 500 ? 'status-5xx'
            : code >= 400 ? 'status-4xx'
            : code >= 300 ? 'status-3xx'
            : code >= 200 ? 'status-2xx'
            : 'status-0xx';
  return `<span class="status-badge ${cls}">${code || '—'}</span>`;
}

function mimeToType(mime) {
  if (!mime) return 'other';
  if (mime.includes('javascript'))    return 'script';
  if (mime.includes('json'))          return 'json';
  if (mime.includes('html'))          return 'html';
  if (mime.includes('css'))           return 'css';
  if (mime.includes('image'))         return 'img';
  if (mime.includes('font'))          return 'font';
  if (mime.includes('xml'))           return 'xml';
  if (mime.includes('websocket'))     return 'ws';
  if (mime.includes('plain'))         return 'text';
  return mime.split('/').pop().split(';')[0];
}

function formatBytes(b) {
  if (!b || b <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatTime(ms) {
  if (!ms || ms < 0) return '0 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

function tryPrettyJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function createEmpty(icon, text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.id = 'net-empty';
  div.innerHTML = `<span class="icon">${icon}</span><p>${text.replace(/\n/g, '<br>')}</p>`;
  return div;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── INIT ─────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

(function init() {
  connectBackground();
  wireEvents();
  initResizeHandle();
  updateIntrudeUI();
  updateQueueCount();
  updateStatusBar();
})();
