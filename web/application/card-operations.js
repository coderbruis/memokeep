(function expose(root) {
  function createCardOperations({ state, save, transact, uid, isoNow, now, history, folderId, duplicateQuestion }) {
    async function move(ids, destination) {
      if (!ids.size) return { count: 0 };
      let duplicate = false;
      const count = ids.size, selected = new Set(ids), target = structuredClone(destination), timestamp = isoNow();
      await transact(data => {
        const destinationCards = data.cards.filter(card => selected.has(card.id)
          || (target.cardFolderId ? folderId(card) === target.cardFolderId : card.cardNotebookId === target.cardNotebookId));
        if ((target.cardFolderId || target.cardNotebookId) && duplicateQuestion(destinationCards)) { duplicate = true; return false; }
        data.cards.forEach(card => {
          if (!selected.has(card.id)) return;
          if (!Object.prototype.hasOwnProperty.call(target, 'cardFolderId')) delete card.cardFolderId;
          Object.assign(card, target);
          card.updatedAt = timestamp;
        });
      });
      if (duplicate) return { duplicate: true };
      return { count };
    }
    async function setStatus(ids, status, onChanged) {
      if (!ids.size) return 0;
      const timestamp = isoNow();
      state.cards.all.forEach(card => {
        if (!ids.has(card.id)) return;
        card.status = status;
        card.updatedAt = timestamp;
      });
      const count = ids.size;
      onChanged();
      await save();
      return count;
    }
    async function restart(ids) {
      if (!ids.size) return 0;
      const count = ids.size;
      const restartedAt = now(), updatedAt = new Date(restartedAt).toISOString();
      let beforeCards;
      const apply = (cards, records) => {
        beforeCards = cards.filter(card => ids.has(card.id)).map(card => structuredClone(card));
        cards.forEach(card => {
          if (!ids.has(card.id)) return;
          card.status = 'active';
          card.dueAt = restartedAt;
          const previous = history(card, records);
          card.lastReviewedAt = previous.lastReviewedAt;
          card.reviewCount = previous.count;
          card.schedulerResetAt = restartedAt;
          card.strength = 0;
          card.schedulerData = {};
          card.updatedAt = updatedAt;
        });
      };
      if (transact && uid) {
        const commandId = uid();
        await transact(data => apply(data.cards, data.reviewRecords), () => ({ commandId,
          domainEvents: [{ kind: 'card.restarted', cardIds: [...ids], beforeCards, occurredAt: restartedAt }] }));
      } else { apply(state.cards.all, state.review.records); await save(); }
      return count;
    }
    return { move, setStatus, restart };
  }
  const api = { createCardOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
