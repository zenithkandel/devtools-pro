// DevTools panel bootstrap.
const PANEL_TITLE = 'devtools-pro';
const PANEL_PATH = 'src/panel.html';

if (!chrome.devtools || !chrome.devtools.panels) {
  console.warn('[DevTools Pro] DevTools API unavailable in this context.');
} else {
  chrome.devtools.panels.create(PANEL_TITLE, null, PANEL_PATH, () => {
    if (chrome.runtime.lastError) {
      console.error(
        '[DevTools Pro] Failed to create panel:',
        chrome.runtime.lastError.message
      );
      return;
    }

    console.log('[DevTools Pro] Panel ready:', PANEL_PATH);
  });
}
