(function expose(root) {
  function createPluginFeatures({ state, config, actions, env }) {
    const manifests = () => env.window.MemoKeepPlugins || [];
    const pluginState = () => env.window.MemoKeepPluginState;
    let view, previousEnabled;

    function isPluginEnabled(featureId) {
      return pluginState()?.isEnabled(state.persistence.data.settings, manifests(), featureId) ?? true;
    }

    function pluginViewAvailable(name) {
      if (name === 'plugins') return manifests().length > 0;
      if (!config.$(`#${name}View`)) return false;
      const plugin = manifests().find(item => item.nav?.view === (actions.editionNavigationSection?.(name) || name));
      return !plugin || isPluginEnabled(plugin.feature);
    }

    function syncPluginNavigation() {
      const catalog = manifests(), group = config.$('#sidebarPluginGroup'), items = config.$('#sidebarPluginItems');
      if (!group || !items) return;
      group.hidden = !catalog.length;
      if (!catalog.length) return;
      for (const manifest of catalog.filter(item => item.nav)) {
        const button = config.$('.shell > header > nav .nav[data-view="' + manifest.nav.view + '"]');
        if (!button) continue;
        if (button.parentElement !== items) items.append(button);
        button.title = `${manifest.nav.label} · 插件`;
        button.setAttribute('aria-label', button.title);
        if (!button.querySelector('.plugin-nav-origin')) button.insertAdjacentHTML('beforeend', '<svg class="plugin-nav-origin" aria-hidden="true"><use href="#icon-puzzle"></use></svg>');
      }
      config.$('#sidebarPluginEmpty').hidden = catalog.some(item => item.nav && isPluginEnabled(item.feature));
      config.$$('[data-workspace-page]').forEach(title => {
        const name = actions.editionNavigationSection?.(title.dataset.workspacePage) || title.dataset.workspacePage;
        const manifest = catalog.find(item => item.nav?.view === name);
        if (!manifest || title.querySelector('.workspace-plugin-origin')) return;
        title.classList.add('has-plugin-origin');
        title.insertAdjacentHTML('afterbegin', '<span class="workspace-plugin-origin"><svg aria-hidden="true"><use href="#icon-puzzle"></use></svg><span>插件</span><svg class="plugin-breadcrumb-chevron" aria-hidden="true"><use href="#icon-chevron-right"></use></svg></span>');
      });
      const page = config.$('.shell > .view:not(.hidden)');
      const section = page?.id.replace(/View$/, '');
      const name = actions.editionNavigationSection?.(section) || section;
      if (!catalog.some(item => item.nav?.view === name) || page.querySelector('.plugin-page-manage')) return;
      const button = env.document.createElement('button');
      button.type = 'button'; button.className = 'plugin-page-manage'; button.dataset.pluginManager = 'mine';
      button.innerHTML = '<svg aria-hidden="true"><use href="#icon-puzzle"></use></svg><span>管理插件</span>';
      if (!actions.mountEditionPluginToolbar?.(page, button)) {
        const toolbar = env.document.createElement('div'); toolbar.className = 'plugin-page-toolbar'; toolbar.append(button);
        page.prepend(toolbar);
      }
    }

    function syncPluginState() {
      const settings = state.persistence.data.settings;
      const enabled = new Set(manifests().filter(item => pluginState().stateOf(settings, item) === 'on').map(item => item.id));
      env.document.documentElement.dataset.pluginsOff = manifests().filter(item => !enabled.has(item.id)).map(item => item.id).join(' ');
      syncPluginNavigation();
      if (previousEnabled) for (const id of enabled) {
        if (previousEnabled.has(id)) continue;
        config.$$(`[data-plugin="${id}"]`).forEach(node => {
          node.classList.remove('plugin-nav-enter');
          // Restart the one-time entrance when a plugin is enabled again.
          void node.offsetWidth;
          node.classList.add('plugin-nav-enter');
          node.addEventListener('animationend', () => node.classList.remove('plugin-nav-enter'), { once: true });
        });
      }
      previousEnabled = enabled;
      config.$$('[data-plugin-new]').forEach(node => {
        const manifest = manifests().find(item => item.id === node.dataset.pluginNew);
        node.hidden = !manifest?.isNew || (settings.pluginsSeen || []).includes(manifest.id);
      });
      const current = config.$('.shell > .view:not(.hidden)')?.id.replace(/View$/, '');
      actions.syncEditionSettings?.();
      if (current && !pluginViewAvailable(current)) actions.showView('home');
      actions.renderPageTabs?.();
    }

    function announcePluginChange(id) {
      env.window.dispatchEvent(new env.window.CustomEvent('memokeep:plugins-changed', { detail: { id } }));
    }

    async function setPluginState(id, nextState, { deleteData = false } = {}) {
      if (!manifests().some(item => item.id === id)) throw new Error('找不到这个插件');
      await actions.beforePluginStateChange?.(id, nextState, { deleteData });
      await env.application.persistence.transact(data => {
        data.settings = pluginState().setState(data.settings, id, nextState);
      });
      announcePluginChange(id);
      await actions.afterPluginStateChange?.(id, nextState, { deleteData });
    }

    async function markPluginSeen(name) {
      const manifest = manifests().find(item => item.nav?.view === name);
      if (!manifest?.isNew || !isPluginEnabled(manifest.feature) || (state.persistence.data.settings.pluginsSeen || []).includes(manifest.id)) return;
      try {
        await env.application.persistence.transact(data => {
          data.settings.pluginsSeen = [...new Set([...(data.settings.pluginsSeen || []), manifest.id])];
        });
        announcePluginChange(manifest.id);
      } catch { /* The persistence layer reports save errors; leave the badge for next time. */ }
    }

    function renderPlugins(options) {
      const container = config.$('#pluginsView');
      if (!container || !manifests().length) return;
      view ||= env.window.MemoKeepPluginsView.create({
        container, manifests: manifests(), getSettings: () => state.persistence.data.settings,
        onSetState: setPluginState,
        onOpen: manifest => { if (manifest.nav && isPluginEnabled(manifest.feature)) actions.showView(manifest.nav.view); },
        showToast: (...args) => actions.showToast(...args), escapeHtml: actions.escapeHtml
      });
      view.render(options);
    }

    async function openPluginManager(tab = 'mine') {
      if (!manifests().length || !await env.application.editor.session.leaveActiveNoteEditor()) return false;
      actions.showView('plugins');
      renderPlugins({ tab });
      return true;
    }

    function bindPlugins() {
      syncPluginState();
      env.document.addEventListener('click', event => {
        const button = event.target.closest('[data-plugin-manager]');
        if (!button) return;
        event.preventDefault();
        void openPluginManager(button.dataset.pluginManager).catch(error => actions.showToast(error.message, true));
      });
      env.window.addEventListener('memokeep:plugins-changed', () => {
        syncPluginState();
        if (!config.$('#pluginsView')?.classList.contains('hidden')) renderPlugins();
      });
    }

    return { isPluginEnabled, pluginViewAvailable, syncPluginNavigation, syncPluginState, setPluginState, markPluginSeen, renderPlugins, openPluginManager, bindPlugins };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createPluginFeatures });
})(globalThis);
