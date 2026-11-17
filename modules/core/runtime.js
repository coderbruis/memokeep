(function exposeRuntime(root) {
  function createRuntime({ features = [], platform = {}, hasEntitlement = () => true } = {}) {
    const installed = new Map(features.map(feature => [feature.id, feature]));
    const commands = new Map();
    const available = id => {
      const feature = installed.get(id);
      return Boolean(feature && (!feature.service || typeof platform[feature.service] === 'function')
        && hasEntitlement(id));
    };
    return {
      available,
      registerCommand(id, { feature, enabled = () => true, execute }) {
        if (commands.has(id)) throw new Error(`Command already registered: ${id}`);
        const command = { feature, enabled, execute };
        commands.set(id, command);
        return () => { if (commands.get(id) === command) commands.delete(id); };
      },
      async execute(id, ...args) {
        const command = commands.get(id);
        if (!command || !available(command.feature) || !command.enabled()) return;
        return command.execute(...args);
      }
    };
  }
  const api = { createRuntime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
