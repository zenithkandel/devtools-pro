# Quick Start Guide - DevTools Pro

Get the extension up and running in 3 minutes!

## Installation

### Step 1: Load the Extension

```
1. Open Chrome browser
2. Go to chrome://extensions/
3. Toggle "Developer mode" (top right corner)
4. Click "Load unpacked"
5. Navigate to the devtools-pro folder
6. Click "Select Folder"
```

### Step 2: Verify Installation

```
1. Go to any website (e.g., google.com)
2. Press F12 to open DevTools
3. Look for "devtools-pro" tab next to Console, Sources, etc.
4. If you see it, you're ready!
```

## First Time Usage

### Network Monitor (Default Tab)

```
What to do:
1. Click the "devtools-pro" tab
2. Navigate around the current website
3. Watch requests appear in the table
4. Click any request to see details
5. Use the filter box to search requests
```

### Enable Intrude Mode

```
1. Click the "Intrude Mode" tab
2. Select a mode:
   - "No JS, No Forward" - Pauses JavaScript
   - "Yes JS, No Forward" - Normal JavaScript
3. Navigate to a website
4. Intercepted requests appear in the queue
5. Click "Edit" on any request to modify
6. Click "Forward" to send it on, or "Drop" to cancel
```

## Common Tasks

### View Request Details

```
1. Network Monitor tab
2. Click any request in the table
3. See the details panel at the bottom
4. Click tabs: Headers, Request, Response, Timing
```

### Modify a Request Header

```
1. Enable Intrude Mode (any mode)
2. Edit a request when it appears
3. Click "Headers" tab in the editor
4. Modify existing headers or add new ones
5. Click "Forward" to send
```

### Modify Request Body

```
1. Enable Intrude Mode
2. Edit a request
3. Click "Body" tab in the editor
4. Edit the request body text
5. Click "Forward" to send
```

### Drop a Request

```
1. Enable Intrude Mode
2. A request you want to block appears
3. Click "Drop" button
4. Request is canceled and doesn't reach the server
```

### Clear All Requests

```
1. Network Monitor tab
2. Click "Clear" button
3. All captured requests are deleted
```

## Debugging Tips

### Extension Not Appearing?

```
1. Check chrome://extensions/
2. Make sure DevTools Pro is enabled (toggle on)
3. Try refreshing DevTools (F12, then F12 again)
4. Check if you're on a valid website (not chrome://)
```

### Requests Not Capturing?

```
1. Make sure you're on the Network Monitor tab
2. Check the "Pause" checkbox is OFF
3. Make sure the website has network activity
4. Try navigating to a new page
5. Check browser console (F12) for errors
```

### Intrude Mode Not Intercepting?

```
1. Make sure a mode is selected (not "Off")
2. Wait for the first request to appear
3. If no requests appear, reload the page
4. Check that the mode status shows the correct mode
```

## Keyboard Shortcuts

- **F12**: Open/close DevTools
- **Escape**: Close request details panel
- **Tab**: Navigate between elements
- **Enter**: Confirm dialogs and buttons

## Important Notes

⚠️ **JavaScript Pause Mode**

- Only works when a page is loading
- Once paused, you MUST handle intercepted requests to resume JS
- If stuck, close the DevTools tab and reload the page

⚠️ **Performance**

- Capturing 500+ requests may slow DevTools
- Use "Clear" to clean up old requests
- Large request bodies may impact performance

✅ **Best Practices**

- Start with "Network Monitor" to understand traffic
- Use Intrude Mode for specific testing scenarios
- Clear requests between test runs
- Enable Pause checkbox if you need to capture while away

## Troubleshooting

**Issue**: Extension won't load
**Solution**: Check manifest.json is in root folder, not in a subfolder

**Issue**: Can't see network requests
**Solution**: Make sure you're monitoring a normal webpage (not about:, chrome://, etc.)

**Issue**: Intrude Mode seems frozen
**Solution**: This is normal in "No JS" mode - handle pending requests to resume JS

**Issue**: Modified headers don't seem to work
**Solution**: Some headers are protected by the browser and can't be modified

## Need Help?

1. Check README.md for detailed documentation
2. Check browser console (F12 → Console) for error messages
3. In the extension service worker logs for background errors
4. Check IMPLEMENTATION_SUMMARY.md for technical details

---

**Ready to intercept?** You're all set! Start with the Network Monitor tab to get familiar with your traffic.
