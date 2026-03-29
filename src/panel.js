// DevTools Pro - Panel Logic
// Main UI controller for the devtools-pro panel

class DevToolsProPanel {
  constructor() {
    this.tabId = chrome.devtools.inspectedWindow.tabId;
    this.port = null;
    this.requests = [];
    this.requestMap = new Map();
    this.interceptMode = 'off';
    this.interceptQueue = [];
    this.selectedRequestId = null;
    this.filteredRequests = [];

    this.initializeElements();
    this.setupEventListeners();
    this.connectToBackground();
  }

  initializeElements() {
    // Navigation tabs
    this.tabBtns = document.querySelectorAll('.tab-btn');
    this.tabContents = document.querySelectorAll('.tab-content');

    // Network Monitor
    this.filterInput = document.getElementById('filter-input');
    this.clearBtn = document.getElementById('clear-btn');
    this.pauseCheckbox = document.getElementById('pause-checkbox');
    this.networkTbody = document.getElementById('network-tbody');
    this.detailsPanel = document.getElementById('details-panel');
    this.closeDetailsBtn = document.querySelector('.close-details-btn');
    this.detailsTabs = document.querySelectorAll('.details-tab-btn');
    this.detailsTabContents = document.querySelectorAll('.details-tab-content');

    // Intrude Mode
    this.intrudeModeRadios = document.querySelectorAll('input[name="intrude-mode"]');
    this.modeStatus = document.getElementById('mode-status');
    this.interceptedCount = document.getElementById('intercepted-count');
    this.pausedJsStatus = document.getElementById('paused-js-status');
    this.intrudeQueue = document.getElementById('intrude-queue');
    this.requestEditor = document.getElementById('request-editor');
    this.closeEditorBtn = document.querySelector('.close-editor-btn');
    this.editorTabs = document.querySelectorAll('.editor-tab-btn');
    this.editorTabContents = document.querySelectorAll('.editor-tab-content');
    this.headersEditor = document.getElementById('headers-editor');
    this.bodyEditor = document.getElementById('body-editor');
    this.addHeaderBtn = document.getElementById('add-header-btn');
    this.forwardBtn = document.getElementById('forward-btn');
    this.dropBtn = document.getElementById('drop-btn');
  }

  setupEventListeners() {
    // Tab navigation
    this.tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Network Monitor
    this.filterInput.addEventListener('input', () => this.filterRequests());
    this.clearBtn.addEventListener('click', () => this.clearRequests());
    this.pauseCheckbox.addEventListener('change', () => this.togglePauseCapture());
    this.closeDetailsBtn.addEventListener('click', () => this.hideDetailsPanel());

    // Details tabs
    this.detailsTabs.forEach((btn) => {
      btn.addEventListener('click', () =>
        this.switchDetailsTab(btn.dataset.detailsTab)
      );
    });

    // Intrude Mode
    this.intrudeModeRadios.forEach((radio) => {
      radio.addEventListener('change', () => this.changeInterceptMode(radio.value));
    });

    this.addHeaderBtn.addEventListener('click', () => this.addHeaderRow());
    this.closeEditorBtn.addEventListener('click', () => this.hideRequestEditor());

    // Editor tabs
    this.editorTabs.forEach((btn) => {
      btn.addEventListener('click', () => this.switchEditorTab(btn.dataset.editorTab));
    });

    this.forwardBtn.addEventListener('click', () => this.forwardRequest());
    this.dropBtn.addEventListener('click', () => this.dropRequest());
  }

  connectToBackground() {
    // Establish connection with background service worker
    this.port = chrome.runtime.connect({
      name: `devtools-${this.tabId}`
    });

    this.port.onMessage.addListener((message) => {
      this.handleBackgroundMessage(message);
    });

    // Request initial state
    chrome.runtime.sendMessage(
      {
        type: 'GET_TAB_DATA',
        tabId: this.tabId
      },
      (response) => {
        if (response) {
          this.requests = response.requests || [];
          this.interceptMode = response.interceptMode || 'off';
          this.interceptQueue = response.interceptQueue || [];
          this.renderNetworkTable();
          this.updateIntrudeModeUI();
        }
      }
    );
  }

  handleBackgroundMessage(message) {
    const { type, data } = message;

    switch (type) {
      case 'INITIAL_STATE':
        this.requests = data.requests || [];
        this.interceptQueue = data.interceptQueue || [];
        this.renderNetworkTable();
        this.updateIntrudeModeUI();
        break;

      case 'NEW_REQUEST':
        this.requests.push(data);
        this.requestMap.set(data.id, data);
        this.renderNetworkTable();
        break;

      case 'REQUEST_UPDATED':
        this.requestMap.set(data.id, data);
        this.updateRequestRow(data.id);
        break;

      case 'REQUEST_INTERCEPTED':
        this.interceptQueue.push({
          requestId: data.requestId,
          request: data.request,
          status: 'pending'
        });
        this.updateIntrudeModeUI();
        this.renderInterceptionQueue();
        break;

      case 'REQUESTS_CLEARED':
        this.requests = [];
        this.requestMap.clear();
        this.renderNetworkTable();
        break;
    }
  }

  switchTab(tabName) {
    // Update active tab button
    this.tabBtns.forEach((btn) => btn.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Show/hide tab content
    this.tabContents.forEach((content) => content.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
  }

  filterRequests() {
    const query = this.filterInput.value.toLowerCase();
    this.filteredRequests = this.requests.filter((req) => {
      const urlPart = req.url.toLowerCase();
      const methodPart = req.method.toLowerCase();
      const typePart = req.type.toLowerCase();
      const statusPart = req.statusCode.toString();

      return (
        urlPart.includes(query) ||
        methodPart.includes(query) ||
        typePart.includes(query) ||
        statusPart.includes(query)
      );
    });
    this.renderNetworkTable();
  }

  renderNetworkTable() {
    const toRender = this.filterInput.value ? this.filteredRequests : this.requests;

    if (toRender.length === 0) {
      this.networkTbody.innerHTML = `
        <tr class="empty-state">
          <td colspan="6">No requests captured. Navigate to a website to see network traffic.</td>
        </tr>
      `;
      return;
    }

    this.networkTbody.innerHTML = toRender
      .map(
        (req) => `
        <tr data-request-id="${req.id}" class="request-row ${
          req.id === this.selectedRequestId ? 'selected' : ''
        }">
          <td>${this.getFileNameFromUrl(req.url)}</td>
          <td><span class="status-${this.getStatusClass(req.statusCode)}">${
          req.statusCode || '-'
        }</span></td>
          <td>${req.type || '-'}</td>
          <td>${this.formatSize(req.size)}</td>
          <td>${req.duration > 0 ? req.duration.toFixed(2) + ' ms' : '-'}</td>
          <td>
            <div class="waterfall" style="width: ${Math.min(
              (req.duration || 0) / 10,
              100
            )}px; background: #0e639c;"></div>
          </td>
        </tr>
      `
      )
      .join('');

    // Add click listeners
    this.networkTbody.querySelectorAll('.request-row').forEach((row) => {
      row.addEventListener('click', () => {
        const requestId = row.dataset.requestId;
        this.selectRequest(requestId);
      });
    });
  }

  updateRequestRow(requestId) {
    const row = document.querySelector(`[data-request-id="${requestId}"]`);
    if (row) {
      const req = this.requestMap.get(requestId);
      row.querySelector('td:nth-child(2)').innerHTML = `<span class="status-${this.getStatusClass(
        req.statusCode
      )}">${req.statusCode || '-'}</span>`;
      row.querySelector('td:nth-child(4)').textContent = this.formatSize(req.size);
      row.querySelector('td:nth-child(5)').textContent =
        req.duration > 0 ? req.duration.toFixed(2) + ' ms' : '-';
      row.querySelector('.waterfall').style.width =
        Math.min((req.duration || 0) / 10, 100) + 'px';
    }
  }

  selectRequest(requestId) {
    this.selectedRequestId = requestId;
    this.renderNetworkTable();

    const request = this.requestMap.get(requestId);
    if (request) {
      this.showDetailsPanel(request);
    }
  }

  showDetailsPanel(request) {
    this.detailsPanel.style.display = 'flex';
    document.getElementById('details-title').textContent = this.getFileNameFromUrl(
      request.url
    );

    this.populateDetailsHeaders(request);
    this.populateDetailsBody(request);
    this.populateTiming(request);
  }

  populateDetailsHeaders(request) {
    const headersDiv = document.getElementById('request-headers');
    headersDiv.innerHTML =
      '<h4>Request Headers</h4>' +
      (request.requestHeaders && request.requestHeaders.length > 0
        ? request.requestHeaders
            .map(
              (h) =>
                `<div class="header-item"><div class="header-name">${h.name || h}:</div><div class="header-value">${
                  h.value || ''
                }</div></div>`
            )
            .join('')
        : '<div style="color: #999;">No request headers</div>');

    const responseHeadersDiv = document.getElementById('response-headers');
    responseHeadersDiv.innerHTML =
      request.responseHeaders && request.responseHeaders.length > 0
        ? request.responseHeaders
            .map(
              (h) =>
                `<div class="header-item"><div class="header-name">${h.name || h}:</div><div class="header-value">${
                  h.value || ''
                }</div></div>`
            )
            .join('')
        : '<div style="color: #999;">No response headers</div>';
  }

  populateDetailsBody(request) {
    const requestBodyDiv = document.getElementById('request-body-content');
    requestBodyDiv.textContent = request.requestBody
      ? typeof request.requestBody === 'string'
        ? request.requestBody
        : JSON.stringify(request.requestBody, null, 2)
      : '(empty)';

    const responseBodyDiv = document.getElementById('response-body-content');
    responseBodyDiv.textContent = request.responseBody
      ? typeof request.responseBody === 'string'
        ? request.responseBody
        : JSON.stringify(request.responseBody, null, 2)
      : '(empty)';
  }

  populateTiming(request) {
    const timingDiv = document.getElementById('timing-info');
    timingDiv.innerHTML = `
      <div style="font-size: 12px; line-height: 1.8;">
        <p><strong>URL:</strong> ${request.url}</p>
        <p><strong>Method:</strong> ${request.method}</p>
        <p><strong>Type:</strong> ${request.type}</p>
        <p><strong>Status:</strong> ${request.statusCode} ${request.statusText || ''}</p>
        <p><strong>Duration:</strong> ${request.duration > 0 ? request.duration.toFixed(2) + ' ms' : 'N/A'}</p>
        <p><strong>Timestamp:</strong> ${new Date(request.timestamp).toLocaleString()}</p>
        <p><strong>Size:</strong> ${this.formatSize(request.size)}</p>
      </div>
    `;
  }

  hideDetailsPanel() {
    this.detailsPanel.style.display = 'none';
    this.selectedRequestId = null;
    this.renderNetworkTable();
  }

  switchDetailsTab(tabName) {
    this.detailsTabs.forEach((btn) => btn.classList.remove('active'));
    document.querySelector(`[data-details-tab="${tabName}"]`).classList.add('active');

    this.detailsTabContents.forEach((content) => content.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
  }

  clearRequests() {
    if (confirm('Clear all captured requests?')) {
      this.port.postMessage({ type: 'CLEAR_REQUESTS' });
      this.requests = [];
      this.requestMap.clear();
      this.renderNetworkTable();
      this.hideDetailsPanel();
    }
  }

  togglePauseCapture() {
    // Note: In real implementation, this would pause the background listener
    console.log(
      'Capture',
      this.pauseCheckbox.checked ? 'paused' : 'resumed'
    );
  }

  // === Intrude Mode Methods ===

  changeInterceptMode(mode) {
    this.interceptMode = mode;
    this.port.postMessage({
      type: 'SET_INTERCEPT_MODE',
      data: { mode }
    });
    this.updateIntrudeModeUI();
  }

  updateIntrudeModeUI() {
    // Update status display
    const modeLabel = {
      off: 'Off',
      'no-js': 'No JS, No Forward',
      'yes-js': 'Yes JS, No Forward'
    }[this.interceptMode];

    this.modeStatus.textContent = modeLabel;
    this.interceptedCount.textContent = this.interceptQueue.length;
    this.pausedJsStatus.textContent =
      this.interceptMode === 'no-js' ? 'Yes' : 'No';

    // Update radio selection
    document.querySelector(
      `input[value="${this.interceptMode}"]`
    ).checked = true;

    this.renderInterceptionQueue();
  }

  renderInterceptionQueue() {
    if (this.interceptQueue.length === 0) {
      this.intrudeQueue.innerHTML = `
        <p class="empty-state">No intercepted requests. Enable a mode and navigate to capture requests.</p>
      `;
      return;
    }

    this.intrudeQueue.innerHTML = this.interceptQueue
      .map(
        (item) => `
        <div class="queue-item" data-request-id="${item.requestId}">
          <div class="queue-item-method">${item.request?.method || 'UNKNOWN'}</div>
          <div class="queue-item-url">${item.request?.url || 'Unknown URL'}</div>
          <div class="queue-item-actions">
            <button class="edit-btn" onclick="panel.editRequest('${item.requestId}')">Edit</button>
            <button class="drop-btn" onclick="panel.dropRequest('${item.requestId}')">Drop</button>
          </div>
        </div>
      `
      )
      .join('');
  }

  editRequest(requestId) {
    const item = this.interceptQueue.find((q) => q.requestId === requestId);
    if (!item) return;

    const request = item.request;
    document.getElementById('editor-title').textContent = `Modify: ${item.request?.method} ${this.getFileNameFromUrl(
      request.url
    )}`;

    // Populate headers
    this.headersEditor.innerHTML = '';
    if (request.requestHeaders) {
      request.requestHeaders.forEach((header) => {
        this.addHeaderRow(header.name || header, header.value || '');
      });
    }

    // Populate body
    this.bodyEditor.value = request.requestBody || '';

    // Store the request ID for later
    this.requestEditor.dataset.requestId = requestId;
    this.requestEditor.style.display = 'flex';
  }

  addHeaderRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'header-editor-row';
    row.innerHTML = `
      <input type="text" class="header-name-input" placeholder="Header name" value="${name}">
      <input type="text" class="header-value-input" placeholder="Header value" value="${value}">
      <button class="remove-btn">Remove</button>
    `;

    row.querySelector('.remove-btn').addEventListener('click', () => row.remove());
    this.headersEditor.appendChild(row);
  }

  hideRequestEditor() {
    this.requestEditor.style.display = 'none';
    this.requestEditor.dataset.requestId = '';
  }

  switchEditorTab(tabName) {
    this.editorTabs.forEach((btn) => btn.classList.remove('active'));
    document.querySelector(`[data-editor-tab="${tabName}"]`).classList.add('active');

    this.editorTabContents.forEach((content) => content.classList.remove('active'));
    document.getElementById(`${tabName}-editor-tab`).classList.add('active');
  }

  forwardRequest() {
    const requestId = this.requestEditor.dataset.requestId;
    if (!requestId) return;

    // Collect modifications
    const modifications = {
      requestHeaders: Array.from(
        this.headersEditor.querySelectorAll('.header-editor-row')
      ).map((row) => ({
        name: row.querySelector('.header-name-input').value,
        value: row.querySelector('.header-value-input').value
      })),
      requestBody: this.bodyEditor.value
    };

    this.port.postMessage({
      type: 'FORWARD_REQUEST',
      data: {
        requestId,
        modifications
      }
    });

    // Remove from queue
    this.interceptQueue = this.interceptQueue.filter(
      (item) => item.requestId !== requestId
    );

    this.hideRequestEditor();
    this.updateIntrudeModeUI();
  }

  dropRequest(requestId) {
    if (!requestId) {
      requestId = this.requestEditor.dataset.requestId;
    }

    if (!requestId) return;

    this.port.postMessage({
      type: 'DROP_REQUEST',
      data: { requestId }
    });

    this.interceptQueue = this.interceptQueue.filter(
      (item) => item.requestId !== requestId
    );

    this.hideRequestEditor();
    this.updateIntrudeModeUI();
  }

  // === Utility Methods ===

  getFileNameFromUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.split('/').pop() || u.hostname;
      return path || url;
    } catch {
      return url.substring(0, 50);
    }
  }

  getStatusClass(status) {
    if (status >= 200 && status < 300) return 'success';
    if (status >= 400) return 'error';
    return 'pending';
  }

  formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}

// Initialize the panel when DOM is ready
let panel;
document.addEventListener('DOMContentLoaded', () => {
  panel = new DevToolsProPanel();
});

// Export for onclick handlers in HTML
window.panel = panel;
