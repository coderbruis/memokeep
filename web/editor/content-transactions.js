(function expose(root) {
  function createNoteContentTransaction({ state, session, services, view }) {
    async function persistSnapshot(snapshot) {
      if (!snapshot) return;
      snapshot = structuredClone(snapshot);
      const libraryId = session.libraryId, notebookId = session.notebookId;
      const draft = services.draft(session.target?.id);
      const targetId = session.target?.id;
      const previousTarget = session.target;
      let target, previousRichImageIds;
      await services.transact(data => {
        const currentDocument = [...data.documents, ...data.cardDocuments].find(doc => doc.id === targetId);
        target = currentDocument || draft?.draftDocument && structuredClone(draft.draftDocument);
        if (targetId && !target) return false;
        if (snapshot.editorMode === 'card') {
          const error = services.validateQuestions(target?.id, snapshot.content, data);
          if (error) throw new Error(error);
        }
        previousRichImageIds = services.imageIdsFromContent(target?.metadata?.noteContent);
        const parsedCards = snapshot.editorMode === 'card' ? services.parseCards(snapshot.content) : [];
        const timestamp = new Date().toISOString();
        if (currentDocument) {
          const previousVersion = services.versionFromDocument(target);
          if (!services.snapshotsMatch(previousVersion, snapshot, false)) {
            const existingVersions = Array.isArray(target.metadata?.versions) ? target.metadata.versions : [];
            target.metadata = {
              ...(target.metadata || {}),
              versions: [previousVersion, ...existingVersions.filter(version => !services.snapshotsMatch(version, previousVersion, false))]
                .slice(0, services.versionLimit)
            };
          }
          Object.assign(target, {
            title: snapshot.title,
            content: snapshot.content,
            sourceType: 'manual-markdown',
            updatedAt: timestamp
          });
        } else {
          target = {
            id: draft?.id || services.uid(),
            knowledgeBaseId: libraryId,
            title: snapshot.title,
            sourceType: 'manual-markdown',
            sourceFileName: null,
            content: snapshot.content,
            metadata: {},
            createdAt: timestamp,
            updatedAt: timestamp
          };
          if (draft?.draftNotebook) {
            data.cardDocuments.push(target);
            data.cardNotebooks.push({ ...draft.draftNotebook, name: snapshot.title });
          } else data.documents.push(target);
        }

        if (!notebookId) target.tagIds = services.normalizeTagIds(snapshot.tagIds);
        target.metadata = {
          ...(target.metadata || {}),
          size: new TextEncoder().encode(`${snapshot.content}${snapshot.noteContent}`).length,
          inlineCardCount: parsedCards.length,
          editorMode: snapshot.editorMode,
          noteContent: snapshot.noteContent,
          noteContentInitialized: snapshot.noteContentInitialized,
          inlineTagRows: structuredClone(snapshot.inlineTagRows || [])
        };
        const ownNotebook = data.cardDocuments.some(doc => doc.id === target.id)
          ? data.cardNotebooks.find(note => note.sourceDocumentId === target.id) : null;
        if (ownNotebook) ownNotebook.name = snapshot.title;
        services.syncInlineCards(target, parsedCards, data);
        services.syncCardSources?.(data, target);
      });
      if (!target) { session.target = previousTarget; return; }
      session.target = target;
      if (draft) { delete draft.draftDocument; delete draft.draftNotebook; delete draft.draftBaseline; draft.dirty = false; }
      session.target = services.documentById(session.target.id) || session.target;
      session.richContent = snapshot.noteContent;
      const richImagesToClean = [...previousRichImageIds, ...session.imageIds];
      session.imageIds.clear();
      if (richImagesToClean.length) {
        try {
          await services.deleteImages(richImagesToClean);
        } catch (error) {
          if (services.isCurrent()) view.notify(`笔记已保存，但图片清理失败：${error.message}`, true);
        }
      }

      if (services.isCurrent()) {
        const tab = session.tabs.find(tab => tab.id === session.activeId);
        if (tab) tab.id = session.target.id;
        session.activeId = session.target.id;
        view.setDocumentId(session.target.id);
        session.savedSnapshot = { ...snapshot };
        view.refreshSaveState();
        view.renderVersionMenu();
      }
      view.renderSidebar();
      view.renderCards();
    }
    return { persist: persistSnapshot };
  }
  const api = { createNoteContentTransaction };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepEditor ||= {}, api);
})(globalThis);
