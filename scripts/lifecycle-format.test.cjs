const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('lifecycle preserves opaque card extensions, structured reminders and precise short focus facts', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/shell/lifecycle.js'), 'utf8'), context);
  const { normalize } = context.MemoKeepShell.createLifecycle({ state: {}, config: { defaults: { streak: {}, settings: {} }, now: () => 100000, uid: () => 'new', NOTE_VERSION_LIMIT: 5 }, actions: {}, env: { structuredClone, normalizeCardWorkspace: () => ({}), normalizeNoteTags: value => value || [], normalizeNoteTagIds: value => value || [] } });
  const input = { cards: [{ id: 'card', dueAt: 1000, extensions: { provider: { opaqueVersion: 'v' } }, criteria: { format: 'unknown' } }], memos: [{ id: 'memo', title: 'memo', reminder: { kind: 'calendar', timeZone: 'Asia/Shanghai', anchorAt: '2026-11-17T09:00:00Z', repeat: 'daily' } }], focusSessions: [{ id: 'mobile', endedAt: '2026-11-17T12:00:00Z', activeDurationMs: 120000, activeIntervals: [], outcome: 'stopped' }, { id: 'short', endedAt: '2026-11-17T12:00:00Z', activeDurationMs: 10000, outcome: 'skipped' }] };
  const output = normalize(input);
  assert.equal(JSON.stringify(output.cards[0].extensions), JSON.stringify(input.cards[0].extensions)); assert.equal(JSON.stringify(output.cards[0].criteria), JSON.stringify(input.cards[0].criteria));
  assert.equal(JSON.stringify(output.memos[0].reminder), JSON.stringify(input.memos[0].reminder)); assert.equal(output.focusSessions.length, 2); assert.equal(output.focusSessions[0].activeDurationMs, 120000);
});
