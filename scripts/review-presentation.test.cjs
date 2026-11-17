const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const domino = require('@mixmark-io/domino');
const MemoScheduler = require('../web/fsrs-scheduler.js');

function setup() {
  const window = domino.createWindow('<div id="host"><div id="answer"></div><footer><button id="source">来源</button><span>快捷键</span></footer></div>');
  const context = vm.createContext({ document: window.document, MemoScheduler });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/review-presentation.js'), 'utf8'), context);
  const api = vm.runInContext('ReviewPresentation', context);
  const $ = selector => window.document.querySelector(selector);
  const expansions = [];
  const panel = api.mount({ host: $('#host'), footer: $('footer'), sourceButton: $('#source'), onExpand: value => expansions.push(value) });
  return { api, panel, $, expansions };
}

test('answer layout handles labelled lists without interpreting user HTML, and preserves prose/code', () => {
  const { api, $ } = setup();
  const answer = '穿透：请求的数据不存在。\n击穿：一个热点 key 失效。\n雪崩：大量 key 同时失效。';
  api.renderAnswer($('#answer'), answer);
  assert.equal($('#answer').querySelectorAll('.review-answer-entry').length, 3);
  assert.equal($('.review-answer-term').textContent, '穿透：');
  api.renderAnswer($('#answer'), '<img src=x onerror=alert(1)>\n\nconst value = { url: "https://example.com" };');
  assert.equal(Boolean($('#answer img')), false);
  assert.equal($('#answer').textContent, '<img src=x onerror=alert(1)>\n\nconst value = { url: "https://example.com" };');
});

test('details stay unavailable before rating, then display real curve, source and lifetime history', () => {
  const { panel, $ } = setup();
  const card = { id: 'one', schedulerVersion: 'mvp-1', reviewCount: 0, lastReviewedAt: null };
  const note = { title: '<img onerror=alert(1)>', content: 'SECRET ANSWER' };
  const history = [
    { cardId: 'one', reviewedAt: '2026-09-01', rating: 'good' },
    { cardId: 'other', reviewedAt: '2026-09-05', rating: 'easy' },
    { cardId: 'one', reviewedAt: 'invalid', rating: 'hard' }
  ];
  panel.update(card, note, history, false);
  panel.open();
  assert.equal(panel.isOpen, false);
  assert.equal($('.review-memory-toggle').classList.contains('hidden'), true);
  assert.doesNotMatch($('.review-memory-panel').textContent, /SECRET|记住/);
  const result = MemoScheduler.review(card, history, 'easy', Date.parse('2026-09-12'));
  history.push(result.log);
  const before = JSON.stringify({ result, note, history });
  panel.update(result.card, note, history, true);
  panel.open();
  assert.equal(panel.isOpen, true);
  assert.match($('.review-memory-facts').textContent, /2 次/);
  assert.doesNotMatch($('.review-memory-facts').textContent, /尚未建立|尚未复习/);
  assert.equal($('.review-memory-excerpt').textContent, 'SECRET ANSWER');
  assert.ok($('.review-memory-trend path').getAttribute('d').startsWith('M'));
  assert.equal($('.review-memory-trend').querySelectorAll('line').length, 2);
  const dot = $('.review-memory-trend circle');
  assert.ok(dot);
  assert.ok($('.review-memory-trend path').getAttribute('d').includes(`${dot.getAttribute('cx')},${dot.getAttribute('cy')}`));
  assert.match($('.review-memory-trend-labels').textContent, /本次复习下次复习\+/);
  assert.doesNotMatch($('.review-memory-panel').textContent, /%/);
  assert.equal(Boolean($('.review-memory-panel img')), false);
  assert.equal(JSON.stringify({ result, note, history }), before);
  panel.update({ id: 'new', reviewCount: 0 }, null, [], false);
  assert.equal(panel.isOpen, false);
  assert.equal($('.review-memory-body').textContent, '');
});

test('panel toggles independently and restores the original layout without duplicate controls', () => {
  const { panel, $, expansions, api } = setup();
  const same = api.mount({ host: $('#host') });
  assert.equal(same, panel);
  assert.equal($('footer').querySelectorAll('.review-memory-toggle').length, 1);
  const result = MemoScheduler.review({ id: 'one' }, [], 'good', Date.now());
  panel.update(result.card, null, [result.log], true);
  panel.open();
  assert.equal($('.review-memory-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal($('#host').classList.contains('memory-open'), true);
  panel.close();
  assert.equal($('.review-memory-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('#host').classList.contains('memory-open'), false);
  assert.deepEqual(expansions, [true, false]);
});
