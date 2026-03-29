// DevTools Extension Bootstrap
// This script creates the "DevTools Pro" panel in Chrome DevTools

chrome.devtools.panels.create(
  "devtools-pro",
  null,
  "panel.html",
  (panel) => {
    console.log("DevTools Pro panel created successfully");
  }
);
