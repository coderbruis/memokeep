(function expose(root) {
  function createNoteSaveSession({ state, view, actions }) {
    const saveCurrentNote = async () => {
      if (!actions.isCurrent()) return true;
      await state.ready;
      if (!actions.isCurrent()) return true;
      const titleInput = view.titleInput();
      if (!titleInput) return true;
      state.latestSnapshot = actions.capture();
      if (!state.latestSnapshot.title) {
        view.setSaveError?.('笔记名称不能为空');
        view.notify('笔记名称不能为空', true);
        titleInput.focus();
        return false;
      }
      try {
        await actions.persist(state.latestSnapshot);
        view.setSaveError?.('');
        view.updateTitle();
        if (actions.refreshPending()) await actions.refresh();
        return true;
      } catch (error) {
        // The persistence coordinator already reports the failure in a toast.
        view.setSaveError?.(error.message || '保存失败，请重试');
        return false;
      }
    };
    const saveActiveNoteEditor = options => {
      if (!state.saveInFlight) {
        state.saveInFlight = saveCurrentNote(options).finally(() => {
          state.saveInFlight = null;
          view.refreshSaveState?.();
        });
        view.refreshSaveState?.();
      }
      return state.saveInFlight;
    };
    const captureActiveNoteDraft = async () => {
      await state.ready;
      const draft = actions.draft();
      if (!draft || !actions.isCurrent()) return;
      const snapshot = actions.capture();
      draft.draftBaseline ||= { ...state.savedSnapshot };
      draft.dirty = !actions.snapshotsMatch(state.savedSnapshot, snapshot);
      Object.assign(draft.draftDocument, { title: snapshot.title, content: snapshot.content, tagIds: [...snapshot.tagIds] });
      Object.assign(draft.draftDocument.metadata, { editorMode: snapshot.editorMode, noteContent: snapshot.noteContent, noteContentInitialized: snapshot.noteContentInitialized, inlineTagRows: structuredClone(snapshot.inlineTagRows || []) });
    };
    const activeNoteEditorHasChanges = () => actions.isCurrent()
      && Boolean(state.savedSnapshot)
      && (state.diagram?.hasChanges() || !actions.snapshotsMatch(state.savedSnapshot, actions.capture()));
    return { save: saveActiveNoteEditor, captureDraft: captureActiveNoteDraft, hasChanges: activeNoteEditorHasChanges };
  }
  const api = { createNoteSaveSession };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepEditor ||= {}, api);
})(globalThis);
