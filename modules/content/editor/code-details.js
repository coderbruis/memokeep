// Metadata belongs to code lines; controls stay outside Quill and saved note HTML.
function normalizeNoteCodeName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
}
function noteCodeDetails(block) {
  const line = block?.querySelector('.ql-code-block') || block;
  return { name: normalizeNoteCodeName(line?.getAttribute('data-code-name')), collapsed: line?.getAttribute('data-code-fold') === '1' };
}
function noteCodeLanguage(language) {
  const id = String(language || 'plain').toLowerCase();
  return NOTE_CODE_LANGUAGES.find(item => item.id === id) || NOTE_CODE_LANGUAGES.find(item => item.aliases.some(alias => alias.toLowerCase() === id)) || { id, label: id, aliases: [] };
}
function paintNoteCodeDetails(block) {
  const { name, collapsed } = noteCodeDetails(block), value = String(collapsed);
  const language = noteCodeLanguage(block.querySelector('.ql-code-block')?.dataset.language).label;
  const title = name ? `${name} · ${language}` : language;
  if (block.getAttribute('data-code-title') !== title) block.setAttribute('data-code-title', title);
  if (block.getAttribute('data-code-collapsed') !== value) block.setAttribute('data-code-collapsed', value);
}
function registerNoteCodeDetails(Quill, registry) {
  const { Attributor, Scope } = Quill.import('parchment');
  class CodeName extends Attributor {
    canAdd(node, value) { return node.classList.contains('ql-code-block') && Boolean(normalizeNoteCodeName(value)) && value === normalizeNoteCodeName(value); }
  }
  class CodeFold extends Attributor {
    canAdd(node, value) { return node.classList.contains('ql-code-block') && value === '1'; }
  }
  registry.register(new CodeName('codeName', 'data-code-name', { scope: Scope.BLOCK_ATTRIBUTE }), new CodeFold('codeFold', 'data-code-fold', { scope: Scope.BLOCK_ATTRIBUTE }));
}
function noteCodeFormatSignature(child) {
  const formats = child?.formats() || {};
  return JSON.stringify(['code-block', 'codeStyle', 'codeName', 'codeFold'].map(key => formats[key] || ''));
}
