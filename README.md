# DevTools Pro - Chrome Extension

A professional network request monitoring and interception tool for Chrome DevTools.

## Features

### Network Monitor Tab

- **Real-time Request Monitoring**: Capture all network requests made by web pages
- **Comprehensive Request Details**: View headers, body, response, and timing information
- **Smart Filtering**: Filter requests by name, path, status code, or type
- **Request Timeline**: Visual waterfall chart showing request duration
- **One-Click Details**: Click any request to see full request/response details

### Intrude Mode Tab

Intercept and modify network requests in real-time (similar to Burp Suite):

#### Mode 1: No JS, No Forward

- Pauses JavaScript execution on the page
- Intercepts all network requests
- Allows modifying request headers and body
- Forward, drop, or modify each request before it's sent

#### Mode 2: Yes JS, No Forward

- Allows normal JavaScript execution
- Intercepts network requests
- Allows modifying request headers and body
- Forward or drop each request

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `devtools-pro` folder
6. Open DevTools (F12) - you'll see a "devtools-pro" tab

## Architecture

### Components

- **manifest.json**: Chrome Extension configuration (Manifest V3)
- **src/devtools.html & src/devtools.js**: DevTools panel creation
- **src/panel.html & src/panel.js**: Main UI and logic
- **src/background.js**: Background service worker for state management and message routing
- **src/content.js**: Content script for page injection and fetch/XHR interception
- **src/styles/panel.css**: Styling for the DevTools panel

### Message Flow

```
Page Context (fetch/XHR)
    ↓
Content Script
    ↓ (window.postMessage)
Page Context (injected script)
    ↓ (chrome.runtime.sendMessage)
Background Service Worker
    ↓ (chrome.runtime.connect)
DevTools Panel
```

## Usage

### Network Monitoring

1. Open DevTools and go to the "devtools-pro" tab
2. Navigate to any website
3. See all network requests captured in the table
4. Click on any request to see details:
   - Headers (request and response)
   - Request/Response body
   - Timing and metadata
5. use the filter box to search by name, status, or type
6. Click "Clear" to reset the request list

### Intrude Mode - No JS

1. Go to "Intrude Mode" tab
2. Select "No JS, No Forward" mode
3. Navigate to a website
4. JavaScript execution will pause
5. Each network request will appear in the "Interception Queue"
6. Click "Edit" to modify request headers/body
7. Click "Forward" to send the modified request
8. Click "Drop" to cancel the request
9. JavaScript will resume after you handle all intercepted requests

### Intrude Mode - Yes JS

1. Go to "Intrude Mode" tab
2. Select "Yes JS, No Forward" mode
3. Navigate to a website
4. JavaScript executes normally
5. Each network request will appear in the "Interception Queue"
6. Modify, forward, or drop requests as needed
7. The page continues to load and execute normally

## Technical Details

### Manifest V3 Compatibility

This extension uses Manifest V3 features:

- Service worker (background.js) instead of persistent background page
- `webRequest` API for monitoring (inspection-only)
- Content script-based fetch/XHR interception for actual request modification
- Runtime message passing for inter-component communication

### Request Interception

Request interception is implemented at the page context level by:

1. Injecting a page context script that wraps `fetch()` and `XMLHttpRequest`
2. Queuing intercepted requests when a mode is enabled
3. Pausing JavaScript execution (in no-js mode) until user responds
4. Forwarding, dropping, or modifying requests based on user action

### Limitations

- Some requests (CORS preflight, etc.) may not be interceptable
- Response body reading may be limited for some response types
- Large files may impact performance
- Extension only works for tabs, not for other DevTools targets

## Development

To modify and test the extension:

1. Make changes to the source files
2. Go to `chrome://extensions/`
3. Find "DevTools Pro" and click the refresh icon (🔄)
4. Close and reopen DevTools to see changes

## Debugging

- Check `chrome://extensions/` for any errors
- Use the DevTools console in the DevTools Pro tab for debugging
- Background service worker logs appear in the extension service worker logs

## Future Enhancements

- Export/import request logs
- Request replay functionality
- More detailed timing breakdowns
- WebSocket interception
- Performance profiling integration

## License

Professional use - DevTools Pro Extension

---

**Note**: This extension is designed for legitimate security testing and development purposes. Use it responsibly.
