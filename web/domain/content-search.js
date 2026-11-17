(function expose(root) {
  const plain = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').replace(/\[!(?:要点|summary)\]/gi, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  function searchContent(data, query, limit = 50) {
    const terms = String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const docs = [...(data.documents || []), ...(data.cardDocuments || [])];
    const notebookSources = new Set((data.cardNotebooks || []).map(note => note.sourceDocumentId));
    const docMap = new Map(docs.map(doc => [doc.id, doc]));
    const tags = new Map((data.noteTags || []).map(tag => [tag.id, tag]));
    const tagPath = id => { const names = [], seen = new Set(); while (tags.has(id) && !seen.has(id)) { seen.add(id); const tag = tags.get(id); names.push(tag.name); id = tag.parentId; } return names.join(' '); };
    const items = new Map((data.items || []).map(item => [item.id, item]));
    const titles = new Map(docs.map(doc => [doc.id, doc.title]));
    const treePath = (list, id) => { const byId = new Map((list || []).map(entry => [entry.id, entry])), names = [], seen = new Set(); for (let entry = byId.get(id); entry && !seen.has(entry.id); entry = byId.get(entry.parentId)) { seen.add(entry.id); names.unshift(entry.name); } return names.join(' / '); };
    const candidates = [
      ...docs.filter(doc => !notebookSources.has(doc.id)).map(doc => ({ kind: 'note', id: doc.id, title: doc.title || '未命名笔记', text: plain(doc.metadata?.noteContent || doc.content) + ' ' + (doc.tagIds || []).map(tagPath).join(' '), label: '笔记', path: treePath(data.knowledgeBases, doc.knowledgeBaseId) })),
      ...(data.cardNotebooks || []).map(doc => ({ kind: 'notebook', id: doc.id, title: doc.name, text: plain(docMap.get(doc.sourceDocumentId)?.metadata?.noteContent || docMap.get(doc.sourceDocumentId)?.content || doc.content), label: '卡片笔记', path: treePath(data.cardFolders, doc.folderId) })),
      ...(data.cards || []).map(card => ({ kind: 'card', id: card.id, title: plain(card.question), text: plain(card.answer) + ' ' + (card.tags || []).join(' ') + ' ' + plain(items.get(card.knowledgeItemId)?.content) + ' ' + (titles.get(items.get(card.knowledgeItemId)?.documentId) || ''), label: '复习卡片', excerpt: plain(card.answer), path: titles.get(items.get(card.knowledgeItemId)?.documentId) || '' })),
      ...(data.memos || []).map(memo => ({ kind: 'memo', id: memo.id, title: memo.title, text: plain(memo.notes), label: '备忘录', path: '' }))
    ];
    return candidates.map(entry => {
      const title = String(entry.title || '').normalize('NFKC').toLocaleLowerCase();
      const content = `${title} ${entry.text}`.normalize('NFKC').toLocaleLowerCase();
      return { ...entry, score: terms.every(term => content.includes(term)) ? terms.reduce((score, term) => score + (title === term ? 0 : title.includes(term) ? 1 : 3), 0) : -1 };
    }).filter(entry => entry.score >= 0).sort((a, b) => a.score - b.score || String(a.title).localeCompare(String(b.title), 'zh-CN')).slice(0, limit);
  }
  const api = { searchContent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
