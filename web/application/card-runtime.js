(function expose(root) {
  const CARD_PAGE_SIZE = 10;
  function createCardRuntime() {
    return {
      cardScope: { type: 'all', id: '' }, activeCardFilter: 'all', activeCardLibraryFilter: 'all',
      cardPage: 1, cardPageFilterKey: '', selectedCardIds: new Set(), selectedCardTags: new Set(),
      cardTagMatchMode: 'any', cardTagScopeKey: '', cardTagResultCount: 0, closedCardFolders: new Set()
    };
  }
  const api = { createCardRuntime, CARD_PAGE_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
