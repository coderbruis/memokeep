function droppedNoteHtml(fileName, content) {
  if (/\.txt$/i.test(fileName)) {
    return content.split(/\r\n?|\n/).map(line => `<p>${applicationShell.actions.escapeHtml(line) || '<br>'}</p>`).join('');
  }
  return applicationShell.actions.sanitizeRichNoteContent(applicationShell.actions.markdownToRichHtml(content));
}

async function saveDroppedNote(source, requestedTitle, libraryId) {
  if (!applicationShell.state.persistence.applicationDataReady) throw new Error('数据仍在加载，请稍后重试');
  const name = requestedTitle.trim();
  if (!name) throw new Error('请填写笔记名称');
  if (!application.state.knowledge.libraryById(libraryId)) throw new Error('请选择有效的知识库');
  if (!await application.editor.session.leaveActiveNoteEditor()) throw new Error('当前笔记尚未保存，请先完成保存');
  if (!application.state.knowledge.libraryById(libraryId)) throw new Error('目标知识库已不存在，请重新选择');
  const timestamp = new Date().toISOString();
  const id = source.openedId || applicationShell.config.uid();
  const content = source.content;
  const noteContent = droppedNoteHtml(source.fileName, content);
  await application.persistence.transact(candidate => {
    if (!candidate.knowledgeBases.some(library => library.id === libraryId)) throw new Error('目标知识库目录已不存在，请重新选择');
    const index = candidate.documents.findIndex(document => document.id === id);
    const previous = candidate.documents[index];
    const note = {
      ...(previous || {}), id, knowledgeBaseId: libraryId,
      title: applicationShell.actions.availableDocumentTitle(name, libraryId, previous?.id),
      sourceType: 'manual-markdown', sourceFileName: source.fileName, content,
      metadata: { ...(previous?.metadata || {}), size: new TextEncoder().encode(content + noteContent).length,
        inlineCardCount: 0, editorMode: 'note', noteContent, noteContentInitialized: true },
      createdAt: previous?.createdAt || timestamp, updatedAt: timestamp
    };
    // A queue acknowledgement may fail after this business transaction commits.
    // Retrying the same event updates its stable note instead of appending a duplicate.
    if (index < 0) candidate.documents.push(note);
    else candidate.documents[index] = note;
  });
  return applicationShell.actions.documentById(id);
}

async function saveDroppedNoteToOriginalDirectory(source, requestedTitle) {
  if (!source.fileToken || !window.memoKeepDesktop?.saveFileToDirectory) throw new Error('此文件没有系统目录授权，请改存到 MemoKeep 知识库');
  let fileName = source.fileName;
  if (requestedTitle !== undefined) {
    const base = requestedTitle.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!base) throw new Error('请填写文件名称');
    const extension = source.fileName.match(/\.(md|markdown|txt)$/i)?.[0] || '.md';
    fileName = `${base}${extension}`;
  }
  return window.memoKeepDesktop.saveFileToDirectory({ token: source.fileToken, fileName, content: source.content });
}

function bindFileDropPreview() {
  const dialog = applicationShell.config.$('#filePreviewDialog'), form = applicationShell.config.$('#filePreviewForm');
  const title = applicationShell.config.$('#filePreviewName'), library = applicationShell.config.$('#filePreviewLibrary');
  const saveAsDialog = applicationShell.config.$('#filePreviewSaveAsDialog'), saveAsForm = applicationShell.config.$('#filePreviewSaveAsForm');
  const saveAsName = applicationShell.config.$('#filePreviewSaveAsName'), saveAsStatus = applicationShell.config.$('#filePreviewSaveAsStatus');
  const saveAsSubmit = applicationShell.config.$('#filePreviewSaveAsSubmit');
  const saveAsCancels = [applicationShell.config.$('#filePreviewCancelSaveAs'), applicationShell.config.$('#filePreviewDismissSaveAs')];
  const content = applicationShell.config.$('#filePreviewContent'), status = applicationShell.config.$('#filePreviewStatus');
  const editor = applicationShell.config.$('#filePreviewEditor'), editButton = applicationShell.config.$('#filePreviewEdit');
  const outlineList = applicationShell.config.$('#filePreviewOutlineList');
  const outlinePanel = applicationShell.config.$('#filePreviewOutline'), outlinePin = applicationShell.config.$('#filePreviewOutlinePin');
  const outlineIcon = outlinePanel.querySelector('.file-preview-outline-icon');
  let outlineTooltip = null, outlineTooltipTarget = null;
  const hideOutlineTooltip = () => {
    outlineTooltip?.remove();
    outlineTooltipTarget?.removeAttribute('aria-describedby');
    outlineTooltip = outlineTooltipTarget = null;
  };
  const showOutlineTooltip = (target, anchor = target) => {
    hideOutlineTooltip();
    outlineTooltipTarget = target;
    outlineTooltip = document.createElement('div');
    outlineTooltip.id = 'filePreviewOutlineTooltip';
    outlineTooltip.className = 'note-toolbar-tooltip';
    outlineTooltip.setAttribute('role', 'tooltip');
    outlineTooltip.textContent = target.getAttribute('aria-label');
    document.body.appendChild(outlineTooltip);
    target.setAttribute('aria-describedby', outlineTooltip.id);
    const rect = anchor.getBoundingClientRect(), tip = outlineTooltip.getBoundingClientRect();
    outlineTooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.width - 8, rect.left + (rect.width - tip.width) / 2))}px`;
    outlineTooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tip.height - 8, rect.bottom + 8))}px`;
  };
  [outlineIcon, outlinePin].forEach(target => {
    target.addEventListener('pointerenter', () => showOutlineTooltip(target));
    target.addEventListener('pointerleave', hideOutlineTooltip);
  });
  outlinePin.addEventListener('focus', () => showOutlineTooltip(outlinePin));
  outlinePin.addEventListener('blur', hideOutlineTooltip);
  outlinePanel.addEventListener('focus', () => showOutlineTooltip(outlinePanel, outlineIcon));
  outlinePanel.addEventListener('blur', hideOutlineTooltip);
  outlinePanel.addEventListener('transitionend', () => {
    if (outlineTooltipTarget) showOutlineTooltip(outlineTooltipTarget, outlineTooltipTarget === outlinePanel ? outlineIcon : outlineTooltipTarget);
  });
  window.addEventListener('resize', hideOutlineTooltip);
  window.addEventListener('blur', hideOutlineTooltip);
  document.addEventListener('scroll', hideOutlineTooltip, true);
  document.addEventListener('pointerdown', hideOutlineTooltip);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideOutlineTooltip(); });
  let outlinePinned = false;
  outlinePin.onclick = () => {
    outlinePinned = !outlinePinned;
    outlinePanel.classList.toggle('pinned', outlinePinned);
    outlinePin.querySelector('use').setAttribute('href', outlinePinned ? '#icon-pin-off' : '#icon-pin');
    outlinePin.setAttribute('aria-pressed', String(outlinePinned));
    outlinePin.setAttribute('aria-label', outlinePinned ? '取消固定大纲' : '固定大纲');
    if (outlinePin.matches(':hover, :focus-visible')) showOutlineTooltip(outlinePin);
  };
  const updateOutline = () => { outlineList.replaceChildren(); content.querySelectorAll('h1,h2,h3,h4').forEach((heading, index) => { const link = document.createElement('button'); link.type = 'button'; link.textContent = heading.textContent.trim() || '未命名标题'; link.className = `level-${heading.tagName.slice(1)}`; link.onclick = () => heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); outlineList.append(link); }); outlineList.parentElement.classList.toggle('hidden', !outlineList.children.length); };
  const submit = applicationShell.config.$('#filePreviewSave'), skip = applicationShell.config.$('#filePreviewSkip');
  const openSave = applicationShell.config.$('#filePreviewOpenSave'), saveOriginal = applicationShell.config.$('#filePreviewSaveOriginal'), saveLibrary = applicationShell.config.$('#filePreviewSaveLibrary'), saveMenu = applicationShell.config.$('#filePreviewSaveMenu'), view = applicationShell.config.$('#filePreviewView');
  const saveAs = applicationShell.config.$('#filePreviewSaveAs');
  const saveStatus = applicationShell.config.$('#filePreviewSaveStatus');
  const overlay = applicationShell.config.$('#fileDropOverlay');
  let queue = [], source = null, busy = false, depth = 0, generation = 0;
  const nativeIds = new Set();
  let nativeDropWait = null;
  const clearNativeDropWait = () => {
    if (nativeDropWait) window.clearTimeout(nativeDropWait.timer);
    nativeDropWait = null;
  };
  const receivedNativeFiles = files => {
    if (!nativeDropWait) return;
    for (const file of files) nativeDropWait.names.delete(file.name);
    if (!nativeDropWait.names.size) clearNativeDropWait();
  };
  const waitForNativeFiles = files => {
    const received = new Set(queue.filter(file => file.nativeFile).map(file => file.name));
    if (source?.fileToken) received.add(source.fileName);
    const names = new Set(files.map(file => file.name).filter(name => !received.has(name)));
    if (!names.size) return;
    clearNativeDropWait();
    nativeDropWait = { names, timer: window.setTimeout(() => {
      nativeDropWait = null;
      applicationShell.actions.showToast('系统未能接收拖入文件，请重新拖入后再试。当前内容已保留。', true);
    }, 5000) };
    applicationShell.actions.showToast('正在等待系统读取拖入文件…');
  };
  let editing = false;
  const setEditing = value => {
    hideOutlineTooltip();
    editing = value;
    if (value) { editor.value = source?.content || ''; content.classList.add('hidden'); editor.classList.remove('hidden'); editButton.textContent = '完成编辑'; editor.focus(); }
    else {
      if (source) {
        source.content = editor.value;
        content.innerHTML = droppedNoteHtml(source.fileName, source.content);
        updateOutline();
      }
      editor.classList.add('hidden');
      content.classList.remove('hidden');
      editButton.textContent = '编辑';
      if (source && !/\.txt$/i.test(source.fileName)) void renderPreviewDiagrams(content);
    }
  };
  const refreshLibraries = () => {
    const selected = library.value || applicationShell.state.knowledge.selectedLibraryId;
    library.innerHTML = '<option value="">请选择知识库</option>' + MemoKeepDirectoryTree.entries(applicationShell.state.persistence.data.knowledgeBases).map(({ item }) =>
      `<option value="${applicationShell.actions.escapeHtml(item.id)}">${applicationShell.actions.escapeHtml(MemoKeepDirectoryTree.label(applicationShell.state.persistence.data.knowledgeBases, item.id))}</option>`).join('');
    library.value = application.state.knowledge.libraryById(selected) ? selected : (applicationShell.state.persistence.data.knowledgeBases[0]?.id || '');
    submit.disabled = busy || !source || !applicationShell.state.persistence.data.knowledgeBases.length;
    if (!applicationShell.state.persistence.data.knowledgeBases.length) saveStatus.textContent = '暂无知识库，请先新建一个知识库。';
  };
  const setBusy = value => {
    busy = value;
    title.disabled = library.disabled = skip.disabled = applicationShell.config.$('#filePreviewNewLibrary').disabled = value;
    submit.disabled = value || !source || !applicationShell.state.persistence.data.knowledgeBases.length;
    editButton.disabled = value || !source;
    openSave.disabled = value || !source;
    saveOriginal.disabled = saveAs.disabled = saveAsSubmit.disabled = value || !source?.fileToken; saveLibrary.disabled = value || !source;
    saveAsName.disabled = value;
    saveAsCancels.forEach(button => { button.disabled = value; });
    applicationShell.config.$('#filePreviewCancel').disabled = applicationShell.config.$('#filePreviewCancelSave').disabled = value;
    dialog.setAttribute('aria-busy', String(value));
    saveAsDialog.setAttribute('aria-busy', String(value));
  };
  const next = async () => {
    if (source?.openedId) {
      try {
        await window.memoKeepDesktop.acknowledgeOpenedNoteFile(source.openedId);
        if (source.fileToken) await window.memoKeepDesktop.releaseOpenedNoteFile(source.fileToken);
        nativeIds.delete(source.openedId);
      } catch (error) {
        status.textContent = `无法关闭文件：${error.message}。内容已保留，可重试。`;
        return;
      }
    }
    source = null;
    setEditing(false);
    if (!queue.length) {
      if (!view.classList.contains('hidden')) applicationShell.actions.showView('libraries');
      return;
    }
    const file = queue.shift(), token = ++generation;
    title.value = file.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 100) || '未命名笔记';
    applicationShell.config.$('#filePreviewSource').textContent = `${file.name}${queue.length ? ` · 后续还有 ${queue.length} 个文件` : ''}`;
    content.textContent = '';
    status.textContent = '正在读取文件…';
    skip.textContent = queue.length ? '跳过此文件' : '关闭';
    setBusy(true);
    applicationShell.actions.showView('filePreview');
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (token !== generation) return;
      source = { fileName: file.name, content: text, ...(file.nativeFile ? {
        openedId: file.nativeFile.id, fileToken: file.nativeFile.token,
      } : {}) };
      content.classList.toggle('file-preview-plain', /\.txt$/i.test(file.name));
      content.innerHTML = droppedNoteHtml(file.name, text);
      updateOutline();
      if (!text) content.textContent = '（空文档）';
      if (!/\.txt$/i.test(file.name)) void renderPreviewDiagrams(content);
      content.scrollTop = 0;
      status.textContent = '尚未保存';
    } catch (error) {
      status.textContent = `读取失败：${error.message}。可以跳过此文件。`;
    } finally {
      if (token === generation) { setBusy(false); openSave.focus(); }
    }
  };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  saveAsDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  const hideSaveMenu = () => { saveMenu.classList.add('hidden'); openSave.setAttribute('aria-expanded', 'false'); };
  const openLibrarySaveDialog = () => {
    if (busy || !source) return;
    hideSaveMenu();
    saveStatus.textContent = '';
    refreshLibraries();
    dialog.showModal();
    title.focus();
    title.select();
  };
  saveLibrary.onclick = openLibrarySaveDialog;
  openSave.onclick = () => { if (!busy && source) { saveMenu.classList.toggle('hidden'); openSave.setAttribute('aria-expanded', String(!saveMenu.classList.contains('hidden'))); } };
  const fileSaveStatus = message => {
    status.textContent = message;
    if (saveAsDialog.open) saveAsStatus.textContent = message;
  };
  const saveToOriginalDirectory = async requestedTitle => {
    hideSaveMenu();
    if (busy || !source) return;
    if (editing) setEditing(false);
    setBusy(true); fileSaveStatus('正在保存到原文件目录…');
    let fileSaved = false;
    try {
      const saved = await saveDroppedNoteToOriginalDirectory(source, requestedTitle);
      if (saved?.saved === false) { fileSaveStatus('已取消覆盖，预览内容已保留'); return; }
      fileSaved = true;
      if (saved?.warning || saved?.receiptPending) {
        fileSaveStatus('文件已保存，回执待补记');
        saveAsDialog.close();
        applicationShell.actions.showToast('文件已保存，回执待补记');
        return;
      }
      if (source.openedId) await window.memoKeepDesktop.acknowledgeOpenedNoteFile(source.openedId);
      fileSaveStatus('已保存到原文件目录');
      saveAsDialog.close();
      applicationShell.actions.showToast('文件已保存到原文件目录');
    } catch (error) {
      fileSaveStatus(fileSaved ? '文件已保存，回执待补记' : `保存失败：${error.message}`);
      if (fileSaved) saveAsDialog.close();
      if (fileSaved) applicationShell.actions.showToast('文件已保存，回执待补记');
    } finally { setBusy(false); }
  };
  saveOriginal.onclick = () => saveToOriginalDirectory();
  saveAs.onclick = () => {
    if (busy || !source?.fileToken) return;
    hideSaveMenu();
    saveAsName.value = source.fileName.replace(/\.(md|markdown|txt)$/i, '');
    const extension = source.fileName.match(/\.(md|markdown|txt)$/i)?.[0] || '.md';
    applicationShell.config.$('#filePreviewSaveAsHint').textContent = `保存到原文件所在目录，扩展名保持为 ${extension}。同名文件需确认后才会覆盖。`;
    saveAsStatus.textContent = '';
    saveAsDialog.showModal();
    saveAsName.focus();
    saveAsName.select();
  };
  saveAsForm.onsubmit = async event => { event.preventDefault(); if (!busy) await saveToOriginalDirectory(saveAsName.value); };
  saveAsCancels.forEach(button => { button.onclick = () => { if (!busy) saveAsDialog.close(); }; });
  document.addEventListener('click', event => { if (!event.target.closest('.file-preview-save-wrap')) { saveMenu.classList.add('hidden'); openSave.setAttribute('aria-expanded', 'false'); } });
  applicationShell.config.$('#filePreviewCancelSave').onclick = () => { if (!busy) dialog.close(); };
  editButton.onclick = () => { if (!busy && source) setEditing(!editing); };
  skip.onclick = () => { if (!busy) void next(); };
  applicationShell.config.$('#filePreviewCancel').onclick = () => { if (!busy) dialog.close(); };
  applicationShell.config.$('#filePreviewNewLibrary').onclick = () => applicationShell.actions.openLibraryDialog();
  applicationShell.config.$('#libraryDialog').addEventListener('close', () => {
    if (!dialog.open) return;
    library.value = applicationShell.state.knowledge.selectedLibraryId || '';
    saveStatus.textContent = '';
    refreshLibraries();
  });
  // Keep preview links from navigating the application away from unsaved content.
  content.addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); });
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !source) return;
    if (editing) setEditing(false);
    setBusy(true);
    saveStatus.textContent = '正在保存…';
    try {
      const note = await saveDroppedNote(source, title.value, library.value);
      applicationShell.state.knowledge.selectedLibraryId = note.knowledgeBaseId;
      applicationShell.state.knowledge.knowledgeTreeCollapsed = false;
      applicationShell.state.knowledge.collapsedLibraryIds.delete(note.knowledgeBaseId);
      applicationShell.actions.saveCollapsedLibraryIds();
      dialog.close();
      applicationShell.actions.openMarkdownNoteEditor(note);
      applicationShell.actions.showToast(`已保存“${note.title}”`);
      setBusy(false);
      await next();
    } catch (error) {
      saveStatus.textContent = `保存失败：${error.message}。预览内容已保留，可重试。`;
      setBusy(false);
    }
  };
  const isFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const clearDrag = () => { depth = 0; overlay.hidden = true; };
  window.memoKeepDesktop?.onNativeFileDrag?.(active => { overlay.hidden = !active; if (!active) depth = 0; });
  window.memoKeepDesktop?.onNativeFileError?.(message => {
    clearNativeDropWait();
    clearDrag();
    const reason = typeof message === 'string' ? message.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240) : '';
    applicationShell.actions.showToast(reason || '系统无法接收拖入文件，请重试。当前内容已保留。', true);
  });
  applicationShell.actions.enqueueNativeFilePreviews = async files => {
    receivedNativeFiles(files);
    const fresh = files.filter(file => file.id && !nativeIds.has(file.id));
    if (!fresh.length) return true;
    if (!applicationShell.state.persistence.applicationDataReady || busy || document.querySelector('dialog[open]')) return false;
    if (!await application.editor.session.leaveActiveNoteEditor()) return false;
    for (const file of fresh) {
      nativeIds.add(file.id);
      queue.push({ name: file.name, text: async () => file.content, nativeFile: file });
    }
    if (!source) await next();
    else {
      applicationShell.actions.showView('filePreview');
      status.textContent = `已加入 ${fresh.length} 个文件，保存或跳过当前文件后继续预览。`;
    }
    return true;
  };
  document.addEventListener('dragenter', event => {
    if (!isFiles(event)) return;
    event.preventDefault(); depth++;
    overlay.hidden = false;
  }, true);
  document.addEventListener('dragover', event => {
    if (!isFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  }, true);
  document.addEventListener('dragleave', event => {
    if (!isFiles(event)) return;
    if (--depth <= 0) clearDrag();
  }, true);
  window.addEventListener('blur', clearDrag);
  document.addEventListener('drop', async event => {
    if (!isFiles(event)) return;
    const files = [...event.dataTransfer.files];
    clearDrag();
    // Prevent browser navigation, while preserving existing image editor drops.
    event.preventDefault();
    const supported = files.filter(file => /\.(md|markdown|txt)$/i.test(file.name));
    if (!supported.length) return;
    event.stopImmediatePropagation();
    if (!applicationShell.state.persistence.applicationDataReady || busy) { applicationShell.actions.showToast('正在处理，请稍后再拖入文件', true); return; }
    if (document.querySelector('dialog[open]')) {
      applicationShell.actions.showToast('请先关闭当前弹窗，再拖入文档', true); return;
    }
    if (supported.length !== files.length) applicationShell.actions.showToast('已忽略不支持的文件，仅预览 Markdown 和 TXT 文档');
    if (window.memoKeepDesktop?.nativeDocumentDrop === true) {
      // Only the OS-delivered queue grants the desktop permission to save a file.
      // A DOM File must not occupy that preview first or add a second copy later.
      waitForNativeFiles(supported);
      return;
    }
    const previewVisible = !view.classList.contains('hidden');
    const preserveCurrent = Boolean(source);
    if (!previewVisible) {
      setBusy(true);
      try { if (!await application.editor.session.leaveActiveNoteEditor()) return; }
      catch (error) { applicationShell.actions.showToast(`无法打开预览：${error.message}`, true); return; }
      finally { setBusy(false); }
      if (!preserveCurrent) queue = [];
    }
    queue.push(...supported);
    if (!previewVisible && !preserveCurrent) void next();
    else if (!previewVisible) {
      applicationShell.actions.showView('filePreview');
      status.textContent = `已加入 ${supported.length} 个文件，保存或跳过当前文件后继续预览。`;
    }
    else status.textContent = `已加入 ${supported.length} 个文件，保存或跳过当前文件后继续预览。`;
  }, true);
}
