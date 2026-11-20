const path = require('node:path');
const { run, buildBackupTool, buildDesktop } = require('./desktop-build.cjs');

function testDesktop() {
  if (process.platform !== 'darwin') throw new Error('Tauri 桌面 WebView 自测需要 macOS');
  run('npm', ['run', 'build', '--', '--smoke-test']);
  try {
    const backup = buildBackupTool();
    const app = buildDesktop(['smoke-test']);
    run(process.execPath, [path.join(__dirname, 'check-webview.cjs'), app, backup]);
  } finally {
    run('npm', ['run', 'build']);
    buildDesktop();
  }
}

if (require.main === module) {
  try { testDesktop(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
