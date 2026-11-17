(function expose(root) {
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
  function studyPreferences(settings = {}) {
    return { minutes: bounded(settings.studyMinutes, 5, 1, 120), newLimit: bounded(settings.newCardsPerDay, 3, 0, 100) };
  }
  function buildLearningPlan(data, at = Date.now()) {
    const preferences = studyPreferences(data.settings);
    const day = new Date(at).toLocaleDateString('en-CA');
    const introduced = new Set();
    for (const session of Object.values(data.reviewSessions || {})) {
      if (session.day !== day) continue;
      for (const result of session.results || []) if (result.rating !== 'later' && result.before?.reviewCount === 0) introduced.add(result.cardId);
    }
    const active = (data.cards || []).filter(card => card.status === 'active');
    const due = active.filter(card => Number(card.dueAt) <= at).sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    const capacity = Math.max(1, Math.floor(preferences.minutes * 60 / 25));
    const reviews = due.filter(card => Number(card.reviewCount || 0) > 0);
    const fresh = due.filter(card => !Number(card.reviewCount || 0));
    const selected = reviews.slice(0, capacity);
    const newAllowance = Math.max(0, preferences.newLimit - introduced.size);
    selected.push(...fresh.slice(0, Math.min(newAllowance, Math.max(0, capacity - selected.length))));
    // Keep this day's assigned cards in scope so same-day relearning remains resumable.
    const prior = data.reviewSessions?.['daily-plan'];
    const valid = new Map(active.map(card => [card.id, card]));
    const previousIds = prior?.day === day ? (prior.scopeIds || []).filter(id => valid.has(id) && Number(valid.get(id).reviewCount || 0) > 0) : [];
    const scopeIds = [...new Set([...previousIds, ...selected.map(card => card.id)])];
    const assigned = active.filter(card => scopeIds.includes(card.id));
    const ready = assigned.filter(card => Number(card.dueAt) <= at);
    return { ...preferences, ids: scopeIds, ready: ready.map(card => card.id),
      totalDue: due.length, dueCount: ready.filter(card => Number(card.reviewCount || 0) > 0).length,
      newCount: ready.filter(card => !Number(card.reviewCount || 0)).length, introduced: introduced.size,
      overflow: Math.max(0, due.length - ready.length), estimatedMinutes: Math.ceil(ready.length * 25 / 60) };
  }
  const api = { studyPreferences, buildLearningPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
