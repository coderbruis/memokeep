(function (host) {
  const types = Object.freeze({
    md: Object.freeze({ id: 'md', label: 'Markdown', extension: '.md', short: 'MD', defaultTitle: '未命名笔记', description: '支持标题、列表与表格' }),
    txt: Object.freeze({ id: 'txt', label: '纯文本', extension: '.txt', short: 'TXT', defaultTitle: '未命名文本', description: '按原样记录文字、空格与换行' })
  });
  const isText = doc => doc?.metadata?.fileType === 'txt' || doc?.metadata?.editorMode === 'text' || doc?.sourceType === 'manual-text'
    || (/\.txt$/i.test(doc?.sourceFileName || '') && doc?.metadata?.editorMode !== 'note');
  function of(doc) {
    if (types[doc?.metadata?.fileType]) return types[doc.metadata.fileType];
    if (isText(doc)) return types.txt;
    if (doc?.metadata?.editorMode === 'note') return types.md;
    const extension = /\.[a-z0-9]+$/i.exec(doc?.sourceFileName || '')?.[0].toLowerCase();
    if (extension && !['.md', '.markdown'].includes(extension)) {
      const short = extension.slice(1).toUpperCase();
      return { id: extension.slice(1), extension, label: short, short };
    }
    if (doc?.sourceType === 'table') return { id: 'csv', extension: '.csv', label: 'CSV', short: 'CSV' };
    return types.md;
  }
  const api = { types, isText, of };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.MemoKeepNoteFiles = api;
})(globalThis);

function noteFileIcon(doc, className = '') {
  const type = MemoKeepNoteFiles.of(doc);
  return `<svg class="note-file-icon ${className}" viewBox="0 0 20 24" aria-hidden="true"><path d="M4 2h8l5 5v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm8 0v5h5"/><text x="10" y="17" text-anchor="middle">${applicationShell.actions.escapeHtml(type.short.slice(0, 4))}</text></svg>`;
}

function noteFileExtension(doc) {
  // Markdown 是默认类型，不显示 .md；其他类型（.txt、.csv）保留后缀以便区分。
  if (MemoKeepNoteFiles.of(doc).id === 'md') return '';
  return `<span class="note-file-extension">${applicationShell.actions.escapeHtml(MemoKeepNoteFiles.of(doc).extension)}</span>`;
}
