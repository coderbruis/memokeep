const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createStorageAdapter } = require('../web/persistence/storage-adapter.js');
const { createSaveCoordinator } = require('../web/persistence/save-coordinator.js');
const { createSyncCoordinator } = require('../web/persistence/sync-coordinator.js');
const patches = require('../web/state-merge.js');
const clone = structuredClone;
const seed = () => ({ version: 2, documents: [{ id: 'note', title: 'saved', content: 'body' }], cards: [], reviewRecords: [], settings: { selectionCardPopupEnabled: true } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('domain fact factories run after the queued mutation and reach the desktop patch write', async () => {
  const current = seed();
  const state = { data: clone(current), baseline: clone(current), ready: true, token: 1 };
  let event, received;
  const storage = { supportsPatches: true, async writeChanges(patch, token, facts) {
    received = { patch, token, facts };
    return { data: patches.applyDataPatch(current, patch), token: 2 };
  } };
  const saving = createSaveCoordinator({ state, storage, normalize: clone, patches, onError: error => { throw error; }, onSyncError() {} });
  await saving.transact(data => { data.documents[0].title = 'new title'; event = { kind: 'note.updated', id: 'note' }; },
    () => ({ commandId: 'note-command', domainEvents: [event] }));
  assert.equal(received.facts.domainEvents[0].id, 'note');
  assert.equal(state.data.documents[0].title, 'new title');
});
function setup(options = {}) {
  const state = { data: seed(), baseline: seed(), token: 7, ready: true, saving: false, refreshPending: false, refreshInFlight: null, refreshAgain: false };
  const disk = { value: seed(), fail: false };
  const events = [], errors = [], listeners = new Map();
  let dirty = false;
  const eventTarget = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const localStorage = {
    getItem(key) { assert.equal(key, 'memokeep-data-v2'); return disk.value === null ? null : JSON.stringify(disk.value); },
    setItem(key, value) { assert.equal(key, 'memokeep-data-v2'); if (disk.fail) throw new Error('disk full'); disk.value = JSON.parse(value); }
  };
  const storage = createStorageAdapter({ desktop: options.desktop, localStorage, storageKey: 'memokeep-data-v2', eventTarget, mergeWindowData: patches.mergeWindowData });
  const sync = createSyncCoordinator({ state, storage, patches, normalize: clone,
    isDirty: () => dirty, onPreferences: () => { events.push('preferences'); options.onPreferences?.(state); },
    beforeApply: () => { events.push('before'); return state.data.documents[0]?.title; },
    afterApply: previous => events.push(['after', previous]) });
  const saving = createSaveCoordinator({ state, storage, patches, normalize: clone,
    refresh: () => { events.push('refresh'); return sync.refresh(); },
    onError: error => errors.push(['save', error.message]), onSyncError: error => errors.push(['sync', error.message]) });
  return { state, disk, storage, events, errors, listeners, ...sync, ...saving, setDirty: value => { dirty = value; } };
}

test('browser adapter keeps null hydration distinct from empty refresh and reports malformed JSON', () => {
  const h = setup(); h.disk.value = null;
  assert.equal(h.storage.read('null'), null);
  assert.deepEqual(h.storage.read(), {});
  const storage = createStorageAdapter({ localStorage: { getItem: () => '{' }, storageKey: 'key' });
  assert.throws(() => storage.read(), SyntaxError);
});
test('browser save merges independent changes with latest storage without changing format', async () => {
  const h = setup();
  h.state.data.documents[0].title = 'local'; h.disk.value.settings.external = true;
  const pending = h.save();
  assert.equal(h.state.saving, false, 'Browser storage and save state update synchronously');
  await pending;
  assert.equal(h.disk.value.documents[0].title, 'local');
  assert.equal(h.state.data.settings.external, true);
  assert.equal(h.disk.value.version, 2);
  assert.deepEqual(h.state.baseline, h.disk.value);
  assert.notEqual(h.state.baseline, h.disk.value);
});
for (const failure of ['conflict', 'disk full']) test(`browser ${failure} preserves draft and baseline, clears saving and permits retry`, async () => {
  const h = setup(); const baseline = h.state.baseline;
  h.state.data.documents[0].title = 'local';
  if (failure === 'conflict') h.disk.value.documents[0].title = 'external'; else h.disk.fail = true;
  await assert.rejects(h.save(), failure === 'conflict' ? /其他窗口/ : /disk full/);
  assert.equal(h.state.data.documents[0].title, 'local'); assert.equal(h.state.baseline, baseline);
  assert.equal(h.state.saving, false); assert.equal(h.errors.length, 1);
  h.disk.fail = false; h.disk.value = seed(); await h.save();
  assert.equal(h.disk.value.documents[0].title, 'local');
});
test('save before hydration rejects without writing, normalization or error notification', async () => {
  const h = setup(); h.state.ready = false;
  await assert.rejects(h.save(), /数据仍在加载/);
  assert.deepEqual(h.errors, []); assert.equal(h.state.saving, false);
  assert.deepEqual(h.disk.value, seed());
});
test('legacy desktop write receives current data and original baseline, then adopts server response', async () => {
  const gate = deferred(); let args;
  const h = setup({ desktop: { write: (...values) => { args = values; return gate.promise; } } });
  h.state.data.documents[0].title = 'local'; const baseline = h.state.baseline;
  const pending = h.save();
  assert.equal(h.state.saving, true); assert.equal(args[1], baseline);
  assert.equal(args[0].documents[0].title, 'local');
  const saved = seed(); saved.settings.server = true; gate.resolve(saved); await pending;
  assert.deepEqual(h.state.data, saved); assert.deepEqual(h.state.baseline, saved);
  assert.notEqual(h.state.baseline, saved); assert.equal(h.state.token, 7);
});
test('patch write advances committed baseline while retaining edits made during persistence', async () => {
  const gate = deferred(); let args;
  const h = setup({ desktop: { writeChanges: (...values) => { args = values; return gate.promise; } } });
  h.state.data.documents[0].title = 'local'; const pending = h.save();
  assert.equal(args[1], 7); assert.equal(args[0].fields[0].changes[0].before.title, 'saved');
  const saved = clone(h.state.data); saved.settings.external = true;
  h.state.data.documents[0].content = 'changed while waiting';
  gate.resolve({ token: 8, patch: patches.createDataPatch(h.state.baseline, saved) }); await pending;
  assert.equal(h.state.token, 8); assert.equal(h.state.data.documents[0].content, 'changed while waiting'); assert.deepEqual(h.state.baseline, saved);
  assert.equal(h.state.saving, false);
});
test('patch endpoint can return a full snapshot; it replaces local state and advances token', async () => {
  const saved = seed(); saved.documents[0].title = 'server';
  const h = setup({ desktop: { writeChanges: async () => ({ data: saved, token: 11 }) } });
  await h.save(); assert.equal(h.state.token, 11); assert.deepEqual(h.state.data, saved);
  assert.deepEqual(h.state.baseline, saved); assert.notEqual(h.state.baseline, saved);
});
test('failed patch write retains conflict baseline/token and can retry the same edit', async () => {
  let fail = true;
  const h = setup({ desktop: { writeChanges: async patch => { if (fail) throw new Error('offline'); return { patch, token: 8 }; } } });
  h.state.data.documents[0].title = 'local'; const baseline = h.state.baseline;
  await assert.rejects(h.save(), /offline/);
  assert.equal(h.state.baseline, baseline); assert.equal(h.state.token, 7); assert.equal(h.state.saving, false);
  fail = false; await h.save(); assert.equal(h.state.baseline.documents[0].title, 'local');
});
for (const fail of [false, true]) test(`deferred refresh runs after ${fail ? 'failed' : 'successful'} save and reports refresh failure separately`, async () => {
  const h = setup({ desktop: {
    write: async data => { if (fail) throw new Error('write failed'); return data; },
    read: async () => { throw new Error('read failed'); }
  } });
  h.state.refreshPending = true;
  if (fail) await assert.rejects(h.save(), /write failed/); else await h.save();
  await settle(); assert.equal(h.state.saving, false);
  assert.ok(h.events.includes('refresh')); assert.ok(h.errors.some(entry => entry[0] === 'sync' && entry[1] === 'read failed'));
});
test('browser subscription filters storage key and can remove the listener', () => {
  const h = setup(); let count = 0; const stop = h.storage.subscribe(() => count++);
  for (const key of ['other', null, 'memokeep-data-v2']) h.listeners.get('storage')({ key });
  assert.equal(count, 1); stop(); assert.equal(h.listeners.size, 0);
});
test('desktop adapter delegates read, preferences and notifications to the existing bridge', async () => {
  let callback;
  const h = setup({ desktop: { read: () => seed(), readEditingPreferences: () => ({ selectionCardPopupEnabled: false }), onDataChanged: cb => { callback = cb; } } });
  assert.equal(h.storage.isDesktop, true); assert.equal(h.storage.supportsPatches, false);
  assert.deepEqual(h.storage.read(), seed()); assert.equal(h.storage.readEditingPreferences().selectionCardPopupEnabled, false);
  let count = 0; h.storage.subscribe(() => count++); callback(); assert.equal(count, 1);
});
test('sync defers during save and before hydration without reading or repainting', async () => {
  const h = setup({ desktop: { read: () => { throw new Error('unexpected read'); } } });
  h.state.ready = false; await h.apply(); assert.equal(h.state.refreshPending, false);
  h.state.ready = true; h.state.saving = true; await h.apply();
  assert.equal(h.state.refreshPending, true); assert.deepEqual(h.events, []);
});
test('dirty editor reads preferences only and retains baseline, token and pending refresh', async () => {
  let count = 0;
  const h = setup({ desktop: { readEditingPreferences: async () => { count++; return { selectionCardPopupEnabled: false }; }, readChanges: () => { throw new Error('unexpected full read'); } } });
  h.setDirty(true); h.state.data.documents[0].title = 'draft'; const baseline = h.state.baseline;
  await h.refresh(); assert.equal(count, 1); assert.equal(h.state.data.documents[0].title, 'draft');
  assert.equal(h.state.data.settings.selectionCardPopupEnabled, false); assert.equal(h.state.baseline, baseline);
  assert.equal(h.state.baseline.settings.selectionCardPopupEnabled, true); assert.equal(h.state.token, 7);
  assert.equal(h.state.refreshPending, true); assert.equal(h.state.refreshInFlight, null);
  assert.deepEqual(h.events, ['preferences']);
});
test('legacy/browser dirty editor syncs preference in both baselines without replacing draft', async () => {
  const h = setup(); h.setDirty(true); h.state.data.documents[0].title = 'draft'; h.disk.value.settings.selectionCardPopupEnabled = false;
  await h.apply(); assert.equal(h.state.data.documents[0].title, 'draft');
  assert.equal(h.state.baseline.documents[0].title, 'saved');
  assert.equal(h.state.baseline.settings.selectionCardPopupEnabled, false); assert.equal(h.state.refreshPending, true);
});
for (const mode of ['lightweight', 'snapshot', 'browser']) test(`${mode}: dirty plugin sync preserves the note conflict baseline and saves against newer remote switches`, async () => {
  const base = seed(); base.settings.plugins = { statistics: 'on', windows: 'on' }; base.settings.pluginsSeen = [];
  let remote = clone(base), hostSnapshot = clone(base), hostToken = 7, fullReads = 0;
  const respond = token => {
    const previous = hostSnapshot, previousToken = hostToken;
    hostSnapshot = clone(remote); hostToken++;
    return token === previousToken ? { patch: patches.createDataPatch(previous, remote), token: hostToken } : { data: clone(remote), token: hostToken };
  };
  const desktop = mode === 'browser' ? undefined : {
    ...(mode === 'lightweight' ? { readEditingPreferences: async () => clone(remote.settings) } : {}),
    readChanges: async token => { fullReads++; return respond(token); },
    writeChanges: async (patch, token) => { remote = patches.applyDataPatch(remote, patch); return respond(token); }
  };
  const h = setup({ desktop }); h.state.data = clone(base); h.state.baseline = clone(base); h.disk.value = clone(base);
  h.setDirty(true); h.state.data.documents[0].title = 'local draft';
  const draft = h.state.data.documents[0], baseline = h.state.baseline, noteBaseline = baseline.documents[0];
  const incoming = mode === 'browser' ? h.disk.value : remote;
  incoming.settings.plugins = { statistics: 'off', windows: 'on' }; incoming.settings.pluginsSeen = ['statistics'];
  incoming.documents[0].content = 'remote body';
  await h.refresh();
  assert.equal(h.state.data.documents[0], draft, 'The active draft object is never replaced');
  assert.equal(h.state.baseline, baseline); assert.equal(baseline.documents[0], noteBaseline);
  assert.equal(noteBaseline.content, 'body', 'The original note conflict baseline is retained');
  assert.equal(h.state.data.documents[0].content, 'body', 'A preference refresh never loads remote note contents');
  assert.deepEqual(h.state.data.settings.plugins, incoming.settings.plugins);
  assert.deepEqual(h.state.baseline.settings.pluginsSeen, ['statistics']);
  assert.notEqual(h.state.data.settings.plugins, h.state.baseline.settings.plugins);
  assert.notEqual(h.state.data.settings.pluginsSeen, h.state.baseline.settings.pluginsSeen);
  assert.deepEqual(h.events, ['preferences'], 'Only the preference hook runs while the editor is dirty');
  assert.equal(fullReads, mode === 'snapshot' ? 1 : 0, 'Lightweight sync does not read the document payload');
  if (mode !== 'browser') assert.equal(h.state.token, null, 'A partially updated baseline invalidates its old full-snapshot token');
  // Another remote toggle can restore the host token's original value before Save.
  incoming.settings.plugins.statistics = 'on'; delete incoming.settings.pluginsSeen;
  h.setDirty(false); await h.save(); await settle();
  const saved = mode === 'browser' ? h.disk.value : remote;
  assert.equal(saved.documents[0].title, 'local draft'); assert.equal(saved.documents[0].content, 'remote body');
  assert.equal(saved.settings.plugins.statistics, 'on');
  assert.equal(h.state.data.settings.plugins.statistics, 'on', 'The save response adopts the latest remote switch instead of retaining the intermediate value');
  assert.equal(Object.hasOwn(h.state.data.settings, 'pluginsSeen'), false);
  assert.deepEqual(h.errors, []);
});
for (const mode of ['lightweight', 'snapshot']) test(`${mode}: missing plugin preferences restore defaults in live settings and their baseline`, async () => {
  const desktop = mode === 'lightweight'
    ? { readEditingPreferences: async () => ({ selectionCardPopupEnabled: true }) }
    : { readChanges: async () => ({ data: seed(), token: 9 }) };
  const h = setup({ desktop }); h.setDirty(true);
  for (const owner of [h.state.data, h.state.baseline]) Object.assign(owner.settings, { plugins: { statistics: 'off' }, pluginsSeen: ['statistics'] });
  h.state.data.documents[0].title = 'draft';
  await h.refresh();
  for (const owner of [h.state.data, h.state.baseline]) {
    assert.equal(Object.hasOwn(owner.settings, 'plugins'), false);
    assert.equal(Object.hasOwn(owner.settings, 'pluginsSeen'), false);
  }
  assert.equal(h.state.data.documents[0].title, 'draft'); assert.equal(h.state.baseline.documents[0].title, 'saved');
  assert.deepEqual(h.events, ['preferences']);
});
test('a save starting during a lightweight read prevents stale plugin preferences from overwriting the save', async () => {
  const gate = deferred(), h = setup({ desktop: { readEditingPreferences: () => gate.promise } });
  h.setDirty(true); h.state.data.settings.plugins = { statistics: 'on' }; h.state.baseline.settings.plugins = { statistics: 'on' };
  const pending = h.refresh(); h.state.saving = true;
  gate.resolve({ selectionCardPopupEnabled: false, plugins: { statistics: 'off' }, pluginsSeen: ['statistics'] }); await pending;
  assert.equal(h.state.data.settings.plugins.statistics, 'on'); assert.equal(h.state.baseline.settings.plugins.statistics, 'on');
  assert.equal(h.state.data.settings.selectionCardPopupEnabled, true);
  assert.equal(h.state.token, 7); assert.equal(h.state.refreshPending, true); assert.deepEqual(h.events, []);
});
test('a save completed during a lightweight read prevents publishing its older plugin response', async () => {
  const gate = deferred(), observed = []; let reads = 0, remote = seed();
  remote.settings.plugins = { statistics: 'off' };
  const h = setup({ onPreferences: state => observed.push(state.data.settings.plugins.statistics), desktop: {
    readEditingPreferences: () => ++reads === 1 ? gate.promise : Promise.resolve(clone(remote.settings)),
    write: async proposal => { remote = clone(proposal); return remote; }
  } });
  h.state.data = clone(remote); h.state.baseline = clone(remote); h.setDirty(true);
  const pending = h.refresh(); h.state.data.settings.plugins.statistics = 'on';
  await h.save(); assert.equal(h.state.saving, false);
  gate.resolve({ selectionCardPopupEnabled: true, plugins: { statistics: 'off' } });
  await pending; await settle();
  assert.equal(h.state.data.settings.plugins.statistics, 'on');
  assert.equal(h.state.baseline.settings.plugins.statistics, 'on');
  assert.ok(observed.every(value => value === 'on'), 'A stale preference response never repaints the saved plugin as disabled');
});
test('empty patch only advances token and clears pending without repaint or normalization', async () => {
  const h = setup({ desktop: { readChanges: async token => { assert.equal(token, 7); return { patch: { fields: [] }, token: 8 }; } } });
  const data = h.state.data, baseline = h.state.baseline;
  await h.refresh(); assert.equal(h.state.data, data); assert.equal(h.state.baseline, baseline);
  assert.equal(h.state.token, 8); assert.equal(h.state.refreshPending, false); assert.deepEqual(h.events, []);
});
test('incoming patch replaces discarded local edits and preserves repaint context', async () => {
  const saved = seed(); saved.documents[0].title = 'remote';
  const h = setup({ desktop: { readChanges: async () => ({ patch: patches.createDataPatch(seed(), saved), token: 8 }) } });
  h.state.data.documents[0].title = 'discarded draft'; await h.refresh();
  assert.deepEqual(h.state.data, saved); assert.deepEqual(h.state.baseline, saved);
  assert.equal(h.state.token, 8); assert.deepEqual(h.events, ['before', ['after', 'discarded draft']]);
});
test('full snapshot refresh adopts remote deletion and calls view hook with previous document', async () => {
  const saved = seed(); saved.documents = [];
  const h = setup({ desktop: { readChanges: async () => ({ data: saved, token: 9 }) } });
  await h.apply(); assert.deepEqual(h.state.data.documents, []); assert.equal(h.state.token, 9);
  assert.deepEqual(h.events, ['before', ['after', 'saved']]); assert.equal(h.state.refreshPending, false);
});
test('a save starting during read prevents stale response/token adoption', async () => {
  const gate = deferred(); const h = setup({ desktop: { readChanges: () => gate.promise } });
  const pending = h.refresh(); h.state.saving = true;
  gate.resolve({ data: { ...seed(), documents: [] }, token: 9 }); await pending;
  assert.equal(h.state.token, 7); assert.deepEqual(h.state.data, seed());
  assert.equal(h.state.refreshPending, true); assert.deepEqual(h.events, []);
});
test('an editor becoming dirty during read retains draft and conflict baseline', async () => {
  const gate = deferred(); const h = setup({ desktop: { readChanges: () => gate.promise } });
  const pending = h.refresh(); h.setDirty(true); h.state.data.documents[0].title = 'draft';
  gate.resolve({ data: { ...seed(), settings: { selectionCardPopupEnabled: false } }, token: 9 }); await pending;
  assert.equal(h.state.data.documents[0].title, 'draft'); assert.equal(h.state.baseline.documents[0].title, 'saved');
  assert.equal(h.state.token, 7); assert.equal(h.state.refreshPending, true); assert.deepEqual(h.events, ['preferences']);
});
test('bursts of window events coalesce to one in-flight read plus one catch-up read', async () => {
  const gate = deferred(); let count = 0;
  const h = setup({ desktop: { readChanges: () => { count++; return count === 1 ? gate.promise : Promise.resolve({ patch: { fields: [] }, token: 9 }); } } });
  const pending = [h.refresh()]; for (let i = 0; i < 20; i++) pending.push(h.refresh());
  assert.equal(count, 1); gate.resolve({ patch: { fields: [] }, token: 8 }); await Promise.all(pending);
  assert.equal(count, 2); assert.equal(h.state.token, 9); assert.equal(h.state.refreshInFlight, null);
});
test('failed refresh clears in-flight state, retains baseline and can retry', async () => {
  let fail = true;
  const h = setup({ desktop: { readChanges: async () => { if (fail) throw new Error('read failed'); return { patch: { fields: [] }, token: 8 }; } } });
  const baseline = h.state.baseline;
  await assert.rejects(h.refresh(), /read failed/); assert.equal(h.state.refreshInFlight, null);
  assert.equal(h.state.baseline, baseline); assert.equal(h.state.refreshPending, true); assert.equal(h.state.token, 7);
  fail = false; await h.refresh(); assert.equal(h.state.token, 8); assert.equal(h.state.refreshPending, false);
});
test('browser persistence modules load before app and expose the same API as CommonJS', () => {
  const context = vm.createContext({});
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  for (const name of ['storage-adapter', 'save-coordinator', 'sync-coordinator']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/persistence', name + '.js'), 'utf8'), context);
    assert.ok(html.indexOf(`src="persistence/${name}.js"`) < html.indexOf('src="app.js"'));
  }
  assert.deepEqual(Object.keys(context.MemoKeepPersistence).sort(), ['createSaveCoordinator', 'createStorageAdapter', 'createSyncCoordinator']);
});
for (const mode of ['legacy', 'patch']) for (const fail of [false, true]) test(`${mode}: ${fail ? 'failed' : 'successful'} private transaction shares ordering with global saves`, async () => {
  const gate = deferred(), entered = deferred(); let writes = 0, disk = {...seed(),memos:[]}, h;
  const write = async proposal => { if (++writes === 1) { entered.resolve(); await gate.promise; if (fail) throw Error('first failed'); } disk = clone(proposal); return clone(disk); };
  const desktop = mode === 'legacy' ? { write } : { writeChanges: async (patch, token) => { const before = clone(disk); const saved = await write(patches.applyDataPatch(before, patch)); return {patch:patches.createDataPatch(before,saved),token:token+1}; } };
  h = setup({desktop}); h.state.data.memos = []; h.state.baseline.memos = [];
  const first = h.transact(data => {data.memos.push({id:'private',title:'memo'});}); const result = fail ? assert.rejects(first,/first failed/) : first;
  await entered.promise; assert.deepEqual(h.state.data.memos, []);
  h.state.data.documents[0].title = 'pending global edit'; const background = h.save();
  const next = h.transact(data => {data.settings.later = true;}); assert.equal(writes,1);
  gate.resolve(); await result; await background; await next;
  assert.equal(disk.memos.length,fail?0:1); assert.equal(disk.documents[0].title,'pending global edit'); assert.equal(disk.settings.later,true);
  assert.deepEqual(h.state.data,disk); assert.deepEqual(h.state.baseline,disk); assert.equal(h.state.saving,false);
});
test('browser transaction failure never exposes candidate data and permits the next transaction', async () => {
  const h=setup(); h.disk.fail=true;
  await assert.rejects(h.transact(data=>{data.documents[0].title='private';}),/disk full/);
  assert.equal(h.state.data.documents[0].title,'saved'); assert.equal(h.state.baseline.documents[0].title,'saved');
  h.disk.fail=false; await h.transact(data=>{data.documents[0].title='retry';}); assert.equal(h.disk.value.documents[0].title,'retry');
});
test('a failed preparation does not write or poison the shared queue', async () => {
  const h=setup(); const bad=h.transact(()=>{throw Error('prepare failed');}); const next=h.transact(data=>{data.settings.next=true;});
  await assert.rejects(bad,/prepare failed/); await next; assert.equal(h.disk.value.settings.next,true); assert.equal(h.state.saving,false);
});
test('successful response preserves later local entity additions, removals and property edits for the next save', async () => {
  const gate=deferred(); let first=true, disk=seed();
  const h=setup({desktop:{write:async proposal=>{if(first){first=false;await gate.promise;}disk=clone(proposal);return clone(disk);}}});
  const saving=h.save(); h.state.data.documents=[]; h.state.data.cards.push({id:'late-card',question:'late'}); h.state.data.settings.added=true;
  gate.resolve(); await saving; assert.equal(h.state.data.documents.length,0); assert.equal(h.state.data.cards.length,1); assert.equal(h.state.baseline.documents.length,1);
  await h.save(); assert.deepEqual(disk,h.state.data); assert.equal(disk.documents.length,0); assert.equal(disk.cards[0].id,'late-card');
});
test('sync remains deferred until all queued writes finish', async () => {
  const first=deferred(),second=deferred(),entered=deferred();let writes=0,reads=0;
  const h=setup({desktop:{write:async proposal=>{const n=++writes;if(n===1){entered.resolve();await first.promise;}else await second.promise;return proposal;},read:async()=>{reads++;return seed();}}});
  const a=h.save();await entered.promise;const b=h.transact(data=>{data.settings.after=true;});await h.refresh();assert.equal(reads,0);
  first.resolve();await a;await settle();assert.equal(h.state.saving,true);assert.equal(reads,0);
  second.resolve();await b;await settle();assert.equal(h.state.saving,false);assert.ok(reads>0);
});
for (const mode of ['legacy', 'patch']) test(`${mode}: failed private candidate retains queued edits without reviving failed work`, async () => {
  const gate=deferred(); let writes=0, disk=seed();
  const write=async proposal=>{if(++writes===1){await gate.promise;throw Error('first failed');}disk=clone(proposal);return clone(disk);};
  const desktop=mode==='legacy'?{write}:{writeChanges:async(patch,token)=>{const before=clone(disk);const saved=await write(patches.applyDataPatch(before,patch));return{patch:patches.createDataPatch(before,saved),token:token+1};}};
  const h=setup({desktop}); const failed=assert.rejects(h.transact(data=>{data.documents[0].title='failed title';}),/first failed/);
  const second=h.transact(data=>{data.settings.selectionCardPopupEnabled=false;data.cards.push({id:'queued',question:'keep'});});
  gate.resolve();await failed;await second;
  assert.equal(disk.documents[0].title,'saved');assert.equal(disk.settings.selectionCardPopupEnabled,false);assert.equal(disk.cards[0].id,'queued');assert.deepEqual(h.state.data,disk);
});
test('two failed candidates leave only later unsaved edits and permit retry', async()=>{
  const gate=deferred();const h=setup({desktop:{write:async()=>{await gate.promise;throw Error('offline');}}});
  const failedA=assert.rejects(h.transact(data=>{data.documents[0].title='first';}),/offline/);
  const failedB=assert.rejects(h.transact(data=>{data.settings.queued=true;}),/offline/);
  h.state.data.documents[0].content='unsaved later';gate.resolve();await failedA;await failedB;
  assert.equal(h.state.data.documents[0].title,'saved');assert.equal(h.state.data.settings.queued,undefined);assert.equal(h.state.data.documents[0].content,'unsaved later');
});
test('failed new entities and normalized fields never enter shared state',async()=>{
  const state={data:{cards:[],settings:{}},baseline:{cards:[],settings:{}},ready:true};
  const saving=createSaveCoordinator({state,storage:{isDesktop:true,write:async()=>{throw Error('offline');}},normalize:data=>({...data,cards:data.cards.map(card=>({...card,defaulted:null}))}),patches,onError(){},onSyncError(){}});
  await assert.rejects(saving.transact(data=>{data.cards.push({id:'failed',question:'new'});}),/offline/);assert.deepEqual(state.data.cards,[]);
});
test('failed removal preserves original entities and later local additions',async()=>{
  const gate=deferred();const h=setup({desktop:{write:async()=>{await gate.promise;throw Error('offline');}}});
  const failed=assert.rejects(h.transact(data=>{data.documents=[];delete data.settings.selectionCardPopupEnabled;}),/offline/);
  h.state.data.documents.push({id:'later',title:'keep'});h.state.data.settings.later='keep';gate.resolve();await failed;
  assert.deepEqual(h.state.data.documents.map(doc=>doc.id),['note','later']);assert.equal(h.state.data.settings.selectionCardPopupEnabled,true);assert.equal(h.state.data.settings.later,'keep');
});

for(const mode of ['legacy','patch'])for(const [failA,failB,titleB] of [[true,true,'B'],[true,false,'A'],[true,false,'B'],[false,true,'B'],[false,false,'B'],[false,false,'base']]){
 test(`${mode}: same-field queue A=${failA?'fail':'ok'} B=${failB?'fail':'ok'} value=${titleB}`,async()=>{
  const state={data:{documents:[{id:'note',title:'base'}],settings:{}},ready:true,token:1};state.baseline=structuredClone(state.data);
  let disk=structuredClone(state.data),writes=0;const gate=deferred();
  const write=async proposal=>{const n=++writes;if(n===1)await gate.promise;if((n===1&&failA)||(n===2&&failB))throw Error('injected failure');disk=structuredClone(proposal);return structuredClone(disk);};
  const storage=mode==='legacy'?{isDesktop:true,write}:{supportsPatches:true,writeChanges:async(patch,token)=>{const previous=structuredClone(disk);const saved=await write(patches.applyDataPatch(previous,patch));return{patch:patches.createDataPatch(previous,saved),token:token+1};}};
  const queue=createSaveCoordinator({state,storage,normalize:structuredClone,patches,onError(){},onSyncError(){}});
  const a=queue.transact(data=>{data.documents[0].title='A';}).then(()=>true,()=>false);
  const b=queue.transact(data=>{data.documents[0].title=titleB;}).then(()=>true,()=>false);
  gate.resolve();assert.deepEqual(await Promise.all([a,b]),[!failA,!failB]);
  const expected=!failB?titleB:!failA?'A':'base';
  const live=state.data.documents[0].title;await queue.transact(data=>{data.settings.neutral=true;});
  assert.equal(live,expected,JSON.stringify({mode,failA,failB,titleB,live,persistedAfterNeutral:disk.documents[0].title,expected}));
  assert.equal(disk.documents[0].title,expected);
 });
}

test('retired checkpoint saves reject instead of silently committing shared state', async()=>{
  const h=setup();assert.equal(h.checkpoint,undefined);assert.equal(h.rollback,undefined);
  await assert.rejects(h.save(seed()),/transact/);assert.deepEqual(h.disk.value,seed());
});
for(const failA of [false,true]) test(`browser: queued same-field intent survives ${failA?'failed':'successful'} prior writes`,async()=>{
  const state={data:seed(),baseline:seed(),ready:true};let disk=seed(),writes=0;
  const coordinator=createSaveCoordinator({state,normalize:clone,patches,onError(){},onSyncError(){},storage:{write(proposal){if(++writes===1&&failA)throw Error('offline');disk=clone(proposal);return clone(disk);}}});
  const first=coordinator.transact(data=>{data.settings.selectionCardPopupEnabled=false;}).then(()=>true,()=>false);
  const second=coordinator.transact(data=>{data.settings.selectionCardPopupEnabled=true;});await first;await second;
  assert.equal(disk.settings.selectionCardPopupEnabled,true);assert.deepEqual(state.data,disk);
});
test('same-value transactions still commit a matching unsaved local edit',async()=>{
  const h=setup();h.state.data.documents[0].title='pending';await h.transact(data=>{data.documents[0].title='pending';});
  assert.equal(h.disk.value.documents[0].title,'pending');
});

test('declined commands do not persist their candidate or unrelated pending edits',async()=>{
  const h=setup();h.state.data.documents[0].title='pending';
  await h.transact(data=>{data.cards.push({id:'cancelled'});return false;});
  assert.equal(h.disk.value.documents[0].title,'saved');assert.deepEqual(h.state.data.cards,[]);assert.equal(h.state.data.documents[0].title,'pending');
});
