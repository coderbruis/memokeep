(function expose(root) {
  function createStartup({ window, state, hooks, shell, requestFrame, cancelFrame, setTimer, clearTimer }) {
    let scheduled = false, started = false, disposed = false, frame = null, timer = null;
    const protectClose = event => {
      if (!state.hasChanges() && !state.tabs.some(tab => tab.draftDocument && tab.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    function initialize() {
      if (started || disposed) return;
      started = true;
      shell.bind();
      hooks.applySidebar();
      hooks.bindings.forEach(bind => bind());
      hooks.bindInvite();
      state.loading = hooks.load();
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      window.addEventListener('beforeunload', protectClose);
      frame = requestFrame(() => { frame = null; timer = setTimer(initialize, 0); });
    }
    function dispose() {
      disposed = true;
      window.removeEventListener('beforeunload', protectClose);
      if (frame !== null) cancelFrame(frame);
      if (timer !== null) clearTimer(timer);
    }
    return { schedule, dispose };
  }
  const api = { createStartup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepBootstrap ||= {}, api);
})(globalThis);
