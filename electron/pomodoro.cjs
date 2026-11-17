// 番茄钟主进程服务：计时只在这里走，应用窗口、桌宠和悬浮窗通过 IPC 共享同一个状态。
// 「固定在桌面」时打开置顶的悬浮窗（design/prototype/pomodoro-20261109.md）。
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const P = require('../web/domain/pomodoro.js');

const FLOAT_SIZES = { pill: { width: 382, height: 66 }, card: { width: 300, height: 252 } };
const EDGE = 16;

function createPomodoroService({ BrowserWindow, screen, Notification, readData, writeData, windows, afterWrite, preload, clock = Date.now }) {
  let settings = P.normalizeSettings(), state = P.initialState(settings), timer = null, floatWindow = null, moveTimer = null;
  const now = () => clock();
  const view = () => P.snapshot(state, settings, now());
  const alive = window => Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());

  // 计时状态存进 settings.pomodoroTimer：退出应用再打开，接着原来的计时（暂停的保持暂停，在走的按真实时间继续）。
  const PHASES = new Set(['idle', 'focus', 'break']);
  function restoreState(saved) {
    const base = { ...P.initialState(settings), planId: settings.lastPlanId ?? null };
    if (!saved || typeof saved !== 'object' || !PHASES.has(saved.phase)) return base;
    const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const restored = { ...base, phase: saved.phase, running: Boolean(saved.running) && saved.phase !== 'idle', long: Boolean(saved.long),
      endsAt: number(saved.endsAt, null), leftMs: Math.max(0, number(saved.leftMs, base.leftMs)), totalMs: Math.max(1, number(saved.totalMs, base.totalMs)),
      planId: saved.planId ?? base.planId, taskId: saved.taskId ?? null, taskName: String(saved.taskName || ''), doneInCycle: Math.max(0, number(saved.doneInCycle, 0)),
      focusStartedAt: number(saved.focusStartedAt, null), focusElapsedMs: Math.max(0, number(saved.focusElapsedMs, 0)), runningSince: number(saved.runningSince, null) };
    if (restored.running && (!restored.endsAt || !restored.runningSince)) return { ...restored, running: false, endsAt: null, runningSince: null };
    return restored;
  }
  let persisting = Promise.resolve();
  function persistState() {
    const snapshot = { ...state, savedAt: now() };
    persisting = persisting.then(() => update(data => { data.settings = { ...data.settings, pomodoroTimer: snapshot }; })).catch(error => console.warn('Pomodoro state not saved:', error));
    return persisting;
  }
  async function load() {
    const data = await readData();
    settings = P.normalizeSettings(data.settings?.pomodoro);
    state = restoreState(data.settings?.pomodoroTimer);
    // 应用关着的时候到点了：按真实结束时间收尾（记录专注、开始休息），但不会在没人的时候自动开始新的专注。
    const events = [];
    for (let guard = 0; state.running && now() >= state.endsAt && guard < 4; guard++) {
      const result = P.tick(state, { ...settings, autoFocus: false }, state.endsAt);
      state = result.state; events.push(...result.events);
    }
    if (events.length) { await handle(events, { quiet: true }); await persistState(); }
    schedule();
    broadcast();
    syncFloat();
  }
  function broadcast(event = null) {
    const payload = { state: view(), event };
    for (const window of [...windows(), floatWindow]) if (alive(window)) window.webContents.send('pomodoro:state', payload);
  }
  function schedule() {
    clearTimeout(timer);
    if (state.running) timer = setTimeout(() => void onTimer(), Math.max(50, state.endsAt - now() + 20));
  }
  async function update(mutator) {
    const data = await readData(), base = structuredClone(data);
    mutator(data);
    await writeData(data, base);
    afterWrite();
  }
  async function planName(planId) {
    if (!planId) return '';
    return (await readData()).plans?.find(plan => plan.id === planId)?.name || '';
  }
  async function record(session) {
    if (!session) return null;
    const saved = { id: randomUUID(), ...session };
    await update(data => { data.focusSessions = [...(Array.isArray(data.focusSessions) ? data.focusSessions : []), saved]; });
    return saved;
  }
  async function saveSettings(patch) {
    settings = P.normalizeSettings({ ...settings, ...patch });
    await update(data => { data.settings = { ...data.settings, pomodoro: { ...settings } }; });
  }
  function notify(title, body) {
    if (!Notification?.isSupported?.()) return;
    try { new Notification({ title, body, silent: !settings.sound }).show(); } catch (error) { console.warn('Pomodoro notification failed:', error); }
  }
  async function handle(events, { quiet = false } = {}) {
    let last = null;
    for (const event of events) {
      if (event.session) event.session = await record(event.session);
      const name = await planName(event.session?.planId);
      if (quiet) { last = { ...event, planName: name }; continue; }
      if (event.type === 'focus-complete') notify('完成一个番茄', event.session ? `${event.session.minutes} 分钟${name ? `记入「${name}」` : '已记录'}` : '专注完成');
      if (event.type === 'break-complete') notify('休息好了', '准备好就开始下一个番茄');
      last = { ...event, planName: name };
    }
    return last;
  }
  async function onTimer() {
    const result = P.tick(state, settings, now());
    const changed = result.state !== state;
    state = result.state;
    schedule();
    // 先记下专注（写 focusSessions），再存计时状态：两次写入不能同时读同一份数据，否则后写的会覆盖先写的。
    const event = await handle(result.events);
    if (changed) await persistState();
    broadcast(event);
    syncFloat(event);
  }

  async function command(type, payload = {}) {
    let event = null;
    const at = now();
    if (type === 'start') {
      const planId = payload.planId !== undefined ? payload.planId || null : state.planId ?? settings.lastPlanId ?? null;
      state = P.start(state, settings, at, { planId, taskId: payload.taskId || null, taskName: payload.taskName || '' });
      if (planId !== settings.lastPlanId) await saveSettings({ lastPlanId: planId });
    } else if (type === 'pause') state = P.pause(state, at);
    else if (type === 'resume') state = P.resume(state, at);
    else if (type === 'stop') { const result = P.stop(state, settings, at); state = result.state; event = await handle(result.events); }
    else if (type === 'skip') { const result = P.skip(state, settings, at); state = result.state; event = await handle(result.events); }
    else if (type === 'set-plan') { state = P.setPlan(state, payload.planId); await saveSettings({ lastPlanId: state.planId }); }
    else if (type === 'settings') {
      const patch = {};
      for (const key of ['focus', 'short', 'long', 'every', 'autoBreak', 'autoFocus', 'sound']) if (key in payload) patch[key] = payload[key];
      await saveSettings(patch);
      if (state.phase === 'idle') state = { ...P.initialState(settings), planId: state.planId, doneInCycle: state.doneInCycle };
    } else if (type === 'pin') await saveSettings({ pinned: Boolean(payload.pinned) });
    else if (type === 'float-size') await saveSettings({ floatSize: payload.size === 'card' ? 'card' : 'pill' });
    else if (type === 'float-color') await saveSettings({ floatColor: payload.color });
    else throw new Error('番茄钟指令无效');
    if (['start', 'pause', 'resume', 'stop', 'skip', 'set-plan', 'settings'].includes(type)) await persistState();
    schedule();
    broadcast(event);
    syncFloat(event);
    return view();
  }

  /* ---------- 固定在桌面的悬浮窗：可以拖到任何显示器的任意位置 ---------- */
  // 只保证整个窗口留在某块屏幕的可用区域内，不再吸附到边缘。
  function clampToScreen({ x, y, width, height }) {
    const area = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) }).workArea;
    return {
      x: Math.round(Math.min(area.x + area.width - width, Math.max(area.x, x))),
      y: Math.round(Math.min(area.y + area.height - height, Math.max(area.y, y))),
    };
  }
  function floatBounds() {
    const size = FLOAT_SIZES[settings.floatSize] || FLOAT_SIZES.pill, saved = settings.floatPosition;
    const area = screen.getPrimaryDisplay().workArea;
    const origin = saved || { x: area.x + area.width - size.width - EDGE, y: area.y + EDGE };
    return { ...size, ...clampToScreen({ ...origin, ...size }) };
  }
  function createFloat() {
    floatWindow = new BrowserWindow({
      ...floatBounds(), frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: false, show: false, title: '番茄钟',
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload },
    });
    floatWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
    floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    floatWindow.loadFile(path.join(__dirname, '..', 'web', 'pomodoro-float.html'));
    floatWindow.once('ready-to-show', () => { if (alive(floatWindow)) floatWindow.showInactive(); });
    floatWindow.on('closed', () => { clearTimeout(moveTimer); floatWindow = null; });
  }
  // 悬浮窗页面用指针拖动（和桌宠一样），不依赖系统拖动区域：不能获得焦点的窗口上系统拖动不可靠。
  function floatPosition() {
    if (!alive(floatWindow)) return null;
    const [x, y] = floatWindow.getPosition();
    return { x, y };
  }
  function moveFloat(position, { save = false } = {}) {
    if (!alive(floatWindow)) return null;
    const x = Number(position?.x), y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return floatPosition();
    const { width, height } = floatWindow.getBounds(), next = clampToScreen({ x, y, width, height });
    floatWindow.setPosition(next.x, next.y, false);
    if (save) {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => void saveSettings({ floatPosition: next }).catch(error => console.warn('Float position could not be saved:', error)), 150);
    }
    return next;
  }
  let shrinkTimer = null;
  function syncFloat(event = null) {
    clearTimeout(shrinkTimer);
    if (event?.type === 'focus-complete' && settings.floatSize === 'pill') shrinkTimer = setTimeout(() => syncFloat(), 6000);
    if (!settings.pinned) { if (alive(floatWindow)) floatWindow.destroy(); return; }
    if (!alive(floatWindow)) { createFloat(); return; }
    // 一个番茄结束时临时展开成卡片，便于看到记录了多少分钟。换大小时左上角不动，放不下时才往屏幕里挪。
    const size = event?.type === 'focus-complete' ? FLOAT_SIZES.card : FLOAT_SIZES[settings.floatSize] || FLOAT_SIZES.pill;
    const bounds = floatWindow.getBounds();
    if (bounds.width !== size.width || bounds.height !== size.height) floatWindow.setBounds({ ...size, ...clampToScreen({ x: bounds.x, y: bounds.y, ...size }) });
  }

  return { load, command, view, broadcast, tick: onTimer, floatPosition, moveFloat, floatWindow: () => floatWindow, settings: () => settings, dispose: () => { clearTimeout(timer); if (alive(floatWindow)) floatWindow.destroy(); } };
}

module.exports = { createPomodoroService };
