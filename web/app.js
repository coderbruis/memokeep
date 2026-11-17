// The legacy boundary supplies live ports; migrated modules receive explicit dependencies.
const application = MemoKeepBootstrap.createApplication({
  modules: { state: MemoKeepState, persistence: MemoKeepPersistence, operations: MemoKeepApplication,
    editor: MemoKeepEditor, views: MemoKeepViews, domain: MemoKeepDomain },
  ports: applicationPorts
});
const applicationStartup = MemoKeepBootstrap.createStartup({
  window, state: applicationPorts.startupState, hooks: applicationPorts.startupHooks,
  shell: MemoKeepViews.createShellView({ ...applicationPorts.shell, state: applicationPorts.startupState }),
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => window.cancelAnimationFrame(id),
  setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: id => clearTimeout(id)
});
applicationStartup.schedule();
