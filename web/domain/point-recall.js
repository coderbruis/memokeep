// 要点记忆（design/prototype/memory-boost-20261112.md）：多要点卡片逐条记录「想起 / 没想起」。
// card.pointRecall = { items: [{ k, t, h }] }：k 是归一后的要点文字，t 是原文，h 是最近 5 次结果（'y' 想起 / 'n' 没想起，旧 → 新）。
// 判断项（design/prototype/check-items-20261112.md）：只有列表项（- • * 1. 1、 1） (1)）才逐条判断，普通行是说明 / 引子，只显示。
(function expose(root) {
  const HISTORY = 5, WEAK_MISSES = 2, GRADE_MIN_POINTS = 3, GRADE_MIN_ITEMS = 2, LONG_ANSWER = 120;
  // 「1.5 倍」「1.1 小节」不算列表项：点号后面不能紧跟数字。
  const ITEM = /^\s*(?:[-*+•·]\s+|\d+(?:\.(?!\d)|、)\s*|\d+[)）]\s*|[（(]\d+[)）]\s*)/;
  const plainLine = line => String(line || '').replace(/\*\*/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  const isItem = line => ITEM.test(String(line || '').replace(/\*\*/g, '')) && key(itemText(line)).length >= 2;
  function itemText(line) { return plainLine(String(line || '').replace(/\*\*/g, '').replace(ITEM, '')); }
  // 判断项：答案里的列表项（代码块里的不算）。
  function checkItems(answer) {
    const text = String(answer || '');
    if (/```/.test(text)) return [];
    return text.split(/\r?\n/).filter(isItem).map(itemText);
  }
  // 说明 / 引子：不是判断项的非空行（复习时照常显示，不判断）。
  function contextLines(answer) {
    const text = String(answer || '');
    if (/```/.test(text)) return [];
    return text.split(/\r?\n/).filter(line => !isItem(line)).map(plainLine).filter(Boolean);
  }
  // 把第 from–to 行设为 / 取消判断项（加上 / 去掉「- 」）；空行不动。
  function markLines(value, from, to, on) {
    const lines = String(value || '').split('\n');
    for (let index = Math.max(0, from); index <= Math.min(to, lines.length - 1); index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      const bare = line.replace(ITEM, '').trimStart();
      lines[index] = on ? `- ${bare}` : bare;
    }
    return lines.join('\n');
  }
  // 「一键设为判断项」建议的行：最后一个以「：」结尾的引子之后的行；没有引子就除第一行外的所有行。
  function suggestedItemLines(value) {
    const lines = String(value || '').split('\n');
    const filled = lines.map((line, index) => line.trim() && !/!\[[^\]]*\]\([^)]*\)\s*$/.test(line.trim()) ? index : -1).filter(index => index >= 0);
    if (filled.length < 3) return [];
    const intro = filled.filter(index => /[：:]\s*$/.test(lines[index])).pop();
    return intro !== undefined && filled.some(index => index > intro) ? filled.filter(index => index > intro) : filled.slice(1);
  }

  function key(text) {
    return String(text || '').normalize('NFKC').toLowerCase().replace(/\*\*/g, '').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 120);
  }

  // 卡片答案（纯文本 / Markdown）→ 要点。代码块、图片不算要点；只有一行时按句号拆。
  function pointsFromAnswer(answer) {
    const text = String(answer || '');
    if (/```/.test(text)) return [];
    const strip = line => line.replace(/\*\*/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\s*(?:[-*+•·]|\d+[.、)]|[（(]\d+[)）])\s*/, '').trim();
    let lines = text.split(/\r?\n/).map(strip).filter(Boolean);
    if (lines.length === 1) lines = lines[0].split(/(?<=[。！？；;!?])\s*/).map(part => part.trim()).filter(Boolean);
    return lines.filter(line => key(line).length >= 2);
  }

  function items(card) {
    const list = Array.isArray(card?.pointRecall?.items) ? card.pointRecall.items : [];
    return list.filter(item => item && typeof item.k === 'string' && typeof item.h === 'string').map(item => {
      const history = item.h.slice(-HISTORY), got = [...history].filter(mark => mark === 'y').length, misses = history.length - got;
      return { key: item.k, text: String(item.t || ''), history, rate: history.length ? Math.round(got / history.length * 100) : null,
        misses, weak: misses >= WEAK_MISSES, lastMissed: history.endsWith('n') };
    });
  }

  // 记下这一次逐条判断的结果（results：[{ text, got: true | false | null }]，null 表示没判断）。
  // 只保留这次出现的要点：答案改过以后，内容没变的条目保留历史，新条目从零开始。
  function record(card, results, at = Date.now()) {
    if (!card || !Array.isArray(results) || !results.length) return false;
    const previous = new Map((card.pointRecall?.items || []).map(item => [item.k, item]));
    const seen = new Set(), next = [];
    for (const result of results) {
      const k = key(result.text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const history = String(previous.get(k)?.h || '');
      const mark = result.got === true ? 'y' : result.got === false ? 'n' : '';
      next.push({ k, t: String(result.text).slice(0, 300), h: (history + mark).slice(-HISTORY) });
    }
    if (!next.some(item => item.h)) return false;
    card.pointRecall = { items: next, updatedAt: at };
    return true;
  }

  const lastMissedKeys = card => new Set(items(card).filter(item => item.lastMissed).map(item => item.key));
  const weakCount = card => items(card).filter(item => item.weak).length;

  // 一组卡片里常漏的要点，想起率从低到高。
  function weakPoints(cards) {
    return (cards || []).flatMap(card => items(card).filter(item => item.weak).map(item => ({ ...item, cardId: card.id, question: card.question })))
      .sort((a, b) => a.rate - b.rate || b.misses - a.misses);
  }

  // 一张卡的汇总：复习时按要点评分了几次、平均想起率、最弱的一条。
  function summary(card) {
    const list = items(card).filter(item => item.history);
    if (!list.length) return null;
    const total = list.reduce((sum, item) => sum + item.history.length, 0);
    const got = list.reduce((sum, item) => sum + [...item.history].filter(mark => mark === 'y').length, 0);
    const weakest = [...list].sort((a, b) => a.rate - b.rate)[0];
    return { items: list, average: Math.round(got / total * 100), weakest: weakest.rate < 100 ? weakest : null, weak: list.filter(item => item.weak).length };
  }

  // 制卡提示：答案 3 条以上或超过 120 字（不算图片）。
  function splitAdvice(card) {
    if (!card || card.cardType === 'point' || card.splitHintDismissed) return null;
    if (['cloze', 'image-occlusion'].includes(card.cardType)) return null;
    const points = pointsFromAnswer(card.answer);
    const length = String(card.answer || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, '').length;
    if (points.length >= GRADE_MIN_POINTS) return { reason: 'points', points };
    if (length > LONG_ANSWER && points.length >= 2) return { reason: 'long', points };
    return null;
  }

  // 去掉「是什么 / 为什么」之类的问法，留下主语，用在拆卡和理解题模板里。
  function subjectOf(question) {
    return String(question || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\s*\d+(?:\.\d+)*\s+/, '')
      .replace(/(?:具体)?(?:是什么|是啥|有哪些|有什么|是怎样的|怎么(?:做|实现|理解)|如何(?:实现|理解)|是)?[?？。\s]*$/, '').trim() || String(question || '').trim();
  }

  // 每一条变一张卡：「：」前面的词当问题，后面的当答案；没有「：」就用主语 + 这一条的开头做提示。
  function splitSuggestions(card) {
    const subject = subjectOf(card?.question);
    return pointsFromAnswer(card?.answer).map(line => {
      const match = line.match(/^([^：:]{1,30})[：:]\s*(.+)$/);
      if (match) return { question: `${match[1].trim()} 是什么？`, answer: match[2].trim() };
      // 截断时不要把英文单词切一半。
      const cue = line.length > 12 ? `${line.slice(0, 10).replace(/\s*[A-Za-z0-9._-]*$/, '') || line.slice(0, 10)}……` : line;
      return { question: `${subject}：${cue}`, answer: line };
    });
  }

  const api = { key, pointsFromAnswer, items, record, lastMissedKeys, weakCount, weakPoints, summary, splitAdvice, splitSuggestions, subjectOf, isItem, itemText, checkItems, contextLines, markLines, suggestedItemLines, HISTORY, WEAK_MISSES, GRADE_MIN_POINTS, GRADE_MIN_ITEMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepPointRecall = api;
})(globalThis);
