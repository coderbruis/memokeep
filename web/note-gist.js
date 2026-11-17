// 要点块和速览（design/prototype/knowledge-skim-20261109.md）。
// 要点块 = 标题下面紧跟的一组引用行，第一行是 [!要点]（也认 [!summary]）。和标题折叠一样，
// 只在 Quill 外面加样式和按钮，保存的内容、撤销历史都不变。
const NOTE_GIST_MARKER = /^\s*\[!(要点|summary)\]\s*$/i;
// 要点第一行写「题目：……」就是复习时的题目，没写用标题（design/prototype/gist-question-20261113.md）；和 web/domain/knowledge-points.js 同一条规则。
const NOTE_GIST_QUESTION = /^\s*题目\s*[:：]\s*(.*)$/;
const NOTE_GIST_STYLE_KEY = 'memokeep-gist-style';
function noteGistStyle() {
  try { return ['tint', 'line', 'paper', 'plain'].includes(localStorage.getItem(NOTE_GIST_STYLE_KEY)) ? localStorage.getItem(NOTE_GIST_STYLE_KEY) : 'tint'; } catch { return 'tint'; }
}
function setNoteGistStyle(value) {
  try { localStorage.setItem(NOTE_GIST_STYLE_KEY, value); } catch { /* 只影响这台电脑上的显示 */ }
  document.documentElement.dataset.gistStyle = noteGistStyle();
}
if (typeof document !== 'undefined') document.documentElement.dataset.gistStyle = noteGistStyle();
function bindNoteGist(quill, column, { onLayout = () => {} } = {}) {
  const root = quill.root;
  const layer = document.createElement('div');
  layer.className = 'note-gist-layer';
  const style = document.createElement('style'), gapStyle = document.createElement('style');
  column.append(layer, style, gapStyle);
  const currentDocumentId = () => column.closest('form')?.dataset.documentId || document.querySelector('#inlineMarkdownNoteForm')?.dataset.documentId || '';
  // applicationShell 是顶层 const，不在 window 上。
  const shell = () => (typeof applicationShell !== 'undefined' ? applicationShell : window.applicationShell)?.actions;
  const levelOf = node => /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
  const isQuote = node => node?.tagName === 'BLOCKQUOTE';
  const sel = index => `#noteRichEditor > .ql-editor > :nth-child(${index + 1})`;
  const expanded = new WeakSet();
  // 全文模式下「只收起详细、保留要点」的段落。
  const folded = new WeakSet();
  let skim = false, sections = [], frame = null, wasEnabled = true;
  const buttons = new Map();

  // 每个标题段落：要点块位置（紧跟标题、跳过空行）和段落范围。
  function scan() {
    const blocks = [...root.children];
    const result = [];
    blocks.forEach((heading, start) => {
      const level = levelOf(heading);
      if (!level) return;
      let end = start + 1;
      while (end < blocks.length && (!levelOf(blocks[end]) || levelOf(blocks[end]) > level)) end++;
      let first = start + 1;
      while (first < end && !blocks[first].textContent.trim() && !isQuote(blocks[first]) && !blocks[first].querySelector('img')) first++;
      let gist = null;
      if (first < end && isQuote(blocks[first]) && NOTE_GIST_MARKER.test(blocks[first].textContent)) {
        let last = first;
        while (last + 1 < end && isQuote(blocks[last + 1])) last++;
        gist = { marker: first, from: first + 1, to: last, question: -1, title: '', lines: 0 };
        for (let i = gist.from; i <= last; i++) {
          const value = blocks[i].textContent;
          if (!value.trim()) continue;
          const own = gist.question < 0 && !gist.lines && NOTE_GIST_QUESTION.exec(value);
          if (own) { gist.question = i; gist.title = own[1].trim(); } else gist.lines++;
        }
      }
      result.push({ heading, level, start, end, gist });
    });
    // 和 web/domain/knowledge-points.js 一样的键：笔记 id + 标题（同名标题加序号），只算有内容的要点。
    const documentId = currentDocumentId(), seen = new Map();
    for (const section of result) {
      if (!section.gist || !documentId) continue;
      if (!section.gist.lines) continue;
      const name = section.heading.textContent.replace(/\s+/g, ' ').trim();
      const count = (seen.get(name) || 0) + 1; seen.set(name, count);
      section.key = `${documentId}#${name}${count > 1 ? `#${count}` : ''}`;
    }
    return result;
  }

  function refresh() {
    sections = scan();
    const rules = [];
    for (const { gist } of sections) {
      if (!gist) continue;
      rules.push(`${sel(gist.marker)} { font-size: 0 !important; line-height: 0 !important; padding: 10px 14px 0 !important; margin: 10px 0 0 !important; border-radius: var(--gist-radius) var(--gist-radius) 0 0; }`);
      rules.push(`${sel(gist.marker)}::before { content: "要点"; position: static; display: block; width: auto; border-radius: 0; background: none; font-size: 12px; line-height: 18px; font-weight: 650; color: var(--gist-ink); }`);
      // 普通引用左边那条竖线是 blockquote::before 画的（enhancements.css）；要点块有自己的左边线，要点里的每一行都不要它。
      for (let i = gist.from; i <= gist.to; i++) rules.push(`${sel(i)}::before { content: none; }`);
      for (let i = gist.marker; i <= gist.to; i++) rules.push(`${sel(i)} { background: var(--gist-bg) !important; border: 0 !important; border-left: var(--gist-rule) solid var(--gist-line) !important; box-shadow: none !important; color: var(--ink) !important; font-style: normal !important; margin-top: 0 !important; margin-bottom: 0 !important; padding: 3px 14px !important; line-height: 1.7 !important; }`);
      rules.push(`${sel(gist.to)} { padding-bottom: 10px !important; margin-bottom: 10px !important; border-radius: 0 0 var(--gist-radius) var(--gist-radius); }`);
      if (gist.to === gist.marker) rules.push(`${sel(gist.marker)} { border-radius: var(--gist-radius); }`);
      // 题目行整行用题目色；颜色写在文字上的（用户自己设的）不覆盖。
      if (gist.question >= 0) rules.push(`${sel(gist.question)} { color: var(--gist-question) !important; font-weight: 650 !important; }`);
      // 空要点：灰字提示写法。输入法组字时文字还没进 Quill，先不显示，免得叠在一起。
      else if (!gist.lines && gist.to > gist.marker && !skim && !composing && quill.isEnabled()) rules.push(`${sel(gist.from)}::before { content: "写下要点；想自己出题，第一行写「题目：……」"; position: absolute; inset: 3px auto auto 14px; width: auto; border-radius: 0; background: none; color: color-mix(in srgb, var(--muted) 70%, transparent); font-weight: 400; pointer-events: none; }`);
    }
    if (!skim) {
      for (const { heading, gist, end } of sections) if (gist && folded.has(heading)) for (let i = gist.to + 1; i < end; i++) rules.push(`${sel(i)} { display: none !important; }`);
    }
    if (skim) {
      const blocks = root.children.length;
      const keep = new Set();
      // 第一个标题之前的内容（开头说明）在速览里也隐藏，只留结构和要点。
      sections.forEach(({ heading, start, end, gist }) => {
        keep.add(start);
        if (expanded.has(heading)) for (let i = start; i < end; i++) keep.add(i);
        else if (gist) for (let i = gist.marker; i <= gist.to; i++) keep.add(i);
      });
      // 嵌套标题：展开外层时，内层整段也展开。
      for (let i = 0; i < blocks; i++) if (!keep.has(i)) rules.push(`${sel(i)} { display: none !important; }`);
    }
    style.textContent = rules.join('\n');
    column.classList.toggle('note-skim', skim);
    renderButtons();
    position();
    onLayout();
    const count = sections.filter(item => item.gist).length;
    paintSkimButton(count);
    paintDetailsAll();
    paintBatch();
    window.dispatchEvent(new CustomEvent('memokeep-note-gists', { detail: { count, skim } }));
  }
  // 笔记顶栏的「速览」按钮可能比这里先或后挂上，两边都会刷新它。
  function paintSkimButton(count) {
    const button = document.querySelector('#noteSkimButton');
    if (!button) return;
    button.hidden = !count && !skim;
    button.setAttribute('aria-pressed', String(skim));
    const label = button.querySelector('span');
    if (label) label.textContent = skim ? '全文' : '速览';
    button.title = skim ? '回到全文（⌘⇧E）' : `只看 ${count} 个要点（⌘⇧E）`;
  }

  // 一键收起 / 展开所有要点下面的详细内容：全文模式管「收起详细」，速览模式管「看详细」。
  const withDetails = () => sections.filter(({ gist, end }) => gist && end - 1 > gist.to);
  function detailsOpen() {
    const list = withDetails();
    return skim ? list.some(({ heading }) => expanded.has(heading)) : list.some(({ heading }) => !folded.has(heading));
  }
  function paintDetailsAll() {
    const button = document.querySelector('#noteGistDetailsAll');
    if (!button) return;
    const list = withDetails();
    button.hidden = !list.length;
    const open = detailsOpen();
    button.setAttribute('aria-pressed', String(!open));
    const label = button.querySelector('span');
    if (label) label.textContent = open ? '收起全部详细' : '展开全部详细';
    button.title = open ? `只留要点，把 ${list.length} 处详细内容都收起来` : `展开 ${list.length} 处要点下面的详细内容`;
  }
  function toggleDetailsAll() {
    const list = withDetails();
    if (!list.length) return;
    const open = detailsOpen();
    if (skim) {
      for (const { heading } of list) open ? expanded.delete(heading) : expanded.add(heading);
      refresh();
      return;
    }
    if (!open) { for (const { heading } of list) folded.delete(heading); refresh(); return; }
    // 收起前：光标在要收起的内容里时，先移到那一节的要点上（否则会马上自动展开）。
    const range = quill.getSelection();
    for (const section of list) {
      const first = root.children[section.gist.to + 1], next = root.children[section.end];
      if (range && first) {
        const from = quill.getIndex(Quill.find(first)), to = next ? quill.getIndex(Quill.find(next)) : quill.getLength();
        if (range.index + range.length >= from && range.index < to) quill.setSelection(Math.max(0, from - 1), 0, 'silent');
      }
      folded.add(section.heading);
    }
    refresh();
  }

  function makeButton(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `note-gist-button ${kind}`;
    button.addEventListener('mousedown', event => event.preventDefault());
    return button;
  }
  const icons = {
    write: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    style: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="6" r="1.4"/><circle cx="8.5" cy="4.5" r="1.4"/><circle cx="11.5" cy="7" r="1.4"/><path d="M8 14a6 6 0 1 1 6-6c0 1.7-1.3 2.4-2.6 2.4H10a1.4 1.4 0 0 0-1 2.4c.3.4.1 1.2-1 1.2z"/></svg>',
    delete: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
    ask: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2M8 11.3h.01"/></svg>',
  };
  // 每个标题段落可能有几个按钮：速览「看详细」；编辑时有要点 →「收起详细 / 样式 / 删除」，没有 →「写要点」。
  function renderButtons() {
    const wanted = new Map();
    for (const section of sections) {
      const { heading, gist, end } = section;
      const kinds = [];
      // 要点上的「加入复习 / 复习中 / 已暂停」一直显示（速览时也显示）。
      if (gist && section.key && shell()?.pointStatus) kinds.push('review');
      if (skim) { if (gist && end - 1 > gist.to) kinds.push('detail'); }
      else if (gist) {
        if (quill.isEnabled()) kinds.push('delete', 'style');
        if (end - 1 > gist.to) kinds.push('fold');
        // 还没写题目：右上角「写题目」；有内容时在「要点」后面说明现在用的是标题。
        if (quill.isEnabled() && gist.question < 0) { kinds.push('ask'); if (gist.lines) kinds.push('hint'); }
      }
      // 一级标题通常是整篇的题目，只给二到四级标题加「写要点」。
      else if (quill.isEnabled() && section.level >= 2 && section.level <= 4 && heading.textContent.trim()) kinds.push('write');
      for (const kind of kinds) wanted.set(`${kind}`, wanted.get(kind) || []), wanted.get(kind).push(section);
    }
    const retained = new Set();
    for (const [kind, list] of wanted) for (const section of list) {
      const { heading, gist, end } = section;
      const key = `${kind}`;
      let group = buttons.get(heading);
      if (!group) { group = new Map(); buttons.set(heading, group); }
      let entry = group.get(key);
      if (!entry) {
        const button = kind === 'hint' ? Object.assign(document.createElement('span'), { className: 'note-gist-button hint', textContent: '题目用标题' }) : makeButton(kind);
        button.addEventListener('click', event => act(kind, heading, event));
        button.addEventListener('mouseenter', () => setHover(heading));
        button.addEventListener('mouseleave', () => setHover(null));
        layer.append(button);
        entry = { kind, button, heading };
        group.set(key, entry);
      }
      retained.add(entry);
      const name = heading.textContent.trim() || '这个标题';
      if (kind === 'detail') {
        const open = expanded.has(heading), hidden = end - 1 - gist.to;
        entry.button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg><span>${open ? '收起' : '看详细'}</span><small>${open ? '' : `· ${hidden} 段`}</small>`;
        entry.button.setAttribute('aria-expanded', String(open));
        entry.button.title = `${open ? '收起' : '展开'}「${name}」的详细内容`;
        entry.anchor = () => root.children[open ? end - 1 : gist.to];
      } else if (kind === 'fold') {
        const closed = folded.has(heading), hidden = end - 1 - gist.to;
        entry.button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${closed ? 'm6 4 4 4-4 4' : 'm4 6 4 4 4-4'}"/></svg><span>${closed ? `展开详细 · ${hidden} 段` : '收起详细'}</span>`;
        entry.button.setAttribute('aria-expanded', String(!closed));
        entry.button.classList.toggle('is-closed', closed);
        entry.button.title = closed ? '显示要点下面的详细内容' : '只留要点，把下面的详细内容收起来';
        entry.anchor = () => root.children[gist.marker];
      } else if (kind === 'review') {
        const info = shell().pointStatus(section.key);
        entry.key = section.key;
        entry.button.dataset.state = info.status;
        entry.button.innerHTML = info.status === 'on' ? `<i class="dot"></i><span>复习中${info.due ? ` · ${info.due}` : ''}</span>`
          : info.status === 'paused' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4v8M10 4v8"/></svg><span>已暂停</span>'
          : `${icons.write}<span>加入复习</span>`;
        entry.button.setAttribute('aria-haspopup', info.status === 'off' ? 'false' : 'dialog');
        entry.button.title = info.status === 'off' ? '把这个要点加入复习：和卡片一起，按遗忘规律安排' : info.status === 'on' ? '查看复习情况' : '已暂停复习，点开可以恢复';
        entry.anchor = () => root.children[gist.marker];
      } else if (kind === 'style') {
        entry.button.innerHTML = icons.style;
        entry.button.setAttribute('aria-label', '要点样式');
        entry.button.setAttribute('aria-haspopup', 'menu');
        entry.button.dataset.tooltip = '要点样式';
        entry.anchor = () => root.children[gist.marker];
      } else if (kind === 'ask') {
        entry.button.innerHTML = `${icons.ask}<span>写题目</span>`;
        entry.button.title = `现在复习时用标题「${name}」当题目；点一下在第一行写自己的题目`;
        entry.anchor = () => root.children[gist.marker];
      } else if (kind === 'hint') {
        entry.anchor = () => root.children[gist.marker];
      } else if (kind === 'delete') {
        entry.button.innerHTML = icons.delete;
        entry.button.setAttribute('aria-label', `删除「${name}」的要点`);
        entry.button.dataset.tooltip = '删除要点';
        entry.anchor = () => root.children[gist.marker];
      } else {
        entry.button.innerHTML = `${icons.write}<span>写要点</span>`;
        entry.button.title = `给「${name}」写 3–5 条要点，速览时只看它们`;
        entry.anchor = () => heading;
      }
    }
    for (const [heading, group] of buttons) {
      for (const [key, entry] of group) if (!retained.has(entry)) { entry.button.remove(); group.delete(key); }
      if (!group.size) buttons.delete(heading);
    }
    paintHover();
  }
  const entries = () => [...buttons.values()].flatMap(group => [...group.values()]);
  function position() {
    frame = null;
    const parent = column.getBoundingClientRect();
    const scale = parent.width / column.offsetWidth || 1;
    const editorRect = root.getBoundingClientRect();
    // 要点块右上角从右往左排：删除、样式、收起详细、写题目。
    const order = { delete: 0, style: 1, fold: 2, ask: 3 };
    const places = entries().map(entry => {
      const node = entry.anchor?.();
      const rect = node?.getBoundingClientRect();
      if (!rect || !rect.height) return { entry, hidden: true };
      if (entry.kind in order) {
        const group = buttons.get(entry.heading);
        let right = (rect.right - parent.left) / scale - 8;
        for (const kind of ['delete', 'style', 'fold', 'ask']) {
          const other = group?.get(kind);
          if (!other) continue;
          const width = other.button.offsetWidth || 26;
          if (other === entry) return { entry, hidden: false, left: right - width, top: (rect.top - parent.top) / scale + 6 };
          right -= width + 2;
        }
      }
      // 「题目用标题」跟在「要点」和复习按钮后面。
      if (entry.kind === 'hint') {
        const review = buttons.get(entry.heading)?.get('review')?.button;
        return { entry, hidden: false, left: (rect.left - parent.left) / scale + 52 + (review ? review.offsetWidth + 8 : 0), top: (rect.top - parent.top) / scale + 4 };
      }
      if (entry.kind === 'review') return { entry, hidden: false, left: (rect.left - parent.left) / scale + 52, top: (rect.top - parent.top) / scale + 4 };
      if (entry.kind === 'write') {
        // 紧跟在标题文字后面（多行标题取最后一行）。
        const range = document.createRange(); range.selectNodeContents(node);
        const lines = [...range.getClientRects()].filter(line => line.width);
        const last = lines.at(-1) || rect;
        const width = entry.button.offsetWidth || 80;
        const left = Math.min((last.right - parent.left) / scale + 10, (editorRect.right - parent.left) / scale - width);
        return { entry, hidden: false, left, top: (last.top - parent.top) / scale + (last.height - 24) / 2 };
      }
      return { entry, hidden: false, left: (rect.left - parent.left) / scale, top: (rect.bottom - parent.top) / scale + 6 };
    });
    for (const { entry, hidden, left, top } of places) {
      entry.button.hidden = hidden;
      if (hidden) continue;
      entry.button.style.left = `${left}px`;
      entry.button.style.top = `${top}px`;
    }
    if (menu.isConnected && menu.dataset.for) placeMenu();
    if (cardHeading) placeCard();
    // 「看详细」占一行，给它让出位置。
    const gaps = entries().filter(entry => entry.kind === 'detail' && !entry.button.hidden).map(entry => entry.anchor());
    const extra = gaps.map(node => `${sel([...root.children].indexOf(node))} { margin-bottom: 44px !important; }`).join('\n');
    if (extra !== gapStyle.textContent) { gapStyle.textContent = extra; schedule(); }
  }

  // 悬停：「写要点」只在鼠标停在标题上（或光标在标题里）时出现；要点块的工具在鼠标停在要点上时出现。
  let hovered = null, hoverTimer = null, caretHeading = null, caretGist = null;
  function sectionOfBlock(node) {
    const index = [...root.children].indexOf(node);
    if (index < 0) return null;
    return sections.find(({ start, gist }) => start === index || (gist && index >= gist.marker && index <= gist.to)) || null;
  }
  function setHover(heading) {
    clearTimeout(hoverTimer);
    if (heading) { if (hovered !== heading) { hovered = heading; paintHover(); } return; }
    hoverTimer = setTimeout(() => { if (menu.dataset.for) return; hovered = null; paintHover(); }, 160);
  }
  // 打字时（含输入法候选）先藏起「写要点」：标题文字在变长，按钮会盖住正在输入的字。停手一会儿或动鼠标后再出现在新的标题末尾。
  let typing = false, composing = false, typingTimer = null;
  function setTyping(value) {
    clearTimeout(typingTimer);
    if (value) typingTimer = setTimeout(() => { if (!composing) setTyping(false); }, 900);
    if (typing === value) return;
    typing = value;
    if (!value) schedule();
    paintHover();
  }
  const onTypeKey = event => { if (!event.metaKey && !event.ctrlKey && event.key !== 'Escape') setTyping(true); };
  const onCompositionStart = () => { composing = true; setTyping(true); if (sections.some(({ gist }) => gist && !gist.lines && gist.question < 0)) refresh(); };
  const onCompositionEnd = () => { composing = false; setTyping(true); if (sections.some(({ gist }) => gist && !gist.lines && gist.question < 0)) refresh(); };
  function paintHover() {
    for (const entry of entries()) entry.button.classList.toggle('is-shown', !(typing && entry.kind === 'write') && Boolean(entry.heading === hovered || entry.heading === caretHeading || ((entry.kind === 'ask' || entry.kind === 'hint') && entry.heading === caretGist) || (entry.kind === 'style' && menu.dataset.for && entry.heading === menuHeading)));
  }
  const onMove = event => {
    if (typing && !composing && (event.movementX || event.movementY)) setTyping(false);
    const block = event.target.closest?.('#noteRichEditor .ql-editor > *');
    const section = block ? sectionOfBlock(block) : null;
    setHover(section?.heading || null);
  };
  const onLeave = () => setHover(null);

  // 样式：整个应用统一，存在本机。
  const GIST_STYLES = [['tint', '浅蓝'], ['line', '线条'], ['paper', '便签'], ['plain', '灰底']];
  const menu = document.createElement('div');
  menu.className = 'note-gist-style-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '要点样式');
  let menuHeading = null;
  function renderMenu() {
    const current = noteGistStyle();
    menu.innerHTML = `<p>要点样式 · 所有笔记统一</p>${GIST_STYLES.map(([id, label]) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" data-gist-style-option="${id}"><span class="note-gist-swatch" data-swatch="${id}"><i></i><i></i></span><span>${label}</span></button>`).join('')}`;
  }
  function placeMenu() {
    const anchor = buttons.get(menuHeading)?.get('style')?.button;
    if (!anchor || anchor.hidden) { closeMenu(); return; }
    menu.style.left = `${parseFloat(anchor.style.left) + anchor.offsetWidth - 196}px`;
    menu.style.top = `${parseFloat(anchor.style.top) + anchor.offsetHeight + 6}px`;
  }
  function openMenu(heading) {
    menuHeading = heading; menu.dataset.for = '1';
    renderMenu(); layer.append(menu); placeMenu(); paintHover();
    menu.querySelector('[aria-checked="true"]')?.focus();
  }
  function closeMenu() { delete menu.dataset.for; menu.remove(); menuHeading = null; paintHover(); }
  menu.addEventListener('mousedown', event => event.preventDefault());
  menu.addEventListener('click', event => {
    const option = event.target.closest('[data-gist-style-option]');
    if (!option) return;
    setNoteGistStyle(option.dataset.gistStyleOption);
    renderMenu();
  });
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); const button = buttons.get(menuHeading)?.get('style')?.button; closeMenu(); button?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  const onOutside = event => {
    if (menu.dataset.for && !menu.contains(event.target) && !event.target.closest?.('.note-gist-button.style')) closeMenu();
    if (cardHeading && !card.contains(event.target) && !event.target.closest?.('.note-gist-button.review')) closeCard();
  };

  function act(kind, heading, event) {
    if (kind === 'detail') toggleDetail(heading);
    else if (kind === 'fold') toggleFold(heading);
    else if (kind === 'write') writeGist(heading);
    else if (kind === 'style') { if (menu.dataset.for && menuHeading === heading) closeMenu(); else openMenu(heading); }
    else if (kind === 'delete') deleteGist(heading);
    else if (kind === 'ask') writeQuestion(heading);
    else if (kind === 'review') void reviewChip(heading);
    event?.stopPropagation();
  }
  // ——— 加入复习 ———
  const card = document.createElement('div');
  card.className = 'note-gist-review-pop';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', '复习情况');
  let cardHeading = null;
  const ratingLabel = { again: '忘记', hard: '有点难', good: '记住', easy: '很简单' };
  function closeCard() { card.remove(); cardHeading = null; }
  // 弹窗贴着要点块的右边缘放，不压住左对齐的要点文字；要点块太窄时才退回到按钮下方。
  function placeCard() {
    const entry = buttons.get(cardHeading)?.get('review'), anchor = entry?.button;
    if (!anchor || anchor.hidden) { closeCard(); return; }
    // 卡片挨着「复习中 · 今天」：像下拉菜单一样贴在它正下方、左边对齐；右边放不下时往左收，不超出要点块。
    const block = entry.anchor?.(), parent = column.getBoundingClientRect(), scale = parent.width / column.offsetWidth || 1;
    const left = parseFloat(anchor.style.left), width = card.offsetWidth || 300;
    const right = block ? (block.getBoundingClientRect().right - parent.left) / scale - 8 : column.offsetWidth;
    card.style.left = `${Math.max(0, Math.min(left, right - width))}px`;
    card.style.top = `${parseFloat(anchor.style.top) + anchor.offsetHeight + 6}px`;
  }
  function openCard(heading) {
    const section = sections.find(item => item.heading === heading), info = shell().pointStatus(section.key);
    cardHeading = heading;
    const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
    const on = info.status === 'on';
    // 标题 + 状态；三项数字等宽排成一行；两个主要操作等宽；「暂停复习」作为次要操作放在最下面。
    card.innerHTML = `<div class="pop-head"><h4>${esc(section.gist?.title || heading.textContent.trim())}</h4><span class="state" data-state="${on ? 'on' : 'paused'}">${on ? '复习中' : '已暂停'}</span></div>
      <dl><div><dt>下次复习</dt><dd>${on ? esc(info.due || '—') : '—'}</dd></div><div><dt>已复习</dt><dd>${info.reviews} 次</dd></div><div><dt>上次</dt><dd>${info.lastRating ? ratingLabel[info.lastRating] : '还没复习'}</dd></div></dl>
      <div class="row">${on ? '<button type="button" class="primary" data-point-action="now">现在复习</button>' : '<button type="button" class="primary" data-point-action="resume">恢复复习</button>'}<button type="button" data-point-action="cards">在卡片里查看</button></div>
      ${on ? '<div class="pop-foot"><button type="button" class="quiet" data-point-action="pause">暂停复习</button><span>复习记录会保留</span></div>' : ''}`;
    card.dataset.key = section.key;
    layer.append(card); placeCard();
    card.querySelector('button')?.focus();
  }
  card.addEventListener('mousedown', event => event.preventDefault());
  card.addEventListener('click', async event => {
    const action = event.target.closest('[data-point-action]')?.dataset.pointAction, key = card.dataset.key;
    if (!action) return;
    closeCard();
    if (action === 'now') await shell().reviewPointNow(key);
    else if (action === 'cards') shell().openPointInCards(key);
    else if (action === 'pause') { await shell().setPointPaused(key, true); toast('已暂停复习，复习记录保留'); }
    else if (action === 'resume') { await shell().setPointPaused(key, false); toast('已恢复复习'); }
  });
  card.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); const button = buttons.get(cardHeading)?.get('review')?.button; closeCard(); button?.focus(); } });
  async function reviewChip(heading) {
    const section = sections.find(item => item.heading === heading);
    if (!section?.key) return;
    if (cardHeading === heading) { closeCard(); return; }
    const info = shell().pointStatus(section.key);
    if (info.status !== 'off') { openCard(heading); return; }
    const added = await shell().addPointToReview(currentDocumentId(), section.key);
    if (!added) { toast('先在要点里写至少一条内容'); return; }
    toast('已加入复习，今天就会出现', [['去复习', () => shell().reviewPointNow(section.key)], ['撤销', () => shell().undoAddPoint(section.key)]]);
  }
  // 底部提示：加入后可以直接去复习或撤销。
  let toastNode = null, toastTimer = null;
  function toast(message, buttonsList = []) {
    toastNode?.remove(); clearTimeout(toastTimer);
    toastNode = document.createElement('div');
    toastNode.className = 'note-gist-toast'; toastNode.setAttribute('role', 'status');
    toastNode.append(Object.assign(document.createElement('span'), { textContent: message }));
    for (const [label, run] of buttonsList) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => { toastNode?.remove(); void run(); });
      toastNode.append(button);
    }
    document.body.append(toastNode);
    toastTimer = setTimeout(() => toastNode?.remove(), 6000);
  }
  const onPointsChanged = () => { renderButtons(); position(); paintBatch(); if (cardHeading) openCard(cardHeading); };
  // 笔记「更多」菜单：这篇的要点一起加入 / 暂停。
  function paintBatch() {
    const add = document.querySelector('#noteGistReviewAll'), pause = document.querySelector('#noteGistPauseAll');
    if (!add || !pause) return;
    const keys = sections.filter(item => item.key).map(item => item.key);
    const states = keys.map(key => shell()?.pointStatus?.(key)?.status || 'off');
    const waiting = states.filter(state => state !== 'on').length, on = states.filter(state => state === 'on').length;
    add.hidden = !waiting; pause.hidden = !on;
    add.querySelector('span').textContent = `把这篇的要点都加入复习（${waiting} 个）`;
    pause.querySelector('span').textContent = `这篇的要点都暂停复习（${on} 个）`;
  }

  // 只删要点块（[!要点] 和下面的引用行），标题和详细内容不动；一次撤销就能恢复。
  function deleteGist(heading) {
    const section = sections.find(item => item.heading === heading);
    if (!section?.gist || !quill.isEnabled()) return;
    const first = Quill.find(root.children[section.gist.marker]), last = Quill.find(root.children[section.gist.to]);
    if (!first || !last) return;
    const from = quill.getIndex(first), to = quill.getIndex(last) + last.length();
    folded.delete(heading);
    quill.history.cutoff();
    quill.deleteText(from, to - from, 'user');
    quill.history.cutoff();
    hovered = null;
  }
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(position); };

  function toggleFold(heading) {
    if (folded.has(heading)) folded.delete(heading);
    else {
      // 光标在要收起的内容里时，先移到要点上。
      const section = sections.find(item => item.heading === heading), range = quill.getSelection();
      const first = root.children[section.gist.to + 1], next = root.children[section.end];
      if (range && first) {
        const from = quill.getIndex(Quill.find(first)), to = next ? quill.getIndex(Quill.find(next)) : quill.getLength();
        if (range.index + range.length >= from && range.index < to) quill.setSelection(Math.max(0, from - 1), 0, 'silent');
      }
      folded.add(heading);
    }
    refresh();
  }
  // 光标或查找跳进收起的内容时自动展开，和标题折叠一样。
  function revealSelection(range) {
    if (!range || skim) return;
    let changed = false;
    for (const { heading, gist, end } of sections) {
      if (!gist || !folded.has(heading)) continue;
      const first = root.children[gist.to + 1], next = root.children[end];
      if (!first) continue;
      const from = quill.getIndex(Quill.find(first)), to = next ? quill.getIndex(Quill.find(next)) : quill.getLength();
      if (range.index < to && range.index + range.length >= from) { folded.delete(heading); changed = true; }
    }
    if (changed) refresh();
  }
  function toggleDetail(heading) {
    if (expanded.has(heading)) expanded.delete(heading); else expanded.add(heading);
    refresh();
  }
  function writeGist(heading) {
    const blot = Quill.find(heading);
    if (!blot || !quill.isEnabled()) return;
    const index = quill.getIndex(blot) + blot.length();
    quill.history.cutoff();
    quill.insertText(index, '[!要点]\n\n', 'user');
    quill.formatLine(index, '[!要点]\n'.length + 1, 'blockquote', true, 'user');
    quill.history.cutoff();
    quill.setSelection(index + '[!要点]\n'.length, 0, 'user');
    quill.focus();
  }
  // 在要点第一行写「题目：」：第一行是空的就写在这一行，否则在前面加一行；光标放在冒号后面。
  function writeQuestion(heading) {
    const gist = sections.find(item => item.heading === heading)?.gist;
    const marker = gist && Quill.find(root.children[gist.marker]);
    if (!marker || gist.question >= 0 || !quill.isEnabled()) return;
    const index = quill.getIndex(marker) + marker.length();
    const reuse = gist.to > gist.marker && !root.children[gist.from].textContent.trim();
    quill.history.cutoff();
    if (reuse) quill.insertText(index, '题目：', 'user');
    else { quill.insertText(index, '题目：\n', 'user'); quill.formatLine(index, 1, 'blockquote', true, 'user'); }
    quill.history.cutoff();
    quill.setSelection(index + '题目：'.length, 0, 'user');
    quill.focus();
  }
  function setSkim(value) {
    value = Boolean(value);
    if (value === skim) return;
    if (value) {
      // 速览只用来看：暂停编辑，免得在隐藏的段落里改到东西。
      wasEnabled = quill.isEnabled();
      quill.blur();
      quill.enable(false);
    } else if (wasEnabled) quill.enable(true);
    skim = value;
    refresh();
  }

  const onChange = (type, range) => {
    if (type === 'text-change') refresh();
    if (type === 'selection-change') {
      if (!quill.history.ignoreChange) revealSelection(range);
      // 光标停在标题里时也显示「写要点」，方便只用键盘的人。
      const [line] = range ? quill.getLine(range.index) : [null];
      const next = line?.domNode && levelOf(line.domNode) ? line.domNode : null;
      const inGist = line?.domNode && !next ? sectionOfBlock(line.domNode)?.heading || null : null;
      if (next !== caretHeading || inGist !== caretGist) { caretHeading = next; caretGist = inGist; paintHover(); }
    }
  };
  // 顶栏按钮和 ⌘⇧E 由这里接管：顶栏会被重新挂载，按钮上的监听不可靠。
  const onClick = async event => {
    if (!column.isConnected) return;
    if (event.target.closest?.('#noteSkimButton')) { event.preventDefault(); setSkim(!skim); return; }
    if (event.target.closest?.('#noteGistDetailsAll')) { event.preventDefault(); toggleDetailsAll(); return; }
    const batch = event.target.closest?.('#noteGistReviewAll, #noteGistPauseAll');
    if (!batch || !shell()?.setDocumentPoints) return;
    event.preventDefault();
    batch.closest('details')?.removeAttribute('open');
    const count = await shell().setDocumentPoints(currentDocumentId(), batch.id === 'noteGistReviewAll');
    toast(batch.id === 'noteGistReviewAll' ? `已把 ${count} 个要点加入复习` : `已暂停 ${count} 个要点的复习`);
  };
  const onKey = event => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== 'KeyE' || !column.isConnected) return;
    if (!skim && !sections.some(item => item.gist)) return;
    event.preventDefault(); setSkim(!skim);
  };
  document.addEventListener('click', onClick);
  window.addEventListener('memokeep-points-changed', onPointsChanged);
  document.addEventListener('pointerdown', onOutside, true);
  root.addEventListener('mousemove', onMove);
  root.addEventListener('keydown', onTypeKey);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);
  column.addEventListener('mouseleave', onLeave);
  document.addEventListener('keydown', onKey);
  quill.on('editor-change', onChange);
  const observer = new ResizeObserver(schedule);
  observer.observe(column);
  observer.observe(root);
  window.addEventListener('resize', schedule);
  const api = { deleteGist: index => { const section = sections.filter(item => item.gist)[index]; if (section) deleteGist(section.heading); }, setSkim, toggleSkim: () => setSkim(!skim), isSkim: () => skim, count: () => sections.filter(item => item.gist).length, refresh };
  window.MemoKeepNoteGist = api;
  refresh();
  requestAnimationFrame(() => paintSkimButton(api.count()));
  return () => {
    if (skim) setSkim(false);
    quill.off('editor-change', onChange);
    document.removeEventListener('click', onClick);
    window.removeEventListener('memokeep-points-changed', onPointsChanged);
    toastNode?.remove(); clearTimeout(toastTimer);
    document.removeEventListener('pointerdown', onOutside, true);
    root.removeEventListener('mousemove', onMove);
    root.removeEventListener('keydown', onTypeKey);
    root.removeEventListener('compositionstart', onCompositionStart);
    root.removeEventListener('compositionend', onCompositionEnd);
    clearTimeout(typingTimer);
    column.removeEventListener('mouseleave', onLeave);
    clearTimeout(hoverTimer);
    document.removeEventListener('keydown', onKey);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    layer.remove();
    style.remove();
    gapStyle.remove();
    column.classList.remove('note-skim');
    if (window.MemoKeepNoteGist === api) window.MemoKeepNoteGist = null;
    window.dispatchEvent(new CustomEvent('memokeep-note-gists', { detail: { count: 0, skim: false } }));
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { bindNoteGist, NOTE_GIST_MARKER };
