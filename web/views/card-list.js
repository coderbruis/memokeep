(function expose(root) {
  function createCardListView({ $, state, runtime, selectCardList, helpers }) {
    const { closeCardContentMenus, renderCardWorkspace, cardsInScope, cardStageOrder, cardStageMeta, cardStage, escapeHtml, cardDueLabel, sourceLabel, matchesCardTags, renderCardTagFilters, summary, directory, CARD_PAGE_SIZE } = helpers;
    // 列表行（design/prototype/card-list-20261112.md，舒适版）：问题 / 答案一行 / 来源和标签；状态标签；相对时间；悬停出现的操作。
    const STAGE_LABEL = { due: '到期', new: '新卡', learning: '学习中', mastered: '已掌握', paused: '已暂停' };
    const DAY = 86400000;
    const startOfDay = time => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
    const shortDate = time => { const date = new Date(time); return `${date.getMonth() + 1}月${date.getDate()}日`; };
    function dueParts(card, stage) {
      if (stage === 'paused') return { text: '—', sub: '暂停中', late: false };
      const due = Number(card.dueAt);
      if (!Number.isFinite(due)) return { text: '—', sub: '', late: false };
      const now = helpers.now?.() ?? Date.now(), days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
      if (days < 0) return { text: `过了 ${-days} 天`, sub: shortDate(due), late: true };
      if (days === 0) return { text: cardDueLabel(card, stage), sub: stage === 'new' ? '首次学习' : '', late: stage === 'due' || stage === 'new' };
      return { text: days === 1 ? '明天' : `${days} 天后`, sub: shortDate(due), late: false };
    }
    const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
    function renderCardTableRow(card) {
      const stage = cardStage(card);
      const isSelected = runtime.selectedCardIds.has(card.id);
      // 知识点来自笔记里的要点：标一个「知识点」，编辑时回到笔记。
      const isPoint = card.cardType === 'point';
      const question = escapeHtml(summary(card.question)), due = dueParts(card, stage), source = sourceLabel(card);
      // 和来源笔记同名的标签不重复显示。
      const tags = (card.tags || []).filter(tag => tag !== source);
      const weakPoints = root.MemoKeepPointRecall?.weakCount(card) || 0;
      const answer = isPoint ? String(card.answer || '').replace(/\*\*/g, '').split('\n').filter(Boolean).join(' · ') : summary(card.answer);
      return `
        <tr class="card-table-row ${isSelected ? 'selected' : ''}" data-card-row="${escapeHtml(card.id)}" tabindex="0" aria-label="编辑卡片：${question}">
          <td class="card-select-cell"><input type="checkbox" data-select-card="${escapeHtml(card.id)}" ${isSelected ? 'checked' : ''} aria-label="选择卡片：${question}"></td>
          <td class="card-content-cell">
            <strong class="card-row-question" title="${question}">${isPoint ? '<span class="card-point-badge">知识点</span>' : ''}<span class="card-row-question-text">${question}</span></strong>
            ${answer ? `<div class="card-row-answer">${escapeHtml(answer)}</div>` : ''}
            ${source || tags.length ? `<div class="card-row-meta">${source ? `<span class="card-row-source">${icon('file-text')}${escapeHtml(source)}</span>` : ''}${tags.map(tag => `<button type="button" class="card-row-tag" data-card-tag="${escapeHtml(tag)}" title="只看标签「${escapeHtml(tag)}」">#${escapeHtml(tag)}</button>`).join('')}${weakPoints ? `<button type="button" class="card-row-weak" data-card-points="${escapeHtml(card.id)}" title="查看每条要点的记录">常漏 ${weakPoints} 条</button>` : ''}</div>` : weakPoints ? `<div class="card-row-meta"><button type="button" class="card-row-weak" data-card-points="${escapeHtml(card.id)}" title="查看每条要点的记录">常漏 ${weakPoints} 条</button></div>` : ''}
          </td>
          <td class="card-status-cell"><span class="card-stage-badge ${stage}">${STAGE_LABEL[stage] || cardStageMeta[stage].label}</span></td>
          <td class="card-due-cell${due.late ? ' attention' : ''}"><span>${escapeHtml(due.text)}</span>${due.sub ? `<small>${escapeHtml(due.sub)}</small>` : ''}</td>
          <td class="card-row-actions">
            ${stage === 'paused' ? '' : `<button type="button" class="card-row-review" data-review-card="${escapeHtml(card.id)}" aria-label="复习这一张：${question}" title="复习这一张">${icon('play')}</button>`}
            ${isPoint ? `<button type="button" class="card-row-edit card-row-open-note" data-edit-card="${escapeHtml(card.id)}" aria-label="在笔记中编辑：${question}" title="在笔记中编辑（内容来自笔记里的要点）">${icon('book-open-text')}</button>` : `<button type="button" class="card-row-edit" data-edit-card="${escapeHtml(card.id)}" aria-label="编辑卡片：${question}" title="编辑卡片">${icon('pencil')}</button>`}
            <button type="button" class="card-row-more" data-card-more="${escapeHtml(card.id)}" aria-label="更多操作：${question}" title="更多操作" aria-haspopup="menu" aria-expanded="false" aria-controls="cardRowMenu"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" fill="currentColor"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle><circle cx="19" cy="12" r="1" fill="currentColor"></circle></svg></button>
          </td>
        </tr>`;
    }

    function render() {
      closeCardContentMenus();
      renderCardWorkspace();
      const scopedCards = cardsInScope();
      const tagScope = JSON.stringify(runtime.cardScope);
      if (runtime.cardTagScopeKey !== tagScope) { runtime.selectedCardTags.clear(); runtime.cardTagScopeKey = tagScope; $('#cardTagSearch').value = ''; $('#cardTagFilter').open = false; }
      const query = $('#cardSearch')?.value?.trim().toLowerCase() || '';
      const existingCardIds = new Set(state.cards.all.map(card => card.id));
      runtime.selectedCardIds = new Set([...runtime.selectedCardIds].filter(id => existingCardIds.has(id)));

      const counts = Object.fromEntries(cardStageOrder.map(stage => [stage, 0]));
      scopedCards.forEach(card => { counts[cardStage(card)] += 1; });
      const libraryFilter = $('#cardLibraryFilter');
      libraryFilter.innerHTML = `<option value="all">全部知识库</option>${directory.entries(state.knowledge.libraries).map(({ item: library }) => `<option value="${escapeHtml(library.id)}">${escapeHtml(directory.label(state.knowledge.libraries, library.id))}</option>`).join('')}`;
      if (!state.knowledge.libraries.some(library => library.id === runtime.activeCardLibraryFilter)) runtime.activeCardLibraryFilter = 'all';
      libraryFilter.value = runtime.activeCardLibraryFilter;
      // 「知识点」是卡片类型，放在「筛选 → 类型」里；旧的 activeCardFilter = 'point' 转成类型筛选。
      if (runtime.activeCardFilter === 'point') { runtime.activeCardFilter = 'all'; runtime.activeCardKind = 'point'; }
      if (!['all', 'point', 'card'].includes(runtime.activeCardKind)) runtime.activeCardKind = 'all';
      // 知识点都删光了，就不再停在「类型：知识点」上（和以前的「知识点」标签一样）。
      if (runtime.activeCardKind === 'point' && !scopedCards.some(card => card.cardType === 'point')) runtime.activeCardKind = 'all';
      const kindFilter = $('#cardKindFilter');
      if (kindFilter) kindFilter.value = runtime.activeCardKind;
      // 整理：有常漏的要点 / 答案太长（design/prototype/memory-boost-20261112.md）。
      if (!['all', 'weak', 'long', 'noitems'].includes(runtime.activeCardRecall)) runtime.activeCardRecall = 'all';
      const recallFilter = $('#cardRecallFilter');
      if (recallFilter) recallFilter.value = runtime.activeCardRecall;
      const recallModule = root.MemoKeepPointRecall;
      const extra = runtime.activeCardRecall === 'weak' && recallModule ? card => recallModule.weakCount(card) > 0
        : runtime.activeCardRecall === 'long' && recallModule ? card => Boolean(recallModule.splitAdvice({ ...card, splitHintDismissed: false }))
        // 判断项（design/prototype/check-items-20261112.md）：3 行以上、但没有 2 个判断项的卡。
        : runtime.activeCardRecall === 'noitems' && recallModule ? card => !['cloze', 'image-occlusion'].includes(card.cardType) && recallModule.checkItems(card.answer).length < 2 && recallModule.suggestedItemLines(card.answer).length > 0 : null;
      $('#cardFilterChips').innerHTML = ['all', 'due', 'new', 'learning', 'mastered', 'paused'].map(stage => {
        const count = stage === 'all' ? scopedCards.length : counts[stage];
        return `<button type="button" data-card-filter="${stage}" aria-pressed="${runtime.activeCardFilter === stage}" class="${count || stage === 'all' ? '' : 'is-empty'}">${stage === 'all' ? '' : `<i class="card-filter-dot ${stage}" aria-hidden="true"></i>`}${stage === 'all' ? '全部' : STAGE_LABEL[stage]}<span>${count}</span></button>`;
      }).join('');

      const matchingCards = selectCardList({ cards: scopedCards, query, stage: runtime.activeCardFilter,
        libraryId: runtime.activeCardLibraryFilter, kind: runtime.activeCardKind, extra, sort: $('#cardSort').value, stageOf: cardStage, sourceLabel, matchesTags: matchesCardTags });
      const pageCards = paginateCards(matchingCards, query);
      const visibleCardIds = pageCards.map(card => card.id);
      const hasFilters = Boolean(query || runtime.activeCardFilter !== 'all' || runtime.activeCardKind !== 'all' || runtime.activeCardRecall !== 'all' || runtime.activeCardLibraryFilter !== 'all' || runtime.selectedCardTags.size);
      renderCardTagFilters(scopedCards, matchingCards.length);
      const advancedCount = Number(runtime.activeCardKind !== 'all') + Number(runtime.activeCardRecall !== 'all') + Number(runtime.activeCardLibraryFilter !== 'all') + runtime.selectedCardTags.size;
      const filterCount = $('#cardAdvancedCount');
      if (filterCount) { filterCount.textContent = String(advancedCount); filterCount.hidden = !advancedCount; }
      const searchSummary = $('#cardSearchSummary');
      if (searchSummary) {
        searchSummary.hidden = !hasFilters;
        // 生效的筛选条件显示成可以叉掉的小标签（标签条件在 #cardTagApplied）。
        const chip = (key, label) => `<span class="card-applied-chip">${escapeHtml(label)}<button type="button" data-card-unset="${key}" aria-label="去掉条件：${escapeHtml(label)}"><svg aria-hidden="true"><use href="#icon-x"></use></svg></button></span>`;
        const library = state.knowledge.libraries.find(item => item.id === runtime.activeCardLibraryFilter);
        searchSummary.innerHTML = hasFilters ? `${runtime.activeCardKind !== 'all' ? chip('kind', `类型：${runtime.activeCardKind === 'point' ? '知识点' : '普通卡片'}`) : ''}${library ? chip('library', `知识库：${library.name}`) : ''}${runtime.activeCardRecall !== 'all' ? chip('recall', { weak: '有常漏的要点', long: '答案太长', noitems: '没设判断项的多行卡' }[runtime.activeCardRecall]) : ''}<span class="card-applied-count">找到 ${matchingCards.length} 张卡片</span><button type="button" data-card-clear-filters>清除筛选</button>` : '';
      }
      $('#cardTotal').textContent = hasFilters
        ? `${matchingCards.length} / ${scopedCards.length} 张卡片`
        : `${matchingCards.length} 张卡片`;
      $('#selectedCardCount').textContent = `已选 ${runtime.selectedCardIds.size} 张`;
      $('#cardBulkSummary').classList.toggle('hidden', runtime.selectedCardIds.size === 0);
      $('#cardListHint').classList.add('hidden');

      $('.card-manager-toolbar').classList.toggle('hidden',scopedCards.length===0);
      const tableBody = pageCards.map(renderCardTableRow).join('');
      const emptyTitle = hasFilters ? '未找到卡片' : '暂无卡片';
      const emptyAction = hasFilters ? 'reset' : 'card';
      const emptyLabel = hasFilters ? '清除筛选' : '新建卡片';
      const emptyState = `<tr class="card-table-empty"><td colspan="5"><div class="card-empty-state"><svg aria-hidden="true"><use href="#icon-${hasFilters ? 'search' : 'layers'}"></use></svg><h2>${emptyTitle}</h2><button type="button" data-card-empty-action="${emptyAction}">${emptyLabel}</button>${hasFilters ? '' : '<button type="button" class="card-import-action" data-card-empty-action="import">导入卡片</button>'}</div></td></tr>`;
      $('#allCards').classList.toggle('is-selecting', runtime.selectedCardIds.size > 0);
      $('#allCards').innerHTML = `
        <div class="card-table-scroll">
          <table class="card-management-table" aria-label="记忆卡片列表">
            <thead ${!scopedCards.length ? 'hidden' : ''}><tr><th scope="col" class="card-select-cell"><input id="selectAllCards" type="checkbox" aria-label="选择当前显示的全部卡片" ${matchingCards.length ? '' : 'disabled'}></th><th scope="col">卡片</th><th scope="col">状态</th><th scope="col">下次复习</th><th scope="col" aria-label="操作"></th></tr></thead>
            <tbody>${tableBody || emptyState}</tbody>
          </table>
        </div>`;

      const selectAll = $('#selectAllCards');
      const selectedVisibleCount = visibleCardIds.filter(id => runtime.selectedCardIds.has(id)).length;
      selectAll.checked = visibleCardIds.length > 0 && selectedVisibleCount === visibleCardIds.length;
      selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleCardIds.length;
      // 主题看板 / 主题详情（web/card-topics-view.js）。
      root.MemoKeepCardTopicsView?.render();
    }

    function paginateCards(cards, query) {
      const filterKey = JSON.stringify([runtime.cardScope.type, runtime.cardScope.id, query, runtime.activeCardFilter, runtime.activeCardLibraryFilter, [...runtime.selectedCardTags].sort(), runtime.cardTagMatchMode]);
      if (filterKey !== runtime.cardPageFilterKey) {
        runtime.cardPage = 1;
        runtime.cardPageFilterKey = filterKey;
      }
      const pageCount = Math.max(1, Math.ceil(cards.length / CARD_PAGE_SIZE));
      runtime.cardPage = Math.max(1, Math.min(runtime.cardPage, pageCount));
      const button = (page, label, text, disabled = false) => `<button type="button" data-card-page="${page}" aria-label="${label}" ${disabled ? 'disabled' : ''} ${page === runtime.cardPage && /^\d+$/.test(text) ? 'aria-current="page"' : ''}>${text}</button>`;
      const pages = [...new Set([1, pageCount, runtime.cardPage - 1, runtime.cardPage, runtime.cardPage + 1,
        ...(runtime.cardPage <= 3 ? [2, 3, 4, 5] : []), ...(runtime.cardPage >= pageCount - 2 ? [pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1] : [])])]
        .filter(page => page >= 1 && page <= pageCount).sort((a, b) => a - b);
      $('#cardPagination').innerHTML = button(runtime.cardPage - 1, '上一页', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"></path></svg>', runtime.cardPage === 1)
        + pages.map((page, index) => `${index && page - pages[index - 1] > 1 ? '<span class="card-page-gap" aria-hidden="true">…</span>' : ''}${button(page, `第 ${page} 页`, String(page))}`).join('')
        + button(runtime.cardPage + 1, '下一页', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"></path></svg>', runtime.cardPage === pageCount);
      $('#cardPagination').hidden = cards.length === 0;
      $('#cardPageStatus').textContent = cards.length ? `第 ${runtime.cardPage} / ${pageCount} 页 · 每页 ${CARD_PAGE_SIZE} 张` : '';
      return cards.slice((runtime.cardPage - 1) * CARD_PAGE_SIZE, runtime.cardPage * CARD_PAGE_SIZE);
    }
    return { render, renderCardTableRow };
  }
  const api = { createCardListView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
