(function expose(root) {
  function createEditorInteractions({ state, config, actions, env, session, features }) {
    const renderCodeCopyButtons = () => {};

    const inlineCardRowBounds = lineIndex => {
      features.syncEditorLayoutMirror();
      const span = session.layoutLineSpans[lineIndex];
      const rects = span?.getClientRects();
      if (!rects?.length || !env.application.domain.parseInlineCardLine(session.layoutLines[lineIndex] || '')) return null;
      const canvasRect = session.canvas.getBoundingClientRect();
      const lineHeight = Number.parseFloat(env.window.getComputedStyle(session.editor).lineHeight) || 28;
      const firstRect = rects[0];
      const lastRect = rects[rects.length - 1];
      const firstLeading = Math.max(0, (lineHeight - firstRect.height) / 2);
      const lastLeading = Math.max(0, (lineHeight - lastRect.height) / 2);
      const top = firstRect.top - canvasRect.top - firstLeading - session.editor.scrollTop;
      const bottom = lastRect.bottom - canvasRect.top + lastLeading - session.editor.scrollTop;
      return { top, bottom, height: bottom - top, right: Math.max(...[...rects].map(rect => rect.right)) - canvasRect.left };
    };

    const versionFromDocument = current => ({
      savedAt: current.updatedAt || current.createdAt || new Date().toISOString(),
      title: String(current.title || ''),
      content: String(current.content || ''),
      editorMode: current.metadata?.editorMode === 'note' ? 'note' : 'card',
      noteContent: String(current.metadata?.noteContent || ''),
      noteContentInitialized: Boolean(current.metadata?.noteContentInitialized),
      inlineTagRows: actions.initialInlineTagRows(current)
    });

    const snapshotsMatch = (left, right, includeTags = true) => (!includeTags || JSON.stringify(env.normalizeNoteTagIds(left.tagIds).sort()) === JSON.stringify(env.normalizeNoteTagIds(right.tagIds).sort()))
    && left.title === right.title
    && left.content === right.content
    && left.editorMode === right.editorMode
    && left.noteContent === right.noteContent
    && left.noteContentInitialized === right.noteContentInitialized
    && JSON.stringify(left.inlineTagRows || []) === JSON.stringify(right.inlineTagRows || []);

    const tableEdgeSelection = (table, action) => {
      const rows = [...(table?.rows || [])];
      if (!rows.length) return null;
      let targetCell = null;
      if (action === 'insertColumnRight') targetCell = rows[0].cells[rows[0].cells.length - 1];
      if (action === 'insertRowBelow') targetCell = rows[rows.length - 1].cells[0];
      if (action === 'deleteColumn') targetCell = rows[0].cells[Math.max(0, session.activeTableColumnIndex)];
      if (action === 'deleteRow') targetCell = rows[Math.max(0, session.activeTableRowIndex)]?.cells[0];
      if (action === 'deleteTable') targetCell = rows[0].cells[0];
      return features.getTableSelectionFromCell(targetCell);
    };

    const refreshNoteShortcutLabels = () => {
      const save = config.$('#saveNoteButton');
      if (save) save.title = `保存笔记（${env.MemoKeepShortcuts.label('save')}）`;
      session.editorRoot.querySelectorAll('#saveNoteButton kbd, .card-editor-footer kbd').forEach(kbd => kbd.textContent = env.MemoKeepShortcuts.label('save'));
      const todo = session.editorRoot.querySelector('.ql-list[value="check"]');
      if (todo) todo.title = `任务列表（${env.MemoKeepShortcuts.label('todo')}）`;
    };

    const refreshEditor = () => {
      features.markNoteChanged();
      features.renderCardEditorLayout();
      features.renderLineBullets();
      features.renderInlineCardTokens();
      features.renderNoteImageTokens();
    };

    const closeContextMenu = () => session.contextMenu.classList.add('hidden');

    const closeCommandMenu = () => {
      session.slashCommandIndex = null;
      session.commandMenu.classList.add('hidden');
    };

    const getLineAt = (value, index) => {
      const lineStart = value.lastIndexOf('\n', index - 1) + 1;
      const nextLineBreak = value.indexOf('\n', index);
      const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
      return { line: value.slice(lineStart, lineEnd), lineStart, lineEnd };
    };

    const currentLineAlreadyHasCard = (value = session.editor.value, index = session.editor.selectionStart) => {
      return Boolean(env.application.domain.parseInlineCardLine(features.getLineAt(value, index).line));
    };

    const positionCommandMenu = () => {
      const contentBeforeCaret = session.editor.value.slice(0, session.editor.selectionStart);
      const lineIndex = (contentBeforeCaret.match(/\n/g) || []).length;
      const linePoint = features.editorTextPoint(lineIndex, 0);
      const unclampedTop = (linePoint?.top || session.editor.offsetTop) - session.editor.scrollTop + 30;
      const maximumTop = Math.max(52, session.canvas.clientHeight - 104);
      session.commandMenu.style.top = `${Math.max(52, Math.min(unclampedTop, maximumTop))}px`;
    };

    const updateCommandMenu = () => {
      const caret = session.editor.selectionStart;
      const hasJustTypedSlash = session.editor.value[caret - 1] === '/';

      if (!hasJustTypedSlash
      || session.editor.selectionStart !== session.editor.selectionEnd
      || features.currentLineAlreadyHasCard()) {
        features.closeCommandMenu();
        return;
      }

      session.slashCommandIndex = caret - 1;
      features.positionCommandMenu();
      session.commandMenu.classList.remove('hidden');
    };

    const insertCardSeparator = () => {
      if (session.slashCommandIndex === null) return;
      const selectionEnd = session.editor.selectionEnd;
      const valueWithoutSlash = `${session.editor.value.slice(0, session.slashCommandIndex)}${session.editor.value.slice(selectionEnd)}`;
      if (features.currentLineAlreadyHasCard(valueWithoutSlash, session.slashCommandIndex)) {
        features.closeCommandMenu();
        actions.showToast('一行只能创建一张记忆卡片，请换行后继续', true);
        return;
      }
      const characterBeforeSlash = session.editor.value[session.slashCommandIndex - 1] || '';
      const replacement = characterBeforeSlash && !/\s/.test(characterBeforeSlash)
      ? config.SLASH_CARD_SEPARATOR
      : config.SLASH_CARD_SEPARATOR.trimStart();
      session.editor.setRangeText(replacement, session.slashCommandIndex, selectionEnd, 'end');
      features.closeCommandMenu();
      session.editor.focus();
      features.refreshEditor();
    };

    const redrawCardEditor = () => {
      session.layoutSignature = '';
      features.renderCardEditorLayout();
      features.renderLineBullets();
      features.renderInlineCardTokens();
      features.renderNoteImageTokens();
    };
    return { renderCodeCopyButtons, inlineCardRowBounds, versionFromDocument, snapshotsMatch, tableEdgeSelection, refreshNoteShortcutLabels, refreshEditor, closeContextMenu, closeCommandMenu, getLineAt, currentLineAlreadyHasCard, positionCommandMenu, updateCommandMenu, insertCardSeparator, redrawCardEditor };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorInteractions });
})(globalThis);
