(function expose(root) {
  function createNotebooks({ state, config, actions, env }) {
    let noteOpenWorker = null, pendingNoteOpen = null;
    function updateInlineNoteRows(note, rows, data = state.persistence.data) {
      note.content = rows.map(row => row.raw).join('\n');
      note.metadata = { ...note.metadata, inlineTagRows: env.structuredClone(rows), inlineCardCount: env.application.domain.parseInlineCards(note.content).length };
      note.updatedAt = new Date().toISOString();
      rows.forEach((row, index) => {
        const item = data.items.find(item => item.id === row.itemId && item.documentId === note.id);
        if (item) item.sourceLocation = { ...item.sourceLocation, line: index + 1 };
      });
    }

    function removeTrashedInlineRows(entries, data = state.persistence.data) {
      const groups = new Map();
      entries.forEach(entry => {
        const item = data.items.find(item => item.id === entry.card.knowledgeItemId);
        const note = item && [...data.documents, ...data.cardDocuments].find(note => note.id === item.documentId);
        if (item?.itemType !== 'inline-card' || note?.metadata?.editorMode !== 'card') return;
        if (!groups.has(note.id)) groups.set(note.id, {note, rows: actions.initialInlineTagRows(note, data), entries: []});
        groups.get(note.id).entries.push({entry, item});
      });
      groups.forEach(({note, rows, entries}) => {
        const removed = new Set();
        entries.forEach(({entry, item}) => {
          const index = rows.findIndex(row => row.itemId === item.id);
          if (index < 0) return;
          const parsed = env.application.domain.parseInlineCardLine(rows[index].raw);
          if (!parsed || parsed.question !== item.frontText || parsed.answer !== item.backText) return;
          entry.inlineSource = { documentId: note.id, line: index, row: env.structuredClone(rows[index]), item: env.structuredClone(item) };
          removed.add(index);
        });
        actions.updateInlineNoteRows(note, rows.filter((_, index) => !removed.has(index)), data);
        const itemIds = new Set(entries.filter(({entry}) => entry.inlineSource).map(({item}) => item.id));
        data.items = data.items.filter(item => !itemIds.has(item.id));
      });
    }

    function normalizeInlineCardSpacing(editor) {
      const selectionStart = editor.selectionStart;
      const selectionEnd = editor.selectionEnd;
      if (selectionStart !== selectionEnd) return;

      const lineStart = editor.value.lastIndexOf('\n', selectionStart - 1) + 1;
      const nextLineBreak = editor.value.indexOf('\n', selectionStart);
      const lineEnd = nextLineBreak === -1 ? editor.value.length : nextLineBreak;
      const sourceLine = editor.value.slice(lineStart, lineEnd);
      const parsed = env.application.domain.parseInlineCardLine(sourceLine);
      if (!parsed) return;

      const normalizedLine = env.application.domain.normalizeInlineCardLineSpacing(sourceLine);
      if (normalizedLine === sourceLine) return;

      const caretInLine = selectionStart - lineStart;
      const lengthDelta = normalizedLine.length - sourceLine.length;
      const nextCaret = lineStart + caretInLine + (caretInLine > parsed.separatorIndex ? lengthDelta : 0);
      editor.value = `${editor.value.slice(0, lineStart)}${normalizedLine}${editor.value.slice(lineEnd)}`;
      editor.setSelectionRange(nextCaret, nextCaret);
    }

    function validateNotebookCardQuestions(documentId, content, data = state.persistence.data) {
      const parsed = env.application.domain.parseInlineCards(content, { keepDuplicates: true });
      const duplicate = env.application.domain.duplicateCardQuestion(parsed);
      if (duplicate) return `第 ${duplicate.line} 行题目“${duplicate.question}”重复，同一卡片笔记内不能有相同题目。`;
      const notebookId = data.cardNotebooks.find(note => note.sourceDocumentId === documentId)?.id;
      if (!notebookId) return '';
      const inlineIds = new Set(data.items.filter(item => item.documentId === documentId && item.itemType === 'inline-card').map(item => item.id));
      const manualQuestions = new Set(data.cards.filter(card => card.cardNotebookId === notebookId && !inlineIds.has(card.knowledgeItemId)).map(card => card.question.trim()));
      const conflict = parsed.find(card => manualQuestions.has(card.question.trim()));
      return conflict ? `第 ${conflict.line} 行题目“${conflict.question}”已存在于这本卡片笔记中，请修改题目。` : '';
    }

    function reconcileInlineTagRows(rows, content) {
      const lines = content.split('\n');
      const used = new Set();
      const next = lines.map(raw => {
        const index = rows.findIndex((row, i) => !used.has(i) && row.raw === raw);
        if (index < 0) return null;
        used.add(index); return { ...rows[index], tags: [...rows[index].tags] };
      });
      const remaining = rows.filter((_, i) => !used.has(i));
      const missing = next.map((row, i) => row ? -1 : i).filter(i => i >= 0);
      missing.forEach((i, offset) => {
        const previous = remaining.length === missing.length ? remaining[offset] : null;
        next[i] = { raw: lines[i], itemId: previous?.itemId || config.uid(), tags: [...(previous?.tags || [])] };
      });
      return next;
    }

    function initialInlineTagRows(note, data = state.persistence.data) {
      return String(note?.content || '').split('\n').map((raw, index) => {
        const parsed = env.application.domain.parseInlineCardLine(raw);
        const item = data.items.find(item => item.documentId === note?.id && item.itemType === 'inline-card' && item.sourceLocation?.line === index + 1);
        const card = item && data.cards.find(card => card.knowledgeItemId === item.id);
        const saved = note?.metadata?.inlineTagRows?.[index];
        return { raw, itemId: item?.id || saved?.itemId || config.uid(), tags: [...(card?.tags || saved?.tags || (parsed ? [] : []))] };
      });
    }

    function openMarkdownImport() {
      const library = env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId);
      if (!library) {
        actions.showToast('请先创建或选择知识库目录，再导入笔记', true);
        if (!state.persistence.data.knowledgeBases.length) actions.openLibraryDialog();
        return;
      }
      const input = config.$('#markdownImportInput');
      input.dataset.libraryId = library.id;
      input.value = '';
      input.click();
    }

    async function importMarkdownFiles(files, libraryId) {
      if (!files.length) return false;
      const importedIds = new Set();
      try {
        if (files.some(file => !/\.(md|markdown|txt)$/i.test(file.name))) {
          throw new Error('请选择 .md、.markdown 或 .txt 文件');
        }
        const sources = await Promise.all(files.map(async file => ({
          fileName: file.name,
          openedId: file.nativeFile?.id,
          content: (await file.text()).replace(/^\uFEFF/, '')
        })));
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
        if (!env.application.state.knowledge.libraryById(libraryId)) throw new Error('目标知识库目录已不存在，请重新选择');
        const timestamp = new Date().toISOString();
        for (const source of sources) {
          const fileType = /\.txt$/i.test(source.fileName) ? 'txt' : 'md';
          const noteContent = fileType === 'txt' ? '' : actions.markdownToRichHtml(source.content);
          const document = {
            id: source.openedId || config.uid(), knowledgeBaseId: libraryId,
            title: actions.availableDocumentTitle(source.fileName.replace(/\.(md|markdown|txt)$/i, '') || env.MemoKeepNoteFiles.types[fileType].defaultTitle, libraryId, null, fileType),
            sourceType: fileType === 'txt' ? 'manual-text' : 'manual-markdown', sourceFileName: source.fileName,
            content: source.content,
            metadata: {
              size: new env.TextEncoder().encode(source.content + noteContent).length,
              fileType, inlineCardCount: 0, editorMode: fileType === 'txt' ? 'text' : 'note', noteContent, noteContentInitialized: fileType !== 'txt'
            },
            createdAt: timestamp, updatedAt: timestamp
          };
          importedIds.add(document.id);
          state.persistence.data.documents.push(document);
        }
        await env.application.persistence.save();
      } catch (error) {
        state.persistence.data.documents = state.persistence.data.documents.filter(document => !importedIds.has(document.id));
        actions.showToast(`导入失败：${error.message}`, true);
        return false;
      }
      state.knowledge.selectedLibraryId = libraryId;
      state.knowledge.knowledgeTreeCollapsed = false;
      state.knowledge.collapsedLibraryIds.delete(libraryId);
      actions.saveCollapsedLibraryIds();
      actions.openMarkdownNoteEditor(actions.documentById([...importedIds][0]));
      actions.showToast(`已导入 ${importedIds.size} 篇笔记`);
      return true;
    }

    // 从系统「打开方式」打开的文件：已经在 MemoKeep 里的直接打开那篇；否则导入到当前目录再打开。
    let openingExternalFiles = null, externalDrainRequested = false;
    async function drainExternalNoteFiles() {
      const files = await config.desktop?.takeOpenedNoteFiles?.() || [];
      const fresh = [];
      const handled = [];
      const dropped = [];
      let existing = null;
      for (const file of files) {
        const committed = state.persistence.data.documents.find(document => document.id === file.id);
        if (file.error && !committed) { actions.showToast(`「${file.name}」${file.error}`, true); await config.desktop.acknowledgeOpenedNoteFile?.(file.id); continue; }
        // The note may have committed before a crash interrupted queue acknowledgement.
        // Never reopen its original Drop content over the already edited document.
        if (file.origin === 'drop' && !committed) { dropped.push(file); continue; }
        const match = committed
          || (file.idPrefix && state.persistence.data.documents.find(document => document.id.toLowerCase().startsWith(file.idPrefix)))
          || state.persistence.data.documents.find(document => document.sourceFileName === file.name && document.content === file.content);
        if (match) existing = match; else fresh.push({ name: file.name, text: async () => file.content, nativeFile: file });
        handled.push(file);
      }
      if (fresh.length) {
        const libraryId = env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId)?.id || state.persistence.data.knowledgeBases[0]?.id;
        if (!libraryId) { actions.showToast('请先创建知识库目录，再打开笔记文件', true); actions.openLibraryDialog(); return false; }
        if (!await importMarkdownFiles(fresh, libraryId)) return false;
      } else if (existing && await actions.openWorkspaceNote(existing.id) === false) return false;
      for (const file of handled) {
        if (file.id) await config.desktop.acknowledgeOpenedNoteFile?.(file.id);
        if (file.token) await config.desktop.releaseOpenedNoteFile?.(file.token);
      }
      if (dropped.length && await actions.enqueueNativeFilePreviews?.(dropped) === false) return false;
      return true;
    }

    function openExternalNoteFiles() {
      if (openingExternalFiles) {
        externalDrainRequested = true;
        return openingExternalFiles;
      }
      openingExternalFiles = (async () => {
        do {
          externalDrainRequested = false;
          // Focus and OS notifications may refer to the same durable queue.
          // A cancelled editor or library dialog must not immediately ask again.
          if (!await drainExternalNoteFiles()) return false;
        } while (externalDrainRequested);
        return true;
      })().catch(error => {
        actions.showToast(`打开文件失败：${error?.message || '请再试一次'}`, true);
        return false;
      }).finally(() => {
        openingExternalFiles = null;
        externalDrainRequested = false;
      });
      return openingExternalFiles;
    }

    function openNewNoteNameDialog(destination = null, anchor = null) {
      if (!state.persistence.data.knowledgeBases.length) { actions.showToast('请先创建知识库', true); actions.openLibraryDialog(); return; }
      if (env.noteTabActionPending || state.persistence.dataSavePending) return;
      env.newNoteFileDestination = destination || { kind: 'knowledge', libraryId: state.editor.activeNoteEditorLibraryId || state.knowledge.selectedLibraryId, tagId: env.selectedNoteTagId };
      env.newNoteFileAnchor = anchor || env.document.activeElement;
      config.$('#newNoteNameForm').reset();
      config.$('#newNoteLibrary').innerHTML = env.MemoKeepDirectoryTree.entries(state.persistence.data.knowledgeBases).map(({ item }) => `<option value="${actions.escapeHtml(item.id)}">${actions.escapeHtml(env.MemoKeepDirectoryTree.label(state.persistence.data.knowledgeBases, item.id))}</option>`).join('');
      config.$('#newNoteLibrary').value = env.application.state.knowledge.libraryById(env.newNoteFileDestination.libraryId)?.id || state.persistence.data.knowledgeBases[0].id;
      env.setNewNoteFileType('md'); env.syncNewNoteFileDestination();
      config.$('#newNoteNameDialog').showModal(); env.positionNewNoteFileDialog();
      env.requestAnimationFrame(() => { config.$('#newNoteName').focus(); config.$('#newNoteName').select(); });
    }

    async function handleNewNoteNameSubmit(event) {
      event.preventDefault();
      if (env.noteTabActionPending || state.persistence.dataSavePending) return;
      const fileType = config.$('#newNoteFileType').value;
      const requestedTitle = config.$('#newNoteName').value.trim().replace(/\.(md|txt|markdown)$/i, '');
      const library = env.application.state.knowledge.libraryById(config.$('#newNoteLibrary').value);
      if (!env.MemoKeepNoteFiles.types[fileType] || !requestedTitle || /[\\/:*?"<>|]/.test(requestedTitle) || !library) {
        if (!requestedTitle) env.showNewNoteFileMessage('error', '请输入文件名称');
        else if (!library) env.showNewNoteFileMessage('error', '请选择有效的知识库目录');
        else env.validateNewNoteFileName();
        config.$('#newNoteName').focus(); return;
      }
      const submit = config.$('#newNoteNameForm button[type="submit"]'); submit.disabled = true; submit.textContent = '创建中…';
      try {
        const created = await env.createNoteTab({ kind: 'knowledge', libraryId: library.id, tagId: env.newNoteFileDestination?.tagId, title: requestedTitle, fileType });
        if (created) {
          config.$('#newNoteNameDialog').close();
          env.requestAnimationFrame(() => { config.$('#inlineMarkdownNoteTitle')?.focus(); config.$('#inlineMarkdownNoteTitle')?.select(); });
        }
      } finally { submit.disabled = false; submit.textContent = '创建'; }
    }

    async function openNoteTarget(request) {
      let { document, initialTitle, cardNotebookId } = request;
      if (state.editor.editingMarkdownDocumentId === (document?.id || 'new') && state.editor.editingCardNotebookId === cardNotebookId && config.$('#inlineMarkdownNoteForm')) {
        config.$$('.view').forEach(view => view.classList.toggle('hidden', view.id !== 'librariesView'));
        actions.syncSidebarSelection(); return true;
      }
      const previousTab = env.openNoteTabs.find(tab => tab.id === state.editor.editingMarkdownDocumentId);
      if (previousTab) previousTab.scrollTop = config.$('#librariesView').scrollTop;
      if (state.editor.activeNoteEditorHasChanges?.() && !await env.application.editor.session.saveNoteBeforeTabChange()) return 'blocked';
      if (pendingNoteOpen) return false;
      if (document) {
        document = actions.documentById(document.id);
        if (!document) { actions.showToast('笔记已不存在', true); return false; }
        const collection = state.persistence.data.cardDocuments.some(row => row.id === document.id) ? 'cardDocuments' : 'documents';
        if (state.persistence.data[collection].some(row => row.id === document.id)) {
          const token = state.persistence.sharedDataToken;
          let selected;
          try {
            selected = await env.application.persistence.storage?.readNoteRecord?.(collection, document.id, token);
            if (pendingNoteOpen) return false;
            // An event may invalidate our snapshot while the conditional read is awaiting IPC.
            if (selected?.unchanged && state.persistence.sharedDataToken !== token) {
              selected = await env.application.persistence.storage.readNoteRecord(collection, document.id);
            }
          } catch (error) {
            if (pendingNoteOpen) return false;
            throw error;
          }
          if (pendingNoteOpen) return false;
          // The source remains editable while reading. Preserve input made during that wait.
          if (state.editor.activeNoteEditorHasChanges?.()) {
            const draft = env.noteDraftTab?.(state.editor.editingMarkdownDocumentId);
            if (!await env.application.editor.session.saveNoteBeforeTabChange()) return 'blocked';
            if (pendingNoteOpen) return false;
            if (!draft) return openNoteTarget(request);
          }
          if (selected && !selected.unchanged) {
            if (!selected.record) { actions.showToast('笔记已被其他窗口删除', true); return false; }
            document = selected.record;
            state.persistence.data = { ...state.persistence.data, [collection]: state.persistence.data[collection].map(row => row.id === document.id ? document : row) };
            const baseline = state.persistence.persistedData;
            if (baseline) state.persistence.persistedData = { ...baseline, [collection]: (baseline[collection] || []).map(row => row.id === document.id ? structuredClone(document) : row) };
            if (state.persistence.sharedDataToken !== selected.revision) state.persistence.sharedDataToken = null;
          } else document = actions.documentById(document.id);
          if (!document) { actions.showToast('笔记已被其他窗口删除', true); return false; }
        }
      }
      const immersive = config.$('#librariesView').classList.contains('card-editor-immersive');
      const reading = config.$('#librariesView').classList.contains('note-reading');
      env.application.editor.session.resetActiveNoteEditor();
      config.$('#librariesView').classList.toggle('card-editor-immersive', immersive);
      config.$('#librariesView').classList.toggle('note-reading', reading);
      if (document?.knowledgeBaseId) state.knowledge.selectedLibraryId = document.knowledgeBaseId;
      if (cardNotebookId) env.application.cards.runtime.cardScope = { type: 'notebook', id: cardNotebookId };
      env.rememberNoteTab(document, cardNotebookId);
      let expanded = false;
      if (document?.knowledgeBaseId) {
        for (const parent of env.MemoKeepDirectoryTree.ancestors(state.persistence.data.knowledgeBases, document.knowledgeBaseId)) {
          expanded = state.knowledge.collapsedLibraryIds.delete(parent.id) || expanded;
        }
        if (expanded) actions.saveCollapsedLibraryIds();
      }
      state.editor.editingCardNotebookId = cardNotebookId;
      state.editor.pendingNewMarkdownNoteTitle = document ? '' : initialTitle.trim();
      state.editor.editingMarkdownDocumentId = document?.id || 'new';
      actions.showView('libraries');
      if (expanded) actions.renderSidebarKnowledgeTree();
      actions.updateNoteWindowTitle();
      return true;
    }

    async function drainNoteOpens() {
      let current;
      try {
        while (pendingNoteOpen) {
          current = pendingNoteOpen; pendingNoteOpen = null;
          const result = await openNoteTarget(current);
          current.resolve(result === true); current = null;
          if (result === 'blocked') break;
        }
      } catch (error) {
        actions.showToast(`笔记打开失败：${error.message}`, true);
        current?.resolve(false);
      } finally {
        pendingNoteOpen?.resolve(false); pendingNoteOpen = null;
        noteOpenWorker = null; env.noteTabActionPending = false;
        env.application.views.tabs.renderNoteTabs(true);
      }
    }

    function openMarkdownNoteEditor(document = null, initialTitle = '', _sourceElement = null, cardNotebookId = null) {
      if (!noteOpenWorker && (env.noteTabActionPending || state.persistence.dataSavePending)) return Promise.resolve(false);
      return new Promise(resolve => {
        pendingNoteOpen?.resolve(false);
        pendingNoteOpen = { document, initialTitle, cardNotebookId, resolve };
        if (!noteOpenWorker) {
          env.noteTabActionPending = true;
          // Keep only the newest destination while preserving the current editor until it is safe to leave.
          noteOpenWorker = Promise.resolve().then(drainNoteOpens);
        }
      });
    }

    function syncInlineCards(document, parsedCards, data = state.persistence.data) {
      // Arrows and equality in knowledge notes are prose; only card mode opts into automatic cards.
      // Return before reconciliation so saving a note cannot remove intentionally added cards either.
      if (document.metadata?.editorMode !== 'card') return;
      const duplicateError = actions.validateNotebookCardQuestions(document.id, document.content || '', data);
      if (duplicateError) throw new Error(duplicateError);
      const timestamp = new Date().toISOString();
      const notebookId = data.cardNotebooks.find(note => note.sourceDocumentId === document.id)?.id || null;
      const existingItems = data.items.filter(item => item.documentId === document.id && item.itemType === 'inline-card');
      const byKey = new Map(existingItems.map(item => [`${item.frontText}\0${item.backText}`, item]));
      const retainedIds = new Set();
      parsedCards.forEach(parsed => {
        const tagRow = document.metadata?.inlineTagRows?.[parsed.line - 1];
        let item = existingItems.find(item => tagRow?.itemId === item.id) || byKey.get(parsed.key);
        const previousCard = item && data.cards.find(card => card.knowledgeItemId === item.id);
        const tags = [...(tagRow?.tags || previousCard?.tags || item?.tags || [])];
        if (!item) {
          item = { id: tagRow?.itemId || config.uid(), knowledgeBaseId: document.knowledgeBaseId, documentId: document.id, itemType: 'inline-card', frontText: parsed.question, backText: parsed.answer, example: '', note: '', tags, sourceLocation: { line: parsed.line }, createdAt: timestamp, updatedAt: timestamp };
          data.items.push(item);
        } else Object.assign(item, { frontText: parsed.question, backText: parsed.answer, tags, sourceLocation: { line: parsed.line }, updatedAt: timestamp });
        retainedIds.add(item.id);
        const card = data.cards.find(candidate => candidate.knowledgeItemId === item.id);
        if (card) Object.assign(card, { question: parsed.question, answer: parsed.answer, knowledgeBaseId: document.knowledgeBaseId, tags, updatedAt: timestamp });
        else data.cards.push(actions.createCard({ question: parsed.question, answer: parsed.answer, knowledgeBaseId: document.knowledgeBaseId, knowledgeItemId: item.id, cardNotebookId: notebookId, tags, createdAt: timestamp }));
      });
      const removedIds = new Set(existingItems.filter(item => !retainedIds.has(item.id)).map(item => item.id));
      data.items = data.items.filter(item => !removedIds.has(item.id));
      data.cards = data.cards.filter(card => !removedIds.has(card.knowledgeItemId));
    }

    function handleCreateCardFromSelection() {
      const selection = env.window.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selectedText || !config.$('#documentPreview').contains(selection.anchorNode)) {
        actions.showToast('请先在文档正文中选中一段内容', true);
        return;
      }

      const document = actions.documentById(state.knowledge.activeDocumentId);
      config.$('#documentDialog').close();
      env.application.views.cardEditor.openCardDialog(null, {
        question: `关于“${document.title}”，这段内容说明了什么？`,
        answer: selectedText,
        knowledgeBaseId: document.knowledgeBaseId,
        sourceDocumentId: document.id,
        sourceTitle: document.title,
        tags: [document.title]
      });
    }
    return { updateInlineNoteRows, removeTrashedInlineRows, normalizeInlineCardSpacing, validateNotebookCardQuestions, reconcileInlineTagRows, initialInlineTagRows, openMarkdownImport, importMarkdownFiles, openExternalNoteFiles, openNewNoteNameDialog, handleNewNoteNameSubmit, openMarkdownNoteEditor, syncInlineCards, handleCreateCardFromSelection };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createNotebooks });
})(globalThis);
