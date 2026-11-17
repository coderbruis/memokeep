(function expose(root) {
  function selectCardList({ cards, query, stage, libraryId, sort, stageOf, sourceLabel, matchesTags, kind = 'all', extra = null }) {
    const matching = cards.filter(card => {
      const searchable = `${card.question} ${card.answer} ${sourceLabel(card)} ${(card.tags || []).join(' ')}`.toLowerCase();
      // 「知识点」是来源筛选，不是复习阶段。
      return searchable.includes(query) && (stage === 'all' || (stage === 'point' ? card.cardType === 'point' : stageOf(card) === stage))
        && (libraryId === 'all' || card.knowledgeBaseId === libraryId) && matchesTags(card)
        // 类型：知识点（来自笔记要点）/ 普通卡片。
        && (kind === 'all' || (kind === 'point') === (card.cardType === 'point'))
        && (!extra || extra(card));
    });
    const time = card => sort === 'due' ? Number(card.dueAt) : Date.parse(sort === 'created' ? card.createdAt : card.updatedAt) || 0;
    return matching.sort((a, b) => sort === 'due' ? time(a) - time(b) : time(b) - time(a));
  }
  const api = { selectCardList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
