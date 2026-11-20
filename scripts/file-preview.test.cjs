const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const domino = require('@mixmark-io/domino');
const code = fs.readFileSync(path.join(__dirname, '../web/file-preview.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
function setup(options = {}) {
  const state = { documents: [{ id: 'existing', content: '原有内容' }], knowledgeBases: [{ id: 'target', name: '知识库' }] };
  const context = vm.createContext({
    applicationDataReady: true, data: state, TextEncoder, Date,
    MemoKeepDirectoryTree: require('../web/directory-tree.js'),
    escapeHtml: text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    markdownToRichHtml: text => `<h1>${text}</h1>`, sanitizeRichNoteContent: text => text,
    libraryById: id => id === 'target' ? { id } : null,
    leaveActiveNoteEditor: async () => !options.blocked,
    uid: () => 'new', availableDocumentTitle: title => title,
    save: async () => { if (options.failure) throw new Error('disk full'); },
    documentById: id => state.documents.find(doc => doc.id === id)
  });
  context.application = { state: { knowledge: { libraryById: context.libraryById } }, persistence: { save: context.save,
    transact: async change => {
      const candidate = structuredClone(state);
      change(candidate);
      await context.save();
      Object.assign(state, candidate);
    } }, editor: { session: { leaveActiveNoteEditor: context.leaveActiveNoteEditor } } };
  require('./shell-fixture.cjs').syntheticShell(context);
  vm.runInContext(code, context);
  return { state, context };
}
test('TXT keeps literal Markdown, HTML and line breaks, including empty lines', () => {
  const { context } = setup();
  assert.equal(context.droppedNoteHtml('x.TXT', '# 原文\r\n<script>x</script>\n\n末行'), '<p># 原文</p><p>&lt;script&gt;x&lt;/script&gt;</p><p><br></p><p>末行</p>');
});
test('saves only to chosen library with chosen title and original content', async () => {
  const { state, context } = setup();
  const result = await context.saveDroppedNote({ fileName: '原文.txt', content: '正文' }, ' 新名称 ', 'target');
  assert.equal(state.documents.length, 2);
  assert.equal(result.title, '新名称');
  assert.equal(result.knowledgeBaseId, 'target');
  assert.equal(result.content, '正文');
  assert.equal(result.sourceFileName, '原文.txt');
  assert.equal(result.metadata.noteContent, '<p>正文</p>');
});
test('invalid input, blocked editor and failed save do not add notes', async () => {
  for (const [options, name, library] of [[{}, ' ', 'target'], [{}, 'name', 'missing'], [{ blocked: true }, 'name', 'target'], [{ failure: true }, 'name', 'target']]) {
    const { state, context } = setup(options);
    await assert.rejects(context.saveDroppedNote({ fileName: 'x.md', content: '# text' }, name, library));
    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0].content, '原有内容');
  }
});

function setupPreview(options = {}) {
  const { context, state } = setup(options);
  const window = domino.createWindow(html, 'http://localhost/');
  const document = window.document;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const nodeListPrototype = Object.getPrototypeOf(document.querySelectorAll('button'));
  // Keep the production DOM and event propagation; shim only missing browser APIs.
  if (!nodeListPrototype[Symbol.iterator]) nodeListPrototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
  if (!nodeListPrototype.forEach) nodeListPrototype.forEach = Array.prototype.forEach;
  if (!window.Element.prototype.append) window.Element.prototype.append = function (...nodes) {
    nodes.forEach(node => this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node));
  };
  if (!window.Element.prototype.replaceChildren) window.Element.prototype.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
  $$('dialog').forEach(dialog => {
    Object.defineProperties(dialog, {
      showModal: { value: () => dialog.setAttribute('open', '') },
      close: { value: () => {
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new window.Event('close'));
      } }
    });
  });
  $('#filePreviewName').select = () => {};
  $('#filePreviewSaveAsName').select = () => {};
  const renders = [], savedFiles = [], acknowledgements = [], revoked = [], toasts = [];
  const nativeWaitTimers = new Map();
  let nextTimer = 0;
  window.setTimeout = callback => { nativeWaitTimers.set(++nextTimer, callback); return nextTimer; };
  window.clearTimeout = timer => nativeWaitTimers.delete(timer);
  const expireNativeWait = () => {
    const callbacks = [...nativeWaitTimers.values()];
    nativeWaitTimers.clear();
    callbacks.forEach(callback => callback());
  };
  const escape = context.escapeHtml;
  // Parsing and Mermaid rendering have their own tests. Supply representative
  // blocks and rendered figures here to exercise the real preview lifecycle.
  const markdownFixture = text => text.split(/(```[\s\S]*?```)/g).map(part => {
    const fence = part.match(/^```(\w*)\n([\s\S]*?)\n```$/);
    if (fence) return `<pre data-language="${fence[1]}">${escape(fence[2])}</pre>`;
    return part.split('\n').filter(Boolean).map(line => {
      const heading = line.match(/^(#{1,4}) (.*)$/);
      return heading ? `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>` : `<p>${escape(line)}</p>`;
    }).join('');
  }).join('');
  state.knowledgeBases = [{ id: 'target', name: '知识库' }];
  let nativeDragCallback, nativeErrorCallback;
  window.memoKeepDesktop = {
    nativeDocumentDrop: options.nativeDocumentDrop === true,
    onNativeFileDrag: callback => { nativeDragCallback = callback; },
    onNativeFileError: callback => { nativeErrorCallback = callback; },
    saveFileToDirectory: async file => { savedFiles.push(file); return options.saveResult || { saved: !options.cancelSave }; },
    acknowledgeOpenedNoteFile: async id => { acknowledgements.push(id); if (options.ackFailure) throw new Error('isolated queue ack failure'); },
    releaseOpenedNoteFile: async token => { revoked.push(token); }
  };
  Object.assign(context, {
    $, window, document, selectedLibraryId: 'target', collapsedLibraryIds: new Set(),
    saveCollapsedLibraryIds() {}, openMarkdownNoteEditor() {},
    markdownToRichHtml: markdownFixture,
    renderPreviewDiagrams: async container => {
      renders.push(container);
      for (const block of Array.from(container.querySelectorAll('pre[data-language="mermaid"]'))) {
        if (block.closest('.markdown-diagram')) continue;
        const figure = document.createElement('figure');
        figure.className = 'markdown-diagram';
        const viewer = document.createElement('div');
        viewer.className = 'diagram-viewer';
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '查看图表源码';
        block.replaceWith(figure);
        details.append(summary, block);
        figure.append(viewer, details);
      }
    },
    showView: name => $('#filePreviewView').classList.toggle('hidden', name !== 'filePreview'),
    showToast: (message, error = false) => toasts.push({ message, error })
  });
  context.bindFileDropPreview();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const domDrop = async files => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ['Files'], files };
    document.dispatchEvent(event);
    await settle();
    return event;
  };
  const nativeDrop = async files => {
    const accepted = await context.applicationShell.actions.enqueueNativeFilePreviews(files);
    await settle();
    return accepted;
  };
  const drop = async (name, text) => {
    if (options.native) {
      await nativeDrop([{ id: 'native-event', name, content: text,
        token: 'opaque-source-grant', origin: 'drop' }]);
    } else {
      await domDrop([{ name, text: async () => text }]);
    }
    await settle();
    assert.equal($('#filePreviewStatus').textContent, '尚未保存', 'The file must finish loading before editing');
  };
  const click = selector => $(selector).click();
  const diagrams = () => $$('#filePreviewContent .markdown-diagram').map(figure => {
    assert.ok(figure.querySelector('.diagram-viewer'), 'Each figure must keep its rendered viewer');
    assert.equal(figure.querySelector('details summary')?.textContent, '查看图表源码');
    return figure.querySelector('details pre')?.textContent;
  });
  return { $, $$, click, drop, domDrop, nativeDrop, expireNativeWait, settle, diagrams, renders, savedFiles, state, acknowledgements, revoked, toasts, context,
    nativeDrag: active => nativeDragCallback(active), nativeError: message => nativeErrorCallback(message) };
}

const flowchart = 'flowchart TD\nA[开始] --> B[完成]';
const sequence = 'sequenceDiagram\n用户->>服务: 保存笔记';
const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;

test('drop opens preview; Save opens the destination menu and cancelling library save preserves preview', async () => {
  const { $, click, drop, state } = setupPreview();
  await drop('示例.txt', '原文内容');
  assert.equal($('#filePreviewView').classList.contains('hidden'), false);
  assert.equal($('#filePreviewDialog').open, false);
  assert.equal($('#filePreviewContent').innerHTML, '<p>原文内容</p>');
  assert.equal(state.documents.length, 1);
  click('#filePreviewOpenSave');
  assert.equal($('#filePreviewSaveMenu').classList.contains('hidden'), false);
  assert.equal($('#filePreviewDialog').open, false);
  click('#filePreviewSaveLibrary');
  assert.equal($('#filePreviewDialog').open, true);
  assert.equal($('#filePreviewName').value, '示例');
  click('#filePreviewCancelSave');
  assert.equal($('#filePreviewDialog').open, false);
  assert.equal($('#filePreviewView').classList.contains('hidden'), false);
  assert.equal($('#filePreviewContent').innerHTML, '<p>原文内容</p>');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveLibrary');
  assert.equal($('#filePreviewDialog').open, true);
});

test('unchanged Markdown edit round trips retain Mermaid viewers and exact source', async () => {
  const { $, click, drop, settle, diagrams, state } = setupPreview();
  const markdown = `# 工作流程\n\n${fence(flowchart)}\n\n末尾说明`;
  await drop('流程.md', markdown);
  assert.deepEqual(diagrams(), [flowchart]);
  for (let cycle = 0; cycle < 3; cycle++) {
    click('#filePreviewEdit');
    assert.equal($('#filePreviewEditor').value, markdown);
    assert.equal($('#filePreviewContent').classList.contains('hidden'), true);
    click('#filePreviewEdit');
    await settle();
    assert.equal($('#filePreviewContent').classList.contains('hidden'), false);
    assert.equal($('#filePreviewEditor').classList.contains('hidden'), true);
    assert.deepEqual(diagrams(), [flowchart], `Edit round trip ${cycle + 1} must restore the diagram`);
  }
  assert.equal(state.documents.length, 1, 'Preview edits must not create a saved note');
});

test('completing Markdown edits renders the latest diagram and saves raw Markdown', async () => {
  const { $, click, drop, settle, diagrams, savedFiles } = setupPreview({ native: true });
  await drop('流程.md', `# 原标题\n${fence(flowchart)}`);
  const changed = 'flowchart LR\n输入 --> 校验 --> 保存';
  const markdown = `# 更新标题\n\n${fence(changed)}\n\n保留 <原始文字>`;
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = markdown;
  click('#filePreviewEdit');
  await settle();
  assert.deepEqual(diagrams(), [changed]);
  assert.equal($('#filePreviewOutlineList button').textContent, '更新标题');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveOriginal');
  await settle();
  assert.equal(savedFiles.length, 1);
  assert.equal(savedFiles[0].content, markdown);
  assert.equal(savedFiles[0].fileName, '流程.md');
  assert.equal(savedFiles[0].token, 'opaque-source-grant');
  assert.equal(savedFiles[0].directory, undefined);
  click('#filePreviewEdit');
  assert.equal($('#filePreviewEditor').value, markdown);
});

test('ordinary browser File drops cannot claim a filesystem path or save to the original directory', async () => {
  const { $, drop, savedFiles } = setupPreview();
  await drop('普通文件.md', '# 浏览器文件');
  assert.equal($('#filePreviewSaveOriginal').disabled, true);
  assert.equal($('#filePreviewSaveAs').disabled, true);
  assert.equal(savedFiles.length, 0);
});

test('desktop DOM-first and native-first delivery each produce one authorized preview', async () => {
  for (const order of ['dom-first', 'native-first']) {
    const { $, click, domDrop, nativeDrop, expireNativeWait, settle, acknowledgements, revoked, toasts, state } = setupPreview({ nativeDocumentDrop: true });
    let browserReads = 0;
    const browserFile = { name: '同一文件.md', text: async () => { browserReads++; return '# DOM 副本'; } };
    const nativeFile = { id: 'native-delivery', name: browserFile.name, content: '# 原生正文', token: 'native-grant', origin: 'drop' };
    if (order === 'dom-first') {
      const event = await domDrop([browserFile]);
      assert.equal(event.defaultPrevented, true);
      assert.equal($('#filePreviewView').classList.contains('hidden'), true, 'Waiting for OS delivery must not create an unauthorized preview');
      assert.match(toasts.at(-1).message, /正在等待系统/);
      await nativeDrop([nativeFile]);
    } else {
      await nativeDrop([nativeFile]);
      await domDrop([browserFile]);
    }
    expireNativeWait();
    assert.equal(browserReads, 0, 'The desktop must not read or queue the DOM copy');
    assert.equal($('#filePreviewSaveAs').disabled, false);
    assert.equal($('#filePreviewContent').textContent, '原生正文');
    assert.equal(toasts.some(toast => toast.error), false);
    assert.equal(state.documents.length, 1);
    click('#filePreviewSkip');
    await settle();
    assert.equal($('#filePreviewView').classList.contains('hidden'), true, 'No second DOM preview may remain');
    assert.deepEqual(acknowledgements, ['native-delivery']);
    assert.deepEqual(revoked, ['native-grant']);
  }
});

test('missing native delivery reports an error instead of exposing an unauthorized preview', async () => {
  const { $, domDrop, nativeDrop, expireNativeWait, toasts, state } = setupPreview({ nativeDocumentDrop: true });
  await domDrop([{ name: '等待.md', text: async () => { throw new Error('A desktop DOM File must not be read'); } }]);
  expireNativeWait();
  assert.equal($('#filePreviewView').classList.contains('hidden'), true);
  assert.match(toasts.at(-1).message, /系统未能接收拖入文件/);
  assert.equal(toasts.at(-1).error, true);
  assert.equal(state.documents.length, 1);
  await nativeDrop([{ id: 'late-event', name: '等待.md', content: '# 迟到的原生正文', token: 'late-grant', origin: 'drop' }]);
  assert.equal($('#filePreviewSaveAs').disabled, false, 'A late durable delivery must still be accepted');
  assert.equal($('#filePreviewContent').textContent, '迟到的原生正文');
});

test('native file errors clear the waiting state and overlay without a later timeout error', async () => {
  const { $, domDrop, nativeDrag, nativeError, expireNativeWait, toasts } = setupPreview({ nativeDocumentDrop: true });
  await domDrop([{ name: '未能接收.md', text: async () => { throw new Error('The DOM copy is never a substitute for native delivery'); } }]);
  nativeDrag(true);
  assert.equal($('#fileDropOverlay').hidden, false);
  nativeError('系统未能读取该文件，请重试。');
  expireNativeWait();
  assert.equal($('#fileDropOverlay').hidden, true);
  assert.equal($('#filePreviewView').classList.contains('hidden'), true);
  assert.deepEqual(toasts.filter(toast => toast.error), [{ message: '系统未能读取该文件，请重试。', error: true }]);
});

test('native error payloads remain bounded text and cannot replace an unsaved preview', async () => {
  const { $, click, nativeDrop, nativeDrag, nativeError, toasts, acknowledgements, revoked } = setupPreview({ nativeDocumentDrop: true });
  await nativeDrop([{ id: 'kept-event', name: '保留编辑.md', content: '# 原始正文', token: 'kept-grant', origin: 'drop' }]);
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = '# 仍未保存的修改';
  nativeDrag(true);
  nativeError('\u0000' + '读取错误'.repeat(100) + '\n');
  assert.equal(toasts.at(-1).message.length, 240);
  assert.doesNotMatch(toasts.at(-1).message, /[\u0000-\u001f\u007f]/);
  nativeError({ toString() { throw new Error('Unexpected objects must not be coerced'); } });
  assert.equal(toasts.at(-1).message, '系统无法接收拖入文件，请重试。当前内容已保留。');
  assert.equal($('#fileDropOverlay').hidden, true);
  assert.equal($('#filePreviewEditor').classList.contains('hidden'), false);
  assert.equal($('#filePreviewEditor').value, '# 仍未保存的修改');
  assert.equal($('#filePreviewSaveAs').disabled, false);
  assert.deepEqual(acknowledgements, []);
  assert.deepEqual(revoked, []);
});

test('the desktop bridge enables native document drops only on Mac desktops and forwards file errors', async () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, '../apps/desktop/tauri-desktop.js'), 'utf8').replace(/^import .*;\n/gm, '');
  for (const [platform, maxTouchPoints, expected] of [['MacIntel', 0, true], ['MacArm64', 0, true], ['Win32', 0, false], ['Linux x86_64', 0, false], ['iPhone', 5, false], ['MacIntel', 5, false]]) {
    const listeners = new Map(), received = [];
    const bridgeContext = vm.createContext({
      window: {}, navigator: { platform, maxTouchPoints }, StateMerge: {}, Search: {}, console,
      listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); }
    });
    vm.runInContext(bridgeSource, bridgeContext);
    const bridge = bridgeContext.window.memoKeepDesktop;
    assert.equal(bridge.nativeDocumentDrop, expected, platform + ':' + maxTouchPoints);
    const release = bridge.onNativeFileError(message => received.push(message));
    listeners.get('workspace-file-error')({ payload: '系统读取失败' });
    assert.deepEqual(received, ['系统读取失败']);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listeners.has('workspace-file-error'), false);
  }
});

test('a later native delivery preserves edits in the active preview and waits its turn', async () => {
  const { $, click, nativeDrop, domDrop, expireNativeWait, state, acknowledgements } = setupPreview({ nativeDocumentDrop: true });
  const first = { id: 'first-event', name: '正在编辑.md', content: '# 原始正文', token: 'first-grant', origin: 'drop' };
  const second = { id: 'second-event', name: '后续文件.txt', content: '# 保持纯文本', token: 'second-grant', origin: 'drop' };
  await nativeDrop([first]);
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = '# 尚未保存的修改';
  await domDrop([{ name: second.name, text: async () => 'DOM 内容' }]);
  await nativeDrop([second]);
  expireNativeWait();
  assert.equal($('#filePreviewEditor').classList.contains('hidden'), false);
  assert.equal($('#filePreviewEditor').value, '# 尚未保存的修改');
  assert.match($('#filePreviewSource').textContent, /正在编辑/);
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  assert.equal(state.documents.find(note => note.id === first.id).content, '# 尚未保存的修改');
  assert.equal($('#filePreviewSource').textContent, second.name);
  assert.equal($('#filePreviewContent').textContent, second.content);
  assert.equal($('#filePreviewSaveAs').disabled, false);
  assert.deepEqual(acknowledgements, [first.id]);
});

test('a busy save rejects a DOM copy and leaves native delivery available for retry', async () => {
  let finish;
  const saveResult = new Promise(resolve => { finish = resolve; });
  const { $, click, nativeDrop, domDrop, savedFiles, settle, toasts } = setupPreview({ nativeDocumentDrop: true, saveResult });
  const first = { id: 'saving-event', name: '保存中.md', content: '# 已编辑正文', token: 'saving-grant', origin: 'drop' };
  const second = { id: 'retry-event', name: '稍后.txt', content: '稍后读取', token: 'retry-grant', origin: 'drop' };
  await nativeDrop([first]);
  const saving = $('#filePreviewSaveOriginal').onclick();
  await domDrop([{ name: second.name, text: async () => { throw new Error('A DOM fallback must not run while saving'); } }]);
  assert.equal(await nativeDrop([second]), false);
  assert.match(toasts.at(-1).message, /正在处理/);
  finish({ saved: true });
  await saving;
  assert.equal(savedFiles[0].content, first.content);
  assert.equal(await nativeDrop([second]), true);
  assert.match($('#filePreviewSource').textContent, /保存中/);
  click('#filePreviewSkip');
  await settle();
  assert.equal($('#filePreviewSource').textContent, second.name);
  click('#filePreviewSkip');
  await settle();
  assert.equal($('#filePreviewView').classList.contains('hidden'), true);
});

test('desktop document routing leaves image drops available to the image editor', async () => {
  const { $, domDrop, context, toasts } = setupPreview({ nativeDocumentDrop: true });
  let imageEvents = 0;
  context.document.addEventListener('drop', () => { imageEvents++; });
  await domDrop([{ name: '图片.png', text: async () => { throw new Error('Images belong to the image editor'); } }]);
  assert.equal(imageEvents, 1);
  assert.equal($('#filePreviewView').classList.contains('hidden'), true);
  assert.deepEqual(toasts, []);
});

test('browser fallback can still save its preview into the knowledge base', async () => {
  const { $, click, drop, state } = setupPreview();
  await drop('浏览器.txt', '# 原样正文');
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  assert.equal(state.documents.find(note => note.id === 'new').content, '# 原样正文');
  assert.equal($('#filePreviewView').classList.contains('hidden'), true);
});

test('the visible Save As flow saves edited content with a new name and preserves the source extension', async () => {
  const { $, click, drop, savedFiles } = setupPreview({ native: true });
  await drop('原文.MARKDOWN', '# 原始内容');
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = '# 另存内容';
  click('#filePreviewOpenSave');
  click('#filePreviewSaveAs');
  assert.equal($('#filePreviewSaveAsDialog').open, true);
  assert.equal($('#filePreviewSaveMenu').classList.contains('hidden'), true);
  assert.equal($('#filePreviewSaveAsName').value, '原文');
  assert.match($('#filePreviewSaveAsHint').textContent, /\.MARKDOWN/);
  $('#filePreviewSaveAsName').value = '另存副本';
  await $('#filePreviewSaveAsForm').onsubmit({ preventDefault() {} });
  assert.equal(savedFiles.length, 1);
  assert.equal(savedFiles[0].fileName, '另存副本.MARKDOWN');
  assert.equal(savedFiles[0].content, '# 另存内容');
  assert.equal($('#filePreviewSaveAsDialog').open, false);
  assert.equal($('#filePreviewName').value, '原文', 'A disk filename must not rename the future library note');
});

test('cancelling Save As or a renamed library dialog cannot change the original save target', async () => {
  const { $, click, drop, settle, savedFiles } = setupPreview({ native: true });
  await drop('原文.TXT', '纯文本');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveAs');
  $('#filePreviewSaveAsName').value = '已取消的文件名称';
  click('#filePreviewDismissSaveAs');
  assert.equal($('#filePreviewSaveAsDialog').open, false);
  assert.equal(savedFiles.length, 0);
  click('#filePreviewOpenSave');
  click('#filePreviewSaveAs');
  assert.equal($('#filePreviewSaveAsName').value, '原文', 'Reopening must discard the cancelled filename');
  click('#filePreviewCancelSaveAs');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveLibrary');
  $('#filePreviewName').value = '已取消的笔记名称';
  click('#filePreviewCancelSave');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveOriginal');
  await settle();
  assert.equal(savedFiles.length, 1);
  assert.equal(savedFiles[0].fileName, '原文.TXT');
});

test('Save As disables its controls while saving and retains the dialog after a cancelled overwrite', async () => {
  let finish;
  const saveResult = new Promise(resolve => { finish = resolve; });
  const { $, click, drop, savedFiles, acknowledgements, context } = setupPreview({ native: true, saveResult });
  await drop('原文.md', '# 原文');
  click('#filePreviewOpenSave');
  click('#filePreviewSaveAs');
  $('#filePreviewSaveAsName').value = '已有文件';
  const saving = $('#filePreviewSaveAsForm').onsubmit({ preventDefault() {} });
  for (const selector of ['#filePreviewSaveAsName', '#filePreviewSaveAsSubmit', '#filePreviewCancelSaveAs', '#filePreviewDismissSaveAs', '#filePreviewSaveAs', '#filePreviewSaveOriginal', '#filePreviewEdit', '#filePreviewSkip', '#filePreviewOpenSave']) {
    assert.equal($(selector).disabled, true, selector);
  }
  assert.equal($('#filePreviewSaveAsDialog').getAttribute('aria-busy'), 'true');
  const cancel = new context.window.Event('cancel', { cancelable: true });
  $('#filePreviewSaveAsDialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true, 'Escape must not close a pending save');
  click('#filePreviewDismissSaveAs');
  assert.equal($('#filePreviewSaveAsDialog').open, true);
  finish({ saved: false });
  await saving;
  assert.equal(savedFiles.length, 1);
  assert.equal($('#filePreviewSaveAsDialog').open, true);
  assert.equal($('#filePreviewSaveAsName').value, '已有文件');
  assert.equal($('#filePreviewSaveAsSubmit').disabled, false);
  assert.match($('#filePreviewSaveAsStatus').textContent, /已取消覆盖/);
  assert.deepEqual(acknowledgements, []);
});

test('cancelled native overwrite preserves editable preview and does not confirm its queue item', async () => {
  const { $, click, drop, settle, acknowledgements, revoked } = setupPreview({ native: true, cancelSave: true });
  await drop('原文件.md', '# 原文');
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = '# 修改后';
  click('#filePreviewSaveOriginal');
  await settle();
  assert.equal($('#filePreviewStatus').textContent, '已取消覆盖，预览内容已保留');
  assert.deepEqual(acknowledgements, []);
  assert.deepEqual(revoked, []);
  click('#filePreviewEdit');
  assert.equal($('#filePreviewEditor').value, '# 修改后');
});

test('a native committed file with a pending receipt reports saved rather than a save failure', async () => {
  for (const extra of [{ saveResult: { saved: true, warning: 'isolated receipt fault', receiptPending: true } }, { ackFailure: true }]) {
    const { $, click, drop, settle, savedFiles, revoked } = setupPreview({ native: true, ...extra });
    await drop('回执.md', '# 文件内容');
    click('#filePreviewSaveOriginal');
    await settle();
    assert.equal(savedFiles.length, 1);
    assert.equal($('#filePreviewStatus').textContent, '文件已保存，回执待补记');
    assert.equal($('#filePreviewSaveOriginal').disabled, false);
    assert.deepEqual(revoked, []);
    click('#filePreviewEdit');
    assert.equal($('#filePreviewEditor').value, '# 文件内容');
  }
});

test('skipping a native preview acknowledges and revokes its opaque directory grant', async () => {
  const { click, drop, settle, acknowledgements, revoked } = setupPreview({ native: true });
  await drop('跳过.md', '# 原文');
  click('#filePreviewSkip');
  await settle();
  assert.deepEqual(acknowledgements, ['native-event']);
  assert.deepEqual(revoked, ['opaque-source-grant']);
});

test('a committed preview with failed queue acknowledgement retries without duplicating its stable note', async () => {
  const options = { native: true, ackFailure: true };
  const { $, click, drop, state, acknowledgements, revoked } = setupPreview(options);
  await drop('重试.md', '# 首次保存');
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  const first = state.documents.find(note => note.id === 'native-event');
  assert.ok(first, 'The first business save must stay committed after acknowledgement fails');
  assert.match($('#filePreviewStatus').textContent, /queue ack failure/);
  options.ackFailure = false;
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  const notes = state.documents.filter(note => note.id === 'native-event');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, '# 首次保存');
  assert.equal(notes[0].createdAt, first.createdAt);
  assert.deepEqual(acknowledgements, ['native-event', 'native-event']);
  assert.deepEqual(revoked, ['opaque-source-grant']);
});

test('failed preview upsert leaves the previously committed note intact and later edits can retry', async () => {
  const options = { native: true, ackFailure: true };
  const { $, click, drop, state } = setupPreview(options);
  await drop('更新重试.md', '# 已提交正文');
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  const first = state.documents.find(note => note.id === 'native-event');
  first.metadata.custom = { preserved: true };
  const original = JSON.stringify(first);
  click('#filePreviewEdit');
  $('#filePreviewEditor').value = '# 重试时更新正文';
  click('#filePreviewEdit');
  options.failure = true;
  options.ackFailure = false;
  click('#filePreviewSaveLibrary');
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  assert.match($('#filePreviewSaveStatus').textContent, /disk full/);
  assert.equal(state.documents.filter(note => note.id === 'native-event').length, 1);
  assert.equal(JSON.stringify(state.documents.find(note => note.id === 'native-event')), original);
  assert.equal(state.documents.find(note => note.id === 'existing').content, '原有内容');
  options.failure = false;
  await $('#filePreviewForm').onsubmit({ preventDefault() {} });
  const updated = state.documents.find(note => note.id === 'native-event');
  assert.equal(state.documents.filter(note => note.id === 'native-event').length, 1);
  assert.equal(updated.content, '# 重试时更新正文');
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.metadata.custom.preserved, true);
});

test('multiple Mermaid diagrams are restored once while ordinary code stays code', async () => {
  const { $, $$, click, drop, settle, diagrams } = setupPreview();
  const ordinary = 'const result = 1 < 2;';
  const markdown = `# 多图\n${fence(flowchart)}\n${fence(sequence)}\n\`\`\`javascript\n${ordinary}\n\`\`\``;
  await drop('多图.markdown', markdown);
  assert.deepEqual(diagrams(), [flowchart, sequence]);
  click('#filePreviewEdit');
  assert.equal($('#filePreviewEditor').value, markdown);
  click('#filePreviewEdit');
  await settle();
  assert.deepEqual(diagrams(), [flowchart, sequence]);
  assert.equal($$('#filePreviewContent .diagram-viewer').length, 2);
  assert.equal($('#filePreviewContent > pre[data-language="javascript"]').textContent, ordinary);
  assert.equal($$('#filePreviewContent details details').length, 0);
});

test('TXT edit round trips retain literal Mermaid fences without diagram rendering', async () => {
  const { $, $$, click, drop, settle, diagrams, renders } = setupPreview();
  const original = `# 纯文本\n${fence(flowchart)}`;
  await drop('流程.TXT', original);
  assert.deepEqual(diagrams(), []);
  assert.equal(renders.length, 0);
  click('#filePreviewEdit');
  assert.equal($('#filePreviewEditor').value, original);
  const changed = `${original}\n${fence(sequence)}\n<script>原文</script>`;
  $('#filePreviewEditor').value = changed;
  click('#filePreviewEdit');
  await settle();
  assert.equal(renders.length, 0);
  assert.equal($$('#filePreviewContent pre, #filePreviewContent figure, #filePreviewContent script').length, 0);
  assert.deepEqual($$('#filePreviewContent p').map(paragraph => paragraph.textContent), changed.split('\n'));
  click('#filePreviewEdit');
  assert.equal($('#filePreviewEditor').value, changed);
});
