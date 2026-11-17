const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDataPatch, applyDataPatch } = require('../web/state-merge.js');

test('one-note patches exclude unrelated note bodies and preserve concurrent edits', () => {
  const base = { documents: [{ id: 'a', content: 'first', title: 'A' }, { id: 'b', content: 'unrelated'.repeat(10000), title: 'B' }], settings: { theme: 'light' } };
  const next = structuredClone(base); next.documents[0].content = 'updated';
  const patch = createDataPatch(base, next);
  assert.ok(JSON.stringify(patch).length < 1000);
  const current = structuredClone(base); current.documents[1].title = 'Changed elsewhere';
  const saved = applyDataPatch(current, patch);
  assert.equal(saved.documents[0].content, 'updated');
  assert.equal(saved.documents[1].title, 'Changed elsewhere');
  assert.equal(current.documents[0].content, 'first');
  assert.equal(saved.documents[1], current.documents[1], 'Unchanged records reuse their identity');
});

test('patches cover additions, deletions, settings, reorder and empty changes', () => {
  const base = { documents: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], settings: { theme: 'light', petEnabled: true }, old: 1 };
  const next = { documents: [{ id: 'c', content: 'C' }, { id: 'b', content: 'B' }], settings: { theme: 'dark', petEnabled: true }, added: 2 };
  assert.deepEqual(applyDataPatch(base, createDataPatch(base, next)), next);
  assert.deepEqual(createDataPatch(next, structuredClone(next)).fields, []);
  assert.equal(applyDataPatch(next, createDataPatch(next, next)), next);
  const reordered = { ...base, documents: [...base.documents].reverse() };
  assert.deepEqual(applyDataPatch(base, createDataPatch(base, reordered)), reordered);
});

test('patches retain same-field conflict checks and review undo protection', () => {
  const base = { documents: [{ id: 'a', content: 'base' }], reviewRecords: [{ id: 'r1' }] };
  const next = structuredClone(base); next.documents[0].content = 'ours';
  const current = structuredClone(base); current.documents[0].content = 'theirs';
  assert.throws(() => applyDataPatch(current, createDataPatch(base, next)), /其他窗口/);
  const undo = { ...base, reviewRecords: [] };
  assert.throws(() => applyDataPatch({ ...base, reviewRecords: [...base.reviewRecords, { id: 'r2' }] }, createDataPatch(base, undo)), /评分/);
});
