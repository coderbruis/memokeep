const test = require('node:test');
const assert = require('node:assert/strict');
const topics = require('../web/domain/card-topics.js');

const NOW = Date.parse('2026-11-12T10:00:00Z');
const day = 86400000;
const card = (id, extra) => ({ id, question: id, answer: '', tags: [], status: 'active', dueAt: NOW - 1000, reviewCount: 1, ...extra });
const data = () => ({
  knowledgeBases: [{ id: 'be', name: '后端' }, { id: 'kafka', name: 'kafka', parentId: 'be' }, { id: 'db', name: '数据库', parentId: 'be' }, { id: 'deep', name: '副本', parentId: 'kafka' }, { id: 'ai', name: 'Agent' }],
  documents: [{ id: 'd1', title: 'kafka快速回顾' }, { id: 'd3', title: 'PG和MySQL' }],
  items: [{ id: 'i1', documentId: 'd1' }, { id: 'i3', documentId: 'd3' }],
  cardFolders: [{ id: 'f1', name: '英语' }, { id: 'f2', name: '商务邮件', parentId: 'f1' }],
  cardNotebooks: [],
  cards: [
    card('k1', { knowledgeBaseId: 'kafka', knowledgeItemId: 'i1' }),
    card('k2', { knowledgeBaseId: 'kafka', knowledgeItemId: 'i1', reviewCount: 0 }),
    card('k3', { knowledgeBaseId: 'deep' }),
    card('k4', { knowledgeBaseId: 'kafka', knowledgeItemId: 'i1', dueAt: NOW + 3 * day }),
    card('p1', { cardType: 'point', knowledgeBaseId: 'db', pointDocumentId: 'd3' }),
    card('a1', { knowledgeBaseId: 'ai', tags: ['RAG'] }),
    card('e1', { cardFolderId: 'f2', knowledgeBaseId: 'kafka' }),
    card('x1', { tags: ['杂项'] }),
    card('s1', { knowledgeBaseId: 'kafka', status: 'paused' })
  ],
  reviewRecords: [
    { cardId: 'k1', rating: 'again', reviewedAt: new Date(NOW - 3 * day).toISOString() },
    { cardId: 'k1', rating: 'good', reviewedAt: new Date(NOW - 2 * day).toISOString() },
    { cardId: 'k1', rating: 'again', reviewedAt: new Date(NOW - day).toISOString() },
    { cardId: 'k4', rating: 'good', reviewedAt: new Date(NOW - day).toISOString() },
    { cardId: 'p1', rating: 'good', reviewedAt: new Date(NOW - 40 * day).toISOString() }
  ]
});

test('topicOf: card folder first, then knowledge base; second level is the topic', () => {
  const d = data();
  const of = id => topics.topicOf(d.cards.find(item => item.id === id), d);
  assert.deepEqual(of('k1'), { groupId: 'library:be', groupName: '后端', topicId: 'library:kafka', topicName: 'kafka', pointId: 'doc:d1', pointName: 'kafka快速回顾' });
  assert.equal(of('k3').topicId, 'library:kafka', 'Third-level knowledge base stays in its topic…');
  assert.deepEqual([of('k3').pointId, of('k3').pointName], ['library:deep', '副本'], '…and becomes the technical point');
  assert.deepEqual([of('p1').topicName, of('p1').pointName], ['数据库', 'PG和MySQL'], 'Knowledge points use their note');
  assert.deepEqual([of('a1').groupName, of('a1').topicName, of('a1').pointName], ['其他', 'Agent', 'RAG'], 'Single-level bases go to 其他; tag as point');
  assert.deepEqual([of('e1').groupName, of('e1').topicName], ['英语', '商务邮件'], 'A card folder wins over the knowledge base');
  assert.deepEqual([of('x1').topicId, of('x1').topicName], ['unfiled', '未分类']);
});

test('build: due, new, weak, retention, minutes and next due per topic and point', () => {
  const view = topics.build(data(), { now: NOW, stageOf: c => c.status === 'paused' ? 'paused' : !c.reviewCount ? 'new' : c.dueAt <= NOW ? 'due' : 'mastered' });
  assert.deepEqual(view.groups.map(group => group.name), ['后端', '英语', '其他'], 'Groups by due, 其他 last');
  const kafka = view.topicById('library:kafka');
  assert.equal(kafka.total, 5);
  assert.equal(kafka.due, 3, 'Paused and future cards are not due');
  assert.deepEqual(kafka.dueIds.sort(), ['k1', 'k2', 'k3']);
  assert.equal(kafka.new, 1);
  assert.equal(kafka.weak, 1, 'k1 forgot twice in its last reviews');
  assert.equal(kafka.retention, 50, '2 of 4 reviews in 30 days were remembered');
  assert.equal(kafka.nextDueAt, NOW + 3 * day);
  assert.deepEqual(kafka.points.map(point => `${point.name}:${point.due}`), ['kafka快速回顾:2', '副本:1', '其他:0'], 'Points sorted by due');
  assert.equal(view.topicById('library:db').retention, null, 'Reviews older than 30 days do not count');
  assert.equal(view.due, 7);
  assert.equal(view.minutes, 3);
  assert.equal(new Set(view.topics.slice(0, 6).map(topic => topic.color)).size, Math.min(6, view.topics.length), 'Up to six topics get different colors');
});

test('sortTopics: by due, by low retention, by recent review', () => {
  const list = [{ name: 'a', due: 1, total: 1, retention: 90, lastReviewedAt: 3 }, { name: 'b', due: 5, total: 5, retention: null, lastReviewedAt: 1 }, { name: 'c', due: 2, total: 2, retention: 40, lastReviewedAt: 2 }];
  assert.deepEqual(topics.sortTopics(list, 'due').map(item => item.name), ['b', 'c', 'a']);
  assert.deepEqual(topics.sortTopics(list, 'retention').map(item => item.name), ['c', 'a', 'b']);
  assert.deepEqual(topics.sortTopics(list, 'recent').map(item => item.name), ['a', 'c', 'b']);
});
