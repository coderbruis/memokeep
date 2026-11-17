(function expose(root) {
  function createSourceLearningFeatures({ state, config, actions, env }) {
    const e = value => actions.escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
    const button = (label, action, attrs = '', kind = '') => `<button type="button" class="${kind}" data-learning-action="${action}" ${attrs}>${label}</button>`;
    const documentIn = id => actions.documentById(id);
    const api = () => env.application.operations.sourceLearning;
    const sourceOf = card => card?.source || state.persistence.data.items.find(item => item.id === card?.knowledgeItemId)?.source;
    let dialog, mounted = null, createFromNote = null;
    function describeSourceDocument(document) {
      const html = document.metadata?.editorMode === 'note' && document.metadata?.noteContentInitialized ? document.metadata.noteContent : '';
      if (!html) return String(document.content || '').split(/\n\s*\n|\n/).filter(text => text.trim()).map(text => ({ text: text.trim(), type: /^#{1,6}\s/.test(text) ? 'heading' : 'p' }));
      const container = env.document.createElement('div'); container.innerHTML = actions.sanitizeRichNoteContent(html);
      return [...container.children].map(node => ({ text: node.textContent.trim(), type: /^H[1-6]$/.test(node.tagName) ? 'heading' : node.matches('.ql-code-block-container,pre') ? 'code' : node.tagName === 'TABLE' ? 'table' : 'p' })).filter(block => block.text);
    }
    function captureCardSource(data, item, { quote = '', plainText = false } = {}) {
      const doc = [...data.documents, ...(data.cardDocuments || [])].find(doc => doc.id === item.documentId); if (!doc) return;
      env.MemoKeepDomain.ensureSourceDocument(doc, describeSourceDocument(doc), config.uid);
      const holder = env.document.createElement('div');
      if (plainText) holder.textContent = quote; else holder.innerHTML = quote;
      const text = holder.textContent || quote;
      try { item.source = env.MemoKeepDomain.sourceFromBlocks(doc, text); }
      catch { item.source = { documentId: doc.id, title: doc.title, quote: text, blockText: text, blockId: null, version: doc.metadata.sourceVersion, unresolved: true }; }
    }
    function syncCardSources(data, doc) { if (doc.metadata?.editorMode !== 'card') env.MemoKeepDomain.syncSourceChanges(data, doc, describeSourceDocument(doc), config.uid); }
    async function prepare(id) {
      await env.application.persistence.transact(data => {
        const doc = [...data.documents, ...(data.cardDocuments || [])].find(doc => doc.id === id); if (!doc) throw new Error('笔记已不存在');
        const before = JSON.stringify(doc.metadata?.sourceBlocks);
        env.MemoKeepDomain.ensureSourceDocument(doc, describeSourceDocument(doc), config.uid);
        if (before === JSON.stringify(doc.metadata.sourceBlocks)) return false;
      }); return documentIn(id);
    }
    function sourceDialog(title, body, footer = '') {
      if (!dialog) { dialog = env.document.createElement('dialog'); dialog.addEventListener('cancel', event => { event.preventDefault(); void requestLearningClose(); }); } dialog.id = 'sourceLearningDialog'; dialog.className = 'source-learning-dialog'; dialog.setAttribute('aria-labelledby', 'sourceLearningTitle');
      if (!dialog.isConnected) env.document.body.append(dialog);
      dialog.innerHTML = `<header><h2 id="sourceLearningTitle">${e(title)}</h2>${button('×', 'close', 'aria-label="关闭"', 'icon-btn')}</header><div class="source-learning-dialog-body">${body}</div><p data-learning-error role="alert"></p>${footer ? `<footer>${footer}</footer>` : ''}`;
      dialog.dataset.initial = dialog.querySelector('form') ? JSON.stringify([...new env.window.FormData(dialog.querySelector('form'))]) : '';
      if (!dialog.open) dialog.showModal();
    }
    async function requestLearningClose() { const form = dialog?.querySelector('form'); if (form?.dataset.saving) return false; if (form && dialog.dataset.initial !== JSON.stringify([...new env.window.FormData(form)])) { if (!await actions.showConfirmDialog({title:'放弃修改？',message:'未保存的修改将丢失。',confirmLabel:'放弃修改',tone:'warning'})) return false; } dialog?.close(); return true; }
    const docs = () => state.persistence.data.documents.filter(doc => describeSourceDocument(doc).length);
    const noteOptions = selected => docs().map(doc => `<option value="${e(doc.id)}" ${doc.id === selected ? 'selected' : ''}>${e(doc.title)}</option>`).join('');
    function blockOptions(doc, selected) { return (doc?.metadata?.sourceBlocks || []).map(block => `<option value="${e(block.id)}" ${block.id === selected ? 'selected' : ''}>${e(block.text.slice(0, 75))}</option>`).join(''); }
    async function openCandidateEditor(id = null, documentId = state.editor.editingMarkdownDocumentId, quote = '', batch = false) {
      const candidate = state.persistence.data.cardCandidates?.find(row => row.id === id);
      if (candidate) documentId = candidate.source.documentId;
      if (!documentIn(documentId)) documentId = docs()[0]?.id;
      if (!documentId) { actions.showToast('请先保存笔记', true); return; }
      if (!candidate && state.editor.activeNoteEditorHasChanges?.()) {
        if (!await actions.showConfirmDialog({ title: '先保存当前笔记？', message: '制卡前需保存原文。', confirmLabel: '保存并继续', tone: 'warning' })) return;
        if (!await state.editor.saveActiveNoteEditor()) return;
      }
      const doc = await prepare(documentId), block = doc.metadata.sourceBlocks.find(block => block.id === candidate?.source.blockId) || doc.metadata.sourceBlocks[0];
      if (!block) { actions.showToast('笔记暂无正文', true); return; }
      const stale = candidate && env.MemoKeepDomain.resolveCardSource(state.persistence.data, candidate.source).stale;
      sourceDialog(candidate ? '编辑待确认卡片' : batch ? '批量录入' : '添加待确认卡片', `<form id="learningCandidateForm" class="learning-form" data-learning-submit="candidate"><input type="hidden" name="id" value="${e(id || '')}"><input type="hidden" name="batch" value="${batch ? '1' : ''}"><div class="learning-grid"><label>来源笔记<select name="documentId" data-learning-change="document">${noteOptions(doc.id)}</select></label><label>来源段落<select name="blockId" data-learning-change="block">${blockOptions(doc, block.id)}</select></label></div>${candidate ? `<details ${stale ? 'open' : ''}><summary>${stale ? '来源已变化' : '原引用快照'}</summary><blockquote>${e(candidate.source.quote)}</blockquote></details>` : ''}<label>原文<textarea name="quote" readonly rows="3">${e(candidate && !stale ? candidate.source.quote : quote && block.text.includes(quote) ? quote : block.text)}</textarea></label>${batch ? '<label>一行一张：问题 == 答案<textarea name="rows" rows="7" required placeholder="接口超时是多少？ == 2 秒"></textarea></label>' : `<label>问题<textarea name="question" rows="3" required>${e(candidate?.question || '')}</textarea></label><label>答案<textarea name="answer" rows="4" required>${e(candidate?.answer || '')}</textarea></label><div class="learning-grid"><label>卡片类型<select name="cardType"><option value="qa">问答</option><option value="cloze" ${candidate?.cardType === 'cloze' ? 'selected' : ''}>填空 {{c1::答案}}</option></select></label><label>答对要点<input name="criteria" value="${e(candidate?.criteria || '')}" placeholder="关键要点"></label></div>`}</form>`, button('取消', 'close') + `<button type="submit" class="primary" form="learningCandidateForm">${candidate ? '保存修改' : '保存到待确认'}</button>`);
    }
    async function openChange(id) {
      const change = state.persistence.data.sourceChanges?.find(row => row.id === id), card = state.persistence.data.cards.find(card => card.id === change?.cardId); if (!change || !card) return;
      const current = env.MemoKeepDomain.resolveCardSource(state.persistence.data, sourceOf(card));
      sourceDialog('原文变化', `<form id="learningChangeForm" class="learning-form" data-learning-submit="change"><input type="hidden" name="id" value="${e(id)}"><div class="learning-grid"><section><h3>原引用</h3><blockquote>${e(change.oldText)}</blockquote></section><section><h3>最新原文</h3><blockquote>${e(current.text || '来源已失效，快照已保留')}</blockquote></section></div><label>卡片问题<textarea name="question" required>${e(card.question)}</textarea></label><div class="learning-grid"><section><h3>当前答案</h3><p>${e(card.answer)}</p></section><label>确认后的答案<textarea name="answer" rows="5" required>${e(change.newAnswer)}</textarea></label></div><label>复习进度<select name="schedule"><option value="preserve">保留计划与记录</option><option value="reset">重新学习（保留历史）</option></select></label></form>`, button('忽略变化', 'ignore-change', `data-id="${e(id)}"`) + button('重新关联来源', 'relink', `data-id="${e(card.id)}"`) + (current.orphan ? '' : '<button type="submit" class="primary" form="learningChangeForm">确认更新</button>'));
    }
    async function openRelink(cardId, documentId = null) {
      const card = state.persistence.data.cards.find(card => card.id === cardId); if (!card) return;
      const id = documentId || docs()[0]?.id; if (!id) { actions.showToast('请先创建一篇笔记', true); return; }
      const doc = await prepare(id), source = sourceOf(card);
      sourceDialog('重新关联来源', `<form id="learningRelinkForm" class="learning-form" data-learning-submit="relink"><input type="hidden" name="cardId" value="${e(cardId)}"><p>${e(card.question)}</p><details><summary>原引用快照</summary><blockquote>${e(source?.quote || '暂无引用快照')}</blockquote></details><label>来源笔记<select name="documentId" data-learning-change="relink-document">${noteOptions(id)}</select></label><label>来源段落<select name="blockId" data-learning-change="block">${blockOptions(doc)}</select></label><label>新引用<textarea name="quote" readonly>${e(doc.metadata.sourceBlocks[0]?.text || '')}</textarea></label><label class="learning-check"><input type="checkbox" name="reset">重置计划，保留历史</label></form>`, button('取消', 'close') + '<button type="submit" class="primary" form="learningRelinkForm">确认关联</button>');
    }
    function renderLearningCardActions(card) {
      const count = state.persistence.data.sourceChanges?.filter(row => row.cardId === card.id && ['pending', 'orphan'].includes(row.status)).length || 0;
      return `<div class="learning-card-actions">${button(count ? `${count} 项来源变化` : '来源与关联', 'card-source', `data-id="${e(card.id)}"`)}${button(card.favorite ? '取消收藏' : '收藏卡片', 'favorite', `data-id="${e(card.id)}"`)}</div>`;
    }
    async function openLearningHub(tab = 'candidates', cardId = null) {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return;
      for (const element of env.document.querySelectorAll('dialog[open]')) element.close();
      state.shell.learningTab = tab; state.shell.learningCardId = cardId; actions.showView('learning');
    }
    function renderLearningHub() {
      const host = config.$('#learningContent'); if (!host) return;
      const data = state.persistence.data, tab = state.shell.learningTab || 'candidates', filter = state.shell.learningCardId;
      const candidates = (data.cardCandidates || []).filter(row => row.status === 'pending');
      const changes = (data.sourceChanges || []).filter(row => ['pending', 'orphan'].includes(row.status) && (!filter || row.cardId === filter));
      const orphanCards = data.cards.filter(card => (!filter || card.id === filter) && sourceOf(card) && env.MemoKeepDomain.resolveCardSource(data, sourceOf(card)).orphan);
      const favorites = data.cards.filter(card => card.favorite);
      const orphanIds = new Set(orphanCards.map(card => card.id));
      const updates = changes.filter(row => !orphanIds.has(row.cardId));
      const sourceTab = ['changes', 'orphans'].includes(tab);
      const isFavorites = tab === 'favorites';
      const tabs = [['candidates', '待确认卡片', candidates.length], ['changes', '来源提醒', updates.length + orphanCards.length]];
      host.innerHTML = `<div class="page-head learning-heading"><div><h1>${isFavorites ? '收藏卡片' : '卡片整理'}</h1><p class="hint">${isFavorites ? '随时回看想重点记住的内容。' : '批量添加与来源维护。日常制卡可直接在笔记中完成。'}</p></div><div>${button('新建卡片', 'new', '', 'primary')}<details class="learning-more"><summary>更多操作</summary><div>${button('批量录入', 'batch')}${button('添加待确认卡片', 'new-candidate')}${button('检查旧卡来源', 'adopt')}${button(isFavorites ? '返回卡片整理' : '收藏卡片', 'tab', `data-tab="${isFavorites ? 'candidates' : 'favorites'}"`)}</div></details></div></div>${isFavorites ? '' : `<div class="learning-tabs" role="tablist" aria-label="卡片整理">${tabs.map(([value, label, count]) => button(`${label}${count ? ` ${count}` : ''}`, 'tab', `data-tab="${value}" role="tab" aria-selected="${value === 'changes' ? sourceTab : tab === value}"`)).join('')}</div>`}${filter ? `<p class="hint">仅显示当前卡片 ${button('查看全部', 'clear-filter')}</p>` : ''}`;
      let content = '';
      if (tab === 'candidates' && candidates.length) content = (candidates.length > 1 ? `<div class="learning-list-actions">${button('全部加入复习', 'accept-all', '', 'primary')}</div>` : '') + candidates.map(row => {
        const resolved = env.MemoKeepDomain.resolveCardSource(data, row.source), duplicate = env.MemoKeepDomain.duplicateCard(data.cards, row);
        return `<article class="learning-row"><div><span class="hint">${e(row.source.title)}${resolved.stale ? ' · 原文已变化，请先检查' : ''}${duplicate ? ' · 内容重复' : ''}</span><h3>${e(row.question)}</h3><p>${e(row.answer)}</p><details><summary>查看原文</summary><blockquote>${e(row.source.quote)}</blockquote>${row.criteria ? `<p>${e(row.criteria)}</p>` : ''}</details></div><div>${button('编辑', 'edit-candidate', `data-id="${e(row.id)}"`)}${button('加入复习', 'accept', `data-id="${e(row.id)}" ${resolved.stale ? 'disabled title="请先检查最新原文"' : ''}`, 'primary')}${button('丢弃', 'discard', `data-id="${e(row.id)}"`)}</div></article>`;
      }).join('');
      if (sourceTab) content = updates.map(row => `<article class="learning-row"><div><h3>${e(data.cards.find(card => card.id === row.cardId)?.question || '卡片已删除')}</h3><p class="hint">${e(row.source.title)} · 原文有变化</p></div>${button('查看变化', 'change', `data-id="${e(row.id)}"`)}</article>`).join('') + orphanCards.map(card => `<article class="learning-row"><div><h3>${e(card.question)}</h3><p class="hint">来源已失效，卡片与复习记录仍保留。</p><details><summary>查看原引用</summary><blockquote>${e(sourceOf(card)?.quote)}</blockquote></details></div>${button('重新关联', 'relink', `data-id="${e(card.id)}"`)}</article>`).join('');
      if (isFavorites) content = favorites.map(card => `<article class="learning-row"><div><h3>${e(card.question)}</h3><p>${e(card.answer)}</p></div><div>${button('打开卡片', 'open-card', `data-id="${e(card.id)}"`)}${button('取消收藏', 'favorite', `data-id="${e(card.id)}"`)}</div></article>`).join('');
      const emptyTitle = isFavorites ? '还没有收藏的卡片' : sourceTab ? '来源暂无需处理' : '没有待确认的卡片';
      const emptyHint = isFavorites ? '在卡片详情中点击收藏，即可在这里找到它。' : sourceTab ? '关联原文发生变化时，会在这里提醒你。' : '在笔记中选中文字 → 制卡 → 保存，即可加入复习。';
      host.insertAdjacentHTML('beforeend', content || `<div class="learning-empty"><svg aria-hidden="true"><use href="#icon-layers"></use></svg><h2>${emptyTitle}</h2><p>${emptyHint}</p></div>`);
    }

    async function adoptLegacySources() {
      let count = 0;
      await env.application.persistence.transact(data => {
        for (const item of data.items.filter(row => row.documentId && !row.source && row.itemType === 'selection-card')) { captureCardSource(data, item, { quote: item.backText || item.frontText }); count++; }
        for (const card of data.cards) { const item = data.items.find(item => item.id === card.knowledgeItemId); if (!card.source && item?.source) card.source = env.structuredClone(item.source); }
      }); actions.showToast(`已保存 ${count} 条快照，请检查来源`); actions.renderLearningHub();
    }
    async function locateCardSource(cardId) {
      const card = state.persistence.data.cards.find(card => card.id === cardId), source = sourceOf(card), current = env.MemoKeepDomain.resolveCardSource(state.persistence.data, source);
      if (current.orphan) { await openLearningHub('orphans', cardId); return; }
      await actions.openWorkspaceNote(current.document.id);
      await new Promise(resolve => { let attempts=0; const check=()=>{if(config.$('#noteRichEditor .ql-editor') || config.$('#notePlainTextContent') || ++attempts>100 || state.editor.editingMarkdownDocumentId!==current.document.id)resolve();else env.setTimeout(check,30)};check();});
      const column = config.$('#noteRichEditor .ql-editor') || config.$('#inlineMarkdownContent');
      const plainEditor=config.$('#notePlainTextContent'); if(plainEditor){const start=plainEditor.value.indexOf(source.quote);if(start>=0){plainEditor.focus();plainEditor.setSelectionRange(start,start+source.quote.length)}return;}
      if (column) { const nodes = [...column.children]; const node = nodes.find(node => env.MemoKeepDomain.cleanSourceText(node.textContent) === env.MemoKeepDomain.cleanSourceText(current.blocks[0].text)); node?.scrollIntoView({ block: 'center' }); node?.animate?.([{ outline: '2px solid var(--blue)' }, { outline: '2px solid transparent' }], { duration: 1600 }); }
    }
    function refreshLearningTools() {
      const node = config.$('[data-learning-action="note-changes"]'); if (!node) return;
      const count = (state.persistence.data.sourceChanges || []).filter(row => row.documentId === state.editor.editingMarkdownDocumentId && ['pending', 'orphan'].includes(row.status)).length;
      node.hidden = !count; node.textContent = `${count} 张卡片待检查`; node.setAttribute('aria-label', `${count} 张卡片的来源有变化，打开检查`);
    }
    function mountLearningTools({ root: editorRoot, createCard }) {
      mounted?.();
      createFromNote = createCard;
      let parent = editorRoot?.querySelector('.note-workspace-controls'), ownParent = false;
      if (!parent) { const internalControls = editorRoot?.querySelector('.note-editor-internal-controls'); if (!internalControls) return () => {}; parent = env.document.createElement('div'); parent.className = 'note-workspace-controls'; internalControls.append(parent); ownParent = true; }
      const node = env.document.createElement('button'); node.type = 'button'; node.className = 'note-workspace-button'; node.dataset.learningAction = 'from-current'; node.setAttribute('aria-label', '从当前笔记制卡'); node.title = '选中文字可自动填入答案'; node.innerHTML = '<svg aria-hidden="true"><use href="#icon-layers"></use></svg><span>从当前笔记制卡</span>';
      node.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
      const updates = env.document.createElement('button'); updates.type = 'button'; updates.className = 'note-workspace-button learning-source-updates'; updates.dataset.learningAction = 'note-changes'; parent.append(node, updates); refreshLearningTools();
      const dispose = () => {
        node.remove(); updates.remove(); if (ownParent) parent.remove();
        if (mounted === dispose) { createFromNote = null; mounted = null; }
      };
      mounted = dispose; return dispose;
    }
    async function confirmLearningDeletion(doc) {
      const data = state.persistence.data, linked = new Set(data.items.filter(item => item.documentId === doc.id).map(item => item.id));
      if (!data.cards.some(card => linked.has(card.knowledgeItemId) || card.source?.documentId === doc.id)) {
        return await actions.showConfirmDialog({ title: '删除笔记', message: `“${doc.title}”会移入回收站。`, confirmLabel: '移入回收站', tone: 'danger' }) ? { keepCards: false } : null;
      }
      return new Promise(resolve => {
        sourceDialog('删除笔记', `<p>“${e(doc.title)}”会移入回收站。</p><label class="learning-check"><input type="checkbox" id="learningKeepCards" checked>保留卡片、快照与复习记录</label><p class="hint">不勾选将一并移入回收站。</p>`, button('取消', 'delete-cancel') + button('移入回收站', 'delete-confirm', '', 'danger'));
        state.shell.learningDeleteResolve = resolve;
        dialog.addEventListener('close', () => { if(state.shell.learningDeleteResolve === resolve) state.shell.learningDeleteResolve = null; resolve(null); }, {once:true});
      });
    }
    async function handleAction(target) {
      const action = target.dataset.learningAction, id = target.dataset.id;
      if (action === 'close') return requestLearningClose();
      if (action === 'note-changes') return openLearningHub('changes');
      if (action === 'from-current') return createFromNote?.();
      if (action === 'new') return env.application.views.cardEditor.openCardDialog();
      if (action === 'new-candidate') return openCandidateEditor();
      if (action === 'batch') return openCandidateEditor(null, state.editor.editingMarkdownDocumentId, '', true);
      if (action === 'tab') { state.shell.learningTab = target.dataset.tab; renderLearningHub(); return; }
      if (action === 'clear-filter') { state.shell.learningCardId = null; renderLearningHub(); return; }
      if (action === 'edit-candidate') return openCandidateEditor(id);
      if (action === 'accept') { const result = await api().acceptCandidates([id]); actions.showToast(`已加入复习 ${result.accepted} 张，跳过 ${result.duplicate} 张重复`); renderLearningHub(); }
      if (action === 'accept-all') { const rows = state.persistence.data.cardCandidates?.filter(row => row.status === 'pending' && !env.MemoKeepDomain.resolveCardSource(state.persistence.data, row.source).stale) || []; const result = await api().acceptCandidates(rows.map(row => row.id)); actions.showToast(`已加入复习 ${result.accepted} 张，跳过 ${result.duplicate} 张重复；原文已变化的卡片仍保留`); renderLearningHub(); }
      if (action === 'discard') { await api().discardCandidate(id); renderLearningHub(); }
      if (action === 'change') return openChange(id);
      if (action === 'ignore-change') { await api().resolveChange(id, { ignore: true }); dialog.close(); renderLearningHub(); }
      if (action === 'relink') { if(dialog?.open && !await requestLearningClose()) return; return openRelink(id); }
      if (action === 'card-source') { const card = state.persistence.data.cards.find(card => card.id === id), source = sourceOf(card), changes = state.persistence.data.sourceChanges?.some(row => row.cardId === id && ['pending', 'orphan'].includes(row.status));
        for (const element of env.document.querySelectorAll('dialog[open]')) if(element !== dialog) element.close();
        if (changes) return openLearningHub('changes', id);
        if (!source) return openRelink(id);
        const current = env.MemoKeepDomain.resolveCardSource(state.persistence.data, source);
        sourceDialog('卡片来源', `<h3>${e(source.title || '来源笔记')}</h3><p class="hint">v${source.version} · ${current.orphan ? '无法定位，快照已保留' : current.stale ? '原文已变化' : '与原文一致'}</p><blockquote>${e(source.quote)}</blockquote>`, (current.orphan ? '' : button('定位原文', 'locate', `data-id="${e(id)}"`)) + button('重新关联', 'relink', `data-id="${e(id)}"`));
      }
      if (action === 'favorite') { const card = state.persistence.data.cards.find(card => card.id === id); await api().favoriteCard(id, !card.favorite); target.textContent = card.favorite ? '收藏卡片' : '取消收藏'; if (state.shell.learningTab === 'favorites') renderLearningHub(); }
      if (action === 'open-card') env.application.views.cardDetail.openCardDetail(env.application.state.cards.byId(id));
      if (action === 'locate') { dialog?.close(); return locateCardSource(id); }
      if (action === 'adopt') return adoptLegacySources();
      if (action === 'delete-cancel' || action === 'delete-confirm') { const resolve = state.shell.learningDeleteResolve; state.shell.learningDeleteResolve = null; const value = action === 'delete-confirm' ? { keepCards: config.$('#learningKeepCards').checked } : null; dialog.close(); resolve?.(value); }
    }
    function bindSourceLearning() {
      env.document.addEventListener('click', event => { const target = event.target.closest('[data-learning-action]'); if (!target) return; event.preventDefault(); Promise.resolve(handleAction(target)).catch(error => { const output = dialog?.open && dialog.querySelector('[data-learning-error]'); if (output) output.textContent = error.message; else actions.showToast(error.message, true); }); });
      env.document.addEventListener('submit', async event => {
        const form = event.target.closest('[data-learning-submit]'); if (!form) return; event.preventDefault(); if (form.dataset.saving) return; form.dataset.saving = '1';
        const data = new env.window.FormData(form), values = Object.fromEntries(data.entries()), submit = dialog.querySelector('button[type=submit]'); if (submit) submit.disabled = true;
        try {
          if (form.dataset.learningSubmit === 'candidate') {
            if (values.id) await api().updateCandidate(values.id, values);
            else {
              let rows = [{ ...values }];
              if (values.batch) {
                rows = String(values.rows || '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
                  const parsed = env.application.domain.parseInlineCards(line);
                  if (parsed.length !== 1 || !parsed[0].question?.trim() || !parsed[0].answer?.trim()) throw new Error(`第 ${index + 1} 行格式不完整，请使用「问题 == 答案」`);
                  return { question: parsed[0].question, answer: parsed[0].answer, cardType: 'qa', quote: values.quote, blockId: values.blockId };
                });
              }
              const added = await api().createCandidates(values.documentId, rows);
              if (!added) { dialog.querySelector('[data-learning-error]').textContent = '已有相同候选'; return; }
            }
          }
          if (form.dataset.learningSubmit === 'change') await api().resolveChange(values.id, { question: values.question, answer: values.answer, reset: values.schedule === 'reset' });
          if (form.dataset.learningSubmit === 'relink') await api().relink(values.cardId, values.documentId, values.blockId, data.has('reset'));
          dialog.close(); actions.showToast('已保存'); actions.renderLearningHub();
        } catch (error) { dialog.querySelector('[data-learning-error]').textContent = error.message; }
        finally { delete form.dataset.saving; if (submit?.isConnected) submit.disabled = false; }
      });
      env.document.addEventListener('change', async event => {
        const target = event.target.closest('[data-learning-change]'); if (!target) return;
        try {
          const form = target.closest('form');
          if (target.dataset.learningChange.includes('document')) { const doc = await prepare(target.value); form.elements.blockId.innerHTML = blockOptions(doc); }
          const doc = documentIn(form.elements.documentId.value), block = doc?.metadata.sourceBlocks.find(row => row.id === form.elements.blockId.value); form.elements.quote.value = block?.text || '';
        } catch (error) { actions.showToast(error.message, true); }
      });
      config.$('#sourceLearningNav')?.addEventListener('click', () => void openLearningHub());
    }
    return { describeSourceDocument, captureCardSource, syncCardSources, renderLearningCardActions, openLearningHub, renderLearningHub, mountLearningTools, refreshLearningTools, bindSourceLearning, confirmLearningDeletion };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createSourceLearningFeatures });
})(globalThis);
