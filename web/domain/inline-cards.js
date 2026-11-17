(function expose(root) {
  function hasVisibleInlineCardText(value = '') {
    return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '').length > 0;
  }

  function parseInlineCardLine(source = '') {
    const separatorMatch = source.match(/==|->|→/);
    if (!separatorMatch) return null;

    const separatorIndex = separatorMatch.index;
    const question = source
      .slice(0, separatorIndex)
      .trim()
      .replace(/^[-*+]\s+/, '');
    const answer = source.slice(separatorIndex + separatorMatch[0].length).trim();

    if (!hasVisibleInlineCardText(question) || !hasVisibleInlineCardText(answer)) return null;

    return {
      question,
      answer,
      separator: separatorMatch[0],
      separatorIndex
    };
  }

  function normalizeInlineCardLineSpacing(sourceLine) {
    const parsed = parseInlineCardLine(sourceLine);
    if (!parsed) return sourceLine;
    const separatorEnd = parsed.separatorIndex + parsed.separator.length;
    return `${sourceLine.slice(0, parsed.separatorIndex).trimEnd()} ${parsed.separator} ${sourceLine.slice(separatorEnd).trimStart()}`;
  }

  function parseInlineCards(markdown = '', { keepDuplicates = false } = {}) {
    const cards = [];
    const seen = new Set();
    let inCodeBlock = false;

    markdown.replace(/\r\n?/g, '\n').split('\n').forEach((source, index) => {
      const trimmed = source.trim();
      if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; return; }
      if (inCodeBlock || !trimmed) return;
      const parsed = parseInlineCardLine(source);
      if (!parsed) return;

      const { question, answer } = parsed;
      const key = `${question}\0${answer}`;
      if (!keepDuplicates && seen.has(key)) return;
      seen.add(key);
      cards.push({ question, answer, line: index + 1, key });
    });

    return cards;
  }

  function duplicateCardQuestion(cards) {
    const seen = new Set();
    for (const card of cards) {
      const question = String(card.question || '').trim();
      if (question && seen.has(question)) return card;
      seen.add(question);
    }
    return null;
  }

  const api = { hasVisibleInlineCardText, parseInlineCardLine, normalizeInlineCardLineSpacing, parseInlineCards, duplicateCardQuestion };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
