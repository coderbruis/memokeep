const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');
const Delta = require('quill-delta');

function references({ plain = false, reading = false, busy = false } = {}) {
  const window = domino.createWindow('<main id="librariesView"></main>');
  const document = window.document, view = document.querySelector('main');
  window.Element.prototype.append = function (...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
  };
  window.Element.prototype.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
  Object.defineProperty(window.Element.prototype, 'dataset', { configurable: true, get() {
    return new Proxy({}, {
      get: (_, key) => this.getAttribute(`data-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`),
      set: (_, key, value) => { this.setAttribute(`data-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`, value); return true; }
    });
  } });
  window.Option = function (text, value) {
    const option = document.createElement('option'); option.textContent = text; option.setAttribute('value', value); return option;
  };
  window.HTMLSelectElement.prototype.add = function (option) { this.appendChild(option); };
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select').options), Symbol.iterator,
    { configurable: true, value: Array.prototype.values });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return (this.querySelector('option[selected]') || this.querySelector('option'))?.getAttribute('value') || ''; },
    set(value) { for (const option of Array.from(this.options)) {
      if (option.getAttribute('value') === value) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    } }
  });
  const create = document.createElement.bind(document);
  document.createElement = function (name) {
    const node = create(name);
    if (name === 'dialog') {
      Object.defineProperties(node, {
        showModal: { value: () => { node.open = true; } },
        close: { value: () => { node.open = false; node.dispatchEvent(new window.Event('close')); } }
      });
    }
    return node;
  };
  const editors = new WeakMap(), toasts = [], inputs = [];
  const documents = [
    { id: 'source', title: '来源笔记', metadata: { editorMode: 'note', noteContent: '<p>正文</p>' } },
    { id: 'stable-target', title: '目标标题', metadata: { editorMode: 'note', noteContent: '<p>目标正文</p>' } }
  ];
  const state = { persistence: { data: { documents, cardDocuments: [], knowledgeBases: [], cards: [], items: [], cardNotebooks: [] } },
    editor: { editingMarkdownDocumentId: 'source' } };
  const current = {};
  function richEditor(node) {
    const quill = { root: node, enabled: true, calls: [],
      isEnabled() { return this.enabled; }, getSelection: () => ({ index: 2, length: 1 }),
      getLength: () => 5, setSelection() {},
      updateContents(delta, source) { this.calls.push({ delta, source }); return this.noChange ? new Delta() : delta; }
    };
    editors.set(node, quill); return quill;
  }
  function textEditor(node) {
    node.value = '原正文'; node.selectionStart = 1; node.selectionEnd = 2;
    node.setRangeText = (text, start, end) => { node.value = node.value.slice(0, start) + text + node.value.slice(end); };
    node.addEventListener('input', () => inputs.push(node)); return node;
  }
  function mount() {
    view.innerHTML = `<div id="inlineMarkdownNoteForm" aria-busy="${busy}"><button type="button" data-open-note-references>关联</button>
      ${plain ? '<textarea id="notePlainTextContent"></textarea>' : '<div id="noteRichEditor"><p>正文</p></div>'}</div>`;
    current.form = document.querySelector('#inlineMarkdownNoteForm');
    if (plain) current.textarea = textEditor(document.querySelector('textarea'));
    else current.quill = richEditor(document.querySelector('#noteRichEditor'));
  }
  mount(); view.classList.toggle('note-reading', reading);
  window.Quill = { find: node => editors.get(node), import: () => Delta };
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/shell/note-navigation.js'), 'utf8'), context);
  const actions = { documentById: id => documents.find(note => note.id === id), showToast: message => toasts.push(message) };
  context.MemoKeepShell.createNoteNavigation({ state, config: { $: selector => document.querySelector(selector) }, actions,
    env: { window, document, Event: window.Event } }).bindNoteNavigation();
  const dialog = () => document.querySelector('.note-references-dialog') || null;
  return { state, view, current, toasts, inputs, mount, dialog,
    open() { current.form.querySelector('button').click(); return dialog(); },
    submit() {
      const form = dialog().querySelector('form'), select = form.querySelector('select');
      select.value = 'stable-target'; form.onsubmit({ preventDefault() {} });
    },
    replaceRich() { current.quill = richEditor(current.quill.root); },
    replaceTextarea() {
      const node = document.createElement('textarea'); node.id = 'notePlainTextContent';
      current.textarea.parentNode.replaceChild(node, current.textarea); current.textarea = textEditor(node);
    }
  };
}

test('initializing notes reject the references panel with an explicit loading message', () => {
  const h = references({ busy: true });
  assert.equal(h.open(), null);
  assert.equal(h.current.quill.calls.length, 0);
  assert.match(h.toasts[0], /正在加载/);
});

test('reading or disabled rich editors still show related notes but cannot insert', () => {
  for (const reading of [true, false]) {
    const h = references({ reading });
    if (!reading) h.current.quill.enabled = false;
    const dialog = h.open();
    assert.equal(dialog.open, true);
    assert.ok(dialog.querySelector('[data-note-related-cards]'));
    assert.equal(dialog.querySelector('form button').disabled, true);
    h.submit();
    assert.equal(dialog.open, true); assert.equal(h.current.quill.calls.length, 0);
    assert.equal(dialog.querySelector('select').value, 'stable-target');
    assert.match(h.toasts[0], /暂不可编辑/);
  }
});

test('submission rechecks initialization and preserves the selected target for a ready retry', () => {
  const h = references(), dialog = h.open();
  h.current.form.setAttribute('aria-busy', 'true'); h.submit();
  assert.equal(dialog.open, true); assert.equal(h.current.quill.calls.length, 0);
  assert.equal(dialog.querySelector('select').value, 'stable-target');
  h.current.form.setAttribute('aria-busy', 'false'); h.submit();
  assert.equal(dialog.open, false); assert.equal(h.current.quill.calls.length, 1);
});

test('a ready rich reference inserts the stable entity ID as a user edit', () => {
  const h = references(), dialog = h.open(); h.submit();
  const [{ delta, source }] = h.current.quill.calls;
  assert.equal(source, 'user');
  const inserted = delta.ops.find(op => op.insert);
  assert.equal(inserted.insert, '目标标题');
  assert.equal(inserted.attributes.link, 'https://memokeep.invalid/notes/stable-target');
  assert.equal(dialog.open, false); assert.equal(h.toasts.length, 0);
});

test('a rejected Quill edit keeps the panel open rather than reporting false success', () => {
  const h = references(), dialog = h.open(); h.current.quill.noChange = true; h.submit();
  assert.equal(dialog.open, true); assert.match(h.toasts[0], /未能插入/);
});

test('switching away or remounting the same note never writes through a captured old editor', () => {
  for (const change of ['different-note', 'same-note-new-form', 'same-form-new-quill']) {
    const h = references(), dialog = h.open(), original = h.current.quill;
    if (change === 'different-note') h.state.editor.editingMarkdownDocumentId = 'another-note';
    else if (change === 'same-note-new-form') h.mount();
    else h.replaceRich();
    h.submit();
    assert.equal(original.calls.length, 0, change); assert.equal(h.current.quill.calls.length, 0, change);
    assert.equal(dialog.open, true); assert.equal(dialog.querySelector('select').value, 'stable-target');
    assert.match(h.toasts[0], /暂不可编辑/);
  }
});

test('plain references respect disabled, readonly, and reading state before dispatching input', () => {
  for (const mode of ['disabled', 'readOnly', 'reading']) {
    const h = references({ plain: true, reading: mode === 'reading' });
    if (mode !== 'reading') h.current.textarea[mode] = true;
    const dialog = h.open(), before = h.current.textarea.value; h.submit();
    assert.equal(dialog.querySelector('form button').disabled, true);
    assert.equal(dialog.open, true); assert.equal(h.current.textarea.value, before); assert.equal(h.inputs.length, 0);
  }
});

test('plain references insert Markdown once and reject a replaced textarea in the same form', () => {
  const h = references({ plain: true }), dialog = h.open(); h.submit();
  assert.equal(h.current.textarea.value, '原[目标标题](https://memokeep.invalid/notes/stable-target)文');
  assert.deepEqual(h.inputs, [h.current.textarea]); assert.equal(dialog.open, false);
  const second = h.open(), original = h.current.textarea; h.replaceTextarea(); h.submit();
  assert.equal(original.value, '原[目标标题](https://memokeep.invalid/notes/stable-target)文');
  assert.equal(h.current.textarea.value, '原正文'); assert.equal(h.inputs.length, 1); assert.equal(second.open, true);
});
