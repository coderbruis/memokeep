function renderPlainTextNoteEditor(library, doc) {
  return `<div id="inlineMarkdownNoteForm" class="clean-note-editor note-text-editor" data-document-id="${applicationShell.actions.escapeHtml(doc.id)}">
    <div class="note-editor-toolbar"><button type="button" id="closeInlineEditorBtn" class="note-back-button" aria-label="返回知识库"><svg aria-hidden="true"><use href="#icon-arrow-left"></use></svg><span>返回</span></button>
      <span id="noteSaveStatus" class="note-save-status" role="status">已保存</span><button type="button" id="saveNoteButton" class="note-save-button" aria-label="保存文件"><svg aria-hidden="true"><use href="#icon-save"></use></svg><span>保存</span></button>
      <button type="button" class="note-toolbar-icon-button note-references-button" data-open-note-references>关联</button>
      <div class="note-history-control"><button type="button" id="noteHistoryButton" class="note-toolbar-icon-button" aria-label="历史版本" aria-haspopup="menu" aria-expanded="false"><svg aria-hidden="true"><use href="#icon-history"></use></svg></button><div id="noteHistoryMenu" class="note-history-menu hidden" role="menu" aria-label="历史版本"></div></div></div>
    <div class="note-text-paper note-open-fade"><div class="note-text-location">${applicationShell.actions.escapeHtml(library?.name || '')}</div>
      <div class="note-text-title"><input id="inlineMarkdownNoteTitle" class="note-title-input" maxlength="100" aria-label="文件名称" value="${applicationShell.actions.escapeHtml(doc.title)}"></div>${renderNoteTagControl()}
      <textarea id="notePlainTextContent" spellcheck="false" wrap="off" aria-label="纯文本内容" placeholder="开始记录文字…"></textarea>
      <footer class="note-text-footer"><span id="notePlainTextCount"></span><button type="button" id="noteTextViewButton" class="note-toolbar-icon-button" aria-label="阅读与显示" aria-haspopup="menu" aria-expanded="false">···</button></footer></div></div>`;
}

function bindPlainTextNoteEditor(doc) {
  const view = applicationShell.config.$('#librariesView'), immersive = view.classList.contains('card-editor-immersive'), reading = view.classList.contains('note-reading');
  applicationShell.state.editor.discardActiveNoteEditor?.();
  applicationShell.state.editor.activeNoteEditorBeforeLeave = null;
  view.classList.toggle('card-editor-immersive', immersive);
  view.classList.toggle('note-reading', reading);
  rememberNoteTab(doc); application.views.tabs.mountNoteTabControls();
  const form = applicationShell.config.$('#inlineMarkdownNoteForm'), title = applicationShell.config.$('#inlineMarkdownNoteTitle'), editor = applicationShell.config.$('#notePlainTextContent');
  const token = applicationShell.config.uid(), id = doc.id, controller = new AbortController(), { signal } = controller;
  const listen = (node, type, handler, options = {}) => node.addEventListener(type, handler, { ...options, signal });
  form.dataset.editorToken = token;
  applicationShell.state.editor.activeNoteEditorLibraryId = doc.knowledgeBaseId;
  applicationShell.config.$('#librariesView').classList.remove('editing-card-note');
  let tagIds = normalizeNoteTagIds(doc.tagIds), inFlight = null;
  editor.value = String(doc.content || '');
  const current = () => form.isConnected && form.dataset.editorToken === token && applicationShell.state.editor.editingMarkdownDocumentId === id;
  const snapshot = () => ({ title: title.value.trim(), content: editor.value, tagIds: [...tagIds], editorMode: 'text', noteContent: '', noteContentInitialized: false });
  let saved = structuredClone(noteDraftTab(id)?.draftBaseline || snapshot());
  const matches = (left, right) => left.title === right.title && left.content === right.content && JSON.stringify(left.tagIds || []) === JSON.stringify(right.tagIds || []);
  const editorTab = () => openNoteTabs.find(tab => tab.id === id);
  const refresh = () => {
    if (!current()) return;
    const dirty = !matches(saved, snapshot()), draft = noteDraftTab(id);
    applicationShell.config.$('#saveNoteButton').disabled = Boolean(inFlight) || (!draft && !dirty);
    applicationShell.config.$('#noteSaveStatus').textContent = inFlight ? '保存中…' : editorTab()?.saveError || (dirty || draft ? '未保存' : '已保存');
    applicationShell.config.$('#noteSaveStatus').classList.toggle('is-dirty', Boolean(dirty || draft || editorTab()?.saveError));
    applicationShell.config.$('#notePlainTextCount').textContent = `${editor.value.length} 字符 · ${editor.value.split('\n').length} 行`;
    application.views.tabs.renderNoteTabs();
  };
  const markChanged = () => {
    const tab = editorTab();
    if (tab) delete tab.saveError;
    refresh();
  };
  const versionOf = value => ({ savedAt: value.updatedAt || value.createdAt, title: value.title, content: String(value.content || ''), editorMode: 'text', noteContent: '', noteContentInitialized: false });
  const historyMenu = applicationShell.config.$('#noteHistoryMenu'), historyButton = applicationShell.config.$('#noteHistoryButton');
  const renderHistory = () => {
    const versions = applicationShell.actions.documentById(id)?.metadata?.versions || [];
    historyMenu.innerHTML = versions.length ? versions.map((version, index) => `<button type="button" role="menuitem" data-text-version="${index}"><strong>${applicationShell.actions.escapeHtml(version.title)}</strong><small>${applicationShell.actions.escapeHtml(applicationShell.actions.formatDate(Date.parse(version.savedAt) || Date.now()))}</small></button>`).join('') : '<p>还没有历史版本</p>';
  };
  const closeHistory = () => { historyMenu.classList.add('hidden'); historyButton.setAttribute('aria-expanded', 'false'); };
  listen(historyButton, 'click', () => {
    const opening = historyMenu.classList.contains('hidden');
    historyMenu.classList.toggle('hidden', !opening); historyButton.setAttribute('aria-expanded', String(opening));
  });
  listen(document, 'pointerdown', event => { if (!historyMenu.contains(event.target) && !historyButton.contains(event.target)) closeHistory(); });
  listen(historyMenu, 'click', async event => {
    const button = event.target.closest('[data-text-version]');
    const version = button && applicationShell.actions.documentById(id)?.metadata?.versions?.[Number(button.dataset.textVersion)];
    if (!version) return;
    closeHistory();
    if (!await applicationShell.actions.previewNoteVersion(id, Number(button.dataset.textVersion), snapshot())) return;
    if (!current()) return;
    title.value = version.title; editor.value = version.content; closeHistory(); markChanged();
    applicationShell.actions.showToast('已载入历史版本，点击保存后生效');
  });
  const saveCurrent = async () => {
    if (!current()) return true;
    const value = snapshot();
    if (!value.title) {
      const tab = editorTab();
      if (tab) tab.saveError = '文件名称不能为空';
      applicationShell.actions.showToast('文件名称不能为空', true); title.focus(); return false;
    }
    const draft = noteDraftTab(id);
    try { await (application.persistence.transactNote || application.persistence.transact)(data => {
      const existing = data.documents.find(doc => doc.id === id), previous = existing || draft?.draftDocument;
      if (!previous) throw new Error('文件已不存在');
      const timestamp = new Date().toISOString();
      const versions = previous?.metadata?.versions || [];
      const changed = previous && (previous.title !== value.title || previous.content !== value.content);
      const updated = { ...previous, title: value.title, content: value.content, tagIds: value.tagIds, sourceType: 'manual-text', updatedAt: timestamp,
        metadata: { ...(previous?.metadata || {}), fileType: 'txt', editorMode: 'text', noteContent: '', noteContentInitialized: false,
          size: new TextEncoder().encode(value.content).length, inlineCardCount: 0,
          versions: existing && changed ? [versionOf(previous), ...versions].slice(0, applicationShell.config.NOTE_VERSION_LIMIT) : versions } };
      if (!existing) data.documents.push(updated);
      else data.documents = data.documents.map(item => item.id === id ? updated : item);
      applicationShell.actions.syncCardSources?.(data, updated);
    }); } catch (error) {
      const tab = editorTab();
      if (tab) tab.saveError = error.message || '保存失败，请重试';
      return false;
    }
    const tab = editorTab();
    if (tab) delete tab.saveError;
    if (draft) { delete draft.draftDocument; delete draft.draftBaseline; draft.dirty = false; }
    if (current()) { saved = structuredClone(value); renderHistory(); applicationShell.actions.updateNoteWindowTitle(); }
    applicationShell.actions.renderSidebarKnowledgeTree();
    applicationShell.actions.refreshLearningTools?.();
    if (applicationShell.state.persistence.sharedDataRefreshPending) await application.persistence.refresh();
    return true;
  };
  applicationShell.state.editor.saveActiveNoteEditor = options => {
    if (!inFlight) { inFlight = saveCurrent(options).finally(() => { inFlight = null; refresh(); }); refresh(); }
    return inFlight;
  };
  applicationShell.state.editor.activeNoteEditorHasChanges = () => current() && !matches(saved, snapshot());
  captureActiveNoteDraft = async () => {
    const draft = noteDraftTab(id);
    if (!draft || !current()) return;
    const value = snapshot();
    draft.draftBaseline ||= structuredClone(saved);
    draft.dirty = !matches(saved, value);
    Object.assign(draft.draftDocument, { title: value.title, content: value.content, tagIds: value.tagIds });
  };
  bindNoteTagPicker(() => tagIds, ids => { tagIds = ids; markChanged(); });
  listen(editor, 'input', markChanged); listen(title, 'input', markChanged);
  listen(title, 'keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); editor.focus(); } });
  listen(applicationShell.config.$('#saveNoteButton'), 'click', () => void applicationShell.state.editor.saveActiveNoteEditor());
  listen(applicationShell.config.$('#closeInlineEditorBtn'), 'click', async () => { if (await application.editor.session.leaveActiveNoteEditor()) { applicationShell.actions.renderLibraries(); applicationShell.actions.updateNoteWindowTitle(); } });
  listen(document, 'keydown', event => {
    if (!current() || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]') || applicationShell.config.$('#librariesView').classList.contains('hidden')) return;
    if (MemoKeepShortcuts.matches(event, 'save')) { event.preventDefault(); void applicationShell.state.editor.saveActiveNoteEditor(); }
  });
  listen(editor, 'keydown', async event => {
    if (event.code !== 'KeyV' || !event.shiftKey || event.altKey || event.isComposing || editor.readOnly
      || !(MemoKeepShortcuts.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const start = editor.selectionStart, end = editor.selectionEnd;
    try {
      const text = await navigator.clipboard.readText();
      if (current() && !editor.readOnly && document.activeElement === editor && editor.selectionStart === start && editor.selectionEnd === end) document.execCommand('insertText', false, text);
    } catch { applicationShell.actions.showToast('无法读取剪贴板，请重新复制后再试', true); }
  });
  const disposeModes = bindNoteViewModes(form, applicationShell.config.$('#noteTextViewButton'), {
    setImmersive: enabled => applicationShell.config.$('#librariesView').classList.toggle('card-editor-immersive', enabled),
    setReading: enabled => { editor.readOnly = enabled; title.readOnly = enabled; },
    preserveSelection: () => { const start = editor.selectionStart, end = editor.selectionEnd; return () => { if (current()) { editor.focus(); editor.setSelectionRange(start, end); } }; }
  });
  const disposeLearningTools = applicationShell.actions.mountLearningTools?.({ root: form });
  const disposeFind = MemoKeepNoteFind.mount({ root: form, textarea: editor, isCurrent: current });
  applicationShell.state.editor.discardActiveNoteEditor = () => { controller.abort(); disposeModes(); disposeFind(); disposeLearningTools?.(); };
  renderHistory(); refresh();
  requestAnimationFrame(() => { if (current()) applicationShell.config.$('#librariesView').scrollTop = openNoteTabs.find(tab => tab.id === id)?.scrollTop || 0; });
}
