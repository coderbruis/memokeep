(function expose(root) {
  function createSettingsOperations({ transact }) {
    async function setSelectionCardPopupEnabled(enabled, { onStart, onFinish }) {
      const value = Boolean(enabled);
      onStart();
      try { await transact(data => { data.settings.selectionCardPopupEnabled = value; }); return true; }
      catch { return false; }
      finally { onFinish(); }
    }
    async function setStudyPreferences(minutes, newLimit) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120 || !Number.isInteger(newLimit) || newLimit < 0 || newLimit > 100) throw new Error('每天时长为1–120分钟，新卡上限为0–100张');
      await transact(data => { data.settings.studyMinutes = minutes; data.settings.newCardsPerDay = newLimit; });
    }
    return { setSelectionCardPopupEnabled, setStudyPreferences };
  }
  const api = { createSettingsOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
