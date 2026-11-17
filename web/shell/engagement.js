(function expose(root) {
  function createEngagementFeatures({ state, config, actions, env }) {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const plain = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    const button = (text, action, attrs = '', cls = 'secondary') => `<button type="button" class="${cls}" data-growth-action="${action}" ${attrs}>${text}</button>`;
    const model = () => env.MemoKeepDomain.buildEngagement(state.persistence.data, config.now());
    let pending = false, boundHost, reportDialog, reportPage = 1;
    function companion(current) {
      return `<div class="engagement-companion" data-accessory="${escape(current.accessory)}"><img src="assets/xiaojiu-reference-cat.png" width="160" height="97" alt="学习伙伴小久"><span class="engagement-prop" aria-hidden="true"></span></div><div><strong>小久 · Lv.${current.level}</strong><p>${current.restToday ? '今日休息' : `今日 ${current.todayCount} 次回忆`}</p><progress max="100" value="${current.xp % 100}" aria-label="当前等级成长进度"></progress><small>${current.xp} 成长值 · 升级还需 ${100 - current.xp % 100}</small></div>`;
    }
    function renderEngagementSummary() {
      const summary = env.MemoKeepDomain.engagementSummary(state.persistence.data, config.now());
      const heading = config.$('#homeView .home-pet-panel h2'); if (heading) heading.textContent = `小久 · Lv.${summary.level}`;
      const cat = config.$('#homeView .home-pet-panel'); if (cat) cat.dataset.accessory = summary.accessory;
      if (summary.restToday) { const speech = config.$('#petSpeech'); if (speech) speech.textContent = '今日休息'; }
      return summary;
    }
    function renderEngagement() {
      const host = config.$('#growthContent') || config.$('#growthView'); if (!host) return;
      const current = model(), ready = current.eligible && !current.claimed && !current.restToday;
      host.innerHTML = `<div class="engagement-page"><header class="engagement-head"><div><h1>学习成长</h1></div>${button('本周回顾','report')}</header>
        <div class="engagement-overview"><section class="engagement-week"><div class="engagement-section-head"><h2>过去 7 天</h2><span>周目标 ${current.weeklyGoal} 天</span></div><p><strong>${current.week.studyDays} 天</strong> · <strong>${current.week.reviewCount} 次回忆</strong>${current.week.hasTime ? ` · 约 <strong>${current.week.minutes} 分钟</strong>` : ''}</p><div class="engagement-days">${current.week.days.map(day => `<div class="${day.count ? 'done' : ''} ${day.key === current.today ? 'today' : ''}"><span>周${day.label}</span><strong>${day.count || '—'}</strong><small>${day.key.slice(5)}</small></div>`).join('')}</div></section><aside class="engagement-buddy">${companion(current)}</aside></div>
        <section class="engagement-task"><div><h2>${current.restToday ? '今日休息' : current.claimed ? '今日已领取' : '每日奖励'}</h2><p>${current.restToday ? '暂停学习提醒，复习计划保留。' : current.claimed ? '20 成长值 · 每天一次' : `一轮复习或 3 次回忆 · 20 成长值/天`}</p></div>${current.restToday || current.claimed ? `<span class="engagement-state">${current.restToday ? '休息日' : '已领取'}</span>` : button(ready ? '领取 20 成长值' : '开始复习', ready ? 'claim' : 'review', '', ready ? 'primary' : 'secondary')}</section>
        <p class="engagement-error" data-growth-error role="alert" hidden></p>
        <section class="engagement-topics"><div class="engagement-section-head"><h2>主题进展</h2>${button('记录笔记','notes','','text-btn')}</div>${current.topics.length ? current.topics.map(topic => `<div class="engagement-topic"><div><strong>${escape(topic.name)}</strong><small>${topic.total} 张卡片 · ${topic.reviewed} 张已开始 · ${topic.due} 张到期${topic.weak ? ` · ${topic.weak} 张需巩固` : ''}</small></div><progress max="${Math.max(1,topic.total)}" value="${topic.reviewed}" aria-label="${escape(topic.name)} 已开始复习比例"></progress>${button(topic.id ? '查看卡片' : '查看全部卡片','topic',`data-id="${escape(topic.id)}"`,'text-btn')}</div>`).join('') : '<p class="engagement-empty">暂无卡片</p>'}</section>
        <section class="engagement-task engagement-note-task"><div><h2>笔记</h2><p>今日 ${current.createdToday} 篇</p></div>${button('记录笔记','notes')}</section>
        <details class="engagement-options"><summary>配饰与设置</summary><div class="engagement-option-grid"><section><h2>小久配饰</h2><div class="engagement-accessories">${current.accessories.map(item => button(`<span class="engagement-accessory-art ${item.id}" aria-hidden="true"></span><span><strong>${item.label}</strong><small>${item.unlocked ? current.accessory === item.id ? '正在佩戴' : '已解锁' : `${item.requirement} 成长值解锁`}</small></span>`, 'accessory',`data-id="${item.id}" aria-pressed="${current.accessory === item.id}" ${item.unlocked ? '' : 'disabled'}`,'engagement-accessory')).join('')}</div></section><section><h2>学习节奏</h2><form data-growth-goal><label>每周练习目标<select name="goal">${[1,2,3,4,5,6,7].map(day => `<option value="${day}" ${current.weeklyGoal === day ? 'selected' : ''}>${day} 天</option>`).join('')}</select></label><button type="submit" class="secondary">保存周目标</button></form><p class="engagement-caption">${current.claimed ? '今日奖励已领取。' : `本周可休息 ${current.restAvailable} 天（每周 1 天）。`}仅暂停提醒，不调整复习计划。</p>${button(current.restToday ? '取消休息' : '今日休息','rest',!current.restToday && !current.restAvailable || current.claimed ? 'disabled' : '')}</section></div></details></div>`;
      if (boundHost !== host) { host.addEventListener('click', handleClick); host.addEventListener('submit', handleSubmit); boundHost = host; }
      renderEngagementSummary();
    }
    async function command(value) {
      if (pending) return false; pending = true;
      const host = config.$('#growthContent') || config.$('#growthView'); host?.querySelectorAll('button, select').forEach(button => { button.disabled = true; });
      const error = host?.querySelector('[data-growth-error]'); if (error) error.hidden = true;
      try {
        await env.application.persistence.transact(data => env.MemoKeepDomain.applyEngagementCommand(data, value, config.now()));
        renderEngagement(); actions.showToast(value.type === 'claim' ? '获得 20 成长值' : value.type === 'rest' ? '休息日已保存' : '已保存');
        return true;
      } catch (reason) { if (error) { error.textContent = reason.message || '保存失败，请重试。'; error.hidden = false; } return false; }
      finally { pending = false; if (host?.isConnected) host.querySelectorAll('button, select').forEach(button => { button.disabled = false; }); const current = model(); host?.querySelectorAll('[data-growth-action="accessory"]').forEach(button => { button.disabled = !current.accessories.find(item => item.id === button.dataset.id)?.unlocked; }); const rest = host?.querySelector('[data-growth-action="rest"]'); if (rest) rest.disabled = current.claimed || !current.restToday && !current.restAvailable; }
    }
    async function handleClick(event) {
      const target = event.target.closest('[data-growth-action]'); if (!target || target.disabled) return;
      const action = target.dataset.growthAction;
      if (['claim','rest'].includes(action)) { await command({ type: action }); return; }
      if (action === 'accessory') { await command({ type: 'accessory', id: target.dataset.id }); return; }
      if (action === 'report') { openGrowthReport(); return; }
      if (action === 'repair') { reportDialog?.close(); const card = env.application.state.cards.byId(target.dataset.id); if (card) env.application.views.cardDetail.openCardDetail(card); return; }
      if (action === 'notes') { actions.showView('libraries'); return; }
      if (action === 'review') { await env.application.operations.review.startReview(false, actions.homeLearningPlan?.().ids || null); return; }
      if (action === 'topic') { const runtime = env.application.cards.runtime; runtime.cardScope = { type: 'all', id: '' }; runtime.activeCardFilter = 'all'; runtime.activeCardLibraryFilter = target.dataset.id || 'all'; runtime.selectedCardTags.clear(); config.$('#cardSearch').value = ''; actions.showView('cards'); return; }
      if (action === 'report-page') { reportPage = Math.max(1,Number(target.dataset.page)||1); renderReport(); }
    }
    async function handleSubmit(event) { const form = event.target.closest('[data-growth-goal]'); if (!form) return; event.preventDefault(); await command({ type: 'goal', goal: Number(form.elements.goal.value) }); }
    function renderReport() {
      if (!reportDialog) return;
      const current = model(), weak = current.weak, pages = Math.max(1,Math.ceil(weak.length / 10)); reportPage = Math.min(reportPage,pages);
      reportDialog.querySelector('[data-report-body]').innerHTML = `<div class="engagement-report-metrics"><div><strong>${current.week.studyDays}</strong><span>参与天数 / 目标 ${current.weeklyGoal}</span></div><div><strong>${current.week.reviewCount}</strong><span>复习次数</span></div><div><strong>${current.week.cards}</strong><span>复习卡片</span></div><div><strong>${weak.length}</strong><span>近期需巩固</span></div></div><h3>评分分布</h3><div class="engagement-report-ratings">${Object.entries({again:'忘记',hard:'困难',good:'记得',easy:'轻松'}).map(([key,label]) => `<span>${label}<strong>${current.week.ratings[key]}</strong></span>`).join('')}</div><h3>待巩固</h3><div class="engagement-weak-list">${weak.slice((reportPage-1)*10,reportPage*10).map(entry => `<article><div><strong>${escape(plain(entry.card.question) || '图片卡片')}</strong><small>${entry.last.rating === 'again' ? '最近忘记' : '最近困难'} · 本周 ${entry.count} 次需巩固</small></div>${button('修复','repair',`data-id="${escape(entry.card.id)}"`)}</article>`).join('') || '<p>暂无待巩固卡片</p>'}</div><div class="engagement-report-page"><span>${weak.length} 张 · ${reportPage}/${pages}</span>${button('上一页','report-page',`data-page="${reportPage-1}" ${reportPage===1?'disabled':''}`)}${button('下一页','report-page',`data-page="${reportPage+1}" ${reportPage===pages?'disabled':''}`)}</div>`;
    }
    function openGrowthReport() {
      if (!reportDialog) { reportDialog = env.document.createElement('dialog'); reportDialog.id = 'growthReportDialog'; reportDialog.className = 'engagement-report-dialog'; reportDialog.setAttribute('aria-labelledby','growthReportTitle'); reportDialog.innerHTML = '<form method="dialog" class="engagement-report-head"><h2 id="growthReportTitle">本周回顾</h2><button type="submit" class="icon-btn" aria-label="关闭学习回顾">×</button></form><div data-report-body></div>'; env.document.body.append(reportDialog); reportDialog.addEventListener('click',handleClick); }
      reportPage=1; renderReport(); if (!reportDialog.open) reportDialog.showModal();
    }
    async function openGrowth() { if (!await env.application.editor.session.leaveActiveNoteEditor()) return false; actions.showView('growth'); return true; }
    return { renderEngagement, renderGrowth: renderEngagement, renderEngagementSummary, openGrowth, openGrowthReport };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEngagementFeatures });
})(globalThis);
