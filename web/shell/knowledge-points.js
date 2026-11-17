// 要点和复习的联动（design/prototype/gist-review-optin-20261109.md）。
// 要点默认只用来速览；用户在要点上点「加入复习」后，才变成知识点卡片，和其他卡片一起复习。
(function expose(root) {
  function createKnowledgePointFeatures({ state, config, actions, env }) {
    const points = () => root.MemoKeepKnowledgePoints;
    const data = () => state.persistence.data;
    const cardOf = key => (data()?.cards || []).find(card => card.cardType === 'point' && card.pointKey === key) || null;
    const changed = () => { env.window.dispatchEvent(new env.window.CustomEvent('memokeep-points-changed')); actions.renderToday?.(); };
    let pending = null;

    // 没有变化时不写数据；同时只跑一次。
    async function syncKnowledgePoints() {
      if (!points() || !data()?.documents || !data().cards) return false;
      if (pending) return pending;
      if (!points().planSync(data()).changed) return false;
      pending = env.application.persistence.transact(next => { points().applySync(next, { createCard: actions.createCard }); })
        .then(() => { env.window.dispatchEvent(new env.window.CustomEvent('memokeep-points-changed')); return true; }, () => false)
        .finally(() => { pending = null; });
      return pending;
    }

    // 笔记里正在编辑的内容先保存，知识点才能读到最新的要点。
    async function saveOpenNote(documentId) {
      const form = config.$('#inlineMarkdownNoteForm');
      if (form?.dataset.documentId !== documentId || !state.editor.activeNoteEditorHasChanges?.()) return;
      await state.editor.saveActiveNoteEditor?.();
    }

    function pointStatus(key) {
      const card = cardOf(key);
      const status = points()?.stateOf(card) || 'off';
      if (!card) return { status };
      const records = (data().reviewRecords || []).filter(record => record.cardId === card.id);
      const last = records.reduce((a, b) => !a || new Date(b.reviewedAt) >= new Date(a.reviewedAt) ? b : a, null);
      return { status, card, reviews: Number(card.reviewCount) || 0, lastRating: last?.rating || null,
        // 新加入、还没复习的显示「今天」，而不是卡片列表里的「待开始」。
        due: status === 'on' ? (Number(card.dueAt) <= config.now() ? '今天' : actions.cardDueLabel(card, actions.cardStage(card))) : '' };
    }

    async function addPointToReview(documentId, key) {
      await saveOpenNote(documentId);
      let card = null;
      await env.application.persistence.transact(next => { card = points().optIn(next, documentId, key, { createCard: actions.createCard }); });
      changed();
      return card;
    }
    async function undoAddPoint(key) { await env.application.persistence.transact(next => points().optOut(next, key)); changed(); }
    async function setPointPaused(key, paused) {
      await env.application.persistence.transact(next => {
        const card = next.cards.find(item => item.cardType === 'point' && item.pointKey === key);
        if (card) Object.assign(card, { status: paused ? 'paused' : 'active', updatedAt: new Date(config.now()).toISOString() });
        if (card && !paused) delete card.pointOrphan;
      });
      changed();
    }
    // 一篇笔记的要点全部加入 / 暂停。
    async function setDocumentPoints(documentId, add) {
      await saveOpenNote(documentId);
      let count = 0;
      await env.application.persistence.transact(next => {
        const document = next.documents.find(item => item.id === documentId);
        for (const point of document ? points().pointsOfDocument(document) : []) {
          const card = next.cards.find(item => item.cardType === 'point' && item.pointKey === point.key);
          if (add) { if (points().stateOf(card) !== 'on') { points().optIn(next, documentId, point.key, { createCard: actions.createCard }); count++; } }
          else if (points().stateOf(card) === 'on') { card.status = 'paused'; count++; }
        }
      });
      changed();
      return count;
    }

    // 现在复习：只复习这一个（没到期就提前），单独一轮，不打断今天的复习。
    async function reviewPointNow(key) {
      const card = cardOf(key);
      if (!card) return;
      if (Number(card.dueAt) > config.now()) await env.application.persistence.transact(next => { const target = next.cards.find(item => item.id === card.id); if (target) target.dueAt = config.now(); });
      await env.application.operations.review.startReview(false, [card.id], { key: `point:${card.id}` });
    }
    function openPointInCards(key) {
      const card = cardOf(key);
      const runtime = env.application.cards.runtime;
      runtime.cardScope = { type: 'all', id: '' }; runtime.activeCardFilter = 'all'; runtime.activeCardKind = 'point'; runtime.activeCardLibraryFilter = 'all'; runtime.selectedCardTags.clear();
      const search = config.$('#cardSearch'); if (search) search.value = card?.question || '';
      actions.showView('cards');
      env.application.views.cards.render();
    }
    // 卡片列表里的知识点：打开笔记并定位到它的标题。
    async function openPointNote(card) {
      if (!card?.pointDocumentId) return;
      await actions.openWorkspaceNote(card.pointDocumentId);
      for (let attempt = 0; attempt < 60; attempt++) {
        const heading = [...env.document.querySelectorAll('#noteRichEditor .ql-editor > :is(h1, h2, h3, h4, h5, h6)')].find(node => node.textContent.replace(/\s+/g, ' ').trim() === points().headingOf(card));
        if (heading) { heading.scrollIntoView({ block: 'center' }); heading.animate?.([{ backgroundColor: 'color-mix(in srgb, var(--blue) 14%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 1600 }); return; }
        await new Promise(resolve => env.setTimeout(resolve, 50));
      }
    }
    async function setAutoAddGists(enabled) {
      await env.application.persistence.transact(next => { next.settings.autoAddGists = Boolean(enabled); });
      await syncKnowledgePoints();
      changed();
    }
    return { syncKnowledgePoints, pointStatus, addPointToReview, undoAddPoint, setPointPaused, setDocumentPoints, reviewPointNow, openPointInCards, openPointNote, setAutoAddGists };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createKnowledgePointFeatures });
})(globalThis);
