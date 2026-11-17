const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEditorSession } = require('../web/editor/session.js');
const { createNoteSaveSession } = require('../web/editor/save-session.js');
const { createNoteContentTransaction } = require('../web/editor/content-transactions.js');
const { createQuillTransactions } = require('../web/editor/quill-transactions.js');
const { createApplicationState } = require('../web/state/application-state.js');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function lifecycle() {
  const events = [], control = { form: true, dirty: true, before: true, answer: 'save' };
  const state = { activeId: 'a', notebookId: 'n', libraryId: 'l', pendingTitle: 'title', tabs: [], actionPending: false, refreshPending: false,
    hasChanges: () => control.dirty, beforeLeave: async () => control.before,
    save: async () => { events.push('save'); return true; }, discard: () => events.push('dispose'), captureDraft: async () => events.push('capture') };
  const session = createEditorSession({ state, view: { hasForm: () => control.form, clearChrome: () => events.push('clear') },
    actions: { confirmUnsaved: async () => control.answer, draft: () => state.tabs.find(tab => tab.id === state.activeId && tab.draftDocument),
      refresh: async () => events.push('refresh'), activate: async id => { state.activeId = id; return true; } } });
  return { state, control, events, ...session };
}
for (const answer of ['cancel', 'discard', 'save']) test(`flush ${answer} preserves original confirmation result`, async () => {
  const h = lifecycle(); h.control.answer = answer;
  assert.equal(await h.flushActiveNoteEditor(), answer !== 'cancel');
  assert.deepEqual(h.events, answer === 'save' ? ['save'] : []);
  assert.equal(h.state.activeId, 'a');
});
test('missing form disposes and clears callbacks; diagram cancellation blocks leaving', async () => {
  const h = lifecycle(); h.control.before = false;
  assert.equal(await h.flushActiveNoteEditor(), false); assert.deepEqual(h.events, []);
  h.control.form = false; assert.equal(await h.flushActiveNoteEditor(), true);
  assert.equal(h.state.save, null); assert.equal(h.state.activeId, null); assert.deepEqual(h.events, ['dispose','clear']);
});
test('failed save retains editor and draft; action guard rejects navigation', async () => {
  const h = lifecycle(); h.state.tabs = [{ id: 'a', draftDocument: {} }]; h.state.save = async () => false;
  assert.equal(await h.leaveActiveNoteEditor(), false); assert.equal(h.state.tabs.length, 1); assert.equal(h.state.activeId, 'a');
  h.state.actionPending = true; assert.equal(await h.leaveActiveNoteEditor(), false);
});
test('leave removes discarded active draft and refreshes only after disposal', async () => {
  const h = lifecycle(); h.control.answer = 'discard'; h.state.tabs = [{ id: 'a', draftDocument: {} }]; h.state.refreshPending = true;
  assert.equal(await h.leaveActiveNoteEditor(), true); assert.deepEqual(h.state.tabs, []);
  assert.deepEqual(h.events, ['dispose','clear','refresh']);
});
test('a replacement editor mounted during save is never disposed by the previous session', async () => {
  const h = lifecycle(), replacement = async () => true;
  h.state.save = async () => { h.state.save = replacement; return true; };
  assert.equal(await h.leaveActiveNoteEditor(), true); assert.equal(h.state.save, replacement); assert.deepEqual(h.events, []);
});
test('tab change captures draft without storage and quietly saves existing notes', async () => {
  const h = lifecycle(); h.state.tabs = [{ id: 'a', draftDocument: {} }];
  assert.equal(await h.saveNoteBeforeTabChange(), true); assert.deepEqual(h.events, ['capture']);
  h.state.tabs = []; h.state.save = async options => { assert.equal(options.quiet, true); h.control.dirty = false; return true; };
  assert.equal(await h.saveNoteBeforeTabChange(), true);
});
test('window close visits background dirty drafts and stops immediately on cancellation', async () => {
  const h = lifecycle(); h.control.dirty = false;
  h.state.tabs = [{ id: 'b', draftDocument: {}, dirty: true }, { id: 'c', draftDocument: {}, dirty: true }];
  // Mounting a background draft supplies new live callbacks.
  const session = createEditorSession({ state: h.state, view: { hasForm: () => true, clearChrome() {} }, actions: {
    draft: () => h.state.tabs.find(tab => tab.id === h.state.activeId), confirmUnsaved: async () => 'cancel', refresh() {},
    activate: async id => { h.events.push(id); h.state.activeId = id; h.state.save = async () => true; h.state.hasChanges = () => true; return true; }
  } });
  assert.equal(await session.flushNoteTabsForWindowClose(), false); assert.deepEqual(h.events, ['dispose','b']);
});
function saveSession() {
  const gate = deferred(), events = [], errors = [], control = { current: true, title: 'note', fail: false, draft: null, refresh: false };
  const state = { ready: Promise.resolve(), saveInFlight: null, savedSnapshot: { title: 'saved' }, latestSnapshot: null, diagram: null };
  const snapshot = () => ({ title: control.title, content: 'body', tagIds: ['tag'], editorMode: 'note', noteContent: '<p>x</p>', noteContentInitialized: true, inlineTagRows: [] });
  const session = createNoteSaveSession({ state, view: { titleInput: () => ({ focus: () => events.push('focus') }), notify: text => events.push(text), updateTitle: () => events.push('title'), setSaveError: message => errors.push(message) },
    actions: { isCurrent: () => control.current, capture: snapshot, persist: async value => { events.push(value.title); if (control.fail) throw new Error('write failed'); await gate.promise; },
      refreshPending: () => control.refresh, refresh: async () => events.push('refresh'), draft: () => control.draft, snapshotsMatch: (a,b) => a.title === b.title } });
  return { state, control, gate, events, errors, ...session };
}
test('editor save is single-flight and saved notes produce no success toast', async () => {
  const h = saveSession(), first = h.save({ quiet: true }), second = h.save();
  assert.equal(first, second); h.gate.resolve(); assert.equal(await first, true);
  assert.deepEqual(h.events, ['note','title']); assert.deepEqual(h.errors, ['']); assert.equal(h.state.saveInFlight, null);
});
test('save waits for rich initialization, validates title, and permits retry after failure', async () => {
  const h = saveSession(), ready = deferred(); h.state.ready = ready.promise; h.control.title = '';
  const pending = h.save(); assert.deepEqual(h.events, []); ready.resolve(); assert.equal(await pending, false); assert.ok(h.events.includes('focus'));
  h.control.title = 'retry'; h.control.fail = true; assert.equal(await h.save(), false); assert.equal(h.state.saveInFlight, null);
  h.control.fail = false; h.gate.resolve(); h.control.refresh = true; assert.equal(await h.save(), true); assert.ok(h.events.includes('refresh'));
  assert.deepEqual(h.errors, ['笔记名称不能为空', 'write failed', '']);
  assert.equal(h.events.includes('笔记已保存'), false);
  assert.equal(h.events.includes('write failed'), false, 'Persistence errors are already announced by the coordinator');
});
function saveFeedback() {
  const context = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../web/editor/features/save-history.js'), 'utf8'), context);
  const tab = { id: 'note' }, notifications = [];
  const control = { validation: '', snapshot: { content: 'changed' }, draft: null };
  const status = { classList: { toggle() {} } }, button = {}, questionError = {};
  const nodes = { '#noteSaveStatus': status, '#saveNoteButton': button, '#cardQuestionError': questionError };
  const session = { target: { id: 'note' }, editorMode: 'card', editor: { value: 'changed' }, savedSnapshot: { content: 'saved' }, latestSnapshot: control.snapshot };
  const features = { snapshotsMatch: (left, right) => left.content === right.content };
  Object.assign(features, context.MemoKeepShell.createEditorSaveHistory({ state: { editor: { editingMarkdownDocumentId: 'note' } },
    config: { $: selector => nodes[selector] }, session, features,
    actions: { validateNotebookCardQuestions: () => control.validation, showToast: message => notifications.push(message) },
    env: { openNoteTabs: [tab], noteDraftTab: () => control.draft, application: { views: { tabs: { renderNoteTabs() {} } } } }
  }), { isCurrentEditor: () => true, captureSnapshot: () => control.snapshot });
  return { tab, control, session, status, button, questionError, notifications, ...features };
}
test('duplicate questions keep an error marker and announce once until corrected', () => {
  const h = saveFeedback(); h.control.validation = '题目重复，无法保存';
  h.refreshSaveState(); h.refreshSaveState();
  assert.equal(h.tab.saveError, h.control.validation); assert.equal(h.button.disabled, true);
  assert.deepEqual(h.notifications, ['题目重复，无法保存']);
  h.markNoteChanged(); assert.equal(h.tab.saveError, h.control.validation, 'Editing keeps the marker while validation still fails');
  h.control.validation = ''; h.markNoteChanged();
  assert.equal(h.tab.saveError, undefined); assert.equal(h.button.disabled, false); assert.equal(h.questionError.hidden, true);
});
test('write failure clears on another edit and an in-flight save remains disabled', () => {
  const h = saveFeedback(); h.setSaveError('磁盘空间不足');
  assert.equal(h.tab.saveError, '磁盘空间不足'); assert.equal(h.status.textContent, '磁盘空间不足');
  h.markNoteChanged(); assert.equal(h.tab.saveError, '磁盘空间不足', 'Refreshing unchanged content retains the failed-save marker');
  h.control.snapshot = { content: 'edited again' };
  h.markNoteChanged(); assert.equal(h.tab.saveError, undefined); assert.equal(h.status.textContent, '未保存');
  h.session.saveInFlight = Promise.resolve(); h.refreshSaveState();
  assert.equal(h.status.textContent, '保存中…'); assert.equal(h.button.disabled, true);
  h.session.saveInFlight = null; h.session.savedSnapshot = h.control.snapshot; h.refreshSaveState();
  assert.equal(h.status.textContent, '已保存'); assert.equal(h.button.disabled, true);
  h.control.draft = {}; h.refreshSaveState();
  assert.equal(h.status.textContent, '未保存'); assert.equal(h.button.disabled, false, 'An untouched draft still needs an explicit save');
});
test('draft capture retains the initial baseline and copies tags without persisting', async () => {
  const h = saveSession(); h.control.draft = { draftDocument: { metadata: {} } };
  await h.captureDraft(); const baseline = h.control.draft.draftBaseline; h.state.savedSnapshot = { title: 'later' }; await h.captureDraft();
  assert.equal(h.control.draft.draftBaseline, baseline); assert.equal(h.control.draft.draftDocument.title, 'note');
  assert.equal(h.control.draft.dirty, true); assert.deepEqual(h.events, []);
  h.control.current = false; assert.equal(h.hasChanges(), false);
});
test('diagram-only changes count as dirty, and stale editors skip save', async () => {
  const h = saveSession(); h.control.title = 'saved'; assert.equal(h.hasChanges(), false);
  h.state.diagram = { hasChanges: () => true }; assert.equal(h.hasChanges(), true);
  h.control.current = false; assert.equal(await h.save(), true); assert.deepEqual(h.events, []);
});
function content(draft = false) {
  const doc = { id: 'note', title: 'old', content: 'old', metadata: { noteContent: '<p>old</p>', versions: [{ title: 'older' }] } };
  let data = { documents: draft ? [] : [doc], cardDocuments: [], cardNotebooks: [] };
  const state = createApplicationState({ read: () => data, replace: next => { data = next; } });
  const events = [], control = { fail: false, cleanupFail: false, current: true, validation: '' };
  const tab = draft ? { id: 'note', draftDocument: doc, draftBaseline: {}, dirty: true } : { id: 'note' };
  const session = { target: doc, libraryId: 'library', notebookId: null, richContent: '', imageIds: new Set(['new-image']), activeId: 'note', tabs: [tab] };
  const snapshot = { title: 'updated', content: 'new', tagIds: ['tag'], editorMode: 'note', noteContent: '<p>new</p>', noteContentInitialized: true, inlineTagRows: [] };
  const persistenceState = { get data() { return data; }, set data(value) { data=value; }, baseline: structuredClone(data), ready: true };
  const coordinator = require('../web/persistence/save-coordinator.js').createSaveCoordinator({ state:persistenceState, normalize:structuredClone,
    onError(){}, onSyncError(){}, storage:{isDesktop:true,async write(proposal){events.push('save');if(control.onSave)await control.onSave();if(control.fail)throw Error('write failed');return proposal;}} });
  const transaction = createNoteContentTransaction({ state, session, services: {
    versionLimit: 5, draft: () => tab.draftDocument ? tab : null, documentById: id => state.read().documents.find(doc => doc.id === id) || state.read().cardDocuments.find(doc => doc.id === id) || tab.draftDocument,
    validateQuestions: () => control.validation, imageIdsFromContent: () => ['old-image'], parseCards: () => [{ question: 'q', answer: 'a' }],
    versionFromDocument: doc => ({ title: doc.title, content: doc.content }), snapshotsMatch: (a,b) => a.title === b.title && a.content === b.content,
    uid: () => 'new-id', normalizeTagIds: tags => [...tags], syncInlineCards: () => events.push('cards'),
    transact: change => coordinator.transact(change),
    deleteImages: async ids => { events.push(['cleanup', ids]); if (control.cleanupFail) throw new Error('cleanup failed'); }, isCurrent: () => control.current },
    view: { notify: message => events.push(message), setDocumentId: id => events.push(id), refreshSaveState: () => events.push('dirty'), renderVersionMenu: () => events.push('versions'), renderSidebar: () => events.push('sidebar'), renderCards: () => events.push('workspace') } });
  return { state, session, tab, snapshot, events, control, ...transaction };
}
test('existing save preserves historical versions, adopts authoritative document and cleans images after storage', async () => {
  const h = content(); const previous = h.session.target; await h.persist(h.snapshot);
  assert.notEqual(h.session.target, previous); assert.equal(h.state.read().documents[0].title, 'updated');
  assert.deepEqual(h.session.target.metadata.versions.map(version => version.title), ['old','older']);
  assert.ok(h.events.indexOf('save') < h.events.findIndex(event => Array.isArray(event)));
  assert.equal(h.session.savedSnapshot.title, 'updated'); assert.equal(h.session.imageIds.size, 0);
});
test('draft failure restores business state but keeps draft document, baseline and images for retry', async () => {
  const h = content(true); h.control.fail = true; const baseline = h.tab.draftBaseline;
  await assert.rejects(h.persist(h.snapshot), /write failed/);
  assert.deepEqual(h.state.read().documents, []); assert.equal(h.session.target, h.tab.draftDocument);
  assert.equal(h.tab.draftBaseline, baseline); assert.equal(h.session.imageIds.size, 1); assert.equal(h.events.some(Array.isArray), false);
  h.control.fail = false; await h.persist(h.snapshot); assert.equal(h.state.read().documents.length, 1); assert.equal(h.tab.draftDocument, undefined);
});
test('card draft creates its own document/notebook and never adds a knowledge document', async () => {
  const h = content(true); h.tab.draftNotebook = { id: 'notebook', sourceDocumentId: 'note' }; h.session.notebookId = 'notebook';
  h.snapshot.editorMode = 'card'; await h.persist(h.snapshot);
  assert.equal(h.state.read().documents.length, 0); assert.equal(h.state.read().cardDocuments.length, 1);
  assert.equal(h.state.read().cardNotebooks[0].name, 'updated'); assert.equal(h.session.target.metadata.inlineCardCount, 1);
});
test('duplicate questions reject before writes; cleanup errors do not undo successful saves', async () => {
  const h = content(); h.snapshot.editorMode = 'card'; h.control.validation = 'duplicate';
  await assert.rejects(h.persist(h.snapshot), /duplicate/); assert.equal(h.events.includes('save'), false);
  h.control.validation = ''; h.control.cleanupFail = true; await h.persist(h.snapshot);
  assert.equal(h.session.target.title, 'updated'); assert.ok(h.events.some(event => typeof event === 'string' && event.includes('图片清理失败')));
});
test('stale content save does not update active editor chrome or snapshots', async () => {
  const h = content(); h.control.current = false; await h.persist(h.snapshot);
  assert.equal(h.session.savedSnapshot, undefined); assert.equal(h.events.includes('dirty'), false); assert.ok(h.events.includes('workspace'));
});
test('Quill transactions preserve user deltas, screenshot undo boundaries and final caret', () => {
  const calls = [];
  class Delta { constructor() { this.ops = []; } retain(n) { this.ops.push(['retain',n]); return this; } delete(n) { this.ops.push(['delete',n]); return this; } insert(...args) { this.ops.push(['insert',...args]); return this; } }
  const quill = { updateContents: (delta,source) => calls.push([delta.ops,source]), getModule: name => ({ cutoff: () => calls.push(name) }), focus: () => calls.push('focus'), setSelection: (...args) => calls.push(args) };
  const actions = createQuillTransactions(); actions.insertScreenshot(quill, Delta, { index: 3, length: 2 }, 'image', { imageId: 'id' });
  assert.deepEqual(calls, ['history', [[['retain',3],['delete',2],['insert',{ image: 'image' },{ imageId:'id' }],['insert','\n']], 'user'], 'history', 'focus', [5,0,'silent']]);
  calls.length = 0; actions.insertImage(quill, Delta, 1, 'image', {}); assert.equal(calls.length, 1); assert.equal(calls[0][1], 'user');
});
test('tab view routes real dataset IDs through close, activate and add handlers', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const calls = [], bar = { addEventListener() {} };
  const element = () => ({ setAttribute() {}, matches: () => false, remove() {}, contains: () => false });
  const platform = {
    window: { addEventListener() {} }, document: { createElement: element, body: { append() {} }, addEventListener() {}, querySelector: () => null },
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} }, requestFrame: () => 1, cancelFrame() {}
  };
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/views/note-tabs.js'), 'utf8'), context);
  const view = context.MemoKeepViews.createNoteTabView({ platform, $: () => bar, state: { batchPending: false }, actions: {
    closeTab: id => calls.push(['close',id]), activate: id => calls.push(['activate',id]), requestNew: (...args) => calls.push(['new',...args])
  } });
  view.bindNoteTabs();
  const close = { dataset: { closeNoteTab: 'draft-id' } };
  await bar.onclick({ target: { closest: selector => selector === '[data-close-note-tab]' ? close : null } });
  const tab = { dataset: { noteTab: 'note-id' } };
  await bar.onclick({ target: { closest: selector => selector === '[data-note-tab]' ? tab : null } });
  const add = {};
  await bar.onclick({ target: { closest: selector => selector === '#newNoteTabButton' ? add : null } });
  assert.deepEqual(calls, [['close','draft-id'],['activate','note-id'],['new',null,add]]);
});
test('tab drag uses only injected platform dimensions, scheduling and disposal', () => {
  const { createNoteTabView } = require('../web/views/note-tabs.js');
  const events = new Map(), documentEvents = new Map(), frames = new Map(), cancelled = [], observed = [], disconnected = [];
  const layer = { style: {}, setAttribute() {}, remove() { this.removed = true; } };
  const document = { createElement: () => layer, body: { append() {} },
    addEventListener: (type, handler) => documentEvents.set(type, handler), removeEventListener: type => documentEvents.delete(type) };
  const window = { innerHeight: 80, addEventListener: (type, handler) => events.set(type, handler), removeEventListener: type => events.delete(type) };
  const observer = name => class { constructor(callback) { this.callback = callback; } observe(node) { observed.push([name,node]); } disconnect() { disconnected.push(name); } };
  const bar = { hidden: false, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 0, right: 400, top: 50, bottom: 100 }),
    querySelector: selector => selector === '.note-tab-add' ? { getBoundingClientRect: () => ({ right: 100 }) } : null };
  const view = createNoteTabView({ state: {}, actions: {}, $() {}, platform: { window, document,
    ResizeObserver: observer('resize'), MutationObserver: observer('mutation'),
    requestFrame: callback => { frames.set(1,callback); return 1; }, cancelFrame: id => cancelled.push(id) } });
  view.bindNoteTabWindowDrag(bar); assert.equal(layer.className, 'note-window-drag-space');
  assert.equal(observed.length, 2); frames.get(1)();
  assert.deepEqual(layer.style, { left: '104px', top: '50px', width: '284px', height: '30px' });
  events.get('resize')(); events.get('pagehide')();
  assert.deepEqual(cancelled, [1]); assert.deepEqual(disconnected, ['resize','mutation']);
  assert.equal(events.has('resize'), false); assert.equal(documentEvents.size, 0); assert.equal(layer.removed, true);
});

const {quillHistoryFixture,Delta:RealDelta}=require('./quill-history-fixture.cjs');
test('Quill partial insertion rollback restores real Delta undo and redo execution',()=>{
 const f=quillHistoryFixture();f.apply(new RealDelta().retain(4).insert(' user'));f.history.cutoff();const before=f.contents();
 assert.throws(()=>createQuillTransactions().preserveOnFailure(f.quill,()=>{f.apply(new RealDelta().delete(2));f.apply(new RealDelta().insert({image:'temporary'}));throw Error('partial');}),/partial/);
 assert.deepEqual(f.contents().ops,before.ops);f.history.undo();assert.equal(f.contents().ops.map(op=>op.insert).join(''),'base\n');f.history.redo();assert.deepEqual(f.contents().ops,before.ops);
});
test('Quill pending DOM update must be drained before the rollback content snapshot',()=>{
 const f=quillHistoryFixture();f.pending(new RealDelta().retain(4).insert(' pending', {bold:true}));
 assert.throws(()=>createQuillTransactions().preserveOnFailure(f.quill,()=>{f.apply(new RealDelta().delete(2));throw Error('insertion failed');}),/insertion failed/);
 assert.deepEqual(f.contents().ops,new RealDelta().insert('base').insert(' pending',{bold:true}).insert('\n').ops);
 const restored=f.contents().ops.map(op=>op.insert).join('');f.history.undo();const undone=f.contents().ops.map(op=>op.insert).join('');f.history.redo();const redone=f.contents().ops.map(op=>op.insert).join('');
 assert.deepEqual({restored,undone,redone},{restored:'base pending\n',undone:'base\n',redone:'base pending\n'});
});

test('Quill insertion failure preserves an existing redo branch and executable undo history',()=>{
  const f=quillHistoryFixture();f.apply(new RealDelta().retain(4).insert(' first'));f.history.cutoff();
  f.apply(new RealDelta().retain(10).insert(' second'));f.history.cutoff();f.history.undo();
  const before=f.contents(),undo=[...f.history.stack.undo].map(row=>row.delta),redo=[...f.history.stack.redo].map(row=>row.delta);
  assert.throws(()=>createQuillTransactions().preserveOnFailure(f.quill,()=>{f.apply(new RealDelta().delete(1));throw Error('failed');}),/failed/);
  assert.deepEqual(f.contents().ops,before.ops);assert.deepEqual([...f.history.stack.undo].map(row=>row.delta),undo);assert.deepEqual([...f.history.stack.redo].map(row=>row.delta),redo);
  f.history.redo();assert.equal(f.contents().ops.map(op=>op.insert).join(''),'base first second\n');
  f.history.undo();assert.deepEqual(f.contents().ops,before.ops);f.history.undo();assert.equal(f.contents().ops.map(op=>op.insert).join(''),'base\n');
});

test('queued saves of the same new note keep one identity and the later explicit content',async()=>{
  const h=content(true),gate=deferred();let writes=0;h.control.onSave=async()=>{if(++writes===1)await gate.promise;};
  const a=h.persist(h.snapshot),b=h.persist({...h.snapshot,title:'later',content:'later content'});
  assert.equal(h.state.read().documents.length,0);gate.resolve();await a;await b;
  assert.equal(h.state.read().documents.length,1);assert.equal(h.state.read().documents[0].id,'note');assert.equal(h.state.read().documents[0].title,'later');
});
