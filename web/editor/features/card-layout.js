(function expose(root) {
  function createEditorCardLayout({ state, config, actions, env, session, features }) {
    const syncEditorLayoutMirror = () => {
      const editorStyle = env.window.getComputedStyle(session.editor);
      const signature = [
        session.editor.value,
        session.editor.clientWidth,
        editorStyle.font,
        editorStyle.lineHeight,
        editorStyle.letterSpacing,
        editorStyle.paddingLeft,
        editorStyle.paddingRight,
        editorStyle.tabSize,
        session.editor.offsetLeft,
        session.editor.offsetTop
      ].join('\0');
      if (signature === session.layoutSignature) return;

      session.layoutSignature = signature;
      session.layoutLines = session.editor.value.replace(/\r\n?/g, '\n').split('\n');
      session.layoutMirror.style.left = `${session.editor.offsetLeft}px`;
      session.layoutMirror.style.top = `${session.editor.offsetTop}px`;
      session.layoutMirror.style.width = `${session.editor.clientWidth}px`;
      session.layoutMirror.style.font = editorStyle.font;
      session.layoutMirror.style.lineHeight = editorStyle.lineHeight;
      session.layoutMirror.style.letterSpacing = editorStyle.letterSpacing;
      session.layoutMirror.style.paddingLeft = editorStyle.paddingLeft;
      session.layoutMirror.style.paddingRight = editorStyle.paddingRight;
      session.layoutMirror.style.tabSize = editorStyle.tabSize;
      session.layoutMirror.replaceChildren();
      session.layoutLineSpans = session.layoutLines.map((line, index) => {
        const span = env.window.document.createElement('span');
        span.className = 'note-layout-line';
        span.textContent = line || '\u200b';
        session.layoutMirror.append(span);
        if (index < session.layoutLines.length - 1) session.layoutMirror.append(env.window.document.createElement('br'));
        return span;
      });
    };

    const editorTextPoint = (lineIndex, characterIndex = 0) => {
      features.syncEditorLayoutMirror();
      const span = session.layoutLineSpans[lineIndex];
      const textNode = span?.firstChild;
      if (!span || !textNode) return null;
      const range = env.window.document.createRange();
      const offset = Math.min(characterIndex, session.layoutLines[lineIndex]?.length || 0);
      range.setStart(textNode, offset);
      range.collapse(true);
      const rangeRect = range.getBoundingClientRect();
      const canvasRect = session.canvas.getBoundingClientRect();
      const editorStyle = env.window.getComputedStyle(session.editor);
      const lineHeight = Number.parseFloat(editorStyle.lineHeight) || 28;
      const glyphHeight = rangeRect.height || Number.parseFloat(editorStyle.fontSize) || 14;
      const leading = Math.max(0, (lineHeight - glyphHeight) / 2);
      return {
        left: rangeRect.left - canvasRect.left,
        top: rangeRect.top - canvasRect.top - leading
      };
    };

    const renderLineBullets = () => {
      // 笔记模式下卡片编辑区是隐藏的：不去量它，省掉几次整页排版。切到卡片模式时尺寸变化会触发重画。
      if (session.editorMode !== 'card') return;
      features.syncEditorLayoutMirror();
      const mirrorRect = session.layoutMirror.getBoundingClientRect();
      const lineHeight = Number.parseFloat(env.window.getComputedStyle(session.editor).lineHeight) || 28;
      const activeLineIndex = (session.editor.value.slice(0, session.editor.selectionStart).match(/\n/g) || []).length;
      session.bulletGutter.innerHTML = session.layoutLineSpans.map((span, lineIndex) => {
        const spanRect = span.getClientRects()[0];
        const glyphHeight = spanRect?.height || lineHeight;
        const leading = Math.max(0, (lineHeight - glyphHeight) / 2);
        const lineTop = (spanRect?.top || mirrorRect.top) - mirrorRect.top - leading;
        const showMarker = Boolean(session.layoutLines[lineIndex]?.trim()) || lineIndex === activeLineIndex;
        return `<span${showMarker ? '' : ' class="no-marker"'} style="top:${lineTop.toFixed(1)}px"></span>`;
      }).join('');
    };

    const renderCardEditorLayout = () => {
      if (session.editorMode !== 'card') return;
      features.syncEditorLayoutMirror();
      const count = env.application.domain.parseInlineCards(session.editor.value).length;
      const countLabel = config.$('#cardEditorCount');
      if (countLabel.textContent !== `${count} 张卡片`) countLabel.textContent = `${count} 张卡片`;
      const contentHeight = session.layoutMirror.getBoundingClientRect().height;
      const minimumHeight = Number.parseFloat(env.window.getComputedStyle(session.editor).minHeight) || 208;
      const height = Math.max(minimumHeight, Math.ceil(contentHeight + 72));
      if (session.editor.style.height !== `${height}px`) session.editor.style.height = `${height}px`;
      const hint = config.$('#cardEditorHint');
      hint.hidden = !session.editor.value.trim();
      hint.style.top = `${session.editor.offsetTop + contentHeight + 18}px`;
    };

    const activeInlineCardLine = () => {
      if (session.hoveredInlineCardLine !== null) return session.hoveredInlineCardLine;
      if (env.window.document.activeElement === session.editor) {
        return (session.editor.value.slice(0, session.editor.selectionStart).match(/\n/g) || []).length;
      }
      const focusedToken = env.window.document.activeElement?.closest?.('[data-inline-card-line]');
      return focusedToken ? Number(focusedToken.dataset.inlineCardLine) : null;
    };

    const renderInlineCardHover = () => {
      const activeLine = features.activeInlineCardLine();
      session.tokenLayer.querySelectorAll('[data-inline-card-line]').forEach(button => {
        button.classList.toggle('is-line-hovered', activeLine !== null && Number(button.dataset.inlineCardLine) === activeLine);
      });
      const bounds = activeLine === null ? null : features.inlineCardRowBounds(activeLine);
      if (!bounds) {
        session.hoverLayer.replaceChildren();
        return;
      }
      const horizontalInset = session.editor.offsetLeft + Number.parseFloat(env.window.getComputedStyle(session.editor).paddingLeft) - 12;
      const width = Math.max(0, session.editor.offsetLeft + session.editor.clientWidth - horizontalInset);
      session.hoverLayer.innerHTML = `
      <span class="inline-card-hover-content" style="left:${horizontalInset.toFixed(1)}px;top:${bounds.top.toFixed(1)}px;width:${width.toFixed(1)}px;height:${bounds.height.toFixed(1)}px"></span>`;
    };

    const renderInlineCardTokens = () => {
      if (session.editorMode !== 'card') return;
      const editorStyle = env.window.getComputedStyle(session.editor);
      const lineHeight = Number.parseFloat(editorStyle.lineHeight) || 28;
      session.textMeasureContext.font = `${editorStyle.fontWeight} ${editorStyle.fontSize} ${editorStyle.fontFamily}`;

      const tokenButtons = [];
      let inCodeBlock = false;
      session.editor.value.replace(/\r\n?/g, '\n').split('\n').forEach((line, lineIndex) => {
        if (line.trim().startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          return;
        }
        if (inCodeBlock) return;

        const parsed = env.application.domain.parseInlineCardLine(line);
        if (!parsed) return;

        const tokenScale = session.editorMode === 'card' ? session.cardEditorZoom / 100 * config.CARD_EDITOR_ZOOM_BASE_SCALE : 1;
        const tokenWidth = 32 * tokenScale;
        const tokenHeight = 26 * tokenScale;
        const separatorStart = features.editorTextPoint(lineIndex, parsed.separatorIndex);
        const separatorEnd = features.editorTextPoint(lineIndex, parsed.separatorIndex + parsed.separator.length);
        if (!separatorStart || !separatorEnd) return;
        const separatorCenter = separatorStart.top === separatorEnd.top
        ? (separatorStart.left + separatorEnd.left) / 2
        : separatorStart.left + session.textMeasureContext.measureText(parsed.separator).width / 2;
        const left = separatorCenter - tokenWidth / 2;
        const top = separatorStart.top + (lineHeight - tokenHeight) / 2 - session.editor.scrollTop;
        const previewSize = 28;
        const actionGap = 3;
        const actionButtonsWidth = previewSize * 4 + actionGap * 3;
        const maximumLeft = session.editor.offsetLeft + session.editor.clientWidth - actionButtonsWidth - 6;
        const previewLeft = maximumLeft;
        const copyLeft = previewLeft + previewSize + actionGap;
        const previewTop = separatorStart.top
        + (lineHeight - previewSize) / 2
        - session.editor.scrollTop;
        const copyTop = previewTop;

        const isVerticallyVisible = top > session.editor.offsetTop - 24
        && top < session.editor.offsetTop + session.editor.clientHeight;
        if (!isVerticallyVisible) return;

        tokenButtons.push(`
        <button
          type="button"
          class="inline-card-token"
          data-inline-card-line="${lineIndex}"
          title="预览这张记忆卡片"
          aria-label="预览这张记忆卡片"
          style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px"
        >-&gt;</button>
        <button
          type="button"
          class="inline-card-row-action inline-card-row-preview${session.hoveredInlineCardLine === lineIndex ? ' is-line-hovered' : ''}"
          data-inline-card-line="${lineIndex}"
          data-inline-card-action="preview"
          data-tooltip="预览卡片"
          aria-label="预览这张记忆卡片"
          style="left:${previewLeft.toFixed(1)}px;top:${previewTop.toFixed(1)}px"
        ><svg aria-hidden="true"><use href="#icon-eye"></use></svg></button>
        <button
          type="button"
          class="inline-card-row-action inline-card-row-copy${session.hoveredInlineCardLine === lineIndex ? ' is-line-hovered' : ''}"
          data-inline-card-line="${lineIndex}"
          data-inline-card-action="copy"
          data-tooltip="复制卡片"
          aria-label="复制这张记忆卡片"
          style="left:${copyLeft.toFixed(1)}px;top:${copyTop.toFixed(1)}px"
        ><svg aria-hidden="true"><use href="#icon-copy"></use></svg></button>
        <button type="button" class="inline-card-row-action inline-card-row-tags${session.hoveredInlineCardLine === lineIndex ? ' is-line-hovered' : ''}" data-inline-card-line="${lineIndex}" data-inline-card-action="tags" aria-label="管理此卡片标签" data-tooltip="添加标签" style="left:${(copyLeft + previewSize + actionGap).toFixed(1)}px;top:${copyTop.toFixed(1)}px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/></svg></button>
        <button type="button" class="inline-card-row-action inline-card-row-delete${session.hoveredInlineCardLine === lineIndex ? ' is-line-hovered' : ''}" data-inline-card-line="${lineIndex}" data-inline-card-action="delete" aria-label="删除整张卡片" data-tooltip="删除卡片" style="left:${(copyLeft + 2 * (previewSize + actionGap)).toFixed(1)}px;top:${copyTop.toFixed(1)}px"><svg aria-hidden="true"><use href="#icon-trash"></use></svg></button>`);
      });

      session.tokenLayer.innerHTML = tokenButtons.join('');
      features.renderInlineCardHover();
    };

    const setHoveredInlineCardLine = lineIndex => {
      session.hoveredInlineCardLine = lineIndex;
      features.renderInlineCardHover();
    };

    const updateInlineCardRowHover = event => {
      features.syncEditorLayoutMirror();
      const canvasRect = session.canvas.getBoundingClientRect();
      const pointerY = event.clientY - canvasRect.top;
      const hoveredLine = session.layoutLineSpans.findIndex((_, lineIndex) => {
        const bounds = features.inlineCardRowBounds(lineIndex);
        return bounds && pointerY >= bounds.top && pointerY <= bounds.bottom;
      });
      features.setHoveredInlineCardLine(hoveredLine >= 0 ? hoveredLine : null);
    };

    const scheduleInlineCardHoverClear = () => {
      env.clearTimeout(session.cardHoverClearTimer);
      session.cardHoverClearTimer = env.setTimeout(() => features.setHoveredInlineCardLine(null), 80);
    };
    return { syncEditorLayoutMirror, editorTextPoint, renderLineBullets, renderCardEditorLayout, activeInlineCardLine, renderInlineCardHover, renderInlineCardTokens, setHoveredInlineCardLine, updateInlineCardRowHover, scheduleInlineCardHoverClear };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorCardLayout });
})(globalThis);
