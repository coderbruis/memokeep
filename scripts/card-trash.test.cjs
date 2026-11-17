const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createApplicationState } = require('../web/state/application-state.js');
const { createCardRuntime } = require('../web/application/card-runtime.js');
const { createCardTrashOperations } = require('../web/application/card-trash.js');
const { createCardBulkView } = require('../web/views/card-bulk.js');
function setup() {
  let data = { cards: [{ id: 'a', question: '问题', answer: '![图](memokeep-image://12345678-1234-4234-8234-123456789abc)', cardNotebookId: 'n', status: 'active', dueAt: 100, reviewCount: 5, lapseCount: 2, strength: 4, tags: ['tag'] }, { id: 'b', question: '其他', status: 'active' }],
    cardFolders: [{ id: 'f', name: '目录' }], cardNotebooks: [{ id: 'n', name: '笔记', folderId: 'f' }],
    cardDocuments: [], documents: [{ id: 'note', content: '原文', metadata: { editorMode: 'card' } }], items: [], trash: [], reviewRecords: [{ id: 'r', cardId: 'a', rating: 'good' }] };
  const state = createApplicationState({ read: () => data, replace: value => { data = value; } }), runtime = createCardRuntime();
  runtime.selectedCardIds = new Set(['a','b']);
  const control = { fail: false, writes: 0 }, events = [];
  const trash = createCardTrashOperations({ state, runtime, directory: require('../web/directory-tree.js'), domain: require('../web/domain/inline-cards.js'),
    transact: async change => { const candidate = structuredClone(state.read()); if (change(candidate) === false) return; control.writes++; if (control.fail) throw new Error('write failed'); state.replace(candidate); },
    hooks: { renderAll: () => events.push('all'), renderTrash: () => events.push('trash'), showCardUndo: (ids, count) => events.push(['undo', ids, count]) },
    helpers: { uid: () => 'entry', cardFolderId: card => Object.hasOwn(card, 'cardFolderId') ? card.cardFolderId : card.cardNotebookId === 'n' ? 'f' : null,
      documentById: id => state.read().documents.find(note => note.id === id),
      removeTrashedInlineRows: (_, candidate) => { candidate.documents[0].content = '已移除'; },
      initialInlineTagRows: () => [], updateInlineNoteRows() {} } });
  return { state, runtime, control, events, trash };
}
test('delete stores exact card/source/folder snapshots, keeps history and clears only deleted selections', async () => {
  const h = setup(), before = h.state.checkpoint(); await h.trash.trashCards(['a']);
  assert.deepEqual(h.state.read().trash[0].card, before.cards[0]);
  assert.deepEqual(h.state.read().trash[0].notebook, before.cardNotebooks[0]);
  assert.deepEqual(h.state.read().trash[0].folders, before.cardFolders);
  assert.deepEqual(h.state.read().reviewRecords, before.reviewRecords);
  assert.deepEqual([...h.runtime.selectedCardIds], ['b']); assert.deepEqual(h.events, ['all','trash',['undo',['entry'],1]]);
});
test('failed delete rolls back notes/cards/trash/history together and keeps selection for retry', async () => {
  const h = setup(), before = h.state.checkpoint(); h.control.fail = true;
  await assert.rejects(h.trash.trashCards(['a']), /write failed/);
  assert.deepEqual(h.state.read(), before); assert.deepEqual([...h.runtime.selectedCardIds], ['a','b']); assert.deepEqual(h.events, ['all']);
  h.control.fail = false; await h.trash.trashCards(['a']); assert.equal(h.state.read().trash.length, 1);
});
test('direct card restoration recreates the full directory ancestry without creating notebooks', async () => {
  const h = setup(); h.state.read().cardFolders = [{id:'parent',name:'父目录'}, {id:'child',name:'子目录',parentId:'parent'}];
  h.state.read().cards[0].cardFolderId = 'child'; h.state.read().cards[0].cardNotebookId = null;
  const before = h.state.checkpoint(); await h.trash.trashCards(['a']); h.state.read().cardFolders = [];
  assert.equal(await h.trash.restoreCardTrash(['entry']), 1);
  assert.deepEqual(h.state.read().cardFolders, before.cardFolders);
  assert.deepEqual(h.state.read().cards.find(card => card.id === 'a'), before.cards[0]);
  assert.deepEqual(h.state.read().cardNotebooks, before.cardNotebooks);
});
test('same-folder duplicate restoration retains the recoverable entry and existing progress', async () => {
  const h = setup(); h.state.read().cards[0].cardFolderId = 'f';
  await h.trash.trashCards(['a']); h.state.read().cards.push({id:'replacement',question:'问题',cardFolderId:'f',reviewCount:10});
  const before = h.state.checkpoint();
  assert.equal(await h.trash.restoreCardTrash(['entry']), 0);
  assert.deepEqual(h.state.read(), before);
});
test('restore failure keeps trash and retries with original scheduling, image references and hierarchy', async () => {
  const h = setup(), original = h.state.checkpoint(); await h.trash.trashCards(['a']);
  h.state.read().cardFolders = []; h.state.read().cardNotebooks = []; const before = h.state.checkpoint(); h.control.fail = true;
  await assert.rejects(h.trash.restoreCardTrash(['entry']), /write failed/); assert.deepEqual(h.state.read(), before);
  h.control.fail = false; assert.equal(await h.trash.restoreCardTrash(['entry']), 1);
  assert.deepEqual(h.state.read().cards.find(card => card.id === 'a'), original.cards[0]);
  assert.deepEqual(h.state.read().reviewRecords, original.reviewRecords); assert.deepEqual(h.state.read().cardFolders, original.cardFolders);
  assert.equal(h.state.read().trash.length, 0); assert.equal(await h.trash.restoreCardTrash(['entry']), 0);
});
test('inline duplicate restores no card and retains the recoverable trash entry', async () => {
  const h = setup(); await h.trash.trashCards(['a']);
  h.state.read().documents[0].content = '问题 -> 已存在';
  h.state.read().trash[0].inlineSource = { documentId: 'note', line: 0, row: { raw: '问题 -> 答案' }, item: { id: 'i' } };
  assert.equal(await h.trash.restoreCardTrash(['entry']), 0); assert.equal(h.state.read().trash.length, 1);
  assert.equal(h.state.read().cards.some(card => card.id === 'a'), false);
});
test('cancelled bulk delete leaves the shared selection and data untouched', async () => {
  const h = setup(), before = h.state.checkpoint();
  const bulk = createCardBulkView({ state: h.state, runtime: h.runtime, trash: h.trash, helpers: { showConfirmDialog: async () => false } });
  await bulk.deleteSelectedCards(); assert.deepEqual(h.state.read(), before); assert.equal(h.control.writes, 0); assert.equal(h.runtime.selectedCardIds.size, 2);
});
test('bulk/trash modules load without legacy globals and migrated entry points are absent', () => {
  const context = vm.createContext({}); const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  for (const file of ['application/card-trash.js','views/card-bulk.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'); vm.runInContext(source, context);
    assert.doesNotMatch(source, /\bapplication\./); assert.doesNotMatch(source, /\bdata\./);
    const index = html.indexOf(`src="${file}"`); assert.ok(index >= 0 && index < html.indexOf('src="bootstrap/composition.js"'));
  }
  const legacy = fs.readFileSync(path.join(__dirname, '../web/legacy/application.js'), 'utf8');
  for (const name of ['trashCards','restoreCardTrash','showCardUndo','deleteCardById','openMoveCardsDialog','moveSelectedCards','setSelectedCardsStatus','restartSelectedCardsForReview','deleteSelectedCards']) assert.doesNotMatch(legacy, new RegExp('function ' + name + '\\('));
});
