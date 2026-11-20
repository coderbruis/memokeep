const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fixture, materializeRecoveryFixture } = require('./storage-v3-fixture.cjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('storage v3 crash fixture binds exact old and new bytes, array order, deletions and index to the journal', () => {
  const { base, target, journal } = fixture;
  const before = JSON.parse(base['memokeep.json']);
  const after = JSON.parse(target['memokeep.json']);
  const manifest = JSON.parse(journal['manifest.json']);
  const marker = JSON.parse(journal.COMMIT);
  assert.equal(marker.manifestSha256, sha256(journal['manifest.json']));
  assert.equal(marker.commitId, manifest.commitId);
  assert.equal(manifest.commitId, after.lastCommitId);
  assert.equal(manifest.baseIndexSha256, sha256(base['memokeep.json']));
  assert.equal(manifest.targetIndexSha256, sha256(target['memokeep.json']));
  assert.equal(journal['base-index.json'], base['memokeep.json']);
  assert.equal(journal['target-index.json'], target['memokeep.json']);
  assert.equal(before.workspaceId, after.workspaceId);
  assert.equal(after.generation, before.generation + 1);
  assert.equal(manifest.baseGeneration, before.generation);
  assert.equal(manifest.targetGeneration, after.generation);

  for (const [index, files] of [[before, base], [after, target]]) {
    assert.deepEqual(Object.keys(index.files).sort(), Object.keys(files).filter(path => path !== 'memokeep.json').sort());
    for (const [path, meta] of Object.entries(index.files)) {
      assert.equal(meta.sha256, sha256(files[path]), path);
      assert.equal(meta.size, Buffer.byteLength(files[path]), path);
      if (meta.kind === 'jsonl') assert.ok(files[path].endsWith('\n'), path);
    }
  }
  const changes = new Set(Object.keys({ ...before.files, ...after.files }).filter(path => base[path] !== target[path]));
  assert.equal(manifest.changes.length, changes.size);
  for (const { path, before: oldFile, after: newFile } of manifest.changes) {
    assert.ok(changes.delete(path), path);
    assert.deepEqual(oldFile, before.files[path] ?? null);
    assert.deepEqual(newFile, after.files[path] ?? null);
    assert.equal(journal[`payload/${path}`], target[path]);
  }
  const ids = (index, files, name) => index.collections[name].order.map(([path, row]) => {
    const values = index.files[path].kind === 'jsonl'
      ? files[path].trimEnd().split('\n').map(line => JSON.parse(line)) : [JSON.parse(files[path])];
    return values[row].id;
  });
  assert.deepEqual(ids(before, base, 'documents'), ['note-b', 'note-a']);
  assert.deepEqual(ids(after, target, 'documents'), ['note-c', 'note-a']);
  assert.deepEqual(ids(after, target, 'reviewRecords'), ['review-b', 'review-a']);
  assert.deepEqual(JSON.parse(target['profile/extra.json']).futureField, { value: null, tags: ['保留'] });
});

test('recovery fixture can reproduce interrupted renames, missing evidence and completed garbage states on disk', t => {
  const root = mkdtempSync(join(tmpdir(), 'memokeep-v3-fixture-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const cases = new Map(fixture.cases.map(scenario => [scenario.id, scenario]));
  assert.equal(cases.size, fixture.cases.length);
  const source = fixture.base['memokeep.json'];
  const [replacement, deletion] = JSON.parse(fixture.journal['manifest.json']).changes;
  const prefix = '.memokeep/staging/commit-1';
  for (const scenario of cases.values()) materializeRecoveryFixture(join(root, scenario.id), scenario);
  const partial = join(root, 'recovery-interrupted-after-replace-and-delete');
  assert.equal(readFileSync(join(partial, 'memokeep.json'), 'utf8'), source);
  assert.equal(readFileSync(join(partial, replacement.path), 'utf8'), fixture.target[replacement.path]);
  assert.equal(existsSync(join(partial, deletion.path)), false);
  assert.equal(existsSync(join(partial, prefix, 'payload', replacement.path)), false);
  assert.equal(existsSync(join(partial, prefix, 'COMMIT')), true);
  const corrupt = join(root, 'torn-marker', prefix, 'COMMIT');
  assert.throws(() => JSON.parse(readFileSync(corrupt, 'utf8')), SyntaxError);
  const missingBase = join(root, 'committed-base-index-missing');
  const missingMarker = join(root, 'marker-missing-after-index');
  for (const directory of [missingBase, missingMarker]) {
    assert.equal(readFileSync(join(directory, 'memokeep.json'), 'utf8'), fixture.target['memokeep.json']);
  }
  assert.equal(existsSync(join(missingBase, prefix, 'COMMIT')), true);
  assert.equal(existsSync(join(missingBase, prefix, 'base-index.json')), false);
  assert.equal(existsSync(join(missingMarker, prefix, 'COMMIT')), false);
  const retired = join(root, 'journal-retired-before-gc');
  assert.equal(existsSync(join(retired, prefix)), false);
  assert.equal(existsSync(join(retired, '.memokeep/garbage/commit-1/COMMIT')), true);
});
