const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');
const DirectoryTree = require('../web/directory-tree.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function factory(file, name) {
  const context = { structuredClone };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), context);
  return context.MemoKeepShell[name];
}

function navigation() {
  const documents = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id, knowledgeBaseId: 'folder', content: id, metadata: {} }));
  const data = { documents, cardDocuments: [], knowledgeBases: [{ id: 'folder', name: '合成目录' }] };
  const state = { persistence: { data, persistedData: structuredClone(data), sharedDataToken: 1 },
    editor: { editingMarkdownDocumentId: 'a', editingCardNotebookId: null }, knowledge: { collapsedLibraryIds: new Set() } };
  const events = [], reads = [], control = { dirty: false, form: {}, save: async () => true };
  const classes = new Set();
  const view = { scrollTop: 0, classList: { contains: name => classes.has(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } } };
  const actions = {
    documentById: id => state.persistence.data.documents.find(row => row.id === id),
    syncSidebarSelection() {}, updateNoteWindowTitle() {}, saveCollapsedLibraryIds() { events.push('collapse-save'); },
    renderSidebarKnowledgeTree() { events.push('tree'); }, showToast(message) { events.push(message); },
    showView() { events.push('mount:' + state.editor.editingMarkdownDocumentId); control.form = {}; }
  };
  state.editor.activeNoteEditorHasChanges = () => control.dirty;
  const env = { openNoteTabs: [{ id: 'a' }], noteTabActionPending: false, MemoKeepDirectoryTree: DirectoryTree, noteDraftTab: () => control.draft,
    rememberNoteTab(document) { if (!env.openNoteTabs.some(tab => tab.id === document?.id)) env.openNoteTabs.push({ id: document?.id }); },
    application: { views: { tabs: { renderNoteTabs() {} } }, cards: { runtime: {} },
      editor: { session: {
        async saveNoteBeforeTabChange() { events.push('save'); return control.save(); },
        resetActiveNoteEditor() { events.push('reset'); state.editor.editingMarkdownDocumentId = null; }
      } }, persistence: { storage: { async readNoteRecord(...args) {
        reads.push(args); return control.read ? control.read(...args) : { unchanged: true, revision: 1 };
      } } } }
  };
  const config = { $: selector => selector === '#librariesView' ? view : control.form,
    $$: () => [{ id: 'librariesView', classList: view.classList }] };
  const api = factory('../web/shell/notebooks.js', 'createNotebooks')({ state, config, actions, env });
  return { ...api, state, env, events, reads, control, actions, view, note: id => actions.documentById(id) };
}

test('clicking the current note preserves the mounted editor without reading or saving', async () => {
  const h = navigation(), form = h.control.form;
  h.control.dirty = true;
  assert.equal(await h.openMarkdownNoteEditor(h.note('a')), true);
  assert.equal(h.control.form, form); assert.deepEqual(h.events, []); assert.equal(h.reads.length, 0);
});

test('rapid clicks retain the last destination and never mount obsolete reads', async () => {
  const h = navigation(), gate = deferred();
  h.control.read = async (_collection, id) => { if (id === 'b') await gate.promise; return { unchanged: true, revision: 1 }; };
  const b = h.openMarkdownNoteEditor(h.note('b')); await turn();
  const c = h.openMarkdownNoteEditor(h.note('c')), d = h.openMarkdownNoteEditor(h.note('d'));
  gate.resolve();
  assert.deepEqual(await Promise.all([b, c, d]), [false, false, true]);
  assert.equal(h.state.editor.editingMarkdownDocumentId, 'd');
  assert.deepEqual(h.events.filter(event => event.startsWith('mount:')), ['mount:d']);
  assert.deepEqual(h.reads.map(row => row[1]), ['b', 'd']);
  assert.equal(h.env.noteTabActionPending, false);
});

test('queued destinations share the original save and a failed save preserves every draft', async () => {
  for (const success of [true, false]) {
    const h = navigation(), gate = deferred(), form = h.control.form;
    h.control.dirty = true;
    h.control.save = async () => { await gate.promise; if (success) h.control.dirty = false; return success; };
    const b = h.openMarkdownNoteEditor(h.note('b')); await turn();
    const d = h.openMarkdownNoteEditor(h.note('d')); gate.resolve();
    assert.deepEqual(await Promise.all([b, d]), success ? [false, true] : [false, false]);
    assert.equal(h.events.filter(event => event === 'save').length, 1);
    if (!success) { assert.equal(h.control.form, form); assert.equal(h.state.editor.editingMarkdownDocumentId, 'a'); assert.equal(h.reads.length, 0); }
  }
});

test('clicking back to the original note cancels a pending destination without resetting it', async () => {
  const h = navigation(), gate = deferred(), form = h.control.form;
  h.control.read = async () => { await gate.promise; return { unchanged: true, revision: 1 }; };
  const b = h.openMarkdownNoteEditor(h.note('b')); await turn();
  const a = h.openMarkdownNoteEditor(h.note('a')); gate.resolve();
  assert.deepEqual(await Promise.all([b, a]), [false, true]);
  assert.equal(h.control.form, form); assert.ok(!h.events.includes('reset'));
});

test('input made while a record is loading is saved before disposal or preserved after failure', async () => {
  for (const success of [true, false]) {
    const h = navigation(), gate = deferred(), form = h.control.form;
    let reads = 0;
    h.control.read = async () => { if (++reads === 1) await gate.promise; return { unchanged: true, revision: 1 }; };
    h.control.save = async () => { if (success) h.control.dirty = false; return success; };
    const pending = h.openMarkdownNoteEditor(h.note('b')); await turn();
    h.control.dirty = true; gate.resolve();
    assert.equal(await pending, success);
    assert.equal(h.events.filter(row => row === 'save').length, 1);
    if (success) { assert.equal(reads, 2); assert.equal(h.state.editor.editingMarkdownDocumentId, 'b'); }
    else { assert.equal(h.control.form, form); assert.equal(h.state.editor.editingMarkdownDocumentId, 'a'); }
  }
});

test('a dirty draft is recaptured after the read without looping or publishing it', async () => {
  const h = navigation(), gate = deferred();
  h.control.draft = { draftDocument: { id: 'a', content: '' } }; h.control.dirty = true;
  h.control.save = async () => { h.control.draft.draftDocument.content = h.control.text; return true; };
  h.control.read = async () => { await gate.promise; return null; };
  h.control.text = 'before';
  const pending = h.openMarkdownNoteEditor(h.note('b')); await turn();
  h.control.text = 'latest unsaved draft'; gate.resolve();
  assert.equal(await pending, true);
  assert.equal(h.control.draft.draftDocument.content, 'latest unsaved draft');
  assert.equal(h.reads.length, 1); assert.equal(h.events.filter(row => row === 'save').length, 2);
});

test('a superseded failed read cannot discard the newest destination', async () => {
  const h = navigation(), gate = deferred();
  h.control.read = async (_collection, id) => { if (id === 'b') { await gate.promise; throw new Error('obsolete read failed'); } return null; };
  const b = h.openMarkdownNoteEditor(h.note('b')); await turn();
  const d = h.openMarkdownNoteEditor(h.note('d')); gate.resolve();
  assert.deepEqual(await Promise.all([b, d]), [false, true]);
  assert.equal(h.state.editor.editingMarkdownDocumentId, 'd');
  assert.deepEqual(h.events.filter(event => event.startsWith('mount:')), ['mount:d']);
});

test('an invalidated conditional-read token forces a record read and never revives the old token', async () => {
  const h = navigation();
  h.control.read = async (_collection, id, token) => {
    if (token === 1) { h.state.persistence.sharedDataToken = null; return { unchanged: true, revision: 1 }; }
    return { revision: 2, record: { ...h.note(id), title: '远端最新标题' } };
  };
  assert.equal(await h.openMarkdownNoteEditor(h.note('b')), true);
  assert.equal(h.reads.length, 2); assert.equal(h.reads[1][2], undefined);
  assert.equal(h.note('b').title, '远端最新标题'); assert.equal(h.state.persistence.sharedDataToken, null);
});

test('unchanged snapshots and v3 fallbacks keep collection identity and directory nodes', async () => {
  for (const selected of [null, { unchanged: true, revision: 1 }]) {
    const h = navigation(), data = h.state.persistence.data, baseline = h.state.persistence.persistedData;
    h.control.read = async () => selected;
    assert.equal(await h.openMarkdownNoteEditor(h.note('b')), true);
    assert.equal(h.state.persistence.data, data); assert.equal(h.state.persistence.persistedData, baseline);
    assert.ok(!h.events.includes('tree')); assert.ok(!h.events.includes('collapse-save'));
  }
});

test('opening a collapsed destination expands only its path and refreshes the directory once', async () => {
  const h = navigation(); h.state.knowledge.collapsedLibraryIds.add('folder');
  assert.equal(await h.openMarkdownNoteEditor(h.note('b')), true);
  assert.equal(h.state.knowledge.collapsedLibraryIds.has('folder'), false);
  assert.equal(h.events.filter(event => event === 'tree').length, 1);
  assert.equal(h.events.filter(event => event === 'collapse-save').length, 1);
});

test('failed reads preserve the current editor and release navigation for a retry', async () => {
  const h = navigation(), form = h.control.form;
  h.control.read = async () => { throw new Error('isolated read failed'); };
  assert.equal(await h.openMarkdownNoteEditor(h.note('b')), false);
  assert.equal(h.control.form, form); assert.equal(h.env.noteTabActionPending, false);
  h.control.read = async () => null;
  assert.equal(await h.openMarkdownNoteEditor(h.note('c')), true);
});

test('directory DOM survives body/history and selection edits but updates names and structure', () => {
  const window = domino.createWindow('<div class="knowledge-nav-group"><div id="knowledgeTree"></div></div>');
  const tree = window.document.querySelector('#knowledgeTree');
  const state = { persistence: { applicationDataReady: true, data: {
    knowledgeBases: [{ id: 'folder', name: '目录' }], documents: [{ id: 'a', knowledgeBaseId: 'folder', title: '笔记A', metadata: {} }, { id: 'b', knowledgeBaseId: 'folder', title: '笔记B', metadata: {} }]
  } }, editor: { editingMarkdownDocumentId: 'a' }, knowledge: { startCollapsedApplied: true, collapsedLibraryIds: new Set() } };
  const actions = { escapeHtml: value => String(value), syncSidebarSelection() {
    for (const row of tree.querySelectorAll('[data-tree-document]')) row.classList.toggle('active', row.getAttribute('data-tree-document') === state.editor.editingMarkdownDocumentId);
  } };
  const env = { MemoKeepDirectoryTree: DirectoryTree, renderSidebarNoteTags() {}, updateSidebarDirectoryToggle() {}, noteFileIcon: () => '<i></i>', queueMicrotask() {} };
  const { renderSidebarKnowledgeTree } = factory('../web/shell/knowledge.js', 'createKnowledge')({ state, actions, env, config: { $: selector => window.document.querySelector(selector) } });
  renderSidebarKnowledgeTree(); const original = tree.firstElementChild;
  state.persistence.data.documents[0].metadata = { noteContent: '大正文'.repeat(10000), versions: [{ content: '历史' }] };
  state.editor.editingMarkdownDocumentId = 'b'; renderSidebarKnowledgeTree();
  assert.equal(tree.firstElementChild, original); assert.equal(tree.querySelector('.tree-document.active').getAttribute('data-tree-document'), 'b');
  state.persistence.data.documents[1].title = '重命名'; renderSidebarKnowledgeTree();
  assert.notEqual(tree.firstElementChild, original); assert.ok(tree.textContent.includes('重命名'));
  state.knowledge.collapsedLibraryIds.add('folder'); renderSidebarKnowledgeTree(); assert.ok(!tree.querySelector('[data-tree-document]'));
  state.knowledge.collapsedLibraryIds.delete('folder'); renderSidebarKnowledgeTree(); assert.equal(tree.querySelectorAll('[data-tree-document]').length, 2);
});
