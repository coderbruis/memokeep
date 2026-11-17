(function expose(root) {
  function createMemoOperations({ transact, uid, now, isoNow }) {
    function byId(data, id) {
      const memo = data.memos.find(item => item.id === id);
      if (!memo) throw new Error('备忘录已不存在，请重新打开');
      return memo;
    }
    function upsert(existing, fields, timestamp) {
      const id = existing?.id || uid(), values = structuredClone(fields);
      return transact(data => {
        if (existing) Object.assign(byId(data, id), values);
        else data.memos.unshift({ id, ...values, completed: false, completedAt: null, createdAt: timestamp });
      });
    }
    function toggleCompletion(memo) {
      const id = memo.id;
      return transact(data => {
        const current = byId(data, id), timestamp = isoNow();
        current.completed = !current.completed;
        current.completedAt = current.completed ? timestamp : null;
        current.updatedAt = timestamp;
        if (!current.completed) { current.notifiedFor = null; current.popupShownFor = null; }
      });
    }
    function snooze(memo) {
      const id = memo.id;
      return transact(data => {
        const current = byId(data, id);
        current.remindAt = new Date(now() + 10 * 60_000).toISOString();
        current.notifiedFor = null; current.popupShownFor = null;
        current.completed = false; current.completedAt = null; current.updatedAt = isoNow();
      });
    }
    function remove(id) { return transact(data => { data.memos = data.memos.filter(memo => memo.id !== id); }); }
    function markReminded(entries, timestamp) {
      return transact(data => {
        for (const entry of entries) {
          const memo = data.memos.find(item => item.id === entry.id);
          if (!memo || memo.completed || memo.remindAt !== entry.remindAt) continue;
          if (entry.notified) memo.notifiedFor = entry.remindAt;
          memo.popupShownFor = entry.remindAt; memo.updatedAt = timestamp;
        }
      });
    }
    return { upsert, toggleCompletion, snooze, remove, markReminded };
  }
  const api = { createMemoOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
