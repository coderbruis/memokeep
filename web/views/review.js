(function expose(root) {
  function createReviewView({ state, runtime, transactions, operations, $, document, shortcuts, scheduler, presentation, outcome,
    now, documentById, sourceLabel, sanitizeRichNoteContent, renderMarkdown, renderAll, showView, renderCards, showToast, openNote, openPointNote, locateCardSource, editCard, syncPoints }) {
    // 语音作答（review-voice.js）：桌面版且系统支持时才显示按钮。
    runtime.reviewVoice ||= root.MemoKeepReviewVoice && root.MemoKeepVoiceAnswer ? root.MemoKeepReviewVoice.create({ $, document, desktop: root.memoKeepDesktop,
      compare: root.MemoKeepVoiceAnswer, terms: root.MemoKeepVoiceTerms || null, shortcuts, settings: () => state.settings?.current, reveal: () => $('#revealBtn').click(),
      // 改字后点「记住」：合并进设置里的语音词库（settings.voiceTerms）。
      // 语音区域的「语音设置」：先退出复习（进度已保存），再打开 设置 › 语音作答。
      openSettings: root.MemoKeepVoiceSettingsPage ? focus => { const close = $('#reviewDialog .rv-close'); if (close) close.click(); else $('#reviewDialog').close(); root.MemoKeepVoiceSettingsPage.open({ focus }); } : null,
      // 复习时勾选 / 取消词库：写进 settings.voicePacks。
      savePacks: mutate => typeof application !== 'undefined' && root.MemoKeepVoiceTerms
        ? application.persistence.transact(data => { data.settings.voicePacks = mutate(root.MemoKeepVoiceTerms.packConfig(data.settings.voicePacks)); })
        : Promise.reject(new Error('unavailable')),
      saveTerms: pairs => typeof application !== 'undefined' && root.MemoKeepVoiceTerms
        ? application.persistence.transact(data => { data.settings.voiceTerms = root.MemoKeepVoiceTerms.remember(data.settings.voiceTerms, pairs); })
        : Promise.reject(new Error('unavailable')),
      isRevealed: () => !$('#answerArea').classList.contains('hidden') }) : null;
    function finishReviewSession(mode) {
      runtime.reviewSessionPaused = true;
      runtime.reviewAwaitingContinue = false;
      runtime.reviewMemoryPanel?.close();
      closeReviewSourceDrawer();
      runtime.reviewVoice?.reset();
      $('#answerArea').classList.add('hidden'); $('#ratings').classList.add('hidden'); $('#revealBtn').classList.add('hidden');
      $('#reviewDialog').close();
      renderAll();
      runtime.reviewOutcomeController ||= outcome.mount({ host: $('#reviewOutcomeHost'), getState: operations().outcomeState,
        isVisible: () => $('#reviewResultDialog').open,
        onResume: () => operations().resumeReviewRound(), onUndo: operations().undoLastReview,
        onReturn: () => { runtime.reviewOutcomeController.stop(); $('#reviewResultDialog').close(); showView('cards'); renderCards(); },
        onClose: () => { runtime.reviewOutcomeController.stop(); $('#reviewResultDialog').close(); },
        // 这几张今天还没记牢：现在再练一轮 / 10 分钟后提醒（不改复习排期）。
        onPractice: ids => { runtime.reviewOutcomeController.stop(); $('#reviewResultDialog').close(); return startPractice(ids, { fromOutcome: true }); },
        onRemind: ids => remindPractice(ids),
        // 接着复习某个主题（或剩下全部）。
        onReviewTopic: root.MemoKeepCardTopicsView ? async id => {
          runtime.reviewOutcomeController.stop(); $('#reviewResultDialog').close(); showView('cards');
          if (id === 'all') { application.cards.runtime.cardScope = { type: 'all', id: '' }; renderCards(); await operations().startReview(true); }
          else await root.MemoKeepCardTopicsView.reviewTopic(id);
        } : null,
        onOpenSource: openNote ? async cardId => {
          const card = state.read().cards.find(candidate => candidate.id === cardId);
          const sourceDocument = documentById(card?.cardType === 'point' ? card.pointDocumentId : state.knowledge.itemById(card?.knowledgeItemId)?.documentId);
          if (!sourceDocument) { showToast('找不到来源笔记'); return; }
          runtime.reviewOutcomeController.stop(); $('#reviewResultDialog').close();
          await openNote(sourceDocument.id);
        } : undefined
      });
      if (!$('#reviewResultDialog').open) $('#reviewResultDialog').showModal();
      runtime.reviewOutcomeController.show(mode || (operations().outcomeState().summary.pending.length ? 'waiting' : 'summary'));
    }

    function updateReviewMemoryPanel(rated = runtime.reviewAwaitingContinue) {
      const card = state.read().cards.find(card => card.id === runtime.reviewQueue[runtime.reviewIndex]?.id);
      if (!card) return;
      runtime.reviewMemoryPanel ||= presentation.mount({
        host: $('#reviewDialogLayout'), footer: $('#reviewDialog .review-footer'),
        sourceButton: $('#reviewOpenSource'), closeSource: closeReviewSourceDrawer
      });
      runtime.reviewMemoryPanel.update(card, documentById(state.knowledge.itemById(card.knowledgeItemId)?.documentId), state.read().reviewRecords || [], rated);
    }

    function updateProgress() {
      const total = runtime.reviewQueue.length;
      const completed = runtime.reviewQueue.filter(card => runtime.reviewedCardIds.has(card.id)).length;
      $('#reviewProgress').textContent = `${Math.min(completed + 1, total)} / ${total}`;
      $('#reviewProgressBar').style.width = `${total ? completed / total * 100 : 0}%`;
      const track = $('#reviewProgressBar').parentElement;
      if (track) {
        track.removeAttribute('aria-hidden');
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', '本轮已保存进度');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(total));
        track.setAttribute('aria-valuenow', String(completed));
        track.setAttribute('aria-valuetext', `已保存 ${completed} / ${total} 张`);
      }
      const note = $('#reviewSessionNote');
      if (note) note.textContent = `已保存 ${completed} / ${total} 张`;
      renderSegments(total);
    }

    // 每项一段，评过的按最后一次评分上色；项目太多时退回连续进度条。
    function renderSegments(total) {
      const host = $('#reviewProgressSegments');
      if (!host) return;
      host.closest('.rv-progress')?.classList.toggle('is-continuous', total > 40);
      if (total > 40) { host.textContent = ''; return; }
      const last = new Map();
      for (const result of runtime.reviewSessionResults || []) if (result?.cardId && result.rating) last.set(result.cardId, result.rating);
      const current = runtime.reviewQueue[runtime.reviewIndex]?.id;
      host.innerHTML = runtime.reviewQueue.map(card => {
        const rating = runtime.reviewedCardIds.has(card.id) ? last.get(card.id) || 'done' : card.id === current ? 'now' : '';
        return `<i${rating ? ` class="${rating}"` : ''}></i>`;
      }).join('');
    }

    function refreshUndo() {
      const button = $('#reviewUndo');
      if (!button) return;
      let canUndo = false;
      try { canUndo = !runtime.practice && Boolean(operations().outcomeState?.().canUndo); } catch { canUndo = false; }
      button.hidden = !canUndo;
    }

    function setSaveStatus(message = '') {
      const status = $('#reviewSaveStatus');
      if (status) { status.textContent = message; status.hidden = !message; status.classList.toggle('error', Boolean(message)); }
      return Boolean(status);
    }

    function showReviewCard() {
      runtime.reviewOutcomeController?.stop();
      setSaveStatus();
      runtime.reviewAwaitingContinue = false;
      $('#reviewContinue').classList.add('hidden');
      $('#reviewDialog').classList.remove('is-rated');
      document.querySelector('#revealBtn kbd').textContent = shortcuts.label('reveal');
      $('#ratings').querySelectorAll('[data-rating] kbd').forEach((key, index) => { key.textContent = shortcuts.label(`rate-${index + 1}`); });
      $('#reviewDialog').querySelectorAll('[data-shortcut-label]').forEach(key => { key.textContent = shortcuts.label(key.dataset.shortcutLabel); });
      $('#reviewLater').hidden = Boolean(runtime.practice);
      $('#reviewDialog').classList.toggle('is-practice', Boolean(runtime.practice));
      const title = $('#reviewDialog .rv-title strong');
      if (title) title.textContent = runtime.practice ? '再练一轮' : '今日复习';
      const card = state.read().cards.find(candidate => candidate.id === runtime.reviewQueue[runtime.reviewIndex]?.id);
      const sourceItem = state.knowledge.itemById(card.knowledgeItemId);
      const isPoint = card.cardType === 'point';
      const sourceDocument = documentById(isPoint ? card.pointDocumentId : sourceItem?.documentId);
      runtime.reviewCurrentPoint = isPoint ? card.pointHeading || card.question : null;
      runtime.reviewCardShownAt = now();
      runtime.reviewActionPending = false;
      updateProgress();
      // 知识点和卡片用同一个界面：标题代替问题，要点代替答案。
      $('#reviewDialog').classList.toggle('is-point', isPoint);
      const kind = $('#reviewDialog .rv-kind');
      if (kind) kind.innerHTML = `<svg aria-hidden="true"><use href="#icon-${isPoint ? 'lightbulb' : 'layers'}"></use></svg>${isPoint ? '知识点' : '卡片'}${runtime.practice ? '<span class="rv-practice-badge">再练 · 不计入排期</span>' : ''}`;
      if (isPoint) {
        $('#reviewQuestion').textContent = card.question;
        const answer = $('#reviewAnswer');
        answer.textContent = '';
        const label = document.createElement('span'); label.className = 'rv-gist-label'; label.textContent = '要点';
        const list = document.createElement('ul'); list.className = 'rv-gist';
        for (const line of String(card.answer || '').split('\n').filter(Boolean)) {
          const item = document.createElement('li');
          // **加粗** 是要点里常用的写法，其余保持纯文本。
          line.split(/(\*\*[^*]+\*\*)/).forEach(part => {
            if (/^\*\*[^*]+\*\*$/.test(part)) { const bold = document.createElement('b'); bold.textContent = part.slice(2, -2); item.append(bold); }
            else if (part) item.append(part);
          });
          list.append(item);
        }
        answer.append(label, list);
        // 自己写了题目的要点：出处里带上标题。
        $('#reviewSource').textContent = [sourceDocument?.title || sourceLabel(card), card.pointHeading].filter(Boolean).join(' › ');
      } else {
        presentation.renderContent($('#reviewQuestion'), card.question, card); presentation.renderAnswer($('#reviewAnswer'), card.answer, card); $('#reviewSource').textContent = sourceLabel(card);
      }
      const sourceText = $('#reviewOpenSource')?.querySelector('.rv-source-label');
      if (sourceText) sourceText.textContent = isPoint ? '看详细' : '看出处';
      $('#reviewDialog .review-card-stage').scrollTop = 0;
      const sourceButton = $('#reviewOpenSource');
      sourceButton.classList.toggle('hidden', !sourceDocument);
      sourceButton.dataset.documentId = sourceDocument?.id || '';
      // 编辑入口：知识点去原笔记改要点；普通卡片在复习上面直接编辑（保存后刷新这张卡）。
      const editButton = $('#reviewEditCard');
      if (editButton) {
        const canEdit = isPoint ? Boolean(sourceDocument && openPointNote && !runtime.practice) : Boolean(editCard);
        editButton.classList.toggle('hidden', !canEdit);
        editButton.querySelector('.rv-edit-label').textContent = isPoint ? '去笔记编辑' : '编辑卡片';
        editButton.title = isPoint ? '离开复习，打开原笔记编辑这条要点（进度已保存）' : '编辑这张卡片，保存后继续复习';
      }
      const drawerEdit = $('#reviewSourceEdit');
      if (drawerEdit) drawerEdit.hidden = !sourceDocument || Boolean(runtime.practice);
      $('#reviewPreviousCard').disabled = operations().findReviewIndex(-1) === null;
      $('#reviewNextCard').disabled = operations().findReviewIndex(1) === null;
      $('#reviewSourceDrawer').classList.add('hidden');
      $('#reviewDialogLayout').classList.remove('source-open');
      $('#answerArea').classList.add('hidden'); $('#ratings').classList.add('hidden'); $('#revealBtn').classList.remove('hidden');
      updateReviewMemoryPanel(false);
      updateReviewIntervals(card);
      refreshUndo();
      runtime.reviewVoice?.onCard(card, { practice: Boolean(runtime.practice) });
    }

    function openReviewSourceDrawer() {
      const sourceDocument = documentById($('#reviewOpenSource').dataset.documentId);
      if (!sourceDocument) return;
      runtime.reviewMemoryPanel?.close();
      const richContent = sourceDocument.metadata?.editorMode === 'note' && sourceDocument.metadata?.noteContentInitialized
        ? sanitizeRichNoteContent(sourceDocument.metadata.noteContent || '')
        : renderMarkdown(sourceDocument.content || '');
      $('#reviewSourceTitle').textContent = sourceDocument.title || '未命名笔记';
      $('#reviewSourceContent').innerHTML = richContent || '<p class="muted">暂无正文</p>';
      // 知识点只显示笔记里的这一节（标题到下一个同级标题），要点块按要点样式显示。
      if (runtime.reviewCurrentPoint) focusPointSection($('#reviewSourceContent'), runtime.reviewCurrentPoint);
      $('#reviewSourceDrawer').classList.remove('hidden');
      $('#reviewDialogLayout').classList.add('source-open');
    }

    function focusPointSection(container, heading) {
      const blocks = [...container.children];
      const level = node => /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0;
      const start = blocks.findIndex(node => level(node) && node.textContent.trim() === heading);
      if (start < 0) return;
      let end = start + 1;
      while (end < blocks.length && (!level(blocks[end]) || level(blocks[end]) > level(blocks[start]))) end++;
      blocks.forEach((node, index) => { if (index < start || index >= end) node.remove(); });
      const marker = /^\s*\[!(要点|summary)\]\s*$/i;
      let inGist = false;
      for (const node of [...container.children]) {
        if (node.tagName === 'BLOCKQUOTE' && marker.test(node.textContent)) { inGist = true; node.classList.add('rv-gist-head'); node.textContent = '要点'; continue; }
        if (inGist && node.tagName === 'BLOCKQUOTE') { node.classList.add('rv-gist-line'); continue; }
        inGist = false;
      }
    }

    function closeReviewSourceDrawer() {
      $('#reviewSourceDrawer').classList.add('hidden');
      $('#reviewDialogLayout').classList.remove('source-open');
    }

    function updateReviewIntervals(card) {
      if (runtime.practice) { for (const button of $('#ratings').querySelectorAll('[data-rating]')) { const slot = button.querySelector('[data-interval]') || button.querySelector('small'); if (slot) slot.textContent = '练习'; } return; }
      const at = now();
      scheduler.configure?.(state.read().settings?.reviewSchedule);
      const preview = scheduler.preview(card, state.read().reviewRecords, at);
      for (const button of $('#ratings').querySelectorAll('[data-rating]')) {
        const label = scheduler.intervalLabel(preview[button.dataset.rating].dueAt, at);
        const slot = button.querySelector('[data-interval]');
        if (slot) slot.textContent = label; else button.querySelector('small').textContent = label;
      }
    }

    function continueReview() {
      if (runtime.reviewActionPending || !runtime.reviewAwaitingContinue) return;
      runtime.reviewAwaitingContinue = false;
      runtime.reviewMemoryPanel?.close();
      $('#reviewContinue').classList.add('hidden');
      if (!operations().advanceAfterReview(runtime.reviewQueue[runtime.reviewIndex].id)) finishReviewSession();
    }

    async function rateCard(rating) {
      if (runtime.reviewActionPending || runtime.reviewAwaitingContinue || $('#answerArea').classList.contains('hidden')) return;
      if (!Object.hasOwn(scheduler.ratings, rating)) return;
      const card = state.read().cards.find(card => card.id === runtime.reviewQueue[runtime.reviewIndex]?.id);
      if (!card || card.status !== 'active') return;
      if (runtime.practice) { await ratePractice(card, rating); return; }
      runtime.reviewActionPending = true;
      setSaveStatus();
      const buttons = [...$('#ratings').querySelectorAll('button')];
      buttons.forEach(button => { button.disabled = true; });
      try {
        await transactions.rate({ cardId: card.id, rating, shownAt: runtime.reviewCardShownAt,
          results: runtime.reviewSessionResults, checkpoint: operations().checkpointReview, points: runtime.reviewVoice?.pointResults?.() || null });
      } catch (error) {
        const message = `评分未保存，请重试。${error.message ? `（${error.message}）` : ''}`;
        if (!setSaveStatus(message)) showToast(message, true);
        return;
      } finally {
        runtime.reviewActionPending = false;
        buttons.forEach(button => { button.disabled = false; });
      }
      runtime.reviewedCardIds.add(card.id);
      updateProgress();
      runtime.reviewAwaitingContinue = true;
      if (state.settings?.current?.fastReview === true) { continueReview(); return; }
      $('#ratings').classList.add('hidden');
      $('#reviewPreviousCard').disabled = true;
      $('#reviewNextCard').disabled = true;
      const next = $('#reviewContinue');
      next.textContent = operations().findReviewIndex(1) !== null || operations().findReviewIndex(-1) !== null ? '下一张 →' : '完成本轮';
      next.classList.remove('hidden');
      $('#reviewDialog').classList.add('is-rated');
      $('#reviewLater').hidden = true;
      refreshUndo();
      updateReviewMemoryPanel(true);
      runtime.reviewMemoryPanel.open();
      next.focus({ preventScroll: true });
    }

    // ---------- 复习时编辑：去原笔记 / 编辑卡片 ----------
    const currentCard = () => state.read().cards.find(card => card.id === runtime.reviewQueue[runtime.reviewIndex]?.id) || null;
    function editCurrentCard() {
      const card = currentCard();
      if (!card) return;
      if (card.cardType === 'point') { void leaveToNote(card); return; }
      if (!editCard) return;
      const revealed = !$('#answerArea').classList.contains('hidden');
      // 卡片编辑器盖在复习上面；关掉后刷新这张卡（保存了就显示新内容），原来翻开的照样翻开。
      $('#cardDialog')?.addEventListener('close', () => {
        if (!$('#reviewDialog').open || currentCard()?.id !== card.id) return;
        showReviewCard();
        if (revealed) $('#revealBtn').click();
      }, { once: true });
      editCard(card);
    }
    // 离开复习去原笔记：进度已保存；笔记页右下角出现「继续复习」，点一下回到这张卡。
    async function leaveToNote(card = currentCard()) {
      if (!card || runtime.practice) return;
      const item = state.knowledge.itemById(card.knowledgeItemId);
      const documentId = card.cardType === 'point' ? card.pointDocumentId : card.sourceAnchor?.documentId || item?.documentId;
      if (!documentId || !documentById(documentId)) { showToast('找不到原笔记'); return; }
      runtime.reviewResume = { cardId: card.id };
      closeReviewSourceDrawer();
      runtime.reviewVoice?.reset();
      $('#reviewDialog').close();
      showResumePill();
      if (card.cardType === 'point' && openPointNote) await openPointNote(card);
      else if (card.sourceAnchor && locateCardSource && await locateCardSource(card)) { /* 已定位到原文 */ }
      else await openNote?.(documentId);
    }
    function showResumePill() {
      let pill = document.getElementById('reviewResumePill');
      if (!pill) {
        pill = document.createElement('div'); pill.id = 'reviewResumePill'; pill.className = 'rv-resume'; pill.setAttribute('role', 'status');
        pill.innerHTML = '<span class="rv-resume-text">复习进度已保存</span><button type="button" class="rv-resume-go" data-resume></button><button type="button" class="rv-resume-close" data-resume-close aria-label="不继续复习" title="不继续复习">×</button>';
        document.body.append(pill);
        pill.addEventListener('click', async event => {
          if (event.target.closest('[data-resume-close]')) { pill.hidden = true; runtime.reviewResume = null; return; }
          if (!event.target.closest('[data-resume]')) return;
          const target = runtime.reviewResume?.cardId;
          pill.hidden = true; runtime.reviewResume = null;
          // 笔记里改了要点：先同步成知识点，再回到刚才那张卡。
          await Promise.resolve(syncPoints?.()).catch(() => false);
          await operations().resumeReviewRound(target);
        });
      }
      const left = runtime.reviewQueue.filter(card => !runtime.reviewedCardIds.has(card.id)).length;
      pill.querySelector('[data-resume]').textContent = left ? `继续复习 · 还剩 ${left} 张` : '继续复习';
      pill.hidden = false;
    }

    // ---------- 再练一轮（design/prototype/memory-boost-20261112.md） ----------
    // 借用复习界面，但不改 FSRS 排期：只记录每条要点想起 / 没想起。结束后回到原来那一轮的完成页。
    const PRACTICE_STASH = ['reviewSessionKey', 'reviewQueue', 'reviewSessionResults', 'reviewScopeIds', 'reviewedCardIds', 'reviewIndex', 'reviewSessionPaused', 'reviewSessionStartedAt'];
    function startPractice(ids, { fromOutcome = false } = {}) {
      const wanted = [...new Set(ids || [])];
      const cards = wanted.map(id => state.read().cards.find(card => card.id === id)).filter(card => card && card.status === 'active');
      if (!cards.length) { showToast('没有可以再练的卡片'); return false; }
      if ($('#reviewDialog').open || runtime.practice) return false;
      const stash = fromOutcome ? Object.fromEntries(PRACTICE_STASH.map(key => [key, runtime[key] instanceof Set ? new Set(runtime[key]) : structuredClone(runtime[key] ?? null)])) : null;
      // 再练中途关掉复习窗口：结束再练，回到原来那一轮的完成页。
      if (!runtime.practiceCloseBound) { runtime.practiceCloseBound = true; $('#reviewDialog').addEventListener('close', () => { if (runtime.practice) finishPractice(); }); }
      runtime.practice = { stash, results: [] };
      runtime.reviewQueue = cards; runtime.reviewIndex = 0; runtime.reviewedCardIds = new Set(); runtime.reviewSessionResults = [];
      runtime.reviewSessionPaused = false; runtime.reviewSessionStartedAt = now(); runtime.reviewAwaitingContinue = false;
      $('#reviewDialog').showModal();
      showReviewCard();
      return true;
    }
    async function ratePractice(card, rating) {
      const points = runtime.reviewVoice?.pointResults?.() || null;
      const decided = (points || []).filter(point => point.got === true || point.got === false);
      runtime.reviewActionPending = true;
      try {
        if (decided.length && typeof application !== 'undefined') await application.persistence.transact(data => { const target = data.cards.find(item => item.id === card.id); if (target) root.MemoKeepPointRecall?.record(target, points, now()); });
      } catch { setSaveStatus('练习记录未保存，不影响复习排期。'); }
      finally { runtime.reviewActionPending = false; }
      runtime.practice.results.push({ cardId: card.id, rating, got: decided.filter(point => point.got).length, total: decided.length });
      runtime.reviewedCardIds.add(card.id);
      updateProgress();
      if (!operations().advanceAfterReview(card.id)) finishPractice();
    }
    function finishPractice() {
      const practice = runtime.practice;
      if (!practice) return;
      runtime.practice = null;
      runtime.reviewVoice?.reset();
      runtime.reviewMemoryPanel?.close();
      $('#reviewDialog').classList.remove('is-practice');
      $('#answerArea').classList.add('hidden'); $('#ratings').classList.add('hidden');
      if ($('#reviewDialog').open) $('#reviewDialog').close();
      const got = practice.results.reduce((sum, item) => sum + item.got, 0), total = practice.results.reduce((sum, item) => sum + item.total, 0);
      const remembered = practice.results.filter(item => item.rating === 'good' || item.rating === 'easy').length;
      if (practice.results.length) showToast(`再练完成：${practice.results.length} 张${total ? ` · 要点想起 ${got} / ${total} 条` : ` · 记住 ${remembered} 张`}`);
      if (practice.stash) { Object.assign(runtime, practice.stash); finishReviewSession('summary'); }
      else renderAll();
    }
    // 10 分钟后提醒：系统通知 + 应用里的提示，点通知直接开始再练。
    function remindPractice(ids) {
      const list = [...new Set(ids || [])];
      if (!list.length) return;
      runtime.practiceReminder && clearTimeout(runtime.practiceReminder);
      runtime.practiceReminder = setTimeout(() => {
        runtime.practiceReminder = null;
        const begin = () => { root.focus?.(); if (!$('#reviewDialog').open) startPractice(list); };
        try { const note = new root.Notification('MemoKeep · 再练一轮', { body: `有 ${list.length} 张今天还没记牢，点这里再回想一次。` }); note.onclick = begin; } catch {}
        showToast(`有 ${list.length} 张今天还没记牢，可以再练一轮了`);
      }, 10 * 60_000);
      showToast('好的，10 分钟后提醒你再练');
    }

    async function deferReviewCard() {
      if (runtime.reviewActionPending || runtime.reviewAwaitingContinue) return;
      runtime.reviewActionPending = true;
      setSaveStatus();
      const card = state.read().cards.find(card => card.id === runtime.reviewQueue[runtime.reviewIndex]?.id);
      if (!card) { runtime.reviewActionPending = false; return; }
      try {
        await transactions.defer({ cardId: card.id, results: runtime.reviewSessionResults, checkpoint: operations().checkpointReview,
          afterSave: () => { if (!operations().advanceAfterReview(card.id)) finishReviewSession(); } });
      } catch { setSaveStatus('稍后安排未保存，请重试。'); }
      finally { runtime.reviewActionPending = false; }
    }
    return { editCurrentCard, leaveToNote, startPractice, finishPractice, remindPractice, finishReviewSession, updateReviewMemoryPanel, showReviewCard, openReviewSourceDrawer, closeReviewSourceDrawer, updateReviewIntervals, continueReview, rateCard, deferReviewCard, isOpen: () => $("#reviewDialog").open, open: () => { const pill = document.getElementById('reviewResumePill'); if (pill) pill.hidden = true; if (!$("#reviewDialog").open) $("#reviewDialog").showModal(); }, refreshUndo,
      stopOutcome: () => runtime.reviewOutcomeController?.stop(),
      closeOutcome: () => { if ($("#reviewResultDialog").open) $("#reviewResultDialog").close(); } };
  }
  const api = { createReviewView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
