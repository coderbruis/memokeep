(function expose(root) {
  function createStorageAdapter({ desktop, localStorage, storageKey, eventTarget, mergeWindowData }) {
    return {
      get isDesktop() { return Boolean(desktop); },
      get supportsPatches() { return Boolean(desktop?.writeChanges); },
      get supportsReadChanges() { return Boolean(desktop?.readChanges); },
      get supportsEditingPreferences() { return Boolean(desktop?.readEditingPreferences); },
      read(empty = '{}') {
        return desktop ? desktop.read() : JSON.parse(localStorage.getItem(storageKey) || empty);
      },
      write(data, baseline) {
        if (desktop) return desktop.write(data, baseline);
        const saved = mergeWindowData(baseline, data, JSON.parse(localStorage.getItem(storageKey) || '{}'));
        localStorage.setItem(storageKey, JSON.stringify(saved));
        return saved;
      },
      writeChanges(patch, token) { return desktop.writeChanges(patch, token); },
      readChanges(token) { return desktop.readChanges(token); },
      readEditingPreferences() { return desktop.readEditingPreferences(); },
      subscribe(callback) {
        if (desktop) return desktop.onDataChanged(callback);
        const listener = event => { if (event.key === storageKey) callback(); };
        eventTarget.addEventListener('storage', listener);
        return () => eventTarget.removeEventListener('storage', listener);
      }
    };
  }
  const api = { createStorageAdapter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepPersistence ||= {}, api);
})(globalThis);
