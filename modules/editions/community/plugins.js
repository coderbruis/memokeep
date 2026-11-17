(function exposePlugins(root) {
  const plugins = [];
  if (typeof module !== 'undefined' && module.exports) module.exports = plugins;
  else root.MemoKeepPlugins = plugins;
})(typeof globalThis !== 'undefined' ? globalThis : this);
