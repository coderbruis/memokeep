const test = require('node:test');
const assert = require('node:assert/strict');
const Delivery = require('../web/shell/reminder-delivery.js');
function setup(api) {
  const state = { memos: { activeMemoReminderId: null, memoReminderQueue: [] }, persistence: { data: { memos: [{ id: 'one' }, { id: 'two' }] } } };
  let legacy = 0, toasts = 0;
  const actions = {
    checkMemoReminders: async () => { legacy++; },
    showNextMemoReminder() { if (!state.memos.activeMemoReminderId) state.memos.activeMemoReminderId = state.memos.memoReminderQueue.shift() || null; },
    enqueueMemoReminders(memos) { const ids = new Set([state.memos.activeMemoReminderId, ...state.memos.memoReminderQueue]); for (const memo of memos) if (!ids.has(memo.id)) state.memos.memoReminderQueue.push(memo.id); actions.showNextMemoReminder(); },
    showToast() { toasts++; },
  };
  const config = { desktop: { reminders: api, openApp: async () => {} } };
  Object.assign(actions, Delivery.create({ state, config, actions, legacyCheck: actions.checkMemoReminders, legacyShow: actions.showNextMemoReminder }));
  return { state, actions, legacy: () => legacy, toasts: () => toasts };
}
test('native delivery acknowledges only displayed popups and never writes shared marker fields', async () => {
  const acknowledgments = [];
  const f = setup({ check: async () => ({ handled: true, rows: [{ memoId: 'one', key: 'key-one' }, { memoId: 'two', key: 'key-two' }] }), acknowledge: async row => { acknowledgments.push(row); return { recorded: true }; } });
  await f.actions.checkMemoReminders();
  assert.equal(f.legacy(), 0); assert.deepEqual(acknowledgments.map(row => row.memoId), ['one']);
  f.state.memos.activeMemoReminderId = null; f.actions.showNextMemoReminder();
  assert.deepEqual(acknowledgments.map(row => row.memoId), ['one', 'two']);
  assert.ok(f.state.persistence.data.memos.every(row => row.notifiedFor === undefined && row.popupShownFor === undefined));
});
test('native recovery errors never fall back to legacy shared markers and repeated errors show one toast', async () => {
  const f = setup({ async check() { throw new Error('Recovery required'); } });
  await f.actions.checkMemoReminders(); await f.actions.checkMemoReminders();
  assert.equal(f.legacy(), 0); assert.equal(f.toasts(), 1);
});
test('old visible popup cannot acknowledge a newer reminder offered for the same memo', async () => {
  let key = 'old', acknowledged = [];
  const f = setup({ check: async () => ({ handled: true, rows: [{ memoId: 'one', key }] }), acknowledge: async row => { acknowledged.push(row.key); return { recorded: true }; } });
  await f.actions.checkMemoReminders();
  key = 'new'; await f.actions.checkMemoReminders();
  assert.deepEqual(acknowledged, ['old']);
  f.state.memos.activeMemoReminderId = null; f.actions.showNextMemoReminder();
  await f.actions.checkMemoReminders();
  assert.deepEqual(acknowledged, ['old', 'new']);
});
test('web-only runtime retains its existing local reminder behavior', async () => {
  const f = setup(undefined); await f.actions.checkMemoReminders(); assert.equal(f.legacy(), 1);
});

test('a completed, deleted or rescheduled active receipt closes its stale popup without acknowledging the replacement', async () => {
  for (const reason of ['completed', 'deleted', 'rescheduled']) {
    const acknowledgments = [];
    let activeValid = true, key = 'old', closed = 0;
    const f = setup({ check: async () => ({ handled: true, activeValid, rows: [{ memoId: 'one', key }] }), acknowledge: async row => { acknowledgments.push(row.key); return { recorded: true }; } });
    f.actions.closeActiveMemoReminder = () => { closed++; };
    await f.actions.checkMemoReminders();
    activeValid = false; key = 'replacement';
    if (reason === 'completed') f.state.persistence.data.memos[0].completed = true;
    if (reason === 'deleted') f.state.persistence.data.memos = f.state.persistence.data.memos.filter(row => row.id !== 'one');
    await f.actions.checkMemoReminders();
    assert.equal(closed, 1, reason); assert.equal(f.state.memos.activeMemoReminderId, null, reason);
    assert.deepEqual(acknowledgments, ['old'], reason);
  }
});
test('an acknowledged but still valid visible reminder remains open on later native checks', async () => {
  let rows = [{ memoId: 'one', key: 'one' }], closed = 0;
  const f = setup({ check: async () => ({ handled: true, activeValid: true, rows }), acknowledge: async () => ({ recorded: true }) });
  f.actions.closeActiveMemoReminder = () => { closed++; };
  await f.actions.checkMemoReminders(); rows = []; await f.actions.checkMemoReminders();
  assert.equal(closed, 0); assert.equal(f.state.memos.activeMemoReminderId, 'one');
});
test('invalid imported reminders report one diagnostic while valid reminders remain usable', async () => {
  const f = setup({ check: async () => ({ handled: true, issues: [{ memoId: 'bad', message: 'invalid time' }], rows: [{ memoId: 'one', key: 'one' }] }), acknowledge: async () => ({ recorded: true }) });
  await f.actions.checkMemoReminders(); await f.actions.checkMemoReminders();
  assert.equal(f.toasts(), 1); assert.equal(f.state.memos.activeMemoReminderId, 'one');
});
test('popup completion is idempotent and cannot undo an already completed or deleted memo', async () => {
  const { createMemoOperations } = require('../web/application/memo-operations.js');
  const data = { memos: [{ id: 'memo', completed: false }] };
  const operations = createMemoOperations({ transact: async work => work(data), isoNow: () => '2026-11-18T12:00:00.000Z' });
  await operations.complete({ id: 'memo' }); await operations.complete({ id: 'memo' });
  assert.equal(data.memos[0].completed, true);
  data.memos = []; await operations.complete({ id: 'memo' }); assert.equal(data.memos.length, 0);
});
test('popup action validates its captured receipt even while a periodic check is in progress', async () => {
  let valid = true, blockNext = false, release;
  const f = setup({ check: async () => {
    if (blockNext) { blockNext = false; await new Promise(resolve => { release = resolve; }); }
    return { handled: true, activeValid: valid, rows: [{ memoId: 'one', key: 'one' }] };
  }, acknowledge: async () => ({ recorded: true }) });
  await f.actions.checkMemoReminders();
  assert.equal(await f.actions.isCurrentReminder(), true);
  blockNext = true;
  const periodic = f.actions.checkMemoReminders();
  assert.equal(typeof release, 'function');
  valid = false;
  assert.equal(await f.actions.isCurrentReminder(), false);
  release(); await periodic;
});
