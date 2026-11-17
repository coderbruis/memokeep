const { test } = require('node:test');
const assert = require('node:assert/strict');
const points = require('../web/domain/knowledge-points.js');

const rich = (id, noteContent) => ({ id, knowledgeBaseId: 'kb', title: id, content: '', metadata: { editorMode: 'note', noteContentInitialized: true, noteContent } });
let seq = 0;
const createCard = ({ question, answer, knowledgeBaseId, createdAt }) => ({ id: `c${++seq}`, question, answer, knowledgeBaseId, status: 'active', dueAt: 1, reviewCount: 0, createdAt, updatedAt: createdAt });

test('rich notes: heading + [!要点]/[!summary] blockquotes become points; plain sections do not', () => {
  const html = '<h2>机会成本</h2><p><br></p><blockquote>[!要点]</blockquote><blockquote>放弃的选项里价值最高的那个。</blockquote><blockquote>沉没成本 &amp; 决策</blockquote><p>细节</p>'
    + '<h2>边际效用</h2><blockquote>[!summary]</blockquote><blockquote>越来越少</blockquote><h2>需求定律</h2><p>没有要点</p><h3>引用但不是要点</h3><blockquote>普通引用</blockquote>';
  assert.deepEqual(points.pointsFromHtml(html), [
    { heading: '机会成本', question: '', lines: ['放弃的选项里价值最高的那个。', '沉没成本 & 决策'] },
    { heading: '边际效用', question: '', lines: ['越来越少'] },
  ]);
});

test('rich notes: bold inside a gist is kept as **bold** for review', () => {
  assert.deepEqual(points.pointsFromHtml('<h2>A</h2><blockquote>[!要点]</blockquote><blockquote><strong>是什么</strong>：放弃的<strong>最高</strong>价值</blockquote>'),
    [{ heading: 'A', question: '', lines: ['**是什么**：放弃的**最高**价值'] }]);
});

test('markdown notes: > [!要点] after a heading, list markers stripped', () => {
  const md = '# 第一章\n\n## 边际效用递减\n\n> [!要点]\n> - **是什么**：越来越少\n> - 总效用还在增加\n\n正文\n\n## 需求定律\n正文';
  assert.deepEqual(points.pointsFromMarkdown(md), [{ heading: '边际效用递减', question: '', lines: ['**是什么**：越来越少', '总效用还在增加'] }]);
});

test('gists stay out of review until opted in; auto-add setting creates them', () => {
  const data = { documents: [rich('n1', '<h2>A</h2><blockquote>[!要点]</blockquote><blockquote>a1</blockquote>')], cards: [], settings: {} };
  assert.equal(points.planSync(data).changed, false, 'Writing a gist does not create a card');
  data.settings.autoAddGists = true;
  points.applySync(data, { createCard, isoNow: () => 't0' });
  assert.equal(data.cards.length, 1); assert.equal(data.cards[0].pointOptIn, true);
});

test('opt in, update, orphan pause, revive, user pause and undo', () => {
  const data = { documents: [rich('n1', '<h2>A</h2><blockquote>[!要点]</blockquote><blockquote>a1</blockquote><h2>A</h2><blockquote>[!要点]</blockquote><blockquote>dup</blockquote>')], cards: [{ id: 'plain', question: 'q', answer: 'a' }], settings: {} };
  const point = points.optIn(data, 'n1', 'n1#A', { createCard, isoNow: () => 't1' });
  assert.equal(points.stateOf(point), 'on'); assert.equal(point.cardType, 'point'); assert.equal(point.answer, 'a1'); assert.equal(point.pointDocumentId, 'n1');
  assert.equal(points.stateOf(data.cards.find(card => card.pointKey === 'n1#A#2')), 'off', 'Duplicate heading is a separate, not-added point');
  assert.equal(points.optIn(data, 'n1', 'missing', { createCard }), null);
  assert.equal(points.planSync(data).changed, false, 'Sync after opting in is a no-op');

  Object.assign(point, { reviewCount: 3, dueAt: 99 });
  data.documents[0].metadata.noteContent = '<h2>A</h2><blockquote>[!要点]</blockquote><blockquote>a1 改过</blockquote>';
  points.applySync(data, { createCard, isoNow: () => 't2' });
  assert.equal(point.answer, 'a1 改过'); assert.equal(point.reviewCount, 3); assert.equal(point.dueAt, 99, 'Editing keeps the schedule');

  data.documents[0].metadata.noteContent = '<h2>A</h2><p>没有要点了</p>';
  const records = [{ cardId: point.id, rating: 'good' }];
  data.reviewRecords = records;
  points.applySync(data, { createCard, isoNow: () => 't3' });
  assert.equal(data.cards.includes(point), false, 'Removing the gist deletes its review card, even after reviews');
  assert.equal(data.reviewRecords, records, 'Review history stays for statistics');
  // 旧版本留下的「要点删掉后暂停」卡片：要点加回来就恢复。
  data.cards.push(point); Object.assign(point, { pointOrphan: true, status: 'paused' });
  data.documents[0].metadata.noteContent = '<h2>A</h2><blockquote>[!要点]</blockquote><blockquote>回来了</blockquote>';
  points.applySync(data, { createCard, isoNow: () => 't4' });
  assert.equal(point.status, 'active'); assert.equal(point.answer, '回来了'); assert.equal(point.reviewCount, 3, 'Revived legacy point keeps its history');

  point.status = 'paused';
  points.applySync(data, { createCard, isoNow: () => 't5' });
  assert.equal(points.stateOf(point), 'paused', 'A user pause survives sync');
  points.optIn(data, 'n1', 'n1#A', { createCard });
  assert.equal(points.stateOf(point), 'on', 'Opting in again resumes');

  points.optOut(data, 'n1#A');
  assert.equal(points.stateOf(point), 'paused', 'Undo after reviews pauses instead of deleting');
  const fresh = points.optIn(data, 'n1', 'n1#A', { createCard });
  fresh.reviewCount = 0; points.optOut(data, 'n1#A');
  assert.equal(data.cards.some(card => card.pointKey === 'n1#A'), false, 'Undo before any review removes the card');
  assert.equal(data.cards.find(card => card.id === 'plain').cardType, undefined, 'Ordinary cards are untouched');
});

test('cards auto-created by the previous version: unreviewed ones are removed, reviewed ones are kept as added', () => {
  const data = { documents: [rich('n1', '<h2>A</h2><blockquote>[!要点]</blockquote><blockquote>a</blockquote><h2>B</h2><blockquote>[!要点]</blockquote><blockquote>b</blockquote>')], settings: {},
    cards: [{ id: 'old-a', cardType: 'point', pointKey: 'n1#A', question: 'A', answer: 'a', reviewCount: 0, status: 'active' }, { id: 'old-b', cardType: 'point', pointKey: 'n1#B', question: 'B', answer: 'b', reviewCount: 2, status: 'active' }] };
  points.applySync(data, { createCard, isoNow: () => 't' });
  assert.deepEqual(data.cards.map(card => [card.id, points.stateOf(card)]), [['old-b', 'on']]);
});

// design/prototype/gist-question-20261113.md
test('question: a first line 「题目：…」 becomes the question and is left out of the answer; otherwise the heading is used', () => {
  const gist = lines => `<h2>2.1 场景识别</h2><blockquote>[!要点]</blockquote>${lines.map(line => `<blockquote>${line}</blockquote>`).join('')}`;
  assert.deepEqual(points.pointsFromHtml(gist(['<br>', '<strong>题目：</strong>怎么做到 95%？', '规则粗筛', '小模型打分'])),
    [{ heading: '2.1 场景识别', question: '怎么做到 95%？', lines: ['规则粗筛', '小模型打分'] }]);
  assert.equal(points.pointsFromHtml(gist(['题目: 半角冒号', 'a']))[0].question, '半角冒号');
  assert.deepEqual(points.pointsFromHtml(gist(['题目：', 'a']))[0], { heading: '2.1 场景识别', question: '', lines: ['a'] }, 'Empty question falls back to the heading');
  assert.deepEqual(points.pointsFromHtml(gist(['a', '题目：不在第一行']))[0], { heading: '2.1 场景识别', question: '', lines: ['a', '题目：不在第一行'] });
  assert.deepEqual(points.pointsFromMarkdown('## H\n\n> [!要点]\n> **题目：**为什么？\n> - 因为'), [{ heading: 'H', question: '为什么？', lines: ['因为'] }]);
  assert.deepEqual(points.pointsOfDocument(rich('n1', gist(['题目：只有题目']))), [], 'A question without content is not a point');
});

test('question: the card follows the question, keeps its key and progress, and remembers the heading', () => {
  const html = question => `<h2>H</h2><blockquote>[!要点]</blockquote>${question ? `<blockquote>题目：${question}</blockquote>` : ''}<blockquote>a</blockquote>`;
  const data = { documents: [rich('n1', html(''))], cards: [], settings: {} };
  const card = points.optIn(data, 'n1', 'n1#H', { createCard });
  assert.deepEqual([card.question, card.pointHeading, points.headingOf(card)], ['H', undefined, 'H']);
  card.reviewCount = 3;
  data.documents[0].metadata.noteContent = html('为什么？');
  assert.equal(points.planSync(data).changed, true);
  points.applySync(data, { createCard, isoNow: () => 't' });
  assert.deepEqual([card.pointKey, card.question, card.answer, card.pointHeading, card.reviewCount], ['n1#H', '为什么？', 'a', 'H', 3]);
  assert.equal(points.planSync(data).changed, false);
  data.documents[0].metadata.noteContent = html('');
  points.applySync(data, { createCard, isoNow: () => 't' });
  assert.deepEqual([card.question, 'pointHeading' in card], ['H', false]);
});
