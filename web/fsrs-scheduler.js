// Shared, offline FSRS-6 scheduler for both review windows. No application state is mutated here.
const MemoScheduler = (() => {
  const lib = typeof module !== 'undefined' && module.exports ? require('ts-fsrs') : FSRS;
  const version = 'fsrs-6/ts-fsrs-5.4.2';
  const DAY = 86400000;
  // 可以在设置里改的四项（design/prototype/review-intervals-20261113.md）；其余参数固定。
  const defaults = Object.freeze({ retention: 0.9, learningSteps: Object.freeze(['1m', '10m']), relearningSteps: Object.freeze(['10m']), maximumInterval: 36500,
    // 新卡片第一次评「有点难」「很简单」隔多久；null 表示交给算法（有点难取忘记和记住的中间，很简单随记住率）。
    hardMinutes: null, easyDays: null });
  const RETENTION = [0.7, 0.97], MAX_STEPS = 5, MAX_STEP_MINUTES = 30 * 1440;
  const unitMinutes = { m: 1, h: 60, d: 1440 };
  // 「1m 10m 1d」「1分钟，10 分钟」都认；统一成 ts-fsrs 的写法。
  function parseSteps(value, label = '间隔') {
    const parts = (Array.isArray(value) ? value : String(value ?? '').replace(/(\d)\s+(?=[mhd分小时天])/gi, '$1').split(/[\s,，、→>]+/)).map(part => String(part).trim()).filter(Boolean);
    if (!parts.length) throw new Error(`${label}至少填一个，例如 10m`);
    if (parts.length > MAX_STEPS) throw new Error(`${label}最多 ${MAX_STEPS} 个`);
    return parts.map(part => {
      const match = part.replace(/分钟?/, 'm').replace(/小时|时/, 'h').replace(/天/, 'd').match(/^(\d{1,5})\s*([mhd])$/i);
      const minutes = match ? Number(match[1]) * unitMinutes[match[2].toLowerCase()] : 0;
      if (!minutes || minutes > MAX_STEP_MINUTES) throw new Error(`「${part}」看不懂：写成数字加单位，m 分钟、h 小时、d 天，最长 30 天`);
      return `${match[1].replace(/^0+(?=\d)/, '')}${match[2].toLowerCase()}`;
    });
  }
  // 严格检查，用在设置页保存前。
  function validateOptions(input = {}) {
    const retention = Number(input.retention);
    if (!(retention >= RETENTION[0] && retention <= RETENTION[1])) throw new Error('目标记住率在 70% 到 97% 之间');
    const maximumInterval = Number(input.maximumInterval);
    if (!Number.isInteger(maximumInterval) || maximumInterval < 1 || maximumInterval > 36500) throw new Error('最长间隔填 1 到 36500 之间的整数天');
    const optional = (value, max, label) => {
      if (value == null || value === '') return null;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${label}填 1 到 ${max} 之间的整数`);
      return number;
    };
    return { retention: Math.round(retention * 100) / 100, learningSteps: parseSteps(input.learningSteps, '新卡片的学习间隔'), relearningSteps: parseSteps(input.relearningSteps, '忘记后的重学间隔'), maximumInterval,
      hardMinutes: optional(input.hardMinutes, MAX_STEP_MINUTES, '「有点难」的分钟数'), easyDays: optional(input.easyDays, 365, '「很简单」的天数') };
  }
  // 读已保存的设置：哪一项不对就用默认值，不影响复习。
  function normalizeOptions(input) {
    const result = { ...defaults, learningSteps: [...defaults.learningSteps], relearningSteps: [...defaults.relearningSteps] };
    if (!input || typeof input !== 'object') return result;
    for (const key of Object.keys(defaults)) { try { result[key] = validateOptions({ ...result, [key]: input[key] })[key]; } catch { /* 保留默认值 */ } }
    return result;
  }
  const build = options => lib.fsrs({ request_retention: options.retention, maximum_interval: options.maximumInterval, enable_fuzz: false,
    enable_short_term: true, learning_steps: options.learningSteps, relearning_steps: options.relearningSteps });
  let options = normalizeOptions(), engine = build(options), signature = JSON.stringify(options);
  // 每次排期前按当前设置调用；设置没变时什么都不做。只影响之后的评分，已经排好的复习时间不动。
  function configure(input) {
    const next = normalizeOptions(input), nextSignature = JSON.stringify(next);
    if (nextSignature !== signature) { options = next; engine = build(next); signature = nextSignature; }
    return options;
  }
  const ratings = Object.freeze({ again: lib.Rating.Again, hard: lib.Rating.Hard, good: lib.Rating.Good, easy: lib.Rating.Easy });
  const time = value => value == null || value === '' ? NaN : typeof value === 'number' ? value : new Date(value).getTime();
  const json = value => JSON.parse(JSON.stringify(value));
  function history(card, records = []) {
    const seen = new Set();
    const logs = records.filter(record => {
      if (record.cardId !== card.id || !ratings[record.rating] || !Number.isFinite(time(record.reviewedAt))) return false;
      if (record.id && seen.has(record.id)) return false;
      if (record.id) seen.add(record.id);
      return true;
    }).sort((a, b) => time(a.reviewedAt) - time(b.reviewedAt));
    const latest = Math.max(time(card.lastReviewedAt) || 0, time(logs.at(-1)?.reviewedAt) || 0);
    return { logs, count: Math.max(logs.length, Number(card.reviewCount ?? card.reviews) || 0), lastReviewedAt: latest || null };
  }
  function validState(state) {
    return state && [0, 1, 2, 3].includes(state.state)
      && ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses'].every(key => Number.isFinite(state[key]) && state[key] >= 0)
      && Number.isFinite(time(state.due)) && (state.state === 0 || state.stability > 0 && Number.isFinite(time(state.last_review)));
  }
  function stateFor(card, records, reviewedAt) {
    if (card.schedulerVersion === version && validState(card.schedulerData)) return json(card.schedulerData);
    // Rebuild only from recorded answers. Missing legacy history is not invented.
    const resetAt = time(card.schedulerResetAt);
    const logs = history(card, records).logs.filter(log => time(log.reviewedAt) <= reviewedAt && (!Number.isFinite(resetAt) || time(log.reviewedAt) >= resetAt));
    let state = lib.createEmptyCard(new Date(logs.length ? time(logs[0].reviewedAt) : reviewedAt));
    for (const log of logs) state = engine.next(state, new Date(time(log.reviewedAt)), ratings[log.rating]).card;
    return state;
  }
  // ts-fsrs 为了让「有点难 < 记住 < 很简单」各差至少一天，会比最长间隔多出一两天；这里压回上限。
  function capped(next, reviewedAt, settings = options) {
    if (next.state === lib.State.Review && next.scheduled_days > settings.maximumInterval) {
      next.scheduled_days = settings.maximumInterval;
      next.due = new Date(reviewedAt + settings.maximumInterval * DAY);
    }
    return next;
  }
  // 新卡片第一次评分：「有点难」「很简单」在设置里指定了间隔时用指定的。只改到期时间，记忆模型照常更新。
  function firstRating(next, before, grade, reviewedAt, settings = options) {
    if (before.state === lib.State.New) {
      if (grade === lib.Rating.Hard && settings.hardMinutes) next.due = new Date(reviewedAt + settings.hardMinutes * 60000);
      if (grade === lib.Rating.Easy && settings.easyDays && next.state === lib.State.Review) { next.scheduled_days = settings.easyDays; next.due = new Date(reviewedAt + settings.easyDays * DAY); }
    }
    return capped(next, reviewedAt, settings);
  }
  function preview(card, records = [], reviewedAt = Date.now()) {
    const state = stateFor(card, records, reviewedAt);
    const choices = engine.repeat(state, new Date(reviewedAt));
    return Object.fromEntries(Object.entries(ratings).map(([name, grade]) => [name, { dueAt: firstRating(choices[grade].card, state, grade, reviewedAt).due.getTime() }]));
  }
  function review(card, records, rating, reviewedAt = Date.now()) {
    if (!Object.hasOwn(ratings, rating)) throw new Error('无效的复习评分');
    const state = stateFor(card, records, reviewedAt);
    if (time(state.last_review) > reviewedAt) throw new Error('系统时间早于上次复习，请检查系统时间');
    const result = engine.next(state, new Date(reviewedAt), ratings[rating]);
    firstRating(result.card, state, ratings[rating], reviewedAt);
    const summary = history(card, records);
    const dueAt = result.card.due.getTime();
    return {
      card: { ...card, dueAt, lastReviewedAt: reviewedAt, reviewCount: summary.count + 1,
        lapseCount: Math.max(Number(card.lapseCount) || 0, summary.logs.filter(log => log.rating === 'again').length) + (rating === 'again' ? 1 : 0),
        strength: Math.max(0, (Number(card.strength) || 0) + ({ again: -1, hard: 0, good: 1, easy: 2 })[rating]),
        schedulerVersion: version, schedulerData: json(result.card), updatedAt: new Date(reviewedAt).toISOString() },
      log: { cardId: card.id, rating, reviewedAt, previousDueAt: card.dueAt, nextDueAt: dueAt,
        schedulerVersion: version, fsrs: json(result.log), schedulerBefore: json(state), schedulerAfter: json(result.card) }
    };
  }
  // 设置页的预览：一张新卡片在这组设置下四个按钮各隔多久。
  function samplePreview(input, at = Date.now()) {
    const settings = normalizeOptions(input), fresh = lib.createEmptyCard(new Date(at)), sample = build(settings).repeat(fresh, new Date(at));
    return Object.fromEntries(Object.entries(ratings).map(([name, grade]) => [name, intervalLabel(firstRating(sample[grade].card, fresh, grade, at, settings).due.getTime(), at)]));
  }
  function intervalLabel(dueAt, from = Date.now()) {
    const minutes = Math.max(1, Math.round((time(dueAt) - from) / 60000));
    if (minutes < 60) return `${minutes} 分钟后`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} 小时后`;
    return `${Math.round(minutes / 1440)} 天后`;
  }
  function trend(card) {
    if (card.schedulerVersion !== version || !validState(card.schedulerData) || !card.schedulerData.stability) return null;
    const state = card.schedulerData;
    const dueDays = Math.max(0, (time(state.due) - time(state.last_review)) / DAY);
    // Keep the scheduled review visible even for minute-scale learning steps.
    const span = Math.max(1 / 1440, dueDays * 1.5);
    const days = span >= 1 ? Math.ceil(span) : Math.ceil(span * 1440) / 1440;
    return { days, dueDays, dueValue: engine.forgetting_curve(dueDays, state.stability), points: Array.from({ length: 41 }, (_, index) => {
      const elapsed = days * index / 40;
      return { day: elapsed, value: engine.forgetting_curve(elapsed, state.stability) };
    }) };
  }
  return { version, defaults, get options() { return options; }, get parameters() { return engine.parameters; }, configure, validateOptions, normalizeOptions, parseSteps, samplePreview, ratings, history, preview, review, intervalLabel, trend };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MemoScheduler;
