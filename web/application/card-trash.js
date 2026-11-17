(function expose(root) {
  function createCardTrashOperations({ runtime, transact, domain, directory, hooks, helpers }) {
    const { uid, removeTrashedInlineRows, initialInlineTagRows, updateInlineNoteRows } = helpers;
    const folderId = (candidate, card) => Object.hasOwn(card, 'cardFolderId') ? card.cardFolderId || null
      : candidate.cardNotebooks.find(note => note.id === card.cardNotebookId)?.folderId || null;
    // Complete snapshots retain scheduling and source information across deletion.
    async function trashCards(cardIds) {
      const ids = new Set(cardIds);
      let cards, entries;
      try { await transact(candidate => {
        cards = candidate.cards.filter(card => ids.has(card.id));
        if (!cards.length) return false;
        entries = cards.map(card => {
          const notebook = candidate.cardNotebooks.find(note => note.id === card.cardNotebookId);
          const folder = candidate.cardFolders.find(item => item.id === folderId(candidate, card));
          return { id: uid(), type: 'card', deletedAt: new Date().toISOString(), card: structuredClone(card),
            notebook: notebook ? structuredClone(notebook) : null, folder: folder ? structuredClone(folder) : null,
            folders: structuredClone(directory.ancestors(candidate.cardFolders, folder?.id)),
            originalLocation: [folder?.name, notebook?.name].filter(Boolean).join(' / ') || '未分类' };
        });
        removeTrashedInlineRows(entries, candidate);
        candidate.trash.unshift(...entries);
        candidate.cards = candidate.cards.filter(card => !ids.has(card.id));
      }); } catch (error) { hooks.renderAll(); throw error; }
      if (!cards.length) return;
      ids.forEach(id => runtime.selectedCardIds.delete(id));
      hooks.renderAll();
      hooks.renderTrash();
      hooks.showCardUndo(entries.map(entry => entry.id), cards.length);
    }

    async function restoreCardTrash(entryIds) {
      const ids = new Set(entryIds);
      const restoredEntries = [];
      try { await transact(candidate => {
        const entries = candidate.trash.filter(entry => ids.has(entry.id) && entry.type === 'card');
        if (!entries.length) return false;
        entries.sort((a, b) => (a.inlineSource?.line || 0) - (b.inlineSource?.line || 0)).forEach(entry => {
          if (entry.card.cardFolderId && candidate.cards.some(card => card.id !== entry.card.id
            && folderId(candidate, card) === entry.card.cardFolderId && card.question.trim() === entry.card.question.trim())) return;
          const source = entry.inlineSource;
          if (source) {
            const note = [...candidate.documents, ...candidate.cardDocuments].find(note => note.id === source.documentId);
            if (!note || note.metadata?.editorMode !== 'card') return;
            const question = domain.parseInlineCardLine(source.row.raw)?.question;
            if (domain.parseInlineCards(note.content).some(card => card.question === question)
              || candidate.cards.some(card => card.cardNotebookId === entry.card.cardNotebookId && card.question.trim() === entry.card.question.trim())) return;
            let rows = initialInlineTagRows(note, candidate);
            if (!note.content) rows = [];
            rows.splice(Math.min(source.line, rows.length), 0, structuredClone(source.row));
            if (!candidate.items.some(item => item.id === source.item.id)) candidate.items.push(structuredClone(source.item));
            updateInlineNoteRows(note, rows, candidate);
          }
          for (const folder of entry.folders || []) if(!candidate.cardFolders.some(current=>current.id===folder.id)) candidate.cardFolders.push(structuredClone(folder));
          restoredEntries.push(entry);
          if (entry.notebook && !candidate.cardNotebooks.some(note => note.id === entry.notebook.id)) {
            if (entry.folder && !candidate.cardFolders.some(folder => folder.id === entry.folder.id)) candidate.cardFolders.push(structuredClone(entry.folder));
            candidate.cardNotebooks.push(structuredClone(entry.notebook));
          }
          if (!candidate.cards.some(card => card.id === entry.card.id)) candidate.cards.push(structuredClone(entry.card));
        });
        candidate.trash = candidate.trash.filter(entry => !restoredEntries.some(restored => restored.id === entry.id));
      }); } catch (error) { hooks.renderAll(); hooks.renderTrash(); throw error; }
      hooks.renderAll();
      hooks.renderTrash();
      return restoredEntries.length;
    }
    return { trashCards, restoreCardTrash };
  }
  const api = { createCardTrashOperations };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
