const { app } = require('electron');

// Native mouse/keyboard tests need the test app, not the terminal, in front.
async function focusWindow(window) {
  const started = Date.now();
  while (true) {
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
    if (window.isFocused() && await window.webContents.executeJavaScript('document.hasFocus()')) return;
    if (Date.now() - started > 5000) throw new Error('Isolated test window could not acquire native focus');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
module.exports = { focusWindow };
