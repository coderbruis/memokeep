// Materializes a synthetic crash state. Recovery belongs to the storage adapter under test.
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const fixture = require('./fixtures/storage-v3/recovery.json');

function materializeRecoveryFixture(root, scenario) {
  const { disk } = scenario;
  const files = { ...fixture.base };
  if (disk.index === 'target') Object.assign(files, fixture.target);
  const applied = disk.index === 'target' ? Object.keys(fixture.base) : disk.applyAfter || [];
  for (const path of applied) {
    if (Object.hasOwn(fixture.target, path)) files[path] = fixture.target[path];
    else delete files[path];
  }
  Object.assign(files, disk.fileOverrides);

  if (disk.journal !== 'none') {
    const marker = JSON.parse(fixture.journal.COMMIT);
    const prefix = `.memokeep/${disk.journal === 'active' ? 'staging' : 'garbage'}/${marker.commitId}`;
    const journal = { ...fixture.journal, ...disk.journalOverrides };
    for (const name of disk.omit || []) delete journal[name];
    for (const [name, value] of Object.entries(journal)) files[`${prefix}/${name}`] = value;
  }

  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value, { encoding: 'utf8', flag: 'wx' });
  }
  return { participant: disk.participant, expected: scenario.expected };
}

module.exports = { fixture, materializeRecoveryFixture };
