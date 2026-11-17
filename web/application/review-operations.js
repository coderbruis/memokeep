(function expose(root) {
  // Runtime belongs to the review module; environment and persisted data are separate ports.
  function createReviewOperations({ store, runtime, environment, persistence, model: ReviewSession, now, normalize, view, transactions }) {
    const { cardsInScope, dueCards, finishReviewSession, showReviewCard, showToast, continueReview } = view;

    function reviewElapsed() { return runtime.reviewSessionPaused ? (store.data.reviewSessions?.[runtime.reviewSessionKey]?.elapsedMs || 0) : Math.max(0, now() - runtime.reviewSessionStartedAt); }

    async function startReview(scopeOnly = false, planIds = null, options = {}) {
      if (!environment.applicationDataReady) { await environment.backgroundLoadPending; if (!environment.applicationDataReady) return; }
      if (runtime.reviewActionPending || view.isOpen()) return;
      runtime.reviewActionPending = true;
      try {
        const planned = Array.isArray(planIds) ? new Set(planIds) : null;
        // options.key：单独复习某几张（比如笔记里的「现在复习」），不打断今天的整轮。
        runtime.reviewSessionKey = options.key ? String(options.key) : planned ? 'daily-plan' : scopeOnly === true && environment.cardScope.type !== 'all' ? `${environment.cardScope.type}:${environment.cardScope.id}${environment.cardScope.point ? `:${environment.cardScope.point}` : ''}` : 'all';
        const candidates = (scopeOnly === true ? cardsInScope().filter(card => card.status === 'active' && card.dueAt <= now()) : dueCards()).filter(card => !planned || planned.has(card.id)).sort((a,b) => a.dueAt-b.dueAt);
        runtime.reviewScopeIds = (scopeOnly === true ? cardsInScope() : store.data.cards).filter(card => !planned || planned.has(card.id)).map(card => card.id);
        const session = ReviewSession.open(store.data, runtime.reviewSessionKey, candidates, runtime.reviewScopeIds);
        runtime.reviewQueue = session.queue.map(id => store.data.cards.find(card => card.id === id) || { id });
        runtime.reviewSessionResults = session.results;
        runtime.reviewedCardIds = new Set(session.done);
        runtime.reviewIndex = session.queue.indexOf(session.currentId);
        runtime.reviewSessionPaused = false;
        runtime.reviewSessionStartedAt = now() - session.elapsedMs;
        checkpointReview();
        await persistence.save();
        view.stopOutcome();
        view.closeOutcome();
        if (runtime.reviewIndex < 0) { finishReviewSession(); return; }
        view.open(); showReviewCard();
        if (session.resumed) showToast(`已继续上次复习，剩余 ${session.queue.filter(id => !runtime.reviewedCardIds.has(id)).length} 张`);
      } finally { runtime.reviewActionPending = false; }
    }

    function checkpointReview(data = store.data, results = runtime.reviewSessionResults) {
      if (runtime.practice) return; // 再练不保存进度
      ReviewSession.checkpoint(data, runtime.reviewSessionKey, runtime.reviewQueue.map(card => card.id), results, runtime.reviewQueue[runtime.reviewIndex]?.id, reviewElapsed(), runtime.reviewScopeIds);
    }

    function outcomeState() {
      const at = now();
      return { at, summary: ReviewSession.summary(store.data, runtime.reviewSessionResults, runtime.reviewScopeIds, reviewElapsed(), at),
        // 一轮结束后「接着复习」的主题（web/card-topics-view.js）。
        next: globalThis.MemoKeepCardTopicsView?.suggestions(runtime.reviewSessionKey) || null,
        canUndo: Boolean(ReviewSession.undoCandidate(store.data, runtime.reviewSessionKey)), settings: store.data.settings, streak: globalThis.MemoKeepDomain?.learningStreak ? MemoKeepDomain.learningStreak(store.data, at) : Number(store.data.streak?.count) || 0 };
    }

    async function readLatestReviewData() {
      const storage = persistence.storage;
      const raw = storage.isDesktop ? await storage.read() : storage.read();
      store.data = normalize(raw); store.baseline = structuredClone(raw);
    }

    async function resumeReviewRound(preferredId) {
      if (runtime.reviewActionPending) return;
      runtime.reviewActionPending = true;
      try {
        await readLatestReviewData();
        const candidates = store.data.cards.filter(card => runtime.reviewScopeIds.includes(card.id) && card.status === 'active' && card.dueAt <= now());
        const session = ReviewSession.open(store.data, runtime.reviewSessionKey, candidates, runtime.reviewScopeIds);
        runtime.reviewQueue = session.queue.map(id => store.data.cards.find(card => card.id === id));
        runtime.reviewSessionResults = session.results; runtime.reviewedCardIds = new Set(session.done);
        const currentId = candidates.some(card => card.id === preferredId) ? preferredId : session.currentId;
        runtime.reviewIndex = session.queue.indexOf(currentId);
        if (runtime.reviewIndex < 0) { finishReviewSession(); return; }
        runtime.reviewSessionPaused = false; runtime.reviewSessionStartedAt = now() - session.elapsedMs;
        checkpointReview(); await persistence.save();
        view.stopOutcome(); view.closeOutcome();
        view.open(); showReviewCard();
      } finally { runtime.reviewActionPending = false; }
    }

    async function undoLastReview() {
      if (runtime.reviewActionPending) return;
      runtime.reviewActionPending = true;
      let target;
      try {
        await readLatestReviewData();
        target = await transactions.undo(runtime.reviewSessionKey);
      } finally { runtime.reviewActionPending = false; }
      await resumeReviewRound(target);
    }

    function findReviewIndex(direction) {
      for (let index = runtime.reviewIndex + direction; index >= 0 && index < runtime.reviewQueue.length; index += direction) {
        if (!runtime.reviewedCardIds.has(runtime.reviewQueue[index].id)) return index;
      }
      return null;
    }

    async function navigateReview(direction) {
      if (runtime.reviewActionPending) return;
      if (runtime.reviewAwaitingContinue) { if (direction > 0) continueReview(); return; }
      const nextIndex = findReviewIndex(direction);
      if (nextIndex === null) return;
      const previousIndex = runtime.reviewIndex;
      runtime.reviewActionPending = true;
      runtime.reviewIndex = nextIndex;
      checkpointReview();
      try { await persistence.save(); showReviewCard(); }
      catch { runtime.reviewIndex = previousIndex; checkpointReview(); }
      finally { runtime.reviewActionPending = false; }
    }

    function advanceAfterReview(cardId) {
      runtime.reviewedCardIds.add(cardId);
      const nextIndex = findReviewIndex(1);
      if (nextIndex !== null) { runtime.reviewIndex = nextIndex; showReviewCard(); return true; }
      const previousIndex = findReviewIndex(-1);
      if (previousIndex !== null) { runtime.reviewIndex = previousIndex; showReviewCard(); return true; }
      return false;
    }
    return { reviewElapsed, startReview, checkpointReview, outcomeState, readLatestReviewData, resumeReviewRound, undoLastReview, findReviewIndex, navigateReview, advanceAfterReview };
  }
  const api = { createReviewOperations };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
