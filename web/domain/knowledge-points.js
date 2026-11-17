// 知识点（design/prototype/review-unified-20261109.md）：笔记里「标题 + 紧跟的要点块」。
// 每个知识点同步成一张 cardType: 'point' 的卡片，和普通卡片共用复习队列、遗忘算法、记录和撤销。
// 要点只存在笔记里；卡片上的问题和答案（要点）随笔记更新。问题：要点第一行写了「题目：……」就用它，没写用标题
// （design/prototype/gist-question-20261113.md）。要点从笔记里删掉，复习卡片也一起删掉（复习记录保留在统计里）。
(function expose(root) {
  const MARKER = /^\s*\[!(要点|summary)\]\s*$/i;
  // 只认要点块里第一行有内容的行；冒号后面为空时仍然用标题。
  const QUESTION = /^\s*题目\s*[:：]\s*(.*)$/;
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  const text = html => String(html || '').replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => entities[name]).replace(/\s+/g, ' ').trim();

  // 富文本里的加粗写成 **…**，复习界面按这个渲染；相邻的加粗合并。
  const bold = html => String(html || '').replace(/<\/?(?:strong|b)(?:\s[^>]*)?>/gi, '**').replace(/\*{4}/g, '').replace(/\*\*(\s*)\*\*/g, '$1');
  // Quill 保存的 HTML：顶层块按顺序排列，引用每行一个 <blockquote>。
  function pointsFromHtml(html) {
    const blocks = [...String(html || '').matchAll(/<(h[1-6]|blockquote|p|pre|ol|ul|table|div|figure|hr)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/gi)]
      .map(match => ({ tag: match[1].toLowerCase(), text: text(match[2] || ''), rich: text(bold(match[2] || '')), raw: match[0] }));
    const points = [];
    blocks.forEach((block, index) => {
      if (!/^h[1-6]$/.test(block.tag) || !block.text) return;
      let next = index + 1;
      while (next < blocks.length && blocks[next].tag !== 'blockquote' && !/^h[1-6]$/.test(blocks[next].tag) && !blocks[next].text && !/<img/i.test(blocks[next].raw)) next++;
      if (blocks[next]?.tag !== 'blockquote' || !MARKER.test(blocks[next].text)) return;
      const lines = [];
      let question = '', first = true;
      for (let line = next + 1; blocks[line]?.tag === 'blockquote'; line++) {
        if (!blocks[line].text) continue;
        const own = first && QUESTION.exec(blocks[line].text);
        first = false;
        if (own) question = own[1].trim(); else lines.push(blocks[line].rich);
      }
      points.push({ heading: block.text, question, lines });
    });
    return points;
  }

  // Markdown：## 标题，空行之后 > [!要点]，接着的 > 行是要点。
  function pointsFromMarkdown(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const points = [];
    lines.forEach((line, index) => {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!heading) return;
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (!MARKER.test((lines[next] || '').replace(/^\s*>\s?/, '')) || !/^\s*>/.test(lines[next] || '')) return;
      const gist = [];
      let question = '', first = true;
      for (let row = next + 1; row < lines.length && /^\s*>/.test(lines[row]); row++) {
        const value = lines[row].replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, '').trim();
        if (!value) continue;
        const own = first && QUESTION.exec(value.replace(/[*_`]/g, ''));
        first = false;
        if (own) question = own[1].trim(); else gist.push(value);
      }
      points.push({ heading: heading[1].replace(/[*_`]/g, '').trim(), question, lines: gist });
    });
    return points;
  }

  function pointsOfDocument(document) {
    const rich = document?.metadata?.editorMode === 'note' && document.metadata.noteContentInitialized;
    const points = rich ? pointsFromHtml(document.metadata.noteContent) : pointsFromMarkdown(document?.content);
    // 同一篇里重名的标题，用序号区分。
    const seen = new Map();
    return points.filter(point => point.lines.length).map(point => {
      const count = (seen.get(point.heading) || 0) + 1;
      seen.set(point.heading, count);
      return { ...point, key: `${document.id}#${point.heading}${count > 1 ? `#${count}` : ''}`, documentId: document.id, knowledgeBaseId: document.knowledgeBaseId || null };
    });
  }

  // 卡片上的问题；自己写了题目时另外记下标题（pointHeading），用来显示出处和回到笔记里定位。
  const titleOf = point => point.question || point.heading;
  const headingOf = card => card?.pointHeading || card?.question || '';
  function setTitle(card, point) {
    card.question = titleOf(point);
    if (point.question) card.pointHeading = point.heading; else delete card.pointHeading;
    return card;
  }
  // 要点是否进复习由用户决定：卡片上 pointOptIn 表示「加入了复习」，status 'paused' 表示暂停。
  // 同步只做三件事：已加入的随笔记更新内容；要点被删掉（或整篇笔记删掉）时删除对应卡片；
  // 打开「新写的要点自动加入复习」时，给新要点建卡片。上一版自动生成、没复习过的卡片会被移除。
  // 旧版本留下的 pointOrphan（要点删掉后暂停）的卡片：要点还在就恢复，不在就删除。
  function planSync(data, { autoAdd = Boolean(data.settings?.autoAddGists) } = {}) {
    const desired = new Map();
    for (const document of data.documents || []) for (const point of pointsOfDocument(document)) desired.set(point.key, point);
    const existing = new Map((data.cards || []).filter(card => card.cardType === 'point' && card.pointKey).map(card => [card.pointKey, card]));
    const create = [], update = [], pause = [], remove = [], adopt = [];
    for (const [key, point] of desired) {
      const card = existing.get(key);
      const answer = point.lines.join('\n');
      if (!card) { if (autoAdd) create.push(point); continue; }
      if (!card.pointOptIn) { if (Number(card.reviewCount) > 0) adopt.push(card); else { remove.push(card); continue; } }
      if (card.question !== titleOf(point) || headingOf(card) !== point.heading || card.answer !== answer || card.pointOrphan || card.knowledgeBaseId !== point.knowledgeBaseId || !card.pointOptIn) update.push({ card, point, answer });
    }
    for (const [key, card] of existing) if (!desired.has(key)) remove.push(card);
    return { create, update, pause, remove, adopt, changed: Boolean(create.length || update.length || pause.length || remove.length) };
  }

  function newPointCard(point, { createCard, isoNow }) {
    const timestamp = isoNow();
    const card = createCard({ question: titleOf(point), answer: point.lines.join('\n'), knowledgeBaseId: point.knowledgeBaseId, createdAt: timestamp });
    return Object.assign(setTitle(card, point), { cardType: 'point', pointKey: point.key, pointDocumentId: point.documentId, pointOptIn: true });
  }

  function applySync(data, { createCard, isoNow = () => new Date().toISOString(), autoAdd } = {}) {
    const plan = planSync(data, autoAdd === undefined ? {} : { autoAdd });
    if (!plan.changed) return plan;
    const timestamp = isoNow();
    data.cards ||= [];
    for (const point of plan.create) data.cards.push(newPointCard(point, { createCard, isoNow }));
    for (const { card, point, answer } of plan.update) {
      Object.assign(setTitle(card, point), { answer, knowledgeBaseId: point.knowledgeBaseId, pointDocumentId: point.documentId, pointOptIn: true, updatedAt: timestamp });
      // 要点加回来：恢复复习；用户自己暂停的保持暂停。
      if (card.pointOrphan) { delete card.pointOrphan; if (card.status === 'paused') card.status = 'active'; }
    }
    if (plan.remove.length) { const ids = new Set(plan.remove.map(card => card.id)); data.cards = data.cards.filter(card => !ids.has(card.id)); }
    return plan;
  }

  // 「加入复习」：已有卡片（暂停过、删掉又加回来）就恢复，否则新建；从今天开始复习。
  function optIn(data, documentId, key, { createCard, isoNow = () => new Date().toISOString() }) {
    const document = (data.documents || []).find(item => item.id === documentId);
    const point = document && pointsOfDocument(document).find(item => item.key === key);
    if (!point) return null;
    const card = (data.cards || []).find(item => item.cardType === 'point' && item.pointKey === key);
    if (card) {
      Object.assign(setTitle(card, point), { answer: point.lines.join('\n'), pointOptIn: true, status: 'active', updatedAt: isoNow() });
      delete card.pointOrphan;
      return card;
    }
    const created = newPointCard(point, { createCard, isoNow });
    (data.cards ||= []).push(created);
    return created;
  }
  // 撤销刚才的「加入复习」：没复习过就删掉卡片，复习过就暂停。
  function optOut(data, key, { isoNow = () => new Date().toISOString() } = {}) {
    const card = (data.cards || []).find(item => item.cardType === 'point' && item.pointKey === key);
    if (!card) return;
    if (Number(card.reviewCount) > 0) Object.assign(card, { status: 'paused', updatedAt: isoNow() });
    else data.cards = data.cards.filter(item => item !== card);
  }
  function stateOf(card) { return !card || !card.pointOptIn ? 'off' : card.status === 'paused' ? 'paused' : 'on'; }

  const isPoint = card => card?.cardType === 'point';
  const api = { pointsFromHtml, pointsFromMarkdown, pointsOfDocument, planSync, applySync, optIn, optOut, stateOf, isPoint, headingOf, KNOWLEDGE_POINT_MARKER: MARKER, KNOWLEDGE_POINT_QUESTION: QUESTION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepKnowledgePoints = api;
})(globalThis);
