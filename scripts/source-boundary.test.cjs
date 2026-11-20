const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPublicFile } = require('./verify-source.cjs');

test('private synchronization channels and providers cannot enter public runtime source', () => {
  assert.throws(() => assertPublicFile('apps/desktop/tauri-desktop.js', "invoke('sync:create-pairing')"), /Private IPC/);
  assert.throws(() => assertPublicFile('web/app.js', "require('../features/sync/service.cjs')"), /Private module/);
  assert.throws(() => assertPublicFile('modules/editions/current/plugins.js', "[{feature: 'sync.lan'}]"), /Private plugin/);
  assert.throws(() => assertPublicFile('modules/editions/current/plugins.js', "[{feature: 'sync.icloud'}]"), /Private plugin/);
});

test('generic committed-data interfaces remain available to independent public builds', () => {
  assert.throws(() => assertPublicFile('modules/core/data-transactions.cjs', 'const api = { addCommitParticipant, onCommitted };'), /Retired Node/);
  assert.doesNotThrow(() => assertPublicFile('scripts/fixtures/host-adapter.cjs', 'const api = { addCommitParticipant, onCommitted };'));
  assert.throws(() => assertPublicFile('web/bridge.js', "require('../scripts/legacy-import/backup.cjs')"), /Development compatibility/);
  assert.doesNotThrow(() => assertPublicFile('apps/desktop/export-legacy-workspace.cjs', "require('../../scripts/legacy-import/backup.cjs')"));
});
