(function expose(root) {
  function createSaveCoordinator({ state, storage, normalize, patches, refresh, onError, onSyncError }) {
    const requests = [];
    let active = false;
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    // Preserve only edits made after a request started; the stored response remains the baseline.
    function rebase(before, after, saved) {
      if (equal(before, after)) return saved;
      if ([before, after, saved].every(Array.isArray) && [...before, ...after, ...saved].every(row => object(row) && typeof row.id === 'string')) {
        const previous = new Map(before.map(row => [row.id, row]));
        const next = new Map(after.map(row => [row.id, row]));
        const result = new Map(saved.map(row => [row.id, row]));
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
          if (equal(previous.get(id), next.get(id))) continue;
          if (!next.has(id)) result.delete(id);
          else result.set(id, rebase(previous.get(id), next.get(id), result.get(id)));
        }
        const order = equal(before.map(row => row.id), after.map(row => row.id)) ? [...result.keys()] : [...next.keys(), ...result.keys()];
        return [...new Set(order)].filter(id => result.has(id)).map(id => result.get(id));
      }
      if (object(before) && object(after) && object(saved)) {
        const result = { ...saved };
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (equal(before[key], after[key])) continue;
          if (!Object.hasOwn(after, key)) delete result[key];
          else Object.defineProperty(result, key, { value: rebase(before[key], after[key], saved[key]), enumerable: true, configurable: true, writable: true });
        }
        return result;
      }
      return structuredClone(after);
    }
    async function commit(change) {
      try {
        if (!state.ready) throw new Error('数据仍在加载，请稍后重试');
        const before = structuredClone(state.data);
        const proposal = normalize(structuredClone(before));
        // A declined command never publishes or persists its candidate.
        if (change && change(proposal) === false) return;
        const baseline = state.baseline;
        let saved;
        if (storage.supportsPatches) {
          const response = await storage.writeChanges(patches.createDataPatch(baseline, proposal), state.token);
          saved = response.patch ? patches.applyDataPatch(baseline, response.patch) : response.data;
          state.token = response.token;
        } else if (storage.isDesktop) saved = await storage.write(proposal, baseline);
        else saved = storage.write(proposal, baseline);
        state.data = normalize(rebase(before, state.data, saved));
        state.baseline = structuredClone(saved);
      } catch (error) {
        onError(error);
        throw error;
      } finally {
        state.saving = requests.length > 0;
      }
    }
    function drain() {
      if (active || !requests.length) return;
      active = true;
      const { change, resolve, reject } = requests.shift();
      commit(change).then(resolve, reject).finally(() => {
        active = false;
        drain();
        if (!active && !requests.length && state.refreshPending) Promise.resolve().then(refresh).catch(onSyncError);
      });
    }
    function enqueue(change) {
      if (!state.ready) return Promise.reject(new Error('数据仍在加载，请稍后重试'));
      state.saving = true;
      return new Promise((resolve, reject) => { requests.push({ change, resolve, reject }); drain(); });
    }
    function save(...args) {
      if (args.length) return Promise.reject(new Error('请使用 transact 提交业务修改'));
      return enqueue();
    }
    return { save, transact: change => enqueue(change) };
  }
  const api = { createSaveCoordinator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepPersistence ||= {}, api);
})(globalThis);
