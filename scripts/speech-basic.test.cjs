const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSpeechService } = require('../electron/speech.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null; child.killed = false;
  child.written = [];
  child.stdin.on('data', chunk => child.written.push(String(chunk).trim()));
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); };
  return child;
}
function fakeContents() { const sent = []; return { sent, isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }), once() {} }; }
function service({ status = 'granted', ask = true, platform = 'darwin', check = '{"type":"check","speech":3,"microphone":3,"available":true,"onDevice":true}' } = {}) {
  const children = [], opened = [];
  const speech = createSpeechService({ app: { isPackaged: false }, helperPath: __filename, platform,
    systemPreferences: { getMediaAccessStatus: () => status, askForMediaAccess: async () => ask },
    shell: { openExternal: url => opened.push(url) },
    spawnProcess: (file, args) => { const child = fakeChild(); child.args = args; children.push(child); return child; },
    execProcess: (file, args, options, callback) => { children.checkArgs = args; setImmediate(() => callback(check === null ? new Error('fail') : null, check || '')); } });
  return { speech, children, opened };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('forwards helper JSON lines to the window with the session id', async () => {
  const { speech, children } = service(), contents = fakeContents();
  assert.deepEqual(await speech.start(contents, 'voice-1'), { ok: true, session: 'voice-1' });
  assert.deepEqual(children[0].args, ['--locale', 'zh-CN']);
  await speech.start(contents, 'voice-2', ['Kafka', 'ISR', 42, ' ', 'x'.repeat(80)]);
  assert.deepEqual(children[1].args, ['--locale', 'zh-CN', '--terms', JSON.stringify(['Kafka', 'ISR', 'x'.repeat(60)])], 'Hint terms are cleaned and passed to the helper');
  speech.cancel(); await tick();
  children[0].stdout.write('{"type":"ready","onDevice":true}\n{"type":"partial","te');
  children[0].stdout.write('xt":"ISR 就是"}\nnot json\n');
  await tick();
  assert.deepEqual(contents.sent.map(item => item.payload), [{ type: 'ready', onDevice: true, session: 'voice-1' }, { type: 'partial', text: 'ISR 就是', session: 'voice-1' }]);
  assert.ok(contents.sent.every(item => item.channel === 'speech:event'));
});

test('stop asks the helper for a final result; cancel ends it', async () => {
  const { speech, children } = service(), contents = fakeContents();
  await speech.start(contents, 'a');
  assert.equal(speech.stop(), true);
  await tick();
  assert.deepEqual(children[0].written, ['stop']);
  assert.equal(speech.cancel(), true);
  await tick();
  assert.deepEqual(children[0].written, ['stop', 'cancel']);
  assert.equal(speech.stop(), false, 'Nothing to stop after cancel');
});

test('a new session cancels the previous one', async () => {
  const { speech, children } = service(), contents = fakeContents();
  await speech.start(contents, 'a');
  await speech.start(contents, 'b');
  await tick();
  assert.deepEqual(children[0].written, ['cancel']);
  assert.equal(children.length, 2);
});

test('helper exiting without a result reports an error, but not after cancel', async () => {
  const { speech, children } = service(), contents = fakeContents();
  await speech.start(contents, 'a');
  children[0].exitCode = 1; children[0].emit('exit', 1);
  assert.equal(contents.sent.at(-1).payload.code, 'exited');
  await speech.start(contents, 'b');
  speech.cancel();
  children[1].exitCode = 0; children[1].emit('exit', 0);
  assert.equal(contents.sent.filter(item => item.payload.session === 'b').length, 0);
});

test('microphone permission: denied stops early, not-determined asks', async () => {
  assert.equal((await service({ status: 'denied' }).speech.start(fakeContents(), 'a')).code, 'microphone-denied');
  assert.equal((await service({ status: 'not-determined', ask: false }).speech.start(fakeContents(), 'a')).code, 'microphone-denied');
  assert.equal((await service({ status: 'not-determined', ask: true }).speech.start(fakeContents(), 'a')).ok, true);
});

test('unsupported outside macOS; settings links go to the right privacy pane', async () => {
  const other = service({ platform: 'win32' });
  assert.equal(other.speech.available(), false);
  assert.equal((await other.speech.start(fakeContents(), 'a')).code, 'unsupported');
  const { speech, opened } = service();
  speech.openSettings('speech-denied'); speech.openSettings('microphone-denied');
  assert.match(opened[0], /Privacy_SpeechRecognition$/);
  assert.match(opened[1], /Privacy_Microphone$/);
});

test('language and on-device options reach the helper', async () => {
  const { speech, children } = service(), contents = fakeContents();
  await speech.start(contents, 'a', [], { locale: 'en-US', onDevice: false });
  assert.deepEqual(children[0].args, ['--locale', 'en-US', '--allow-server']);
  speech.cancel();
  await speech.start(contents, 'b', [], { locale: 'xx', onDevice: true });
  assert.deepEqual(children[1].args, ['--locale', 'zh-CN'], 'Unknown locales fall back; on-device is the default');
});

test('status reports permissions and on-device support for the settings page', async () => {
  const { speech, children } = service({ status: 'denied' });
  assert.deepEqual(await speech.status('zh-HK'), { supported: true, microphone: 'denied', speech: 'granted', onDevice: true, recognizer: true });
  assert.deepEqual(children.checkArgs, ['--check', '--locale', 'zh-HK']);
  assert.equal((await service({ check: null }).speech.status()).speech, 'unknown', 'A failing check does not throw');
  assert.equal((await service({ platform: 'win32' }).speech.status()).supported, false);
});
