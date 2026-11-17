// 计划：每日固定任务 + 临时任务 + 日历打卡（design/prototype/plan-checkin-20261108.md）。
// 纯函数：日期一律用本地日期字符串 YYYY-MM-DD，便于比较与存储。
(function expose(root) {
  const pad = value => String(value).padStart(2, '0');
  const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  function dayKey(at) {
    const date = at instanceof Date ? at : new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function parseDay(day) {
    const [year, month, date] = String(day).split('-').map(Number);
    return new Date(year, month - 1, date);
  }
  function addDays(day, count) {
    const date = parseDay(day);
    date.setDate(date.getDate() + count);
    return dayKey(date);
  }
  const isDay = value => typeof value === 'string' && DAY_PATTERN.test(value) && dayKey(parseDay(value)) === value;
  const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / 86_400_000);

  // 已结束：手动结束，或过了结束日期。没有结束日期的计划不会自动结束。
  function planEnded(plan, today) { return Boolean(plan.endedAt) || Boolean(plan.endDate && plan.endDate < today); }
  const endedDay = plan => plan.endedAt ? dayKey(new Date(plan.endedAt)) : null;
  // 进行中的计划算到今天；已结束的算到结束日期与手动结束那天中较早的一天。
  function lastDay(plan, today) {
    if (!planEnded(plan, today)) return today;
    return [plan.endDate, endedDay(plan)].filter(Boolean).sort()[0];
  }
  function inPlan(plan, day) {
    if (day < plan.startDate) return false;
    if (plan.endDate && day > plan.endDate) return false;
    const ended = endedDay(plan);
    return !(ended && day > ended);
  }

  // 过去的日子按当天保存的固定任务快照统计；今天和以后按当前的固定任务。
  function fixedIdsFor(plan, day, today) {
    const entry = plan.days?.[day];
    if (day < today && Array.isArray(entry?.fixedIds)) return entry.fixedIds;
    return (plan.fixed || []).map(task => task.id);
  }
  function fixedTask(plan, id) {
    return (plan.fixed || []).find(task => task.id === id) || (plan.archivedFixed || []).find(task => task.id === id) || { id, name: '（已删除的任务）' };
  }
  function dayStat(plan, day, today) {
    const entry = plan.days?.[day] || {}, ids = fixedIdsFor(plan, day, today);
    const doneFixed = new Set(entry.doneFixed || []), tasks = entry.tasks || [];
    const total = ids.length + tasks.length;
    const done = ids.filter(id => doneFixed.has(id)).length + tasks.filter(task => task.done).length;
    return { total, done, full: total > 0 && done === total };
  }
  function dayItems(plan, day, today) {
    const entry = plan.days?.[day] || {}, doneFixed = new Set(entry.doneFixed || []);
    return {
      fixed: fixedIdsFor(plan, day, today).map(id => ({ ...fixedTask(plan, id), done: doneFixed.has(id) })),
      tasks: (entry.tasks || []).map(task => ({ ...task, done: Boolean(task.done) })),
    };
  }

  // 连续完成：从昨天往前数全部完成的天数；今天做完了把今天也算上。今天没做完不算中断。
  function streak(plan, today) {
    let count = 0, day = dayStat(plan, today, today).full ? today : addDays(today, -1);
    while (day >= plan.startDate && inPlan(plan, day, today) && dayStat(plan, day, today).full) { count++; day = addDays(day, -1); }
    return count;
  }

  function planDays(plan, today) {
    const end = planEnded(plan, today) ? lastDay(plan, today) : today, days = [];
    for (let day = plan.startDate; day <= end; day = addDays(day, 1)) days.push(day);
    return days;
  }

  function progress(plan, today) {
    const days = planDays(plan, today), stats = days.map(day => dayStat(plan, day, today));
    let best = 0, run = 0;
    for (const stat of stats) { run = stat.full ? run + 1 : 0; best = Math.max(best, run); }
    const tasks = days.flatMap(day => plan.days?.[day]?.tasks || []);
    const doneTasks = tasks.filter(task => task.done).length;
    const doneItems = stats.reduce((sum, stat) => sum + stat.done, 0), allItems = stats.reduce((sum, stat) => sum + stat.total, 0);
    const counted = new Map();
    for (const day of days) {
      const done = new Set(plan.days?.[day]?.doneFixed || []);
      for (const id of fixedIdsFor(plan, day, today)) {
        const row = counted.get(id) || { ...fixedTask(plan, id), done: 0, days: 0 };
        row.days++; if (done.has(id)) row.done++;
        counted.set(id, row);
      }
    }
    return {
      days: days.length,
      totalDays: plan.endDate ? daysBetween(plan.startDate, plan.endDate) + 1 : null,
      dayNumber: daysBetween(plan.startDate, planEnded(plan, today) ? lastDay(plan, today) : today) + 1,
      fullDays: stats.filter(stat => stat.full).length,
      missedDays: stats.filter((stat, index) => stat.done === 0 && days[index] < today).length,
      bestStreak: best, streak: streak(plan, today),
      doneItems, allItems, rate: allItems ? doneItems / allItems : 0,
      doneTasks, doneFixed: doneItems - doneTasks,
      perFixed: [...counted.values()].map(row => ({ ...row, rate: row.days ? row.done / row.days : 0 })).sort((a, b) => b.rate - a.rate || b.done - a.done),
    };
  }

  // 「复习卡片」这类固定任务：完成当天这一轮复习后自动打勾（用户手动取消过的不再自动勾）。
  const REVIEW_TASK = /复习.{0,4}卡片|卡片.{0,3}复习|^复习$|^背卡片$/;
  const isReviewTask = name => REVIEW_TASK.test(String(name || '').replace(/\s+/g, ''));
  function reviewTasksToComplete(plans, day) {
    const pending = [];
    for (const plan of plans || []) {
      if (planEnded(plan, day) || !inPlan(plan, day)) continue;
      const entry = plan.days?.[day] || {}, done = new Set(entry.doneFixed || []), dismissed = new Set(entry.autoDismissed || []);
      for (const id of fixedIdsFor(plan, day, day)) if (!done.has(id) && !dismissed.has(id) && isReviewTask(fixedTask(plan, id)?.name)) pending.push({ planId: plan.id, fixedId: id });
    }
    return pending;
  }
  const api = { isReviewTask, reviewTasksToComplete, dayKey, parseDay, addDays, isDay, daysBetween, planEnded, lastDay, inPlan, fixedIdsFor, fixedTask, dayStat, dayItems, streak, planDays, progress };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepPlans = api;
})(globalThis);
