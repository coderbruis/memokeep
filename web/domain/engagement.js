(function expose(root) {
  const DAY = 86400000, RATINGS = new Set(['again', 'hard', 'good', 'easy']);
  const ACCESSORIES = Object.freeze([{ id: 'scarf', label: '同行围巾', requirement: 0 }, { id: 'hat', label: '星光帽', requirement: 160 }, { id: 'leaf', label: '新芽徽记', requirement: 220 }]);
  const stamp = value => value == null || value === '' ? NaN : typeof value === 'number' ? value : new Date(value).getTime();
  const dayKey = at => new Date(at).toLocaleDateString('en-CA');
  function weekStart(at) { const date = new Date(at); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (date.getDay() + 6) % 7); return date.getTime(); }
  function preferences(settings = {}) {
    const source = settings.engagement || {}, clean = values => [...new Set((Array.isArray(values) ? values : []).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(stamp(value + 'T12:00:00')) && dayKey(stamp(value + 'T12:00:00')) === value))];
    return { earnedDays: clean(source.earnedDays), restUsed: clean(source.restUsed), weeklyGoal: Number.isFinite(Number(source.weeklyGoal)) ? Math.max(1, Math.min(7, Math.round(Number(source.weeklyGoal)))) : 4,
      accessory: ACCESSORIES.some(item => item.id === source.accessory) ? source.accessory : 'scarf' };
  }
  function validReviews(data, at) {
    const seen = new Set();
    return (data.reviewRecords || []).filter(record => {
      if (!record || typeof record !== 'object' || !RATINGS.has(record.rating) || !Number.isFinite(stamp(record.reviewedAt)) || stamp(record.reviewedAt) > at || record.undone) return false;
      if (record.id && seen.has(record.id)) return false; if (record.id) seen.add(record.id); return true;
    });
  }
  function completedRound(data, records, today) {
    const known = new Set(records.map(record => record.id).filter(Boolean)), active = new Set((data.cards || []).filter(card => card.status === 'active').map(card => card.id));
    return Object.values(data.reviewSessions || {}).some(session => {
      if (!session || session.day !== today || !Array.isArray(session.queue) || !session.queue.length || session.currentId) return false;
      const results = (Array.isArray(session.results) ? session.results : []).filter(result => result && (result.rating === 'later' || RATINGS.has(result.rating) && known.has(result.recordId)));
      return results.some(result => RATINGS.has(result.rating)) && session.queue.every(id => !active.has(id) || results.some(result => result.cardId === id));
    });
  }
  function engagementSummary(data, at = Date.now()) {
    const config = preferences(data.settings), today = dayKey(at), earned = config.earnedDays.filter(day => day <= today), xp = earned.length * 20;
    const accessory = ACCESSORIES.find(item => item.id === config.accessory), selected = accessory?.requirement <= xp ? accessory.id : 'scarf';
    return { xp, level: 1 + Math.floor(xp / 100), accessory: selected, restToday: config.restUsed.includes(today) };
  }
  function buildEngagement(data, at = Date.now()) {
    const config = preferences(data.settings), summary = engagementSummary(data, at), today = dayKey(at), records = validReviews(data, at), todayRecords = records.filter(record => dayKey(stamp(record.reviewedAt)) === today);
    const start = new Date(at); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
    const weekRecords = records.filter(record => stamp(record.reviewedAt) >= start.getTime());
    const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(start); date.setDate(date.getDate() + index); const key = dayKey(date.getTime()); return { key, label: ['日','一','二','三','四','五','六'][date.getDay()], count: weekRecords.filter(record => dayKey(stamp(record.reviewedAt)) === key).length }; });
    const latest = new Map(); for (const record of records) if (!latest.has(record.cardId) || stamp(latest.get(record.cardId).reviewedAt) <= stamp(record.reviewedAt)) latest.set(record.cardId, record);
    const difficultCounts = new Map(); for (const record of weekRecords) if (['again','hard'].includes(record.rating)) difficultCounts.set(record.cardId,(difficultCounts.get(record.cardId)||0)+1);
    const weak = (data.cards || []).filter(card => { const last = latest.get(card.id); return last && ['again', 'hard'].includes(last.rating) && stamp(last.reviewedAt) >= start.getTime(); }).map(card => ({ card, last: latest.get(card.id), count: difficultCounts.get(card.id)||0 }));
    const weakIds = new Set(weak.map(entry=>entry.card.id)), libraries = data.knowledgeBases || [], libraryIds = new Set(libraries.map(library=>library.id)), buckets = new Map();
    for (const card of data.cards || []) { const id=libraryIds.has(card.knowledgeBaseId)?card.knowledgeBaseId:'', bucket=buckets.get(id)||{total:0,reviewed:0,due:0,weak:0};bucket.total++;if(Number(card.reviewCount)>0||latest.has(card.id))bucket.reviewed++;if(card.status==='active'&&Number(card.dueAt)<=at)bucket.due++;if(weakIds.has(card.id))bucket.weak++;buckets.set(id,bucket); }
    const topics = [...libraries.map(library=>({id:library.id,name:library.name})),{id:'',name:'独立卡片'}].filter(topic=>buckets.has(topic.id)).map(topic=>({...topic,...buckets.get(topic.id)}));
    const week = weekStart(at), usedThisWeek = config.restUsed.filter(day => stamp(day + 'T12:00:00') >= week && stamp(day + 'T12:00:00') < week + 7 * DAY).length;
    const elapsed = weekRecords.filter(record => Number.isFinite(Number(record.responseTimeMs)) && Number(record.responseTimeMs) > 0);
    const createdToday = (data.documents || []).filter(doc => dayKey(stamp(doc.createdAt)) === today && String(doc.metadata?.noteContent || doc.content || '').replace(/<[^>]*>/g,'').trim()).length;
    return { ...summary, ...config, accessory: summary.accessory, today, todayCount: todayRecords.length, eligible: todayRecords.length >= 3 || completedRound(data, records, today), claimed: config.earnedDays.includes(today),
      restAvailable: Math.max(0, 1 - usedThisWeek), week: { days, studyDays: days.filter(day => day.count).length, reviewCount: weekRecords.length, cards: new Set(weekRecords.map(record => record.cardId)).size,
        minutes: Math.round(elapsed.reduce((total, record) => total + Number(record.responseTimeMs),0) / 60000), hasTime: elapsed.length > 0,
        ratings: Object.fromEntries([...RATINGS].map(rating => [rating, weekRecords.filter(record => record.rating === rating).length])) }, weak, topics, createdToday, accessories: ACCESSORIES.map(item => ({ ...item, unlocked: summary.xp >= item.requirement })) };
  }
  function applyEngagementCommand(data, command, at = Date.now()) {
    const current = buildEngagement(data, at), config = preferences(data.settings);
    if (command.type === 'claim') {
      if (current.claimed) return false;
      if (current.restToday) throw new Error('今天已安排休息，取消休息后再领取学习奖励。');
      if (!current.eligible) throw new Error('先完成一轮计划，或认真完成三次回忆。');
      config.earnedDays.push(current.today);
    } else if (command.type === 'rest') {
      if (current.restToday) config.restUsed = config.restUsed.filter(day => day !== current.today);
      else { if (current.claimed) throw new Error('今天已领取学习奖励，可以直接休息，无需再使用休息日。'); if (!current.restAvailable) throw new Error('本周的休息日已使用，可下周继续安排。'); config.restUsed.push(current.today); }
    } else if (command.type === 'goal') {
      const goal = Number(command.goal); if (!Number.isInteger(goal) || goal < 1 || goal > 7) throw new Error('每周目标为一至七天。'); config.weeklyGoal = goal;
    } else if (command.type === 'accessory') {
      const item = current.accessories.find(item => item.id === command.id); if (!item || !item.unlocked) throw new Error('继续认真练习，达到所需成长值后即可解锁。'); config.accessory = item.id;
    } else throw new Error('无法识别的成长操作。');
    data.settings ||= {}; data.settings.engagement = config; return true;
  }
  function awardCompletedRound(data, at = Date.now()) {
    const current = engagementSummary(data, at), today = dayKey(at), config = preferences(data.settings);
    if (current.restToday || config.earnedDays.includes(today) || !completedRound(data, validReviews(data, at), today)) return false;
    config.earnedDays.push(today); data.settings ||= {}; data.settings.engagement = config; return true;
  }
  function buildRetentionForecast(cards, at, { curve, version, review } = {}) {
    if (typeof curve !== 'function') return null;
    const eligible = (cards || []).filter(card => card.status === 'active' && card.schedulerVersion === version && Number(card.schedulerData?.stability) > 0 && Number.isFinite(stamp(card.schedulerData?.last_review)) && stamp(card.schedulerData.last_review) <= at);
    if (!eligible.length) return null;
    const values = Array.from({ length: 31 }, (_, day) => eligible.reduce((sum, card) => sum + curve(Math.max(0,(at - stamp(card.schedulerData.last_review)) / DAY) + day, Number(card.schedulerData.stability)), 0) / eligible.length);
    // Simulate one real good rating using the configured scheduler, without changing the card or its records.
    const scheduler = typeof module !== 'undefined' && module.exports ? require('../fsrs-scheduler.js') : typeof MemoScheduler !== 'undefined' ? MemoScheduler : null;
    const simulate = review || (scheduler ? (card, when) => scheduler.review(card, [], 'good', when).card : null);
    const planned = eligible.map(card => {
      const due = stamp(card.dueAt), when = Math.max(at, due);
      if (!simulate || !Number.isFinite(due) || when > at + 30 * DAY) return null;
      try {
        const result = simulate(card, when), next = result?.card || result;
        return Number(next?.schedulerData?.stability) > 0 ? { when, stability: Number(next.schedulerData.stability) } : null;
      } catch { return null; } // A malformed legacy scheduler state must not prevent statistics from opening.
    });
    const plannedValues = Array.from({ length: 31 }, (_, day) => eligible.reduce((sum, card, index) => {
      const when = at + day * DAY, plan = planned[index];
      const natural = curve(Math.max(0, (when - stamp(card.schedulerData.last_review)) / DAY), Number(card.schedulerData.stability));
      return sum + (plan && when >= plan.when ? Math.max(natural, curve((when - plan.when) / DAY, plan.stability)) : natural);
    }, 0) / eligible.length);
    const calendarDay = value => { const date = new Date(value); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY; };
    const today = calendarDay(at);
    const reviewDays = [...new Set(planned.filter(Boolean).map(plan => calendarDay(plan.when) - today).filter(day => day <= 30))].sort((a,b)=>a-b).slice(0,8);
    return { naturalRetention: values, plannedRetention: plannedValues, reviewDays, firstRiskDay: values.findIndex(value => value < .6), dueWithinSevenDays: eligible.filter(card => Number(card.dueAt) <= at + 7 * DAY).length, knownCards: eligible.length, excludedCards: cards.filter(card => card.status === 'active').length - eligible.length };
  }
  // 全应用唯一的「连续学习」：那天有复习（未撤销）或在计划里打过卡就算一天。
  // 从今天往前数；今天还没学不算中断，从昨天开始数。
  function learningStreak(data, at = Date.now()) {
    const days = new Set(validReviews(data, at).map(record => dayKey(stamp(record.reviewedAt))));
    for (const plan of data.plans || []) for (const [day, entry] of Object.entries(plan.days || {}))
      if ((entry?.doneFixed || []).length || (entry?.tasks || []).some(task => task?.done)) days.add(day);
    const date = new Date(at); date.setHours(12, 0, 0, 0);
    if (!days.has(dayKey(date.getTime()))) date.setDate(date.getDate() - 1);
    let count = 0;
    while (days.has(dayKey(date.getTime()))) { count++; date.setDate(date.getDate() - 1); }
    return count;
  }
  const api = { learningStreak, engagementPreferences: preferences, engagementSummary, buildEngagement, applyEngagementCommand, awardCompletedRound, buildRetentionForecast };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
