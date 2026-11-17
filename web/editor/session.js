(function expose(root) {
  function createEditorSession({ state, view, actions }) {
    async function flushActiveNoteEditor() {
      if (!state.save) return true;
      if (!view.hasForm()) {
        resetActiveNoteEditor();
        return true;
      }
      if (state.beforeLeave && !await state.beforeLeave()) return false;
      if (!state.hasChanges?.()) return true;
      const action = await actions.confirmUnsaved();
      if (action === 'cancel') return false;
      if (action === 'discard') return true;
      return state.save();
    }

    function resetActiveNoteEditor() {
      state.discard?.();
      state.discard = null;
      state.save = null;
      state.hasChanges = null;
      state.beforeLeave = null;
      state.captureDraft = null;
      view.clearChrome();
      state.activeId = null;
      state.notebookId = null;
      state.libraryId = null;
      state.pendingTitle = '';
    }

    async function leaveActiveNoteEditor() {
      if (state.actionPending) return false;
      if (!state.save) return true;
      const saveEditor = state.save;
      const draft = actions.draft();
      if (!await flushActiveNoteEditor()) return false;
      if (draft?.draftDocument) state.tabs = state.tabs.filter(tab => tab !== draft);
      if (state.save === saveEditor) resetActiveNoteEditor();
      if (state.refreshPending) await actions.refresh();
      return true;
    }

    async function saveNoteBeforeTabChange() {
      if (state.beforeLeave && !await state.beforeLeave()) return false;
      if (actions.draft()) { await state.captureDraft?.(); return true; }
      if (state.hasChanges?.() && !await state.save({ quiet: true })) return false;
      return !state.hasChanges?.();
    }

    async function flushNoteTabsForWindowClose() {
      if (!await leaveActiveNoteEditor()) return false;
      for (const tab of state.tabs.filter(tab => tab.draftDocument && tab.dirty)) {
        if (!await actions.activate(tab.id)) return false;
        await state.captureDraft?.();
        if (!await leaveActiveNoteEditor()) return false;
      }
      return true;
    }
    return { flushActiveNoteEditor, resetActiveNoteEditor, leaveActiveNoteEditor, saveNoteBeforeTabChange, flushNoteTabsForWindowClose };
  }
  const api = { createEditorSession };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepEditor ||= {}, api);
})(globalThis);
