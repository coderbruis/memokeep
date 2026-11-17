// Code appearance is a Quill line format. Toolbars and highlighting stay outside saved content.
const NOTE_CODE_STYLE_BASE = Object.freeze({ theme: 'dark', font: 'system', size: 14, lineHeight: 1.6, appearance: 'simple', lineNumbers: true, wrap: false });
const NOTE_CODE_STYLE_THEMES = { auto: '跟随应用', light: '浅色', dark: '深色', warm: '暖灰' };
function normalizeNoteCodeStyle(value = {}) {
  return {
    theme: Object.hasOwn(NOTE_CODE_STYLE_THEMES, value?.theme) ? value.theme : NOTE_CODE_STYLE_BASE.theme,
    font: ['system', 'menlo', 'consolas'].includes(value?.font) ? value.font : 'system',
    size: Number.isInteger(Number(value?.size)) && Number(value.size) >= 12 && Number(value.size) <= 20 ? Number(value.size) : 14,
    lineHeight: [1.4, 1.6, 1.8, 2].includes(Number(value?.lineHeight)) ? Number(value.lineHeight) : 1.6,
    appearance: ['simple', 'border', 'raised'].includes(value?.appearance) ? value.appearance : 'simple',
    lineNumbers: typeof value?.lineNumbers === 'boolean' ? value.lineNumbers : true,
    wrap: value?.wrap === true
  };
}
function packNoteCodeStyle(style) {
  const clean = normalizeNoteCodeStyle(style);
  return [clean.theme, clean.font, clean.size, clean.lineHeight, clean.appearance, Number(clean.lineNumbers), Number(clean.wrap)].join('|');
}
function parseNoteCodeStyle(value) {
  if (typeof value !== 'string' || !/^(auto|light|dark|warm)\|(system|menlo|consolas)\|(1[2-9]|20)\|(1\.4|1\.6|1\.8|2)\|(simple|border|raised)\|[01]\|[01]$/.test(value)) return null;
  const [theme, font, size, lineHeight, appearance, lineNumbers, wrap] = value.split('|');
  return { theme, font, size: Number(size), lineHeight: Number(lineHeight), appearance, lineNumbers: lineNumbers === '1', wrap: wrap === '1' };
}
function noteCodeStyle(block) {
  return parseNoteCodeStyle(block?.querySelector('.ql-code-block')?.getAttribute('data-code-style') || block?.getAttribute('data-code-style')) || { ...NOTE_CODE_STYLE_BASE };
}
function paintNoteCodeStyle(node, style) {
  const clean = normalizeNoteCodeStyle(style);
  for (const [key, value] of Object.entries(clean)) {
    const name = `data-code-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    const text = String(value);
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  }
}
function serializeNoteCodeStyles(root) {
  root.querySelectorAll('.ql-code-block-container').forEach(block => { paintNoteCodeStyle(block, noteCodeStyle(block)); paintNoteCodeDetails(block); });
}
function registerNoteCodeStyle(Quill, registry, { getDefault, isLoading }) {
  registerNoteCodeDetails(Quill, registry);
  const { Attributor, Scope } = Quill.import('parchment');
  class CodeStyle extends Attributor {
    canAdd(node, value) { return node.classList.contains('ql-code-block') && Boolean(parseNoteCodeStyle(value)); }
  }
  registry.register(new CodeStyle('codeStyle', 'data-code-style', { scope: Scope.BLOCK_ATTRIBUTE }));
  const BaseCode = registry.query('code-block'), BaseContainer = registry.query('code-block-container');
  class StyledCode extends BaseCode {
    static create(value) {
      const node = super.create(value);
      if (!isLoading()) node.setAttribute('data-code-style', packNoteCodeStyle(getDefault()));
      return node;
    }
  }
  class StyledCodeContainer extends BaseContainer {
    checkMerge() {
      const signature = noteCodeFormatSignature;
      return super.checkMerge() && signature(this.children.head) === signature(this.children.tail)
        && signature(this.children.head) === signature(this.next.children.head) && signature(this.children.head) === signature(this.next.children.tail);
    }
    optimize(context) {
      super.optimize(context);
      this.children.forEach(child => {
        if (!child.next || noteCodeFormatSignature(child) === noteCodeFormatSignature(child.next)) return;
        const next = this.splitAfter(child);
        next?.optimize(context);
        this.prev?.optimize(context);
      });
    }
    html(index, length) {
      const template = document.createElement('template');
      template.innerHTML = super.html(index, length);
      const [line] = this.children.find(index);
      const style = line?.formats().codeStyle;
      const pre = template.content.firstElementChild;
      if (parseNoteCodeStyle(style)) pre.setAttribute('data-code-style', style);
      const details = line?.formats() || {};
      if (details.codeName) pre.setAttribute('data-code-name', details.codeName);
      if (details.codeFold === '1') pre.setAttribute('data-code-fold', '1');
      // Mermaid's literal-source importer supplies its own final line terminator.
      if (pre.dataset.language === 'mermaid' && pre.textContent.endsWith('\n')) pre.textContent = pre.textContent.slice(0, -1);
      return template.innerHTML;
    }
  }
  StyledCode.requiredContainer = StyledCodeContainer;
  StyledCodeContainer.allowedChildren = [StyledCode];
  registry.register(StyledCodeContainer, StyledCode);
}

const noteCodeTokenCache = new WeakMap();
function highlightNoteCode(root, dirtyBlocks = null) {
  if (!window.Highlight || !CSS.highlights || !window.Prism) return;
  const ranges = { keyword: [], string: [], comment: [], number: [] };
  const color = type => /comment|prolog|doctype/.test(type) ? 'comment' : /string|char|attr-value|regex/.test(type) ? 'string' : /number|boolean|constant/.test(type) ? 'number' : /keyword|builtin|function|class-name|tag|selector|property|attr-name|symbol|operator/.test(type) ? 'keyword' : null;
  let budget = 50000;
  for (const block of root.querySelectorAll('.ql-code-block-container')) {
    const language = noteCodeLanguage(block.querySelector('.ql-code-block')?.dataset.language).id;
    const grammar = Prism.languages[language];
    if (!grammar || ['plain', 'plaintext'].includes(language) || noteCodeDetails(block).collapsed && !root.closest('.note-reading')) continue;
    let cached = noteCodeTokenCache.get(block);
    if (dirtyBlocks && !dirtyBlocks.has(block) && cached?.ranges && cached.language === language) {
      if (cached.text.length > budget) continue;
      budget -= cached.text.length;
      for (const key of Object.keys(ranges)) ranges[key].push(...cached.ranges[key]);
      continue;
    }
    const lines = [...block.querySelectorAll('.ql-code-block')], text = lines.map(line => line.textContent).join('\n');
    if (text.length > 20000 || text.length > budget) continue;
    budget -= text.length;
    if (!cached || cached.text !== text || cached.language !== language) {
      const segments = []; let offset = 0;
      const walk = (token, inherited = null) => {
        if (typeof token === 'string') { if (inherited && token.length) segments.push({ start: offset, end: offset + token.length, color: inherited }); offset += token.length; }
        else if (Array.isArray(token)) token.forEach(child => walk(child, inherited));
        else walk(token.content, color(token.type) || inherited);
      };
      try {
        const env = { code: text, grammar, language };
        Prism.hooks.run('before-tokenize', env); env.tokens = Prism.tokenize(env.code, env.grammar); Prism.hooks.run('after-tokenize', env); walk(env.tokens);
      } catch { /* An unsupported grammar leaves readable source, without disrupting editing. */ }
      cached = { text, language, segments }; noteCodeTokenCache.set(block, cached);
    }
    const nodes = []; let offset = 0;
    const blockRanges = { keyword: [], string: [], comment: [], number: [] };
    for (const line of lines) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) { nodes.push({ node, start: offset, end: offset + node.length }); offset += node.length; }
      offset += 1;
    }
    let firstIndex = 0;
    for (const token of cached.segments) {
      while (firstIndex < nodes.length && nodes[firstIndex].end <= token.start) firstIndex++;
      for (let i = firstIndex; i < nodes.length && nodes[i].start < token.end; i++) {
        const item = nodes[i], start = Math.max(token.start, item.start), end = Math.min(token.end, item.end);
        if (end <= start) continue;
        const range = document.createRange(); range.setStart(item.node, start - item.start); range.setEnd(item.node, end - item.start); blockRanges[token.color].push(range);
      }
    }
    cached.ranges = blockRanges;
    for (const key of Object.keys(ranges)) ranges[key].push(...blockRanges[key]);
  }
  for (const [key, values] of Object.entries(ranges)) CSS.highlights.set(`note-code-${key}`, new Highlight(...values));
}

function registerNoteCodeClipboard(quill) {
  const Delta = window.Quill.import('delta');
  // A styled code block copied as HTML retains its appearance, including Mermaid source.
  const preserveStyle = (node, delta) => {
    const style = parseNoteCodeStyle(node.getAttribute('data-code-style'));
    const name = normalizeNoteCodeName(node.getAttribute('data-code-name'));
    const folded = node.getAttribute('data-code-fold') === '1';
    if (!style && !name && !folded) return delta;
    const attributes = { ...(style ? { codeStyle: packNoteCodeStyle(style) } : {}), ...(name ? { codeName: name } : {}), ...(folded ? { codeFold: '1' } : {}) };
    const result = new Delta();
    for (const op of delta.ops) {
      if (typeof op.insert !== 'string' || !op.attributes?.['code-block']) { result.push(op); continue; }
      const parts = op.insert.split('\n');
      parts.forEach((part, index) => { if (part) result.insert(part, op.attributes); if (index < parts.length - 1) result.insert('\n', { ...op.attributes, ...attributes }); });
    }
    return result;
  };
  // Saved code lines are DIVs; HTML import must not collapse their literal whitespace.
  quill.clipboard.addMatcher('.ql-code-block', (node, delta) =>
    new Delta().insert(node.textContent + '\n', delta.ops.at(-1)?.attributes));
  quill.clipboard.addMatcher('PRE', preserveStyle);
  quill.clipboard.addMatcher('.ql-code-block-container', (node, delta) => {
    const line = node.querySelector('.ql-code-block');
    if (!line || !richEditorDiagramSources({ querySelectorAll: () => [node] }).length) return delta;
    return preserveStyle(line, delta);
  });
  // Quill's literal paste inside code skips HTML matchers and carries only the language.
  const convertClipboard = quill.clipboard.convert;
  quill.clipboard.convert = function(input, formats = {}) {
    const delta = convertClipboard.call(this, input, formats);
    if (formats['code-block']) for (const op of delta.ops) {
      if (op.attributes?.['code-block']) for (const key of ['codeStyle', 'codeName', 'codeFold']) op.attributes[key] = formats[key] || null;
    }
    return delta;
  };
}
