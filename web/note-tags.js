// Note tags use stable IDs and stay separate from memory-card and memo tags.
let selectedNoteTagId = null;
let noteTagTreeExpanded = false;
const expandedNoteTagIds = new Set();
let noteTagDialogTarget = null;
let noteTagCreated = null;
let noteTagOperationPending = false;
const NOTE_TAG_PAGE_SIZE = 10;
let noteTagHomePage = 1;
let noteTagHomeSearch = '';
let noteTagHomeSort = 'recent';

function normalizeNoteTags(tags) {
  const ids = new Set(), names = new Set();
  const normalized = (Array.isArray(tags) ? tags : []).filter(tag => {
    if (!tag || typeof tag.id !== 'string' || typeof tag.name !== 'string') return false;
    const name = tag.name.trim().toLocaleLowerCase();
    if (!name || ids.has(tag.id) || names.has(name)) return false;
    ids.add(tag.id); names.add(name); return true;
  }).map(tag => ({ ...tag, name: tag.name.trim().slice(0, 40) }));
  const byId = new Map(normalized.map(tag => [tag.id, tag]));
  normalized.forEach(tag => {
    if (!tag.parentId) return;
    const seen = new Set([tag.id]); let parent = byId.get(tag.parentId);
    if (!parent) { delete tag.parentId; return; }
    while (parent) { if (seen.has(parent.id)) { delete tag.parentId; break; } seen.add(parent.id); parent = byId.get(parent.parentId); }
  });
  return normalized;
}
function noteTagAncestorIds(id) {
  const result = [], seen = new Set(), lookup = noteTagsById();
  for (let tag = lookup.get(id)?.tag; tag && !seen.has(tag.id); tag = lookup.get(tag.parentId)?.tag) { seen.add(tag.id); result.unshift(tag.id); }
  return result;
}
function noteTagDescendantIds(id) {
  const ids = new Set([id]), tags = applicationShell.state.persistence.data.noteTags;
  for (let pass = 0; pass < tags.length; pass++) { let changed = false; for (const tag of tags) if (tag.parentId && ids.has(tag.parentId) && !ids.has(tag.id)) { ids.add(tag.id); changed = true; } if (!changed) break; }
  return ids;
}
function noteTagPath(id) { const lookup = noteTagsById(); return noteTagAncestorIds(id).map(value => lookup.get(value).tag.name).join(' / '); }


function normalizeNoteTagIds(ids) {
  return [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])];
}

function noteTagById(id) { return applicationShell.state.persistence.data.noteTags.find(tag => tag.id === id); }
let noteTagLookupSource, noteTagLookupSize = -1, noteTagLookup = new Map();
function noteTagsById() {
  if (noteTagLookupSource !== applicationShell.state.persistence.data.noteTags || noteTagLookupSize !== applicationShell.state.persistence.data.noteTags.length) {
    noteTagLookupSource = applicationShell.state.persistence.data.noteTags; noteTagLookupSize = applicationShell.state.persistence.data.noteTags.length;
    noteTagLookup = new Map(applicationShell.state.persistence.data.noteTags.map((tag, order) => [tag.id, { tag, order }]));
  }
  return noteTagLookup;
}
function documentNoteTags(doc) {
  const lookup = noteTagsById();
  return normalizeNoteTagIds(doc.tagIds).map(id => lookup.get(id)).filter(Boolean).sort((a, b) => a.order - b.order).map(entry => entry.tag);
}
function noteTagIndex() {
  const byTag = new Map(applicationShell.state.persistence.data.noteTags.map(tag => [tag.id, { documents: [], lastUsed: Date.parse(tag.updatedAt || tag.createdAt) || 0 }]));
  let taggedCount = 0;
  for (const doc of applicationShell.state.persistence.data.documents) {
    let tagged = false;
    const assigned = new Set((doc.tagIds || []).flatMap(id => noteTagAncestorIds(id)));
    for (const id of assigned) {
      const entry = byTag.get(id); if (!entry) continue;
      entry.documents.push(doc); entry.lastUsed = Math.max(entry.lastUsed, noteDirectoryTimestamp(doc)); tagged = true;
    }
    if (tagged) taggedCount++;
  }
  return { byTag, taggedCount };
}
function noteTagIcon(name = 'tag', className = '') { return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`; }
function renderDocumentNoteTags(doc, limit = Infinity) {
  const tags = documentNoteTags(doc);
  const remaining = tags.slice(limit);
  return tags.length ? `<div class="document-note-tags">${tags.slice(0, limit).map(tag => `<span title="${noteDirectoryAttribute(tag.name)}">${applicationShell.actions.escapeHtml(tag.name)}</span>`).join('')}${remaining.length ? `<span title="${noteDirectoryAttribute(remaining.map(tag => tag.name).join('、'))}">+${remaining.length}</span>` : ''}</div>` : '';
}

function renderSidebarNoteTags() {
  const tree = applicationShell.config.$('#noteTagTree');
  if (!tree) return;
  if (selectedNoteTagId && !['all', 'untagged'].includes(selectedNoteTagId) && !noteTagById(selectedNoteTagId)) selectedNoteTagId = 'all';
  tree.hidden = !noteTagTreeExpanded;
  applicationShell.config.$('#noteTagsNav').setAttribute('aria-expanded', String(noteTagTreeExpanded));
  if (!noteTagTreeExpanded) { tree.replaceChildren(); syncNoteTagSelection(); return; }
  const tags = applicationShell.state.persistence.data.noteTags, documents = applicationShell.state.persistence.data.documents, seen = new Set();
  const children = new Map(); tags.forEach(tag => { const parent = tag.parentId && noteTagById(tag.parentId) ? tag.parentId : null; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(tag); });
  const render = (tag, depth = 0) => {
    if (seen.has(tag.id)) return ''; seen.add(tag.id);
    const id = noteDirectoryAttribute(tag.id), name = noteDirectoryAttribute(tag.name), descendants = children.get(tag.id) || [];
    const docs = documents.filter(doc => doc.tagIds?.includes(tag.id));
    const canExpand = docs.length > 0 || descendants.length > 0, expanded = canExpand && expandedNoteTagIds.has(tag.id);
    const toggle = canExpand ? `<button type="button" class="tree-library-toggle note-tag-expand${expanded ? '' : ' collapsed'}" data-expand-note-tag="${id}" aria-controls="note-tag-documents-${id}" aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'}${name}中的笔记和子标签">⌄</button>` : '<span class="note-tag-expand-placeholder" aria-hidden="true"></span>';
    const expansionAttributes = canExpand ? ` aria-controls="note-tag-documents-${id}" aria-expanded="${expanded}"` : '';
    return `<div class="tree-library-group note-tag-group" data-note-tag-depth="${depth}"><div class="tree-library-row note-tag-tree-row">${toggle}<button type="button" data-note-tag-directory="${id}" class="tree-library note-tag-directory" title="${noteDirectoryAttribute(noteTagPath(tag.id))}"${expansionAttributes}>${noteTagIcon('tag', 'tree-kind-icon')}<span class="tree-label-text">${applicationShell.actions.escapeHtml(tag.name)}</span></button><button type="button" class="tree-more" data-tree-menu-button="note-tag" data-tree-menu-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="${name}的更多操作">•••</button><div class="tree-item-menu" popover="auto" role="menu" aria-label="标签操作">${renderNoteTagDirectoryMenu(tag.id)}</div></div><div id="note-tag-documents-${id}" class="note-tag-documents"${expanded ? '' : ' hidden'}>${expanded ? descendants.map(child => render(child, depth + 1)).join('') : ''}${(expanded ? docs : []).map(doc => `<div class="tree-document-row"><button type="button" class="tree-document" data-note-tag-document="${noteDirectoryAttribute(doc.id)}" data-source-note-tag="${id}" title="${noteDirectoryAttribute(doc.title)}">${noteFileIcon(doc, 'tree-kind-icon')}<span class="tree-label-text">${applicationShell.actions.escapeHtml(doc.title)}</span></button></div>`).join('')}</div></div>`;
  };
  tree.innerHTML = (children.get(null) || []).map(tag => render(tag)).join('') || '<p class="note-tag-empty">还没有标签</p>';
  syncNoteTagSelection();
}

function syncNoteTagSelection(section = applicationShell.config.$('.shell > .view:not(.hidden)')?.id.replace(/View$/, '')) {
  const selected = section === 'libraries' && Boolean(selectedNoteTagId) && !applicationShell.state.editor.editingCardNotebookId;
  applicationShell.config.$('#noteTagsNav')?.classList.toggle('active', selected);
  applicationShell.config.$$('#noteTagTree [data-note-tag-directory]').forEach(button => {
    const active = selected && button.dataset.noteTagDirectory === selectedNoteTagId;
    button.classList.toggle('active', active);
    if (active && !applicationShell.state.editor.editingMarkdownDocumentId) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  applicationShell.config.$$('#noteTagTree [data-note-tag-document]').forEach(button => {
    const active = section === 'libraries' && button.dataset.noteTagDocument === applicationShell.state.editor.editingMarkdownDocumentId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (selected) applicationShell.config.$$('.nav[data-view="libraries"]').forEach(button => { button.classList.remove('active'); button.removeAttribute('aria-current'); });
}

async function openNoteTagDirectory(id = 'all', { toggleExpanded = false } = {}) {
  if (!await application.editor.session.leaveActiveNoteEditor()) return false;
  selectedNoteTagId = ['all', 'untagged'].includes(id) || noteTagById(id) ? id : 'all';
  if (toggleExpanded && noteTagById(selectedNoteTagId) && (applicationShell.state.persistence.data.documents.some(doc => doc.tagIds?.some(id => noteTagDescendantIds(selectedNoteTagId).has(id))) || applicationShell.state.persistence.data.noteTags.some(tag => tag.parentId === selectedNoteTagId))) {
    if (expandedNoteTagIds.has(selectedNoteTagId)) expandedNoteTagIds.delete(selectedNoteTagId);
    else expandedNoteTagIds.add(selectedNoteTagId);
  }
  noteTagAncestorIds(selectedNoteTagId).slice(0, -1).forEach(id => expandedNoteTagIds.add(id));
  noteTagTreeExpanded = true;
  applicationShell.actions.showView('libraries');
  renderSidebarNoteTags();
  return true;
}

function renderNoteTagDirectory(newNoteButton) {
  if (selectedNoteTagId === 'all') { renderNoteTagHome(); return; }
  const tag = noteTagById(selectedNoteTagId);
  const scopeIds = tag ? noteTagDescendantIds(tag.id) : null;
  const docs = applicationShell.state.persistence.data.documents.filter(doc => tag ? doc.tagIds?.some(id => scopeIds.has(id)) : !documentNoteTags(doc).length);
  const scope = { id: `note-tags:${tag?.id || 'untagged'}`, tagId: tag?.id, noteTagScope: true,
    name: tag ? noteTagPath(tag.id) : '未设置标签', description: '' };
  newNoteButton.disabled = !applicationShell.state.persistence.data.knowledgeBases.length;
  newNoteButton.title = tag ? `新建笔记并添加“${tag.name}”标签` : '新建笔记';
  applicationShell.config.$('#libraryContent').innerHTML = renderNoteDirectory(scope, docs, [], '');
  applicationShell.config.$('.note-directory-header-actions').prepend(newNoteButton);
  mountNoteDirectory(scope, docs);
}

function renderNoteTagDirectoryMenu(id) {
  return `<button type="button" role="menuitem" data-new-note-tag>${noteTagIcon('plus')}新建标签</button>${id ? `<button type="button" role="menuitem" data-rename-note-tag="${noteDirectoryAttribute(id)}">${noteTagIcon('pencil')}重命名标签</button><button type="button" class="danger" role="menuitem" data-delete-note-tag="${noteDirectoryAttribute(id)}">${noteTagIcon('trash')}删除标签</button>` : ''}`;
}

function handleNoteTagDirectoryClick(event) {
  const destination = event.target.closest('[data-note-tag-home], [data-note-tag-open]');
  if (destination) { void openNoteTagDirectory(destination.dataset.noteTagOpen || 'all'); return true; }
  const trigger = event.target.closest('[data-note-tag-menu]');
  if (trigger) {
    const menu = applicationShell.config.$('#noteTagHomeMenu');
    const wasOpen = menu.matches(':popover-open') && menu.dataset.trigger === trigger.dataset.noteTagMenu
      || noteDirectoryMenuPointerDown?.trigger === trigger && noteDirectoryMenuPointerDown.open;
    noteDirectoryMenuPointerDown = null;
    if (menu.matches(':popover-open')) menu.hidePopover();
    if (wasOpen) return true;
    menu.dataset.trigger = trigger.dataset.noteTagMenu;
    menu.innerHTML = renderNoteTagDirectoryMenu(trigger.dataset.noteTagMenu);
    menu.showPopover();
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 5))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
    return true;
  }
  const button = event.target.closest('[data-new-note-tag], [data-rename-note-tag], [data-delete-note-tag]');
  if (!button) return false;
  button.closest('[popover]')?.hidePopover();
  if (button.hasAttribute('data-delete-note-tag')) void deleteNoteTag(button.dataset.deleteNoteTag);
  else openNoteTagDialog(button.dataset.renameNoteTag || null);
  return true;
}

function openNoteTagDialog(id = null, onCreated = null, initialName = '') {
  if (noteTagOperationPending || !applicationShell.state.persistence.applicationDataReady) return;
  noteTagDialogTarget = id;
  noteTagCreated = onCreated;
  applicationShell.config.$('#noteTagForm').reset();
  applicationShell.config.$('#noteTagDialogTitle').textContent = id ? '重命名标签' : '新建标签';
  applicationShell.config.$('#noteTagSubmit').textContent = id ? '保存' : '创建';
  applicationShell.config.$('#noteTagName').value = noteTagById(id)?.name || initialName;
  const form = applicationShell.config.$('#noteTagForm');
  let parent = form.querySelector('#noteTagParent');
  if (!parent) { const label = document.createElement('label'); label.className = 'note-tag-parent-field'; label.innerHTML = '上级标签<select id="noteTagParent" aria-label="上级标签"></select>'; form.querySelector('#noteTagError').before(label); parent = label.querySelector('select'); }
  const excluded = id ? noteTagDescendantIds(id) : new Set();
  parent.innerHTML = '<option value="">无上级标签</option>' + applicationShell.state.persistence.data.noteTags.filter(tag => !excluded.has(tag.id)).map(tag => `<option value="${noteDirectoryAttribute(tag.id)}">${applicationShell.actions.escapeHtml(noteTagPath(tag.id))}</option>`).join('');
  parent.value = noteTagById(id)?.parentId || ''; parent.removeAttribute('aria-invalid');
  applicationShell.config.$('#noteTagError').textContent = '';
  applicationShell.config.$('#noteTagName').removeAttribute('aria-invalid');
  applicationShell.config.$('#noteTagDialog').showModal();
  requestAnimationFrame(() => { applicationShell.config.$('#noteTagName').focus(); applicationShell.config.$('#noteTagName').select(); });
}

async function submitNoteTag(event) {
  event.preventDefault();
  if (noteTagOperationPending || applicationShell.state.persistence.dataSavePending) return;
  const name = applicationShell.config.$('#noteTagName').value.trim();
  const parentId = applicationShell.config.$('#noteTagParent')?.value || null;
  const parentInvalid = parentId && (!noteTagById(parentId) || noteTagDialogTarget && noteTagDescendantIds(noteTagDialogTarget).has(parentId));
  const invalid = parentInvalid ? '上级标签无效，不能放到自己或自己的子标签中' : !name ? '请输入标签名称' : applicationShell.state.persistence.data.noteTags.some(tag => tag.id !== noteTagDialogTarget && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? '这个标签已存在，请使用其他名称' : '';
  if (invalid) { applicationShell.config.$('#noteTagError').textContent = invalid; const field = applicationShell.config.$(parentInvalid ? '#noteTagParent' : '#noteTagName'); field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
  const before = structuredClone(applicationShell.state.persistence.data.noteTags);
  const timestamp = new Date().toISOString();
  const id = noteTagDialogTarget || applicationShell.config.uid();
  const existing = noteTagById(id);
  if (existing) { Object.assign(existing, { name, updatedAt: timestamp }); if (parentId) existing.parentId = parentId; else delete existing.parentId; }
  else applicationShell.state.persistence.data.noteTags.push({ id, name, ...(parentId ? { parentId } : {}), createdAt: timestamp, updatedAt: timestamp });
  noteTagOperationPending = true; applicationShell.config.$('#noteTagSubmit').disabled = true;
  try {
    await application.persistence.save();
    applicationShell.config.$('#noteTagDialog').close();
    noteTagCreated?.(id);
    renderSidebarNoteTags();
    if (!applicationShell.state.editor.editingMarkdownDocumentId && !applicationShell.config.$('#librariesView').classList.contains('hidden')) applicationShell.actions.renderLibraries();
    applicationShell.actions.showToast(existing ? '标签已更新' : '标签已创建');
  } catch {
    applicationShell.state.persistence.data.noteTags = before;
    applicationShell.config.$('#noteTagError').textContent = '保存失败，请重试';
  } finally { noteTagOperationPending = false; applicationShell.config.$('#noteTagSubmit').disabled = false; }
}

async function deleteNoteTag(id) {
  if (noteTagOperationPending || applicationShell.state.persistence.dataSavePending || !await application.editor.session.leaveActiveNoteEditor()) return;
  const tag = noteTagById(id); if (!tag) return;
  if (!await applicationShell.actions.showConfirmDialog({ title: `删除标签“${tag.name}”？`, message: '笔记会保留，并移除与此标签的关联。子标签会移到此标签的上级。', confirmLabel: '删除标签' })) return;
  noteTagOperationPending = true;
  try {
    await application.persistence.transact(data => {
      data.noteTags = data.noteTags.filter(tag => tag.id !== id);
      data.noteTags.forEach(child => { if (child.parentId === id) { if (tag.parentId) child.parentId = tag.parentId; else delete child.parentId; child.updatedAt = new Date().toISOString(); } });
      data.documents.forEach(doc => { if (doc.tagIds?.includes(id)) { doc.tagIds = doc.tagIds.filter(value => value !== id); doc.updatedAt = new Date().toISOString(); } });
    });
    for (const tab of openNoteTabs) {
      if (tab.draftDocument?.tagIds) tab.draftDocument.tagIds = tab.draftDocument.tagIds.filter(value => value !== id);
      if (tab.draftBaseline?.tagIds) tab.draftBaseline.tagIds = tab.draftBaseline.tagIds.filter(value => value !== id);
    }
    if (selectedNoteTagId === id) selectedNoteTagId = 'all';
    applicationShell.actions.renderAll(); applicationShell.actions.showToast('标签已删除，笔记已保留');
  } catch { applicationShell.actions.renderAll(); }
  finally { noteTagOperationPending = false; }
}

function renderNoteTagControl() {
  return `<div class="note-tag-control"><span class="note-tag-property-label">${noteTagIcon()}标签</span><div id="noteTagSelectedChips" class="note-tag-selected-chips"></div><button type="button" id="noteTagPickerButton" class="note-tag-picker-button" popovertarget="noteTagPicker" aria-label="选择笔记标签">${noteTagIcon('plus')}<span>添加标签</span><small id="noteTagPickerCount" hidden></small></button><div id="noteTagPicker" class="note-tag-picker" popover="auto" aria-label="选择笔记标签"><div class="note-tag-picker-head"><strong>添加标签</strong><button type="button" popovertarget="noteTagPicker" popovertargetaction="hide" aria-label="关闭标签选择">×</button></div><input id="noteTagPickerSearch" type="search" maxlength="40" placeholder="搜索或新建标签" aria-label="搜索或新建笔记标签"><div id="noteTagPickerOptions" class="note-tag-picker-options"></div><button type="button" id="noteTagPickerCreate">＋ 新建标签</button><footer class="note-tag-picker-footer"><span><span id="noteTagPickerSelectionStatus"></span> · 随笔记保存</span><button type="button" class="primary" popovertarget="noteTagPicker" popovertargetaction="hide">完成</button></footer></div></div>`;
}

function bindNoteTagPicker(getIds, setIds) {
  const panel = applicationShell.config.$('#noteTagPicker'); if (!panel) return;
  const search = applicationShell.config.$('#noteTagPickerSearch');
  const render = () => {
    const ids = getIds(), query = search.value.trim().toLocaleLowerCase();
    const selected = documentNoteTags({ tagIds: ids });
    const { byTag } = noteTagIndex();
    const tags = applicationShell.state.persistence.data.noteTags.filter(tag => noteTagPath(tag.id).toLocaleLowerCase().includes(query));
    applicationShell.config.$('#noteTagPickerCount').textContent = selected.length || '';
    applicationShell.config.$('#noteTagPickerSelectionStatus').textContent = `已选 ${selected.length} 个`;
    applicationShell.config.$('#noteTagSelectedChips').innerHTML = selected.map(tag => `<span class="note-tag-selected-chip">${applicationShell.actions.escapeHtml(noteTagPath(tag.id))}<button type="button" data-remove-note-tag="${noteDirectoryAttribute(tag.id)}" aria-label="移除标签：${noteDirectoryAttribute(tag.name)}">×</button></span>`).join('');
    applicationShell.config.$('#noteTagPickerButton').title = selected.map(tag => tag.name).join('、') || '选择笔记标签';
    applicationShell.config.$('#noteTagPickerOptions').innerHTML = tags.map(tag => `<label><input type="checkbox" value="${noteDirectoryAttribute(tag.id)}"${ids.includes(tag.id) ? ' checked' : ''}><span>${applicationShell.actions.escapeHtml(noteTagPath(tag.id))}</span><small>${byTag.get(tag.id).documents.length} 篇</small></label>`).join('') || '<p>没有匹配的标签</p>';
    applicationShell.config.$('#noteTagPickerCreate').textContent = search.value.trim() ? `＋ 新建“${search.value.trim()}”` : '＋ 新建标签';
  };
  search.oninput = render;
  applicationShell.config.$('#noteTagSelectedChips').onclick = event => {
    const button = event.target.closest('[data-remove-note-tag]'); if (!button) return;
    setIds(getIds().filter(id => id !== button.dataset.removeNoteTag)); render(); applicationShell.config.$('#noteTagPickerButton').focus();
  };
  panel.onchange = event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    const id = event.target.value;
    setIds(event.target.checked ? [...new Set([...getIds(), id])] : getIds().filter(value => value !== id));
    render();
    [...applicationShell.config.$('#noteTagPickerOptions').querySelectorAll('input')].find(input => input.value === id)?.focus({ preventScroll: true });
  };
  applicationShell.config.$('#noteTagPickerCreate').onclick = () => {
    const initial = search.value.trim();
    panel.hidePopover();
    openNoteTagDialog(null, id => { if (!panel.isConnected) return; setIds([...new Set([...getIds(), id])]); search.value = ''; render(); }, initial);
  };
  panel.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    render();
    const rect = applicationShell.config.$('#noteTagPickerButton').getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, rect.left))}px`;
    panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, rect.bottom + 8))}px`;
    search.focus();
  });
  render();
}

function bindNoteTagEvents() {
  applicationShell.config.$('#newNoteTagBtn').onclick = () => openNoteTagDialog();
  applicationShell.config.$('#noteTagForm').onsubmit = submitNoteTag;
  applicationShell.config.$('#noteTagName').oninput = () => {
    applicationShell.config.$('#noteTagName').removeAttribute('aria-invalid');
    applicationShell.config.$('#noteTagError').textContent = '';
  };
  // 标签行右侧的箭头：点它只展开 / 收起标签列表，不切换页面。
  applicationShell.config.$('#noteTagsNav [data-nav-toggle="tags"]')?.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    noteTagTreeExpanded = !noteTagTreeExpanded;
    renderSidebarNoteTags();
  });
  applicationShell.config.$('#noteTagsNav').onclick = async () => {
    const wasSelected = selectedNoteTagId === 'all' && !applicationShell.config.$('#librariesView').classList.contains('hidden') && !applicationShell.state.editor.editingMarkdownDocumentId;
    if (wasSelected) { noteTagTreeExpanded = !noteTagTreeExpanded; renderSidebarNoteTags(); }
    else await openNoteTagDirectory();
  };
  applicationShell.config.$('#noteTagTree').onclick = async event => {
    const menuButton = event.target.closest('[data-tree-menu-button="note-tag"]');
    if (menuButton) { applicationShell.actions.openTreeItemMenu(menuButton); return; }
    if (handleNoteTagDirectoryClick(event)) return;
    const expand = event.target.closest('[data-expand-note-tag]');
    if (expand) {
      const id = expand.dataset.expandNoteTag;
      if (expandedNoteTagIds.has(id)) expandedNoteTagIds.delete(id); else expandedNoteTagIds.add(id);
      renderSidebarNoteTags();
      [...applicationShell.config.$('#noteTagTree').querySelectorAll('[data-expand-note-tag]')].find(button => button.dataset.expandNoteTag === id)?.focus();
      return;
    }
    const directory = event.target.closest('[data-note-tag-directory]');
    if (directory) {
      const id = directory.dataset.noteTagDirectory;
      if (await openNoteTagDirectory(id, { toggleExpanded: true })) {
        [...applicationShell.config.$('#noteTagTree').querySelectorAll('[data-note-tag-directory]')].find(button => button.dataset.noteTagDirectory === id)?.focus({ preventScroll: true });
      }
      return;
    }
    const button = event.target.closest('[data-note-tag-document]');
    if (button) {
      const doc = applicationShell.state.persistence.data.documents.find(doc => doc.id === button.dataset.noteTagDocument);
      if (doc && await applicationShell.actions.openMarkdownNoteEditor(doc)) { selectedNoteTagId = button.dataset.sourceNoteTag; applicationShell.actions.syncSidebarSelection(); }
    }
  };
  applicationShell.config.$('#noteTagTree').onpointerdown = event => {
    const button = event.target.closest('[data-tree-menu-button="note-tag"]');
    applicationShell.state.knowledge.treeMenuPointerDown = button && event.button === 0
      ? { button, open: button.parentElement.querySelector('.tree-item-menu').matches(':popover-open') } : null;
  };
  applicationShell.config.$('#noteTagTree').onkeydown = event => {
    const menu = event.target.closest('.tree-item-menu');
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      menu.hidePopover();
      menu.parentElement.querySelector('.tree-more').focus({ preventScroll: true });
      return;
    }
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  };
}

function noteTagLastUsed(tag, index = noteTagIndex()) { return index.byTag.get(tag.id)?.lastUsed || 0; }

function renderNoteTagHome() {
  const index = noteTagIndex();
  const { taggedCount } = index;
  const untaggedCount = applicationShell.state.persistence.data.documents.length - taggedCount;
  applicationShell.config.$('#libraryContent').innerHTML = `<header class="note-directory-heading note-tag-home-heading"><div class="note-directory-heading-copy"><div class="note-directory-title"><h2>标签</h2></div><div class="library-meta"><span>${applicationShell.state.persistence.data.noteTags.length} 个标签</span><span>${taggedCount} 篇笔记</span></div></div><div class="note-directory-header-actions"><button type="button" class="primary note-tag-create" data-new-note-tag>${noteTagIcon('plus')}新建标签</button></div></header>
  <section class="note-directory note-tag-home" aria-label="标签目录"><div class="note-directory-toolbar"><label class="note-directory-search">${noteDirectoryIcon('search')}<input id="noteTagHomeSearch" type="search" placeholder="搜索标签" aria-label="搜索标签" value="${noteDirectoryAttribute(noteTagHomeSearch)}"></label><label class="note-directory-sort">${noteDirectoryIcon('sort')}<select id="noteTagHomeSort" aria-label="标签排序"><option value="recent">最近使用</option><option value="name">按名称排序</option></select></label><button type="button" class="note-tag-untagged" data-note-tag-open="untagged">未设置标签的笔记 <span>${untaggedCount}</span> ›</button></div>
  <div class="note-directory-scroll" role="region" aria-label="标签列表" tabindex="0"><div id="noteTagHomeResults" class="note-tag-home-grid"></div></div>
  <footer class="note-directory-footer"><p id="noteTagHomeStatus" class="note-directory-status" role="status" aria-live="polite" aria-atomic="true"></p><div class="note-directory-footer-controls"><span class="note-directory-page-size">每页 ${NOTE_TAG_PAGE_SIZE} 个标签</span><nav id="noteTagHomePagination" class="note-directory-pagination" aria-label="标签分页"></nav></div></footer></section><div id="noteTagHomeMenu" class="note-directory-menu" popover="auto" role="menu" aria-label="标签操作"></div>`;
  let resultKey, resultTags;
  const update = () => {
    const query = noteTagHomeSearch.trim().toLocaleLowerCase();
    const key = JSON.stringify([query, noteTagHomeSort]);
    if (key !== resultKey) {
      resultTags = applicationShell.state.persistence.data.noteTags.filter(tag => noteTagPath(tag.id).toLocaleLowerCase().includes(query));
      resultTags.sort((a, b) => noteTagHomeSort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : noteTagLastUsed(b, index) - noteTagLastUsed(a, index));
      resultKey = key;
    }
    const tags = resultTags;
    const pageCount = Math.max(1, Math.ceil(tags.length / NOTE_TAG_PAGE_SIZE));
    noteTagHomePage = Math.max(1, Math.min(noteTagHomePage, pageCount));
    const offset = (noteTagHomePage - 1) * NOTE_TAG_PAGE_SIZE;
    const pageTags = tags.slice(offset, offset + NOTE_TAG_PAGE_SIZE);
    applicationShell.config.$('#noteTagHomeResults').innerHTML = pageTags.map(tag => {
      const id = noteDirectoryAttribute(tag.id), name = noteDirectoryAttribute(tag.name), timestamp = noteTagLastUsed(tag, index);
      const count = index.byTag.get(tag.id).documents.length;
      return `<article class="note-tag-home-card" data-note-tag-card="${id}"><button type="button" class="note-tag-card-open" data-note-tag-open="${id}" aria-label="打开标签：${name}"><span class="note-tag-card-icon">${noteTagIcon()}</span><h3 title="${name}">${applicationShell.actions.escapeHtml(tag.name)}</h3><p>${count} 篇笔记</p><footer><span>${timestamp ? `更新于 ${applicationShell.actions.formatDate(timestamp)}` : '还没有笔记'}</span>${noteTagIcon('arrow-right')}</footer></button><button type="button" class="note-directory-more note-tag-card-more" data-note-tag-menu="${id}" aria-label="${name}的标签操作" aria-haspopup="menu" aria-expanded="false">${noteDirectoryIcon('more')}</button></article>`;
    }).join('') || `<div class="note-directory-empty">${noteDirectoryIcon(query ? 'search' : 'tag')}<h3>${query ? '没有找到标签' : '暂无标签'}</h3><button type="button" class="primary" ${query ? 'data-clear-tag-search' : 'data-new-note-tag'}>${query ? '清空搜索' : '新建标签'}</button></div>`;
    applicationShell.config.$('#noteTagHomeStatus').textContent = `${query ? `找到 ${tags.length} 个标签（共 ${applicationShell.state.persistence.data.noteTags.length} 个）` : `共 ${tags.length} 个标签`}${tags.length ? ` · 当前 ${offset + 1}–${offset + pageTags.length} 个` : ''}`;
    applicationShell.config.$('#noteTagHomePagination').innerHTML = renderNoteDirectoryPagination(noteTagHomePage, pageCount, 'note-tag-home', 'noteTagHomeResults');
    applicationShell.config.$('.note-tag-home .note-directory-scroll').scrollTop = 0;
    applicationShell.config.$('[data-clear-tag-search]')?.addEventListener('click', () => { applicationShell.config.$('#noteTagHomeSearch').value = ''; applicationShell.config.$('#noteTagHomeSearch').dispatchEvent(new Event('input')); applicationShell.config.$('#noteTagHomeSearch').focus(); });
  };
  applicationShell.config.$('#noteTagHomeSearch').oninput = event => { noteTagHomeSearch = event.target.value; noteTagHomePage = 1; update(); };
  applicationShell.config.$('#noteTagHomeSearch').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.target.value = ''; noteTagHomeSearch = ''; noteTagHomePage = 1; update(); } };
  applicationShell.config.$('#noteTagHomeSort').value = noteTagHomeSort;
  applicationShell.config.$('#noteTagHomeSort').onchange = event => { noteTagHomeSort = event.target.value; noteTagHomePage = 1; update(); };
  applicationShell.config.$('#noteTagHomePagination').onclick = event => {
    const button = event.target.closest('[data-note-tag-home-page]');
    if (!button || button.disabled || Number(button.dataset.noteTagHomePage) === noteTagHomePage) return;
    const action = button.dataset.noteTagHomePageAction;
    noteTagHomePage = Number(button.dataset.noteTagHomePage); update();
    (applicationShell.config.$(`[data-note-tag-home-page-action="${action}"]:not(:disabled)`) || applicationShell.config.$('#noteTagHomePagination [aria-current="page"]'))?.focus({ preventScroll: true });
  };
  const root = applicationShell.config.$('#libraryContent');
  const rememberMenuPointerDown = event => {
    const trigger = event.target.closest('[data-note-tag-menu]');
    noteDirectoryMenuPointerDown = trigger ? { trigger, open: trigger.getAttribute('aria-expanded') === 'true' } : null;
  };
  root.addEventListener('pointerdown', rememberMenuPointerDown, true);
  disposeNoteDirectory = () => {
    root.removeEventListener('pointerdown', rememberMenuPointerDown, true);
    noteDirectoryMenuPointerDown = null;
    disposeNoteDirectory = () => {};
  };
  const menu = applicationShell.config.$('#noteTagHomeMenu');
  menu.addEventListener('toggle', event => {
    if (event.newState !== 'closed') return;
    const trigger = [...applicationShell.config.$$('[data-note-tag-menu]')].find(button => button.dataset.noteTagMenu === menu.dataset.trigger);
    trigger?.setAttribute('aria-expanded', 'false');
    if (menu.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
  });
  menu.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  };
  update();
}

function renderTaggedNoteList(documents) {
  if (noteDirectoryPreference.view === 'card') return `<div class="document-list note-directory-grid note-tag-note-list">${documents.map(doc => renderNoteDirectoryCard(doc, application.state.knowledge.libraryById(doc.knowledgeBaseId)?.name || '未分类知识库')).join('')}</div>`;
  return `<div class="document-list note-directory-list note-tag-note-list">${documents.map(doc => {
    const id = noteDirectoryAttribute(doc.id), title = noteDirectoryAttribute(doc.title), preview = noteDirectoryPreview(doc);
    const libraryName = application.state.knowledge.libraryById(doc.knowledgeBaseId)?.name || '未分类知识库';
    const timestamp = noteDirectoryTimestamp(doc);
    const more = `<div class="document-actions"><button type="button" class="note-directory-more" data-note-directory-menu="${id}" aria-label="${title}的更多操作" aria-haspopup="menu" aria-expanded="false">${noteDirectoryIcon('more')}</button></div>`;
    return `<article class="document-row note-tag-note-row" data-document-row="${id}" data-open-document-row="${id}" role="button" tabindex="0" aria-label="打开笔记：${title}"><span class="doc-icon">${noteFileIcon(doc)}</span><div class="document-summary"><div class="note-file-title-row"><h3 title="${title}">${applicationShell.actions.escapeHtml(doc.title)}</h3></div><p class="note-tag-note-excerpt">${applicationShell.actions.escapeHtml(preview.text || preview.heading || (preview.diagram ? '包含图表' : '暂无正文'))}</p></div><div class="note-tag-note-meta"><span class="note-tag-note-source" title="${noteDirectoryAttribute(libraryName)}">${noteDirectoryIcon('folder')}<span>${applicationShell.actions.escapeHtml(libraryName)}</span></span>${renderDocumentNoteTags(doc)}</div><time class="note-tag-note-time">${timestamp ? applicationShell.actions.formatDate(timestamp) : '未记录时间'}</time>${more}</article>`;
  }).join('')}</div>`;
}
