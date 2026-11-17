// 从系统打开的笔记文件（访达「打开方式」、拖到程序坞图标、命令行参数）。
// 主进程只负责排队和读文件；界面准备好后来取，由它决定是打开已有笔记还是导入。
const SUPPORTED = /\.(md|markdown|txt)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

function createOpenFiles({ fs, path, storageRoot = async () => '', notify = () => {} }) {
  const pending = [];
  function add(filePath, cwd = '') {
    if (typeof filePath !== 'string' || !SUPPORTED.test(filePath)) return false;
    const resolved = path.resolve(cwd || '.', filePath);
    if (!pending.includes(resolved)) pending.push(resolved);
    notify();
    return true;
  }
  // 命令行里除了文件还有开关和程序自己的路径，只认支持的扩展名。
  function addFromArgv(argv = [], cwd = '') {
    let added = 0;
    for (const value of argv) if (typeof value === 'string' && !value.startsWith('-') && add(value, cwd)) added++;
    return added;
  }
  async function take() {
    const paths = pending.splice(0);
    const root = paths.length ? await Promise.resolve(storageRoot()).catch(() => '') : '';
    const files = [];
    for (const filePath of paths) {
      const name = path.basename(filePath);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_BYTES) { files.push({ name, error: '文件超过 5 MB，没有打开' }); continue; }
        const content = (await fs.readFile(filePath, 'utf8')).replace(/^﻿/, '');
        // MemoKeep 自己写到存储文件夹里的笔记，文件名以笔记 id 的前 8 位结尾：直接打开那篇，不重复导入。
        const relative = root ? path.relative(path.resolve(root), filePath) : '..';
        const inside = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
        const idPrefix = inside ? (name.match(/-([0-9a-f]{8})\.[^.]+$/i)?.[1] || '').toLowerCase() : '';
        files.push({ name, content, idPrefix });
      } catch (error) {
        files.push({ name, error: error.code === 'ENOENT' ? '文件不存在' : '文件读不出来' });
      }
    }
    return files;
  }
  return { add, addFromArgv, take, pendingCount: () => pending.length };
}

module.exports = { createOpenFiles, SUPPORTED_NOTE_FILE: SUPPORTED };
