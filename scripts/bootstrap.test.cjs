const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createApplication } = require('../web/bootstrap/composition.js');
const { createStartup } = require('../web/bootstrap/startup.js');
function composition(captured) {
  let data = { version: 2, cards: [{ id: 'card', question: 'q', status: 'active' }], documents: [], cardDocuments: [], cardNotebooks: [], knowledgeBases: [], items: [], reviewRecords: [], memos: [], settings: {}, trash: [] };
  const persistenceState = { get data() { return data; }, set data(value) { data = value; }, baseline: structuredClone(data), ready: true, saving: false, refreshPending: false };
  const events = [];
  const modules = { state: require('../web/state/application-state.js'), persistence: {
    ...require('../web/persistence/storage-adapter.js'), ...require('../web/persistence/save-coordinator.js'), ...require('../web/persistence/sync-coordinator.js') },
    operations: { ...require('../web/application/card-operations.js'), ...require('../web/application/card-runtime.js'), ...require('../web/application/memo-operations.js'), ...require('../web/application/settings-operations.js'), ...require('../web/application/knowledge-operations.js'), ...require('../web/application/review-operations.js'), ...require('../web/application/review-transactions.js'), ...require('../web/application/review-runtime.js') },
    editor: require('../web/editor/session.js'), views: { ...require('../web/views/note-tabs.js'), ...require('../web/views/card-list.js'), ...require('../web/views/card-list-events.js'), ...require('../web/views/review.js'), ...require('../web/views/review-events.js') }, domain: { ...require('../web/domain/inline-cards.js'), ...require('../web/domain/card-list.js') } };
  const editorState = { save: null, tabs: [] };
  const ports = { data: { read: () => data, replace: value => { data = value; } }, persistenceState,
    storage: { desktop: { write: async value => { events.push('write'); return value; } } }, patches: require('../web/state-merge.js'),
    normalize: structuredClone, sync: { isDirty: () => false }, notify: message => events.push(message),
    actions: { isoNow: () => '2026-10-17', now: () => 10, history: () => ({}), folderId: () => null, duplicateQuestion: () => null },
    review: { model: require('../web/review-session.js'), scheduler: require('../web/fsrs-scheduler.js'), todayKey: () => '2026-10-17', environment: {}, ui: {}, candidates: {} },
    cards: { helpers: {}, actions: {} },
    editorState, editorView: { clearChrome() {} }, editorActions: { draft: () => null }, tabs: { state: {}, actions: {}, $() {} } };
  if (captured) {
    const create = modules.operations.createReviewRuntime;
    modules.operations.createReviewRuntime = () => { captured.creations++; return create(); };
    for (const [group, name] of [['views', 'createReviewView'], ['views', 'createReviewBindings'], ['operations', 'createReviewOperations']]) {
      const factory = modules[group][name];
      modules[group][name] = dependencies => { captured.runtimes.push(dependencies.runtime); return factory(dependencies); };
    }
  }
  return { application: createApplication({ modules, ports }), modules, ports, events };
}
test('composition has no initialization IO and all migrated services share the live owner', async () => {
  const h = composition(); assert.deepEqual(h.events, []); assert.equal(h.application.state.rollback, undefined);
  const replacement = { ...h.application.state.read(), cards: [{ id: 'new', question: 'new' }] };
  h.application.state.replace(replacement); assert.equal(h.ports.persistenceState.data, replacement);
  await h.application.persistence.save(); assert.deepEqual(h.events, ['write']);
  assert.equal(h.application.state.cards.all, h.ports.persistenceState.data.cards);
  assert.equal(h.application.domain, h.modules.domain);
});
test('operations use the composed save endpoint without a global alias', async () => {
  const h = composition(); let calls = 0; h.application.persistence.save = async () => { calls++; };
  const selection = new Set(['card']);
  assert.equal(await h.application.operations.cards.setStatus(selection, 'paused', () => selection.clear()), 1);
  assert.equal(calls, 1); assert.equal(h.application.state.cards.byId('card').status, 'paused');
});
test('session disposal uses the original shared callbacks and state', () => {
  const h = composition(); h.ports.editorState.discard = () => h.events.push('dispose'); h.ports.editorState.activeId = 'note';
  h.application.editor.session.resetActiveNoteEditor();
  assert.equal(h.ports.editorState.activeId, null); assert.deepEqual(h.events, ['dispose']);
});
function startup() {
  const calls = [], listeners = new Map(), state = { tabs: [], dirty: false, hasChanges() { return this.dirty; } };
  let frame, timer;
  const loading = Promise.resolve();
  const lifecycle = createStartup({ state, window: { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) },
    shell: { bind: () => calls.push('shell') }, hooks: { applySidebar: () => calls.push('sidebar'), bindings: [() => calls.push('navigation'), () => calls.push('desktop')],
      bindInvite: () => calls.push('invite'), load: () => { calls.push('load'); return loading; } },
    requestFrame: callback => { frame = callback; return 1; }, cancelFrame: id => calls.push(['cancelFrame',id]),
    setTimer: (callback, delay) => { assert.equal(delay, 0); timer = callback; return 2; }, clearTimer: id => calls.push(['clearTimer',id]) });
  return { state, calls, listeners, lifecycle, loading, paint: () => frame(), tick: () => timer() };
}
test('startup preserves paint then timer then binding order and tracks the original load promise', () => {
  const h = startup(); h.lifecycle.schedule(); h.lifecycle.schedule(); assert.deepEqual(h.calls, []);
  h.paint(); assert.deepEqual(h.calls, []); h.tick(); h.tick();
  assert.deepEqual(h.calls, ['shell','sidebar','navigation','desktop','invite','load']); assert.equal(h.state.loading, h.loading);
});
test('close guard responds to current editor or background dirty drafts and ignores clean tabs', () => {
  const h = startup(); h.lifecycle.schedule(); const guard = h.listeners.get('beforeunload');
  let count = 0; const event = { preventDefault: () => count++ };
  guard(event); assert.equal(count, 0);
  h.state.tabs = [{ draftDocument: {}, dirty: true }]; guard(event); assert.equal(count, 1); assert.equal(event.returnValue, '');
  h.state.tabs = []; h.state.dirty = true; guard(event); assert.equal(count, 2);
});
test('disposing scheduled startup removes its close guard and prevents binding or loading', () => {
  const h = startup(); h.lifecycle.schedule(); h.lifecycle.dispose(); h.paint(); h.tick();
  assert.equal(h.listeners.size, 0); assert.deepEqual(h.calls, [['cancelFrame',1]]); assert.equal(h.state.loading, undefined);
});
test('disposing between paint and initialization cancels the timer', () => {
  const h = startup(); h.lifecycle.schedule(); h.paint(); h.lifecycle.dispose(); h.tick();
  assert.deepEqual(h.calls, [['clearTimer',2]]);
});
test('bootstrap modules are loadable without legacy globals and the HTML orders explicit dependencies', () => {
  const context = vm.createContext({});
  for (const file of ['bootstrap/composition.js','bootstrap/startup.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../web',file),'utf8'),context);
  assert.equal(typeof context.MemoKeepBootstrap.createApplication, 'function');
  const html = fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
  assert.ok(html.indexOf('src="bootstrap/composition.js"') < html.indexOf('src="legacy/application.js"'));
  assert.ok(html.indexOf('src="legacy/application.js"') < html.indexOf('src="app.js"'));
  const entry = fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
  assert.doesNotMatch(entry, /\bdata\b|memoKeepDesktop|localStorage/);
  const legacy = fs.readFileSync(path.join(__dirname,'../web/legacy/application.js'),'utf8');
  assert.doesNotMatch(legacy, /^(?:async )?function (?:getApplicationState|getApplicationOperations|getApplicationPersistence|getEditorSession|getNoteTabView|save|refreshSharedData|applySharedData|libraryById|itemById|parseInlineCards)\(/m);
});

test('review undo uses the composed save endpoint and current data owner', async () => {
  const h = composition(); let calls = 0;
  h.application.persistence.transact = async change => { calls++; change(h.application.state.read()); };
  const current = h.application.state.read();
  current.cards[0] = { id: 'card', status: 'active', dueAt: 10 };
  const snapshot = require('../web/review-session.js').snapshot(current.cards[0]);
  current.reviewRecords = [{ id: 'log', cardId: 'card' }];
  current.reviewSessions = { all: { results: [{ cardId: 'card', recordId: 'log', before: snapshot, after: snapshot }] } };
  assert.equal(await h.application.operations.reviewTransactions.undo('all'), 'card');
  assert.equal(calls, 1); assert.equal(h.ports.persistenceState.data.reviewRecords.length, 0);
});

test('composition creates one review owner shared by operations, rendering and bindings', () => {
  const captured = { creations: 0, runtimes: [] }, h = composition(captured);
  assert.equal(captured.creations, 1); assert.equal(captured.runtimes.length, 3);
  for (const runtime of captured.runtimes) assert.equal(runtime, h.application.review.runtime);
  captured.runtimes[0].reviewActionPending = true;
  assert.equal(captured.runtimes[1].reviewActionPending, true);
  assert.equal(captured.runtimes[2].reviewActionPending, true);
  assert.equal(Object.hasOwn(h.ports.review, 'session'), false);
  assert.deepEqual(h.events, []);
});
test('separate applications have separate transient owners and never store them in persisted data', async () => {
  const first = composition(), second = composition();
  first.application.review.runtime.reviewQueue.push({ id: 'first' });
  first.application.review.runtime.reviewedCardIds.add('first');
  assert.deepEqual(second.application.review.runtime.reviewQueue, []);
  assert.equal(second.application.review.runtime.reviewedCardIds.size, 0);
  await first.application.persistence.save();
  for (const key of Object.keys(first.application.review.runtime)) assert.equal(Object.hasOwn(first.application.state.read(), key), false);
});

test('card composition creates one owner for list/events and a live scope adapter for review', () => {
  const h = composition(); const captured = [], creators = [];
  const create = h.modules.operations.createCardRuntime;
  h.modules.operations.createCardRuntime = () => { const runtime = create(); creators.push(runtime); return runtime; };
  for (const name of ['createCardListView', 'createCardListBindings']) {
    const factory = h.modules.views[name];
    h.modules.views[name] = dependencies => { captured.push(dependencies.runtime); return factory(dependencies); };
  }
  let environment;
  const factory = h.modules.operations.createReviewOperations;
  h.modules.operations.createReviewOperations = dependencies => { environment = dependencies.environment; return factory(dependencies); };
  const application = createApplication({ modules: h.modules, ports: h.ports });
  assert.equal(creators.length, 1); assert.equal(captured.length, 2);
  for (const runtime of captured) assert.equal(runtime, application.cards.runtime);
  const replacement = { type: 'folder', id: 'fresh' };
  application.cards.runtime.cardScope = replacement; assert.equal(environment.cardScope, replacement);
  h.ports.review.environment.applicationDataReady = true; assert.equal(environment.applicationDataReady, true);
  assert.equal(Object.hasOwn(h.ports.cards, 'runtime'), false); assert.deepEqual(h.events, []);
});
test('applications isolate card state and never persist scope, page or selection', async () => {
  const a = composition(), b = composition(); const runtime = a.application.cards.runtime;
  runtime.cardScope.id = 'changed'; runtime.selectedCardIds.add('card'); runtime.selectedCardTags.add('tag'); runtime.closedCardFolders.add('folder'); runtime.cardPage = 3;
  assert.deepEqual(b.application.cards.runtime.cardScope, { type: 'all', id: '' });
  for (const field of ['selectedCardIds', 'selectedCardTags', 'closedCardFolders']) assert.equal(b.application.cards.runtime[field].size, 0);
  assert.equal(b.application.cards.runtime.cardPage, 1);
  await a.application.persistence.save();
  for (const key of Object.keys(runtime)) assert.equal(Object.hasOwn(a.application.state.read(), key), false);
});
test('bulk flow and trash transaction share the composed card owner without initialization IO', () => {
  const h = composition(), captured = [];
  const trash = require('../web/application/card-trash.js').createCardTrashOperations;
  const bulk = require('../web/views/card-bulk.js').createCardBulkView;
  h.modules.operations.createCardTrashOperations = dependencies => { captured.push(dependencies.runtime); return trash(dependencies); };
  h.modules.views.createCardBulkView = dependencies => { captured.push(dependencies.runtime); return bulk(dependencies); };
  h.ports.cardBulk = { helpers: { renderAll() {}, renderTrash() {} }, directory: require('../web/directory-tree.js') };
  const application = createApplication({ modules: h.modules, ports: h.ports });
  assert.equal(captured.length, 2);
  for (const runtime of captured) assert.equal(runtime, application.cards.runtime);
  assert.equal(typeof application.operations.cardTrash.trashCards, 'function');
  assert.equal(typeof application.views.cardBulk.deleteSelectedCards, 'function'); assert.deepEqual(h.events, []);
});
test('card bindings receive original module operations without legacy fallbacks or wrappers', () => {
  const h = composition(), bulk = { deleteCardById() {}, deleteSelectedCards() {}, openMoveCardsDialog() {} }, editor = { openCardDialog() {} };
  let listActions, deleteCard;
  Object.assign(h.modules.operations, { createCardTrashOperations: () => ({}) });
  Object.assign(h.modules.views, { createCardBulkView: () => bulk, createCardEditor: () => editor, createCardDetail: () => ({}),
    createCardDialogBindings: deps => { deleteCard = deps.deleteCardById; return {}; },
    createCardListBindings: deps => { listActions = deps.actions; return {}; } });
  h.ports.cardBulk = { helpers: {} }; h.ports.cardDialogs = {};
  h.ports.cards.actions.deleteCardById = () => { throw new Error('Stale entry'); };
  const application = createApplication({ modules: h.modules, ports: h.ports });
  assert.equal(deleteCard, bulk.deleteCardById); assert.equal(listActions.deleteSelectedCards, bulk.deleteSelectedCards);
  assert.equal(listActions.openMoveCardsDialog, bulk.openMoveCardsDialog); assert.equal(listActions.openCardDialog, editor.openCardDialog);
  assert.equal(application.views.cardBulk, bulk);
});
test('failed card rollback preserves a memo committed after its checkpoint', async () => {
  const h = composition(), data = h.application.state.read(); data.memos.push({id:'memo',title:'old'}); h.ports.persistenceState.baseline = structuredClone(data);
  let release, entered; const started = new Promise(resolve => { entered = resolve; }); let writes = 0;
  h.ports.storage.desktop.write = async proposal => { if (++writes === 1) { entered(); await new Promise(resolve => { release = resolve; }); return proposal; } throw Error('card write failed'); };
  const memo = h.application.operations.memos.upsert(data.memos[0], {title:'committed'}, 'now'); await started;
  const card = h.application.operations.cards.move(new Set(['card']), {}), rejected = assert.rejects(card, /card write failed/);
  release(); await memo; await rejected;
  assert.equal(h.application.state.memos.byId('memo').title, 'committed'); assert.equal(h.ports.persistenceState.baseline.memos[0].title, 'committed'); assert.equal(h.application.state.cards.byId('card').updatedAt, undefined);
});
test('failed card move does not erase an already queued settings save',async()=>{
  const h=composition();h.application.state.read().settings.selectionCardPopupEnabled=true;h.ports.persistenceState.baseline=structuredClone(h.application.state.read());
  let release,writes=0,disk;const gate=new Promise(resolve=>{release=resolve;});
  h.ports.storage.desktop.write=async proposal=>{if(++writes===1){await gate;throw Error('card failed');}disk=structuredClone(proposal);return proposal;};
  const move=assert.rejects(h.application.operations.cards.move(new Set(['card']),{cardFolderId:'failed-folder'}),/card failed/);
  const preference=h.application.operations.settings.setSelectionCardPopupEnabled(false,{onStart(){},onFinish(){}});
  release();await move;assert.equal(await preference,true);assert.equal(disk.settings.selectionCardPopupEnabled,false);
  assert.equal(disk.cards[0].cardFolderId,undefined);assert.deepEqual(h.application.state.read(),disk);
});

for (const secondFails of [false,true]) test(`composed card moves: later ${secondFails?'failure must not revive the first failed move':'success must retain its requested destination'}`,async()=>{
 const h=composition(),gate=(()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};})();let writes=0,disk;
 h.ports.storage.desktop.write=async proposal=>{const n=++writes;if(n===1){await gate.promise;throw Error('first failed');}if(n===2&&secondFails)throw Error('second failed');disk=structuredClone(proposal);return proposal;};
 const a=h.application.operations.cards.move(new Set(['card']),{cardFolderId:'folder-A'}).then(()=>true,()=>false);
 const wanted=secondFails?'folder-B':'folder-A';
 const b=h.application.operations.cards.move(new Set(['card']),{cardFolderId:wanted}).then(()=>true,()=>false);
 gate.resolve();assert.deepEqual(await Promise.all([a,b]),[false,!secondFails]);
 const actual=h.application.state.cards.byId('card').cardFolderId;
 assert.equal(actual,secondFails?undefined:wanted,JSON.stringify({secondFails,actual,persisted:disk?.cards[0].cardFolderId,wanted:secondFails?'original destination':wanted}));
});

for(const failA of [false,true]) test(`queued preference can explicitly restore its initial value after ${failA?'failed':'successful'} prior preference`,async()=>{
  const h=composition();h.application.state.read().settings.selectionCardPopupEnabled=true;h.ports.persistenceState.baseline=structuredClone(h.application.state.read());
  let release,writes=0,disk;const gate=new Promise(resolve=>{release=resolve;});
  h.ports.storage.desktop.write=async proposal=>{if(++writes===1){await gate;if(failA)throw Error('first failed');}disk=structuredClone(proposal);return proposal;};
  const callbacks={onStart(){},onFinish(){}};
  const a=h.application.operations.settings.setSelectionCardPopupEnabled(false,callbacks);
  const b=h.application.operations.settings.setSelectionCardPopupEnabled(true,callbacks);
  release();assert.equal(await a,!failA);assert.equal(await b,true);assert.equal(h.application.state.settings.current.selectionCardPopupEnabled,true);
  if(disk)assert.equal(disk.settings.selectionCardPopupEnabled,true);
});
