const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');

const webRoot = path.join(__dirname, '../web');
const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const appCode = fs.readFileSync(path.join(webRoot, 'legacy/application.js'), 'utf8') + '\n' + fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8');
const workspaceCode = fs.readFileSync(path.join(webRoot, 'card-workspace.js'), 'utf8');

function setup() {
  const window = domino.createWindow(html, 'http://localhost/');
  const document = window.document;
  const nodeListPrototype = Object.getPrototypeOf(document.querySelectorAll('button'));
  if (!nodeListPrototype[Symbol.iterator]) nodeListPrototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
  const openPopovers = new Set();
  // Domino supplies the real DOM tree; these shims only cover missing browser APIs.
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, 'dataset')) {
    Object.defineProperty(window.Element.prototype, 'dataset', { get() {
      const element = this;
      return new Proxy({}, {
        get: (_, key) => element.getAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
        set: (_, key, value) => { element.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true; }
      });
    } });
    window.Element.prototype.append = function (...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node)); };
    window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 });
  }
  const createElement = document.createElement.bind(document);
  Object.defineProperty(document, 'createElement', { value(tag) {
    const element = createElement(tag);
    const matches = element.matches.bind(element);
    Object.defineProperty(element, 'matches', { value: selector => selector === ':popover-open' ? openPopovers.has(element) : matches(selector) });
    element.showPopover = () => {
      openPopovers.add(element);
      const event = new window.Event('toggle'); event.newState = 'open'; element.dispatchEvent(event);
    };
    element.hidePopover = () => {
      if (!openPopovers.delete(element)) return;
      const event = new window.Event('toggle'); event.newState = 'closed'; element.dispatchEvent(event);
    };
    return element;
  } });
  const queryAll = document.querySelectorAll.bind(document);
  Object.defineProperty(document, 'querySelectorAll', { value(selector) {
    if (!selector.includes(':popover-open')) return queryAll(selector);
    return [...queryAll(selector.replaceAll(':popover-open', ''))].filter(element => openPopovers.has(element));
  } });
  const calls = { details: [], edits: [], organizations: [], openedNotes: [], saves: 0, confirm: false };
  const context = vm.createContext({ window, document, Element: window.Element, console, URLSearchParams,
    noteDraftTab: () => null,
    structuredClone, TextEncoder, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} }, requestAnimationFrame() {}
  });
  vm.runInContext(fs.readFileSync(path.join(webRoot, 'directory-tree.js'), 'utf8'), context);
  vm.runInContext(workspaceCode, context);
  vm.runInContext(fs.readFileSync(path.join(webRoot, 'card-import.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(webRoot, 'review-presentation.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(webRoot, 'sidebar-tools.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(webRoot, 'note-tags.js'), 'utf8'), context);
  for (const file of ["vendor/ts-fsrs/index.umd", "review-session", "fsrs-scheduler"]) vm.runInContext(fs.readFileSync(path.join(webRoot, file + ".js"), "utf8"), context);
  for (const name of ["naming", "inline-cards", "image-references", "queries", "card-list"]) vm.runInContext(fs.readFileSync(path.join(webRoot, "domain", name + ".js"), "utf8"), context);
  for (const name of ["storage-adapter", "save-coordinator", "sync-coordinator"]) vm.runInContext(fs.readFileSync(path.join(webRoot, "persistence", name + ".js"), "utf8"), context);
  for (const file of ["state/application-state", "application/card-operations", "application/card-trash", "application/card-runtime", "application/memo-operations", "application/settings-operations", "application/knowledge-operations", "application/review-transactions", "application/review-operations", "application/review-runtime"]) vm.runInContext(fs.readFileSync(path.join(webRoot, file + ".js"), "utf8"), context);
  for (const file of ["editor/session", "editor/save-session", "editor/content-transactions", "editor/quill-transactions", "views/note-tabs", "views/review", "views/review-events", "views/card-list", "views/card-bulk", "views/card-list-events", "views/card-editor", "views/card-detail", "views/card-dialog-events"]) vm.runInContext(fs.readFileSync(path.join(webRoot, file + ".js"), "utf8"), context);
  for (const file of ["views/shell", "bootstrap/composition", "bootstrap/startup"]) vm.runInContext(fs.readFileSync(path.join(webRoot, file + ".js"), "utf8"), context);
  require('./shell-fixture.cjs').loadShellModules(context, webRoot);
  vm.runInContext(`const fixtureCreateCardEditor = MemoKeepViews.createCardEditor;
    MemoKeepViews.createCardEditor = dependencies => ({ ...fixtureCreateCardEditor(dependencies),
      openCardDialog: (...args) => openCardDialog(...args) });`, context);
  vm.runInContext(appCode, context);
  require('./shell-fixture.cjs').bindShellFixture(context);
  // Expose module callbacks to the existing VM fixture, without production globals.
  Object.assign(context, vm.runInContext(`({ renderCards: application.views.cards.render,
    handleCardListClick: application.views.cardEvents.handleCardListClick,
    handleCardListKeydown: application.views.cardEvents.handleCardListKeydown,
    bindCardAndReviewEvents: () => { application.views.cardEvents.bind(); application.views.cardDialogs.bind(); application.views.reviewEvents.bind(); } })`, context));
  const bindOrganization = context.bindCardWorkspace;
  Object.assign(context, {
    bindCardWorkspace() {}, bindSidebarQuickTools() {},
    save: async () => { calls.saves += 1; },
    showToast() {}, renderTrash() {},
    openCardDetail: card => calls.details.push(card?.id),
    openCardDialog: card => calls.edits.push(card?.id || 'new'),
    openCardOrganization: (...args) => calls.organizations.push(args),
    openCardNotebookView: id => calls.openedNotes.push(id),
    leaveActiveNoteEditor: async () => true,
    showConfirmDialog: async () => calls.confirm,
    renderAll: () => context.renderCards()
  });
  Object.assign(context, vm.runInContext(`({
    deleteCardById: application.views.cardBulk.deleteCardById, moveSelectedCards: application.views.cardBulk.moveSelectedCards,
    trashCards: application.operations.cardTrash.trashCards, restoreCardTrash: application.operations.cardTrash.restoreCardTrash
  })`, context));
  vm.runInContext('application.views.cardBulk.showCardUndo = () => {};', context);
  vm.runInContext('application.persistence.save = () => save(); application.editor.session.leaveActiveNoteEditor = () => leaveActiveNoteEditor();', context);
  vm.runInContext(`Object.defineProperty(application.persistence.storage, 'isDesktop', { get: () => true });
    application.persistence.storage.write = async proposal => { await save(); return structuredClone(proposal); };`, context);
  vm.runInContext('application.views.cardDetail.openCardDetail = (...args) => openCardDetail(...args);', context);
  vm.runInContext(`const fixtureTimestamp = Date.now(); data = normalize({
    version: 2, cardOrganizationVersion: 1,
    cardFolders: [{ id: 'work', name: '工作学习' }, { id: 'other', name: '英语积累' }, { id: 'empty', name: '读书摘录' }],
    cardNotebooks: [
      { id: 'backend', name: '后端基础', folderId: 'work', sourceDocumentId: 'doc1' },
      { id: 'tools', name: '效率工具', folderId: 'work', sourceDocumentId: 'doc2' },
      { id: 'english', name: '英语', folderId: 'other', sourceDocumentId: 'doc3' }
    ],
    knowledgeBases: [{ id: 'lib1', name: '研发知识库' }, { id: 'lib2', name: '实践记录' }],
    documents: [{ id: 'doc1', title: '来源 <笔记>', knowledgeBaseId: 'lib1' }, { id: 'doc2', title: '效率工具', knowledgeBaseId: 'lib2' }, { id: 'doc3', title: '英语' }],
    items: [{ id: 'item1', documentId: 'doc1' }, { id: 'item2', documentId: 'doc2' }],
    cards: [
      { id: 'due', cardNotebookId: 'backend', knowledgeBaseId: 'lib1', knowledgeItemId: 'item1', question: 'HTTP <script>缓存</script>', answer: '条件请求验证版本', tags: ['network'], reviewCount: 3, strength: 2, dueAt: fixtureTimestamp - 1000 },
      { id: 'new', cardNotebookId: 'backend', knowledgeBaseId: 'lib1', question: '数据库索引', answer: '有序数据结构', reviewCount: 0, dueAt: fixtureTimestamp - 1000 },
      { id: 'paused', cardNotebookId: 'tools', knowledgeBaseId: 'lib2', knowledgeItemId: 'item2', question: '任务拆分', answer: '清晰的完成标准', status: 'paused', reviewCount: 5, strength: 4, dueAt: fixtureTimestamp - 1000 },
      { id: 'outside', cardNotebookId: 'english', knowledgeBaseId: 'lib2', question: 'Outside scope', answer: 'Keep intact', reviewCount: 2, dueAt: fixtureTimestamp - 1000 },
      { id: 'unfiled', question: '未分类卡片', answer: '独立内容', reviewCount: 0, dueAt: fixtureTimestamp + 86400000 }
    ].map(card => ({ ...card, createdAt: new Date(fixtureTimestamp).toISOString(), updatedAt: new Date(fixtureTimestamp).toISOString() }))
  }); persistedData = structuredClone(data); applicationDataReady = true; application.cards.runtime.cardScope = { type: 'folder', id: 'work' };`, context);
  context.bindCardAndReviewEvents();
  document.querySelector('.card-nav-group').classList.remove('tree-collapsed');
  context.renderCards();
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const evaluate = code => vm.runInContext(code, context);
  const listClick = selector => context.handleCardListClick({ target: $(selector) });
  const visible = () => $$('[data-card-row]').map(row => row.dataset.cardRow);
  return { context, window, document, calls, $, $$, evaluate, listClick, visible, openPopovers, bindOrganization };
}

test('parent directory includes descendant notebooks and cards, with full breadcrumb paths', () => {
  const { $, evaluate, visible, context } = setup();
  evaluate(`data.cardFolders.find(folder => folder.id === 'other').parentId = 'work';`);
  context.renderCards();
  assert.deepEqual(visible(), ['due', 'new', 'paused', 'outside']);
  assert.equal($('#cardWorkspaceSubtitle').textContent, '4 张卡片 · 到期 3 张');
  assert.ok(!$('[data-open-card-notebook="english"]'));
  evaluate(`application.cards.runtime.cardScope = { type: 'folder', id: 'other' };`);
  context.renderCards();
  assert.equal($('#cardBreadcrumb').textContent, '记忆卡片 / 工作学习 / 英语积累');
});

test('directory counts, notebook shortcuts and table content follow scope without HTML interpretation', () => {
  const { $, $$, evaluate, visible } = setup();
  assert.equal($('#cardWorkspaceSubtitle').textContent, '3 张卡片 · 到期 2 张');
  assert.equal($$('[data-open-card-notebook]').length,0);
  assert.deepEqual(visible(), ['due', 'new', 'paused']);
  assert.equal($('.card-content-cell strong').textContent, 'HTTP <script>缓存</script>');
  assert.equal($$('.card-content-cell .card-answer-preview').length, 0);
  assert.ok($('#allCards').textContent.includes('条件请求验证版本'));
  assert.equal($('.card-row-meta [data-card-tag]').textContent, '#network');
  assert.equal($$('#allCards script').length, 0);
  assert.equal($('#cardStartReviewBtn span').textContent, '复习此目录 · 2');
  evaluate("application.cards.runtime.cardScope = { type: 'all', id: '' }; renderCards()");
  assert.match($('#cardWorkspaceSubtitle').textContent, /^5 张卡片/);
  assert.ok(!$('#cardNotebookSection'));
  evaluate("application.cards.runtime.cardScope = { type: 'unfiled', id: '' }; renderCards()");
  assert.deepEqual(visible(), ['unfiled']);
  assert.equal($('#cardWorkspaceSubtitle').textContent, '1 张卡片');
});

test('search, stage and library filters intersect, and empty-state reset preserves the directory', async () => {
  const { $, evaluate, visible, listClick } = setup();
  $('#cardSearch').value = 'NETWORK';
  evaluate("application.cards.runtime.activeCardFilter = 'due'; application.cards.runtime.activeCardLibraryFilter = 'lib1'; renderCards()");
  assert.deepEqual(visible(), ['due']);
  assert.equal($('#cardTotal').textContent, '1 / 3 张卡片');
  evaluate("application.cards.runtime.activeCardLibraryFilter = 'lib2'; renderCards()");
  assert.deepEqual(visible(), []);
  assert.ok($('#selectAllCards').disabled);
  await listClick('[data-card-empty-action="reset"]');
  assert.deepEqual(visible(), ['due', 'new', 'paused']);
  assert.equal($('#cardWorkspaceTitle').textContent, '工作学习');
  assert.equal($('#cardSearch').value, '');
});

test('selection does not open details; select-all and bulk pause act only on selected cards', async () => {
  const { $, evaluate, listClick, calls } = setup();
  $('#cardSearch').value = '缓存'; evaluate('renderCards()');
  $('#selectAllCards').checked = true; await listClick('#selectAllCards');
  assert.equal(evaluate('JSON.stringify([...application.cards.runtime.selectedCardIds])'), '["due"]');
  assert.equal(calls.details.length, 0);
  assert.ok(!$('#cardBulkSummary').classList.contains('hidden'));
  $('#cardSearch').value = ''; evaluate('renderCards()');
  assert.ok($('#selectAllCards').indeterminate);
  await evaluate("application.views.cardBulk.setSelectedCardsStatus('paused')");
  assert.equal(evaluate("data.cards.find(card => card.id === 'due').status"), 'paused');
  assert.equal(evaluate("data.cards.find(card => card.id === 'new').status"), 'active');
  assert.equal(evaluate("data.cards.find(card => card.id === 'outside').status"), 'active');
  assert.ok($('#cardBulkSummary').classList.contains('hidden'));
  assert.equal(calls.saves, 1);
});

test('row menu and edit controls do not open detail; cancelled delete preserves data and confirmed delete is recoverable', async () => {
  const { $, context, window, calls, evaluate, listClick, openPopovers } = setup();
  $('[data-card-more="due"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(openPopovers.has($('#cardRowMenu')));
  assert.equal(calls.details.length, 0);
  await $('#cardRowMenu').onclick({ target: $('#cardRowMenu [data-edit-card]') });
  assert.deepEqual(calls.edits, ['due']);
  assert.equal(calls.details.length, 0);
  await listClick('[data-edit-card="new"]');
  assert.deepEqual(calls.edits, ['due', 'new']);
  await context.deleteCardById('due');
  assert.equal(evaluate('data.cards.length'), 5);
  assert.equal(calls.saves, 0);
  calls.confirm = true;
  await context.deleteCardById('due');
  assert.equal(evaluate('data.cards.length'), 4);
  assert.equal(evaluate('data.trash[0].card.reviewCount'), 3);
  assert.equal(evaluate('data.trash[0].card.knowledgeItemId'), 'item1');
  assert.equal(evaluate('data.trash[0].notebook.id'), 'backend');
  assert.equal(evaluate('data.trash[0].folder.id'), 'work');
});

test('empty folders directly create cards without a notebook and keep historical notes untouched', async () => {
  const { $, evaluate, calls, context, listClick } = setup();
  const history=evaluate('JSON.stringify([data.cardNotebooks,data.documents,data.cardDocuments])');
  evaluate("application.cards.runtime.cardScope = { type: 'folder', id: 'empty' }; renderCards()");
  assert.equal($('#cardWorkspaceSubtitle').textContent,'0 张卡片');
  assert.equal($('#cardStartReviewBtn').disabled,true);
  $('#cardNotebookSelect').innerHTML=context.cardNotebookOptions();
  await listClick('[data-card-empty-action="card"]');
  assert.equal(calls.edits.at(-1),'new');
  assert.equal($('#cardNotebookSelect').value,'folder:empty');
  assert.equal(calls.organizations.length,0);
  assert.equal(evaluate('JSON.stringify([data.cardNotebooks,data.documents,data.cardDocuments])'),history);
});

test('row keyboard activation opens the editor, but embedded controls never activate it', () => {
  const { context, $, calls } = setup();
  let prevented = 0;
  const key = target => context.handleCardListKeydown({ target, key: 'Enter', preventDefault() { prevented++; } });
  key($('[data-card-row="due"]'));
  key($('[data-card-more="new"]'));
  key($('[data-select-card="new"]'));
  assert.deepEqual(calls.edits, ['due']);
  assert.deepEqual(calls.details, []);
  assert.equal(prevented, 1);
});

test('row menu pauses and resumes only its card, and new-card menu keeps the folder destination', async () => {
  const { $, context, window, evaluate, calls, openPopovers } = setup();
  const openRowMenu = () => $('[data-card-more="due"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  openRowMenu();
  await $('#cardRowMenu').onclick({ target: $('#cardRowMenu [data-toggle-card]') });
  assert.equal(evaluate("data.cards.find(card => card.id === 'due').status"), 'paused');
  assert.equal(evaluate("data.cards.find(card => card.id === 'new').status"), 'active');
  assert.equal(openPopovers.size, 0);
  openRowMenu();
  assert.match($('#cardRowMenu [data-toggle-card]').textContent, /恢复/);
  await $('#cardRowMenu').onclick({ target: $('#cardRowMenu [data-toggle-card]') });
  assert.equal(evaluate("data.cards.find(card => card.id === 'due').status"), 'active');
  assert.equal(calls.details.length, 0);
  // The real dialog supplies options; the dialog spy above only records opens.
  $('#cardNotebookSelect').innerHTML = context.cardNotebookOptions();
  $('#newCardBtn').onclick();
  assert.equal(openPopovers.size,0);
  assert.equal(calls.edits.at(-1), 'new');
  assert.equal($('#cardNotebookSelect').value, 'folder:work');
  assert.equal(openPopovers.size, 0);
});

function fillPages(fixture, count = 24) {
  fixture.evaluate(`data.cards = Array.from({ length: ${count} }, (_, index) => ({ ...data.cards[0], id: 'page-' + index, question: '分页问题 ' + index, tags: ['分页'], status: 'active' })); renderCards();`);
}

test('pagination renders 10 cards per page, keeps total counts, and opens the same editor after paging', async () => {
  const f = setup(); fillPages(f);
  assert.equal(f.visible().length, 10);
  assert.equal(f.$('#cardTotal').textContent, '24 张卡片');
  assert.ok(f.$('[aria-label="上一页"]').disabled);
  f.$('#cardPagination').onclick({ target: f.$('[aria-label="下一页"]') });
  assert.equal(f.visible()[0], 'page-10');
  assert.equal(f.visible().length, 10);
  await f.listClick('[data-card-row="page-10"]');
  assert.deepEqual(f.calls.edits, ['page-10']);
  assert.deepEqual(f.calls.details, []);
  f.$('#cardPagination').onclick({ target: f.$('[aria-label="第 3 页"]') });
  assert.equal(f.visible().length, 4);
  assert.ok(f.$('[aria-label="下一页"]').disabled);
  assert.equal(f.$('#cardPageStatus').textContent, '第 3 / 3 页 · 每页 10 张');
});

test('select-all is page-local and selections survive paging for bulk operations', async () => {
  const f = setup(); fillPages(f);
  f.$('#selectAllCards').checked = true; await f.listClick('#selectAllCards');
  assert.equal(f.evaluate('application.cards.runtime.selectedCardIds.size'), 10);
  f.$('#cardPagination').onclick({ target: f.$('[aria-label="下一页"]') });
  assert.equal(f.$('#selectAllCards').checked, false);
  f.$('#selectAllCards').checked = true; await f.listClick('#selectAllCards');
  assert.equal(f.evaluate('application.cards.runtime.selectedCardIds.size'), 20);
  await f.evaluate("application.views.cardBulk.setSelectedCardsStatus('paused')");
  assert.equal(f.evaluate("data.cards.filter(card => card.status === 'paused').length"), 20);
  assert.equal(f.evaluate("data.cards.filter(card => card.status === 'active').length"), 4);
});

test('search and scope reset pagination; shrinking results clamp the page and empty results hide pagination', () => {
  const f = setup(); fillPages(f);
  f.evaluate('application.cards.runtime.cardPage = 3; renderCards()');
  f.$('#cardSearch').value = '分页问题 1'; f.context.renderCards();
  assert.equal(f.evaluate('application.cards.runtime.cardPage'), 1);
  assert.equal(f.$('#cardTotal').textContent, '11 / 24 张卡片');
  f.$('#cardSearch').value = ''; f.context.renderCards();
  f.evaluate('application.cards.runtime.cardPage = 3; renderCards(); data.cards = data.cards.slice(0, 11); renderCards()');
  assert.equal(f.evaluate('application.cards.runtime.cardPage'), 2);
  assert.deepEqual(f.visible(), ['page-10']);
  f.evaluate("application.cards.runtime.cardScope = {type:'all', id:''}; renderCards()");
  assert.equal(f.evaluate('application.cards.runtime.cardPage'), 1);
  f.$('#cardSearch').value = '没有匹配的内容'; f.context.renderCards();
  assert.equal(f.$('#cardPagination').hidden, true);
  assert.equal(f.$('#selectAllCards').disabled, true);
});

test('large collections show bounded page controls with ellipses', () => {
  const f = setup(); fillPages(f, 1000);
  f.evaluate('application.cards.runtime.cardPage = 50; renderCards()');
  assert.ok(f.$$('#cardPagination button').length <= 9);
  assert.equal(f.$$('.card-page-gap').length, 2);
  assert.ok(f.$('[aria-label="第 1 页"]'));
  assert.ok(f.$('[aria-label="第 100 页"]'));
});


test('row content and edit icon open the same editor exactly once; checkboxes and menus do not', async () => {
  const f = setup();
  await f.listClick('[data-card-row="due"] .card-content-cell strong');
  await f.listClick('[data-edit-card="due"]');
  assert.deepEqual(f.calls.edits, ['due', 'due']);
  await f.listClick('[data-select-card="due"]');
  await f.listClick('[data-card-more="due"]');
  assert.deepEqual(f.calls.edits, ['due', 'due']);
  assert.deepEqual(f.calls.details, []);
});

test('note validation rejects repeated questions with same or different answers before synchronization', () => {
  const f = setup();
  for (const content of ['a -> c\na -> c', 'a -> c\n  a -> d']) {
    assert.match(f.context.validateNotebookCardQuestions('doc1', content), /第 2 行.*重复/);
    const before = f.evaluate('JSON.stringify(data)');
    assert.throws(() => f.context.syncInlineCards({id:'doc1',content,metadata:{editorMode:'card'}}, f.context.MemoKeepDomain.parseInlineCards(content)), /重复/);
    assert.equal(f.evaluate('JSON.stringify(data)'), before);
  }
  assert.equal(f.context.validateNotebookCardQuestions('doc1', 'a -> c\nb -> c'), '');
  assert.equal(f.context.validateNotebookCardQuestions('doc1', 'a -> c\n```\na -> d\n```'), '');
  assert.match(f.context.validateNotebookCardQuestions('doc1', '数据库索引 -> 不同答案'), /已存在/);
  assert.equal(f.context.validateNotebookCardQuestions('doc2', '数据库索引 -> 不同答案'), '');
});

test('bulk move with colliding questions leaves all cards and selection unchanged', async () => {
  const f = setup();
  f.evaluate("data.cards.find(card => card.id === 'outside').question = data.cards[0].question; application.cards.runtime.selectedCardIds.add('outside');");
  f.$('#moveCardsLibrary').innerHTML = '<option value="backend">后端基础</option>';
  f.$('#moveCardsLibrary').value = 'backend';
  await f.context.moveSelectedCards({preventDefault(){}});
  assert.equal(f.calls.saves, 0);
  assert.equal(f.evaluate("data.cards.find(card => card.id === 'outside').cardNotebookId"), 'english');
  assert.equal(f.evaluate('application.cards.runtime.selectedCardIds.size'), 1);
});

test('real input events reject duplicate typing and paste immediately, before save', () => {
  const f = setup();
  const editor = f.document.createElement('textarea');
  editor.value = 'a -> b\na1 -> b\n';
  editor.selectionStart = editor.selectionEnd = editor.value.length;
  editor.setSelectionRange = (start, end) => { editor.selectionStart = start; editor.selectionEnd = end; };
  const messages = [];
  f.context.bindCardQuestionInputGuard(editor, value => f.context.validateNotebookCardQuestions('doc1', value), message => messages.push(message));
  const original = editor.value;
  const input = value => { editor.dispatchEvent(new f.window.Event('beforeinput')); editor.value = value; editor.dispatchEvent(new f.window.Event('input')); };
  input(original + 'a -> a');
  assert.equal(editor.value, original);
  assert.match(messages.at(-1), /已拦截.*第 3 行/);
  input(original + 'a -> b\nx -> y');
  assert.equal(editor.value, original);
  input(original + 'a2 -> c');
  assert.equal(editor.value, original + 'a2 -> c');
  assert.equal(messages.at(-1), '');
});

test('composition waits for completion; pre-existing duplicate drafts can be repaired', () => {
  const f = setup();
  const editor = f.document.createElement('textarea');
  editor.value = '题目 -> 答案\n';
  editor.setSelectionRange = () => {};
  const messages = [];
  f.context.bindCardQuestionInputGuard(editor, value => f.context.validateNotebookCardQuestions('doc1', value), message => messages.push(message));
  editor.dispatchEvent(new f.window.Event('compositionstart'));
  editor.value += '题目 -> 新答案';
  editor.dispatchEvent(new f.window.Event('input'));
  assert.match(editor.value, /新答案/);
  editor.dispatchEvent(new f.window.Event('compositionend'));
  assert.equal(editor.value, '题目 -> 答案\n');
  assert.match(messages.at(-1), /已拦截/);
  editor.value = 'a -> b\na -> c';
  editor.dispatchEvent(new f.window.Event('beforeinput'));
  editor.value = 'a -> b\na2 -> c';
  editor.dispatchEvent(new f.window.Event('input'));
  assert.equal(editor.value, 'a -> b\na2 -> c');
  assert.equal(messages.at(-1), '');
});

test('tag filtering supports any/all, intersects existing filters, and search preserves result count', () => {
  const f = setup();
  f.evaluate("data.cards[0].tags = ['Agent','工具调用','Agent']; data.cards[1].tags = ['Agent']; data.cards[2].tags = ['工具调用']; renderCards(); application.cards.runtime.selectedCardTags = new Set(['Agent','工具调用']); renderCards();");
  assert.deepEqual(f.visible(), ['due', 'new', 'paused']);
  assert.equal(f.$('[data-filter-tag="Agent"]').parentNode.querySelector('small').textContent, '2');
  f.$('#cardTagModes').onclick({target:f.$('[data-tag-mode="all"]')});
  assert.deepEqual(f.visible(), ['due']);
  f.$('#cardTagSearch').value = '工具'; f.$('#cardTagSearch').oninput();
  assert.equal(f.$$('[data-filter-tag]').length, 1);
  assert.match(f.$('#cardSearchSummary').textContent, /找到 1 张卡片/);
  f.evaluate("application.cards.runtime.activeCardLibraryFilter = 'lib2'; renderCards()");
  assert.deepEqual(f.visible(), []);
  assert.ok(f.$('[data-card-empty-action="reset"]'));
});

test('tag checkbox and row tag actions update results without opening the editor; removal and clear restore results', async () => {
  const f = setup();
  f.evaluate("data.cards[0].tags = ['Agent']; data.cards[1].tags = ['Other']; renderCards()");
  const input = f.$('[data-filter-tag="Agent"]'); input.checked = true;
  f.$('#cardTagOptions').onchange({target:input});
  assert.deepEqual(f.visible(), ['due']);
  assert.equal(f.$('#cardTagFilterLabel').textContent, '标签 · 1');
  f.$('#cardTagApplied').onclick({target:f.$('[data-remove-filter-tag="Agent"]')});
  assert.equal(f.visible().length, 3);
  await f.listClick('[data-card-tag="Other"]');
  assert.deepEqual(f.visible(), ['new']);
  assert.deepEqual(f.calls.edits, []);
  f.$('#cardTagClear').onclick();
  assert.equal(f.visible().length, 3);
  assert.ok(f.$('#cardTagApplied').hidden);
});

test('tag changes reset pages and switching directory clears selected tags', () => {
  const f = setup(); fillPages(f, 24);
  f.evaluate("data.cards.forEach((card,i) => card.tags = i < 14 ? ['Agent'] : ['RAG']); renderCards(); application.cards.runtime.cardPage = 3; renderCards(); application.cards.runtime.selectedCardTags.add('Agent'); renderCards()");
  assert.equal(f.evaluate('application.cards.runtime.cardPage'), 1);
  assert.equal(f.$('#cardTotal').textContent, '14 / 24 张卡片');
  assert.equal(f.visible().length, 10);
  f.evaluate("application.cards.runtime.cardScope = {type:'all',id:''}; renderCards()");
  assert.equal(f.evaluate('application.cards.runtime.selectedCardTags.size'), 0);
  assert.equal(f.$('#cardTotal').textContent, '24 张卡片');
});

test('inline tag rows preserve identity through reorder, insertion, and question/answer edits', () => {
  const f = setup();
  const rows = [{raw:'a -> b',itemId:'a',tags:['Agent']},{raw:'c -> d',itemId:'c',tags:['RAG']}];
  const reordered = f.context.reconcileInlineTagRows(rows, 'c -> d\na -> b');
  assert.equal(reordered[1].itemId, 'a');
  const edited = f.context.reconcileInlineTagRows(reordered, 'c -> d\na2 -> new');
  assert.equal(edited[1].tags[0], 'Agent');
  const inserted = f.context.reconcileInlineTagRows(edited, 'new -> answer\nc -> d\na2 -> new');
  assert.equal(inserted[2].itemId, 'a');
  assert.equal(inserted[0].tags.length, 0);
});

test('inline tag save and reload keeps tags and review history when question changes', () => {
  const f = setup();
  f.evaluate(`data.items = []; data.cards = []; const doc = documentById('doc1'); doc.content = 'a -> b'; doc.metadata = {editorMode:'card', inlineTagRows:[{raw:'a -> b',itemId:'stable',tags:['Agent','基础概念']}]}; syncInlineCards(doc, application.domain.parseInlineCards(doc.content)); data.cards[0].reviewCount = 7; data.cards[0].strength = 4;`);
  assert.equal(f.evaluate('data.cards[0].tags.join(",")'), 'Agent,基础概念');
  f.evaluate(`documentById('doc1').content = 'renamed -> changed'; documentById('doc1').metadata.inlineTagRows[0].raw = 'renamed -> changed'; syncInlineCards(documentById('doc1'), application.domain.parseInlineCards(documentById('doc1').content));`);
  assert.equal(f.evaluate('data.cards.length'), 1);
  assert.equal(f.evaluate('data.cards[0].reviewCount'), 7);
  assert.equal(f.evaluate('data.cards[0].question'), 'renamed');
  assert.equal(f.evaluate("initialInlineTagRows(documentById('doc1'))[0].tags.join(',')"), 'Agent,基础概念');
  f.evaluate(`documentById('doc1').metadata.inlineTagRows[0].tags = []; syncInlineCards(documentById('doc1'), application.domain.parseInlineCards(documentById('doc1').content));`);
  assert.equal(f.evaluate('data.cards[0].tags.length'), 0);
});

test('delete card ranges remove complete first/middle/last/only rows and preserve adjacent content', () => {
  const f = setup();
  for (const [text, index, expected] of [['a -> b\nc -> d',0,'c -> d'], ['a -> b\nc -> d',1,'a -> b'], ['a -> b',0,''], ['a -> b\nc -> d\ne -> f',1,'a -> b\ne -> f']]) {
    const range = f.context.inlineCardLineDeleteRange(text,index);
    assert.equal(text.slice(0,range.start)+text.slice(range.end),expected);
  }
  assert.equal(f.context.inlineCardLineDeleteRange('普通文字',0),null);
});

test('directory deletion synchronizes note lines and tags, cannot regenerate on save, and restores with history', async () => {
  const f = setup();
  f.evaluate(`data.items=[];data.cards=[];const doc=documentById('doc1');doc.content='a -> b\\nc -> d\\ne -> f';doc.metadata={editorMode:'card',inlineTagRows:[{raw:'a -> b',itemId:'ia',tags:['A']},{raw:'c -> d',itemId:'ic',tags:['C']},{raw:'e -> f',itemId:'ie',tags:['E']}]};syncInlineCards(doc,application.domain.parseInlineCards(doc.content));data.cards[0].reviewCount=8;`);
  const ids = f.evaluate('data.cards.slice(0,2).map(card=>card.id)');
  await f.context.trashCards(ids);
  assert.equal(f.evaluate("documentById('doc1').content"), 'e -> f');
  assert.equal(f.evaluate("data.items[0].sourceLocation.line"),1);
  f.evaluate("syncInlineCards(documentById('doc1'),application.domain.parseInlineCards(documentById('doc1').content))");
  assert.equal(f.evaluate('data.cards.length'),1);
  const entries = f.evaluate('data.trash.map(entry=>entry.id)');
  assert.equal(await f.context.restoreCardTrash(entries),2);
  assert.equal(f.evaluate("documentById('doc1').content"), 'a -> b\nc -> d\ne -> f');
  assert.equal(f.evaluate("data.cards.find(card=>card.question==='a').reviewCount"),8);
  assert.equal(f.evaluate("data.cards.find(card=>card.question==='a').tags[0]"),'A');
  await f.context.trashCards(f.evaluate('data.cards.map(card=>card.id)'));
  assert.equal(f.evaluate("documentById('doc1').content"),'');
  assert.equal(f.evaluate("documentById('doc1').metadata.inlineCardCount"),0);
});

test('failed deletion rolls back card, note text, items and trash together', async () => {
  const f=setup();
  f.evaluate(`data.items=[];data.cards=[];const doc=documentById('doc1');doc.content='a -> b';doc.metadata={editorMode:'card'};syncInlineCards(doc,application.domain.parseInlineCards(doc.content));`);
  const before=f.evaluate('JSON.stringify(data)');
  f.context.save=async()=>{throw new Error('disk failed')};
  await assert.rejects(f.context.trashCards(f.evaluate('data.cards.map(card=>card.id)')),/disk failed/);
  assert.equal(f.evaluate('JSON.stringify(data)'),before);
});

async function deleteFolderFromMenu(f, id) {
  if (!f.organizationBound) { f.bindOrganization(); f.organizationBound = true; }
  await f.$('#cardTree').onclick({ target: f.$(`[data-card-organize="folder"][data-organize-id="${id}"]`) });
  const button = f.$('[data-card-menu-action="delete"]');
  await button.parentNode.onclick({ target: button });
}

test('deleting a card folder removes its subtree and notebooks, preserves other data and restores notes with history', async () => {
  const f = setup();
  f.evaluate(`data.cardFolders.push({id:'child',name:'子目录',parentId:'work'});data.cardNotebooks.push({id:'nested',name:'子笔记',folderId:'child'});data=normalize(data);data.cardDocuments[0].content='问题 -> 答案';data.items.push({id:'nested-item',documentId:'card-document-nested',sourceLocation:{line:1}});data.cards.push({...data.cards[0],id:'nested-card',cardNotebookId:'nested',knowledgeItemId:'nested-item'});renderCards();`);
  const unrelated = f.evaluate('JSON.stringify({documents:data.documents,other:data.cards.find(c=>c.id==="outside")})');
  f.calls.confirm = true;
  await deleteFolderFromMenu(f, 'work');
  assert.equal(f.evaluate('data.cardFolders.some(f=>["work","child"].includes(f.id))'), false);
  assert.equal(f.evaluate('data.cardNotebooks.some(n=>["backend","tools","nested"].includes(n.id))'), false);
  assert.equal(f.evaluate('data.cardDocuments.some(d=>d.id==="card-document-nested")'), false);
  assert.equal(f.evaluate('data.cards.some(c=>["due","new","paused","nested-card"].includes(c.id))'), false);
  assert.equal(f.evaluate('JSON.stringify({documents:data.documents,other:data.cards.find(c=>c.id==="outside")})'), unrelated);
  assert.equal(f.evaluate('data.trash.length'), 3);
  f.evaluate('data=normalize(data)');
  assert.equal(f.evaluate('activeCardNotebooks().length'), 1);
  await f.context.restoreCardNotebookTrash(f.evaluate('data.trash.find(e=>e.notebook.id==="nested").id'));
  assert.equal(f.evaluate('data.cardNotebooks.find(n=>n.id==="nested").folderId'), 'child');
  assert.equal(f.evaluate('data.cardFolders.find(f=>f.id==="child").parentId'), 'work');
  assert.equal(f.evaluate('data.cards.find(c=>c.id==="nested-card").reviewCount'), 3);
  assert.equal(f.evaluate('data.cardDocuments.find(d=>d.id==="card-document-nested").content'), '问题 -> 答案');
  assert.equal(f.evaluate('data.items.some(i=>i.id==="nested-item")'), true);
  const beforeRestore = f.evaluate('JSON.stringify(data)');
  f.context.save = async () => { throw new Error('restore failed'); };
  await assert.rejects(f.context.restoreCardNotebookTrash(f.evaluate('data.trash[0].id')), /restore failed/);
  assert.equal(f.evaluate('JSON.stringify(data)'), beforeRestore);
});

test('cancelled folder deletion and failed save preserve the entire collection', async () => {
  const f=setup(), before=f.evaluate('JSON.stringify(data)');
  await deleteFolderFromMenu(f,'work');
  assert.equal(f.evaluate('JSON.stringify(data)'),before);
  f.calls.confirm=true; f.context.save=async()=>{throw new Error('disk failed')};
  await assert.rejects(deleteFolderFromMenu(f,'work'),/disk failed/);
  assert.equal(f.evaluate('JSON.stringify(data)'),before);
});

test('direct folder ownership survives normalization and coexists with historical notebook ownership',()=>{
 const {evaluate,context,visible}=setup();
 evaluate(`data.cards.push({...data.cards[0],id:'direct',question:'直接归属',cardNotebookId:null,cardFolderId:'work'});renderCards();`);
 assert.ok(visible().includes('direct'));
 assert.equal(evaluate(`cardFolderId(data.cards.find(card=>card.id==='due'))`),'work');
 evaluate(`data=normalize(structuredClone(data));application.cards.runtime.cardScope={type:'folder',id:'work'};renderCards();`);
 assert.ok(visible().includes('direct'));
 evaluate(`data.cards.find(card=>card.id==='direct').cardFolderId=null;application.cards.runtime.cardScope={type:'unfiled',id:''};renderCards();`);
 assert.ok(visible().includes('direct'));
});

test('moving a historical card to a folder retains its source and deleting the old folder cannot remove it',async()=>{
 const {context,evaluate,$}=setup();
 Object.defineProperty($('#moveCardsDialog'),'close',{value:()=>{}});
 const original=evaluate(`JSON.stringify(data.documents.find(doc=>doc.id==='doc1'))`);
 evaluate(`application.cards.runtime.selectedCardIds=new Set(['due']);`);
 $('#moveCardsLibrary').innerHTML=context.cardNotebookOptions();$('#moveCardsLibrary').value='folder:other';
 await context.moveSelectedCards({preventDefault(){}});
 assert.equal(evaluate(`data.cards.find(card=>card.id==='due').cardNotebookId`),'backend');
 assert.equal(evaluate(`cardFolderId(data.cards.find(card=>card.id==='due'))`),'other');
 await context.trashCardFolder('work');
 assert.ok(evaluate(`data.cards.some(card=>card.id==='due')`));
 assert.equal(evaluate(`JSON.stringify(data.documents.find(doc=>doc.id==='doc1'))`),original);
 assert.ok(evaluate(`data.cardNotebooks.some(note=>note.id==='backend')`));
});

test('CSV import deduplicates against legacy folder cards and within a file without touching progress or sources', async () => {
  const h = setup(), before = h.evaluate('JSON.stringify([data.documents,data.cardDocuments,data.items,data.reviewRecords,data.cards])');
  h.evaluate("application.cards.runtime.selectedCardIds.add('due')");
  await h.context.importCardFile({ size: 100, text: async () => 'question,answer,tags\n数据库索引,已有,a\n新增,答案,x|y\n新增,重复,z' }, 'work');
  assert.equal(h.calls.saves, 1);
  assert.equal(h.evaluate("data.cards.filter(card=>card.cardFolderId==='work').length"), 1);
  assert.equal(h.evaluate("data.cards.find(card=>card.question==='新增').reviewCount"), 0);
  assert.equal(h.evaluate("data.cards.find(card=>card.question==='新增').cardNotebookId"), null);
  assert.equal(h.evaluate("application.cards.runtime.selectedCardIds.has('due')"), true);
  assert.equal(h.evaluate("JSON.stringify([data.documents,data.cardDocuments,data.items,data.reviewRecords,data.cards.filter(card=>card.question!=='新增')])"), before);
});

test('invalid, oversized and stale-destination CSV imports perform no write', async () => {
  const h = setup(), before = h.evaluate('JSON.stringify(data)');
  for (const [file, folder] of [
    [{ size: 100, text: async () => '问题,答案\n有效,答案\n缺少答案,' }, 'work'],
    [{ size: 10 * 1024 * 1024 + 1, text: async () => { throw Error('must not read'); } }, 'work'],
    [{ size: 100, text: async () => '问题,答案\n有效,答案' }, 'removed']
  ]) await h.context.importCardFile(file, folder);
  assert.equal(h.calls.saves, 0); assert.equal(h.evaluate('JSON.stringify(data)'), before);
});

test('failed CSV persistence rolls back the canonical state and supports retry without duplicate cards', async () => {
  const h = setup(), before = h.evaluate('JSON.stringify(data)'), file = { size: 20, text: async () => '问题,答案\n新增,答案' };
  h.context.save = async () => { throw Error('disk full'); };
  await h.context.importCardFile(file, 'work');
  assert.equal(h.evaluate('JSON.stringify(data)'), before);
  h.context.save = async () => { h.calls.saves++; };
  await h.context.importCardFile(file, 'work'); await h.context.importCardFile(file, 'work');
  assert.equal(h.calls.saves, 1); assert.equal(h.evaluate("data.cards.filter(card=>card.question==='新增').length"), 1);
});

test('card sorting is stable, non-mutating and resets pagination while retaining selection', () => {
  const h = setup();
  h.context.bindCardContentMenus();
  h.evaluate('application.cards.runtime.cardPage = 3'); h.$('#cardSort').onchange();
  assert.equal(h.evaluate('application.cards.runtime.cardPage'), 1);
  h.evaluate("data.cards.forEach((card,i)=>{card.updatedAt=new Date(2026,0,i+1).toISOString();card.createdAt=new Date(2026,0,6-i).toISOString();card.dueAt=100+i;});application.cards.runtime.selectedCardIds.add('due')");
  const before = h.evaluate('JSON.stringify(data.cards)');
  h.$('#cardSort').value = 'updated'; h.context.renderCards(); assert.deepEqual(h.visible(), ['paused','new','due']);
  h.$('#cardSort').value = 'created'; h.context.renderCards(); assert.deepEqual(h.visible(), ['due','new','paused']);
  h.$('#cardSort').value = 'due'; h.context.renderCards(); assert.deepEqual(h.visible(), ['due','new','paused']);
  assert.equal(h.evaluate('JSON.stringify(data.cards)'), before);
  assert.equal(h.evaluate("application.cards.runtime.selectedCardIds.has('due')"), true);
});

test('restoring a legacy notebook also restores an explicitly owned child-folder card path', async () => {
  const h = setup();
  h.evaluate("data.cardFolders.push({id:'child',name:'Child',parentId:'work'});data.cards.find(card=>card.id==='due').cardFolderId='child'");
  await h.context.trashCardFolder('work');
  const id = h.evaluate("data.trash.find(entry=>entry.type==='card-notebook'&&entry.notebook.id==='backend').id");
  await h.context.restoreCardNotebookTrash(id);
  assert.equal(h.evaluate("data.cardFolders.find(folder=>folder.id==='child')?.parentId"), 'work');
  assert.equal(h.evaluate("cardFolderId(data.cards.find(card=>card.id==='due'))"), 'child');
});
