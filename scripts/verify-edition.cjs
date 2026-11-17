const assert = require('node:assert/strict');
const path = require('node:path');
const asar = require('@electron/asar');
const { assertPublicFile, requiredFiles } = require('./verify-source.cjs');

function verifyEditionArchive(archive, edition = 'community') {
  assert.equal(edition, 'community', 'Only the community edition is built from this repository');
  const entries = asar.listPackage(archive).map(file => file.replace(/^\//, ''));
  const files = entries.filter(file => !asar.statFile(archive, file).files);
  for (const required of requiredFiles) assert.ok(files.includes(required), `Missing ${required}`);
  for (const file of entries) assertPublicFile(file);
  for (const file of files.filter(file => /\.(?:js|cjs|html|css|json|swift)$/.test(file) && !file.startsWith('node_modules/') && !file.startsWith('web/vendor/'))) {
    assertPublicFile(file, asar.extractFile(archive, file).toString());
  }
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(manifest.name, 'memokeep-community');
  assert.equal(manifest.main, 'electron/main.cjs');
  assert.equal(manifest.scripts, undefined, 'Build scripts must not be shipped');
  assert.equal(manifest.devDependencies, undefined, 'Development dependencies must not be shipped');
  return { edition, entries: entries.length, archive: path.resolve(archive) };
}

if (require.main === module) {
  try { console.log(verifyEditionArchive(process.argv[2], process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyEditionArchive };
