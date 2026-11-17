// 记忆卡片按主题（design/prototype/card-topics-20261112.md）。
// 主题从卡片所在位置来：有卡片目录用卡片目录，否则用卡片所属的知识库（大多数卡片是从笔记做的）。
// 第一级 = 分组（后端），第二级 = 主题（kafka / 数据库）；只有一级的放进「其他」分组。
// 技术点 = 更深一级的目录 / 知识库，否则是卡片来自的笔记，再否则是第一个标签。
(function expose(root) {
  const COLORS = 6;
  const SECONDS_PER_CARD = 20;
  const OTHER = '其他';

  function hash(value) { let h = 0; for (const char of String(value)) h = (h * 31 + char.codePointAt(0)) >>> 0; return h; }

  // 一张卡片在树上的路径：[{ kind, id, name }]，以及它的技术点。
  function locate(card, index) {
    const path = [];
    const folderId = Object.prototype.hasOwnProperty.call(card, 'cardFolderId') ? card.cardFolderId : index.notebooks.get(card.cardNotebookId)?.folderId;
    if (folderId && index.folders.has(folderId)) {
      for (let node = index.folders.get(folderId), guard = 0; node && guard < 20; node = index.folders.get(node.parentId), guard++) path.unshift({ kind: 'folder', id: node.id, name: node.name || '未命名目录' });
    } else if (card.knowledgeBaseId && index.libraries.has(card.knowledgeBaseId)) {
      for (let node = index.libraries.get(card.knowledgeBaseId), guard = 0; node && guard < 20; node = index.libraries.get(node.parentId), guard++) path.unshift({ kind: 'library', id: node.id, name: node.name || '未命名知识库' });
    }
    // 技术点：更深的一级优先，其次是来源笔记（知识点 → 笔记；问答卡 → 知识条目的笔记；卡片笔记本），再其次第一个标签。
    let point = path[2] ? { id: `${path[2].kind}:${path[2].id}`, name: path[2].name } : null;
    if (!point) {
      const documentId = card.pointDocumentId || index.items.get(card.knowledgeItemId)?.documentId || index.notebooks.get(card.cardNotebookId)?.sourceDocumentId;
      const document = documentId && index.documents.get(documentId);
      if (document) point = { id: `doc:${document.id}`, name: document.title || '未命名笔记' };
      else if (index.notebooks.get(card.cardNotebookId)) point = { id: `nb:${card.cardNotebookId}`, name: index.notebooks.get(card.cardNotebookId).name || '未命名' };
      else if (card.tags?.[0]) point = { id: `tag:${card.tags[0]}`, name: card.tags[0] };
    }
    return { path, point: point || { id: 'none', name: '其他' } };
  }

  function indexOf(data) {
    const byId = list => new Map((list || []).map(item => [item.id, item]));
    return { folders: byId(data.cardFolders), notebooks: byId(data.cardNotebooks), libraries: byId(data.knowledgeBases), documents: byId(data.documents), items: byId(data.items) };
  }

  // 卡片所在的主题和技术点：{ groupId, groupName, topicId, topicName, pointId, pointName }。
  function topicOf(card, data, index = indexOf(data)) {
    const { path, point } = locate(card, index);
    if (!path.length) return { groupId: 'other', groupName: OTHER, topicId: 'unfiled', topicName: '未分类', pointId: point.id, pointName: point.name };
    if (path.length === 1) return { groupId: 'other', groupName: OTHER, topicId: `${path[0].kind}:${path[0].id}`, topicName: path[0].name, pointId: point.id, pointName: point.name };
    return { groupId: `${path[0].kind}:${path[0].id}`, groupName: path[0].name, topicId: `${path[1].kind}:${path[1].id}`, topicName: path[1].name, pointId: point.id, pointName: point.name };
  }

  // 最近 5 次里有 2 次以上「忘记」= 薄弱（常忘）。
  function recentRatings(records) {
    const byCard = new Map();
    for (const record of records || []) { if (!byCard.has(record.cardId)) byCard.set(record.cardId, []); byCard.get(record.cardId).push(record); }
    for (const list of byCard.values()) list.sort((a, b) => new Date(a.reviewedAt) - new Date(b.reviewedAt));
    return byCard;
  }
  const isWeak = list => (list || []).slice(-5).filter(record => record.rating === 'again').length >= 2;

  // 主题看板的数据：分组 → 主题 → 技术点，带到期、新卡、学习中、已掌握、薄弱、记住率、上次复习。
  function build(data, { now = Date.now(), stageOf, days = 30 } = {}) {
    const index = indexOf(data);
    const ratings = recentRatings(data.reviewRecords);
    const since = now - days * 86400000;
    const groups = new Map(), topics = new Map();
    const blank = () => ({ total: 0, due: 0, new: 0, learning: 0, mastered: 0, paused: 0, weak: 0, dueIds: [], weakIds: [], cardIds: [], reviewed: 0, remembered: 0, lastReviewedAt: 0, nextDueAt: Infinity });
    for (const card of data.cards || []) {
      const where = topicOf(card, data, index);
      const stage = stageOf ? stageOf(card) : card.status === 'paused' ? 'paused' : Number(card.dueAt) <= now ? 'due' : 'learning';
      if (!groups.has(where.groupId)) groups.set(where.groupId, { id: where.groupId, name: where.groupName, topics: [] });
      let topic = topics.get(where.topicId);
      if (!topic) {
        topic = { id: where.topicId, name: where.topicName, groupId: where.groupId, groupName: where.groupName, color: hash(where.topicId) % COLORS + 1, points: new Map(), ...blank() };
        topics.set(where.topicId, topic); groups.get(where.groupId).topics.push(topic);
      }
      let point = topic.points.get(where.pointId);
      if (!point) { point = { id: where.pointId, name: where.pointName, ...blank() }; topic.points.set(where.pointId, point); }
      const history = ratings.get(card.id) || [];
      const weak = card.status === 'active' && isWeak(history);
      for (const target of [topic, point]) {
        target.total++; target.cardIds.push(card.id);
        if (stage in target && stage !== 'due') target[stage]++;
        if (card.status === 'active' && Number(card.dueAt) <= now) { target.due++; target.dueIds.push(card.id); }
        if (weak) { target.weak++; target.weakIds.push(card.id); }
        for (const record of history) {
          const at = new Date(record.reviewedAt).getTime();
          if (at > target.lastReviewedAt) target.lastReviewedAt = at;
          if (at >= since) { target.reviewed++; if (record.rating !== 'again') target.remembered++; }
        }
        if (card.status === 'active' && Number(card.dueAt) > now) target.nextDueAt = Math.min(target.nextDueAt, Number(card.dueAt));
      }
    }
    const finish = target => ({ ...target, retention: target.reviewed ? Math.round(target.remembered / target.reviewed * 100) : null, minutes: Math.max(1, Math.ceil(target.due * SECONDS_PER_CARD / 60)), lastReviewedAt: target.lastReviewedAt || null, nextDueAt: Number.isFinite(target.nextDueAt) ? target.nextDueAt : null });
    const list = [...groups.values()].map(group => {
      const groupTopics = group.topics.map(topic => ({ ...finish(topic), points: [...topic.points.values()].map(finish).sort((a, b) => b.due - a.due || b.total - a.total || a.name.localeCompare(b.name, 'zh')) }));
      return { ...group, topics: groupTopics, due: groupTopics.reduce((sum, topic) => sum + topic.due, 0), total: groupTopics.reduce((sum, topic) => sum + topic.total, 0) };
    });
    // 「其他」分组放最后。
    list.sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.due - a.due || a.name.localeCompare(b.name, 'zh'));
    const all = list.flatMap(group => group.topics);
    // 颜色按主题 id 排序后依次分配：6 个以内不重复，增删主题时其他主题颜色尽量不变。
    [...all].sort((a, b) => a.id.localeCompare(b.id)).forEach((topic, index) => { topic.color = index % COLORS + 1; });
    const due = all.reduce((sum, topic) => sum + topic.due, 0);
    return { groups: list, topics: all, due, newDue: (data.cards || []).filter(card => card.status === 'active' && Number(card.dueAt) <= now && !card.reviewCount).length,
      minutes: Math.ceil(due * SECONDS_PER_CARD / 60), topicById: id => all.find(topic => topic.id === id) || null };
  }

  // 排序方式：到期多的在前 / 记住率低的在前 / 最近复习。
  function sortTopics(topics, by = 'due') {
    const list = [...topics];
    if (by === 'retention') return list.sort((a, b) => (a.retention ?? 101) - (b.retention ?? 101) || b.due - a.due);
    if (by === 'recent') return list.sort((a, b) => (b.lastReviewedAt || 0) - (a.lastReviewedAt || 0) || b.due - a.due);
    return list.sort((a, b) => b.due - a.due || b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  }

  const api = { build, topicOf, indexOf, sortTopics, isWeak, SECONDS_PER_CARD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepCardTopics = api;
})(globalThis);
