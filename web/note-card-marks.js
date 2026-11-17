// 笔记里的制卡标记（design/prototype/note-card-marks-20261112.md）。
// 制过卡的原文：淡蓝底 + 细下划线；段落左边「卡 N」小标（点开看是哪几张卡）；大纲每节后面显示卡片数。
// 标记画在编辑器上面的一层，不改笔记内容；位置每次打开 / 编辑后用 web/domain/card-anchors.js 重新找。
function bindNoteCardMarks(quill, column, options) {
  const { documentId, cards, sourceDocumentOf, enabled, saveAnchors, openCard, reviewCard, createCard } = options;
  const A = window.MemoKeepCardAnchors;
  if (!A) return null;
  const root = quill.root;
  const layer = document.createElement('div');
  layer.className = 'note-card-marks-layer';
  layer.setAttribute('aria-hidden', 'false');
  column.append(layer);
  let resolved = [], groups = [], counts = new Map(), frame = null, timer = null, disposed = false, popover = null, popoverGroup = null, flashId = null;
  let lastData = null;
  const tried = new Set();
  const STAGE = { new: '新卡', due: '到期复习', learning: '学习中', mastered: '已掌握', paused: '已暂停' };
  const shell = () => (typeof applicationShell !== 'undefined' ? applicationShell : null);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function headings() {
    const list = [];
    for (const line of quill.getLines()) {
      const level = line.formats?.().header;
      if (level) list.push({ index: quill.getIndex(line), text: line.domNode.textContent.trim(), level });
    }
    return list;
  }

  // ---------- 计算：找回每张卡片的原文位置 ----------
  function compute() {
    timer = null;
    if (disposed) return;
    const id = documentId();
    if (!id || !enabled()) { resolved = []; groups = []; counts = new Map(); render(); decorateOutline(); return; }
    const text = A.textOf(quill.getContents());
    const heads = headings();
    const all = cards() || [];
    lastData = all;
    // 以前做的卡片：用卡片答案找段落，找到就补上位置（每张卡每次打开只试一次）。
    const updates = [];
    for (const card of all) {
      if (card.sourceAnchor || card.sourceAnchorDismissed || card.cardType === 'point' || tried.has(card.id) || sourceDocumentOf(card) !== id) continue;
      tried.add(card.id);
      const anchor = A.infer(text, card, { documentId: id, headings: heads });
      if (anchor) updates.push({ cardId: card.id, anchor });
    }
    if (updates.length) saveAnchors(updates);
    resolved = all.filter(card => card.sourceAnchor?.documentId === id && card.status !== 'deleted')
      .map(card => ({ card, ...A.resolve(text, card.sourceAnchor) }))
      .concat(updates.map(update => ({ card: all.find(card => card.id === update.cardId), ...A.resolve(text, update.anchor) })))
      .filter(item => item.card && item.index >= 0);
    // 同一段落的卡片合成一组（一个小标）。
    const byBlock = new Map();
    for (const item of resolved) {
      const [line] = quill.getLine(Math.min(item.index, quill.getLength() - 1));
      const key = line ? quill.getIndex(line) : item.index;
      if (!byBlock.has(key)) byBlock.set(key, { key, line, items: [] });
      byBlock.get(key).items.push(item);
    }
    groups = [...byBlock.values()].sort((a, b) => a.key - b.key);
    counts = new Map();
    for (const item of resolved) { const heading = A.headingAt(heads, item.index); if (heading) counts.set(heading, (counts.get(heading) || 0) + 1); }
    render();
    decorateOutline();
    if (popoverGroup !== null) { const group = groups.find(item => item.key === popoverGroup); if (group) openPopover(group); else closePopover(); }
  }
  const schedule = (delay = 250) => { if (timer) clearTimeout(timer); timer = setTimeout(compute, delay); };

  // ---------- 画：文字底色 + 段落小标 ----------
  function domRange(index, length) {
    try {
      const [startLeaf, startOffset] = quill.getLeaf(index);
      const [endLeaf, endOffset] = quill.getLeaf(index + length);
      if (!startLeaf?.domNode || !endLeaf?.domNode) return null;
      const range = document.createRange();
      const start = startLeaf.domNode.nodeType === 3 ? [startLeaf.domNode, startOffset] : [startLeaf.domNode, 0];
      const end = endLeaf.domNode.nodeType === 3 ? [endLeaf.domNode, endOffset] : [endLeaf.domNode, endLeaf.domNode.childNodes.length];
      range.setStart(...start); range.setEnd(...end);
      return range;
    } catch { return null; }
  }
  function render() {
    frame = null;
    layer.textContent = '';
    if (!groups.length || column.classList.contains('note-skim')) return;
    const parent = column.getBoundingClientRect(), scale = parent.width / column.offsetWidth || 1;
    const editor = root.getBoundingClientRect();
    for (const group of groups) {
      let first = null;
      const stale = group.items.some(item => item.status === 'stale');
      for (const item of group.items) {
        const range = domRange(item.index, item.length);
        for (const rect of range ? [...range.getClientRects()] : []) {
          if (!rect.width || !rect.height) continue;
          first ||= rect;
          const mark = document.createElement('span');
          mark.className = `note-card-mark${item.status === 'stale' ? ' is-stale' : ''}${flashId && item.card.id === flashId ? ' is-flash' : ''}`;
          mark.dataset.cardMark = item.card.id;
          mark.style.cssText = `left:${(rect.left - parent.left) / scale}px;top:${(rect.top - parent.top) / scale}px;width:${rect.width / scale}px;height:${rect.height / scale}px`;
          layer.append(mark);
        }
      }
      if (!first) continue;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = `note-card-badge${stale ? ' is-stale' : ''}`;
      badge.dataset.cardGroup = String(group.key);
      badge.setAttribute('aria-label', `这一段制过 ${group.items.length} 张卡${stale ? '，制卡后原文改过' : ''}`);
      badge.title = stale ? '制卡后这段改过' : `这一段制过 ${group.items.length} 张卡`;
      badge.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${stale ? '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>' : '<rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>'}</svg><span>${group.items.length}</span>`;
      badge.style.left = `${Math.max(2, (editor.left - parent.left) / scale - 40)}px`;
      badge.style.top = `${(first.top - parent.top) / scale + Math.max(0, (first.height - 22) / 2) / scale}px`;
      layer.append(badge);
    }
    if (popover) layer.append(popover), placePopover();
  }
  const scheduleRender = () => { if (frame === null) frame = requestAnimationFrame(render); };

  // ---------- 大纲：每节卡片数 ----------
  function decorateOutline() {
    const list = document.querySelector('#noteOutlineList');
    if (!list) return;
    list.querySelectorAll('.note-outline-cards').forEach(node => node.remove());
    if (!counts.size) return;
    for (const link of list.querySelectorAll('.note-outline-link')) {
      const count = counts.get(link.textContent.trim());
      if (!count) continue;
      const badge = document.createElement('span');
      badge.className = 'note-outline-cards';
      badge.title = `这一节制过 ${count} 张卡`;
      badge.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/></svg>${count}`;
      link.after(badge);
    }
  }
  const outline = document.querySelector('#noteOutlineList');
  const outlineObserver = outline ? new MutationObserver(mutations => { if (mutations.some(m => [...m.addedNodes].some(node => !node.classList?.contains('note-outline-cards')))) decorateOutline(); }) : null;
  outlineObserver?.observe(outline, { childList: true, subtree: true });

  // ---------- 点小标：这一段的卡片 ----------
  function stageOf(card) {
    const stage = shell()?.actions.cardStage?.(card) || (card.status === 'paused' ? 'paused' : 'learning');
    const next = shell()?.actions.cardDueLabel?.(card, stage) || '';
    return { stage, label: STAGE[stage] || stage, next };
  }
  function openPopover(group) {
    popoverGroup = group.key;
    popover?.remove();
    popover = document.createElement('div');
    popover.className = 'note-card-pop';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', '这一段的卡片');
    const stale = group.items.filter(item => item.status === 'stale');
    popover.innerHTML = `<p class="note-card-pop-head"><span>这一段做过 ${group.items.length} 张卡</span><button type="button" data-card-pop-close aria-label="关闭">×</button></p>
      ${stale.length ? '<p class="note-card-pop-warn">制卡后这段改过，卡片答案可能需要更新。</p>' : ''}
      ${group.items.map(item => { const s = stageOf(item.card); return `<div class="note-card-pop-item" data-card-id="${esc(item.card.id)}"><b>${esc(item.card.question || '（没有问题）')}</b><span class="meta"><span class="st ${s.stage}">${esc(s.label)}</span>${s.next ? `<span>下次 ${esc(s.next)}</span>` : ''}<span>复习过 ${Number(item.card.reviewCount) || 0} 次</span>${item.status === 'stale' ? '<span class="stale">原文改过</span>' : ''}</span>
        <span class="acts"><button type="button" data-card-open>打开卡片</button><button type="button" data-card-review>复习</button>${item.status === 'stale' ? '<button type="button" data-card-accept>按现在的原文记录</button>' : ''}<button type="button" class="ghost" data-card-unlink>去掉标记</button></span></div>`; }).join('')}
      <p class="note-card-pop-foot"><button type="button" data-card-again>＋ 再制一张</button></p>`;
    layer.append(popover);
    placePopover();
  }
  function placePopover() {
    if (!popover) return;
    const badge = layer.querySelector(`[data-card-group="${popoverGroup}"]`);
    if (!badge) return;
    popover.style.left = `${parseFloat(badge.style.left)}px`;
    popover.style.top = `${parseFloat(badge.style.top) + 28}px`;
  }
  function closePopover() { popover?.remove(); popover = null; popoverGroup = null; }

  layer.addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  layer.addEventListener('click', async event => {
    const badge = event.target.closest('[data-card-group]');
    if (badge) { const group = groups.find(item => String(item.key) === badge.dataset.cardGroup); if (popoverGroup === group?.key) closePopover(); else if (group) openPopover(group); return; }
    if (event.target.closest('[data-card-pop-close]')) { closePopover(); return; }
    const group = groups.find(item => item.key === popoverGroup);
    if (event.target.closest('[data-card-again]') && group) {
      const first = group.items[0];
      const text = A.textOf(quill.getContents()).slice(first.index, first.index + first.length);
      closePopover(); createCard(text, { index: first.index, length: first.length }); return;
    }
    const row = event.target.closest('[data-card-id]');
    const item = group?.items.find(entry => entry.card.id === row?.dataset.cardId);
    if (!item) return;
    if (event.target.closest('[data-card-open]')) { closePopover(); openCard(item.card.id); }
    else if (event.target.closest('[data-card-review]')) { closePopover(); reviewCard(item.card.id); }
    else if (event.target.closest('[data-card-unlink]')) { await saveAnchors([{ cardId: item.card.id, anchor: null }]); closePopover(); schedule(0); }
    else if (event.target.closest('[data-card-accept]')) {
      const text = A.textOf(quill.getContents());
      const anchor = A.create(text, item.index, item.length, { documentId: documentId(), heading: A.headingAt(headings(), item.index), now: item.card.sourceAnchor?.createdAt });
      await saveAnchors([{ cardId: item.card.id, anchor }]); schedule(0);
    }
  });
  const onDocumentDown = event => { if (popover && !event.target.closest?.('.note-card-pop, [data-card-group]')) closePopover(); };
  const onKey = event => { if (event.key === 'Escape' && popover) { event.preventDefault(); event.stopPropagation(); closePopover(); } };
  document.addEventListener('pointerdown', onDocumentDown, true);
  document.addEventListener('keydown', onKey, true);

  // ---------- 对外：重叠检查、定位 ----------
  function overlapping(range) {
    if (!range || !range.length) return [];
    return resolved.filter(item => A.overlaps(item, range)).map(item => item.card);
  }
  function focusCard(cardId) {
    const item = resolved.find(entry => entry.card.id === cardId);
    if (!item) return false;
    const [line] = quill.getLine(item.index);
    line?.domNode?.scrollIntoView?.({ block: 'center' });
    flashId = cardId;
    scheduleRender();
    setTimeout(() => { flashId = null; scheduleRender(); }, 1600);
    return true;
  }
  function openGroupFor(cards) {
    const ids = new Set(cards.map(card => card.id));
    const group = groups.find(entry => entry.items.some(item => ids.has(item.card.id)));
    if (group) { group.line?.domNode?.scrollIntoView?.({ block: 'nearest' }); openPopover(group); }
  }

  // ---------- 何时重算 ----------
  const onText = (type, _delta, _old, source) => { if (type === 'text-change') { closePopover(); schedule(source === 'user' ? 300 : 60); } };
  quill.on('editor-change', onText);
  const resize = new ResizeObserver(scheduleRender);
  resize.observe(root);
  window.addEventListener('resize', scheduleRender);
  // 卡片数据变了（新建、删除、复习后）就重算；只比较引用，很便宜。
  const poll = setInterval(() => { if (!disposed && cards() !== lastData) schedule(0); }, 1000);
  const onSkim = new MutationObserver(scheduleRender);
  onSkim.observe(column, { attributes: true, attributeFilter: ['class'] });
  schedule(30);

  const api = { refresh: () => schedule(0), overlapping, focusCard, openGroupFor, get count() { return resolved.length; },
    dispose() {
      disposed = true; clearTimeout(timer); clearInterval(poll); if (frame) cancelAnimationFrame(frame);
      quill.off('editor-change', onText); resize.disconnect(); onSkim.disconnect(); outlineObserver?.disconnect();
      window.removeEventListener('resize', scheduleRender);
      document.removeEventListener('pointerdown', onDocumentDown, true); document.removeEventListener('keydown', onKey, true);
      layer.remove(); document.querySelectorAll('#noteOutlineList .note-outline-cards').forEach(node => node.remove());
      if (window.MemoKeepNoteCardMarks === api) window.MemoKeepNoteCardMarks = null;
    } };
  window.MemoKeepNoteCardMarks = api;
  return api;
}

// 卡片详情「定位到原文」：打开来源笔记，滚到那一段并闪一下。
window.MemoKeepLocateCardSource = async function locateCardSource(card) {
  const shell = typeof applicationShell !== 'undefined' ? applicationShell : null;
  const documentId = card?.sourceAnchor?.documentId;
  const target = documentId && shell?.actions.documentById?.(documentId);
  if (!target) return false;
  await shell.actions.openMarkdownNoteEditor(target);
  for (let i = 0; i < 40; i++) {
    const marks = window.MemoKeepNoteCardMarks;
    if (marks?.focusCard(card.id)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

// 笔记「更多」里的「显示制卡标记」开关（settings.noteCardMarks，默认打开）。
(function bindNoteCardMarksToggle() {
  const shell = () => (typeof applicationShell !== 'undefined' ? applicationShell : null);
  const on = () => shell()?.state.persistence.data?.settings?.noteCardMarks !== false;
  const sync = () => document.querySelectorAll('#noteCardMarksToggle').forEach(button => { button.setAttribute('aria-checked', String(on())); button.classList.toggle('is-off', !on()); });
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('#noteCardMarksToggle');
    if (!button || typeof application === 'undefined') return;
    event.preventDefault();
    const next = !on();
    await application.persistence.transact(data => { data.settings.noteCardMarks = next; }).catch(() => {});
    sync();
    window.MemoKeepNoteCardMarks?.refresh();
  });
  new MutationObserver(() => { if (document.querySelector('#noteCardMarksToggle:not([data-synced])')) { document.querySelectorAll('#noteCardMarksToggle').forEach(node => { node.dataset.synced = ''; }); sync(); } })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
