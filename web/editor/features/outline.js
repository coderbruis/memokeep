(function expose(root) {
  function createEditorOutline({ state, config, actions, env, session, features }) {
    const setOutlinePreview = visible => {
      env.clearTimeout(session.outlineCloseTimer);
      if (session.outlinePinned) return;
      session.richWorkspace.classList.toggle('is-outline-preview', Boolean(visible));
    };

    const scheduleOutlineClose = () => {
      env.clearTimeout(session.outlineCloseTimer);
      if (session.outlinePinned) return;
      session.outlineCloseTimer = env.setTimeout(() => features.setOutlinePreview(false), 140);
    };

    const positionOutlineHoverTarget = () => {
      session.outlinePositionFrame = null;
      if (!session.noteScrollViewport || !session.richWorkspace.isConnected || !session.outlineHoverTarget.isConnected) return;
      const workspaceRect = session.richWorkspace.getBoundingClientRect();
      const viewportRect = session.noteScrollViewport.getBoundingClientRect();
      const scrollRange = session.noteScrollViewport.scrollHeight - session.noteScrollViewport.clientHeight;
      session.backToTopButton.hidden = session.editorMode !== 'note' || scrollRange <= 0 || session.noteScrollViewport.scrollTop <= scrollRange * 0.5;
      session.backToTopButton.style.right = `${Math.max(18, env.window.innerWidth - viewportRect.right + 24)}px`;
      session.backToTopButton.style.bottom = `${Math.max(78, env.window.innerHeight - viewportRect.bottom + 24)}px`;
      const toolbarRect = session.richToolbar.getBoundingClientRect();
      // Reading hides the formatting toolbar, but the sticky tab bar remains visible.
      const tabsRect = session.noteScrollViewport.querySelector('.note-tabs-bar')?.getBoundingClientRect();
      const preferredViewportTop = Math.max(viewportRect.top, toolbarRect.bottom, tabsRect?.bottom || 0) + 18;
      const minTop = 18;
      const maxTop = Math.max(minTop, workspaceRect.height - session.outlineHoverTarget.offsetHeight - 18);
      const nextTop = Math.max(minTop, Math.min(maxTop, preferredViewportTop - workspaceRect.top));
      const roundedTop = Math.round(nextTop);
      const visibleBottom = viewportRect.bottom - 18;
      const outlineListHeight = Math.max(120, visibleBottom - preferredViewportTop - 48);
      session.outlineHoverTarget.style.top = `${roundedTop}px`;
      if (!session.outlinePinned) session.outlinePanel.style.setProperty('--note-outline-content-top', `${roundedTop}px`);
      session.outlinePanel.style.setProperty('--note-outline-sticky-top', `${Math.round(preferredViewportTop - viewportRect.top)}px`);
      session.outlinePanel.style.setProperty('--note-outline-list-height', `${Math.round(outlineListHeight)}px`);
    };

    const scheduleOutlineHoverTargetPosition = () => {
      if (session.outlinePositionFrame !== null) return;
      session.outlinePositionFrame = env.window.requestAnimationFrame(features.positionOutlineHoverTarget);
    };

    const setOutlinePinned = pinned => {
      session.outlinePinned = Boolean(pinned);
      env.clearTimeout(session.outlineCloseTimer);
      session.richWorkspace.classList.toggle('is-outline-pinned', session.outlinePinned);
      session.richWorkspace.classList.toggle('is-outline-preview', !session.outlinePinned);
      session.outlinePin.classList.toggle('active', session.outlinePinned);
      session.outlinePin.setAttribute('aria-pressed', String(session.outlinePinned));
      session.outlinePin.setAttribute('aria-label', session.outlinePinned ? '取消固定大纲' : '固定大纲');
      session.outlinePin.title = session.outlinePinned ? '取消固定大纲' : '固定大纲';
      env.localStorage.setItem(config.NOTE_OUTLINE_PINNED_KEY, String(session.outlinePinned));
      features.positionOutlineHoverTarget();
    };

    const updateActiveOutlineItem = () => {
      if (!session.richEditor) return;
      const range = session.richEditor.getSelection();
      if (!range) return;
      const headings = [...session.richEditor.root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(heading => heading.textContent.trim());
      let activeIndex = -1;
      headings.forEach((heading, index) => {
        const blot = env.window.Quill.find(heading);
        if (blot && session.richEditor.getIndex(blot) <= range.index) activeIndex = index;
      });
      session.outlineList.querySelectorAll('[data-outline-index]').forEach(button => {
        button.parentElement.classList.toggle('active', Number(button.dataset.outlineIndex) === activeIndex);
      });
    };

    const renderNoteOutline = () => {
      if (!session.richEditor) return;
      const headings = [...session.richEditor.root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(heading => heading.textContent.trim());
      session.outlineList.replaceChildren();
      if (!headings.length) {
        const empty = env.window.document.createElement('p');
        empty.className = 'note-outline-empty';
        empty.textContent = '添加标题后，将自动生成目录';
        session.outlineList.append(empty);
        return;
      }
      let hiddenBelowLevel = null;
      headings.forEach((heading, index) => {
        const level = Number(heading.tagName.slice(1));
        if (hiddenBelowLevel !== null && level > hiddenBelowLevel) return;
        hiddenBelowLevel = null;
        const hasChildren = Number(headings[index + 1]?.tagName.slice(1)) > level;
        const collapsed = hasChildren && session.collapsedOutlineHeadings.has(heading);
        if (collapsed) hiddenBelowLevel = level;
        const row = env.window.document.createElement('div');
        row.className = `note-outline-item level-${level}`;
        if (hasChildren) {
          const toggle = env.window.document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'note-outline-toggle';
          toggle.setAttribute('aria-expanded', String(!collapsed));
          toggle.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}「${heading.textContent.trim()}」的子标题`);
          toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
          toggle.onclick = () => {
            if (collapsed) session.collapsedOutlineHeadings.delete(heading);
            else session.collapsedOutlineHeadings.add(heading);
            const scrollTop = session.outlineList.scrollTop;
            features.renderNoteOutline();
            session.outlineList.scrollTop = scrollTop;
            session.outlineList.querySelector(`[data-outline-index="${index}"]`)?.previousElementSibling?.focus({ preventScroll: true });
          };
          row.append(toggle);
        } else {
          const spacer = env.window.document.createElement('span');
          spacer.className = 'note-outline-spacer';
          row.append(spacer);
        }
        const button = env.window.document.createElement('button');
        button.type = 'button';
        button.className = 'note-outline-link';
        button.dataset.outlineIndex = String(index);
        button.textContent = heading.textContent.trim();
        button.title = heading.textContent.trim();
        row.append(button);
        session.outlineList.append(row);
      });
      features.updateActiveOutlineItem();
    };
    return { setOutlinePreview, scheduleOutlineClose, positionOutlineHoverTarget, scheduleOutlineHoverTargetPosition, setOutlinePinned, updateActiveOutlineItem, renderNoteOutline };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorOutline });
})(globalThis);
