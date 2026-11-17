// 记忆卡片 › 主题看板 / 主题详情（design/prototype/card-topics-20261112.md）。
// 看板：「全部」范围 + 主题视图时显示；每个主题一张卡片（到期、记住率、三段条、薄弱技术点、复习按钮），可多选一起复习。
// 详情：范围是 { type: 'topic', id, point } 时，在列表上面显示主题统计和技术点；列表本身沿用现有的卡片表格。
// 数据来自 web/domain/card-topics.js。
(function () {
  const $ = selector => document.querySelector(selector);
  const VIEW_KEY = 'memokeep-card-view', SORT_KEY = 'memokeep-card-topic-sort';
  const store = { get(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, value); } catch {} } };
  const selected = new Set();
  let mode = store.get(VIEW_KEY, 'topics'), sort = store.get(SORT_KEY, 'due');

  const ready = () => typeof applicationShell !== 'undefined' && typeof application !== 'undefined' && window.MemoKeepCardTopics && $('#cardTopicsBoard');
  const data = () => applicationShell.state.persistence.data;
  const runtime = () => application.cards.runtime;
  const now = () => applicationShell.config.now();
  const esc = value => applicationShell.actions.escapeHtml(String(value ?? ''));
  const model = () => MemoKeepCardTopics.build(data(), { now: now(), stageOf: card => applicationShell.actions.cardStage(card) });

  function ago(at) {
    if (!at) return '还没复习过';
    const days = Math.floor((new Date(now()).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? '今天复习过' : days === 1 ? '昨天复习过' : `${days} 天前复习过`;
  }
  const dateLabel = at => { const date = new Date(at); return `${date.getMonth() + 1}月${date.getDate()}日`; };
  const retentionHtml = topic => topic.retention === null ? '<span class="ct-ret">记住率 —</span>' : `<span class="ct-ret${topic.retention < 75 ? ' low' : ''}">记住率 <b>${topic.retention}%</b></span>`;
  // 三段条：新卡 / 学习中（含到期）/ 已掌握。
  function mixBar(topic) {
    const active = topic.new + topic.learning + topic.mastered + (topic.total - topic.new - topic.learning - topic.mastered - topic.paused);
    if (!active) return '<div class="ct-mix" aria-hidden="true"></div>';
    const learning = active - topic.new - topic.mastered;
    const part = (value, cls, label) => value > 0 ? `<i class="${cls}" style="width:${(value / active * 100).toFixed(1)}%" title="${label} ${value}"></i>` : '';
    return `<div class="ct-mix" role="img" aria-label="新卡 ${topic.new}，学习中 ${learning}，已掌握 ${topic.mastered}">${part(topic.new, 'n', '新卡')}${part(learning, 'l', '学习中')}${part(topic.mastered, 'm', '已掌握')}</div>`;
  }

  // ---------- 主题看板 ----------
  function tile(topic) {
    const weak = topic.points.filter(point => point.weak > 0).slice(0, 2);
    const others = topic.points.filter(point => !weak.includes(point)).slice(0, Math.max(0, 3 - weak.length));
    const rest = topic.points.length - weak.length - others.length;
    const subs = [...weak.map(point => `<span class="w" title="常忘 ${point.weak} 张">${esc(point.name)} ${point.weak}</span>`), ...others.map(point => `<span>${esc(point.name)}</span>`), rest > 0 ? `<span>+${rest}</span>` : ''].join('');
    const isSelected = selected.has(topic.id);
    return `<article class="ct-tile${isSelected ? ' is-selected' : ''}" data-topic="${esc(topic.id)}" tabindex="0" aria-label="${esc(topic.name)}：${topic.due} 张到期，共 ${topic.total} 张">
      <div class="ct-tile-head"><span class="ct-dot c${topic.color}" aria-hidden="true"></span><b>${esc(topic.name)}</b><span class="ct-count">${topic.total} 张</span><button type="button" class="ct-check" data-topic-select="${esc(topic.id)}" role="checkbox" aria-checked="${isSelected}" aria-label="选择 ${esc(topic.name)}"></button></div>
      <div class="ct-tile-row">${topic.due ? `<span class="ct-due">${topic.due}<small>到期</small></span>` : '<span class="ct-due none">今天都复习完了</span>'}${retentionHtml(topic)}</div>
      ${mixBar(topic)}
      <div class="ct-subs">${subs}</div>
      <div class="ct-tile-foot"><span class="ct-when">${topic.due ? ago(topic.lastReviewedAt) : topic.nextDueAt ? `下次 ${dateLabel(topic.nextDueAt)}` : ago(topic.lastReviewedAt)}</span>${topic.due ? `<button type="button" class="ct-go" data-topic-review="${esc(topic.id)}">复习 ${topic.due}</button>` : `<button type="button" class="ct-go muted" data-topic-open="${esc(topic.id)}">查看</button>`}</div>
    </article>`;
  }

  function renderBoard(view) {
    const board = $('#cardTopicsBoard');
    const topicsById = new Map(view.topics.map(topic => [topic.id, topic]));
    for (const id of [...selected]) if (!topicsById.has(id)) selected.delete(id);
    const share = view.topics.filter(topic => topic.due > 0).sort((a, b) => b.due - a.due);
    const legend = share.slice(0, 6).map(topic => `<span><i class="ct-dot c${topic.color}"></i>${esc(topic.name)} ${topic.due}</span>`).join('') + (share.length > 6 ? `<span>其他 ${share.slice(6).reduce((sum, topic) => sum + topic.due, 0)}</span>` : '');
    const bar = share.map(topic => `<i class="c${topic.color}" style="width:${(topic.due / Math.max(1, view.due) * 100).toFixed(1)}%" title="${esc(topic.name)} ${topic.due}"></i>`).join('');
    const sortButton = (key, label) => `<button type="button" data-topic-sort="${key}" aria-pressed="${sort === key}">${label}</button>`;
    const groups = view.groups.map(group => {
      const topics = MemoKeepCardTopics.sortTopics(group.topics, sort);
      // 主题少的分组并排放在一行，避免一个主题占一整行。
      return `<section class="ct-group${topics.length >= 4 ? ' is-wide' : ''}" style="--ct-n:${Math.min(topics.length, 4)}" aria-label="${esc(group.name)}"><h3 class="ct-group-head"><span>${esc(group.name)}</span><small>${topics.length} 个主题 · 到期 ${group.due}</small><span class="ct-line"></span></h3><div class="ct-tiles">${topics.map(tile).join('')}</div></section>`;
    }).join('');
    const picked = [...selected].map(id => topicsById.get(id)).filter(Boolean);
    const pickedDue = picked.reduce((sum, topic) => sum + topic.due, 0);
    board.innerHTML = `
      <div class="ct-today">
        <div><div class="ct-big">${view.due}<small>${view.due ? '张今天要复习' : '今天没有要复习的卡片'}</small></div><div class="ct-meta">${view.due ? `约 <b>${view.minutes} 分钟</b> · 新卡 ${view.newDue} · ${share.length} 个主题` : '新的卡片到期后会出现在这里'}</div></div>
        <div class="ct-today-mix">${view.due ? `<div class="ct-mix big" role="img" aria-label="今天要复习的主题构成">${bar}</div><div class="ct-legend">${legend}</div>` : ''}</div>
        <button type="button" class="primary ct-review-all" data-topic-review-all ${view.due ? '' : 'disabled'}><svg aria-hidden="true"><use href="#icon-play"></use></svg><span>全部复习 · ${view.due}</span></button>
      </div>
      <div class="ct-bar"><span class="ct-bar-title">${view.topics.length} 个主题</span><span class="ct-grow"></span><div class="ct-seg" role="group" aria-label="主题排序">${sortButton('due', '到期多的在前')}${sortButton('retention', '记住率低的在前')}${sortButton('recent', '最近复习')}</div></div>
      <div class="ct-groups">${groups}</div>
      <div class="ct-selbar" ${picked.length ? '' : 'hidden'} role="region" aria-label="已选主题"><span><b>已选 ${picked.length} 个主题</b> · ${picked.map(topic => esc(topic.name)).join('、')} · 到期 ${pickedDue} 张 · 约 ${Math.max(1, Math.ceil(pickedDue * MemoKeepCardTopics.SECONDS_PER_CARD / 60))} 分钟</span><span class="ct-grow"></span><button type="button" class="ct-sel-clear" data-topic-clear>取消</button><button type="button" class="ct-sel-go" data-topic-review-selected ${pickedDue ? '' : 'disabled'}><svg aria-hidden="true"><use href="#icon-play"></use></svg>复习所选 · ${pickedDue}</button></div>`;
  }

  // ---------- 主题详情 ----------
  function renderDetail(view, scope) {
    const head = $('#cardTopicHead');
    const topic = view.topicById(scope.id);
    if (!topic) { head.innerHTML = ''; return; }
    const point = scope.point ? topic.points.find(item => item.id === scope.point) : null;
    const target = point || topic;
    const chip = (id, label, count, active) => `<button type="button" class="ct-point${active ? ' is-active' : ''}" data-topic-point="${esc(id)}" aria-pressed="${active}">${esc(label)}${count ? ` <em>${count}</em>` : ''}</button>`;
    head.innerHTML = `
      <button type="button" class="ct-back" data-topic-back><svg aria-hidden="true"><use href="#icon-arrow-left"></use></svg>全部主题</button>
      <div class="ct-stats">
        <div><b>${target.total}</b><small>张卡片</small></div>
        <div class="due"><b>${target.due}</b><small>今天到期</small></div>
        <div class="weak"><b>${target.weak}</b><small>薄弱（常忘）</small></div>
        <div class="${target.retention !== null && target.retention >= 75 ? 'good' : target.retention !== null ? 'weak' : ''}"><b>${target.retention === null ? '—' : `${target.retention}%`}</b><small>记住率 · 30 天</small></div>
        <div><b>${target.due ? `≈${target.minutes} 分钟` : '—'}</b><small>复习完到期</small></div>
      </div>
      <div class="ct-points" role="group" aria-label="技术点">${chip('', '全部', topic.due, !point)}${topic.points.map(item => chip(item.id, item.name, item.due, point?.id === item.id)).join('')}</div>${weakPointsBlock()}`;
  }

  // 最常漏的要点（design/prototype/memory-boost-20261112.md）：这个主题 / 技术点里多要点卡片的常漏条目，想起率从低到高。
  function weakPointsBlock() {
    const recall = window.MemoKeepPointRecall;
    if (!recall || typeof cardsInScope !== 'function') return '';
    const weak = recall.weakPoints(cardsInScope().filter(card => card.status === 'active'));
    if (!weak.length) return '';
    const shown = weak.slice(0, 6), ids = [...new Set(weak.map(item => item.cardId))];
    return `<section class="ct-weak-points" aria-label="最常漏的要点"><h3>最常漏的要点<small>最近 5 次漏了 2 次以上 · ${weak.length} 条</small></h3><ul>${shown.map(item => `<li><span class="t">${esc(item.text)}<small>${esc(String(item.question || '').slice(0, 40))} · 最近 ${item.history.length} 次漏了 ${item.misses} 次</small></span><span class="n">想起 ${item.rate}%</span></li>`).join('')}</ul>${weak.length > shown.length ? `<p class="ct-weak-more">还有 ${weak.length - shown.length} 条</p>` : ''}<button type="button" class="primary" data-topic-practice="${esc(ids.join(','))}">只练这些 · ${ids.length} 张卡</button><span class="ct-weak-note">和「再练一轮」一样，不改复习排期</span></section>`;
  }

  // ---------- 渲染入口（卡片列表渲染完调用） ----------
  function render() {
    if (!ready()) return;
    const scope = runtime().cardScope;
    const view = model();
    const hasCards = (data().cards || []).length > 0;
    const board = scope.type === 'all' && mode === 'topics' && hasCards;
    const detail = scope.type === 'topic';
    const page = $('#cardsView');
    page.classList.toggle('is-topic-board', board);
    page.classList.toggle('is-topic-detail', detail);
    $('#cardTopicsBoard').hidden = !board;
    $('#cardTopicHead').hidden = !detail;
    const toggle = $('#cardViewToggle');
    // 详情页本身就是列表，不需要切换。
    toggle.hidden = !hasCards || scope.type !== 'all';
    toggle.querySelectorAll('[data-card-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cardView === (detail ? 'topics' : board ? 'topics' : 'list'))));
    if (board) { renderBoard(view); $('#cardWorkspaceTitle').textContent = '记忆卡片'; $('#cardBreadcrumb').textContent = '记忆卡片 / 按主题'; }
    if (detail) renderDetail(view, scope);
    if (detail) {
      const topic = view.topicById(scope.id);
      const point = scope.point && topic?.points.find(item => item.id === scope.point);
      if (topic) {
        $('#cardWorkspaceTitle').textContent = point ? point.name : topic.name;
        $('#cardBreadcrumb').textContent = ['记忆卡片', topic.groupName === '其他' ? '' : topic.groupName, topic.name, point?.name].filter(Boolean).join(' / ');
        const button = $('#cardStartReviewBtn');
        const due = (point || topic).due;
        button.querySelector('span').textContent = point ? `只复习「${point.name}」 · ${due}` : `复习 ${topic.name} · ${due}`;
        button.disabled = !due;
      }
    }
  }

  // ---------- 操作 ----------
  function rerender() { application.views.cards.render(); }
  function openTopic(id, point = null) {
    runtime().cardScope = { type: 'topic', id, point: point || null };
    runtime().selectedCardIds.clear();
    runtime().activeCardFilter = 'all';
    rerender();
    $('#cardsView')?.scrollTo?.({ top: 0 });
  }
  async function reviewTopic(id) {
    openTopic(id);
    await application.operations.review.startReview(true);
  }
  async function reviewSelected() {
    const view = model();
    const topics = [...selected].map(id => view.topicById(id)).filter(Boolean);
    const ids = topics.flatMap(topic => topic.dueIds);
    if (!ids.length) return;
    await application.operations.review.startReview(false, ids, { key: `topics:${topics.map(topic => topic.id).sort().join(',')}` });
  }

  function onClick(event) {
    const practice = event.target.closest('[data-topic-practice]');
    if (practice) { application.views.review?.startPractice(practice.dataset.topicPractice.split(',').filter(Boolean)); return; }
    const target = event.target.closest('[data-card-view], [data-topic-sort], [data-topic-select], [data-topic-review], [data-topic-review-all], [data-topic-open], [data-topic-clear], [data-topic-review-selected], [data-topic-back], [data-topic-point], .ct-tile');
    if (!target || !ready()) return;
    if (target.dataset.cardView) {
      mode = target.dataset.cardView; store.set(VIEW_KEY, mode);
      if (mode === 'topics' && runtime().cardScope.type !== 'topic') runtime().cardScope = { type: 'all', id: '' };
      if (mode === 'list' && runtime().cardScope.type === 'topic') { /* 详情本身就是列表，不变 */ }
      rerender(); return;
    }
    if (target.dataset.topicSort) { sort = target.dataset.topicSort; store.set(SORT_KEY, sort); render(); return; }
    if (target.dataset.topicSelect) { event.stopPropagation(); const id = target.dataset.topicSelect; if (selected.has(id)) selected.delete(id); else selected.add(id); render(); return; }
    if (target.dataset.topicReview) { event.stopPropagation(); void reviewTopic(target.dataset.topicReview); return; }
    if (target.hasAttribute('data-topic-review-all')) { void application.operations.review.startReview(true); return; }
    if (target.dataset.topicOpen) { event.stopPropagation(); openTopic(target.dataset.topicOpen); return; }
    if (target.hasAttribute('data-topic-clear')) { selected.clear(); render(); return; }
    if (target.hasAttribute('data-topic-review-selected')) { void reviewSelected(); return; }
    if (target.hasAttribute('data-topic-back')) { runtime().cardScope = { type: 'all', id: '' }; mode = 'topics'; store.set(VIEW_KEY, mode); rerender(); return; }
    if (target.hasAttribute('data-topic-point')) { openTopic(runtime().cardScope.id, target.dataset.topicPoint || null); return; }
    if (target.classList.contains('ct-tile')) openTopic(target.dataset.topic);
  }
  function onKey(event) {
    const tileNode = event.target.closest?.('.ct-tile');
    if (!tileNode || event.target !== tileNode) return;
    if (event.key === 'Enter') { event.preventDefault(); openTopic(tileNode.dataset.topic); }
    if (event.key === ' ') { event.preventDefault(); tileNode.querySelector('[data-topic-select]')?.click(); }
  }

  function bind() {
    const page = $('#cardsView');
    if (!page) return;
    page.addEventListener('click', onClick);
    page.addEventListener('keydown', onKey);
  }

  // 复习结束后「接着复习」：别的主题（到期多的在前），以及剩下全部。
  function suggestions(currentKey = '') {
    if (!window.MemoKeepCardTopics || typeof applicationShell === 'undefined') return null;
    const view = model();
    const current = /^topic:([^:]+:[^:]+)/.exec(currentKey)?.[1];
    const topics = MemoKeepCardTopics.sortTopics(view.topics.filter(topic => topic.due > 0 && topic.id !== current), 'due').slice(0, 3).map(topic => ({ id: topic.id, name: topic.name, due: topic.due, color: topic.color }));
    return { topics, all: view.due };
  }

  window.MemoKeepCardTopicsView = { render, openTopic, reviewTopic, suggestions, get mode() { return mode; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
