(function expose(root) {
  // A note transaction copies only objects it actually changes. Unchanged bodies stay shared.
  function createRecordDraft(source) {
    const nodes = new WeakMap(), assigned = new WeakSet(), touched = new Set();
    function touch(node, name) { let field = name; for (let current = node; current.parent; current = current.parent) field = current.key; touched.add(field); }
    function create(value, parent, key) {
      const node = { value, copy: null, parent, key, children: new Map() };
      function changed() {
        if (node.copy) return;
        node.copy = Array.isArray(value) ? value.slice() : { ...value };
        if (parent) { parent.changed(); parent.copy[key] = node.proxy; }
      }
      node.changed = changed;
      node.proxy = new Proxy(value, {
        get(_, name) {
          const entry = (node.copy || value)[name];
          if (!entry || typeof entry !== 'object') return entry;
          const child = node.children.get(name);
          if (child?.value === entry || child?.proxy === entry) return child.proxy;
          const next = create(entry, node, name); node.children.set(name, next); return next.proxy;
        },
        set(_, name, entry) {
          touch(node, name);
          if ((node.copy || value)[name] === entry) return true;
          changed();
          if (entry && typeof entry === 'object') {
            // A derived metadata/history container must be plain before later reads
            // wrap it again. Existing untouched draft records retain their originals.
            if (!nodes.has(entry)) assigned.add(entry);
            entry = finish(entry, true);
            assigned.add(entry);
          }
          node.copy[name] = entry; node.children.delete(name); return true;
        },
        deleteProperty(_, name) { touch(node, name); if (Object.hasOwn(node.copy || value, name)) { changed(); delete node.copy[name]; node.children.delete(name); } return true; },
        ownKeys: () => Reflect.ownKeys(node.copy || value),
        has: (_, name) => name in (node.copy || value),
        getOwnPropertyDescriptor: (_, name) => Object.getOwnPropertyDescriptor(node.copy || value, name),
      });
      nodes.set(node.proxy, node); return node;
    }
    function finish(value, nested = false) {
      const node = value && typeof value === 'object' ? nodes.get(value) : null;
      if (!node) {
        if (value && typeof value === 'object' && (nested || assigned.has(value))) {
          const result = Array.isArray(value) ? value.slice() : { ...value };
          for (const key of Object.keys(result)) result[key] = finish(result[key], true);
          return result;
        }
        return value;
      }
      // A newly assigned container may be read again and wrapped without a write.
      // Its nested history can still contain earlier draft views, so materialize that
      // container while keeping untouched original records shared.
      if (!node.copy) return assigned.has(node.value) ? finish(node.value, true) : node.value;
      for (const key of Object.keys(node.copy)) node.copy[key] = finish(node.copy[key]);
      return node.copy;
    }
    const node = create(source);
    return { draft: node.proxy, finish: () => finish(node.proxy), touched };
  }
  function createSaveCoordinator({ state, storage, normalize, patches, refresh, onError, onSyncError }) {
    const requests = [];
    let active = false;
    const equal = patches?.stateValuesEqual || ((a, b) => a === b || JSON.stringify(a) === JSON.stringify(b));
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
    function slices(source, patch) {
      return Object.fromEntries(patch.fields.map(field => [field.key, field.kind === 'entities'
        ? (source[field.key] || []).filter(row => field.changes.some(change => change.id === row.id)) : source[field.key]]));
    }
    function installSlices(source, values, patch) {
      const next = { ...source };
      for (const field of patch.fields) {
        if (field.kind !== 'entities') { if (Object.hasOwn(values, field.key)) next[field.key] = values[field.key]; else delete next[field.key]; continue; }
        const ids = new Set(field.changes.map(row => row.id)), rows = new Map((values[field.key] || []).map(row => [row.id, row]));
        next[field.key] = (source[field.key] || []).flatMap(row => {
          if (!ids.has(row.id)) return [row];
          const updated = rows.get(row.id); rows.delete(row.id); return updated ? [updated] : [];
        }).concat([...rows.values()]);
      }
      return next;
    }
    async function commitRecord(change, context) {
      const before = state.data, draft = createRecordDraft(before);
      if (change(draft.draft) === false) return;
      const proposal = draft.finish();
      let delta = patches.createDataPatch(before, proposal);
      if (!delta.fields.length && draft.touched.size) {
        const selected = source => Object.fromEntries([...draft.touched].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
        // A same-value save can be persisting edits typed during the preceding async save.
        delta = patches.createDataPatch(selected(state.baseline), selected(proposal));
      }
      if (!delta.fields.length) return;
      // Only changed records cross the asynchronous boundary; later typing cannot mutate this request.
      const started = structuredClone(slices(before, delta));
      for (const field of delta.fields) {
        if (field.kind === 'entities') for (const row of field.changes) row.before = (state.baseline[field.key] || []).find(value => value.id === row.id);
        else field.before = state.baseline[field.key];
      }
      const request = structuredClone(delta), baseline = state.baseline;
      const response = await storage.writeChanges(request, state.token, typeof context === 'function' ? context() : context);
      const saved = response.patch ? patches.applyDataPatch(baseline, response.patch) : response.data;
      const live = slices(state.data, request), stored = slices(saved, request);
      state.data = installSlices(state.data, rebase(started, live, stored), request);
      state.baseline = saved;
      state.token = response.token;
      if (response.refreshRequired) state.refreshPending = true;
    }
    async function commit(change, context, record = false) {
      try {
        if (!state.ready) throw new Error('数据仍在加载，请稍后重试');
        if (record && storage.supportsPatches) return await commitRecord(change, context);
        const before = structuredClone(state.data);
        const proposal = normalize(structuredClone(before));
        // A declined command never publishes or persists its candidate.
        if (change && change(proposal) === false) return;
        const facts = typeof context === 'function' ? context() : context;
        const baseline = state.baseline;
        let saved;
        if (storage.supportsPatches) {
          const response = await storage.writeChanges(patches.createDataPatch(baseline, proposal), state.token, facts);
          saved = response.patch ? patches.applyDataPatch(baseline, response.patch) : response.data;
          state.token = response.token;
          if (response.refreshRequired) state.refreshPending = true;
        } else if (storage.isDesktop) saved = await storage.write(proposal, baseline, facts);
        else saved = storage.write(proposal, baseline, facts);
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
      const { change, context, record, resolve, reject } = requests.shift();
      commit(change, context, record).then(resolve, reject).finally(() => {
        active = false;
        drain();
        if (!active && !requests.length && state.refreshPending) Promise.resolve().then(refresh).catch(onSyncError);
      });
    }
    function enqueue(change, context, record = false) {
      if (!state.ready) return Promise.reject(new Error('数据仍在加载，请稍后重试'));
      state.saving = true;
      return new Promise((resolve, reject) => { requests.push({ change, context, record, resolve, reject }); drain(); });
    }
    function save(...args) {
      if (args.length) return Promise.reject(new Error('请使用 transact 提交业务修改'));
      return enqueue();
    }
    return { save, transact: (change, context) => enqueue(change, context), transactNote: (change, context) => enqueue(change, context, true) };
  }
  const api = { createSaveCoordinator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepPersistence ||= {}, api);
})(globalThis);
