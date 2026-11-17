(function expose(root) {
  function createQuillTransactions() {
    function preserveOnFailure(quill, change) {
      const range = quill.getSelection(), contents = quill.getContents();
      const images = [...quill.root.querySelectorAll('img')].map(image =>
        ['data-memokeep-image-id', 'data-file-name', 'alt'].map(name => [name, image.getAttribute(name)]));
      const history = quill.getModule('history');
      const savedHistory = history && { stack: { undo: [...history.stack.undo], redo: [...history.stack.redo] },
        lastRecorded: history.lastRecorded, currentRange: history.currentRange };
      try { return change(); }
      catch (error) {
        try {
          quill.setContents(contents, 'silent');
          [...quill.root.querySelectorAll('img')].forEach((image, index) => images[index]?.forEach(([name, value]) => {
            if (value === null) image.removeAttribute(name); else image.setAttribute(name, value);
          }));
          if (range) quill.setSelection(range.index, range.length, 'silent');
        } finally { if (savedHistory) Object.assign(history, savedHistory); }
        throw error;
      }
    }
    function insertImage(quill, Delta, index, image, attributes) {
      quill.updateContents(new Delta().retain(index).insert({ image }, attributes), 'user');
    }
    function insertScreenshot(quill, Delta, selection, image, attributes) {
      quill.getModule('history')?.cutoff();
      quill.updateContents(new Delta().retain(selection.index).delete(selection.length).insert({ image }, attributes).insert('\n'), 'user');
      quill.getModule('history')?.cutoff();
      quill.focus();
      quill.setSelection(selection.index + 2, 0, 'silent');
    }
    return { insertImage, insertScreenshot, preserveOnFailure };
  }
  const api = { createQuillTransactions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepEditor ||= {}, api);
})(globalThis);
