(function expose(root) {
  function comparableName(value = '') {
    return String(value).trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
  }

  function nextAvailableName(requestedName, existingNames, maxLength) {
    const requested = String(requestedName).trim().slice(0, maxLength);
    const occupied = new Set(existingNames.map(comparableName));
    if (!occupied.has(comparableName(requested))) return requested;

    const stem = requested.replace(/[（(]\d+[）)]$/, '').trimEnd() || requested;
    for (let index = 1; ; index += 1) {
      const suffix = `（${index}）`;
      const candidateStem = stem.slice(0, Math.max(1, maxLength - suffix.length)).trimEnd();
      const candidate = `${candidateStem}${suffix}`;
      if (!occupied.has(comparableName(candidate))) return candidate;
    }
  }

  const api = { comparableName, nextAvailableName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
