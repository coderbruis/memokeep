(function expose(root) {
  function createShellFeatures({ state, config, actions, env }) {
    function applySidebarCollapsedState() {
      config.$('.shell')?.classList.toggle('sidebar-collapsed', state.shell.sidebarCollapsed);
      const button = config.$('#sidebarCollapseBtn');
      if (!button) return;
      const label = state.shell.sidebarCollapsed ? '展开侧栏' : '收起侧栏';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-expanded', String(!state.shell.sidebarCollapsed));
      const tooltip = button.querySelector('[role="tooltip"]');
      if (tooltip) tooltip.textContent = label;
    }

    function toggleSidebarCollapsed() {
      state.shell.sidebarCollapsed = !state.shell.sidebarCollapsed;
      env.localStorage.setItem(config.SIDEBAR_COLLAPSED_KEY, String(state.shell.sidebarCollapsed));
      actions.applySidebarCollapsedState();
    }

    function showToast(message, error = false) {
      const toast = config.$('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.classList.remove('hidden');
      env.clearTimeout(actions.showToast.timer); actions.showToast.timer = env.setTimeout(() => toast.classList.add('hidden'), 3200);
    }

    async function copyTextToClipboard(text, successMessage = '已复制') {
      const value = String(text || '');
      if (!value) return false;
      try {
        await env.navigator.clipboard.writeText(value);
      } catch {
        const input = env.document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        env.document.body.appendChild(input);
        input.select();
        env.document.execCommand('copy');
        input.remove();
      }
      actions.showToast(successMessage);
      return true;
    }

    async function showConfirmDialog({
      title,
      message,
      confirmLabel = '删除',
      tone = 'danger',
      icon = tone === 'danger' ? 'trash' : 'alert-triangle'
    }) {
      if (state.shell.confirmDialogClosing) await state.shell.confirmDialogClosing;
      const dialog = config.$('#appConfirmDialog');
      if (dialog.open) await new Promise(resolve => { dialog.addEventListener('close', resolve, { once: true }); dialog.close(); });
      dialog.classList.remove('unsaved-note-dialog');
      config.$('#appConfirmTitle').textContent = title;
      config.$('#appConfirmMessage').textContent = message;
      config.$('#appConfirmIcon').setAttribute('href', `#icon-${icon}`);
      config.$('#appConfirmIconWrap').className = `app-confirm-icon ${tone}`;
      const submitButton = config.$('#appConfirmSubmit');
      config.$('#appConfirmExtra').classList.add('hidden');
      submitButton.className = `app-confirm-submit ${tone}`;
      submitButton.querySelector('use').setAttribute('href', `#icon-${icon}`);
      submitButton.querySelector('span').textContent = confirmLabel;

      return new Promise(resolve => {
        let settled = false;
        const finish = confirmed => {
          if (settled) return;
          settled = true;
          if (!dialog.open) { resolve(confirmed); return; }
          // A queued close event must finish before another confirmation reuses this dialog.
          const closing = new Promise(resolveClose => {
            dialog.addEventListener('close', () => {
              if (state.shell.confirmDialogClosing === closing) state.shell.confirmDialogClosing = null;
              resolveClose(); resolve(confirmed);
            }, { once: true });
          });
          state.shell.confirmDialogClosing = closing;
          dialog.close();
        };
        config.$('#appConfirmSubmit').onclick = () => finish(true);
        config.$('#appConfirmCancel').onclick = () => finish(false);
        config.$('#appConfirmClose').onclick = () => finish(false);
        dialog.oncancel = event => {
          event.preventDefault();
          finish(false);
        };
        dialog.onclose = () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };
        dialog.showModal();
        env.requestAnimationFrame(() => config.$('#appConfirmCancel').focus());
      });
    }

    function showUnsavedNoteDialog(documentId = state.editor.editingMarkdownDocumentId) {
      const dialog = config.$('#appConfirmDialog');
      if (dialog.open) dialog.close();
      dialog.classList.add('unsaved-note-dialog');
      config.$('#appConfirmTitle').textContent = '保存笔记更改？';
      const name = documentId === state.editor.editingMarkdownDocumentId ? config.$('#inlineMarkdownNoteTitle')?.value : actions.documentById(documentId)?.title;
      config.$('#appConfirmMessage').textContent = env.noteDraftTab(documentId)
      ? `“${name || '未命名笔记'}”尚未保存。保存后会加入左侧目录，选择不保存将丢弃这份草稿。`
      : '当前笔记有尚未保存的修改。保存后才会生成新的历史版本。';
      config.$('#appConfirmIcon').setAttribute('href', '#icon-history');
      config.$('#appConfirmIconWrap').className = 'app-confirm-icon';
      const submitButton = config.$('#appConfirmSubmit');
      submitButton.className = 'app-confirm-submit';
      submitButton.querySelector('use').setAttribute('href', '#icon-check');
      submitButton.querySelector('span').textContent = '保存';
      const extraButton = config.$('#appConfirmExtra');
      extraButton.textContent = '不保存';
      extraButton.classList.remove('hidden');
      return new Promise(resolve => {
        let settled = false;
        const finish = action => {
          if (settled) return;
          settled = true;
          extraButton.classList.add('hidden');
          // Finish the close event before a batch opens the next confirmation.
          if (dialog.open) {
            dialog.addEventListener('close', () => resolve(action), { once: true });
            dialog.close();
          } else resolve(action);
        };
        submitButton.onclick = () => finish('save');
        extraButton.onclick = () => finish('discard');
        config.$('#appConfirmCancel').onclick = () => finish('cancel');
        config.$('#appConfirmClose').onclick = () => finish('cancel');
        dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
        dialog.onclose = () => { if (!settled) finish('cancel'); };
        dialog.showModal();
        env.requestAnimationFrame(() => submitButton.focus());
      });
    }

    function syncSidebarSelection() {
      const view = config.$('.shell > .view:not(.hidden)')?.id;
      // Card notebooks share the note editor view, but belong to the cards navigation.
      const cardEditor = view === 'librariesView' && Boolean(state.editor.editingCardNotebookId && state.editor.editingMarkdownDocumentId);
      const section = cardEditor ? 'cards' : view?.replace(/View$/, '');
      const select = (button, className, selected) => {
        button.classList.toggle(className, selected);
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      };
      const navSection = actions.editionNavigationSection?.(section) || section;
      config.$$('.nav').forEach(button => select(button, 'active', button.dataset.view === navSection));
      config.$$('#sidebarPluginManage, #sidebarFootSettings').forEach(button => select(button, 'active',
      button.id === 'sidebarPluginManage' ? section === 'plugins' : button.dataset.viewLink === section));
      actions.syncPluginNavigation?.();
      actions.syncEditionNavigation?.(section);
      config.$$('#knowledgeTree [data-tree-library]').forEach(button => select(button, 'active',
      section === 'libraries' && !env.selectedNoteTagId && !state.editor.editingMarkdownDocumentId && button.dataset.treeLibrary === state.knowledge.selectedLibraryId));
      config.$$('#knowledgeTree [data-tree-document]').forEach(button => select(button, 'active',
      section === 'libraries' && button.dataset.treeDocument === state.editor.editingMarkdownDocumentId));
      env.syncNoteTagSelection(section);
      const scope = cardEditor ? { type: 'notebook', id: state.editor.editingCardNotebookId } : env.application.cards.runtime.cardScope;
      config.$$('#cardTree [data-card-scope]').forEach(button => {
        const selected = section === 'cards' && button.dataset.cardScope === scope.type && button.dataset.scopeId === scope.id;
        select(button, 'active', selected);
        button.closest('.card-tree-row').classList.toggle('selected', selected);
      });
      actions.syncLocateCurrentNoteButton?.();
    }

    function showView(name) {
      if (actions.pluginViewAvailable?.(name) === false) name = 'home';
      actions.rememberPageTab?.(name);
      const leaving = actions.beforeEditionViewChange?.(name);
      if (leaving?.catch) void leaving.catch(error => actions.showToast(error.message, true));
      config.$$('.view').forEach(view => view.classList.add('hidden'));
      config.$(`#${name}View`)?.classList.remove('hidden');
      if (name === 'trash') actions.renderTrash();
      if (name === 'home') actions.renderHome();
      if (name === 'libraries') actions.renderLibraries();
      if (name === 'cards') {
        env.application.views.cards.render();
        // 打开卡片页时同步一次知识点（要点删掉的卡片不再出现）。
        actions.syncKnowledgePoints?.().then(changed => { if (changed && !config.$('#cardsView').classList.contains('hidden')) env.application.views.cards.render(); });
      }
      if (name === 'memos') actions.renderMemos();
      if (name === 'favorites') actions.renderFavorites?.();
      if (name === 'plans') actions.renderPlans?.();
      if (name === 'plugins') actions.renderPlugins?.();
      actions.renderEditionPage?.(name);
      if (name === 'growth') actions.renderEngagement?.();
      if (name === 'learning') actions.renderLearningHub?.();
      if (name === 'settings') { actions.initializeReminderIntervalPicker(); actions.renderSettings(); }
      actions.syncSidebarSelection();
      actions.renderPlanNav?.();
      env.application.views.tabs?.renderOpenTabsStrip?.();
      actions.rememberOpenNotes?.();
      void actions.markPluginSeen?.(name);
    }

    async function copyInviteText() {
      const message = '我正在使用 MemoKeep，把学过的知识变成长期记忆。一起试试吧！';
      try {
        await env.navigator.clipboard.writeText(message);
        actions.showToast('邀请文案已复制，可以发给好友了');
      } catch {
        const input = env.document.createElement('textarea');
        input.value = message; env.document.body.appendChild(input); input.select();
        env.document.execCommand('copy'); input.remove();
        actions.showToast('邀请文案已复制，可以发给好友了');
      }
    }

    function homeLearningPlan() {
      if (env.MemoKeepDomain.buildLearningPlan) return env.MemoKeepDomain.buildLearningPlan(state.persistence.data, config.now());
      const ids = actions.dueCards().map(card => card.id);
      return { ids, ready: ids, totalDue: ids.length, minutes: 5, newLimit: 3, dueCount: ids.length, newCount: 0, estimatedMinutes: Math.ceil(ids.length * 25 / 60) };
    }

    // 「今天」页由 web/shell/today.js 绘制；保留这个名字给已有的调用方。
    function renderHomeLearningPlan() { actions.renderToday?.(); }

    async function openWorkspaceNote(id, history = false) {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
      const doc = actions.documentById(id);
      if (!doc) { actions.showToast('这篇笔记已移除', true); return false; }
      state.knowledge.selectedLibraryId = doc.knowledgeBaseId;
      const notebook = (state.persistence.data.cardNotebooks || []).find(note => note.sourceDocumentId === doc.id);
      await actions.openMarkdownNoteEditor(doc, '', null, notebook?.id || null);
      if (history) config.$('#noteHistoryButton')?.click();
      return true;
    }

    async function openAppearanceSettings() {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
      actions.showView('settings');
      config.$('[data-settings-panel="appearance"]')?.click();
      config.$('[data-appearance-mode]')?.focus({ preventScroll: true });
    }

    function openStudyPlanSettings() {
      const plan = actions.homeLearningPlan(), form = config.$('#studyPlanForm');
      form.elements.minutes.value = plan.minutes;
      form.elements.newLimit.value = plan.newLimit;
      config.$('#studyPlanError').textContent = '';
      config.$('#studyPlanDialog').showModal();
    }

    async function saveStudyPreferences(minutes, limit) {
      if (state.shell.studyPreferencesPending) return false;
      state.shell.studyPreferencesPending = true;
      config.$$('[data-study-minutes], #studyPlanForm button').forEach(button => { button.disabled = true; });
      try {
        await env.application.operations.settings.setStudyPreferences(minutes, limit);
        actions.renderHome();
        config.$('#studyPlanDialog').close();
        return true;
      } catch (error) { config.$('#studyPlanError').textContent = error.message || '保存失败，请重试'; return false; }
      finally { state.shell.studyPreferencesPending = false; config.$$('[data-study-minutes], #studyPlanForm button').forEach(button => { button.disabled = false; }); }
    }

    function openWorkspaceHistory() {
      const docs = [...state.persistence.data.documents, ...(state.persistence.data.cardDocuments || [])].filter(doc => doc.metadata?.versions?.length).sort((a, b) => new Date(b.metadata.versions[0].savedAt) - new Date(a.metadata.versions[0].savedAt));
      config.$('#workspaceHistoryNotes').innerHTML = docs.map(doc => `<button type="button" data-open-history-note="${actions.escapeHtml(doc.id)}"><strong>${actions.escapeHtml(doc.title)}</strong><small>${doc.metadata.versions.length} 个已保存版本</small></button>`).join('') || '<p class="hint">暂无历史版本</p>';
      config.$('#workspaceHistoryDialog').showModal();
    }

    const WORKSPACE_SEARCH_KINDS = {
      note: { label: '笔记', icon: 'icon-file-text' },
      notebook: { label: '卡片笔记', icon: 'icon-book-open-text' },
      card: { label: '复习卡片', icon: 'icon-layers' },
      memo: { label: '备忘录', icon: 'icon-circle-check' }
    };
    const WORKSPACE_SEARCH_GROUP_LIMIT = 3;

    function workspaceSearchTerms(query) {
      return String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    }

    function highlightWorkspaceSearch(text, terms) {
      const value = String(text || '');
      if (!terms.length) return actions.escapeHtml(value);
      const pattern = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
      let html = '', last = 0;
      value.replace(pattern, (match, index) => { html += actions.escapeHtml(value.slice(last, index)) + `<mark>${actions.escapeHtml(value.slice(index, index + match.length))}</mark>`; last = index + match.length; return match; });
      return html + actions.escapeHtml(value.slice(last));
    }

    // 摘要从第一个命中位置附近截取，保证关键词出现在摘要里。
    function workspaceSearchSnippet(text, terms) {
      const value = String(text || '').trim(), lower = value.normalize('NFKC').toLocaleLowerCase(), length = 96;
      const hits = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
      const hit = hits.length ? Math.min(...hits) : 0;
      let start = 0;
      if (hit >= 24) {
        start = hit - 18;
        const windowStart = Math.max(0, hit - 30), cut = value.slice(windowStart, hit).search(/[，。；：、！？,.;:!?\s][^，。；：、！？,.;:!?\s]*$/);
        if (cut >= 0) start = windowStart + cut + 1;
      }
      const body = highlightWorkspaceSearch(value.slice(start, start + length), terms);
      return `${start ? '…' : ''}${body}${start + length < value.length ? '…' : ''}`;
    }

    function workspaceSearchRow(entry, index, terms, compact = false) {
      const kind = WORKSPACE_SEARCH_KINDS[entry.kind] || WORKSPACE_SEARCH_KINDS.note;
      const icon = compact ? 'icon-clock' : kind.icon;
      return `<button type="button" class="product-search-item${compact ? ' is-compact' : ''}" role="option" id="workspaceSearchOption${index}" data-workspace-search-index="${index}" aria-selected="false">`
        + `<span class="product-search-kind" aria-hidden="true"><svg><use href="#${icon}"></use></svg></span>`
        + `<span class="product-search-title"><strong>${highlightWorkspaceSearch(entry.title, terms)}</strong>${entry.path ? `<small>${highlightWorkspaceSearch(entry.path, terms)}</small>` : ''}<span class="sr-only">，${kind.label}</span></span>`
        + (compact ? '' : `<span class="product-search-snippet">${workspaceSearchSnippet(entry.excerpt ?? entry.text, terms)}</span>`)
        + '<span class="product-search-enter" aria-hidden="true"><svg><use href="#icon-corner-down-left"></use></svg>打开</span></button>';
    }

    function openWorkspaceSearch() {
      const dialog = config.$('#workspaceSearchDialog');
      config.$('#workspaceSearchQuery').value = '';
      state.shell.workspaceSearchScope = 'all';
      state.shell.workspaceSearchActive = 0;
      actions.renderWorkspaceSearch();
      dialog.showModal();
      config.$('#workspaceSearchQuery').focus();
    }

    function renderWorkspaceSearch() {
      const query = config.$('#workspaceSearchQuery').value, terms = workspaceSearchTerms(query), list = config.$('#workspaceSearchResults');
      const scopes = config.$('#workspaceSearchScopes'), count = config.$('#workspaceSearchCount');
      state.shell.workspaceSearchRenderedQuery = query;
      config.$('#workspaceSearchClear').hidden = !query;
      if (!terms.length) {
        const libraries = state.persistence.data.knowledgeBases || [];
        const entries = [...state.persistence.data.documents].sort((a, b) => new Date(b.updatedAt || b.importedAt || 0) - new Date(a.updatedAt || a.importedAt || 0)).slice(0, 5)
          .map(doc => ({ kind: 'note', id: doc.id, title: doc.title || '未命名笔记', path: env.MemoKeepDirectoryTree?.label(libraries, doc.knowledgeBaseId) || '' }));
        state.shell.workspaceSearchEntries = entries;
        state.shell.workspaceSearchActive = Math.min(state.shell.workspaceSearchActive || 0, Math.max(0, entries.length - 1));
        scopes.hidden = true; config.$('#workspaceSearchTabHint').hidden = true; count.textContent = '';
        list.innerHTML = (entries.length ? `<div class="product-search-group" role="group" aria-label="最近打开"><div class="product-search-group-label">最近打开</div>${entries.map((entry, index) => workspaceSearchRow(entry, index, [], true)).join('')}</div>` : '')
          + '<p class="product-search-tips"><span>多个关键词用空格分开，如 <code>接口 超时</code></span><span>同时搜索标题、正文和标签</span></p>';
        return actions.syncWorkspaceSearchActive();
      }
      const all = env.MemoKeepDomain.searchContent(state.persistence.data, query);
      if (state.shell.workspaceSearchScope !== 'all' && !all.some(entry => entry.kind === state.shell.workspaceSearchScope)) state.shell.workspaceSearchScope = 'all';
      const scope = state.shell.workspaceSearchScope || 'all';
      scopes.hidden = !all.length;
      config.$('#workspaceSearchTabHint').hidden = !all.length;
      scopes.innerHTML = [['all', '全部', all.length], ...Object.entries(WORKSPACE_SEARCH_KINDS).map(([kind, meta]) => [kind, meta.label, all.filter(entry => entry.kind === kind).length])]
        .map(([kind, label, total]) => `<button type="button" class="product-search-scope" role="tab" data-workspace-search-scope="${kind}" aria-selected="${scope === kind}" tabindex="-1"${kind !== 'all' && !total ? ' disabled' : ''}>${label}<b>${total}</b></button>`).join('');
      const shown = scope === 'all' ? all : all.filter(entry => entry.kind === scope);
      count.textContent = `${shown.length} 个结果`;
      if (!shown.length) {
        const title = query.trim().slice(0, 100);
        state.shell.workspaceSearchEntries = [{ kind: 'create', title }];
        state.shell.workspaceSearchActive = 0;
        list.innerHTML = `<div class="product-search-empty"><h3>没有找到「${actions.escapeHtml(title)}」</h3><p>试试更短的关键词，或去掉其中一个词。</p>`
          + `<button type="button" class="product-search-create" role="option" id="workspaceSearchOption0" data-workspace-search-index="0" aria-selected="true"><svg aria-hidden="true"><use href="#icon-plus"></use></svg>新建笔记「${actions.escapeHtml(title)}」</button></div>`;
        return actions.syncWorkspaceSearchActive();
      }
      const entries = [];
      let html = '';
      for (const [kind, meta] of Object.entries(WORKSPACE_SEARCH_KINDS)) {
        const group = shown.filter(entry => entry.kind === kind);
        if (!group.length) continue;
        const visible = scope === 'all' ? group.slice(0, WORKSPACE_SEARCH_GROUP_LIMIT) : group;
        const more = group.length > visible.length ? `<button type="button" class="product-search-more" data-workspace-search-scope="${kind}" tabindex="-1">查看全部 ${group.length} 个</button>` : '';
        html += `<div class="product-search-group" role="group" aria-label="${meta.label}"><div class="product-search-group-label"><span>${meta.label}</span>${more}</div>`;
        visible.forEach(entry => { html += workspaceSearchRow(entry, entries.length, terms); entries.push(entry); });
        html += '</div>';
      }
      state.shell.workspaceSearchEntries = entries;
      state.shell.workspaceSearchActive = Math.min(state.shell.workspaceSearchActive || 0, entries.length - 1);
      list.innerHTML = html;
      actions.syncWorkspaceSearchActive();
    }

    function syncWorkspaceSearchActive(scroll = true) {
      const active = state.shell.workspaceSearchActive || 0;
      let current = null;
      config.$$('#workspaceSearchResults [data-workspace-search-index]').forEach(option => {
        const selected = Number(option.dataset.workspaceSearchIndex) === active;
        option.setAttribute('aria-selected', String(selected));
        if (selected) current = option;
      });
      const input = config.$('#workspaceSearchQuery');
      if (current) input.setAttribute('aria-activedescendant', current.id); else input.removeAttribute('aria-activedescendant');
      if (scroll) current?.scrollIntoView({ block: 'nearest' });
    }

    function setWorkspaceSearchScope(scope) {
      state.shell.workspaceSearchScope = scope;
      state.shell.workspaceSearchActive = 0;
      actions.renderWorkspaceSearch();
      config.$('#workspaceSearchResults').scrollTop = 0;
      config.$('#workspaceSearchQuery').focus();
    }

    async function openWorkspaceSearchResult(index) {
      const entry = state.shell.workspaceSearchEntries?.[index];
      if (!entry) return;
      config.$('#workspaceSearchDialog').close();
      if (entry.kind === 'note') { await actions.openWorkspaceNote(entry.id); return; }
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
      if (entry.kind === 'create') {
        actions.showView('libraries');
        if (!state.persistence.data.knowledgeBases.length) { actions.openLibraryDialog(); return; }
        const libraryId = env.application.state.knowledge.libraryById(state.knowledge.selectedLibraryId)?.id || state.persistence.data.knowledgeBases[0].id;
        state.knowledge.selectedLibraryId = libraryId;
        await env.createNoteTab({ kind: 'knowledge', libraryId, title: entry.title });
        return;
      }
      if (entry.kind === 'notebook') env.openCardNotebookView(entry.id);
      if (entry.kind === 'card') { actions.showView('cards'); env.application.views.cardDetail.openCardDetail(env.application.state.cards.byId(entry.id)); }
      if (entry.kind === 'memo') { actions.showView('memos'); await actions.openMemoDialog(env.application.state.memos.byId(entry.id)); }
    }

    function bindWorkspaceSearch() {
      const input = config.$('#workspaceSearchQuery'), list = config.$('#workspaceSearchResults'), dialog = config.$('#workspaceSearchDialog');
      if (!input || !list || !dialog) return;
      const rerender = () => { state.shell.workspaceSearchActive = 0; actions.renderWorkspaceSearch(); list.scrollTop = 0; };
      input.oninput = () => { env.clearTimeout(state.shell.workspaceSearchTimer); state.shell.workspaceSearchTimer = env.setTimeout(rerender, 100); };
      config.$('#workspaceSearchClear').onclick = () => { input.value = ''; env.clearTimeout(state.shell.workspaceSearchTimer); rerender(); input.focus(); };
      config.$('#workspaceSearchScopes').addEventListener('click', event => { const button = event.target.closest('[data-workspace-search-scope]'); if (button && !button.disabled) actions.setWorkspaceSearchScope(button.dataset.workspaceSearchScope); });
      list.addEventListener('click', event => {
        const scope = event.target.closest('[data-workspace-search-scope]');
        if (scope) { actions.setWorkspaceSearchScope(scope.dataset.workspaceSearchScope); return; }
        const button = event.target.closest('[data-workspace-search-index]');
        if (button) void actions.openWorkspaceSearchResult(Number(button.dataset.workspaceSearchIndex));
      });
      list.addEventListener('mousemove', event => {
        const button = event.target.closest('[data-workspace-search-index]');
        if (!button || Number(button.dataset.workspaceSearchIndex) === state.shell.workspaceSearchActive) return;
        state.shell.workspaceSearchActive = Number(button.dataset.workspaceSearchIndex);
        actions.syncWorkspaceSearchActive(false);
      });
      // 焦点始终留在输入框，↑↓ 只移动当前项。
      input.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        const total = state.shell.workspaceSearchEntries?.length || 0;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!total) return;
          state.shell.workspaceSearchActive = ((state.shell.workspaceSearchActive || 0) + (event.key === 'ArrowDown' ? 1 : -1) + total) % total;
          actions.syncWorkspaceSearchActive();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          env.clearTimeout(state.shell.workspaceSearchTimer);
          if (input.value !== state.shell.workspaceSearchRenderedQuery) rerender();
          void actions.openWorkspaceSearchResult(state.shell.workspaceSearchActive || 0);
        } else if (event.key === 'Tab' && !config.$('#workspaceSearchScopes').hidden) {
          event.preventDefault();
          const tabs = [...config.$$('#workspaceSearchScopes [data-workspace-search-scope]:not([disabled])')];
          const current = tabs.findIndex(tab => tab.dataset.workspaceSearchScope === (state.shell.workspaceSearchScope || 'all'));
          actions.setWorkspaceSearchScope(tabs[(current + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length].dataset.workspaceSearchScope);
        } else if (event.key === 'Escape' && input.value) {
          event.preventDefault();
          input.value = ''; env.clearTimeout(state.shell.workspaceSearchTimer); rerender();
        }
      });
    }

    function bindProductNavigation() {
      const shortcut = config.$('#workspaceSearchButton kbd');
      if (shortcut) shortcut.textContent = config.desktop?.platform === 'darwin' || /Mac/.test(env.navigator.platform || '') ? '⌘ K' : 'Ctrl K';
      const bind = (selector, callback) => { const button = config.$(selector); if (button) button.onclick = callback; };
      bind('#workspaceSearchButton', actions.openWorkspaceSearch);
      bind('#sidebarAppearanceBtn', actions.openAppearanceSettings);
      bind('#workspaceFavoritesBtn', () => actions.openFavoriteNotes());
      bind('#sidebarHistoryBtn', actions.openWorkspaceHistory);
      bind('#studyPlanSettingsBtn', actions.openStudyPlanSettings);
      bind('#homeNewNoteBtn', async () => {
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.showView('libraries');
        if (!state.persistence.data.knowledgeBases.length) actions.openLibraryDialog();
        else { state.knowledge.selectedLibraryId ||= state.persistence.data.knowledgeBases[0].id; await env.createNoteTab({ kind: 'knowledge', libraryId: state.knowledge.selectedLibraryId }); }
      });
      config.$$('[data-study-minutes]').forEach(button => { button.onclick = () => actions.saveStudyPreferences(Number(button.dataset.studyMinutes), actions.homeLearningPlan().newLimit); });
      config.$('#studyPlanForm')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; actions.saveStudyPreferences(Number(form.elements.minutes.value), Number(form.elements.newLimit.value)); });
      actions.bindWorkspaceSearch();
      env.document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing && state.persistence.applicationDataReady && !env.document.querySelector('dialog[open]')) { event.preventDefault(); actions.openWorkspaceSearch(); } });
      config.$('#homeRecentNotes')?.addEventListener('click', event => { const button = event.target.closest('[data-open-recent-note]'); if (button) void actions.openWorkspaceNote(button.dataset.openRecentNote); });
      config.$('#workspaceHistoryNotes')?.addEventListener('click', event => { const button = event.target.closest('[data-open-history-note]'); if (button) { config.$('#workspaceHistoryDialog').close(); void actions.openWorkspaceNote(button.dataset.openHistoryNote, true); } });
    }

    function renderHome(summary = null) {
      actions.renderToday?.(summary);
      actions.renderEngagementSummary?.();
    }

    function inlineCardLineDeleteRange(content, lineIndex) {
      const lines = content.split('\n');
      if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length || !env.application.domain.parseInlineCardLine(lines[lineIndex])) return null;
      const start = lines.slice(0, lineIndex).reduce((total, line) => total + line.length + 1, 0);
      return lineIndex < lines.length - 1
      ? { start, end: start + lines[lineIndex].length + 1 }
      : { start: Math.max(0, start - 1), end: content.length };
    }

    function bindCardQuestionInputGuard(editor, validate, report) {
      let previous = { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
      let composing = false;
      const capture = () => { previous = { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd }; };
      const check = () => {
        if (composing) return;
        const error = validate(editor.value);
        // Existing invalid drafts remain editable; never silently remove existing content.
        if (error && !validate(previous.value)) {
          editor.value = previous.value;
          editor.setSelectionRange(previous.start, previous.end);
          report(`已拦截重复题目。${error}`);
        } else { report(error); capture(); }
      };
      editor.addEventListener('beforeinput', () => { if (!composing) capture(); });
      editor.addEventListener('compositionstart', () => { capture(); composing = true; });
      editor.addEventListener('compositionend', () => { composing = false; editor.dispatchEvent(new env.window.Event('input', { bubbles: true })); });
      editor.addEventListener('input', check);
      report(validate(editor.value));
    }

    function showNoteSelectionCardDisabledToast() {
      actions.showToast('已关闭划词浮层');
      const action = env.window.document.createElement('button');
      action.type = 'button'; action.className = 'note-selection-toast-settings'; action.textContent = '前往设置';
      action.onclick = actions.openNoteEditingSettings;
      config.$('#toast').append(action);
      env.clearTimeout(actions.showToast.timer); actions.showToast.timer = env.setTimeout(() => config.$('#toast').classList.add('hidden'), 6500);
    }

    function renderStatistics() { return actions.renderEditionPage?.('statistics'); }

    function toDateTimeLocal(value) {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }

    function roundedHourFromNow() {
      const date = new Date(config.now() + 60 * 60_000);
      date.setMinutes(0, 0, 0);
      return date;
    }

    // 工作空间的备份状态和菜单里的数量。备份时间记在本机（导出备份成功时写入）。
    function renderSidebarFooterStatus() {
      let last = null;
      try { last = Number(env.localStorage.getItem('memokeep-last-backup-at')) || null; } catch { /* 读不到就当没有备份 */ }
      const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
      const text = last == null ? '还没有备份' : days < 1 ? '已备份 · 今天' : days > 7 ? `${days} 天没有备份` : `已备份 · ${days} 天前`;
      const stale = last == null || days > 7;
      config.$$('[data-backup-status]').forEach(node => { node.textContent = text; node.classList.toggle('is-stale', stale); });
      config.$('#sidebarWorkspaceBtn')?.classList.toggle('is-stale', stale);
      config.$('#sidebarWorkspaceBtn')?.setAttribute('title', `本地工作空间 · ${text}`);
      const data = state.persistence.data || {};
      const badge = (selector, count) => { const node = config.$(selector); if (!node) return; node.hidden = !count; node.textContent = count > 99 ? '99+' : String(count || ''); };
      badge('#sidebarTrashCount', (data.trash || []).length);
      badge('#sidebarCandidateCount', (data.cardCandidates || []).filter(row => row.status === 'pending').length);
    }

    function bindNavigationEvents() {
      actions.bindPlugins?.();
      actions.bindEdition?.();
      actions.bindProductNavigation();
      actions.bindSourceLearning?.();
      actions.bindPlans?.();
      actions.bindPomodoro?.();
      actions.bindToday?.();
      env.application.views.tabs.bindNoteTabs();
      env.bindNewNoteFileControls();
      config.$('#sidebarCollapseBtn').onclick = actions.toggleSidebarCollapsed;
      // design/prototype/sidebar-more-menu-20261109.md：工作空间和「更多」打开同一个菜单。
      const moreButton = config.$('#sidebarMoreBtn'), workspaceButton = config.$('#sidebarWorkspaceBtn');
      const moreMenu = config.$('#sidebarMoreMenu');
      let moreTrigger = moreButton;
      const menuItems = () => [...moreMenu.querySelectorAll('button')].filter(item => !item.disabled && item.offsetParent);
      const closeMoreMenu = (restoreFocus = false) => {
        const wasOpen = !moreMenu.classList.contains('hidden');
        moreMenu.classList.add('hidden');
        [moreButton, workspaceButton].forEach(trigger => trigger?.setAttribute('aria-expanded', 'false'));
        if (restoreFocus && wasOpen) moreTrigger?.focus({ preventScroll: true });
      };
      const openMoreMenu = (trigger, focusFirst = false) => {
        moreTrigger = trigger;
        actions.renderSidebarFooterStatus();
        moreMenu.classList.remove('hidden');
        [moreButton, workspaceButton].forEach(item => item?.setAttribute('aria-expanded', String(item === trigger)));
        if (focusFirst) menuItems()[0]?.focus({ preventScroll: true });
      };
      [moreButton, workspaceButton].forEach(trigger => {
        if (!trigger) return;
        trigger.onclick = event => {
          event.stopPropagation();
          if (!moreMenu.classList.contains('hidden') && moreTrigger === trigger) closeMoreMenu();
          else openMoreMenu(trigger, event.detail === 0);
        };
      });
      // 外观三个按钮点了立即生效，菜单保持打开；其余菜单项点了就关闭。
      moreMenu.onclick = event => { if (!event.target.closest('[data-appearance-mode]')) closeMoreMenu(); };
      moreMenu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMoreMenu(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = menuItems(), index = items.indexOf(env.document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        event.preventDefault(); items[next]?.focus();
      });
      env.window.document.addEventListener('click', event => {
        if (!event.target.closest('.sidebar-footer')) closeMoreMenu();
      });
      config.$('#sidebarBackupNow').onclick = () => actions.exportBackup();
      config.$('#sidebarManageData').onclick = async () => {
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.showView('settings');
        config.$('[data-settings-panel="data"]')?.click();
      };
      config.$('#sidebarShortcutsBtn').onclick = () => env.document.getElementById('shortcutEntry')?.click();
      actions.renderSidebarFooterStatus();
      config.$('#trashBtn').onclick = async () => {
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.showView('trash');
      };
      config.$('#trashSearch').oninput = actions.renderTrash;
      config.$('#trashTabs').onclick = event => {
        const button = event.target.closest('[data-trash-filter]');
        if (!button) return;
        config.$('#trashType').value = button.dataset.trashFilter;
        config.$$('#trashTabs button').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
        actions.renderTrash();
      };
      config.$('#trashList').onclick = actions.handleTrashAction;
      config.$('#emptyTrashButton').onclick = actions.emptyTrash;

      config.$$('.nav').forEach(button => {
        button.onclick = async () => {
          if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
          if (button.dataset.view === 'libraries') {
            env.selectedNoteTagId = null;
            state.knowledge.knowledgeTreeCollapsed = !state.knowledge.knowledgeTreeCollapsed;
            if (!state.knowledge.knowledgeTreeCollapsed) actions.collapseAllDirectories?.();
            env.localStorage.setItem(
            'memokeep-knowledge-tree-collapsed',
            String(state.knowledge.knowledgeTreeCollapsed)
            );
            actions.renderSidebarKnowledgeTree();
            actions.renderLibraries();
          }
          if (button.dataset.view === 'plans') actions.togglePlanNav?.();
          if (button.dataset.view === 'cards') {
            env.application.cards.runtime.cardScope = { type: 'all', id: '' };
            env.application.cards.runtime.selectedCardIds.clear();
            const group = config.$('.card-nav-group');
            group.classList.toggle('tree-collapsed');
            env.application.views.cards.render();
          }
          actions.showView(button.dataset.view);
        };
      });

      // 侧栏右侧固定的展开箭头（design/prototype/sidebar-trailing-icons-20261111.md）：点箭头只展开 / 收起，不切换页面。
      const navToggles = {
        libraries: () => {
          state.knowledge.knowledgeTreeCollapsed = !state.knowledge.knowledgeTreeCollapsed;
          if (!state.knowledge.knowledgeTreeCollapsed) actions.collapseAllDirectories?.();
          env.localStorage.setItem('memokeep-knowledge-tree-collapsed', String(state.knowledge.knowledgeTreeCollapsed));
          actions.renderSidebarKnowledgeTree();
          return true;
        },
        plans: () => { actions.togglePlanNav?.(); return true; },
        cards: () => {
          const group = config.$('.card-nav-group');
          if (group.classList.contains('is-empty')) return false;
          group.classList.toggle('tree-collapsed');
          env.application.views.cards.render();
          return true;
        }
      };
      config.$$('.nav-twisty[data-nav-toggle]').forEach(twisty => {
        const toggle = navToggles[twisty.dataset.navToggle];
        if (!toggle) return;
        twisty.addEventListener('click', event => {
          if (!toggle()) return;
          event.preventDefault();
          event.stopPropagation();
        });
      });

      config.$$('[data-view-link]').forEach(button => {
        button.onclick = async event => {
          event.preventDefault();
          if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
          actions.handleEditionNavigation?.(button);
          actions.showView(button.dataset.viewLink);
        };
      });

      config.$('#sidebarSettingsBtn').onclick = async () => {
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.showView('settings');
      };
    }

    function bindDialogEvents() {
      config.$$('[data-close-dialog]').forEach(button => {
        button.onclick = () => button.closest('dialog').close();
      });

      config.$('#tutorialBtn').onclick = () => config.$('#tutorialDialog').showModal();
      config.$('#upgradeBtn').onclick = () => config.$('#upgradeDialog').showModal();
      config.$('#tutorialStartBtn').onclick = () => {
        config.$('#tutorialDialog').close();
        actions.showView('libraries');
        if (!state.persistence.data.knowledgeBases.length) actions.openLibraryDialog();
      };
    }

    function bindFileEvents() {
      config.$('#webBackupInput').onchange = actions.handleWebBackupInput;
    }

    function bindDesktopEvents() {
      let closePending = false;
      config.desktop?.onNavigateToView?.(async view => {
        if (!state.persistence.applicationDataReady) { await state.persistence.backgroundLoadPending; if (!state.persistence.applicationDataReady) return; }
        if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
        actions.showView(view);
        if (view === 'memos') actions.renderMemos();
      });
      config.desktop?.onRequestClose?.(async quitting => {
        if (closePending) return;
        closePending = true;
        try {
          await actions.beforeEditionWindowClose?.();
          if (!await env.application.editor.session.flushNoteTabsForWindowClose()) {
            await config.desktop.cancelClose?.();
            return;
          }
          actions.renderAll();
          await config.desktop.confirmClose(Boolean(quitting));
        } catch (error) {
          await config.desktop.cancelClose?.();
          actions.showToast(error.message || '保存没有成功，请稍后再关闭窗口', true);
        } finally { closePending = false; }
      });
      env.application.persistence.storage.subscribe(() => env.application.persistence.refresh().catch(error => actions.showToast(`同步失败：${error.message}`, true)));
    }
    return { renderSidebarFooterStatus, applySidebarCollapsedState, toggleSidebarCollapsed, showToast, copyTextToClipboard, showConfirmDialog, showUnsavedNoteDialog, syncSidebarSelection, showView, copyInviteText, homeLearningPlan, renderHomeLearningPlan, openWorkspaceNote, openAppearanceSettings, openStudyPlanSettings, saveStudyPreferences, openWorkspaceHistory, openWorkspaceSearch, renderWorkspaceSearch, syncWorkspaceSearchActive, setWorkspaceSearchScope, openWorkspaceSearchResult, bindWorkspaceSearch, bindProductNavigation, renderHome, inlineCardLineDeleteRange, bindCardQuestionInputGuard, showNoteSelectionCardDisabledToast, renderStatistics, toDateTimeLocal, roundedHourFromNow, bindNavigationEvents, bindDialogEvents, bindFileEvents, bindDesktopEvents };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createShellFeatures });
})(globalThis);
