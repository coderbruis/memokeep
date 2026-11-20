const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.join(__dirname, '../apps/desktop');
const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json'), 'utf8'));

test('desktop package and lock declare the same valid project version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('desktop lock contains complete versions and all Tauri CLI optional platforms', () => {
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.link) continue;
    assert.equal(typeof entry.version, 'string', `${name} must declare its resolved version`);
    assert.ok(entry.version.length > 0, `${name} cannot have an empty version`);
  }
  const cli = lock.packages['node_modules/@tauri-apps/cli'];
  for (const [name, version] of Object.entries(cli.optionalDependencies)) {
    const candidates = Object.entries(lock.packages)
      .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
    const entry = candidates.find(([, candidate]) => candidate.version === version)?.[1];
    assert.ok(entry, `${name}@${version} must resolve even on another platform`);
    assert.ok(entry.resolved && entry.integrity, `${name} must include its archive and integrity`);
    assert.equal(entry.optional, true);
  }
});
