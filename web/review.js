const api = window.memoKeepDesktop;
const DAY = 86_400_000;
const DEFER_DELAY = 60 * 60_000;

let data = null;
let reviewQueue = [];
let reviewIndex = 0;
let cardShownAt = 0;
let isSaving = false;
let sourceDrawerOpen = false;
let reviewedCardIds = new Set();
let reviewSessionStartedAt = 0;
let reviewSessionResults = [];
let reviewMemoryPanel;
let reviewScopeIds = [];
let reviewSessionPaused = false;
let reviewOutcomeController;
function reviewElapsed() { return reviewSessionPaused ? (data.reviewSessions?.quick?.elapsedMs || 0) : Math.max(0, Date.now() - reviewSessionStartedAt); }
let reviewAwaitingContinue = false;

function updateMemoryPanel(rated = reviewAwaitingContinue) {
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  if (!card) return;
  reviewMemoryPanel ||= ReviewPresentation.mount({
    host: document.querySelector('.review-shell'), footer: document.querySelector('.review-footer'),
    sourceButton: byId('openReviewSource'), closeSource: closeSourceDrawer,
    onExpand: open => api.setReviewSourceOpen?.(open)
  });
  reviewMemoryPanel.update(card, sourceDocument(card), data.reviewRecords || [], rated);
}

const byId = id => document.getElementById(id);
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function dayKey(timestamp = Date.now()) {
  const value = new Date(timestamp);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function sourceLabel(card) {
  const note = sourceDocument(card);
  if (note?.title) return note.title;
  const library = data.knowledgeBases.find(candidate => candidate.id === card.knowledgeBaseId);
  return library?.name || card.tags?.[0] || '个人知识库';
}

function sourceDocument(card) {
  const item = data.items.find(candidate => candidate.id === card.knowledgeItemId);
  return item && [...data.documents, ...(data.cardDocuments || [])].find(candidate => candidate.id === item.documentId);
}

function sanitizeSourceNote(html = '') {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  const allowed = new Set(['P','BR','STRONG','EM','U','S','OL','UL','LI','BLOCKQUOTE','A','H1','H2','H3','H4','H5','H6','PRE','CODE','SPAN','DIV','TABLE','TBODY','TR','TD']);
  [...template.content.querySelectorAll('*')].forEach(element => {
    if (!allowed.has(element.tagName)) { element.replaceWith(...element.childNodes); return; }
    [...element.attributes].forEach(attribute => element.removeAttribute(attribute.name));
  });
  return template.innerHTML;
}

function closeSourceDrawer() {
  if (!sourceDrawerOpen) return;
  sourceDrawerOpen = false;
  byId('reviewSourceDrawer').classList.add('hidden');
  byId('reviewCard').classList.remove('source-open');
  api.setReviewSourceOpen?.(false);
}

function openSourceDrawer() {
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  const note = card && sourceDocument(card);
  if (!note) return;
  reviewMemoryPanel?.close({ resize: false });
  byId('reviewSourceTitle').textContent = note.title || '未命名笔记';
  const content = byId('reviewSourceContent');
  const richContent = note.metadata?.editorMode === 'note' && note.metadata?.noteContentInitialized;
  if (richContent) content.innerHTML = sanitizeSourceNote(note.metadata.noteContent || '');
  else content.textContent = note.content || '暂无正文';
  sourceDrawerOpen = true;
  byId('reviewSourceDrawer').classList.remove('hidden');
  byId('reviewCard').classList.add('source-open');
  api.setReviewSourceOpen?.(true);
}

function updateStreak(timestamp) {
  data.streak ||= { count: 0, lastDay: '' };
  const currentDay = dayKey(timestamp);
  if (data.streak.lastDay === currentDay) return;
  const yesterday = dayKey(timestamp - DAY);
  data.streak.count = data.streak.lastDay === yesterday ? Number(data.streak.count || 0) + 1 : 1;
  data.streak.lastDay = currentDay;
}

function outcomeState() {
  const at = Date.now();
  return { at, summary: ReviewSession.summary(data, reviewSessionResults, reviewScopeIds, reviewElapsed(), at),
    canUndo: Boolean(ReviewSession.undoCandidate(data, 'quick')), settings: data.settings, streak: globalThis.MemoKeepDomain?.learningStreak ? MemoKeepDomain.learningStreak(data, at) : Number(data.streak?.count) || 0 };
}
function showEmptyState(_completedCount = 0, mode) {
  updateProgress();
  reviewSessionPaused = true;
  reviewAwaitingContinue = false;
  byId('reviewContinue').classList.add('hidden');
  reviewMemoryPanel?.close(); closeSourceDrawer();
  byId('answerArea').classList.add('hidden'); byId('ratingActions').classList.add('hidden'); byId('revealAnswer').classList.add('hidden');
  byId('reviewCard').classList.add('hidden'); byId('reviewEmpty').classList.remove('hidden');
  byId('reviewProgress').textContent = '进度已保存';
  reviewOutcomeController ||= ReviewOutcome.mount({ host: byId('reviewEmpty'), getState: outcomeState,
    isVisible: () => !byId('reviewEmpty').classList.contains('hidden'), onResume: () => resumeReviewRound(), onUndo: undoLastReview,
    onReturn: async () => { await api.openApp?.('cards'); reviewOutcomeController.stop(); await api.closeReview(); },
    onClose: async () => { reviewOutcomeController.stop(); await api.closeReview(); }
  });
  reviewOutcomeController.show(mode || (outcomeState().summary.pending.length ? 'waiting' : 'summary'));
}
async function resumeReviewRound(preferredId) {
  if (isSaving) return;
  await initializeReview(preferredId);
}
async function undoLastReview() {
  if (isSaving) return;
  isSaving = true;
  let target;
  try {
    data = await api.read();
    const before = structuredClone(data);
    try { target = ReviewSession.undo(data, 'quick'); data = await api.write(data); }
    catch (error) { data = before; throw error; }
  } finally { isSaving = false; }
  await initializeReview(target);
}

function updateProgress() {
  const total = reviewQueue.length;
  const completed = reviewQueue.filter(id => reviewedCardIds.has(id)).length;
  byId('reviewProgress').textContent = `第 ${Math.min(reviewIndex + 1, total)} / ${total} 张 · 已保存 ${completed}`;
  const bar = byId('reviewProgressBar');
  bar.style.width = `${total ? completed / total * 100 : 0}%`;
  const track = bar.parentElement;
  if (track) {
    track.removeAttribute('aria-hidden');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', '本轮已保存进度');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.max(1, total)));
    track.setAttribute('aria-valuenow', String(completed));
    track.setAttribute('aria-valuetext', `已保存 ${completed} / ${total} 张`);
  }
}

function renderCard() {
  reviewOutcomeController?.stop();
  reviewAwaitingContinue = false;
  byId('reviewContinue').classList.add('hidden');
  document.querySelector('.review-label').textContent = '试着回忆';
  document.querySelector('#revealAnswer kbd').textContent = MemoKeepShortcuts.label('reveal');
  document.querySelector('.review-footer > span').textContent = `${MemoKeepShortcuts.label('reveal')} 显示答案 · ${[1,2,3,4].map(n=>MemoKeepShortcuts.label('rate-'+n)).join(' / ')} 评分 · ${MemoKeepShortcuts.label('review-later')} 稍后`;
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  if (!card) {
    showEmptyState(reviewQueue.length);
    return;
  }

  cardShownAt = Date.now();
  closeSourceDrawer();
  byId('reviewEmpty').classList.add('hidden');
  byId('reviewCard').classList.remove('hidden');
  updateProgress();
  ReviewPresentation.renderContent(byId('reviewQuestion'), card.question, card);
  ReviewPresentation.renderAnswer(byId('reviewAnswer'), card.answer, card);
  document.querySelector('.review-reading-area').scrollTop = 0;
  byId('reviewAnswerPreview').textContent = '?';
  byId('reviewSource').textContent = `来源：${sourceLabel(card)}`;
  const note = sourceDocument(card);
  byId('openReviewSource').classList.toggle('hidden', !note);
  byId('previousReviewCard').disabled = findReviewIndex(-1) === null;
  byId('nextReviewCard').disabled = findReviewIndex(1) === null;
  byId('answerArea').classList.add('hidden');
  byId('ratingActions').classList.add('hidden');
  byId('revealAnswer').classList.remove('hidden');
  updateMemoryPanel(false);
  updateReviewIntervals(card);
}

function findReviewIndex(direction) {
  for (let index = reviewIndex + direction; index >= 0 && index < reviewQueue.length; index += direction) {
    if (!reviewedCardIds.has(reviewQueue[index])) return index;
  }
  return null;
}

function checkpointReview() {
  ReviewSession.checkpoint(data, 'quick', reviewQueue, reviewSessionResults, reviewQueue[reviewIndex], reviewElapsed(), reviewScopeIds);
  window.MemoKeepDomain?.awardCompletedRound?.(data, Date.now());
}

async function navigateReview(direction) {
  if (isSaving) return;
  if (reviewAwaitingContinue) { if (direction > 0) continueReview(); return; }
  const nextIndex = findReviewIndex(direction);
  if (nextIndex === null) return;
  const previousIndex = reviewIndex;
  isSaving = true;
  reviewIndex = nextIndex;
  checkpointReview();
  try { data = await api.write(data); renderCard(); }
  catch { reviewIndex = previousIndex; checkpointReview(); byId('reviewSource').textContent = '进度保存失败，请重试'; }
  finally { isSaving = false; }
}

function advanceAfterReview(cardId) {
  reviewedCardIds.add(cardId);
  const nextIndex = findReviewIndex(1);
  if (nextIndex !== null) { reviewIndex = nextIndex; renderCard(); return true; }
  const previousIndex = findReviewIndex(-1);
  if (previousIndex !== null) { reviewIndex = previousIndex; renderCard(); return true; }
  return false;
}

function revealAnswer() {
  if (reviewAwaitingContinue || isSaving) return;
  byId('answerArea').classList.remove('hidden');
  byId('ratingActions').classList.remove('hidden');
  byId('revealAnswer').classList.add('hidden');
  updateMemoryPanel(false);
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  if (card) updateReviewIntervals(card);
}

function updateReviewIntervals(card) {
  const at = Date.now();
  MemoScheduler.configure(data.settings?.reviewSchedule);
  const preview = MemoScheduler.preview(card, data.reviewRecords, at);
  for (const button of byId('ratingActions').querySelectorAll('[data-rating]')) {
    button.querySelector('small').textContent = MemoScheduler.intervalLabel(preview[button.dataset.rating].dueAt, at);
  }
}
function continueReview() {
  if (isSaving || !reviewAwaitingContinue) return;
  reviewAwaitingContinue = false;
  reviewMemoryPanel?.close();
  byId('reviewContinue').classList.add('hidden');
  if (!advanceAfterReview(reviewQueue[reviewIndex])) showEmptyState(reviewedCardIds.size);
}
async function rateCard(rating) {
  if (isSaving || reviewAwaitingContinue || byId('answerArea').classList.contains('hidden')) return;
  if (!Object.hasOwn(MemoScheduler.ratings, rating)) return;
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  if (!card || card.status !== 'active') return;
  isSaving = true;
  const before = structuredClone(data);
  const ratingButtons = [...document.querySelectorAll('.rating-actions button')];
  ratingButtons.forEach(button => { button.disabled = true; });
  let recorded = false;
  try {
    const reviewedAt = Date.now();
    MemoScheduler.configure(data.settings?.reviewSchedule);
    const result = MemoScheduler.review(card, data.reviewRecords, rating, reviewedAt);
    Object.assign(card, result.card);
    const record = { id: uid(), ...result.log, responseTimeMs: Math.max(0, reviewedAt - cardShownAt) };
    data.reviewRecords.push(record);
    updateStreak(reviewedAt);
    reviewSessionResults.push({ cardId: card.id, rating, recordId: record.id, reviewedAt, before: ReviewSession.snapshot(before.cards.find(item => item.id === card.id)), after: ReviewSession.snapshot(card), streakBefore: before.streak });
    recorded = true;
    checkpointReview();
    data = await api.write(data);
  } catch (error) {
    data = before;
    if (recorded) reviewSessionResults.pop();
    byId('reviewSource').textContent = `评分未保存，请重试：${error.message}`;
    return;
  } finally {
    isSaving = false;
    ratingButtons.forEach(button => { button.disabled = false; });
  }
  reviewedCardIds.add(card.id);
  byId('reviewSource').textContent = `来源：${sourceLabel(card)}`;
  updateProgress();
  reviewAwaitingContinue = true;
  if (data.settings?.fastReview === true) { continueReview(); return; }
  byId('ratingActions').classList.add('hidden');
  byId('previousReviewCard').disabled = true;
  byId('nextReviewCard').disabled = true;
  const next = byId('reviewContinue');
  next.textContent = findReviewIndex(1) !== null || findReviewIndex(-1) !== null ? '下一张 →' : '完成本轮';
  next.classList.remove('hidden');
  document.querySelector('.review-label').textContent = '评分已保存';
  document.querySelector('.review-footer > span').textContent = `Space / Enter · ${next.textContent}`;
  updateMemoryPanel(true);
  reviewMemoryPanel.open();
  next.focus({ preventScroll: true });
}

async function deferCard() {
  if (isSaving || reviewAwaitingContinue || byId('answerArea').classList.contains('hidden')) return;
  const card = data.cards.find(candidate => candidate.id === reviewQueue[reviewIndex]);
  if (!card) return;

  isSaving = true;
  const before = structuredClone(data);
  const ratingButtons = [...document.querySelectorAll('.rating-actions button')];
  ratingButtons.forEach(button => { button.disabled = true; });
  const deferredAt = Date.now();
  card.dueAt = deferredAt + DEFER_DELAY;
  card.updatedAt = new Date(deferredAt).toISOString();

  try {
    reviewSessionResults.push({ cardId: card.id, rating: 'later' });
    checkpointReview();
    data = await api.write(data);
    if (!advanceAfterReview(card.id)) showEmptyState(reviewedCardIds.size);
  } catch {
    data = before;
    reviewSessionResults.pop();
    byId('reviewSource').textContent = '稍后复习设置失败，请重试';
  } finally {
    isSaving = false;
    ratingButtons.forEach(button => { button.disabled = false; });
  }
}

async function initializeReview(preferredId) {
  if (isSaving) return;
  isSaving = true;
  try {
  data = await api.read();
  data.knowledgeBases ||= [];
  data.documents ||= [];
  data.items ||= [];
  data.cards ||= [];
  data.reviewRecords ||= [];
  const candidates = data.cards
    .filter(card => card.status === 'active' && Number(card.dueAt) <= Date.now())
    .sort((first, second) => Number(first.dueAt) - Number(second.dueAt));
  reviewScopeIds = data.cards.map(card => card.id);
  const session = ReviewSession.open(data, 'quick', candidates, reviewScopeIds);
  reviewQueue = session.queue;
  reviewIndex = reviewQueue.indexOf(candidates.some(card => card.id === preferredId) ? preferredId : session.currentId);
  reviewedCardIds = new Set(session.done);
  reviewSessionPaused = false;
  reviewSessionStartedAt = Date.now() - session.elapsedMs;
  reviewSessionResults = session.results;
  checkpointReview();
  data = await api.write(data);
  if (reviewIndex >= 0) {
    renderCard();
    if (session.resumed) byId('reviewSource').textContent += ' · 已继续';
  }
  else showEmptyState();
  } catch (error) { byId('reviewSource').textContent = '进度保存失败，请重新打开'; throw error; }
  finally { isSaving = false; }
}

byId('closeReview').onclick = () => { reviewOutcomeController?.stop(); api.closeReview(); };
byId('revealAnswer').onclick = revealAnswer;
byId('reviewContinue').onclick = continueReview;
byId('openReviewSource').onclick = openSourceDrawer;
byId('closeReviewSource').onclick = closeSourceDrawer;
byId('previousReviewCard').onclick = () => navigateReview(-1);
byId('nextReviewCard').onclick = () => navigateReview(1);
byId('ratingActions').onclick = event => {
  const deferButton = event.target.closest('[data-defer]');
  if (deferButton) {
    deferCard();
    return;
  }
  const button = event.target.closest('[data-rating]');
  if (button) rateCard(button.dataset.rating);
};
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.target.closest?.('input,textarea,select,[contenteditable=true]')) return;
  if (!byId('reviewEmpty').classList.contains('hidden')) { if (event.key === 'Escape') { reviewOutcomeController?.stop(); api.closeReview(); } return; }
  if (event.key === 'Escape') {
    if (reviewMemoryPanel?.isOpen) reviewMemoryPanel.close({ focus: true });
    else if (sourceDrawerOpen) closeSourceDrawer();
    else api.closeReview();
    return;
  }
  if (reviewAwaitingContinue && ([' ', 'Enter'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey || MemoKeepShortcuts.matches(event, 'review-next'))) {
    if (!MemoKeepShortcuts.matches(event, 'review-next') && event.target.closest?.('button, a, input, textarea, select') && event.target.id !== 'reviewContinue') return;
    event.preventDefault(); continueReview(); return;
  }
  if (MemoKeepShortcuts.matches(event, 'review-prev')) { event.preventDefault(); navigateReview(-1); return; }
  if (MemoKeepShortcuts.matches(event, 'review-next')) { event.preventDefault(); navigateReview(1); return; }
  if (MemoKeepShortcuts.matches(event, 'reveal') && !byId('revealAnswer').classList.contains('hidden')) {
    event.preventDefault();
    revealAnswer();
    return;
  }
  if (byId('ratingActions').classList.contains('hidden')) return;
  const rating = ['again','hard','good','easy'].find((_,index) => MemoKeepShortcuts.matches(event, `rate-${index+1}`));
  if (rating) { event.preventDefault(); rateCard(rating); }
  else if (MemoKeepShortcuts.matches(event, 'review-later')) { event.preventDefault(); deferCard(); }
});
api.onReviewReload(() => initializeReview().catch(() => {}));
initializeReview().catch(() => {});
