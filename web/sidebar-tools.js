function updateSidebarDirectoryToggle() {
  const button = applicationShell.config.$('#toggleAllKnowledgeDirectories');
  if (!button) return;
  const anyExpanded = (!applicationShell.state.knowledge.knowledgeTreeCollapsed && applicationShell.state.persistence.data.knowledgeBases.some(item => !applicationShell.state.knowledge.collapsedLibraryIds.has(item.id)))
    || (!applicationShell.config.$('.card-nav-group')?.classList.contains('tree-collapsed') && applicationShell.state.persistence.data.cardFolders.some(item => !application.cards.runtime.closedCardFolders.has(item.id)));
  button.dataset.action = anyExpanded ? 'collapse' : 'expand';
  button.setAttribute('aria-label', anyExpanded ? '收起全部目录' : '展开全部目录');
  button.disabled = !applicationShell.state.persistence.data.knowledgeBases.length && !applicationShell.state.persistence.data.cardFolders.length;
  button.querySelector('path').setAttribute('d', anyExpanded ? 'm8 4 4 4 4-4M8 20l4-4 4 4' : 'm8 8 4-4 4 4M8 16l4 4 4-4');
}

function bindSidebarQuickTools() {
  // Search lives in the ⌘K workspace search; the sidebar only keeps create and folder tools.
  const add = applicationShell.config.$('#sidebarQuickCreate'), folder = applicationShell.config.$('#sidebarQuickFolder');
  let createTrigger = add;
  applicationShell.config.$('#toggleAllKnowledgeDirectories').onclick = () => {
    const expand = applicationShell.config.$('#toggleAllKnowledgeDirectories').dataset.action === 'expand';
    applicationShell.state.persistence.data.knowledgeBases.forEach(item => expand ? applicationShell.state.knowledge.collapsedLibraryIds.delete(item.id) : applicationShell.state.knowledge.collapsedLibraryIds.add(item.id));
    applicationShell.state.persistence.data.cardFolders.forEach(item => expand ? application.cards.runtime.closedCardFolders.delete(item.id) : application.cards.runtime.closedCardFolders.add(item.id));
    applicationShell.state.knowledge.knowledgeTreeCollapsed = false;
    applicationShell.config.$('.card-nav-group').classList.remove('tree-collapsed');
    localStorage.setItem('memokeep-knowledge-tree-collapsed', 'false');
    applicationShell.actions.saveCollapsedLibraryIds();
    applicationShell.actions.renderSidebarKnowledgeTree(); renderCardWorkspace();
  };
  const create = document.createElement('div');
  create.className = 'sidebar-global-create';
  create.id = 'sidebarGlobalCreate';
  add.setAttribute('aria-controls', create.id);
  create.setAttribute('popover', 'auto'); create.setAttribute('role', 'menu');
  create.setAttribute('aria-label', '新增目录或笔记');
  create.innerHTML = `<div class="sidebar-create-title">新建内容</div>${['knowledge', 'cards'].map(kind => {
    const knowledge = kind === 'knowledge';
    return `<section role="group" aria-label="${knowledge ? '知识库' : '记忆卡片'}"><p>${knowledge ? '知识库' : '记忆卡片'}</p>
      <button type="button" role="menuitem" data-new-kind="${kind}" data-new-type="note" aria-label="新建${knowledge ? '知识库笔记' : '卡片笔记'}"><svg aria-hidden="true"><use href="#icon-${knowledge ? 'file-plus-2' : 'layers'}"></use></svg><span class="sidebar-create-copy"><strong>${knowledge ? '文件' : '卡片笔记'}</strong><small>${knowledge ? '记录想法，整理知识' : '收纳卡片，安排复习'}</small></span></button>
      <button type="button" role="menuitem" data-new-kind="${kind}" data-new-type="folder" aria-label="新建${knowledge ? '知识库' : '卡片'}目录"><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span class="sidebar-create-copy"><strong>目录</strong></span></button></section>`;
  }).join('')}<div class="sidebar-create-footer"><button type="button" role="menuitem" data-new-kind="knowledge" data-new-type="import"><svg aria-hidden="true"><use href="#icon-file-import"></use></svg><span class="sidebar-create-copy"><strong>导入笔记</strong></span><span class="sidebar-create-format">MD / TXT</span></button></div>`;
  document.body.append(create);
  const place = (panel, anchor, right = false) => {
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(right ? rect.right - panel.offsetWidth : rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 7, window.innerHeight - panel.offsetHeight - 8))}px`;
  };
  const openCreate = (trigger, type) => {
    if (create.matches(':popover-open') && createTrigger === trigger) { create.hidePopover(); return; }
    createTrigger = trigger;
    create.querySelector('.sidebar-create-title').textContent = type === 'note' ? '新建笔记' : '新建目录';
    create.querySelectorAll('[data-new-type]').forEach(button => { button.hidden = button.dataset.newType !== type && !(type === 'note' && button.dataset.newType === 'import'); });
    create.querySelector('.sidebar-create-footer').hidden = type !== 'note';
    create.showPopover(); place(create, trigger, true); create.querySelector('button:not([hidden])').focus({preventScroll:true});
    add.setAttribute('aria-expanded', String(trigger === add)); folder.setAttribute('aria-expanded', String(trigger === folder));
  };
  add.onclick = () => openCreate(add, 'note');
  folder.onclick = () => openCreate(folder, 'folder');
  folder.setAttribute('aria-controls', create.id);
  create.addEventListener('toggle', event => { if(event.newState === 'closed') [add,folder].forEach(button => button.setAttribute('aria-expanded','false')); });
  create.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault(); create.hidePopover(); createTrigger.focus(); return;
    }
    const buttons = [...create.querySelectorAll('[role="menuitem"]:not([hidden])')];
    const index = buttons.indexOf(document.activeElement);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  window.addEventListener('resize', () => {
    if (create.matches(':popover-open')) {
      if (!createTrigger.getClientRects().length) create.hidePopover();
      else place(create, createTrigger, true);
    }
  });
  create.onclick = async event => {
    const button = event.target.closest('[data-new-kind]');
    if (!button) return;
    create.hidePopover();
    if (button.dataset.newType === 'import') {
      applicationShell.actions.openMarkdownImport();
      return;
    }
    if (!await application.editor.session.leaveActiveNoteEditor()) return;
    if (button.dataset.newKind === 'knowledge') {
      if (button.dataset.newType === 'folder') applicationShell.actions.openLibraryDialog();
      else if (application.state.knowledge.libraryById(applicationShell.state.knowledge.selectedLibraryId)) requestNewNoteFile({ kind: 'knowledge', libraryId: applicationShell.state.knowledge.selectedLibraryId });
      else { applicationShell.actions.showToast('请先创建知识库目录，再新建笔记', true); applicationShell.actions.openLibraryDialog(); }
    } else {
      const note = applicationShell.state.persistence.data.cardNotebooks.find(note => application.cards.runtime.cardScope.type === 'notebook' && note.id === application.cards.runtime.cardScope.id);
      openCardOrganization(button.dataset.newType === 'folder' ? 'folder' : 'notebook', '', button.dataset.newType === 'folder' ? null : note?.folderId || null);
    }
  };
  window.addEventListener('resize', () => { create.hidePopover(); });
}
