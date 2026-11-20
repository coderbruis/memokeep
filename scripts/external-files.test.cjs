const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(rows, options = {}) {
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/shell/notebooks.js'), 'utf8'), context);
  const data = { documents: [], knowledgeBases: options.noLibrary ? [] : [{ id: 'library' }] };
  const pending = [...rows], acknowledged = [], released = [], toasts = [], opened = [], previews = [];
  let failAck = options.failAckOnce;
  const desktop = {
    takeOpenedNoteFiles: async () => structuredClone(pending),
    acknowledgeOpenedNoteFile: async id => {
      if (failAck) { failAck = false; throw new Error('isolated interrupted acknowledgement'); }
      acknowledged.push(id);
      const index = pending.findIndex(row => row.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    releaseOpenedNoteFile: async token => { released.push(token); },
  };
  const state = { persistence: { data }, knowledge: { selectedLibraryId: 'library', collapsedLibraryIds: new Set() } };
  const actions = {
    availableDocumentTitle: name => name,
    markdownToRichHtml: content => '<p>' + content + '</p>',
    saveCollapsedLibraryIds() {}, openMarkdownNoteEditor() {},
    documentById: id => data.documents.find(row => row.id === id),
    showToast: text => toasts.push(text), openLibraryDialog: () => opened.push('library-dialog'),
    openWorkspaceNote: async id => { opened.push(id); return !options.blocked; },
    enqueueNativeFilePreviews: async files => { previews.push(files); return !options.previewBusy; },
  };
  const env = { TextEncoder, MemoKeepNoteFiles: { types: { md: { defaultTitle: '笔记' }, txt: { defaultTitle: '文本' } } },
    application: { state: { knowledge: { libraryById: id => data.knowledgeBases.find(row => row.id === id) } },
      editor: { session: { leaveActiveNoteEditor: options.leave || (async () => !options.blocked) } },
      persistence: { save: async () => { if (options.saveFailure) throw new Error('isolated disk full'); await options.save?.(); } } } };
  const methods = context.MemoKeepShell.createNotebooks({ state, config: { desktop, uid: () => 'generated' }, actions, env });
  return { ...methods, data, pending, acknowledged, released, toasts, opened, previews };
}

const file = { id: 'queue-event', name: '中文 空格.md', content: '# 本机文件', token: 'opaque-grant', origin: 'system' };

test('system opened file keeps the existing automatic library import and confirms only after save', async () => {
  const current = fixture([file]);
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
  assert.equal(current.data.documents[0].id, file.id);
  assert.equal(current.data.documents[0].content, file.content);
  assert.equal(current.data.documents[0].sourceFileName, file.name);
  assert.deepEqual(current.acknowledged, [file.id]);
  assert.deepEqual(current.released, [file.token]);
});

test('an interrupted acknowledgement retries the stable imported note instead of duplicating edited content', async () => {
  const current = fixture([file], { failAckOnce: true });
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
  current.data.documents[0].content = '# 后续修改';
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
  assert.equal(current.data.documents[0].content, '# 后续修改');
  assert.deepEqual(current.opened, [file.id]);
  assert.deepEqual(current.acknowledged, [file.id]);
});

test('unsaved editor refusal and persistence failure leave the durable file queue unconfirmed', async () => {
  for (const options of [{ blocked: true }, { saveFailure: true }]) {
    const current = fixture([file], options);
    await current.openExternalNoteFiles();
    assert.equal(current.data.documents.length, 0);
    assert.equal(current.pending.length, 1);
    assert.deepEqual(current.acknowledged, []);
    assert.deepEqual(current.released, []);
  }
});

test('creating the first library can retry the same queued file without losing it', async () => {
  const current = fixture([file], { noLibrary: true });
  await current.openExternalNoteFiles();
  assert.deepEqual(current.opened, ['library-dialog']);
  assert.equal(current.pending.length, 1);
  current.data.knowledgeBases.push({ id: 'library' });
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
  assert.equal(current.pending.length, 0);
});

test('native Drop files enter preview without automatic import or premature acknowledgement', async () => {
  const current = fixture([{ ...file, origin: 'drop' }], { previewBusy: true });
  await current.openExternalNoteFiles();
  assert.equal(current.previews.length, 1);
  assert.equal(current.previews[0][0].token, file.token);
  assert.equal(current.data.documents.length, 0);
  assert.equal(current.pending.length, 1);
  assert.deepEqual(current.acknowledged, []);
});

test('after restart a committed Drop note is opened and acknowledged without replacing its edited text', async () => {
  for (const error of [undefined, '源文件已经不存在']) {
    const current = fixture([{ ...file, origin: 'drop', ...(error ? { error, content: null } : {}) }]);
    current.data.documents.push({ id: file.id, sourceFileName: file.name, content: '# 已提交且编辑后的正文',
      title: '保留的名称', metadata: { custom: '保留的扩展' } });
    const before = JSON.stringify(current.data.documents);
    await current.openExternalNoteFiles();
    await current.openExternalNoteFiles();
    assert.equal(JSON.stringify(current.data.documents), before);
    assert.deepEqual(current.opened, [file.id]);
    assert.deepEqual(current.acknowledged, [file.id]);
    assert.deepEqual(current.released, [file.token]);
    assert.equal(current.previews.length, 0);
    assert.equal(current.pending.length, 0);
  }
});

test('one failed file is reported and acknowledged without blocking the next valid file', async () => {
  const current = fixture([{ id: 'invalid', name: '坏文件.txt', error: '文件不是有效的 UTF-8 文本' }, file]);
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
  assert.match(current.toasts[0], /UTF-8/);
  assert.deepEqual(current.acknowledged, ['invalid', file.id]);
});

test('concurrent OS and focus hints ask the dirty editor once; a later user event can retry', async () => {
  let resolveLeave, leaveCalls = 0, first = true;
  const choice = new Promise(resolve => { resolveLeave = resolve; });
  const current = fixture([file], { leave: async () => {
    leaveCalls++;
    return first ? choice : true;
  } });
  const osEvent = current.openExternalNoteFiles();
  await new Promise(resolve => setImmediate(resolve));
  const focusEvent = current.openExternalNoteFiles();
  first = false;
  resolveLeave(false);
  await Promise.all([osEvent, focusEvent]);
  assert.equal(leaveCalls, 1);
  assert.equal(current.pending.length, 1);
  assert.equal(current.data.documents.length, 0);
  await current.openExternalNoteFiles();
  assert.equal(leaveCalls, 2);
  assert.equal(current.data.documents.length, 1);
  assert.equal(current.pending.length, 0);
});

test('concurrent hints do not reopen a missing-library dialog until a later action', async () => {
  const current = fixture([file], { noLibrary: true });
  await Promise.all([current.openExternalNoteFiles(), current.openExternalNoteFiles()]);
  assert.deepEqual(current.opened, ['library-dialog']);
  assert.equal(current.pending.length, 1);
  current.data.knowledgeBases.push({ id: 'library' });
  await current.openExternalNoteFiles();
  assert.equal(current.data.documents.length, 1);
});

test('successful processing drains a new batch that arrived while the first save was in flight', async () => {
  let finishSave, first = true;
  const saved = new Promise(resolve => { finishSave = resolve; });
  const current = fixture([file], { save: async () => { if (first) await saved; } });
  const initial = current.openExternalNoteFiles();
  await new Promise(resolve => setImmediate(resolve));
  current.pending.push({ ...file, id: 'next-event', name: '后续文件.txt', token: 'next-grant' });
  const next = current.openExternalNoteFiles();
  first = false;
  finishSave();
  await Promise.all([initial, next]);
  assert.equal(current.data.documents.length, 2);
  assert.deepEqual(current.acknowledged, ['queue-event', 'next-event']);
  assert.equal(current.pending.length, 0);
});
