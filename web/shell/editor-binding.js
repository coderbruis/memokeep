(function expose(root) {
  function createEditorBinding({ state, config, actions, env }) {
    function bindInlineMarkdownEditor(document) {
      const session = { document, disposed: false }, features = {};
      const dependencies = { state, config, actions, env, session, features };
      Object.assign(features, root.MemoKeepShell.createEditorInteractions(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorCardLayout(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorImages(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorSaveHistory(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorRichText(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorOutline(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorTables(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorCardPreview(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorCardTags(dependencies));
      Object.assign(features, root.MemoKeepShell.createEditorZoom(dependencies));
      if (env.MemoKeepNoteFiles.isText(session.document)) {
        env.bindPlainTextNoteEditor(session.document);
        actions.mountNoteWorkspace({ root: config.$('#inlineMarkdownNoteForm') });
        return;
      }
      env.rememberNoteTab(session.document, state.editor.editingCardNotebookId);
      env.application.views.tabs.mountNoteTabControls();
      session.target = session.document;
      session.latestSnapshot = null;
      session.savedSnapshot = null;
      session.saveInFlight = null;
      session.noteTagIds = env.normalizeNoteTagIds(session.document?.tagIds);
      session.inlineTagRows = actions.initialInlineTagRows(session.document);
      session.slashCommandIndex = null;
      session.editorLibraryId = session.document ? session.document.knowledgeBaseId : state.knowledge.selectedLibraryId;
      session.editorToken = config.uid();
      state.editor.activeNoteEditorLibraryId = session.editorLibraryId;
      config.$('#inlineMarkdownNoteForm').dataset.editorToken = session.editorToken;
      config.$('#inlineMarkdownNoteForm').dataset.documentId = session.document?.id || 'new';
      session.canvas = config.$('.note-editor-canvas');
      session.editor = config.$('#inlineMarkdownNoteContent');
      session.commandMenu = config.$('#noteCommandMenu');
      session.contextMenu = config.$('#noteEditorContextMenu');
      session.hoverLayer = config.$('#inlineCardHoverLayer');
      session.imageTokenLayer = config.$('#noteImageTokenLayer');
      session.imageLightbox = config.$('#noteImageLightbox');
      session.imagePreviewViewer = env.bindNoteImagePreview(session.imageLightbox);
      session.tokenLayer = config.$('#inlineCardTokenLayer');
      session.previewOverlay = config.$('#inlineCardPreviewOverlay');
      session.previewHead = session.previewOverlay.querySelector('.inline-card-preview-head');
      session.previewDrag = null;
      session.previewResizeObserver = null;
      session.richEditorPane = config.$('#noteRichEditorPane');
      session.richToolbar = config.$('#noteRichToolbar');
      session.textColorButton = config.$('#noteTextColorButton');
      session.textColorMenu = config.$('#noteTextColorMenu');
      session.backgroundColorButton = config.$('#noteBackgroundColorButton');
      session.backgroundColorMenu = config.$('#noteBackgroundColorMenu');
      session.toolbarToggleButton = config.$('#toggleNoteToolbarButton');
      session.toolbarTooltip = null;
      session.toolbarResizeObserver = null;
      session.richImageInput = config.$('#noteRichImageInput');
      session.tableButton = config.$('#insertNoteTableButton');
      session.tablePicker = config.$('#noteTablePicker');
      session.tablePickerSize = config.$('#noteTablePickerSize');
      session.tableEditActions = config.$('#noteTableEditActions');
      session.tableFloatingTools = config.$('#noteTableFloatingTools');
      session.richEditorColumn = config.$('.note-rich-editor-column');
      session.richSlashMenu = config.$('#noteRichSlashMenu');
      session.codeCopyLayer = config.$('#noteCodeCopyLayer');
      session.richWorkspace = config.$('#noteRichWorkspace');
      session.outlineList = config.$('#noteOutlineList');
      session.outlinePanel = config.$('#noteOutlinePanel');
      session.outlineHoverTarget = config.$('#noteOutlineHoverTarget');
      session.outlinePin = config.$('#pinNoteOutline');
      session.historyButton = config.$('#noteHistoryButton');
      session.historyMenu = config.$('#noteHistoryMenu');
      session.textMeasureCanvas = env.window.document.createElement('canvas');
      session.textMeasureContext = session.textMeasureCanvas.getContext('2d');
      session.bulletGutter = env.window.document.createElement('div');
      session.bulletGutter.className = 'note-bullet-gutter';
      session.canvas.prepend(session.bulletGutter);
      session.layoutMirror = env.window.document.createElement('div');
      session.layoutMirror.className = 'note-layout-mirror';
      session.canvas.prepend(session.layoutMirror);
      session.imagePreviewCache = new Map();
      session.editorResizeObserver = null;
      session.editorResizeFrame = null;
      session.cardHoverClearTimer = null;
      session.hoveredInlineCardLine = null;
      session.layoutSignature = '';
      session.layoutLines = [];
      session.layoutLineSpans = [];
      session.imageTokenRevision = 0;
      session.imageTokenSignature = '';
      session.activeLightboxImageId = null;
      session.activeImageCaretId = null;
      session.contextSelectionStart = 0;
      session.contextSelectionEnd = 0;
      session.editorMode = session.target?.metadata?.editorMode === 'note' ? 'note' : 'card';
      session.cardEditorZoom = config.CARD_EDITOR_ZOOM_DEFAULT;
      session.zoomWheelDelta = 0;
      session.zoomWheelTime = 0;
      session.richNoteContent = String(session.target?.metadata?.noteContent || '');
      session.richNoteInitialized = Boolean(session.target?.metadata?.noteContentInitialized);
      session.richEditor = null;
      session.serializedRichNote = null;
      session.richContentObserver = null;
      session.lastRichSelection = null;
      session.selectionCards = null;
      session.richEditorLoading = false;
      session.tableModule = null;
      session.lastTableSelection = null;
      session.activeTableElement = null;
      session.activeTableRowIndex = -1;
      session.activeTableColumnIndex = -1;
      session.selectedTableCells = [];
      session.selectedTableAxis = null;
      session.tableToolsHideTimer = null;
      session.tableToolsInteractionUntil = 0;
      session.tableToolsResizeObserver = null;
      session.codeBlocksResizeObserver = null;
      session.disposeEditorDiagramPreview = null;
      session.noteMermaidEditor = null;
      session.disposeNoteImageTools = null;
      session.disposeNoteBlockNavigation = null;
      session.disposeNoteHeadingFold = null;
      session.disposeNoteGist = null;
      session.noteCardMarks = null;
      session.disposeNoteTableResize = null;
      session.disposeNoteLinkPaste = null;
      session.disposeNoteModes = null;
      session.disposeNoteScreenshot = null;
      session.disposeNoteCodeStyles = null;
      session.outlinePinned = session.richWorkspace.classList.contains('is-outline-pinned');
      session.outlineCloseTimer = null;
      session.outlinePositionFrame = null;
      session.outlinePositionResizeObserver = null;
      session.noteScrollViewport = session.richWorkspace.closest('.view');
      session.backToTopButton = env.window.document.createElement('button');
      session.backToTopButton.type = 'button';
      session.backToTopButton.className = 'note-back-to-top';
      session.backToTopButton.hidden = true;
      session.backToTopButton.setAttribute('aria-label', '回到顶部');
      session.backToTopButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14M12 20V8m-6 6 6-6 6 6"/></svg><span role="tooltip">回到顶部</span>';
      env.window.document.body.append(session.backToTopButton);
      session.backToTopButton.onclick = () => session.noteScrollViewport?.scrollTo({
        top: 0,
        behavior: env.window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      });
      session.richDraftImageIds = new Set();
      session.isNormalizingCodeBlock = false;
      session.editor.value = session.editor.value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => {
        if (line.trim().startsWith('```')) {
          session.isNormalizingCodeBlock = !session.isNormalizingCodeBlock;
          return line;
        }
        return session.isNormalizingCodeBlock ? line : env.application.domain.normalizeInlineCardLineSpacing(line);
      })
      .join('\n');
      session.collapsedOutlineHeadings = new WeakSet();
      session.outlineHoverTarget.onpointerenter = () => features.setOutlinePreview(true);
      session.outlineHoverTarget.onfocus = () => features.setOutlinePreview(true);
      session.outlinePanel.onpointerenter = () => env.clearTimeout(session.outlineCloseTimer);
      session.outlinePanel.onpointerleave = features.scheduleOutlineClose;
      session.outlineHoverTarget.onblur = features.scheduleOutlineClose;
      session.noteScrollViewport?.addEventListener('scroll', features.scheduleOutlineHoverTargetPosition, { passive: true });
      env.window.addEventListener('resize', features.scheduleOutlineHoverTargetPosition);
      session.outlinePositionResizeObserver = new env.ResizeObserver(features.scheduleOutlineHoverTargetPosition);
      session.outlinePositionResizeObserver.observe(session.richWorkspace);
      if (session.noteScrollViewport) session.outlinePositionResizeObserver.observe(session.noteScrollViewport);
      features.scheduleOutlineHoverTargetPosition();
      session.outlinePin.onclick = () => features.setOutlinePinned(!session.outlinePinned);
      session.outlineList.onclick = event => {
        const button = event.target.closest('[data-outline-index]');
        if (!button || !session.richEditor) return;
        const heading = [...session.richEditor.root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .filter(item => item.textContent.trim())[Number(button.dataset.outlineIndex)];
        if (!heading) return;
        const blot = env.window.Quill.find(heading);
        const index = blot ? session.richEditor.getIndex(blot) : 0;
        session.richEditor.setSelection(index, 0, 'silent');
        session.richEditor.root.focus({ preventScroll: true });
        heading.scrollIntoView({ behavior: 'smooth', block: 'center' });
        features.updateActiveOutlineItem();
      };
      session.alignmentLabels = {
        '': '左对齐',
        center: '居中对齐',
        right: '右对齐',
        justify: '两端对齐'
      };
      session.tableButton.setAttribute('aria-haspopup', 'dialog');
      session.tableButton.setAttribute('aria-expanded', 'false');
      session.tableButton.onmousedown = event => event.preventDefault();
      session.tableButton.onclick = event => {
        event.stopPropagation();
        const opening = session.tablePicker.classList.contains('hidden');
        session.tablePicker.classList.toggle('hidden', !opening);
        session.tableButton.setAttribute('aria-expanded', String(opening));
        if (opening) {
          features.positionTablePicker();
          features.refreshTableEditActions();
        }
      };
      session.tablePicker.onmousedown = event => event.preventDefault();
      session.tablePicker.onpointermove = event => {
        const cell = event.target.closest('[data-table-rows][data-table-columns]');
        if (!cell) return;
        const rows = Number(cell.dataset.tableRows);
        const columns = Number(cell.dataset.tableColumns);
        session.tablePickerSize.textContent = `${rows} × ${columns}`;
        session.tablePicker.querySelectorAll('[data-table-rows][data-table-columns]').forEach(button => {
          button.classList.toggle('selected', Number(button.dataset.tableRows) <= rows && Number(button.dataset.tableColumns) <= columns);
        });
      };
      session.tablePicker.onpointerleave = () => {
        session.tablePickerSize.textContent = '选择行列';
        session.tablePicker.querySelectorAll('[data-table-rows][data-table-columns]').forEach(button => button.classList.remove('selected'));
      };
      session.tablePicker.onclick = event => {
        const sizeCell = event.target.closest('[data-table-rows][data-table-columns]');
        if (sizeCell && session.tableModule) {
          const rows = Number(sizeCell.dataset.tableRows);
          const columns = Number(sizeCell.dataset.tableColumns);
          session.richEditor.focus();
          session.tableModule.insertTable(rows, columns);
          features.closeTablePicker();
          features.markNoteChanged();
          return;
        }
        const action = event.target.closest('[data-table-action]')?.dataset.tableAction;
        if (action && typeof session.tableModule?.[action] === 'function') {
          const tableSelection = features.resolveTableSelection();
          if (!tableSelection) return;
          session.richEditor.setSelection(tableSelection.index, 0, 'silent');
          session.tableModule[action]();
          if (action === 'deleteTable') {
            session.lastTableSelection = null;
            features.clearTableAxisSelection();
          }
          else session.lastTableSelection = session.richEditor.getSelection() || tableSelection;
          features.closeTablePicker();
          features.markNoteChanged();
        }
      };
      env.window.document.addEventListener('pointerdown', features.handleTablePickerOutsideClick);
      session.richEditorReady = Promise.resolve();
      state.editor.discardActiveNoteEditor?.();
      state.editor.activeNoteEditorBeforeLeave = () => session.noteMermaidEditor?.confirmClose() || Promise.resolve(true);
      state.editor.discardActiveNoteEditor = () => {
        session.disposed = true;
        session.disposeLearningTools?.();
        config.$('#librariesView').classList.remove('editing-card-note', 'card-editor-immersive');
        env.clearTimeout(session.cardHoverClearTimer);
        env.clearTimeout(session.outlineCloseTimer);
        env.clearTimeout(session.tableToolsHideTimer);
        session.editorResizeObserver?.disconnect();
        if (session.editorResizeFrame !== null) env.window.cancelAnimationFrame(session.editorResizeFrame);
        session.previewResizeObserver?.disconnect();
        session.tableToolsResizeObserver?.disconnect();
        session.codeBlocksResizeObserver?.disconnect();
        session.richContentObserver?.disconnect();
        session.disposeEditorDiagramPreview?.();
        session.disposeNoteImageTools?.();
        session.imagePreviewViewer.dispose();
        session.noteMermaidEditor?.dispose();
        session.disposeNoteBlockNavigation?.();
        session.disposeNoteHeadingFold?.();
        session.disposeNoteGist?.();
        session.noteCardMarks?.dispose(); session.noteCardMarks = null;
        session.disposeNoteFind?.();
        session.disposeNoteTableResize?.();
        session.disposeNoteLinkPaste?.();
        session.disposeNoteModes?.();
        session.disposeNoteScreenshot?.();
        session.disposeNoteCodeStyles?.();
        session.selectionCards?.dispose();
        session.backToTopButton.remove();
        session.outlinePositionResizeObserver?.disconnect();
        if (session.outlinePositionFrame !== null) env.window.cancelAnimationFrame(session.outlinePositionFrame);
        session.richToolbar.removeEventListener('click', features.handleSelectedTableToolbarClick, true);
        session.richToolbar.removeEventListener('change', features.handleSelectedTableToolbarChange, true);
        session.richToolbar.removeEventListener('click', features.handleAlignmentTooltipRefresh);
        session.richToolbar.removeEventListener('change', features.handleAlignmentTooltipRefresh);
        env.window.document.removeEventListener('pointerdown', features.handleModeMenuOutsideClick);
        env.window.document.removeEventListener('pointerdown', features.handleTablePickerOutsideClick);
        env.window.document.removeEventListener('keydown', features.handleNoteSaveShortcut);
        env.window.removeEventListener('memokeep-shortcuts-changed', features.refreshNoteShortcutLabels);
        env.window.document.removeEventListener('keydown', features.handleCardZoomShortcut);
        session.editorRoot.removeEventListener('wheel', features.handleCardZoomWheel);
        env.window.removeEventListener('storage', features.handleCardZoomStorage);
        session.toolbarTooltip?.remove();
        session.toolbarTooltip = null;
        session.toolbarResizeObserver?.disconnect();
        session.toolbarResizeObserver = null;
        session.noteScrollViewport?.removeEventListener('scroll', features.scheduleOutlineHoverTargetPosition);
        env.window.removeEventListener('resize', features.scheduleOutlineHoverTargetPosition);
        env.window.removeEventListener('resize', features.renderCodeCopyButtons);
        session.latestSnapshot = null;
        session.savedSnapshot = null;
      };
      session.contentTransaction = env.application.editor.factories.createNoteContentTransaction({
        state: env.application.state,
        session: {
          get target() { return session.target; }, set target(value) { session.target = value; },
          get libraryId() { return session.editorLibraryId; }, get notebookId() { return state.editor.editingCardNotebookId; },
          get richContent() { return session.richNoteContent; }, set richContent(value) { session.richNoteContent = value; },
          get imageIds() { return session.richDraftImageIds; }, get activeId() { return state.editor.editingMarkdownDocumentId; },
          set activeId(value) { state.editor.editingMarkdownDocumentId = value; }, get tabs() { return env.openNoteTabs; },
          set savedSnapshot(value) { session.savedSnapshot = value; }
        },
        services: { versionLimit: config.NOTE_VERSION_LIMIT, draft: id => env.noteDraftTab(id), documentById: id => actions.documentById(id),
          validateQuestions: actions.validateNotebookCardQuestions, imageIdsFromContent: env.application.domain.noteImageIdsFromContent,
          parseCards: env.application.domain.parseInlineCards, versionFromDocument: features.versionFromDocument, snapshotsMatch: features.snapshotsMatch, uid: () => config.uid(), normalizeTagIds: env.normalizeNoteTagIds,
          syncInlineCards: actions.syncInlineCards, syncCardSources: (...args) => actions.syncCardSources?.(...args), transact: change => env.application.persistence.transact(change), deleteImages: actions.deleteUnreferencedNoteImageFiles, isCurrent: features.isCurrentEditor },
        view: { notify: actions.showToast, refreshSaveState: features.refreshSaveState, renderVersionMenu: features.renderVersionMenu,
          renderSidebar: () => { actions.renderSidebarKnowledgeTree(); actions.refreshLearningTools?.(); }, renderCards: () => env.renderCardWorkspace(),
          setDocumentId: id => { config.$('#inlineMarkdownNoteForm').dataset.documentId = id; } }
      });
      session.noteSaveSession = env.application.editor.factories.createNoteSaveSession({
        state: {
          get ready() { return session.richEditorReady; },
          get saveInFlight() { return session.saveInFlight; }, set saveInFlight(value) { session.saveInFlight = value; },
          get latestSnapshot() { return session.latestSnapshot; }, set latestSnapshot(value) { session.latestSnapshot = value; },
          get savedSnapshot() { return session.savedSnapshot; }, get diagram() { return session.noteMermaidEditor; }
        },
        view: { titleInput: () => config.$('#inlineMarkdownNoteTitle'), notify: actions.showToast, updateTitle: actions.updateNoteWindowTitle,
          setSaveError: features.setSaveError, refreshSaveState: features.refreshSaveState },
        actions: { isCurrent: features.isCurrentEditor, capture: features.captureSnapshot,
          // 保存后同步知识点：要点删掉了，对应的复习卡片也删掉；要点改了，卡片内容跟着改。
          persist: async snapshot => { const result = await features.persistSnapshot(snapshot); actions.syncKnowledgePoints?.(); return result; },
          refreshPending: () => state.persistence.sharedDataRefreshPending, refresh: () => env.application.persistence.refresh(), draft: () => env.noteDraftTab(), snapshotsMatch: features.snapshotsMatch }
      });
      state.editor.saveActiveNoteEditor = session.noteSaveSession.save;
      env.captureActiveNoteDraft = session.noteSaveSession.captureDraft;
      state.editor.activeNoteEditorHasChanges = session.noteSaveSession.hasChanges;
      env.bindNoteTagPicker(() => session.noteTagIds, ids => { session.noteTagIds = ids; features.markNoteChanged(); });
      config.$('#saveNoteButton').onclick = () => state.editor.saveActiveNoteEditor();
      env.window.document.addEventListener('keydown', features.handleNoteSaveShortcut);
      env.window.addEventListener('memokeep-shortcuts-changed', features.refreshNoteShortcutLabels);
      session.historyButton.onclick = event => {
        event.stopPropagation();
        features.renderVersionMenu();
        const opening = session.historyMenu.classList.contains('hidden');
        session.historyMenu.classList.toggle('hidden', !opening);
        session.historyButton.setAttribute('aria-expanded', String(opening));
      };
      session.historyMenu.onclick = async event => {
        const option = event.target.closest('[data-note-version-index]');
        if (!option) return;
        const version = session.target?.metadata?.versions?.[Number(option.dataset.noteVersionIndex)];
        if (!version) return;
        features.closeVersionMenu();
        await session.richEditorReady;
        if (actions.previewNoteVersion && !await actions.previewNoteVersion(session.target?.id, Number(option.dataset.noteVersionIndex), features.captureSnapshot())) return;
        if (!features.isCurrentEditor()) return;
        config.$('#inlineMarkdownNoteTitle').value = version.title;
        session.editor.value = version.content;
        session.inlineTagRows = env.structuredClone(version.inlineTagRows || actions.reconcileInlineTagRows([], version.content));
        session.editorMode = version.editorMode === 'note' ? 'note' : 'card';
        const versionWasRichText = version.editorMode === 'note' && version.noteContentInitialized;
        session.richNoteContent = versionWasRichText ? version.noteContent : '';
        session.richNoteInitialized = Boolean(versionWasRichText);
        if (!versionWasRichText) {
          session.richEditorLoading = true;
          session.richEditor.setText(version.content || '', 'silent');
          session.richEditorLoading = false;
          session.richNoteInitialized = true;
          session.richNoteContent = features.serializeRichNote();
        }
        await features.loadRichNote(session.richNoteContent);
        features.applyEditorMode(false);
        session.disposeNoteFind?.();
        session.disposeNoteFind = env.window.MemoKeepNoteFind.mount({
          root: config.$('#inlineMarkdownNoteForm'),
          quill: session.editorMode === 'note' ? session.richEditor : null,
          textarea: session.editor,
          isCurrent: features.isCurrentEditor
        });
        features.refreshEditor();
        session.latestSnapshot = features.captureSnapshot();
        features.refreshSaveState();
        actions.showToast('已载入历史版本，点击保存后生效');
      };
      features.renderVersionMenu();
      session.previewHead.onpointerdown = event => {
        if (event.button !== 0 || !event.isPrimary || event.target.closest('button')) return;
        event.preventDefault();
        session.previewDrag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: parseFloat(session.previewOverlay.style.left),
          top: parseFloat(session.previewOverlay.style.top)
        };
        session.previewHead.setPointerCapture(event.pointerId);
        session.previewHead.classList.add('is-dragging');
      };
      session.previewHead.onpointermove = event => {
        if (!session.previewDrag || session.previewDrag.pointerId !== event.pointerId) return;
        features.moveCardPreview(session.previewDrag.left + event.clientX - session.previewDrag.x, session.previewDrag.top + event.clientY - session.previewDrag.y);
      };
      session.previewHead.onpointerup = session.previewHead.onpointercancel = event => {
        if (event.pointerId === session.previewDrag?.pointerId) features.stopPreviewDrag();
      };
      session.previewHead.onlostpointercapture = features.stopPreviewDrag;
      session.previewResizeObserver = new env.ResizeObserver(features.clampCardPreview);
      session.previewResizeObserver.observe(config.$('#inlineMarkdownNoteForm'));
      session.previewResizeObserver.observe(session.previewOverlay);
      config.$('#insertCardEditorCard').onmousedown = event => event.preventDefault();
      config.$('#insertCardEditorCard').onclick = () => {
        features.closeCommandMenu();
        features.closeCardPreview();
        const lineStart = session.editor.value.lastIndexOf('\n', session.editor.selectionStart - 1) + 1;
        const nextBreak = session.editor.value.indexOf('\n', session.editor.selectionEnd);
        const lineEnd = nextBreak === -1 ? session.editor.value.length : nextBreak;
        const isBlank = !session.editor.value.slice(lineStart, lineEnd).trim();
        const insertAt = isBlank ? lineStart : lineEnd;
        const prefix = isBlank ? '' : '\n';
        session.editor.setRangeText(`${prefix}${config.SLASH_CARD_SEPARATOR}`, insertAt, isBlank ? lineEnd : insertAt, 'end');
        const caret = insertAt + prefix.length;
        session.editor.setSelectionRange(caret, caret);
        session.editor.focus();
        features.refreshEditor();
      };
      config.$('#closeInlineEditorBtn').onclick = async () => {
        const notebook = state.persistence.data.cardNotebooks.find(note => note.id === state.editor.editingCardNotebookId) || env.noteDraftTab()?.draftNotebook;
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        if (notebook) {
          env.application.cards.runtime.cardScope = notebook.folderId ? { type: 'folder', id: notebook.folderId } : { type: 'all', id: '' };
          actions.showView('cards');
          return;
        }
        actions.renderLibraries();
        actions.renderSidebarKnowledgeTree();
      };
      if (state.editor.editingCardNotebookId) {
        config.$('#closeInlineEditorBtn').title = '返回记忆卡片';
        config.$('#closeInlineEditorBtn').setAttribute('aria-label', '返回记忆卡片');
      }
      actions.bindCardQuestionInputGuard(session.editor,
      value => session.editorMode === 'card' ? actions.validateNotebookCardQuestions(session.target?.id, value) : '',
      message => {
        config.$('#cardQuestionError').textContent = message;
        config.$('#cardQuestionError').hidden = !message;
        session.editor.setAttribute('aria-invalid', String(Boolean(message)));
      });
      session.editor.oninput = event => {
        if (event.isComposing) return;
        actions.normalizeInlineCardSpacing(session.editor);
        features.closeCardPreview();
        features.refreshEditor();
        features.updateCommandMenu();
      };
      session.editor.oncontextmenu = event => {
        event.preventDefault();
        features.closeCommandMenu();
        features.closeCardPreview();
        session.contextSelectionStart = session.editor.selectionStart;
        session.contextSelectionEnd = session.editor.selectionEnd;
        const bounds = session.canvas.getBoundingClientRect();
        const menuWidth = 176;
        const menuHeight = 46;
        session.contextMenu.style.left = `${Math.max(8, Math.min(event.clientX - bounds.left, session.canvas.clientWidth - menuWidth - 8))}px`;
        session.contextMenu.style.top = `${Math.max(8, Math.min(event.clientY - bounds.top, session.canvas.clientHeight - menuHeight - 8))}px`;
        session.contextMenu.classList.remove('hidden');
      };
      session.editor.onpaste = async event => {
        const imageFiles = [...(event.clipboardData?.items || [])]
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);
        if (!imageFiles.length) return;
        event.preventDefault();
        features.closeContextMenu();
        session.contextSelectionStart = session.editor.selectionStart;
        session.contextSelectionEnd = session.editor.selectionEnd;
        if (!config.desktop?.saveNoteImage) {
          actions.showToast('当前环境不支持粘贴本地图片', true);
          return;
        }
        try {
          const images = [];
          for (const file of imageFiles) {
            const bytes = new env.Uint8Array(await file.arrayBuffer());
            images.push(await config.desktop.saveNoteImage({ bytes, mimeType: file.type, name: file.name || '粘贴图片' }));
          }
          features.insertImageReferences(images);
          actions.showToast(`已插入 ${images.length} 张图片`);
        } catch (error) {
          actions.showToast(`粘贴图片失败：${error.message}`, true);
        }
      };
      session.editor.onkeydown = event => {
        if (features.handleAtomicImageDelete(event)) return;
        if (session.activeImageCaretId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab'].includes(event.key)) {
          session.activeImageCaretId = null;
          features.renderNoteImageTokens();
        }
        const caret = session.editor.selectionStart;
        const isAddingAnotherBlankLine = event.key === 'Enter'
        && !event.isComposing
        && session.editor.selectionStart === session.editor.selectionEnd
        && features.getLineAt(session.editor.value, caret).line.trim() === '';
        if (isAddingAnotherBlankLine) {
          event.preventDefault();
          features.closeCommandMenu();
          return;
        }
        const isSecondEquals = event.key === '='
        && session.editor.selectionStart === session.editor.selectionEnd
        && session.editor.value[caret - 1] === '=';
        if (isSecondEquals) {
          const valueWithoutFirstEquals = `${session.editor.value.slice(0, caret - 1)}${session.editor.value.slice(caret)}`;
          if (features.currentLineAlreadyHasCard(valueWithoutFirstEquals, caret - 1)) {
            event.preventDefault();
            session.editor.setRangeText('', caret - 1, caret, 'end');
            features.closeCommandMenu();
            features.refreshEditor();
            actions.showToast('一行只能创建一张记忆卡片，请换行后继续', true);
            return;
          }
        }
        if (!session.contextMenu.classList.contains('hidden') && event.key === 'Escape') {
          event.preventDefault();
          features.closeContextMenu();
          return;
        }
        if (!session.previewOverlay.classList.contains('hidden') && event.key === 'Escape') {
          event.preventDefault();
          features.closeCardPreview();
          return;
        }
        if (session.commandMenu.classList.contains('hidden')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          features.closeCommandMenu();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          features.insertCardSeparator();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
        }
      };
      session.editor.onclick = () => {
        if (session.activeImageCaretId) {
          session.activeImageCaretId = null;
          features.renderNoteImageTokens();
        }
        features.renderLineBullets();
        features.renderInlineCardHover();
        features.updateCommandMenu();
      };
      session.editor.onselect = () => { features.renderLineBullets(); features.renderInlineCardHover(); };
      session.editor.onfocus = features.renderInlineCardHover;
      session.editor.onblur = () => env.requestAnimationFrame(() => { if (features.isCurrentEditor()) features.renderInlineCardHover(); });
      session.editor.onmousemove = event => {
        env.clearTimeout(session.cardHoverClearTimer);
        features.updateInlineCardRowHover(event);
      };
      session.editor.onmouseleave = event => {
        if (event.relatedTarget?.closest?.('[data-inline-card-line]')) return;
        features.scheduleInlineCardHoverClear();
      };
      session.editor.onscroll = event => {
        features.closeCardPreview();
        features.closeContextMenu();
        features.setHoveredInlineCardLine(null);
        session.bulletGutter.style.transform = `translateY(${-event.target.scrollTop}px)`;
        features.renderInlineCardTokens();
        features.renderNoteImageTokens();
        if (!session.commandMenu.classList.contains('hidden')) features.positionCommandMenu();
      };
      session.inlineTagPanel = env.window.document.createElement('div');
      session.inlineTagPanel.className = 'inline-tag-panel';
      session.inlineTagPanel.setAttribute('popover', 'auto');
      session.inlineTagPanel.setAttribute('aria-label', '管理此卡片标签');
      config.$('#inlineMarkdownNoteForm').append(session.inlineTagPanel);
      session.tagRowIndex = null;
      session.inlineTagPanel.oninput = event => { if (event.target.type === 'search') features.renderInlineTags(); };
      session.inlineTagPanel.onchange = event => {
        const tag = event.target.dataset.inlineTag;
        if (tag === undefined) return;
        const row = session.inlineTagRows[session.tagRowIndex];
        row.tags = event.target.checked ? [...new Set([...row.tags, tag])] : row.tags.filter(value => value !== tag);
        features.markNoteChanged(); features.renderInlineTags();
        [...session.inlineTagPanel.querySelectorAll('[data-inline-tag]')].find(input => input.dataset.inlineTag === tag)?.focus();
      };
      session.inlineTagPanel.onclick = event => {
        if (event.target.closest('[data-close-tags]')) { session.inlineTagPanel.hidePopover(); session.editor.focus(); return; }
        const row = session.inlineTagRows[session.tagRowIndex];
        const remove = event.target.closest('[data-remove-tag]');
        if (remove) row.tags = row.tags.filter(tag => tag !== remove.dataset.removeTag);
        else if (event.target.closest('[data-create-tag]')) {
          const input = session.inlineTagPanel.querySelector('input[type=search]');
          const tag = input.value.trim();
          if (!tag) return;
          row.tags = [...new Set([...row.tags, tag])]; input.value = '';
        } else return;
        features.markNoteChanged(); features.renderInlineTags();
      };
      session.inlineTagPanel.onkeydown = event => {
        if (event.key === 'Enter' && event.target.type === 'search') { event.preventDefault(); session.inlineTagPanel.querySelector('[data-create-tag]').click(); }
      };
      session.tokenLayer.onclick = event => {
        const token = event.target.closest('[data-inline-card-line]');
        if (!token) return;
        const lineIndex = Number(token.dataset.inlineCardLine);
        if (token.dataset.inlineCardAction === 'delete') {
          const range = actions.inlineCardLineDeleteRange(session.editor.value, lineIndex);
          if (!range) return;
          features.closeCardPreview();
          if (session.inlineTagPanel.matches(':popover-open')) session.inlineTagPanel.hidePopover();
          session.editor.focus();
          session.editor.setSelectionRange(range.start, range.end);
          // Native text deletion participates in the textarea undo history.
          if (!env.window.document.execCommand('delete', false)) {
            session.editor.setRangeText('', range.start, range.end, 'start');
            features.refreshEditor();
          }
          features.setHoveredInlineCardLine(null);
          actions.showToast('卡片已移除，保存笔记后生效');
          return;
        }
        if (token.dataset.inlineCardAction === 'tags') { features.openInlineTags(lineIndex, token); return; }
        if (token.dataset.inlineCardAction === 'copy') {
          const sourceLine = session.editor.value.replace(/\r\n?/g, '\n').split('\n')[lineIndex] || '';
          actions.copyTextToClipboard(sourceLine.trim(), '卡片内容已复制');
          return;
        }
        features.openCardPreview(lineIndex, token);
      };
      session.tokenLayer.onfocusin = features.renderInlineCardHover;
      session.tokenLayer.onfocusout = () => env.requestAnimationFrame(() => { if (features.isCurrentEditor()) features.renderInlineCardHover(); });
      session.tokenLayer.onmouseover = event => {
        const token = event.target.closest('[data-inline-card-line]');
        if (!token) return;
        env.clearTimeout(session.cardHoverClearTimer);
        features.setHoveredInlineCardLine(Number(token.dataset.inlineCardLine));
      };
      session.tokenLayer.onmouseout = event => {
        const token = event.target.closest('[data-inline-card-line]');
        if (!token) return;
        const nextToken = event.relatedTarget?.closest?.('[data-inline-card-line]');
        if (nextToken?.dataset.inlineCardLine === token.dataset.inlineCardLine) return;
        features.scheduleInlineCardHoverClear();
      };
      session.imageTokenLayer.onclick = event => {
        const token = event.target.closest('[data-note-image-id]');
        if (!token) return;
        const action = event.target.closest('[data-note-image-action]')?.dataset.noteImageAction;
        if (action === 'continue') {
          const caret = Number(token.dataset.noteImageCaret || token.dataset.noteImageEnd);
          session.activeImageCaretId = token.dataset.noteImageId;
          token.classList.add('is-caret-active');
          session.editor.focus();
          session.editor.setSelectionRange(caret, caret);
          features.closeCardPreview();
          features.closeCommandMenu();
          return;
        }
        features.openImageLightbox(token);
      };
      session.imageTokenLayer.onkeydown = event => {
        if (!['Backspace', 'Delete'].includes(event.key)) return;
        const token = event.target.closest('[data-note-image-id]');
        if (!token) return;
        event.preventDefault();
        features.removeImageIdsFromEditor([token.dataset.noteImageId]);
      };
      config.$('#insertInlineCardCommand').onmousedown = event => event.preventDefault();
      config.$('#insertInlineCardCommand').onclick = features.insertCardSeparator;
      config.$('#insertNoteImageMenuItem').onmousedown = event => event.preventDefault();
      config.$('#insertNoteImageMenuItem').onclick = features.chooseAndInsertImage;
      session.canvas.onpointerdown = event => {
        if (!event.target.closest('#noteEditorContextMenu')) features.closeContextMenu();
      };
      config.$('#closeInlineCardPreview').onclick = features.closeCardPreview;
      config.$('#closeNoteImageLightbox').onclick = features.closeImageLightbox;
      session.imageLightbox.onclick = event => {
        if (event.target === session.imageLightbox) features.closeImageLightbox();
      };
      session.imageLightbox.onkeydown = event => {
        if (['Backspace', 'Delete'].includes(event.key) && session.activeLightboxImageId) {
          event.preventDefault();
          features.removeImageIdsFromEditor([session.activeLightboxImageId]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          features.closeImageLightbox();
        }
      };
      session.previewOverlay.onclick = event => {
        if (event.target === session.previewOverlay) features.closeCardPreview();
      };
      session.previewOverlay.onkeydown = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          features.closeCardPreview();
          session.editor.focus();
        }
      };
      config.$('#revealInlineCardAnswer').onclick = event => {
        if (event.currentTarget.disabled) return;
        config.$('#inlineCardPreviewAnswer').textContent = event.currentTarget.dataset.answer;
        config.$('#inlineCardPreviewAnswer').classList.add('revealed');
        config.$('#inlineCardPreviewAnswerArea').hidden = false;
        config.$('#inlineCardPreviewHintText').textContent = '对照答案，确认自己是否真正记住。';
        config.$('#revealInlineCardAnswerIcon').setAttribute('href', '#icon-circle-check');
        config.$('#revealInlineCardAnswerLabel').textContent = '答案已显示';
        config.$('#copyInlineCardAnswer').disabled = false;
      };
      config.$('#copyInlineCardAnswer').onclick = event => {
        if (event.currentTarget.disabled) return;
        actions.copyTextToClipboard(event.currentTarget.dataset.answer, '答案已复制');
      };
      env.window.document.addEventListener('pointerdown', features.handleModeMenuOutsideClick);
      config.$('#inlineMarkdownNoteTitle').oninput = features.markNoteChanged;
      config.$('#inlineMarkdownNoteTitle').onkeydown = event => {
        if (session.editorMode !== 'note' || event.key !== 'Enter' || event.isComposing
        || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        session.richEditorReady.then(() => {
          if (features.isCurrentEditor() && session.editorMode === 'note') session.richEditor?.setSelection(0, 0, 'user');
        });
      };
      session.richEditorReady = features.initializeRichNoteEditor().then(() => {
        if (!features.isCurrentEditor()) return;
        features.applyEditorMode(false);
        session.disposeNoteFind = env.window.MemoKeepNoteFind.mount({
          root: config.$('#inlineMarkdownNoteForm'),
          quill: session.editorMode === 'note' ? session.richEditor : null,
          textarea: session.editor,
          isCurrent: features.isCurrentEditor
        });
        (session.editorMode === 'note' ? session.richWorkspace : session.canvas).classList.add('note-open-fade');
        session.latestSnapshot = features.captureSnapshot();
        session.savedSnapshot = { ...(env.noteDraftTab()?.draftBaseline || session.latestSnapshot) };
        features.refreshSaveState();
        const tab = env.openNoteTabs.find(tab => tab.id === state.editor.editingMarkdownDocumentId);
        if (tab) env.requestAnimationFrame(() => { if (features.isCurrentEditor()) config.$('#librariesView').scrollTop = tab.scrollTop; });
      }).catch(error => {
        env.console.error('Failed to initialize note rich editor', error);
        if (features.isCurrentEditor()) actions.showToast(`富文本组件加载失败：${error.message}`, true);
      });
      session.editorRoot = config.$('#inlineMarkdownNoteForm');
      session.disposeNoteScreenshot = env.window.MemoKeepScreenshot?.mount({
        platform: config.desktop,
        runtime: env.MemoKeepRuntime.createRuntime({ features: env.MemoKeepFeatures, platform: config.desktop || {}, hasEntitlement: id => actions.isPluginEnabled?.(id) ?? true }),
        notify: actions.showToast,
        buttons: [config.$('#captureNoteScreenshot'), config.$('#captureCardScreenshot')],
        isActive: () => features.isCurrentEditor() && !session.editorRoot.closest('.view')?.classList.contains('hidden')
        && !session.editorRoot.closest('.view')?.classList.contains('note-reading')
        && (session.editorMode === 'card' || Boolean(session.richEditor)) && !session.richEditorLoading,
        getSelection: () => session.editorMode === 'note'
        ? { ...(session.richEditor.getSelection() || session.lastRichSelection || { index: session.richEditor.getLength() - 1, length: 0 }) }
        : { start: session.editor.selectionStart, end: session.editor.selectionEnd },
        focus: selection => {
          if (!features.isCurrentEditor()) return;
          if (session.editorMode === 'note') { session.richEditor.focus(); session.richEditor.setSelection(selection.index, selection.length, 'silent'); }
          else { session.editor.focus(); session.editor.setSelectionRange(selection.start, selection.end); }
        },
        insert: async (payload, selection) => {
          const savedImage = await config.desktop.saveNoteImage(payload);
          const ensureCurrentEditor = async () => {
            if (features.isCurrentEditor()) return;
            await actions.deleteUnreferencedNoteImageFiles([savedImage.id]);
            throw new Error('当前笔记已切换，可粘贴已复制的截图');
          };
          await ensureCurrentEditor();
          if (session.editorMode === 'note') {
            session.richDraftImageIds.add(savedImage.id);
            const preview = await config.desktop.readNoteImage(savedImage.id);
            if (!preview?.dataUrl) throw new Error('图片保存后无法读取');
            await ensureCurrentEditor();
            const Delta = env.window.Quill.import('delta');
            env.application.editor.factories.createQuillTransactions().insertScreenshot(session.richEditor, Delta, selection, preview.dataUrl,
            { imageId: savedImage.id, imageName: savedImage.name, alt: savedImage.name });
            features.markNoteChanged();
          } else {
            session.contextSelectionStart = selection.start;
            session.contextSelectionEnd = selection.end;
            features.insertImageReferences([savedImage]);
          }
        }
      });
      session.immersiveButton = config.$('#toggleCardImmersive');
      session.disposeNoteModes = env.bindNoteViewModes(session.editorRoot, session.immersiveButton, {
        setImmersive: features.setEditorImmersive,
        preserveSelection: () => { const range=session.richEditor?.getSelection(); return () => {if(range)session.richEditor?.setSelection(range,'silent');}; },
        setReading: reading => {
          session.editor.readOnly = reading;
          config.$('#inlineMarkdownNoteTitle').readOnly = reading;
          session.richEditor?.enable(!reading);
          session.richEditorReady.then(() => { if(features.isCurrentEditor()) session.richEditor?.enable(!config.$('#librariesView').classList.contains('note-reading')); });
          features.closeCommandMenu(); features.closeContextMenu();
        }
      });
      config.$('#cardEditorZoomOut').onclick = () => features.applyCardZoom(session.cardEditorZoom - config.CARD_EDITOR_ZOOM_STEP);
      config.$('#cardEditorZoomIn').onclick = () => features.applyCardZoom(session.cardEditorZoom + config.CARD_EDITOR_ZOOM_STEP);
      config.$('#cardEditorZoomReset').onclick = () => features.applyCardZoom(config.CARD_EDITOR_ZOOM_DEFAULT);
      env.window.document.addEventListener('keydown', features.handleCardZoomShortcut);
      session.editorRoot.addEventListener('wheel', features.handleCardZoomWheel, { passive: false });
      env.window.addEventListener('storage', features.handleCardZoomStorage);
      session.savedCardZoom = null;
      try { session.savedCardZoom = env.localStorage.getItem(config.CARD_EDITOR_ZOOM_KEY); } catch { /* Use the default zoom. */ }
      features.applyCardZoom(session.savedCardZoom, false);
      session.editorResizeObserver = new env.ResizeObserver(() => {
        if (session.editorResizeFrame !== null) return;
        session.editorResizeFrame = env.requestAnimationFrame(() => {
          session.editorResizeFrame = null;
          if (features.isCurrentEditor()) features.redrawCardEditor();
        });
      });
      session.editorResizeObserver.observe(session.editor);
      features.renderCardEditorLayout();
      features.renderLineBullets();
      features.renderInlineCardTokens();
      features.renderNoteImageTokens();
      actions.mountNoteWorkspace({ root: session.editorRoot });
      session.disposeLearningTools = actions.mountLearningTools?.({ root: session.editorRoot, createCard: features.createCardFromNote });
    }
    return { bindInlineMarkdownEditor };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorBinding });
})(globalThis);
