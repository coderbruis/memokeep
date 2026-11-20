(function expose(root) {
  function createLifecycle({ state, config, actions, env }) {
    function normalize(input = {}) {
      const migratedCards = Array.isArray(input.cards) ? input.cards.map(card => ({
        ...(Object.prototype.hasOwnProperty.call(card,'cardFolderId') ? {cardFolderId:card.cardFolderId || null} : {}),
        ...Object.fromEntries(['cardType','imageOcclusion','reverseOf','splitFrom','source','favorite','pointKey','pointDocumentId','pointOrphan','pointOptIn','pointHeading','sourceAnchor','sourceAnchorDismissed','pointRecall','splitHintDismissed','extensions','keyPoints','criteria','formatExtensions','clozeText','blankIndex','clozeGroupId'].filter(key => Object.hasOwn(card, key)).map(key => [key, env.structuredClone(card[key])])),
        id: card.id || config.uid(), knowledgeBaseId: card.knowledgeBaseId || null, knowledgeItemId: card.knowledgeItemId || null, cardNotebookId: card.cardNotebookId || null,
        question: card.question || '', answer: card.answer || '', direction: card.direction || 'forward', tags: card.tags || [],
        status: card.status || 'active', dueAt: Number(card.dueAt || config.now()), lastReviewedAt: card.lastReviewedAt || null,
        reviewCount: Number(card.reviewCount ?? card.reviews ?? 0), lapseCount: Number(card.lapseCount || 0),
        strength: Number(card.strength || 0), schedulerVersion: card.schedulerVersion || 'mvp-1', schedulerData: card.schedulerData || {},
        schedulerResetAt: card.schedulerResetAt || null,
        createdAt: card.createdAt || new Date().toISOString(), updatedAt: card.updatedAt || new Date().toISOString()
      })) : [];
      const normalizedMemos = Array.isArray(input.memos) ? input.memos.map(memo => ({
        ...Object.fromEntries(['reminder', 'extensions'].filter(key => Object.hasOwn(memo, key)).map(key => [key, env.structuredClone(memo[key])])),
        id: memo.id || config.uid(),
        title: String(memo.title || '').trim(),
        notes: String(memo.notes || ''),
        remindAt: memo.remindAt || null,
        repeat: ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(memo.repeat) ? memo.repeat : 'none',
        priority: ['normal', 'medium', 'high'].includes(memo.priority) ? memo.priority : 'normal',
        tags: Array.isArray(memo.tags) ? memo.tags.filter(Boolean) : [],
        completed: Boolean(memo.completed),
        completedAt: memo.completedAt || null,
        notifiedFor: memo.notifiedFor || null,
        popupShownFor: memo.popupShownFor || null,
        createdAt: memo.createdAt || new Date().toISOString(),
        updatedAt: memo.updatedAt || memo.createdAt || new Date().toISOString()
      })).filter(memo => memo.title) : [];
      return {
        ...env.structuredClone(config.defaults), ...input, ...env.normalizeCardWorkspace(input, migratedCards), version: 2,
        knowledgeBases: Array.isArray(input.knowledgeBases) ? input.knowledgeBases : [],
        noteTags: env.normalizeNoteTags(input.noteTags),
        documents: Array.isArray(input.documents) ? input.documents.map(document => ({
          ...document,
          tagIds: env.normalizeNoteTagIds(document.tagIds),
          metadata: {
            ...(document.metadata || {}),
            versions: Array.isArray(document.metadata?.versions)
            ? document.metadata.versions.slice(0, config.NOTE_VERSION_LIMIT).map(version => ({
              savedAt: version.savedAt || new Date().toISOString(),
              title: String(version.title || document.title || ''),
              content: String(version.content || ''),
              editorMode: ['note', 'text'].includes(version.editorMode) ? version.editorMode : 'card',
              noteContent: String(version.noteContent || ''),
              noteContentInitialized: Boolean(version.noteContentInitialized)
            }))
            : []
          }
        })) : [], items: Array.isArray(input.items) ? input.items : [],
        cards: migratedCards, reviewRecords: Array.isArray(input.reviewRecords) ? input.reviewRecords : [], memos: normalizedMemos, plans: Array.isArray(input.plans) ? input.plans.filter(plan => plan && typeof plan.id === 'string') : [], focusSessions: Array.isArray(input.focusSessions) ? input.focusSessions.filter(session => session && typeof session.id === 'string' && (Number(session.minutes) > 0 || Number.isFinite(session.activeDurationMs) && session.activeDurationMs >= 0)) : [],
        freeReviews: Array.isArray(input.freeReviews) ? input.freeReviews : [],
        trash: Array.isArray(input.trash) ? input.trash : [],
        streak: { ...config.defaults.streak, ...(input.streak || {}) }, settings: { ...config.defaults.settings, ...(input.settings || {}), selectionCardPopupEnabled: input.settings?.selectionCardPopupEnabled !== false }
      };
    }

    async function load() {
      state.persistence.applicationDataReady = false;
      const loading = config.$('#startupLoading');
      loading.hidden = false;
      loading.classList.remove('failed');
      loading.setAttribute('aria-busy', 'true');
      config.$('#startupLoadingText').textContent = '正在加载…';
      config.$('#startupLoadingHint').textContent = '';
      config.$('#startupLoadingHint').hidden = true;
      config.$('#startupRetry').hidden = true;
      config.$('.shell').inert = true;
      try {
        await new Promise(resolve => env.requestAnimationFrame(() => env.setTimeout(resolve, 0)));
        const pathReady = config.desktop?.getLocalDataPath ? config.desktop.getLocalDataPath().then(path => { state.shell.localDataPath = path; }).catch(() => {}) : Promise.resolve();
        if (config.desktop?.readHomeSummary && !config.isNoteWindow) {
          const summary = await config.desktop.readHomeSummary();
          actions.renderHome(summary);
          loading.hidden = true;
          config.$('.shell').inert = false;
          config.$('#backgroundLoading').hidden = false;
          config.$('#backgroundLoading').textContent = '今日复习已就绪，目录与笔记正在后台加载…';
          await new Promise(resolve => env.requestAnimationFrame(() => env.setTimeout(resolve, 0)));
        }
        const storage = env.application.persistence.storage;
        const response = storage.supportsReadChanges ? await storage.readChanges() : null;
        const raw = response ? response.data : await storage.read('null');
        state.persistence.sharedDataToken = response?.token ?? null;
        state.persistence.persistedData = env.structuredClone(raw || {});
        state.persistence.data = actions.normalize(raw || {});
        actions.syncPluginState?.();
        const legacyCardDeletes = state.persistence.data.trash.filter(entry => entry.type === 'card' && !entry.inlineSource
        && !state.persistence.data.cards.some(card => card.knowledgeItemId === entry.card?.knowledgeItemId)
        && state.persistence.data.items.some(item => item.id === entry.card?.knowledgeItemId && item.itemType === 'inline-card'));
        actions.removeTrashedInlineRows(legacyCardDeletes);
        const repairedCardDeletes = legacyCardDeletes.some(entry => entry.inlineSource);
        state.knowledge.selectedLibraryId = state.persistence.data.knowledgeBases[0]?.id || null;
        actions.renderHome();
        await new Promise(resolve => env.requestAnimationFrame(() => env.setTimeout(resolve, 0)));
        actions.renderSidebarKnowledgeTree();
        actions.renderPlanNav?.();
        actions.renderPomodoroPill?.();
        await new Promise(resolve => env.requestAnimationFrame(() => env.setTimeout(resolve, 0)));
        env.renderCardWorkspace(true);
        env.application.views.cardEditor.fillLibrarySelects();
        actions.deferWorkspacePersistence?.();
        state.persistence.applicationDataReady = true;
        await actions.initializeEdition?.();
        if (!config.isNoteWindow) await actions.restoreOpenNotes?.();
        // 启动前、运行中用「打开方式」送来的文件。
        if (!config.isNoteWindow && config.desktop?.takeOpenedNoteFiles) {
          const openPendingFiles = () => { if (state.persistence.applicationDataReady) void actions.openExternalNoteFiles(); };
          config.desktop.onNoteFilesOpened?.(openPendingFiles);
          env.window.addEventListener('focus', openPendingFiles);
          env.document.addEventListener('close', event => {
            // Cancelling an unsaved-note prompt must not immediately ask again.
            if (event.target?.id === 'appConfirmDialog') return;
            // Cancelling first-library creation must also leave the queued file waiting.
            if (event.target?.id === 'libraryDialog' && !state.persistence.data.knowledgeBases.length) return;
            openPendingFiles();
          }, true);
          openPendingFiles();
        }
        if (!config.isNoteWindow) { actions.scheduleReminder(); actions.scheduleMemoReminders(); }
        // Existing data needs no write/full document sync just to open the app.
        // Persist legacy migrations after the first frame.
        if (!raw || raw.version !== 2 || !raw.cardOrganizationVersion || repairedCardDeletes) {
          await new Promise(resolve => env.requestAnimationFrame(() => env.setTimeout(resolve, 0)));
          await env.application.persistence.save();
        }
        await pathReady;
        if (config.isNoteWindow) actions.openNoteWindowTarget(config.noteWindowParams.get('noteKind'), config.noteWindowParams.get('noteId'));
        loading.hidden = true;
        config.$('.shell').inert = false;
        config.$('#backgroundLoading').hidden = true;
      } catch (error) {
        loading.classList.add('failed');
        config.$('#startupLoadingText').textContent = '加载失败';
        config.$('#startupLoadingHint').textContent = `无法加载本地数据：${error.message}`;
        config.$('#startupLoadingHint').hidden = false;
        config.$('#startupRetry').hidden = false;
        config.$('#startupRetry').onclick = () => actions.load();
        // Keep the already rendered summary visible if background loading fails.
        if (loading.hidden) {
          config.$('#backgroundLoading').textContent = '目录与笔记加载失败，点击重试';
          config.$('#backgroundLoading').onclick = () => { state.persistence.backgroundLoadPending = actions.load(); };
        }
      } finally { loading.setAttribute('aria-busy', 'false'); }
    }

    function renderSharedData(previousDocument) {
      const document = actions.documentById(state.editor.editingMarkdownDocumentId);
      if (state.editor.editingMarkdownDocumentId && state.editor.editingMarkdownDocumentId !== 'new' && !env.noteDraftTab()
      && (!document || state.editor.editingCardNotebookId && !state.persistence.data.cardNotebooks.some(note => note.id === state.editor.editingCardNotebookId))) {
        env.application.editor.session.resetActiveNoteEditor();
        actions.showToast('该笔记已在其他窗口删除');
      }
      if (!env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId)) state.knowledge.selectedLibraryId = state.persistence.data.knowledgeBases[0]?.id || null;
      actions.renderAll(Boolean(state.editor.editingMarkdownDocumentId) && previousDocument === JSON.stringify(document));
      actions.refreshNoteReferences?.();
      actions.updateNoteWindowTitle();
    }

    function updateNoteWindowTitle() {
      if (!config.isNoteWindow) return;
      const title = actions.documentById(state.editor.editingMarkdownDocumentId)?.title;
      if (title) {
        env.window.document.title = `${title} · MemoKeep`;
        void config.desktop?.setNoteWindowTitle?.(env.window.document.title)?.catch(() => {});
      }
    }

    function openNoteWindowTarget(kind, id) {
      if (config.isNoteWindow) actions.showView('libraries');
      if (kind === 'cards') {
        if (!env.activeCardNotebooks().some(note => note.id === id)) { actions.showToast('笔记已不存在', true); return; }
        env.application.cards.runtime.cardScope = { type: 'notebook', id };
        env.openCardNotebookView(id);
      } else if (kind === 'knowledge') {
        const document = state.persistence.data.documents.find(note => note.id === id);
        if (!document) { actions.showToast('笔记已不存在', true); return; }
        state.knowledge.selectedLibraryId = document.knowledgeBaseId;
        actions.openMarkdownNoteEditor(document);
      }
      actions.updateNoteWindowTitle();
    }

    async function openNoteInNewWindow(kind, id) {
      if (actions.isPluginEnabled?.('workspace.multiWindow') === false) return;
      const documentId = kind === 'cards' ? state.persistence.data.cardNotebooks.find(note => note.id === id)?.sourceDocumentId : id;
      try {
        if (documentId === state.editor.editingMarkdownDocumentId && state.editor.activeNoteEditorHasChanges?.()
        && !await state.editor.saveActiveNoteEditor()) return;
        if (config.desktop?.openNoteWindow) await config.desktop.openNoteWindow({ kind, id });
        else {
          const url = new env.URL(env.window.location.href);
          url.search = new env.URLSearchParams({ noteKind: kind, noteId: id }).toString();
          if (!env.window.open(url.href, '_blank', 'popup,width=1080,height=800')) actions.showToast('请允许浏览器打开新窗口', true);
        }
      } catch (error) { actions.showToast(`打开失败：${error.message}`, true); }
    }

    function renderAll(preserveNoteEditor = false) {
      actions.syncPluginState?.();
      // showView renders a page when it becomes visible; hidden pages need no DOM work.
      const view = config.$('.shell > .view:not(.hidden)')?.id;
      if (view === 'homeView') actions.renderHome();
      if (view === 'librariesView' && !preserveNoteEditor) actions.renderLibraries();
      if (view === 'memosView') actions.renderMemos();
      if (view === 'plansView') actions.renderPlans?.(); else actions.renderPlanNav?.();
      actions.renderPomodoroPill?.();
      if (view === 'cardsView') env.application.views.cards.render();
      else env.renderCardWorkspace(true);
      if (view === 'pluginsView') actions.renderPlugins?.();
      actions.renderEditionPage?.(view?.replace(/View$/, ''));
      if (view === 'growthView') actions.renderEngagement?.();
      if (view === 'learningView') actions.renderLearningHub?.();
      if (view === 'settingsView') actions.renderSettings();
      if (view === 'trashView') actions.renderTrash();
      actions.renderSidebarKnowledgeTree();
      env.application.views.cardEditor.fillLibrarySelects();
      env.application.views.tabs.renderNoteTabs();
    }
    return { normalize, load, renderSharedData, updateNoteWindowTitle, openNoteWindowTarget, openNoteInNewWindow, renderAll };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createLifecycle });
})(globalThis);
