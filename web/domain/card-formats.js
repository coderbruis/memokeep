(function expose(root) {
  const clozePattern = /\{\{c(\d+)::([^{}]+?)\}\}/g;
  const imageReference = /^(?:memokeep-image:\/\/[0-9a-f-]{36}|data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+)$/i;
  function clozeParts(value) {
    const text = String(value || ''), parts = []; let from = 0;
    for (const match of text.matchAll(clozePattern)) {
      if (match.index > from) parts.push({ text: text.slice(from, match.index) });
      const split = match[2].split('::');
      parts.push({ answer: split.shift(), hint: split.join('::'), index: Number(match[1]) });
      from = match.index + match[0].length;
    }
    if (from < text.length) parts.push({ text: text.slice(from) });
    return parts;
  }
  const clamp = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function normalizeOcclusion(value) {
    if (!value || !imageReference.test(String(value.reference || ''))) return null;
    const x = clamp(value.x, .15, 0, .97), y = clamp(value.y, .2, 0, .97);
    return { reference: String(value.reference), x, y, w: clamp(value.w, .35, .03, 1 - x), h: clamp(value.h, .2, .03, 1 - y) };
  }
  function normalizeCardFormat(card = {}) {
    const occlusion = normalizeOcclusion(card.imageOcclusion);
    const cardType = card.cardType === 'cloze' ? 'cloze' : card.cardType === 'image-occlusion' && occlusion ? 'image-occlusion' : 'qa';
    return { cardType, ...(cardType === 'image-occlusion' ? { imageOcclusion: occlusion } : {}), ...(card.reverseOf ? { reverseOf: String(card.reverseOf) } : {}) };
  }
  function validateCardFormat(card) {
    if (card.cardType === 'cloze' && !clozeParts(card.question).some(part => part.answer?.trim())) return '填空正文需要至少一个 {{c1::答案}} 标记。';
    if (card.cardType === 'image-occlusion' && !normalizeOcclusion(card.imageOcclusion)) return '请先选择图片并框出需要遮挡的区域。';
    return '';
  }
  function clozeAnswer(value) { return clozeParts(value).filter(part => part.answer).map(part => part.answer).join('；'); }
  function formatLabel(card) { return card.cardType === 'cloze' ? '填空卡' : card.cardType === 'image-occlusion' ? '图片遮挡' : card.reverseOf ? '反向卡' : '问答卡'; }
  function sameCardPrompt(first, second) {
    if (String(first.question || '').trim() !== String(second.question || '').trim()) return false;
    if (first.cardType === 'image-occlusion' && second.cardType === 'image-occlusion') return JSON.stringify(normalizeOcclusion(first.imageOcclusion)) === JSON.stringify(normalizeOcclusion(second.imageOcclusion));
    return true;
  }
  function cardQualityIssues(card = {}) {
    const issues = [], question = String(card.question || '').replace(/!\[[^\]]*\]\([^)]+\)/g,'').trim();
    if (question.length > 120) issues.push('问题较长，试着保留一个明确的提问。');
    if ((question.match(/[?？]/g) || []).length > 1) issues.push('同一张卡包含多个问题，可以拆成几张独立复习。');
    if (String(card.answer || '').length > 600) issues.push('答案包含较多内容，可以拆成几个答对要点。');
    if (Number(card.lapseCount || 0) >= 3) issues.push('这张卡曾多次重学，可以检查问题是否足够具体。');
    return issues;
  }
  const api = { clozeParts, clozeAnswer, normalizeOcclusion, normalizeCardFormat, validateCardFormat, formatLabel, cardQualityIssues, sameCardPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepCardFormats = api;
})(globalThis);
