// 「今天」首页（design/prototype/today-home-20261109.md）：
// 一句话总结 + 当天进度；左边复习和各计划今天的任务，右边专注、本周节奏、继续写。
(function expose(root) {
  function createTodayFeatures({ state, config, actions, env }) {
    const P = root.MemoKeepPlans, Pomo = root.MemoKeepPomodoro;
    const e = value => actions.escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
    const icon = (id, className = '') => `<svg class="${className}" aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
    const START_KEY = 'memokeep-today-start-dismissed';
    const PLAN_ROWS = 6;
    const ui = { adding: null };
    let bound = false;

    const data = () => state.persistence.data || {};
    const dayKey = () => P ? P.dayKey(config.now()) : actions.todayKey(config.now());
    const activePlans = () => P ? (data().plans || []).filter(plan => !P.planEnded(plan, dayKey()) && plan.startDate <= dayKey()) : [];
    // 还没开始的计划（比如今天新建、明天开始），在总结和计划区里说明，免得像是「没有计划」。
    const upcomingPlans = () => P ? (data().plans || []).filter(plan => !plan.endedAt && plan.startDate > dayKey()).sort((a, b) => a.startDate.localeCompare(b.startDate)) : [];
    function startsIn(plan) {
      const days = Math.round((P.parseDay(plan.startDate) - P.parseDay(dayKey())) / 86_400_000);
      if (days === 1) return '明天开始';
      if (days === 2) return '后天开始';
      const date = P.parseDay(plan.startDate);
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日开始`;
    }
    const focusMinutesOn = day => Pomo ? (Pomo.minutesByDay(data().focusSessions || []).get(day) || 0) : 0;
    const startDismissed = () => { try { return env.localStorage.getItem(START_KEY) === 'true'; } catch { return false; } };

    function greeting() {
      const hour = new Date(config.now()).getHours();
      return hour < 5 ? '夜深了' : hour < 11 ? '上午好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    }

    // 今天所有计划任务（固定 + 临时），按计划分组。
    function planToday() {
      const today = dayKey();
      return activePlans().map(plan => {
        const items = P.dayItems(plan, today, today);
        const auto = new Set(plan.days?.[today]?.autoFixed || []);
        const rows = [...items.fixed.map(task => ({ ...task, kind: 'fixed', auto: task.done && auto.has(task.id) })), ...items.tasks.map(task => ({ ...task, kind: 'task' }))];
        return { plan, rows, done: rows.filter(row => row.done).length, total: rows.length, streak: P.streak(plan, today), day: dayIndex(plan, today) };
      });
    }
    function dayIndex(plan, today) {
      const start = P.parseDay(plan.startDate), now = P.parseDay(today);
      const index = Math.round((now - start) / 86_400_000) + 1;
      const total = plan.endDate ? Math.round((P.parseDay(plan.endDate) - start) / 86_400_000) + 1 : null;
      return total ? `第 ${index} / ${total} 天` : `第 ${index} 天`;
    }

    function model(summary) {
      const loaded = Boolean(state.persistence.data?.cards);
      const learning = loaded ? actions.homeLearningPlan() : { ready: [], totalDue: summary?.dueCount || 0, estimatedMinutes: 0, dueCount: summary?.dueCount || 0, newCount: 0, minutes: 15, ids: [] };
      const reviewsDone = loaded ? actions.reviewsToday().length : summary?.doneCount || 0;
      const plans = loaded ? planToday() : [];
      const planTotal = plans.reduce((sum, row) => sum + row.total, 0), planDone = plans.reduce((sum, row) => sum + row.done, 0);
      const remainingCards = loaded ? learning.ready.length : summary?.dueCount || 0;
      // 侧栏「今天」右边的待复习数量。
      const navBadge = config.$('#homeNavBadge');
      if (navBadge) { navBadge.textContent = remainingCards > 99 ? '99+' : String(remainingCards); navBadge.classList.toggle('hidden', !remainingCards); }
      // 知识点和卡片在同一个队列里，这里只是分开数。
      const cardById = new Map((data().cards || []).map(card => [card.id, card]));
      const remainingPoints = loaded ? learning.ready.filter(item => (item?.cardType ? item : cardById.get(item?.id ?? item))?.cardType === 'point').length : 0;
      const focus = focusMinutesOn(Pomo ? Pomo.dayOf(new Date(config.now()).toISOString()) : '');
      return { remainingPoints, loaded, learning, reviewsDone, plans, planTotal, planDone, remainingCards, remainingTasks: planTotal - planDone, focus };
    }

    function renderSummary(m) {
      const sentence = config.$('#todaySummary'), meter = config.$('#todayMeter');
      if (!sentence) return;
      const parts = [];
      if (m.remainingCards - m.remainingPoints) parts.push(`<b>${m.remainingCards - m.remainingPoints} 张卡片</b>`);
      if (m.remainingPoints) parts.push(`<b>${m.remainingPoints} 个知识点</b>`);
      if (m.remainingTasks) parts.push(`<b>${m.remainingTasks} 项计划任务</b>`);
      if (parts.length) sentence.innerHTML = `今天还有 ${parts.join(' 和 ')}${m.remainingCards && m.learning.estimatedMinutes ? `，复习大约 <b>${m.learning.estimatedMinutes} 分钟</b>` : ''}。`;
      // 没有待办时不写总结：下面的复习、计划、完成卡已经说明了状态。
      else sentence.textContent = '';
      sentence.hidden = !parts.length;
      const total = m.reviewsDone + m.remainingCards + m.planTotal, done = m.reviewsDone + m.planDone;
      meter.hidden = !total;
      if (!total) return;
      const width = value => `${(value / total * 100).toFixed(2)}%`;
      meter.querySelector('[data-part="review"]').style.width = width(m.reviewsDone);
      meter.querySelector('[data-part="plan"]').style.width = width(m.planDone);
      const text = `已完成 ${done} / ${total} 项${m.focus ? ` · 专注 ${Pomo.formatMinutes(m.focus)}` : ''}`;
      meter.querySelector('.today-bar').setAttribute('aria-label', text);
      config.$('#todayMeterText').innerHTML = `已完成 <b>${done}</b> / ${total} 项${m.focus ? ` · 专注 <b>${e(Pomo.formatMinutes(m.focus))}</b>` : ''}`;
    }

    function renderStart(m) {
      const host = config.$('#todayStart');
      if (!host) return;
      const d = data(), steps = [
        { done: (d.documents || []).length > 0, title: '写第一篇笔记', hint: '在知识库里记下正在学的内容。', action: 'note', label: '新建笔记' },
        { done: (d.cards || []).length > 0, title: '从笔记里做卡片', hint: '选中笔记里的一句话，点「做成卡片」。', action: 'cards', label: '打开知识库' },
        { done: (d.plans || []).length > 0, title: '建一个学习计划', hint: '每天的固定任务会列在这里。', action: 'plan', label: '新建计划' },
      ];
      const show = m.loaded && !startDismissed() && steps.some(step => !step.done) && (d.cards || []).length < 10;
      host.hidden = !show;
      if (!show) { host.innerHTML = ''; return; }
      // 只列还没做的步骤：已有的笔记、计划不再以「已完成」的大卡片出现。
      const remaining = steps.filter(step => !step.done);
      host.innerHTML = remaining.map((step, index) => `<div class="today-step${index ? '' : ' next'}">
          <span class="today-step-n" aria-hidden="true">${remaining.length > 1 ? index + 1 : icon('sparkles')}</span>
          <span><b>${step.title}</b><small>${step.hint}</small></span>
          <button type="button" class="${index ? 'secondary' : 'primary'}" data-today-start="${step.action}">${step.label}</button></div>`).join('')
        + '<button type="button" class="text-btn today-start-dismiss" data-today-start="dismiss">不再显示</button>';
    }

    // 连续学习：全应用同一个口径（domain/engagement.js learningStreak）。
    const learningStreak = () => globalThis.MemoKeepDomain?.learningStreak ? MemoKeepDomain.learningStreak(data(), config.now()) : Number(data().streak?.count) || 0;

    function renderDone(m) {
      const host = config.$('#todayDone');
      if (!host) return;
      const show = m.loaded && !m.remainingCards && !m.remainingTasks && m.reviewsDone + m.planDone > 0;
      host.hidden = !show;
      if (!show) { host.innerHTML = ''; return; }
      const today = actions.todayKey(config.now());
      const notes = (data().documents || []).filter(doc => doc.updatedAt && actions.todayKey(new Date(doc.updatedAt).getTime()) === today).length;
      const tomorrowEnd = new Date(config.now()); tomorrowEnd.setHours(24 + 23, 59, 59, 999);
      const dueTomorrow = (data().cards || []).filter(card => card.status === 'active' && card.dueAt <= tomorrowEnd.getTime()).length;
      const planNames = m.plans.map(row => row.plan.name);
      const facts = [[m.reviewsDone, '张卡片'], [m.planDone, '项任务'], [m.focus, '分钟专注'], [notes, '篇笔记']].filter(([value]) => value);
      host.innerHTML = `<span class="today-done-seal" aria-hidden="true">${icon('check')}</span><div><h2>今天全部完成</h2>
        <p>${m.plans.length ? `${m.plans.length > 1 ? '所有计划' : '计划'}都已打卡，` : ''}连续学习第 ${Math.max(1, learningStreak())} 天。</p>
        <div class="today-done-facts">${facts.map(([value, label]) => `<span><b>${value}</b>${label}</span>`).join('')}</div>
        <p class="today-done-next">明天：${dueTomorrow ? `${dueTomorrow} 张卡片到期` : '没有卡片到期'}${planNames.length ? ` · ${planNames.map(e).join('、')}继续` : ''}</p></div>`;
    }

    function renderReview(m) {
      const learning = m.learning;
      const count = config.$('#homePlanCount'); if (!count) return;
      count.textContent = learning.ready.length;
      // 和卡片页对得上：今天这一轮 + 留到明天的 = 全部到期。
      const overflow = Math.max(0, Number(learning.overflow ?? learning.totalDue - learning.ready.length) || 0);
      config.$('#homeAllDue').textContent = overflow ? `另有 ${overflow} 张留到明天` : '全部卡片';
      config.$('#homePlanDetail').innerHTML = learning.ready.length
        ? `<span><i class="today-sw due"></i>复习 ${learning.dueCount}</span><span><i class="today-sw new"></i>新 ${learning.newCount}</span>${m.remainingPoints ? `<span><i class="today-sw point"></i>其中知识点 ${m.remainingPoints}</span>` : ''}`
        : `<span>${learning.ids.length ? '今天的复习已完成' : learning.totalDue ? '今天的新卡已达上限' : ''}</span>`;
      config.$('#homePlanEstimate').textContent = learning.ready.length ? `预计 ${learning.estimatedMinutes} 分钟 · ` : '';
      config.$('#homeBudgetBtn').firstChild.textContent = `每天 ${learning.minutes} 分钟`;
      config.$$('[data-study-minutes]').forEach(button => button.setAttribute('aria-checked', String(Number(button.dataset.studyMinutes) === learning.minutes)));
      config.$('#startReviewBtn').disabled = false;
      config.$('#homeReviewPanel').classList.toggle('is-empty', !learning.ready.length);
    }

    function renderPlans(m) {
      const host = config.$('#todayPlans');
      if (!host) return;
      if (!m.loaded) { host.innerHTML = ''; return; }
      const head = `<div class="today-block-head"><h2>${icon('calendar-days')}计划 · 今天的任务</h2>${(data().plans || []).length ? '<button type="button" class="text-btn" data-today-plans>管理计划</button>' : ''}</div>`;
      const upcoming = upcomingPlans();
      if (!m.plans.length && upcoming.length) {
        host.innerHTML = head + `<div class="today-plans">${upcoming.map(plan => `<article class="today-plan upcoming" data-today-upcoming="${e(plan.id)}">
          <div class="today-plan-head"><button type="button" class="today-plan-name" data-today-open-plan="${e(plan.id)}">${e(plan.name)}</button><span class="today-plan-meta">${startsIn(plan)}</span></div>
          <p class="today-plan-note">${(plan.fixed || []).length ? `每天 ${plan.fixed.length} 项：${plan.fixed.slice(0, 3).map(task => e(task.name)).join('、')}${plan.fixed.length > 3 ? ' 等' : ''}` : ''}</p>
        </article>`).join('')}</div>`;
        return;
      }
      if (!m.plans.length) {
        host.innerHTML = `${head}<div class="today-plan-empty"><p>${(data().plans || []).length ? '今天没有进行中的计划。' : '还没有计划。'}</p><button type="button" class="secondary" data-today-start="plan">${icon('plus')}新建计划</button></div>`;
        return;
      }
      const focusing = actions.pomodoroState?.();
      host.innerHTML = head + `<div class="today-plans">${m.plans.map(({ plan, rows, done, total, streak, day }) => {
        const ordered = [...rows.filter(row => !row.done), ...rows.filter(row => row.done)];
        const visible = ordered.slice(0, PLAN_ROWS), hidden = ordered.length - visible.length;
        return `<article class="today-plan" data-today-plan="${e(plan.id)}">
          <div class="today-plan-head"><button type="button" class="today-plan-name" data-today-open-plan="${e(plan.id)}">${e(plan.name)}</button><span class="today-plan-meta">${day}</span>
            <span class="today-plan-count">${done}/${total}</span></div>
          ${visible.map(row => `<div class="today-task${row.done ? ' done' : ''}">
            <button type="button" class="today-check" data-today-toggle="${row.kind}" data-today-task="${e(row.id)}" aria-pressed="${row.done}" aria-label="${row.done ? '取消完成' : '完成'}：${e(row.name)}">${row.done ? icon('check') : ''}</button>
            <span class="today-task-name">${e(row.name)}</span>${row.kind === 'task' ? '<span class="today-task-tag">临时</span>' : ''}${row.auto ? '<span class="today-task-tag auto" title="今天这一轮复习完成后自动勾上">自动</span>' : ''}
            ${row.done || !actions.openPomodoro ? '' : `<button type="button" class="today-task-focus" data-today-focus="${e(row.id)}" data-today-focus-name="${e(row.name)}" aria-label="专注这项：${e(row.name)}">${icon('timer')}${focusing?.phase === 'focus' && focusing.taskId === row.id ? '专注中' : '专注'}</button>`}
          </div>`).join('')}
          ${hidden ? `<button type="button" class="today-task-more" data-today-open-plan="${e(plan.id)}">还有 ${hidden} 项，在计划里查看</button>` : ''}
          ${ui.adding === plan.id
            ? `<form class="today-add" data-today-add="${e(plan.id)}"><input name="task" maxlength="80" placeholder="今天要做的临时任务" aria-label="添加临时任务：${e(plan.name)}" autocomplete="off"><button type="submit" class="secondary">添加</button></form>`
            : `<button type="button" class="today-add-row" data-today-adding="${e(plan.id)}">${icon('plus')}添加今天的临时任务</button>`}
        </article>`;
      }).join('')}</div>`;
      if (ui.adding) host.querySelector('.today-add input')?.focus();
    }

    function renderFocus(m) {
      const host = config.$('#todayFocus');
      if (!host) return;
      const timer = actions.pomodoroState?.(), running = timer && timer.phase !== 'idle';
      const plans = data().plans || [], planName = id => plans.find(plan => plan.id === id)?.name;
      // 已结束或还没开始的计划不作为默认专注对象。
      const usable = id => m.plans.some(row => row.plan.id === id);
      const lastPlan = (running ? timer.planId : null) || [timer?.planId, timer?.settings?.lastPlanId].find(usable) || m.plans[0]?.plan.id || null;
      const sessions = Pomo ? (data().focusSessions || []).filter(session => Pomo.dayOf(session.startedAt || session.endedAt || '') === Pomo.dayOf(new Date(config.now()).toISOString())).length : 0;
      host.innerHTML = `<div class="today-block-head"><h2>${icon('timer')}专注</h2></div>
        <div class="today-focus${running ? ' running' : ''}">
          <div class="today-focus-top"><b>${Pomo ? e(Pomo.formatMinutes(m.focus)) : '0 分钟'}</b><small>${running ? `${timer.phase === 'break' ? '休息中' : '专注中'}${timer.planId && planName(timer.planId) ? ` · ${e(planName(timer.planId))}` : ''}` : `今天 · ${sessions} 个番茄`}</small></div>
          ${actions.openPomodoro ? `<button type="button" class="today-focus-start" data-today-focus-start>${icon('timer')}${running ? '打开番茄钟' : `开始专注${lastPlan && planName(lastPlan) ? ` · ${e(planName(lastPlan))}` : ''}`}</button>` : ''}
        </div>`;
      host.dataset.plan = lastPlan || '';
    }

    function renderWeek() {
      const chart = config.$('#homeWeekChart');
      if (!chart) return;
      const at = config.now(), logs = data().reviewRecords || [], sessions = data().focusSessions || [], days = [];
      const byFocus = Pomo ? Pomo.minutesByDay(sessions) : new Map();
      for (let offset = 6; offset >= 0; offset--) {
        const day = new Date(at); day.setDate(day.getDate() - offset);
        const key = actions.todayKey(day.getTime());
        const reviews = logs.filter(record => actions.todayKey(record.reviewedAt) === key).length;
        const focus = byFocus.get(P ? P.dayKey(day) : key) || 0;
        days.push({ label: offset ? '日一二三四五六'[day.getDay()] : '今', reviews, focus, score: reviews + focus / 5 });
      }
      const max = Math.max(1, ...days.map(day => day.score));
      chart.innerHTML = days.map((day, index) => `<div class="${index === 6 ? 'today' : ''}" title="${day.reviews} 次回忆${day.focus ? ` · 专注 ${day.focus} 分钟` : ''}"><i style="--h:${Math.round(day.score / max * 100)}%"></i><small>${day.label}</small></div>`).join('');
      const active = days.filter(day => day.score).length, total = days.reduce((sum, day) => sum + day.reviews, 0);
      chart.setAttribute('aria-label', `最近七天共 ${total} 次回忆，${active} 天有学习`);
      config.$('#homeWeekSummary').textContent = `${total} 次回忆 · ${active} 天参与`;
      const streak = learningStreak();
      config.$('#homeStreak').innerHTML = streak ? `${icon('sparkles')}连续学习 <b>${streak} 天</b>` : '今天学一点，开始连续';
    }

    function renderRecent() {
      const host = config.$('#homeRecentNotes');
      if (!host) return;
      const docs = [...(data().documents || [])].sort((a, b) => new Date(b.updatedAt || b.importedAt || 0) - new Date(a.updatedAt || a.importedAt || 0)).slice(0, 3);
      const when = value => {
        if (!value) return '';
        const time = new Date(value).getTime(), diff = config.now() - time, minute = 60_000;
        if (diff < minute) return '刚刚';
        if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
        if (actions.todayKey(time) === actions.todayKey(config.now())) return '今天';
        if (diff < 7 * 24 * 60 * minute) return `周${'日一二三四五六'[new Date(time).getDay()]}`;
        return `${new Date(time).getMonth() + 1} 月 ${new Date(time).getDate()} 日`;
      };
      host.innerHTML = docs.map(doc => `<button class="home-recent-note" type="button" data-open-recent-note="${e(doc.id)}"><svg aria-hidden="true"><use href="#icon-file-text"></use></svg><span><strong>${e(doc.title || '未命名笔记')}</strong><small>${e(env.application.state.knowledge.libraryById(doc.knowledgeBaseId)?.name || '我的知识库')}</small></span><time>${e(when(doc.updatedAt || doc.importedAt))}</time></button>`).join('') || '<p class="hint">暂无笔记</p>';
    }

    let autoReviewDay = '';
    function renderToday(summary = null) {
      if (!config.$('#todaySummary')) return;
      const now = new Date(config.now());
      config.$('#today').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now)}`;
      config.$('#today').dateTime = actions.todayKey(now.getTime());
      config.$('#todayGreeting').textContent = greeting();
      const m = model(summary);
      renderSummary(m); renderStart(m); renderDone(m); renderReview(m); renderPlans(m); renderFocus(m);
      // 笔记里新写或改过的要点，同步进复习队列后再画一次。
      if (m.loaded) actions.syncKnowledgePoints?.().then(changed => { if (changed) renderToday(); });
      if (m.loaded) { renderWeek(); renderRecent(); }
      // 今天这一轮复习做完了，计划里的「复习卡片」自动勾上。
      if (m.loaded && m.learning.ids.length && !m.learning.ready.length && m.reviewsDone && autoReviewDay !== dayKey() && P?.reviewTasksToComplete?.(data().plans, dayKey()).length)
        autoReviewDay = dayKey(), void run(() => env.application.operations.plans.autoCompleteReview(dayKey())).then(() => renderToday());
      const speech = config.$('#petSpeech');
      if (speech) speech.textContent = m.remainingCards ? `${m.remainingCards} 张今天复习` : (data().cards || []).length ? '今日复习已完成' : '暂无待复习';
    }

    async function run(task) {
      try { await task(); } catch (error) { actions.showToast(error.message || '操作失败，请重试', true); }
      renderToday();
      actions.renderPlanNav?.();
    }

    function bindToday() {
      if (bound) return;
      const view = config.$('#homeView');
      if (!view) return;
      bound = true;
      const budget = config.$('#homeBudgetBtn'), menu = config.$('#homeBudgetMenu');
      const closeBudget = () => { menu.hidden = true; budget.setAttribute('aria-expanded', 'false'); };
      budget.onclick = event => { event.stopPropagation(); const open = menu.hidden; menu.hidden = !open; budget.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('[aria-checked="true"], button')?.focus(); };
      menu.addEventListener('click', () => closeBudget());
      menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeBudget(); budget.focus(); } });
      env.document.addEventListener('click', event => { if (!event.target.closest('#homeBudgetMenu, #homeBudgetBtn')) closeBudget(); });
      view.addEventListener('click', event => {
        const target = event.target.closest('button');
        if (!target) return;
        const ds = target.dataset, plans = env.application.operations.plans, today = dayKey();
        const planId = target.closest('[data-today-plan]')?.dataset.todayPlan;
        if (ds.todayToggle && planId) void run(() => ds.todayToggle === 'fixed' ? plans.toggleFixed(planId, today, ds.todayTask) : plans.toggleTask(planId, today, ds.todayTask));
        else if (ds.todayFocus && planId) actions.openPomodoro?.({ planId, taskId: ds.todayFocus, taskName: ds.todayFocusName, start: true });
        else if (ds.todayAdding) { ui.adding = ds.todayAdding; renderToday(); }
        else if (ds.todayOpenPlan) void actions.openPlans?.(ds.todayOpenPlan);
        else if ('todayPlans' in ds) void actions.openPlans?.();
        else if ('todayFocusStart' in ds) {
          const timer = actions.pomodoroState?.();
          actions.openPomodoro?.(timer && timer.phase !== 'idle' ? {} : { planId: config.$('#todayFocus').dataset.plan || null, start: true });
        } else if (ds.todayStart === 'dismiss') { try { env.localStorage.setItem(START_KEY, 'true'); } catch { /* 只影响这张引导 */ } renderToday(); }
        else if (ds.todayStart === 'note') config.$('#homeNewNoteBtn').click();
        else if (ds.todayStart === 'cards') actions.showView('libraries');
        else if (ds.todayStart === 'plan') void actions.newPlan?.();
      });
      view.addEventListener('submit', event => {
        const form = event.target.closest('[data-today-add]');
        if (!form) return;
        event.preventDefault();
        const name = form.elements.task.value.trim(), planId = form.dataset.todayAdd;
        if (!name) { ui.adding = null; renderToday(); return; }
        ui.adding = planId;
        void run(() => env.application.operations.plans.addTask(planId, dayKey(), name));
      });
      view.addEventListener('keydown', event => {
        if (event.key === 'Escape' && event.target.closest('[data-today-add]')) { event.preventDefault(); ui.adding = null; renderToday(); config.$(`[data-today-adding]`)?.focus(); }
      });
      view.addEventListener('focusout', event => {
        const form = event.target.closest('[data-today-add]');
        if (form && !form.contains(event.relatedTarget) && !form.elements.task.value.trim()) env.setTimeout(() => { if (ui.adding === form.dataset.todayAdd) { ui.adding = null; renderToday(); } }, 0);
      });
    }

    return { renderToday, bindToday, renderTodayFocus: () => { const m = model(); renderFocus(m); if (!ui.adding) renderPlans(m); renderSummary(m); } };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createTodayFeatures });
})(globalThis);
