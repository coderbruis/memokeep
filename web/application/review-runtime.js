(function expose(root) {
  // One transient owner per application. Persisted checkpoints remain in application data.
  function createReviewRuntime() {
    return {
      reviewQueue: [], reviewIndex: 0, reviewCardShownAt: 0, reviewActionPending: false,
      reviewedCardIds: new Set(), reviewSessionStartedAt: 0, reviewSessionResults: [],
      reviewSessionKey: 'all', reviewScopeIds: [], reviewSessionPaused: false,
      reviewOutcomeController: undefined, reviewMemoryPanel: undefined, reviewAwaitingContinue: false
    };
  }
  const api = { createReviewRuntime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
