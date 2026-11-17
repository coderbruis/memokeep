(function expose(root) {
  function createCardDetail({ $, state, presentation, helpers, transact, document }) {
    const { cardStage, cardStageMeta, cardLibraryLabel, cardSourceNoteLabel, documentById, escapeHtml, sanitizeRichNoteContent, renderMarkdown } = helpers;
    let splitDialog;
    function qualityIssues(card) { return helpers.cardFormats?.cardQualityIssues(card) || []; }
    function openSplitDialog(card) {
      if (!transact) return;
      splitDialog?.remove(); splitDialog = document.createElement('dialog'); splitDialog.id = 'cardSplitDialog'; splitDialog.setAttribute('aria-labelledby','cardSplitTitle');
      splitDialog.innerHTML = `<form class="cf-split-form"><div class="dialog-head"><h2 id="cardSplitTitle">拆分卡片</h2><button type="button" class="icon-btn" data-split-cancel aria-label="关闭拆卡">×</button></div><p class="hint">新卡重新学习，原卡与记录保留。</p><div data-split-entries></div><button type="button" class="secondary" data-split-add>再加一张</button><label><input type="checkbox" name="pauseOriginal" checked> 创建后暂停原卡</label><p data-split-error role="alert" hidden></p><div class="dialog-actions"><button type="button" class="secondary" data-split-cancel>取消</button><button type="submit" class="primary">创建新卡</button></div></form>`;
      document.body.appendChild(splitDialog); const form=splitDialog.querySelector('form'), entries=splitDialog.querySelector('[data-split-entries]'); let saving=false;
      const answers=String(card.answer||'').split(/\n+|[；;]/).map(t=>t.trim()).filter(Boolean);
      function add(answer='') {
        const field=document.createElement('div');field.className='cf-split-entry';
        field.innerHTML='<label>具体问题<textarea name="question" rows="2" required></textarea></label><label>答对要点<textarea name="answer" rows="2" required></textarea></label><button type="button" class="text-btn" data-split-remove>移除</button>';
        field.querySelector('[name=answer]').value=answer;
        field.querySelector('[data-split-remove]').onclick=()=>{if(entries.children.length<=2){helpers.showToast?.('至少保留两张子卡片');return}field.remove()};entries.appendChild(field);
      }
      add(answers[0]||''); add(answers.slice(1).join('；'));
      const signature=()=>JSON.stringify([...form.querySelectorAll('textarea,input')].map(input=>input.type==='checkbox'?input.checked:input.value)), baseline=signature();
      async function close(){
        if(saving)return;
        if(signature()!==baseline&&helpers.showConfirmDialog&&!await helpers.showConfirmDialog({title:'放弃拆卡草稿？',message:'未保存的内容将丢失。',confirmLabel:'放弃修改',tone:'warning'}))return;
        splitDialog.close();
      }
      form.querySelectorAll('[data-split-cancel]').forEach(button=>button.onclick=close);
      splitDialog.addEventListener('cancel',event=>{event.preventDefault();void close()});
      form.querySelector('[data-split-add]').onclick=()=>{if(entries.children.length>=6){helpers.showToast?.('一次最多拆成六张卡片');return}add()};
      form.onsubmit=async event=>{
        event.preventDefault();if(saving)return;
        const rows=[...entries.children].map(field=>({question:field.querySelector('[name=question]').value.trim(),answer:field.querySelector('[name=answer]').value.trim()})), error=form.querySelector('[data-split-error]');
        if(rows.some(row=>!row.question||!row.answer)){error.textContent='请填写每张卡的问题和答案。';error.hidden=false;form.querySelector('textarea:invalid')?.focus();return}
        if(new Set(rows.map(row=>row.question)).size!==rows.length){error.textContent='问题不能重复。';error.hidden=false;return}
        saving=true;form.querySelectorAll('button').forEach(button=>button.disabled=true);error.hidden=true;
        try {
          await transact(candidateData=>{
            const original=candidateData.cards.find(item=>item.id===card.id);if(!original)throw Error('原卡已不存在');
            for(const row of rows){
              if(candidateData.cards.some(item=>item.id!==original.id&&item.question.trim()===row.question&&((original.cardFolderId&&item.cardFolderId===original.cardFolderId)||(original.cardNotebookId&&item.cardNotebookId===original.cardNotebookId))))throw Error('目标位置已有同名题目，请调整问题');
              const created=helpers.createCard({...row,knowledgeBaseId:original.knowledgeBaseId,knowledgeItemId:original.knowledgeItemId,cardNotebookId:original.cardNotebookId,...(Object.hasOwn(original,'cardFolderId')?{cardFolderId:original.cardFolderId}:{}),tags:[...(original.tags||[])]});
              Object.assign(created,{cardType:'qa',splitFrom:original.id,...(original.source?{source:structuredClone(original.source)}:{})});candidateData.cards.unshift(created);
            }
            if(form.elements.pauseOriginal.checked)original.status='paused';
          });
          splitDialog.close();$('#cardDetailDialog').close();helpers.renderAll();helpers.showToast?.(`已创建 ${rows.length} 张新卡，原卡与历史已保留`);
        } catch(cause){error.textContent=`创建失败：${cause.message}。草稿已保留。`;error.hidden=false}
        finally{saving=false;form.querySelectorAll('button').forEach(button=>button.disabled=false)}
      };
      splitDialog.showModal();entries.querySelector('textarea').focus();
    }

    function openCardDetail(card) {
      if (!card) return;
      const stage = cardStage(card);
      const type = helpers.cardFormats?.formatLabel(card) || '问答卡';
      const item = state.knowledge.itemById(card.knowledgeItemId);
      const sourceDocument = documentById(item?.documentId);
      $('#cardDetailId').value = card.id;
      presentation.renderContent($('#cardDetailQuestion'), card.question, card);
      presentation.renderAnswer($('#cardDetailAnswer'), card.answer, card);
      $('#cardDetailMeta').innerHTML = `
        <span><small>所属知识库</small><strong>${escapeHtml(cardLibraryLabel(card))}</strong></span>
        <span><small>来源笔记</small><strong>${escapeHtml(cardSourceNoteLabel(card))}</strong></span>
        <span><small>学习状态</small><strong>${cardStageMeta[stage].label}</strong></span>
        <span><small>累计复习</small><strong>${Number(card.reviewCount || 0)} 次</strong></span>
        <span><small>卡片类型</small><strong>${escapeHtml(type)}</strong></span>
        ${card.tags?.length ? `<div class="card-detail-tags">${card.tags.map(tag => `<i>${escapeHtml(tag)}</i>`).join('')}</div>` : ''}`;
      // 制卡标记：卡片来自笔记的哪一段，可以「定位到原文」；原文删掉了就提示一下。
      const anchor = card.sourceAnchor, anchorDocument = anchor && documentById(anchor.documentId);
      if (anchor && root.MemoKeepCardAnchors) {
        const holder = document.createElement('div');
        holder.innerHTML = anchorDocument?.metadata?.editorMode === 'note' && anchorDocument.metadata.noteContentInitialized ? sanitizeRichNoteContent(anchorDocument.metadata.noteContent || '').replace(/<\/(p|h[1-6]|li|blockquote|pre|div)>/gi, '$&\n') : renderMarkdown(anchorDocument?.content || '');
        const status = anchorDocument ? root.MemoKeepCardAnchors.resolve(holder.textContent, anchor).status : 'missing';
        const row = document.createElement('div');
        row.className = `card-detail-anchor${status === 'missing' ? ' is-missing' : ''}`;
        row.innerHTML = status === 'missing'
          ? `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/></svg><span>原文段落已经从笔记里删掉了</span><button type="button" class="secondary" data-anchor-clear>去掉来源</button>`
          : `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>来自 <b>${escapeHtml(anchorDocument.title || '笔记')}${anchor.heading ? ` › ${escapeHtml(anchor.heading)}` : ''}</b>${status === 'stale' ? '<em>原文改过</em>' : ''}</span><button type="button" class="secondary" data-anchor-locate>定位到原文</button>`;
        $('#cardDetailMeta').appendChild(row);
        row.querySelector('[data-anchor-locate]')?.addEventListener('click', () => { $('#cardDetailDialog').close(); root.MemoKeepLocateCardSource?.(card); });
        row.querySelector('[data-anchor-clear]')?.addEventListener('click', async () => {
          if (!transact) return;
          await transact(candidate => { const target = candidate.cards.find(item => item.id === card.id); if (target) { delete target.sourceAnchor; target.sourceAnchorDismissed = true; } });
          row.remove();
        });
      }
      // 要点记忆（design/prototype/memory-boost-20261112.md）：每条最近 5 次想起 / 没想起、想起率，最弱的标橙。
      const recall = root.MemoKeepPointRecall?.summary(card);
      if (recall) {
        const section = document.createElement('section'); section.className = 'card-detail-recall';
        const missed = recall.items.filter(item => item.lastMissed || item.weak).length;
        section.innerHTML = `<div class="cdr-head"><h3>要点记忆</h3><span>要点平均想起 <b>${recall.average}%</b></span>${recall.weakest ? `<span>最弱：<b class="cdr-weak">${escapeHtml(recall.weakest.text.slice(0, 24))}</b></span>` : ''}</div>
          <div class="cdr-table" role="table" aria-label="每条要点最近的记录"><div class="cdr-row cdr-th" role="row"><span role="columnheader">要点</span><span role="columnheader">最近 ${root.MemoKeepPointRecall.HISTORY} 次</span><span role="columnheader">想起率</span></div>
          ${recall.items.map(item => `<div class="cdr-row${item.weak ? ' is-weak' : ''}" role="row"><span role="cell" class="cdr-text">${escapeHtml(item.text)}${item.lastMissed ? '<small>上次没想起</small>' : ''}</span><span role="cell" class="cdr-dots" aria-label="${[...item.history].map(mark => mark === 'y' ? '想起' : '没想起').join('，')}">${[...item.history].map(mark => `<i class="${mark === 'y' ? 'y' : 'n'}">${mark === 'y' ? '✓' : '✕'}</i>`).join('')}</span><span role="cell" class="cdr-rate">${item.rate}%<i style="--rate:${item.rate}%"></i></span></div>`).join('')}</div>
          <div class="cdr-actions">${missed ? `<button type="button" class="primary" data-recall-practice>只练没记牢的 ${missed} 条</button>` : ''}${recall.weakest && transact ? '<button type="button" class="secondary" data-recall-split>把最弱的一条拆成单独的卡</button>' : ''}</div>`;
        $('#cardDetailMeta').appendChild(section);
        section.querySelector('[data-recall-practice]')?.addEventListener('click', () => { $('#cardDetailDialog').close(); helpers.startPractice?.([card.id]); });
        section.querySelector('[data-recall-split]')?.addEventListener('click', async event => {
          const weakest = recall.weakest, suggestion = root.MemoKeepPointRecall.splitSuggestions({ question: card.question, answer: weakest.text })[0];
          if (!suggestion) return;
          event.currentTarget.disabled = true;
          try {
            await transact(candidate => {
              const original = candidate.cards.find(item => item.id === card.id); if (!original) throw Error('原卡已不存在');
              const created = helpers.createCard({ ...suggestion, knowledgeBaseId: original.knowledgeBaseId, knowledgeItemId: original.knowledgeItemId, cardNotebookId: original.cardNotebookId, ...(Object.hasOwn(original, 'cardFolderId') ? { cardFolderId: original.cardFolderId } : {}), tags: [...(original.tags || [])] });
              Object.assign(created, { cardType: 'qa', splitFrom: original.id, ...(original.sourceAnchor ? { sourceAnchor: structuredClone(original.sourceAnchor) } : {}) });
              candidate.cards.unshift(created);
            });
            helpers.showToast?.(`已把「${suggestion.question}」拆成单独的卡，原卡保留`);
            helpers.renderAll?.();
          } catch (cause) { helpers.showToast?.(`拆卡失败：${cause.message}`, true); event.currentTarget.disabled = false; }
        });
      }
      if (transact) {
        const issues=qualityIssues(card), repair=document.createElement('section');repair.className='cf-repair-panel';
        repair.innerHTML=`${issues.length?`<p class="hint">${issues.map(escapeHtml).join('<br>')}</p>`:''}<div class="cf-repair-actions"><button type="button" class="secondary" data-repair-edit>编辑卡片</button><button type="button" class="secondary" data-repair-split>拆分卡片</button></div>${helpers.renderLearningCardActions?.(card)||''}`;
        $('#cardDetailMeta').appendChild(repair);repair.querySelector('[data-repair-edit]').onclick=()=>$('#cardDetailEdit').click();repair.querySelector('[data-repair-split]').onclick=()=>openSplitDialog(card);
      }
      const sourceButton = $('#cardDetailOpenSource');
      sourceButton.classList.toggle('hidden', !sourceDocument);
      sourceButton.dataset.documentId = sourceDocument?.id || '';
      $('#cardDetailSourceDrawer').classList.add('hidden');
      $('#cardDetailLayout').classList.remove('source-open');
      $('#cardDetailDialog').showModal();
    }

    function openCardDetailSourceDrawer() {
      const sourceDocument = documentById($('#cardDetailOpenSource').dataset.documentId);
      if (!sourceDocument) return;
      const richContent = sourceDocument.metadata?.editorMode === 'note' && sourceDocument.metadata?.noteContentInitialized
        ? sanitizeRichNoteContent(sourceDocument.metadata.noteContent || '')
        : renderMarkdown(sourceDocument.content || '');
      $('#cardDetailSourceTitle').textContent = sourceDocument.title || '未命名笔记';
      $('#cardDetailSourceContent').innerHTML = richContent || '<p class="muted">暂无正文</p>';
      $('#cardDetailSourceDrawer').classList.remove('hidden');
      $('#cardDetailLayout').classList.add('source-open');
    }

    function closeCardDetailSourceDrawer() {
      $('#cardDetailSourceDrawer').classList.add('hidden');
      $('#cardDetailLayout').classList.remove('source-open');
    }
    return { openSplitDialog, openCardDetail, openCardDetailSourceDrawer, closeCardDetailSourceDrawer };
  }
  const api = { createCardDetail };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
