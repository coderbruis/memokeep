// 用 MemoKeep 打开 .md / .txt：主进程排队、读文件、认出存储文件夹里自己的笔记。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOpenFiles } = require('../electron/open-files.cjs');

test('queues supported files once, reads them when taken, and recognises notes in the storage folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memokeep-open-files-'));
  const storage = path.join(dir, 'storage');
  await fs.mkdir(path.join(storage, '知识库', '面试'), { recursive: true });
  const outside = path.join(dir, '电商售后.md'), own = path.join(storage, '知识库', '面试', 'Agent核心概念-0E95C6A4.md');
  await fs.writeFile(outside, '﻿# 电商售后\n正文');
  await fs.writeFile(own, '# Agent');
  let notified = 0;
  const files = createOpenFiles({ fs, path, storageRoot: async () => storage, notify: () => { notified++; } });
  assert.equal(files.add(outside), true);
  assert.equal(files.add(outside), true, 'Opening the same file twice is fine');
  assert.equal(files.add(path.join(dir, 'photo.png')), false, 'Other file types are ignored');
  assert.equal(files.addFromArgv(['--flag', '.', own, path.join(dir, 'missing.txt')]), 2);
  assert.equal(files.pendingCount(), 3);
  assert.equal(notified, 4);
  assert.deepEqual(await files.take(), [
    { name: '电商售后.md', content: '# 电商售后\n正文', idPrefix: '' },
    { name: 'Agent核心概念-0E95C6A4.md', content: '# Agent', idPrefix: '0e95c6a4' },
    { name: 'missing.txt', error: '文件不存在' },
  ]);
  assert.deepEqual(await files.take(), [], 'Each file is delivered once');
});

test('a file that merely looks like a MemoKeep note outside the storage folder is imported, not matched by id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memokeep-open-files-'));
  const file = path.join(dir, '笔记-0e95c6a4.md');
  await fs.writeFile(file, 'x');
  const files = createOpenFiles({ fs, path, storageRoot: async () => path.join(dir, 'storage') });
  files.add(file);
  assert.equal((await files.take())[0].idPrefix, '');
});
