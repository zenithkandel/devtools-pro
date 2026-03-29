// DevTools Extension Bootstrap
// This script creates the "DevTools Pro" panel in Chrome DevTools

const PANEL_PAGE_PATH = 'src/panel.html';

if (!chrome.devtools?.panels) {
  console.warn('[DevTools Pro] DevTools APIs are not available in this context.');
} else {
  chrome.devtools.panels.create('devtools-pro', null, PANEL_PAGE_PATH, (panel) => {
    if (chrome.runtime.lastError) {
      console.error('[DevTools Pro] Failed to create panel:', chrome.runtime.lastError.message);
      return;
    }

    console.log('[DevTools Pro] Panel created successfully at', PANEL_PAGE_PATH);
  });
}
