class DevToolsProPanel {
  constructor() {
    this.tabId = chrome.devtools.inspectedWindow.tabId;
    this.port = null;
    this.requests = [];
    this.requestMap = new Map();
    this.interceptQueue = [];
    this.interceptMode = 'off';
    this.selectedRequestId = null;

    this.initializeElements();
    this.setupEventListeners();
    this.connectToBackground();
    this.renderNetworkTable();
    this.renderInterceptionQueue();
    this.updateIntrudeModeUI();
  }

  initializeElements() {
    this.statusEl = document.getElementById('panel-status');
    this.tabButtons = document.querySelectorAll('.tab-btn');
    this.tabContents = document.querySelectorAll('.tab-content');

    this.filterInput = document.getElementById('filter-input');
    this.clearBtn = document.getElementById('clear-btn');
    this.networkTbody = document.getElementById('network-tbody');

    this.detailsPanel = document.getElementById('details-panel');
    this.closeDetailsBtn = document.querySelector('.close-details-btn');
    this.detailsTitle = document.getElementById('details-title');
    this.requestHeadersPre = document.getElementById('request-headers');
    this.responseHeadersPre = document.getElementById('response-headers');
    this.requestBodyPre = document.getElementById('request-body-content');
    this.responseBodyPre = document.getElementById('response-body-content');
    this.timingInfo = document.getElementById('timing-info');

    this.intrudeModeRadios = document.querySelectorAll('input[name="intrude-mode"]');
    this.modeStatus = document.getElementById('mode-status');
    this.interceptedCount = document.getElementById('intercepted-count');
    this.pausedJsStatus = document.getElementById('paused-js-status');
    this.intrudeQueue = document.getElementById('intrude-queue');

    this.requestEditor = document.getElementById('request-editor');
    this.editorTitle = document.getElementById('editor-title');
    this.closeEditorBtn = document.querySelector('.close-editor-btn');
    this.headersEditor = document.getElementById('headers-editor');
    this.bodyEditor = document.getElementById('body-editor');
    this.addHeaderBtn = document.getElementById('add-header-btn');
    this.forwardBtn = document.getElementById('forward-btn');
    this.dropBtn = document.getElementById('drop-btn');
  }

  setupEventListeners() {
    this.tabButtons.forEach((button) => {
      button.addEventListener('click', () => this.switchTab(button.dataset.tab));
    });

    this.filterInput.addEventListener('input', () => this.renderNetworkTable());
    this.clearBtn.addEventListener('click', () => this.clearRequests());
    this.closeDetailsBtn.addEventListener('click', () => this.hideDetailsPanel());

    this.intrudeModeRadios.forEach((radio) => {
      radio.addEventListener('change', () => this.changeInterceptMode(radio.value));
    });

    this.addHeaderBtn.addEventListener('click', () => this.addHeaderRow());
    this.closeEditorBtn.addEventListener('click', () => this.hideRequestEditor());
    this.forwardBtn.addEventListener('click', () => this.forwardRequest());
    this.dropBtn.addEventListener('click', () => this.dropRequest());
  }

  connectToBackground() {
    this.port = chrome.runtime.connect({ name: `devtools-${this.tabId}` });

    this.port.onMessage.addListener((message) => this.handleBackgroundMessage(message));
    this.port.onDisconnect.addListener(() => {
      this.setStatus('Disconnected', true);
    });

    chrome.runtime.sendMessage(
      {
        type: 'GET_TAB_DATA',
        tabId: this.tabId
      },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          this.setStatus('Failed to load tab data', true);
          return;
        }

        this.applySnapshot(response);
        this.setStatus('Connected');
      }
    );
  }

  applySnapshot(snapshot) {
    const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
    this.requests = requests.map((request) => this.normalizeRequest(request));
    this.requestMap = new Map(this.requests.map((request) => [request.id, request]));

    const queue = Array.isArray(snapshot.interceptQueue) ? snapshot.interceptQueue : [];
    this.interceptQueue = queue
      .map((item) => this.normalizeQueueItem(item))
      .filter(Boolean);

    this.interceptMode = snapshot.interceptMode || 'off';

    this.renderNetworkTable();
    this.renderInterceptionQueue();
    this.updateIntrudeModeUI();
  }

  handleBackgroundMessage(message) {
    const { type, data } = message;

    switch (type) {
      case 'INITIAL_STATE':
        this.applySnapshot(data || {});
        this.setStatus('Live');
        break;

      case 'NEW_REQUEST':
      case 'REQUEST_UPDATED':
        this.upsertRequest(this.normalizeRequest(data));
        this.renderNetworkTable();
        if (this.selectedRequestId === String(data && data.id)) {
          this.renderDetails(this.requestMap.get(this.selectedRequestId));
        }
        break;

      case 'REQUEST_INTERCEPTED':
        {
          const item = this.normalizeQueueItem({
            requestId: data && data.requestId,
            request: data && data.request
          });

          if (item) {
            this.upsertQueueItem(item);
            this.renderInterceptionQueue();
            this.updateIntrudeModeUI();
            this.setStatus(`Intercepted ${item.request.method} ${this.getFileNameFromUrl(item.request.url)}`);
          }
        }
        break;

      case 'REQUESTS_CLEARED':
        this.requests = [];
        this.requestMap.clear();
        this.interceptQueue = [];
        this.hideRequestEditor();
        this.hideDetailsPanel();
        this.renderNetworkTable();
        this.renderInterceptionQueue();
        this.updateIntrudeModeUI();
        this.setStatus('Cleared');
        break;

      default:
        break;
    }
  }

  normalizeHeaders(headers) {
    if (Array.isArray(headers)) {
      return headers
        .filter((header) => header && header.name)
        .map((header) => ({
          name: String(header.name),
          value: header.value == null ? '' : String(header.value)
        }));
    }

    if (headers && typeof headers === 'object') {
      return Object.entries(headers).map(([name, value]) => ({
        name,
        value: value == null ? '' : String(value)
      }));
    }

    return [];
  }

  normalizeRequest(request) {
    const id = String((request && request.id) || (request && request.requestId) || 'unknown');
    return {
      id,
      url: (request && request.url) || '',
      method: (request && request.method) || 'GET',
      type: (request && request.type) || 'other',
      statusCode: Number((request && request.statusCode) || 0),
      statusText: (request && request.statusText) || '',
      duration: Number((request && request.duration) || 0),
      size: Number((request && request.size) || 0),
      timestamp: Number((request && request.timestamp) || Date.now()),
      requestHeaders: this.normalizeHeaders(request && request.requestHeaders),
      responseHeaders: this.normalizeHeaders(request && request.responseHeaders),
      requestBody:
        request && Object.prototype.hasOwnProperty.call(request, 'requestBody')
          ? String(request.requestBody)
          : '',
      responseBody:
        request && Object.prototype.hasOwnProperty.call(request, 'responseBody')
          ? String(request.responseBody)
          : ''
    };
  }

  normalizeQueueItem(item) {
    if (!item || !item.requestId) return null;

    const requestId = String(item.requestId);
    const request = item.request
      ? this.normalizeRequest(item.request)
      : this.requestMap.get(requestId) ||
      this.normalizeRequest({
        id: requestId,
        method: 'UNKNOWN',
        url: 'Unknown URL',
        type: 'intercepted'
      });

    return {
      requestId,
      status: item.status || 'pending',
      modifications: item.modifications || {},
      request
    };
  }

  upsertRequest(request) {
    if (!request || !request.id) return;

    this.requestMap.set(request.id, request);
    const index = this.requests.findIndex((entry) => entry.id === request.id);

    if (index >= 0) {
      this.requests[index] = request;
    } else {
      this.requests.push(request);
    }

    if (this.requests.length > 1500) {
      this.requests = this.requests.slice(this.requests.length - 1500);
      this.requestMap = new Map(this.requests.map((entry) => [entry.id, entry]));
    }
  }

  upsertQueueItem(queueItem) {
    const index = this.interceptQueue.findIndex(
      (item) => item.requestId === queueItem.requestId
    );

    if (index >= 0) {
      this.interceptQueue[index] = queueItem;
    } else {
      this.interceptQueue.unshift(queueItem);
    }

    this.requestMap.set(queueItem.request.id, queueItem.request);
  }

  switchTab(tabName) {
    this.tabButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tabName);
    });

    this.tabContents.forEach((section) => {
      section.classList.toggle('active', section.id === tabName);
    });
  }

  getFilteredRequests() {
    const query = this.filterInput.value.trim().toLowerCase();
    let list = [...this.requests].sort((a, b) => b.timestamp - a.timestamp);

    if (!query) {
      return list;
    }

    return list.filter((request) => {
      return (
        request.url.toLowerCase().includes(query) ||
        request.method.toLowerCase().includes(query) ||
        request.type.toLowerCase().includes(query) ||
        String(request.statusCode).includes(query)
      );
    });
  }

  renderNetworkTable() {
    const requests = this.getFilteredRequests();
    this.networkTbody.innerHTML = '';

    if (requests.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'empty-state';
      cell.textContent = 'No requests captured yet.';
      row.appendChild(cell);
      this.networkTbody.appendChild(row);
      return;
    }

    const fragment = document.createDocumentFragment();

    requests.forEach((request) => {
      const row = document.createElement('tr');
      row.dataset.requestId = request.id;
      row.classList.toggle('selected', request.id === this.selectedRequestId);

      const nameCell = document.createElement('td');
      nameCell.textContent = this.getFileNameFromUrl(request.url);

      const methodCell = document.createElement('td');
      methodCell.textContent = request.method;

      const statusCell = document.createElement('td');
      const statusSpan = document.createElement('span');
      statusSpan.className = `status-${this.getStatusClass(request.statusCode)}`;
      statusSpan.textContent = request.statusCode > 0 ? String(request.statusCode) : '-';
      statusCell.appendChild(statusSpan);

      const typeCell = document.createElement('td');
      typeCell.textContent = request.type;

      const sizeCell = document.createElement('td');
      sizeCell.textContent = this.formatSize(request.size);

      const durationCell = document.createElement('td');
      durationCell.textContent = this.formatDuration(request.duration);

      row.appendChild(nameCell);
      row.appendChild(methodCell);
      row.appendChild(statusCell);
      row.appendChild(typeCell);
      row.appendChild(sizeCell);
      row.appendChild(durationCell);

      row.addEventListener('click', () => this.selectRequest(request.id));
      fragment.appendChild(row);
    });

    this.networkTbody.appendChild(fragment);
  }

  selectRequest(requestId) {
    this.selectedRequestId = String(requestId);
    this.renderNetworkTable();

    const request = this.requestMap.get(this.selectedRequestId);
    if (request) {
      this.renderDetails(request);
    }
  }

  renderDetails(request) {
    if (!request) return;

    this.detailsPanel.classList.remove('hidden');
    this.detailsTitle.textContent = `${request.method} ${request.url}`;
    this.requestHeadersPre.textContent = this.formatHeaders(request.requestHeaders);
    this.responseHeadersPre.textContent = this.formatHeaders(request.responseHeaders);
    this.requestBodyPre.textContent = this.formatBody(request.requestBody);
    this.responseBodyPre.textContent = this.formatBody(request.responseBody);
    this.timingInfo.textContent =
      `Status: ${request.statusCode || '-'} ${request.statusText || ''}  |  ` +
      `Duration: ${this.formatDuration(request.duration)}  |  ` +
      `Size: ${this.formatSize(request.size)}`;
  }

  hideDetailsPanel() {
    this.detailsPanel.classList.add('hidden');
    this.selectedRequestId = null;
    this.renderNetworkTable();
  }

  renderInterceptionQueue() {
    this.intrudeQueue.innerHTML = '';

    if (this.interceptQueue.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No intercepted requests. Switch to an intrude mode and trigger requests.';
      this.intrudeQueue.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    this.interceptQueue.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'queue-item';
      card.dataset.requestId = item.requestId;

      const method = document.createElement('div');
      method.className = 'queue-item-method';
      method.textContent = item.request.method || 'UNKNOWN';

      const url = document.createElement('div');
      url.className = 'queue-item-url';
      url.textContent = item.request.url || 'Unknown URL';

      const actions = document.createElement('div');
      actions.className = 'queue-item-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => this.editRequest(item.requestId));

      const dropBtn = document.createElement('button');
      dropBtn.type = 'button';
      dropBtn.className = 'btn-danger';
      dropBtn.textContent = 'Drop';
      dropBtn.addEventListener('click', () => this.dropRequest(item.requestId));

      actions.appendChild(editBtn);
      actions.appendChild(dropBtn);

      card.appendChild(method);
      card.appendChild(url);
      card.appendChild(actions);
      fragment.appendChild(card);
    });

    this.intrudeQueue.appendChild(fragment);
  }

  updateIntrudeModeUI() {
    const modeLabel = {
      off: 'Off',
      'no-js': 'No JS, No Forward',
      'yes-js': 'Yes JS, No Forward'
    }[this.interceptMode] || 'Off';

    this.modeStatus.textContent = modeLabel;
    this.interceptedCount.textContent = String(this.interceptQueue.length);
    this.pausedJsStatus.textContent = this.interceptMode === 'no-js' ? 'Yes' : 'No';

    this.intrudeModeRadios.forEach((radio) => {
      radio.checked = radio.value === this.interceptMode;
    });
  }

  changeInterceptMode(mode) {
    this.interceptMode = mode;
    this.updateIntrudeModeUI();
    this.setStatus(`Mode set to ${mode}`);

    if (this.port) {
      this.port.postMessage({
        type: 'SET_INTERCEPT_MODE',
        data: { mode }
      });
    }
  }

  editRequest(requestId) {
    const item = this.interceptQueue.find((entry) => entry.requestId === requestId);
    if (!item) return;

    this.requestEditor.classList.remove('hidden');
    this.requestEditor.dataset.requestId = requestId;
    this.editorTitle.textContent = `${item.request.method} ${item.request.url}`;

    this.headersEditor.innerHTML = '';
    if (item.request.requestHeaders.length === 0) {
      this.addHeaderRow('', '');
    } else {
      item.request.requestHeaders.forEach((header) => {
        this.addHeaderRow(header.name || '', header.value || '');
      });
    }

    this.bodyEditor.value = item.request.requestBody || '';
  }

  addHeaderRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'header-editor-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'header-name-input';
    nameInput.placeholder = 'Header name';
    nameInput.value = name;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'header-value-input';
    valueInput.placeholder = 'Header value';
    valueInput.value = value;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn-danger';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => row.remove());

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(removeButton);
    this.headersEditor.appendChild(row);
  }

  collectHeaderEdits() {
    return Array.from(this.headersEditor.querySelectorAll('.header-editor-row'))
      .map((row) => {
        const name = row.querySelector('.header-name-input').value.trim();
        const value = row.querySelector('.header-value-input').value;
        return { name, value };
      })
      .filter((header) => header.name.length > 0);
  }

  forwardRequest() {
    const requestId = this.requestEditor.dataset.requestId;
    if (!requestId) return;

    const modifications = {
      requestHeaders: this.collectHeaderEdits(),
      requestBody: this.bodyEditor.value
    };

    if (this.port) {
      this.port.postMessage({
        type: 'FORWARD_REQUEST',
        data: { requestId, modifications }
      });
    }

    this.interceptQueue = this.interceptQueue.filter((item) => item.requestId !== requestId);
    this.hideRequestEditor();
    this.renderInterceptionQueue();
    this.updateIntrudeModeUI();
  }

  dropRequest(requestId = this.requestEditor.dataset.requestId) {
    if (!requestId) return;

    if (this.port) {
      this.port.postMessage({
        type: 'DROP_REQUEST',
        data: { requestId }
      });
    }

    this.interceptQueue = this.interceptQueue.filter((item) => item.requestId !== requestId);
    this.hideRequestEditor();
    this.renderInterceptionQueue();
    this.updateIntrudeModeUI();
  }

  hideRequestEditor() {
    this.requestEditor.classList.add('hidden');
    this.requestEditor.dataset.requestId = '';
    this.headersEditor.innerHTML = '';
    this.bodyEditor.value = '';
  }

  clearRequests() {
    const shouldClear = window.confirm('Clear all captured requests and interception queue?');
    if (!shouldClear) return;

    this.requests = [];
    this.requestMap.clear();
    this.interceptQueue = [];
    this.hideRequestEditor();
    this.hideDetailsPanel();
    this.renderNetworkTable();
    this.renderInterceptionQueue();
    this.updateIntrudeModeUI();

    if (this.port) {
      this.port.postMessage({ type: 'CLEAR_REQUESTS' });
    }
  }

  setStatus(message, isError = false) {
    this.statusEl.textContent = message;
    this.statusEl.style.color = isError ? '#ff8fa0' : '#9ba7ba';
  }

  formatHeaders(headers) {
    if (!headers || headers.length === 0) return '(empty)';
    return headers.map((header) => `${header.name}: ${header.value}`).join('\n');
  }

  formatBody(body) {
    if (body == null || body === '') return '(empty)';
    return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  }

  getFileNameFromUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.pathname.split('/').pop() || parsed.hostname;
    } catch {
      return String(url || '').slice(0, 80);
    }
  }

  getStatusClass(status) {
    if (status >= 200 && status < 400) return 'success';
    if (status >= 400) return 'error';
    return 'pending';
  }

  formatDuration(duration) {
    return duration > 0 ? `${duration.toFixed(1)} ms` : '-';
  }

  formatSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new DevToolsProPanel();
});
