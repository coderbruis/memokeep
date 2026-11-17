(function expose(host) {
  function mount({ root, quill, textarea, isCurrent }) {
    const document = root.ownerDocument, view = root.closest('.view');
    const controller = new AbortController(), { signal } = controller;
    const listen = (node, type, handler, options = {}) => node?.addEventListener(type, handler, { ...options, signal });
    const button = document.createElement('button');
    button.id = 'noteFindButton'; button.type = 'button'; button.className = 'note-toolbar-icon-button';
    button.setAttribute('aria-label', '查找笔记内容');
    button.setAttribute('aria-controls', 'noteFindBar'); button.setAttribute('aria-expanded', 'false');
    button.title = `查找笔记内容（${host.MemoKeepShortcuts.isMac ? '⌘ F' : 'Ctrl F'}）`;
    button.innerHTML = '<svg aria-hidden="true"><use href="#icon-search"></use></svg>';
    const editorToolbar = root.dataset.editorMode === 'note' ? root.querySelector('#noteRichToolbar') : root.querySelector('.note-editor-toolbar');
    const toolbar = editorToolbar.querySelector('.note-toolbar-actions') || editorToolbar;
    const more = toolbar.querySelector('.note-tab-more-control');
    toolbar.insertBefore(button, more);
    const bar = document.createElement('div');
    bar.id = 'noteFindBar'; bar.className = 'note-find-bar'; bar.hidden = true;
    bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', '笔记内查找');
    bar.innerHTML = `<svg class="note-find-icon" aria-hidden="true"><use href="#icon-search"></use></svg>
      <input id="noteFindInput" type="search" aria-label="查找笔记内容" placeholder="在当前笔记中查找" autocomplete="off" spellcheck="false" aria-describedby="noteFindCount">
      <span id="noteFindCount" role="status" aria-live="polite" aria-atomic="true"></span>
      <button id="noteFindPrevious" type="button" aria-label="上一个匹配" title="上一个匹配（Shift + Enter）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
      <button id="noteFindNext" type="button" aria-label="下一个匹配" title="下一个匹配（Enter）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <button id="noteFindClose" type="button" aria-label="关闭查找" title="关闭查找（Esc）"><svg aria-hidden="true"><use href="#icon-x"></use></svg></button>`;
    root.append(bar);
    const input = bar.querySelector('input'), count = bar.querySelector('#noteFindCount');
    const previous = bar.querySelector('#noteFindPrevious'), next = bar.querySelector('#noteFindNext');
    let matches = [], active = -1, frame = null, restoreRange = null;
    const text = () => quill ? quill.getContents().ops.map(op => typeof op.insert === 'string' ? op.insert : '\ufffc').join('') : textarea.value;
    const clearHighlights = () => {
      host.CSS?.highlights?.delete('note-find-matches');
      host.CSS?.highlights?.delete('note-find-active');
    };
    const domRange = match => {
      const [startLeaf, startOffset] = quill.getLeaf(match.index);
      const [endLeaf, endOffset] = quill.getLeaf(match.index + match.length);
      if (!startLeaf || !endLeaf) return null;
      const [startNode, start] = startLeaf.position(startOffset, false);
      const [endNode, end] = endLeaf.position(endOffset, true);
      const range = document.createRange();
      range.setStart(startNode, start); range.setEnd(endNode, end);
      return range;
    };
    const paint = () => {
      clearHighlights();
      if (!quill || !host.CSS?.highlights || !host.Highlight) return;
      // Native highlights leave Quill's DOM, saved HTML and undo history untouched.
      const all = new host.Highlight();
      for (const match of matches) { const range = domRange(match); if (range) all.add(range); }
      host.CSS.highlights.set('note-find-matches', all);
      if (matches[active]) {
        const range = domRange(matches[active]);
        if (range) { const current = new host.Highlight(range); current.priority = 1; host.CSS.highlights.set('note-find-active', current); }
      }
    };
    const position = () => {
      if (bar.hidden || !view) return;
      const bounds = view.getBoundingClientRect();
      const tabs = document.querySelector('#noteTabsBar');
      const toolbar = quill ? root.querySelector('#noteRichToolbar') : root.querySelector('.note-editor-toolbar');
      const bottom = element => element?.getClientRects().length ? element.getBoundingClientRect().bottom : bounds.top;
      bar.style.top = `${Math.max(bounds.top, bottom(tabs), bottom(toolbar)) + 8}px`;
      bar.style.right = `${Math.max(12, host.innerWidth - bounds.right + 16)}px`;
      bar.style.width = `${Math.min(430, bounds.width - 24)}px`;
    };
    const scrollToRect = rect => {
      if (!rect || !view) return;
      const bounds = view.getBoundingClientRect();
      const top = Math.max(bounds.top, bar.getBoundingClientRect().bottom) + 16;
      const bottom = Math.min(bounds.bottom, host.innerHeight) - 64;
      if (rect.top < top || rect.bottom > bottom) view.scrollTop += rect.top - (top + bottom - rect.height) / 2;
    };
    const textareaRect = match => {
      const mirror = document.createElement('div'), style = host.getComputedStyle(textarea);
      mirror.className = 'note-find-text-mirror'; mirror.setAttribute('aria-hidden', 'true');
      for (const property of ['font', 'letterSpacing', 'lineHeight', 'padding', 'borderWidth', 'boxSizing', 'tabSize', 'wordBreak', 'overflowWrap', 'textIndent', 'textTransform']) mirror.style[property] = style[property];
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.whiteSpace = textarea.wrap === 'off' ? 'pre' : 'pre-wrap';
      mirror.textContent = textarea.value.slice(0, match.index);
      const marker = document.createElement('span'); marker.textContent = textarea.value.slice(match.index, match.index + match.length);
      mirror.append(marker, document.createTextNode(textarea.value.slice(match.index + match.length) || '\u200b'));
      document.body.append(mirror);
      const top = marker.offsetTop, left = marker.offsetLeft, height = marker.offsetHeight || parseFloat(style.lineHeight);
      const width = marker.getBoundingClientRect().width;
      if (top < textarea.scrollTop || top + height > textarea.scrollTop + textarea.clientHeight) textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
      if (left < textarea.scrollLeft || left + width > textarea.scrollLeft + textarea.clientWidth) textarea.scrollLeft = Math.max(0, left - textarea.clientWidth / 2);
      const bounds = textarea.getBoundingClientRect();
      mirror.remove();
      return { top: bounds.top + top - textarea.scrollTop, bottom: bounds.top + top - textarea.scrollTop + height, height };
    };
    const updateStatus = () => {
      count.textContent = !input.value ? '' : matches.length ? `${active + 1} / ${matches.length}` : '无匹配结果';
      previous.disabled = next.disabled = !matches.length;
      bar.classList.toggle('has-no-results', Boolean(input.value) && !matches.length);
    };
    const showMatch = () => {
      const match = matches[active];
      updateStatus();
      if (!match) { paint(); return; }
      const focused = document.activeElement, selection = [input.selectionStart, input.selectionEnd];
      let rect;
      if (quill) {
        // A silent selection reveals folded headings without applying formatting tools.
        quill.setSelection(match.index, match.length, 'silent');
        rect = domRange(match)?.getBoundingClientRect();
      } else {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(match.index, match.index + match.length);
        rect = textareaRect(match);
      }
      focused?.focus({ preventScroll: true });
      if (focused === input) input.setSelectionRange(...selection);
      paint(); position(); scrollToRect(rect);
    };
    const refresh = (navigate = false) => {
      if (bar.hidden || !isCurrent()) return;
      const oldIndex = matches[active]?.index;
      matches = [];
      if (input.value) {
        const pattern = new RegExp(input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        for (const match of text().matchAll(pattern)) matches.push({ index: match.index, length: match[0].length });
      }
      active = matches.length ? Math.max(0, matches.findIndex(match => match.index >= (navigate ? 0 : oldIndex ?? 0))) : -1;
      if (navigate) showMatch(); else { updateStatus(); paint(); }
    };
    const move = delta => {
      if (!matches.length) return;
      active = (active + delta + matches.length) % matches.length;
      showMatch();
    };
    const close = (restore = true) => {
      if (bar.hidden) return;
      bar.hidden = true; button.setAttribute('aria-expanded', 'false'); clearHighlights();
      if (restore && isCurrent()) {
        const match = matches[active] || restoreRange;
        if (quill) { if (match) quill.setSelection(match.index, match.length, 'silent'); else quill.focus(); }
        else { textarea.focus({ preventScroll: true }); if (match) textarea.setSelectionRange(match.index, match.index + match.length); }
      }
    };
    const open = () => {
      if (bar.hidden) {
        restoreRange = quill ? quill.getSelection() : { index: textarea.selectionStart, length: textarea.selectionEnd - textarea.selectionStart };
        const selected = restoreRange?.length ? text().slice(restoreRange.index, restoreRange.index + restoreRange.length) : '';
        if (selected && selected.length <= 500 && !/[\r\n]/.test(selected)) input.value = selected;
      }
      bar.hidden = false; button.setAttribute('aria-expanded', 'true'); position();
      input.focus({ preventScroll: true }); input.select(); refresh(true);
    };
    const schedule = () => {
      if (bar.hidden || frame !== null) return;
      frame = host.requestAnimationFrame(() => { frame = null; refresh(); position(); });
    };
    listen(button, 'mousedown', event => event.preventDefault());
    listen(button, 'click', open);
    listen(input, 'input', event => { if (!event.isComposing) refresh(true); });
    listen(input, 'compositionend', () => refresh(true));
    listen(previous, 'click', () => move(-1)); listen(next, 'click', () => move(1));
    listen(bar.querySelector('#noteFindClose'), 'click', () => close());
    listen(document, 'keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !isCurrent() || !root.isConnected
        || view?.classList.contains('hidden') || document.querySelector('dialog[open], [aria-modal="true"]:not(.hidden)')) return;
      const primary = host.MemoKeepShortcuts.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (primary && !event.shiftKey && !event.altKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f')) {
        event.preventDefault(); event.stopImmediatePropagation(); open(); return;
      }
      if (bar.hidden || !root.contains(event.target) && !bar.contains(event.target) && !button.contains(event.target)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Enter' && bar.contains(event.target) && event.target === input && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); move(event.shiftKey ? -1 : 1);
      }
    }, { capture: true });
    if (quill) quill.on('text-change', schedule);
    else listen(textarea, 'input', schedule);
    listen(root, 'click', schedule);
    listen(view, 'scroll', position, { passive: true }); listen(host, 'resize', schedule);
    return () => {
      close(false); controller.abort();
      if (quill) quill.off('text-change', schedule);
      if (frame !== null) host.cancelAnimationFrame(frame);
      button.remove(); bar.remove();
    };
  }
  host.MemoKeepNoteFind = { mount };
})(globalThis);
