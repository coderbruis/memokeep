(function expose(root) {
  function createEditorCardTags({ state, config, actions, env, session, features }) {
    const renderInlineTags = () => {
      const row = session.inlineTagRows[session.tagRowIndex];
      if (!row) return;
      const query = session.inlineTagPanel.querySelector('input[type=search]')?.value || '';
      const all = [...new Set([...state.persistence.data.cards.flatMap(card => card.tags || []), ...session.inlineTagRows.flatMap(row => row.tags)])].filter(Boolean).sort((a,b) => a.localeCompare(b, 'zh-CN'));
      session.inlineTagPanel.querySelector('.inline-tag-chips').innerHTML = row.tags.map(tag => `<button type="button" data-remove-tag="${actions.escapeHtml(tag)}">${actions.escapeHtml(tag)} ×</button>`).join('') || '<span>尚未添加标签</span>';
      session.inlineTagPanel.querySelector('.inline-tag-options').innerHTML = all.filter(tag => tag.toLowerCase().includes(query.trim().toLowerCase())).map(tag => `<label><input type="checkbox" data-inline-tag="${actions.escapeHtml(tag)}" ${row.tags.includes(tag) ? 'checked' : ''}><span>${actions.escapeHtml(tag)}</span></label>`).join('') || '<p>没有匹配的标签</p>';
      const create = session.inlineTagPanel.querySelector('[data-create-tag]');
      create.disabled = !query.trim() || all.includes(query.trim());
      create.textContent = query.trim() ? `＋ 新建“${query.trim()}”` : '＋ 输入名称以新建标签';
    };

    const openInlineTags = (lineIndex, button) => {
      session.inlineTagRows = actions.reconcileInlineTagRows(session.inlineTagRows, session.editor.value);
      session.tagRowIndex = lineIndex;
      session.inlineTagPanel.innerHTML = `<div class="inline-tag-head"><strong>管理此卡片标签</strong><button type="button" data-close-tags aria-label="关闭标签面板">×</button></div><p>仅应用于当前卡片</p><div class="inline-tag-chips"></div><input type="search" aria-label="搜索或新建标签" placeholder="搜索或新建标签" maxlength="60"><p>已有标签</p><div class="inline-tag-options"></div><button type="button" data-create-tag></button><div class="inline-tag-foot"><span>随笔记一起保存</span><button type="button" data-close-tags>完成</button></div>`;
      features.renderInlineTags();
      session.inlineTagPanel.showPopover();
      const bounds = button.getBoundingClientRect();
      session.inlineTagPanel.style.left = `${Math.max(12, Math.min(bounds.right - session.inlineTagPanel.offsetWidth, env.window.innerWidth - session.inlineTagPanel.offsetWidth - 12))}px`;
      session.inlineTagPanel.style.top = `${Math.max(12, Math.min(bounds.bottom + 8, env.window.innerHeight - session.inlineTagPanel.offsetHeight - 12))}px`;
      session.inlineTagPanel.querySelector('input[type=search]').focus();
    };
    return { renderInlineTags, openInlineTags };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorCardTags });
})(globalThis);
