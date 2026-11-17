const test = require('node:test');
const assert = require('node:assert/strict');
const anchors = require('../web/domain/card-anchors.js');

const note = '1.2 CAP\nCAP 定理指出，分布式系统最多只能同时满足一致性、可用性和分区容错性中的两项。网络分区一定会发生。\n1.3 拜占庭问题\n拜占庭问题的核心是：即使部分节点会作恶，诚实节点也要能达成一致。结论是 n ≥ 3f + 1。\n常见算法有 PBFT。\n';
const quote = '拜占庭问题的核心是：即使部分节点会作恶，诚实节点也要能达成一致。';

test('textOf keeps embeds as one character so indexes match the editor', () => {
  assert.equal(anchors.textOf({ ops: [{ insert: 'ab' }, { insert: { image: 'x' } }, { insert: 'c\n' }] }), 'ab￼c\n');
});

test('create trims whitespace and records context and heading', () => {
  const at = note.indexOf(quote);
  const anchor = anchors.create(note, at - 1, quote.length + 1, { documentId: 'd', heading: '1.3 拜占庭问题', now: 't' });
  assert.equal(anchor.quote, quote);
  assert.equal(anchor.prefix, note.slice(at - 32, at));
  assert.equal(anchor.suffix, note.slice(at + quote.length, at + quote.length + 32));
  assert.deepEqual([anchor.documentId, anchor.heading, anchor.createdAt], ['d', '1.3 拜占庭问题', 't']);
  assert.equal(anchors.create(note, 0, 0, {}), null);
});

test('resolve: exact, picks the right copy by context, then stale after edits, then missing', () => {
  const anchor = anchors.create(note, note.indexOf(quote), quote.length, { documentId: 'd' });
  assert.deepEqual(anchors.resolve(note, anchor), { index: note.indexOf(quote), length: quote.length, status: 'exact' });
  const twice = `${quote}\n其他\n${note}`;
  assert.equal(anchors.resolve(twice, anchor).index, twice.lastIndexOf(quote), 'Context picks the original copy');
  const edited = note.replace('即使部分节点会作恶', '即使一部分节点作恶或者宕机');
  const stale = anchors.resolve(edited, anchor);
  assert.equal(stale.status, 'stale');
  assert.match(edited.slice(stale.index, stale.index + stale.length), /一部分节点作恶或者宕机/);
  assert.equal(anchors.resolve(note.replace(/1\.3 拜占庭问题\n.*\n/, ''), anchor).status, 'missing', 'Deleted paragraph');
});

test('resolve falls back to the most similar paragraph when the context changed too', () => {
  const anchor = anchors.create(note, note.indexOf(quote), quote.length, { documentId: 'd' });
  const rewritten = '完全不同的开头\n拜占庭问题的核心是：即使部分节点会作恶，诚实节点也要能够达成一致。\n完全不同的结尾\n';
  const found = anchors.resolve(rewritten, anchor);
  assert.equal(found.status, 'stale');
  assert.equal(rewritten.slice(found.index, found.index + found.length), '拜占庭问题的核心是：即使部分节点会作恶，诚实节点也要能够达成一致。');
});

test('infer finds old cards by their answer; short or unrelated answers are skipped', () => {
  const headings = [{ index: 0, text: '1.2 CAP' }, { index: note.indexOf('1.3'), text: '1.3 拜占庭问题' }];
  const exact = anchors.infer(note, { answer: quote, createdAt: 'c' }, { documentId: 'd', headings });
  assert.deepEqual([exact.quote, exact.heading, exact.inferred, exact.createdAt], [quote, '1.3 拜占庭问题', true, 'c']);
  const partOfParagraph = anchors.infer(note, { answer: 'CAP 定理指出，分布式系统最多只能同时满足一致性、可用性和分区容错性中的两项。' }, { documentId: 'd', headings });
  assert.equal(partOfParagraph.heading, '1.2 CAP');
  assert.equal(anchors.infer(note, { answer: '是的' }, { documentId: 'd' }), null);
  assert.equal(anchors.infer(note, { answer: 'Kafka 的 ISR 是同步副本集合' }, { documentId: 'd' }), null);
});

test('overlaps', () => {
  assert.equal(anchors.overlaps({ index: 10, length: 5 }, { index: 14, length: 3 }), true);
  assert.equal(anchors.overlaps({ index: 10, length: 5 }, { index: 15, length: 3 }), false);
  assert.equal(anchors.overlaps({ index: -1, length: 0 }, { index: 0, length: 3 }), false);
});
