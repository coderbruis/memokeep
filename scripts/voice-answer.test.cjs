const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../web/domain/voice-answer.js');

const question = 'kafka的ISR是什么？';
const reference = ['ISR（In-Sync Replicas）是与 leader 保持同步的副本集合。', 'follower 落后超过 replica.lag.time.max.ms 会被移出 ISR。', '只有 ISR 中的副本才能被选为新的 leader。'];

test('prototype example: two of three points, suggests 有点难', () => {
  const result = voice.compare(reference, 'ISR 就是和 leader 保持同步的那些副本，如果 follower 落后太久就会被踢出去。', question);
  assert.deepEqual(result.points.map(point => point.hit), [true, true, false]);
  assert.equal(result.hits, 2);
  assert.equal(result.total, 3);
  assert.equal(result.suggestion, 'hard');
});

test('repeating words from the question does not count as an answer', () => {
  const result = voice.compare(reference, 'ISR 就是 ISR，kafka 的 ISR', question);
  assert.equal(result.hits, 0);
  assert.equal(result.suggestion, 'again');
});

test('a full answer suggests 记住, never 很简单', () => {
  const result = voice.compare(reference, 'ISR 是和 leader 保持同步的副本集合。follower 落后超过 replica.lag.time.max.ms 就被移出 ISR。只有 ISR 里的副本才能被选为新的 leader。', question);
  assert.equal(result.hits, 3);
  assert.equal(result.suggestion, 'good');
});

test('no spoken text or no splittable points gives no suggestion', () => {
  assert.equal(voice.compare(reference, '', question).suggestion, null);
  assert.equal(voice.compare(['是的'], '是的').total, 0);
  assert.equal(voice.compare(['是的'], '是的').suggestion, null);
});

test('splits list markers and sentences into points', () => {
  assert.deepEqual(voice.splitPoints(['1. 消息压缩；2) 批量发送', '- 零拷贝。顺序写磁盘']), ['消息压缩；', '批量发送', '零拷贝。', '顺序写磁盘']);
});

test('keywords: English terms and numbers weigh 2, Chinese pairs 1, filler dropped', () => {
  const words = Object.fromEntries(voice.keywords('就是 Redis 的 6379 端口').map(word => [word.token, word.weight]));
  assert.deepEqual(words, { redis: 2, 6379: 2, 端口: 1 });
  assert.ok(voice.keywords('ＩＳＲ').some(word => word.token === 'isr'), 'Full-width letters are normalized');
});

test('suggestRating thresholds', () => {
  assert.equal(voice.suggestRating(4, 4), 'good');
  assert.equal(voice.suggestRating(2, 4), 'hard');
  assert.equal(voice.suggestRating(1, 4), 'again');
  assert.equal(voice.suggestRating(0, 0), null);
});

test('highlight marks matched words case-insensitively and keeps the original text', () => {
  const parts = voice.highlight('ISR 和 Leader 同步', ['isr', 'leader']);
  assert.equal(parts.map(part => part.text).join(''), 'ISR 和 Leader 同步');
  assert.deepEqual(parts.filter(part => part.hit).map(part => part.text), ['ISR', 'Leader']);
});

test('stablePrefix finds the confirmed part of live text', () => {
  assert.equal(voice.stablePrefix('ISR 就是和', 'ISR 就是和 leader'), 7);
  assert.equal(voice.stablePrefix('ISR 就是', 'ISR 救'), 4);
});

test('transcript: a new sentence after a pause is appended, not overwriting the earlier one', () => {
  const live = voice.createTranscript();
  live.push('ISR 就是');
  live.push('ISR 就是和 leader 保持同步的副本');
  // 停顿几秒后，系统从新的一句重新给结果（没有任何结束标记）。
  let state = live.push('如果');
  assert.equal(state.text, 'ISR 就是和 leader 保持同步的副本，如果');
  assert.equal(state.current, '如果');
  state = live.push('如果 follower 落后太久就会被踢出去', true);
  assert.equal(state.text, 'ISR 就是和 leader 保持同步的副本，如果 follower 落后太久就会被踢出去');
  assert.equal(state.current, '');
  state = live.push('只有 ISR 的副本能当 leader');
  assert.equal(state.text, 'ISR 就是和 leader 保持同步的副本，如果 follower 落后太久就会被踢出去，只有 ISR 的副本能当 leader');
});

test('transcript: revisions inside the current sentence replace it; cumulative results after a segment end are not duplicated', () => {
  const live = voice.createTranscript();
  live.push('ISR 救');
  assert.equal(live.push('ISR 就是同步副本').text, 'ISR 就是同步副本');
  const again = voice.createTranscript();
  again.push('第一句', true);
  assert.equal(again.push('第一句第二句').text, '第一句第二句');
  assert.equal(again.push('第一句第二句', true).text, '第一句第二句', 'The same final segment is not added twice');
  assert.equal(again.push('', true).text, '第一句第二句', 'An empty final keeps what was said');
});

test('transcript: stable part of the current sentence is reported for black/grey display', () => {
  const live = voice.createTranscript();
  live.push('如果 follower');
  const state = live.push('如果 follower 落后');
  assert.equal(state.current.slice(0, state.stable), '如果 follower');
});
