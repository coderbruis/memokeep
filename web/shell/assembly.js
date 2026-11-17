(function expose(root) {
  function createShell({ environment: env }) {
    const state = { persistence: {}, knowledge: {}, editor: {}, memos: {}, shell: {} };
    const config = {}, actions = {};
    const dependencies = { state, config, actions, env };
    Object.assign(actions, root.MemoKeepShell.createAssets(dependencies));
    Object.assign(actions, root.MemoKeepShell.createContent(dependencies));
    Object.assign(actions, root.MemoKeepShell.createKnowledge(dependencies));
    Object.assign(actions, root.MemoKeepShell.createShellFeatures(dependencies));
    Object.assign(actions, root.MemoKeepShell.createPluginFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createLifecycle(dependencies));
    Object.assign(actions, root.MemoKeepShell.createSelectors(dependencies));
    Object.assign(actions, root.MemoKeepShell.createTrash(dependencies));
    Object.assign(actions, root.MemoKeepShell.createNotebooks(dependencies));
    Object.assign(actions, root.MemoKeepShell.createEditorView(dependencies));
    Object.assign(actions, root.MemoKeepShell.createEditorBinding(dependencies));
    Object.assign(actions, root.MemoKeepShell.createWorkspaceFeatures(dependencies));
    Object.assign(actions, root.MemoKeepShell.createWorkspaceHistory?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createPageTabFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createEngagementFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createSourceLearningFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createPlanFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createPomodoroFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createKnowledgePointFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createTodayFeatures?.(dependencies));
    Object.assign(actions, root.MemoKeepShell.createMemos(dependencies));
    Object.assign(actions, root.MemoKeepShell.createSettings(dependencies));
    Object.assign(actions, root.MemoKeepShell.createReminders(dependencies));
    Object.assign(actions, root.MemoKeepEdition?.createShellFeatures?.(dependencies));
    config.desktop = env.window.memoKeepDesktop;
    config.noteWindowParams = new env.URLSearchParams(env.window.location.search);
    config.isNoteWindow = config.noteWindowParams.has('noteId');
    env.document.documentElement.classList.toggle('note-window', config.isNoteWindow);
    env.document.documentElement.classList.toggle('note-window-mac', config.isNoteWindow && config.desktop?.platform === 'darwin');
    config.STORAGE_KEY = 'memokeep-data-v2';
    config.COLLAPSED_LIBRARIES_KEY = 'memokeep-collapsed-library-ids';
    config.SIDEBAR_COLLAPSED_KEY = 'memokeep-sidebar-collapsed';
    config.NOTE_OUTLINE_PINNED_KEY = 'memokeep-note-outline-pinned';
    config.CARD_EDITOR_ZOOM_KEY = 'memokeep-card-editor-zoom-v2';
    config.CARD_EDITOR_ZOOM_DEFAULT = 100;
    config.CARD_EDITOR_ZOOM_BASE_SCALE = .8;
    config.CARD_EDITOR_ZOOM_MIN = 80;
    config.CARD_EDITOR_ZOOM_MAX = 150;
    config.CARD_EDITOR_ZOOM_STEP = 10;
    config.NOTE_VERSION_LIMIT = 5;
    config.DAY = 86_400_000;
    config.typeLabels = { tech: '技术', vocabulary: '单词', sentences: '语句', general: '通用' };
    config.cardStageMeta = {
      all: { label: '全部' },
      new: { label: '新卡' },
      due: { label: '到期复习' },
      learning: { label: '学习中' },
      mastered: { label: '已掌握' },
      paused: { label: '已暂停' }
    };
    config.cardStageOrder = ['new', 'due', 'learning', 'mastered', 'paused'];
    config.defaults = {
      version: 2,
      knowledgeBases: [], noteTags: [], documents: [], items: [], cards: [], reviewRecords: [], memos: [], plans: [], focusSessions: [], freeReviews: [], trash: [],
      streak: { count: 0, lastDay: '' },
      settings: { reminderMinutes: 30, petEnabled: true, notificationsEnabled: true, activeHoursStart: '08:00', activeHoursEnd: '22:00', petPosition: null, knowledgeStoragePath: '', cloudSyncEnabled: true, selectionCardPopupEnabled: true }
    };
    state.persistence.data = env.structuredClone(config.defaults);
    state.persistence.persistedData = null;
    state.persistence.dataSavePending = false;
    state.persistence.sharedDataRefreshPending = false;
    state.persistence.sharedDataRefreshInFlight = null;
    state.persistence.sharedDataRefreshAgain = false;
    state.persistence.sharedDataToken = undefined;
    state.knowledge.selectedLibraryId = null;
    state.knowledge.activeDocumentId = null;
    state.editor.editingMarkdownDocumentId = null;
    state.editor.editingCardNotebookId = null;
    state.editor.pendingNewMarkdownNoteTitle = '';
    state.memos.reminderTimer = undefined;
    state.memos.memoReminderTimer = undefined;
    state.shell.sidebarCollapsed = env.localStorage.getItem(config.SIDEBAR_COLLAPSED_KEY) === 'true';
    state.knowledge.knowledgeTreeCollapsed = true;
    state.knowledge.collapsedLibraryIds = new Set(actions.loadCollapsedLibraryIds());
    state.knowledge.renamingTreeItem = null;
    state.knowledge.treeMenuPointerDown = null;
    state.shell.localDataPath = '浏览器本地存储';
    state.shell.reminderIntervalChoices = null;
    state.memos.memoContentEditor = null;
    config.applicationScripts = new Map();
    state.memos.memoDraftImageIds = new Set();
    state.editor.saveActiveNoteEditor = null;
    state.editor.discardActiveNoteEditor = null;
    state.editor.activeNoteEditorHasChanges = null;
    state.editor.activeNoteEditorBeforeLeave = null;
    state.editor.activeNoteEditorLibraryId = null;
    state.memos.activeMemoFilter = 'all';
    state.memos.memoReminderCheckRunning = false;
    state.memos.activeMemoReminderId = null;
    state.memos.memoReminderQueue = [];
    state.shell.trashClearPending = false;
    config.$ = selector => env.document.querySelector(selector);
    config.$$ = selector => [...env.document.querySelectorAll(selector)];
    config.uid = () => env.crypto.randomUUID();
    config.now = () => Date.now();
    state.persistence.applicationDataReady = false;
    state.persistence.backgroundLoadPending = null;
    config.SLASH_CARD_SEPARATOR = ' -> ';
    config.memoRepeatLabels = { none: '', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', yearly: '每年' };
    config.memoPriorityLabels = { normal: '普通', medium: '重要', high: '紧急' };
    state.shell.selectionCardPreferencePending = false;
    state.knowledge.knowledgeOperationPending = false;

    const ports = {
      data: { read: () => state.persistence.data, replace: value => { state.persistence.data = value; } },
      cardBulk: { $: config.$, document: env.document, setTimer: (...args) => env.setTimeout(...args), clearTimer: id => env.clearTimeout(id), directory: env.MemoKeepDirectoryTree,
        helpers: {
          cardFolderId: (...args) => env.cardFolderId(...args),
          uid: (...args) => config.uid(...args),
          documentById: (...args) => actions.documentById(...args),
          removeTrashedInlineRows: (...args) => actions.removeTrashedInlineRows(...args),
          initialInlineTagRows: (...args) => actions.initialInlineTagRows(...args),
          updateInlineNoteRows: (...args) => actions.updateInlineNoteRows(...args),
          showToast: (...args) => actions.showToast(...args),
          showConfirmDialog: (...args) => actions.showConfirmDialog(...args),
          renderAll: (...args) => actions.renderAll(...args),
          cardNotebookOptions: (...args) => env.cardNotebookOptions(...args),
          cardDestination: (...args) => env.cardDestination(...args),
          renderTrash: (...args) => actions.renderTrash(...args),
      } },
      cardDialogs: { $: config.$, document: env.document, Event: env.window.Event, setTimer: (...args) => env.setTimeout(...args),
        editorComponent: { mount: (...args) => env.MemoKeepCardEditor.mount(...args) },
        directory: env.MemoKeepDirectoryTree,
        presentation: { renderContent: (...args) => env.ReviewPresentation.renderContent(...args), renderAnswer: (...args) => env.ReviewPresentation.renderAnswer(...args) },
        helpers: {
          selectedLibraryId: () => state.knowledge.selectedLibraryId,
          documentById: (...args) => actions.documentById(...args),
          escapeHtml: (...args) => actions.escapeHtml(...args),
          cardNotebookOptions: (...args) => env.cardNotebookOptions(...args),
          sanitizeRichNoteContent: (...args) => actions.sanitizeRichNoteContent(...args),
          renderMarkdown: (...args) => actions.renderMarkdown(...args),
          cardDestination: (...args) => env.cardDestination(...args),
          cardFolderId: (...args) => env.cardFolderId(...args),
          uid: (...args) => config.uid(...args),
          createCard: (...args) => actions.createCard(...args),
          // 卡片详情「只练没记牢的」：用复习界面再练一轮（design/prototype/memory-boost-20261112.md）。
          startPractice: ids => env.application.views.review?.startPractice(ids),
          cardFormats: env.window.MemoKeepCardFormats,
          captureCardSource: (...args) => actions.captureCardSource?.(...args),
          renderLearningCardActions: card => actions.renderLearningCardActions?.(card) || '',
          showConfirmDialog: (...args) => actions.showConfirmDialog(...args),
          deleteUnreferencedNoteImageFiles: (...args) => actions.deleteUnreferencedNoteImageFiles(...args),
          renderAll: (...args) => actions.renderAll(...args),
          showToast: (...args) => actions.showToast(...args),
          cardStage: (...args) => actions.cardStage(...args),
          cardStageMeta: config.cardStageMeta,
          cardLibraryLabel: (...args) => actions.cardLibraryLabel(...args),
          cardSourceNoteLabel: (...args) => actions.cardSourceNoteLabel(...args),
      } },
      cards: { $: config.$, $$: config.$$, helpers: {
          closeCardContentMenus: (...args) => env.closeCardContentMenus(...args),
          renderCardWorkspace: (...args) => env.renderCardWorkspace(...args),
          cardsInScope: (...args) => env.cardsInScope(...args),
          cardStageOrder: config.cardStageOrder,
          cardStageMeta: config.cardStageMeta,
          cardStage: (...args) => actions.cardStage(...args),
          escapeHtml: (...args) => actions.escapeHtml(...args),
          cardDueLabel: (...args) => actions.cardDueLabel(...args),
          sourceLabel: (...args) => actions.sourceLabel(...args),
          matchesCardTags: (...args) => env.matchesCardTags(...args),
          renderCardTagFilters: (...args) => env.renderCardTagFilters(...args),
          summary: (...args) => env.ReviewPresentation.summary(...args),
          directory: env.MemoKeepDirectoryTree,
          now: () => config.now(),
        }, actions: {
          openPointNote: card => actions.openPointNote?.(card),
          openCardDetail: card => env.application.views.cardDetail.openCardDetail(card),
          // 列表里复习一张或所选的几张：没到期的先提前到现在，再单独开一轮（不打断今天的整轮）。
          reviewCards: async ids => {
            const wanted = new Set(ids), cards = state.persistence.data.cards.filter(card => wanted.has(card.id) && card.status === 'active');
            if (!cards.length) { actions.showToast('所选卡片都暂停了，先恢复再复习', true); return; }
            const at = config.now();
            if (cards.some(card => Number(card.dueAt) > at)) await env.application.persistence.transact(next => next.cards.forEach(card => { if (wanted.has(card.id) && card.status === 'active' && Number(card.dueAt) > at) card.dueAt = at; }));
            await env.application.operations.review.startReview(false, cards.map(card => card.id), { key: `cards:${cards.map(card => card.id).sort().join(',')}` });
          },
          chooseCardImport: (...args) => env.chooseCardImport(...args),
          createCardInWorkspace: (...args) => env.createCardInWorkspace(...args),
          renderAll: (...args) => actions.renderAll(...args),
          bindCardWorkspace: (...args) => env.bindCardWorkspace(...args),
          bindCardContentMenus: (...args) => env.bindCardContentMenus(...args),
          bindCardTagFilters: (...args) => env.bindCardTagFilters(...args),
      } },
      review: {
        model: env.ReviewSession, scheduler: env.MemoScheduler, todayKey: actions.todayKey,
        environment: {
          get applicationDataReady() { return state.persistence.applicationDataReady; },
          get backgroundLoadPending() { return state.persistence.backgroundLoadPending; },
        },
        candidates: { cardsInScope: env.cardsInScope, dueCards: actions.dueCards, showToast: actions.showToast },
        ui: { $: config.$, document: env.document, desktop: config.desktop, homePlan: () => actions.homeLearningPlan?.(), syncPoints: () => actions.syncKnowledgePoints?.(), shortcuts: { label: (...args) => env.MemoKeepShortcuts.label(...args), matches: (...args) => env.MemoKeepShortcuts.matches(...args) }, scheduler: env.MemoScheduler,
          presentation: { mount: (...args) => env.ReviewPresentation.mount(...args), renderContent: (...args) => env.ReviewPresentation.renderContent(...args), renderAnswer: (...args) => env.ReviewPresentation.renderAnswer(...args) },
          outcome: { mount: (...args) => env.ReviewOutcome.mount(...args) },
          now: config.now, documentById: actions.documentById, sourceLabel: actions.sourceLabel, sanitizeRichNoteContent: actions.sanitizeRichNoteContent, renderMarkdown: actions.renderMarkdown,
          renderAll: () => actions.renderAll(), showView: actions.showView, renderCards: () => env.application.views.cards.render(), showToast: (...args) => actions.showToast(...args), openNote: id => actions.openWorkspaceNote?.(id),
          // 复习时去原笔记编辑 / 在复习上面编辑卡片。
          openPointNote: card => actions.openPointNote?.(card), locateCardSource: card => env.window.MemoKeepLocateCardSource?.(card), editCard: card => env.application.views.cardEditor.openCardDialog(card) }
      },
      editorState: {
        get save() { return state.editor.saveActiveNoteEditor; }, set save(value) { state.editor.saveActiveNoteEditor = value; },
        get discard() { return state.editor.discardActiveNoteEditor; }, set discard(value) { state.editor.discardActiveNoteEditor = value; },
        get hasChanges() { return state.editor.activeNoteEditorHasChanges; }, set hasChanges(value) { state.editor.activeNoteEditorHasChanges = value; },
        get beforeLeave() { return state.editor.activeNoteEditorBeforeLeave; }, set beforeLeave(value) { state.editor.activeNoteEditorBeforeLeave = value; },
        get captureDraft() { return env.captureActiveNoteDraft; }, set captureDraft(value) { env.captureActiveNoteDraft = value; },
        get activeId() { return state.editor.editingMarkdownDocumentId; }, set activeId(value) { state.editor.editingMarkdownDocumentId = value; },
        get notebookId() { return state.editor.editingCardNotebookId; }, set notebookId(value) { state.editor.editingCardNotebookId = value; },
        get libraryId() { return state.editor.activeNoteEditorLibraryId; }, set libraryId(value) { state.editor.activeNoteEditorLibraryId = value; },
        get pendingTitle() { return state.editor.pendingNewMarkdownNoteTitle; }, set pendingTitle(value) { state.editor.pendingNewMarkdownNoteTitle = value; },
        get actionPending() { return env.noteTabActionPending; }, set actionPending(value) { env.noteTabActionPending = value; },
        get tabs() { return env.openNoteTabs; }, set tabs(value) { env.openNoteTabs = value; },
        get refreshPending() { return state.persistence.sharedDataRefreshPending; }, set refreshPending(value) { state.persistence.sharedDataRefreshPending = value; },
      },
      persistenceState: {
        get data() { return state.persistence.data; }, set data(value) { state.persistence.data = value; },
        get baseline() { return state.persistence.persistedData; }, set baseline(value) { state.persistence.persistedData = value; },
        get token() { return state.persistence.sharedDataToken; }, set token(value) { state.persistence.sharedDataToken = value; },
        get saving() { return state.persistence.dataSavePending; }, set saving(value) { state.persistence.dataSavePending = value; },
        get refreshPending() { return state.persistence.sharedDataRefreshPending; }, set refreshPending(value) { state.persistence.sharedDataRefreshPending = value; },
        get refreshInFlight() { return state.persistence.sharedDataRefreshInFlight; }, set refreshInFlight(value) { state.persistence.sharedDataRefreshInFlight = value; },
        get refreshAgain() { return state.persistence.sharedDataRefreshAgain; }, set refreshAgain(value) { state.persistence.sharedDataRefreshAgain = value; },
        get ready() { return state.persistence.applicationDataReady; }, set ready(value) { state.persistence.applicationDataReady = value; },
      },
      editorView: { hasForm: () => Boolean(config.$('#inlineMarkdownNoteForm')), clearChrome: () => {
          config.$('#noteTabsBar .note-tab-navigation')?.replaceChildren(); config.$('#noteTabsBar .note-tab-actions')?.replaceChildren();
      } },
      editorActions: { confirmUnsaved: id => actions.showUnsavedNoteDialog(id), draft: () => env.noteDraftTab(), activate: id => env.activateNoteTab(id) },
      tabs: { $: config.$, platform: { window: env.window, document: env.document,
          get ResizeObserver() { return env.ResizeObserver; }, get MutationObserver() { return env.MutationObserver; },
          requestFrame: callback => env.requestAnimationFrame(callback), cancelFrame: id => env.window.cancelAnimationFrame(id) }, state: {
          get tabs() { return env.openNoteTabs; }, set tabs(value) { env.openNoteTabs = value; },
          get activeId() { return state.editor.editingMarkdownDocumentId; }, get actionPending() { return env.noteTabActionPending || state.shell.pageTabPending; },
          get batchPending() { return env.noteTabBatchPending; }, get saving() { return state.persistence.dataSavePending; },
          get isNoteWindow() { return config.isNoteWindow; }, hasChanges: () => state.editor.activeNoteEditorHasChanges?.()
        }, actions: { documentById: id => actions.documentById(id), activeNotebooks: () => env.activeCardNotebooks(),
          escapeHtml: actions.escapeHtml, fileIcon: doc => env.noteFileIcon(doc), fileExtension: doc => env.noteFileExtension(doc),
          rememberWorkspace: options => actions.rememberOpenNotes?.(options),
          syncPageTabChrome: () => actions.syncPageTabChrome?.(),
          pageTabItems: () => config.isNoteWindow ? [] : actions.workspacePageTabItems?.() || [],
          orderWorkspaceTabs: items => config.isNoteWindow ? items : actions.orderWorkspaceTabs?.(items) || items,
          reorderWorkspaceTabs: config.isNoteWindow ? null : (...args) => actions.reorderWorkspaceTabs(...args),
          moveWorkspaceTab: config.isNoteWindow ? null : (...args) => actions.moveWorkspaceTab(...args),
          closeGroup: (...args) => env.closeNoteTabGroup(...args), closeTab: (...args) => env.closeNoteTab(...args), activate: id => env.activateNoteTab(id),
          requestNew: (...args) => env.requestNewNoteFile(...args), shortcuts: { label: (...args) => env.MemoKeepShortcuts.label(...args), matches: (...args) => env.MemoKeepShortcuts.matches(...args) } } },
      storage: { desktop: config.desktop, localStorage: env.localStorage, storageKey: config.STORAGE_KEY, eventTarget: env.window },
      patches: { createDataPatch: (...args) => env.createDataPatch(...args), applyDataPatch: (...args) => env.applyDataPatch(...args), mergeWindowData: (...args) => env.mergeWindowData(...args) },
      normalize: input => actions.normalize(input),
      sync: { isDirty: () => state.editor.activeNoteEditorHasChanges?.(),
        onPreferences: () => {
          actions.renderNoteEditingSettings();
          actions.syncPluginState?.();
          if (!config.$('#pluginsView')?.classList.contains('hidden')) actions.renderPlugins?.();
          env.window.dispatchEvent(new env.Event('memokeep-selection-card-preference-changed'));
        },
        beforeApply: () => JSON.stringify(actions.documentById(state.editor.editingMarkdownDocumentId)), afterApply: previous => actions.renderSharedData(previous) },
      notify: (...args) => actions.showToast(...args),
      actions: { createCard: fields => actions.createCard(fields), describeDocument: doc => actions.describeSourceDocument(doc), uid: () => config.uid(), now: () => config.now(), isoNow: () => new Date().toISOString(),
        history: (...args) => env.MemoScheduler.history(...args), folderId: card => env.cardFolderId(card),
        duplicateQuestion: cards => env.application.domain.duplicateCardQuestion(cards), availableDocumentTitle: (...args) => actions.availableDocumentTitle(...args) },
      startupState: { get ready() { return state.persistence.applicationDataReady; }, get tabs() { return env.openNoteTabs; },
        hasChanges: () => state.editor.activeNoteEditorHasChanges?.(), set loading(value) { state.persistence.backgroundLoadPending = value; } },
      startupHooks: { applySidebar: () => actions.applySidebarCollapsedState(),
        bindings: [() => actions.bindNavigationEvents(), () => actions.bindDialogEvents(), () => actions.bindKnowledgeEvents(), () => actions.bindMemoEvents(),
          () => { env.application.views.cardEvents.bind(); env.application.views.cardDialogs.bind(); env.application.views.reviewEvents.bind(); }, () => actions.bindSettingsEvents(), () => actions.bindFileEvents(), () => env.bindFileDropPreview(), () => actions.bindDesktopEvents()],
        bindInvite: () => { config.$('#inviteBtn').onclick = actions.copyInviteText; }, load: () => actions.load() },
      shell: { window: env.window, document: env.document, Element: env.window.Element, $$: config.$$, notify: (...args) => actions.showToast(...args) }
    };
    return { state, config, actions, ports };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createShell });
})(globalThis);
