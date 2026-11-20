import { invoke } from '@tauri-apps/api/core';
import StateMerge from '../../web/state-merge.js';

const id = 'isolated-smoke-note';
const linkedId = 'isolated-reference-note';
const cardId = 'isolated-smoke-card';
const changed = 'Tauri 保存成功';
const memoTitle = 'Tauri 测试备忘';
const planName = 'Tauri 每日计划';
const taskName = '完成 WebView 自测';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDeQAAAAASUVORK5CYII=';
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(check, label) {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 35));
  }
}

function hasPlanCheckIn(plan) {
  return plan.name === planName && Object.values(plan.days || {}).some(day => day.doneFixed?.length === 1);
}

async function checkFieldPatches(bridge) {
  const { createDataPatch } = StateMerge;
  const { data, token } = await bridge.readChanges();
  const selected = await invoke('plugin:memokeep-workspace|read_fields', { fields: ['version'] });
  assert(Object.keys(selected.data).join() === 'version', '字段读取只返回指定数据');
  const updated = { ...data, cutoverFieldTest: null };
  const first = await bridge.writeChanges(createDataPatch(data, updated), token);
  assert(first.patch?.fields[0]?.key === 'cutoverFieldTest' && first.token > token, '当前修订保存应返回字段补丁');
  const unchanged = await bridge.readChanges(first.token);
  assert(unchanged.patch?.fields.length === 0, '无变化时不重读全库');
  await invoke('plugin:memokeep-workspace|write_fields', { expectedRevision: first.token, updated: { cutoverParallelTest: true }, removed: [] });
  const write = await bridge.writeChanges(createDataPatch(updated, data), first.token);
  assert(write.data?.cutoverParallelTest === true && !Object.hasOwn(write.data, 'cutoverFieldTest'), '过期修订应保留并行写入并区分删除和空值');
  try {
    await bridge.writeChanges(createDataPatch(updated, { ...updated, cutoverFieldTest: true }), first.token);
    throw new Error('不应覆盖另一方删除的字段');
  } catch (error) {
    assert(String(error.message).includes('其他窗口已修改或删除相同内容'), '同字段冲突应拒绝写入');
  }
}

async function check() {
  const phase = await invoke('smoke_phase');
  await until(() => typeof applicationShell !== 'undefined' && applicationShell.state.persistence.applicationDataReady
    && document.querySelector('#startupLoading').hidden, '页面加载');
  const bridge = window.memoKeepDesktop;
  assert(applicationShell.state.shell.localDataPath.endsWith('/workspace.sqlite3'), '设置应显示实际 SQLite 文件位置');
  if (phase === 'write') {
    assert(await bridge.speech.available(), '语音辅助程序未装配');
    assert((await bridge.speech.status('zh-CN')).supported, '真实语音权限查询失败');
    await checkFieldPatches(bridge);
  }
  const existing = await bridge.read();
  if (phase === 'migration') {
    const note = existing.documents.find(row => row.id === 'legacy-migration-note');
    const imageId = '814318fa-0a7e-4e78-baf0-ac458c8e2846';
    assert(note?.content === '迁移保留 Markdown', '旧笔记正文导入后仍可读取');
    assert(note.metadata.versions[0].content.includes(imageId), '旧笔记历史保持图片引用');
    assert((await bridge.readNoteImage(imageId)).dataUrl === `data:image/png;base64,${png}`, '旧历史图片保持原始字节');
    assert(await applicationShell.actions.openWorkspaceNote(note.id), '迁移笔记可从标准入口打开');
    return;
  }
  if (phase === 'reload') {
    assert(existing.documents.some(row => row.id === id && row.metadata.noteContent.includes(changed)), '重开后应读取笔记');
    assert(existing.reviewRecords.some(row => row.cardId === cardId && row.rating === 'good'), '重开后应读取复习记录');
    assert(existing.memos.some(memo => memo.title === memoTitle), '重开后应读取备忘');
    assert(existing.plans.some(hasPlanCheckIn), '重开后应读取计划和打卡');
    return;
  }
  assert(phase === 'write' && !(existing.documents || []).some(row => row.id === id), '测试应使用新数据库');
  const image = await bridge.saveNoteImage({ bytes: Uint8Array.from(atob(png), character => character.charCodeAt(0)), name: '测试.png' });
  const storedImage = await bridge.readNoteImage(image.id);
  assert(storedImage.dataUrl === `data:image/png;base64,${png}`, '本地图片应保持原始字节');
  const { actions, state } = applicationShell;
  const time = '2026-11-18T18:00:00.000Z';
  const initial = { ...existing, version: 2, cardOrganizationVersion: 1,
    knowledgeBases: [{ id: 'smoke-library', name: '测试知识库', type: 'general' }],
    documents: [{ id, knowledgeBaseId: 'smoke-library', title: '测试笔记', content: '', sourceType: 'manual-markdown',
      createdAt: time, updatedAt: time, metadata: { editorMode: 'note', noteContentInitialized: true, noteContent: '<p>合成正文</p><p>精确搜索段落</p>', versions: [{ content: image.reference }] } },
    { id: linkedId, knowledgeBaseId: 'smoke-library', title: '可改名的引用', content: '', sourceType: 'manual-markdown',
      createdAt: time, updatedAt: time, metadata: { editorMode: 'note', noteContentInitialized: true, noteContent: '<p>作为引用目标</p>' } }],
    cards: [{ ...actions.createCard({ question: '合成题目', answer: '合成答案', knowledgeBaseId: 'smoke-library' }),
      id: cardId, sourceAnchor: { documentId: id, quote: '合成正文', prefix: '', suffix: '', createdAt: time } }],
  };
  await bridge.write(initial, existing);
  await until(() => Boolean(applicationShell.actions.documentById(id)), '收到持久化变更提示');
  assert(await actions.openMarkdownNoteEditor(actions.documentById(id)), '需要成功打开笔记');
  await until(() => Boolean(globalThis.Quill?.find(document.querySelector('#noteRichEditor'))), '富文本编辑器');
  const quill = Quill.find(document.querySelector('#noteRichEditor'));
  quill.setSelection(0, 0, 'silent');
  document.querySelector('[data-open-note-references]').click();
  const references = document.querySelector('.note-references-dialog');
  assert(references.querySelector('[data-note-related-cards]').textContent.includes('合成题目'), '笔记应显示关联卡片');
  references.querySelector('select').value = linkedId;
  references.querySelector('form').requestSubmit();
  assert(quill.root.querySelector(`[href="https://memokeep.invalid/notes/${linkedId}"]`), '引用应保存稳定 ID');
  quill.insertText(quill.getLength() - 1, changed, 'user');
  await state.editor.saveActiveNoteEditor();
  const saved = await bridge.read();
  assert(saved.documents.some(row => row.id === id && row.metadata.noteContent.includes(changed)), '编辑器修改需持久保存');
  assert(!(await bridge.deleteNoteImage(image.id)), '笔记历史引用的图片应当保留');
  await actions.openWorkspaceNote(linkedId);
  await until(() => document.querySelector('[data-open-note-references]'), '打开引用目标');
  document.querySelector('[data-open-note-references]').click();
  assert(document.querySelector('[data-note-incoming]').textContent.includes('测试笔记'), '目标笔记应显示反向引用');
  document.querySelector('.note-references-dialog').close();
  const beforeRename = await bridge.read();
  await bridge.write({ ...beforeRename, documents: beforeRename.documents.map(note => note.id === linkedId ? { ...note, title: '引用目标新标题' } : note) }, beforeRename);
  await until(() => actions.documentById(linkedId)?.title === '引用目标新标题', '收到目标笔记改名');
  document.querySelector('[data-open-note-references]').click();
  document.querySelector('[data-note-incoming] button').click();
  await until(() => document.querySelector('.ql-editor [data-memokeep-title="引用目标新标题"]')?.getAnimations().length, '反向引用定位到来源段落');
  await application.operations.review.startReview(false, [cardId]);
  await until(() => document.querySelector('#reviewDialog').open, '打开卡片复习');
  document.querySelector('#revealBtn').click();
  await until(() => !document.querySelector('#ratings').classList.contains('hidden'), '显示答案和评分');
  document.querySelector('#ratings [data-rating="good"]').click();
  await until(() => application.state.read().reviewRecords.some(row => row.cardId === cardId), '写入复习评分');
  const review = await bridge.read();
  assert(review.reviewRecords.some(row => row.cardId === cardId && row.rating === 'good')
    && review.cards.some(card => card.id === cardId && card.dueAt > Date.now()), 'FSRS 计算和评分结果应持久保存');
  document.querySelector('#reviewDialog').close();
  document.querySelector('#reviewResultDialog').close();
  actions.showView('memos');
  document.querySelector('#newMemoBtn').click();
  await until(() => document.querySelector('#memoDialog').open, '新建备忘');
  document.querySelector('#memoTitle').value = memoTitle;
  document.querySelector('#memoClearTime').click();
  const memoForm = document.querySelector('#memoForm');
  const invalid = [...memoForm.elements].filter(control => control.willValidate && !control.validity.valid);
  assert(!invalid.length, `备忘表单校验：${invalid.map(control => `${control.id} ${control.validationMessage}`).join(', ')}`);
  memoForm.querySelector('button[type="submit"]').click();
  await until(() => !document.querySelector('#memoDialog').open, '保存备忘');
  assert((await bridge.read()).memos.some(memo => memo.title === memoTitle && memo.remindAt === null), '应保存未设提醒的备忘');

  actions.showView('plans');
  document.querySelector('[data-plan-action="new"]').click();
  const planForm = document.querySelector('[data-plan-form="new"]');
  planForm.elements.namedItem('name').value = planName;
  planForm.elements.namedItem('fixed').value = taskName;
  planForm.requestSubmit();
  await until(() => !planForm.closest('dialog')?.open, '保存计划');
  assert((await bridge.read()).plans.some(plan => plan.name === planName), '计划应写入数据库');
  document.querySelector('[data-plan-toggle="fixed"]').click();
  await until(() => document.querySelector('[data-plan-toggle="fixed"]')?.getAttribute('aria-pressed') === 'true', '固定任务打卡');
  assert((await bridge.read()).plans.some(hasPlanCheckIn), '打卡应写入数据库');

  actions.openPomodoro();
  const timerClick = name => document.querySelector(`#pomodoroPanel [data-pomodoro="${name}"]`).click();
  timerClick('start');
  await until(() => actions.pomodoroState()?.running, '开始番茄钟');
  timerClick('pause');
  await until(() => !actions.pomodoroState()?.running, '暂停番茄钟');
  timerClick('resume');
  await until(() => actions.pomodoroState()?.running, '继续番茄钟');
  timerClick('stop');
  await until(() => actions.pomodoroState()?.phase === 'idle', '结束短时间专注');
  timerClick('close');

  document.querySelector('#workspaceSearchButton').click();
  const search = document.querySelector('#workspaceSearchQuery');
  const runSearch = bridge.searchContent;
  try {
    let finishOld;
    bridge.searchContent = query => query === '旧结果' ? new Promise(resolve => { finishOld = resolve; }) : runSearch(query);
    search.value = '旧结果';
    const pending = actions.renderWorkspaceSearch();
    search.value = memoTitle;
    await actions.renderWorkspaceSearch();
    finishOld([{ kind: 'note', id, title: '过期搜索结果' }]);
    await pending;
    assert(document.querySelector('#workspaceSearchResults').textContent.includes(memoTitle), '较晚返回的旧搜索不能覆盖新结果');
  } finally { bridge.searchContent = runSearch; }
  search.value = memoTitle;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => document.querySelector('#workspaceSearchResults').textContent.includes(memoTitle)
    && document.querySelector('#workspaceSearchResults .product-search-item'), '工作空间搜索能找到刚保存的备忘');
  search.value = '精确搜索段落';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => document.querySelector('#workspaceSearchResults').textContent.includes('精确搜索段落'), '原生全文索引找到段落');
  const indexed = await invoke('plugin:memokeep-workspace|query_search', { terms: ['精确搜索段落'] });
  assert(indexed?.some(entry => entry.id === id), '全文结果应来自 SQLite 索引');
  document.querySelector('#workspaceSearchResults .product-search-item').click();
  await until(() => document.querySelector('#noteFindInput')?.value === '精确搜索段落', '搜索结果定位到正文并高亮');
  assert(document.querySelector('.ql-editor [data-memokeep-title="引用目标新标题"]'), '改名后引用应显示最新标题');
  document.querySelector('#noteFindClose').click();
  for (const name of ['home', 'cards', 'memos', 'plans', 'favorites', 'trash', 'plugins', 'settings', 'freeReview', 'statistics']) {
    const view = document.querySelector(`#${name}View`);
    if (view && actions.pluginViewAvailable?.(name) !== false) {
      actions.showView(name);
      assert(!view.classList.contains('hidden'), `${name} 页面应能显示`);
    }
  }
  actions.showView('settings');
  document.querySelector('[data-settings-panel="data"]').click();
  document.querySelector('#importBackupBtn').click();
  await until(() => document.querySelector('#backupRestorePreview')?.open, '设置恢复预览');
  assert((await bridge.read()).documents.some(note => note.id === id), '预览阶段应保留当前笔记');
  document.querySelector('#backupRestorePreview footer [data-backup-cancel]').click();
  await until(() => !document.querySelector('#backupRestorePreview'), '取消备份恢复预览');
  document.querySelector('#importBackupBtn').click();
  await until(() => document.querySelector('#backupRestorePreview')?.open, '重新打开恢复预览');
  document.querySelector('[data-backup-apply]').click();
  await until(() => !document.querySelector('#backupRestorePreview'), '确认还原');
  assert((await bridge.read()).documents.some(note => note.id === 'restore-smoke-note'), '应恢复便携备份');
  assert((await bridge.importBackup({ status: true })).canUndo, '恢复后应允许撤销');
  await until(() => !document.querySelector('#undoBackupRestoreBtn').disabled, '启用恢复撤销按钮');
  document.querySelector('#undoBackupRestoreBtn').click();
  await until(() => document.querySelector('#appConfirmDialog').open, '确认撤销恢复');
  document.querySelector('#appConfirmSubmit').click();
  await until(() => actions.documentById(id), '恢复撤销后重新载入工作区');
  assert((await bridge.read()).documents.some(note => note.id === id), '撤销应还原笔记');
  try {
    await invoke('plugin:memokeep-workspace|read', { scope: 'ios-local' });
    throw new Error('桌面不应能读取 iOS 范围');
  } catch (error) {
    assert(error?.code === 'PERMISSION_DENIED', `错误范围应被拒绝：${error?.message || error}`);
  }
}

check().then(() => invoke('smoke_finish', { error: null }),
  error => invoke('smoke_finish', { error: error?.message || String(error) }));
