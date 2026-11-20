const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/domain/pomodoro.js');

function exactSession(id, start, durationMs) {
  return { id, planId: 'plan', startedAt: new Date(start).toISOString(), endedAt: new Date(start + durationMs).toISOString(),
    activeDurationMs: durationMs, outcome: 'completed', timeAccuracy: 'exact',
    activeIntervals: [{ start: new Date(start).toISOString(), end: new Date(start + durationMs).toISOString() }] };
}

test('minute labels round the final aggregate without losing precise stored durations', () => {
  const start = new Date(2026, 10, 17, 10).getTime();
  const sessions = [exactSession('fractional', start, 1295879), exactSession('whole', start + 3600000, 25 * P.MINUTE)];
  const before = structuredClone(sessions), key = P.dayOf(start), raw = P.minutesByDay(sessions, 'plan').get(key);
  assert.ok(Math.abs(raw - 46.59798333333333) < 1e-10);
  assert.equal(P.roundMinutes(raw), 47);
  assert.equal(P.formatMinutes(raw), '47 分钟');
  assert.equal(P.totalMinutes(sessions, 'plan'), raw);
  assert.deepEqual(sessions, before);
});

test('displaying a day never rounds each individual session before accumulation', () => {
  const start = new Date(2026, 10, 17, 10).getTime();
  const sessions = [exactSession('first', start, 86400), exactSession('second', start + 3600000, 86400)];
  const raw = P.totalMinutes(sessions, 'plan');
  assert.equal(raw, 2.88);
  assert.equal(P.roundMinutes(raw), 3);
  assert.equal(P.formatMinutes(raw), '3 分钟');
});

test('minute formatting preserves whole-minute values and safely handles invalid numbers', () => {
  for (const [value, rounded, label] of [[25, 25, '25 分钟'], [45, 45, '45 分钟'], [120, 120, '2 小时'],
    [59.5, 60, '1 小时'], [792, 792, '13 小时 12 分'], [-5, 0, '0 分钟'], [NaN, 0, '0 分钟'], [Infinity, 0, '0 分钟'], [-Infinity, 0, '0 分钟']]) {
    assert.equal(P.roundMinutes(value), rounded);
    assert.equal(P.formatMinutes(value), label);
  }
});
