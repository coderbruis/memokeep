(function expose(root) {
  function createEditorSaveHistory({ state, config, actions, env, session, features }) {
    const isCurrentEditor = () => !session.disposed
      && state.editor.editingMarkdownDocumentId === (session.target?.id || 'new')
      && config.$('#inlineMarkdownNoteForm')?.dataset.editorToken === session.editorToken;

    const serializeRichNote = () => {
      if (!session.richEditor || session.richEditorLoading) return session.richNoteContent;
      // Drain synchronous DOM changes too: image/table/code tools can change
      // attributes before MutationObserver's callback or Quill's next update.
      if (session.richContentObserver?.takeRecords().length) session.serializedRichNote = null;
      if (session.serializedRichNote !== null) return session.serializedRichNote;
      const content = session.richEditor.root.cloneNode(true);
      content.querySelectorAll('.ql-cursor').forEach(cursor => cursor.remove());
      env.serializeNoteLinkCards(content);
      content.querySelectorAll('.note-image-frame').forEach(frame => {
        const image = frame.querySelector('img');
        if (image) frame.replaceWith(image);
        else frame.remove();
      });
      content.querySelectorAll('img').forEach(image => {
        const imageId = String(image.dataset.memokeepImageId || '').toLowerCase();
        if (imageId) {
          image.setAttribute('src', `memokeep-image://${imageId}`);
          return;
        }
        if (!/^https?:\/\//i.test(image.getAttribute('src') || '')) {
          image.remove();
        }
      });
      session.serializedRichNote = actions.sanitizeRichNoteContent(content.innerHTML);
      return session.serializedRichNote;
    };

    const captureSnapshot = () => ({
      tagIds: [...session.noteTagIds],
      title: config.$('#inlineMarkdownNoteTitle').value.trim(),
      content: session.editor.value,
      editorMode: session.editorMode,
      noteContent: features.serializeRichNote(),
      noteContentInitialized: session.richNoteInitialized,
      inlineTagRows: env.structuredClone(session.inlineTagRows = actions.reconcileInlineTagRows(session.inlineTagRows, session.editor.value))
    });

    const formatVersionTime = value => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '较早版本';
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).format(date);
    };

    const renderVersionMenu = () => {
      const versions = session.target?.metadata?.versions || [];
      session.historyButton.disabled = !versions.length;
      if (!versions.length) {
        session.historyMenu.innerHTML = '<p class="note-history-empty">保存新内容后，这里会保留最近 5 版。</p>';
        return;
      }
      session.historyMenu.innerHTML = `<div class="note-history-menu-head"><strong>历史版本</strong><small>最近 ${versions.length} 版</small></div>${versions.map((version, index) => `
      <button type="button" data-note-version-index="${index}" role="menuitem">
        <span><strong>${actions.escapeHtml(features.formatVersionTime(version.savedAt))}</strong><small>${actions.escapeHtml(version.title || '未命名笔记')}</small></span>
        <em>恢复</em>
      </button>`).join('')}`;
    };

    const closeVersionMenu = () => {
      session.historyMenu.classList.add('hidden');
      session.historyButton.setAttribute('aria-expanded', 'false');
    };

    const editorTab = () => env.openNoteTabs.find(tab => tab.id === (session.target?.id || state.editor.editingMarkdownDocumentId));

    const setSaveError = message => {
      const tab = editorTab();
      if (tab) {
        if (message) tab.saveError = message;
        else delete tab.saveError;
      }
      features.refreshSaveState();
    };

    const refreshSaveState = () => {
      if (!features.isCurrentEditor() || !session.savedSnapshot) return;
      const dirty = !features.snapshotsMatch(session.savedSnapshot, features.captureSnapshot());
      const draft = env.noteDraftTab();
      if (draft) draft.dirty = dirty;
      const tab = editorTab();
      const duplicateError = session.editorMode === 'card' ? actions.validateNotebookCardQuestions(session.target?.id, session.editor.value) : '';
      const previousValidationError = session.saveValidationError;
      session.saveValidationError = duplicateError;
      if (tab) {
        if (duplicateError) tab.saveError = duplicateError;
        else if (tab.saveError === previousValidationError) delete tab.saveError;
      }
      config.$('#noteSaveStatus').textContent = session.saveInFlight ? '保存中…' : tab?.saveError || (dirty || draft ? '未保存' : '已保存');
      config.$('#noteSaveStatus').classList.toggle('is-dirty', Boolean(dirty || draft || tab?.saveError));
      config.$('#saveNoteButton').disabled = Boolean(session.saveInFlight || duplicateError) || (!dirty && !draft);
      if (duplicateError) {
        config.$('#cardQuestionError').textContent = duplicateError;
        config.$('#cardQuestionError').hidden = false;
        if (duplicateError !== previousValidationError) actions.showToast(duplicateError, true);
      } else if (previousValidationError) {
        config.$('#cardQuestionError').textContent = '';
        config.$('#cardQuestionError').hidden = true;
      }
      env.application.views.tabs.renderNoteTabs();
    };

    const persistSnapshot = snapshot => session.contentTransaction.persist(snapshot);

    const markNoteChanged = () => {
      if (!features.isCurrentEditor()) return;
      const tab = editorTab();
      const snapshot = features.captureSnapshot();
      if (tab && session.latestSnapshot && !features.snapshotsMatch(session.latestSnapshot, snapshot)) delete tab.saveError;
      session.latestSnapshot = snapshot;
      features.refreshSaveState();
    };

    const handleNoteSaveShortcut = event => {
      if (event.defaultPrevented || event.isComposing || env.window.document.querySelector('dialog[open]') || !features.isCurrentEditor() || session.editorRoot.closest('.view')?.classList.contains('hidden')) return;
      if (env.MemoKeepShortcuts.matches(event, 'save')) {
        event.preventDefault();
        if (!config.$('#saveNoteButton').disabled) state.editor.saveActiveNoteEditor();
        return;
      }
      if (env.MemoKeepShortcuts.matches(event, 'todo') && session.editorMode === 'note') {
        event.preventDefault();
        session.richEditorReady.then(() => {
          if (!features.isCurrentEditor() || !session.richEditor) return;
          session.richEditor.focus();
          const currentList = session.richEditor.getFormat().list;
          const isTaskList = currentList === 'checked' || currentList === 'unchecked';
          session.richEditor.format('list', isTaskList ? false : 'unchecked', 'user');
        });
      }
    };
    return { isCurrentEditor, serializeRichNote, captureSnapshot, formatVersionTime, renderVersionMenu, closeVersionMenu, refreshSaveState, setSaveError, persistSnapshot, markNoteChanged, handleNoteSaveShortcut };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorSaveHistory });
})(globalThis);
