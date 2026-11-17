const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const upstream = require('ts-fsrs');
const scheduler = require('../web/fsrs-scheduler.js');
const time = Date.parse('2026-09-12T10:00:00Z');
const day = 86400000;
const fresh = () => ({ id: 'a', status: 'active', dueAt: time, reviewCount: 0, schedulerVersion: 'mvp-1' });

test('all four ratings match the real pinned FSRS engine, including short-term learning', () => {
  const engine = upstream.fsrs(scheduler.parameters);
  const card = fresh();
  const preview = scheduler.preview(card, [], time);
  for (const [rating, grade] of Object.entries(scheduler.ratings)) {
    const expected = engine.next(upstream.createEmptyCard(new Date(time)), new Date(time), grade);
    const result = scheduler.review(card, [], rating, time);
    assert.equal(result.card.dueAt, expected.card.due.getTime());
    assert.equal(result.card.schedulerData.stability, expected.card.stability);
    assert.equal(preview[rating].dueAt, result.card.dueAt);
    assert.equal(result.log.schedulerVersion, scheduler.version);
  }
  assert.equal(card.reviewCount, 0, 'preview and review are pure until the caller saves');
  assert.throws(() => scheduler.review(card, [], 'later', time));
});

test('legacy logs replay chronologically; persistence and browser bundle give identical future scheduling', () => {
  const card = fresh();
  const logs = [{ id: 'b', cardId: 'a', rating: 'good', reviewedAt: time - day },
    { id: 'a', cardId: 'a', rating: 'easy', reviewedAt: time - 6 * day },
    { id: 'bad', cardId: 'other', rating: 'again', reviewedAt: time }];
  const engine = upstream.fsrs(scheduler.parameters);
  let expected = upstream.createEmptyCard(new Date(time - 6 * day));
  for (const [when, grade] of [[time - 6 * day, 4], [time - day, 3], [time, 3]]) expected = engine.next(expected, new Date(when), grade).card;
  const result = scheduler.review(card, logs, 'good', time);
  assert.equal(result.card.schedulerData.stability, expected.stability);
  assert.equal(result.card.reviewCount, 3);
  assert.equal(result.card.lastReviewedAt, time);
  const saved = JSON.parse(JSON.stringify(result.card));
  assert.deepEqual(scheduler.preview(saved, logs, time + day), scheduler.preview(result.card, logs, time + day));
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../web/vendor/ts-fsrs/index.umd.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../web/fsrs-scheduler.js'), 'utf8'), context);
  const browser = vm.runInContext('MemoScheduler', context);
  assert.equal(JSON.stringify(browser.preview(saved, logs, time + day)), JSON.stringify(scheduler.preview(saved, logs, time + day)));
});

test('reset retains lifetime statistics but begins a new memory model; malformed states recover from valid logs', () => {
  const logs = [{ id: 'a', cardId: 'a', rating: 'good', reviewedAt: time - day }, { id: 'b', cardId: 'a', rating: 'again', reviewedAt: time - 2 * day }];
  const card = { ...fresh(), schedulerResetAt: time, schedulerData: { stability: NaN } };
  const summary = scheduler.history(card, logs);
  assert.equal(summary.count, 2);
  assert.equal(summary.lastReviewedAt, time - day);
  const result = scheduler.review(card, logs, 'easy', time);
  assert.equal(result.card.schedulerData.reps, 1);
  assert.equal(result.card.reviewCount, 3);
  const trend = scheduler.trend(result.card);
  assert.ok(trend.points.length > 2);
  assert.equal(trend.points[0].value, 1);
  assert.ok(trend.points.every((p, i, points) => Number.isFinite(p.value) && p.value > 0 && (!i || p.value <= points[i - 1].value)));
  const recovered = scheduler.review({ ...fresh(), schedulerVersion: scheduler.version, schedulerData: { state: 2, stability: -1 } }, logs, 'hard', time);
  assert.ok(recovered.card.schedulerData.stability > 0);
});

test('trend marks the actual scheduled review and uses a minute-scale horizon for learning steps', () => {
  const engine = upstream.fsrs(scheduler.parameters);
  for (const rating of ['again', 'easy']) {
    const result = scheduler.review(fresh(), [], rating, time);
    const trend = scheduler.trend(result.card);
    assert.equal(trend.dueDays, (result.card.dueAt - time) / day);
    assert.equal(trend.dueValue, engine.forgetting_curve(trend.dueDays, result.card.schedulerData.stability));
    assert.ok(trend.days > trend.dueDays);
    if (rating === 'again') assert.ok(trend.days < 1 / 24, 'a one-minute review is not squeezed into a seven-day chart');
  }
});

// design/prototype/review-intervals-20261113.md
test('review intervals: custom steps, retention and cap change the schedule; bad or missing settings fall back to defaults', () => {
  try {
    assert.deepEqual(scheduler.samplePreview(), { again: '1 分钟后', hard: '6 分钟后', good: '10 分钟后', easy: '8 天后' }, 'Defaults are unchanged');
    assert.deepEqual(scheduler.parseSteps('1分钟，10 分钟 1d 2 h'), ['1m', '10m', '1d', '2h']);
    assert.throws(() => scheduler.validateOptions({ retention: 0.9, learningSteps: 'abc', relearningSteps: '10m', maximumInterval: 10 }), /看不懂/);
    assert.throws(() => scheduler.validateOptions({ retention: 0.9, learningSteps: '', relearningSteps: '10m', maximumInterval: 10 }), /至少填一个/);
    assert.throws(() => scheduler.validateOptions({ retention: 0.99, learningSteps: '1m', relearningSteps: '10m', maximumInterval: 10 }), /70% 到 97%/);
    assert.throws(() => scheduler.validateOptions({ retention: 0.9, learningSteps: '1m', relearningSteps: '10m', maximumInterval: 0 }), /最长间隔/);
    assert.deepEqual(scheduler.normalizeOptions({ retention: 5, learningSteps: '2m', maximumInterval: 'x' }), { retention: 0.9, learningSteps: ['2m'], relearningSteps: ['10m'], maximumInterval: 36500, hardMinutes: null, easyDays: null });

    scheduler.configure({ retention: 0.9, learningSteps: ['5m', '1h'], relearningSteps: ['30m'], maximumInterval: 36500 });
    const preview = scheduler.preview(fresh(), [], time);
    assert.equal(preview.again.dueAt - time, 5 * 60000);
    assert.equal(preview.good.dueAt - time, 60 * 60000);
    // 目标记住率越高、最长间隔越短，长期间隔越短。
    const easy = options => { scheduler.configure({ ...scheduler.defaults, ...options }); return (scheduler.review(fresh(), [], 'easy', time).card.dueAt - time) / day; };
    assert.ok(easy({ retention: 0.95 }) < easy({ retention: 0.8 }));
    assert.equal(easy({ maximumInterval: 3 }), 3);
    // 改设置不动已经排好的卡片：只有再次评分时才用新设置。
    scheduler.configure();
    const reviewed = scheduler.review(fresh(), [], 'easy', time).card;
    scheduler.configure({ ...scheduler.defaults, maximumInterval: 3 });
    assert.equal(reviewed.dueAt, time + 8 * day);
    assert.ok(scheduler.review(reviewed, [], 'good', reviewed.dueAt).card.dueAt - reviewed.dueAt <= 3 * day);
    // 新卡片第一次评「有点难」「很简单」可以指定间隔；之后的评分仍然交给算法。
    scheduler.configure({ ...scheduler.defaults, hardMinutes: 30, easyDays: 4 });
    const chosen = scheduler.preview(fresh(), [], time);
    assert.deepEqual([chosen.again.dueAt - time, chosen.hard.dueAt - time, chosen.good.dueAt - time, chosen.easy.dueAt - time], [60000, 30 * 60000, 10 * 60000, 4 * day]);
    const easyCard = scheduler.review(fresh(), [], 'easy', time).card;
    assert.deepEqual([easyCard.dueAt, easyCard.schedulerData.scheduled_days], [time + 4 * day, 4]);
    assert.equal(scheduler.review(fresh(), [], 'hard', time).card.dueAt, time + 30 * 60000);
    assert.notEqual(scheduler.preview(easyCard, [], easyCard.dueAt).easy.dueAt - easyCard.dueAt, 4 * day, 'Only the first rating of a new card is fixed');
    assert.equal(scheduler.samplePreview({ ...scheduler.defaults, easyDays: 30, maximumInterval: 7 }).easy, '7 天后', 'The cap still applies');
    assert.throws(() => scheduler.validateOptions({ ...scheduler.defaults, easyDays: 0 }), /很简单/);
  } finally { scheduler.configure(); }
});
