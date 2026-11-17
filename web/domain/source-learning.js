(function expose(root) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const key = value => clean(String(value || '').replace(/<[^>]*>/g, '')).normalize('NFKC').toLocaleLowerCase();
  const allDocuments = data => [...(data.documents || []), ...(data.cardDocuments || [])];
  function reconcileSourceBlocks(previous = [], descriptors = [], uid) {
    const used = new Set(), oldIndex = new Map(previous.map((block, index) => [block.id, index]));
    const blocks = descriptors.filter(block => clean(block.text)).map(block => ({ text: String(block.text).trim(), type: block.type || 'p' }));
    for (const block of blocks) {
      const match = previous.find(old => !used.has(old.id) && clean(old.text) === clean(block.text));
      if (match) { block.id = match.id; used.add(match.id); }
    }
    let before = -1;
    for (let start = 0; start < blocks.length;) {
      if (blocks[start].id) { before = oldIndex.get(blocks[start].id); start++; continue; }
      let end = start; while (end < blocks.length && !blocks[end].id) end++;
      const after = end < blocks.length ? oldIndex.get(blocks[end].id) : previous.length;
      const available = previous.filter((block, index) => !used.has(block.id) && index > before && index < after);
      if (available.length === end - start) for (let i = start; i < end; i++) { blocks[i].id = available[i - start].id; used.add(blocks[i].id); }
      for (let i = start; i < end; i++) blocks[i].id ||= uid();
      start = end;
    }
    return blocks.map((block, index) => ({ ...block, index }));
  }
  function sourceFromBlocks(document, quote, blockId = null) {
    const blocks = document.metadata?.sourceBlocks || [], normalized = clean(quote);
    let index = blockId ? blocks.findIndex(block => block.id === blockId) : blocks.findIndex(block => clean(block.text).includes(normalized));
    if (index < 0 && normalized) index = blocks.findIndex(block => normalized.startsWith(clean(block.text)) || clean(block.text).includes(normalized.split(' ').slice(0, 4).join(' ')));
    if (index < 0) throw new Error('找不到对应的来源段落，请重新选择原文。');
    let text = blocks[index].text, end = index;
    while (normalized && !clean(text).includes(normalized) && end + 1 < blocks.length) text += '\n' + blocks[++end].text;
    if (normalized && !clean(text).includes(normalized)) throw new Error('选中文字已与保存的原文不一致，请先保存笔记。');
    return { documentId: document.id, title: document.title, blockId: blocks[index].id, blockIds: blocks.slice(index, end + 1).map(block => block.id), quote: String(quote || text), blockText: text, version: document.metadata?.sourceVersion || 1 };
  }
  function resolveCardSource(data, source) {
    const document = allDocuments(data).find(doc => doc.id === source?.documentId);
    if (!document) return { document: null, text: '', orphan: true, stale: true };
    const ids = source.blockIds?.length ? source.blockIds : [source.blockId];
    const blocks = ids.map(id => document.metadata?.sourceBlocks?.find(block => block.id === id));
    const orphan = blocks.some(block => !block), text = orphan ? '' : blocks.map(block => block.text).join('\n');
    return { document, blocks, text, orphan, stale: orphan || clean(text) !== clean(source.blockText || source.quote), version: document.metadata?.sourceVersion || 1 };
  }
  function ensureSourceDocument(document, descriptors, uid) {
    const previous = document.metadata?.sourceBlocks || [];
    const blocks = reconcileSourceBlocks(previous, descriptors, uid);
    const changed = previous.length && JSON.stringify(previous.map(block => [block.id, block.text])) !== JSON.stringify(blocks.map(block => [block.id, block.text]));
    document.metadata = { ...(document.metadata || {}), sourceBlocks: blocks, sourceVersion: Math.max(1, Number(document.metadata?.sourceVersion) || 1) + (changed ? 1 : 0) };
    return blocks;
  }
  function syncSourceChanges(data, document, descriptors, uid, at = Date.now()) {
    ensureSourceDocument(document, descriptors, uid);
    data.sourceChanges ||= [];
    const sources = new Map((data.items || []).map(item => [item.id, item]));
    for (const card of data.cards) {
      const item = sources.get(card.knowledgeItemId), source = card.source || item?.source;
      if (!item || source?.documentId !== document.id) continue;
      const result = resolveCardSource(data, source);
      const prior = data.sourceChanges.find(change => change.cardId === card.id && ['pending', 'orphan'].includes(change.status));
      if (!result.stale) { if (prior) prior.status = 'unchanged'; continue; }
      if (data.sourceChanges.some(change => change.cardId === card.id && change.status === 'ignored' && change.newText === result.text)) { if (prior) prior.status = 'ignored'; continue; }
      const values = { cardId: card.id, itemId: item.id, documentId: document.id, source: structuredClone(source), oldText: source.blockText || source.quote, newText: result.text, oldAnswer: card.answer, newAnswer: key(card.answer) === key(source.quote) ? result.text : card.answer, sourceVersion: result.version, status: result.orphan ? 'orphan' : 'pending', updatedAt: at };
      if (prior) Object.assign(prior, values); else data.sourceChanges.push({ id: uid(), createdAt: at, ...values });
    }
  }
  function duplicateCard(cards, candidate, excludeId = null) {
    return cards.find(card => card.id !== excludeId && card.status !== 'archived' && key(card.question) === key(candidate.question) && key(card.answer) === key(candidate.answer) && (card.cardType || 'qa') === (candidate.cardType || 'qa'));
  }
  const api = { cleanSourceText: clean, reconcileSourceBlocks, sourceFromBlocks, resolveCardSource, ensureSourceDocument, syncSourceChanges, duplicateCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
