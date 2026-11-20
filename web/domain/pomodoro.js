// 番茄钟状态机（design/prototype/pomodoro-20261109.md）。纯函数：传入当前时间，返回新状态和事件。
// 桌面版由主进程驱动，应用窗口、桌宠和悬浮窗共享同一个状态；浏览器里由页面自己驱动。
(function expose(root) {
  const MINUTE = 60_000;
  let aggregationProvider = null;
  const newId = now => root.crypto?.randomUUID?.() || `focus-${now}-${Math.random().toString(36).slice(2, 14)}`;
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

  function leftMs(state, now) { return state.running && state.endsAt ? Math.min(state.leftMs, Math.max(0, state.endsAt - now)) : state.leftMs; }
  function snapshot(state, settings, now) {
    const left = leftMs(state, now);
    return { ...state, leftMs: left, round: (state.doneInCycle % settings.every) + 1, every: settings.every, settings };
  }
  // 暂停时把已走的专注时间存起来；只统计真正在计时的时间。
  function stopRunning(state, now) {
    if (!state.running) return state;
    const ran = Math.max(0, Math.min(now, state.endsAt) - state.runningSince);
    const tracked = state.phase === 'focus' && Array.isArray(state.activeIntervals), end = Math.min(now, state.endsAt);
    const intervals = tracked ? [...state.activeIntervals, ...(end > state.runningSince ? [{ start: state.runningSince, end }] : [])] : state.activeIntervals;
    return { ...state, ...(tracked ? { activeIntervals: intervals } : {}), clockUncertain: state.clockUncertain || now < state.runningSince, running: false, leftMs: Math.max(0, state.leftMs - ran), endsAt: null, runningSince: null,
      focusElapsedMs: state.phase === 'focus' ? state.focusElapsedMs + ran : state.focusElapsedMs };
  }
  const run = (state, now) => ({ ...state, running: true, runningSince: now, endsAt: now + state.leftMs });

  function start(state, settings, now, { planId = state.planId, taskId = null, taskName = '', sessionId = newId(now) } = {}) {
    const total = settings.focus * MINUTE;
    return run({ ...idle(settings, { planId, doneInCycle: state.doneInCycle }), phase: 'focus', planId, taskId, taskName: String(taskName || '').slice(0, 120),
      leftMs: total, totalMs: total, focusStartedAt: now, focusSessionId: sessionId, activeIntervals: [], clockUncertain: false }, now);
  }
  function pause(state, now) { return stopRunning(state, now); }
  function resume(state, now) { return state.phase === 'idle' || state.running ? state : run(state, now); }
  function setPlan(state, planId) { return { ...state, planId: planId || null }; }

  function sessionFrom(state, endedAt, outcome) {
    const minutes = Math.round(state.focusElapsedMs / MINUTE);
    const exact = Array.isArray(state.activeIntervals) && !!state.focusSessionId;
    return { ...(state.focusSessionId ? { id: state.focusSessionId, originSessionId: state.focusSessionId } : {}), planId: state.planId, taskId: state.taskId, taskName: state.taskName, startedAt: new Date(state.focusStartedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), minutes,
      activeDurationMs: state.focusElapsedMs, outcome, activeIntervals: exact ? state.activeIntervals.map(row => ({ start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString() })) : [], timeAccuracy: exact ? state.clockUncertain ? 'clock-uncertain' : 'exact' : 'legacy-summary' };
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
    const stopped = stopRunning(state, now), session = sessionFrom(stopped, now, 'stopped');
    return { state: idle(settings, state), events: [{ type: 'focus-stopped', session }] };
  }
  function skip(state, settings, now) {
    if (state.phase === 'break') return { state: idle(settings, state), events: [{ type: 'break-skipped' }] };
    return { state, events: [] };
  }
  function tick(state, settings, now) {
    if (!state.running || now < state.endsAt) return { state, events: [] };
    if (state.phase === 'focus') {
      const ended = state.endsAt, finished = stopRunning(state, ended), session = sessionFrom(finished, ended, 'completed');
      const counted = { ...finished, doneInCycle: finished.doneInCycle + 1 };
      return { state: startBreak(counted, settings, now), events: [{ type: 'focus-complete', session }] };
    }
    const rested = idle(settings, state);
    return { state: settings.autoFocus ? start(rested, settings, now, { planId: state.planId }) : rested, events: [{ type: 'break-complete' }] };
  }

  // 统计：专注记录按开始那天计入。
  const localDayOf = iso => { const date = new Date(iso); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  const dayOf = iso => aggregationProvider?.dayKey ? aggregationProvider.dayKey(iso) : localDayOf(iso);
  function setAggregationProvider(provider) {
    if (provider !== null && typeof provider !== 'function' && typeof provider?.aggregate !== 'function') throw new Error('专注统计接口无效');
    aggregationProvider = provider; return () => { if (aggregationProvider === provider) aggregationProvider = null; };
  }
  function statistics(sessions, options = {}) {
    const fallback = () => defaultStatistics(sessions, options);
    if (aggregationProvider) return (typeof aggregationProvider === 'function' ? aggregationProvider : aggregationProvider.aggregate)(sessions, { ...options, fallback });
    return fallback();
  }
  function defaultStatistics(sessions, options = {}) {
    const map = new Map(), completedByDay = new Map(), known = new Set();
    let completedCount = 0, sessionCount = 0;
    for (const session of sessions || []) {
      if (session.id && known.has(session.id)) continue; if (session.id) known.add(session.id);
      if (options.planId !== undefined && session.planId !== options.planId) continue;
      const duration = Number(session.activeDurationMs ?? Number(session.minutes || 0) * MINUTE);
      if (!Number.isFinite(duration) || duration < MINUTE || !['completed', 'stopped'].includes(session.outcome || 'completed') || session.timeAccuracy === 'clock-uncertain' || session.voided) continue;
      sessionCount++;
      if (session.timeAccuracy === 'exact' && session.activeIntervals?.length) {
        for (const interval of session.activeIntervals) {
          let cursor = new Date(interval.start).getTime(), end = new Date(interval.end).getTime();
          if (!Number.isFinite(cursor) || !Number.isFinite(end) || end < cursor) continue;
          while (cursor < end) { const next = new Date(cursor); next.setHours(24, 0, 0, 0); const stop = Math.min(end, next.getTime()), day = localDayOf(cursor); map.set(day, (map.get(day) || 0) + (stop - cursor) / MINUTE); cursor = stop; }
        }
      } else {
        const day = session.legacyDayKey || localDayOf(session.startedAt || session.endedAt);
        map.set(day, (map.get(day) || 0) + duration / MINUTE);
      }
      if (!session.outcome || session.outcome === 'completed') { const day = session.timeAccuracy === 'exact' ? localDayOf(session.endedAt) : session.legacyDayKey || localDayOf(session.startedAt || session.endedAt); completedByDay.set(day, (completedByDay.get(day) || 0) + 1); completedCount++; }
    }
    return { byDay: map, totalMinutes: [...map.values()].reduce((sum, value) => sum + value, 0), completedByDay, completedCount, sessionCount };
  }
  const minutesByDay = (sessions, planId) => statistics(sessions, { planId }).byDay;
  const totalMinutes = (sessions, planId) => statistics(sessions, { planId }).totalMinutes;
  const completedCount = (sessions, { planId, day } = {}) => { const summary = statistics(sessions, { planId }); return day ? summary.completedByDay.get(day) || 0 : summary.completedCount; };
  function roundMinutes(total) {
    const value = Number(total);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }
  function formatMinutes(total) {
    const minutes = roundMinutes(total);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  const clock = ms => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };

  const api = { MINUTE, DEFAULTS, LIMITS, FLOAT_COLORS, normalizeSettings, initialState, snapshot, leftMs, start, pause, resume, stop, skip, tick, setPlan, dayOf, setAggregationProvider, statistics, minutesByDay, totalMinutes, completedCount, roundMinutes, formatMinutes, clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepPomodoro = api;
})(globalThis);
