const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../web/domain/plans.js');
const { createPlanOperations } = require('../web/application/plan-operations.js');

function setup(today = '2026-11-20') {
  const data = { plans: [] };
  let clock = plans.parseDay(today).getTime() + 10 * 3600_000, next = 0;
  const ops = createPlanOperations({
    plans, uid: () => `id${++next}`, now: () => clock, isoNow: () => new Date(clock).toISOString(),
    transact: async change => { const draft = structuredClone(data); change(draft); Object.assign(data, draft); },
  });
  return { data, ops, plan: () => data.plans[0], setDay: day => { clock = plans.parseDay(day).getTime() + 10 * 3600_000; } };
}

test('dates are local day keys and validated', () => {
  assert.equal(plans.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(plans.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(plans.isDay('2026-02-30'), false);
  assert.equal(plans.daysBetween('2026-11-02', '2026-12-08'), 36);
});
test('optional calendar ports affect instants while civil date arithmetic and history snapshots remain stable', () => {
  const clear = plans.setCalendarProvider({ dayKey: () => '2026-11-16' });
  try { assert.equal(plans.dayKey(Date.now()), '2026-11-16'); assert.equal(plans.isDay('2026-11-17'), true); assert.equal(plans.addDays('2026-11-17', 1), '2026-11-18'); assert.equal(plans.civilDayKey(plans.parseDay('2026-11-17')), '2026-11-17'); } finally { clear(); }
  const plan = { fixed: [{ id: 'f', name: 'new' }], days: { '2026-11-16': { fixedIds: ['f'], fixedNames: { f: 'old snapshot' }, doneFixed: [] } } };
  assert.equal(plans.dayItems(plan, '2026-11-16', '2026-11-17').fixed[0].name, 'old snapshot');
});

test('fixed and temporary tasks count toward the day; future days only accept new tasks', async () => {
  const { ops, plan } = setup();
  await ops.create({ name: '面试准备', startDate: '2026-11-18', endDate: '2026-12-08', fixed: ['复习卡片', '刷题', '  '] });
  assert.deepEqual(plan().fixed.map(task => task.name), ['复习卡片', '刷题'], 'blank fixed rows are dropped');
  const [a, b] = plan().fixed;
  await ops.toggleFixed(plan().id, '2026-11-20', a.id);
  const taskId = await ops.addTask(plan().id, '2026-11-20', '修改简历');
  assert.deepEqual(plans.dayStat(plan(), '2026-11-20', '2026-11-20'), { total: 3, done: 1, full: false });
  await ops.toggleTask(plan().id, '2026-11-20', taskId);
  await ops.toggleFixed(plan().id, '2026-11-20', b.id);
  assert.equal(plans.dayStat(plan(), '2026-11-20', '2026-11-20').full, true);
  await ops.addTask(plan().id, '2026-11-25', '投递简历');
  await assert.rejects(ops.toggleTask(plan().id, '2026-11-25', plan().days['2026-11-25'].tasks[0].id), /还没到这一天/);
  await assert.rejects(ops.addTask(plan().id, '2026-11-10', '早于开始'), /不在计划内/);
  await assert.rejects(ops.addTask(plan().id, '2026-11-20', '   '), /请输入任务名称/);
});

test('editing fixed tasks changes today and later, never past days', async () => {
  const { ops, plan, setDay } = setup('2026-11-19');
  await ops.create({ name: '英语', startDate: '2026-11-18', fixed: ['背单词', '听力'] });
  const [words, listening] = plan().fixed;
  await ops.toggleFixed(plan().id, '2026-11-19', words.id);
  await ops.toggleFixed(plan().id, '2026-11-19', listening.id);
  setDay('2026-11-20');
  await ops.toggleFixed(plan().id, '2026-11-20', listening.id);
  await ops.setFixed(plan().id, [{ id: words.id, name: '背单词 50 个' }, { name: '精读' }]);
  assert.equal(plans.dayStat(plan(), '2026-11-19', '2026-11-20').full, true, 'yesterday keeps its two finished tasks');
  assert.deepEqual(plans.dayItems(plan(), '2026-11-19', '2026-11-20').fixed.map(task => task.name), ['背单词 50 个', '听力'], 'removed tasks keep their name in past lists');
  assert.deepEqual(plans.dayStat(plan(), '2026-11-20', '2026-11-20'), { total: 2, done: 0, full: false }, 'today follows the new list and drops the removed tick');
  assert.equal(plan().archivedFixed[0].name, '听力');
});

test('streak skips an unfinished today and progress summarises the whole plan', async () => {
  const { ops, plan, setDay } = setup('2026-11-16');
  await ops.create({ name: '雅思', startDate: '2026-11-16', endDate: '2026-11-20', fixed: ['听力'] });
  const listening = plan().fixed[0].id;
  for (const day of ['2026-11-16', '2026-11-18', '2026-11-19']) { setDay(day); await ops.toggleFixed(plan().id, day, listening); }
  setDay('2026-11-20');
  assert.equal(plans.streak(plan(), '2026-11-20'), 2, 'today not finished yet does not break the streak');
  await ops.toggleFixed(plan().id, '2026-11-20', listening);
  assert.equal(plans.streak(plan(), '2026-11-20'), 3);
  const later = '2026-11-22';
  assert.equal(plans.planEnded(plan(), later), true);
  const summary = plans.progress(plan(), later);
  assert.equal(summary.days, 5); assert.equal(summary.fullDays, 4); assert.equal(summary.bestStreak, 3); assert.equal(summary.missedDays, 1);
  assert.equal(summary.perFixed[0].done, 4);
});

test('ending, extending and deleting a plan', async () => {
  const { ops, plan, data } = setup();
  await ops.create({ name: '考研', startDate: '2026-11-01' });
  assert.equal(plans.planEnded(plan(), '2026-11-20'), false, 'no end date means it never ends on its own');
  await ops.end(plan().id);
  assert.equal(plans.planEnded(plan(), '2026-11-20'), true);
  await assert.rejects(ops.addTask(plan().id, '2026-11-20', '补一项'), /计划已结束/);
  await ops.update(plan().id, { endDate: '2026-12-31' });
  assert.equal(plans.planEnded(plan(), '2026-11-20'), false, 'a later end date reopens the plan');
  await assert.rejects(ops.update(plan().id, { endDate: '2026-10-01' }), /结束日期不能早于开始日期/);
  await ops.remove(plan().id);
  assert.equal(data.plans.length, 0);
});

test('finishing today\'s review round ticks 「复习卡片」 tasks once; a manual untick sticks', async () => {
  const { data, ops, plan } = setup();
  await ops.create({ name: '考研', startDate: '2026-11-20', fixed: ['复习卡片', '读一章教材'] });
  const [review, read] = plan().fixed;
  assert.deepEqual(plans.reviewTasksToComplete(data.plans, '2026-11-20'), [{ planId: plan().id, fixedId: review.id }], 'Only review-like tasks');
  await ops.autoCompleteReview('2026-11-20');
  assert.deepEqual(plan().days['2026-11-20'].doneFixed, [review.id]);
  assert.deepEqual(plan().days['2026-11-20'].autoFixed, [review.id]);
  await ops.toggleFixed(plan().id, '2026-11-20', review.id);
  assert.deepEqual(plan().days['2026-11-20'].autoDismissed, [review.id]);
  assert.deepEqual(plans.reviewTasksToComplete(data.plans, '2026-11-20'), [], 'Unticked by hand: not ticked again today');
  assert.equal(plan().days['2026-11-20'].doneFixed.includes(read.id), false);
});
