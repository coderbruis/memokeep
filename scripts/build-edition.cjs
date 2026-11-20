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
  for (const directory of ['web', 'modules/core', 'modules/content', 'modules/editions/current', 'modules/editions/community']) {
    copyDirectory(path.join(sourceRoot, directory), path.join(stage, directory), name => !/\.(?:cjs|swift|java)$/.test(name));
  }
  return stage;
}

module.exports = { stageEdition, copyDirectory };
