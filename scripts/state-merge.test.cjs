const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeWindowData } = require('../web/state-merge.js');

test('merges edits from stale windows without losing other notes or review progress', () => {
  const base = { documents: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], cards: [{ id: 'c', reviewCount: 0 }] };
  const next = structuredClone(base);
  next.documents[0].content = 'edited A';
  const current = structuredClone(base);
  current.documents[1].content = 'edited B';
  current.documents.push({ id: 'new', content: 'new note' });
  current.cards[0].reviewCount = 2;
  assert.deepEqual(mergeWindowData(base, next, current), {
    documents: [{ id: 'a', content: 'edited A' }, { id: 'b', content: 'edited B' }, { id: 'new', content: 'new note' }],
    cards: [{ id: 'c', reviewCount: 2 }]
  });
});

test('does not resurrect deleted notes or silently overwrite a concurrent edit', () => {
  const base = { documents: [{ id: 'a', content: 'A' }] };
  assert.deepEqual(mergeWindowData(base, base, { documents: [] }), { documents: [] });
  const changed = { documents: [{ id: 'a', content: 'changed' }] };
  assert.throws(() => mergeWindowData(base, changed, { documents: [] }), /其他窗口/);
  assert.throws(() => mergeWindowData(base, changed, { documents: [{ id: 'a', content: 'other edit' }] }), /其他窗口/);
  assert.throws(() => mergeWindowData(base, { documents: [] }, changed), /其他窗口/);
});

test('preserves unrelated additions, removals and settings changes', () => {
  const base = { cards: [{ id: 'a' }, { id: 'b' }], settings: { petEnabled: true, reminderMinutes: 30 } };
  const next = { cards: [{ id: 'b' }, { id: 'c' }], settings: { petEnabled: true, reminderMinutes: 60 } };
  const current = { cards: [{ id: 'a' }, { id: 'b', reviewCount: 1 }, { id: 'd' }], settings: { petEnabled: false, reminderMinutes: 30 } };
  assert.deepEqual(mergeWindowData(base, next, current), {
    cards: [{ id: 'b', reviewCount: 1 }, { id: 'd' }, { id: 'c' }], settings: { petEnabled: false, reminderMinutes: 60 }
  });
});

test('undo is atomic against concurrently added ratings while allowing unrelated note edits', () => {
  const base = { reviewRecords: [{ id: 'r1', cardId: 'a' }], cards: [{ id: 'a', reviewCount: 1 }], documents: [{ id: 'n', content: 'before' }] };
  const next = structuredClone(base); next.reviewRecords = []; next.cards[0].reviewCount = 0;
  const current = structuredClone(base); current.reviewRecords.push({ id: 'r2', cardId: 'b' });
  assert.throws(() => mergeWindowData(base, next, current), /无法撤销/);
  current.reviewRecords.pop(); current.documents[0].content = 'other window';
  const result = mergeWindowData(base, next, current);
  assert.equal(result.cards[0].reviewCount, 0);
  assert.equal(result.reviewRecords.length, 0);
  assert.equal(result.documents[0].content, 'other window');
});
