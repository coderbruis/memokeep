const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const StateMerge = require('../web/state-merge.js');
const Search = require('../web/domain/content-search.js');
const { createStorageAdapter } = require('../web/persistence/storage-adapter.js');

function loadDesktop(respond = () => undefined) {
  const events = new EventEmitter();
  const calls = [];
  const window = {};
  const source = readFileSync(require.resolve('../apps/desktop/tauri-desktop.js'), 'utf8');
  runInNewContext(source.replace(/^import .*;\r?$/gm, ''), {
    StateMerge, Search, Error, console, window,
    async invoke(command, args) {
      const name = command.replace('plugin:memokeep-workspace|', '');
      if (name === 'record_status') return { enabled: false, isolated: false, revision: 8 };
      calls.push([name, structuredClone(args)]);
      return respond(name, args);
    },
    async listen(name, callback) {
      events.on(name, callback);
      return () => events.off(name, callback);
    },
    getCurrentWindow: () => ({
      async onCloseRequested(callback) { events.on('close', callback); },
      async destroy() { events.emit('destroy'); },
    }),
  });
  return { desktop: window.memoKeepDesktop, events, calls };
}

test('the desktop bridge skips full reads for a current revision and writes only affected fields', async () => {
  const original = { documents: [{ id: 'a', title: '旧笔记' }], settings: { theme: 'dark' }, obsolete: true };
  const next = { documents: [{ id: 'a', title: '新笔记' }], settings: original.settings, nullable: null };
  const patch = StateMerge.createDataPatch(original, next);
  const { desktop, calls } = loadDesktop((name, args) => {
    if (name === 'read') return { data: original, revision: 8 };
    if (name === 'read_fields') return { data: Object.fromEntries(args.fields.filter(key => Object.hasOwn(original, key)).map(key => [key, original[key]])), revision: 8 };
    assert.equal(name, 'write_fields');
    return 9;
  });
  const storage = createStorageAdapter({ desktop });
  assert.equal(storage.supportsPatches, true);
  assert.deepEqual(structuredClone(await storage.readChanges(8)), { patch: { fields: [] }, token: 8 });
  assert.deepEqual(structuredClone(await storage.readChanges(7)), { data: original, token: 8 });
  assert.deepEqual(structuredClone(await storage.writeChanges(patch, 8)), { patch, token: 9 });
  assert.deepEqual(calls, [
    ['read_fields', { fields: [] }], ['read_fields', { fields: [] }], ['read', { scope: 'desktop' }],
    ['read_fields', { fields: ['documents', 'obsolete', 'nullable'] }],
    ['write_fields', { expectedRevision: 8, updated: { documents: next.documents, nullable: null }, removed: ['obsolete'] }],
  ]);
});

test('a stale write retries against the most recent snapshot and preserves other changes', async () => {
  const original = { documents: [{ id: 'a', title: '旧笔记' }] };
  const next = { documents: [{ id: 'a', title: '新笔记' }] };
  const concurrent = { ...original, settings: { theme: 'dark' } };
  let revision = 8;
  const { desktop, calls } = loadDesktop((name, args) => {
    if (name === 'read') return { revision, data: concurrent };
    if (name === 'read_fields') return { revision, data: original };
    if (args.expectedRevision === 8) {
      revision = 9;
      throw { code: 'STALE_REVISION' };
    }
    return 10;
  });
  const expected = { ...next, settings: concurrent.settings };
  assert.deepEqual(structuredClone(await desktop.writeChanges(StateMerge.createDataPatch(original, next), 8)), { data: expected, token: 10 });
  assert.deepEqual(calls.filter(([name]) => name === 'write_fields').map(([, args]) => args.expectedRevision), [8, 9]);
});

test('a failed full write can retry with its original baseline', async () => {
  const original = { documents: [{ id: 'a', title: '旧笔记' }] };
  const candidate = { documents: [{ id: 'a', title: '新笔记' }] };
  const concurrent = { documents: [...original.documents, { id: 'b', title: '另一窗口的笔记' }] };
  let fail = true;
  const { desktop, calls } = loadDesktop(name => {
    if (name === 'read') return { data: fail ? original : concurrent, revision: fail ? 1 : 2 };
    if (fail) throw new Error('disk full');
    return 3;
  });
  const storage = createStorageAdapter({ desktop });
  const baseline = await storage.read();
  await assert.rejects(storage.write(candidate, baseline), /disk full/);
  fail = false;
  const merged = { documents: [...candidate.documents, concurrent.documents[1]] };
  assert.deepEqual(structuredClone(await storage.write(candidate, baseline)), merged);
  assert.deepEqual(calls.at(-1), ['write', { scope: 'desktop', data: merged, expectedRevision: 2 }]);
});

test('the desktop bridge prevents implicit close and cleans up change subscriptions', async () => {
  const { desktop, events } = loadDesktop();
  const close = [];
  await desktop.onRequestClose(value => close.push(value));
  events.emit('close', { preventDefault: () => close.push('prevented') });
  assert.deepEqual(close, ['prevented', false]);
  events.on('destroy', () => close.push('destroyed'));
  await desktop.confirmClose();
  assert.equal(close.at(-1), 'destroyed');

  let seen = 0;
  const release = desktop.onDataChanged(() => { seen++; });
  events.emit('workspace-changed');
  release();
  release();
  events.emit('workspace-changed');
  await Promise.resolve();
  assert.equal(seen, 1);
  assert.equal(events.listenerCount('workspace-changed'), 0);
});
