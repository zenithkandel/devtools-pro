/**
 * panel.js — DevTools Pro
 * Handles: Network tab, HTTP Intrude tab, WS Intruder tab.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STATE ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const state = {
  // Network log
  requests:         [],
  selectedReqId:    null,
  filterText:       '',
  filterType:       'All',
  preserveLog:      false,
  recording:        true,
  activeDetailTab:  'headers',
  logEpoch:         null,

  // HTTP Intrude
  intrudeEnabled:       false,
  intrudeMode:          'no-js',
  intercepted:          [],
  selectedIntercept:    null,
  jsCurrentlyDisabled:  false,

  // WS Intruder
  ws: {
    monitoring:       false,
    intruding:        false,
    sockets:          [],   // { requestId, url, status:'open'|'closed', opened, closed, outCount, inCount }
    selectedSocketId: null,
    messages:         [],   // { id, requestId, direction:'out'|'in', data, dataType, opcode, ts, status:'live'|'intercepted'|'forwarded'|'dropped' }
    interceptQueue:   [],   // subset of messages where status==='intercepted'
    selectedMsgId:    null, // selected in intercept drawer
    msgSeq:           0,
  },
};

let reqIdCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BACKGROUND PORT ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const tabId = chrome.devtools.inspectedWindow.tabId;
const port  = chrome.runtime.connect({ name: 'devtools-pro' });

port.postMessage({ type: 'INIT', tabId });

port.onMessage.addListener((msg) => {
  switch (msg.type) {

    // HTTP Intrude
    case 'REQUEST_PAUSED':    handleInterceptedRequest(msg); break;
    case 'INTERCEPT_ENABLED': onInterceptEnabled(msg.options); break;
    case 'INTERCEPT_DISABLED':onInterceptDisabled(); break;
    case 'JS_TOGGLED':
      state.jsCurrentlyDisabled = msg.disabled;
      updateJsStatusBadge(); updateJsToggleBtn(); break;
    case 'REQUEST_CONTINUED':
    case 'REQUEST_DROPPED':   removeFromQueue(msg.requestId); break;
    case 'ALL_FORWARDED':
      state.intercepted = []; state.selectedIntercept = null;
      renderQueue(); renderEditor(); updateForwardAllBtn(); break;
    case 'DEBUGGER_DETACHED':
      if (state.intrudeEnabled) { state.intrudeEnabled = false; state.jsCurrentlyDisabled = false; syncInterceptToggleUI(); updateJsStatusBadge(); }
      if (state.ws.monitoring)  { state.ws.monitoring = false; state.ws.intruding = false; updateWsControlsUI(); }
      break;

    // WS Monitor
    case 'WS_MONITOR_STARTED': state.ws.monitoring = true; updateWsControlsUI(); break;
    case 'WS_MONITOR_STOPPED': state.ws.monitoring = false; state.ws.intruding = false; updateWsControlsUI(); break;

    case 'WS_CREATED':    wsOnCreated(msg); break;
    case 'WS_CLOSED':     wsOnClosed(msg);  break;
    case 'WS_HANDSHAKE':  /* optional: could update socket info */ break;
    case 'WS_FRAME_SENT':     wsOnFrame(msg, 'out'); break;
    case 'WS_FRAME_RECEIVED': wsOnFrame(msg, 'in');  break;
    case 'WS_FRAME_ERROR':    wsOnFrameError(msg);   break;

    // WS Intrude
    case 'WS_INTRUDE_ENABLED':  state.ws.intruding = true;  updateWsControlsUI(); showWsDrawer(true);  break;
    case 'WS_INTRUDE_DISABLED': state.ws.intruding = false; updateWsControlsUI(); showWsDrawer(false); releaseAllIntercepted(); break;
    case 'WS_INTERCEPTED':  wsOnIntercepted(msg); break;
    case 'WS_FORWARDED':    wsSetMsgStatus(msg.msgId, 'forwarded'); break;
    case 'WS_DROPPED':      wsSetMsgStatus(msg.msgId, 'dropped');   break;
    case 'WS_CUSTOM_SENT':  break;

    case 'ERROR': console.error('[DevTools Pro]', msg.message); break;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NETWORK MONITORING ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  if (!state.recording) return;

  const id   = ++reqIdCounter;
  const type = classifyType(entry);
  const size = entry.response.bodySize > 0 ? entry.response.bodySize : (entry.response._transferSize || 0);

  const req = {
    id, entry, type, size,
    url:     entry.request.url,
    method:  entry.request.method,
    status:  entry.response.status,
    time:    entry.time,
    started: new Date(entry.startedDateTime).getTime(),
    timings: entry.timings || {},
  };

  if (!state.logEpoch) state.logEpoch = req.started;

  state.requests.push(req);
  renderRow(req);
  updateStatusBar();
});

chrome.devtools.network.onNavigated.addListener(() => {
  if (!state.preserveLog) {
    state.requests = []; state.selectedReqId = null; state.logEpoch = null; reqIdCounter = 0;
    clearTableBody(); hideDetail(); updateStatusBar(); showEmptyState(true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NETWORK TABLE ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const tbody      = document.getElementById('request-tbody');
const emptyState = document.getElementById('empty-state');

function classifyType(entry) {
  const rt = entry._resourceType;
  if (rt) {
    if (rt === 'xhr' || rt === 'fetch')       return 'Fetch/XHR';
    if (rt === 'script')                      return 'JS';
    if (rt === 'stylesheet')                  return 'CSS';
    if (rt === 'image' || rt === 'imageset')  return 'Img';
    if (rt === 'media')                       return 'Media';
    if (rt === 'font')                        return 'Font';
    if (rt === 'document')                    return 'Doc';
    if (rt === 'websocket')                   return 'WS';
  }
  const mime = (entry.response.content?.mimeType || '').toLowerCase();
  if (mime.includes('javascript')) return 'JS';
  if (mime.includes('css'))        return 'CSS';
  if (mime.includes('html'))       return 'Doc';
  if (mime.startsWith('image/'))   return 'Img';
  if (mime.startsWith('font/') || mime.includes('font')) return 'Font';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'Media';
  return 'Other';
}

function matchesFilter(req) {
  if (state.filterType !== 'All' && req.type !== state.filterType) return false;
  if (state.filterText && !req.url.toLowerCase().includes(state.filterText.toLowerCase())) return false;
  return true;
}

function formatSize(bytes) {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} kB`;
  return `${(bytes/1048576).toFixed(2)} MB`;
}

function formatTime(ms) {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms/1000).toFixed(2)} s`;
}

function urlName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last  = parts[parts.length - 1] || u.hostname;
    return u.search ? last + u.search : last;
  } catch { return url; }
}

function statusClass(status) {
  if (status >= 500) return 'status-5xx';
  if (status >= 400) return 'status-4xx';
  if (status >= 300) return 'status-3xx';
  if (status >= 200) return 'status-2xx';
  return 'status-0';
}

function waterfallBar(req) {
  const totalLogTime = Math.max(...state.requests.map(r => (r.started - state.logEpoch) + r.time), 1);
  const offset = ((req.started - state.logEpoch) / totalLogTime) * 100;
  const width  = Math.max((req.time / totalLogTime) * 100, 0.5);
  const typeClass = { 'Fetch/XHR':'xhr','Doc':'doc','JS':'js','CSS':'css' }[req.type] || '';
  return `<div class="waterfall-bar-wrap"><div class="waterfall-bar ${typeClass}" style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"></div></div>`;
}

function renderRow(req) {
  if (!matchesFilter(req)) return;
  showEmptyState(false);
  const tr = document.createElement('tr');
  tr.dataset.id = req.id;
  tr.innerHTML = `
    <td title="${req.url}">${urlName(req.url)}</td>
    <td><span class="method-tag method-${req.method}">${req.method}</span></td>
    <td class="${statusClass(req.status)}">${req.status || '—'}</td>
    <td>${req.type}</td>
    <td>${formatSize(req.size)}</td>
    <td>${formatTime(req.time)}</td>
    <td>${waterfallBar(req)}</td>`;
  tr.addEventListener('click', () => selectRequest(req.id));
  tbody.appendChild(tr);
  if (state.selectedReqId === req.id) tr.classList.add('selected');
}

function reRenderTable() {
  tbody.innerHTML = '';
  let visible = 0;
  for (const req of state.requests) { if (matchesFilter(req)) { renderRow(req); visible++; } }
  showEmptyState(visible === 0);
}

function clearTableBody() { tbody.innerHTML = ''; }
function showEmptyState(show) { emptyState.classList.toggle('hidden', !show); }

function updateStatusBar() {
  const visible = state.requests.filter(r => matchesFilter(r));
  const totalBytes = visible.reduce((s, r) => s + r.size, 0);
  const totalMs    = visible.reduce((s, r) => s + r.time, 0);
  document.getElementById('stat-count').textContent       = `${visible.length} request${visible.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-transferred').textContent = `${formatSize(totalBytes)} transferred`;
  document.getElementById('stat-time').textContent        = `Finish: ${formatTime(totalMs)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DETAIL PANE ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const detailPane    = document.getElementById('detail-pane');
const detailContent = document.getElementById('detail-content');

function selectRequest(id) {
  state.selectedReqId = id;
  document.querySelectorAll('#request-tbody tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.id == id));
  showDetail();
  renderDetailTab(state.activeDetailTab);
}
function showDetail()  { detailPane.classList.add('visible'); }
function hideDetail()  { detailPane.classList.remove('visible'); state.selectedReqId = null; document.querySelectorAll('#request-tbody tr').forEach(tr => tr.classList.remove('selected')); }
function currentRequest() { return state.requests.find(r => r.id === state.selectedReqId) || null; }

function renderDetailTab(tabName) {
  state.activeDetailTab = tabName;
  document.querySelectorAll('.detail-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.dtab === tabName));
  const req = currentRequest();
  if (!req) { detailContent.innerHTML = ''; return; }
  const e = req.entry;
  switch (tabName) {
    case 'headers':  renderHeadersTab(req, e);  break;
    case 'payload':  renderPayloadTab(e);        break;
    case 'response': renderResponseTab(e);       break;
    case 'cookies':  renderCookiesTab(e);        break;
    case 'timing':   renderTimingTab(req);       break;
  }
}

function headerRows(headers) {
  return headers.map(h => `<div class="header-row"><span class="header-name">${esc(h.name)}:</span><span class="header-value">${esc(h.value)}</span></div>`).join('');
}

function renderHeadersTab(req, e) {
  detailContent.innerHTML = `
    <div class="header-section">
      <div class="header-section-title">General</div>
      <div class="header-row"><span class="header-name">Request URL:</span><span class="header-value">${esc(req.url)}</span></div>
      <div class="header-row"><span class="header-name">Request Method:</span><span class="header-value">${esc(req.method)}</span></div>
      <div class="header-row"><span class="header-name">Status Code:</span><span class="header-value ${statusClass(req.status)}">${req.status} ${esc(e.response.statusText)}</span></div>
      <div class="header-row"><span class="header-name">Remote Address:</span><span class="header-value">${esc(e.serverIPAddress || '—')} ${e.connection ? ':' + e.connection : ''}</span></div>
    </div>
    <div class="header-section"><div class="header-section-title">Response Headers</div>${headerRows(e.response.headers)}</div>
    <div class="header-section"><div class="header-section-title">Request Headers</div>${headerRows(e.request.headers)}</div>`;
}

function renderPayloadTab(e) {
  if (!e.request.postData) { detailContent.innerHTML = '<span style="color:var(--text-muted);font-size:11px;">No request body</span>'; return; }
  const pd = e.request.postData;
  let html = '';
  if (pd.params?.length) {
    html += `<div class="header-section"><div class="header-section-title">Form Data</div>${pd.params.map(p => `<div class="header-row"><span class="header-name">${esc(p.name)}:</span><span class="header-value">${esc(p.value)}</span></div>`).join('')}</div>`;
  }
  if (pd.text) {
    html += `<div class="header-section"><div class="header-section-title">Payload</div><pre class="pre-block">${esc(tryPrettyJson(pd.text))}</pre></div>`;
  }
  detailContent.innerHTML = html || '<span style="color:var(--text-muted)">Empty body</span>';
}

function renderResponseTab(e) {
  detailContent.innerHTML = '<span style="color:var(--text-muted);font-size:11px;">Loading…</span>';
  e.getContent((content, encoding) => {
    let text = content || '';
    if (encoding === 'base64') { try { text = atob(text); } catch (_) {} }
    const mime = (e.response.content?.mimeType || '').toLowerCase();
    if (mime.includes('json')) text = tryPrettyJson(text);
    detailContent.innerHTML = `<pre class="pre-block">${esc(text || '(empty response)')}</pre>`;
  });
}

function renderCookiesTab(e) {
  const cookieTable = (cookies) => cookies.length
    ? cookies.map(c => `<div class="header-row"><span class="header-name">${esc(c.name)}:</span><span class="header-value">${esc(c.value)}</span></div>`).join('')
    : '<span style="color:var(--text-muted);font-size:11px">None</span>';
  detailContent.innerHTML = `
    <div class="header-section"><div class="header-section-title">Request Cookies</div>${cookieTable(e.request.cookies || [])}</div>
    <div class="header-section"><div class="header-section-title">Response Cookies</div>${cookieTable(e.response.cookies || [])}</div>`;
}

function renderTimingTab(req) {
  const t = req.timings, total = req.time || 1;
  const phases = [
    { key:'blocked',label:'Blocked',cls:'blocked' },{ key:'dns',label:'DNS',cls:'dns' },
    { key:'connect',label:'Connect',cls:'connect' },{ key:'ssl',label:'SSL',cls:'ssl' },
    { key:'send',label:'Sending',cls:'send' },      { key:'wait',label:'Waiting',cls:'wait' },
    { key:'receive',label:'Receiving',cls:'receive' },
  ];
  const rows = phases.map(p => {
    const ms = t[p.key] > 0 ? t[p.key] : 0;
    const pct = Math.max((ms / total) * 100, 0);
    return `<div class="timing-row"><span class="timing-label">${p.label}</span><div class="timing-bar-wrap"><div class="timing-bar ${p.cls}" style="width:${pct.toFixed(1)}%"></div></div><span class="timing-value">${ms > 0 ? formatTime(ms) : '—'}</span></div>`;
  }).join('');
  detailContent.innerHTML = `<div class="header-section"><div class="header-section-title">Timing Breakdown</div>${rows}<div class="timing-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px"><span class="timing-label" style="color:var(--text)">Total</span><div class="timing-bar-wrap"><div class="timing-bar wait" style="width:100%"></div></div><span class="timing-value" style="color:var(--text)">${formatTime(total)}</span></div></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HTTP INTRUDE ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function handleInterceptedRequest(msg) {
  state.intercepted.push(msg);
  renderQueue(); updateForwardAllBtn();
  const badge = document.getElementById('intrude-badge');
  badge.hidden = false; badge.textContent = state.intercepted.length;
  if (!state.selectedIntercept) selectIntercepted(msg.requestId);
}

function removeFromQueue(requestId) {
  const idx = state.intercepted.findIndex(r => r.requestId === requestId);
  if (idx === -1) return;
  state.intercepted.splice(idx, 1);
  if (state.selectedIntercept === requestId) state.selectedIntercept = state.intercepted[0]?.requestId || null;
  renderQueue(); renderEditor(); updateForwardAllBtn(); updateBadge();
}

function updateBadge() {
  const badge = document.getElementById('intrude-badge');
  badge.hidden = state.intercepted.length === 0;
  badge.textContent = state.intercepted.length;
}

function selectIntercepted(requestId) {
  state.selectedIntercept = requestId; renderQueue(); renderEditor();
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('queue-count').textContent = state.intercepted.length;
  if (state.intercepted.length === 0) { list.innerHTML = '<div class="queue-empty">No requests intercepted</div>'; return; }
  list.innerHTML = state.intercepted.map(r => {
    const selected = r.requestId === state.selectedIntercept;
    const time = new Date(r.timestamp).toLocaleTimeString('en-US', { hour12: false });
    return `<div class="queue-item ${selected ? 'selected' : ''}" data-rid="${esc(r.requestId)}">
      <div class="qi-top"><span class="qi-method">${esc(r.method)}</span><span class="qi-url" title="${esc(r.url)}">${esc(urlName(r.url))}</span></div>
      <div class="qi-meta">${esc(r.resourceType || 'other')} · ${time}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.queue-item').forEach(el => el.addEventListener('click', () => selectIntercepted(el.dataset.rid)));
}

function renderEditor() {
  const body = document.getElementById('editor-body');
  const actions = document.getElementById('editor-actions');
  if (!state.selectedIntercept) { actions.style.display = 'none'; body.innerHTML = '<div class="editor-empty">Select a request from the queue to inspect and modify it</div>'; return; }
  const req = state.intercepted.find(r => r.requestId === state.selectedIntercept);
  if (!req) { actions.style.display = 'none'; return; }
  actions.style.display = 'flex';
  const headersText = (req.headers || []).map(h => `${h.name}: ${h.value}`).join('\n');
  body.innerHTML = `
    <div class="editor-field">
      <label>Method &amp; URL</label>
      <div class="editor-url-row">
        <select id="ed-method" class="method-select">${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(m => `<option ${m===req.method?'selected':''}>${m}</option>`).join('')}</select>
        <input id="ed-url" type="text" class="url-input" value="${esc(req.url)}" spellcheck="false">
      </div>
    </div>
    <div class="editor-field">
      <label>Headers <span style="color:var(--text-muted);font-weight:400;text-transform:none;letter-spacing:0">(Name: Value, one per line)</span></label>
      <textarea id="ed-headers" class="headers-ta" spellcheck="false">${esc(headersText)}</textarea>
    </div>
    <div class="editor-field">
      <label>Body</label>
      <textarea id="ed-body" class="body-ta" spellcheck="false">${esc(req.postData || '')}</textarea>
    </div>`;
}

function collectEditorModifications() {
  const url      = document.getElementById('ed-url')?.value     || '';
  const method   = document.getElementById('ed-method')?.value  || '';
  const rawHdrs  = document.getElementById('ed-headers')?.value || '';
  const postData = document.getElementById('ed-body')?.value    || '';
  const headers  = rawHdrs.split('\n').map(line => { const c = line.indexOf(':'); if (c < 1) return null; return { name: line.slice(0,c).trim(), value: line.slice(c+1).trim() }; }).filter(Boolean);
  return { url, method, headers, postData };
}

function onInterceptEnabled(options) {
  state.intrudeEnabled = true;
  if (options?.disableJs) { state.jsCurrentlyDisabled = true; updateJsStatusBadge(); }
  syncInterceptToggleUI();
}

function onInterceptDisabled() {
  state.intrudeEnabled = false; state.jsCurrentlyDisabled = false;
  updateJsStatusBadge(); syncInterceptToggleUI();
  state.intercepted = []; state.selectedIntercept = null;
  renderQueue(); renderEditor(); updateForwardAllBtn(); updateBadge();
}

function syncInterceptToggleUI() {
  const btn = document.getElementById('btn-intercept-toggle');
  const label = document.getElementById('intercept-label');
  btn.classList.toggle('active', state.intrudeEnabled);
  label.textContent = state.intrudeEnabled ? 'Intercepting…' : 'Enable Intercept';
  document.getElementById('btn-forward-all').disabled = !state.intrudeEnabled || state.intercepted.length === 0;
  document.getElementById('btn-js-toggle').style.display = (state.intrudeEnabled && state.intrudeMode === 'no-js') ? 'inline-flex' : 'none';
}

function updateJsStatusBadge() {
  document.getElementById('js-sep').style.display  = state.jsCurrentlyDisabled ? 'block' : 'none';
  document.getElementById('js-status').style.display = state.jsCurrentlyDisabled ? 'flex'  : 'none';
}

function updateJsToggleBtn() {
  document.getElementById('btn-js-toggle').textContent = state.jsCurrentlyDisabled ? 'Re-enable JS' : 'Disable JS';
}

function updateForwardAllBtn() {
  document.getElementById('btn-forward-all').disabled = !state.intrudeEnabled || state.intercepted.length === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WS INTRUDER — DATA HANDLERS ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function wsOnCreated(msg) {
  // Check for duplicate (e.g. reconnect with same requestId)
  if (state.ws.sockets.find(s => s.requestId === msg.requestId)) return;

  const sock = {
    requestId: msg.requestId,
    url:       msg.url,
    status:    'open',
    opened:    msg.timestamp,
    closed:    null,
    outCount:  0,
    inCount:   0,
  };
  state.ws.sockets.push(sock);

  renderSocketList();
  updateWsSockCount();

  // Auto-select if first socket
  if (!state.ws.selectedSocketId) wsSelectSocket(msg.requestId);
}

function wsOnClosed(msg) {
  const sock = state.ws.sockets.find(s => s.requestId === msg.requestId);
  if (sock) { sock.status = 'closed'; sock.closed = msg.timestamp; }
  renderSocketList();
}

function wsOnFrame(msg, direction) {
  const sock = state.ws.sockets.find(s => s.requestId === msg.requestId);
  if (!sock) return;

  const opcode = msg.opcode;
  let msgType = 'text';
  if (opcode === 2)  msgType = 'binary';
  if (opcode === 9)  msgType = 'ping';
  if (opcode === 10) msgType = 'pong';

  const frame = {
    id:        String(++state.ws.msgSeq),
    requestId: msg.requestId,
    direction,
    data:      msg.data ?? '',
    dataType:  msgType,
    opcode:    msg.opcode,
    ts:        msg.timestamp,
    status:    'live',  // 'live' | 'intercepted' | 'forwarded' | 'dropped'
  };

  state.ws.messages.push(frame);
  if (direction === 'out') sock.outCount++;
  else sock.inCount++;

  if (state.ws.selectedSocketId === msg.requestId) {
    appendMsgItem(frame);
    updateMsgCounts();
  }
}

function wsOnFrameError(msg) {
  // Just log — no UI action needed
  console.warn('[DevTools Pro WS] Frame error:', msg);
}

function wsOnIntercepted(msg) {
  // Find or create the socket entry for this URL
  let sock = state.ws.sockets.find(s => s.url === msg.socketUrl && s.status === 'open');

  const frame = {
    id:        msg.msgId,
    requestId: sock?.requestId ?? '__intercept__',
    direction: 'out',
    data:      msg.data,
    dataType:  msg.dataType || 'text',
    opcode:    1,
    ts:        msg.timestamp,
    status:    'intercepted',
    socketUrl: msg.socketUrl,
  };

  state.ws.messages.push(frame);
  state.ws.interceptQueue.push(frame);
  if (sock) { sock.outCount++; }

  // Update badge
  const badge = document.getElementById('ws-badge');
  badge.hidden = false;
  badge.textContent = state.ws.interceptQueue.length;

  if (state.ws.selectedSocketId === frame.requestId || state.ws.intruding) {
    appendMsgItem(frame);
    updateMsgCounts();
  }

  renderWsIntercept();

  // Auto-select first item
  if (!state.ws.selectedMsgId) wsSelectIntercept(frame.id);

  document.getElementById('ws-btn-fwd-all').disabled = false;
}

function wsSetMsgStatus(msgId, status) {
  const frame = state.ws.messages.find(m => m.id === msgId);
  if (frame) { frame.status = status; }

  // Remove from intercept queue
  const idx = state.ws.interceptQueue.findIndex(m => m.id === msgId);
  if (idx !== -1) state.ws.interceptQueue.splice(idx, 1);

  if (state.ws.selectedMsgId === msgId) {
    state.ws.selectedMsgId = state.ws.interceptQueue[0]?.id ?? null;
  }

  // Update badge
  const badge = document.getElementById('ws-badge');
  badge.hidden = state.ws.interceptQueue.length === 0;
  badge.textContent = state.ws.interceptQueue.length;

  renderWsIntercept();
  refreshOutList(); // re-render outgoing to reflect status change
  updateMsgCounts();

  document.getElementById('ws-btn-fwd-all').disabled = state.ws.interceptQueue.length === 0;
  document.getElementById('ws-btn-fwd-selected').disabled  = !state.ws.selectedMsgId;
  document.getElementById('ws-btn-drop-selected').disabled = !state.ws.selectedMsgId;
}

function releaseAllIntercepted() {
  // UI cleanup when WS intrude is turned off (bg already released them)
  state.ws.interceptQueue.forEach(m => { m.status = 'forwarded'; });
  state.ws.interceptQueue = [];
  state.ws.selectedMsgId = null;
  document.getElementById('ws-badge').hidden = true;
  renderWsIntercept();
  refreshOutList();
  updateMsgCounts();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WS INTRUDER — RENDER ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function renderSocketList() {
  const list = document.getElementById('ws-socket-list');

  if (state.ws.sockets.length === 0) {
    list.innerHTML = `<div class="ws-empty-socks"><div class="ws-empty-icon">⚡</div><span>Start monitoring to<br>detect WebSocket connections.</span></div>`;
    return;
  }

  list.innerHTML = state.ws.sockets.map(s => {
    const selected = s.requestId === state.ws.selectedSocketId;
    const shortUrl = shortWsUrl(s.url);
    const timeStr  = new Date(s.opened).toLocaleTimeString('en-US', { hour12: false });
    return `
      <div class="ws-socket-item ${selected ? 'selected' : ''}" data-rid="${esc(s.requestId)}">
        <div class="ws-sock-status">
          <div class="ws-status-dot ${s.status}"></div>
          <span class="ws-sock-label ${s.status}">${s.status.toUpperCase()}</span>
        </div>
        <div class="ws-sock-url" title="${esc(s.url)}">${esc(shortUrl)}</div>
        <div class="ws-sock-meta">
          <span>↑${s.outCount}</span>
          <span>↓${s.inCount}</span>
          <span>${timeStr}</span>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.ws-socket-item').forEach(el =>
    el.addEventListener('click', () => wsSelectSocket(el.dataset.rid))
  );
}

function wsSelectSocket(requestId) {
  state.ws.selectedSocketId = requestId;

  // Update socket list highlight
  document.querySelectorAll('.ws-socket-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.rid === requestId)
  );

  const sock = state.ws.sockets.find(s => s.requestId === requestId);

  // Update selected info
  const info = document.getElementById('ws-selected-info');
  if (sock) {
    info.textContent  = sock.url;
    info.className    = 'ws-selected-info has-socket';
  } else {
    info.textContent = 'No socket selected';
    info.className   = 'ws-selected-info';
  }

  // Enable/disable message-level controls
  document.getElementById('ws-btn-clear-msgs').disabled = !requestId;
  document.getElementById('ws-custom-send-wrap').style.display = (requestId && sock?.status === 'open') ? 'flex' : 'none';

  renderMsgLists();
  updateMsgCounts();
}

function renderMsgLists() {
  refreshOutList();
  refreshInList();
}

function refreshOutList() {
  const list = document.getElementById('ws-out-list');
  const msgs = state.ws.messages.filter(m =>
    m.requestId === state.ws.selectedSocketId && m.direction === 'out'
  );
  if (msgs.length === 0) {
    list.innerHTML = '<div class="ws-empty-msgs">No outgoing frames yet.</div>';
    return;
  }
  list.innerHTML = msgs.map(m => renderMsgItem(m)).join('');
  list.querySelectorAll('.ws-msg-fwd').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); wsForwardMsg(btn.dataset.id); })
  );
  list.querySelectorAll('.ws-msg-drp').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); wsDropMsg(btn.dataset.id); })
  );
}

function refreshInList() {
  const list = document.getElementById('ws-in-list');
  const msgs = state.ws.messages.filter(m =>
    m.requestId === state.ws.selectedSocketId && m.direction === 'in'
  );
  if (msgs.length === 0) {
    list.innerHTML = '<div class="ws-empty-msgs">No incoming frames yet.</div>';
    return;
  }
  list.innerHTML = msgs.map(m => renderMsgItem(m)).join('');
}

function appendMsgItem(frame) {
  if (frame.requestId !== state.ws.selectedSocketId) return;
  const listId = frame.direction === 'out' ? 'ws-out-list' : 'ws-in-list';
  const list   = document.getElementById(listId);

  // Remove empty placeholder
  const empty = list.querySelector('.ws-empty-msgs');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.innerHTML = renderMsgItem(frame);
  const el = div.firstElementChild;
  list.appendChild(el);

  // Wire intercept buttons
  el.querySelector('.ws-msg-fwd')?.addEventListener('click', (e) => { e.stopPropagation(); wsForwardMsg(frame.id); });
  el.querySelector('.ws-msg-drp')?.addEventListener('click', (e) => { e.stopPropagation(); wsDropMsg(frame.id); });

  // Auto-scroll
  list.scrollTop = list.scrollHeight;
}

function renderMsgItem(frame) {
  const time  = new Date(frame.ts).toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const preview = (frame.data || '').slice(0, 200);
  const statusMap = { live:'', intercepted:'pending', forwarded:'forwarded', dropped:'dropped' };
  const statusLabel = statusMap[frame.status] || '';

  const intercepted = frame.status === 'intercepted';
  const dropped     = frame.status === 'dropped';
  const forwarded   = frame.status === 'forwarded';

  const classNames = ['ws-msg-item', intercepted ? 'intercepted' : '', dropped ? 'dropped' : '', forwarded ? 'forwarded' : ''].filter(Boolean).join(' ');

  const actionBtns = intercepted ? `
    <div class="ws-msg-actions">
      <button class="ed-btn forward-btn ws-msg-fwd" data-id="${esc(frame.id)}">Forward</button>
      <button class="ed-btn drop-btn ws-msg-drp"    data-id="${esc(frame.id)}">Drop</button>
    </div>` : '';

  return `
    <div class="${classNames}" data-id="${esc(frame.id)}">
      <div class="ws-msg-top">
        <span class="ws-msg-time">${time}</span>
        <span class="ws-msg-type-badge ${frame.dataType}">${frame.dataType}</span>
        ${statusLabel ? `<span class="ws-msg-status ${statusLabel}">${statusLabel}</span>` : ''}
      </div>
      <div class="ws-msg-body">${esc(preview)}${frame.data?.length > 200 ? '…' : ''}</div>
      ${actionBtns}
    </div>`;
}

function updateMsgCounts() {
  const socketId = state.ws.selectedSocketId;
  const out = state.ws.messages.filter(m => m.requestId === socketId && m.direction === 'out').length;
  const inc = state.ws.messages.filter(m => m.requestId === socketId && m.direction === 'in').length;
  document.getElementById('ws-out-count').textContent = out;
  document.getElementById('ws-in-count').textContent  = inc;
}

function updateWsSockCount() {
  document.getElementById('ws-sock-count').textContent = state.ws.sockets.length;
}

// ─── Intercept Drawer ─────────────────────────────────────────────────────────

function showWsDrawer(visible) {
  document.getElementById('ws-intercept-drawer').classList.toggle('visible', visible);
}

function renderWsIntercept() {
  const queue = state.ws.interceptQueue;
  document.getElementById('ws-intercept-count').textContent = queue.length;

  const queueEl = document.getElementById('ws-intercept-queue');

  if (queue.length === 0) {
    queueEl.innerHTML = '<div class="queue-empty">Waiting for intercepted frames…</div>';
    renderWsFrameEditor(null);
    return;
  }

  queueEl.innerHTML = queue.map(m => {
    const selected = m.id === state.ws.selectedMsgId;
    const time = new Date(m.ts).toLocaleTimeString('en-US', { hour12:false });
    const preview = (m.data || '').slice(0, 60);
    return `<div class="ws-intercept-item ${selected ? 'selected' : ''}" data-id="${esc(m.id)}">
      <div class="qi-top">
        <span class="qi-method">${esc(m.dataType.toUpperCase())}</span>
        <span class="qi-url" title="${esc(m.socketUrl || '')}">${esc(shortWsUrl(m.socketUrl || ''))}</span>
      </div>
      <div class="qi-meta">${esc(time)} · ${esc(preview)}${m.data?.length > 60 ? '…' : ''}</div>
    </div>`;
  }).join('');

  queueEl.querySelectorAll('.ws-intercept-item').forEach(el =>
    el.addEventListener('click', () => wsSelectIntercept(el.dataset.id))
  );

  renderWsFrameEditor(state.ws.selectedMsgId);

  document.getElementById('ws-btn-fwd-selected').disabled  = !state.ws.selectedMsgId;
  document.getElementById('ws-btn-drop-selected').disabled = !state.ws.selectedMsgId;
}

function wsSelectIntercept(id) {
  state.ws.selectedMsgId = id;
  document.querySelectorAll('.ws-intercept-item').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  renderWsFrameEditor(id);
  document.getElementById('ws-btn-fwd-selected').disabled  = !id;
  document.getElementById('ws-btn-drop-selected').disabled = !id;
}

function renderWsFrameEditor(msgId) {
  const editor = document.getElementById('ws-frame-editor');

  if (!msgId) {
    editor.innerHTML = '<div class="ws-editor-empty">Select an intercepted frame to edit it</div>';
    return;
  }

  const frame = state.ws.interceptQueue.find(m => m.id === msgId);
  if (!frame) { editor.innerHTML = '<div class="ws-editor-empty">Frame not found</div>'; return; }

  editor.innerHTML = `
    <div class="ws-frame-edit-area">
      <div class="ws-frame-meta">Socket: ${esc(shortWsUrl(frame.socketUrl || ''))} · Type: ${esc(frame.dataType)}</div>
      <div class="ws-frame-edit-label">Frame Payload</div>
      <textarea class="ws-frame-textarea" id="ws-frame-payload" spellcheck="false">${esc(frame.data || '')}</textarea>
    </div>`;
}

// ─── WS Actions ───────────────────────────────────────────────────────────────

function wsForwardMsg(msgId) {
  // Read edited payload from textarea if in drawer
  const ta = document.getElementById('ws-frame-payload');
  const editedData = ta ? ta.value : null;

  // If edited, update in-memory
  if (editedData !== null) {
    const frame = state.ws.interceptQueue.find(m => m.id === msgId);
    if (frame) frame.data = editedData;
  }

  port.postMessage({ type: 'WS_FORWARD', msgId: String(msgId) });
}

function wsDropMsg(msgId) {
  port.postMessage({ type: 'WS_DROP', msgId: String(msgId) });
}

// ─── WS Controls UI ───────────────────────────────────────────────────────────

function updateWsControlsUI() {
  const monBtn   = document.getElementById('ws-monitor-btn');
  const monDot   = document.getElementById('ws-monitor-dot');
  const monLabel = document.getElementById('ws-monitor-label');
  const intBtn   = document.getElementById('ws-intrude-btn');
  const intDot   = document.getElementById('ws-intrude-dot');
  const intLabel = document.getElementById('ws-intrude-label');

  if (state.ws.monitoring) {
    monBtn.classList.add('monitoring');
    monDot.className = 'ws-dot ws-dot-monitor';
    monLabel.textContent = 'Stop Monitor';
    intBtn.disabled = false;
  } else {
    monBtn.classList.remove('monitoring');
    monDot.className = 'ws-dot';
    monLabel.textContent = 'Start Monitor';
    intBtn.disabled = true;
  }

  if (state.ws.intruding) {
    intBtn.classList.add('intruding');
    intDot.className = 'ws-dot ws-dot-intrude';
    intLabel.textContent = 'Intercept ON';
  } else {
    intBtn.classList.remove('intruding');
    intDot.className = 'ws-dot';
    intLabel.textContent = 'Intercept Off';
  }

  document.getElementById('ws-btn-clear-all').disabled = state.ws.sockets.length === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPLIT PANE DRAG ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function makeSplitDraggable(handleId, rightPaneEl, axis = 'x', shrink = true) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  let dragging = false, startPos = 0, startSize = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true; startPos = axis === 'x' ? e.clientX : e.clientY;
    startSize = axis === 'x' ? rightPaneEl.offsetWidth : rightPaneEl.offsetHeight;
    handle.classList.add('dragging'); document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none'; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = (axis === 'x' ? e.clientX : e.clientY) - startPos;
    const sign  = shrink ? -1 : 1;
    const newSize = Math.max(180, Math.min(startSize + delta * sign, 900));
    if (axis === 'x') rightPaneEl.style.width = newSize + 'px';
    else rightPaneEl.style.height = newSize + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });
}

makeSplitDraggable('split-handle', document.getElementById('detail-pane'), 'x', true);

// Intrude queue/editor split
(function() {
  const handle = document.getElementById('intrude-split-handle');
  const qPanel = document.querySelector('.queue-panel');
  if (!handle || !qPanel) return;
  let drag = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => { drag = true; startX = e.clientX; startW = qPanel.offsetWidth; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!drag) return; qPanel.style.width = Math.max(160, Math.min(startW + (e.clientX - startX), 600)) + 'px'; });
  document.addEventListener('mouseup', () => { drag = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
})();

// WS socket list resize
makeSplitDraggable('ws-split-handle-1', document.getElementById('ws-socket-panel'), 'x', false);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EVENT WIRING ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));
  })
);

// ── Network controls ──────────────────────────────────────────────────────────
document.getElementById('btn-record').addEventListener('click', () => {
  state.recording = !state.recording;
  document.getElementById('btn-record').classList.toggle('active', state.recording);
});

document.getElementById('btn-clear').addEventListener('click', () => {
  state.requests = []; state.selectedReqId = null; state.logEpoch = null; reqIdCounter = 0;
  clearTableBody(); hideDetail(); updateStatusBar(); showEmptyState(true);
});

document.getElementById('chk-preserve').addEventListener('change', e => { state.preserveLog = e.target.checked; });
document.getElementById('filter-search').addEventListener('input', e => { state.filterText = e.target.value.trim(); reRenderTable(); updateStatusBar(); });

document.getElementById('type-filters').addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.filterType = btn.dataset.type;
  reRenderTable(); updateStatusBar();
});

document.getElementById('detail-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.detail-tab');
  if (btn) renderDetailTab(btn.dataset.dtab);
});

document.getElementById('btn-close-detail').addEventListener('click', hideDetail);

// ── HTTP Intrude controls ─────────────────────────────────────────────────────
document.getElementById('mode-no-js').addEventListener('click', () => {
  if (state.intrudeEnabled) return;
  state.intrudeMode = 'no-js';
  document.getElementById('mode-no-js').classList.add('active');
  document.getElementById('mode-yes-js').classList.remove('active');
});
document.getElementById('mode-yes-js').addEventListener('click', () => {
  if (state.intrudeEnabled) return;
  state.intrudeMode = 'yes-js';
  document.getElementById('mode-yes-js').classList.add('active');
  document.getElementById('mode-no-js').classList.remove('active');
});

document.getElementById('btn-intercept-toggle').addEventListener('click', () => {
  if (state.intrudeEnabled) {
    port.postMessage({ type: 'DISABLE_INTERCEPT' });
  } else {
    port.postMessage({ type: 'ENABLE_INTERCEPT', options: { disableJs: state.intrudeMode === 'no-js' } });
  }
});

document.getElementById('btn-js-toggle').addEventListener('click',  () => port.postMessage({ type: 'TOGGLE_JS' }));
document.getElementById('btn-forward').addEventListener('click',     () => {
  if (!state.selectedIntercept) return;
  port.postMessage({ type: 'CONTINUE_REQUEST', requestId: state.selectedIntercept, modifications: collectEditorModifications() });
});
document.getElementById('btn-drop').addEventListener('click',        () => {
  if (!state.selectedIntercept) return;
  port.postMessage({ type: 'DROP_REQUEST', requestId: state.selectedIntercept });
});
document.getElementById('btn-forward-all').addEventListener('click', () => port.postMessage({ type: 'FORWARD_ALL' }));

// ── WS Intruder controls ──────────────────────────────────────────────────────
document.getElementById('ws-monitor-btn').addEventListener('click', () => {
  if (!state.ws.monitoring) {
    port.postMessage({ type: 'WS_MONITOR_START' });
  } else {
    // Stop: also stop intrude if active
    if (state.ws.intruding) port.postMessage({ type: 'WS_INTRUDE_DISABLE' });
    port.postMessage({ type: 'WS_MONITOR_STOP' });
  }
});

document.getElementById('ws-intrude-btn').addEventListener('click', () => {
  if (!state.ws.monitoring) return;
  if (!state.ws.intruding) {
    port.postMessage({ type: 'WS_INTRUDE_ENABLE' });
  } else {
    port.postMessage({ type: 'WS_INTRUDE_DISABLE' });
  }
});

document.getElementById('ws-btn-clear-msgs').addEventListener('click', () => {
  state.ws.messages = state.ws.messages.filter(m => m.requestId !== state.ws.selectedSocketId);
  const sock = state.ws.sockets.find(s => s.requestId === state.ws.selectedSocketId);
  if (sock) { sock.outCount = 0; sock.inCount = 0; }
  renderMsgLists(); updateMsgCounts();
});

document.getElementById('ws-btn-clear-all').addEventListener('click', () => {
  state.ws.sockets  = [];
  state.ws.messages = [];
  state.ws.interceptQueue  = [];
  state.ws.selectedSocketId = null;
  state.ws.selectedMsgId   = null;
  renderSocketList(); renderMsgLists(); updateWsSockCount(); updateMsgCounts();
  updateWsControlsUI();
  document.getElementById('ws-selected-info').textContent = 'No socket selected';
  document.getElementById('ws-selected-info').className   = 'ws-selected-info';
});

document.getElementById('ws-custom-send-btn').addEventListener('click', () => {
  const input = document.getElementById('ws-custom-input');
  const data  = input.value.trim();
  if (!data || !state.ws.selectedSocketId) return;
  const sock = state.ws.sockets.find(s => s.requestId === state.ws.selectedSocketId);
  if (!sock) return;
  port.postMessage({ type: 'WS_SEND_CUSTOM', socketUrl: sock.url, data });
  input.value = '';
});

document.getElementById('ws-custom-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('ws-custom-send-btn').click(); }
});

// Drawer: forward/drop selected
document.getElementById('ws-btn-fwd-selected').addEventListener('click', () => {
  if (state.ws.selectedMsgId) wsForwardMsg(state.ws.selectedMsgId);
});
document.getElementById('ws-btn-drop-selected').addEventListener('click', () => {
  if (state.ws.selectedMsgId) wsDropMsg(state.ws.selectedMsgId);
});

// Drawer: forward all
document.getElementById('ws-btn-fwd-all').addEventListener('click', () => {
  const ids = state.ws.interceptQueue.map(m => m.id);
  ids.forEach(id => port.postMessage({ type: 'WS_FORWARD', msgId: String(id) }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HELPERS ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function tryPrettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function shortWsUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const label = u.host + (path.length > 1 ? path : '');
    return label.length > 50 ? label.slice(0, 49) + '…' : label;
  } catch { return url.slice(0, 50); }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
showEmptyState(true);
renderQueue();
updateWsControlsUI();
