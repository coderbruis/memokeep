// 笔记里的制卡标记（design/prototype/note-card-marks-20261112.md）：卡片记下「来自笔记的哪一段」。
// sourceAnchor = { documentId, quote, prefix, suffix, heading, createdAt, inferred? }，不往笔记里插任何东西；
// 打开笔记时在正文里重新找：原文完全相同 → exact；找不到时用前后文或相似段落 → stale（原文改过）；都找不到 → missing。
(function expose(root) {
  const CONTEXT = 32;
  const squash = value => String(value || '').replace(/\s+/g, ' ').trim();

  // 编辑器正文（图片等嵌入算一个字符，和 Quill 的位置一一对应）。
  function textOf(delta) {
    return (delta?.ops || []).map(op => typeof op.insert === 'string' ? op.insert : '￼').join('');
  }

  // 位置之前最近的标题（headings: [{ index, text }]，按 index 升序）。
  function headingAt(headings, index) {
    let found = '';
    for (const heading of headings || []) { if (heading.index > index) break; found = heading.text; }
    return found;
  }

  function create(text, index, length, { documentId, heading = '', now = new Date().toISOString() } = {}) {
    let start = index, end = index + length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const quote = text.slice(start, end);
    if (!quote) return null;
    return { documentId, quote, prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), heading, createdAt: now };
  }

  // 两段文字从某一端开始有多少字相同（prefix 看结尾，suffix 看开头）。
  function sameEnd(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
  function sameStart(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

  function bigrams(value) {
    const text = squash(value).replace(/\s/g, ''), set = new Map();
    for (let i = 0; i < text.length - 1; i++) { const pair = text.slice(i, i + 2); set.set(pair, (set.get(pair) || 0) + 1); }
    return set;
  }
  // 相似度（字符二元组 Dice 系数，0–1）。
  function similarity(a, b) {
    const x = bigrams(a), y = bigrams(b);
    let common = 0, total = 0;
    for (const [pair, count] of x) { common += Math.min(count, y.get(pair) || 0); total += count; }
    for (const count of y.values()) total += count;
    return total ? 2 * common / total : 0;
  }

  // 正文按行（段落）切开：[{ start, end, text }]。
  function lines(text) {
    const list = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === '\n') { if (i > start) list.push({ start, end: i, text: text.slice(start, i) }); start = i + 1; }
    }
    return list;
  }

  // 在正文里找回这段：{ index, length, status }。
  function resolve(text, anchor) {
    if (!anchor?.quote) return { index: -1, length: 0, status: 'missing' };
    const { quote, prefix = '', suffix = '' } = anchor;
    const hits = [];
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) hits.push(at);
    if (hits.length) {
      // 出现多次时用前后文挑最像的那一处。
      const score = at => sameEnd(text.slice(Math.max(0, at - prefix.length), at), prefix) + sameStart(text.slice(at + quote.length, at + quote.length + suffix.length), suffix);
      const index = hits.reduce((best, at) => score(at) > score(best) ? at : best, hits[0]);
      return { index, length: quote.length, status: 'exact' };
    }
    // 原文改过：前后文都还在，中间就是改过的这段。
    const before = prefix.slice(-12), after = suffix.slice(0, 12);
    if (before.length >= 6 && after.length >= 6) {
      for (let at = text.indexOf(before); at >= 0; at = text.indexOf(before, at + 1)) {
        const from = at + before.length, to = text.indexOf(after, from);
        if (to > from && to - from <= Math.max(quote.length * 3, quote.length + 120)) {
          if (similarity(text.slice(from, to), quote) >= 0.35) return { index: from, length: to - from, status: 'stale' };
        }
      }
    }
    // 再不行：找最像的一段（相似度 ≥ 0.6）。
    let best = null, bestScore = 0;
    for (const line of lines(text)) {
      const value = similarity(line.text, quote);
      if (value > bestScore) { best = line; bestScore = value; }
    }
    if (best && bestScore >= 0.6) return { index: best.start, length: best.end - best.start, status: 'stale' };
    return { index: -1, length: 0, status: 'missing' };
  }

  // 以前做的卡片没有记位置：用卡片答案找完全相同或很像的段落。
  function infer(text, card, { documentId, headings = [] } = {}) {
    const answer = squash(card?.answer).replace(/\*\*/g, '');
    if ([...answer].length < 8) return null;
    const plain = text;
    const at = plain.indexOf(answer);
    if (at >= 0) return { ...create(plain, at, answer.length, { documentId, heading: headingAt(headings, at), now: card.createdAt || new Date().toISOString() }), inferred: true };
    // 答案是某一段的一部分（或者这一段的大部分）。
    let best = null, bestScore = 0;
    for (const line of lines(plain)) {
      const value = squash(line.text).includes(answer.slice(0, 40)) ? 0.9 : similarity(line.text, answer);
      if (value > bestScore) { best = line; bestScore = value; }
    }
    if (best && bestScore >= 0.8) return { ...create(plain, best.start, best.end - best.start, { documentId, heading: headingAt(headings, best.start), now: card.createdAt || new Date().toISOString() }), inferred: true };
    return null;
  }

  const overlaps = (a, b) => a && b && a.index >= 0 && b.index >= 0 && a.index < b.index + Math.max(1, b.length) && b.index < a.index + Math.max(1, a.length);

  const api = { CONTEXT, textOf, headingAt, create, resolve, infer, overlaps, similarity, lines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepCardAnchors = api;
})(globalThis);
