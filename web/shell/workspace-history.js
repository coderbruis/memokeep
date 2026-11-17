(function expose(root) {
  function createWorkspaceHistory({ state, config, actions, env }) {
    const workspaceKey = 'memokeep-open-note-tabs-v1';
    let restoring = false, restored = false, restorationPending = false, historyDialog = null, historyResolve = null, historyClosing = null, historyRevision = 0;
    const docs = data => [...data.documents, ...(data.cardDocuments || [])];
    const signature = value => JSON.stringify([value.title || '', value.content || '', value.editorMode || 'card', value.noteContent || '', Boolean(value.noteContentInitialized)]);
    function rememberOpenNotes({ captureScroll = false } = {}) {
      if (!state.persistence.applicationDataReady || config.isNoteWindow || restoring || restorationPending) return;
      const currentTab = env.openNoteTabs.find(tab => tab.id === state.editor.editingMarkdownDocumentId);
      if (currentTab && captureScroll) currentTab.scrollTop = config.$('#librariesView')?.scrollTop || 0;
      const data = state.persistence.data, documents = new Set(docs(data).map(doc => doc.id));
      const tabs = env.openNoteTabs.filter(tab => !tab.draftDocument && documents.has(tab.id)).map(tab => ({ id: tab.id, cardNotebookId: tab.cardNotebookId || null, scrollTop: Math.max(0, Number(tab.scrollTop) || 0) }));
      const current = config.$('.shell > .view:not(.hidden)')?.id;
      const pageTabs = state.shell?.pageTabs || [], validKeys = new Set([...tabs.map(tab => `note:${tab.id}`), ...pageTabs.map(tab => `page:${tab.id}`)]);
      const tabOrder = (actions.getWorkspaceTabOrder?.() || [...validKeys]).filter(key => validKeys.has(key));
      try { env.localStorage.setItem(workspaceKey, JSON.stringify({ version: 1, tabs, pageTabs, tabOrder, activeId: tabs.some(tab => tab.id === state.editor.editingMarkdownDocumentId) ? state.editor.editingMarkdownDocumentId : null, view: current?.replace(/View$/, '') || 'home' })); }
      catch { /* Preferences must never block document operations. */ }
    }
    async function restoreOpenNotes() {
      if (restored || restoring || config.isNoteWindow) return;
      restored = true;
      let saved;
      try { saved = JSON.parse(env.localStorage.getItem(workspaceKey) || 'null'); } catch { restorationPending = false; return; }
      if (saved?.version !== 1 || !Array.isArray(saved.tabs)) { restorationPending = false; return; }
      restoring = true;
      try {
        const data = state.persistence.data, documents = new Map(docs(data).map(doc => [doc.id, doc]));
        const notebooks = new Map((data.cardNotebooks || []).map(note => [note.id, note]));
        const seen = new Set(), tabs = [];
        for (const tab of saved.tabs.slice(0, 100)) {
          if (!tab || typeof tab.id !== 'string' || seen.has(tab.id) || !documents.has(tab.id)) continue;
          const notebook = tab.cardNotebookId ? notebooks.get(tab.cardNotebookId) : [...notebooks.values()].find(note => note.sourceDocumentId === tab.id);
          if (tab.cardNotebookId && (!notebook || notebook.sourceDocumentId !== tab.id)) continue;
          seen.add(tab.id); tabs.push({ id: tab.id, cardNotebookId: notebook?.id || null, scrollTop: Math.max(0, Number(tab.scrollTop) || 0) });
        }
        env.openNoteTabs = tabs;
        actions.restorePageTabs?.(saved.pageTabs);
        actions.restoreWorkspaceTabOrder?.(saved.tabOrder);
        env.application.views.tabs.renderNoteTabs();
        if (saved.view === 'libraries' && tabs.some(tab => tab.id === saved.activeId)) await env.activateNoteTab(saved.activeId);
        else if (actions.pageTabInfo?.(saved.view)?.available && state.shell.pageTabs.some(tab => tab.id === actions.pageTabInfo(saved.view).id)) actions.showView(saved.view);
      } finally { restoring = false; restorationPending = false; }
    }
    function versionMarkup(snapshot) {
      return snapshot.editorMode === 'note' && snapshot.noteContentInitialized
        ? actions.sanitizeRichNoteContent(snapshot.noteContent || '') : '<pre>' + actions.escapeHtml(snapshot.content || '') + '</pre>';
    }
    function versionLines(snapshot) {
      if (snapshot.editorMode !== 'note' || !snapshot.noteContentInitialized) return String(snapshot.content || '').split('\n');
      const node = env.document.createElement('div');
      node.innerHTML = String(snapshot.noteContent || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
      return node.textContent.replace(/\n{3,}/g, '\n\n').trim().split('\n');
    }
    function diffMarkup(before, after) {
      const left = ['标题：' + (before.title || '未命名笔记'), '', ...versionLines(before)], right = ['标题：' + (after.title || '未命名笔记'), '', ...versionLines(after)], output = [];
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < Math.min(length, 2000); index++) {
        const a = left[index], b = right[index];
        if (a === b && a !== undefined) output.push('<div class="history-diff-line"><span> </span><code>' + (actions.escapeHtml(a) || ' ') + '</code></div>');
        else { if (a !== undefined) output.push('<div class="history-diff-line removed"><span>−</span><code>' + (actions.escapeHtml(a) || ' ') + '</code></div>'); if (b !== undefined) output.push('<div class="history-diff-line added"><span>＋</span><code>' + (actions.escapeHtml(b) || ' ') + '</code></div>'); }
      }
      if (length > 2000) output.push('<p class="hint">仅显示前2000行，完整内容见左右预览。</p>');
      return output.join('') || '<p class="hint">无文字差异</p>';
    }
    function ensureHistoryDialog() {
      if (historyDialog) return;
      historyDialog = env.document.createElement('dialog'); historyDialog.id = 'noteVersionCompareDialog'; historyDialog.className = 'note-version-compare-dialog'; historyDialog.setAttribute('aria-labelledby', 'noteVersionCompareTitle');
      historyDialog.innerHTML = '<header><div><h2 id="noteVersionCompareTitle">版本对比</h2><p data-history-version-label class="hint"></p></div><button type="button" data-history-cancel aria-label="关闭版本对比">×</button></header><div class="note-version-compare-tabs" role="tablist" aria-label="版本查看方式"><button type="button" role="tab" data-history-view="compare">左右预览</button><button type="button" role="tab" data-history-view="diff">文字差异</button></div><div data-history-compare class="note-version-compare-columns"><section><h3>当前内容</h3><h4 data-history-current-title></h4><article data-history-current></article></section><section><h3>历史版本</h3><h4 data-history-previous-title></h4><article data-history-previous></article></section></div><div data-history-diff class="note-version-diff" hidden></div><p data-history-error role="alert" hidden></p><footer><p class="hint">载入后需保存；当前修改会先备份。</p><button type="button" data-history-cancel>取消</button><button type="button" class="primary" data-history-apply>载入此版本</button></footer>';
      env.document.body.append(historyDialog);
      const cancel = () => closeHistoryCompare(false);
      historyDialog.querySelectorAll('[data-history-cancel]').forEach(button => { button.onclick = cancel; });
      historyDialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
      historyDialog.querySelectorAll('[data-history-view]').forEach(button => { button.onclick = () => {
        const compare = button.dataset.historyView === 'compare';
        historyDialog.querySelector('[data-history-compare]').hidden = !compare; historyDialog.querySelector('[data-history-diff]').hidden = compare;
        historyDialog.querySelectorAll('[data-history-view]').forEach(tab => { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
      }; });
      historyDialog.querySelector('.note-version-compare-tabs').onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const tabs = [...historyDialog.querySelectorAll('[data-history-view]')];
        const current = tabs.indexOf(env.document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + 1) % tabs.length;
        tabs[next].click(); tabs[next].focus();
      };
    }
    function closeHistoryCompare(value) {
      if (!value) historyRevision++;
      const resolve = historyResolve; historyResolve = null;
      if (!historyDialog.open) { resolve?.(value); return Promise.resolve(); }
      const closing = new Promise(done => { historyDialog.addEventListener('close', () => { if (historyClosing === closing) historyClosing = null; resolve?.(value); done(); }, { once: true }); });
      historyClosing = closing; historyDialog.close(); return closing;
    }
    async function previewNoteVersion(documentId, index, currentSnapshot) {
      if (historyClosing) await historyClosing;
      if (historyResolve) await closeHistoryCompare(false);
      const document = actions.documentById(documentId), version = document?.metadata?.versions?.[index];
      if (!document || !version) return false;
      ensureHistoryDialog();
      const request = ++historyRevision;
      const current = env.structuredClone(currentSnapshot), previous = env.structuredClone(version);
      historyDialog.querySelector('[data-history-current-title]').textContent = current.title || '未命名笔记';
      historyDialog.querySelector('[data-history-previous-title]').textContent = previous.title || '未命名笔记';
      historyDialog.querySelector('[data-history-current]').innerHTML = versionMarkup(current);
      historyDialog.querySelector('[data-history-previous]').innerHTML = versionMarkup(previous);
      historyDialog.querySelector('[data-history-diff]').innerHTML = diffMarkup(current, previous);
      historyDialog.querySelector('[data-history-version-label]').textContent = (document.title || '未命名笔记') + ' · ' + new Date(previous.savedAt).toLocaleString('zh-CN');
      const error = historyDialog.querySelector('[data-history-error]'); error.hidden = true; error.textContent = '';
      historyDialog.querySelector('[data-history-view="compare"]').click();
      const apply = historyDialog.querySelector('[data-history-apply]'); apply.disabled = false;
      apply.onclick = async () => {
        if (apply.disabled || request !== historyRevision) return; apply.disabled = true;
        try {
          const live = actions.documentById(documentId);
          if (!live || state.editor.editingMarkdownDocumentId !== documentId) throw new Error('笔记已关闭，请重新打开');
          const saved = { title: live.title, content: live.content, editorMode: live.metadata?.editorMode, noteContent: live.metadata?.noteContent, noteContentInitialized: live.metadata?.noteContentInitialized };
          if (signature(current) !== signature(saved)) await env.application.persistence.transact(data => {
            const target = docs(data).find(doc => doc.id === documentId); if (!target) throw new Error('笔记已移除');
            const snapshot = { savedAt: new Date().toISOString(), ...current };
            target.metadata ||= {}; target.metadata.versions = [snapshot, ...(target.metadata.versions || [])].slice(0, config.NOTE_VERSION_LIMIT || 5);
          });
          if (request !== historyRevision) return;
          await closeHistoryCompare(true);
        } catch (reason) { if (request !== historyRevision) return; error.textContent = '备份失败：' + reason.message + '。修改已保留，可重试。'; error.hidden = false; apply.disabled = false; }
      };
      if (!historyDialog.open) historyDialog.showModal();
      return new Promise(resolve => { historyResolve = resolve; });
    }
    return { rememberOpenNotes, restoreOpenNotes, deferWorkspacePersistence() { if (!config.isNoteWindow && !restored) restorationPending = true; }, previewNoteVersion };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createWorkspaceHistory });
})(globalThis);
