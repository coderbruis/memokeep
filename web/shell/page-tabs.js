(function expose(root) {
  function createPageTabFeatures({ state, config, actions, env }) {
    state.shell.pageTabs = [];
    state.shell.workspaceTabOrder = [];
    let bound = false;
    const currentView = () => config.$('.shell > .view:not(.hidden)')?.id.replace(/View$/, '');
    const escape = value => actions.escapeHtml(String(value)).replace(/"/g, '&quot;');

    function pageTabInfo(name) {
      if (config.isNoteWindow || typeof name !== 'string') return null;
      const id = actions.editionNavigationSection?.(name) || name;
      if (id === 'settings') return { id, view: id, label: '设置与偏好', icon: 'settings', available: true };
      const manifests = env.window.MemoKeepPlugins || [];
      if (id === 'plugins') return manifests.length ? { id, view: id, label: '插件', icon: 'puzzle', available: true } : null;
      const plugin = manifests.find(item => item.nav?.view === id);
      if (!plugin || !config.$(`#${name}View`)) return null;
      return { id, view: name, label: plugin.nav.label, icon: plugin.nav.icon, plugin: true,
        available: actions.isPluginEnabled?.(plugin.feature) !== false };
    }

    function rememberPageTab(name) {
      const info = pageTabInfo(name); if (!info) return;
      getWorkspaceTabOrder();
      const tab = state.shell.pageTabs.find(tab => tab.id === info.id);
      if (tab) tab.view = info.view;
      else state.shell.pageTabs.push({ id: info.id, view: info.view });
    }

    function restorePageTabs(saved) {
      const tabs = [], seen = new Set();
      for (const entry of Array.isArray(saved) ? saved.slice(0, 100) : []) {
        const info = pageTabInfo(entry?.view);
        if (!info || info.id !== entry.id || seen.has(info.id)) continue;
        seen.add(info.id); tabs.push({ id: info.id, view: info.view });
      }
      state.shell.pageTabs = tabs;
    }

    function getWorkspaceTabOrder() {
      const keys = [...state.shell.pageTabs.map(tab => `page:${tab.id}`), ...env.openNoteTabs.map(tab => `note:${tab.id}`)];
      const valid = new Set(keys), seen = new Set();
      state.shell.workspaceTabOrder = [...state.shell.workspaceTabOrder, ...keys].filter(key => {
        if (!valid.has(key) || seen.has(key)) return false;
        seen.add(key); return true;
      });
      return [...state.shell.workspaceTabOrder];
    }

    function syncTabModelOrder() {
      const positions = new Map(getWorkspaceTabOrder().map((key, index) => [key, index]));
      env.openNoteTabs.sort((a, b) => positions.get(`note:${a.id}`) - positions.get(`note:${b.id}`));
      state.shell.pageTabs.sort((a, b) => positions.get(`page:${a.id}`) - positions.get(`page:${b.id}`));
    }

    function restoreWorkspaceTabOrder(saved) {
      state.shell.workspaceTabOrder = Array.isArray(saved) ? saved.filter(key => typeof key === 'string') : [];
      syncTabModelOrder();
    }

    function orderWorkspaceTabs(items) {
      const positions = new Map(getWorkspaceTabOrder().map((key, index) => [key, index]));
      return [...items].sort((a, b) => positions.get(a.key) - positions.get(b.key));
    }

    const tabActionPending = () => Boolean(state.shell.pageTabPending || env.noteTabActionPending || env.noteTabBatchPending || state.persistence.dataSavePending);

    function reorderWorkspaceTabs(sourceKey, targetKey, after = false) {
      if (tabActionPending() || sourceKey === targetKey) return false;
      const order = getWorkspaceTabOrder(), from = order.indexOf(sourceKey);
      if (from < 0 || !order.includes(targetKey)) return false;
      order.splice(from, 1); order.splice(order.indexOf(targetKey) + (after ? 1 : 0), 0, sourceKey);
      if (order.every((key, index) => key === state.shell.workspaceTabOrder[index])) return false;
      state.shell.workspaceTabOrder = order; syncTabModelOrder();
      renderPageTabs(); actions.rememberOpenNotes?.();
      return true;
    }

    function moveWorkspaceTab(key, direction) {
      const order = getWorkspaceTabOrder(), index = order.indexOf(key), target = index + direction;
      return index >= 0 && target >= 0 && target < order.length && reorderWorkspaceTabs(key, order[target], direction > 0);
    }

    function tabMarkup(tab, active) {
      const info = pageTabInfo(tab.view); if (!info) return '';
      const label = `${info.plugin ? '插件 › ' : ''}${info.label}`;
      const title = info.available ? label : `${label}（已停用，点击管理插件）`;
      const disabled = tabActionPending() ? ' disabled' : '';
      return `<div class="workspace-page-tab${active === tab.id ? ' is-active' : ''}${info.available ? '' : ' is-unavailable'}" draggable="true" data-workspace-tab-key="page:${escape(tab.id)}" title="拖动排序；Alt + Shift + 左右方向键调整位置"><button type="button" class="workspace-page-tab-select" data-open-page-tab="${escape(tab.id)}" role="tab" aria-selected="${active === tab.id}" aria-controls="${escape(tab.view)}View" title="${escape(title)}"${disabled}><svg aria-hidden="true"><use href="#icon-${escape(info.icon)}"></use></svg><span class="workspace-page-tab-label">${escape(label)}</span>${info.available ? '' : '<small class="workspace-page-tab-state">已停用</small>'}</button><button type="button" class="workspace-page-tab-close" data-close-page-tab="${escape(tab.id)}" aria-label="关闭标签：${escape(label)}" title="关闭标签"${disabled}><svg aria-hidden="true"><use href="#icon-x"></use></svg></button></div>`;
    }

    function workspacePageTabItems() {
      const active = pageTabInfo(currentView())?.id;
      return state.shell.pageTabs.map(tab => ({ key: `page:${tab.id}`, markup: tabMarkup(tab, active) })).filter(item => item.markup);
    }

    function syncPageTabChrome() {
      const top = config.$('#workspacePageTabs'), shell = config.$('.shell');
      if (!shell || config.isNoteWindow) return;
      const view = currentView(), info = pageTabInfo(view);
      const active = state.shell.pageTabs.some(tab => tab.id === info?.id) ? info.id : null;
      if (active) shell.dataset.pageTabActive = active; else delete shell.dataset.pageTabActive;
      shell.dataset.pageTabs = String(state.shell.pageTabs.length > 0);
      if (top) { top.hidden = true; if (top.childElementCount) top.replaceChildren(); }
      config.$('#noteTabsBar .note-page-tabs')?.remove();
      bindPageTabs();
    }

    function renderPageTabs() {
      syncPageTabChrome();
      env.application?.views.tabs?.renderNoteTabs();
    }

    function refreshTabs() {
      renderPageTabs(); actions.rememberOpenNotes?.();
    }

    async function runPageTabAction(run) {
      if (state.shell.pageTabPending || env.noteTabActionPending || env.noteTabBatchPending || state.persistence.dataSavePending) return false;
      state.shell.pageTabPending = true; refreshTabs();
      try { return await run(); }
      catch (error) { actions.showToast(error.message || '标签切换失败，请再试一次', true); return false; }
      finally { state.shell.pageTabPending = false; refreshTabs(); }
    }

    async function leaveCurrentPage() {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
      if (currentView() === 'freeReview') await actions.finishActiveFreeReview?.();
      return true;
    }

    function openPageTab(id) {
      return runPageTabAction(async () => {
        const tab = state.shell.pageTabs.find(tab => tab.id === id), info = tab && pageTabInfo(tab.view);
        if (!info || !await leaveCurrentPage()) return false;
        if (info.available) actions.showView(tab.view);
        else {
          actions.showView('plugins'); actions.renderPlugins?.({ tab: 'mine' });
          actions.showToast(`「${info.label}」已停用，可在插件管理中启用`);
        }
        return true;
      });
    }

    function closePageTab(id) {
      return runPageTabAction(async () => {
        const tabs = state.shell.pageTabs, index = tabs.findIndex(tab => tab.id === id);
        if (index < 0) return false;
        if (pageTabInfo(currentView())?.id === id) {
          if (!await leaveCurrentPage()) return false;
          const order = getWorkspaceTabOrder(), position = order.indexOf(`page:${id}`);
          const candidates = [...order.slice(position + 1), ...order.slice(0, position).reverse()];
          const next = candidates.find(key => key.startsWith('page:')
            ? pageTabInfo(tabs.find(tab => `page:${tab.id}` === key)?.view)?.available
            : env.openNoteTabs.some(tab => `note:${tab.id}` === key && (tab.draftDocument || actions.documentById(tab.id))));
          if (next?.startsWith('page:')) actions.showView(tabs.find(tab => `page:${tab.id}` === next).view);
          else if (next) { if (!await env.activateNoteTab(next.slice(5))) return false; }
          else actions.showView('home');
        }
        state.shell.pageTabs = tabs.filter(tab => tab.id !== id);
        return true;
      });
    }

    function bindPageTabs() {
      if (bound) return; bound = true;
      env.document.addEventListener('click', event => {
        const button = event.target.closest('[data-open-page-tab], [data-close-page-tab]');
        if (!button || button.disabled) return;
        event.preventDefault();
        if (button.dataset.closePageTab) void closePageTab(button.dataset.closePageTab);
        else void openPageTab(button.dataset.openPageTab);
      });
      env.document.addEventListener('keydown', event => {
        const tab = event.target.closest?.('[data-open-page-tab], [data-open-tab]');
        if (!tab || !event.altKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const key = tab.parentElement.dataset.workspaceTabKey, host = tab.closest('#noteTabsBar, #workspaceOpenTabs');
        if (moveWorkspaceTab(key, event.key === 'ArrowLeft' ? -1 : 1)) {
          Array.from(host.querySelectorAll('[data-workspace-tab-key]')).find(row => row.dataset.workspaceTabKey === key)?.querySelector('[role="tab"], [data-open-tab]')?.focus();
        }
      });
      bindWorkspaceTabDrag();
    }

    function bindWorkspaceTabDrag() {
      let draggedKey = null;
      const row = event => {
        const tab = event.target.closest?.('[data-workspace-tab-key]');
        return tab?.parentElement.matches('.note-tab-list, .workspace-open-tabs-list') ? tab : null;
      };
      const clearTargets = () => env.document.querySelectorAll('.is-workspace-tab-drop-target').forEach(tab => tab.classList.remove('is-workspace-tab-drop-target', 'is-workspace-tab-drop-after'));
      const clear = () => { draggedKey = null; clearTargets(); };
      const after = (event, tab) => { const bounds = tab.getBoundingClientRect(); return event.clientX >= bounds.left + bounds.width / 2; };
      env.document.addEventListener('dragstart', event => {
        const tab = row(event); if (!tab) return;
        if (tabActionPending() || event.target.closest('[data-close-page-tab], [data-close-note-tab], [data-close-open-tab]')) { event.preventDefault(); return; }
        draggedKey = tab.dataset.workspaceTabKey;
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-memokeep-workspace-tab', draggedKey);
      });
      env.document.addEventListener('dragover', event => {
        const tab = row(event); if (!draggedKey || !tab || tabActionPending()) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        clearTargets(); tab.classList.add('is-workspace-tab-drop-target'); tab.classList.toggle('is-workspace-tab-drop-after', after(event, tab));
        const list = tab.parentElement, bounds = list.getBoundingClientRect();
        if (event.clientX < bounds.left + 28) list.scrollLeft -= 24;
        else if (event.clientX > bounds.right - 28) list.scrollLeft += 24;
      });
      env.document.addEventListener('drop', event => {
        const tab = row(event); if (!draggedKey || !tab) return;
        event.preventDefault(); reorderWorkspaceTabs(draggedKey, tab.dataset.workspaceTabKey, after(event, tab)); clear();
      });
      env.document.addEventListener('dragend', clear);
    }
    return { pageTabInfo, rememberPageTab, restorePageTabs, renderPageTabs, syncPageTabChrome, workspacePageTabItems,
      getWorkspaceTabOrder, restoreWorkspaceTabOrder, orderWorkspaceTabs, reorderWorkspaceTabs, moveWorkspaceTab, openPageTab, closePageTab };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createPageTabFeatures });
})(globalThis);
