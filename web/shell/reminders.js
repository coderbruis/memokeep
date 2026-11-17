(function expose(root) {
  function createReminders({ state, config, actions, env }) {
    function inActiveHours() { const current = new Date().toTimeString().slice(0,5); const { activeHoursStart: start, activeHoursEnd: end } = state.persistence.data.settings; return start <= end ? current >= start && current <= end : current >= start || current <= end; }

    function scheduleReminder() { env.clearInterval(state.memos.reminderTimer); if (config.isNoteWindow) return; state.memos.reminderTimer = env.setInterval(() => { const due = actions.dueCards(); if (env.MemoKeepDomain?.engagementSummary?.(state.persistence.data, config.now()).restToday) return; if (!due.length || !state.persistence.data.settings.notificationsEnabled || !actions.inActiveHours()) return; const message = `还有 ${due.length} 个知识点等待回忆`; if (config.desktop) config.desktop.notify(message); else if (env.Notification.permission === 'granted') new env.Notification('MemoKeep', { body: message }); }, Math.max(1, Number(state.persistence.data.settings.reminderMinutes)) * 60_000); }

    async function initializeReminderIntervalPicker() {
      if (state.shell.reminderIntervalChoices) return;
      try { await actions.loadApplicationScript('vendor/choices/choices.min.js'); }
      catch (error) { actions.showToast(error.message, true); return; }
      if (state.shell.reminderIntervalChoices) return;
      const select = config.$('#reminderMinutes');
      if (!select || typeof env.window.Choices !== 'function') return;
      state.shell.reminderIntervalChoices = new env.window.Choices(select, {
        allowHTML: false,
        itemSelectText: '',
        position: 'bottom',
        searchEnabled: false,
        shouldSort: false
      });
    }
    return { inActiveHours, scheduleReminder, initializeReminderIntervalPicker };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createReminders });
})(globalThis);
