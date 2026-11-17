// Keep folding UI and visibility rules outside Quill so saved HTML and undo stay intact.
function bindNoteHeadingFold(quill, column, onLayout = () => {}) {
  const root = quill.root;
  const collapsed = new WeakSet();
  const buttons = new Map();
  const layer = document.createElement('div');
  layer.className = 'note-heading-fold-layer';
  const style = document.createElement('style');
  column.append(layer, style);
  let sections = [], frame = null;
  const levelOf = node => /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
  const position = () => {
    frame = null;
    const parent = column.getBoundingClientRect();
    const scale = parent.width / column.offsetWidth || 1;
    // Measure all headings before moving controls; interleaving forces layout per heading.
    const positions = [...buttons].map(([heading, button]) => {
      const rect = heading.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(heading).lineHeight);
      return { button, hidden: !rect.height || !rect.width,
        left: `${(rect.left - parent.left) / scale - 28}px`,
        top: `${(rect.top - parent.top) / scale + Math.max(0, (lineHeight - 24) / 2)}px` };
    });
    for (const { button, hidden, left, top } of positions) {
      if (button.hidden !== hidden) button.hidden = hidden;
      if (button.style.left !== left) button.style.left = left;
      if (button.style.top !== top) button.style.top = top;
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(position); };
  const refresh = () => {
    const blocks = [...root.children];
    sections = blocks.flatMap((heading, start) => {
      const level = levelOf(heading);
      if (!level) return [];
      let end = start + 1;
      while (end < blocks.length && (!levelOf(blocks[end]) || levelOf(blocks[end]) > level)) end++;
      return [{ heading, start, end }];
    });
    const hidden = new Set();
    for (const { heading, start, end } of sections) {
      if (collapsed.has(heading)) for (let i = start + 1; i < end; i++) hidden.add(i + 1);
    }
    style.textContent = [...hidden].map(index => `#noteRichEditor > .ql-editor > :nth-child(${index}) { display: none !important; }`).join('\n');
    const retained = new Set();
    let previousButton = null;
    for (const { heading, start, end } of sections) {
      if (end === start + 1) continue;
      retained.add(heading);
      let button = buttons.get(heading);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'note-heading-toggle';
        button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => {
          if (collapsed.has(heading)) collapsed.delete(heading);
          else {
            // Move a selection out of the section before hiding it.
            const range = quill.getSelection();
            const section = sections.find(item => item.heading === heading);
            const first = Quill.find(heading);
            const last = root.children[section?.end];
            const from = quill.getIndex(first) + first.length();
            const to = last ? quill.getIndex(Quill.find(last)) : quill.getLength();
            if (range && range.index < to && range.index + range.length >= from) {
              quill.setSelection(quill.getIndex(first), 0, 'silent');
            }
            collapsed.add(heading);
          }
          refresh();
        });
        buttons.set(heading, button);
      }
      const folded = collapsed.has(heading);
      const label = `${folded ? '展开' : '收起'}「${heading.textContent.trim() || '空标题'}」的内容`;
      button.setAttribute('aria-expanded', String(!folded));
      button.setAttribute('aria-label', label);
      button.title = label;
      const expected = previousButton ? previousButton.nextSibling : layer.firstChild;
      if (expected !== button) layer.insertBefore(button, expected);
      previousButton = button;
    }
    for (const [heading, button] of buttons) if (!retained.has(heading)) { button.remove(); buttons.delete(heading); }
    position();
    onLayout();
  };
  const revealSelection = (range, includeHeading = false) => {
    if (!range) return;
    let changed = false;
    for (const { heading, end } of sections) {
      if (!collapsed.has(heading)) continue;
      const blot = Quill.find(heading);
      const from = quill.getIndex(blot) + (includeHeading ? 0 : blot.length());
      const next = root.children[end];
      const to = next ? quill.getIndex(Quill.find(next)) : quill.getLength();
      if (range.index < to && range.index + range.length >= from) { collapsed.delete(heading); changed = true; }
    }
    if (changed) refresh();
  };
  const onChange = (type, range) => {
    if (type === 'text-change') refresh();
    // History restores its final selection after transforming the document.
    if (type === 'selection-change' && !quill.history.ignoreChange) revealSelection(range);
  };
  const beforeInput = event => {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') revealSelection(quill.getSelection(), true);
  };
  const onKeyDown = event => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      || quill.selection.composing || !quill.isEnabled()) return;
    const range = quill.getSelection();
    if (!range || range.length) return;
    const [line, offset] = quill.getLine(range.index);
    const heading = line?.domNode;
    if (!collapsed.has(heading) || offset !== line.length() - 1) return;
    const section = sections.find(item => item.heading === heading);
    if (!section) return;
    const next = root.children[section.end];
    const index = next ? quill.getIndex(Quill.find(next)) : quill.getLength();
    const Delta = Quill.import('delta');
    event.preventDefault();
    event.stopImmediatePropagation();
    quill.history.cutoff();
    // A sibling heading ends the folded range without exposing or changing its contents.
    quill.updateContents(new Delta().retain(index).insert('\n', { header: levelOf(heading) }), 'user');
    quill.setSelection(index, 0, 'user');
    quill.history.cutoff();
    quill.scrollSelectionIntoView();
  };
  quill.on('editor-change', onChange);
  // 折叠箭头只在鼠标停在标题上时显示（已折叠的始终显示），和「写要点」一致。
  let hoverButton = null;
  const setHover = button => { if (hoverButton === button) return; hoverButton?.classList.remove('is-hover'); hoverButton = button; button?.classList.add('is-hover'); };
  const onHover = event => {
    let node = event.target instanceof Element ? event.target : null;
    while (node && node.parentElement !== root) node = node.parentElement;
    setHover(node && buttons.get(node) || null);
  };
  const onLeave = event => { if (!event.relatedTarget?.closest?.('.note-heading-toggle')) setHover(null); };
  root.addEventListener('mouseover', onHover);
  root.addEventListener('mouseleave', onLeave);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('beforeinput', beforeInput, true);
  const observer = new ResizeObserver(schedule);
  observer.observe(column);
  observer.observe(root);
  window.addEventListener('resize', schedule);
  refresh();
  return () => {
    quill.off('editor-change', onChange);
    root.removeEventListener('mouseover', onHover);
    root.removeEventListener('mouseleave', onLeave);
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('beforeinput', beforeInput, true);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    layer.remove();
    style.remove();
  };
}
