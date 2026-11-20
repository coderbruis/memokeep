/* Shared keyboard bindings: physical key codes keep Option/Shift combinations stable. */
(() => {
  const host = globalThis;
  const mac = (host.memoKeepDesktop?.platform || host.navigator?.platform || '').toLowerCase();
  const isMac = mac === 'darwin' || mac.includes('mac');
  const mod = isMac ? 'Meta' : 'Control';
  const storageKey = 'memokeep-shortcuts-v1';
  const entries = [];
  const add = (id, group, label, binding) => entries.push({ id, group, label, defaultBinding: binding });
  add('save', '笔记编辑', '保存笔记', `${mod}+KeyS`);
  add('todo', '笔记编辑', '切换待办列表', `${mod}+Alt+KeyT`);
  for (const shortcut of host.MemoKeepEdition?.shortcuts || []) {
    add(shortcut.id, shortcut.group, shortcut.label, isMac && shortcut.macBinding ? shortcut.macBinding : shortcut.binding);
  }
  add('mode-edit', '阅读与显示', '沉浸式编辑', `${mod}+Alt+Digit1`);
  add('mode-read', '阅读与显示', '沉浸式阅读', `${mod}+Alt+Digit2`);
  add('mode-eye', '阅读与显示', '护眼模式', `${mod}+Alt+Digit3`);
  add('tab-close', '标签页', '关闭当前标签页', `${mod}+KeyW`);
  for (let n = 1; n <= 9; n++) add(`tab-${n}`, '标签页', `切换到第 ${n} 个标签页`, `${mod}+Digit${n}`);
  add('reveal', '复习', '显示答案', 'Space');
  ['重来', '困难', '良好', '简单'].forEach((label, index) => add(`rate-${index + 1}`, '复习', `评分：${label}`, `Digit${index + 1}`));
  add('review-prev', '复习', '上一张', 'ArrowLeft');
  add('review-next', '复习', '下一张', 'ArrowRight');
  add('review-later', '复习', '稍后复习', 'KeyL');
  add('review-source', '复习', '看出处', 'KeyD');
  add('review-edit', '复习', '编辑卡片 / 去笔记编辑', 'KeyE');
  add('review-undo', '复习', '撤销上一次评分', 'KeyZ');
  add('review-voice', '复习', '语音作答', 'KeyV');
  add('review-voice-redo', '复习', '语音作答：重说', 'KeyR');
  const defaults = Object.fromEntries(entries.map(item => [item.id, item.defaultBinding]));
  const modifiers = ['Meta', 'Control', 'Alt', 'Shift'];
  const validCode = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;
  function parse(binding) {
    if (typeof binding !== 'string') return null;
    const parts = binding.split('+'), code = parts.pop();
    if (!validCode.test(code) || parts.some(p => !modifiers.includes(p)) || new Set(parts).size !== parts.length) return null;
    return { code, mods: parts };
  }
  function fromEvent(event) {
    let code = event.code;
    if (!code) {
      const key = event.key || '';
      code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === ' ' ? 'Space' : key;
    }
    if (!validCode.test(code)) return null;
    return [...modifiers.filter(m => event[{Meta:'metaKey',Control:'ctrlKey',Alt:'altKey',Shift:'shiftKey'}[m]]), code].join('+');
  }
  const symbols = { Meta:'⌘', Control:isMac?'⌃':'Ctrl', Alt:isMac?'⌥':'Alt', Shift:isMac?'⇧':'Shift', ArrowLeft:'←', ArrowRight:'→', ArrowUp:'↑', ArrowDown:'↓', Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']', Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/', Backquote:'`' };
  const keys = binding => String(binding).split('+').map(p => symbols[p] || p.replace(/^Key|^Digit/, ''));
  function validate(id, binding, bindings) {
    const parsed = parse(binding), item = entries.find(e => e.id === id);
    if (!item || !parsed) return '请使用字母、数字、方向键或功能键';
    if (binding !== [...modifiers.filter(m => parsed.mods.includes(m)), parsed.code].join('+')) return '无效的组合键';
    if (item.group !== '复习' && !parsed.mods.includes(mod) && !/^F\d/.test(parsed.code)) return `请包含 ${isMac ? 'Command' : 'Ctrl'}，避免影响文字输入`;
    // These combinations remain owned by the OS, desktop host or the text editor.
    const primary = parsed.mods.includes(mod);
    const unshifted = !parsed.mods.includes('Alt') && !parsed.mods.includes(isMac?'Control':'Meta');
    if ((primary && unshifted && /^(Key[QRCXVZABIUFNPT]|Equal|Minus|Digit0)$/.test(parsed.code))
      || (parsed.mods.includes('Alt') && parsed.code === 'F4')
      || (isMac && parsed.mods.includes('Meta') && ['KeyH','KeyM'].includes(parsed.code))
      || (!isMac && parsed.mods.includes('Meta'))) return '该组合由系统或编辑器使用，请换一个组合';
    const conflict = entries.find(e => e.id !== id && bindings[e.id] === binding);
    return conflict ? `已用于「${conflict.label}」，请换一个组合` : '';
  }
  function read() {
    try {
      const value = JSON.parse(host.localStorage.getItem(storageKey));
      if (!value || value.platform !== (isMac?'mac':'other') || !value.bindings) return {...defaults};
      const result = {...defaults};
      for (const item of entries) if (parse(value.bindings[item.id])) result[item.id] = value.bindings[item.id];
      return entries.some(item => validate(item.id, result[item.id], result)) ? {...defaults} : result;
    } catch { return {...defaults}; }
  }
  let current = read();
  function announce() { host.dispatchEvent?.(new Event('memokeep-shortcuts-changed')); }
  host.MemoKeepShortcuts = {
    entries, defaults, isMac, keys, fromEvent, validate,
    snapshot: () => ({...current}),
    label: id => keys(current[id]).join(' '),
    matches: (event, id) => !event.isComposing && !event.repeat && fromEvent(event) === current[id],
    save(bindings) {
      for (const item of entries) { const error = validate(item.id, bindings[item.id], bindings); if(error) throw new Error(error); }
      host.localStorage.setItem(storageKey, JSON.stringify({platform:isMac?'mac':'other',bindings}));
      current = {...bindings}; announce();
    }
  };
  host.addEventListener?.('storage', event => { if (event.key === storageKey || event.key === null) { current = read(); announce(); } });
})();
