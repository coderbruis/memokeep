(function expose(root) {
  function todayKey(timestamp) { return new Date(timestamp).toLocaleDateString('sv-SE'); }
  function dueCards(snapshot, timestamp) { return snapshot.cards.filter(card => card.status === 'active' && card.dueAt <= timestamp); }
  function reviewsToday(snapshot, timestamp) { return snapshot.reviewRecords.filter(record => todayKey(record.reviewedAt) === todayKey(timestamp)); }
  function libraryById(snapshot, id) { return snapshot.knowledgeBases.find(item => item.id === id); }
  function documentById(snapshot, id) { return snapshot.documents.find(item => item.id === id) || snapshot.cardDocuments?.find(item => item.id === id); }
  function itemById(snapshot, id) { return snapshot.items.find(item => item.id === id); }
  const api = { todayKey, dueCards, reviewsToday, libraryById, documentById, itemById };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
