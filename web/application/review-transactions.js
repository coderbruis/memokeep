(function expose(root) {
  function createReviewTransactions({ transact, scheduler, model, now, uid, todayKey, awardCompletedRound }) {
    async function rate({ cardId, rating, shownAt, results, checkpoint, points = null }) {
      const reviewedAt = now();
      let entry;
      await transact(data => {
        const card = data.cards.find(item => item.id === cardId);
        const before = structuredClone(data);
        scheduler.configure?.(data.settings?.reviewSchedule);
        const result = scheduler.review(card, data.reviewRecords, rating, reviewedAt);
        Object.assign(card, result.card);
        // 按要点评分：每条想起 / 没想起记在卡片上（design/prototype/memory-boost-20261112.md）。
        const decided = Array.isArray(points) ? points.filter(point => point.got === true || point.got === false) : [];
        if (decided.length) globalThis.MemoKeepPointRecall?.record(card, points, reviewedAt);
        const record = { id: uid(), ...result.log, responseTimeMs: Math.max(0, reviewedAt - shownAt),
          ...(decided.length ? { points: { got: decided.filter(point => point.got).length, total: decided.length } } : {}) };
        data.reviewRecords.push(record);
        const day = todayKey(reviewedAt);
        if (data.streak.lastDay !== day) {
          const yesterday = todayKey(reviewedAt - 86_400_000);
          data.streak.count = data.streak.lastDay === yesterday ? data.streak.count + 1 : 1;
          data.streak.lastDay = day;
        }
        entry = { cardId: card.id, rating, recordId: record.id, reviewedAt, ...(decided.length ? { missed: decided.filter(point => !point.got).length } : {}),
          before: model.snapshot(before.cards.find(item => item.id === card.id)),
          after: model.snapshot(card), streakBefore: before.streak };
        checkpoint(data, [...results, entry]);
        awardCompletedRound?.(data, reviewedAt);
      });
      results.push(entry);
    }

    async function defer({ cardId, results, checkpoint, afterSave = () => {} }) {
      const entry = { cardId, rating: 'later' }, deferredAt = now();
      await transact(data => {
        const card = data.cards.find(item => item.id === cardId);
        card.dueAt = deferredAt + 60 * 60_000;
        card.updatedAt = new Date(deferredAt).toISOString();
        checkpoint(data, [...results, entry]);
        awardCompletedRound?.(data, deferredAt);
      });
      results.push(entry);
      afterSave();
    }
    async function undo(key) {
      let target;
      await transact(data => { target = model.undo(data, key); });
      return target;
    }

    return { rate, defer, undo };
  }
  const api = { createReviewTransactions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
