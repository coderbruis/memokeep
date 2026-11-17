const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('helper builds select explicit sources and cannot reuse a different source edition from the same output directory', t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memokeep-helper-build-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const native = path.join(sourceRoot, 'native', 'speech');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'MemoKeepSpeech.swift'), '// base helper');
  fs.writeFileSync(path.join(native, 'Info.plist'), '<plist></plist>');
  const alternate = path.join(sourceRoot, 'alternate.swift');
  fs.writeFileSync(alternate, '// alternate helper');
  const calls = [];
  const filename = path.join(__dirname, 'build-speech-helper.cjs');
  const module = { exports: {} };
  const mockedRequire = id => id === 'node:child_process' ? {
    execFileSync(command, args) {
      calls.push({ command, args });
      fs.writeFileSync(args[args.indexOf('-o') + 1], fs.readFileSync(args[args.indexOf('-o') - 1]));
    }
  } : require(id);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: mockedRequire, __filename: filename, __dirname,
    process: { platform: 'darwin', arch: 'arm64' }
  }, { filename });
  const { buildSpeechHelper } = module.exports;
  const outputDirectory = path.join(sourceRoot, 'selected-output');
  const basic = buildSpeechHelper({ sourceRoot, outputDirectory });
  assert.equal(basic, path.join(outputDirectory, 'memokeep-speech'));
  assert.equal(fs.readFileSync(basic, 'utf8'), '// base helper');
  assert.equal(buildSpeechHelper({ sourceRoot, outputDirectory }), basic);
  assert.equal(calls.length, 1, 'Unchanged input uses the cached executable');
  buildSpeechHelper({ sourceRoot, sourceFile: alternate, outputDirectory });
  assert.equal(calls.length, 2, 'Selecting another source invalidates a newer existing executable');
  assert.equal(fs.readFileSync(basic, 'utf8'), '// alternate helper');
  buildSpeechHelper({ sourceRoot, outputDirectory });
  assert.equal(calls.length, 3, 'Switching back restores the original helper');
  assert.equal(fs.readFileSync(basic, 'utf8'), '// base helper');
  buildSpeechHelper({ sourceRoot, outputDirectory, force: true });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].command, 'swiftc');
  assert.ok(calls[0].args.includes(path.join(native, 'Info.plist')), 'Selected source root supplies the usage declarations');
});
