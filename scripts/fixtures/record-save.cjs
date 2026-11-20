// Synthetic IPC endpoint for the actual desktop bridge and save coordinator; no real workspace.
const fs = require('node:fs');
const vm = require('node:vm');
const StateMerge = require('../../web/state-merge.js');
const Search = require('../../web/domain/content-search.js');
const { createStorageAdapter } = require('../../web/persistence/storage-adapter.js');
const { createSaveCoordinator } = require('../../web/persistence/save-coordinator.js');
const copy = value => structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value) || 'null');

function syntheticData(count = 1000) {
  const content = '合成基准正文，不是真实笔记。'.repeat(160);
  return { documents: Array.from({ length: count }, (_, index) => ({ id: `note-${index}`, title: `笔记 ${index}`, content,
    metadata: { versions: [], noteContent: '<p>synthetic</p>' }, updatedAt: '2026-11-19T12:00:00Z' })),
    cardDocuments: [], cards: [], reviewRecords: [], settings: {} };
}

function recordFixture({ count = 1000, enabled = true, beforeWrite, beforeRead, afterRead, failWrite = false } = {}) {
  let remote = syntheticData(count), revision = 1, failed = failWrite;
  const state = { ready: true, data: copy(remote), baseline: copy(remote), token: revision, saving: false };
  const calls = [], errors = [], window = {};
  const source = fs.readFileSync(require.resolve('../../apps/desktop/tauri-desktop.js'), 'utf8').replace(/^import .*;\r?$/gm, '');
  vm.runInNewContext(source, { window, StateMerge, Search, console, Error,
    getCurrentWindow: () => ({ label: 'main' }), listen: async () => () => {},
    async invoke(command, args) {
      const name = command.split('|')[1], request = copy(args), call = { name, requestBytes: bytes(args), args: request };
      calls.push(call);
      const reading = ['read', 'read_fields', 'read_records'].includes(name);
      if (reading) await beforeRead?.({ name, args: request, remote, revision, bump: () => ++revision });
      let result;
      if (name === 'record_status') result = { enabled, isolated: false, revision };
      else if (name === 'read') result = { revision, data: remote };
      else if (name === 'read_fields') result = { revision, data: Object.fromEntries(args.fields.filter(key => Object.hasOwn(remote, key)).map(key => [key, remote[key]])) };
      else if (name === 'read_records') result = { revision, data: Object.fromEntries(args.requests.map(row => [row.field,
        remote[row.field].filter(value => row.changes.some(change => change.id === value.id))])) };
      else if (name === 'note_summaries') result = { revision, total: remote[args.collection].length,
        rows: remote[args.collection].slice(args.offset, args.offset + args.limit).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) };
      else if (name === 'write_records' || name === 'write_fields') {
        await beforeWrite?.({ name, remote, revision, bump: () => ++revision });
        if (failed) { failed = false; throw new Error('synthetic disk full'); }
        if (args.expectedRevision !== revision) throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
        for (const row of args.records || []) {
          const values = new Map(remote[row.field].map(value => [value.id, value]));
          for (const change of row.changes) { if (change.value === null) values.delete(change.id); else values.set(change.id, change.value); }
          remote[row.field] = [...values.values()];
        }
        Object.assign(remote, args.updated); for (const field of args.removed) delete remote[field];
        result = ++revision;
      } else throw new Error('unexpected synthetic IPC ' + name);
      call.responseBytes = bytes(result);
      const response = copy(result);
      if (reading) await afterRead?.({ name, args: request, remote, revision, bump: () => ++revision });
      return response;
    },
  });
  const storage = createStorageAdapter({ desktop: window.memoKeepDesktop });
  const saving = createSaveCoordinator({ state, storage, normalize: copy, patches: StateMerge,
    refresh: async () => {}, onError: error => errors.push(error.message), onSyncError: error => errors.push(error.message) });
  return { state, calls, errors, storage, saving, desktop: window.memoKeepDesktop, remote: () => remote, revision: () => revision };
}

module.exports = { recordFixture, syntheticData, bytes };
