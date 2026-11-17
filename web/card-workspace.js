// Card organization is independent from the original knowledge documents.
function activeCardNotebooks() {
  const documents = new Set([...applicationShell.state.persistence.data.documents, ...applicationShell.state.persistence.data.cardDocuments].map(doc => doc.id));
  return applicationShell.state.persistence.data.cardNotebooks.filter(note => !note.sourceDocumentId || documents.has(note.sourceDocumentId));
}

function openCardNotebookView(notebookId) {
  const notebook = activeCardNotebooks().find(note => note.id === notebookId);
  if (!notebook) {
    applicationShell.actions.showView('cards');
    application.views.cards.render();
    return;
  }
  MemoKeepDirectoryTree.ancestors(applicationShell.state.persistence.data.cardFolders, notebook.folderId).forEach(folder => application.cards.runtime.closedCardFolders.delete(folder.id));
  const source = applicationShell.actions.documentById(notebook.sourceDocumentId);
  if (source) {
    if (application.state.knowledge.libraryById(source.knowledgeBaseId)) applicationShell.state.knowledge.selectedLibraryId = source.knowledgeBaseId;
    applicationShell.actions.openMarkdownNoteEditor(source, '', null, notebook.id);
    renderCardWorkspace();
    return;
  }
  applicationShell.actions.showView('cards');
  application.views.cards.render();
}





function normalizeCardWorkspace(input, cards) {
  const folders = Array.isArray(input.cardFolders) ? input.cardFolders : [];
  const notebooks = Array.isArray(input.cardNotebooks) ? input.cardNotebooks : [];
  const documents = Array.isArray(input.cardDocuments) ? input.cardDocuments : [];
  if (!input.cardOrganizationVersion) {
    cards.forEach(card => {
      const item = (input.items || []).find(item => item.id === card.knowledgeItemId);
      const doc = (input.documents || []).find(doc => doc.id === item?.documentId);
      if (!doc) return;
      const library = (input.knowledgeBases || []).find(library => library.id === doc.knowledgeBaseId);
      const folderId = library ? `folder-${library.id}` : null;
      if (library && !folders.some(folder => folder.id === folderId)) folders.push({ id: folderId, name: library.name });
      const notebookId = `notebook-${doc.id}`;
      if (!notebooks.some(notebook => notebook.id === notebookId)) notebooks.push({ id: notebookId, name: doc.title, folderId, sourceDocumentId: doc.id });
      card.cardNotebookId = notebookId;
    });
  }
  // Give standalone notebooks a real document without adding them to knowledge libraries.
  // Never recreate a missing source: deleted notes must remain deleted.
  notebooks.filter(note => !note.sourceDocumentId).forEach(note => {
    const id = `card-document-${note.id}`;
    if (!documents.some(doc => doc.id === id)) {
      const timestamp = new Date().toISOString();
      documents.push({ id, title: note.name, knowledgeBaseId: null, content: '',
        sourceType: 'manual-markdown', metadata: { editorMode: 'card', versions: [] },
        createdAt: timestamp, updatedAt: timestamp });
    }
    note.sourceDocumentId = id;
  });
  return { cardFolders: folders, cardNotebooks: notebooks, cardDocuments: documents, cardOrganizationVersion: 1 };
}

// Keep each notebook recoverable, including empty notes and its original folder path.
async function trashCardFolder(folderId) {
  let folderIds, ownedCards, notebookIds, documentIds;
  try { await application.persistence.transact(data => {
    folderIds = new Set(MemoKeepDirectoryTree.entries(data.cardFolders)
      .filter(({ item, parents }) => item.id === folderId || parents.some(parent => parent.id === folderId)).map(({ item }) => item.id));
    if (!folderIds.size) return false;
    ownedCards = data.cards.filter(card=>folderIds.has(cardFolderId(card)));
    const ownedIds = new Set(ownedCards.map(card=>card.id));
    const notebooks = data.cardNotebooks.filter(note => folderIds.has(note.folderId));
    notebookIds = new Set(notebooks.map(note => note.id));
    const retainedNotebookIds = new Set(data.cards.filter(card=>!ownedIds.has(card.id)).map(card=>card.cardNotebookId).filter(Boolean));
    documentIds = new Set(notebooks.map(note => note.sourceDocumentId).filter(id =>
      data.cardDocuments.some(doc => doc.id === id)
      && !data.cards.some(card => !ownedIds.has(card.id) && (
        data.items.some(item => item.id === card.knowledgeItemId && item.documentId === id)
        || data.cardNotebooks.some(note => note.id === card.cardNotebookId && note.sourceDocumentId === id)))
      && !data.cardNotebooks.some(note => !notebookIds.has(note.id) && note.sourceDocumentId === id)));
    const entries = notebooks.map(notebook => {
      const source = [...data.documents, ...data.cardDocuments].find(doc => doc.id === notebook.sourceDocumentId);
      const folders = new Map();
      const locations = [notebook.folderId, ...ownedCards.filter(card => card.cardNotebookId === notebook.id).map(cardFolderId)];
      for (const location of locations) for (const folder of MemoKeepDirectoryTree.ancestors(data.cardFolders, location)) folders.set(folder.id, folder);
      return { id: applicationShell.config.uid(), type: 'card-notebook', deletedAt: new Date().toISOString(), notebook: structuredClone(notebook),
        folders: structuredClone([...folders.values()]),
        originalLocation: MemoKeepDirectoryTree.label(data.cardFolders, notebook.folderId),
        document: source ? structuredClone(source) : { id: notebook.sourceDocumentId, title: notebook.name, content: '', metadata: { editorMode: 'card' } },
        ownsDocument: data.cardDocuments.some(doc => doc.id === notebook.sourceDocumentId),
        items: structuredClone(data.items.filter(item => item.documentId === notebook.sourceDocumentId)),
        cards: structuredClone(ownedCards.filter(card => card.cardNotebookId === notebook.id)) };
    });
    const grouped = new Set(entries.flatMap(entry=>entry.cards.map(card=>card.id)));
    entries.push(...ownedCards.filter(card=>!grouped.has(card.id)).map(card=>({id:applicationShell.config.uid(),type:'card',deletedAt:new Date().toISOString(),card:structuredClone(card),folders:structuredClone(MemoKeepDirectoryTree.ancestors(data.cardFolders,cardFolderId(card))),originalLocation:MemoKeepDirectoryTree.label(data.cardFolders,cardFolderId(card))})));
    data.trash.unshift(...entries);
    data.cardFolders = data.cardFolders.filter(folder => !folderIds.has(folder.id));
    data.cardNotebooks = data.cardNotebooks.filter(note => !notebookIds.has(note.id) || retainedNotebookIds.has(note.id));
    data.cardDocuments = data.cardDocuments.filter(doc => !documentIds.has(doc.id));
    data.items = data.items.filter(item => !documentIds.has(item.documentId));
    data.cards = data.cards.filter(card => !ownedIds.has(card.id));
  }); } catch (error) { applicationShell.actions.renderAll(); throw error; }
  if (!folderIds.size) return;
  folderIds.forEach(id => application.cards.runtime.closedCardFolders.delete(id));
  application.cards.runtime.selectedCardIds.clear();
  if (notebookIds.has(applicationShell.state.editor.editingCardNotebookId) || documentIds.has(applicationShell.state.editor.editingMarkdownDocumentId)) application.editor.session.resetActiveNoteEditor();
  applicationShell.actions.renderAll(); applicationShell.actions.renderTrash();
  applicationShell.actions.showToast(`目录已删除，${ownedCards.length} 张卡片已移入回收站`);
}

async function restoreCardNotebookTrash(entryId) {
  try { await application.persistence.transact(data => {
    const entry = data.trash.find(item => item.id === entryId && item.type === 'card-notebook');
    if (!entry) return false;
    for (const folder of entry.folders || []) {
      if (!data.cardFolders.some(item => item.id === folder.id)) data.cardFolders.push(structuredClone(folder));
    }
    if (!data.cardNotebooks.some(note => note.id === entry.notebook.id)) data.cardNotebooks.push(structuredClone(entry.notebook));
    if (![...data.documents, ...data.cardDocuments].some(doc => doc.id === entry.document.id)) (entry.ownsDocument ? data.cardDocuments : data.documents).push(structuredClone(entry.document));
    for (const item of entry.items) if (!data.items.some(current => current.id === item.id)) data.items.push(structuredClone(item));
    for (const card of entry.cards) if (!data.cards.some(current => current.id === card.id)) data.cards.push(structuredClone(card));
    data.trash = data.trash.filter(item => item.id !== entryId);
  }); } catch (error) { applicationShell.actions.renderAll(); applicationShell.actions.renderTrash(); throw error; }
  applicationShell.actions.renderAll(); applicationShell.actions.renderTrash();
}

// Explicit directory ownership takes precedence; old cards keep their notebook-derived location.
function cardFolderId(card) {
  if (Object.prototype.hasOwnProperty.call(card, 'cardFolderId')) return card.cardFolderId || null;
  return applicationShell.state.persistence.data.cardNotebooks.find(note => note.id === card.cardNotebookId)?.folderId || null;
}
function cardDestination(value) {
  if (value.startsWith('folder:')) return { cardFolderId: value.slice(7) };
  return value ? { cardNotebookId: value } : { cardFolderId: null };
}
function cardsInScope() {
  // 主题 / 技术点（design/prototype/card-topics-20261112.md）。
  const scope = application.cards.runtime.cardScope;
  if (scope.type === 'topic' && window.MemoKeepCardTopics) {
    const data = applicationShell.state.persistence.data, index = MemoKeepCardTopics.indexOf(data);
    return data.cards.filter(card => { const where = MemoKeepCardTopics.topicOf(card, data, index); return where.topicId === scope.id && (!scope.point || where.pointId === scope.point); });
  }
  const folderIds = new Set(MemoKeepDirectoryTree.entries(applicationShell.state.persistence.data.cardFolders)
    .filter(({ item, parents }) => item.id === application.cards.runtime.cardScope.id || parents.some(parent => parent.id === application.cards.runtime.cardScope.id))
    .map(({ item }) => item.id));
  return applicationShell.state.persistence.data.cards.filter(card => {
    const notebook = applicationShell.state.persistence.data.cardNotebooks.find(note => note.id === card.cardNotebookId);
    if (application.cards.runtime.cardScope.type === 'notebook') return notebook?.id === application.cards.runtime.cardScope.id;
    if (application.cards.runtime.cardScope.type === 'folder') return folderIds.has(cardFolderId(card));
    if (application.cards.runtime.cardScope.type === 'unfiled') return !cardFolderId(card) && (!notebook || Object.prototype.hasOwnProperty.call(card,'cardFolderId'));
    return true;
  });
}

function cardNotebookOptions() {
  return '<option value="">未分类</option>' + MemoKeepDirectoryTree.entries(applicationShell.state.persistence.data.cardFolders).map(({item}) => `<option value="folder:${applicationShell.actions.escapeHtml(item.id)}">${applicationShell.actions.escapeHtml(MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.cardFolders,item.id))}</option>`).join('') + '<optgroup label="历史卡片笔记">' + activeCardNotebooks().map(note => {
    const folder = applicationShell.state.persistence.data.cardFolders.find(folder => folder.id === note.folderId);
    return `<option value="${applicationShell.actions.escapeHtml(note.id)}">${applicationShell.actions.escapeHtml((folder ? MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.cardFolders, folder.id) + ' / ' : '') + note.name)}</option>`;
  }).join('') + '</optgroup>';
}

function renderCardWorkspace(sidebarOnly = false) {
  updateSidebarDirectoryToggle();
  const notebooks = activeCardNotebooks();
  if (application.cards.runtime.cardScope.type === 'notebook' && !notebooks.some(note => note.id === application.cards.runtime.cardScope.id)
    || application.cards.runtime.cardScope.type === 'folder' && !applicationShell.state.persistence.data.cardFolders.some(folder => folder.id === application.cards.runtime.cardScope.id)) application.cards.runtime.cardScope = { type: 'all', id: '' };
  const row = (type, id, name, count, icon, indent = 0) => `<div class="card-tree-row ${indent ? 'nested' : ''}" style="margin-left:${15 + indent}px">
    ${type === 'folder' ? `<button class="card-tree-chevron" data-folder-toggle="${applicationShell.actions.escapeHtml(id)}" aria-label="展开或收起${applicationShell.actions.escapeHtml(name)}" aria-expanded="${!application.cards.runtime.closedCardFolders.has(id)}"></button>` : ''}
    <button class="card-tree-label" data-card-scope="${type}" data-scope-id="${applicationShell.actions.escapeHtml(id)}" title="${applicationShell.actions.escapeHtml(name)}"><svg class="tree-kind-icon" aria-hidden="true"><use href="#icon-${type === 'notebook' ? 'layers' : icon}"></use></svg><span>${applicationShell.actions.escapeHtml(name)}</span>${['folder', 'notebook'].includes(type) ? '' : `<small>${count}</small>`}</button>
    ${['folder', 'notebook'].includes(type) ? `<button class="card-tree-more" data-card-organize="${type}" data-organize-id="${applicationShell.actions.escapeHtml(id)}" title="更多操作" aria-label="${applicationShell.actions.escapeHtml(name)}的更多操作" aria-haspopup="menu" aria-expanded="false">•••</button>` : ''}</div>`;
  const notebookRow = (note, indent = 0) => row('notebook', note.id, note.name, 0, 'book-open-text', indent);
  const foldersById = new Set(applicationShell.state.persistence.data.cardFolders.map(folder => folder.id));
  const notesByFolder = new Map();
  for (const note of notebooks) { if (!notesByFolder.has(note.folderId)) notesByFolder.set(note.folderId, []); notesByFolder.get(note.folderId).push(note); }
  // 没有卡片目录时不能展开：不显示箭头，图标保持原样。
  applicationShell.config.$('.card-nav-group').classList.toggle('is-empty', !applicationShell.state.persistence.data.cardFolders.length);
  applicationShell.config.$('#cardTree').innerHTML = applicationShell.config.$('.card-nav-group').classList.contains('tree-collapsed') ? '' : MemoKeepDirectoryTree.entries(applicationShell.state.persistence.data.cardFolders).map(({ item: folder, depth, parents }) => {
      if (parents.some(parent => application.cards.runtime.closedCardFolders.has(parent.id))) return '';
      const notes = notesByFolder.get(folder.id) || [];
      return row('folder', folder.id, folder.name, 0, 'folder', (depth - 1) * 14)
        + (application.cards.runtime.closedCardFolders.has(folder.id) ? '' : notes.map(note => notebookRow(note, (depth - 1) * 14 + 18)).join(''));
    }).join('') + notebooks.filter(note => !foldersById.has(note.folderId)).map(note => notebookRow(note)).join('');
  applicationShell.actions.syncSidebarSelection();
  if (sidebarOnly) return;
  const notebook = notebooks.find(note => application.cards.runtime.cardScope.type === 'notebook' && note.id === application.cards.runtime.cardScope.id);
  const folder = applicationShell.state.persistence.data.cardFolders.find(folder => folder.id === (notebook?.folderId || (application.cards.runtime.cardScope.type === 'folder' ? application.cards.runtime.cardScope.id : '')));
  const title = notebook?.name || folder?.name || (application.cards.runtime.cardScope.type === 'unfiled' ? '未分类' : '全部卡片');
  applicationShell.config.$('#cardWorkspaceTitle').textContent = title;
  applicationShell.config.$('#cardWorkspaceTitle').title = title;
  applicationShell.config.$('#cardBreadcrumb').textContent = ['记忆卡片', MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.cardFolders, folder?.id), notebook?.name || (!folder ? title : '')].filter(Boolean).join(' / ');
  const scopedCards = cardsInScope();
  applicationShell.config.$('#cardWorkspaceSubtitle').textContent = `${scopedCards.length} 张卡片`;
  const due = scopedCards.filter(card => card.status === 'active' && card.dueAt <= applicationShell.config.now()).length;
  const newDue = scopedCards.filter(card => card.status === 'active' && card.dueAt <= applicationShell.config.now() && card.reviewCount === 0).length;
  applicationShell.config.$('#cardReviewSummaryTitle').textContent = due
    ? `当前可复习 ${due} 张 · 预计 ${Math.max(1, Math.ceil(due / 2))} 分钟`
    : scopedCards.length ? '当前没有到期卡片' : '从第一张卡片开始积累';
  applicationShell.config.$('#cardReviewSummaryHint').textContent = due
    ? `${newDue ? `含 ${newDue} 张新卡 · ` : ''}每次回想，都让记忆更牢固。`
    : scopedCards.length ? '按自己的节奏学习，卡片到期后再来复习。' : '把值得记住的内容整理成问答，留给下一次回想。';
  applicationShell.config.$('.card-review-summary').title = '按当前目录内已到期卡片统计，耗时按每张约 30 秒估算';
  const reviewButton = applicationShell.config.$('#cardStartReviewBtn');
  reviewButton.querySelector('span').textContent = `${notebook ? '复习本笔记' : folder ? '复习此目录' : '开始复习'} · ${due}`;
  // Keep this actionable: a card may become due while this view stays open.
  reviewButton.title = '按当前时间复习已到期的新卡和待复习卡片';
  applicationShell.config.$('#cardWorkspaceSubtitle').textContent = `${scopedCards.length} 张卡片${due ? ` · 到期 ${due} 张` : ''}`;
  applicationShell.config.$('.card-review-summary').classList.add('hidden');
  reviewButton.disabled = scopedCards.length === 0;
}

function createCardInWorkspace() {
  application.views.cardEditor.openCardDialog();
  if (application.cards.runtime.cardScope.type === 'folder') applicationShell.config.$('#cardNotebookSelect').value = `folder:${application.cards.runtime.cardScope.id}`;
}

function closeCardContentMenus() {
  applicationShell.config.$$('.card-workspace-create-menu:popover-open, .card-row-menu:popover-open').forEach(menu => menu.hidePopover());
}

function bindCardContentMenus() {
  // Both menus use native light-dismiss, with keyboard navigation and focus return.
  const makeMenu = (id, className, label) => {
    const menu = document.createElement('div');
    menu.id = id;
    menu.className = `card-directory-menu ${className}${className === 'card-row-menu' ? ' compact-context-menu' : ''}`;
    menu.setAttribute('popover', 'auto');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    document.body.append(menu);
    let trigger = null;
    let pressedWhileOpen = null;
    document.addEventListener('pointerdown', event => {
      pressedWhileOpen = menu.matches(':popover-open') && trigger?.contains(event.target) ? trigger : null;
    }, true);
    menu.addEventListener('toggle', event => {
      trigger?.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.hidePopover();
        trigger?.focus({ preventScroll: true });
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Tab') {
        menu.hidePopover();
        trigger?.focus({ preventScroll: true });
      }
    });
    return { menu, toggle(button) {
      const wasOpen = menu.matches(':popover-open') && trigger === button || pressedWhileOpen === button;
      pressedWhileOpen = null;
      closeCardContentMenus();
      if (wasOpen) return;
      trigger = button;
      menu.showPopover();
      button.setAttribute('aria-expanded', 'true');
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8))}px`;
      menu.querySelector('button')?.focus({ preventScroll: true });
    } };
  };
  applicationShell.config.$('#newCardBtn').onclick = createCardInWorkspace;
  applicationShell.config.$('#importCardsBtn').onclick = chooseCardImport;
  applicationShell.config.$('#cardSort').onchange = () => {application.cards.runtime.cardPage=1;application.views.cards.render();};
  const row = makeMenu('cardRowMenu', 'card-row-menu', '卡片操作');
  applicationShell.config.$('#allCards').addEventListener('click', event => {
    const button = event.target.closest('[data-card-more]');
    if (!button) return;
    const card = applicationShell.state.persistence.data.cards.find(card => card.id === button.dataset.cardMore);
    if (!card) return;
    const id = applicationShell.actions.escapeHtml(card.id);
    row.menu.innerHTML = `<button type="button" role="menuitem" data-edit-card="${id}"><svg aria-hidden="true"><use href="#icon-pencil"></use></svg>编辑卡片</button><button type="button" role="menuitem" data-toggle-card="${id}"><svg aria-hidden="true"><use href="#icon-${card.status === 'paused' ? 'play' : 'pause'}"></use></svg>${card.status === 'paused' ? '恢复' : '暂停'}复习</button><div class="tree-menu-separator" role="separator"></div><button type="button" role="menuitem" class="danger" data-delete-card="${id}"><svg aria-hidden="true"><use href="#icon-trash"></use></svg>移入回收站</button>`;
    row.toggle(button);
  });
  row.menu.onclick = async event => {
    if (!event.target.closest('button')) return;
    row.menu.hidePopover();
    await application.views.cardEvents.handleCardListClick(event);
  };
  window.addEventListener('resize', closeCardContentMenus);
  applicationShell.config.$('#cardsView').addEventListener('scroll', closeCardContentMenus, { passive: true });
  window.addEventListener('scroll', closeCardContentMenus, { passive: true });
}

function openCardOrganization(type = 'notebook', id = '', parentFolderId = null) {
  if (type === 'notebook' && !id) return createNoteTab({ kind: 'cards', folderId: parentFolderId || (application.cards.runtime.cardScope.type === 'folder' ? application.cards.runtime.cardScope.id : null) });
  const item = (type === 'folder' ? applicationShell.state.persistence.data.cardFolders : applicationShell.state.persistence.data.cardNotebooks).find(item => item.id === id);
  const parentId = type === 'folder' ? (item?.parentId || parentFolderId || null) : null;
  if (type === 'folder' && !item) {
    const error = MemoKeepDirectoryTree.creationError(applicationShell.state.persistence.data.cardFolders, parentId);
    if (error) { applicationShell.actions.showToast(error, true); return; }
  }
  applicationShell.config.$('#cardOrganizationForm').reset();
  applicationShell.config.$('#cardOrganizationType').value = type;
  applicationShell.config.$('#cardOrganizationId').value = id;
  applicationShell.config.$('#cardOrganizationParentId').value = parentId || '';
  applicationShell.config.$('#cardOrganizationParentHint').textContent = `上级目录：${MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.cardFolders, parentId) || '记忆卡片根目录'} · 第 ${MemoKeepDirectoryTree.ancestors(applicationShell.state.persistence.data.cardFolders, parentId).length + 1} / 5 层`;
  applicationShell.config.$('#cardOrganizationParentHint').classList.toggle('hidden', type !== 'folder');
  applicationShell.config.$('#cardOrganizationName').value = item?.name || '';
  applicationShell.config.$('#cardOrganizationNameLabel').textContent = type === 'folder' ? '目录名称' : '笔记名称';
  applicationShell.config.$('#cardOrganizationName').placeholder = type === 'folder' ? '例如：工作学习' : '例如：后端启动命令';
  applicationShell.config.$('#cardOrganizationFolder').innerHTML = '<option value="">根目录</option>' + MemoKeepDirectoryTree.entries(applicationShell.state.persistence.data.cardFolders).map(({ item: folder }) => `<option value="${applicationShell.actions.escapeHtml(folder.id)}">${applicationShell.actions.escapeHtml(MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.cardFolders, folder.id))}</option>`).join('');
  applicationShell.config.$('#cardOrganizationFolder').value = item?.folderId || parentFolderId || (application.cards.runtime.cardScope.type === 'folder' ? application.cards.runtime.cardScope.id : '');
  applicationShell.config.$('#cardOrganizationFolderField').classList.toggle('hidden', type === 'folder');
  applicationShell.config.$('#cardOrganizationTitle').textContent = `${item ? '重命名' : '新建'}${type === 'folder' ? '目录' : '卡片笔记'}`;
  applicationShell.config.$('#cardOrganizationSubmit').textContent = item ? '保存' : '创建';
  applicationShell.config.$('#cardOrganizationDialog').showModal();
  applicationShell.config.$('#cardOrganizationName').focus();
  if (item) applicationShell.config.$('#cardOrganizationName').select();
}

function bindSidebarCreateMenu(button, kind) {
  const isKnowledge = kind === 'knowledge';
  const label = isKnowledge ? '新增知识库内容' : '新增记忆卡片内容';
  button.classList.add('sidebar-create-button');
  button.innerHTML = '<svg aria-hidden="true"><use href="#icon-plus"></use></svg>';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'card-directory-menu sidebar-create-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.innerHTML = `<button type="button" role="menuitem" data-create="folder"><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>新增${isKnowledge ? '知识库' : '记忆卡片'}目录</span></button><button type="button" role="menuitem" data-create="note"><svg aria-hidden="true"><use href="#icon-file-plus-2"></use></svg><span>新增${isKnowledge ? '知识库' : '记忆卡片'}笔记</span></button>`;
  document.body.append(menu);
  menu.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
  button.onclick = () => {
    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button').focus({ preventScroll: true });
  };
  menu.onclick = async event => {
    const action = event.target.closest('[data-create]')?.dataset.create;
    if (!action) return;
    menu.hidePopover();
    if (!await application.editor.session.leaveActiveNoteEditor()) return;
    if (isKnowledge) {
      if (action === 'folder') applicationShell.actions.openLibraryDialog();
      else if (application.state.knowledge.libraryById(applicationShell.state.knowledge.selectedLibraryId)) requestNewNoteFile({ kind: 'knowledge', libraryId: applicationShell.state.knowledge.selectedLibraryId });
      else { applicationShell.actions.showToast('请先创建并选择一个知识库目录', true); applicationShell.actions.openLibraryDialog(); }
    } else {
      const notebook = applicationShell.state.persistence.data.cardNotebooks.find(note => note.id === application.cards.runtime.cardScope.id && application.cards.runtime.cardScope.type === 'notebook');
      openCardOrganization(action === 'folder' ? 'folder' : 'notebook', '', action === 'folder' ? null : notebook?.folderId || null);
    }
  };
  const close = () => menu.hidePopover();
  window.addEventListener('resize', close);
  applicationShell.config.$('.shell > header > nav').addEventListener('scroll', close, { passive: true });
}

let cancelPendingSidebarContextMenu = null;

function openSidebarContextMenu(event, showMenu) {
  event.preventDefault();
  cancelPendingSidebarContextMenu?.();
  const target = event.target;
  let timer;
  const cancel = () => {
    clearTimeout(timer);
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('scroll', cancel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    if (cancelPendingSidebarContextMenu === cancel) cancelPendingSidebarContextMenu = null;
  };
  const open = () => {
    cancel();
    if (target.isConnected) showMenu();
  };
  const release = released => {
    if (!released.buttons) timer = setTimeout(open, 0);
  };
  const onKeyDown = key => { if (key.key === 'Escape') cancel(); };
  cancelPendingSidebarContextMenu = cancel;
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('scroll', cancel, true);
  window.addEventListener('keydown', onKeyDown, true);
  // macOS sends contextmenu on press. Let native popover light-dismiss finish
  // on release before opening, including a long press or Control-click.
  if (event.buttons) window.addEventListener('pointerup', release, true);
  else timer = setTimeout(open, 0);
}

function bindCardWorkspace() {
  bindSidebarQuickTools();
  // 侧栏「记忆卡片」右侧悬停出现的「+」：新建卡片目录（design/prototype/sidebar-trailing-icons-20261111.md 方案 B）。
  const newFolder = applicationShell.config.$('#newCardFolderBtn');
  if (newFolder) newFolder.onclick = async () => { if (await application.editor.session.leaveActiveNoteEditor()) openCardOrganization('folder', '', null); };
  const menu = document.createElement('div');
  menu.id = 'cardDirectoryMenu';
  menu.className = 'card-directory-menu compact-context-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '卡片目录操作');
  document.body.append(menu);
  let menuTarget = null;
  let menuTrigger = null;
  let menuPointerDown = null;
  const closeMenu = () => { menu.hidePopover(); menuTrigger?.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('toggle', event => {
    if (event.newState === 'closed') menuTrigger?.setAttribute('aria-expanded', 'false');
  });
  window.addEventListener('resize', closeMenu);
  applicationShell.config.$('.shell > header > nav').addEventListener('scroll', closeMenu, { passive: true });
  const openMenu = (organize, point = null) => {
    const wasOpen = menu.matches(':popover-open') && menuTrigger === organize || menuPointerDown === organize;
    menuPointerDown = null;
    closeMenu();
    applicationShell.actions.closeTreeItemMenus();
    if (wasOpen && !point) return;
    menuTrigger = organize;
    menuTarget = { type: organize.dataset.cardOrganize, id: organize.dataset.organizeId };
    const atLimit = MemoKeepDirectoryTree.ancestors(applicationShell.state.persistence.data.cardFolders, menuTarget.id).length >= MemoKeepDirectoryTree.MAX_DEPTH;
    menu.setAttribute('aria-label', menuTarget.type === 'folder' ? '卡片目录操作' : '卡片笔记操作');
    const separator = '<div class="tree-menu-separator" role="separator"></div>';
    menu.innerHTML = (menuTarget.type === 'folder'
      ? `<button type="button" role="menuitem" data-card-menu-action="new"><svg aria-hidden="true"><use href="#icon-plus"></use></svg><span>新建卡片</span></button><button type="button" role="menuitem" data-card-menu-action="new-folder" ${atLimit ? 'disabled' : ''}><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>新建子目录${atLimit ? '<small>最多 5 层，已达上限</small>' : ''}</span></button>`
      : '<button type="button" role="menuitem" data-card-menu-action="open-window"><svg aria-hidden="true"><use href="#icon-arrow-up-right"></use></svg><span>在新窗口打开</span></button>')
      + separator
      + '<button type="button" role="menuitem" data-card-menu-action="rename"><svg aria-hidden="true"><use href="#icon-pencil"></use></svg><span>重命名</span></button>'
      + separator
      + `<button type="button" role="menuitem" class="danger" data-card-menu-action="delete"><svg aria-hidden="true"><use href="#icon-trash"></use></svg><span>${menuTarget.type === 'folder' ? '删除目录' : '删除卡片笔记'}</span></button>`;
    menu.showPopover();
    const rect = organize.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(point?.x ?? rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point?.y ?? rect.bottom + 5, window.innerHeight - menu.offsetHeight - 8))}px`;
    organize.setAttribute('aria-expanded', 'true');
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  applicationShell.config.$('#cardTree').oncontextmenu = event => {
    if (!applicationShell.state.persistence.applicationDataReady) return;
    const organize = event.target.closest('.card-tree-row')?.querySelector('[data-card-organize]');
    if (!organize) return;
    openSidebarContextMenu(event, () => openMenu(organize, { x: event.clientX, y: event.clientY }));
  };
  applicationShell.config.$('#cardTree').onpointerdown = event => {
    const organize = event.target.closest('[data-card-organize]');
    menuPointerDown = event.button === 0 && menu.matches(':popover-open') && menuTrigger === organize ? organize : null;
  };
  menu.onclick = async event => {
    if (event.target.closest('button')?.disabled) return;
    const action = event.target.closest('[data-card-menu-action]')?.dataset.cardMenuAction;
    if (!action || !menuTarget) return;
    const { type, id } = menuTarget;
    closeMenu();
    if (action === 'open-window' && type === 'notebook') { await applicationShell.actions.openNoteInNewWindow('cards', id); return; }
    if (!await application.editor.session.leaveActiveNoteEditor()) return;
    if (action === 'new') { application.cards.runtime.cardScope = { type:'folder', id }; createCardInWorkspace(); return; }
    if (action === 'new-folder') { openCardOrganization('folder', '', id); return; }
    if (action === 'rename') { openCardOrganization(type, id); return; }
    const collection = type === 'folder' ? applicationShell.state.persistence.data.cardFolders : applicationShell.state.persistence.data.cardNotebooks;
    const item = collection.find(item => item.id === id);
    if (!item) return;
    const confirmed = await applicationShell.actions.showConfirmDialog({
      title: `删除${type === 'folder' ? '目录' : '卡片笔记'}“${item.name}”？`,
      message: type === 'folder' ? '将删除此目录及全部子目录，其中的卡片笔记和卡片会一起移入回收站，可恢复内容和复习进度。' : '删除卡片笔记后，其中的卡片将移到“未分类”，来源和复习进度会保留。',
      confirmLabel: '删除'
    });
    if (!confirmed) return;
    if (type === 'folder') {
      await trashCardFolder(id);
      return;
    } else {
      applicationShell.state.persistence.data.cardNotebooks = applicationShell.state.persistence.data.cardNotebooks.filter(note => note.id !== id);
      applicationShell.state.persistence.data.cards.forEach(card => { if (card.cardNotebookId === id) card.cardNotebookId = null; });
    }
    application.cards.runtime.selectedCardIds.clear();
    await application.persistence.save();
    application.views.cards.render();
    applicationShell.actions.showToast(type === 'folder' ? '目录已删除，卡片笔记已移到根目录' : '卡片笔记已删除，卡片已移到未分类');
  };
  applicationShell.config.$('#cardOrganizationForm').onsubmit = async event => {
    event.preventDefault();
    const type = applicationShell.config.$('#cardOrganizationType').value;
    const name = applicationShell.config.$('#cardOrganizationName').value.trim();
    if (!name) return;
    const collection = type === 'folder' ? applicationShell.state.persistence.data.cardFolders : applicationShell.state.persistence.data.cardNotebooks;
    let item = collection.find(item => item.id === applicationShell.config.$('#cardOrganizationId').value);
    const isCreating = !item;
    const parentId = type === 'folder' ? (item?.parentId || applicationShell.config.$('#cardOrganizationParentId').value || null) : null;
    if (type === 'folder' && isCreating) {
      const error = MemoKeepDirectoryTree.creationError(collection, parentId);
      if (error) { applicationShell.actions.showToast(error, true); return; }
    }
    const folderId = type === 'notebook' ? applicationShell.config.$('#cardOrganizationFolder').value || null : null;
    if (folderId && !applicationShell.state.persistence.data.cardFolders.some(folder => folder.id === folderId)) { applicationShell.actions.showToast('所属目录已不存在，请重新选择', true); return; }
    if (collection.some(other => other.id !== item?.id && other.name === name && (type === 'folder' ? (other.parentId || null) === parentId : (other.folderId || null) === folderId))) { applicationShell.actions.showToast('同一目录下名称已存在', true); return; }
    if (!item) { item = { id: applicationShell.config.uid() }; collection.push(item); }
    Object.assign(item, { name, ...(type === 'notebook' ? { folderId } : { parentId }), updatedAt: new Date().toISOString() });
    const ownDocument = applicationShell.state.persistence.data.cardDocuments.find(doc => doc.id === item.sourceDocumentId);
    if (ownDocument) { ownDocument.title = name; ownDocument.updatedAt = new Date().toISOString(); }
    application.cards.runtime.cardScope = { type, id: item.id }; application.cards.runtime.selectedCardIds.clear();
    MemoKeepDirectoryTree.ancestors(applicationShell.state.persistence.data.cardFolders, type === 'folder' ? item.id : folderId).forEach(folder => application.cards.runtime.closedCardFolders.delete(folder.id));
    await application.persistence.save();
    applicationShell.config.$('#cardOrganizationDialog').close();
    if (isCreating) applicationShell.config.$('.card-nav-group').classList.remove('tree-collapsed');
    if (type === 'notebook') openCardNotebookView(item.id);
    else { applicationShell.actions.showView('cards'); application.views.cards.render(); }
  };
  applicationShell.config.$('#cardTree').onclick = async event => {
    const toggle = event.target.closest('[data-folder-toggle]');
    if (toggle) { const id = toggle.dataset.folderToggle; application.cards.runtime.closedCardFolders.has(id) ? application.cards.runtime.closedCardFolders.delete(id) : application.cards.runtime.closedCardFolders.add(id); renderCardWorkspace(); return; }
    const organize = event.target.closest('[data-card-organize]');
    if (organize) {
      openMenu(organize);
      return;
    }
    const button = event.target.closest('[data-card-scope]')
      || event.target.closest('.card-tree-row')?.querySelector('[data-card-scope]');
    if (!button) return;
    if (button.dataset.cardScope !== 'notebook' && !await application.editor.session.leaveActiveNoteEditor()) return;
    if (button.dataset.cardScope === 'folder') {
      const id = button.dataset.scopeId;
      application.cards.runtime.closedCardFolders.has(id) ? application.cards.runtime.closedCardFolders.delete(id) : application.cards.runtime.closedCardFolders.add(id);
    }
    application.cards.runtime.cardScope = { type: button.dataset.cardScope, id: button.dataset.scopeId };
    application.cards.runtime.activeCardFilter = 'all'; application.cards.runtime.activeCardLibraryFilter = 'all'; application.cards.runtime.selectedCardIds.clear(); applicationShell.config.$('#cardSearch').value = '';
    if (application.cards.runtime.cardScope.type === 'notebook') { openCardNotebookView(application.cards.runtime.cardScope.id); return; }
    applicationShell.actions.showView('cards'); application.views.cards.render();
  };
}

function cardTags(card) {
  return [...new Set((card.tags || []).map(tag => String(tag).trim()).filter(Boolean))];
}
function matchesCardTags(card) {
  const tags = cardTags(card);
  return !application.cards.runtime.selectedCardTags.size || (application.cards.runtime.cardTagMatchMode === 'all'
    ? [...application.cards.runtime.selectedCardTags].every(tag => tags.includes(tag))
    : [...application.cards.runtime.selectedCardTags].some(tag => tags.includes(tag)));
}
function renderCardTagFilters(scopedCards, resultCount = application.cards.runtime.cardTagResultCount) {
  application.cards.runtime.cardTagResultCount = resultCount;
  const counts = new Map();
  scopedCards.forEach(card => cardTags(card).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
  const query = applicationShell.config.$('#cardTagSearch').value.trim().toLowerCase();
  const tags = [...new Set([...counts.keys(), ...application.cards.runtime.selectedCardTags])].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b, 'zh-CN'));
  applicationShell.config.$('#cardTagOptions').innerHTML = tags.filter(tag => tag.toLowerCase().includes(query)).map(tag => `<label><input type="checkbox" data-filter-tag="${applicationShell.actions.escapeHtml(tag)}" ${application.cards.runtime.selectedCardTags.has(tag) ? 'checked' : ''}><span title="${applicationShell.actions.escapeHtml(tag)}">${applicationShell.actions.escapeHtml(tag)}</span><small>${counts.get(tag) || 0}</small></label>`).join('') || '<p>没有找到标签</p>';
  applicationShell.config.$('#cardTagFilterLabel').textContent = application.cards.runtime.selectedCardTags.size ? `标签 · ${application.cards.runtime.selectedCardTags.size}` : '全部标签';
  applicationShell.config.$('#cardTagFilter').classList.toggle('has-selection', application.cards.runtime.selectedCardTags.size > 0);
  applicationShell.config.$('#cardTagSelectedCount').textContent = `已选 ${application.cards.runtime.selectedCardTags.size} 个标签`;
  applicationShell.config.$('#cardTagModeHint').textContent = application.cards.runtime.cardTagMatchMode === 'all' ? '显示同时包含全部所选标签的卡片' : '显示包含任一所选标签的卡片';
  applicationShell.config.$$('[data-tag-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tagMode === application.cards.runtime.cardTagMatchMode)));
  applicationShell.config.$('#cardTagApplied').hidden = !application.cards.runtime.selectedCardTags.size;
  applicationShell.config.$('#cardTagApplied').innerHTML = [...application.cards.runtime.selectedCardTags].map(tag => `<span class="card-applied-chip">#${applicationShell.actions.escapeHtml(tag)}<button type="button" data-remove-filter-tag="${applicationShell.actions.escapeHtml(tag)}" aria-label="移除标签 ${applicationShell.actions.escapeHtml(tag)}"><svg aria-hidden="true"><use href="#icon-x"></use></svg></button></span>`).join('');
}
function bindCardTagFilters() {
  const close = () => { applicationShell.config.$('#cardTagFilter').open = false; };
  const focusTrigger = () => applicationShell.config.$('#cardTagFilter summary').focus({ preventScroll: true });
  applicationShell.config.$('#cardTagSearch').oninput = () => renderCardTagFilters(cardsInScope());
  applicationShell.config.$('#cardTagOptions').onchange = event => {
    const input = event.target.closest('[data-filter-tag]');
    if (!input) return;
    const tag = input.dataset.filterTag;
    if (input.checked) application.cards.runtime.selectedCardTags.add(tag); else application.cards.runtime.selectedCardTags.delete(tag);
    application.views.cards.render();
    applicationShell.config.$$('[data-filter-tag]').find(node => node.dataset.filterTag === tag)?.focus({ preventScroll: true });
  };
  applicationShell.config.$('#cardTagModes').onclick = event => {
    const button = event.target.closest('[data-tag-mode]');
    if (!button) return;
    application.cards.runtime.cardTagMatchMode = button.dataset.tagMode; application.views.cards.render();
  };
  const clear = () => { application.cards.runtime.selectedCardTags.clear(); application.views.cards.render(); };
  applicationShell.config.$('#cardTagClear').onclick = clear;
  applicationShell.config.$('#cardTagApplied').onclick = event => {
    const remove = event.target.closest('[data-remove-filter-tag]');
    if (remove) { application.cards.runtime.selectedCardTags.delete(remove.dataset.removeFilterTag); application.views.cards.render(); focusTrigger(); }
    else if (event.target.closest('[data-clear-filter-tags]')) { clear(); focusTrigger(); }
  };
  applicationShell.config.$('#cardTagDone').onclick = () => { close(); focusTrigger(); };
  applicationShell.config.$('#cardTagFilter').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); focusTrigger(); } };
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#cardTagFilter')) close(); });
}

function chooseCardImport() {
  const input=applicationShell.config.$('#cardImportInput');
  input.dataset.folderId = application.cards.runtime.cardScope.type==='folder' ? application.cards.runtime.cardScope.id : '';
  input.value=''; input.onchange=()=>void importCardFile(input.files[0],input.dataset.folderId || null); input.click();
}
async function importCardFile(file, folderId = null) {
  if(!file) return;
  try {
    if(file.size>10*1024*1024) throw new Error('CSV 不能超过 10 MB');
    const parsed=MemoKeepCardImport.parseCardCSV(await file.text());
    let additions;
    await application.persistence.transact(data => {
      if(folderId && !data.cardFolders.some(folder=>folder.id===folderId)) throw new Error('目标目录已不存在');
      const questions=new Set(data.cards.filter(card=>cardFolderId(card)===folderId).map(card=>card.question.trim()));
      additions=parsed.filter(card=>{if(questions.has(card.question))return false;questions.add(card.question);return true;});
      if(!additions.length) {applicationShell.actions.showToast('没有新增卡片，重复题目已跳过');return false;}
      data.cards.push(...additions.map(card=>applicationShell.actions.createCard({...card,cardFolderId:folderId})));
    });
    if (!additions.length) return;
    applicationShell.actions.renderAll();applicationShell.actions.showToast(`已导入 ${additions.length} 张卡片${parsed.length>additions.length?'，重复题目已跳过':''}`);
  } catch(error) {applicationShell.actions.showToast(`导入失败：${error.message}`,true);}
}
