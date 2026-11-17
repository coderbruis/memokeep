function bindNotePlainPaste(quill, notify) {
  const isMac = (window.memoKeepDesktop?.platform || navigator.platform || '').toLowerCase().match(/darwin|mac/);
  quill.root.addEventListener('keydown', async event => {
    const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.defaultPrevented || event.isComposing || !primary || !event.shiftKey || event.altKey
      || (event.code !== 'KeyV' && event.key.toLowerCase() !== 'v')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || !quill.isEnabled()) return;
    const range = quill.getSelection();
    if (!range) return;
    try {
      const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, '\n');
      const current = quill.getSelection();
      // Clipboard reads can finish after switching notes or moving the caret.
      if (!text || !quill.root.isConnected || !quill.isEnabled() || !quill.hasFocus()
        || current?.index !== range.index || current?.length !== range.length) return;
      quill.history.cutoff();
      // Use Quill's text-only insertion to keep target code/table formatting and undo.
      quill.clipboard.onPaste(range, { text });
      quill.history.cutoff();
    } catch {
      notify?.('无法读取剪贴板，请重新复制后再试', true);
    }
  }, true);
}
