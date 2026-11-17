(function expose(root) {
  function createEditorCardPreview({ state, config, actions, env, session, features }) {
    const stopPreviewDrag = () => {
      const pointerId = session.previewDrag?.pointerId;
      session.previewDrag = null;
      session.previewHead.classList.remove('is-dragging');
      if (pointerId !== undefined && session.previewHead.hasPointerCapture(pointerId)) {
        session.previewHead.releasePointerCapture(pointerId);
      }
    };

    const moveCardPreview = (left, top) => {
      const editorRoot = config.$('#inlineMarkdownNoteForm');
      const rootRect = editorRoot.getBoundingClientRect();
      const minLeft = Math.max(12, 12 - rootRect.left);
      const minTop = Math.max(64, 12 - rootRect.top);
      const right = Math.min(rootRect.right, env.window.innerWidth) - rootRect.left - 12;
      const bottom = Math.min(rootRect.bottom, env.window.innerHeight) - rootRect.top - 12;
      session.previewOverlay.style.maxWidth = `${Math.max(0, right - minLeft)}px`;
      session.previewOverlay.style.maxHeight = `${Math.max(0, bottom - minTop)}px`;
      const rect = session.previewOverlay.getBoundingClientRect();
      session.previewOverlay.style.right = 'auto';
      session.previewOverlay.style.left = `${Math.max(minLeft, Math.min(left, right - rect.width))}px`;
      session.previewOverlay.style.top = `${Math.max(minTop, Math.min(top, bottom - rect.height))}px`;
    };

    const clampCardPreview = () => {
      if (session.previewOverlay.classList.contains('hidden')) return;
      features.moveCardPreview(parseFloat(session.previewOverlay.style.left) || 12, parseFloat(session.previewOverlay.style.top) || 64);
    };

    const closeCardPreview = () => {
      features.stopPreviewDrag();
      session.previewOverlay.classList.add('hidden');
    };

    const positionCardPreview = anchorToken => {
      const rootRect = config.$('#inlineMarkdownNoteForm').getBoundingClientRect();
      // Keep the preview centered in the editor so it does not cover the outline
      // or hug the right edge on wide windows. It remains clamped to the viewport.
      const left = Math.max(12, (rootRect.width - session.previewOverlay.offsetWidth) / 2);
      const top = Math.max(64, (rootRect.height - session.previewOverlay.offsetHeight) / 2);
      features.moveCardPreview(left, top);
    };

    const openCardPreview = (lineIndex, anchorToken) => {
      const sourceLine = session.editor.value.replace(/\r\n?/g, '\n').split('\n')[lineIndex] || '';
      const parsed = env.application.domain.parseInlineCardLine(sourceLine);
      if (!parsed) return;

      const hasAnswer = Boolean(parsed.answer);
      config.$('#inlineCardPreviewQuestion').textContent = parsed.question || '未填写问题';
      config.$('#inlineCardPreviewSource').textContent = `来源：${config.$('#inlineMarkdownNoteTitle').value.trim() || session.target?.title || '未命名笔记'}`;
      config.$('#inlineCardPreviewAnswerArea').hidden = true;
      config.$('#inlineCardPreviewAnswer').textContent = '';
      config.$('#inlineCardPreviewAnswer').classList.remove('revealed');
      config.$('#copyInlineCardAnswer').disabled = true;
      config.$('#copyInlineCardAnswer').dataset.answer = parsed.answer;
      config.$('#inlineCardPreviewHintText').textContent = hasAnswer
      ? '先尝试在心里回答，再显示答案。'
      : '这张卡片还缺少答案，请在箭头后继续输入。';
      config.$('#revealInlineCardAnswer').disabled = !hasAnswer;
      config.$('#revealInlineCardAnswerLabel').textContent = hasAnswer
      ? '我已尝试回忆 · 显示答案'
      : '请先补充答案';
      config.$('#revealInlineCardAnswerIcon').setAttribute('href', '#icon-eye');
      config.$('#revealInlineCardAnswer').dataset.answer = parsed.answer;
      session.previewOverlay.classList.remove('hidden');
      session.previewOverlay.scrollTop = 0;
      features.positionCardPreview(anchorToken);
      config.$('#closeInlineCardPreview').focus();
    };
    return { stopPreviewDrag, moveCardPreview, clampCardPreview, closeCardPreview, positionCardPreview, openCardPreview };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorCardPreview });
})(globalThis);
