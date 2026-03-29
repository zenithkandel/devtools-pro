/**
 * devtools.js
 * Registers the DevTools Pro panel in Chrome DevTools.
 */
chrome.devtools.panels.create(
  "DevTools Pro",
  null,           // icon (optional)
  "panel.html",
  (panel) => {
    panel.onShown.addListener((win) => {
      // Panel shown
    });
  }
);
