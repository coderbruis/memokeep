// Shared persisted rounds for the main and quick-review windows.
const ReviewSession = {
  day(at = Date.now()) { return new Date(at).toLocaleDateString('en-CA'); },
  pending(data, scopeIds, at = Date.now()) {
    const end = new Date(at); end.setHours(23, 59, 59, 999);
    const scope = new Set(scopeIds || data.cards.map(card => card.id));
    return data.cards.filter(card => scope.has(card.id) && card.status === 'active' && Number.isFinite(Number(card.dueAt)) && Number(card.dueAt) <= end.getTime())
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  },
  open(data, key, candidates, scopeIds = data.cards.map(card => card.id), at = Date.now()) {
    const stored = data.reviewSessions?.[key];
    const saved = stored && (!stored.day || stored.day === this.day(at)) ? stored : null;
    const scope = new Set(scopeIds);
    const valid = new Set(data.cards.filter(card => scope.has(card.id) && card.status === 'active').map(card => card.id));
    const due = new Set(candidates.filter(card => valid.has(card.id)).map(card => card.id));
    const results = Array.isArray(saved?.results) ? saved.results : [];
    const queue = [...new Set([...(saved?.queue || []).filter(id => valid.has(id)), ...due])];
    return { queue, results, done: queue.filter(id => !due.has(id)), scopeIds,
      currentId: due.has(saved?.currentId) ? saved.currentId : [...candidates].sort((a, b) => Number(a.dueAt) - Number(b.dueAt)).find(card => due.has(card.id))?.id,
      elapsedMs: Math.max(0, Number(saved?.elapsedMs) || 0), resumed: Boolean(saved) };
  },
  checkpoint(data, key, queue, results, currentId, elapsedMs, scopeIds, at = Date.now()) {
    data.reviewSessions ||= {};
    const current = data.cards.find(card => card.id === currentId);
    // A saved rating must not leave the just-rated card as the next waiting cursor.
    const cursor = current?.status === 'active' && Number(current.dueAt) <= at ? currentId : null;
    data.reviewSessions[key] = { queue: [...new Set(queue)], results: structuredClone(results), currentId: cursor,
      scopeIds: scopeIds || data.reviewSessions[key]?.scopeIds || data.cards.map(card => card.id),
      elapsedMs: Math.max(0, elapsedMs), day: this.day(at), updatedAt: at };
  },
  summary(data, results, scopeIds, elapsedMs, at = Date.now()) {
    const logIds = new Set(data.reviewRecords.map(log => log.id));
    const rated = results.filter(result => ['again', 'hard', 'good', 'easy'].includes(result.rating) && (!result.recordId || logIds.has(result.recordId)));
    const pending = this.pending(data, scopeIds, at);
    const allPending = this.pending(data, null, at);
    const counts = Object.fromEntries(['again', 'hard', 'good', 'easy'].map(rating => [rating, rated.filter(result => result.rating === rating).length]));
    const ratedIds = new Set(rated.map(result => result.cardId));
    const points = [...ratedIds].filter(id => data.cards.find(card => card.id === id)?.cardType === 'point').length;
    return { cards: ratedIds.size, points, ratings: rated.length, counts,
      pending, ready: pending.filter(card => Number(card.dueAt) <= at), elapsedMs,
      todayComplete: allPending.length === 0, outsidePending: allPending.filter(card => !pending.includes(card)).length,
      last: rated.at(-1), deferred: results.filter(result => result.rating === 'later').length,
      // 本轮最后一次评为「忘记 / 有点难」的项目，完成页列在「需要再看」。
      // 「记住」但漏了要点的也算（design/prototype/memory-boost-20261112.md）。
      weak: [...rated.reduce((map, result) => map.set(result.cardId, result), new Map())]
        .filter(([, result]) => result.rating === 'again' || result.rating === 'hard' || Number(result.missed) > 0)
        .map(([cardId, result]) => { const card = data.cards.find(item => item.id === cardId); return { cardId, rating: result.rating, missed: Number(result.missed) || 0, question: card?.question || '', kind: card?.cardType === 'point' ? 'point' : 'card' }; })
        .filter(item => item.question),
      tomorrow: this.dueTomorrow(data, at) };
  },
  dueTomorrow(data, at = Date.now()) {
    const start = new Date(at); start.setHours(24, 0, 0, 0);
    const end = new Date(start); end.setHours(23, 59, 59, 999);
    return data.cards.filter(card => card.status === 'active' && Number(card.dueAt) >= start.getTime() && Number(card.dueAt) <= end.getTime()).length;
  },
  snapshot(card) {
    return Object.fromEntries(['dueAt', 'lastReviewedAt', 'reviewCount', 'lapseCount', 'strength', 'schedulerVersion', 'schedulerData', 'schedulerResetAt', 'pointRecall']
      .map(key => [key, structuredClone(card[key] ?? null)]));
  },
  undoCandidate(data, key) {
    const last = data.reviewSessions?.[key]?.results?.filter(result => result.rating !== 'later').at(-1);
    if (!last?.recordId || !last.before || !last.after) return null;
    const log = data.reviewRecords.find(record => record.id === last.recordId);
    const card = data.cards.find(candidate => candidate.id === last.cardId);
    if (!log || !card) return null;
    const latest = data.reviewRecords.reduce((a, b) => !a || new Date(b.reviewedAt).getTime() >= new Date(a.reviewedAt).getTime() ? b : a, null);
    if (latest?.id !== log.id || JSON.stringify(this.snapshot(card)) !== JSON.stringify(last.after)) return null;
    return { last, log, card };
  },
  undo(data, key) {
    const candidate = this.undoCandidate(data, key);
    if (!candidate) throw new Error('这张卡片已有新的修改或后续评分，无法撤销。');
    const { last, card } = candidate;
    Object.assign(card, structuredClone(last.before), { updatedAt: new Date().toISOString() });
    data.reviewRecords = data.reviewRecords.filter(record => record.id !== last.recordId);
    if (last.streakBefore) data.streak = structuredClone(last.streakBefore);
    const session = data.reviewSessions[key];
    session.results = session.results.filter(result => result.recordId !== last.recordId);
    session.currentId = card.id;
    return card.id;
  }
};
if (typeof module !== 'undefined' && module.exports) module.exports = ReviewSession;
