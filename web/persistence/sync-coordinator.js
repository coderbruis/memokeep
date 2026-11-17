(function expose(root) {
  function createSyncCoordinator({ state, storage, normalize, patches, isDirty, onPreferences, beforeApply, afterApply }) {
    function syncPluginPreferences(preferences = {}) {
      let baselineChanged = false;
      for (const key of ['plugins', 'pluginsSeen']) {
        const value = preferences[key];
        for (const owner of [state.data, state.baseline]) {
          if (!owner) continue;
          owner.settings ||= {};
          if (owner === state.baseline && (JSON.stringify(owner.settings[key]) !== JSON.stringify(value)
            || Object.hasOwn(owner.settings, key) !== (value !== undefined))) baselineChanged = true;
          if (value === undefined) delete owner.settings[key];
          else owner.settings[key] = structuredClone(value);
        }
      }
      // A partial baseline no longer matches the host's full snapshot token.
      // Request a full response on the next save/read, without reading the draft now.
      if (baselineChanged && (storage.supportsReadChanges || storage.supportsPatches)) state.token = null;
    }

    async function refresh() {
      if (state.refreshInFlight) { state.refreshAgain = true; return state.refreshInFlight; }
      state.refreshInFlight = (async () => {
        do { state.refreshAgain = false; await apply(); }
        while (state.refreshAgain && state.ready && !state.saving);
      })();
      try { await state.refreshInFlight; }
      finally { state.refreshInFlight = null; }
    }
    async function apply() {
      if (!state.ready) return;
      state.refreshPending = true;
      // Preserve an unsaved draft and its original conflict baseline.
      if (state.saving) return;
      if (isDirty() && storage.supportsEditingPreferences) {
        const baseline = state.baseline;
        const preferences = await storage.readEditingPreferences();
        if (state.saving || state.baseline !== baseline) return;
        state.data.settings.selectionCardPopupEnabled = preferences.selectionCardPopupEnabled;
        syncPluginPreferences(preferences);
        onPreferences();
        return;
      }
      const response = storage.supportsReadChanges ? await storage.readChanges(state.token) : null;
      const raw = response ? response.data || patches.applyDataPatch(state.baseline, response.patch) : storage.isDesktop ? await storage.read() : storage.read();
      if (state.saving) return;
      if (response?.patch && !response.patch.fields.length) { state.token = response.token; state.refreshPending = false; return; }
      if (isDirty()) {
        const enabled = raw?.settings?.selectionCardPopupEnabled !== false;
        state.data.settings.selectionCardPopupEnabled = enabled;
        if (state.baseline) {
          state.baseline.settings ||= {};
          state.baseline.settings.selectionCardPopupEnabled = enabled;
        }
        syncPluginPreferences(raw?.settings);
        onPreferences();
        return;
      }
      const previous = beforeApply();
      if (response) state.token = response.token;
      if (response?.patch) {
        // Discarded or failed drafts may have changed local data; replace those edits.
        state.data = normalize(patches.applyDataPatch(state.data, structuredClone(patches.createDataPatch(state.data, raw))));
        state.baseline = raw;
      } else { state.baseline = structuredClone(raw); state.data = normalize(raw); }
      state.refreshPending = false;
      afterApply(previous);
    }
    return { refresh, apply };
  }
  const api = { createSyncCoordinator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepPersistence ||= {}, api);
})(globalThis);
