(function expose(root) {
  function createReviewBindings({ $, document, desktop, state, runtime, view, operations, shortcuts, homePlan, syncPoints }) {
    let bound = false;
    function bind() {
      if (bound) return;
      bound = true;
      // 开始前先把笔记里的要点同步成知识点，保证队列是最新的。
      const start = (...args) => syncPoints ? Promise.resolve(syncPoints()).catch(() => false).then(() => operations().startReview(...args)) : operations().startReview(...args);
      $('#startReviewBtn').onclick = () => syncPoints ? Promise.resolve(syncPoints()).catch(() => false).then(() => operations().startReview(false, homePlan?.()?.ids ?? null)) : operations().startReview(false, homePlan?.()?.ids ?? null);
      $('#cardStartReviewBtn').onclick = () => syncPoints ? Promise.resolve(syncPoints()).catch(() => false).then(() => operations().startReview(true)) : operations().startReview(true);
      desktop?.onReviewStart?.((...args) => start(...args));
      $('#revealBtn').onclick = () => {
        $('#answerArea').classList.remove('hidden');
        $('#ratings').classList.remove('hidden');
        $('#revealBtn').classList.add('hidden');
        view.updateReviewMemoryPanel(false);
        const card = state.read().cards.find(card => card.id === runtime.reviewQueue[runtime.reviewIndex]?.id);
        if (card) view.updateReviewIntervals(card);
        runtime.reviewVoice?.onReveal();
      };
      runtime.reviewVoice?.bind();
      $('#reviewContinue').onclick = view.continueReview;
      $('#reviewOpenSource').onclick = view.openReviewSourceDrawer;
      if ($('#reviewLater')) $('#reviewLater').onclick = () => view.deferReviewCard();
      const undo = async () => {
        if ($('#reviewUndo')?.hidden !== false) return;
        runtime.reviewMemoryPanel?.close?.();
        try { await operations().undoLastReview(); } catch (error) { desktop?.showToast?.(error.message); view.refreshUndo?.(); }
      };
      if ($('#reviewUndo')) $('#reviewUndo').onclick = () => { void undo(); };
      $('#reviewCloseSource').onclick = view.closeReviewSourceDrawer;
      if ($('#reviewEditCard')) $('#reviewEditCard').onclick = () => view.editCurrentCard();
      if ($('#reviewSourceEdit')) $('#reviewSourceEdit').onclick = () => { void view.leaveToNote(); };
      $('#reviewPreviousCard').onclick = () => operations().navigateReview(-1);
      $('#reviewNextCard').onclick = () => operations().navigateReview(1);
      $('#reviewResultDialog').addEventListener('close', () => runtime.reviewOutcomeController?.stop());
      $('#ratings').onclick = event => {
        const actionButton = event.target.closest('button');
        if (actionButton?.dataset.defer) {
          view.deferReviewCard();
          return;
        }
        const rating = actionButton?.dataset.rating;
        if (rating) view.rateCard(rating);
      };
      document.addEventListener('keydown', event => {
        if (!$('#reviewDialog').open || event.defaultPrevented || event.repeat || event.isComposing || event.target.closest?.('input,textarea,select,[contenteditable=true]')) return;
        if (runtime.reviewVoice?.handleKey(event)) return;
        if (event.key === 'Escape' && runtime.reviewMemoryPanel?.isOpen) {
          event.preventDefault();
          event.stopPropagation();
          runtime.reviewMemoryPanel.close({ focus: true });
          return;
        }
        if (event.key === 'Escape' && !$('#reviewSourceDrawer').classList.contains('hidden')) {
          event.preventDefault();
          event.stopPropagation();
          view.closeReviewSourceDrawer();
          return;
        }
        if (runtime.reviewAwaitingContinue && ([' ', 'Enter'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey || shortcuts.matches(event, 'review-next'))) {
          if (!shortcuts.matches(event, 'review-next') && event.target.closest?.('button, a, input, textarea, select') && event.target.id !== 'reviewContinue') return;
          event.preventDefault(); view.continueReview(); return;
        }
        if (shortcuts.matches(event, 'review-undo') && $('#reviewUndo')?.hidden === false) { event.preventDefault(); void undo(); return; }
        if (shortcuts.matches(event, 'review-prev')) { event.preventDefault(); operations().navigateReview(-1); return; }
        if (shortcuts.matches(event, 'review-next')) { event.preventDefault(); operations().navigateReview(1); return; }
        if (shortcuts.matches(event, 'reveal') && !$('#revealBtn').classList.contains('hidden')) {
          event.preventDefault();
          $('#revealBtn').click();
          return;
        }
        if (shortcuts.matches(event, 'review-later') && !runtime.reviewAwaitingContinue) { event.preventDefault(); view.deferReviewCard(); return; }
        if (shortcuts.matches(event, 'review-edit') && !$('#answerArea').classList.contains('hidden') && !$('#reviewEditCard')?.classList.contains('hidden')) { event.preventDefault(); view.editCurrentCard(); return; }
        if (shortcuts.matches(event, 'review-source') && !$('#answerArea').classList.contains('hidden') && !$('#reviewOpenSource').classList.contains('hidden')) {
          event.preventDefault();
          if ($('#reviewSourceDrawer').classList.contains('hidden')) view.openReviewSourceDrawer(); else view.closeReviewSourceDrawer();
          return;
        }
        if ($('#ratings').classList.contains('hidden')) return;
        const rating = ['again','hard','good','easy'].find((_, index) => shortcuts.matches(event, `rate-${index + 1}`));
        if (rating) {
          event.preventDefault();
          view.rateCard(rating);
        }
      });
    }
    return { bind };
  }
  const api = { createReviewBindings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
