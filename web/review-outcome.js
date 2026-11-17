// Waiting and round-summary screens shared by both review entry points.
const ReviewOutcome = (() => {
  const labels = { again: '忘记', hard: '有点难', good: '记住', easy: '很简单' };
  const duration = ms => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const countdown = ms => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // 卡片文字里可能有图片引用，列表里只留文字。
  const plain = value => String(value || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/\s+/g, ' ').trim();
  function mount({ host, getState, onResume, onUndo, onReturn, onClose, onOpenSource, onReviewTopic, onPractice, onRemind, isVisible = () => true }) {
    host.classList.add('review-outcome', 'ro');
    host.innerHTML = `<div class="ro-head"><strong data-role="page-title">今日复习</strong><button type="button" class="ro-close" data-action="close" aria-label="结束本轮" title="结束本轮，进度已保存"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <section class="ro-wait" data-role="waiting">
        <div class="ro-ring"><svg viewBox="0 0 116 116" aria-hidden="true"><circle class="ro-ring-bg" cx="58" cy="58" r="52"/><circle class="ro-ring-fg" data-role="ring" cx="58" cy="58" r="52"/></svg><strong data-role="countdown" role="timer" aria-live="off"></strong></div>
        <h2 data-role="wait-title"></h2><p class="ro-copy" data-role="wait-copy"></p>
        <div class="ro-next"><span class="ro-kind">卡片</span><strong data-role="next-title"></strong><span class="ro-rating" data-role="next-rating"></span></div>
        <div class="ro-actions"><button type="button" class="ro-primary" data-action="resume">继续复习</button><button type="button" class="ro-secondary" data-action="summary">先结束，看本轮记录</button></div>
        <p class="ro-foot"><span data-role="last-rating"></span><button type="button" class="ro-link" data-action="undo">撤销</button></p>
        <p class="ro-foot ro-reminder" data-role="reminder"></p>
      </section>
      <section class="ro-summary hidden" data-role="summary">
        <h2 data-role="summary-title">本轮完成</h2><p class="ro-copy" data-role="summary-copy">进度已保存</p>
        <div class="ro-stats"><div><strong data-role="cards">0</strong><span>张卡片</span></div><div data-role="points-cell" class="hidden"><strong data-role="points">0</strong><span>个知识点</span></div><div data-role="duration-cell"><strong data-role="duration">0:00</strong><span>用时</span></div><div><strong data-role="recall">–</strong><span>记住或很简单</span></div><div><strong data-role="streak">0 天</strong><span>连续复习</span></div></div>
        <section class="ro-dist"><h3>评分<small><span data-role="ratings">0</span> 次，同一张卡评了多次都算</small></h3><div class="ro-bar" role="img" aria-label="本轮评分分布"></div><div class="ro-legend"></div></section>
        <section class="ro-weak-block" data-role="weak-block"><h3 data-role="weak-title">需要再看<small data-role="weak-count"></small></h3><ul class="ro-weak" data-role="weak"></ul><div class="ro-weak-actions" data-role="weak-actions"><button type="button" class="ro-primary" data-action="practice">现在再练一轮</button><button type="button" class="ro-secondary" data-action="remind">10 分钟后提醒我</button><span>只是练习，不改复习排期</span></div></section>
        <div class="ro-upcoming"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><p data-role="upcoming"></p><button type="button" class="ro-link" data-action="waiting">查看等待</button></div>
        <div class="ro-actions start"><button type="button" class="ro-primary" data-action="close">完成</button><button type="button" class="ro-text" data-action="undo">撤销最后一次评分</button></div>
        <span class="ro-hidden" data-role="pending">0</span>
      </section>
      <section class="ro-next-topics hidden" data-role="next-topics"><h3 data-role="next-topics-title">接着复习</h3><div class="ro-next-list" data-role="next-list"></div></section><p class="round-error ro-error" role="alert"></p>`;
    const $ = role => host.querySelector(`[data-role="${role}"]`);
    const buttons = action => [...host.querySelectorAll(`[data-action="${action}"]`)];
    const ring = $('ring'), circumference = 2 * Math.PI * 52;
    if (ring) ring.style.strokeDasharray = String(circumference);
    let mode = 'waiting', timer = null, busy = false, waitFrom = null, autoResumed = false;
    function refresh() {
      if (!isVisible()) { stop(); return; }
      const state = getState();
      const { summary: s, at = Date.now(), canUndo, settings } = state;
      if (mode === 'waiting' && !s.pending.length) mode = 'summary';
      $('waiting').classList.toggle('hidden', mode !== 'waiting');
      $('summary').classList.toggle('hidden', mode !== 'summary');
      $('page-title').textContent = mode === 'waiting' ? '今日复习' : '本轮记录';
      const next = s.pending[0];
      const relearning = next && [1, 3].includes(next.schedulerData?.state);
      const ready = s.ready.length > 0;
      const remaining = next ? Math.max(0, Number(next.dueAt) - at) : 0;
      if (next && !ready && (waitFrom === null || remaining > waitFrom)) waitFrom = remaining;
      $('countdown').textContent = next ? ready ? '已到期' : countdown(remaining) : '';
      if (ring) ring.style.strokeDashoffset = String(ready || !waitFrom ? 0 : circumference * (1 - remaining / waitFrom));
      $('wait-title').textContent = ready ? `${s.ready.length} 张已到期，可以继续` : `还剩 ${s.pending.length} 张，稍等一下`;
      $('wait-copy').textContent = ready ? '点「继续复习」接着复习。'
        : relearning ? '刚才忘记的卡片过一会儿再考一次，到时间会自动继续。' : '稍后再看的卡片到时间会自动继续。';
      $('next-title').textContent = plain(next?.question);
      const lastForNext = next && [...(s.weak || [])].find(item => item.cardId === next.id);
      $('next-rating').textContent = lastForNext ? `刚才：${labels[lastForNext.rating]}` : '';
      buttons('resume').forEach(button => { button.classList.toggle('hidden', !ready); button.textContent = relearning ? '继续重学' : '继续复习'; });
      $('reminder').textContent = settings?.notificationsEnabled ? '进度已保存，到时间会提醒你。' : '进度已保存，可以先关掉。';
      $('last-rating').textContent = s.last ? `刚才评了「${labels[s.last.rating]}」 · ` : '';
      const points = s.points || 0;
      $('cards').textContent = s.cards - points; $('points').textContent = points;
      $('points-cell').classList.toggle('hidden', !points); $('duration-cell').classList.toggle('hidden', Boolean(points));
      $('ratings').textContent = s.ratings; $('duration').textContent = duration(s.elapsedMs); $('pending').textContent = s.pending.length;
      const kept = (s.counts.good || 0) + (s.counts.easy || 0);
      $('recall').textContent = s.ratings ? `${Math.round(kept / s.ratings * 100)}%` : '–';
      $('streak').textContent = `${Number(state.streak) || 0} 天`;
      $('summary-title').textContent = s.todayComplete ? '今天的复习完成了' : '本轮完成';
      $('summary-copy').textContent = `${s.cards - points} 张卡片${points ? `、${points} 个知识点` : ''}，用时 ${duration(s.elapsedMs)} · 进度已保存`;
      const bar = host.querySelector('.ro-bar'), legend = host.querySelector('.ro-legend');
      // Only reconstruct the distribution when ratings change, preserving focus during ticks.
      const signature = JSON.stringify(s.counts);
      if (bar.dataset.counts !== signature) {
        bar.dataset.counts = signature; bar.textContent = ''; legend.textContent = '';
        for (const [rating, label] of Object.entries(labels)) {
          const segment = document.createElement('span'); segment.className = `ro-segment ${rating}`;
          segment.style.flexGrow = s.counts[rating]; segment.classList.toggle('hidden', !s.counts[rating]); bar.appendChild(segment);
          const item = document.createElement('span'); item.className = `ro-legend-item ${rating}`; item.textContent = `${label} ${s.counts[rating]}`; legend.appendChild(item);
        }
        bar.classList.toggle('empty', !s.ratings);
        bar.setAttribute('aria-label', Object.entries(labels).map(([key, label]) => `${label} ${s.counts[key]} 次`).join('，'));
      }
      const weak = s.weak || [], weakList = $('weak');
      $('weak-block').classList.toggle('hidden', !weak.length);
      // 再练一轮（design/prototype/memory-boost-20261112.md）：忘记、有点难、漏了要点的都算还没记牢。
      const canPractice = Boolean(onPractice) && weak.length > 0;
      $('weak-title').firstChild.textContent = canPractice ? `这 ${weak.length} 张今天还没记牢` : '需要再看';
      $('weak-count').textContent = canPractice ? '趁现在再回想一次，记得更牢' : `本轮忘记或有点难的 ${weak.length} 项`;
      $('weak-actions').hidden = !canPractice;
      const practiceButton = host.querySelector('[data-action="practice"]');
      if (practiceButton) practiceButton.textContent = `现在再练一轮 · 约 ${Math.max(1, Math.round(weak.length * 25 / 60))} 分钟`;
      host.querySelector('[data-action="remind"]').hidden = !onRemind;
      const weakSignature = JSON.stringify(weak);
      if (weakList.dataset.items !== weakSignature) {
        weakList.dataset.items = weakSignature;
        weakList.innerHTML = weak.map(item => `<li><span class="ro-kind${item.kind === 'point' ? ' point' : ''}">${item.kind === 'point' ? '知识点' : '卡片'}</span><span class="ro-q">${escapeHtml(plain(item.question))}</span><span class="ro-rating ${item.rating}">${labels[item.rating]}${item.missed ? ` · 漏了 ${item.missed} 条` : ''}</span>${onOpenSource ? `<button type="button" class="ro-link" data-action="source" data-card="${escapeHtml(item.cardId)}">${item.kind === 'point' ? '看详细' : '看出处'}</button>` : ''}</li>`).join('');
      }
      // 接着复习：别的主题 + 剩下全部（只在本轮完成、没有等待中的卡片时显示）。
      const nextBlock = $('next-topics'), nextUp = state.next;
      // 等待中（刚忘记的卡片过一会儿再考）也显示：等的时候可以先复习别的主题。
      const showNext = Boolean(onReviewTopic && nextUp && (nextUp.topics.length || nextUp.all));
      $('next-topics-title').textContent = mode === 'waiting' ? '等的时候，先复习别的' : '接着复习';
      nextBlock.classList.toggle('hidden', !showNext);
      if (showNext) $('next-list').innerHTML = nextUp.topics.map(topic => `<button type="button" class="ro-secondary ro-next-topic" data-action="topic" data-card="${escapeHtml(topic.id)}"><i class="ro-topic-dot c${topic.color}"></i>${escapeHtml(topic.name)} · ${topic.due}</button>`).join('')
        + (nextUp.all ? `<button type="button" class="ro-primary ro-next-all" data-action="topic" data-card="all">剩下全部 · ${nextUp.all}</button>` : '');
      $('upcoming').innerHTML = next ? ready ? `<b>${s.ready.length} 张已到期</b>，可以继续复习` : `<b>${s.pending.length} 张稍后再看</b> · ${countdown(remaining)} 后到期`
        : s.todayComplete ? (s.tomorrow ? `接下来：<b>明天 ${s.tomorrow} 张</b>` : '接下来：明天没有到期的卡片')
          : `当前范围已完成 · 其他目录还有 <b>${s.outsidePending} 张</b>待复习`;
      buttons('waiting').forEach(button => button.classList.toggle('hidden', !next));
      buttons('undo').forEach(button => { button.disabled = busy || !canUndo; button.hidden = !canUndo; button.title = canUndo ? '恢复最后一次评分前的卡片状态' : '暂无可撤销的评分，或卡片已有后续修改'; });
      if (!ready) autoResumed = false;
      return { ready };
    }
    async function act(action, payload) {
      if (busy) return;
      if (action === 'summary' || action === 'waiting') { mode = action; refresh(); return; }
      if (action === 'source') { await onOpenSource?.(payload); return; }
      busy = true; host.querySelector('.round-error').textContent = '';
      host.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        if (action === 'resume') await onResume();
        else if (action === 'undo') await onUndo();
        else if (action === 'return') await onReturn();
        else if (action === 'close') await onClose();
        else if (action === 'topic') await onReviewTopic?.(payload);
        else if (action === 'practice') await onPractice?.((getState().summary.weak || []).map(item => item.cardId));
        else if (action === 'remind') await onRemind?.((getState().summary.weak || []).map(item => item.cardId));
      } catch (error) { host.querySelector('.round-error').textContent = error.message || '操作未保存，请重试。'; }
      finally { busy = false; host.querySelectorAll('button').forEach(button => { button.disabled = false; }); if (isVisible()) refresh(); }
    }
    host.onclick = event => { const button = event.target.closest('[data-action]'); if (button && !button.disabled) void act(button.dataset.action, button.dataset.card); };
    // 计时器每秒刷新；等待中的卡片到期时自动继续一次。
    function tick() {
      const result = refresh();
      if (mode === 'waiting' && result?.ready && !autoResumed && !busy) { autoResumed = true; void act('resume'); }
    }
    function stop() { if (timer !== null) clearInterval(timer); timer = null; }
    return { show(initialMode) { mode = initialMode; waitFrom = null; autoResumed = false; stop(); refresh(); timer = setInterval(tick, 1000); }, stop, refresh, act };
  }
  return { mount, countdown, duration };
})();
