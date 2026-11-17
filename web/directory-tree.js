// Shared by the sidebar and desktop document storage. Legacy folders have no parentId.
(function (root) {
  const MAX_DEPTH = 5;
  function index(items) {
    const byId = new Map(items.map(item => [item.id, item]));
    const children = new Map();
    for (const item of items) {
      if (!children.has(item.parentId)) children.set(item.parentId, []);
      children.get(item.parentId).push(item);
    }
    return { byId, children, ancestors: id => ancestors(items, id, byId), label: id => ancestors(items, id, byId).map(item => item.name).join(' / ') };
  }
  function ancestors(items, id, byId = index(items).byId) {
    const chain = [], seen = new Set();
    for (let item = byId.get(id); item && !seen.has(item.id); item = byId.get(item.parentId)) {
      seen.add(item.id);
      chain.unshift(item);
    }
    return chain;
  }
  function entries(items) {
    const { byId, children } = index(items);
    const result = [], seen = new Set();
    const visit = (item, parents) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      result.push({ item, depth: parents.length + 1, parents });
      (children.get(item.id) || []).forEach(child => visit(child, [...parents, item]));
    };
    items.filter(item => !byId.has(item.parentId)).forEach(item => visit(item, []));
    // Keep malformed imported cycles visible without recursing forever.
    items.forEach(item => visit(item, []));
    return result;
  }
  function creationError(items, parentId) {
    if (!parentId) return '';
    if (!items.some(item => item.id === parentId)) return '上级目录已不存在，请重新选择';
    const chain = ancestors(items, parentId);
    if (chain.length >= MAX_DEPTH || chain.some(item => item.id === chain[0]?.parentId)) return `目录最多支持 ${MAX_DEPTH} 层`;
    return '';
  }
  function label(items, id) { return ancestors(items, id).map(item => item.name).join(' / '); }
  const api = { MAX_DEPTH, index, ancestors, entries, creationError, label };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemoKeepDirectoryTree = api;
})(globalThis);
