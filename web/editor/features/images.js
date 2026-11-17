(function expose(root) {
  function createEditorImages({ state, config, actions, env, session, features }) {
    const findNoteImageReferenceRanges = value => {
      const references = [];
      const pattern = /!\[([^\]\n]*)\]\(memokeep-image:\/\/([0-9a-f-]{36})\)/gi;
      let match;
      while ((match = pattern.exec(value)) !== null) {
        references.push({
          name: match[1] || '图片',
          id: match[2].toLowerCase(),
          start: match.index,
          end: match.index + match[0].length,
          marker: match[0]
        });
      }
      return references;
    };

    const parseNoteImageReferences = value => features.findNoteImageReferenceRanges(value).map(reference => {
      const before = value.slice(0, reference.start);
      const lastLineBreak = before.lastIndexOf('\n');
      return {
        ...reference,
        lineIndex: (before.match(/\n/g) || []).length,
        startIndex: reference.start - lastLineBreak - 1
      };
    });

    const cardImageReferenceFragments = (lineIndex, startIndex, markerLength) => {
      features.syncEditorLayoutMirror();
      const textNode = session.layoutLineSpans[lineIndex]?.firstChild;
      if (!textNode) return [];
      const range = env.window.document.createRange();
      range.setStart(textNode, Math.min(startIndex, textNode.length));
      range.setEnd(textNode, Math.min(startIndex + markerLength, textNode.length));
      const canvasRect = session.canvas.getBoundingClientRect();
      return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({
        left: rect.left - canvasRect.left,
        top: rect.top - canvasRect.top - session.editor.scrollTop,
        width: rect.width,
        height: rect.height
      }));
    };

    const renderNoteImageTokens = async () => {
      const references = features.parseNoteImageReferences(session.editor.value);
      const nextSignature = references.map(reference => `${reference.id}\0${reference.name}\0${reference.lineIndex}\0${reference.startIndex}`).join('\n');
      if (nextSignature !== session.imageTokenSignature) {
        session.imageTokenSignature = nextSignature;
        session.imageTokenRevision += 1;
      }
      const revision = session.imageTokenRevision;
      if (!references.length) {
        session.imageTokenLayer.replaceChildren();
        return;
      }

      const resolved = await Promise.all(references.map(async reference => {
        if (!session.imagePreviewCache.has(reference.id)) {
          session.imagePreviewCache.set(reference.id, config.desktop?.readNoteImage
          ? config.desktop.readNoteImage(reference.id).catch(() => null)
          : Promise.resolve(null));
        }
        return { ...reference, image: await session.imagePreviewCache.get(reference.id) };
      }));
      if (revision !== session.imageTokenRevision || !features.isCurrentEditor()) return;

      const editorStyle = env.window.getComputedStyle(session.editor);
      const lineHeight = Number.parseFloat(editorStyle.lineHeight) || 28;
      session.textMeasureContext.font = `${editorStyle.fontWeight} ${editorStyle.fontSize} ${editorStyle.fontFamily}`;
      const referenceMasks = [];
      const tokens = resolved.map(({ id, name, image, lineIndex, startIndex, marker, end }) => {
        const content = image
        ? `<img src="${image.dataUrl}" alt="${actions.escapeHtml(name)}">`
        : '<span>图片不可用</span>';
        if (session.editorMode === 'card') {
          const fragments = features.cardImageReferenceFragments(lineIndex, startIndex, marker.length);
          if (!fragments.length) return '';
          // Cover only reference glyphs, including wrapped pieces. Keep surrounding
          // text and other image references in their original textarea positions.
          fragments.forEach(fragment => {
            referenceMasks.push(`<span class="note-image-reference-mask" aria-hidden="true" style="left:${fragment.left.toFixed(1)}px;top:${(fragment.top - 1).toFixed(1)}px;width:${fragment.width.toFixed(1)}px;height:${(fragment.height + 2).toFixed(1)}px"></span>`);
          });
          const anchor = fragments.find(fragment => fragment.width >= 88)
          || fragments.reduce((widest, fragment) => fragment.width > widest.width ? fragment : widest);
          const tokenWidth = Math.max(0, Math.min(anchor.width, session.canvas.clientWidth - anchor.left));
          const top = anchor.top + (anchor.height - 26) / 2;
          if (top + 26 < session.editor.offsetTop || top > session.editor.offsetTop + session.editor.clientHeight) return '';
          return `
          <div class="note-image-token is-wrapped-reference${image ? '' : ' is-missing'}${session.activeImageCaretId === id ? ' is-caret-active' : ''}" data-note-image-id="${id}" data-note-image-name="${actions.escapeHtml(name)}" data-note-image-file-name="${actions.escapeHtml(image?.fileName || name)}" data-note-image-end="${end}" data-note-image-caret="${end}" style="left:${anchor.left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${tokenWidth.toFixed(1)}px">
            <button type="button" class="note-image-thumb" data-note-image-action="preview" aria-label="放大预览" title="点击放大预览">${content}</button>
            <button type="button" class="note-image-continue" data-note-image-action="continue" aria-label="在图片后继续输入" title="在图片后继续输入"><span>继续输入</span></button>
          </div>`;
        }
        const line = session.editor.value.replace(/\r\n?/g, '\n').split('\n')[lineIndex] || '';
        const markerWidth = Math.max(46, session.textMeasureContext.measureText(marker).width + 4);
        const trailingText = line.slice(startIndex + marker.length);
        const hasTrailingText = Boolean(trailingText.trim());
        const trailingWidth = session.textMeasureContext.measureText(trailingText).width;
        const tokenWidth = Math.max(88, markerWidth + trailingWidth + 8);
        const continuationLabel = hasTrailingText ? actions.escapeHtml(trailingText) : '继续输入';
        const continuationCaret = end + trailingText.length;
        const markerStart = features.editorTextPoint(lineIndex, startIndex);
        if (!markerStart) return '';
        const left = markerStart.left;
        const top = markerStart.top + (lineHeight - 26) / 2 - session.editor.scrollTop;
        const visible = top > session.editor.offsetTop - 24 && top < session.editor.offsetTop + session.editor.clientHeight;
        if (!visible) return '';
        return `
        <div class="note-image-token${image ? '' : ' is-missing'}${session.activeImageCaretId === id ? ' is-caret-active' : ''}" data-note-image-id="${id}" data-note-image-name="${actions.escapeHtml(name)}" data-note-image-file-name="${actions.escapeHtml(image?.fileName || name)}" data-note-image-end="${end}" data-note-image-caret="${continuationCaret}" style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${tokenWidth.toFixed(1)}px">
          <button type="button" class="note-image-thumb" data-note-image-action="preview" aria-label="放大预览" title="点击放大预览">${content}</button>
          <button type="button" class="note-image-continue${hasTrailingText ? ' has-content' : ''}" data-note-image-action="continue" aria-label="在图片后继续输入" title="在图片后继续输入"><span>${continuationLabel}</span></button>
        </div>`;
      });
      // Draw all masks before controls so adjacent images cannot cover each other.
      session.imageTokenLayer.innerHTML = referenceMasks.join('') + tokens.join('');
    };

    const insertImageReferences = images => {
      const references = images.filter(Boolean).map(image => {
        const safeName = String(image.name || '图片').replace(/[\[\]\r\n]/g, ' ').trim() || '图片';
        return `![${safeName}](memokeep-image://${image.id})`;
      });
      if (!references.length) return;
      const value = session.editor.value;
      const start = session.contextSelectionStart;
      const end = session.contextSelectionEnd;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const prefix = before && !/\s$/.test(before) ? ' ' : '';
      const suffix = after && !/^\s/.test(after) ? ' ' : '';
      session.editor.setRangeText(`${prefix}${references.join(' ')}${suffix}`, start, end, 'end');
      session.editor.dispatchEvent(new env.Event('input', { bubbles: true }));
      session.editor.focus();
    };

    const chooseAndInsertImage = async () => {
      features.closeContextMenu();
      if (!config.desktop?.chooseNoteImage) {
        actions.showToast('当前环境不支持选择本地图片', true);
        return;
      }
      try {
        const image = await config.desktop.chooseNoteImage();
        if (!image) return;
        features.insertImageReferences([image]);
        actions.showToast('图片已插入笔记');
      } catch (error) {
        actions.showToast(`插入图片失败：${error.message}`, true);
      }
    };

    const closeImageLightbox = () => {
      session.imageLightbox.classList.add('hidden');
      config.$('#noteImageLightboxImage').removeAttribute('src');
      session.activeLightboxImageId = null;
      if (session.editorMode === 'note') session.richEditor?.focus();
      else session.editor.focus();
    };

    const openImageLightbox = token => {
      const image = token.querySelector('img');
      if (!image) {
        actions.showToast('图片文件不可用', true);
        return;
      }
      const previewName = token.dataset.noteImageFileName || token.dataset.noteImageName || '笔记图片';
      env.prepareNoteImagePreview(image, config.$('#noteImageLightboxImage'));
      config.$('#noteImageLightboxImage').src = image.src;
      config.$('#noteImageLightboxImage').alt = previewName;
      config.$('#noteImageLightboxCaption').textContent = previewName;
      session.activeLightboxImageId = token.dataset.noteImageId;
      session.imageLightbox.classList.remove('hidden');
      session.imagePreviewViewer.reset();
      session.imageLightbox.focus();
    };

    const persistRemovedImages = async imageIds => {
      session.latestSnapshot = features.captureSnapshot();
      features.refreshSaveState();
      imageIds.forEach(imageId => session.imagePreviewCache.delete(imageId));
    };

    const removeImageIdsFromEditor = imageIds => {
      const ids = [...new Set(imageIds)].filter(Boolean);
      if (!ids.length) return;
      if (ids.includes(session.activeImageCaretId)) session.activeImageCaretId = null;
      let nextValue = session.editor.value;
      ids.forEach(imageId => {
        const pattern = new RegExp(`!\\[[^\\]\\n]*\\]\\(memokeep-image:\\/\\/${imageId}\\)`, 'gi');
        nextValue = nextValue.replace(pattern, '');
      });
      session.editor.value = nextValue
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n');
      features.closeImageLightbox();
      session.editor.dispatchEvent(new env.Event('input', { bubbles: true }));
      features.persistRemovedImages(ids);
    };

    const handleAtomicImageDelete = event => {
      if (!['Backspace', 'Delete'].includes(event.key) || event.isComposing) return false;
      const selectionStart = session.editor.selectionStart;
      const selectionEnd = session.editor.selectionEnd;
      const isCollapsed = selectionStart === selectionEnd;
      const references = features.findNoteImageReferenceRanges(session.editor.value);
      const affected = references.filter(reference => {
        if (!isCollapsed) return reference.start < selectionEnd && reference.end > selectionStart;
        return event.key === 'Backspace'
        ? selectionStart > reference.start && selectionStart <= reference.end
        : selectionStart >= reference.start && selectionStart < reference.end;
      });
      if (!affected.length) return false;

      event.preventDefault();
      const removeStart = Math.min(selectionStart, ...affected.map(reference => reference.start));
      const removeEnd = Math.max(selectionEnd, ...affected.map(reference => reference.end));
      session.editor.setRangeText('', removeStart, removeEnd, 'end');
      session.editor.dispatchEvent(new env.Event('input', { bubbles: true }));
      features.persistRemovedImages(affected.map(reference => reference.id));
      return true;
    };
    return { findNoteImageReferenceRanges, parseNoteImageReferences, cardImageReferenceFragments, renderNoteImageTokens, insertImageReferences, chooseAndInsertImage, closeImageLightbox, openImageLightbox, persistRemovedImages, removeImageIdsFromEditor, handleAtomicImageDelete };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorImages });
})(globalThis);
