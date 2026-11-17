function noteNavigationBlock(quill, blot) {
  if (!blot) return null;
  while (blot.parent && blot.parent !== quill.scroll) blot = blot.parent;
  if (blot.parent !== quill.scroll) return null;
  const type = blot.statics.blotName;
  if (!['code-block-container', 'table-container', 'list-container', 'blockquote', 'header'].includes(type)
    && !blot.domNode.querySelector?.('.note-image-frame, img')) return null;
  let last = blot;
  // Quill stores each quoted paragraph separately; treat consecutive quotes as one block.
  if (type === 'blockquote') while (last.next?.statics.blotName === type) last = last.next;
  return { first: blot, last };
}

function moveAfterNoteBlock(quill, block) {
  if (!block?.last.domNode.isConnected || !quill.isEnabled()) return false;
  const end = quill.getIndex(block.last) + block.last.length();
  const next = block.last.next;
  const reusable = next?.statics.blotName === 'block' && !next.domNode.querySelector('.note-image-frame, img');
  if (!reusable) {
    const Delta = window.Quill.import('delta');
    quill.history.cutoff();
    // An unformatted Delta inserts a paragraph without inheriting code, list or table formatting.
    quill.updateContents(new Delta().retain(end).insert('\n'), 'user');
    quill.history.cutoff();
  }
  quill.setSelection(end, 0, 'user');
  quill.scrollSelectionIntoView();
  return true;
}

function insertBeforeNoteBlock(quill, block) {
  if (!block || !quill.root.contains(block.first.domNode) || !quill.isEnabled()) return false;
  const index = quill.getIndex(block.first);
  const Delta = window.Quill.import('delta');
  quill.history.cutoff();
  quill.updateContents(new Delta().retain(index).insert('\n'), 'user');
  quill.history.cutoff();
  quill.setSelection(index, 0, 'user');
  quill.scrollSelectionIntoView();
  return true;
}

function removeEmptyNoteTable(quill, range, key) {
  const [line, offset] = quill.getLine(range.index);
  if (!line) return false;
  const block = noteNavigationBlock(quill, line);
  const inside = block?.first.statics.blotName === 'table-container';
  let table = inside ? block.first : null;
  if (inside) {
    if (key === 'Backspace' ? offset > 0 : offset < line.length() - 1) return false;
  } else if (line.parent === quill.scroll) {
    const adjacent = key === 'Backspace' && offset === 0 ? line.prev
      : key === 'Delete' && offset === line.length() - 1 ? line.next : null;
    if (adjacent?.statics.blotName === 'table-container') table = adjacent;
  }
  if (!table) return false;
  const index = quill.getIndex(table), length = table.length();
  const contents = quill.getContents(index, length);
  // Embeds count as content even when getText() would report an empty cell.
  if (contents.ops.some(op => typeof op.insert !== 'string' || op.insert.trim())) return false;
  const Delta = window.Quill.import('delta');
  const delta = new Delta().retain(index).delete(length);
  if (inside) delta.insert('\n');
  quill.history.cutoff();
  quill.updateContents(delta, 'user');
  const caret = inside ? index : key === 'Backspace' ? range.index - length : range.index;
  quill.setSelection(caret, 0, 'user');
  quill.history.cutoff();
  quill.scrollSelectionIntoView();
  return true;
}

function bindNoteBlockNavigation(quill, column, onNavigate = () => {}) {
  const root = quill.root;
  const controller = new AbortController();
  const listen = (node, type, handler, options = {}) => node.addEventListener(type, handler, { ...options, signal: controller.signal });
  const fromIndex = index => noteNavigationBlock(quill, quill.getLine(index)[0]);
  const fromNode = node => {
    const diagram = node.closest?.('.note-diagram-toggle-host');
    if (diagram?.noteCodeBlock) return noteNavigationBlock(quill, window.Quill.find(diagram.noteCodeBlock));
    return root.contains(node) ? noteNavigationBlock(quill, window.Quill.find(node, true)) : null;
  };
  listen(column, 'mousedown', event => {
    if (event.target.closest('.note-diagram-insert-before')) event.preventDefault();
  });
  listen(column, 'click', event => {
    if (event.target.closest('.note-diagram-insert-before') && insertBeforeNoteBlock(quill, fromNode(event.target))) onNavigate();
  });
  // Capture before Quill's default block-boundary handlers consume these keys.
  listen(column, 'keydown', event => {
    if (!['Enter', 'Backspace', 'Delete'].includes(event.key) || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || quill.selection.composing || !quill.isEnabled()) return;
    if (!root.contains(event.target) && !event.target.closest('.note-diagram-toggle-host')) return;
    const range = quill.getSelection();
    const imageFrame = event.target.closest('.note-image-frame');
    if (event.key !== 'Enter') {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !root.contains(event.target)
        || imageFrame || !range || range.length || !removeEmptyNoteTable(quill, range, event.key)) return;
    } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      const block = root.contains(event.target) && range && !imageFrame ? fromIndex(range.index) : fromNode(event.target);
      if (!moveAfterNoteBlock(quill, block)) return;
    } else {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !root.contains(event.target)
        || imageFrame || !range || range.length) return;
      const [line] = quill.getLine(range.index);
      if (!line?.formats()['code-block']) return;
      const block = fromIndex(range.index);
      if (block && quill.getIndex(block.first) === range.index && (line.length() > 1 || line.next)
        && richEditorDiagramSources({ querySelectorAll: () => [block.first.domNode] }).length) {
        if (!insertBeforeNoteBlock(quill, block)) return;
        event.preventDefault(); event.stopImmediatePropagation(); onNavigate();
        return;
      }
      if (line.length() !== 1 || line.next) return;
      const Delta = window.Quill.import('delta');
      const index = quill.getIndex(line);
      const clear = Object.fromEntries(Object.keys(line.formats()).map(name => [name, null]));
      quill.history.cutoff();
      quill.updateContents(new Delta().retain(index).retain(1, clear), 'user');
      quill.history.cutoff();
      quill.setSelection(index, 0, 'user');
      quill.scrollSelectionIntoView();
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    onNavigate();
  }, { capture: true });
  return () => controller.abort();
}
