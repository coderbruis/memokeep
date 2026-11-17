// 计划的数据操作。每次修改都通过 transact 写入 data.plans，与其它数据一起保存和同步。
(function expose(root) {
  function createPlanOperations({ transact, uid, now, isoNow, plans: domain = root.MemoKeepPlans }) {
    const today = () => domain.dayKey(now());
    const cleanName = (value, label) => {
      const name = String(value ?? '').trim().slice(0, 120);
      if (!name) throw new Error(`请输入${label}`);
      return name;
    };
    function checkDates(startDate, endDate) {
      if (!domain.isDay(startDate)) throw new Error('请选择开始日期');
      if (endDate && !domain.isDay(endDate)) throw new Error('结束日期无效');
      if (endDate && endDate < startDate) throw new Error('结束日期不能早于开始日期');
    }
    function byId(data, id) {
      const plan = (data.plans || []).find(item => item.id === id);
      if (!plan) throw new Error('计划已不存在，请刷新后重试');
      return plan;
    }
    const touch = plan => { plan.updatedAt = isoNow(); };
    // 第一次记录某天时保存当天的固定任务，之后修改固定任务不影响这一天。
    function entryFor(plan, day) {
      plan.days ||= {};
      const entry = plan.days[day] ||= {};
      entry.fixedIds ||= (plan.fixed || []).map(task => task.id);
      entry.doneFixed ||= [];
      entry.tasks ||= [];
      return entry;
    }
    function editableDay(plan, day, { allowFuture = false } = {}) {
      if (!domain.isDay(day)) throw new Error('日期无效');
      if (!domain.inPlan(plan, day)) throw new Error('这一天不在计划内');
      if (domain.planEnded(plan, today())) throw new Error('计划已结束，不能再修改');
      if (!allowFuture && day > today()) throw new Error('还没到这一天，到那天再打钩');
    }
    const fixedFromNames = names => names.map(name => cleanName(name, '任务名称')).map(name => ({ id: uid(), name }));

    function create({ name, startDate, endDate = null, fixed = [] }) {
      const id = uid(), timestamp = isoNow();
      checkDates(startDate, endDate || null);
      const plan = { id, name: cleanName(name, '计划名称'), startDate, endDate: endDate || null, endedAt: null,
        fixed: fixedFromNames(fixed.filter(value => String(value ?? '').trim())), archivedFixed: [], days: {}, retro: '', createdAt: timestamp, updatedAt: timestamp };
      return transact(data => { (data.plans ||= []).unshift(plan); }).then(() => id);
    }
    function update(id, { name, startDate, endDate }) {
      return transact(data => {
        const plan = byId(data, id);
        const nextStart = startDate ?? plan.startDate, nextEnd = endDate === undefined ? plan.endDate : endDate || null;
        checkDates(nextStart, nextEnd);
        if (name !== undefined) plan.name = cleanName(name, '计划名称');
        plan.startDate = nextStart; plan.endDate = nextEnd;
        // 改到今天之后的结束日期 = 延长计划，回到进行中。
        if (plan.endedAt && (!nextEnd || nextEnd >= today())) plan.endedAt = null;
        touch(plan);
      });
    }
    // rows: [{ id?, name }]，保留原有 id 让已打的钩继续有效；删掉的任务归档，过去的清单仍能显示名称。
    function setFixed(id, rows) {
      return transact(data => {
        const plan = byId(data, id), day = today();
        const known = new Map((plan.fixed || []).map(task => [task.id, task]));
        const next = rows.filter(row => String(row?.name ?? '').trim()).map(row => {
          const name = cleanName(row.name, '任务名称');
          return row.id && known.has(row.id) ? { id: row.id, name } : { id: uid(), name };
        });
        const kept = new Set(next.map(task => task.id));
        const removed = (plan.fixed || []).filter(task => !kept.has(task.id));
        plan.archivedFixed = [...(plan.archivedFixed || []).filter(task => !kept.has(task.id)), ...removed.map(({ id: taskId, name }) => ({ id: taskId, name }))];
        plan.fixed = next;
        // 今天和以后已有的记录跟随新的固定任务；过去的保持原样。
        for (const [key, entry] of Object.entries(plan.days || {})) {
          if (key < day) continue;
          entry.fixedIds = next.map(task => task.id);
          entry.doneFixed = (entry.doneFixed || []).filter(taskId => kept.has(taskId));
        }
        touch(plan);
      });
    }
    function toggleFixed(id, day, fixedId) {
      return transact(data => {
        const plan = byId(data, id); editableDay(plan, day);
        const entry = entryFor(plan, day);
        if (!entry.fixedIds.includes(fixedId)) throw new Error('这项固定任务已不存在');
        const unchecking = entry.doneFixed.includes(fixedId);
        entry.doneFixed = unchecking ? entry.doneFixed.filter(value => value !== fixedId) : [...entry.doneFixed, fixedId];
        // 手动取消了自动打的勾：今天不再自动勾它。
        if (unchecking && (entry.autoFixed || []).includes(fixedId)) {
          entry.autoFixed = entry.autoFixed.filter(value => value !== fixedId);
          entry.autoDismissed = [...new Set([...(entry.autoDismissed || []), fixedId])];
        }
        if (!unchecking && entry.autoFixed) entry.autoFixed = entry.autoFixed.filter(value => value !== fixedId);
        touch(plan);
      });
    }
    function addTask(id, day, name) {
      const taskId = uid();
      return transact(data => {
        const plan = byId(data, id); editableDay(plan, day, { allowFuture: true });
        entryFor(plan, day).tasks.push({ id: taskId, name: cleanName(name, '任务名称'), done: false });
        touch(plan);
      }).then(() => taskId);
    }
    function toggleTask(id, day, taskId) {
      return transact(data => {
        const plan = byId(data, id); editableDay(plan, day);
        const task = entryFor(plan, day).tasks.find(item => item.id === taskId);
        if (!task) throw new Error('任务已不存在');
        task.done = !task.done;
        touch(plan);
      });
    }
    function removeTask(id, day, taskId) {
      return transact(data => {
        const plan = byId(data, id); editableDay(plan, day, { allowFuture: true });
        const entry = entryFor(plan, day);
        entry.tasks = entry.tasks.filter(item => item.id !== taskId);
        touch(plan);
      });
    }
    function end(id) {
      return transact(data => { const plan = byId(data, id); plan.endedAt = isoNow(); touch(plan); });
    }
    function setRetro(id, text) {
      return transact(data => { const plan = byId(data, id); plan.retro = String(text ?? '').trim().slice(0, 500); touch(plan); });
    }
    function remove(id) {
      return transact(data => {
        byId(data, id);
        data.plans = data.plans.filter(plan => plan.id !== id);
      });
    }
    // 今天这一轮复习做完了：把各计划里的「复习卡片」固定任务勾上，标记为自动完成。
    function autoCompleteReview(day = today()) {
      return transact(data => {
        for (const { planId, fixedId } of domain.reviewTasksToComplete(data.plans, day)) {
          const plan = byId(data, planId), entry = entryFor(plan, day);
          entry.doneFixed = [...new Set([...entry.doneFixed, fixedId])];
          entry.autoFixed = [...new Set([...(entry.autoFixed || []), fixedId])];
          touch(plan);
        }
      });
    }
    return { autoCompleteReview, create, update, setFixed, toggleFixed, addTask, toggleTask, removeTask, end, setRetro, remove };
  }
  const api = { createPlanOperations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepApplication ||= {}, api);
})(globalThis);
