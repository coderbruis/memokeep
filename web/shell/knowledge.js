(function expose(root) {
  function createKnowledge({ state, config, actions, env }) {
    let locateHighlightTimer = null, sidebarTreeOwner = null, sidebarTreeKey = null;

    function currentSidebarNote() {
      if (config.isNoteWindow || !state.persistence.applicationDataReady || state.editor.editingCardNotebookId
        || config.$('#librariesView')?.classList.contains('hidden')) return null;
      const document = state.persistence.data.documents.find(item => item.id === state.editor.editingMarkdownDocumentId);
      return document && state.persistence.data.knowledgeBases.some(library => library.id === document.knowledgeBaseId) ? document : null;
    }

    function syncLocateCurrentNoteButton() {
      const button = config.$('#locateCurrentNoteButton'); if (!button) return;
      const document = currentSidebarNote();
      button.disabled = !document || Boolean(state.knowledge.renamingTreeItem);
      button.title = state.knowledge.renamingTreeItem ? '请先完成重命名'
        : document ? `定位到：${env.MemoKeepDirectoryTree.label(state.persistence.data.knowledgeBases, document.knowledgeBaseId)} / ${document.title}`
          : '打开已保存的知识库笔记后可定位';
    }

    function locateCurrentNote() {
      const document = currentSidebarNote();
      if (!document || state.knowledge.renamingTreeItem) { syncLocateCurrentNoteButton(); return false; }
      const libraries = state.persistence.data.knowledgeBases;
      env.MemoKeepDirectoryTree.ancestors(libraries, document.knowledgeBaseId).forEach(library => state.knowledge.collapsedLibraryIds.delete(library.id));
      // A locate request opens just this path, including before the initial tree render.
      state.knowledge.startCollapsedApplied = true;
      state.knowledge.knowledgeTreeCollapsed = false;
      state.knowledge.selectedLibraryId = document.knowledgeBaseId;
      env.selectedNoteTagId = null;
      actions.saveCollapsedLibraryIds();
      env.localStorage.setItem('memokeep-knowledge-tree-collapsed', 'false');
      if (state.shell.sidebarCollapsed) {
        state.shell.sidebarCollapsed = false;
        env.localStorage.setItem(config.SIDEBAR_COLLAPSED_KEY, 'false');
        actions.applySidebarCollapsedState();
      }
      actions.renderSidebarKnowledgeTree();
      const target = Array.from(config.$('#knowledgeTree').querySelectorAll('[data-tree-document]'))
        .find(button => button.dataset.treeDocument === document.id);
      const nav = config.$('.shell > header > nav');
      if (!target || !nav) return false;
      const bounds = target.getBoundingClientRect(), viewport = nav.getBoundingClientRect();
      nav.scrollTo({ top: Math.max(0, nav.scrollTop + bounds.top - viewport.top - (nav.clientHeight - bounds.height) / 2), behavior: 'instant' });
      target.classList.add('is-locate-target');
      env.clearTimeout(locateHighlightTimer);
      locateHighlightTimer = env.setTimeout(() => target.classList.remove('is-locate-target'), 1800);
      return true;
    }

    function loadCollapsedLibraryIds() {
      try {
        const storedIds = JSON.parse(env.localStorage.getItem(config.COLLAPSED_LIBRARIES_KEY) || '[]');
        return Array.isArray(storedIds) ? storedIds : [];
      } catch {
        return [];
      }
    }

    function saveCollapsedLibraryIds() {
      env.localStorage.setItem(config.COLLAPSED_LIBRARIES_KEY, JSON.stringify([...state.knowledge.collapsedLibraryIds]));
    }

    // 打开知识库时目录都先收起（笔记不默认展开）；只展开当前打开的那篇笔记所在的目录。
    function collapseAllDirectories() {
      const libraries = state.persistence.data?.knowledgeBases || [];
      const collapsed = new Set(libraries.map(library => library.id));
      const active = actions.documentById?.(state.editor.editingMarkdownDocumentId);
      if (active?.knowledgeBaseId) {
        collapsed.delete(active.knowledgeBaseId);
        env.MemoKeepDirectoryTree.ancestors(libraries, active.knowledgeBaseId).forEach(parent => collapsed.delete(parent.id));
      }
      state.knowledge.collapsedLibraryIds = collapsed;
      saveCollapsedLibraryIds();
    }

    function cardLibraryLabel(card) { return env.application.state.knowledge.libraryById(card.knowledgeBaseId)?.name || '未分类'; }

    function renderSidebarKnowledgeTree() {
      env.renderSidebarNoteTags();
      const group = config.$('.knowledge-nav-group');
      group?.classList.toggle('collapsed', state.knowledge.knowledgeTreeCollapsed);
      const tree = config.$('#knowledgeTree'); if (!tree) return;
      // 应用打开后第一次画目录：先全部收起。
      if (!state.knowledge.startCollapsedApplied && state.persistence.applicationDataReady) { state.knowledge.startCollapsedApplied = true; collapseAllDirectories(); }
      env.updateSidebarDirectoryToggle();
      if (state.knowledge.knowledgeTreeCollapsed) { tree.replaceChildren(); sidebarTreeKey = null; actions.syncSidebarSelection(); return; }
      // Body/history edits and selection changes do not change the directory's DOM.
      const treeKey = JSON.stringify([state.persistence.data.knowledgeBases,
        state.persistence.data.documents.map(doc => [doc.id, doc.knowledgeBaseId, doc.title, doc.sourceType, doc.sourceFileName, doc.metadata?.fileType, doc.metadata?.editorMode]),
        [...state.knowledge.collapsedLibraryIds].sort(), state.knowledge.renamingTreeItem || null]);
      if (sidebarTreeOwner === tree && sidebarTreeKey === treeKey) { actions.syncSidebarSelection(); return; }
      const documentsByLibrary = new Map();
      for (const doc of state.persistence.data.documents) {
        if (!documentsByLibrary.has(doc.knowledgeBaseId)) documentsByLibrary.set(doc.knowledgeBaseId, []);
        documentsByLibrary.get(doc.knowledgeBaseId).push(doc);
      }
      tree.innerHTML = env.MemoKeepDirectoryTree.entries(state.persistence.data.knowledgeBases).map(({ item: library, depth, parents }) => {
        if (parents.some(parent => state.knowledge.collapsedLibraryIds.has(parent.id))) return '';
        const isCollapsed = state.knowledge.collapsedLibraryIds.has(library.id);
        const documents = isCollapsed ? [] : documentsByLibrary.get(library.id) || [];
        const isRenamingLibrary = state.knowledge.renamingTreeItem?.type === 'library'
        && state.knowledge.renamingTreeItem.id === library.id;

        const documentRows = documents.map(document => {
          const isRenamingDocument = state.knowledge.renamingTreeItem?.type === 'document'
          && state.knowledge.renamingTreeItem.id === document.id;
          const documentLabel = isRenamingDocument
          ? `<input class="tree-rename-input" data-tree-rename-type="document" data-tree-rename-id="${document.id}" maxlength="100" value="${actions.escapeHtml(document.title)}" aria-label="重命名笔记">`
          : `<button class="tree-document" data-tree-document="${document.id}" title="笔记：${actions.escapeHtml(document.title)}">${env.noteFileIcon(document, "tree-kind-icon")}<span class="tree-label-text">${actions.escapeHtml(document.title)}</span></button>`;

          return `
        <div class="tree-document-row">
          ${documentLabel}
          <button class="tree-more" data-tree-menu-button="document" data-tree-menu-id="${document.id}" aria-haspopup="menu" aria-expanded="false" aria-label="${actions.escapeHtml(document.title)}的更多操作">•••</button>
          <div class="tree-item-menu" data-document-menu popover="auto" role="menu" aria-label="笔记操作"></div>
        </div>`;
        }).join('');

        const libraryLabel = isRenamingLibrary
        ? `<input class="tree-rename-input" data-tree-rename-type="library" data-tree-rename-id="${library.id}" maxlength="50" value="${actions.escapeHtml(library.name)}" aria-label="重命名知识库">`
        : `<button class="tree-library" data-tree-library="${library.id}" aria-expanded="${!isCollapsed}" title="${actions.escapeHtml(library.name)}，点击${isCollapsed ? '展开' : '收起'}笔记"><span class="tree-label-text">${actions.escapeHtml(library.name)}</span></button>`;

        return `
      <div class="tree-library-group ${parents.some(parent => state.knowledge.collapsedLibraryIds.has(parent.id)) ? 'hidden' : ''}" data-tree-library-group="${library.id}" style="--tree-depth:${depth - 1}">
        <div class="tree-library-row">
          <button class="tree-library-toggle ${isCollapsed ? 'collapsed' : ''}" data-tree-toggle-library="${library.id}" aria-expanded="${!isCollapsed}" aria-label="${isCollapsed ? '展开' : '收起'}${actions.escapeHtml(library.name)}中的笔记">⌄</button>
          ${libraryLabel}
          <button class="tree-more" data-tree-menu-button="library" data-tree-menu-id="${library.id}" aria-haspopup="menu" aria-expanded="false" aria-label="${actions.escapeHtml(library.name)}的更多操作">•••</button>
          <div class="tree-item-menu" popover="auto" role="menu" aria-label="知识库操作">
            <button data-tree-action="new-note" data-tree-target-type="library" data-tree-target-id="${library.id}"><svg aria-hidden="true"><use href="#icon-file-plus-2"></use></svg><span>新建笔记</span></button>
            <button data-tree-action="new-folder" data-tree-target-type="library" data-tree-target-id="${library.id}" ${depth >= env.MemoKeepDirectoryTree.MAX_DEPTH ? 'disabled' : ''}><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>新建子目录${depth >= env.MemoKeepDirectoryTree.MAX_DEPTH ? '<small>最多 5 层，已达上限</small>' : ''}</span></button>
            <div class="tree-menu-separator" role="separator"></div>
            <button data-tree-action="rename" data-tree-target-type="library" data-tree-target-id="${library.id}"><svg aria-hidden="true"><use href="#icon-pencil"></use></svg><span>重命名</span></button>
            <button role="menuitem" data-tree-action="copy" data-tree-target-type="library" data-tree-target-id="${library.id}"><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>复制知识库</span></button>
            <button role="menuitem" data-tree-action="export" data-tree-target-type="library" data-tree-target-id="${library.id}"><svg aria-hidden="true"><use href="#icon-file-text"></use></svg><span>导出笔记</span><small class="tree-menu-hint">含子目录</small></button>
            <div class="tree-menu-separator" role="separator"></div>
            <button class="danger" data-tree-action="delete" data-tree-target-type="library" data-tree-target-id="${library.id}"><svg aria-hidden="true"><use href="#icon-trash"></use></svg><span>删除目录</span></button>
          </div>
        </div>
        <div class="tree-document-list ${isCollapsed ? 'hidden' : ''}">${documentRows || (state.persistence.data.knowledgeBases.some(child => child.parentId === library.id) ? '' : '<p class="tree-document-empty">还没有笔记</p>')}</div>
      </div>`;
      }).join('') || '<p class="knowledge-tree-empty">还没有知识库</p>';
      sidebarTreeOwner = tree; sidebarTreeKey = treeKey;
      actions.syncSidebarSelection();

      if (state.knowledge.renamingTreeItem) {
        env.queueMicrotask(() => {
          const input = tree.querySelector('.tree-rename-input');
          input?.focus();
          input?.select();
        });
      }
    }

    function renderLibraries() {
      env.disposeNoteDirectory();
      const newNoteButton = config.$('#newNoteBtn');
      config.$('.knowledge-page-actions').append(newNoteButton);
      config.$('#librariesView').classList.toggle('note-directory-view', Boolean(env.selectedNoteTagId || env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId)) && !state.editor.editingMarkdownDocumentId && !config.isNoteWindow);
      actions.syncSidebarSelection();
      env.application.views.tabs.renderNoteTabs();
      config.$('#librariesView').classList.toggle('editing-note', Boolean(state.editor.editingMarkdownDocumentId));
      config.$('#librariesView').classList.toggle('editing-card-note', Boolean(state.editor.editingMarkdownDocumentId)
      && actions.documentById(state.editor.editingMarkdownDocumentId)?.metadata?.editorMode !== 'note'
      && !env.MemoKeepNoteFiles.isText(actions.documentById(state.editor.editingMarkdownDocumentId)));
      if (config.isNoteWindow && !state.editor.editingMarkdownDocumentId) {
        config.$('#libraryContent').innerHTML = '<div class="empty-state note-window-empty" role="status"><h2>没有打开的笔记</h2></div>';
        return;
      }
      if (!state.editor.editingMarkdownDocumentId && env.selectedNoteTagId) { env.renderNoteTagDirectory(newNoteButton); return; }
      const library = env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId);
      newNoteButton.disabled = !library;
      newNoteButton.title = library ? `在“${library.name}”中新建笔记` : '请先创建知识库';
      if (state.editor.editingCardNotebookId && state.editor.editingMarkdownDocumentId) {
        const document = actions.documentById(state.editor.editingMarkdownDocumentId);
        if (document) {
          config.$('#libraryContent').innerHTML = actions.renderInlineMarkdownEditor(library, document);
          actions.bindInlineMarkdownEditor(document);
          return;
        }
      }
      if (!library) {
        config.$('#libraryContent').innerHTML = '<div class="empty-state"><span>⌁</span><h2>暂无知识库</h2><button class="primary" id="emptyCreateBtn">新建知识库</button></div>';
        config.$('#emptyCreateBtn').onclick = actions.openLibraryDialog;
        return;
      }
      if (state.editor.editingMarkdownDocumentId) {
        const document = state.editor.editingMarkdownDocumentId === 'new' ? null : actions.documentById(state.editor.editingMarkdownDocumentId);
        config.$('#libraryContent').innerHTML = actions.renderInlineMarkdownEditor(library, document);
        actions.bindInlineMarkdownEditor(document);
        return;
      }
      const docs = state.persistence.data.documents.filter(doc => doc.knowledgeBaseId === library.id);
      const items = state.persistence.data.items.filter(item => item.knowledgeBaseId === library.id);
      const isStructured = library.type === 'vocabulary' || library.type === 'sentences';
      const structuredItems = isStructured && items.length
      ? `<section class="structured-content-section"><h3>结构化内容</h3>${actions.renderItemTable(items)}</section>`
      : '';
      config.$('#libraryContent').innerHTML = env.renderNoteDirectory(library, docs, items, structuredItems);
      config.$('.note-directory-header-actions').prepend(newNoteButton);
      env.mountNoteDirectory(library, docs);
    }

    function startDocumentListRename(documentId) {
      const document = actions.documentById(documentId);
      const row = config.$(`[data-document-row="${documentId}"]`);
      const heading = row?.querySelector('.document-summary h3');
      if (!document || !heading) return;
      const input = env.window.document.createElement('input');
      input.className = 'document-rename-input';
      input.value = document.title;
      input.maxLength = 100;
      input.setAttribute('aria-label', '重命名笔记');
      heading.replaceWith(input);
      row.classList.add('is-renaming');
      let settled = false;
      const finish = async saveRename => {
        if (settled) return;
        if (saveRename && !input.value.trim()) {
          actions.showToast('笔记名称不能为空', true);
          input.focus();
          return;
        }
        settled = true;
        if (!saveRename) {
          actions.renderLibraries();
          return;
        }
        input.dataset.treeRenameType = 'document';
        input.dataset.treeRenameId = documentId;
        await actions.commitTreeRename(input);
      };
      input.onkeydown = event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      };
      input.onblur = () => finish(true);
      input.focus();
      input.select();
    }

    function renderItemTable(items) {
      return `<div class="table-actions"><button class="primary small" id="addSelectedItemsBtn">将选中内容加入记忆</button><span class="hint">可批量选择单词或语句</span></div><table class="item-table"><thead><tr><th><input id="selectAllItems" type="checkbox"></th><th>原文 / 单词</th><th>释义 / 译文</th><th>例句</th><th>状态</th></tr></thead><tbody>${items.map(item => { const added = state.persistence.data.cards.some(card => card.knowledgeItemId === item.id); return `<tr><td><input class="item-check" type="checkbox" value="${item.id}" ${added ? 'disabled' : ''}></td><td>${actions.escapeHtml(item.frontText)}</td><td>${actions.escapeHtml(item.backText)}</td><td>${actions.escapeHtml(item.example || '—')}</td><td><span class="tag">${added ? '已加入' : '未加入'}</span></td></tr>`; }).join('')}</tbody></table>${items.length ? '' : '<div class="empty">当前知识库还没有结构化内容。</div>'}`;
    }

    function openLibraryDialog(parentId = null) {
      if (typeof parentId !== 'string') parentId = null; // Also used directly as a click handler.
      const error = env.MemoKeepDirectoryTree.creationError(state.persistence.data.knowledgeBases, parentId);
      if (error) { actions.showToast(error, true); return; }
      config.$('#libraryForm').reset();
      config.$('#libraryParentId').value = parentId || '';
      config.$('#libraryParentHint').textContent = `上级目录：${env.MemoKeepDirectoryTree.label(state.persistence.data.knowledgeBases, parentId) || '知识库根目录'} · 第 ${env.MemoKeepDirectoryTree.ancestors(state.persistence.data.knowledgeBases, parentId).length + 1} / 5 层`;
      config.$('#libraryDialog').showModal();
      config.$('#libraryName').focus();
    }

    function openDocument(id) {
      const doc = actions.documentById(id); if (!doc) return; state.knowledge.activeDocumentId = id;
      config.$('#documentSource').textContent = env.application.state.knowledge.libraryById(doc.knowledgeBaseId)?.name || '知识文档'; config.$('#documentTitle').textContent = doc.title;
      config.$('#documentPreview').innerHTML = actions.renderMarkdown(doc.content); config.$('#documentDialog').showModal();
    }

    function addSelectedItems() {
      const ids = config.$$('.item-check:checked').map(input => input.value);
      if (!ids.length) { actions.showToast('请先选择要加入记忆的内容', true); return; }
      const createdAt = new Date().toISOString();
      ids.forEach(id => { const item = env.application.state.knowledge.itemById(id); if (!item || state.persistence.data.cards.some(card => card.knowledgeItemId === id)) return; state.persistence.data.cards.push(actions.createCard({ question: item.frontText, answer: item.backText, knowledgeBaseId: item.knowledgeBaseId, knowledgeItemId: id, tags: item.tags, createdAt })); });
      env.application.persistence.save().then(() => { actions.renderAll(); actions.showToast(`已将 ${ids.length} 条内容加入记忆计划`); });
    }

    async function handleCreateLibrary(event) {
      event.preventDefault();
      const requestedName = config.$('#libraryName').value.trim();
      if (!requestedName) return;
      const parentId = config.$('#libraryParentId').value || null;
      const error = env.MemoKeepDirectoryTree.creationError(state.persistence.data.knowledgeBases, parentId);
      if (error) { actions.showToast(error, true); return; }
      const name = actions.availableLibraryName(requestedName, null, parentId);
      const timestamp = new Date().toISOString();
      const library = {
        id: config.uid(),
        name,
        parentId,
        description: '',
        type: 'general',
        language: '',
        createdAt: timestamp,
        updatedAt: timestamp
      };

      state.persistence.data.knowledgeBases.push(library);
      env.selectedNoteTagId = null;
      state.knowledge.selectedLibraryId = library.id;
      env.MemoKeepDirectoryTree.ancestors(state.persistence.data.knowledgeBases, library.id).forEach(parent => state.knowledge.collapsedLibraryIds.delete(parent.id));
      actions.saveCollapsedLibraryIds();
      state.knowledge.knowledgeTreeCollapsed = false;
      env.localStorage.setItem('memokeep-knowledge-tree-collapsed', 'false');
      config.$('#libraryDialog').close();
      actions.renderAll();
      actions.showToast(name === requestedName ? '目录已创建' : `名称重复，已创建为“${name}”`);
      await env.application.persistence.save();
      actions.renderAll();
    }

    function renderTreeDocumentMenu(id) {
      return `
            <button role="menuitem" data-tree-action="open-window" data-tree-target-type="document" data-tree-target-id="${env.noteDirectoryAttribute(id)}"><svg aria-hidden="true"><use href="#icon-arrow-up-right"></use></svg><span>在新窗口打开</span></button>
            <div class="tree-menu-separator" role="separator"></div>
            <button data-tree-action="rename" data-tree-target-type="document" data-tree-target-id="${env.noteDirectoryAttribute(id)}"><svg aria-hidden="true"><use href="#icon-pencil"></use></svg><span>重命名</span></button>
            <button role="menuitem" data-tree-action="move" data-tree-target-type="document" data-tree-target-id="${env.noteDirectoryAttribute(id)}"><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>移动到…</span></button>
            <button role="menuitem" data-tree-action="export" data-tree-target-type="document" data-tree-target-id="${env.noteDirectoryAttribute(id)}"><svg aria-hidden="true"><use href="#icon-file-text"></use></svg><span>导出笔记</span></button>
            <div class="tree-menu-separator" role="separator"></div>
            <button class="danger" data-tree-action="delete" data-tree-target-type="document" data-tree-target-id="${env.noteDirectoryAttribute(id)}"><svg aria-hidden="true"><use href="#icon-trash"></use></svg><span>删除笔记</span></button>
          `;
    }

    function closeTreeItemMenus() {
      config.$$('.tree-item-menu').forEach(menu => { menu.hidePopover(); if (menu.hasAttribute('data-document-menu')) menu.replaceChildren(); });
      config.$$('.tree-more').forEach(button => { button.classList.remove('menu-open'); button.setAttribute('aria-expanded', 'false'); });
    }

    function openTreeItemMenu(button, point = null) {
      const menu = button.parentElement.querySelector('.tree-item-menu');
      const wasOpen = menu.matches(':popover-open') || state.knowledge.treeMenuPointerDown?.button === button && state.knowledge.treeMenuPointerDown.open;
      state.knowledge.treeMenuPointerDown = null;
      actions.closeTreeItemMenus();
      if (wasOpen && !point) return;
      menu.onbeforetoggle = event => {
        const opening = event.newState === 'open';
        button.classList.toggle('menu-open', opening);
        button.setAttribute('aria-expanded', String(opening));
      };
      if (button.dataset.treeMenuButton === 'document') menu.innerHTML = actions.renderTreeDocumentMenu(button.dataset.treeMenuId);
      menu.querySelectorAll('button').forEach(item => item.setAttribute('role', 'menuitem'));
      menu.showPopover();
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(point?.x ?? rect.right - menu.offsetWidth, env.window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(point?.y ?? rect.bottom + 5, env.window.innerHeight - menu.offsetHeight - 8))}px`;
      menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }

    function startTreeRename(type, id) {
      state.knowledge.renamingTreeItem = { type, id };
      actions.closeTreeItemMenus();
      actions.renderSidebarKnowledgeTree();
    }

    async function commitTreeRename(input) {
      const type = input.dataset.treeRenameType;
      const id = input.dataset.treeRenameId;
      const nextName = input.value.trim();
      if (!nextName) {
        actions.showToast(type === 'library' ? '知识库名称不能为空' : '笔记名称不能为空', true);
        input.focus();
        return;
      }

      const timestamp = new Date().toISOString();
      if (type === 'library') {
        const library = env.application.state.knowledge.libraryById(id);
        if (!library) return;
        library.name = nextName;
        library.updatedAt = timestamp;
      } else {
        const document = actions.documentById(id);
        if (!document) return;
        document.title = nextName;
        document.updatedAt = timestamp;

        const documentItemIds = new Set();
        state.persistence.data.items.forEach(item => {
          if (item.documentId !== id || item.itemType !== 'inline-card') return;
          item.tags = [nextName];
          item.updatedAt = timestamp;
          documentItemIds.add(item.id);
        });
        state.persistence.data.cards.forEach(card => {
          if (!documentItemIds.has(card.knowledgeItemId)) return;
          card.tags = [nextName];
          card.updatedAt = timestamp;
        });

        if (state.editor.editingMarkdownDocumentId === id && config.$('#inlineMarkdownNoteTitle')) {
          config.$('#inlineMarkdownNoteTitle').value = nextName;
          config.$('#inlineMarkdownNoteTitle').dispatchEvent(new env.Event('input'));
        }
      }

      state.knowledge.renamingTreeItem = null;
      await env.application.persistence.save();
      actions.renderSidebarKnowledgeTree();
      env.application.views.tabs.renderNoteTabs();
      if (!state.editor.editingMarkdownDocumentId) actions.renderLibraries();
      actions.showToast(type === 'library' ? '知识库已重命名' : '笔记已重命名');
    }

    function cancelTreeRename() {
      const pendingRename = state.knowledge.renamingTreeItem;
      if (!pendingRename) return;
      state.knowledge.renamingTreeItem = null;

      const input = config.$('#knowledgeTree .tree-rename-input');
      const item = pendingRename.type === 'library'
      ? env.application.state.knowledge.libraryById(pendingRename.id)
      : actions.documentById(pendingRename.id);
      if (!input || !item) {
        actions.renderSidebarKnowledgeTree();
        return;
      }

      const label = pendingRename.type === 'library' ? item.name : item.title;
      const button = env.window.document.createElement('button');
      button.className = pendingRename.type === 'library' ? 'tree-library' : 'tree-document';
      button.dataset[pendingRename.type === 'library' ? 'treeLibrary' : 'treeDocument'] = pendingRename.id;
      button.title = label;
      button.textContent = label;
      input.replaceWith(button);
      actions.syncSidebarSelection();
    }

    async function handleTreeItemAction(actionButton) {
      if (actionButton.disabled) return;
      const action = actionButton.dataset.treeAction;
      const type = actionButton.dataset.treeTargetType;
      const id = actionButton.dataset.treeTargetId;
      actions.closeTreeItemMenus();

      if (action === 'new-folder' && type === 'library') {
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.openLibraryDialog(id);
        return;
      }

      if(action==='move' && type==='document'){actions.openMoveKnowledgeDocument(id);return;}
      if(action==='copy' && type==='library'){try{await actions.copyKnowledgeLibrary(id);}catch(error){actions.showToast('复制失败：'+error.message,true);}return;}

      if (action === 'export') {
        if (!config.desktop?.exportNotes) { actions.showToast('请在桌面应用中导出笔记', true); return; }
        if (env.noteTabActionPending || state.persistence.dataSavePending) return;
        try {
          if (state.editor.activeNoteEditorHasChanges?.() && !await state.editor.saveActiveNoteEditor({ quiet: true })) return;
          const result = await config.desktop.exportNotes({ type, id });
          if (result) actions.showToast(`已导出 ${result.count} 篇笔记：${result.path}`);
        } catch (error) { actions.showToast(`导出失败：${error.message || '请重试'}`, true); }
        return;
      }

      if (action === 'open-window' && type === 'document') {
        await actions.openNoteInNewWindow('knowledge', id);
        return;
      }

      if (action === 'new-note' && type === 'library') {
        actions.closeTreeItemMenus();
        env.requestNewNoteFile({ kind: 'knowledge', libraryId: id });
        return;
      }

      if (action === 'rename') {
        actions.startTreeRename(type, id);
        return;
      }

      if (type === 'library') {
        const library = env.application.state.knowledge.libraryById(id);
        if (!library) return;
        const confirmed = await actions.showConfirmDialog({
          title: `删除知识库“${library.name}”？`,
          message: '当前目录中的笔记和关联记忆卡片将移入回收站，可逐篇恢复。子目录将移到上一级，内容保留。',
          confirmLabel: '删除知识库'
        });
        if (!confirmed) return;
        state.knowledge.collapsedLibraryIds.delete(id);
        actions.saveCollapsedLibraryIds();
        await actions.deleteLibrary(id);
        actions.showToast('知识库已删除');
        return;
      }

      const document = actions.documentById(id);
      if (!document) return;
      const confirmed = actions.confirmLearningDeletion ? await actions.confirmLearningDeletion(document) : await actions.showConfirmDialog({ title: `删除笔记“${document.title}”？`, message: '笔记及关联记忆卡片将移入回收站，可随时恢复。', confirmLabel: '删除笔记' });
      if (!confirmed) return;
      await actions.deleteDocument(id, typeof confirmed === 'object' ? confirmed : {});
    }

    function toggleSidebarLibrary(libraryId) {
      if (state.knowledge.collapsedLibraryIds.has(libraryId)) state.knowledge.collapsedLibraryIds.delete(libraryId);
      else state.knowledge.collapsedLibraryIds.add(libraryId);
      actions.saveCollapsedLibraryIds();
    }

    async function handleKnowledgeTreeClick(event) {
      if (event.target.closest('.tree-rename-input')) return;

      const actionButton = event.target.closest('[data-tree-action]');
      if (actionButton) {
        await actions.handleTreeItemAction(actionButton);
        return;
      }

      const menuButton = event.target.closest('[data-tree-menu-button]');
      if (menuButton) {
        actions.openTreeItemMenu(menuButton);
        return;
      }

      const toggleButton = event.target.closest('[data-tree-toggle-library]');
      if (toggleButton) {
        const libraryId = toggleButton.dataset.treeToggleLibrary;
        actions.toggleSidebarLibrary(libraryId);
        actions.renderSidebarKnowledgeTree();
        return;
      }

      actions.closeTreeItemMenus();
      const documentButton = event.target.closest('[data-tree-document]');
      if (documentButton) {
        const documentId = documentButton.dataset.treeDocument;
        const document = actions.documentById(documentId);
        if (document) {
          if (await actions.openMarkdownNoteEditor(document)) { env.selectedNoteTagId = null; actions.syncSidebarSelection(); }
        }
        return;
      }

      const libraryButton = event.target.closest('[data-tree-library]');
      if (!libraryButton) return;

      const libraryId = libraryButton.dataset.treeLibrary;
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
      actions.toggleSidebarLibrary(libraryId);
      env.selectedNoteTagId = null;
      state.knowledge.selectedLibraryId = libraryId;
      actions.showView('libraries');
      actions.renderLibraries();
      actions.renderSidebarKnowledgeTree();
      env.application.views.cardEditor.fillLibrarySelects();
    }

    function handleKnowledgeTreeKeydown(event) {
      const input = event.target.closest('.tree-rename-input');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        actions.commitTreeRename(input);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        actions.cancelTreeRename();
      }
    }

    async function moveKnowledgeDocument(documentId, libraryId) {
      if (state.knowledge.knowledgeOperationPending || state.persistence.dataSavePending || env.noteTabActionPending) return;
      state.knowledge.knowledgeOperationPending = true;
      try {
        if (state.editor.activeNoteEditorHasChanges?.() && !await state.editor.saveActiveNoteEditor({ quiet:true })) return;
        await env.application.operations.knowledge.moveDocument(documentId, libraryId, {
          beforeSave: () => {
            state.knowledge.selectedLibraryId = libraryId;
            env.MemoKeepDirectoryTree.ancestors(env.application.state.knowledge.libraries, libraryId).forEach(item => state.knowledge.collapsedLibraryIds.delete(item.id));
            actions.saveCollapsedLibraryIds();
          },
          afterSave: ({ document, library }) => {
            if (state.editor.editingMarkdownDocumentId === documentId && config.$('#inlineMarkdownNoteTitle')) config.$('#inlineMarkdownNoteTitle').value = document.title;
            actions.renderAll(Boolean(state.editor.editingMarkdownDocumentId));
            actions.showToast('笔记已移动到“' + library.name + '”');
          },
          onRollback: () => actions.renderAll(Boolean(state.editor.editingMarkdownDocumentId))
        });
      } finally { state.knowledge.knowledgeOperationPending = false; }
    }

    function openMoveKnowledgeDocument(documentId) {
      const document=state.persistence.data.documents.find(doc=>doc.id===documentId);
      if(!document)return;
      const entries=env.MemoKeepDirectoryTree.entries(state.persistence.data.knowledgeBases).filter(({item})=>item.id!==document.knowledgeBaseId);
      if(!entries.length){actions.showToast('请先创建其他知识库目录');return;}
      const dialog=env.window.document.createElement('dialog');
      dialog.innerHTML=`<form class="knowledge-move-form"><h2>移动笔记</h2><p class="hint">${actions.escapeHtml(document.title)}</p><label>目标目录<select name="destination">${entries.map(({item})=>`<option value="${actions.escapeHtml(item.id)}">${actions.escapeHtml(env.MemoKeepDirectoryTree.label(state.persistence.data.knowledgeBases,item.id))}</option>`).join('')}</select></label><p class="hint">同名笔记将自动追加编号。</p><p class="move-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary">取消</button><button type="submit" class="primary">移动</button></div></form>`;
      env.window.document.body.append(dialog);
      dialog.addEventListener('close',()=>dialog.remove());
      dialog.querySelector('.secondary').onclick=()=>dialog.close();
      dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const submit=dialog.querySelector('[type=submit]');submit.disabled=true;try{await actions.moveKnowledgeDocument(documentId,dialog.querySelector('select').value);dialog.close();}catch(error){dialog.querySelector('.move-error').textContent='移动失败：'+error.message;}finally{submit.disabled=false;}};
      dialog.showModal();
    }

    async function copyKnowledgeLibrary(libraryId) {
      if(state.knowledge.knowledgeOperationPending || state.persistence.dataSavePending || env.noteTabActionPending)return;
      state.knowledge.knowledgeOperationPending=true;
      try {
        if(state.editor.activeNoteEditorHasChanges?.() && !await state.editor.saveActiveNoteEditor({quiet:true}))return;
        const root=env.application.state.knowledge.libraryById(libraryId);if(!root)return;
        const libraries=env.MemoKeepDirectoryTree.entries(state.persistence.data.knowledgeBases).filter(({item})=>env.MemoKeepDirectoryTree.ancestors(state.persistence.data.knowledgeBases,item.id).some(parent=>parent.id===libraryId)).map(({item})=>item);
        const libraryIds=new Set(libraries.map(item=>item.id));
        const documents=state.persistence.data.documents.filter(doc=>libraryIds.has(doc.knowledgeBaseId));
        const docIds=new Set(documents.map(doc=>doc.id));
        const items=state.persistence.data.items.filter(item=>libraryIds.has(item.knowledgeBaseId)||docIds.has(item.documentId));
        const itemIds=new Set(items.map(item=>item.id));
        const cards=state.persistence.data.cards.filter(card=>itemIds.has(card.knowledgeItemId));
        const ids=new Map([...libraries,...documents,...items,...cards].map(item=>[item.id,config.uid()]));
        const timestamp=new Date().toISOString();
        const remap=value=>{
          if(typeof value==='string'){for(const [oldId,newId] of ids)value=value.split(oldId).join(newId);return value;}
          if(Array.isArray(value))return value.map(remap);
          if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item)]));
          return value;
        };
        const clones=libraries.map(item=>({...remap(item),createdAt:timestamp,updatedAt:timestamp}));
        const clonedRoot=clones.find(item=>item.id===ids.get(libraryId));
        clonedRoot.name=actions.availableLibraryName(root.name,null,root.parentId||null);
        await env.application.persistence.transact(data => {
        data.knowledgeBases.push(...clones);
        data.documents.push(...documents.map(item=>({...remap(item),createdAt:timestamp,updatedAt:timestamp})));
        data.items.push(...items.map(item=>({...remap(item),createdAt:timestamp,updatedAt:timestamp})));
        data.cards.push(...cards.map(item=>({...remap(item),createdAt:timestamp,updatedAt:timestamp})));
        });actions.renderAll(Boolean(state.editor.editingMarkdownDocumentId));actions.showToast('已复制为“'+clonedRoot.name+'”');
      } catch(error) {actions.renderAll(Boolean(state.editor.editingMarkdownDocumentId));throw error;} finally {state.knowledge.knowledgeOperationPending=false;}
    }

    async function deleteDocument(documentId, { keepCards = false } = {}) {
      const document = actions.documentById(documentId); if (!document) return;
      await env.application.persistence.transact(data => {
        const current = data.documents.find(doc => doc.id === documentId); if(!current) return false;
        const items = data.items.filter(item => item.documentId === documentId), itemIds = new Set(items.map(item => item.id));
        const cards = data.cards.filter(card => itemIds.has(card.knowledgeItemId));
        if(keepCards) {
          for(const item of items) if(!item.source) actions.captureCardSource?.(data,item,{quote:item.backText||item.frontText});
          data.sourceChanges ||= [];
          for(const card of cards){const item=items.find(item=>item.id===card.knowledgeItemId),source=card.source||item?.source;if(!source)continue;card.source ||= env.structuredClone(source);
            const existing=data.sourceChanges.find(row=>row.cardId===card.id&&['pending','orphan'].includes(row.status));
            const change={cardId:card.id,itemId:item.id,documentId,source:env.structuredClone(source),oldText:source.blockText||source.quote,newText:'',oldAnswer:card.answer,newAnswer:card.answer,status:'orphan',updatedAt:config.now()};
            if(existing)Object.assign(existing,change);else data.sourceChanges.push({id:config.uid(),createdAt:config.now(),...change});
          }
        }
        data.trash.unshift({id:config.uid(),deletedAt:new Date().toISOString(),libraryName:env.application.state.knowledge.libraryById(current.knowledgeBaseId)?.name||'未分类',document:env.structuredClone(current),items:keepCards?[]:env.structuredClone(items),cards:keepCards?[]:env.structuredClone(cards),keptCardIds:keepCards?cards.map(card=>card.id):[]});
        data.documents=data.documents.filter(doc=>doc.id!==documentId);
        if(!keepCards){data.items=data.items.filter(item=>item.documentId!==documentId);data.cards=data.cards.filter(card=>!itemIds.has(card.knowledgeItemId));}
      });
      if(state.editor.editingMarkdownDocumentId===documentId)env.application.editor.session.resetActiveNoteEditor();
      actions.renderAll();actions.showToast(keepCards?'笔记已移入回收站，卡片和引用快照已保留':'笔记及关联卡片已移入回收站');
    }

    async function deleteLibrary(libraryId) {
      if (state.editor.activeNoteEditorLibraryId === libraryId) env.application.editor.session.resetActiveNoteEditor();
      const library = env.application.state.knowledge.libraryById(libraryId);
      const documents = state.persistence.data.documents.filter(document => document.knowledgeBaseId === libraryId);
      documents.forEach(document => {
        const items = state.persistence.data.items.filter(item => item.documentId === document.id);
        const documentItemIds = new Set(items.map(item => item.id));
        const cards = state.persistence.data.cards.filter(card => documentItemIds.has(card.knowledgeItemId));
        state.persistence.data.trash.unshift({ id: config.uid(), deletedAt: new Date().toISOString(), libraryName: library?.name || '未分类', document: env.structuredClone(document), items: env.structuredClone(items), cards: env.structuredClone(cards) });
      });
      const itemIds = new Set(
      state.persistence.data.items.filter(item => item.knowledgeBaseId === libraryId).map(item => item.id)
      );
      state.persistence.data.knowledgeBases = state.persistence.data.knowledgeBases.filter(library => library.id !== libraryId);
      state.persistence.data.knowledgeBases.forEach(child => { if (child.parentId === libraryId) child.parentId = library?.parentId || null; });
      state.persistence.data.documents = state.persistence.data.documents.filter(document => document.knowledgeBaseId !== libraryId);
      state.persistence.data.items = state.persistence.data.items.filter(item => item.knowledgeBaseId !== libraryId);
      state.persistence.data.cards = state.persistence.data.cards.filter(card => (
      card.knowledgeBaseId !== libraryId && !itemIds.has(card.knowledgeItemId)
      ));
      state.knowledge.selectedLibraryId = state.persistence.data.knowledgeBases[0]?.id || null;
      await env.application.persistence.save();
      actions.renderAll();
      actions.showToast(documents.length ? `知识库已删除，${documents.length} 篇笔记已移入回收站` : '知识库已删除');
    }

    async function handleLibraryContentClick(event) {
      if (env.handleNoteDirectoryClick(event)) return;
      if (event.target.id === 'addSelectedItemsBtn') actions.addSelectedItems();
      if (event.target.id === 'selectAllItems') {
        config.$$('.item-check:not(:disabled)').forEach(input => {
          input.checked = event.target.checked;
        });
      }

      const renameDocumentId = event.target.closest('[data-rename-document]')?.dataset.renameDocument;
      if (renameDocumentId) {
        event.stopPropagation();
        actions.startDocumentListRename(renameDocumentId);
        return;
      }

      const documentId = event.target.closest('[data-delete-document]')?.dataset.deleteDocument;
      if (documentId) {
        event.stopPropagation();
        const document = actions.documentById(documentId);
        const confirmed = actions.confirmLearningDeletion ? await actions.confirmLearningDeletion(document) : await actions.showConfirmDialog({ title: `删除笔记“${document?.title || '未命名笔记'}”？`, message: '笔记及关联记忆卡片将移入回收站，可随时恢复。', confirmLabel: '删除笔记' });
        if (confirmed) await actions.deleteDocument(documentId, typeof confirmed === 'object' ? confirmed : {});
        return;
      }

      const documentRow = event.target.closest('[data-open-document-row]');
      const openDocumentId = documentRow?.dataset.openDocumentRow;
      if (openDocumentId) actions.openMarkdownNoteEditor(actions.documentById(openDocumentId), '', documentRow);

      const libraryId = event.target.closest('[data-delete-library]')?.dataset.deleteLibrary;
      if (libraryId) {
        const library = env.application.state.knowledge.libraryById(libraryId);
        const confirmed = await actions.showConfirmDialog({
          title: `删除知识库“${library?.name || '未命名知识库'}”？`,
          message: '当前目录中的笔记和关联记忆卡片将移入回收站，可逐篇恢复。子目录将移到上一级，内容保留。',
          confirmLabel: '删除知识库'
        });
        if (confirmed) await actions.deleteLibrary(libraryId);
      }
    }

    function handleLibraryContentKeydown(event) {
      if (!['Enter', ' '].includes(event.key) || event.target.closest('.document-actions, input, button, select')) return;
      const documentRow = event.target.closest('[data-open-document-row]');
      if (!documentRow) return;
      event.preventDefault();
      actions.openMarkdownNoteEditor(actions.documentById(documentRow.dataset.openDocumentRow), '', documentRow);
    }

    function bindKnowledgeEvents() {
      const locate = config.$('#locateCurrentNoteButton');
      if (locate) {
        locate.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
        locate.onclick = actions.locateCurrentNote;
      }
      env.bindNoteTagEvents();
      env.bindLibrarySettings();
      // 侧栏「知识库」右侧悬停出现的「+」（design/prototype/sidebar-trailing-icons-20261111.md 方案 B）。
      config.$('#newLibraryBtn').onclick = async () => { if (await env.application.editor.session.leaveActiveNoteEditor()) actions.openLibraryDialog(); };
      config.$('#newNoteBtn').onclick = event => env.requestNewNoteFile({ kind: 'knowledge', libraryId: env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId)?.id || state.persistence.data.knowledgeBases[0]?.id, tagId: env.selectedNoteTagId }, event.currentTarget);
      config.$('#libraryForm').onsubmit = actions.handleCreateLibrary;
      config.$('#newNoteNameForm').onsubmit = actions.handleNewNoteNameSubmit;
      config.$('#markdownImportInput').onchange = async event => {
        const files = [...event.target.files];
        const libraryId = event.target.dataset.libraryId;
        event.target.value = '';
        await actions.importMarkdownFiles(files, libraryId);
      };
      config.$('#knowledgeTree').onclick = actions.handleKnowledgeTreeClick;
      config.$('#knowledgeTree').onpointerdown = event => {
        const button = event.target.closest('[data-tree-menu-button]');
        // Native light-dismiss runs before click, so remember the pointerdown state.
        state.knowledge.treeMenuPointerDown = button && event.button === 0
        ? { button, open: button.parentElement.querySelector('.tree-item-menu').matches(':popover-open') } : null;
      };
      config.$('#knowledgeTree').oncontextmenu = event => {
        if (!state.persistence.applicationDataReady || event.target.closest('input, .tree-item-menu')) return;
        const button = event.target.closest('.tree-library-row, .tree-document-row')?.querySelector('[data-tree-menu-button]');
        if (!button) return;
        env.openSidebarContextMenu(event, () => actions.openTreeItemMenu(button, { x: event.clientX, y: event.clientY }));
      };
      env.window.addEventListener('resize', actions.closeTreeItemMenus);
      config.$('.shell > header > nav').addEventListener('scroll', actions.closeTreeItemMenus, { passive: true });
      config.$('#knowledgeTree').onkeydown = actions.handleKnowledgeTreeKeydown;
      config.$('#knowledgeTree').onfocusout = event => {
        const input = event.target.closest('.tree-rename-input');
        if (!input) return;
        const renameRow = input.closest('.tree-library-row, .tree-document-row');
        if (renameRow?.contains(event.relatedTarget)) return;
        actions.cancelTreeRename();
      };
      config.$('#knowledgeTree').onpointerout = event => {
        const renameRow = event.target.closest('.tree-library-row, .tree-document-row');
        if (!renameRow?.querySelector('.tree-rename-input')) return;
        if (renameRow.contains(event.relatedTarget)) return;
        actions.cancelTreeRename();
      };
      env.window.document.addEventListener('pointerdown', event => {
        if (!state.knowledge.renamingTreeItem) return;
        const renameRow = config.$('#knowledgeTree .tree-rename-input')
        ?.closest('.tree-library-row, .tree-document-row');
        if (renameRow?.contains(event.target)) return;
        actions.cancelTreeRename();
      }, true);
      env.window.document.addEventListener('click', event => {
        if (!event.target.closest('.tree-item-menu, .tree-more')) actions.closeTreeItemMenus();
      });
      config.$('#libraryContent').onclick = actions.handleLibraryContentClick;
      config.$('#libraryContent').onkeydown = actions.handleLibraryContentKeydown;
      config.$('#createFromSelectionBtn').onclick = actions.handleCreateCardFromSelection;
    }
    return { locateCurrentNote, syncLocateCurrentNoteButton, loadCollapsedLibraryIds, saveCollapsedLibraryIds, collapseAllDirectories, cardLibraryLabel, renderSidebarKnowledgeTree, renderLibraries, startDocumentListRename, renderItemTable, openLibraryDialog, openDocument, addSelectedItems, handleCreateLibrary, renderTreeDocumentMenu, closeTreeItemMenus, openTreeItemMenu, startTreeRename, commitTreeRename, cancelTreeRename, handleTreeItemAction, toggleSidebarLibrary, handleKnowledgeTreeClick, handleKnowledgeTreeKeydown, moveKnowledgeDocument, openMoveKnowledgeDocument, copyKnowledgeLibrary, deleteDocument, deleteLibrary, handleLibraryContentClick, handleLibraryContentKeydown, bindKnowledgeEvents };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createKnowledge });
})(globalThis);
