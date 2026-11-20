// Drafts belong to tabs until an explicit save adds them to the library.
let openNoteTabs = [];
let noteTabActionPending = false;
let noteTabBatchPending = false;
let captureActiveNoteDraft = null;

function noteDraftTab(id = applicationShell.state.editor.editingMarkdownDocumentId) {
  return openNoteTabs.find(tab => tab.id === id && tab.draftDocument);
}





function rememberNoteTab(document, cardNotebookId = null) {
  const id = document?.id || 'new';
  let tab = openNoteTabs.find(tab => tab.id === id);
  if (!tab) { tab = { id, cardNotebookId, scrollTop: 0 }; openNoteTabs.push(tab); }
  tab.cardNotebookId = cardNotebookId;
  return tab;
}





async function activateNoteTab(id) {
  const tab = openNoteTabs.find(tab => tab.id === id);
  if (!tab) return false;
  const document = applicationShell.actions.documentById(id);
  if (!document && id !== 'new') { application.views.tabs.renderNoteTabs(); applicationShell.actions.showToast('笔记已不存在', true); return false; }
  return applicationShell.actions.openMarkdownNoteEditor(document, '', null, tab.cardNotebookId);
}

async function closeNoteTab(id, batch = false) {
  if (noteTabActionPending || applicationShell.state.persistence.dataSavePending || noteTabBatchPending && !batch) return false;
  const index = openNoteTabs.findIndex(tab => tab.id === id); if (index < 0) return false;
  const draft = noteDraftTab(id);
  if (applicationShell.state.editor.editingMarkdownDocumentId !== id && draft?.dirty) {
    noteTabActionPending = true;
    let action;
    try { action = await applicationShell.actions.showUnsavedNoteDialog(id); }
    finally { noteTabActionPending = false; }
    if (action === 'cancel') return false;
    if (action === 'save') {
      if (!await activateNoteTab(id) || !await applicationShell.state.editor.saveActiveNoteEditor()) return false;
    }
  }
  if (applicationShell.state.editor.editingMarkdownDocumentId !== id) {
    openNoteTabs.splice(index, 1); application.views.tabs.renderNoteTabs(); return true;
  }
  noteTabActionPending = true;
  const immersive = applicationShell.config.$('#librariesView').classList.contains('card-editor-immersive');
  let closed = false;
  try {
    if (!await application.editor.session.flushActiveNoteEditor()) return false;
    application.editor.session.resetActiveNoteEditor();
    openNoteTabs.splice(index, 1); closed = true;
  } finally { noteTabActionPending = false; application.views.tabs.renderNoteTabs(); }
  if (!closed) return false;
  const next = openNoteTabs[Math.min(index, openNoteTabs.length - 1)];
  if (next) {
    applicationShell.config.$('#librariesView').classList.toggle('card-editor-immersive', immersive);
    await activateNoteTab(next.id);
    applicationShell.config.$('#noteTabsBar [aria-selected="true"]')?.focus({ preventScroll: true });
  }
  else { applicationShell.actions.renderLibraries(); applicationShell.actions.renderSidebarKnowledgeTree(); applicationShell.actions.updateNoteWindowTitle(); }
  return true;
}

async function closeNoteTabGroup(action, targetId) {
  if (noteTabActionPending || noteTabBatchPending || applicationShell.state.persistence.dataSavePending || !openNoteTabs.some(tab => tab.id === targetId)) return;
  const ids = openNoteTabs.filter(tab => action === 'all' || (action === 'current' ? tab.id === targetId : tab.id !== targetId))
    .map(tab => tab.id).sort((left, right) => Number(left === applicationShell.state.editor.editingMarkdownDocumentId) - Number(right === applicationShell.state.editor.editingMarkdownDocumentId));
  noteTabBatchPending = true;
  try {
    for (const id of ids) {
      // A preceding close may have just mounted another draft editor.
      await captureActiveNoteDraft?.();
      if (!await closeNoteTab(id, true)) return;
    }
    if (action === 'others') await activateNoteTab(targetId);
  } finally { noteTabBatchPending = false; application.views.tabs.renderNoteTabs(); }
}

async function createNoteTab(destination = null) {
  if (noteTabActionPending || noteTabBatchPending || applicationShell.state.persistence.dataSavePending) return;
  noteTabActionPending = true; application.views.tabs.renderNoteTabs();
  let created = null, notebook = null;
  try {
    if (!await application.editor.session.saveNoteBeforeTabChange()) return;
    const activeNotebook = destination ? (destination.kind === 'cards' ? { folderId: destination.folderId || null } : null)
      : applicationShell.state.persistence.data.cardNotebooks.find(note => note.id === applicationShell.state.editor.editingCardNotebookId) || noteDraftTab()?.draftNotebook;
    const library = destination?.kind === 'knowledge' ? application.state.knowledge.libraryById(destination.libraryId)
      : application.state.knowledge.libraryById(applicationShell.state.editor.activeNoteEditorLibraryId) || application.state.knowledge.libraryById(applicationShell.state.knowledge.selectedLibraryId) || applicationShell.state.persistence.data.knowledgeBases[0];
    if (destination?.kind === 'knowledge' && !library) { applicationShell.actions.showToast('所属目录已不存在', true); return; }
    if (activeNotebook?.folderId && !applicationShell.state.persistence.data.cardFolders.some(folder => folder.id === activeNotebook.folderId)) { applicationShell.actions.showToast('所属目录已不存在', true); return; }
    if (!activeNotebook && !library) { applicationShell.actions.openNewNoteNameDialog(); return; }
    const timestamp = new Date().toISOString();
    const fileType = !activeNotebook && MemoKeepNoteFiles.types[destination?.fileType] ? destination.fileType : 'md';
    const baseTitle = destination?.title || MemoKeepNoteFiles.types[fileType].defaultTitle;
    let title = baseTitle.slice(0, 100);
    const existingTitles = new Set([...applicationShell.state.persistence.data.documents.filter(doc => doc.knowledgeBaseId === library?.id && (activeNotebook || MemoKeepNoteFiles.of(doc).id === fileType)).map(doc => doc.title),
      ...applicationShell.state.persistence.data.cardNotebooks.filter(note => note.folderId === activeNotebook?.folderId).map(note => note.name),
      ...openNoteTabs.filter(tab => tab.draftDocument && (activeNotebook || MemoKeepNoteFiles.of(tab.draftDocument).id === fileType)).map(tab => tab.draftDocument.title)]);
    const occupied = new Set([...existingTitles].map(application.domain.comparableName));
    let suffix = 2;
    while (occupied.has(application.domain.comparableName(title))) {
      const ending = ` ${suffix++}`;
      title = `${baseTitle.slice(0, 100 - ending.length)}${ending}`;
    }
    const tagId = destination ? destination.tagId : selectedNoteTagId;
    created = { tagIds: !activeNotebook && noteTagById(tagId) ? [tagId] : [], id: applicationShell.config.uid(), knowledgeBaseId: activeNotebook ? null : library.id, title, content: '', sourceType: fileType === 'txt' ? 'manual-text' : 'manual-markdown', sourceFileName: null,
      metadata: { fileType, size: 0, inlineCardCount: 0, editorMode: activeNotebook ? 'card' : fileType === 'txt' ? 'text' : 'note', noteContent: '', noteContentInitialized: fileType !== 'txt', versions: [] }, createdAt: timestamp, updatedAt: timestamp };
    if (activeNotebook) {
      notebook = { id: applicationShell.config.uid(), name: title, folderId: activeNotebook.folderId || null, sourceDocumentId: created.id, createdAt: timestamp, updatedAt: timestamp };
    }
    Object.assign(rememberNoteTab(created, notebook?.id || null), { draftDocument: created, draftNotebook: notebook, dirty: false });
  } finally { noteTabActionPending = false; application.views.tabs.renderNoteTabs(); }
  if (created) applicationShell.config.$('#librariesView').classList.remove('note-reading');
  if (created && await applicationShell.actions.openMarkdownNoteEditor(applicationShell.actions.documentById(created.id), '', null, notebook?.id || null)) {
    await captureActiveNoteDraft?.();
    if (applicationShell.state.editor.editingMarkdownDocumentId === created.id) {
      applicationShell.config.$('#inlineMarkdownNoteTitle')?.focus(); applicationShell.config.$('#inlineMarkdownNoteTitle')?.select();
    }
  }
  return created;
}

// Keep native window dragging outside the note's scrolling/sticky layer.
