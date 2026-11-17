// 固定在桌面的番茄钟悬浮窗：只显示和发指令，计时在主进程。
(() => {
  const api = window.memoKeepDesktop?.pomodoro, P = window.MemoKeepPomodoro, root = document.getElementById('float');
  if (!api || !P) return;
  const icon = id => `<svg class="i" aria-hidden="true"><use href="#${id}"></use></svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  let state = null, plans = new Map(), sessions = [], finished = null, finishedTimer = null, picking = false, hoverColor = null;
  // 按钮提示：悬浮窗不会激活应用，系统的 title 提示出不来，所以自己画。放在 #float 外面，每秒重画也不闪。
  const tip = document.createElement('div');
  tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);
  let pointer = null;
  function updateTip() {
    const hovered = pointer && !drag ? document.elementFromPoint(pointer.x, pointer.y)?.closest('.ib[aria-label]') : null;
    const focused = document.activeElement?.matches?.('.ib[aria-label]:focus-visible') ? document.activeElement : null;
    const button = hovered || focused;
    if (!button) { tip.hidden = true; return; }
    tip.textContent = button.getAttribute('aria-label');
    tip.hidden = false;
    const box = button.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight, room = document.documentElement.clientWidth;
    if (root.querySelector('.pill')) {
      // 胶囊只有一行高：提示放在按钮左边，盖住计划名那一段。
      tip.style.left = `${Math.max(4, box.left - width - 6)}px`;
      tip.style.top = `${box.top + (box.height - height) / 2}px`;
    } else {
      tip.style.left = `${Math.min(room - width - 4, Math.max(4, box.left + (box.width - width) / 2))}px`;
      tip.style.top = `${box.bottom + 4}px`;
    }
  }
  // 色块不画提示：指到哪个颜色，色块右边的名称就换成哪个。
  const colorName = id => P.FLOAT_COLORS.find(color => color.id === id)?.name || '';
  function updateColorName() {
    const hovered = pointer && !drag ? document.elementFromPoint(pointer.x, pointer.y)?.closest('.sw')?.dataset.color || null : null;
    hoverColor = hovered;
    const name = root.querySelector('.swatches .name');
    if (name && state) name.textContent = colorName(hoverColor || state.settings.floatColor);
  }
  window.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; updateTip(); updateColorName(); });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; updateTip(); updateColorName(); });
  window.addEventListener('blur', () => { pointer = null; updateTip(); updateColorName(); });
  document.addEventListener('focusin', updateTip);
  document.addEventListener('focusout', () => setTimeout(updateTip, 0));

  async function refreshData() {
    try {
      const data = await window.memoKeepDesktop.read();
      plans = new Map((data.plans || []).map(plan => [plan.id, plan.name]));
      sessions = data.focusSessions || [];
    } catch { /* 悬浮窗只读数据，失败时保留上一次的名称 */ }
  }
  const planName = id => (id && plans.get(id)) || '未归入计划';
  const todayMinutes = () => P.minutesByDay(sessions).get(P.dayOf(new Date().toISOString())) || 0;
  const planMinutes = id => sessions.filter(session => session.planId === id).reduce((sum, session) => sum + Number(session.minutes || 0), 0);
  const left = () => state.running && state.endsAt ? Math.max(0, state.endsAt - Date.now()) : state.leftMs;

  function ring(size, width) {
    const r = (size - width) / 2, c = 2 * Math.PI * r, progress = state.totalMs ? 1 - left() / state.totalMs : 0;
    return `<svg viewBox="0 0 ${size} ${size}"><circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${width}"/><circle class="fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${width}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress)}"/></svg>`;
  }
  function render() {
    if (!state) return;
    const settings = state.settings, idle = state.phase === 'idle', card = settings.floatSize === 'card' || finished;
    const phase = idle ? '准备开始' : state.phase === 'break' ? (state.long ? '长休息' : '休息中') : `专注中 · 第 ${state.round} 个`;
    const toggle = idle ? `<button class="ib" data-cmd="start" aria-label="开始专注">${icon('play')}</button>`
      : `<button class="ib" data-cmd="${state.running ? 'pause' : 'resume'}" aria-label="${state.running ? '暂停' : '继续'}">${icon(state.running ? 'pause' : 'play')}</button>`;
    const pin = `<button class="ib pin" data-cmd="unpin" aria-label="取消固定">${icon('pin')}</button>`;
    // 只有这个按钮会把 MemoKeep 主窗口叫出来；点悬浮条别的地方不会。
    const openApp = `<button class="ib" data-cmd="open-app" aria-label="打开 MemoKeep">${icon('app')}</button>`;
    // 背景颜色：调色板按钮打开一排色块，点一个立即生效；再点调色板或按 Esc 不改直接返回。
    document.documentElement.dataset.color = settings.floatColor;
    const palette = `<button class="ib${picking ? ' on' : ''}" data-cmd="colors" aria-label="${picking ? '返回计时' : '背景颜色'}" aria-pressed="${picking}">${icon('palette')}</button>`;
    const swatches = `<div class="swatches" role="radiogroup" aria-label="背景颜色">${P.FLOAT_COLORS.map(color => `<button class="sw" role="radio" data-color="${color.id}" aria-checked="${color.id === settings.floatColor}" aria-label="${color.name}" style="--c:${color.swatch}"></button>`).join('')}<span class="name">${colorName(hoverColor || settings.floatColor)}</span></div>`;
    root.className = `float${idle && !picking ? ' idle' : ''}${state.phase === 'break' ? ' break' : ''}`;
    if (!card && picking) {
      root.innerHTML = `<div class="shell pill picking">${icon('grip').replace('class="i"', 'class="i grip"')}${swatches}${palette}</div>`;
      updateTip();
      return;
    }
    if (!card) {
      root.innerHTML = `<div class="shell pill">${icon('grip').replace('class="i"', 'class="i grip"')}<span class="ring">${ring(32, 3.5)}</span><span class="time">${P.clock(left())}</span>
        <span class="label">${idle ? '开始专注' : state.phase === 'break' ? '休息一下' : esc(planName(state.planId))}${!idle && !state.running ? ' · 已暂停' : ''}</span>${toggle}
        <button class="ib" data-cmd="card" aria-label="展开">${icon('expand')}</button>${palette}${openApp}${pin}</div>`;
      updateTip();
      return;
    }
    const actions = finished ? (state.phase === 'break' && !state.running ? `<button class="primary" data-cmd="resume">休息 ${Math.round(state.totalMs / 60000)} 分钟</button><button data-cmd="start">继续专注</button>` : `<button data-cmd="dismiss">知道了</button>`)
      : idle ? `<button class="primary" data-cmd="start">开始专注</button>`
      : state.phase === 'focus' ? `<button data-cmd="${state.running ? 'pause' : 'resume'}">${state.running ? '暂停' : '继续'}</button><button data-cmd="stop">结束</button>`
      : `<button data-cmd="${state.running ? 'pause' : 'resume'}">${state.running ? '暂停' : '开始休息'}</button><button data-cmd="skip">跳过休息</button>`;
    const meta = finished ? `<b>完成一个番茄</b><span>${finished.session ? `${finished.session.minutes} 分钟记入「${esc(planName(finished.session.planId))}」` : '专注完成'}</span>`
      : `<b>${esc(planName(state.planId))}</b><span>${idle ? `专注 ${settings.focus} 分钟` : state.running ? '计时中' : '已暂停'}</span><span>本轮第 ${state.round}/${state.every} 个番茄</span>`;
    root.innerHTML = `<div class="shell card${finished ? ' finished' : ''}">
      <div class="top">${icon('grip').replace('class="i"', 'class="i grip"')}<span class="phase">${phase}</span>${palette}<button class="ib" data-cmd="pill" aria-label="收成胶囊">${icon('shrink')}</button>${openApp}${pin}</div>
      <div class="body"><span class="ring">${ring(88, 7)}<span class="time">${P.clock(left())}</span></span><span class="meta">${meta}</span></div>
      <div class="acts">${actions}</div>
      ${picking ? swatches : `<div class="foot"><span>今天 ${P.formatMinutes(todayMinutes())}</span><span>${state.planId ? `「${esc(planName(state.planId))}」累计 ${P.formatMinutes(planMinutes(state.planId))}` : ''}</span></div>`}</div>`;
    updateTip();
  }

  root.addEventListener('click', event => {
    const swatch = event.target.closest('.sw');
    if (swatch) { picking = false; hoverColor = null; void api.command('float-color', { color: swatch.dataset.color }); render(); return; }
    const button = event.target.closest('[data-cmd]'); if (!button) return;
    const cmd = button.dataset.cmd;
    if (cmd === 'colors') { picking = !picking; hoverColor = null; render(); return; }
    if (cmd === 'dismiss') { finished = null; render(); return; }
    if (cmd === 'card' || cmd === 'pill') { picking = false; void api.command('float-size', { size: cmd }); return; }
    if (cmd === 'unpin') { void api.command('pin', { pinned: false }); return; }
    if (cmd === 'open-app') { void api.openApp?.(); return; }
    if (cmd === 'start' || cmd === 'resume') finished = null;
    void api.command(cmd);
  });
  // 拖动：按住空白处（按钮以外）移动整个悬浮窗，松手就停在那里。
  let drag = null, dragFrame = 0;
  root.addEventListener('pointerdown', async event => {
    if (event.button !== 0 || event.target.closest('button') || !api.getFloatPosition) return;
    event.preventDefault();
    root.setPointerCapture(event.pointerId);
    const origin = await api.getFloatPosition(); if (!origin) return;
    drag = { id: event.pointerId, startX: event.screenX, startY: event.screenY, originX: origin.x, originY: origin.y, x: origin.x, y: origin.y, moved: false };
  });
  // 移动和松手监听整个页面：指针移出悬浮窗内容时也不能丢事件。
  window.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.screenX - drag.startX, dy = event.screenY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) { drag.moved = true; root.classList.add('dragging'); }
    drag.x = drag.originX + dx; drag.y = drag.originY + dy;
    // 不用 requestAnimationFrame：没有焦点的窗口里它可能不触发。同一时间只发一次移动，落后的位置在返回后补上。
    if (dragFrame) return;
    const send = () => { dragFrame = 1; const target = { x: drag.x, y: drag.y }; api.moveFloat(target).finally(() => { dragFrame = 0; if (drag && (drag.x !== target.x || drag.y !== target.y)) send(); }); };
    send();
  });
  const endDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const done = drag; drag = null; root.classList.remove('dragging');
    if (done.moved) void api.moveFloat({ x: done.x, y: done.y }, true);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', () => { if (drag) endDrag({ pointerId: drag.id }); });
  // 键盘：聚焦悬浮窗时方向键每次移动 10px（按住 Shift 移动 40px）。
  root.tabIndex = -1;
  root.addEventListener('keydown', async event => {
    if (event.key === 'Escape' && picking) { picking = false; render(); return; }
    const step = event.shiftKey ? 40 : 10, delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta || event.target.closest('button') || !api.getFloatPosition) return;
    event.preventDefault();
    const origin = await api.getFloatPosition(); if (origin) void api.moveFloat({ x: origin.x + delta[0], y: origin.y + delta[1] }, true);
  });
  api.onState(async ({ state: next, event }) => {
    state = next;
    if (event?.type === 'focus-complete' || event?.type === 'focus-stopped') await refreshData();
    if (event?.type === 'focus-complete') {
      finished = event; clearTimeout(finishedTimer);
      finishedTimer = setTimeout(() => { finished = null; render(); }, 6000);
    }
    if (state.planId && !plans.has(state.planId)) await refreshData();
    render();
  });
  // 每秒刷新倒计时；计时状态以主进程为准。
  setInterval(() => { if (state?.running) render(); }, 1000);
  (async () => { await refreshData(); state = await api.get(); render(); })();
})();
