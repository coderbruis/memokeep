// Selection controls live outside Quill: preferences and dismissing never edit the note.
function bindNoteSelectionCards(quill, column, { getEnabled, setEnabled, openSettings, createCard, copy, notifyDisabled, getOverlap = () => [], openExisting = () => {} }) {
  const controller = new AbortController(), { signal } = controller;
  const listen = (node, type, handler, options = {}) => node.addEventListener(type, handler, { ...options, signal });
  const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  const cardIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H5a2 2 0 0 0-2 2v12"/><rect x="7" y="7" width="14" height="14" rx="3"/><path d="M11 12h6m-6 4h4M16 2v4m-2-2h4"/></svg>';
  const toolbar = document.createElement('div');
  toolbar.id = 'noteSelectionCardToolbar'; toolbar.className = 'note-selection-card-toolbar'; toolbar.setAttribute('popover', 'manual'); toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '划词操作');
  toolbar.innerHTML = `<button type="button" id="createRichCardFromSelection" class="note-selection-card-button" aria-label="用选中文字制卡">${cardIcon}<span>制卡</span></button><span class="note-selection-divider" aria-hidden="true"></span><button type="button" id="noteSelectionCardMore" aria-label="划词浮层设置" aria-haspopup="menu" aria-controls="noteSelectionCardMenu" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><button type="button" id="dismissNoteSelectionCard" aria-label="关闭本次划词浮层" title="仅关闭本次">${icon('x')}</button>`;
  // 制卡标记（design/prototype/note-card-marks-20261112.md）：选中的文字制过卡时，浮层上显示「已制过 N 张」，制卡前再确认一次。
  const warn = document.createElement('span');
  warn.className = 'note-selection-card-warn'; warn.hidden = true;
  toolbar.querySelector('#createRichCardFromSelection').after(warn);
  const confirmBox = document.createElement('div');
  confirmBox.id = 'noteSelectionCardDuplicate'; confirmBox.className = 'note-selection-duplicate'; confirmBox.setAttribute('popover', 'auto'); confirmBox.setAttribute('role', 'dialog'); confirmBox.setAttribute('aria-label', '这段已经做过卡片');
  document.body.append(confirmBox);
  let duplicates = [], pending = null;
  const menu = document.createElement('div');
  menu.id = 'noteSelectionCardMenu'; menu.className = 'note-selection-popup-menu'; menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '划词浮层设置');
  menu.innerHTML = `<button type="button" role="menuitem" data-selection-setting="disable"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.3A11 11 0 0 1 21 12a12 12 0 0 1-3.2 4M6.5 6.5A12 12 0 0 0 3 12a11 11 0 0 0 12.4 6.4"/></svg><span>不再自动弹出</span></button><button type="button" role="menuitem" data-selection-setting="settings">${icon('settings')}<span>划词设置…</span></button>`;
  const context = document.createElement('div');
  context.id = 'noteSelectionCardContextMenu'; context.className = 'note-selection-popup-menu note-selection-context-menu'; context.setAttribute('popover', 'auto'); context.setAttribute('role', 'menu'); context.setAttribute('aria-label', '选中文字操作');
  context.innerHTML = `<button type="button" role="menuitem" data-selection-action="copy">${icon('copy')}<span>复制</span></button><div role="separator"></div><button type="button" role="menuitem" data-selection-action="create">${cardIcon}<span>制卡</span></button>`;
  column.append(toolbar, menu, context);
  const more = toolbar.querySelector('#noteSelectionCardMore');
  let selection = null, contextSelection = null, dismissed = null, morePointerOpen = false, disposed = false;
  const isOpen = element => element.matches(':popover-open');
  const close = element => { if (isOpen(element)) element.hidePopover(); };
  const keyFor = range => `${range.index}:${range.length}`;
  const readSelection = () => {
    const range = quill.getSelection();
    if (!range?.length) return null;
    const text = quill.getText(range.index, range.length).trim();
    return text ? { range: { ...range }, text } : null;
  };
  const hide = () => { close(menu); close(context); close(toolbar); };
  const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const restoreSelection = current => {
    if (current && column.isConnected) { quill.setSelection(current.range.index, current.range.length, 'silent'); quill.focus({ preventScroll: true }); }
  };
  function dismiss() {
    const current = selection;
    if (current) dismissed = keyFor(current.range);
    hide(); restoreSelection(current);
  }
  function positionMenu(popover, rect, alignRight = false) {
    const width = popover.offsetWidth, height = popover.offsetHeight;
    let top = rect.bottom + 6;
    if (top + height > innerHeight - 12 && rect.top - height - 6 >= 12) top = rect.top - height - 6;
    popover.style.left = `${Math.max(12, Math.min((alignRight ? rect.right - width : rect.left), innerWidth - width - 12))}px`;
    popover.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12))}px`;
  }
  function show(current) {
    if (disposed || !getEnabled() || !quill.isEnabled() || !column.getClientRects().length || dismissed === keyFor(current.range)) return;
    selection = current;
    const bounds = quill.getBounds(current.range.index, current.range.length), editor = quill.container.getBoundingClientRect();
    if (!bounds) return;
    duplicates = getOverlap(current.range) || [];
    warn.hidden = !duplicates.length;
    warn.innerHTML = duplicates.length ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/></svg>已制过 ${duplicates.length} 张` : '';
    toolbar.classList.toggle('has-duplicate', duplicates.length > 0);
    if (!isOpen(toolbar)) toolbar.showPopover();
    const rect = { left: editor.left + bounds.left, top: editor.top + bounds.top, bottom: editor.top + bounds.bottom, width: bounds.width };
    const width = toolbar.offsetWidth, height = toolbar.offsetHeight;
    const top = rect.top - height - 8 >= 12 ? rect.top - height - 8 : rect.bottom + 8;
    toolbar.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - 12))}px`;
    toolbar.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12))}px`;
    if (isOpen(menu)) positionMenu(menu, more.getBoundingClientRect(), true);
  }
  // 输入法拼写中的字母会被当成选区（macOS 拼音等），这时不弹制卡浮层。
  let composing = false;
  const isComposing = () => composing || Boolean(quill.composition?.isComposing);
  const selectionChanged = (range, oldRange, source) => {
    if (range && (!oldRange || range.index !== oldRange.index || range.length !== oldRange.length)) dismissed = null;
    if (!range?.length) {
      // Menu focus temporarily removes Quill's focus without invalidating the chosen text.
      if (!range && [toolbar, menu, context].some(node => node.contains(document.activeElement))) return;
      selection = null; hide(); return;
    }
    if (source !== 'user') return;
    if (isComposing()) { selection = null; hide(); return; }
    if (isOpen(context)) close(context);
    const current = readSelection();
    if (!current) { selection = null; hide(); return; }
    close(menu); show(current);
  };
  quill.on('selection-change', selectionChanged);
  const textChanged = () => { dismissed = null; selection = null; hide(); };
  quill.on('text-change', textChanged);
  listen(quill.root, 'compositionstart', () => { composing = true; selection = null; hide(); });
  listen(quill.root, 'compositionend', () => { composing = false; });
  listen(toolbar, 'mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  listen(more, 'pointerdown', () => { morePointerOpen = isOpen(menu); });
  listen(toolbar, 'click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.id === 'createRichCardFromSelection') {
      const current = selection;
      const existing = current ? getOverlap(current.range) || [] : [];
      if (current && existing.length) { askDuplicate(current, existing, toolbar.getBoundingClientRect()); return; }
      hide(); if (current) createCard(current.text, current.range);
    }
    else if (button.id === 'dismissNoteSelectionCard') dismiss();
    else if (button === more) {
      const wasOpen = morePointerOpen || isOpen(menu); morePointerOpen = false; close(menu);
      if (wasOpen) return;
      menu.showPopover(); more.setAttribute('aria-expanded', 'true'); positionMenu(menu, more.getBoundingClientRect(), true);
      menu.querySelector('button').focus({ preventScroll: true });
    }
  });
  // 这段已经做过卡片：查看已有卡片，还是仍然新建。
  function askDuplicate(current, existing, rect) {
    pending = current;
    close(toolbar);
    confirmBox.innerHTML = `<h4>这段已经做过卡片</h4><p>选中的文字和${existing.length > 1 ? `这 ${existing.length} 张` : '这张'}卡片的原文重叠：</p>${existing.slice(0, 3).map(card => `<div class="q">${escapeText(card.question || '（没有问题）')}</div>`).join('')}<div class="row"><button type="button" data-duplicate="view">查看已有卡片</button><button type="button" class="primary" data-duplicate="create">仍然新建</button></div>`;
    confirmBox.showPopover();
    confirmBox.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - confirmBox.offsetWidth - 12))}px`;
    confirmBox.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - confirmBox.offsetHeight - 12))}px`;
    confirmBox.querySelector('[data-duplicate="create"]').focus({ preventScroll: true });
    confirmBox.dataset.ids = existing.map(card => card.id).join(',');
  }
  listen(confirmBox, 'click', event => {
    const action = event.target.closest('[data-duplicate]')?.dataset.duplicate;
    if (!action) return;
    const current = pending; pending = null;
    close(confirmBox);
    if (action === 'create' && current) createCard(current.text, current.range);
    else if (action === 'view' && current) openExisting(getOverlap(current.range) || []);
  });
  listen(menu, 'click', async event => {
    const action = event.target.closest('[data-selection-setting]')?.dataset.selectionSetting; if (!action) return;
    const current = selection; dismiss();
    if (action === 'settings') { await openSettings(); return; }
    if (await setEnabled(false)) { restoreSelection(current); notifyDisabled(); }
  });
  listen(menu, 'toggle', event => more.setAttribute('aria-expanded', String(event.newState === 'open')));
  listen(quill.root, 'contextmenu', event => {
    if (event.defaultPrevented) return;
    const current = readSelection(); if (!current) return;
    hide(); contextSelection = current;
    const x = event.clientX, y = event.clientY;
    openSidebarContextMenu(event, () => {
      if (disposed) return;
      context.showPopover();
      positionMenu(context, { left: x, right: x, top: y, bottom: y - 6 });
      context.querySelector('button').focus({ preventScroll: true });
    });
  });
  listen(context, 'click', async event => {
    const action = event.target.closest('[data-selection-action]')?.dataset.selectionAction;
    const current = contextSelection; if (!action || !current) return;
    hide();
    if (action === 'create') createCard(current.text);
    else { await copy(current.text); restoreSelection(current); }
  });
  for (const popup of [menu, context]) {
    listen(popup, 'keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(popup);
        if (popup === menu && isOpen(toolbar)) more.focus({ preventScroll: true }); else restoreSelection(contextSelection);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...popup.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    });
  }
  listen(document, 'keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && isOpen(toolbar)) { event.preventDefault(); dismiss(); } });
  listen(document, 'pointerdown', event => { if (![toolbar, menu, context, quill.root].some(node => node.contains(event.target))) hide(); });
  listen(window, 'resize', hide);
  listen(window, 'scroll', event => { if (![menu, context].some(node => node.contains(event.target))) hide(); }, { capture: true });
  listen(window, 'memokeep-selection-card-preference-changed', () => { if (!getEnabled()) hide(); });
  // A native auto-popover may close when clicking outside without changing selection.
  listen(context, 'toggle', event => { if (event.newState === 'closed' && context.contains(document.activeElement)) restoreSelection(contextSelection); });
  return { hide, dispose() { disposed = true; controller.abort(); quill.off('selection-change', selectionChanged); quill.off('text-change', textChanged); toolbar.remove(); confirmBox.remove(); menu.remove(); context.remove(); } };
}
