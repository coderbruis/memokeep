globalThis.MemoKeepEdition = { id: 'community', editorAssets: ['../modules/content/diagrams/source-editor.js'] };
globalThis.MemoKeepEditorEnhancements = {
  create: () => ({
    bindImages: () => () => {},
    bindTables: () => () => {},
    bindCode: quill => ({
      render() { serializeNoteCodeStyles(quill.root); highlightNoteCode(quill.root); },
      dispose() { for (const key of ['keyword', 'string', 'comment', 'number']) CSS.highlights?.delete(`note-code-${key}`); }
    })
  })
};
