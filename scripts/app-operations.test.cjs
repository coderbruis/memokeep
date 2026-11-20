const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createApplicationState } = require('../web/state/application-state.js');
const { createCardOperations } = require('../web/application/card-operations.js');
const { createMemoOperations } = require('../web/application/memo-operations.js');
const { createSettingsOperations } = require('../web/application/settings-operations.js');
const { createKnowledgeOperations } = require('../web/application/knowledge-operations.js');
const { duplicateCardQuestion } = require('../web/domain/inline-cards.js');
const timestamp = new Date('2026-10-17T10:00:00Z').getTime();
const iso = new Date(timestamp).toISOString();
function setup() {
  let data = { version: 2, knowledgeBases: [{ id: 'l1', name: 'first' }, { id: 'l2', name: 'second' }],
    documents: [{ id: 'note', knowledgeBaseId: 'l1', title: 'note', metadata: { versions: [{ content: 'history' }] } }],
    items: [{ id: 'item', documentId: 'note', knowledgeBaseId: 'l1' }, { id: 'other', documentId: 'other', knowledgeBaseId: 'l1' }],
    cards: [{ id: 'a', question: 'A', cardNotebookId: 'legacy', knowledgeItemId: 'item', knowledgeBaseId: 'l1', status: 'paused', dueAt: 1, reviewCount: 4, lapseCount: 2, strength: 9, schedulerData: { stability: 10 } },
      { id: 'b', question: 'B', cardFolderId: 'dest', knowledgeItemId: 'other', knowledgeBaseId: 'l1', status: 'active', reviewCount: 2 }],
    cardNotebooks: [{ id: 'legacy', folderId: 'old' }], cardFolders: [], cardDocuments: [{ id: 'legacy-note' }],
    reviewRecords: [{ id: 'record', cardId: 'a' }], reviewSessions: { all: { queue: ['a'] } }, streak: { count: 3 },
    memos: [{ id: 'memo', title: 'memo', completed: false, notifiedFor: 'old', popupShownFor: 'old', repeat: 'daily' }],
    settings: { selectionCardPopupEnabled: true }, trash: [], noteTags: [] };
  const state = createApplicationState({ read: () => data, replace: value => { data = value; } });
  const control = { fail: false, saves: 0, saved: null, onSave: null };
  let nextId = 0;
  const deps = { state, now: () => timestamp, isoNow: () => iso, uid: () => `new-${++nextId}`,
    save: async () => {
      control.saves++;
      if (control.onSave) await control.onSave();
      if (control.fail) throw new Error('write failed');
      control.saved = structuredClone(data);
      state.replace(structuredClone(data));
    } };
  const persistenceState = { get data() { return data; }, set data(value) { data = value; }, baseline: structuredClone(data), ready: true, saving: false };
  const coordinator = require('../web/persistence/save-coordinator.js').createSaveCoordinator({ state: persistenceState,
    normalize: structuredClone, patches: require('../web/state-merge.js'), refresh() {}, onError() {}, onSyncError() {},
    storage: { isDesktop: true, async write(proposal) { control.saves++; if (control.onSave) await control.onSave(); if (control.fail) throw Error('write failed'); control.saved = structuredClone(proposal); return proposal; } } });
  deps.transact = change => coordinator.transact(change);
  return { state, control,
    cards: createCardOperations({ ...deps, history: () => ({ count: 7, lastReviewedAt: 123 }), duplicateQuestion: duplicateCardQuestion,
      folderId: card => Object.hasOwn(card, 'cardFolderId') ? card.cardFolderId : state.cards.notebooks.find(note => note.id === card.cardNotebookId)?.folderId }),
    memos: createMemoOperations(deps), settings: createSettingsOperations(deps),
    knowledge: createKnowledgeOperations({ ...deps, availableDocumentTitle: title => title + '（1）' }) };
}
test('domain accessors always follow the sole owner after save, sync, import or rollback replacement', () => {
  const h = setup(), domain = h.state.cards, before = domain.all;
  const next = structuredClone(h.state.read()); next.cards = [{ id: 'new' }]; next.documents = [];
  h.state.replace(next);
  assert.equal(domain.all, next.cards); assert.notEqual(domain.all, before);
  assert.equal(h.state.read(), next); assert.equal(h.state.cards.byId('new'), next.cards[0]);
  assert.equal(h.state.knowledge.documentById('note'), undefined);
  assert.equal(h.state.knowledge.documentById('legacy-note'), next.cardDocuments[0]);
  assert.equal(h.state.knowledge.libraryById('l1'), next.knowledgeBases[0]);
  assert.equal(h.state.knowledge.itemById('item'), next.items[0]);
  assert.equal(h.state.memos.byId('memo'), next.memos[0]);
  assert.equal(h.state.review.records, next.reviewRecords); assert.equal(h.state.settings.current, next.settings);
});
test('rollback checkpoints are temporary independent snapshots and never replace the live owner automatically', () => {
  const h = setup(), before = h.state.checkpoint();
  before.cards[0].question = 'snapshot only'; assert.equal(h.state.cards.all[0].question, 'A');
  h.state.replace(before); assert.equal(h.state.cards.all[0].question, 'snapshot only');
});
test('empty card operations do not persist or invoke selection effects', async () => {
  const h = setup(); assert.deepEqual(await h.cards.move(new Set(), {}), { count: 0 });
  assert.equal(await h.cards.setStatus(new Set(), 'paused', () => assert.fail()), 0);
  assert.equal(await h.cards.restart(new Set()), 0); assert.equal(h.control.saves, 0);
});
test('card move preserves scheduling, source and history and migrates explicit folder ownership', async () => {
  const h = setup(), before = h.state.checkpoint();
  assert.deepEqual(await h.cards.move(new Set(['a']), { cardFolderId: 'dest', cardNotebookId: null }), { count: 1 });
  const card = h.state.cards.byId('a'); assert.equal(card.cardFolderId, 'dest'); assert.equal(card.updatedAt, iso);
  for (const field of ['knowledgeItemId','knowledgeBaseId','status','dueAt','reviewCount','lapseCount','strength','schedulerData']) assert.deepEqual(card[field], before.cards[0][field]);
  assert.deepEqual(h.state.review.records, before.reviewRecords);
  await h.cards.move(new Set(['a']), { cardNotebookId: 'legacy' });
  assert.equal(Object.hasOwn(h.state.cards.byId('a'), 'cardFolderId'), false);
});
test('duplicate target questions reject before mutation or persistence', async () => {
  const h = setup(); h.state.cards.byId('b').question = ' A '; const before = h.state.checkpoint();
  assert.deepEqual(await h.cards.move(new Set(['a']), { cardFolderId: 'dest' }), { duplicate: true });
  assert.deepEqual(h.state.read(), before); assert.equal(h.control.saves, 0);
});
test('failed card move restores the complete state; retry uses the current owner', async () => {
  const h = setup(), before = h.state.checkpoint(); h.control.fail = true;
  await assert.rejects(h.cards.move(new Set(['a']), { cardFolderId: 'dest' }), /write failed/);
  assert.deepEqual(h.state.read(), before);
  h.control.fail = false; await h.cards.move(new Set(['a']), { cardFolderId: 'dest' });
  assert.equal(h.state.cards.byId('a').cardFolderId, 'dest');
});
test('status operation clears selection before save and retains original failure semantics', async () => {
  const h = setup(), ids = new Set(['a']); h.control.fail = true;
  h.control.onSave = () => assert.equal(ids.size, 0);
  await assert.rejects(h.cards.setStatus(ids, 'active', () => ids.clear()), /write failed/);
  assert.equal(h.state.cards.byId('a').status, 'active'); assert.equal(h.state.cards.byId('a').updatedAt, iso);
});
test('restart retains review/lapse history and session records while resetting scheduling', async () => {
  const h = setup(), records = structuredClone(h.state.review.records);
  assert.equal(await h.cards.restart(new Set(['a'])), 1);
  const card = h.state.cards.byId('a'); assert.equal(card.dueAt, timestamp); assert.equal(card.schedulerResetAt, timestamp);
  assert.equal(card.reviewCount, 7); assert.equal(card.lastReviewedAt, 123); assert.equal(card.lapseCount, 2);
  assert.deepEqual(card.schedulerData, {}); assert.equal(card.strength, 0); assert.equal(card.status, 'active');
  assert.deepEqual(h.state.review.records, records); assert.deepEqual(h.state.review.sessions.all.queue, ['a']);
});
test('restart failure retains the committed schedule and selection for an atomic retry', async () => {
  const h = setup(), ids = new Set(['a']); h.control.fail = true;
  const before = structuredClone(h.state.read());
  await assert.rejects(h.cards.restart(ids), /write failed/);
  assert.equal(ids.size, 1); assert.deepEqual(h.state.read(), before);
  h.control.fail = false;
  assert.equal(await h.cards.restart(ids), 1);
  assert.equal(h.state.cards.byId('a').schedulerResetAt, timestamp);
});
test('memo create and update preserve completion/repeat metadata and save exactly once per operation', async () => {
  const h = setup(); await h.memos.upsert(null, { title: 'new', updatedAt: iso, repeat: 'weekly' }, iso);
  assert.equal(h.state.memos.all[0].id, 'new-1'); assert.equal(h.state.memos.all[0].completed, false);
  assert.equal(h.state.memos.all[0].createdAt, iso);
  const memo = h.state.memos.byId('memo'); memo.completed = true;
  await h.memos.upsert(memo, { title: 'edited' }, iso);
  assert.equal(h.state.memos.byId('memo').completed, true); assert.equal(h.state.memos.byId('memo').repeat, 'daily');
  assert.equal(h.control.saves, 2);
});
test('memo completion and reopen clear reminders only when reopening', async () => {
  const h = setup(); await h.memos.toggleCompletion(h.state.memos.byId('memo'));
  let memo = h.state.memos.byId('memo'); assert.equal(memo.completedAt, iso); assert.equal(memo.notifiedFor, 'old');
  await h.memos.toggleCompletion(memo); memo = h.state.memos.byId('memo');
  assert.equal(memo.completedAt, null); assert.equal(memo.notifiedFor, null); assert.equal(memo.popupShownFor, null);
});
test('snooze reopens the memo, delays ten minutes and retains its repeat rule', async () => {
  const h = setup(); h.state.memos.byId('memo').completed = true;
  await h.memos.snooze(h.state.memos.byId('memo'));
  const memo = h.state.memos.byId('memo'); assert.equal(memo.remindAt, new Date(timestamp + 600000).toISOString());
  assert.equal(memo.completed, false); assert.equal(memo.repeat, 'daily'); assert.equal(memo.notifiedFor, null);
});
test('memo removal changes only memos and failed removal retains the committed record', async () => {
  const h = setup(), before = h.state.checkpoint(); h.control.fail = true;
  await assert.rejects(h.memos.remove('memo'), /write failed/); assert.deepEqual(h.state.memos.all, before.memos);
  assert.deepEqual(h.state.cards.all, before.cards); assert.deepEqual(h.state.trash.entries, before.trash);
});
for (const fail of [false, true]) test(`preference ${fail ? 'failure rolls back' : 'success persists'} publishes only after persistence while retaining start/finish callbacks`, async () => {
  const h = setup(), calls = []; h.control.fail = fail;
  const result = await h.settings.setSelectionCardPopupEnabled(false, { onStart: () => calls.push(h.state.settings.current.selectionCardPopupEnabled), onFinish: () => calls.push(h.state.settings.current.selectionCardPopupEnabled) });
  assert.equal(result, !fail); assert.deepEqual(calls, [true, fail]);
  assert.equal(h.state.settings.current.selectionCardPopupEnabled, fail);
});
test('library metadata update preserves hierarchy, ID, content and unrelated fields', async () => {
  const h = setup(), library = h.state.knowledge.libraryById('l1'); library.parentId = 'parent'; library.extra = 'old';
  const documents = structuredClone(h.state.knowledge.documents);
  await h.knowledge.updateLibrary(library, { name: 'renamed', language: '中文' });
  const saved = h.state.knowledge.libraryById('l1'); assert.equal(saved.parentId, 'parent'); assert.equal(saved.extra, 'old');
  assert.equal(saved.name, 'renamed'); assert.equal(saved.updatedAt, iso); assert.deepEqual(h.state.knowledge.documents, documents);
});
test('library update failure restores field presence on a replacement owner without erasing unrelated updates', async () => {
  const h = setup(); h.control.fail = true;
  h.control.onSave = () => { const next = h.state.checkpoint(); next.knowledgeBases[0].external = true; h.state.replace(next); };
  await assert.rejects(h.knowledge.updateLibrary(h.state.knowledge.libraryById('l1'), { name: 'changed', language: '中文' }), /write failed/);
  const library = h.state.knowledge.libraryById('l1'); assert.equal(library.name, 'first'); assert.equal(library.external, true);
  assert.equal(Object.hasOwn(library, 'language'), false); assert.equal(Object.hasOwn(library, 'updatedAt'), false);
});
const hooks = calls => ({ beforeSave: () => calls.push('before'), afterSave: result => calls.push(result.document.title), onRollback: () => calls.push('rollback') });
test('document move cascades to linked items/cards, keeps versions and leaves unrelated sources intact', async () => {
  const h = setup(), calls = [], before = h.state.checkpoint();
  await h.knowledge.moveDocument('note', 'l2', hooks(calls));
  assert.equal(h.state.knowledge.documentById('note').title, 'note（1）');
  assert.equal(h.state.knowledge.itemById('item').knowledgeBaseId, 'l2'); assert.equal(h.state.cards.byId('a').knowledgeBaseId, 'l2');
  assert.equal(h.state.cards.byId('b').knowledgeBaseId, 'l1'); assert.deepEqual(h.state.knowledge.documents[0].metadata, before.documents[0].metadata);
  assert.deepEqual(calls, ['before', 'note（1）']); assert.equal(h.control.saves, 1);
});
test('missing/same document destinations cause no mutation, save or view effects', async () => {
  const h = setup(), calls = [], before = h.state.checkpoint();
  await assert.rejects(h.knowledge.moveDocument('missing', 'l2', hooks(calls)), /已不存在/);
  assert.equal(await h.knowledge.moveDocument('note', 'l1', hooks(calls)), null);
  assert.deepEqual(h.state.read(), before); assert.deepEqual(calls, []); assert.equal(h.control.saves, 0);
});
for (const failAt of ['save', 'view']) test(`document move ${failAt === 'save' ? 'discards the candidate' : 'retains the committed move'} when ${failAt} fails`, async () => {
  const h = setup(), calls = [], before = h.state.checkpoint(); h.control.fail = failAt === 'save';
  const callbacks = hooks(calls); if (failAt === 'view') callbacks.afterSave = () => { throw new Error('view failed'); };
  await assert.rejects(h.knowledge.moveDocument('note', 'l2', callbacks), /failed/);
  if (failAt === 'save') assert.deepEqual(h.state.read(), before);
  else { assert.deepEqual(h.state.read(), h.control.saved); assert.equal(h.state.knowledge.documentById('note').knowledgeBaseId, 'l2'); }
  assert.deepEqual(calls, ['before', 'rollback']);
});
test('business state and operations are browser-loadable before app with no DOM or platform dependencies', () => {
  const context = vm.createContext({ structuredClone });
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  for (const name of ['state/application-state','application/card-operations','application/card-trash','application/card-runtime','application/memo-operations','application/settings-operations','application/knowledge-operations','application/review-operations','application/review-transactions','application/review-runtime']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', name + '.js'), 'utf8'), context);
    assert.ok(html.indexOf(`src="${name}.js"`) < html.indexOf('src="app.js"'));
  }
  assert.equal(typeof context.MemoKeepState.createApplicationState, 'function');
  assert.equal(Object.keys(context.MemoKeepApplication).length, 10);
});
test('failed memo upsert restores only its target after state replacement, preserving other domain changes', async () => {
  const h = setup(), original = structuredClone(h.state.memos.byId('memo')); h.control.fail = true;
  h.control.onSave = async () => { h.state.replace(structuredClone(h.state.read())); h.state.read().settings.extra = 'concurrent'; };
  await assert.rejects(h.memos.upsert(h.state.memos.byId('memo'), {title:'edited',notes:'new'}, iso), /write failed/);
  assert.deepEqual(h.state.memos.byId('memo'), original); assert.equal(h.state.settings.current.extra, 'concurrent');
  await assert.rejects(h.memos.upsert(null, {title:'new'}, iso), /write failed/); assert.equal(h.state.memos.all.length, 1);
});
test('queued memo retry uses live state after a failed previous write and does not replay stale fields', async () => {
  const h = setup(); let release, entered; const started = new Promise(resolve => { entered = resolve; });
  h.control.onSave = async () => { if (h.control.saves === 1) { entered(); await new Promise(resolve => { release = resolve; }); throw Error('first write fails'); } };
  const first = h.memos.upsert(h.state.memos.byId('memo'), {title:'first'}, iso), failed = assert.rejects(first, /first write fails/); await started;
  const second = h.memos.upsert(h.state.memos.byId('memo'), {title:'second'}, iso); release(); await failed; await second;
  assert.equal(h.state.memos.all.length, 1); assert.equal(h.state.memos.byId('memo').title, 'second'); assert.equal(h.control.saves, 2);
});
for (const action of ['toggleCompletion','snooze','remove']) test(`memo ${action} failure leaves the committed record unchanged and supports retry`, async () => {
  const h=setup(),before=structuredClone(h.state.memos.byId('memo'));h.control.fail=true;
  const invoke=()=>action==='remove'?h.memos.remove('memo'):h.memos[action](h.state.memos.byId('memo'));
  await assert.rejects(invoke(),/write failed/);assert.deepEqual(h.state.memos.byId('memo'),before);
  h.control.fail=false;await invoke();
  if(action==='remove')assert.equal(h.state.memos.byId('memo'),undefined);
  else if(action==='snooze')assert.equal(h.state.memos.byId('memo').remindAt,new Date(timestamp+600000).toISOString());
  else assert.equal(h.state.memos.byId('memo').completed,true);
});
