// Basic source editing uses the same Delta transaction and preserves layout comments.
(function exposeSourceEditor(root) {
  function create(quill, runtime, { confirmDiscard } = {}) {
    let active;
    const close = () => { active?.dialog.remove(); active = null; };
    const hasChanges = () => Boolean(active && active.input.value !== active.original);
    const confirmClose = async () => {
      if (hasChanges() && !await confirmDiscard({ title: '放弃图表修改？', message: '尚未应用的源码将被丢弃。', confirmLabel: '放弃修改', tone: 'warning' })) return false;
      close(); return true;
    };
    function open(block, range) {
      if (active || !quill.isEnabled()) return;
      const original = block ? richEditorDiagramSources({ querySelectorAll: () => [block] })[0] : NOTE_MERMAID_TEMPLATES.flowchart.source;
      if (original === undefined) return;
      const target = { block, range: range || quill.getSelection(true) || { index: quill.getLength() - 1, length: 0 }, document: JSON.stringify(quill.getContents()) };
      const dialog = document.createElement('dialog');
      dialog.className = 'mermaid-source-dialog';
      dialog.setAttribute('aria-label', 'Mermaid 源码编辑');
      dialog.innerHTML = '<h2>Mermaid 源码</h2><textarea aria-label="Mermaid 源码" spellcheck="false"></textarea><p role="alert" hidden></p><footer><button type="button" data-action="cancel">取消</button><button type="button" data-action="apply">应用</button></footer>';
      const input = dialog.querySelector('textarea'), error = dialog.querySelector('[role="alert"]');
      input.value = original;
      active = { dialog, input, original };
      dialog.querySelector('[data-action="cancel"]').onclick = () => void confirmClose();
      dialog.addEventListener('cancel', event => { event.preventDefault(); void confirmClose(); });
      dialog.querySelector('[data-action="apply"]').onclick = async () => {
        const source = input.value, session = active;
        try {
          if (!source.trim()) throw new Error('请输入 Mermaid 源码');
          const mermaid = await loadDiagramRenderer();
          await mermaid.parse(themedMermaidSource(source));
          if (active !== session || input.value !== source) return;
          if (source !== original || !block) changeNoteMermaid(quill, target, source);
          close();
        } catch (reason) { if (active === session) { error.textContent = reason.message; error.hidden = false; } }
      };
      document.body.append(dialog); dialog.showModal(); input.focus();
    }
    return { insert: range => open(null, range), edit: block => open(block), hasChanges, confirmClose, requestClose: confirmClose, dispose: close };
  }
  root.MemoKeepDiagramSourceAuthoring = { create };
  root.MemoKeepDiagramAuthoring ||= root.MemoKeepDiagramSourceAuthoring;
})(globalThis);
