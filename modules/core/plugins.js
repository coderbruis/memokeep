(function exposePluginState(root) {
  const states = new Set(['on', 'off', 'none']);

  function stateOf(settings, manifest) {
    const saved = settings?.plugins?.[manifest.id];
    return states.has(saved) ? saved : states.has(manifest.defaultState) ? manifest.defaultState : 'none';
  }

  function isEnabled(settings, manifests, featureId) {
    const manifest = manifests.find(plugin => plugin.feature === featureId);
    return !manifest || stateOf(settings, manifest) === 'on';
  }

  function setState(settings, id, state) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new TypeError('Invalid plugin id');
    if (!states.has(state)) throw new TypeError('Invalid plugin state');
    return { ...settings, plugins: { ...settings?.plugins, [id]: state } };
  }

  function filter(manifests, { category = '全部', query = '' } = {}) {
    const search = String(query).trim().toLocaleLowerCase();
    return manifests.filter(plugin => (!category || category === '全部' || plugin.category === category)
      && (!search || `${plugin.name} ${plugin.brief}`.toLocaleLowerCase().includes(search)));
  }

  function navItems(settings, manifests) {
    const seen = new Set(Array.isArray(settings?.pluginsSeen) ? settings.pluginsSeen : []);
    return manifests.filter(plugin => plugin.nav && stateOf(settings, plugin) === 'on')
      .map(plugin => ({ ...plugin.nav, pluginId: plugin.id, isNew: Boolean(plugin.isNew && !seen.has(plugin.id)) }));
  }

  const api = { stateOf, isEnabled, setState, filter, navItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepPluginState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
