function registerNoteDiagramClipboard(quill) {
  const Delta = window.Quill.import('delta');
  const sourceDelta = source => source.replace(/\r\n?/g, '\n').split('\n').reduce((result, line) => {
    if (line) result.insert(line);
    return result.insert('\n', { 'code-block': 'mermaid' });
  }, new Delta());
  quill.clipboard.addMatcher('PRE', (node, delta) => {
    if (!isDiagramCodeBlock(node)) return delta;
    // Preserve literal labels, indentation and empty lines rather than interpreting Markdown inside code.
    return sourceDelta(node.textContent);
  });
  quill.clipboard.addMatcher('.ql-code-block-container', (node, delta) => {
    // Saved Quill blocks use DIVs, whose whitespace the default HTML importer collapses.
    const [source] = richEditorDiagramSources({ querySelectorAll: () => [node] });
    return source === undefined ? delta : sourceDelta(source);
  });
}

function noteDiagramClipboardHtml(value) {
  const source = String(value).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const container = document.createElement('div');
  if (isMermaidSource(source, true)) {
    const pre = document.createElement('pre');
    pre.dataset.language = 'mermaid';
    const code = document.createElement('code');
    code.textContent = source;
    pre.append(code);
    container.append(pre);
  } else {
    if (!applicationShell.actions.looksLikeMarkdown(source)) return null;
    container.innerHTML = applicationShell.actions.markdownToRichHtml(source);
  }
  const diagrams = [...container.querySelectorAll('pre')].filter(isDiagramCodeBlock);
  if (!diagrams.length) return null;
  diagrams.forEach(pre => { pre.dataset.language = 'mermaid'; });
  // Adjacent fences are distinct diagrams, even when Quill would merge their code containers.
  for (const pre of container.querySelectorAll('pre')) {
    const previous = pre.previousElementSibling;
    if (previous?.tagName !== 'PRE' || ![previous, pre].some(isDiagramCodeBlock)) continue;
    const paragraph = document.createElement('p');
    paragraph.append(document.createElement('br'));
    pre.before(paragraph);
  }
  return container.innerHTML;
}

function pasteNoteDiagram(quill, text) {
  const html = noteDiagramClipboardHtml(text);
  if (!html) return false;
  const range = quill.getSelection(true);
  if (!range || !quill.isEnabled()) return false;
  const [first, offset] = quill.getLine(range.index);
  const [last] = quill.getLine(range.index + range.length);
  // A table cell keeps its normal text-paste behavior instead of splitting the table into blocks.
  if (first?.formats().table || last?.formats().table) return false;
  const Delta = window.Quill.import('delta');
  const prefix = new Delta();
  if (offset > 0) prefix.insert('\n', first.formats());
  const previous = offset > 0 ? first : range.index > 0 ? quill.getLine(range.index - 1)[0] : null;
  if (previous?.formats()['code-block']) prefix.insert('\n');
  const content = quill.clipboard.convert({ html, text: '' });
  if (!String(content.ops.at(-1)?.insert || '').endsWith('\n')) content.insert('\n');
  const needsParagraph = !last || last.statics.blotName !== 'block'
    || last.domNode.querySelector('.note-image-frame, img') || range.index + range.length >= quill.getLength();
  if (needsParagraph) content.insert('\n');
  const change = new Delta().retain(range.index).delete(range.length).concat(prefix).concat(content);
  quill.history.cutoff();
  quill.updateContents(change, 'user');
  quill.history.cutoff();
  quill.setSelection(range.index + prefix.length() + content.length() - (needsParagraph ? 1 : 0), 0, 'user');
  quill.scrollSelectionIntoView();
  return true;
}
