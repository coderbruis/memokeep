const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { validatePortableBackup } = require('../../scripts/legacy-import/backup.cjs');

const [binary, backupTool] = process.argv.slice(2);
if (!binary) throw new Error('请传入使用 smoke-test 特性构建的应用路径');

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 35_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}：退出状态 ${result.status ?? result.signal}`);
}

function migrateFixture(directory) {
  const legacy = path.join(directory, 'legacy');
  const historicalImages = path.join(legacy, 'version-images');
  fs.mkdirSync(historicalImages, { recursive: true });
  const imageId = '814318fa-0a7e-4e78-baf0-ac458c8e2846';
  const imagePath = path.join(historicalImages, `${imageId}.png`);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDeQAAAAASUVORK5CYII=', 'base64');
  const legacyData = path.join(legacy, 'memokeep-data.json');
  const snapshot = JSON.stringify({
    version: 2, cardOrganizationVersion: 1, knowledgeBases: [{ id: 'legacy-library', name: '旧知识库' }],
    documents: [{ id: 'legacy-migration-note', knowledgeBaseId: 'legacy-library', title: '旧笔记', content: '迁移保留 Markdown',
      metadata: { versions: [{ savedAt: '2026-11-18T18:00:00.000Z', content: `![](memokeep-image://${imageId})` }] } }], cards: [],
  });
  fs.writeFileSync(legacyData, snapshot);
  fs.writeFileSync(imagePath, bytes);
  const backup = path.join(directory, 'legacy-portable.json');
  run(process.execPath, [path.join(__dirname, 'export-legacy-workspace.cjs'), legacy, backup], '导出旧工作空间');
  run(backupTool, ['restore', backup, path.join(directory, 'workspace.sqlite3')], '导入隔离 Tauri 工作空间');
  assert.equal(fs.readFileSync(legacyData, 'utf8'), snapshot);
  assert.deepEqual(fs.readFileSync(imagePath), bytes);
}

function verifyRollback(directory) {
  const destination = path.join(directory, 'rollback-portable.json');
  run(backupTool, ['export', path.join(directory, 'workspace.sqlite3'), destination], '导出回退备份');
  const exported = validatePortableBackup(JSON.parse(fs.readFileSync(destination, 'utf8')));
  assert(exported.data.documents.some(note => note.id === 'isolated-smoke-note' && note.metadata.noteContent.includes('Tauri 保存成功')));
  assert(exported.data.reviewRecords.some(record => record.cardId === 'isolated-smoke-card'));
  assert.equal(exported.media.length, 1);
  console.log('rollback：旧版读取新工作区备份通过');
}

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memokeep-tauri-smoke-'));
try {
  fs.writeFileSync(path.join(dataDirectory, 'fixture.json'), JSON.stringify({
    version: 2, knowledgeBases: [], documents: [{ id: 'restore-smoke-note', title: '隔离恢复笔记' }], cards: [],
  }));
  if (backupTool) migrateFixture(dataDirectory);
  for (const phase of backupTool ? ['migration', 'write', 'reload'] : ['write', 'reload']) {
    run(binary, [], phase, {
      env: {
        ...process.env,
        MEMOKEEP_SMOKE_DATA_DIR: dataDirectory,
        MEMOKEEP_SMOKE_PHASE: phase,
      },
    });
    console.log(`${phase}：WebView 自测通过`);
  }
  if (backupTool) verifyRollback(dataDirectory);
} finally {
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}
