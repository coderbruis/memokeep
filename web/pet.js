const api = window.memoKeepDesktop;
const bubblePanel = document.querySelector('.bubble');
const petButton = document.getElementById('pet');
const bubbleText = document.getElementById('bubble');
const petActionPanel = document.getElementById('petActions');
const reviewNowButton = document.getElementById('reviewNow');
const remindLaterButton = document.getElementById('remindLater');
const closeButton = document.getElementById('close');
const growthButton = document.getElementById('petGrowth');
const SNOOZE_DURATION = 30 * 60_000;
const SNOOZE_MESSAGE_DURATION = 10_000;
let snoozedUntil = 0;
let timerOverride = false; // 番茄钟占用气泡时为 true
let snoozeMessageUntil = 0;
let snoozeMessageTimer = null;

let refreshPending;
function refresh() {
  if (refreshPending) return refreshPending;
  refreshPending = refreshSummary().finally(() => { refreshPending = null; });
  return refreshPending;
}
async function refreshSummary() {
  const summary = api.readPetSummary ? await api.readPetSummary() : await api.read().then(data => ({
    dueCount: data.cards.filter(card => card.status === 'active' && card.dueAt <= Date.now()).length, cardCount: data.cards.length, growth: window.MemoKeepDomain?.engagementSummary(data, Date.now())
  }));
  const growth = summary.growth || { xp: 0, level: 1, accessory: 'scarf', restToday: false };
  petButton.dataset.accessory = growth.accessory;
  petButton.setAttribute('aria-label', `小久，同行等级 ${growth.level}，拖动位置，轻点复习`);
  if (growthButton) { growthButton.textContent = `Lv.${growth.level}`; growthButton.title = `成长值 ${growth.xp} · 打开学习成长`; }
  if (timerOverride) return; // 番茄钟正在用气泡
  if (growth.restToday) {
    petActionPanel.classList.add('hidden');
    bubbleText.textContent = '今日休息';
    bubblePanel.classList.remove('hidden');
  } else if (Date.now() < snoozedUntil) {
    petActionPanel.classList.add('hidden');
    if (Date.now() < snoozeMessageUntil) {
      bubbleText.textContent = '稍后提醒';
      bubblePanel.classList.remove('hidden');
    } else {
      bubblePanel.classList.add('hidden');
    }
  } else {
    bubblePanel.classList.remove('hidden');
    bubbleText.textContent = summary.dueCount ? `${summary.dueCount} 张待复习` : summary.cardCount ? '今日复习已完成' : '暂无卡片';
    petActionPanel.classList.toggle('hidden', !summary.dueCount);
  }
}

let dragState = null;
let dragFrame = null;

petButton.addEventListener('pointerdown', async event => {
  if (event.button !== 0) return;
  event.preventDefault();
  petButton.setPointerCapture(event.pointerId);
  const origin = await api.getPetPosition();
  dragState = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    originX: origin.x,
    originY: origin.y,
    moved: false,
    nextX: origin.x,
    nextY: origin.y
  };
});

petButton.addEventListener('pointermove', event => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const deltaX = event.screenX - dragState.startScreenX;
  const deltaY = event.screenY - dragState.startScreenY;
  if (Math.hypot(deltaX, deltaY) > 4) dragState.moved = true;
  dragState.nextX = dragState.originX + deltaX;
  dragState.nextY = dragState.originY + deltaY;
  if (!dragFrame) dragFrame = requestAnimationFrame(async () => {
    dragFrame = null;
    if (dragState) await api.setPetPosition({ x: dragState.nextX, y: dragState.nextY });
  });
});

petButton.addEventListener('pointerup', event => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const wasMoved = dragState.moved;
  dragState = null;
  if (!wasMoved) api.startReview();
});

petButton.addEventListener('pointercancel', () => { dragState = null; });
petButton.addEventListener('contextmenu', event => {
  event.preventDefault();
  event.stopPropagation();
  dragState = null;
  api.showPetContextMenu();
});
if (growthButton) growthButton.onclick = event => { event.stopPropagation(); api.openApp?.('growth'); };
reviewNowButton.onclick = event => { event.stopPropagation(); api.startReview(); };
remindLaterButton.onclick = event => {
  event.stopPropagation();
  const timestamp = Date.now();
  snoozedUntil = timestamp + SNOOZE_DURATION;
  snoozeMessageUntil = timestamp + SNOOZE_MESSAGE_DURATION;
  clearTimeout(snoozeMessageTimer);
  refresh();
  snoozeMessageTimer = setTimeout(refresh, SNOOZE_MESSAGE_DURATION);
};
closeButton.addEventListener('pointerdown', event => event.stopPropagation());
closeButton.addEventListener('click', async event => {
  event.preventDefault();
  event.stopPropagation();
  closeButton.disabled = true;
  try {
    await api.hidePet();
  } finally {
    closeButton.disabled = false;
  }
});
api.onDataChanged(refresh);
refresh();
setInterval(refresh, 60_000);

// 番茄钟：计时在主进程。固定在桌面时由悬浮窗显示倒计时，这里只在一个番茄结束时提醒。
const pomodoro = api.pomodoro, Pomo = window.MemoKeepPomodoro;
const timerBadge = document.getElementById('petTimer'), timerBadgeText = document.getElementById('petTimerText');
const timerActions = document.getElementById('petTimerActions'), timerPrimary = document.getElementById('petTimerPrimary'), timerSecondary = document.getElementById('petTimerSecondary');
let timerState = null, timerEvent = null, timerEventUntil = 0, timerBubbleUntil = 0, planNames = new Map();
const timerLeft = () => timerState.running && timerState.endsAt ? Math.max(0, timerState.endsAt - Date.now()) : timerState.leftMs;
async function loadPlanNames() {
  try { const data = await api.read(); planNames = new Map((data.plans || []).map(plan => [plan.id, plan.name])); } catch {}
}
function setTimerActions(primary, secondary) {
  timerActions.classList.toggle('hidden', !primary);
  if (!primary) return;
  [[timerPrimary, primary], [timerSecondary, secondary]].forEach(([button, action]) => {
    button.hidden = !action; if (!action) return;
    button.textContent = action[0]; button.dataset.cmd = action[1];
  });
}
function renderTimer() {
  if (!timerState || !Pomo) return;
  const now = Date.now(), active = timerState.phase !== 'idle', pinned = timerState.settings.pinned;
  const showEvent = timerEvent && now < timerEventUntil;
  const showRunning = active && !pinned && now < timerBubbleUntil;
  timerBadge.classList.toggle('hidden', !active || pinned || showRunning || showEvent);
  timerBadge.classList.toggle('break', timerState.phase === 'break');
  if (active) {
    const left = timerLeft();
    timerBadgeText.textContent = `${Math.ceil(left / 60_000)}′`;
    timerBadge.querySelector('.fg').style.strokeDashoffset = String(94.25 * (timerState.totalMs ? left / timerState.totalMs : 0));
    timerBadge.setAttribute('aria-label', `${timerState.phase === 'break' ? '休息' : '专注'}剩余 ${Pomo.clock(left)}，轻点展开`);
  }
  if (!showEvent && !showRunning) {
    if (timerOverride) { timerOverride = false; timerActions.classList.add('hidden'); refresh(); }
    return;
  }
  timerOverride = true;
  petActionPanel.classList.add('hidden');
  bubblePanel.classList.remove('hidden');
  if (showEvent) {
    const session = timerEvent.session, name = session?.planId ? planNames.get(session.planId) : '';
    bubbleText.textContent = timerEvent.type === 'break-complete' ? '休息好了，继续吧' : session ? `完成一个番茄！${session.minutes} 分钟${name ? `记入「${name}」` : '已记录'}` : '专注完成';
    if (timerEvent.type === 'focus-complete' && timerState.phase === 'break' && !timerState.running) setTimerActions([`休息 ${Math.round(timerState.totalMs / 60_000)} 分钟`, 'resume'], ['继续专注', 'start']);
    else if (timerEvent.type === 'break-complete') setTimerActions(['开始专注', 'start'], null);
    else setTimerActions(null);
    return;
  }
  const name = timerState.planId ? planNames.get(timerState.planId) : '';
  bubbleText.textContent = `${timerState.phase === 'break' ? '休息中' : '专注中'} ${Pomo.clock(timerLeft())}${timerState.phase === 'focus' && name ? ` · ${name}` : ''}`;
  setTimerActions(timerState.running ? ['暂停', 'pause'] : [timerState.phase === 'break' ? '开始休息' : '继续', 'resume'], timerState.phase === 'focus' ? ['结束', 'stop'] : ['跳过休息', 'skip']);
}
if (pomodoro && Pomo) {
  pomodoro.onState(async ({ state, event }) => {
    const started = timerState && timerState.phase === 'idle' && state.phase !== 'idle';
    timerState = state;
    if (state.planId && !planNames.has(state.planId)) await loadPlanNames();
    if (started) timerBubbleUntil = Date.now() + 5000;
    if (event && ['focus-complete', 'break-complete'].includes(event.type)) {
      await loadPlanNames();
      timerEvent = event; timerEventUntil = Date.now() + (timerState.settings.autoBreak || event.type === 'break-complete' ? 8000 : 60_000);
    }
    renderTimer();
  });
  pomodoro.get().then(async state => { timerState = state; await loadPlanNames(); renderTimer(); });
  setInterval(renderTimer, 1000);
  timerBadge.addEventListener('pointerdown', event => event.stopPropagation());
  timerBadge.addEventListener('click', event => { event.stopPropagation(); timerBubbleUntil = Date.now() + 5000; renderTimer(); });
  timerActions.addEventListener('pointerdown', event => event.stopPropagation());
  timerActions.addEventListener('click', event => {
    const button = event.target.closest('[data-cmd]'); if (!button) return;
    event.stopPropagation();
    timerEvent = null; timerBubbleUntil = Date.now() + 5000;
    void pomodoro.command(button.dataset.cmd);
  });
}
