// 编译复习语音作答用的 macOS 语音识别辅助程序：native/speech → build/speech/memokeep-speech。
// Tauri 装配前编译，源码不变时复用产物。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'speech', 'memokeep-speech');

function buildSpeechHelper({ force = false, sourceRoot = root, sourceFile, outputDirectory, outputName = 'memokeep-speech' } = {}) {
  if (process.platform !== 'darwin') return null;
  const inputs = [path.resolve(sourceRoot, sourceFile || 'native/speech/MemoKeepSpeech.swift'), path.resolve(sourceRoot, 'native/speech/Info.plist')];
  const executable = path.join(path.resolve(sourceRoot, outputDirectory || 'build/speech'), outputName);
  const stamp = executable + '.build.sha256';
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`;
  // Switching source editions can leave an executable newer than both inputs.
  // Cache the source contents, not just their modification times.
  const fingerprint = createHash('sha256').update(target).update(fs.readFileSync(__filename));
  for (const file of inputs) fingerprint.update(fs.readFileSync(file));
  const signature = fingerprint.digest('hex');
  if (!force && fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === signature) return executable;
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const moduleCache = path.join(path.dirname(executable), 'module-cache');
  fs.mkdirSync(moduleCache, { recursive: true });
  // Info.plist 嵌进可执行文件，系统弹授权框时有用途说明。
  execFileSync('swiftc', ['-O', '-module-cache-path', moduleCache, '-target', target, inputs[0], '-o', executable,
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', inputs[1]], { stdio: 'inherit' });
  fs.writeFileSync(stamp, signature);
  return executable;
}
if (require.main === module) console.log(buildSpeechHelper({ force: process.argv.includes('--force') }));
module.exports = { buildSpeechHelper, speechHelperPath: output };
