function stateValuesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a), otherKeys = Object.keys(b);
  return keys.length === otherKeys.length && keys.every(key => Object.hasOwn(b, key) && stateValuesEqual(a[key], b[key]));
}

// Apply only this window's changes to the latest shared data.
function mergeWindowData(base, next, current) {
  const equal = stateValuesEqual;
  // Undo removes a review log and restores its scheduling/streak snapshot as one transaction.
  // A concurrent rating must not be merged with that older snapshot.
  if (Array.isArray(base?.reviewRecords) && Array.isArray(next?.reviewRecords)) {
    const kept = new Set(next.reviewRecords.map(record => record.id));
    if (base.reviewRecords.some(record => !kept.has(record.id)) && !equal(base.reviewRecords, current?.reviewRecords)) {
      throw new Error('其他窗口已有新的评分，无法撤销；请刷新后重试。');
    }
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const merge = (before, after, latest) => {
    if (equal(before, after)) return latest;
    if (equal(before, latest) || equal(after, latest)) return after;
    if ([before, after, latest].every(Array.isArray)
      && [...before, ...after, ...latest].every(item => object(item) && typeof item.id === 'string')) {
      const previous = new Map(before.map(item => [item.id, item]));
      const incoming = new Map(after.map(item => [item.id, item]));
      const existing = new Map(latest.map(item => [item.id, item]));
      return [...new Set([...existing.keys(), ...incoming.keys()])]
        .map(id => merge(previous.get(id), incoming.get(id), existing.get(id)))
        .filter(item => item !== undefined);
    }
    if ([before, after, latest].every(object)) {
      const result = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(latest)])) {
        // Timestamps can change independently alongside otherwise compatible edits.
        const value = key === 'updatedAt' && after[key] && latest[key]
          ? (after[key] > latest[key] ? after[key] : latest[key])
          : merge(before[key], after[key], latest[key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    throw new Error('其他窗口已修改或删除相同内容，请复制保留当前修改，重新打开笔记后再保存。');
  };
  return merge(base, next, current);
}

// Entity patches carry only changed records, including their conflict baseline.
function createDataPatch(base = {}, next = {}) {
  const fields = [];
  const entities = values => Array.isArray(values) && values.every(value => value && typeof value.id === 'string')
    && new Set(values.map(value => value.id)).size === values.length;
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const before = base[key], after = next[key];
    if (stateValuesEqual(before, after)) continue;
    if (entities(before) && entities(after)) {
      const previous = new Map(before.map(value => [value.id, value]));
      const incoming = new Map(after.map(value => [value.id, value]));
      const changes = [];
      for (const id of new Set([...previous.keys(), ...incoming.keys()])) {
        if (!stateValuesEqual(previous.get(id), incoming.get(id))) changes.push({ id, before: previous.get(id), after: incoming.get(id) });
      }
      const beforeOrder = before.map(value => value.id), afterOrder = after.map(value => value.id);
      fields.push({ key, kind: 'entities', changes, ...(!stateValuesEqual(beforeOrder, afterOrder) ? { beforeOrder, afterOrder } : {}) });
    } else fields.push({ key, kind: 'value', before, after });
  }
  const keptReviews = new Set((next.reviewRecords || []).map(record => record.id));
  const removedReview = Array.isArray(base.reviewRecords) && Array.isArray(next.reviewRecords)
    && base.reviewRecords.some(record => !keptReviews.has(record.id));
  return { fields, ...(removedReview ? { reviewBaseline: base.reviewRecords } : {}) };
}

function applyDataPatch(current, patch) {
  if (!Array.isArray(patch?.fields)) throw new Error('数据变更格式无效');
  if (patch.reviewBaseline && !stateValuesEqual(patch.reviewBaseline, current.reviewRecords)) {
    throw new Error('其他窗口已有新的评分，无法撤销；请刷新后重试。');
  }
  if (!patch.fields.length) return current;
  const result = { ...current };
  for (const field of patch.fields) {
    if (['__proto__', 'constructor', 'prototype'].includes(field.key)) throw new Error('数据字段无效');
    let value;
    if (field.kind === 'entities') {
      const rows = Array.isArray(current[field.key]) ? current[field.key] : [];
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const change of field.changes) {
        const merged = mergeWindowData(change.before, change.after, byId.get(change.id));
        if (merged === undefined) byId.delete(change.id); else byId.set(change.id, merged);
      }
      const order = field.afterOrder && stateValuesEqual(rows.map(row => row.id), field.beforeOrder) ? field.afterOrder : [];
      value = [...new Set([...order, ...byId.keys()])].filter(id => byId.has(id)).map(id => byId.get(id));
    } else value = mergeWindowData(field.before, field.after, current[field.key]);
    if (value === undefined) delete result[field.key]; else result[field.key] = value;
  }
  return result;
}

if (typeof module !== 'undefined') module.exports = { mergeWindowData, createDataPatch, applyDataPatch, stateValuesEqual };
