const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { stageEdition, copyDependencies } = require('./build-edition.cjs');
const { verifySource, requiredFiles } = require('./verify-source.cjs');
const { verifyEditionArchive } = require('./verify-edition.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memokeep-public-boundaries-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;

function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
function fixture() {
  const root = path.join(temporary, 'source-' + sequence++);
  for (const file of requiredFiles) write(root, file, file.endsWith('.html') ? '<!doctype html><title>MemoKeep</title>' : '');
  for (const edition of ['current', 'community']) {
    write(root, `modules/editions/${edition}/main.cjs`, 'module.exports = { features: [] };');
    write(root, `modules/editions/${edition}/plugins.js`, 'module.exports = [];');
  }
  write(root, 'package.json', JSON.stringify({ name: 'memokeep', version: '1.0.0', main: 'electron/main.cjs',
    scripts: { start: 'electron .' }, build: {}, devDependencies: { electron: '*' }, dependencies: {} }));
  write(root, 'native/speech/MemoKeepSpeech.swift', 'import Speech\nlet recognizer = SFSpeechRecognizer()\n');
  return root;
}
function stage(root) { return stageEdition('community', path.join(temporary, 'stage-' + sequence++), root); }

test('an independent public source stages and produces a verifiable archive', async () => {
  const source = fixture();
  write(source, 'electron/main.cjs', "const schema = { freeReviews: [] }; const capability = 'review.freeSpeak';\n");
  write(source, 'node_modules/first/package.json', JSON.stringify({ name: 'first', version: '1.0.0', dependencies: { second: '1.0.0' } }));
  write(source, 'node_modules/second/package.json', JSON.stringify({ name: 'second', version: '1.0.0' }));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  manifest.dependencies = { first: '1.0.0' };
  write(source, 'package.json', JSON.stringify(manifest));
  assert.ok(verifySource(source).files > 0);
  const staged = stage(source);
  assert.equal(fs.readFileSync(path.join(staged, '.memokeep-edition-stage'), 'utf8'), 'community');
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, 'node_modules/second/package.json'))).version, '1.0.0');
  assert.ok(!fs.existsSync(path.join(staged, 'native')));
  const archive = path.join(temporary, 'community.asar');
  await asar.createPackage(staged, archive);
  assert.equal(verifyEditionArchive(archive).edition, 'community');
  assert.equal(stageEdition('community', staged, source), staged, 'A marked stage can be rebuilt');
});

test('private directories, bridges, and speech implementations are rejected before copying', () => {
  for (const [file, contents] of [
    ['modules/features/free-review/service.cjs', 'module.exports = {};'],
    ['modules/editions/pro/main.cjs', 'module.exports = {};'],
    ['web/shell/free-review.js', 'function renderFreeReview() {}'],
    ['electron/preload.cjs', "ipcRenderer.invoke('freeReview:finish-active');"],
    ['electron/main.cjs', "ipcMain.handle('speech:pause', () => {});"],
    ['modules/content/diagrams/sequence-model.js', 'function createMermaidSequenceDrag() {}'],
    ['modules/content/diagrams/canvas-model.js', 'function mermaidCanvasResizeBox() {}'],
    ['web/leaked-controls.js', 'const markup = "<circle class=mermaid-sequence-endpoint />";'],
    ['native/speech/MemoKeepSpeech.swift', 'let detailed = arguments.contains("--detail")'],
    ['native/speech/MemoKeepSpeech.swift', 'let pitchValues: [Double] = []'],
    ['yes', 'credential-placeholder'], ['yes.pub', 'credential-placeholder']
  ]) {
    const source = fixture();
    write(source, file, contents);
    const destination = path.join(temporary, 'blocked-stage-' + sequence++);
    assert.throws(() => stageEdition('community', destination, source), /Private|Detailed|Credential/);
    assert.ok(!fs.existsSync(destination), 'Source rejection must happen before writing the stage');
  }
});

test('a leak added after staging is rejected from the actual archive', async () => {
  for (const [file, contents] of [
    ['modules/features/analytics/statistics.js', 'function privateAnalytics() {}'],
    ['modules/content/diagrams/sequence-controls.js', 'function positionMermaidSequenceRouteHandles() {}'],
    ['electron/preload.cjs', "ipcRenderer.invoke('speech:resume');"]
  ]) {
    const staged = stage(fixture());
    write(staged, file, contents);
    const archive = path.join(temporary, 'leaked-' + sequence++ + '.asar');
    await asar.createPackage(staged, archive);
    assert.throws(() => verifyEditionArchive(archive), /Private/);
  }
  const staged = stage(fixture());
  fs.unlinkSync(path.join(staged, 'modules/content/editor/image-format.js'));
  const archive = path.join(temporary, 'incomplete.asar');
  await asar.createPackage(staged, archive);
  assert.throws(() => verifyEditionArchive(archive), /Missing.*image-format/);
  assert.throws(() => verifyEditionArchive(archive, 'pro'), /Only the community edition/);
});

test('staging protects unrelated destinations and rejects symlinked source', () => {
  const source = fixture();
  assert.throws(() => stageEdition('pro', undefined, source), /Unknown public edition/);
  assert.throws(() => stageEdition('community', source, source), /source checkout/);
  const destination = path.join(temporary, 'unrelated');
  fs.mkdirSync(destination);
  write(destination, 'keep.txt', 'retain');
  assert.throws(() => stageEdition('community', destination, source), /Not an edition staging directory/);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'retain');
  fs.symlinkSync(path.join(source, 'web/index.html'), path.join(source, 'web/linked.html'));
  assert.throws(() => verifySource(source), /Unexpected source symlink/);
});

test('dependency copying accepts an explicit independent dependency root', () => {
  const source = fixture();
  write(source, 'node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', version: '7.1.0' }));
  const staged = path.join(temporary, 'dependencies');
  copyDependencies(staged, { 'fixture-dependency': '*' }, source);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, 'node_modules/fixture-dependency/package.json'))).version, '7.1.0');
});
