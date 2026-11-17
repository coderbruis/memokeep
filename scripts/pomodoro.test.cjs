const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/domain/pomodoro.js');
const M = P.MINUTE;

test('settings are clamped and keep their defaults', () => {
  const settings = P.normalizeSettings({ focus: 500, short: 0, every: 'x', autoBreak: false, floatSize: 'huge' });
  assert.equal(settings.focus, 120); assert.equal(settings.short, 1); assert.equal(settings.every, 4);
  assert.equal(settings.autoBreak, false); assert.equal(settings.floatSize, 'pill'); assert.equal(settings.pinned, false);
  assert.equal(settings.floatColor, 'auto'); assert.equal(P.normalizeSettings({ floatColor: 'mint' }).floatColor, 'mint'); assert.equal(P.normalizeSettings({ floatColor: 'pink' }).floatColor, 'auto');
});

test('a full focus records only running time, then starts the break automatically', () => {
  const settings = P.normalizeSettings({ focus: 25, short: 5 });
  let state = P.start(P.initialState(settings), settings, 0, { planId: 'plan', taskName: '刷题' });
  state = P.pause(state, 10 * M);
  assert.equal(P.leftMs(state, 99 * M), 15 * M, 'paused time does not run');
  state = P.resume(state, 20 * M);
  assert.equal(P.tick(state, settings, 30 * M).events.length, 0);
  const done = P.tick(state, settings, 36 * M);
  assert.equal(done.events[0].type, 'focus-complete');
  assert.deepEqual({ ...done.events[0].session, startedAt: undefined, endedAt: undefined }, { planId: 'plan', taskId: null, taskName: '刷题', minutes: 25, startedAt: undefined, endedAt: undefined });
  assert.equal(done.state.phase, 'break'); assert.equal(done.state.running, true); assert.equal(done.state.totalMs, 5 * M);
  const rested = P.tick(done.state, settings, 42 * M);
  assert.equal(rested.state.phase, 'idle'); assert.equal(rested.state.planId, 'plan', 'the plan is remembered for the next focus');
});

test('every fourth focus earns a long break; auto focus can follow a break', () => {
  const settings = P.normalizeSettings({ focus: 25, short: 5, long: 15, every: 4, autoFocus: true });
  let state = P.initialState(settings), now = 0;
  for (let round = 1; round <= 4; round++) {
    state = P.start(state, settings, now); now += 25 * M;
    ({ state } = P.tick(state, settings, now));
    assert.equal(state.totalMs, (round === 4 ? 15 : 5) * M, `round ${round} break length`);
    if (round < 4) { state = P.skip(state, settings, now).state; }
  }
  now += 15 * M;
  ({ state } = P.tick(state, settings, now));
  assert.equal(state.phase, 'focus', 'autoFocus starts the next focus');
  assert.equal(P.snapshot(state, settings, now).round, 1, 'a new cycle starts at round 1');
});

test('stopping early keeps whole minutes of focus and drops under a minute', () => {
  const settings = P.normalizeSettings({});
  const early = P.stop(P.start(P.initialState(settings), settings, 0, { planId: 'p' }), settings, 7.6 * M);
  assert.equal(early.events[0].session.minutes, 8);
  assert.equal(early.state.phase, 'idle');
  const tooShort = P.stop(P.start(P.initialState(settings), settings, 0), settings, 20_000);
  assert.equal(tooShort.events[0].session, null);
});

test('minutes are grouped by the start day and formatted', () => {
  const at = (day, hour) => new Date(2026, 10, day, hour).toISOString();
  const sessions = [{ planId: 'a', startedAt: at(9, 23), minutes: 25 }, { planId: 'a', startedAt: at(9, 9), minutes: 30 }, { planId: 'b', startedAt: at(10, 9), minutes: 45 }];
  assert.deepEqual([...P.minutesByDay(sessions, 'a')], [['2026-11-09', 55]]);
  assert.equal(P.formatMinutes(55), '55 分钟'); assert.equal(P.formatMinutes(792), '13 小时 12 分'); assert.equal(P.formatMinutes(120), '2 小时');
  assert.equal(P.clock(59_001), '01:00');
});
