(function expose(root) {
  function createCardListBindings({ $, $$, state, runtime, view, actions, save }) {
async function handleCardListClick(event) {
  if (event.target.closest('[data-card-clear-filters]')) {
    runtime.selectedCardTags.clear();
    runtime.activeCardFilter = 'all'; runtime.activeCardKind = 'all'; runtime.activeCardRecall = 'all'; runtime.activeCardLibraryFilter = 'all'; $('#cardSearch').value = '';
    view.render(); $('#cardSearch').focus(); return;
  }
  const unset = event.target.closest('[data-card-unset]')?.dataset.cardUnset;
  if (unset) {
    if (unset === 'kind') runtime.activeCardKind = 'all';
    if (unset === 'library') runtime.activeCardLibraryFilter = 'all';
    if (unset === 'recall') runtime.activeCardRecall = 'all';
    view.render(); $('#cardAdvancedFilters summary')?.focus({ preventScroll: true }); return;
  }
  const pointsCardId = event.target.closest('[data-card-points]')?.dataset.cardPoints;
  if (pointsCardId) { const card = state.cards.all.find(item => item.id === pointsCardId); if (card) actions.openCardDetail?.(card); return; }
  const reviewCardId = event.target.closest('[data-review-card]')?.dataset.reviewCard;
  if (reviewCardId) { await actions.reviewCards?.([reviewCardId]); return; }
  const tagButton = event.target.closest('[data-card-tag]');
  if (tagButton) { runtime.selectedCardTags = new Set([tagButton.dataset.cardTag]); runtime.cardTagMatchMode = 'any'; view.render(); $('#cardTagFilter summary').focus({ preventScroll: true }); return; }
  const emptyAction = event.target.closest('[data-card-empty-action]')?.dataset.cardEmptyAction;
  if (emptyAction) {
    if (emptyAction === 'reset') {
      runtime.selectedCardTags.clear();
      runtime.activeCardFilter = 'all'; runtime.activeCardKind = 'all'; runtime.activeCardRecall = 'all'; runtime.activeCardLibraryFilter = 'all'; $('#cardSearch').value = '';
      view.render();
      $('#cardSearch').focus();
    } else if (emptyAction === 'import') actions.chooseCardImport();
    else actions.createCardInWorkspace();
    return;
  }
  const selectAll = event.target.closest('#selectAllCards');
  if (selectAll) {
    const visibleIds = $$('[data-select-card]').map(input => input.dataset.selectCard);
    visibleIds.forEach(id => selectAll.checked ? runtime.selectedCardIds.add(id) : runtime.selectedCardIds.delete(id));
    view.render();
    $('#selectAllCards').focus({ preventScroll: true });
    return;
  }

  const cardCheckbox = event.target.closest('[data-select-card]');
  if (cardCheckbox) {
    if (cardCheckbox.checked) runtime.selectedCardIds.add(cardCheckbox.dataset.selectCard);
    else runtime.selectedCardIds.delete(cardCheckbox.dataset.selectCard);
    view.render();
    $$('[data-select-card]').find(input => input.dataset.selectCard === cardCheckbox.dataset.selectCard)?.focus({ preventScroll: true });
    return;
  }

  const editCardId = event.target.closest('[data-edit-card]')?.dataset.editCard;
  const toggleCardId = event.target.closest('[data-toggle-card]')?.dataset.toggleCard;
  const deleteCardId = event.target.closest('[data-delete-card]')?.dataset.deleteCard;

  // 知识点的内容来自笔记，编辑就打开笔记。
  const openCard = card => card?.cardType === 'point' && actions.openPointNote ? actions.openPointNote(card) : actions.openCardDialog(card);
  if (editCardId) openCard(state.cards.all.find(card => card.id === editCardId));

  if (toggleCardId) {
    const card = state.cards.all.find(candidate => candidate.id === toggleCardId);
    if (!card) return;
    card.status = card.status === 'paused' ? 'active' : 'paused';
    card.updatedAt = new Date().toISOString();
    await save();
    actions.renderAll();
    $$('[data-card-more]').find(button => button.dataset.cardMore === toggleCardId)?.focus({ preventScroll: true });
    return;
  }

  if (deleteCardId) {
    await actions.deleteCardById(deleteCardId);
    return;
  }

  const row = event.target.closest('[data-card-row]');
  if (row && !event.target.closest('button, input')) openCard(state.cards.all.find(card => card.id === row.dataset.cardRow));
}

    function handleCardListKeydown(event) {
      if (!['Enter', ' '].includes(event.key) || event.target.closest('button, input')) return;
      const row = event.target.closest('[data-card-row]');
      if (!row) return;
      event.preventDefault();
      const card = state.cards.all.find(item => item.id === row.dataset.cardRow);
      if (card?.cardType === 'point' && actions.openPointNote) actions.openPointNote(card); else actions.openCardDialog(card);
    }

    function bind() {
      actions.bindCardWorkspace();
      actions.bindCardContentMenus();
      actions.bindCardTagFilters();
      $('#cardSearch').oninput = view.render;
      const kindFilter = $('#cardKindFilter');
      if (kindFilter) kindFilter.onchange = event => { runtime.activeCardKind = event.target.value; view.render(); };
      const recallFilter = $('#cardRecallFilter');
      if (recallFilter) recallFilter.onchange = event => { runtime.activeCardRecall = event.target.value; view.render(); };
      // ⌘F / Ctrl+F：在卡片列表里直接聚焦搜索框。
      root.document?.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
        const page = $('#cardsView'), search = $('#cardSearch');
        if (!page || page.classList.contains('hidden') || page.classList.contains('is-topic-board') || !search?.getClientRects().length || root.document.querySelector('dialog[open]')) return;
        event.preventDefault(); search.focus(); search.select();
      });
      $('#cardLibraryFilter').onchange = event => {
        runtime.activeCardLibraryFilter = event.target.value;
        view.render();
      };
      $('#cardFilterChips').onclick = event => {
        const filterButton = event.target.closest('[data-card-filter]');
        if (!filterButton) return;
        runtime.activeCardFilter = filterButton.dataset.cardFilter;
        view.render();
        $$('[data-card-filter]').find(button => button.dataset.cardFilter === runtime.activeCardFilter)?.focus({ preventScroll: true });
      };
      $('#cardPagination').onclick = event => {
        const button = event.target.closest('[data-card-page]');
        if (!button || button.disabled) return;
        const nextPage = Number(button.dataset.cardPage);
        if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage === runtime.cardPage) return;
        runtime.cardPage = nextPage;
        view.render();
        $('#cardPagination [aria-current="page"]')?.focus({ preventScroll: true });
        $('#allCards').scrollIntoView?.({ block: 'start', behavior: 'instant' });
      };
      const searchSummary = $('#cardSearchSummary');
      if (searchSummary) searchSummary.onclick = handleCardListClick;
      $('#allCards').onclick = handleCardListClick;
      $('#allCards').onkeydown = handleCardListKeydown;
      $('#bulkMoveCards').onclick = actions.openMoveCardsDialog;
      const bulkReview = $('#bulkReviewCards');
      if (bulkReview) bulkReview.onclick = () => actions.reviewCards?.([...runtime.selectedCardIds]);
      const bulkClear = $('#bulkClearSelection');
      if (bulkClear) bulkClear.onclick = () => { runtime.selectedCardIds.clear(); view.render(); $('#cardSearch')?.focus({ preventScroll: true }); };
      $('#moveCardsForm').onsubmit = actions.moveSelectedCards;
      $('#bulkRestartCards').onclick = actions.restartSelectedCardsForReview;
      $('#bulkPauseCards').onclick = () => actions.setSelectedCardsStatus('paused');
      $('#bulkResumeCards').onclick = () => actions.setSelectedCardsStatus('active');
      $('#bulkDeleteCards').onclick = actions.deleteSelectedCards;


    }
    return { bind, handleCardListClick, handleCardListKeydown };
  }
  const api = { createCardListBindings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
