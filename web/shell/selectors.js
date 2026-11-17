(function expose(root) {
  function createSelectors({ state, config, actions, env }) {
    function escapeHtml(value = '') { const div = env.document.createElement('div'); div.textContent = String(value); return div.innerHTML; }

    function todayKey(timestamp = config.now()) { return env.MemoKeepDomain.todayKey(timestamp); }

    function dueCards() { return env.MemoKeepDomain.dueCards(env.application.state.read(), config.now()); }

    function reviewsToday() { return env.MemoKeepDomain.reviewsToday(env.application.state.read(), config.now()); }

    function formatDate(timestamp) { return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp); }

    function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }

    function documentById(id) { return env.application.state.knowledge.documentById(id) || env.noteDraftTab(id)?.draftDocument; }

    function sourceLabel(card) { const item = env.application.state.knowledge.itemById(card.knowledgeItemId); const doc = actions.documentById(card.cardType === 'point' ? card.pointDocumentId : item?.documentId); return doc?.title || env.application.state.knowledge.libraryById(card.knowledgeBaseId)?.name || '手动创建'; }

    function cardSourceNoteLabel(card) { const item = env.application.state.knowledge.itemById(card.knowledgeItemId); return actions.documentById(item?.documentId)?.title || '手动创建'; }

    function availableLibraryName(requestedName, excludedId = null, parentId = null) {
      return env.application.domain.nextAvailableName(
      requestedName,
      state.persistence.data.knowledgeBases.filter(library => library.id !== excludedId && (library.parentId || null) === parentId).map(library => library.name),
      50
      );
    }

    function availableDocumentTitle(requestedTitle, libraryId, excludedId = null, fileType = null, data = state.persistence.data) {
      if (!fileType && excludedId) fileType = env.MemoKeepNoteFiles.of([...data.documents, ...(data.cardDocuments || [])].find(doc => doc.id === excludedId)).id;
      return env.application.domain.nextAvailableName(
      requestedTitle,
      data.documents
      .filter(document => document.knowledgeBaseId === libraryId && document.id !== excludedId && (!fileType || env.MemoKeepNoteFiles.of(document).id === fileType))
      .map(document => document.title),
      100
      );
    }

    async function deleteUnreferencedNoteImageFiles(imageIds) {
      if (!config.desktop?.deleteNoteImage) return;
      const snapshots = [state.persistence.data, state.persistence.persistedData].filter(Boolean);
      const referencedImageIds = new Set([
        ...snapshots.flatMap(env.application.domain.dataImageIds),
        ...env.application.domain.dataImageIds({ documents: env.openNoteTabs.filter(tab => tab.draftDocument).map(tab => tab.draftDocument) })
      ]);
      for (const imageId of new Set(imageIds)) {
        if (!referencedImageIds.has(imageId)) await config.desktop.deleteNoteImage(imageId);
      }
    }

    function cardStage(card) {
      if (card.status === 'paused') return 'paused';
      if (card.reviewCount === 0) return 'new';
      if (card.dueAt <= config.now()) return 'due';
      if (card.strength >= 3) return 'mastered';
      return 'learning';
    }

    function cardDueLabel(card, stage) {
      if (stage === 'paused') return '—';
      if (stage === 'new' && card.dueAt <= config.now()) return '今天';
      const date = new Date(card.dueAt);
      if (!Number.isFinite(date.getTime())) return '—';
      const day = actions.todayKey(date.getTime());
      if (day === actions.todayKey()) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      if (day === actions.todayKey(config.now() + config.DAY)) return '明天';
      return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), month: 'short', day: 'numeric' });
    }

    function createCard({ question, answer, knowledgeBaseId = null, knowledgeItemId = null, cardNotebookId = null, cardFolderId = undefined, tags = [], createdAt = new Date().toISOString() }) {
      return { id: config.uid(), knowledgeBaseId, knowledgeItemId, cardNotebookId, ...(cardFolderId !== undefined ? {cardFolderId} : {}), question, answer, direction: 'forward', tags, status: 'active', dueAt: config.now(), lastReviewedAt: null, reviewCount: 0, lapseCount: 0, strength: 0, schedulerVersion: 'mvp-1', schedulerData: {}, createdAt, updatedAt: createdAt };
    }
    return { escapeHtml, todayKey, dueCards, reviewsToday, formatDate, formatBytes, documentById, sourceLabel, cardSourceNoteLabel, availableLibraryName, availableDocumentTitle, deleteUnreferencedNoteImageFiles, cardStage, cardDueLabel, createCard };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createSelectors });
})(globalThis);
