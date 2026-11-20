const test = require('node:test');
const assert = require('node:assert/strict');
const { recordFixture } = require('./fixtures/record-save.cjs');
const { createStorageAdapter } = require('../web/persistence/storage-adapter.js');

test('a known unchanged record revision returns only the revision without fetching its body', async () => {
  const h = recordFixture({ count: 2 });
  const result = await h.storage.readNoteRecord('documents', 'note-0', 1);
  assert.deepEqual({ ...result }, { unchanged: true, revision: 1 });
  assert.ok(!Object.hasOwn(result, 'record'));
  assert.deepEqual(h.calls.map(row => row.name), ['record_status', 'read_fields']);
  assert.deepEqual(h.calls.at(-1).args.fields, []);
  assert.ok(h.calls.at(-1).responseBytes < 100);
});

test('an unknown revision always reads the requested record, including deleted records', async () => {
  const h = recordFixture({ count: 2 });
  for (const token of [undefined, null]) {
    const selected = await h.storage.readNoteRecord('documents', 'note-0', token);
    assert.equal(selected.record.id, 'note-0');
    assert.equal(selected.revision, 1);
    assert.equal(h.calls.at(-1).name, 'read_records');
  }
  const missing = await h.storage.readNoteRecord('documents', 'deleted', null);
  assert.equal(missing.record, null);
  assert.equal(h.calls.filter(row => row.name === 'read_fields').length, 0);
});

test('a stale token reads the record on its own current snapshot even if another commit intervenes', async () => {
  const h = recordFixture({ count: 2, beforeRead({ name, remote, bump }) {
    if (name === 'read_fields' || name === 'read_records') {
      remote.documents[0].title = `remote revision ${bump()}`;
    }
  } });
  const selected = await h.storage.readNoteRecord('documents', 'note-0', 1);
  assert.equal(selected.record.title, 'remote revision 3');
  assert.equal(selected.revision, 3);
  assert.ok(!selected.unchanged);
  assert.deepEqual(h.calls.map(row => row.name), ['record_status', 'read_fields', 'read_records']);
});

test('conditional reads never cache revision checks or restore an invalidated caller token', async () => {
  let h, invalidated = false;
  h = recordFixture({ count: 2, afterRead({ name, remote, bump }) {
    if (name !== 'read_fields' || invalidated) return;
    invalidated = true;
    remote.documents[0].title = 'commit after the revision check'; bump();
    h.state.token = null; // Simulate workspace-changed arriving while the response is in flight.
  } });
  const checked = await h.storage.readNoteRecord('documents', 'note-0', h.state.token);
  assert.equal(checked.unchanged, true);
  assert.equal(checked.revision, 1);
  assert.equal(h.state.token, null);
  const current = await h.storage.readNoteRecord('documents', 'note-0', h.state.token);
  assert.equal(current.record.title, 'commit after the revision check');
  assert.equal(current.revision, 2);
  const checkedAgain = await h.storage.readNoteRecord('documents', 'note-0', 2);
  assert.equal(checkedAgain.unchanged, true);
  assert.equal(h.calls.filter(row => row.name === 'read_fields').length, 2);
  assert.equal(h.calls.filter(row => row.name === 'read_records').length, 1);
});

test('v3 repeated note selection keeps its zero-IPC path for known and unknown revisions', async () => {
  const h = recordFixture({ count: 1000, enabled: false });
  await h.desktop.read();
  const initialCalls = h.calls.length;
  for (let index = 0; index < 100; index++) {
    assert.equal(await h.storage.readNoteRecord('documents', `note-${index}`, index % 2 ? null : 1), null);
  }
  assert.equal(h.calls.length, initialCalls);
  assert.equal(h.calls.filter(row => row.name === 'record_status').length, 1);
});

test('revision check failures remain retryable and never report unchanged success', async () => {
  let fail = true;
  const h = recordFixture({ count: 2, beforeRead({ name }) {
    if (name === 'read_fields' && fail) { fail = false; throw new Error('synthetic read failure'); }
  } });
  await assert.rejects(h.storage.readNoteRecord('documents', 'note-0', 1), /synthetic read failure/);
  assert.equal((await h.storage.readNoteRecord('documents', 'note-0', 1)).unchanged, true);
  assert.equal(h.calls.filter(row => row.name === 'read_records').length, 0);
});

test('the adapter forwards the caller revision without converting an unknown revision', async () => {
  const requests = [];
  const storage = createStorageAdapter({ desktop: {
    readNoteRecord(...args) { requests.push(args); return { unchanged: true, revision: args[2] }; },
  } });
  assert.equal((await storage.readNoteRecord('cardDocuments', 'card-note', 9)).revision, 9);
  await storage.readNoteRecord('documents', 'note');
  assert.deepEqual(requests, [['cardDocuments', 'card-note', 9], ['documents', 'note', undefined]]);
});
