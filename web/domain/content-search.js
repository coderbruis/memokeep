(function expose(root) {
  const plain = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').replace(/\[!(?:要点|summary)\]/gi, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const normalizeQuery = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const searchTerms = query => normalizeQuery(query).trim().split(/\s+/).filter(Boolean);
  function indexContent(data) {
    const docs = [...(data.documents || []), ...(data.cardDocuments || [])];
    const notebookSources = new Set((data.cardNotebooks || []).map(note => note.sourceDocumentId));
    const docMap = new Map(docs.map(doc => [doc.id, doc]));
    const tags = new Map((data.noteTags || []).map(tag => [tag.id, tag]));
    const tagPath = id => { const names = [], seen = new Set(); while (tags.has(id) && !seen.has(id)) { seen.add(id); const tag = tags.get(id); names.push(tag.name); id = tag.parentId; } return names.join(' '); };
    const items = new Map((data.items || []).map(item => [item.id, item]));
    const titles = new Map(docs.map(doc => [doc.id, doc.title]));
    const libraries = new Map((data.knowledgeBases || []).map(entry => [entry.id, entry]));
    const folders = new Map((data.cardFolders || []).map(entry => [entry.id, entry]));
    const treePath = (byId, id) => { const names = [], seen = new Set(); for (let entry = byId.get(id); entry && !seen.has(entry.id); entry = byId.get(entry.parentId)) { seen.add(entry.id); names.unshift(entry.name); } return names.join(' / '); };
    return [
      ...docs.filter(doc => !notebookSources.has(doc.id)).map(doc => ({ kind: 'note', id: doc.id, title: doc.title || '未命名笔记', text: plain(doc.metadata?.noteContent || doc.content) + ' ' + (doc.tagIds || []).map(tagPath).join(' '), label: '笔记', path: treePath(libraries, doc.knowledgeBaseId) })),
      ...(data.cardNotebooks || []).map(doc => ({ kind: 'notebook', id: doc.id, title: doc.name, text: plain(docMap.get(doc.sourceDocumentId)?.metadata?.noteContent || docMap.get(doc.sourceDocumentId)?.content || doc.content), label: '卡片笔记', path: treePath(folders, doc.folderId) })),
      ...(data.cards || []).map(card => ({ kind: 'card', id: card.id, title: plain(card.question), text: plain(card.answer) + ' ' + (card.tags || []).join(' ') + ' ' + plain(items.get(card.knowledgeItemId)?.content) + ' ' + (titles.get(items.get(card.knowledgeItemId)?.documentId) || ''), label: '复习卡片', excerpt: plain(card.answer), path: titles.get(items.get(card.knowledgeItemId)?.documentId) || '' })),
      ...(data.memos || []).map(memo => ({ kind: 'memo', id: memo.id, title: memo.title, text: plain(memo.notes), label: '备忘录', path: '' }))
    ].map(entry => ({
      ...entry, normalizedTitle: normalizeQuery(entry.title), normalizedBody: normalizeQuery(`${entry.title || ''} ${entry.text}`)
    })).sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
  }
  function searchContent(data, query, limit = 50) {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const candidates = indexContent(data);
    return candidates.map(entry => {
      const { normalizedTitle: title, normalizedBody: content, ...result } = entry;
      return { ...result, score: terms.every(term => content.includes(term)) ? terms.reduce((score, term) => score + (title === term ? 0 : title.includes(term) ? 1 : 3), 0) : -1 };
    }).filter(entry => entry.score >= 0).sort((a, b) => a.score - b.score).slice(0, limit);
  }
  const api = { searchContent, indexContent, searchTerms };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
