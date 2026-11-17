let newNoteFileDestination = null;
let newNoteFileAnchor = null;

const NEW_NOTE_FILE_TYPE_SEARCH_AFTER = 5;
const NEW_NOTE_FILE_ILLEGAL = /[\\/:*?"<>|]/g;

function requestNewNoteFile(destination = null, anchor = null) {
  const cards = destination ? destination.kind === 'cards' : Boolean(applicationShell.state.editor.editingCardNotebookId || noteDraftTab()?.draftNotebook);
  if (cards) return createNoteTab(destination);
  return applicationShell.actions.openNewNoteNameDialog(destination, anchor);
}

// Right-aligned under the page button; left-aligned when the anchor sits near the left edge (sidebar rows).
function positionNewNoteFileDialog() {
  const dialog = applicationShell.config.$('#newNoteNameDialog');
  if (!dialog.open) return;
  if (innerWidth <= 680) { dialog.style.left = dialog.style.top = ''; return; }
  const anchor = newNoteFileAnchor?.isConnected && newNoteFileAnchor.getClientRects().length ? newNoteFileAnchor : applicationShell.config.$('#newNoteBtn');
  const rect = anchor?.getClientRects().length ? anchor.getBoundingClientRect() : null;
  const width = dialog.offsetWidth, height = dialog.offsetHeight;
  const fromLeft = rect && rect.right - width < 12;
  const left = rect ? (fromLeft ? rect.left - 8 : rect.right - width) : (innerWidth - width) / 2;
  dialog.style.left = `${Math.max(12, Math.min(left, innerWidth - width - 12))}px`;
  dialog.style.top = `${Math.max(12, Math.min(rect ? rect.bottom + 8 : (innerHeight - height) / 2, innerHeight - height - 12))}px`;
  dialog.style.setProperty('--note-file-origin', fromLeft ? 'top left' : 'top right');
}

function placeNewNoteFilePopover(menu, rect, { alignRight = false, minWidth = 0 } = {}) {
  menu.style.width = `${Math.min(Math.max(rect.width, minWidth), innerWidth - 16)}px`;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(alignRight ? rect.right - width : rect.left, innerWidth - width - 8))}px`;
  const top = rect.bottom + 6 + height <= innerHeight - 8 ? rect.bottom + 6 : rect.top - 6 - height >= 8 ? rect.top - 6 - height : Math.max(8, innerHeight - height - 8);
  menu.style.top = `${top}px`;
}

function setNewNoteFileType(id, { flash = false } = {}) {
  const type = MemoKeepNoteFiles.types[id];
  if (!type) return;
  const $ = applicationShell.config.$;
  const previous = $('#newNoteFileType').value;
  const input = $('#newNoteName');
  if (!input.value.trim() || Object.values(MemoKeepNoteFiles.types).some(item => item.defaultTitle === input.value)) input.value = type.defaultTitle;
  $('#newNoteFileType').value = id;
  $('#newNoteFileSuffix').textContent = type.extension;
  $('#newNoteFileTypeButton').setAttribute('aria-label', `文件类型：${type.label} ${type.extension}，点击更换`);
  $('#newNoteFileTypeHint').textContent = `${type.label}：${type.description}`;
  applicationShell.config.$$('#newNoteFileTypeMenu [data-new-file-type]').forEach(button => {
    const selected = button.dataset.newFileType === id;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  if (flash && previous !== id) {
    const chip = $('#newNoteFileTypeButton');
    chip.classList.remove('is-changed'); void chip.offsetWidth; chip.classList.add('is-changed');
  }
  validateNewNoteFileName();
}

// Mirrors createNoteTab: same-type titles in the target library plus open drafts get a " 2", " 3"… ending.
function newNoteFileSavedTitle(title, fileType, libraryId) {
  const comparable = application.domain.comparableName;
  const sameType = doc => MemoKeepNoteFiles.of(doc).id === fileType;
  const occupied = new Set([
    ...applicationShell.state.persistence.data.documents.filter(doc => doc.knowledgeBaseId === libraryId && sameType(doc)).map(doc => doc.title),
    ...openNoteTabs.filter(tab => tab.draftDocument && sameType(tab.draftDocument)).map(tab => tab.draftDocument.title)
  ].map(comparable));
  let result = title.slice(0, 100), suffix = 2;
  while (occupied.has(comparable(result))) { const ending = ` ${suffix++}`; result = `${title.slice(0, 100 - ending.length)}${ending}`; }
  return result;
}

function newNoteFileRequestedTitle() {
  return applicationShell.config.$('#newNoteName').value.trim().replace(/\.(md|txt|markdown)$/i, '');
}

function showNewNoteFileMessage(tone = '', text = '') {
  const $ = applicationShell.config.$, message = $('#newNoteFileError');
  message.hidden = !text; message.textContent = text; message.dataset.tone = tone;
  if (tone === 'error') message.setAttribute('role', 'alert'); else message.removeAttribute('role');
  $('#newNoteFileNameBox').classList.toggle('is-invalid', tone === 'error');
  $('#newNoteName').toggleAttribute('aria-invalid', tone === 'error');
}

// Live check while typing; empty names are only reported on submit.
function validateNewNoteFileName() {
  const $ = applicationShell.config.$;
  const title = newNoteFileRequestedTitle();
  const illegal = [...new Set(title.match(NEW_NOTE_FILE_ILLEGAL) || [])];
  const submit = $('#newNoteNameForm button[type="submit"]');
  submit.disabled = illegal.length > 0;
  if (illegal.length) { showNewNoteFileMessage('error', `文件名不能包含 ${illegal.map(char => `「${char}」`).join('')}，请删除或换成其他字符`); return false; }
  const type = MemoKeepNoteFiles.types[$('#newNoteFileType').value];
  const library = application.state.knowledge.libraryById($('#newNoteLibrary').value);
  if (title && type && library) {
    const saved = newNoteFileSavedTitle(title, type.id, library.id);
    if (saved !== title.slice(0, 100)) { showNewNoteFileMessage('warning', `此目录已有「${title}${type.extension}」，将保存为「${saved}${type.extension}」`); return true; }
  }
  showNewNoteFileMessage();
  return true;
}

// Typing a known extension at the end of the name ("周报.txt") switches the type and drops the extension.
function applyNewNoteFileSuffix() {
  const input = applicationShell.config.$('#newNoteName');
  const match = /\.([a-z0-9]+)$/i.exec(input.value);
  if (!match) return;
  const extension = `.${match[1].toLowerCase()}`;
  const type = extension === '.markdown' ? MemoKeepNoteFiles.types.md : Object.values(MemoKeepNoteFiles.types).find(item => item.extension === extension);
  if (!type) return;
  input.value = input.value.slice(0, -match[0].length);
  setNewNoteFileType(type.id, { flash: true });
}

function syncNewNoteFileDestination() {
  const $ = applicationShell.config.$, escape = applicationShell.actions.escapeHtml;
  const libraries = applicationShell.state.persistence.data.knowledgeBases;
  const chain = MemoKeepDirectoryTree.ancestors(libraries, $('#newNoteLibrary').value);
  $('#newNoteLibraryValue').innerHTML = chain.map((item, index) => index === chain.length - 1 ? `<strong>${escape(item.name)}</strong>` : `<span>${escape(item.name)}</span><span class="note-file-crumb-separator" aria-hidden="true">/</span>`).join('');
  validateNewNoteFileName();
}

function renderNewNoteFileTypes(query = '') {
  const $ = applicationShell.config.$, escape = applicationShell.actions.escapeHtml;
  const current = $('#newNoteFileType').value;
  const needle = query.trim().toLowerCase().replace(/^\./, '');
  const types = Object.values(MemoKeepNoteFiles.types).filter(type => !needle || `${type.label}${type.extension}${type.description}`.toLowerCase().includes(needle));
  $('#newNoteFileTypeMenu .note-file-type-options').innerHTML = types.length
    ? types.map(type => `<button type="button" role="option" aria-selected="${type.id === current}" tabindex="${type.id === current ? 0 : -1}" data-new-file-type="${escape(type.id)}">${noteFileIcon({ metadata: { fileType: type.id } })}<span><strong>${escape(type.label)}</strong><small>${escape(type.description)}</small></span><code>${escape(type.extension)}</code><svg class="note-file-check" aria-hidden="true"><use href="#icon-check"></use></svg></button>`).join('')
    : `<p class="note-file-menu-empty">没有匹配「${escape(query.trim())}」的类型</p>`;
}

function renderNewNoteFileLibraries(query = '') {
  const $ = applicationShell.config.$, escape = applicationShell.actions.escapeHtml;
  const libraries = applicationShell.state.persistence.data.knowledgeBases, documents = applicationShell.state.persistence.data.documents;
  const current = $('#newNoteLibrary').value, needle = query.trim().toLowerCase();
  const rows = MemoKeepDirectoryTree.entries(libraries).map(({ item, depth }) => ({ item, depth, label: MemoKeepDirectoryTree.label(libraries, item.id) }))
    .filter(row => !needle || row.label.toLowerCase().includes(needle));
  $('#newNoteLibraryOptions').innerHTML = rows.length
    ? rows.map(({ item, depth, label }) => `<button type="button" role="option" aria-selected="${item.id === current}" data-new-file-library="${escape(item.id)}" style="--depth:${needle ? 0 : depth - 1}"><svg aria-hidden="true"><use href="#icon-folder"></use></svg><span>${escape(needle ? label : item.name)}</span><small>${documents.filter(doc => doc.knowledgeBaseId === item.id).length}</small><svg class="note-file-check" aria-hidden="true"><use href="#icon-check"></use></svg></button>`).join('')
    : `<p class="note-file-menu-empty">没有匹配「${escape(query.trim())}」的目录</p>`;
}

function bindNewNoteFileMenu({ menu, trigger, search, options, render, open, choose, returnFocus }) {
  const close = () => { if (menu.matches(':popover-open')) menu.hidePopover(); };
  trigger.onclick = () => { if (menu.matches(':popover-open')) close(); else open(); };
  trigger.onkeydown = event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } };
  menu.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  search.oninput = () => render(search.value);
  menu.onclick = event => { const option = event.target.closest('[role="option"]'); if (option) { choose(option); close(); returnFocus().focus(); } };
  menu.onkeydown = event => {
    const items = [...options.querySelectorAll('[role="option"]')], searching = !search.closest('[hidden]');
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = document.activeElement === search ? items[0] : document.activeElement.closest('[role="option"]');
      target?.click(); return;
    }
    if (event.key === 'Tab') { event.preventDefault(); close(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement), last = items.length - 1;
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowDown' ? (index >= last ? 0 : index + 1) : index - 1;
    if (next < 0) { if (searching) { search.focus(); return; } next = last; }
    items[next].focus();
  };
  return close;
}

function bindNewNoteFileControls() {
  const $ = applicationShell.config.$;
  const dialog = $('#newNoteNameDialog'), nameBox = $('#newNoteFileNameBox'), input = $('#newNoteName');
  const typeMenu = $('#newNoteFileTypeMenu'), typeTrigger = $('#newNoteFileTypeButton'), typeSearch = $('#newNoteFileTypeSearch');
  const libraryMenu = $('#newNoteLibraryMenu'), libraryTrigger = $('#newNoteLibraryButton'), librarySearch = $('#newNoteLibrarySearch');

  const openTypes = () => {
    const many = Object.keys(MemoKeepNoteFiles.types).length > NEW_NOTE_FILE_TYPE_SEARCH_AFTER;
    typeSearch.closest('.note-file-menu-search').hidden = !many; typeSearch.value = '';
    renderNewNoteFileTypes(); typeMenu.showPopover();
    const box = nameBox.getBoundingClientRect();
    placeNewNoteFilePopover(typeMenu, { ...box.toJSON(), width: 300 }, { alignRight: true });
    (many ? typeSearch : typeMenu.querySelector('[aria-selected="true"]'))?.focus();
  };
  const closeTypes = bindNewNoteFileMenu({ menu: typeMenu, trigger: typeTrigger, search: typeSearch, options: typeMenu.querySelector('.note-file-type-options'),
    render: renderNewNoteFileTypes, open: openTypes, choose: option => setNewNoteFileType(option.dataset.newFileType, { flash: true }), returnFocus: () => input });

  const openLibraries = () => {
    librarySearch.value = ''; renderNewNoteFileLibraries(); libraryMenu.showPopover();
    placeNewNoteFilePopover(libraryMenu, libraryTrigger.getBoundingClientRect(), { minWidth: 260 });
    librarySearch.focus();
  };
  const closeLibraries = bindNewNoteFileMenu({ menu: libraryMenu, trigger: libraryTrigger, search: librarySearch, options: $('#newNoteLibraryOptions'),
    render: renderNewNoteFileLibraries, open: openLibraries, choose: option => { $('#newNoteLibrary').value = option.dataset.newFileLibrary; syncNewNoteFileDestination(); }, returnFocus: () => libraryTrigger });

  const closeMenus = () => { closeTypes(); closeLibraries(); };
  input.oninput = () => { applyNewNoteFileSuffix(); validateNewNoteFileName(); };
  input.addEventListener('keydown', event => { if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); openTypes(); } });
  nameBox.addEventListener('mousedown', event => { if (event.target === nameBox) { event.preventDefault(); input.focus(); } });
  dialog.addEventListener('close', closeMenus);
  dialog.addEventListener('scroll', closeMenus);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  window.addEventListener('resize', () => { closeMenus(); positionNewNoteFileDialog(); });
}
