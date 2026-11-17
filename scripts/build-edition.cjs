const fs = require('node:fs');
const path = require('node:path');
const { verifySource } = require('./verify-source.cjs');
const root = path.resolve(__dirname, '..');

function copyDirectory(source, target, accept = () => true) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!accept(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${source}/${entry.name}`);
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to, accept);
    else fs.copyFileSync(from, to);
  }
}

function copyDependencies(stage, dependencies, dependencyRoot = root) {
  const copied = new Set();
  function copy(name, from) {
    let directory = from, source;
    while (true) {
      const candidate = path.join(directory, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) { source = candidate; break; }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Missing dependency: ${name}`);
      directory = parent;
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (copied.has(name)) {
      const existing = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', name, 'package.json'), 'utf8'));
      if (existing.version !== metadata.version) throw new Error(`Conflicting dependency versions: ${name}`);
      return;
    }
    copied.add(name);
    copyDirectory(source, path.join(stage, 'node_modules', name));
    for (const dependency of Object.keys(metadata.dependencies || {})) copy(dependency, source);
  }
  for (const name of Object.keys(dependencies)) copy(name, dependencyRoot);
}

function stageEdition(edition = 'community', destination, sourceRoot = root) {
  if (edition !== 'community') throw new Error(`Unknown public edition: ${edition}`);
  sourceRoot = path.resolve(sourceRoot);
  verifySource(sourceRoot);
  const stage = path.resolve(destination || path.join(sourceRoot, 'dist', 'editions', edition));
  const relative = path.relative(sourceRoot, stage);
  const insideCheckout = relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  if (stage === sourceRoot || sourceRoot.startsWith(stage + path.sep) || (insideCheckout && !relative.startsWith('dist' + path.sep))) throw new Error('Cannot stage over a source checkout');
  const marker = path.join(stage, '.memokeep-edition-stage');
  if (fs.existsSync(stage)) {
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== edition) throw new Error(`Not an edition staging directory: ${stage}`);
    fs.rmSync(stage, { recursive: true });
  }
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(marker, edition);
  for (const directory of ['electron', 'web', 'modules/core', 'modules/content', 'modules/editions/current', 'modules/editions/community']) {
    copyDirectory(path.join(sourceRoot, directory), path.join(stage, directory));
  }
  const original = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const { scripts, build, devDependencies, workspaces, ...manifest } = original;
  manifest.name = 'memokeep-community';
  manifest.productName = 'MemoKeep Community';
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  copyDependencies(stage, manifest.dependencies || {}, sourceRoot);
  return stage;
}

async function main() {
  const [edition = 'community', action = 'stage', destination] = process.argv.slice(2);
  if (!['stage', 'dir', 'dmg'].includes(action)) throw new Error(`Unknown build action: ${action}`);
  const stage = stageEdition(edition, destination);
  console.log(`${edition} staged: ${stage}`);
  if (action === 'stage') return;
  const speechHelper = require('./build-speech-helper.cjs').buildSpeechHelper();
  const { build, Platform } = require('electron-builder');
  const original = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build || {};
  await build({ projectDir: root, targets: Platform.MAC.createTarget(action), config: {
    ...original,
    appId: 'com.memokeep.community',
    productName: 'MemoKeep Community',
    artifactName: 'MemoKeep-Community-${version}-${arch}.${ext}',
    files: ['electron/**/*', 'modules/**/*', 'web/**/*', 'package.json'],
    dmg: { ...original.dmg, title: 'MemoKeep Community ${version}' },
    directories: { app: stage, output: path.join(root, 'dist', edition), buildResources: path.join(root, 'build') },
    mac: { ...original.mac, extendInfo: { ...original.mac?.extendInfo,
      NSMicrophoneUsageDescription: '复习时用语音说出答案。',
      NSSpeechRecognitionUsageDescription: '把你说的答案转成文字，和参考答案对照。' } },
    extraResources: speechHelper ? [{ from: speechHelper, to: 'memokeep-speech' }] : [],
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
    afterPack: async context => {
      const archive = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources', 'app.asar');
      console.log(require('./verify-edition.cjs').verifyEditionArchive(archive, edition));
    }
  } });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { stageEdition, copyDirectory, copyDependencies };
