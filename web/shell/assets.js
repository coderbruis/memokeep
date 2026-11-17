(function expose(root) {
  function createAssets({ state, config, actions, env }) {
    function loadApplicationScript(source) {
      if (!config.applicationScripts.has(source)) {
        config.applicationScripts.set(source, new Promise((resolve, reject) => {
          const script = env.document.createElement('script'); script.src = source;
          script.onload = resolve;
          script.onerror = () => { script.remove(); config.applicationScripts.delete(source); reject(new Error(`无法加载组件：${source}`)); };
          env.document.head.append(script);
        }));
      }
      return config.applicationScripts.get(source);
    }

    function loadNoteEditorAssets() {
      return Promise.all(['vendor/quill/quill.js', 'vendor/prism/prism-languages.min.js', '../modules/content/diagrams/canvas-model.js', '../modules/content/diagrams/sequence-model.js', ...env.MemoKeepEdition.editorAssets].map(actions.loadApplicationScript));
    }
    return { loadApplicationScript, loadNoteEditorAssets };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createAssets });
})(globalThis);
