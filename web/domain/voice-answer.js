// 语音作答对照（design/prototype/voice-review-20261111.md）：本地、可解释的关键词匹配。
// 参考答案拆成要点 → 每个要点取关键词（英文术语 / 数字算 2 分，中文双字词算 1 分）→ 回答里覆盖 35% 以上就算说中。
(function expose(root) {
  // 虚词：整词去掉；含「虚字」的双字词不算关键词（「的副」「被选」这类拼接没有意义）。
  const STOP_WORDS = ['就是', '那些', '这些', '如果', '只有', '可以', '因为', '所以', '但是', '然后', '还有', '以及', '或者', '通过', '进行', '一个', '一些', '什么', '怎么', '时候', '的话', '其实', '主要', '比如', '也就'];
  const FUNCTION_CHARS = new Set([...'的是了和与及就被也都而或把这那个吗呢吧啊嗯呃么着过地得']);
  const HIT_RATIO = 0.35;

  function normalize(text) {
    return String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  }

  // 一段文字里的关键词：[{ token, weight }]，去重。
  function keywords(text) {
    const value = normalize(text), seen = new Map();
    const add = (token, weight) => { if (!seen.has(token)) seen.set(token, weight); };
    for (const match of value.matchAll(/[a-z0-9][a-z0-9._+#-]*[a-z0-9+#]|[a-z0-9]/g)) {
      const token = match[0];
      if (token.length >= 2 || /\d/.test(token)) add(token, 2);
    }
    for (const run of value.match(/[\u3400-\u9fff]+/g) || []) {
      let rest = run;
      for (const word of STOP_WORDS) rest = rest.split(word).join(' ');
      for (const segment of rest.split(' ')) {
        for (let index = 0; index < segment.length - 1; index++) {
          const pair = segment.slice(index, index + 2);
          if (!FUNCTION_CHARS.has(pair[0]) && !FUNCTION_CHARS.has(pair[1])) add(pair, 1);
        }
      }
    }
    return [...seen].map(([token, weight]) => ({ token, weight }));
  }

  // 参考答案的若干行（列表项 / 段落）→ 要点。长段落再按句号拆开。
  function splitPoints(lines) {
    const points = [];
    for (const line of [].concat(lines || [])) {
      for (const part of String(line || '').split(/(?<=[。！？；;!?])\s*|\n+/)) {
        const text = part.replace(/^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[)）])\s*/, '').trim();
        if (text && keywords(text).length) points.push(text);
      }
    }
    return points;
  }

  // 返回每个要点是否说中、说中了哪些词，以及建议评分（拆不出要点时为 null）。
  // 题目里已经出现的词不算（复述题目不等于答出来）；几个要点共有的词按出现的要点数分摊权重。
  function compare(referenceLines, spoken, question = '', { ratio = HIT_RATIO } = {}) {
    const said = normalize(spoken).replace(/\s+/g, '');
    const given = new Set(keywords(question).map(word => word.token));
    const texts = splitPoints(referenceLines);
    const lists = texts.map(text => keywords(text).filter(word => !given.has(word.token)));
    const spread = new Map();
    for (const words of lists) for (const word of words) spread.set(word.token, (spread.get(word.token) || 0) + 1);
    const points = texts.map((text, index) => {
      const words = lists[index].map(word => ({ ...word, weight: word.weight / spread.get(word.token) }));
      const total = words.reduce((sum, word) => sum + word.weight, 0);
      const matched = words.filter(word => said.includes(word.token.replace(/\s+/g, '')));
      const score = matched.reduce((sum, word) => sum + word.weight, 0);
      return { text, hit: total > 0 && score / total >= ratio, matched: matched.map(word => word.token), weight: total };
    }).filter(point => point.weight > 0);
    const hits = points.filter(point => point.hit).length;
    const meaningful = points.length > 1 || points[0]?.weight >= 2;
    return { points, hits, total: points.length, suggestion: meaningful && said ? suggestRating(hits, points.length) : null };
  }

  function suggestRating(hits, total) {
    if (!total) return null;
    if (hits === total) return 'good';
    if (hits * 2 >= total) return 'hard';
    return 'again';
  }

  // 在回答里标出说中的词：返回 [{ text, hit }] 片段，顺序拼起来就是原文。
  function highlight(spoken, tokens) {
    const text = String(spoken || ''), lower = normalize(text);
    if (lower.length !== text.length) return [{ text, hit: false }];
    const marks = new Array(text.length).fill(false);
    for (const token of new Set(tokens)) {
      let from = 0, index;
      while (token && (index = lower.indexOf(token, from)) >= 0) { marks.fill(true, index, index + token.length); from = index + token.length; }
    }
    const parts = [];
    for (let index = 0; index < text.length; index++) {
      const last = parts[parts.length - 1];
      if (last && last.hit === marks[index]) last.text += text[index]; else parts.push({ text: text[index], hit: marks[index] });
    }
    return parts;
  }

  // 实时文字：和上一次相同的前缀算「已确认」，后面变化的部分显示成灰色。
  function stablePrefix(previous, current) {
    const a = String(previous || ''), b = String(current || '');
    let index = 0;
    while (index < a.length && index < b.length && a[index] === b[index]) index++;
    return index;
  }

  // 实时识别结果按「段」拼接：系统在停顿后会从新的一句重新给结果，不能直接覆盖前面说的。
  // push(text, segmentEnd)：text 是当前这一段的最新结果。返回 { committed, current, text }。
  function createTranscript() {
    const segments = [];
    let current = '', previous = '';
    const loose = value => normalize(value).replace(/[\s，。！？、,.!?；;：:]/g, '');
    const continues = (text, before) => { const a = loose(text), b = loose(before); return Boolean(b) && a.startsWith(b); };
    // 新结果和上一次的开头完全不同（或明显变短），说明系统开始了新的一句。
    const restarted = (before, text) => {
      const a = loose(before), b = loose(text);
      if (!a || !b) return false;
      const same = stablePrefix(a, b);
      return same === 0 && a.length >= 4 || b.length * 2 < a.length && same * 2 < a.length;
    };
    function join(parts) {
      return parts.filter(Boolean).reduce((all, part) => !all ? part : /[，。！？、,.!?；;：:\s]$/.test(all) ? all + part : `${all}，${part}`, '');
    }
    function push(value, segmentEnd = false) {
      const text = String(value || '').trim();
      previous = current;
      // 有的系统版本在一段结束后仍给出包含前一段的完整结果：撤回那一段，按延续处理。
      if (text && segments.length && continues(text, segments[segments.length - 1])) { previous = segments.pop(); current = ''; }
      else if (text && current && restarted(current, text)) { segments.push(current); previous = ''; }
      if (text) current = text;
      if (segmentEnd && current) { segments.push(current); current = ''; previous = ''; }
      return snapshot();
    }
    function snapshot() {
      const committed = join(segments);
      return { committed, current, text: join([committed, current]), stable: stablePrefix(previous, current) };
    }
    function reset() { segments.length = 0; current = ''; previous = ''; }
    return { push, snapshot, reset };
  }

  const api = { keywords, splitPoints, compare, suggestRating, highlight, stablePrefix, createTranscript, HIT_RATIO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepVoiceAnswer = api;
})(globalThis);
