// 设置 › 语音作答 › 语音词库（design/prototype/voice-term-packs-20261111.md）。
// 上面是「使用的词库」：每个词库一张卡片，勾选启用（可多选），「只用这个」，拖动排序，新建 / 重命名 / 删除自己的词库。
// 下面是词条列表：按词库筛选、搜索、分页，「添加」可以选加到哪个词库。
// 数据：我的词库 settings.voiceTerms；词库配置 settings.voicePacks；关掉的内置词 settings.voiceTermsDisabled。
(function () {
  const PAGE = 12;
  const terms = () => window.MemoKeepVoiceTerms;
  const $ = selector => document.querySelector(selector);
  const data = () => (typeof applicationShell !== 'undefined' ? applicationShell.state.persistence.data : null);
  const transact = fn => (typeof application !== 'undefined' ? application.persistence.transact(fn) : Promise.reject(new Error('unavailable')));
  const key = value => terms().normalizeKey(value);
  const splitAliases = value => [...new Set(String(value || '').split(/[,，、;；\n]+/).map(item => item.trim()).filter(Boolean))];
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let filter = 'enabled', query = '', editing = null, page = 1, renaming = null, creating = false, dragging = null;

  const settings = () => data()?.settings || {};
  const allPacks = () => terms().packs({ mine: settings().voiceTerms, packs: settings().voicePacks });

  // 改词库配置（启用 / 顺序 / 自己的词库）。
  const savePacks = mutate => transact(next => { next.settings.voicePacks = mutate(terms().packConfig(next.settings.voicePacks)); });

  // ---------- 词库卡片 ----------
  function renderPacks() {
    const grid = $('#voicePackGrid');
    if (!grid) return;
    const list = allPacks(), enabled = list.filter(pack => pack.enabled);
    $('#voicePackSummary').textContent = `已启用 ${enabled.length} 个 · 共 ${enabled.reduce((sum, pack) => sum + pack.terms.length, 0)} 个词`;
    $('#voicePackAll').hidden = enabled.length === list.length;
    grid.textContent = '';
    for (const pack of list) {
      const card = document.createElement('div');
      card.className = `vs-pack${pack.enabled ? ' is-on' : ''}${pack.kind === 'mine' ? ' is-mine' : ''}`;
      card.dataset.pack = pack.id;
      card.draggable = renaming !== pack.id;
      const examples = pack.terms.slice(0, 4).map(item => item.term).join('、') || (pack.kind === 'builtin' ? '' : '还没有词');
      if (renaming === pack.id) {
        card.innerHTML = `<input class="vs-pack-name-input" data-pack-rename-input maxlength="20" value="${escapeHtml(pack.name)}" aria-label="词库名称"><span class="vs-pack-ex">Enter 保存 · Esc 取消</span>`;
      } else {
        card.innerHTML = `<label class="vs-pack-main"><input type="checkbox" data-pack-toggle ${pack.enabled ? 'checked' : ''} aria-label="启用 ${escapeHtml(pack.name)}"><span class="vs-pack-name">${escapeHtml(pack.name)}<span class="vs-pack-count">${pack.terms.length}</span></span></label><span class="vs-pack-ex">${escapeHtml(examples)}</span><span class="vs-pack-actions"><button type="button" data-pack-only>只用这个</button>${pack.kind === 'custom' ? '<button type="button" data-pack-rename>重命名</button><button type="button" data-pack-delete>删除</button>' : ''}</span>`;
      }
      grid.append(card);
    }
    const add = document.createElement('div');
    add.className = 'vs-pack is-new';
    add.innerHTML = creating
      ? '<input class="vs-pack-name-input" data-pack-create-input maxlength="20" placeholder="词库名称，例如：公司内部" aria-label="新词库名称"><span class="vs-pack-ex">Enter 创建 · Esc 取消</span>'
      : '<button type="button" data-pack-create><svg aria-hidden="true"><use href="#icon-plus"></use></svg>新建词库<small>例如「公司内部」</small></button>';
    grid.append(add);
    grid.querySelector('[data-pack-rename-input], [data-pack-create-input]')?.focus();
  }

  // ---------- 词条列表 ----------
  function rows() {
    const off = new Set((settings().voiceTermsDisabled || []).map(key));
    return allPacks().map(pack => ({ pack, rows: pack.terms.map(item => ({ term: item.term, aliases: item.aliases, pack: pack.id, packName: pack.name, kind: pack.kind, off: pack.kind === 'builtin' && off.has(key(item.term)) })) }));
  }

  function renderFilters(groups) {
    const host = $('#voiceTermFilter');
    if (!host) return;
    if (filter !== 'enabled' && !groups.some(group => group.pack.id === filter)) filter = 'enabled';
    const enabledCount = groups.filter(group => group.pack.enabled).reduce((sum, group) => sum + group.rows.length, 0);
    host.innerHTML = [`<button type="button" class="vs-chip" data-filter="enabled" aria-pressed="${filter === 'enabled'}">已启用<span>${enabledCount}</span></button>`,
      ...groups.map(group => `<button type="button" class="vs-chip" data-filter="${escapeHtml(group.pack.id)}" aria-pressed="${filter === group.pack.id}">${escapeHtml(group.pack.name)}<span>${group.rows.length}</span></button>`)].join('');
    // 添加表单里能选的：我的词库 + 自己新建的词库。
    const select = $('#voiceTermPack');
    if (select) {
      const value = select.value;
      select.innerHTML = groups.filter(group => group.pack.kind !== 'builtin').map(group => `<option value="${escapeHtml(group.pack.id)}">${escapeHtml(group.pack.name)}</option>`).join('');
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
  }

  function render() {
    const list = $('#voiceTermList');
    if (!list || !terms()) return;
    renderPacks();
    const groups = rows();
    renderFilters(groups);
    const pool = filter === 'enabled' ? groups.filter(group => group.pack.enabled).flatMap(group => group.rows) : groups.find(group => group.pack.id === filter)?.rows || [];
    const q = key(query);
    const matched = pool.filter(row => !q || key(row.term).includes(q) || row.aliases.some(alias => key(alias).includes(q)));
    const pages = Math.max(1, Math.ceil(matched.length / PAGE));
    page = Math.min(Math.max(1, page), pages);
    list.textContent = '';
    renderPager(matched.length, pages);
    if (!matched.length) {
      const empty = document.createElement('p'); empty.className = 'voice-terms-empty';
      empty.textContent = q ? '没有找到' : filter === 'enabled' ? '没有启用的词库，在上面勾选一个。' : filter === 'mine' ? '还没有自己的词。复习时改字后点「记住」，或点「添加」。' : '这个词库还没有词，点「添加」。';
      list.append(empty);
      return;
    }
    for (const row of matched.slice((page - 1) * PAGE, page * PAGE)) {
      const item = document.createElement('div');
      item.className = `voice-term-row${row.off ? ' is-off' : ''}`;
      item.dataset.term = row.term;
      item.dataset.pack = row.pack;
      const term = document.createElement('strong'); term.textContent = row.term;
      const aliases = document.createElement('span'); aliases.className = 'voice-term-aliases';
      if (row.aliases.length) row.aliases.forEach(alias => { const chip = document.createElement('span'); chip.textContent = alias; aliases.append(chip); });
      else { const none = document.createElement('em'); none.textContent = '只作提示词'; aliases.append(none); }
      const source = document.createElement('span'); source.className = `voice-term-source ${row.kind === 'builtin' ? 'builtin' : 'mine'}`; source.textContent = row.packName;
      const actions = document.createElement('span'); actions.className = 'voice-term-actions';
      if (row.kind !== 'builtin') actions.innerHTML = '<button type="button" data-term-edit>编辑</button><button type="button" data-term-delete>删除</button>';
      else {
        const label = document.createElement('label'); label.className = 'voice-term-switch';
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !row.off; box.dataset.termToggle = ''; box.setAttribute('aria-label', `启用 ${row.term}`);
        label.append(box, document.createTextNode('启用'));
        actions.append(label);
      }
      item.append(term, aliases, source, actions);
      list.append(item);
    }
  }

  // 分页：‹ 1 2 3 … 14 ›，左边显示共几个；只有一页时只显示数量。
  function renderPager(total, pages) {
    const pager = $('#voiceTermPager');
    if (!pager) return;
    pager.textContent = '';
    pager.hidden = !total;
    const count = document.createElement('span'); count.className = 'vs-pager-count';
    count.textContent = pages > 1 ? `共 ${total} 个 · 第 ${page} / ${pages} 页` : `共 ${total} 个`;
    pager.append(count);
    if (pages < 2) return;
    const button = (label, target, { current = false, disabled = false, aria } = {}) => {
      const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.dataset.termPage = String(target);
      node.disabled = disabled; if (current) node.setAttribute('aria-current', 'page'); if (aria) node.setAttribute('aria-label', aria);
      return node;
    };
    const numbers = new Set([1, pages, page - 1, page, page + 1].filter(value => value >= 1 && value <= pages));
    const group = document.createElement('span'); group.className = 'vs-pager-pages';
    group.append(button('‹', page - 1, { disabled: page === 1, aria: '上一页' }));
    let last = 0;
    for (const value of [...numbers].sort((a, b) => a - b)) {
      if (value - last > 1) { const gap = document.createElement('span'); gap.className = 'vs-pager-gap'; gap.textContent = '…'; group.append(gap); }
      group.append(button(String(value), value, { current: value === page, aria: `第 ${value} 页` }));
      last = value;
    }
    group.append(button('›', page + 1, { disabled: page === pages, aria: '下一页' }));
    pager.append(group);
  }

  // ---------- 添加 / 编辑 ----------
  function setError(message = '') { const node = $('#voiceTermError'); if (node) node.textContent = message; }
  function showForm(show) {
    $('#voiceTermForm').hidden = !show;
    $('#voiceTermAddBtn').setAttribute('aria-expanded', String(show));
    if (show) $('#voiceTermName').focus();
  }
  function resetForm() {
    editing = null;
    $('#voiceTermName').value = ''; $('#voiceTermAliases').value = '';
    $('#voiceTermSubmit').textContent = '保存';
    setError();
    showForm(false);
  }

  // 从词库里拿掉一个词：我的词库改 voiceTerms，自己的词库改 voicePacks.custom。
  function withoutTerm(next, packId, term) {
    if (packId === terms().MINE) next.settings.voiceTerms = (next.settings.voiceTerms || []).filter(entry => key(entry.term) !== key(term));
    else {
      const config = terms().packConfig(next.settings.voicePacks);
      config.custom = config.custom.map(pack => pack.id === packId ? { ...pack, terms: pack.terms.filter(entry => key(entry.term) !== key(term)) } : pack);
      next.settings.voicePacks = config;
    }
  }

  async function submit(event) {
    event.preventDefault();
    const term = $('#voiceTermName').value.trim(), aliases = splitAliases($('#voiceTermAliases').value), packId = $('#voiceTermPack').value || terms().MINE;
    if (!term) { setError('请填写术语'); $('#voiceTermName').focus(); return; }
    if (aliases.some(alias => [...alias].length < 2)) { setError('每个读法至少 2 个字，避免误替换'); $('#voiceTermAliases').focus(); return; }
    const was = editing;
    try {
      await transact(next => {
        if (was) withoutTerm(next, was.pack, was.term);
        Object.assign(next.settings, terms().addTo(next.settings, packId, term, aliases));
        // 加了词的词库要启用；同名内置词被关掉的，重新打开。
        const config = terms().packConfig(next.settings.voicePacks);
        if (!config.enabled.includes(packId)) { config.enabled.push(packId); next.settings.voicePacks = config; }
        next.settings.voiceTermsDisabled = (next.settings.voiceTermsDisabled || []).filter(item => key(item) !== key(term));
      });
    } catch { setError('没有保存成功，请重试'); return; }
    resetForm();
    filter = packId; page = 1;
    render();
  }

  // ---------- 事件 ----------
  async function onPackClick(event) {
    const card = event.target.closest('.vs-pack');
    if (!card) return;
    const id = card.dataset.pack;
    if (event.target.closest('[data-pack-create]')) { creating = true; renderPacks(); return; }
    if (event.target.closest('[data-pack-only]')) { await savePacks(config => ({ ...config, enabled: [id] })).catch(() => {}); page = 1; render(); return; }
    if (event.target.closest('[data-pack-rename]')) { renaming = id; renderPacks(); return; }
    if (event.target.closest('[data-pack-delete]')) {
      const pack = allPacks().find(item => item.id === id);
      if (!window.confirm(`删除词库「${pack?.name}」？里面的 ${pack?.terms.length || 0} 个词也会一起删除。`)) return;
      await savePacks(config => ({ enabled: config.enabled.filter(item => item !== id), order: config.order.filter(item => item !== id), custom: config.custom.filter(item => item.id !== id) })).catch(() => {});
      if (filter === id) filter = 'enabled';
      render();
    }
  }

  async function onPackChange(event) {
    const box = event.target.closest('[data-pack-toggle]');
    if (!box) return;
    const id = box.closest('.vs-pack').dataset.pack;
    try { await savePacks(config => ({ ...config, enabled: box.checked ? [...new Set([...config.enabled, id])] : config.enabled.filter(item => item !== id) })); }
    catch { box.checked = !box.checked; return; }
    page = 1;
    render();
  }

  async function onPackKey(event) {
    const input = event.target.closest('[data-pack-rename-input], [data-pack-create-input]');
    if (!input || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renaming = null; creating = false; renderPacks(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = input.value.trim().slice(0, 20);
    if (!name) { input.focus(); return; }
    if (input.matches('[data-pack-create-input]')) {
      const id = `custom-${Date.now().toString(36)}`;
      await savePacks(config => ({ enabled: [...config.enabled, id], order: [...config.order, id], custom: [...config.custom, { id, name, terms: [] }] })).catch(() => {});
      creating = false; filter = id; page = 1;
    } else {
      const id = renaming;
      await savePacks(config => ({ ...config, custom: config.custom.map(pack => pack.id === id ? { ...pack, name } : pack) })).catch(() => {});
      renaming = null;
    }
    render();
  }

  // 拖动卡片排序：顺序决定同一个读法属于多个词库时用哪个。
  async function movePack(from, to) {
    if (!from || !to || from === to) return;
    await savePacks(config => { const order = config.order.filter(id => id !== from); order.splice(order.indexOf(to), 0, from); return { ...config, order }; }).catch(() => {});
    render();
  }
  function bindDrag(grid) {
    grid.addEventListener('dragstart', event => { const card = event.target.closest('.vs-pack[data-pack]'); if (!card) return; dragging = card.dataset.pack; card.classList.add('is-dragging'); event.dataTransfer?.setData('text/plain', dragging); });
    grid.addEventListener('dragend', () => { dragging = null; grid.querySelectorAll('.is-dragging, .is-drop').forEach(node => node.classList.remove('is-dragging', 'is-drop')); });
    grid.addEventListener('dragover', event => { const card = event.target.closest('.vs-pack[data-pack]'); if (!card || !dragging || card.dataset.pack === dragging) return; event.preventDefault(); grid.querySelectorAll('.is-drop').forEach(node => node.classList.remove('is-drop')); card.classList.add('is-drop'); });
    grid.addEventListener('drop', event => {
      const card = event.target.closest('.vs-pack[data-pack]');
      const from = dragging || event.dataTransfer?.getData('text/plain');
      if (!card) return;
      event.preventDefault();
      dragging = null;
      movePack(from, card.dataset.pack);
    });
  }

  async function onListClick(event) {
    const pageButton = event.target.closest('[data-term-page]');
    if (pageButton) { if (!pageButton.disabled) { page = Number(pageButton.dataset.termPage); render(); $('#voiceTermsSection')?.scrollIntoView({ block: 'nearest' }); } return; }
    const row = event.target.closest('.voice-term-row');
    if (!row) return;
    const term = row.dataset.term, packId = row.dataset.pack;
    if (event.target.closest('[data-term-edit]')) {
      const item = allPacks().find(pack => pack.id === packId)?.terms.find(entry => key(entry.term) === key(term));
      if (!item) return;
      editing = { pack: packId, term: item.term };
      $('#voiceTermName').value = item.term;
      $('#voiceTermAliases').value = (item.aliases || []).join('，');
      $('#voiceTermPack').value = packId;
      $('#voiceTermSubmit').textContent = '保存修改';
      showForm(true);
      return;
    }
    if (event.target.closest('[data-term-delete]')) {
      try { await transact(next => withoutTerm(next, packId, term)); } catch { setError('没有删除成功，请重试'); return; }
      if (editing && key(editing.term) === key(term)) resetForm();
      render();
    }
  }

  async function onListChange(event) {
    const box = event.target.closest('[data-term-toggle]');
    if (!box) return;
    const term = box.closest('.voice-term-row').dataset.term;
    try {
      await transact(next => {
        const off = (next.settings.voiceTermsDisabled || []).filter(item => key(item) !== key(term));
        if (!box.checked) off.push(term);
        next.settings.voiceTermsDisabled = off;
      });
    } catch { box.checked = !box.checked; setError('没有保存成功，请重试'); return; }
    render();
  }

  // 打开设置页时重置筛选并刷新。
  function reset() { renaming = null; creating = false; resetForm(); query = ''; filter = 'enabled'; page = 1; if ($('#voiceTermSearch')) $('#voiceTermSearch').value = ''; render(); }

  function bind() {
    if (!$('#voiceTermList') || !terms()) return;
    const grid = $('#voicePackGrid');
    grid.addEventListener('click', onPackClick);
    grid.addEventListener('change', onPackChange);
    grid.addEventListener('keydown', onPackKey);
    bindDrag(grid);
    $('#voicePackAll').addEventListener('click', async () => { await savePacks(config => ({ ...config, enabled: [...config.order] })).catch(() => {}); render(); });
    $('#voiceTermForm').addEventListener('submit', submit);
    $('#voiceTermForm').addEventListener('input', () => setError());
    $('#voiceTermCancel').addEventListener('click', resetForm);
    $('#voiceTermSearch').addEventListener('input', event => { query = event.target.value; page = 1; render(); });
    $('#voiceTermFilter').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (button) { filter = button.dataset.filter; page = 1; render(); } });
    $('#voiceTermAddBtn').addEventListener('click', () => {
      if (!$('#voiceTermForm').hidden) { resetForm(); return; }
      editing = null; $('#voiceTermSubmit').textContent = '保存';
      $('#voiceTermPack').value = allPacks().some(pack => pack.id === filter && pack.kind !== 'builtin') ? filter : terms().MINE;
      showForm(true);
    });
    $('#voiceTermList').addEventListener('click', onListClick);
    $('#voiceTermPager').addEventListener('click', onListClick);
    $('#voiceTermList').addEventListener('change', onListChange);
    render();
  }

  window.MemoKeepVoiceTermSettings = { render, reset, movePack };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
