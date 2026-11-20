(function expose(root) {
  function create({ state, config, actions, legacyCheck, legacyShow }) {
    const pending = new Map(), acknowledged = new Set();
    let busy = false, visibleKey = null, lastError = null, lastIssues = null;
    const api = () => config.desktop?.reminders;
    function acknowledgeVisible() {
      const id = state.memos.activeMemoReminderId, row = pending.get(id);
      if (!row || row.key !== visibleKey || acknowledged.has(row.key)) return;
      acknowledged.add(row.key);
      while (acknowledged.size > 256) acknowledged.delete(acknowledged.values().next().value);
      void api().acknowledge({ key: row.key, memoId: id }).then(result => {
        if (!result?.recorded) acknowledged.delete(row.key);
      }).catch(() => acknowledged.delete(row.key));
    }
    function showNextMemoReminder() {
      const before = state.memos.activeMemoReminderId;
      legacyShow();
      const active = state.memos.activeMemoReminderId;
      if (active && active !== before) visibleKey = pending.get(active)?.key || null;
      acknowledgeVisible();
    }
    async function checkMemoReminders() {
      if (busy) return;
      if (!api()?.check) return legacyCheck();
      busy = true;
      try {
        const active = state.memos.activeMemoReminderId;
        const activeReceipt = active && visibleKey ? { memoId: active, key: visibleKey } : null;
        const result = await api().check(activeReceipt);
        if (!result?.handled) throw new Error('本机提醒服务尚未就绪');
        lastError = null;
        pending.clear();
        for (const row of result.rows || []) pending.set(row.memoId, row);
        const issues = JSON.stringify(result.issues || []);
        if ((result.issues || []).length && issues !== lastIssues) actions.showToast?.(`有 ${result.issues.length} 条备忘提醒格式无效，原内容已保留，请检查提醒时间。`, true);
        lastIssues = issues;
        const current = state.persistence.data.memos.find(memo => memo.id === active);
        if (active && (!current || current.completed || result.activeValid === false)) {
          actions.closeActiveMemoReminder?.();
          state.memos.activeMemoReminderId = null;
          state.memos.memoReminderQueue = state.memos.memoReminderQueue.filter(id => id !== active && pending.has(id));
          visibleKey = null;
          // Closing a dialog dispatches its close event asynchronously. Let that
          // event finish before a later check opens the replacement occurrence.
          return;
        }
        const due = (result.rows || []).map(row => state.persistence.data.memos.find(memo => memo.id === row.memoId)).filter(Boolean);
        if (due.length) { await config.desktop.openApp?.(); actions.enqueueMemoReminders(due); }
        acknowledgeVisible();
      } catch (error) {
        // Native recovery failures must not fall back to shared delivery markers.
        if (lastError !== error.message) actions.showToast?.(`提醒暂未检查：${error.message}`, true);
        lastError = error.message;
      } finally { busy = false; }
    }
    async function isCurrentReminder() {
      if (!api()?.check) return true;
      const memoId = state.memos.activeMemoReminderId, key = visibleKey;
      if (!memoId || !key) return false;
      try {
        const result = await api().check({ memoId, key });
        return result.activeValid === true && state.memos.activeMemoReminderId === memoId && visibleKey === key;
      } catch (error) {
        if (lastError !== error.message) actions.showToast?.(`提醒暂未检查：${error.message}`, true);
        lastError = error.message;
        return false;
      }
    }
    return { checkMemoReminders, showNextMemoReminder, reminderOffer: id => pending.get(id), isCurrentReminder };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemoKeepReminderDelivery = api;
})(globalThis);
