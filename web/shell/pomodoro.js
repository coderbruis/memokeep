// 番茄钟：侧栏入口与面板（design/prototype/pomodoro-20261109.md）。
// 桌面版计时在主进程；浏览器里没有主进程，由页面用同一个状态机计时。
(function expose(root) {
  function createPomodoroFeatures({ state, config, actions, env }) {
    const P = root.MemoKeepPomodoro, Plans = root.MemoKeepPlans;
    const e = value => actions.escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
    const icon = (id, className = '') => `<svg class="${className}" aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
    const listeners = new Set();
    let timer = null, current = null, lastEvent = null, panelSettings = false, tickHandle = null;

    /* ---------- 计时来源 ---------- */
    function localTimer() {
      let settings = P.normalizeSettings(state.persistence.data.settings?.pomodoro), timerState = { ...P.initialState(settings), planId: settings.lastPlanId ?? null }, handle = null;
      const view = () => P.snapshot(timerState, settings, Date.now());
      const emit = event => listeners.forEach(listener => listener({ state: view(), event }));
      const transact = change => env.application.persistence.transact(change);
      async function saveSettings(patch) {
        settings = P.normalizeSettings({ ...settings, ...patch });
        await transact(data => { data.settings = { ...data.settings, pomodoro: { ...settings } }; });
      }
      async function record(events) {
        for (const event of events) {
          if (!event.session) continue;
          event.session = { id: config.uid(), ...event.session };
          const session = event.session;
          await transact(data => { (data.focusSessions ||= []).push(session); });
        }
        return events.at(-1) || null;
      }
      function schedule() {
        clearTimeout(handle);
        if (!timerState.running) return;
        handle = env.setTimeout(async () => {
          const result = P.tick(timerState, settings, Date.now());
          timerState = result.state; schedule();
          emit(await record(result.events));
        }, Math.max(50, timerState.endsAt - Date.now() + 20));
      }
      async function command(type, payload = {}) {
        let event = null; const at = Date.now();
        if (type === 'start') {
          const planId = payload.planId !== undefined ? payload.planId || null : timerState.planId;
          timerState = P.start(timerState, settings, at, { planId, taskId: payload.taskId, taskName: payload.taskName });
          if (planId !== settings.lastPlanId) await saveSettings({ lastPlanId: planId });
        } else if (type === 'pause') timerState = P.pause(timerState, at);
        else if (type === 'resume') timerState = P.resume(timerState, at);
        else if (type === 'stop' || type === 'skip') { const result = P[type](timerState, settings, at); timerState = result.state; event = await record(result.events); }
        else if (type === 'set-plan') { timerState = P.setPlan(timerState, payload.planId); await saveSettings({ lastPlanId: timerState.planId }); }
        else if (type === 'settings') {
          await saveSettings(payload);
          if (timerState.phase === 'idle') timerState = { ...P.initialState(settings), planId: timerState.planId, doneInCycle: timerState.doneInCycle };
        } else if (type === 'float-color') await saveSettings({ floatColor: payload.color });
        else return view();
        schedule(); emit(event);
        return view();
      }
      return { desktop: false, get: async () => view(), command, onState: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
    }
    function source() {
      if (timer) return timer;
      const desktop = env.window.memoKeepDesktop?.pomodoro;
      timer = desktop ? { desktop: true, get: desktop.get, command: desktop.command, onState: desktop.onState, onOpenPanel: desktop.onOpenPanel } : localTimer();
      return timer;
    }

    /* ---------- 数据 ---------- */
    const sessions = () => state.persistence.data.focusSessions || [];
    const today = () => Plans.dayKey(config.now());
    const minutesToday = () => P.minutesByDay(sessions()).get(today()) || 0;
    const planMinutes = planId => sessions().filter(session => session.planId === planId).reduce((sum, session) => sum + Number(session.minutes || 0), 0);
    const plans = () => state.persistence.data.plans || [];
    const activePlans = () => plans().filter(plan => !Plans.planEnded(plan, today()) && plan.startDate <= today());
    const planName = id => plans().find(plan => plan.id === id)?.name || '';
    const left = () => current ? (current.running && current.endsAt ? Math.max(0, current.endsAt - Date.now()) : current.leftMs) : 0;

    /* ---------- 侧栏入口 ---------- */
    function renderPomodoroPill() {
      const pill = config.$('#pomodoroPill');
      if (!pill || !current) return;
      const idle = current.phase === 'idle', progress = current.totalMs ? 1 - left() / current.totalMs : 0, c = 2 * Math.PI * 7;
      pill.classList.toggle('active', !idle);
      pill.classList.toggle('break', current.phase === 'break');
      const label = idle ? `番茄钟 · 今天 ${P.formatMinutes(minutesToday())}` : current.phase === 'break' ? '休息中' : planName(current.planId) || '专注中';
      pill.innerHTML = idle ? `${icon('timer', 'pomodoro-pill-icon')}<span class="pomodoro-pill-label">${e(label)}</span>`
        : `<svg class="pomodoro-pill-ring" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7"/><circle cx="9" cy="9" r="7" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress)}"/></svg><b>${P.clock(left())}</b><span class="pomodoro-pill-label">${e(label)}${current.running ? '' : ' · 已暂停'}</span>`;
      pill.setAttribute('aria-label', idle ? `打开番茄钟，今天专注 ${P.formatMinutes(minutesToday())}` : `番茄钟：${current.phase === 'break' ? '休息' : '专注'}剩余 ${P.clock(left())}`);
      pill.title = idle ? '番茄钟' : `${label} · ${P.clock(left())}`;
    }

    /* ---------- 面板 ---------- */
    function step(key, unit, presets) {
      const settings = current.settings;
      return `<div class="pomodoro-set-row"><span>${{ focus: '专注', short: '短休息', long: '长休息', every: '长休息间隔' }[key]}</span>
        ${presets ? `<span class="pomodoro-presets">${presets.map(value => `<button type="button" data-pomodoro-set="${key}" data-value="${value}" aria-pressed="${settings[key] === value}">${value}</button>`).join('')}</span>` : ''}
        <span class="pomodoro-stepper"><button type="button" data-pomodoro-step="${key}" data-dir="-1" aria-label="减少${unit}">${icon('minus')}</button><output aria-live="polite">${settings[key]} ${unit}</output><button type="button" data-pomodoro-step="${key}" data-dir="1" aria-label="增加${unit}">${icon('plus')}</button></span></div>`;
    }
    const toggle = (key, label) => `<div class="pomodoro-set-row"><span>${label}</span><button type="button" class="pomodoro-switch" role="switch" data-pomodoro-switch="${key}" aria-checked="${current.settings[key]}" aria-label="${label}"></button></div>`;
    function renderPanel() {
      const panel = config.$('#pomodoroPanel');
      if (!panel || !current || !panel.matches(':popover-open')) return;
      const s = current.settings, idle = current.phase === 'idle', progress = current.totalMs ? 1 - left() / current.totalMs : 0, c = 2 * Math.PI * 95;
      const label = current.phase === 'focus' ? (current.running ? '专注中' : '已暂停') : current.phase === 'break' ? (current.running ? (current.long ? '长休息中' : '休息中') : '休息 · 未开始') : '准备开始';
      const buttons = idle ? `<button type="button" class="pomodoro-button primary" data-pomodoro="start">${icon('play')}开始专注</button>`
        : current.phase === 'focus' ? `<button type="button" class="pomodoro-button" data-pomodoro="${current.running ? 'pause' : 'resume'}">${icon(current.running ? 'pause' : 'play')}${current.running ? '暂停' : '继续'}</button><button type="button" class="pomodoro-button" data-pomodoro="stop">${icon('square')}结束</button>`
        : `<button type="button" class="pomodoro-button" data-pomodoro="${current.running ? 'pause' : 'resume'}">${icon(current.running ? 'pause' : 'play')}${current.running ? '暂停' : '开始休息'}</button><button type="button" class="pomodoro-button" data-pomodoro="skip">${icon('skip-forward')}跳过休息</button>`;
      const done = current.doneInCycle % s.every, rounds = Array.from({ length: s.every }, (_, index) => `<i class="${index < done || (current.phase === 'break' && done === 0 && current.doneInCycle) ? 'done' : index === done && current.phase === 'focus' ? 'now' : ''}"></i>`).join('');
      const choices = activePlans();
      const missing = current.planId && !choices.some(plan => plan.id === current.planId) ? `<option value="${e(current.planId)}" selected>${e(planName(current.planId) || '已删除的计划')}</option>` : '';
      const total = current.planId ? planMinutes(current.planId) : 0;
      panel.innerHTML = `<div class="pomodoro-head"><h2>番茄钟</h2><span></span>
          <button type="button" class="pomodoro-icon" data-pomodoro="settings" aria-pressed="${panelSettings}" aria-label="时长设置" title="时长设置">${icon('settings')}</button>
          <button type="button" class="pomodoro-icon" data-pomodoro="close" aria-label="关闭">${icon('x')}</button></div>
        <div class="pomodoro-phases" aria-hidden="true"><span class="${current.phase !== 'break' ? 'on' : ''}">专注 ${s.focus} 分钟</span><span class="${current.phase === 'break' ? 'on' : ''}">休息 ${current.phase === 'break' ? Math.round(current.totalMs / 60000) : s.short} 分钟</span></div>
        <div class="pomodoro-dial${current.phase === 'break' ? ' break' : ''}" role="timer" aria-label="${label}，剩余 ${P.clock(left())}"><svg viewBox="0 0 210 210" aria-hidden="true"><circle class="bg" cx="105" cy="105" r="95"/><circle class="fg" cx="105" cy="105" r="95" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress)}"/></svg><div><b>${P.clock(left())}</b><span>${label}${current.taskName && current.phase === 'focus' ? ` · ${e(current.taskName)}` : ''}</span></div></div>
        <div class="pomodoro-rounds" aria-label="本轮第 ${current.round} 个番茄，共 ${s.every} 个">${rounds}</div>
        <label class="pomodoro-plan">${icon('calendar-days')}<span>记到</span><select data-pomodoro-plan aria-label="专注时间记到哪个计划">${choices.map(plan => `<option value="${e(plan.id)}" ${plan.id === current.planId ? 'selected' : ''}>${e(plan.name)}</option>`).join('')}${missing}<option value="" ${current.planId ? '' : 'selected'}>不归入计划</option></select></label>
        <div class="pomodoro-controls">${buttons}</div>
        ${source().desktop ? `<div class="pomodoro-pin${s.pinned ? ' on' : ''}">${icon(s.pinned ? 'pin' : 'pin-off')}<span>固定在桌面<small>${s.pinned ? '悬浮在所有窗口最上层，收起 MemoKeep 也能看到' : '开启后番茄钟悬浮在所有窗口最上层'}</small></span><button type="button" class="pomodoro-switch" role="switch" data-pomodoro-pin aria-checked="${s.pinned}" aria-label="固定在桌面"></button></div>${s.pinned ? `<div class="pomodoro-float-color"><span>悬浮窗颜色<small>${e(P.FLOAT_COLORS.find(color => color.id === s.floatColor)?.name || '')}${s.floatColor === 'auto' ? ' · 跟随系统深浅色' : ''}</small></span><span class="pomodoro-swatches" role="radiogroup" aria-label="悬浮窗颜色">${P.FLOAT_COLORS.map(color => `<button type="button" role="radio" data-pomodoro-float-color="${color.id}" aria-checked="${color.id === s.floatColor}" aria-label="${color.name}" title="${color.name}" style="--c:${color.swatch}"></button>`).join('')}</span></div>` : ''}` : ''}
        <p class="pomodoro-today">今天专注 <b>${P.formatMinutes(minutesToday())}</b>${current.planId ? `<br>「${e(planName(current.planId))}」累计 <b>${P.formatMinutes(total)}</b>` : ''}</p>
        ${lastEvent?.type === 'focus-stopped' && !lastEvent.session ? '<p class="pomodoro-note" role="status">不到 1 分钟，没有记录。</p>' : ''}
        ${panelSettings ? `<div class="pomodoro-settings"><h3>时长</h3>${step('focus', '分钟', [25, 45, 60])}${step('short', '分钟')}${step('long', '分钟')}${step('every', '个番茄')}
          ${toggle('autoBreak', '专注结束后自动开始休息')}${toggle('autoFocus', '休息结束后自动开始专注')}${toggle('sound', '结束时提示音')}
          <p class="pomodoro-note">修改从下一个番茄开始生效。</p></div>` : ''}`;
    }
    function render() { renderPomodoroPill(); renderPanel(); actions.renderPomodoroInPlans?.(); if (!config.$('#homeView')?.classList.contains('hidden')) actions.renderTodayFocus?.(); }

    function openPomodoro(options = {}) {
      const panel = config.$('#pomodoroPanel'); if (!panel) return;
      if (!panel.matches(':popover-open')) panel.showPopover();
      renderPanel();
      if (options.start && current?.phase === 'idle') void command('start', { planId: options.planId ?? current.planId, taskId: options.taskId, taskName: options.taskName });
      else if (options.planId !== undefined && current?.phase === 'idle') void command('set-plan', { planId: options.planId });
      panel.querySelector('[data-pomodoro="start"], [data-pomodoro="pause"], [data-pomodoro="resume"]')?.focus();
    }
    async function command(type, payload) {
      try {
        current = await source().command(type, payload);
        render();
      } catch (error) { actions.showToast(`番茄钟：${error.message}`, true); }
    }
    async function deleteFocusSession(id) {
      await env.application.persistence.transact(data => { data.focusSessions = (data.focusSessions || []).filter(session => session.id !== id); });
      render();
    }

    function bindPomodoro() {
      const pill = config.$('#pomodoroPill'), panel = config.$('#pomodoroPanel');
      if (!pill || !panel || panel.dataset.bound) return;
      panel.dataset.bound = 'true';
      // 侧栏入口用原生 popovertarget 打开 / 关闭面板。
      panel.addEventListener('toggle', event => { pill.setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState === 'open') { renderPanel(); panel.querySelector('.pomodoro-controls button')?.focus(); } });
      panel.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button) return;
        const data = button.dataset, s = current.settings;
        if (data.pomodoro === 'close') { panel.hidePopover(); pill.focus(); }
        else if (data.pomodoro === 'settings') { panelSettings = !panelSettings; renderPanel(); panel.querySelector('[data-pomodoro="settings"]')?.focus(); }
        else if (data.pomodoro) void command(data.pomodoro).then(() => panel.querySelector('.pomodoro-controls button')?.focus());
        else if (data.pomodoroFloatColor) void command('float-color', { color: data.pomodoroFloatColor }).then(() => panel.querySelector(`[data-pomodoro-float-color="${data.pomodoroFloatColor}"]`)?.focus());
        else if (data.pomodoroPin !== undefined) void command('pin', { pinned: !s.pinned }).then(() => panel.querySelector('[data-pomodoro-pin]')?.focus());
        else if (data.pomodoroSwitch) void command('settings', { [data.pomodoroSwitch]: !s[data.pomodoroSwitch] }).then(() => panel.querySelector(`[data-pomodoro-switch="${data.pomodoroSwitch}"]`)?.focus());
        else if (data.pomodoroSet) void command('settings', { [data.pomodoroSet]: Number(data.value) }).then(() => panel.querySelector(`[data-pomodoro-set="${data.pomodoroSet}"][data-value="${data.value}"]`)?.focus());
        else if (data.pomodoroStep) {
          const key = data.pomodoroStep, size = key === 'focus' || key === 'long' ? 5 : 1;
          void command('settings', { [key]: s[key] + Number(data.dir) * size }).then(() => panel.querySelector(`[data-pomodoro-step="${key}"][data-dir="${data.dir}"]`)?.focus());
        }
      });
      panel.addEventListener('change', event => {
        if (event.target.matches('[data-pomodoro-plan]')) void command('set-plan', { planId: event.target.value || null });
      });
      const timerSource = source();
      timerSource.onState(({ state: next, event }) => {
        current = next;
        if (event) {
          lastEvent = event;
          if (event.type === 'focus-complete' && !timerSource.desktop) actions.showToast(event.session ? `完成一个番茄，${event.session.minutes} 分钟${planName(event.session.planId) ? `记入「${planName(event.session.planId)}」` : '已记录'}` : '专注完成');
        }
        render();
      });
      timerSource.onOpenPanel?.(() => openPomodoro());
      void timerSource.get().then(next => { if (next) { current = next; render(); } });
      tickHandle = env.window.setInterval(() => { if (current?.running) { renderPomodoroPill(); renderPanel(); } }, 1000);
    }

    return { openPomodoro, pomodoroState: () => current, pomodoroCommand: command, deleteFocusSession, renderPomodoroPill, bindPomodoro };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createPomodoroFeatures });
})(globalThis);
