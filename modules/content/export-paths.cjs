const path = require('node:path');
const { isText: isPlainTextDocument } = require('../../web/note-file-types.js');
const { isRichTextNote } = require('../../electron/document-export.cjs');

function safeFileName(value, fallback) {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '').trim();
  return cleaned || fallback;
}

function knowledgeDocumentExtension(document) {
  if (isPlainTextDocument(document)) return '.txt';
  if (isRichTextNote(document)) return '.md';
  const sourceExtension = path.extname(document.sourceFileName || '').toLowerCase();
  if (['.md', '.markdown', '.csv', '.tsv', '.txt'].includes(sourceExtension)) return sourceExtension;
  return document.sourceType === 'table' ? '.csv' : '.md';
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}


module.exports = { safeFileName, knowledgeDocumentExtension, isPathInside };
