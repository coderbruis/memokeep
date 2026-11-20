const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDataTransactions } = require('./fixtures/host-adapter.cjs');
const { normalizeTransactionContext } = require('./fixtures/host-adapter.cjs');

test('generic transformations are ordered and isolated before durable preparation', async () => {
  const transactions = createDataTransactions();
  const source = { before: { count: 0 }, after: { count: 1 }, context: { commandId: 'op', domainEvents: [{ kind: 'example.updated' }] } };
  transactions.addCommitParticipant({ transform(change) { assert.equal(change.context.commandId, 'op'); change.after.count += 1; return change.after; }, prepare() {} });
  transactions.addCommitParticipant({ transform(change) { change.after.count *= 3; return change.after; }, prepare() {} });
  assert.deepEqual(await transactions.transform(source), { count: 6 });
  assert.deepEqual(source.after, { count: 1 });
  transactions.addCommitParticipant({ transform() { return []; }, prepare() {} });
  await assert.rejects(transactions.transform(source), /Invalid data transformation/);
});

test('transaction facts reject unstructured, oversized and prototype-bearing inputs', () => {
  assert.equal(normalizeTransactionContext(), undefined);
  const facts = { commandId: 'command', domainEvents: [{ kind: 'note.updated', id: 'note' }] };
  assert.deepEqual(normalizeTransactionContext(facts), facts);
  assert.notEqual(normalizeTransactionContext(facts), facts);
  for (const value of [[], { commandId: 'x', domainEvents: [null] }, { commandId: '', domainEvents: [] }, JSON.parse('{"commandId":"x","domainEvents":[],"__proto__":{}}')]) {
    assert.throws(() => normalizeTransactionContext(value));
  }
  assert.throws(() => normalizeTransactionContext({ commandId: 'x', domainEvents: [{ kind: 'x', text: 'x'.repeat(4 * 1024 * 1024) }] }), /too large/);
});

test('participants prepare isolated snapshots before commit, and disposal stops future preparation', async () => {
  const calls = [], change = { before: { value: 1 }, after: { value: 2 } };
  const transactions = createDataTransactions();
  const dispose = transactions.addCommitParticipant({ prepare(snapshot) {
    snapshot.after.value = 99; calls.push('prepare');
    return { commit() { calls.push('commit'); }, rollback() { calls.push('rollback'); } };
  } });
  const prepared = await transactions.prepare(change);
  assert.deepEqual(calls, ['prepare']); assert.equal(change.after.value, 2);
  await prepared.commit(); assert.deepEqual(calls, ['prepare', 'commit']);
  dispose(); await transactions.prepare(change); assert.equal(calls.length, 2);
});

test('partial preparation failure rolls back earlier effects in reverse order', async () => {
  const calls = [], transactions = createDataTransactions();
  for (const id of [1, 2]) transactions.addCommitParticipant({ prepare() { return { rollback() { calls.push(id); } }; } });
  transactions.addCommitParticipant({ prepare() { throw new Error('prepare rejected'); } });
  await assert.rejects(transactions.prepare({ before: {}, after: {} }), /prepare rejected/);
  assert.deepEqual(calls, [2, 1]);
});

test('durable-save failure can roll back every prepared effect', async () => {
  const calls = [], transactions = createDataTransactions();
  for (const id of [1, 2]) transactions.addCommitParticipant({ prepare() {
    return { commit() { calls.push('commit'); }, rollback() { calls.push(id); } };
  } });
  const prepared = await transactions.prepare({ before: {}, after: {} });
  await prepared.rollback(); assert.deepEqual(calls, [2, 1]);
});

test('finalizer failures are reported without falsely undoing an already committed save', async () => {
  const errors = [], calls = [], transactions = createDataTransactions({ reportError: error => errors.push(error.message) });
  transactions.addCommitParticipant({ prepare() { return { commit() { throw new Error('recover pending intent'); } }; } });
  transactions.addCommitParticipant({ prepare() { return { commit() { calls.push('second finalized'); } }; } });
  await (await transactions.prepare({ before: {}, after: {} })).commit();
  assert.deepEqual(errors, ['recover pending intent']); assert.deepEqual(calls, ['second finalized']);
});

test('committed notifications isolate listeners and cannot reject the authoritative save', async () => {
  const errors = [], seen = [], transactions = createDataTransactions({ reportError: error => errors.push(error.message) });
  transactions.onCommitted(change => { change.after.value = 99; throw new Error('observer failed'); });
  const dispose = transactions.onCommitted(change => seen.push(change.after.value));
  transactions.notify({ before: { value: 1 }, after: { value: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [2]); assert.deepEqual(errors, ['observer failed']);
  dispose(); transactions.notify({ before: {}, after: { value: 3 } });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(seen, [2]);
});
