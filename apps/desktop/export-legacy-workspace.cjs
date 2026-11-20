const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPortableBackup, validatePortableBackup } = require('../../scripts/legacy-import/backup.cjs');
const { readNoteImage } = require('../../scripts/legacy-import/note-images.cjs');

async function run() {
  const [directory, destination] = process.argv.slice(2);
  if (!directory || !destination || process.argv.length !== 4) {
    throw new Error('用法：node export-legacy-workspace.cjs <旧工作空间目录> <新备份 JSON>');
  }
  const source = path.join(directory, 'memokeep-data.json');
  const snapshot = await fs.readFile(source);
  const data = JSON.parse(snapshot);
  const imageRoot = data.settings?.knowledgeStoragePath || directory;
  const backup = await createPortableBackup(data, async id =>
    await readNoteImage(imageRoot, id)
    || await readNoteImage(directory, id, { directoryName: 'version-images' })
    || await readNoteImage(directory, id, { directoryName: 'note-images' }));
  const { summary } = validatePortableBackup(backup);
  if (!(await fs.readFile(source)).equals(snapshot)) {
    throw new Error('源工作空间在导出时发生了更改，请重新导出。');
  }

  const temporary = path.join(path.dirname(destination), `.memokeep-backup-${randomUUID()}.tmp`);
  const output = await fs.open(temporary, 'wx', 0o600);
  try {
    await output.writeFile(JSON.stringify(backup));
    await output.sync();
    await fs.link(temporary, destination);
  } finally {
    await output.close();
    await fs.rm(temporary, { force: true });
  }
  console.log(JSON.stringify(summary));
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
