(function expose(root) {
  function createKnowledgeOperations({ state, transact, isoNow, availableDocumentTitle }) {
    async function updateLibrary(library, next) {
      const values = structuredClone(next), id = library.id;
      await transact(data => {
        const current = data.knowledgeBases.find(item => item.id === id);
        if (!current) throw new Error('知识库已不存在');
        Object.assign(current, values, { updatedAt: isoNow() });
      });
    }

    async function moveDocument(documentId, libraryId, { beforeSave, afterSave, onRollback }) {
      let changed = false, moved = false;
      try {
        await transact(data => {
          const document = data.documents.find(doc => doc.id === documentId), library = data.knowledgeBases.find(item => item.id === libraryId);
          if (!document || !library) throw new Error('笔记或目标目录已不存在');
          if (document.knowledgeBaseId === libraryId) return false;
          changed = true;
          document.knowledgeBaseId = libraryId;
          document.title = availableDocumentTitle(document.title, libraryId, documentId, null, data);
          document.updatedAt = isoNow();
          const itemIds = new Set();
          data.items.filter(item => item.documentId === documentId).forEach(item => {
            item.knowledgeBaseId = libraryId; item.updatedAt = document.updatedAt; itemIds.add(item.id);
          });
          data.cards.filter(card => itemIds.has(card.knowledgeItemId)).forEach(card => {
            card.knowledgeBaseId = libraryId; card.updatedAt = document.updatedAt;
          });
          beforeSave();
          moved = true;
        });
        if (!moved) return null;
        const result = { document: state.knowledge.documentById(documentId), library: state.knowledge.libraryById(libraryId) };
        afterSave(result);
        return result;
      } catch (error) {
        if (changed) onRollback();
        throw error;
      }
    }
    async function setDocumentFavorite(documentId, favorite) {
      await transact(data => {
        const document = [...data.documents, ...(data.cardDocuments || [])].find(item => item.id === documentId);
        if (!document) throw new Error('笔记已不存在，请先保存笔记');
        document.metadata = { ...(document.metadata || {}), favorite: favorite === true };
      });
      return state.knowledge.documentById(documentId);
    }
    return { updateLibrary, moveDocument, setDocumentFavorite };
  }
  const api = { createKnowledgeOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
