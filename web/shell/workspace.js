(function expose(root) {
  function createWorkspaceFeatures({ state, config, actions, env }) {
    let mounted = null, favoritePending = false, favoriteTab = 'notes';
    const documents = () => [...state.persistence.data.documents, ...(state.persistence.data.cardDocuments || [])];
    const escape = value => actions.escapeHtml(String(value ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const persistedDocument = id => documents().find(doc => doc.id === id);
    const isFavorite = id => persistedDocument(id)?.metadata?.favorite === true;
    function refreshFavoriteButton() {
      const button = config.$('#noteFavoriteButton');
      if (!button) return;
      const active = isFavorite(state.editor.editingMarkdownDocumentId), unsaved = !persistedDocument(state.editor.editingMarkdownDocumentId);
      button.setAttribute('aria-pressed', String(active)); button.disabled = favoritePending || unsaved;
      button.title = unsaved ? '保存后可收藏' : active ? '取消收藏' : '收藏笔记';
      button.setAttribute('aria-label', button.title);
      const label = active ? '已收藏' : '收藏'; if (button.querySelector('span').textContent !== label) button.querySelector('span').textContent = label;
    }
    async function toggleDocumentFavorite(id = state.editor.editingMarkdownDocumentId) {
      if (favoritePending) return false;
      const doc = persistedDocument(id);
      if (!doc) { actions.showToast('请先保存笔记'); return false; }
      favoritePending = true; refreshFavoriteButton();
      try {
        await env.application.operations.knowledge.setDocumentFavorite(id, !isFavorite(id));
        actions.renderSidebarKnowledgeTree(); refreshFavoriteButton(); renderFavorites(); return true;
      } catch (error) { actions.showToast(`收藏没有保存：${error?.message || '请再试一次'}`); return false; }
      finally { favoritePending = false; refreshFavoriteButton(); }
    }
    // 收藏页：和「记忆卡片」「备忘录」同级的页面（design/prototype/favorites-page-20261113.md）。
    const favoritesView = () => config.$('#favoritesView');
    let favoritesBound = false;
    function renderFavorites() {
      const view = favoritesView();
      if (!view) return;
      bindFavorites(view);
      const query = view.querySelector('[data-favorite-query]').value.trim().toLocaleLowerCase();
      const favoriteCards = (state.persistence.data.cards || []).filter(card => card.favorite);
      const cardNotes = new Set((state.persistence.data.cardDocuments || []).map(doc => doc.id));
      const favoriteDocuments = documents().filter(doc => doc.metadata?.favorite === true);
      view.querySelectorAll('[data-favorite-tab]').forEach(tab => {
        tab.setAttribute('aria-selected', String(tab.dataset.favoriteTab === favoriteTab));
        tab.querySelector('span').textContent = String(tab.dataset.favoriteTab === 'cards' ? favoriteCards.length : favoriteDocuments.length);
      });
      // 「知识笔记 / 卡片笔记」只在两种都收藏过时才需要区分。
      const kind = view.querySelector('[data-favorite-kind]');
      const mixed = favoriteDocuments.some(doc => cardNotes.has(doc.id)) && favoriteDocuments.some(doc => !cardNotes.has(doc.id));
      kind.hidden = favoriteTab === 'cards' || !mixed && kind.value === 'all';
      view.querySelector('[data-favorite-query]').placeholder = favoriteTab === 'cards' ? '搜索收藏的卡片' : '搜索收藏的笔记';
      const day = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? `${date.getFullYear() === new Date(config.now()).getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日` : ''; };
      // 卡片网格：每张卡片有位置、标题、正文开头和日期，不用点开就能认出是哪一篇（design/prototype/favorites-page-20261113.md）。
      const plain = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const row = ({ open, remove, icon, title, where, excerpt, meta, label }) => `<article class="favorites-card"><button type="button" class="favorites-open" ${open}><span class="favorites-card-top"><span class="favorites-icon"><svg aria-hidden="true"><use href="#icon-${icon}"></use></svg></span><span class="favorites-path" title="${where}">${where}</span></span><strong>${title}</strong><span class="favorites-excerpt">${excerpt}</span>${meta ? `<span class="favorites-foot"><time>${meta}</time></span>` : ''}</button><button type="button" class="favorites-remove" ${remove} aria-label="取消收藏 ${label}" title="取消收藏"><svg aria-hidden="true"><use href="#icon-star"></use></svg></button></article>`;
      const empty = (title, hint) => `<div class="favorites-empty"><svg aria-hidden="true"><use href="#icon-star"></use></svg><h2>${title}</h2><p>${hint}</p></div>`;
      let rows, total, unit;
      if (favoriteTab === 'cards') {
        const list = favoriteCards.filter(card => `${card.question || ''} ${card.answer || ''}`.toLocaleLowerCase().includes(query));
        rows = list.map(card => { const question = plain(card.question); return row({ open: `data-favorite-card="${escape(card.id)}"`, remove: `data-favorite-card-remove="${escape(card.id)}"`, icon: 'layers', label: escape(question),
          title: escape(question || '未命名卡片'), where: '记忆卡片', excerpt: escape(plain(card.answer).slice(0, 160) || '还没有答案') }); });
        total = favoriteCards.length; unit = '张';
      } else {
        const only = kind.value;
        const list = favoriteDocuments.filter(doc => (only === 'all' || (only === 'cards') === cardNotes.has(doc.id))
          && `${doc.title} ${doc.content || ''}`.toLocaleLowerCase().includes(query)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        rows = list.map(doc => { const preview = env.noteDirectoryPreview(doc); return row({ open: `data-favorite-open="${escape(doc.id)}"`, remove: `data-favorite-remove="${escape(doc.id)}"`, icon: cardNotes.has(doc.id) ? 'layers' : 'book-open', label: escape(doc.title),
          title: escape(doc.title || '未命名笔记'), meta: day(doc.updatedAt) && `更新于 ${day(doc.updatedAt)}`,
          excerpt: escape([preview.heading, preview.text].filter(Boolean).join(' · ').slice(0, 160) || (preview.diagram ? '包含图表' : '暂无正文')),
          where: escape(cardNotes.has(doc.id) ? '卡片笔记' : env.MemoKeepDirectoryTree.ancestors(state.persistence.data.knowledgeBases, doc.knowledgeBaseId).map(lib => lib.name).join(' / ') || '知识笔记') }); });
        total = favoriteDocuments.length; unit = '篇';
      }
      const count = view.querySelector('[data-favorite-count]');
      count.hidden = rows.length === total; count.textContent = `找到 ${rows.length} ${unit}，共 ${total} ${unit}`;
      view.querySelector('[data-favorite-list]').innerHTML = rows.length ? rows.join('')
        : total ? empty('没有匹配的收藏', '换个关键词试试。')
        : favoriteTab === 'cards' ? empty('还没有收藏卡片', '在卡片详情里点「收藏卡片」，就会出现在这里。') : empty('还没有收藏笔记', '打开笔记，点标题下面的「收藏」，就会出现在这里。');
    }
    function bindFavorites(view) {
      if (favoritesBound) return;
      favoritesBound = true;
      view.querySelector('[data-favorite-query]').oninput = renderFavorites;
      view.querySelector('[data-favorite-kind]').onchange = renderFavorites;
      view.addEventListener('click', async event => {
        const tab = event.target.closest('[data-favorite-tab]');
        if (tab) { favoriteTab = tab.dataset.favoriteTab; renderFavorites(); return; }
        const cardRemove = event.target.closest('[data-favorite-card-remove]');
        if (cardRemove) { cardRemove.disabled = true; try { await env.application.operations.sourceLearning.favoriteCard(cardRemove.dataset.favoriteCardRemove, false); } catch (error) { actions.showToast(error.message || '取消收藏失败', true); } renderFavorites(); return; }
        const cardOpen = event.target.closest('[data-favorite-card]');
        if (cardOpen) {
          const card = env.application.state.cards.byId(cardOpen.dataset.favoriteCard);
          if (card) env.application.views.cardDetail.openCardDetail(card); else renderFavorites();
          return;
        }
        const remove = event.target.closest('[data-favorite-remove]');
        if (remove) { remove.disabled = true; await toggleDocumentFavorite(remove.dataset.favoriteRemove); if (remove.isConnected) remove.disabled = false; return; }
        const open = event.target.closest('[data-favorite-open]');
        if (!open) return;
        const doc = actions.documentById(open.dataset.favoriteOpen);
        if (!doc) { renderFavorites(); return; }
        const notebook = (state.persistence.data.cardNotebooks || []).find(note => note.sourceDocumentId === doc.id);
        await actions.openMarkdownNoteEditor(doc, '', null, notebook?.id || null);
      });
    }
    // 打开收藏页；tab 为 'notes' 或 'cards' 时直接到那一栏。
    async function openFavoriteNotes(tab) {
      if (tab === 'notes' || tab === 'cards') favoriteTab = tab;
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
      actions.showView('favorites');
      return true;
    }
    function mountNoteWorkspace({ root: editorRoot }) {
      mounted?.dispose();
      if (!editorRoot) return;
      const toolbar = editorRoot.querySelector('.note-editor-toolbar');
      if (!toolbar) return;
      const controller = new env.window.AbortController(), signal = controller.signal;
      const listen = (node, type, fn, options = {}) => node?.addEventListener(type, fn, { ...options, signal });
      const controls = env.document.createElement('div'); controls.className = 'note-workspace-controls';
      controls.innerHTML = `<button type="button" id="noteFavoriteButton" class="note-workspace-button" aria-pressed="false"><svg aria-hidden="true"><use href="#icon-star"></use></svg><span>收藏</span></button><button type="button" id="noteSkimButton" class="note-workspace-button" aria-pressed="false" hidden title="只看每个标题下的要点（⌘⇧E）"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/></svg><span>速览</span></button><button type="button" id="noteGistDetailsAll" class="note-workspace-button" hidden title="一次收起 / 展开所有要点下面的详细内容"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 9 5-5 5 5M7 15l5 5 5-5"/></svg><span>收起全部详细</span></button><button type="button" id="noteGistReviewAll" class="note-workspace-button" hidden><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>把这篇的要点都加入复习</span></button><button type="button" id="noteGistPauseAll" class="note-workspace-button" hidden><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg><span>这篇的要点都暂停复习</span></button><button type="button" id="noteCardMarksToggle" class="note-workspace-button" role="menuitemcheckbox" aria-checked="true"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/></svg><span>显示制卡标记</span></button>`;
      toolbar.append(controls);
      // 先拿到按钮再交给标签栏：标签栏会把「收藏」挪到笔记标签旁边，之后在 controls 里就找不到它了。
      const favoriteButton = controls.querySelector('#noteFavoriteButton');
      env.application.views.tabs.mountNoteTabControls();
      listen(favoriteButton, 'click', () => void toggleDocumentFavorite());
      const observer = new env.MutationObserver(refreshFavoriteButton);
      observer.observe(editorRoot, { subtree: true, childList: true, characterData: true });
      const dispose = () => {
        controller.abort(); observer.disconnect(); controls.remove(); favoriteButton.remove();
        if (mounted?.root === editorRoot) mounted = null;
      };
      const previousDispose = state.editor.discardActiveNoteEditor; state.editor.discardActiveNoteEditor = () => { dispose(); previousDispose?.(); };
      mounted = { root: editorRoot, dispose };
      refreshFavoriteButton();
      return dispose;
    }
    return { mountNoteWorkspace, toggleDocumentFavorite, openFavoriteNotes, renderFavorites, refreshFavoriteButton };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createWorkspaceFeatures });
})(globalThis);
