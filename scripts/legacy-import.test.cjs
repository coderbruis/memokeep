const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validatePortableBackup } = require('./legacy-import/backup.cjs');

const cli = path.resolve(__dirname, '../apps/desktop/export-legacy-workspace.cjs');
const id = '814318fa-0a7e-4e78-baf0-ac458c8e2846';
const png = Buffer.from('89504e470d0a1a0a', 'hex');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memokeep-legacy-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = path.join(directory, 'old-workspace');
  await fs.mkdir(path.join(legacy, 'version-images'), { recursive: true });
  const data = JSON.stringify({ version: 2, documents: [{ id: 'note', content: '原文',
    metadata: { versions: [{ content: `![](memokeep-image://${id})` }] } }], cards: [] });
  await fs.writeFile(path.join(legacy, 'memokeep-data.json'), data);
  await fs.writeFile(path.join(legacy, 'version-images', `${id}.png`), png);
  return { directory, legacy, data };
}

test('legacy CLI exports historical attachments without modifying the old workspace', async t => {
  const { directory, legacy, data } = await fixture(t);
  const target = path.join(directory, 'portable.json');
  const result = spawnSync(process.execPath, [cli, legacy, target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const backup = validatePortableBackup(JSON.parse(await fs.readFile(target, 'utf8')));
  assert.equal(backup.media.length, 1);
  assert.deepEqual(backup.media[0].bytes, png);
  assert.equal(backup.data.documents[0].content, '原文');
  assert.equal(await fs.readFile(path.join(legacy, 'memokeep-data.json'), 'utf8'), data);
  assert.deepEqual(await fs.readFile(path.join(legacy, 'version-images', `${id}.png`)), png);
  const repeated = spawnSync(process.execPath, [cli, legacy, target], { encoding: 'utf8' });
  assert.notEqual(repeated.status, 0);
  assert.equal(validatePortableBackup(JSON.parse(await fs.readFile(target, 'utf8'))).media.length, 1);
});

test('a missing legacy attachment fails without publishing a partial backup', async t => {
  const { directory, legacy, data } = await fixture(t);
  await fs.unlink(path.join(legacy, 'version-images', `${id}.png`));
  const target = path.join(directory, 'missing.json');
  const result = spawnSync(process.execPath, [cli, legacy, target], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /完整备份未导出/);
  await assert.rejects(fs.access(target));
  assert.equal(await fs.readFile(path.join(legacy, 'memokeep-data.json'), 'utf8'), data);
});
