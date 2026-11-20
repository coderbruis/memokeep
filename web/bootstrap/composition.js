(function expose(root) {
  function createApplication({ modules, ports }) {
    const state = modules.state.createApplicationState(ports.data);
    const storage = modules.persistence.createStorageAdapter({ ...ports.storage, mergeWindowData: ports.patches.mergeWindowData });
    const sync = modules.persistence.createSyncCoordinator({ state: ports.persistenceState, storage, normalize: ports.normalize,
      patches: ports.patches, ...ports.sync });
    const saving = modules.persistence.createSaveCoordinator({ state: ports.persistenceState, storage, normalize: ports.normalize,
      patches: ports.patches, refresh: () => sync.refresh(),
      onError: error => ports.notify(`保存失败：${error.message}`, true),
      onSyncError: error => ports.notify(`同步失败：${error.message}`, true) });
    const persistence = { storage, ...saving, ...sync };
    const dependencies = { state, save: () => persistence.save(), transact: (change, context) => persistence.transact(change, context), ...ports.actions };
    const operations = {
      cards: modules.operations.createCardOperations(dependencies), memos: modules.operations.createMemoOperations(dependencies),
      settings: modules.operations.createSettingsOperations(dependencies), knowledge: modules.operations.createKnowledgeOperations(dependencies)
    };
    if (modules.operations.createPlanOperations) operations.plans = modules.operations.createPlanOperations(dependencies);
    if (modules.operations.createSourceLearningOperations) operations.sourceLearning = modules.operations.createSourceLearningOperations({ ...dependencies, domain: modules.domain });
    let cards, cardEvents, cardRuntime, cardEditor, cardDetail, cardDialogs, cardBulk;
    if (ports.cards) {
      cardRuntime = modules.operations.createCardRuntime();
      if (ports.cardBulk) {
        operations.cardTrash = modules.operations.createCardTrashOperations({ ...ports.cardBulk, state, runtime: cardRuntime,
          domain: modules.domain, transact: (change, context) => persistence.transact(change, context), hooks: {
            renderAll: ports.cardBulk.helpers.renderAll, renderTrash: ports.cardBulk.helpers.renderTrash,
            showCardUndo: (...args) => cardBulk.showCardUndo(...args) } });
        cardBulk = modules.views.createCardBulkView({ ...ports.cardBulk, state, runtime: cardRuntime,
          operations: operations.cards, trash: operations.cardTrash });

      }
      if (ports.cardDialogs) {
        cardEditor = modules.views.createCardEditor({ ...ports.cardDialogs, state, runtime: cardRuntime,
          imageIds: modules.domain.noteImageIdsFromContent, transact: (change, context) => persistence.transact(change, context) });
        cardDetail = modules.views.createCardDetail({ ...ports.cardDialogs, state, transact: (change, context) => persistence.transact(change, context) });
        cardDialogs = modules.views.createCardDialogBindings({ ...ports.cardDialogs, state, editor: cardEditor,
          detail: cardDetail, deleteCardById: cardBulk.deleteCardById });
      }
      cards = modules.views.createCardListView({ ...ports.cards, runtime: cardRuntime, state,
        helpers: { ...ports.cards.helpers, CARD_PAGE_SIZE: modules.operations.CARD_PAGE_SIZE }, selectCardList: modules.domain.selectCardList });
      cardEvents = modules.views.createCardListBindings({ ...ports.cards, runtime: cardRuntime, state, view: cards, actions: { ...ports.cards.actions, ...cardBulk, ...(cardEditor ? { openCardDialog: cardEditor.openCardDialog } : {}) }, save: () => persistence.save() });
    }
    let review, reviewEvents, reviewRuntime;
    if (ports.review) {
      reviewRuntime = modules.operations.createReviewRuntime();
      operations.reviewTransactions = modules.operations.createReviewTransactions({ ...dependencies,
        ...ports.review, model: ports.review.model, awardCompletedRound: modules.domain?.awardCompletedRound });
      review = modules.views.createReviewView({ ...ports.review.ui, state, runtime: reviewRuntime,
        transactions: operations.reviewTransactions, operations: () => operations.review });
      reviewEvents = modules.views.createReviewBindings({ ...ports.review.ui, state, runtime: reviewRuntime,
        view: review, operations: () => operations.review });
      const reviewEnvironment = cardRuntime ? Object.create(ports.review.environment, {
        cardScope: { get: () => cardRuntime.cardScope }
      }) : ports.review.environment;
      operations.review = modules.operations.createReviewOperations({ ...ports.review, runtime: reviewRuntime, environment: reviewEnvironment,
        view: { ...review, ...ports.review.candidates },
        store: ports.persistenceState, persistence, now: ports.actions.now, normalize: ports.normalize,
        transactions: operations.reviewTransactions });
    }
    const session = modules.editor.createEditorSession({ state: ports.editorState, view: ports.editorView,
      actions: { ...ports.editorActions, refresh: () => persistence.refresh() } });
    const tabs = modules.views.createNoteTabView(ports.tabs);
    return { state, persistence, operations, cards: { runtime: cardRuntime }, review: { runtime: reviewRuntime }, domain: modules.domain, editor: { session, factories: modules.editor }, views: { tabs, cards, cardEvents, cardEditor, cardDetail, cardDialogs, cardBulk, review, reviewEvents } };
  }
  const api = { createApplication };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepBootstrap ||= {}, api);
})(globalThis);
