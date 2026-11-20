const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageEdition } = require('./build-edition.cjs');
const { verifySource, requiredFiles } = require('./verify-source.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memokeep-public-boundaries-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function write(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(temporary, 'source-'));
  for (const file of requiredFiles) write(root, file, file.endsWith('.html') ? '<!doctype html><title>MemoKeep</title>' : '');
  write(root, 'modules/editions/community/plugins.js', 'module.exports = [];');
  write(root, 'package.json', JSON.stringify({ name: 'memokeep-community', version: '1.0.0' }));
  write(root, 'native/speech/MemoKeepSpeech.swift', 'import Speech\nlet recognizer = SFSpeechRecognizer()\n');
  return root;
}

test('independent public source stages only browser assets and can rebuild a marked stage', () => {
  const source = fixture();
  assert.ok(verifySource(source).files > 0);
  const staged = stageEdition('community', undefined, source);
  assert.equal(fs.readFileSync(path.join(staged, '.memokeep-edition-stage'), 'utf8'), 'community');
  for (const relative of ['web/index.html', 'modules/editions/community/plugins.js', 'modules/content/editor/image-format.js']) {
    assert.ok(fs.existsSync(path.join(staged, relative)), relative);
  }
  for (const relative of ['native', 'apps', 'node_modules', 'modules/content/backup.cjs']) {
    assert.ok(!fs.existsSync(path.join(staged, relative)), relative);
  }
  assert.equal(stageEdition('community', staged, source), staged);
});

test('private directories, bridges, and speech implementations are rejected before copying', () => {
  for (const [file, contents] of [
    ['modules/features/free-review/service.cjs', 'module.exports = {};'],
    ['modules/editions/pro/bridge.js', 'module.exports = {};'],
    ['web/shell/free-review.js', 'function renderFreeReview() {}'],
    ['apps/desktop/tauri-desktop.js', "invoke('freeReview:finish-active');"],
    ['apps/desktop/tauri-desktop.js', "invoke('speech:pause');"],
    ['modules/content/diagrams/sequence-model.js', 'function createMermaidSequenceDrag() {}'],
    ['modules/content/diagrams/canvas-model.js', 'function mermaidCanvasResizeBox() {}'],
    ['web/leaked-controls.js', 'const markup = "<circle class=mermaid-sequence-endpoint />";'],
    ['native/speech/MemoKeepSpeech.swift', 'let detailed = arguments.contains("--detail")'],
    ['native/speech/MemoKeepSpeech.swift', 'let pitchValues: [Double] = []'],
    ['yes', 'credential-placeholder'], ['yes.pub', 'credential-placeholder']
  ]) {
    const source = fixture();
    write(source, file, contents);
    const destination = path.join(source, 'dist', 'blocked');
    assert.throws(() => stageEdition('community', destination, source), /Private|Detailed|Credential/);
    assert.ok(!fs.existsSync(destination), 'Source rejection must happen before writing the stage');
  }
});

test('missing assets are rejected before staging', () => {
  const source = fixture();
  fs.unlinkSync(path.join(source, 'modules/content/editor/image-format.js'));
  assert.throws(() => stageEdition('community', undefined, source), /Missing.*image-format/);
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
