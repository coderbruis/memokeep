// 番茄钟状态机（design/prototype/pomodoro-20261109.md）。纯函数：传入当前时间，返回新状态和事件。
// 桌面版由主进程驱动，应用窗口、桌宠和悬浮窗共享同一个状态；浏览器里由页面自己驱动。
(function expose(root) {
  const MINUTE = 60_000;
  const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, autoBreak: true, autoFocus: false, sound: true, pinned: false, floatSize: 'pill', floatColor: 'auto' };
  // 悬浮窗背景颜色（design/prototype/pomodoro-float-colors-20261116.html）：auto 跟随系统深浅色，其余是固定颜色。
  const FLOAT_COLORS = [{ id: 'auto', name: '默认', swatch: '#fff' }, { id: 'ink', name: '墨黑', swatch: '#1e2129' }, { id: 'tomato', name: '番茄', swatch: '#c44238' },
    { id: 'mint', name: '薄荷', swatch: '#cfeadf' }, { id: 'sky', name: '天空', swatch: '#cfdcf8' }, { id: 'apricot', name: '暖杏', swatch: '#f6dcb4' }];
  const LIMITS = { focus: [5, 120], short: [1, 30], long: [5, 60], every: [2, 8] };

  function normalizeSettings(input = {}) {
    const settings = { ...DEFAULTS };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const value = Math.round(Number(input[key]));
      if (Number.isFinite(value)) settings[key] = Math.min(max, Math.max(min, value));
    }
    for (const key of ['autoBreak', 'autoFocus', 'sound', 'pinned']) if (typeof input[key] === 'boolean') settings[key] = input[key];
    if (['pill', 'card'].includes(input.floatSize)) settings.floatSize = input.floatSize;
    if (FLOAT_COLORS.some(color => color.id === input.floatColor)) settings.floatColor = input.floatColor;
    if (typeof input.lastPlanId === 'string' || input.lastPlanId === null) settings.lastPlanId = input.lastPlanId;
    if (input.floatPosition && Number.isFinite(input.floatPosition.x) && Number.isFinite(input.floatPosition.y)) settings.floatPosition = { x: input.floatPosition.x, y: input.floatPosition.y };
    return settings;
  }

  const idle = (settings, keep = {}) => ({
    phase: 'idle', running: false, endsAt: null, leftMs: settings.focus * MINUTE, totalMs: settings.focus * MINUTE,
    planId: keep.planId ?? null, taskId: null, taskName: '', doneInCycle: keep.doneInCycle || 0,
    focusStartedAt: null, focusElapsedMs: 0, runningSince: null,
  });
  function initialState(settings = DEFAULTS) { return idle(normalizeSettings(settings)); }

  function leftMs(state, now) { return state.running && state.endsAt ? Math.max(0, state.endsAt - now) : state.leftMs; }
  function snapshot(state, settings, now) {
    const left = leftMs(state, now);
    return { ...state, leftMs: left, round: (state.doneInCycle % settings.every) + 1, every: settings.every, settings };
  }
  // 暂停时把已走的专注时间存起来；只统计真正在计时的时间。
  function stopRunning(state, now) {
    if (!state.running) return state;
    const ran = Math.max(0, Math.min(now, state.endsAt) - state.runningSince);
    return { ...state, running: false, leftMs: Math.max(0, state.endsAt - now), endsAt: null, runningSince: null,
      focusElapsedMs: state.phase === 'focus' ? state.focusElapsedMs + ran : state.focusElapsedMs };
  }
  const run = (state, now) => ({ ...state, running: true, runningSince: now, endsAt: now + state.leftMs });

  function start(state, settings, now, { planId = state.planId, taskId = null, taskName = '' } = {}) {
    const total = settings.focus * MINUTE;
    return run({ ...idle(settings, { planId, doneInCycle: state.doneInCycle }), phase: 'focus', planId, taskId, taskName: String(taskName || '').slice(0, 120),
      leftMs: total, totalMs: total, focusStartedAt: now }, now);
  }
  function pause(state, now) { return stopRunning(state, now); }
  function resume(state, now) { return state.phase === 'idle' || state.running ? state : run(state, now); }
  function setPlan(state, planId) { return { ...state, planId: planId || null }; }

  function sessionFrom(state, endedAt) {
    const minutes = Math.round(state.focusElapsedMs / MINUTE);
    if (minutes < 1) return null;
    return { planId: state.planId, taskId: state.taskId, taskName: state.taskName, startedAt: new Date(state.focusStartedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), minutes };
  }
  function startBreak(state, settings, now) {
    const long = state.doneInCycle > 0 && state.doneInCycle % settings.every === 0;
    const total = (long ? settings.long : settings.short) * MINUTE;
    const next = { ...state, phase: 'break', long, running: false, leftMs: total, totalMs: total, endsAt: null, runningSince: null, focusStartedAt: null, focusElapsedMs: 0 };
    return settings.autoBreak ? run(next, now) : next;
  }
  // 提前结束：满 1 分钟按实际专注时长记录。
  function stop(state, settings, now) {
    if (state.phase !== 'focus') return { state: idle(settings, state), events: [] };
    const stopped = stopRunning(state, now), session = sessionFrom(stopped, now);
    return { state: idle(settings, state), events: [{ type: 'focus-stopped', session }] };
  }
  function skip(state, settings, now) {
    if (state.phase === 'break') return { state: idle(settings, state), events: [{ type: 'break-skipped' }] };
    return { state, events: [] };
  }
  function tick(state, settings, now) {
    if (!state.running || now < state.endsAt) return { state, events: [] };
    if (state.phase === 'focus') {
      const ended = state.endsAt, finished = stopRunning(state, ended), session = sessionFrom(finished, ended);
      const counted = { ...finished, doneInCycle: finished.doneInCycle + 1 };
      return { state: startBreak(counted, settings, now), events: [{ type: 'focus-complete', session }] };
    }
    const rested = idle(settings, state);
    return { state: settings.autoFocus ? start(rested, settings, now, { planId: state.planId }) : rested, events: [{ type: 'break-complete' }] };
  }

  // 统计：专注记录按开始那天计入。
  const dayOf = iso => { const date = new Date(iso); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  function minutesByDay(sessions, planId) {
    const map = new Map();
    for (const session of sessions || []) {
      if (planId !== undefined && session.planId !== planId) continue;
      const day = dayOf(session.startedAt);
      map.set(day, (map.get(day) || 0) + Number(session.minutes || 0));
    }
    return map;
  }
  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(total));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  const clock = ms => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };

  const api = { MINUTE, DEFAULTS, LIMITS, FLOAT_COLORS, normalizeSettings, initialState, snapshot, leftMs, start, pause, resume, stop, skip, tick, setPlan, dayOf, minutesByDay, formatMinutes, clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepPomodoro = api;
})(globalThis);
