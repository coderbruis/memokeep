// 制卡提示（design/prototype/memory-boost-20261112.md）：编辑卡片时，答案 3 条以上或太长 → 建议拆成小卡或保留按要点评分；
// 只考「是什么」→ 建议再加一道理解题（为什么 / 区别 / 会怎样 / 举例）。只在编辑框里提示，不弹窗；全部在本地完成。
// 判断项（design/prototype/check-items-20261112.md）：答案框左边标出哪几行是判断项；选中几行「设为判断项」（⌘L 切换）加上「- 」。
(function bindCardSplitHint() {
  const $ = selector => document.querySelector(selector);
  const recall = () => window.MemoKeepPointRecall;
  const shell = () => (typeof applicationShell !== 'undefined' ? applicationShell : null);
  const app = () => (typeof application !== 'undefined' ? application : null);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let host = null, dismissed = false, previewOpen = false, pendingTemplate = null, lastSignature = '';

  const editingCard = () => { const id = $('#editingCardId')?.value; return id ? shell()?.state.persistence.data.cards.find(card => card.id === id) || null : null; };
  const draft = () => ({ question: $('#question')?.value || '', answer: $('#answer')?.value || '', cardType: $('#cardFormatType')?.value || 'qa' });

  let tools = null, gutter = null;
  function ensureHost() {
    if (host?.isConnected) return host;
    const field = $('#cardForm section[data-card-field="answer"]');
    if (!field) return null;
    tools = document.createElement('div'); tools.id = 'cardItemTools'; tools.className = 'ce-item-tools';
    tools.innerHTML = `<button type="button" class="ce-item-btn is-mark" data-item-mark title="设为判断项（⌘L）"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/></svg><span>设为判断项</span></button><button type="button" class="ce-item-btn" data-item-unmark>取消判断项</button><span class="ce-item-key"><kbd>⌘L</kbd> 切换</span><span class="ce-item-count" id="cardItemCount"></span>`;
    host = document.createElement('div'); host.id = 'cardSplitHint'; host.className = 'ce-split-hint';
    field.after(tools, host);
    gutter = document.createElement('div'); gutter.className = 'ce-item-gutter'; gutter.setAttribute('aria-hidden', 'true');
    field.append(gutter);
    // 点按钮时不让编辑框失去选区。
    tools.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
    tools.addEventListener('click', event => {
      if (event.target.closest('[data-item-mark]')) markSelection(true);
      else if (event.target.closest('[data-item-unmark]')) markSelection(false);
    });
    host.addEventListener('click', onClick);
    return host;
  }

  // ---------- 判断项 ----------
  const answerEditor = () => $('#answerEditor');
  const editableKind = () => (draft().cardType || 'qa') === 'qa';
  // 编辑框里选区所在的行（按换行数；图片不占行）。没有选区就是光标所在的行。
  function selectedLines() {
    const editor = answerEditor(), selection = getSelection();
    if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0), before = document.createRange();
    before.selectNodeContents(editor); before.setEnd(range.startContainer, range.startOffset);
    const from = (before.toString().match(/\n/g) || []).length;
    before.setEnd(range.endContainer, range.endOffset);
    const upto = before.toString();
    let to = (upto.match(/\n/g) || []).length;
    if (!range.collapsed && upto.endsWith('\n') && to > from) to--;
    return { from, to };
  }
  // 改答案文字：写回 #answer、重画编辑框（和打开对话框时一样），再触发 input 让对话框记下改动。
  function setAnswer(value, select = null) {
    const editor = answerEditor(), field = $('#answer');
    if (!editor || !field) return;
    field.value = value;
    editor.textContent = '';
    for (const part of ReviewPresentation.contentParts(value)) editor.appendChild(part.reference ? ReviewPresentation.imageNode(part) : document.createTextNode(part.text));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    if (select) selectLines(select.from, select.to);
    render(true);
  }
  function selectLines(from, to) {
    const editor = answerEditor();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let line = 0, start = null, end = null, last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      last = node;
      for (let offset = 0; offset <= node.length; offset++) {
        if (start === null && line === from) start = [node, offset];
        if (line === to && (offset === node.length || node.data[offset] === '\n')) { end = [node, offset]; if (offset < node.length) break; }
        if (offset < node.length && node.data[offset] === '\n') line++;
      }
      if (end && line > to) break;
    }
    if (!start) return;
    const range = document.createRange(); range.setStart(...start); range.setEnd(...(end || [last, last.length]));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    editor.focus();
  }
  function markSelection(on) {
    const module = recall(), lines = selectedLines();
    if (!module || !lines) { shell()?.actions.showToast('先在答案里选中要设为判断项的几行'); return; }
    setAnswer(module.markLines($('#answer').value, lines.from, lines.to, on), lines);
  }
  function toggleSelection() {
    const module = recall(), lines = selectedLines();
    if (!module || !lines) return;
    const rows = $('#answer').value.split('\n').slice(lines.from, lines.to + 1).filter(line => line.trim());
    markSelection(!(rows.length && rows.every(module.isItem)));
  }
  function markSuggested() {
    const module = recall(), indexes = module?.suggestedItemLines($('#answer').value) || [];
    if (!indexes.length) return;
    let value = $('#answer').value;
    for (const index of indexes) value = module.markLines(value, index, index, true);
    setAnswer(value);
  }
  // 左边的「判断」标记：量出每个判断项那一行在编辑框里的位置。
  function paintGutter() {
    const editor = answerEditor(), module = recall();
    if (!gutter || !editor || !module) return;
    const show = editableKind();
    editor.classList.toggle('has-item-gutter', show);
    gutter.hidden = !show;
    if (!show) { gutter.textContent = ''; return; }
    const lines = ($('#answer')?.value || '').split('\n');
    const marks = [], base = gutter.parentElement.getBoundingClientRect();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let line = 0, atLineStart = true;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let offset = 0; offset < node.length; offset++) {
        if (atLineStart && node.data[offset] !== '\n' && module.isItem(lines[line] || '')) {
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
          const rect = range.getClientRects()[0];
          if (rect) marks.push(rect.top - base.top + rect.height / 2);
        }
        atLineStart = false;
        if (node.data[offset] === '\n') { line++; atLineStart = true; }
      }
    }
    gutter.innerHTML = marks.map(top => `<span style="top:${top.toFixed(1)}px">判断</span>`).join('');
  }

  function templates(question) {
    const subject = recall()?.subjectOf(question) || '';
    return [`为什么${subject}……？`, `${subject}和……有什么区别？`, `如果${subject}……，会怎样？`, `举个例子：${subject}……`];
  }

  function render(force = false) {
    const box = ensureHost(), module = recall();
    if (!box || !module) return;
    const card = draft(), existing = editingCard();
    const signature = JSON.stringify([card, dismissed, previewOpen, existing?.id]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const advice = !dismissed && !existing?.splitHintDismissed ? module.splitAdvice(card) : null;
    const askDefinition = card.cardType === 'qa' && card.answer.trim() && /是什么|是啥|什么是|定义/.test(card.question);
    const itemCount = module.checkItems(card.answer).length, suggested = module.suggestedItemLines(card.answer);
    const showTools = editableKind();
    if (tools) { tools.hidden = !showTools; tools.querySelector('#cardItemCount').innerHTML = `判断项 <b>${itemCount}</b> 个`; }
    let html = '';
    // 判断项提示：没有（多行卡）/ 只有 1 个 / 2 个以上。
    if (showTools && !previewOpen) {
      if (!itemCount && suggested.length) html += `<div class="ce-hint-box is-warn"><h4>这张卡还没有判断项</h4><p>复习时整张卡打一个分。答案里有好几条要记的内容，就把它们设为判断项${advice ? '，或者拆成几张小卡' : ''}。</p><div class="ce-hint-row"><button type="button" class="ce-item-btn is-mark" data-item-suggest>把后 ${suggested.length} 行设为判断项</button>${advice ? `<button type="button" class="ce-item-btn" data-split-open>拆成 ${advice.points.length} 张卡</button>` : ''}</div></div>`;
      else if (itemCount === 1) html += `<div class="ce-hint-box is-warn"><h4>只有 1 个判断项</h4><p>至少 2 项才逐条判断；只有 1 项时整张卡打一个分。</p></div>`;
      else if (itemCount >= 2) html += `<div class="ce-hint-box is-item"><h4>复习时逐条判断这 ${itemCount} 项</h4><p>说明和引子（没标的行）复习时照常显示，只是不参与判断。</p></div>`;
    }
    if (advice && !previewOpen && (!showTools || itemCount)) {
      const count = advice.points.length;
      html += `<div class="ce-hint-box is-warn"><h4><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/></svg>${advice.reason === 'points' ? `答案有 ${count} 条，一次很难全想起来` : '答案比较长，一次很难全想起来'}</h4>
        <p>拆成 ${count} 张小卡，每张只考一条；或者保留这张，复习时逐条判断。</p>
        <div class="ce-hint-row"><button type="button" class="primary" data-split-open>拆成 ${count} 张卡</button><button type="button" class="secondary" data-split-keep>保留这张</button></div></div>`;
    }
    if (advice && previewOpen) {
      const rows = module.splitSuggestions(card);
      html += `<div class="ce-split-preview" role="group" aria-label="拆分预览"><p class="ce-split-title">拆成 ${rows.length} 张卡：问题可以直接改，不要的取消勾选</p>
        ${rows.map((row, index) => `<div class="ce-split-row"><input type="checkbox" id="splitKeep${index}" data-split-row checked aria-label="保留第 ${index + 1} 张"><div><input type="text" id="splitQuestion${index}" data-split-question value="${esc(row.question)}" aria-label="第 ${index + 1} 张的问题"><p data-split-answer>${esc(row.answer)}</p></div></div>`).join('')}
        <div class="ce-split-foot">${existing ? '<label><input type="checkbox" id="splitKeepOriginal" checked> 保留原卡继续复习（不勾选就暂停原卡）</label>' : '<span>这张还没保存，拆完就用新卡代替它。</span>'}<span class="ce-grow"></span><button type="button" class="secondary" data-split-cancel>取消</button><button type="button" class="primary" data-split-create>创建 ${rows.length} 张卡</button></div>
        <p class="ce-split-error" role="alert" hidden></p></div>`;
    }
    if (askDefinition && !previewOpen) {
      html += `<div class="ce-hint-box is-idea"><h4><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/></svg>只考了「是什么」，再加一道理解题？</h4>
        <p>点一个模板，保存这张后会新建一张卡，问题开头已经填好。</p>
        <div class="ce-hint-row">${templates(card.question).map(text => `<button type="button" class="ce-template" data-split-template="${esc(text)}">${esc(text.replace(recall().subjectOf(card.question), '…'))}</button>`).join('')}</div></div>`;
    }
    box.innerHTML = html;
    box.hidden = !html;
    requestAnimationFrame(paintGutter);
  }

  async function createSplit() {
    const box = ensureHost(), module = recall(), data = shell()?.state.persistence.data;
    if (!box || !module || !app()) return;
    const error = box.querySelector('.ce-split-error');
    const rows = [...box.querySelectorAll('.ce-split-row')].filter(row => row.querySelector('[data-split-row]').checked)
      .map(row => ({ question: row.querySelector('[data-split-question]').value.trim(), answer: row.querySelector('[data-split-answer]').textContent.trim() }))
      .filter(row => row.question && row.answer);
    if (rows.length < 1) { error.textContent = '至少保留一张卡。'; error.hidden = false; return; }
    if (new Set(rows.map(row => row.question)).size !== rows.length) { error.textContent = '问题不能重复。'; error.hidden = false; return; }
    const existing = editingCard(), keep = $('#splitKeepOriginal')?.checked !== false;
    const tags = ($('#cardTags')?.value || '').split(/[,，]/).map(value => value.trim()).filter(Boolean);
    const destination = typeof cardDestination === 'function' ? cardDestination($('#cardNotebookSelect')?.value || '') : {};
    const knowledgeBaseId = $('#cardLibrary')?.value || null, sourceItemId = $('#sourceItemId')?.value || existing?.knowledgeItemId || null;
    box.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await app().persistence.transact(candidate => {
        const original = existing && candidate.cards.find(card => card.id === existing.id);
        if (existing && !original) throw new Error('原卡已不存在');
        for (const row of [...rows].reverse()) {
          const created = shell().actions.createCard({ ...row, knowledgeBaseId, knowledgeItemId: sourceItemId, ...destination, tags });
          Object.assign(created, { cardType: 'qa', ...(original ? { splitFrom: original.id } : {}), ...(original?.sourceAnchor ? { sourceAnchor: structuredClone(original.sourceAnchor) } : {}) });
          candidate.cards.unshift(created);
        }
        if (original && !keep) original.status = 'paused';
      });
    } catch (cause) {
      error.textContent = `创建失败：${cause.message}。内容已保留。`; error.hidden = false;
      box.querySelectorAll('button').forEach(button => { button.disabled = false; });
      return;
    }
    $('#cardDialog').close();
    shell().actions.renderAll();
    shell().actions.showToast(`已创建 ${rows.length} 张卡${existing ? keep ? '，原卡保留' : '，原卡已暂停' : ''}`);
  }

  async function keepWhole() {
    dismissed = true;
    const existing = editingCard();
    if (existing && app()) await app().persistence.transact(candidate => { const card = candidate.cards.find(item => item.id === existing.id); if (card) card.splitHintDismissed = true; }).catch(() => {});
    render(true);
    shell()?.actions.showToast('好的，保留这张卡，不再提示拆分');
  }

  // 理解题模板：先保存这张（有改动或是新卡），保存成功、窗口关掉后再新建一张，问题开头已经填好。
  function useTemplate(text) {
    pendingTemplate = { question: text, knowledgeBaseId: $('#cardLibrary')?.value || '', tags: ($('#cardTags')?.value || '').split(/[,，]/).map(value => value.trim()).filter(Boolean) };
    const dirty = $('#cardEditStatus')?.classList.contains('is-dirty') || !$('#editingCardId')?.value;
    if (dirty) $('#cardForm').requestSubmit();
    else $('#cardDialog').close();
  }
  function openPendingTemplate() {
    const preset = pendingTemplate; pendingTemplate = null;
    if (!preset || !app()) return;
    app().views.cardEditor.openCardDialog(null, preset);
    // 光标停在「……」上，直接输入就替换掉。
    setTimeout(() => {
      const editor = $('#questionEditor');
      const walker = editor && document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker?.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf('……');
        if (at < 0) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 2);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        editor.focus();
        break;
      }
    }, 30);
  }

  function onClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-split-open')) { previewOpen = true; render(true); host.querySelector('[data-split-question]')?.focus(); }
    else if (button.hasAttribute('data-split-cancel')) { previewOpen = false; render(true); }
    else if (button.hasAttribute('data-split-create')) void createSplit();
    else if (button.hasAttribute('data-split-keep')) void keepWhole();
    else if (button.hasAttribute('data-item-suggest')) markSuggested();
    else if (button.dataset.splitTemplate) useTemplate(button.dataset.splitTemplate);
  }

  function bind() {
    const dialog = $('#cardDialog');
    if (!dialog) return;
    // 打开对话框：重置状态再画；答案 / 问题 / 格式改动时重新检查。
    new MutationObserver(() => { if (dialog.open) { dismissed = false; previewOpen = false; lastSignature = ''; render(true); } })
      .observe(dialog, { attributes: true, attributeFilter: ['open'] });
    dialog.addEventListener('input', event => { if (event.target.closest?.('#questionEditor, #answerEditor')) setTimeout(() => render(), 0); });
    dialog.addEventListener('change', event => { if (event.target.id === 'cardFormatType') render(true); });
    // ⌘L：在答案里切换选中几行是不是判断项。
    dialog.addEventListener('keydown', event => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== 'l' || !event.target.closest?.('#answerEditor') || !editableKind()) return;
      event.preventDefault(); event.stopPropagation(); toggleSelection();
    });
    window.addEventListener('resize', () => { if (dialog.open) paintGutter(); });
    new ResizeObserver(() => { if (dialog.open) paintGutter(); }).observe(dialog);
    dialog.addEventListener('close', () => { if (pendingTemplate) setTimeout(openPendingTemplate, 0); });
    // 取消编辑（或保存失败后取消）就不再新建理解题。
    dialog.addEventListener('cancel', () => { pendingTemplate = null; });
    dialog.addEventListener('click', event => { if (event.target.closest?.('[data-card-close]')) pendingTemplate = null; }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
  window.MemoKeepCardSplitHint = { render: () => render(true) };
})();
