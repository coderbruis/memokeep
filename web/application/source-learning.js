(function expose(root) {
  function createSourceLearningOperations({ state, transact, uid, createCard, domain, describeDocument, now = Date.now }) {
    const documentIn = (data, id) => [...data.documents, ...(data.cardDocuments || [])].find(doc => doc.id === id);
    const initialize = (data, id) => { const doc = documentIn(data, id); if (!doc) throw new Error('来源笔记已不存在'); domain.ensureSourceDocument(doc, describeDocument(doc), uid); return doc; };
    const validate = fields => { if (!fields.question?.trim() || !fields.answer?.trim()) throw new Error('问题和答案不能为空'); if (fields.question.length > 6000 || fields.answer.length > 24000) throw new Error('内容太长，请拆成较小的知识点'); if (fields.cardType === 'cloze' && !/\{\{c\d+::[^{}]+\}\}/.test(fields.question)) throw new Error('填空卡需包含 {{c1::答案}} 标记'); };
    async function createCandidates(documentId, rows) {
      if (!rows.length || rows.length > 30) throw new Error('每次可添加1–30张候选');
      for (const row of rows) validate(row);
      let added = 0;
      await transact(data => {
        const doc = initialize(data, documentId); data.cardCandidates ||= [];
        for (const row of rows) {
          const source = domain.sourceFromBlocks(doc, row.quote, row.blockId);
          if (data.cardCandidates.some(candidate => candidate.status === 'pending' && domain.duplicateCard([candidate], row))) continue;
          data.cardCandidates.push({ id: uid(), question: row.question.trim(), answer: row.answer.trim(), criteria: row.criteria || '', cardType: row.cardType || 'qa', tags: [...(row.tags || [])], source, status: 'pending', createdAt: now() }); added++;
        }
      }); return added;
    }
    async function updateCandidate(id, fields) {
      validate(fields); await transact(data => {
        const candidate = data.cardCandidates?.find(row => row.id === id && row.status === 'pending'); if (!candidate) throw new Error('候选已处理');
        const doc = initialize(data, fields.documentId || candidate.source.documentId);
        Object.assign(candidate, { question: fields.question.trim(), answer: fields.answer.trim(), criteria: fields.criteria || '', cardType: fields.cardType || 'qa', source: domain.sourceFromBlocks(doc, fields.quote, fields.blockId), updatedAt: now() });
      });
    }
    async function acceptCandidates(ids) {
      let accepted = 0, duplicate = 0;
      await transact(data => {
        for (const id of ids) {
          const candidate = data.cardCandidates?.find(row => row.id === id && row.status === 'pending'); if (!candidate) continue;
          const source = domain.resolveCardSource(data, candidate.source); if (source.stale) throw new Error('有候选的来源已变化，请先检查并刷新候选');
          validate(candidate);
          if (domain.duplicateCard(data.cards, candidate)) { candidate.status = 'duplicate'; duplicate++; continue; }
          const item = { id: uid(), documentId: source.document.id, knowledgeBaseId: source.document.knowledgeBaseId, itemType: 'selection-card', frontText: candidate.question, backText: candidate.answer, source: structuredClone(candidate.source), sourceLocation: { type: 'block', blockId: candidate.source.blockId }, tags: candidate.tags, createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
          data.items.push(item);
          const card = createCard({ question: candidate.question, answer: candidate.answer, tags: candidate.tags, knowledgeBaseId: item.knowledgeBaseId, knowledgeItemId: item.id });
          card.cardType = candidate.cardType; card.source = structuredClone(candidate.source); data.cards.unshift(card); candidate.status = 'accepted'; candidate.cardId = card.id; accepted++;
        }
      }); return { accepted, duplicate };
    }
    async function discardCandidate(id) { await transact(data => { const row = data.cardCandidates?.find(row => row.id === id); if (row) row.status = 'discarded'; }); }
    async function resolveChange(id, { answer, question, reset = false, ignore = false }) {
      await transact(data => {
        const change = data.sourceChanges?.find(row => row.id === id && ['pending', 'orphan'].includes(row.status)); if (!change) throw new Error('这项变化已处理');
        const card = data.cards.find(card => card.id === change.cardId), item = data.items.find(item => item.id === change.itemId); if (!card || !item) throw new Error('卡片已不存在');
        if (ignore) { change.status = 'ignored'; return; }
        const current = domain.resolveCardSource(data, card.source || item.source); if (current.orphan) throw new Error('来源已删除，请重新关联或保留当前快照');
        if (current.text !== change.newText || current.version !== change.sourceVersion) throw new Error('原文再次发生变化，请刷新后重新检查');
        validate({ question, answer, cardType: card.cardType });
        Object.assign(card, { question: question.trim(), answer: answer.trim(), updatedAt: new Date(now()).toISOString() });
        if (reset) Object.assign(card, { dueAt: now(), schedulerResetAt: now(), schedulerData: {}, strength: 0 });
        item.frontText = card.question; item.backText = card.answer;
        card.source = { ...(card.source || item.source), quote: current.text, blockText: current.text, version: current.version, title: current.document.title };
        item.source ||= structuredClone(card.source);
        change.status = 'accepted'; change.resolvedAt = now();
      });
    }
    async function relink(cardId, documentId, blockId, reset = false) {
      await transact(data => {
        const card = data.cards.find(row => row.id === cardId); if (!card) throw new Error('卡片已不存在');
        const doc = initialize(data, documentId), block = doc.metadata.sourceBlocks.find(row => row.id === blockId); if (!block) throw new Error('请选择来源段落');
        let item = data.items.find(row => row.id === card.knowledgeItemId);
        if (!item) { item = { id: uid(), itemType: 'selection-card', tags: [] }; data.items.push(item); card.knowledgeItemId = item.id; }
        Object.assign(item, { documentId, knowledgeBaseId: doc.knowledgeBaseId, frontText: card.question, backText: card.answer, source: domain.sourceFromBlocks(doc, block.text, blockId), sourceLocation: { type: 'block', blockId } });
        card.source = structuredClone(item.source);
        card.knowledgeBaseId = doc.knowledgeBaseId; card.updatedAt = new Date(now()).toISOString();
        if (reset) Object.assign(card, { dueAt: now(), schedulerResetAt: now(), schedulerData: {}, strength: 0 });
        for (const change of data.sourceChanges || []) if (change.cardId === cardId && ['pending', 'orphan'].includes(change.status)) change.status = 'relinked';
      });
    }
    async function favoriteCard(id, value) { await transact(data => { const card = data.cards.find(card => card.id === id); if (!card) throw new Error('卡片已不存在'); card.favorite = Boolean(value); }); }
    return { createCandidates, updateCandidate, acceptCandidates, discardCandidate, resolveChange, relink, favoriteCard };
  }
  const api = { createSourceLearningOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
