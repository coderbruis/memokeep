(function expose(root) {
  function createNoteTabView({ state, actions, $, platform }) {
    function mountNoteTabControls() {
      const form = $('#inlineMarkdownNoteForm');
      const navigation = $('#noteTabsBar .note-tab-navigation');
      const chrome = $('#noteTabsBar .note-tab-actions');
      if (!form || !navigation || !chrome) return;
      const back = form.querySelector('#closeInlineEditorBtn') || navigation.querySelector('#closeInlineEditorBtn');
      navigation.replaceChildren(...[back].filter(Boolean));
      // Keep note actions in the editor toolbar so the tab strip stays available for tabs and window dragging.
      const find = selector => form.querySelector(selector) || chrome.querySelector(selector);
      const status = find('#noteSaveStatus');
      const controlGroups = [...form.querySelectorAll('.note-workspace-controls'), ...chrome.querySelectorAll('.note-workspace-controls')];
      const workspaceControls = controlGroups.at(-1);
      // Plain-text learning tools can mount before workspace actions; keep both in the same menu group.
      controlGroups.filter(group => group !== workspaceControls).forEach(group => {
        workspaceControls.append(...group.children); group.remove();
      });
      const saveButton = find('#saveNoteButton'), history = find('.note-history-control');
      const favorite = workspaceControls?.querySelector('#noteFavoriteButton') || form.querySelector('#noteFavoriteButton') || chrome.querySelector('#noteFavoriteButton');
      const tagControl = form.querySelector('.note-tag-control');
      const properties = tagControl || form.querySelector('.note-document-heading, .card-editor-heading, .note-text-title');
      if (favorite && properties) {
        favorite.classList.add('note-document-favorite');
        const addTag = properties.querySelector('#noteTagPickerButton');
        const title = properties.querySelector('.note-title-input');
        if (addTag) addTag.after(favorite); else if (title) title.after(favorite); else properties.append(favorite);
      }

      const toolbar = form.dataset.editorMode === 'note' ? form.querySelector('#noteRichToolbar') : form.querySelector('.note-editor-toolbar');
      if (!toolbar) return;
      let toolbarActions = toolbar.querySelector('.note-toolbar-actions');
      if (!toolbarActions) {
        toolbarActions = platform.document.createElement('div');
        toolbarActions.className = 'note-toolbar-actions';
        toolbar.append(toolbarActions);
      }
      const more = form.querySelector('.note-tab-more-control') || platform.document.createElement('details');
      more.className = 'note-tab-more-control';
      if (!more.firstElementChild) {
        more.innerHTML = '<summary class="note-tab-more-trigger" title="更多笔记操作" aria-label="更多笔记操作" aria-haspopup="menu" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div class="note-tab-more-menu" role="menu" aria-label="更多笔记操作"></div>';
        more.addEventListener('toggle', () => more.querySelector('summary').setAttribute('aria-expanded', String(more.open)));
      }
      const menu = more.querySelector('.note-tab-more-menu');
      let internalControls = form.querySelector('.note-editor-internal-controls');
      if (!internalControls) {
        internalControls = platform.document.createElement('div');
        internalControls.className = 'note-editor-internal-controls hidden';
        internalControls.hidden = true;
        internalControls.setAttribute('aria-hidden', 'true');
        form.append(internalControls);
      }
      if (status) { status.hidden = true; internalControls.append(status); }
      if (saveButton) {
        saveButton.removeAttribute('role');
        internalControls.append(saveButton);
      }
      if (history) {
        const button = history.querySelector('#noteHistoryButton');
        button.setAttribute('role', 'menuitem');
        if (!button.querySelector('span')) button.insertAdjacentHTML('beforeend', '<span>历史版本</span>');
      }
      const skim = workspaceControls?.querySelector('#noteSkimButton') || form.querySelector('#noteSkimButton') || chrome.querySelector('#noteSkimButton');
      const details = workspaceControls?.querySelector('#noteGistDetailsAll') || form.querySelector('#noteGistDetailsAll') || chrome.querySelector('#noteGistDetailsAll');
      const screenshot = toolbar.id === 'noteRichToolbar' ? form.querySelector('#captureNoteScreenshot') : null;
      const findButton = form.querySelector('#noteFindButton') || chrome.querySelector('#noteFindButton');
      const separator = platform.document.createElement('span');
      separator.className = 'note-toolbar-separator'; separator.setAttribute('aria-hidden', 'true');
      // Retain internal bindings and keyboard saving; the menu exposes history only.
      if (workspaceControls) internalControls.append(workspaceControls);
      menu.replaceChildren(...[history].filter(Boolean));
      toolbarActions.replaceChildren(...[screenshot, screenshot ? separator : null, skim, details, findButton, more].filter(Boolean));
      chrome.replaceChildren();
    }

    const renderedTabMarkup = new WeakMap();
    function renderNoteTabs(revealActive = false) {
      const bar = $('#noteTabsBar'); if (!bar) return;
      state.tabs = state.tabs.filter(tab => tab.draftDocument || (tab.id === 'new' ? state.activeId === 'new'
        : actions.documentById(tab.id) && (!tab.cardNotebookId || actions.activeNotebooks().some(note => note.id === tab.cardNotebookId))));
      // Retain opened notes across directory navigation without showing editor chrome there.
      const visible = Boolean(state.activeId || state.isNoteWindow);
      bar.hidden = !visible;
      $('#librariesView').classList.toggle('has-note-tabs', visible);
      const escape = value => actions.escapeHtml(String(value)).replace(/"/g, '&quot;');
      const activeTitle = $('#inlineMarkdownNoteForm')?.dataset.documentId === state.activeId ? $('#inlineMarkdownNoteTitle')?.value : null;
      const dirty = Boolean(state.hasChanges?.());
      if (!bar.querySelector('.note-tab-list')) bar.innerHTML = '<div class="note-tab-navigation" data-tauri-drag-region></div><div class="note-tab-list" role="tablist" aria-label="已打开的笔记" data-tauri-drag-region></div><button type="button" class="note-tab-add" id="newNoteTabButton" aria-label="新建笔记" title="新建笔记"><svg aria-hidden="true"><use href="#icon-plus"></use></svg></button><div class="note-tab-actions" data-tauri-drag-region></div>';
      const list = bar.querySelector('.note-tab-list');
      const noteItems = state.tabs.map(tab => {
        const doc = actions.documentById(tab.id), active = tab.id === state.activeId;
        const title = (active ? activeTitle : null) || doc?.title || '未命名笔记';
        const unsaved = Boolean(tab.draftDocument || (active ? dirty : tab.dirty) || tab.saveError);
        const saveHint = unsaved ? `${tab.saveError ? `${tab.saveError} · ` : ''}未保存 · ${actions.shortcuts.label('save')} 保存` : '';
        const tooltip = [title, saveHint].filter(Boolean).join('\n');
        return { key: `note:${tab.id}`, markup: `<div class="note-tab${active ? ' is-active' : ''}" draggable="true" data-tauri-drag-region="false" data-workspace-tab-key="note:${escape(tab.id)}" data-note-tab-order="${escape(tab.id)}" title="拖动排序；Alt + Shift + 左右方向键调整位置">
          <button type="button" id="noteTab-${escape(tab.id)}" class="note-tab-select" role="tab" aria-selected="${active}" aria-controls="libraryContent" tabindex="${active || !state.activeId && tab === state.tabs[0] ? 0 : -1}" data-note-tab="${escape(tab.id)}" title="${escape(tooltip)}" ${state.actionPending ? 'disabled' : ''}>
            ${unsaved ? `<span class="note-tab-dirty${tab.saveError ? ' is-save-error' : ''}" aria-label="${escape(tab.saveError || '未保存')}" title="${escape(saveHint)}"></span>` : ''}<span class="note-tab-filename"><span class="note-tab-title">${escape(title)}</span>${tab.cardNotebookId ? '' : actions.fileExtension(doc)}</span>
          </button>
          <button type="button" class="note-tab-close" data-close-note-tab="${escape(tab.id)}" aria-label="关闭笔记：${escape(title)}" title="关闭标签" ${state.actionPending ? 'disabled' : ''}><svg aria-hidden="true"><use href="#icon-x"></use></svg></button>
        </div>` };
      });
      const items = [...(actions.pageTabItems?.() || []), ...noteItems];
      const markups = (actions.orderWorkspaceTabs?.(items) || items).map(item => item.markup);
      list.setAttribute('aria-label', '已打开的标签');
      // 切换标签、打字时这里会连续调用几次。标签的个数和顺序没变时只替换有变化的那几个：
      // 不重建整条标签栏，也就不用读、写横向滚动位置（读一次，浏览器就要把整篇笔记重新排版一遍）。
      const previous = renderedTabMarkup.get(list);
      if (previous && previous.length === markups.length && list.children.length === markups.length) {
        markups.forEach((markup, index) => { if (previous[index] !== markup) list.children[index].outerHTML = markup; });
      } else {
        const scrollLeft = previous ? list.scrollLeft : 0;
        list.innerHTML = markups.join('');
        if (scrollLeft) list.scrollLeft = scrollLeft;
      }
      renderedTabMarkup.set(list, markups);
      $('#newNoteTabButton').disabled = state.actionPending;
      const panel = $('#libraryContent');
      if (state.activeId) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `noteTab-${state.activeId}`); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
      if (revealActive) bar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      renderOpenTabsStrip();
      actions.rememberWorkspace?.();
    }

    // 离开笔记去别的页面（设置、卡片、今天…）时，已打开的标签仍留在顶部标题行，点一下回到那篇笔记，不会「丢」。
    let lastActiveId = null;
    function renderOpenTabsStrip() {
      actions.syncPageTabChrome?.();
      const strip = $('#workspaceOpenTabs'); if (!strip) return;
      if (state.activeId) lastActiveId = state.activeId;
      const tabs = state.tabs.filter(tab => tab.id !== 'new' && (tab.draftDocument || actions.documentById(tab.id)));
      const pageItems = actions.pageTabItems?.() || [];
      strip.classList.toggle('has-page-tabs', pageItems.length > 0);
      const show = !state.activeId && !state.isNoteWindow && (tabs.length > 0 || pageItems.length > 0);
      strip.hidden = !show;
      if (!show) { if (strip.childElementCount) strip.replaceChildren(); return; }
      const escape = value => actions.escapeHtml(String(value)).replace(/"/g, '&quot;');
      const noteItems = tabs.map(tab => {
        const doc = tab.draftDocument || actions.documentById(tab.id), title = doc?.title || '未命名笔记', recent = tab.id === lastActiveId;
        const disabled = state.actionPending || state.batchPending ? ' disabled' : '';
        return { key: `note:${tab.id}`, markup: `<div class="workspace-open-tab${recent ? ' is-recent' : ''}" draggable="true" data-tauri-drag-region="false" data-workspace-tab-key="note:${escape(tab.id)}" title="拖动排序；Alt + Shift + 左右方向键调整位置"><button type="button" data-open-tab="${escape(tab.id)}" title="回到「${escape(title)}」${recent ? '（上次编辑）' : ''}"${disabled}>${tab.cardNotebookId ? '<svg aria-hidden="true"><use href="#icon-book-open-text"></use></svg>' : actions.fileIcon(doc)}<span>${escape(title)}</span>${tab.draftDocument || tab.dirty ? '<i class="note-tab-dirty" aria-label="未保存"></i>' : ''}</button><button type="button" class="workspace-open-tab-close" data-close-open-tab="${escape(tab.id)}" aria-label="关闭笔记：${escape(title)}" title="关闭标签"${disabled}><svg aria-hidden="true"><use href="#icon-x"></use></svg></button></div>` };
      });
      const items = [...pageItems, ...noteItems], ordered = actions.orderWorkspaceTabs?.(items) || items;
      strip.innerHTML = `<div class="workspace-open-tabs-list" role="tablist" aria-label="已打开的标签" data-tauri-drag-region>${ordered.map(item => item.markup).join('')}</div><button type="button" class="workspace-open-tab-add" data-new-open-tab aria-label="新建笔记" title="新建笔记"${state.actionPending ? ' disabled' : ''}><svg aria-hidden="true"><use href="#icon-plus"></use></svg></button>`;
      if (!strip.dataset.bound) {
        strip.dataset.bound = 'true';
        strip.addEventListener('click', async event => {
          if (state.actionPending || state.batchPending) return;
          const close = event.target.closest('[data-close-open-tab]');
          if (close) { await actions.closeTab(close.dataset.closeOpenTab); renderOpenTabsStrip(); return; }
          const open = event.target.closest('[data-open-tab]');
          if (open) { await actions.activate(open.dataset.openTab); return; }
          const add = event.target.closest('[data-new-open-tab]');
          if (add) await actions.requestNew(null, add);
        });
        strip.addEventListener('wheel', event => {
          const list = strip.querySelector('.workspace-open-tabs-list');
          if (!list || list.scrollWidth <= list.clientWidth) return;
          event.preventDefault(); list.scrollLeft += event.deltaY || event.deltaX;
        }, { passive: false });
      }
    }

    function reorderNoteTabs(sourceId, targetId, after = false) {
      if (actions.reorderWorkspaceTabs) return actions.reorderWorkspaceTabs(`note:${sourceId}`, `note:${targetId}`, after);
      if (state.actionPending || state.batchPending || state.saving || sourceId === targetId) return false;
      const tabs = [...state.tabs], from = tabs.findIndex(tab => tab.id === sourceId);
      if (from < 0 || !tabs.some(tab => tab.id === targetId)) return false;
      const [tab] = tabs.splice(from, 1), destination = tabs.findIndex(item => item.id === targetId) + (after ? 1 : 0);
      tabs.splice(destination, 0, tab); state.tabs = tabs; renderNoteTabs(true);
      return true;
    }
    function bindNoteTabReorder(bar) {
      platform.window.addEventListener('pagehide', () => actions.rememberWorkspace?.({ captureScroll: true }));
      if (actions.reorderWorkspaceTabs) return;
      let draggedId = null;
      const clearTargets = () => bar.querySelectorAll('.is-tab-drop-target').forEach(tab => tab.classList.remove('is-tab-drop-target', 'is-tab-drop-after'));
      const clear = () => { draggedId = null; clearTargets(); };
      bar.addEventListener('dragstart', event => {
        const tab = event.target.closest('[data-note-tab-order]');
        if (!tab || event.target.closest('[data-close-note-tab]') || state.actionPending || state.batchPending || state.saving) { event.preventDefault(); return; }
        draggedId = tab.dataset.noteTabOrder;
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-memokeep-note-tab', draggedId);
      });
      bar.addEventListener('dragover', event => {
        const tab = event.target.closest('[data-note-tab-order]'); if (!draggedId || !tab) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        clearTargets(); tab.classList.add('is-tab-drop-target');
        const bounds = tab.getBoundingClientRect(); tab.classList.toggle('is-tab-drop-after', event.clientX >= bounds.left + bounds.width / 2);
      });
      bar.addEventListener('drop', event => {
        const tab = event.target.closest('[data-note-tab-order]'); if (!draggedId || !tab) return;
        event.preventDefault(); const source = draggedId, target = tab.dataset.noteTabOrder;
        const bounds = tab.getBoundingClientRect(); reorderNoteTabs(source, target, event.clientX >= bounds.left + bounds.width / 2); clear();
      });
      bar.addEventListener('dragend', clear);
    }

    function bindNoteTabWindowDrag(bar) {
      const layer = platform.document.createElement('div');
      layer.className = 'note-window-drag-space';
      layer.setAttribute('data-tauri-drag-region', '');
      layer.hidden = true;
      layer.setAttribute('aria-hidden', 'true');
      platform.document.body.append(layer);
      let frame = null;
      const update = () => {
        frame = null;
        const add = bar.querySelector('.note-tab-add');
        if (bar.hidden || !bar.getClientRects().length || !add) { layer.hidden = true; return; }
        const rect = bar.getBoundingClientRect();
        const left = Math.max(rect.left, add.getBoundingClientRect().right + 4);
        const right = rect.right - 12;
        const top = Math.max(0, rect.top), bottom = Math.min(platform.window.innerHeight, rect.bottom);
        layer.hidden = right <= left || bottom <= top;
        if (layer.hidden) return;
        Object.assign(layer.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      };
      const schedule = () => { if (frame === null) frame = platform.requestFrame(update); };
      const resize = new platform.ResizeObserver(schedule);
      resize.observe(bar);
      const changes = new platform.MutationObserver(schedule);
      changes.observe(bar, { childList: true, subtree: true, attributes: true });
      platform.window.addEventListener('resize', schedule);
      platform.document.addEventListener('scroll', schedule, { capture: true, passive: true });
      // The binding lives with the page, just like the tab bar itself.
      platform.window.addEventListener('pagehide', () => {
        resize.disconnect(); changes.disconnect();
        platform.window.removeEventListener('resize', schedule);
        platform.document.removeEventListener('scroll', schedule, true);
        if (frame !== null) platform.cancelFrame(frame);
        layer.remove();
      }, { once: true });
      schedule();
    }

    function bindNoteTabs() {
      const bar = $('#noteTabsBar');
      bindNoteTabWindowDrag(bar);
      bindNoteTabReorder(bar);
      const closeMore = (details, restoreFocus = false) => {
        if (!details) return;
        const historyMenu = details.querySelector('.note-history-menu');
        const historyButton = details.querySelector('#noteHistoryButton');
        if (historyMenu && !historyMenu.classList.contains('hidden')) historyMenu.classList.add('hidden');
        historyButton?.setAttribute('aria-expanded', 'false');
        details.open = false;
        if (restoreFocus) details.querySelector('summary')?.focus({ preventScroll: true });
      };
      platform.window.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || platform.document.querySelector('dialog[open], [aria-modal="true"]:not(.hidden)')) return;
        const number = Array.from({length:9}, (_,i) => i+1).find(n => actions.shortcuts.matches(event, `tab-${n}`)) || 0;
        const closing = actions.shortcuts.matches(event, 'tab-close');
        if ((!number && !closing) || bar.hidden || !bar.getClientRects().length || !state.activeId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || state.actionPending || state.batchPending || state.saving || platform.document.querySelector('dialog[open], [aria-modal="true"]:not(.hidden)')) return;
        hideMenu();
        if (closing) void actions.closeTab(state.activeId);
        else if (state.tabs[number - 1]) void actions.activate(state.tabs[number - 1].id);
      }, true);
      const menu = platform.document.createElement('div');
      menu.id = 'noteTabContextMenu';
      menu.className = 'note-tab-context-menu';
      menu.setAttribute('popover', 'manual');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', '标签操作');
      menu.innerHTML = '<button type="button" role="menuitem" data-tab-menu-action="others">关闭其他</button><button type="button" role="menuitem" data-tab-menu-action="current">关闭当前</button><button type="button" role="menuitem" data-tab-menu-action="all">关闭全部</button>';
      platform.document.body.append(menu);
      let contextTabId = null;
      const hideMenu = (restoreFocus = false) => {
        if (!menu.matches(':popover-open')) return;
        menu.hidePopover();
        if (restoreFocus) platform.document.getElementById(`noteTab-${contextTabId}`)?.focus({ preventScroll: true });
      };
      const showMenu = (tab, x, y) => {
        if (state.actionPending || state.batchPending || state.saving) return;
        contextTabId = tab.dataset.noteTab;
        menu.querySelector('[data-tab-menu-action="others"]').disabled = state.tabs.length < 2;
        menu.showPopover();
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(x, platform.window.innerWidth - bounds.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, platform.window.innerHeight - bounds.height - 8))}px`;
        // 只有一个标签时「关闭其他」不可用，焦点落在第一个能用的。
        menu.querySelector('button:not(:disabled)').focus({ preventScroll: true });
      };
      bar.addEventListener('contextmenu', event => {
        const tab = event.target.closest('.note-tab')?.querySelector('[data-note-tab]');
        if (!tab) return;
        event.preventDefault();
        showMenu(tab, event.clientX, event.clientY);
      });
      menu.onclick = async event => {
        const button = event.target.closest('[data-tab-menu-action]');
        if (!button || button.disabled) return;
        const id = contextTabId;
        hideMenu();
        await actions.closeGroup(button.dataset.tabMenuAction, id);
      };
      menu.onkeydown = event => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); hideMenu(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = items.indexOf(platform.document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      };
      platform.document.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target)) hideMenu();
        const more = $('#inlineMarkdownNoteForm .note-tab-more-control[open]');
        if (more && !more.contains(event.target)) closeMore(more);
      }, true);
      platform.document.addEventListener('click', event => {
        const more = event.target.closest('.note-tab-more-control[open]');
        const button = event.target.closest('.note-tab-more-menu button');
        if (more && button && button.id !== 'noteHistoryButton') closeMore(more, true);
      });
      platform.document.addEventListener('keydown', event => {
        const more = event.target.closest?.('.note-tab-more-control'); // 目标可能是 document 本身（没有 closest）
        if (!more || !more.open) return;
        if (event.key === 'Escape') {
          const historyMenu = more.querySelector('.note-history-menu');
          const historyButton = more.querySelector('#noteHistoryButton');
          if (historyMenu && !historyMenu.classList.contains('hidden')) {
            historyMenu.classList.add('hidden'); historyButton?.setAttribute('aria-expanded', 'false'); historyButton?.focus();
          } else closeMore(more, true);
          event.preventDefault(); event.stopPropagation();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          const items = [...more.querySelectorAll('.note-tab-more-menu button:not(:disabled)')].filter(button => button.getClientRects().length);
          if (!items.length) return;
          const index = items.indexOf(platform.document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next].focus(); event.preventDefault();
        } else if (event.key === 'Tab') closeMore(more);
      });
      platform.document.addEventListener('scroll', () => hideMenu(), true);
      platform.window.addEventListener('resize', () => hideMenu());
      platform.window.addEventListener('blur', () => hideMenu());
      bar.onclick = async event => {
        if (state.batchPending) return;
        hideMenu();
        const close = event.target.closest('[data-close-note-tab]');
        if (close) { await actions.closeTab(close.dataset.closeNoteTab); return; }
        const tab = event.target.closest('[data-note-tab]');
        if (tab) {
          const id = tab.dataset.noteTab, retainFocus = platform.document.activeElement === tab;
          if (await actions.activate(id) && retainFocus) platform.document.getElementById('noteTab-' + id)?.focus({ preventScroll: true });
          return;
        }
        if (event.target.closest('#newNoteTabButton')) await actions.requestNew(null, event.target.closest('#newNoteTabButton'));
      };
      bar.onkeydown = async event => {
        const tab = event.target.closest('[data-note-tab]'); if (!tab || state.actionPending || state.batchPending) return;
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
          event.preventDefault();
          const bounds = tab.getBoundingClientRect();
          showMenu(tab, bounds.left, bounds.bottom);
          return;
        }
        const index = state.tabs.findIndex(item => item.id === tab.dataset.noteTab);
        if (event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (actions.moveWorkspaceTab) {
            if (actions.moveWorkspaceTab(`note:${tab.dataset.noteTab}`, event.key === 'ArrowLeft' ? -1 : 1)) platform.document.getElementById('noteTab-' + tab.dataset.noteTab)?.focus();
            return;
          }
          const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
          if (next >= 0 && next < state.tabs.length && reorderNoteTabs(tab.dataset.noteTab, state.tabs[next].id, next > index)) platform.document.getElementById('noteTab-' + tab.dataset.noteTab)?.focus();
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Delete') { await actions.closeTab(tab.dataset.noteTab); return; }
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
        if (await actions.activate(state.tabs[next].id)) bar.querySelector('[aria-selected="true"]')?.focus();
      };
      bar.addEventListener('wheel', event => {
        const list = bar.querySelector('.note-tab-list');
        if (!list || list.scrollWidth <= list.clientWidth || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); list.scrollLeft += event.deltaY || event.deltaX;
      }, { passive: false });
    }
    return { mountNoteTabControls, renderNoteTabs, renderOpenTabsStrip, bindNoteTabWindowDrag, bindNoteTabs, reorderNoteTabs };
  }
  const api = { createNoteTabView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
