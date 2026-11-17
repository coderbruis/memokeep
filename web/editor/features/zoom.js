(function expose(root) {
  function createEditorZoom({ state, config, actions, env, session, features }) {
    const setEditorImmersive = enabled => {
      const immersive = Boolean(enabled && !config.isNoteWindow);
      config.$('#librariesView').classList.toggle('card-editor-immersive', immersive);
      features.closeCommandMenu();
      features.closeContextMenu();
      session.selectionCards?.hide();
      if (session.editorMode === 'card') features.redrawCardEditor();
    };

    const normalizeCardZoom = value => {
      const number = value === null || String(value).trim() === '' ? config.CARD_EDITOR_ZOOM_DEFAULT : Number(value);
      return Number.isFinite(number)
      ? Math.max(config.CARD_EDITOR_ZOOM_MIN, Math.min(config.CARD_EDITOR_ZOOM_MAX, Math.round(number / config.CARD_EDITOR_ZOOM_STEP) * config.CARD_EDITOR_ZOOM_STEP))
      : config.CARD_EDITOR_ZOOM_DEFAULT;
    };

    const applyCardZoom = (value, persist = true) => {
      session.cardEditorZoom = features.normalizeCardZoom(value);
      session.editorRoot.style.setProperty('--card-editor-scale', session.cardEditorZoom / 100 * config.CARD_EDITOR_ZOOM_BASE_SCALE);
      config.$('#cardEditorZoomOut').disabled = session.cardEditorZoom === config.CARD_EDITOR_ZOOM_MIN;
      config.$('#cardEditorZoomIn').disabled = session.cardEditorZoom === config.CARD_EDITOR_ZOOM_MAX;
      const reset = config.$('#cardEditorZoomReset');
      reset.querySelector('span').textContent = `${session.cardEditorZoom}%`;
      reset.setAttribute('aria-label', `当前缩放 ${session.cardEditorZoom}%，点击恢复默认`);
      if (persist) {
        try { env.localStorage.setItem(config.CARD_EDITOR_ZOOM_KEY, String(session.cardEditorZoom)); } catch { /* Keep zoom usable if storage is unavailable. */ }
      }
      if (session.editorMode === 'card') {
        features.closeCommandMenu();
        features.closeContextMenu();
        features.redrawCardEditor();
      }
    };

    const canZoomCardEditor = () => features.isCurrentEditor() && session.editorMode === 'card'
    && !session.editorRoot.closest('.view')?.classList.contains('hidden')
    && !env.window.document.querySelector('dialog[open]')
    && session.previewOverlay.classList.contains('hidden') && session.imageLightbox.classList.contains('hidden');

    const handleCardZoomShortcut = event => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || !features.canZoomCardEditor()) return;
      const direction = ['+', '='].includes(event.key) ? 1 : event.key === '-' ? -1 : 0;
      if (!direction && event.key !== '0') return;
      event.preventDefault();
      features.applyCardZoom(direction ? session.cardEditorZoom + direction * config.CARD_EDITOR_ZOOM_STEP : config.CARD_EDITOR_ZOOM_DEFAULT);
    };

    const handleCardZoomWheel = event => {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey) || !features.canZoomCardEditor()) return;
      event.preventDefault();
      if (!event.deltaY) return;
      const now = env.performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? session.editor.clientHeight : 1);
      if (now - session.zoomWheelTime > 180 || Math.sign(delta) !== Math.sign(session.zoomWheelDelta)) session.zoomWheelDelta = 0;
      session.zoomWheelTime = now;
      session.zoomWheelDelta += delta;
      const steps = Math.trunc(session.zoomWheelDelta / 60);
      if (!steps) return;
      session.zoomWheelDelta -= steps * 60;
      features.applyCardZoom(session.cardEditorZoom - steps * config.CARD_EDITOR_ZOOM_STEP);
    };

    const handleCardZoomStorage = event => {
      if (event.storageArea === env.localStorage && (event.key === config.CARD_EDITOR_ZOOM_KEY || event.key === null)) features.applyCardZoom(event.newValue, false);
    };
    return { setEditorImmersive, normalizeCardZoom, applyCardZoom, canZoomCardEditor, handleCardZoomShortcut, handleCardZoomWheel, handleCardZoomStorage };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorZoom });
})(globalThis);
