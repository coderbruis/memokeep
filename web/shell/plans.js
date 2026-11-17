// 计划页面与侧栏列表（design/prototype/plan-checkin-20261108.md）。
(function expose(root) {
  function createPlanFeatures({ state, config, actions, env }) {
    const P = root.MemoKeepPlans;
    const ops = () => env.application.operations.plans;
    const e = value => actions.escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
    const icon = (id, className = '') => `<svg class="${className}" aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
    const WEEK = '日一二三四五六';
    const FOLD_AT = 6; // 一组超过 6 项时，已完成的自动收起
    const ui = { planId: null, day: null, month: null, collapsed: {}, showDone: {} };
    let dialog = null;

    const today = () => P.dayKey(config.now());
    const plans = () => state.persistence.data.plans || [];
    const ended = plan => P.planEnded(plan, today());
    const monthDay = day => { const date = P.parseDay(day); return `${date.getMonth() + 1} 月 ${date.getDate()} 日`; };
    const visible = () => !config.$('#plansView')?.classList.contains('hidden');
    const Pomo = root.MemoKeepPomodoro;
    const focusSessions = planId => (state.persistence.data.focusSessions || []).filter(session => session.planId === planId);
    const focusTotal = planId => focusSessions(planId).reduce((sum, session) => sum + Number(session.minutes || 0), 0);
    const focusByDay = planId => Pomo ? Pomo.minutesByDay(focusSessions(planId)) : new Map();
    const timerNow = () => actions.pomodoroState?.() || null;
    const focusingPlan = () => { const timer = timerNow(); return timer && timer.phase === 'focus' ? timer.planId : null; };
    const clockTime = iso => { const date = new Date(iso); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
    const NAV_KEY = 'memokeep-plan-nav-expanded';
    const navExpanded = () => { try { return env.localStorage.getItem(NAV_KEY) === 'true'; } catch { return false; } };
    function togglePlanNav() {
      try { env.localStorage.setItem(NAV_KEY, String(!navExpanded())); } catch { /* 只影响展开状态 */ }
      renderPlanNav();
    }

    function current() {
      const list = plans();
      return list.find(plan => plan.id === ui.planId) || list.find(plan => !ended(plan)) || list[0] || null;
    }
    // 选中计划时把日期放到合适的位置：进行中 → 今天；已结束 → 最后一天；还没开始 → 开始那天。
    function focusPlan(plan) {
      ui.planId = plan?.id || null;
      if (!plan) return;
      const now = today();
      ui.day = ended(plan) ? P.lastDay(plan, now) : now < plan.startDate ? plan.startDate : now;
      ui.month = ui.day.slice(0, 7);
    }

    /* ---------- 侧栏 ---------- */
    function renderPlanNav() {
      const host = config.$('#planNavList');
      if (!host) return;
      const now = today(), open = visible(), selected = current(), expanded = navExpanded(), focusing = focusingPlan();
      const row = plan => {
        const done = ended(plan), stat = done ? null : P.dayStat(plan, now, now);
        const meta = done ? icon('check', 'plan-nav-done') : now < plan.startDate ? '<em>未开始</em>' : `<em>${stat.done}/${stat.total}</em>`;
        const active = open && plan === selected;
        const dot = plan.id === focusing ? '<i class="plan-nav-focus" title="正在专注"></i>' : '';
        return `<button type="button" class="plan-nav-item${active ? ' active' : ''}${done ? ' ended' : ''}" data-plan-open="${e(plan.id)}"${active ? ' aria-current="page"' : ''}><span class="plan-nav-name">${e(plan.name)}</span>${dot}${meta}</button>`;
      };
      const running = plans().filter(plan => !ended(plan)), finished = plans().filter(ended);
      host.hidden = !expanded;
      host.innerHTML = `${running.map(row).join('')}
        ${finished.length ? `<div class="plan-nav-section">已结束</div>${finished.map(row).join('')}` : ''}`;
      const nav = config.$('.nav[data-view="plans"]'), meta = config.$('#planNavMeta');
      nav?.setAttribute('aria-expanded', String(expanded));
      nav?.closest('.plan-nav-heading')?.classList.toggle('expanded', expanded);
      // 侧栏不显示进行中的计划数量，只在专注时显示圆点；数量在悬停提示里。
      if (meta) meta.innerHTML = !expanded && focusing ? '<i class="plan-nav-focus"></i>' : '';
      if (nav) nav.title = expanded ? '计划' : `计划${running.length ? `：${running.length} 个进行中` : ''}${focusing ? '，正在专注' : ''}`;
    }

    /* ---------- 日历 ---------- */
    function calendar(plan) {
      const now = today(), [year, month] = ui.month.split('-').map(Number);
      const first = new Date(year, month - 1, 1), lead = (first.getDay() + 6) % 7, count = new Date(year, month, 0).getDate();
      let cells = '<span class="plan-day-pad"></span>'.repeat(lead);
      const minutes = focusByDay(plan.id);
      for (let date = 1; date <= count; date++) {
        const day = P.dayKey(new Date(year, month - 1, date)), stat = P.dayStat(plan, day, now), future = day > now;
        const classes = ['plan-day'];
        let sub = '', state = `完成 ${stat.done}/${stat.total}`;
        const num = `<span class="plan-day-num">${date}</span>`;
        if (!P.inPlan(plan, day)) { cells += `<span class="plan-day out">${num}</span>`; continue; }
        // 第二行同时放状态和专注分钟：底色表示完成程度，蓝圆点只表示今天，选中用中性灰框。
        const focused = minutes.get(day), min = focused ? `<span class="plan-day-min">${focused}′</span>` : '';
        if (stat.full && !future) { classes.push('full'); sub = icon('check', 'plan-day-tick') + min; state = '已全部完成'; }
        else if (stat.done > 0) { classes.push('part'); sub = `<span class="plan-day-count">${stat.done}/${stat.total}</span>${min ? `<span class="plan-day-sep" aria-hidden="true">·</span>${min}` : ''}`; }
        else if (day < now) { classes.push('miss'); sub = `<i class="plan-day-dot" aria-hidden="true"></i>${min}`; state = '未打卡'; }
        else if (day === now) { sub = min; state = `今天还没打卡，完成 0/${stat.total}`; }
        else if (plan.days?.[day]?.tasks?.length) { sub = `<small>+${plan.days[day].tasks.length}</small>`; state = `已安排 ${plan.days[day].tasks.length} 项临时任务`; }
        if (day === now) classes.push('today');
        if (day === ui.day) classes.push('selected');
        cells += `<button type="button" class="${classes.join(' ')}" data-plan-day="${day}" aria-pressed="${day === ui.day}" aria-label="${month} 月 ${date} 日${day === now ? '（今天）' : ''}，${state}${focused ? `，专注 ${focused} 分钟` : ''}">${num}<span class="plan-day-sub">${sub}</span></button>`;
      }
      return `<div class="plan-section-head"><h2>${year} 年 ${month} 月</h2><span class="plan-head-tools">
          <button type="button" class="plan-icon-button" data-plan-month="-1" aria-label="上个月">${icon('chevron-right', 'flip')}</button>
          <button type="button" class="plan-icon-button" data-plan-month="1" aria-label="下个月">${icon('chevron-right')}</button>
          <button type="button" class="plan-button small" data-plan-action="today">今天</button></span></div>
        <div class="plan-week" aria-hidden="true">${'一二三四五六日'.split('').map(day => `<span>${day}</span>`).join('')}</div>
        <div class="plan-calendar">${cells}</div>
        <div class="plan-legend"><span><i class="full"></i>全部完成</span><span><i class="part"></i>完成一部分</span><span><i class="miss"></i>未打卡</span><span><i class="today"></i>今天</span><span><i class="min">24′</i>专注分钟</span></div>`;
    }

    /* ---------- 某一天的清单 ---------- */
    function taskRow(plan, task, kind, { locked, removable, focusable }) {
      return `<div class="plan-task${task.done ? ' done' : ''}">
        <button type="button" class="plan-check" data-plan-toggle="${kind}" data-plan-id="${e(task.id)}" aria-pressed="${task.done}" aria-label="${task.done ? '取消完成' : '完成'}：${e(task.name)}"${locked ? ` disabled title="${locked}"` : ''}>${icon('check')}</button>
        <span class="plan-task-name">${e(task.name)}</span>
        ${focusable && !task.done ? `<button type="button" class="plan-focus-task" data-plan-focus="${e(task.id)}" data-plan-focus-name="${e(task.name)}" aria-label="专注这项：${e(task.name)}">${icon('timer')}专注这项</button>` : ''}
        ${removable ? `<button type="button" class="plan-icon-button plan-task-remove" data-plan-remove="${e(task.id)}" aria-label="删除：${e(task.name)}">${icon('x')}</button>` : ''}</div>`;
    }
    function group(plan, id, iconId, title, items, kind, options) {
      const done = items.filter(item => item.done).length, closed = ui.collapsed[id];
      const many = items.length > FOLD_AT, fold = many && done > 0 && !ui.showDone[id];
      const shown = fold ? items.filter(item => !item.done) : many ? [...items.filter(item => !item.done), ...items.filter(item => item.done)] : items;
      return `<section class="plan-group" aria-label="${title}">
        <div class="plan-group-head"><button type="button" class="plan-group-toggle" data-plan-group="${id}" aria-expanded="${!closed}">${icon('chevron-down', 'caret')}${icon(iconId)}${title}<span>${done}/${items.length}</span></button>${options.headExtra || ''}</div>
        ${closed ? '' : `${shown.map(item => taskRow(plan, item, kind, options)).join('') || options.empty || ''}
          ${fold ? `<button type="button" class="plan-fold" data-plan-show-done="${id}">${icon('check')}已完成 ${done} 项<span>展开</span></button>` : many && done ? `<button type="button" class="plan-fold" data-plan-show-done="${id}"><span>收起已完成</span></button>` : ''}
          ${options.tail || ''}`}</section>`;
    }
    function dayPane(plan, readOnly) {
      const now = today(), day = ui.day, date = P.parseDay(day), stat = P.dayStat(plan, day, now), items = P.dayItems(plan, day, now);
      const isToday = day === now, future = day > now, outside = !P.inPlan(plan, day);
      const locked = readOnly ? '计划已结束' : future ? '还没到这一天，到那天再打钩' : '';
      const title = isToday ? '今天' : monthDay(day);
      if (outside) return `<div class="plan-day-pane"><p class="plan-empty">这一天不在计划内。</p></div>`;
      return `<div class="plan-day-pane">
        <div class="plan-day-head"><div class="plan-section-head"><h2>${title}<small>${isToday ? `${monthDay(day)} · ` : ''}星期${WEEK[date.getDay()]}</small></h2></div>
          <div class="plan-progress${stat.full ? ' full' : ''}" role="progressbar" aria-label="${title}的完成进度" aria-valuemin="0" aria-valuemax="${stat.total}" aria-valuenow="${stat.done}"><span><i style="width:${stat.total ? stat.done / stat.total * 100 : 0}%"></i></span><b>${stat.done}/${stat.total} 完成</b></div></div>
        <div class="plan-day-list">
          ${group(plan, 'fixed', 'repeat-2', '每日固定', items.fixed, 'fixed', { locked, focusable: isToday && !readOnly, headExtra: readOnly ? '' : '<button type="button" class="plan-link" data-plan-action="edit-fixed">编辑</button>', empty: `<p class="plan-empty">${readOnly ? '没有固定任务。' : '还没有固定任务，点「编辑」添加。'}</p>` })}
          ${group(plan, 'tasks', 'pencil', `${isToday ? '今天' : '这天'}的临时任务`, items.tasks, 'task', { locked, removable: !readOnly, focusable: isToday && !readOnly, empty: readOnly ? '<p class="plan-empty">这天没有临时任务。</p>' : '',
            tail: readOnly ? '' : `<form class="plan-add" data-plan-add>${icon('plus')}<input name="name" maxlength="120" autocomplete="off" placeholder="${future ? '提前给这天加任务' : '添加临时任务'}，回车保存" aria-label="添加临时任务"></form>` })}
          ${focusList(plan, day, readOnly, isToday)}
          ${stat.full && !future && !readOnly ? `<p class="plan-done-note">${icon('check')}${isToday ? (plan.endDate === now ? '最后一天也完成了！明天起这里会变成计划总结。' : `今天的任务都完成了，已连续 ${P.streak(plan, now)} 天。`) : '这一天全部完成。'}</p>` : ''}
          ${future ? '<p class="plan-note">还没到这一天，可以先加临时任务，到那天再打钩。</p>' : ''}
        </div></div>`;
    }

    function focusList(plan, day, readOnly, isToday) {
      const list = focusSessions(plan.id).filter(session => Pomo?.dayOf(session.startedAt) === day).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      if (!list.length) return '';
      const total = list.reduce((sum, session) => sum + Number(session.minutes || 0), 0);
      return `<section class="plan-group plan-focus-group" aria-label="${isToday ? '今天' : '这天'}的专注">
        <div class="plan-group-head"><span class="plan-focus-title">${icon('timer')}${isToday ? '今天' : '这天'}的专注</span><span class="plan-focus-sum">${list.length} 段 · ${Pomo.formatMinutes(total)}</span></div>
        ${list.map(session => `<div class="plan-session"><span class="plan-session-time">${clockTime(session.startedAt)} – ${clockTime(session.endedAt)}</span><span class="plan-session-task">${e(session.taskName || '专注')}</span><span class="plan-session-len">${session.minutes} 分钟</span>${readOnly ? '' : `<button type="button" class="plan-icon-button plan-task-remove" data-plan-delete-session="${e(session.id)}" aria-label="删除这段专注记录">${icon('x')}</button>`}</div>`).join('')}
      </section>`;
    }

    /* ---------- 页面 ---------- */
    function activePage(plan) {
      const now = today(), info = P.progress(plan, now), upcoming = now < plan.startDate;
      const range = plan.endDate ? `${monthDay(plan.startDate)} – ${monthDay(plan.endDate)}` : `${monthDay(plan.startDate)}开始`;
      const position = upcoming ? `还有 ${P.daysBetween(now, plan.startDate)} 天开始` : `第 ${info.dayNumber} 天${info.totalDays ? ` / 共 ${info.totalDays} 天` : ''}`;
      return `<div class="plan-header"><div><h1>${e(plan.name)}</h1><p>${range} · ${position}</p></div>
          <div class="plan-stats">${Pomo ? `<div class="plan-stat-time"><b>${Pomo.formatMinutes(focusTotal(plan.id))}</b><span>累计学习</span></div>` : ''}<div><b>${info.streak}</b><span>连续全部完成（天）</span></div><div><b>${info.fullDays}/${upcoming ? 0 : info.days}</b><span>全部完成的天数</span></div>
          ${actions.openPomodoro && !upcoming ? `<button type="button" class="plan-button focus" data-plan-action="focus">${icon('timer')}${focusingPlan() === plan.id ? '专注中' : '开始专注'}</button>` : ''}
          <button type="button" class="plan-button" data-plan-action="edit">${icon('pencil')}编辑计划</button></div></div>
        <div class="plan-columns"><section class="plan-calendar-pane" aria-label="日历打卡">${calendar(plan)}</section>${dayPane(plan, false)}</div>`;
    }
    function miniMonth(plan, ym) {
      const now = today(), [year, month] = ym.split('-').map(Number), first = new Date(year, month - 1, 1), lead = (first.getDay() + 6) % 7, count = new Date(year, month, 0).getDate();
      let cells = '<span></span>'.repeat(lead);
      for (let date = 1; date <= count; date++) {
        const day = P.dayKey(new Date(year, month - 1, date));
        if (!P.inPlan(plan, day) || day > P.lastDay(plan, now)) { cells += '<span class="plan-mini-day out"></span>'; continue; }
        const stat = P.dayStat(plan, day, now), kind = stat.full ? 'full' : stat.done ? 'part' : 'miss';
        cells += `<button type="button" class="plan-mini-day ${kind}${day === ui.day ? ' selected' : ''}" data-plan-day="${day}" aria-pressed="${day === ui.day}" aria-label="${month} 月 ${date} 日，完成 ${stat.done}/${stat.total}" title="${month}/${date} · ${stat.done}/${stat.total}"></button>`;
      }
      return `<div class="plan-mini"><b>${month} 月</b><div class="plan-mini-week" aria-hidden="true">${'一二三四五六日'.split('').map(day => `<span>${day}</span>`).join('')}</div><div class="plan-mini-grid">${cells}</div></div>`;
    }
    function summaryTime(plan) {
      if (!Pomo) return '';
      const days = P.planDays(plan, today()), byDay = focusByDay(plan.id), values = days.map(day => byDay.get(day) || 0), total = values.reduce((a, b) => a + b, 0);
      if (!total) return '';
      const max = Math.max(...values), best = days[values.indexOf(max)], average = Math.round(total / days.length), count = focusSessions(plan.id).length;
      return `<section class="plan-time" aria-label="学习时长">
        <div class="plan-time-cards"><div><b>${Pomo.formatMinutes(total)}</b><span>累计学习</span></div><div><b>${average} 分钟</b><span>平均每天</span></div><div><b>${max} 分钟</b><span>学得最多的一天 · ${monthDay(best)}</span></div><div><b>${count} 段</b><span>专注记录</span></div></div>
        <div class="plan-section-head"><h2>每天学习时长<small>分钟 · 虚线是平均值</small></h2></div>
        <div class="plan-daybars" role="img" aria-label="每天学习时长，平均 ${average} 分钟，最多 ${max} 分钟">${values.map((value, index) => `<i class="${value ? '' : 'zero'}" style="height:${Math.max(2, value / max * 100)}%" title="${monthDay(days[index])} · ${value} 分钟"></i>`).join('')}<span class="plan-daybars-avg" style="bottom:${average / max * 100}%"><em>平均 ${average} 分钟</em></span></div>
        <div class="plan-daybars-axis"><span>${monthDay(days[0])}</span><span>${monthDay(days.at(-1))}</span></div>
      </section>`;
    }
    function summaryPage(plan) {
      const now = today(), info = P.progress(plan, now), last = P.lastDay(plan, now), rate = Math.round(info.rate * 100);
      const months = [...new Set(P.planDays(plan, now).map(day => day.slice(0, 7)))];
      return `<div class="plan-header"><div><h1>${e(plan.name)}<span class="plan-ended-tag">${icon('check')}已结束</span></h1><p>${monthDay(plan.startDate)} – ${monthDay(last)} · 共 ${info.days} 天</p></div>
          <div class="plan-stats"><button type="button" class="plan-button primary" data-plan-action="again">${icon('repeat-2')}再来一轮</button><button type="button" class="plan-button" data-plan-action="extend">延长计划</button><button type="button" class="plan-icon-button" data-plan-action="delete" aria-label="删除计划" title="删除计划">${icon('trash')}</button></div></div>
        <section class="plan-summary" aria-label="计划总结">
          <div class="plan-ring" style="--rate:${rate}"><b>${rate}%</b><span>任务完成率</span></div>
          <div><p class="plan-summary-line">${info.days} 天里，<b>${info.fullDays}</b> 天全部完成，最长连续 <b>${info.bestStreak}</b> 天。</p>
            <p class="plan-summary-detail">一共打钩 ${info.doneItems} 项（固定 ${info.doneFixed} 项、临时 ${info.doneTasks} 项）${info.missedDays ? `，${info.missedDays} 天没有打卡` : ''}。</p>
            ${plan.retro ? `<blockquote class="plan-retro">${e(plan.retro)}<button type="button" class="plan-link" data-plan-action="retro">编辑</button></blockquote>` : '<button type="button" class="plan-link" data-plan-action="retro">写一句总结</button>'}</div>
        </section>
        ${summaryTime(plan)}
        <div class="plan-columns"><section aria-label="整个计划的打卡">
            <div class="plan-section-head"><h2>整个计划的打卡<small>点一天看当天清单</small></h2></div>
            <div class="plan-minis">${months.map(month => miniMonth(plan, month)).join('')}</div>
            <div class="plan-legend"><span><i class="full"></i>全部完成</span><span><i class="part"></i>完成一部分</span><span><i class="miss"></i>没打卡</span></div>
            ${info.perFixed.length ? `<div class="plan-section-head spaced"><h2>每项固定任务<small>完成的天数</small></h2></div>
            <div class="plan-bars">${info.perFixed.map(row => `<div class="plan-bar"><span class="plan-bar-name" title="${e(row.name)}">${e(row.name)}</span><span class="plan-bar-track"><i style="width:${row.rate * 100}%"></i></span><span>${row.done}/${row.days} 天</span></div>`).join('')}</div>` : ''}
          </section>${dayPane(plan, true)}</div>`;
    }
    function emptyPage() {
      return `<div class="plan-empty-page"><span class="plan-empty-icon">${icon('calendar-days')}</span><h1>计划</h1>
        <p>为一段时间的目标（面试准备、英语学习……）设置每天要做的固定任务，每天还能加临时任务。打钩后完成情况记在日历上。</p>
        <button type="button" class="plan-button primary" data-plan-action="new">${icon('plus')}新建计划</button></div>`;
    }

    function renderPlans() {
      const host = config.$('#plansContent');
      if (!host) return;
      const plan = current();
      if (plan && plan.id !== ui.planId) focusPlan(plan);
      if (plan && !ui.day) focusPlan(plan);
      host.innerHTML = !plan ? emptyPage() : ended(plan) ? summaryPage(plan) : activePage(plan);
      renderPlanNav();
    }

    /* ---------- 弹窗 ---------- */
    function ensureDialog() {
      if (dialog) return dialog;
      dialog = env.document.createElement('dialog');
      dialog.id = 'planDialog'; dialog.className = 'plan-dialog'; dialog.setAttribute('aria-labelledby', 'planDialogTitle');
      env.document.body.appendChild(dialog);
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
      return dialog;
    }
    const fixedRow = (task = {}) => `<div class="plan-fixed-row"><input name="fixed" data-fixed-id="${e(task.id || '')}" value="${e(task.name || '')}" maxlength="120" placeholder="如：背单词 40 个" aria-label="固定任务"><button type="button" class="plan-icon-button" data-dialog-remove aria-label="删除这项">${icon('trash')}</button></div>`;
    function openDialog(kind) {
      const plan = current(), node = ensureDialog(), now = today();
      const isNew = kind === 'new' || kind === 'again';
      const titles = { new: '新建计划', again: '再来一轮', 'edit-fixed': '每日固定任务', edit: '编辑计划', extend: '延长计划', retro: '一句话总结' };
      const tasks = kind === 'again' || kind === 'edit-fixed' ? plan.fixed : [{}];
      const body = {
        new: true, again: true,
        'edit-fixed': true,
      }[kind] ? `${isNew ? `<label class="plan-field">计划名称<input name="name" maxlength="120" required placeholder="如：面试准备、英语学习" value="${kind === 'again' ? e(`${plan.name} · 第 2 轮`) : ''}"></label>
            <div class="plan-field-row"><label class="plan-field">开始<input type="date" name="startDate" required value="${now}"></label><label class="plan-field">结束（可不填）<input type="date" name="endDate" min="${now}"></label></div>
            <div class="plan-field-label">每日固定任务</div>` : ''}
          <div class="plan-fixed-list" data-fixed-list>${tasks.map(fixedRow).join('')}</div>
          <button type="button" class="plan-button dashed" data-dialog-add>${icon('plus')}添加一项</button>`
        : kind === 'edit' ? `<label class="plan-field">计划名称<input name="name" maxlength="120" required value="${e(plan.name)}"></label>
            <div class="plan-field-row"><label class="plan-field">开始<input type="date" name="startDate" required value="${plan.startDate}"></label><label class="plan-field">结束（可不填）<input type="date" name="endDate" value="${plan.endDate || ''}" min="${plan.startDate}"></label></div>
            <div class="plan-danger"><button type="button" class="plan-button" data-plan-action="end">结束计划</button><button type="button" class="plan-button danger" data-plan-action="delete">${icon('trash')}删除计划</button></div>`
        : kind === 'extend' ? `<label class="plan-field">新的结束日期<input type="date" name="endDate" min="${now}" value="${P.addDays(now, 14)}" required></label>`
        : `<label class="plan-field">这一轮的收获或教训<textarea name="retro" rows="3" maxlength="500" placeholder="如：听力从 6 分到 7 分，写作最难坚持">${e(plan.retro || '')}</textarea></label>`;
      const hint = { new: '起个名字，写下每天都要做的事。临时任务以后每天随时加。', again: '用同样的固定任务开始新的一轮，之前的记录保留在原计划里。', 'edit-fixed': '每天都会出现在清单里。修改从今天开始生效，之前的打卡记录不变。', edit: '', extend: '延长后计划回到进行中，可以继续打卡。', retro: '' }[kind];
      node.innerHTML = `<form method="dialog" data-plan-form="${kind}"><h2 id="planDialogTitle">${titles[kind]}</h2>${hint ? `<p class="plan-dialog-hint">${hint}</p>` : ''}
        ${body}<p class="plan-dialog-error" data-plan-error role="alert"></p>
        <div class="plan-dialog-actions"><button type="button" class="plan-button" data-dialog-close>取消</button><button type="submit" class="plan-button primary">${isNew ? '创建' : '保存'}</button></div></form>`;
      node.showModal();
      node.querySelector('input:not([type=hidden]), textarea')?.focus();
    }
    async function submitDialog(form) {
      const kind = form.dataset.planForm, plan = current(), values = new env.window.FormData(form);
      const fixedRows = [...form.querySelectorAll('[name="fixed"]')].map(input => ({ id: input.dataset.fixedId || undefined, name: input.value }));
      if (kind === 'new' || kind === 'again') {
        const id = await ops().create({ name: values.get('name'), startDate: values.get('startDate'), endDate: values.get('endDate') || null, fixed: fixedRows.map(row => row.name) });
        focusPlan({ id, ...plans().find(item => item.id === id) });
        actions.showToast(kind === 'again' ? '已开始新的一轮' : '计划已创建');
      } else if (kind === 'edit-fixed') await ops().setFixed(plan.id, fixedRows);
      else if (kind === 'edit') await ops().update(plan.id, { name: values.get('name'), startDate: values.get('startDate'), endDate: values.get('endDate') || null });
      else if (kind === 'extend') { await ops().update(plan.id, { endDate: values.get('endDate') }); focusPlan(current()); actions.showToast('计划已延长'); }
      else if (kind === 'retro') await ops().setRetro(plan.id, values.get('retro'));
      dialog.close();
      if (kind === 'edit') focusPlan(current());
      renderPlans();
    }

    /* ---------- 打开与事件 ---------- */
    async function openPlans(id) {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
      if (id) focusPlan(plans().find(plan => plan.id === id));
      actions.showView('plans');
      return true;
    }
    async function run(task, focus) {
      try { await task(); } catch (error) { actions.showToast(error.message, true); }
      renderPlans();
      if (focus) config.$(`#plansContent ${focus}`)?.focus();
    }
    function bindPlans() {
      const view = config.$('#plansView'), nav = config.$('#planNavList');
      if (!view || view.dataset.bound) return;
      view.dataset.bound = 'true';
      nav?.addEventListener('click', event => {
        const open = event.target.closest('[data-plan-open]');
        if (open) void openPlans(open.dataset.planOpen);
      });
      config.$('#newPlanBtn')?.addEventListener('click', () => void openPlans().then(ok => ok && openDialog('new')));
      view.addEventListener('click', event => {
        const target = event.target.closest('button'); if (!target || target.disabled) return;
        const plan = current(), data = target.dataset;
        if (data.planDay) { ui.day = data.planDay; if (!ended(plan)) ui.month = ui.day.slice(0, 7); renderPlans(); config.$(`#plansContent [data-plan-day="${ui.day}"]`)?.focus(); }
        else if (data.planMonth) {
          const [year, month] = ui.month.split('-').map(Number), date = new Date(year, month - 1 + Number(data.planMonth), 1);
          ui.month = P.dayKey(date).slice(0, 7); renderPlans(); config.$(`#plansContent [data-plan-month="${data.planMonth}"]`)?.focus();
        }
        else if (data.planToggle) void run(() => data.planToggle === 'fixed' ? ops().toggleFixed(plan.id, ui.day, data.planId) : ops().toggleTask(plan.id, ui.day, data.planId), `[data-plan-id="${data.planId}"]`);
        else if (data.planRemove) void run(() => ops().removeTask(plan.id, ui.day, data.planRemove), '[data-plan-add] input');
        else if (data.planGroup) { ui.collapsed[data.planGroup] = !ui.collapsed[data.planGroup]; renderPlans(); config.$(`#plansContent [data-plan-group="${data.planGroup}"]`)?.focus(); }
        else if (data.planShowDone) { ui.showDone[data.planShowDone] = !ui.showDone[data.planShowDone]; renderPlans(); config.$(`#plansContent [data-plan-group="${data.planShowDone}"]`)?.focus(); }
        else if (data.planFocus) actions.openPomodoro?.({ planId: plan.id, taskId: data.planFocus, taskName: data.planFocusName, start: true });
        else if (data.planDeleteSession) void run(() => actions.deleteFocusSession(data.planDeleteSession));
        else if (data.planAction === 'focus') actions.openPomodoro?.({ planId: plan.id, start: focusingPlan() !== plan.id });
        else if (data.planAction === 'today') { focusPlan(plan); renderPlans(); }
        else if (data.planAction) void handleAction(data.planAction);
      });
      view.addEventListener('submit', event => {
        const form = event.target.closest('[data-plan-add]'); if (!form) return;
        event.preventDefault();
        const input = form.elements.name, name = input.value.trim(); if (!name) return;
        const plan = current();
        void run(() => ops().addTask(plan.id, ui.day, name), '[data-plan-add] input');
      });
      ensureDialog();
      dialog.addEventListener('click', event => {
        const target = event.target.closest('button'); if (!target) return;
        if (target.matches('[data-dialog-close]')) dialog.close();
        else if (target.matches('[data-dialog-add]')) { const list = dialog.querySelector('[data-fixed-list]'); list.insertAdjacentHTML('beforeend', fixedRow()); list.lastElementChild.querySelector('input').focus(); }
        else if (target.matches('[data-dialog-remove]')) { const row = target.closest('.plan-fixed-row'), next = row.nextElementSibling || row.previousElementSibling; row.remove(); next?.querySelector('input')?.focus(); }
        else if (target.dataset.planAction) void handleAction(target.dataset.planAction);
      });
      dialog.addEventListener('submit', async event => {
        const form = event.target.closest('[data-plan-form]'); if (!form) return;
        event.preventDefault();
        const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
        try { await submitDialog(form); }
        catch (error) { form.querySelector('[data-plan-error]').textContent = error.message; }
        finally { if (submit.isConnected) submit.disabled = false; }
      });
      // 跨过午夜回到窗口时，今天会变；重新渲染让「今天」和日历保持正确。
      env.window.addEventListener('focus', () => { if (visible()) renderPlans(); else renderPlanNav(); });
      renderPlanNav();
    }
    async function handleAction(action) {
      const plan = current();
      if (['new', 'again', 'edit-fixed', 'edit', 'extend', 'retro'].includes(action)) { openDialog(action); return; }
      if (action === 'end') {
        if (!await actions.showConfirmDialog({ title: `结束「${plan.name}」？`, message: '结束后计划变成只读的总结，之前的打卡记录都会保留。之后可以用「延长计划」继续。', confirmLabel: '结束计划', tone: 'warning', icon: 'check' })) return;
        dialog?.close();
        await run(() => ops().end(plan.id));
        focusPlan(current()); renderPlans();
      }
      if (action === 'delete') {
        if (!await actions.showConfirmDialog({ title: `删除「${plan.name}」？`, message: '计划和它的全部打卡记录都会删除，无法恢复。', confirmLabel: '删除计划' })) return;
        dialog?.close();
        await run(() => ops().remove(plan.id));
        ui.planId = null; ui.day = null; renderPlans();
        actions.showToast('计划已删除');
      }
    }

    const newPlan = () => openPlans().then(ok => { if (ok) openDialog('new'); });
    return { renderPlans, renderPlanNav, openPlans, newPlan, bindPlans, togglePlanNav, renderPomodoroInPlans: () => { renderPlanNav(); if (visible()) renderPlans(); } };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createPlanFeatures });
})(globalThis);
