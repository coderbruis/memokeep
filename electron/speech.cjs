// 复习时的语音作答：在主进程里启动 macOS 语音识别辅助程序（native/speech），把事件转发给窗口。
// 一次只有一个收音会话；窗口关闭或开始新会话时，旧的会被取消。
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['zh-CN', 'zh-HK', 'en-US'];
const settingsUrls = {
  'microphone-denied': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'speech-denied': 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition'
};

function defaultHelperPath(app) {
  return app.isPackaged ? path.join(process.resourcesPath, 'memokeep-speech') : path.join(__dirname, '..', 'build', 'speech', 'memokeep-speech');
}

function createSpeechService({ app, systemPreferences, shell, helperPath = defaultHelperPath(app), spawnProcess = spawn, execProcess = execFile, platform = process.platform }) {
  let active = null;
  let startVersion = 0;

  const available = () => platform === 'darwin' && fs.existsSync(helperPath);

  function end(session) {
    if (active === session) active = null;
    if (session.child.exitCode === null && !session.child.killed) session.child.kill();
  }

  async function microphoneAllowed() {
    const status = systemPreferences.getMediaAccessStatus?.('microphone');
    if (status === 'granted' || status === undefined) return true;
    if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
    return false;
  }

  async function start(webContents, id, terms = [], options = {}) {
    if (!available()) return { ok: false, code: 'unsupported', message: '这台电脑不支持语音作答' };
    const version = ++startVersion;
    if (active) cancelSession(active);
    if (!await microphoneAllowed()) return { ok: false, code: 'microphone-denied', message: '没有麦克风权限' };
    if (version !== startVersion) return { ok: false, code: 'cancelled', message: '语音会话已取消' };
    // 提示词：最多 100 个、每个最长 60 字，只收字符串。
    const hints = (Array.isArray(terms) ? terms : []).filter(term => typeof term === 'string' && term.trim()).map(term => term.trim().slice(0, 60)).slice(0, 100);
    // 识别语言和「只在本机识别」来自 设置 › 语音作答。
    const locale = LOCALES.includes(options?.locale) ? options.locale : 'zh-CN';
    const args = ['--locale', locale, ...(options?.onDevice === false ? ['--allow-server'] : []), ...(hints.length ? ['--terms', JSON.stringify(hints)] : [])];
    const child = spawnProcess(helperPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const session = { id: String(id), child, settled: false };
    active = session;
    const send = event => {
      if (['final', 'error', 'cancelled'].includes(event.type)) session.settled = true;
      if (!webContents.isDestroyed()) webContents.send('speech:event', { ...event, session: session.id });
    };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { send(JSON.parse(line)); } catch { /* 忽略不是 JSON 的输出 */ }
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', error => { if (!session.settled) send({ type: 'error', code: 'launch', message: error.message }); end(session); });
    child.on('exit', () => {
      if (!session.settled && !session.cancelled) send({ type: 'error', code: 'exited', message: '语音识别意外停止了' });
      if (active === session) active = null;
    });
    webContents.once('destroyed', () => { if (active === session) cancel(); });
    return { ok: true, session: session.id };
  }

  function writeTo(session, command) {
    if (!session || session.child.exitCode !== null || session.child.killed) return false;
    session.child.stdin.write(`${command}\n`);
    return true;
  }

  function stop() { return writeTo(active, 'stop'); }

  function cancelSession(session) {
    if (!session) return false;
    session.cancelled = true;
    writeTo(session, 'cancel');
    if (active === session) active = null;
    setTimeout(() => end(session), 500).unref?.();
    return true;
  }

  function cancel() { startVersion++; return cancelSession(active); }

  // 设置页显示的状态：麦克风 / 语音识别权限，这种语言能不能在本机识别。
  const SPEECH_STATUS = ['not-determined', 'denied', 'restricted', 'granted'];
  function status(locale = 'zh-CN') {
    const microphone = systemPreferences.getMediaAccessStatus?.('microphone') || 'granted';
    if (!available()) return Promise.resolve({ supported: false, microphone, speech: 'unknown', onDevice: false, recognizer: false });
    const lang = LOCALES.includes(locale) ? locale : 'zh-CN';
    return new Promise(resolve => {
      execProcess(helperPath, ['--check', '--locale', lang], { timeout: 5000 }, (error, stdout) => {
        let check = null;
        try { check = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch {}
        if (error || !check) { resolve({ supported: true, microphone, speech: 'unknown', onDevice: false, recognizer: false }); return; }
        resolve({ supported: true, microphone, speech: SPEECH_STATUS[check.speech] || 'unknown', onDevice: Boolean(check.onDevice), recognizer: Boolean(check.available) });
      });
    });
  }

  function openSettings(code) {
    return shell.openExternal(settingsUrls[code] || settingsUrls['microphone-denied']);
  }

  function register(ipcMain) {
    ipcMain.handle('speech:available', () => available());
    ipcMain.handle('speech:start', (event, id, terms, options) => start(event.sender, id, terms, options));
    ipcMain.handle('speech:status', (_event, locale) => status(locale));
    ipcMain.handle('speech:stop', () => stop());
    ipcMain.handle('speech:cancel', () => cancel());
    ipcMain.handle('speech:open-settings', (_, code) => openSettings(String(code || '')));
  }

  return { available, start, stop, cancel, status, openSettings, register, dispose: cancel };
}

module.exports = { createSpeechService, defaultHelperPath };
