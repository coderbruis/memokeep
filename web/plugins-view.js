(function expose(root) {
  const PERMISSIONS = {
    mic: ['mic', '麦克风', '录下你说的话'],
    speech: ['mic', '语音识别', '把语音转成文字，只在本机识别'],
    store: ['disk', '在本机保存文件', '录音和文字存在这台电脑的数据目录里'],
    screen: ['screen', '屏幕录制', '截图时读取屏幕画面'],
    folder: ['out', '写入你选的文件夹', '只写你指定的那个目录']
  };
  const ICONS = {
    chart: '<path d="M5 20v-5M12 20V5M19 20v-9"/>',
    crop: '<path d="M6 2v16h16M2 6h16v16"/>',
    flow: '<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v5a4 4 0 0 0 4 4H14"/>',
    wand: '<path d="m4 20 11-11M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3M18 3v2"/>',
    out: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 16v-6M9.5 12.5 12 10l2.5 2.5"/>',
    wins: '<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 7V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    disk: '<path d="M22 12H2M5.5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-7a2 2 0 0 0-1.8-1H7.3a2 2 0 0 0-1.8 1Z"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    puzzle: '<path d="M9 4h4v2.5a1.75 1.75 0 1 0 3.5 0V4H20v5h-2.2a1.75 1.75 0 1 0 0 3.5H20V20h-5v-2.2a1.75 1.75 0 1 0-3.5 0V20H4v-6h2.2a1.75 1.75 0 1 0 0-3.5H4V4h5"/>'
  };
  const icon = name => `<svg class="plugin-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.puzzle}</svg>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function create({ container, manifests, getSettings, onSetState, onOpen, showToast, escapeHtml = escape }) {
    const document = container.ownerDocument;
    const window = document.defaultView;
    const model = root.MemoKeepPluginState;
    const view = { tab: 'market', category: '全部', query: '', detail: null, from: 'market' };
    const busy = new Set(), changing = new Set();
    let destroyed = false, toastTimer, dialogResolve = null;
    const byId = id => manifests.find(manifest => manifest.id === id);
    const stateOf = manifest => model.stateOf(getSettings(), manifest);
    const e = value => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const permissions = manifest => manifest.permissions || [];
    const installed = () => manifests.filter(manifest => stateOf(manifest) !== 'none');
    const usageOf = manifest => manifest.nav ? '侧栏「插件」' : manifest.usage || manifest.adds?.[0] || '在应用内使用';
    const kindOf = manifest => manifest.nav ? '独立页面' : '增强功能';

    container.innerHTML = `<div class="plugins-head"><h1>插件</h1>
      <div class="plugins-tabs" role="tablist" aria-label="插件">
        <button type="button" id="pluginsMarketTab" role="tab" aria-controls="pluginsMarket" data-plugin-tab="market">市场</button>
        <button type="button" id="pluginsInstalledTab" role="tab" aria-controls="pluginsInstalled" data-plugin-tab="mine">已安装 <em id="pluginsInstalledCount"></em></button>
      </div>
      <label class="plugins-search">${icon('search')}<input id="pluginsSearch" type="search" placeholder="找插件" aria-label="找插件" autocomplete="off"></label>
    </div><div class="plugins-body">
      <div id="pluginsMarket" role="tabpanel" aria-labelledby="pluginsMarketTab"><div class="plugins-categories" aria-label="插件分类"></div><div class="plugins-grid"></div></div>
      <div id="pluginsInstalled" role="tabpanel" aria-labelledby="pluginsInstalledTab" hidden></div>
      <div id="pluginsDetail" hidden></div>
    </div><div class="plugins-action-toast" role="status" hidden><span></span><button type="button">打开</button></div>`;
    const $ = selector => container.querySelector(selector);
    const dialog = document.createElement('dialog');
    dialog.id = 'pluginsConfirmDialog';
    dialog.className = 'app-confirm-dialog plugins-confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'pluginsConfirmTitle');
    dialog.setAttribute('aria-describedby', 'pluginsConfirmMessage');
    document.body.append(dialog);

    function newTag(manifest) {
      return manifest.isNew && !(getSettings()?.pluginsSeen || []).includes(manifest.id) ? '<span class="plugin-new">新</span>' : '';
    }

    function installButton(manifest) {
      if (busy.has(manifest.id)) return '<button type="button" class="plugin-button done" disabled>正在安装…</button>';
      if (stateOf(manifest) === 'none') return `<button type="button" class="plugin-button primary" data-plugin-install="${e(manifest.id)}">安装</button>`;
      return `<span class="plugin-button done">${stateOf(manifest) === 'on' ? '已安装' : '已停用'}</span>`;
    }

    function switchButton(manifest) {
      return `<button type="button" class="plugin-switch" role="switch" aria-checked="${stateOf(manifest) === 'on'}" aria-label="启用${e(manifest.name)}" data-plugin-toggle="${e(manifest.id)}" ${changing.has(manifest.id) ? 'disabled' : ''}></button>`;
    }

    function removeButton(manifest) {
      return `<button type="button" class="plugin-button ghost danger" data-plugin-remove="${e(manifest.id)}" ${changing.has(manifest.id) ? 'disabled' : ''}>卸载</button>`;
    }

    function permissionList(manifest) {
      return permissions(manifest).map(key => {
        const permission = PERMISSIONS[key];
        if (!permission) return '';
        return `<div class="plugin-permission">${icon(permission[0])}<span><b>${permission[1]}</b><small>${permission[2]}</small></span></div>`;
      }).join('');
    }

    function renderMarket() {
      $('.plugins-categories').innerHTML = ['全部', '复习', '笔记', '工具'].map(category => `<button type="button" class="plugin-category" data-plugin-category="${category}" aria-pressed="${view.category === category}">${category}</button>`).join('');
      const shown = model.filter(manifests, { category: view.category, query: view.query });
      $('.plugins-grid').innerHTML = shown.map(manifest => `<article class="plugin-market-card" data-plugin-detail="${e(manifest.id)}" tabindex="0" role="button" aria-label="${e(manifest.name)}">
        <div class="plugin-card-top"><span class="plugin-picture">${icon(manifest.icon)}</span><span><b>${e(manifest.name)}${newTag(manifest)}</b><small>${e(manifest.category)} · MemoKeep 官方</small></span></div>
        <div class="plugin-card-kind">${kindOf(manifest)}</div><p>${e(manifest.brief)}</p><div class="plugin-card-foot"><span class="plugin-card-usage">${e(usageOf(manifest))}</span>${installButton(manifest)}</div></article>`).join('')
        || `<div class="plugins-empty">没有找到「${e(view.query)}」相关的插件</div>`;
    }

    function installedRow(manifest) {
      return `<div class="plugin-installed-row${stateOf(manifest) === 'off' ? ' off' : ''}" data-plugin-id="${e(manifest.id)}">
        <span class="plugin-picture">${icon(manifest.icon)}</span>
        <button type="button" class="plugin-row-name" data-plugin-detail="${e(manifest.id)}"><b>${e(manifest.name)}</b><small>${stateOf(manifest) === 'off' ? '已停用，入口已收起，数据都还在' : e(manifest.brief)}</small></button>
        <span class="plugin-usage">${manifest.nav ? icon('puzzle') : ''}${e(usageOf(manifest))}</span>
        <div class="plugin-row-actions">${manifest.nav && stateOf(manifest) === 'on' ? `<button type="button" class="plugin-button ghost plugin-row-open" data-plugin-open="${e(manifest.id)}">打开</button>` : ''}${removeButton(manifest)}${switchButton(manifest)}</div></div>`;
    }

    function installedSection(plugins, { kind, title, description }) {
      if (!plugins.length) return '';
      return `<section class="plugins-installed-section" data-plugin-kind="${kind}"><h2>${title}</h2><p class="plugins-section-description">${description}</p>${plugins.map(installedRow).join('')}</section>`;
    }

    function renderInstalled() {
      const mine = model.filter(installed(), { query: view.query });
      $('#pluginsInstalled').innerHTML = installedSection(mine.filter(manifest => manifest.nav), {
        kind: 'page', title: '独立页面', description: '启用后，入口统一出现在左侧「插件」分组。'
      }) + installedSection(mine.filter(manifest => !manifest.nav), {
        kind: 'enhancement', title: '增强功能', description: '在原来的位置使用，不额外占用侧栏。'
      }) || `<div class="plugins-empty">${view.query ? `已安装的插件里没有「${e(view.query)}」` : '还没有安装插件，去市场看看'}${!view.query ? '<button type="button" class="plugin-button" data-plugin-go-market>去找插件</button>' : ''}</div>`;
    }

    function renderDetail(manifest) {
      const enabled = stateOf(manifest) === 'on';
      const actions = stateOf(manifest) === 'none' || busy.has(manifest.id) ? installButton(manifest)
        : `${manifest.nav && enabled ? `<button type="button" class="plugin-button primary" data-plugin-open="${e(manifest.id)}">打开</button>` : ''}${removeButton(manifest)}${switchButton(manifest)}`;
      $('#pluginsDetail').innerHTML = `<button type="button" class="plugin-back" data-plugin-back>${icon('back')}${view.from === 'mine' ? '已安装' : '市场'}</button>
        <div class="plugin-detail-head"><span class="plugin-picture">${icon(manifest.icon)}</span><div class="plugin-detail-copy"><h2>${e(manifest.name)}${newTag(manifest)}</h2><p>${e(manifest.brief)}</p></div><div class="plugin-detail-actions">${actions}</div></div>
        <div class="plugin-detail-columns"><div class="plugin-detail-description">
          ${manifest.preview ? `<img class="plugin-preview" src="${e(manifest.preview)}" alt="${e(manifest.name)}界面预览">` : ''}
          <h3>介绍</h3><p>${e(manifest.long)}</p><h3>装了以后</h3><ul>${(manifest.adds || []).map(item => `<li>${e(item)}</li>`).join('')}</ul>
          <h3>不想用了</h3><p>在「已安装」里关掉，入口就收起来，数据留着；卸载时可以选要不要连数据一起删。</p>
        </div><div><div class="plugin-detail-box"><h3>使用位置</h3><p>${e(usageOf(manifest))}</p><small class="plugin-detail-kind">${kindOf(manifest)}</small></div><div class="plugin-detail-box"><h3>会用到</h3>${permissions(manifest).length ? permissionList(manifest) : '<p>不需要额外权限，只用到应用里已有的数据。</p>'}</div>
          <div class="plugin-detail-box"><dl><dt>版本</dt><dd>${e(manifest.version)}</dd><dt>更新</dt><dd>${e(manifest.updated)}</dd><dt>作者</dt><dd>MemoKeep 官方</dd><dt>联网</dt><dd>不联网</dd></dl></div></div></div>`;
    }

    function render({ tab } = {}) {
      if (destroyed) return;
      if (tab === 'market' || tab === 'mine') {
        view.tab = tab;
        view.detail = null;
        view.query = '';
        $('#pluginsSearch').value = '';
      }
      const detail = byId(view.detail);
      $('#pluginsInstalledCount').textContent = installed().length;
      container.querySelectorAll('[data-plugin-tab]').forEach(button => {
        button.setAttribute('aria-selected', String(!detail && button.dataset.pluginTab === view.tab));
        button.tabIndex = button.dataset.pluginTab === view.tab ? 0 : -1;
      });
      $('.plugins-search').hidden = Boolean(detail);
      $('#pluginsMarket').hidden = Boolean(detail) || view.tab !== 'market';
      $('#pluginsInstalled').hidden = Boolean(detail) || view.tab !== 'mine';
      $('#pluginsDetail').hidden = !detail;
      renderMarket();
      renderInstalled();
      if (detail) renderDetail(detail);
    }

    function toast(message, manifest) {
      window.clearTimeout(toastTimer);
      const element = $('.plugins-action-toast');
      element.hidden = true;
      if (!manifest?.nav) { showToast?.(message); return; }
      element.querySelector('span').textContent = message;
      element.querySelector('button').onclick = () => { element.hidden = true; onOpen?.(manifest); };
      element.hidden = false;
      toastTimer = window.setTimeout(() => { element.hidden = true; }, 5000);
    }

    function finishDialog(result) {
      const resolve = dialogResolve;
      dialogResolve = null;
      if (dialog.open) dialog.close();
      resolve?.(result);
    }

    function confirm({ manifest, install }) {
      if (dialogResolve) finishDialog(null);
      const title = install ? `安装「${manifest.name}」` : `卸载「${manifest.name}」？`;
      const message = install ? '它会用到下面这些，装好后第一次使用时系统还会再问一次。' : '入口会消失。以后还可以从市场再装回来。';
      dialog.innerHTML = `<div class="app-confirm-card">
        <button type="button" class="app-confirm-close" data-plugin-dialog-cancel aria-label="关闭">${icon('close')}</button>
        <div class="app-confirm-icon ${install ? 'plugin-install-icon' : 'danger'}">${icon(install ? manifest.icon : 'trash')}</div>
        <div class="app-confirm-copy"><h2 id="pluginsConfirmTitle">${e(title)}</h2><p id="pluginsConfirmMessage">${message}</p></div>
        ${install ? `<div class="plugin-dialog-permissions">${permissionList(manifest)}</div>` : manifest.ownsData ? '<label class="plugin-wipe-label"><input id="pluginsDeleteData" type="checkbox">同时删除它的数据</label>' : ''}
        <div class="app-confirm-actions"><button type="button" class="plugin-button" data-plugin-dialog-cancel>取消</button><button type="button" id="pluginsConfirmSubmit" class="plugin-button ${install ? 'primary' : 'danger'}">${install ? '允许并安装' : '卸载'}</button></div>
      </div>`;
      dialog.querySelectorAll('[data-plugin-dialog-cancel]').forEach(button => { button.onclick = () => finishDialog(null); });
      return new Promise(resolve => {
        dialogResolve = resolve;
        dialog.querySelector('#pluginsConfirmSubmit').onclick = () => finishDialog({ deleteData: Boolean(dialog.querySelector('#pluginsDeleteData')?.checked) });
        dialog.showModal();
        dialog.querySelector('.app-confirm-actions [data-plugin-dialog-cancel]').focus();
      });
    }

    async function install(manifest) {
      if (busy.has(manifest.id) || changing.has(manifest.id) || stateOf(manifest) !== 'none') return;
      if (permissions(manifest).length && !await confirm({ manifest, install: true })) return;
      busy.add(manifest.id);
      changing.add(manifest.id);
      render();
      const started = Date.now();
      try {
        await onSetState(manifest.id, 'on', { deleteData: false });
        await new Promise(resolve => window.setTimeout(resolve, Math.max(0, 400 - (Date.now() - started))));
        toast(`「${manifest.name}」装好了${manifest.nav ? '，入口在左边侧栏' : ''}`, manifest);
      } catch (error) { showToast?.(error.message || '安装失败，请再试一次', true); }
      finally { busy.delete(manifest.id); changing.delete(manifest.id); render(); }
    }

    async function toggle(manifest) {
      if (changing.has(manifest.id)) return;
      const next = stateOf(manifest) === 'on' ? 'off' : 'on';
      changing.add(manifest.id);
      render();
      try {
        await onSetState(manifest.id, next, { deleteData: false });
        toast(next === 'on' ? `「${manifest.name}」已启用` : `「${manifest.name}」已停用，数据都还在`);
      } catch (error) { showToast?.(error.message || '保存失败，请再试一次', true); }
      finally { changing.delete(manifest.id); render(); }
    }

    async function remove(manifest) {
      if (changing.has(manifest.id)) return;
      const result = await confirm({ manifest, install: false });
      if (!result) return;
      changing.add(manifest.id);
      render();
      try {
        await onSetState(manifest.id, 'none', result);
        toast(`「${manifest.name}」已卸载${manifest.ownsData ? result.deleteData ? '，数据也删掉了' : '，数据还留着' : ''}`);
      } catch (error) { showToast?.(error.message || '卸载失败，请再试一次', true); }
      finally { changing.delete(manifest.id); render(); }
    }

    function openDetail(id) {
      if (!byId(id)) return;
      view.from = view.tab;
      view.detail = id;
      render();
      $('.plugins-body').scrollTop = 0;
      $('[data-plugin-back]')?.focus({ preventScroll: true });
    }

    function onClick(event) {
      const target = event.target.closest('[data-plugin-install], [data-plugin-toggle], [data-plugin-remove], [data-plugin-open], [data-plugin-detail], [data-plugin-tab], [data-plugin-category], [data-plugin-back], [data-plugin-go-market]');
      if (!target || !container.contains(target) || target.disabled) return;
      const data = target.dataset;
      if (data.pluginInstall) { void install(byId(data.pluginInstall)); return; }
      if (data.pluginToggle) { void toggle(byId(data.pluginToggle)); return; }
      if (data.pluginRemove) { void remove(byId(data.pluginRemove)); return; }
      if (data.pluginOpen) { onOpen?.(byId(data.pluginOpen)); return; }
      if (data.pluginDetail) { openDetail(data.pluginDetail); return; }
      if (data.pluginTab) { view.tab = data.pluginTab; view.detail = null; }
      if ('pluginGoMarket' in data) { view.tab = 'market'; view.detail = null; }
      if (data.pluginCategory) view.category = data.pluginCategory;
      if ('pluginBack' in data) { view.detail = null; view.tab = view.from; }
      render();
      $('.plugins-body').scrollTop = 0;
    }

    function onKeydown(event) {
      const card = event.target.closest('.plugin-market-card');
      if (card === event.target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openDetail(card.dataset.pluginDetail); return; }
      const tab = event.target.closest('[data-plugin-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...container.querySelectorAll('[data-plugin-tab]')];
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].click();
      tabs[index].focus();
    }

    function onInput(event) {
      if (event.target.id !== 'pluginsSearch') return;
      view.query = event.target.value.trim();
      render();
      $('.plugins-body').scrollTop = 0;
    }

    dialog.oncancel = event => { event.preventDefault(); finishDialog(null); };
    let backdrop = false;
    const outside = event => { const rect = dialog.getBoundingClientRect(); return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom); };
    dialog.onpointerdown = event => { backdrop = outside(event); };
    dialog.onclick = event => { if (backdrop && outside(event)) finishDialog(null); backdrop = false; };
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKeydown);
    container.addEventListener('input', onInput);
    render();
    return { render, openDetail, destroy() {
      destroyed = true;
      window.clearTimeout(toastTimer);
      finishDialog(null);
      dialog.remove();
      container.removeEventListener('click', onClick);
      container.removeEventListener('keydown', onKeydown);
      container.removeEventListener('input', onInput);
      container.replaceChildren();
    } };
  }
  root.MemoKeepPluginsView = { create };
})(globalThis);
