const test = require('node:test');
const assert = require('node:assert/strict');
const { recordFixture } = require('./fixtures/record-save.cjs');
const deferred = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve: () => resolve() }; };

test('actual note save path transfers only the affected record and shares every unaffected body', async () => {
  const h = recordFixture(), original = h.state.data.documents[500];
  await h.saving.transactNote(data => { data.documents[0].title = 'changed'; data.documents[0].metadata.versions.push({ title: 'previous' }); });
  assert.equal(h.remote().documents[0].title, 'changed'); assert.equal(h.state.data.documents[0].metadata.versions.length, 1);
  assert.equal(h.state.data.documents[500], original);
  assert.deepEqual(h.calls.map(row => row.name), ['record_status', 'read_records', 'write_records']);
  assert.equal(h.calls.find(row => row.name === 'write_records').args.records[0].changes.length, 1);
  assert.ok(h.calls.reduce((sum, row) => sum + row.requestBytes + row.responseBytes, 0) < 25000);
});

test('a declined or failed record draft never mutates the committed owner and a later retry succeeds', async () => {
  const h = recordFixture({ count: 2, failWrite: true }), original = structuredClone(h.state.data);
  await h.saving.transactNote(data => { data.documents[0].title = 'declined'; return false; });
  assert.deepEqual(h.state.data, original); assert.equal(h.calls.length, 0);
  await assert.rejects(h.saving.transactNote(data => { data.documents[0].title = 'failed'; }), /disk full/);
  assert.deepEqual(h.state.data, original); assert.deepEqual(h.state.baseline, original);
  await h.saving.transactNote(data => { data.documents[0].title = 'retry'; });
  assert.equal(h.state.data.documents[0].title, 'retry');
});

test('record copy-on-write supports map filter nested metadata and source-card edits without proxy leaks', async () => {
  const h = recordFixture({ count: 4 });
  h.state.data.cards = [{ id: 'card', frontText: 'old' }]; h.state.baseline.cards = [{ id: 'card', frontText: 'old' }]; h.remote().cards = [{ id: 'card', frontText: 'old' }];
  await h.saving.transactNote(data => {
    data.documents = data.documents.map(row => row.id === 'note-0' ? { ...row, metadata: { ...row.metadata, custom: ['new'] } } : row).filter(row => row.id !== 'note-3');
    data.cards[0].frontText = 'new source';
  });
  assert.doesNotThrow(() => structuredClone(h.state.data));
  assert.equal(h.state.data.documents.length, 3); assert.equal(h.state.data.cards[0].frontText, 'new source');
  assert.deepEqual(h.state.data.documents[0].metadata.custom, ['new']);
});

test('concurrent writes merge on current record data, invalidate the full token and retain other notes', async () => {
  let bumped = false;
  const h = recordFixture({ count: 2, beforeWrite({ remote, bump }) { if (!bumped) { bumped = true; remote.documents[0].metadata.remote = true; remote.documents[1].title = 'remote second'; bump(); } } });
  await h.saving.transactNote(data => { data.documents[0].title = 'local title'; });
  assert.equal(h.state.data.documents[0].metadata.remote, true);
  assert.equal(h.remote().documents[1].title, 'remote second');
  assert.equal(h.state.token, null); assert.equal(h.state.refreshPending, true);
  assert.equal(h.calls.filter(row => row.name === 'write_records').length, 2);
});

test('edits made while awaiting persistence stay unsaved and a same-value next request persists them', async () => {
  const gate = deferred(), entered = deferred(); let wait = true;
  const h = recordFixture({ count: 2, async beforeWrite() { if (wait) { entered.resolve(); await gate.promise; } } });
  const pending = h.saving.transactNote(data => { data.documents[0].title = 'first'; }); await entered.promise;
  h.state.data.documents[0].title = 'typing after save started'; h.state.data.documents[1].content = 'other local edit';
  gate.resolve(); await pending;
  assert.equal(h.state.baseline.documents[0].title, 'first'); assert.equal(h.state.data.documents[0].title, 'typing after save started');
  assert.equal(h.state.data.documents[1].content, 'other local edit');
  wait = false;
  await h.saving.transactNote(data => { data.documents[0].title = 'typing after save started'; });
  assert.equal(h.remote().documents[0].title, 'typing after save started');
});

test('conflicting remote edits preserve the original owner and baseline without publishing a failed candidate', async () => {
  let bumped = false;
  const h = recordFixture({ count: 2, beforeWrite({ remote, bump }) { if (!bumped) { bumped = true; remote.documents[0].title = 'other window'; bump(); } } });
  const original = structuredClone(h.state.data);
  await assert.rejects(h.saving.transactNote(data => { data.documents[0].title = 'my conflicting title'; }), /其他窗口/);
  assert.deepEqual(h.state.data, original); assert.deepEqual(h.state.baseline, original);
  assert.equal(h.state.token, 1); assert.equal(h.remote().documents[0].title, 'other window');
});

test('the note transaction queue never resurrects a failed earlier edit', async () => {
  const h = recordFixture({ count: 2, failWrite: true });
  const first = h.saving.transactNote(data => { data.documents[0].title = 'failed first'; });
  const second = h.saving.transactNote(data => { data.documents[0].content = 'successful second'; });
  await assert.rejects(first, /disk full/); await second;
  assert.equal(h.remote().documents[0].title, '笔记 0'); assert.equal(h.remote().documents[0].content, 'successful second');
});

test('paged summaries exclude bodies and only selected editor records are hydrated', async () => {
  const h = recordFixture({ count: 1000 });
  const page = await h.storage.listNoteSummaries('documents', 20, 3);
  assert.equal(page.rows.length, 3); assert.equal(page.rows[0].id, 'note-20'); assert.ok(!JSON.stringify(page).includes('合成基准正文'));
  const selected = await h.storage.readNoteRecord('documents', 'note-333');
  assert.equal(selected.record.id, 'note-333');
  assert.equal(h.calls.at(-1).name, 'read_records');
});

test('the real source-learning hook retains a plain source snapshot inside a record transaction', async () => {
  const Source = require('../web/domain/source-learning.js'), h = recordFixture({ count: 2 });
  for (const data of [h.state.data, h.state.baseline, h.remote()]) {
    data.documents[0].metadata = { sourceBlocks: [{ id: 'block', text: 'before', type: 'p' }], sourceVersion: 1 };
    data.items = [{ id: 'item', documentId: 'note-0' }];
    data.cards = [{ id: 'card', knowledgeItemId: 'item', answer: 'before', source: { documentId: 'note-0', blockId: 'block', blockText: 'before', quote: 'before' } }];
    data.sourceChanges = [];
  }
  await h.saving.transactNote(data => {
    const note = data.documents[0]; note.content = 'after';
    Source.syncSourceChanges(data, note, [{ text: 'after', type: 'p' }], () => 'source-change');
  });
  assert.equal(h.state.data.sourceChanges[0].oldText, 'before');
  assert.equal(h.state.data.sourceChanges[0].newText, 'after');
  assert.doesNotThrow(() => structuredClone(h.state.data.sourceChanges[0].source));
  assert.equal(h.remote().cards[0].answer, 'before');
  assert.equal(h.remote().documents[0].content, 'after');
});

test('real note persist materializes repeatedly replaced metadata and old history without copying untouched notes', async () => {
  const { createNoteContentTransaction } = require('../web/editor/content-transactions.js');
  const Source = require('../web/domain/source-learning.js'), h = recordFixture({ count: 3 });
  for (const data of [h.state.data, h.state.baseline, h.remote()]) {
    data.documents[0].metadata = { editorMode: 'note', noteContent: '<p>before</p>', noteContentInitialized: true,
      versions: [{ title: 'older A', content: 'older A', noteContent: '<p>older A</p>', editorMode: 'note' },
        { title: 'older B', content: 'older B', noteContent: '<p>older B</p>', editorMode: 'note' }],
      inlineTagRows: [{ itemId: 'retained-row', tags: ['retained-tag'] }], sourceBlocks: [{ id: 'block', text: 'before', type: 'p' }], sourceVersion: 1 };
    data.items = []; data.cardNotebooks = [];
  }
  const untouched = h.state.data.documents[1], untouchedMetadata = untouched.metadata;
  const session = { target: h.state.data.documents[0], libraryId: 'library', notebookId: null, imageIds: new Set(),
    activeId: 'note-0', tabs: [{ id: 'note-0' }] };
  let uid = 0;
  const transaction = createNoteContentTransaction({ state: {}, session, services: {
    draft: () => null, transactNote: change => h.saving.transactNote(change),
    documentById: id => h.state.data.documents.find(row => row.id === id), imageIdsFromContent: () => [],
    versionLimit: 5, versionFromDocument: row => ({ savedAt: row.updatedAt, title: row.title, content: row.content,
      editorMode: row.metadata.editorMode, noteContent: row.metadata.noteContent, noteContentInitialized: row.metadata.noteContentInitialized,
      inlineTagRows: row.metadata.inlineTagRows }),
    snapshotsMatch: (left, right) => ['title', 'content', 'editorMode', 'noteContent', 'noteContentInitialized'].every(key => left[key] === right[key]),
    normalizeTagIds: values => [...values], syncInlineCards() {},
    syncCardSources(data, note) { Source.syncSourceChanges(data, note, [{ text: note.content, type: 'p' }], () => `source-${++uid}`); },
    isCurrent: () => true,
  }, view: { setDocumentId() {}, refreshSaveState() {}, renderVersionMenu() {}, renderSidebar() {}, renderCards() {} } });
  for (const text of ['first actual save', 'second actual save']) {
    await transaction.persist({ title: text, content: text, tagIds: [], editorMode: 'note', noteContent: `<p>${text}</p>`,
      noteContentInitialized: true, inlineTagRows: [{ itemId: 'retained-row', tags: ['retained-tag'] }] });
    assert.doesNotThrow(() => structuredClone(h.state.data.documents[0]));
    assert.equal(h.state.data.documents[1], untouched); assert.equal(h.state.data.documents[1].metadata, untouchedMetadata);
  }
  const saved = h.remote().documents[0];
  assert.equal(saved.title, 'second actual save'); assert.equal(saved.metadata.versions.length, 4);
  assert.equal(saved.metadata.versions[0].title, 'first actual save');
  assert.equal(saved.metadata.versions[2].title, 'older A');
  assert.equal(saved.metadata.versions[3].title, 'older B');
  assert.equal(saved.metadata.sourceBlocks[0].text, 'second actual save');
  assert.deepEqual(saved.metadata.versions[0].inlineTagRows, [{ itemId: 'retained-row', tags: ['retained-tag'] }]);
});
