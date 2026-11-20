const path = require('node:path');
const fs = require('node:fs');
const { build } = require('esbuild');
const { stageEdition } = require('../../scripts/build-edition.cjs');
const { buildSpeechHelper } = require('../../scripts/build-speech-helper.cjs');

function stageSpeech(outputDirectory, name, sourceFile) {
  const triple = (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '-apple-darwin';
  return buildSpeechHelper({ outputDirectory, outputName: name + '-' + triple, sourceFile });
}

async function stageDesktopBridge(destination, { smokeTest = false } = {}) {
  const web = path.join(destination, 'web');
  await build({
    entryPoints: [path.join(__dirname, 'tauri-desktop.js')],
    bundle: true, format: 'iife', platform: 'browser', target: 'safari15',
    outfile: path.join(web, 'tauri-desktop.js'),
  });
  const index = path.join(web, 'index.html');
  const html = fs.readFileSync(index, 'utf8');
  if (!html.includes('</head>')) throw new Error('无法加载桌面宿主桥接');
  let staged = html.replace('</head>', '<script src="tauri-desktop.js"></script>\n</head>');
  if (smokeTest) {
    await build({ entryPoints: [path.join(__dirname, 'smoke.js')], bundle: true, format: 'iife',
      platform: 'browser', target: 'safari15', outfile: path.join(web, 'tauri-smoke.js') });
    staged = staged.replace('</body>', '<script src="tauri-smoke.js"></script>\n</body>');
  }
  fs.writeFileSync(index, staged);
}

if (require.main === module) {
  (async () => {
    const destination = stageEdition('community', path.resolve(__dirname, '../../dist/tauri-community'));
    await stageDesktopBridge(destination, { smokeTest: process.argv.includes('--smoke-test') });
    stageSpeech(path.resolve(__dirname, '../../dist/tauri-native'), 'memokeep-speech-basic');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { stageDesktopBridge, stageSpeech };
