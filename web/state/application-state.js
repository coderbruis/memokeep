(function expose(root) {
  // A live access port over the existing owner, never a second data container.
  function createApplicationState({ read, replace }) {
    const checkpoint = () => structuredClone(read());
    const domain = fields => Object.defineProperties({}, Object.fromEntries(Object.entries(fields)
      .map(([name, field]) => [name, { enumerable: true, get: () => read()[field] }])));
    const knowledge = domain({ libraries: 'knowledgeBases', documents: 'documents', items: 'items', tags: 'noteTags' });
    knowledge.libraryById = id => knowledge.libraries.find(item => item.id === id);
    knowledge.documentById = id => knowledge.documents.find(item => item.id === id) || read().cardDocuments?.find(item => item.id === id);
    knowledge.itemById = id => knowledge.items.find(item => item.id === id);
    const cards = domain({ all: 'cards', folders: 'cardFolders', notebooks: 'cardNotebooks', documents: 'cardDocuments' });
    cards.byId = id => cards.all.find(item => item.id === id);
    const memos = domain({ all: 'memos' });
    memos.byId = id => memos.all.find(item => item.id === id);
    return { knowledge, cards, memos, review: domain({ records: 'reviewRecords', sessions: 'reviewSessions', streak: 'streak' }),
      settings: domain({ current: 'settings' }), trash: domain({ entries: 'trash' }),
      read, replace, checkpoint };
  }
  const api = { createApplicationState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepState = api;
})(globalThis);
