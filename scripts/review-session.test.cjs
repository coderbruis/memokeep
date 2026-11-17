const { test } = require('node:test');
const assert = require('node:assert/strict');
const Session = require('../web/review-session.js');
const now = new Date(2026, 8, 12, 12).getTime();
const dataFor = () => ({ cards: [
  { id: 'a', question: '<script>unsafe</script>', status: 'active', dueAt: now + 60000 },
  { id: 'b', status: 'active', dueAt: now + 2 * 86400000 },
  { id: 'c', status: 'paused', dueAt: now - 1 },
  { id: 'd', status: 'active', dueAt: now + 120000 }
], reviewRecords: [] });

test('same-day pending tasks, paused cards, other scopes and genuine completion are distinguished', () => {
  const data = dataFor();
  const s = Session.summary(data, [], ['a', 'b', 'c'], 5000, now);
  assert.deepEqual(s.pending.map(card => card.id), ['a']);
  assert.equal(s.outsidePending, 1);
  assert.equal(s.todayComplete, false);
  assert.equal(Session.summary(data, [], ['b'], 0, now).todayComplete, false);
  data.cards[0].status = 'paused'; data.cards[3].dueAt += 86400000;
  assert.equal(Session.summary(data, [], ['b'], 0, now).todayComplete, true);
});
test('round survives closing while waiting, resumes due cards, and a new day starts fresh counts', () => {
  const data = dataFor();
  const results = [{ cardId: 'a', rating: 'again' }];
  Session.checkpoint(data, 'all', ['a'], results, 'a', 8000, ['a'], now);
  const waiting = Session.open(data, 'all', [], ['a'], now + 10000);
  assert.equal(waiting.currentId, undefined);
  assert.equal(waiting.results.length, 1);
  assert.equal(waiting.elapsedMs, 8000);
  const resumed = Session.open(data, 'all', [data.cards[0]], ['a'], now + 60001);
  assert.equal(resumed.currentId, 'a');
  assert.deepEqual(resumed.done, []);
  const tomorrow = Session.open(data, 'all', [data.cards[0]], ['a'], now + 86400000);
  assert.equal(tomorrow.results.length, 0);
});
test('summary counts distinct cards, individual valid ratings and excludes postponed or undone results', () => {
  const data = dataFor(); data.reviewRecords = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  const results = [{ cardId: 'a', rating: 'again', recordId: 'r1' }, { cardId: 'a', rating: 'good', recordId: 'r2' }, { cardId: 'b', rating: 'easy', recordId: 'r3' }, { cardId: 'a', rating: 'later' }, { cardId: 'b', rating: 'hard', recordId: 'undone' }];
  const s = Session.summary(data, results, ['a', 'b'], 8000, now);
  assert.equal(s.cards, 2); assert.equal(s.ratings, 3); assert.equal(s.deferred, 1);
  assert.deepEqual(s.counts, { again: 1, hard: 0, good: 1, easy: 1 });
});
test('reopening after waiting starts with the announced earliest card instead of the last rated card', () => {
  const data = dataFor();
  Session.checkpoint(data, 'all', ['d', 'a'], [{ cardId: 'd', rating: 'again' }], 'd', 8000, ['a', 'd'], now);
  assert.equal(data.reviewSessions.all.currentId, null);
  const resumed = Session.open(data, 'all', [data.cards[3], data.cards[0]], ['a', 'd'], now + 180000);
  assert.equal(resumed.currentId, 'a');
  Session.checkpoint(data, 'all', resumed.queue, resumed.results, 'd', 8000, ['a', 'd'], now + 180000);
  assert.equal(Session.open(data, 'all', [data.cards[0], data.cards[3]], ['a', 'd'], now + 180001).currentId, 'd');
});
