(function expose(root) {
  function createTrash({ state, config, actions, env }) {
    function formatTrashTime(value) {
      return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
    }

    function renderTrash() {
      const list = config.$('#trashList');
      if (!list) return;
      const emptyButton = config.$('#emptyTrashButton');
      emptyButton.disabled = state.shell.trashClearPending || !state.persistence.data.trash.length;
      const query = (config.$('#trashSearch')?.value || '').trim().toLowerCase();
      const filter = config.$('#trashType')?.value || 'all';
      const entries = state.persistence.data.trash.filter(entry => (filter === 'all' || (entry.type === 'card' ? 'card' : 'note') === filter)
      && (!query || `${entry.card?.question || entry.document?.title || ''} ${entry.originalLocation || entry.libraryName || ''}`.toLowerCase().includes(query)));
      list.innerHTML = entries.length ? entries.map(entry => `
    <article class="trash-row" data-trash-id="${entry.id}">
      <span class="trash-doc-icon"><svg aria-hidden="true"><use href="#icon-book-open-text"></use></svg></span>
      <strong>${entry.type === 'card' ? '<small class="trash-kind">卡片</small>' : ''}${actions.escapeHtml(entry.card?.question || entry.document?.title || '未命名笔记')}</strong>
      <span>${actions.escapeHtml(entry.originalLocation || entry.libraryName || '未分类')}</span>
      <time>${actions.formatTrashTime(entry.deletedAt)}</time>
      <div><button type="button" data-trash-action="restore"${state.shell.trashClearPending ? ' disabled' : ''}>恢复</button><button type="button" class="danger" data-trash-action="delete"${state.shell.trashClearPending ? ' disabled' : ''}>彻底删除</button></div>
    </article>`).join('') : `<div class="trash-empty"><svg aria-hidden="true"><use href="#icon-trash"></use></svg><strong>${query ? '未找到匹配内容' : '暂无已删除内容'}</strong></div>`;
    }

    async function emptyTrash() {
      if (state.shell.trashClearPending || !state.persistence.data.trash.length) return;
      state.shell.trashClearPending = true;
      const button = config.$('#emptyTrashButton');
      const entries = [...state.persistence.data.trash];
      const noteCount = entries.filter(entry => entry.type !== 'card').length;
      const cardCount = entries.reduce((count, entry) => count + (entry.type === 'card' ? 1 : (entry.cards || []).length), 0);
      actions.renderTrash();
      try {
        const confirmed = await actions.showConfirmDialog({
          title: '清空回收站？',
          message: `将永久删除 ${noteCount} 篇笔记和 ${cardCount} 张记忆卡片（含笔记关联卡片）。\n包含筛选外的内容，无法恢复。`,
          confirmLabel: '全部清空'
        });
        if (!confirmed) return;
        // Only remove the entries covered by the confirmation, preserving new arrivals from other windows.
        const ids = new Set(entries.map(entry => entry.id));
        const removed = state.persistence.data.trash.filter(entry => ids.has(entry.id));
        if (!removed.length) return;
        const previousTrash = state.persistence.data.trash;
        button.setAttribute('aria-busy', 'true');
        button.querySelector('span').textContent = '清空中…';
        state.persistence.data.trash = state.persistence.data.trash.filter(entry => !ids.has(entry.id));
        try {
          await env.application.persistence.save();
        } catch (error) {
          state.persistence.data.trash = previousTrash;
          actions.showToast(`清空失败，请重试：${error.message}`, true);
          return;
        }
        try {
          await actions.deleteUnreferencedNoteImageFiles(removed.flatMap(env.application.domain.trashEntryImageIds));
        } catch (error) {
          actions.showToast(`回收站内容已删除，但图片清理失败：${error.message}`, true);
          return;
        }
        actions.showToast(state.persistence.data.trash.length ? `已彻底删除 ${removed.length} 项内容` : '回收站已清空');
      } finally {
        state.shell.trashClearPending = false;
        button.removeAttribute('aria-busy');
        button.querySelector('span').textContent = '清空回收站';
        actions.renderTrash();
      }
    }

    async function handleTrashAction(event) {
      if (state.shell.trashClearPending) return;
      const row = event.target.closest('[data-trash-id]');
      const action = event.target.closest('[data-trash-action]')?.dataset.trashAction;
      if (!row || !action) return;
      const entry = state.persistence.data.trash.find(item => item.id === row.dataset.trashId);
      if (!entry) return;
      if (entry.type === 'card-notebook' && action === 'restore') {
        await env.restoreCardNotebookTrash(entry.id);
        actions.showToast('卡片笔记已恢复，内容和复习进度保持不变');
        return;
      }
      if (entry.type === 'card') {
        if (action === 'restore') {
          await env.application.operations.cardTrash.restoreCardTrash([entry.id]);
          actions.showToast('卡片已恢复，来源和复习进度保持不变');
        } else {
          const confirmed = await actions.showConfirmDialog({ title: '彻底删除这张卡片？', message: `卡片正面：${entry.card.question}\n彻底删除后无法恢复，来源笔记不受影响。`, confirmLabel: '彻底删除' });
          if (!confirmed) return;
          try { await env.application.persistence.transact(data => {
            data.trash = data.trash.filter(item => item.id !== entry.id);
          }); } catch (error) { actions.renderTrash(); throw error; }
          actions.renderTrash();
          actions.showToast('卡片已彻底删除');
        }
        return;
      }
      if (action === 'restore') {
        let library = env.application.state.knowledge.libraryById(entry.document.knowledgeBaseId);
        if (!library) {
          library = { id: config.uid(), name: `${entry.libraryName || '恢复的笔记'}`, type: 'general', description: '从回收站恢复', language: '', createdAt: new Date().toISOString() };
          state.persistence.data.knowledgeBases.push(library);
          entry.document.knowledgeBaseId = library.id;
          entry.items.forEach(item => { item.knowledgeBaseId = library.id; });
          entry.cards.forEach(card => { card.knowledgeBaseId = library.id; });
        }
        state.persistence.data.documents.push(entry.document);
        state.persistence.data.items.push(...entry.items);
        state.persistence.data.cards.push(...entry.cards);
        state.persistence.data.trash = state.persistence.data.trash.filter(item => item.id !== entry.id);
        await env.application.persistence.save();
        actions.renderAll();
        actions.renderTrash();
        actions.showToast('笔记已恢复');
        return;
      }
      const confirmed = await actions.showConfirmDialog({ title: `彻底删除“${entry.document?.title || '未命名笔记'}”？`, message: '彻底删除后无法恢复。', confirmLabel: '彻底删除' });
      if (!confirmed) return;
      const imageIds = [...env.application.domain.noteImageIdsFromContent(entry.document?.content), ...env.application.domain.noteImageIdsFromContent(entry.document?.metadata?.noteContent)];
      state.persistence.data.trash = state.persistence.data.trash.filter(item => item.id !== entry.id);
      await env.application.persistence.save();
      await actions.deleteUnreferencedNoteImageFiles(imageIds).catch(error => actions.showToast(`笔记已删除，但图片清理失败：${error.message}`, true));
      actions.renderTrash();
      actions.showToast('笔记已彻底删除');
    }
    return { formatTrashTime, renderTrash, emptyTrash, handleTrashAction };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createTrash });
})(globalThis);
