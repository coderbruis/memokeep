// HostAdapter contract test fixture. This is not an application persistence service.
// Main-process extensions participate in the existing durable data commit.
function normalizeTransactionContext(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid transaction context');
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError('Transaction context must be serializable'); }
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Transaction context is too large');
  const context = JSON.parse(text, (key, item) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Invalid transaction context field');
    return item;
  });
  if (typeof context.commandId !== 'string' || !context.commandId || context.commandId.length > 128
    || !Array.isArray(context.domainEvents) || context.domainEvents.length > 100
    || context.domainEvents.some(event => !event || typeof event !== 'object' || typeof event.kind !== 'string' || event.kind.length > 100)) {
    throw new TypeError('Invalid domain transaction facts');
  }
  return context;
}
function createDataTransactions({ reportError = error => console.error('Data extension failed:', error) } = {}) {
  const participants = new Set(), listeners = new Set();
  const report = error => { try { reportError(error); } catch { /* Reporting must not change a committed save. */ } };
  async function finish(effects, method) {
    for (const effect of effects) {
      try { await effect?.[method]?.(); } catch (error) { report(error); }
    }
  }
  return {
    addCommitParticipant(participant) {
      if (typeof participant?.prepare !== 'function') throw new TypeError('A commit participant needs prepare()');
      participants.add(participant);
      return () => participants.delete(participant);
    },
    onCommitted(listener) {
      if (typeof listener !== 'function') throw new TypeError('A committed-data listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async transform(change) {
      let after = structuredClone(change.after);
      for (const participant of [...participants]) {
        if (typeof participant.transform !== 'function') continue;
        const result = await participant.transform({ ...structuredClone(change), after: structuredClone(after) });
        if (result === undefined) continue;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Invalid data transformation');
        after = structuredClone(result);
      }
      return after;
    },
    async prepare(change) {
      const effects = [];
      try {
        for (const participant of [...participants]) effects.push(await participant.prepare(structuredClone(change)));
      } catch (error) {
        await finish([...effects].reverse(), 'rollback');
        throw error;
      }
      return {
        // Finalizers must be recoverable. The authoritative file has already committed.
        commit: () => finish(effects, 'commit'),
        rollback: () => finish([...effects].reverse(), 'rollback')
      };
    },
    notify(change) {
      for (const listener of [...listeners]) {
        Promise.resolve().then(() => listener(structuredClone(change))).catch(report);
      }
    }
  };
}
module.exports = { createDataTransactions, normalizeTransactionContext };
