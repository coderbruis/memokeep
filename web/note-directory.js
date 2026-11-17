// Directory controls share one result set; previews never mount saved note HTML.
const NOTE_DIRECTORY_PREFERENCE_KEY = 'memokeep-note-directory-v1';
const NOTE_DIRECTORY_PAGE_SIZE = 10;
const noteDirectorySearches = new Map();
const noteDirectoryFileTypes = new Map();
const noteDirectoryPreviewCache = new Map();
let noteDirectoryPreviewCacheSize = 0;
let noteDirectoryPage = 1;
let noteDirectoryLibraryId = null;
let disposeNoteDirectory = () => {};
let noteDirectoryMenuPointerDown = null;
let noteDirectoryPreference = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTE_DIRECTORY_PREFERENCE_KEY));
    return { view: saved?.view === 'list' ? 'list' : 'card', sort: ['recent', 'oldest', 'name'].includes(saved?.sort) ? saved.sort : 'recent' };
  } catch { return { view: 'card', sort: 'recent' }; }
})();

function noteDirectoryIcon(name) {
  const paths = {
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    more: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
    sort: '<path d="M8 4v16m-4-4 4 4 4-4M15 5h6m-6 5h4m-4 5h2"/>'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || `<use href="#icon-${name}"></use>`}</svg>`;
}

function noteDirectoryAttribute(value) {
  return applicationShell.actions.escapeHtml(value).replace(/"/g, '&quot;');
}

function noteDirectoryPreview(doc) {
  if (MemoKeepNoteFiles.isText(doc)) return { text: String(doc.content || '').replace(/\s+/g, ' ').trim(), heading: '', diagram: '' };
  const rich = doc.metadata?.noteContent;
  const source = doc.metadata?.editorMode === 'note' && typeof rich === 'string' && (rich || doc.metadata?.noteContentInitialized) ? rich : null;
  const cached = noteDirectoryPreviewCache.get(doc.id);
  if (cached?.source === source && cached?.content === doc.content && cached?.title === doc.title) {
    noteDirectoryPreviewCache.delete(doc.id); noteDirectoryPreviewCache.set(doc.id, cached);
    return cached.preview;
  }
  const template = document.createElement('template');
  template.innerHTML = source === null ? applicationShell.actions.markdownToRichHtml(String(doc.content || '')) : source;
  const fragment = template.content;
  fragment.querySelectorAll('script,style,iframe,object,svg,template').forEach(node => node.remove());
  const diagrams = [];
  for (const block of fragment.querySelectorAll('.ql-code-block-container,pre')) {
    const value = block.matches('pre') ? (isDiagramCodeBlock(block) ? block.textContent : null)
      : richEditorDiagramSources({ querySelectorAll: () => [block] })[0];
    if (value != null) { diagrams.push(value); block.remove(); }
  }
  fragment.querySelectorAll('img').forEach(node => node.replaceWith(document.createTextNode(node.alt || '图片')));
  fragment.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode(' ')));
  fragment.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,tr').forEach(node => node.append(document.createTextNode(' ')));
  fragment.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(node => { if (node.textContent.trim() === doc.title) node.remove(); });
  const headingNode = fragment.querySelector('h1,h2,h3,h4,h5,h6');
  const heading = headingNode?.textContent.trim() || '';
  headingNode?.remove();
  // 摘要里不露出要点标记和 Markdown 符号（[!要点]、**加粗**、`代码`）。
  const text = (fragment.textContent || '').replace(/\[!(?:要点|summary)\]/gi, ' ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const preview = { text, heading, diagram: diagrams[0] || '' };
  const size = (source?.length || 0) + String(doc.content || '').length + text.length + heading.length + (preview.diagram?.length || 0);
  if (cached) { noteDirectoryPreviewCache.delete(doc.id); noteDirectoryPreviewCacheSize -= cached.size; }
  if (size <= 2_000_000) {
    noteDirectoryPreviewCache.set(doc.id, { source, content: doc.content, title: doc.title, preview, size });
    noteDirectoryPreviewCacheSize += size;
    while (noteDirectoryPreviewCache.size > 128 || noteDirectoryPreviewCacheSize > 2_000_000) {
      const first = noteDirectoryPreviewCache.keys().next().value;
      noteDirectoryPreviewCacheSize -= noteDirectoryPreviewCache.get(first).size;
      noteDirectoryPreviewCache.delete(first);
    }
  }
  return preview;
}

function noteDirectoryTimestamp(doc) {
  return Date.parse(doc.updatedAt || doc.createdAt) || 0;
}

function compareNoteDirectoryDocuments(a, b) {
  const sort = noteDirectoryPreference.sort;
  return sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true })
    : (noteDirectoryTimestamp(a) - noteDirectoryTimestamp(b)) * (sort === 'oldest' ? 1 : -1);
}

function renderNoteDirectoryPagination(page, pageCount, prefix = 'note-directory', resultsId = 'noteDirectoryResults') {
  const pages = pageCount <= 7 ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : [...new Set([1, ...Array.from({ length: 5 }, (_, index) => Math.min(Math.max(page - 2, 2), pageCount - 5) + index), pageCount])];
  const button = (target, label, action, disabled = false) => `<button type="button" data-${prefix}-page="${target}" data-${prefix}-page-action="${action}" aria-controls="${resultsId}"${disabled ? ' disabled' : ''}${action.startsWith('page-') ? ` aria-label="第 ${target} 页"${target === page ? ' aria-current="page"' : ''}` : ''}>${label}</button>`;
  return button(page - 1, '上一页', 'previous', page === 1)
    + pages.map((target, index) => `${index && target - pages[index - 1] > 1 ? '<span class="note-directory-page-gap" aria-hidden="true">…</span>' : ''}${button(target, target, `page-${target}`)}`).join('')
    + button(page + 1, '下一页', 'next', page === pageCount);
}

function renderNoteDirectory(library, docs, items, structuredItems) {
  const libraryId = noteDirectoryAttribute(library.id);
  const fileTypes = new Map(Object.values(MemoKeepNoteFiles.types).map(type => [type.id, type]));
  docs.forEach(doc => { const type = MemoKeepNoteFiles.of(doc); fileTypes.set(type.id, type); });
  const childError = library.noteTagScope ? '' : MemoKeepDirectoryTree.creationError(applicationShell.state.persistence.data.knowledgeBases, library.id);
  return `${library.noteTagScope ? `<nav class="note-tag-breadcrumb" aria-label="当前位置"><button type="button" data-note-tag-home>标签</button><span aria-hidden="true">/</span><span aria-current="page">${applicationShell.actions.escapeHtml(library.name)}</span></nav>` : ''}<header class="note-directory-heading">
    <div class="note-directory-heading-copy"><div class="note-directory-title">${library.noteTagScope ? noteDirectoryIcon('tag') : ''}<h2>${applicationShell.actions.escapeHtml(library.name)}</h2><span class="badge">${applicationShell.actions.escapeHtml(library.noteTagScope ? `${docs.length} 篇笔记` : applicationShell.config.typeLabels[library.type] || '通用')}</span></div>
    </div>
    <div class="note-directory-header-actions"><button type="button" class="note-directory-more" data-note-directory-menu="library" aria-label="目录操作" aria-haspopup="menu" aria-expanded="false">${noteDirectoryIcon('more')}</button></div>
  </header>
  <section class="note-directory" data-note-directory-library="${libraryId}" aria-label="笔记目录">
    <div class="note-directory-toolbar">
      <div class="note-directory-controls"><label class="note-directory-search">${noteDirectoryIcon('search')}<input id="noteDirectorySearch" type="search" aria-label="搜索当前目录" placeholder="搜索当前目录" value="${noteDirectoryAttribute(noteDirectorySearches.get(library.id) || '')}"></label>
        <label class="note-directory-sort">${noteDirectoryIcon('sort')}<select id="noteDirectorySort" aria-label="笔记排序"><option value="recent">最近更新</option><option value="name">按名称排序</option><option value="oldest">最早更新</option></select></label>
        <label class="note-directory-file-type"><select id="noteDirectoryFileType" aria-label="文件类型筛选"><option value="all">全部类型</option>${[...fileTypes.values()].map(type => `<option value="${noteDirectoryAttribute(type.id)}">${applicationShell.actions.escapeHtml(type.label)}</option>`).join('')}</select></label>
        <div class="note-directory-view-switch" role="group" aria-label="目录视图"><button type="button" data-note-directory-view="list" aria-pressed="${noteDirectoryPreference.view === 'list'}">${noteDirectoryIcon('list')}列表</button><button type="button" data-note-directory-view="card" aria-pressed="${noteDirectoryPreference.view === 'card'}">${noteDirectoryIcon('grid')}卡片</button></div>
      </div>
    </div>
    <h3 class="note-directory-results-heading">${library.noteTagScope ? '关联笔记' : '全部笔记'} <span id="noteDirectoryCount" class="note-directory-count">${docs.length}</span></h3>
    <div class="note-directory-scroll" tabindex="0" role="region" aria-label="笔记内容"><div id="noteDirectoryResults"></div>${structuredItems}</div>
    <footer class="note-directory-footer"><p id="noteDirectoryStatus" class="note-directory-status" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="note-directory-footer-controls"><span class="note-directory-page-size">每页 ${NOTE_DIRECTORY_PAGE_SIZE} 篇</span><nav id="noteDirectoryPagination" class="note-directory-pagination" aria-label="笔记分页"></nav></div>
    </footer>
  </section>
  <div id="noteDirectoryLibraryMenu" class="note-directory-menu" popover="auto" role="menu" aria-label="目录操作">${library.noteTagScope ? renderNoteTagDirectoryMenu(library.tagId) : `<button type="button" data-edit-library="${libraryId}" role="menuitem">${noteDirectoryIcon('pencil')}编辑知识库</button><button type="button" data-new-library-child="${libraryId}" role="menuitem"${childError ? ` disabled title="${noteDirectoryAttribute(childError)}"` : ''}>${noteDirectoryIcon('folder')}新建子目录</button><button type="button" class="danger" data-delete-library="${libraryId}" role="menuitem">${noteDirectoryIcon('trash')}删除知识库</button>`}</div>
  <div id="noteDirectoryDocumentMenu" class="note-directory-menu document-actions" popover="auto" role="menu" aria-label="笔记操作"></div>`;
}

// 一篇笔记有几张卡片：从笔记里做的、选区制卡、导入的、加入复习的要点都算（不只是 inlineCardCount）。
let noteDirectoryCardCountCache = { cards: null, items: null, notebooks: null, counts: new Map() };
function noteDirectoryCardCount(doc) {
  const data = applicationShell.state.persistence.data || {};
  const cache = noteDirectoryCardCountCache;
  if (cache.cards !== data.cards || cache.items !== data.items || cache.notebooks !== data.cardNotebooks || cache.length !== data.cards?.length) {
    const itemDocument = new Map((data.items || []).map(item => [item.id, item.documentId]));
    const notebookDocument = new Map((data.cardNotebooks || []).map(note => [note.id, note.sourceDocumentId]));
    const counts = new Map();
    for (const card of data.cards || []) {
      if (card.deletedAt) continue;
      const id = card.cardType === 'point' ? card.pointDocumentId : itemDocument.get(card.knowledgeItemId) || notebookDocument.get(card.cardNotebookId);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    noteDirectoryCardCountCache = { cards: data.cards, items: data.items, notebooks: data.cardNotebooks, length: data.cards?.length, counts };
  }
  return Math.max(noteDirectoryCardCountCache.counts.get(doc.id) || 0, Number(doc.metadata?.inlineCardCount) || 0);
}

function renderNoteDirectoryCard(doc, libraryName) {
  const id = noteDirectoryAttribute(doc.id), title = noteDirectoryAttribute(doc.title);
  const preview = noteDirectoryPreview(doc);
  const summary = [preview.heading, preview.text].filter(Boolean).join(' · ')
    || (preview.diagram ? '包含图表' : '暂无正文');
  const timestamp = noteDirectoryTimestamp(doc);
  const date = timestamp ? applicationShell.actions.formatDate(timestamp) : '未记录时间';
  const count = noteDirectoryCardCount(doc);
  return `<article class="document-row note-directory-card${libraryName ? ' note-tag-note-row' : ''}" data-document-row="${id}" data-open-document-row="${id}" role="button" tabindex="0" aria-label="打开笔记：${title}">
    <div class="note-directory-card-top"><span class="note-directory-card-kind"><span class="note-directory-card-icon">${noteFileIcon(doc)}</span>${applicationShell.actions.escapeHtml(MemoKeepNoteFiles.of(doc).label)}</span><div class="document-actions"><button type="button" class="note-directory-more" data-note-directory-menu="${id}" aria-label="${title}的更多操作" aria-haspopup="menu" aria-expanded="false">${noteDirectoryIcon('more')}</button></div></div>
    <div class="document-summary"><div class="note-file-title-row"><h3 title="${title}">${title}</h3></div></div>
    <div class="note-directory-preview"><p>${applicationShell.actions.escapeHtml(summary)}</p></div>
    <div class="note-directory-card-meta">${libraryName ? `<span class="note-tag-note-source" title="${noteDirectoryAttribute(libraryName)}">${noteDirectoryIcon('folder')}<span>${applicationShell.actions.escapeHtml(libraryName)}</span></span>` : ''}${renderDocumentNoteTags(doc, 2)}</div>
    <footer class="note-directory-card-footer"><time${timestamp ? ` datetime="${new Date(timestamp).toISOString()}"` : ''}>${timestamp ? '更新于 ' : ''}${date}</time><span class="note-directory-card-memory">${noteDirectoryIcon('layers')}${count} 张卡片</span><span class="note-directory-card-open" aria-hidden="true">${noteDirectoryIcon('arrow-right')}</span></footer>
  </article>`;
}

function renderDocumentList(documents, library) {
  if (library?.noteTagScope) return renderTaggedNoteList(documents);
  const cards = noteDirectoryPreference.view === 'card';
  if (cards) return `<div class="document-list note-directory-grid">${documents.map(doc => renderNoteDirectoryCard(doc)).join('')}</div>`;
  const rows = documents.map(doc => {
    const id = noteDirectoryAttribute(doc.id), title = noteDirectoryAttribute(doc.title);
    const size = applicationShell.actions.formatBytes(doc.metadata?.size ?? new TextEncoder().encode(String(doc.content || '')).length);
    const count = noteDirectoryCardCount(doc);
    const timestamp = noteDirectoryTimestamp(doc);
    const date = timestamp ? applicationShell.actions.formatDate(timestamp) : '未记录时间';
    const more = `<div class="document-actions"><button type="button" class="note-directory-more" data-note-directory-menu="${id}" aria-label="${title}的更多操作" aria-haspopup="menu" aria-expanded="false">${noteDirectoryIcon('more')}</button></div>`;
    return `<article class="document-row" data-document-row="${id}" data-open-document-row="${id}" role="button" tabindex="0" aria-label="打开笔记：${title}">
      <span class="doc-icon" aria-hidden="true">${noteFileIcon(doc)}</span>
      <div class="document-summary"><div class="note-file-title-row"><h3 title="${title}">${title}</h3></div><p>${applicationShell.actions.escapeHtml(MemoKeepNoteFiles.of(doc).label)}</p>${renderDocumentNoteTags(doc)}</div>
      <span class="note-directory-cell note-directory-size">${size}</span><span class="note-directory-cell note-directory-card-count">${noteDirectoryIcon('layers')}${count} 张</span><time class="note-directory-cell">${date}</time>${more}
    </article>`;
  }).join('');
  return `<div class="note-directory-list-heading" aria-hidden="true"><span>笔记名称</span><span class="note-directory-size">文件大小</span><span class="note-directory-card-count">记忆卡片</span><span>更新时间</span><span></span></div><div class="document-list note-directory-list">${rows}</div>`;
}

function mountNoteDirectory(library, docs) {
  const root = applicationShell.config.$('#libraryContent');
  let assetWarmup = null;
  if (docs.some(doc => !MemoKeepNoteFiles.isText(doc)) && !window.Quill && typeof requestIdleCallback === 'function') {
    assetWarmup = requestIdleCallback(() => {
      assetWarmup = null;
      // Warm local scripts while browsing; a failed prefetch can retry on open.
      void applicationShell.actions.loadNoteEditorAssets().catch(() => {});
    }, { timeout: 500 });
  }
  if (noteDirectoryLibraryId !== library.id) {
    noteDirectoryLibraryId = library.id;
    noteDirectoryPage = 1;
  }
  const rememberMenuPointerDown = event => {
    const trigger = event.target.closest('[data-note-directory-menu]');
    noteDirectoryMenuPointerDown = trigger ? { trigger, open: trigger.getAttribute('aria-expanded') === 'true' } : null;
  };
  root.addEventListener('pointerdown', rememberMenuPointerDown, true);
  let searchFrame = null;
  let resultKey, resultDocuments;
  const update = () => {
    root.querySelectorAll('.note-directory-menu:popover-open').forEach(menu => menu.hidePopover());
    root.querySelectorAll('[data-note-directory-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    const query = (noteDirectorySearches.get(library.id) || '').trim().toLocaleLowerCase();
    const { view, sort } = noteDirectoryPreference;
    const fileType = noteDirectoryFileTypes.get(library.id) || 'all';
    const key = JSON.stringify([query, sort, fileType]);
    if (key !== resultKey) {
      const filtered = docs.filter(doc => {
        if (fileType !== 'all' && MemoKeepNoteFiles.of(doc).id !== fileType) return false;
        if (!query) return true;
        const preview = noteDirectoryPreview(doc);
        return `${doc.title} ${preview.heading} ${preview.text} ${documentNoteTags(doc).map(tag => tag.name).join(' ')}`.toLocaleLowerCase().includes(query);
      });
      filtered.sort(compareNoteDirectoryDocuments);
      resultDocuments = filtered; resultKey = key;
    }
    const filtered = resultDocuments;
    const pageCount = Math.max(1, Math.ceil(filtered.length / NOTE_DIRECTORY_PAGE_SIZE));
    noteDirectoryPage = Math.min(Math.max(noteDirectoryPage, 1), pageCount);
    const offset = (noteDirectoryPage - 1) * NOTE_DIRECTORY_PAGE_SIZE;
    const pageDocuments = filtered.slice(offset, offset + NOTE_DIRECTORY_PAGE_SIZE);
    applicationShell.config.$('#noteDirectoryCount').textContent = filtered.length;
    root.querySelectorAll('[data-note-directory-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.noteDirectoryView === view)));
    applicationShell.config.$('#noteDirectoryResults').innerHTML = filtered.length ? renderDocumentList(pageDocuments, library)
      : `<div class="note-directory-empty">${noteDirectoryIcon(query ? 'search' : 'file-text')}<h3>${query ? '没有找到相关笔记' : library.noteTagScope ? '还没有关联笔记' : '还没有笔记'}</h3><button type="button" class="${query ? 'secondary' : 'primary'}" data-note-directory-empty="${query ? 'clear' : !applicationShell.state.persistence.data.knowledgeBases.length ? 'library' : 'new'}">${query ? '清空搜索' : !applicationShell.state.persistence.data.knowledgeBases.length ? '新建知识库' : '新建笔记'}</button></div>`;
    const total = query ? `找到 ${filtered.length} 篇笔记（共 ${docs.length} 篇）` : `共 ${docs.length} 篇笔记`;
    applicationShell.config.$('#noteDirectoryStatus').textContent = `${total}${filtered.length ? ` · 当前 ${offset + 1}–${offset + pageDocuments.length} 篇` : ''}`;
    applicationShell.config.$('#noteDirectoryPagination').innerHTML = renderNoteDirectoryPagination(noteDirectoryPage, pageCount);
    root.querySelector('.note-directory-scroll').scrollTop = 0;
  };
  applicationShell.config.$('#noteDirectoryFileType').value = noteDirectoryFileTypes.get(library.id) || 'all';
  applicationShell.config.$('#noteDirectoryFileType').onchange = event => { noteDirectoryFileTypes.set(library.id, event.target.value); noteDirectoryPage = 1; update(); };
  applicationShell.config.$('#noteDirectorySort').value = noteDirectoryPreference.sort;
  applicationShell.config.$('#noteDirectorySearch').oninput = event => {
    noteDirectorySearches.set(library.id, event.target.value); noteDirectoryPage = 1;
    if (searchFrame !== null) cancelAnimationFrame(searchFrame);
    searchFrame = requestAnimationFrame(() => { searchFrame = null; update(); });
  };
  applicationShell.config.$('#noteDirectorySearch').onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.target.value = ''; noteDirectorySearches.set(library.id, ''); noteDirectoryPage = 1; update(); }
  };
  applicationShell.config.$('#noteDirectorySort').onchange = event => { noteDirectoryPreference.sort = event.target.value; noteDirectoryPage = 1; persist(); update(); };
  applicationShell.config.$('#noteDirectoryPagination').onclick = event => {
    const button = event.target.closest('[data-note-directory-page]');
    if (!button || button.disabled || Number(button.dataset.noteDirectoryPage) === noteDirectoryPage) return;
    const action = button.dataset.noteDirectoryPageAction;
    noteDirectoryPage = Number(button.dataset.noteDirectoryPage);
    update();
    const nextFocus = root.querySelector(`[data-note-directory-page-action="${action}"]:not(:disabled)`)
      || root.querySelector('#noteDirectoryPagination [aria-current="page"]');
    nextFocus?.focus({ preventScroll: true });
  };
  root.querySelectorAll('[data-note-directory-view]').forEach(button => {
    button.onclick = () => { noteDirectoryPreference.view = button.dataset.noteDirectoryView; persist(); update(); };
  });
  root.querySelectorAll('.note-directory-menu').forEach(menu => menu.addEventListener('toggle', event => {
    if (event.newState !== 'closed' || !menu.isConnected) return;
    const trigger = [...root.querySelectorAll('[data-note-directory-menu]')].find(button => button.dataset.noteDirectoryMenu === menu.dataset.noteDirectoryTrigger);
    trigger?.setAttribute('aria-expanded', 'false');
    if (document.activeElement === document.body || menu.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
  }));
  root.querySelectorAll('.note-directory-menu').forEach(menu => {
    menu.onkeydown = event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    };
  });
  function persist() {
    try { localStorage.setItem(NOTE_DIRECTORY_PREFERENCE_KEY, JSON.stringify(noteDirectoryPreference)); } catch { /* The current view still works when storage is unavailable. */ }
  }
  update();
  disposeNoteDirectory = () => {
    if (assetWarmup !== null) cancelIdleCallback(assetWarmup);
    if (searchFrame !== null) cancelAnimationFrame(searchFrame);
    root.removeEventListener('pointerdown', rememberMenuPointerDown, true);
    noteDirectoryMenuPointerDown = null;
    disposeNoteDirectory = () => {};
  };
}

async function openDocumentKnowledgeDirectory(documentId) {
  if (!await application.editor.session.leaveActiveNoteEditor()) return;
  const doc = applicationShell.actions.documentById(documentId);
  const library = application.state.knowledge.libraryById(doc?.knowledgeBaseId);
  if (!doc || !library) { applicationShell.actions.showToast('原知识库目录已不存在', true); return; }
  selectedNoteTagId = null;
  applicationShell.state.knowledge.selectedLibraryId = library.id;
  applicationShell.state.knowledge.knowledgeTreeCollapsed = false;
  MemoKeepDirectoryTree.ancestors(applicationShell.state.persistence.data.knowledgeBases, library.id).forEach(parent => applicationShell.state.knowledge.collapsedLibraryIds.delete(parent.id));
  applicationShell.actions.saveCollapsedLibraryIds();
  noteDirectorySearches.delete(library.id);
  const docs = applicationShell.state.persistence.data.documents.filter(item => item.knowledgeBaseId === library.id).sort(compareNoteDirectoryDocuments);
  noteDirectoryLibraryId = library.id;
  noteDirectoryPage = Math.floor(docs.findIndex(item => item.id === documentId) / NOTE_DIRECTORY_PAGE_SIZE) + 1;
  applicationShell.actions.showView('libraries');
  applicationShell.actions.renderSidebarKnowledgeTree();
  [...applicationShell.config.$('#knowledgeTree').querySelectorAll('[data-tree-library]')].find(button => button.dataset.treeLibrary === library.id)?.scrollIntoView({ block: 'nearest' });
  applicationShell.config.$('#librariesView').scrollTop = 0;
  const row = [...applicationShell.config.$('#noteDirectoryResults').querySelectorAll('[data-document-row]')].find(item => item.dataset.documentRow === documentId);
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus({ preventScroll: true });
}

function handleNoteDirectoryClick(event) {
  if (handleNoteTagDirectoryClick(event)) return true;
  if (selectedNoteTagId && event.target.closest('[data-delete-document], [data-rename-document]')) return true;
  const sourceButton = event.target.closest('[data-document-knowledge-directory]');
  if (sourceButton) {
    sourceButton.closest('[popover]')?.hidePopover();
    void openDocumentKnowledgeDirectory(sourceButton.dataset.documentKnowledgeDirectory);
    return true;
  }
  const trigger = event.target.closest('[data-note-directory-menu]');
  if (trigger) {
    const libraryMenu = trigger.dataset.noteDirectoryMenu === 'library';
    const menu = applicationShell.config.$(libraryMenu ? '#noteDirectoryLibraryMenu' : '#noteDirectoryDocumentMenu');
    const wasOpen = menu.matches(':popover-open') && trigger.getAttribute('aria-expanded') === 'true'
      || noteDirectoryMenuPointerDown?.trigger === trigger && noteDirectoryMenuPointerDown.open;
    noteDirectoryMenuPointerDown = null;
    applicationShell.config.$('#libraryContent').querySelectorAll('.note-directory-menu:popover-open').forEach(open => open.hidePopover());
    applicationShell.config.$('#libraryContent').querySelectorAll('[data-note-directory-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return true;
    if (!libraryMenu) {
      const id = noteDirectoryAttribute(trigger.dataset.noteDirectoryMenu);
      const actions = selectedNoteTagId
        ? `<button type="button" data-document-knowledge-directory="${id}" role="menuitem">${noteDirectoryIcon('folder')}前往知识库目录</button>`
        : `<button type="button" data-rename-document="${id}" role="menuitem">${noteDirectoryIcon('pencil')}重命名</button><button type="button" class="danger" data-delete-document="${id}" role="menuitem">${noteDirectoryIcon('trash')}删除笔记</button>`;
      menu.innerHTML = `<button type="button" data-open-document-row="${id}" role="menuitem">${noteDirectoryIcon('file-text')}打开笔记</button>${actions}`;
    }
    menu.dataset.noteDirectoryTrigger = trigger.dataset.noteDirectoryMenu;
    menu.showPopover();
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 5))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus({ preventScroll: true });
    return true;
  }
  if (event.target.closest('.note-directory-menu')) event.target.closest('.note-directory-menu').hidePopover();
  const editLibraryId = event.target.closest('[data-edit-library]')?.dataset.editLibrary;
  if (editLibraryId) { openLibrarySettings(editLibraryId); return true; }
  const childLibraryButton = event.target.closest('[data-new-library-child]');
  if (childLibraryButton) { if (!childLibraryButton.disabled) applicationShell.actions.openLibraryDialog(childLibraryButton.dataset.newLibraryChild); return true; }
  const emptyAction = event.target.closest('[data-note-directory-empty]')?.dataset.noteDirectoryEmpty;
  if (emptyAction === 'library') { applicationShell.actions.openLibraryDialog(); return true; }
  if (emptyAction === 'new') { applicationShell.config.$('#newNoteBtn').click(); return true; }
  if (emptyAction === 'clear') {
    const input = applicationShell.config.$('#noteDirectorySearch'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); return true;
  }
  return Boolean(event.target.closest('[data-note-directory-view], .document-rename-input'));
}
