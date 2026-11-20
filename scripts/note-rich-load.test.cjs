const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const imageId = '019332ac-8624-4111-8888-000000000001';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNQcDvxP2pL038AEiUEvVyVVmsAAAAASUVORK5CYII=';
const note = id => `<h2>合成正文</h2><p>图片之前</p><p><img src="memokeep-image://${id}" data-memokeep-image-id="${id}" data-file-name="原图.png" alt="原图.png" width="420" height="280" data-image-rotation="90"></p><p>图片之后</p>`;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Real Quill, image formats, sanitizer and serializer; Domino supplies the DOM
// without launching a GUI. Geometry/observer behavior remains a desktop UI check.
function fixture(read) {
  const window = domino.createWindow('<!doctype html><html><body><main id="librariesView"><div id="inlineMarkdownNoteForm"><input id="inlineMarkdownNoteTitle" value="合成笔记"><div id="editor"></div></div></main></body></html>', 'http://localhost/');
  const proto = window.Element.prototype;
  proto.append ||= function (...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node); };
  proto.replaceWith ||= function (...nodes) { for (const node of nodes) this.parentNode.insertBefore(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node, this); this.remove(); };
  proto.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 400 });
  proto.getClientRects = () => [];
  proto.scrollIntoView = () => {};
  proto.getRootNode = function () { return this.ownerDocument; };
  const tokenList = Object.getPrototypeOf(window.document.body.classList);
  tokenList[Symbol.iterator] ||= function* () { for (let index = 0; index < this.length; index++) yield this.item(index); };
  for (const list of [window.document.querySelectorAll('img'), window.document.body.querySelectorAll('img')]) {
    Object.getPrototypeOf(list)[Symbol.iterator] ||= function* () { for (let index = 0; index < this.length; index++) yield this[index]; };
    Object.getPrototypeOf(list).forEach ||= Array.prototype.forEach;
  }
  if (!Object.getOwnPropertyDescriptor(proto, 'dataset')) Object.defineProperty(proto, 'dataset', { get() {
    const element = this, attribute = key => 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
    return new Proxy({}, { get: (_, key) => element.getAttribute(attribute(key)) ?? undefined,
      set: (_, key, value) => { element.setAttribute(attribute(key), String(value)); return true; } });
  } });
  window.document.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} });
  const Observer = class { observe() {} disconnect() {} takeRecords() { return []; } };
  const frames = [];
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.cancelAnimationFrame = () => {};
  const context = vm.createContext({ window, self: window, document: window.document,
    navigator: { platform: 'MacIntel', userAgent: 'node' }, MutationObserver: Observer,
    Node: window.Node, HTMLElement: window.HTMLElement, Element: window.Element, Text: window.Text,
    DOMParser: class { parseFromString(html) { return domino.createDocument(html); } },
    getComputedStyle: element => ({ display: element.tagName === 'IMG' ? 'inline' : 'block', whiteSpace: 'normal', overflowY: 'visible', direction: 'ltr', getPropertyValue: () => '' }),
    setTimeout, clearTimeout, console });
  for (const file of ['web/vendor/quill/quill.js', 'modules/content/editor/table-format.js', 'modules/content/editor/image-format.js',
    'web/shell/content.js', 'web/editor/features/save-history.js', 'web/editor/features/rich-text.js']) vm.runInContext(source(file), context);
  const Quill = window.Quill;
  const quill = new Quill('#editor', { registry: context.createNoteImageRegistry(Quill, ['header', 'bold', 'image', 'table']), modules: { toolbar: false }, theme: null });
  context.registerNoteImageClipboard(quill);
  const session = { richEditor: quill, richNoteContent: '', richEditorLoading: false, serializedRichNote: null, noteTagIds: [],
    editor: { value: '' }, editorMode: 'note', richNoteInitialized: true, inlineTagRows: [], target: { id: 'synthetic' }, editorToken: 'token' };
  window.document.querySelector('#inlineMarkdownNoteForm').dataset.editorToken = 'token';
  const state = { editor: { editingMarkdownDocumentId: 'synthetic' }, persistence: { data: { documents: [], cardDocuments: [] } } };
  const config = { $: selector => window.document.querySelector(selector), desktop: { readNoteImage: read } };
  const env = { window, document: window.document, ...Object.fromEntries(['noteImageLayout', 'writeNoteImageLayout', 'noteTableCellWidth', 'serializeNoteTableWidths'].map(key => [key, context[key]])),
    parseNoteCodeStyle: () => null, normalizeNoteCodeName: () => '', serializeNoteLinkCards() {}, serializeNoteCodeStyles() {}, structuredClone,
    openNoteTabs: [], createNoteImageRegistry: context.createNoteImageRegistry, registerNoteLinkCard() {}, registerNoteCodeStyle() {}, createNoteMarkdownBindings: () => ({}) };
  const actions = { reconcileInlineTagRows: rows => rows, loadNoteEditorAssets: async () => {} };
  actions.sanitizeRichNoteContent = context.MemoKeepShell.createContent({ state, config, actions, env }).sanitizeRichNoteContent;
  const features = {};
  Object.assign(features, context.MemoKeepShell.createEditorSaveHistory({ state, config, actions, env, session, features }));
  Object.assign(features, context.MemoKeepShell.createEditorRichText({ state, config, actions, env, session, features }));
  return { window, context, session, quill, state, config, env, actions, features, frames,
    load: html => { session.richNoteContent = html; session.serializedRichNote = null; return features.loadRichNote(html); } };
}

test('cold local images do not delay body rendering and preserve source references before/after hydration', async () => {
  const gate = deferred(), calls = [], h = fixture(id => { calls.push(id); return gate.promise; });
  const html = note(imageId), loading = h.load(html);
  assert.match(h.quill.root.textContent, /图片之前/);
  assert.match(h.quill.root.textContent, /图片之后/);
  assert.equal(h.quill.isEnabled(), false);
  assert.notEqual(h.quill.root.querySelector('img').getAttribute('src'), png);
  assert.equal(h.features.serializeRichNote(), html, 'saving during loading retains the source, not placeholder bytes');
  await tick(); assert.deepEqual(calls, [imageId]);
  gate.resolve({ dataUrl: png, fileName: '磁盘文件名.png' }); await loading;
  const image = h.quill.root.querySelector('img');
  assert.equal(image.getAttribute('src'), png);
  assert.equal(image.dataset.memokeepImageId, imageId);
  assert.equal(image.dataset.fileName, '原图.png');
  const saved = h.features.serializeRichNote();
  assert.match(saved, new RegExp(`src="memokeep-image://${imageId}"`));
  assert.match(saved, /width="420"/); assert.match(saved, /height="280"/); assert.match(saved, /data-image-rotation="90"/);
  assert.doesNotMatch(saved, /data:image|图片不可用/);
  assert.equal(h.quill.isEnabled(), true);
});

test('native image requests start synchronously before real Quill clipboard conversion', async () => {
  const gate = deferred(), events = [], h = fixture(() => { events.push('native-read'); return gate.promise; });
  const convert = h.quill.clipboard.convertHTML.bind(h.quill.clipboard);
  h.quill.clipboard.convertHTML = html => { events.push('clipboard-convert'); return convert(html); };
  const loading = h.load(note(imageId));
  assert.deepEqual(events, ['native-read', 'clipboard-convert']);
  assert.match(h.quill.root.textContent, /图片之后/);
  gate.resolve({ dataUrl: png }); await loading;
  assert.equal(h.quill.root.querySelector('img').getAttribute('src'), png);
});

test('missing image keeps its ID and layout and can be read on a later reopen', async () => {
  let reads = 0;
  const h = fixture(async () => { reads++; return null; });
  await h.load(note(imageId));
  const saved = h.features.serializeRichNote();
  assert.match(saved, new RegExp(imageId)); assert.match(saved, /width="420"/);
  assert.equal(h.quill.root.querySelector('img').title, '图片暂时不可用，重新打开笔记可重试');
  await h.load(saved);
  assert.equal(reads, 2, 'a failure is not cached as a permanently missing image');
  assert.match(h.features.serializeRichNote(), new RegExp(imageId));
});

test('synchronous and asynchronous native failures preserve the source and permit retry', async () => {
  for (const asynchronous of [false, true]) {
    let reads = 0;
    const h = fixture(() => {
      reads++;
      if (reads > 1) return Promise.resolve({ dataUrl: png });
      if (asynchronous) return Promise.reject(new Error('synthetic unavailable'));
      throw new Error('synthetic unavailable');
    });
    await h.load(note(imageId));
    const saved = h.features.serializeRichNote();
    assert.match(saved, new RegExp(`memokeep-image://${imageId}`));
    assert.equal(h.quill.isEnabled(), true);
    await h.load(saved);
    assert.equal(reads, 2);
    assert.equal(h.quill.root.querySelector('img').getAttribute('src'), png);
  }
});

test('reopening a hydrated source uses the image cache and later text edits save the original image reference', async () => {
  let reads = 0;
  const h = fixture(async () => { reads++; return { dataUrl: png }; });
  await h.load(note(imageId));
  const saved = h.features.serializeRichNote();
  await h.load(saved);
  assert.equal(reads, 1);
  assert.equal(h.quill.root.querySelector('img').getAttribute('src'), png);
  h.quill.insertText(0, '编辑后的正文', 'user');
  h.session.serializedRichNote = null; // The real editor's text-change callback invalidates this cache.
  const edited = h.features.captureSnapshot();
  assert.match(edited.noteContent, /编辑后的正文/);
  assert.match(edited.noteContent, new RegExp(`memokeep-image://${imageId}`));
  assert.doesNotMatch(edited.noteContent, /data:image/);
});

test('open-tab image discovery and document scans wait for idle time', async () => {
  const idle = [], reads = [], h = fixture(async id => { reads.push(id); return { dataUrl: png }; });
  let scanned = 0;
  h.window.requestIdleCallback = callback => idle.push(callback);
  h.env.openNoteTabs = [{ id: 'other' }];
  h.state.persistence.data.documents = [{ id: 'other', get metadata() { scanned++; return { noteContent: note(imageId) }; } }];
  await h.load('<p>正文无需等待其他标签图片</p>');
  assert.equal(scanned, 0); assert.equal(reads.length, 0);
  idle.shift()();
  assert.equal(scanned, 1); assert.equal(reads.length, 0);
  await idle.shift()();
  assert.deepEqual(reads, [imageId]);
  await idle.shift()();
});

test('disposed editor and a superseded same-editor load reject late image writes', async () => {
  const old = deferred(), next = deferred(), newerId = imageId.replace(/1$/, '2');
  const h = fixture(id => id === imageId ? old.promise : next.promise);
  const first = h.load(note(imageId)), oldImage = h.quill.root.querySelector('img');
  const second = h.load(note(newerId)), currentImage = h.quill.root.querySelector('img');
  await tick(); old.resolve({ dataUrl: png }); await first;
  assert.equal(h.session.richEditorLoading, true, 'old completion does not clear the new loading guard');
  assert.equal(currentImage.dataset.memokeepImageId, newerId);
  assert.equal(oldImage.getAttribute('src'), currentImage.getAttribute('src'));
  h.session.disposed = true;
  next.resolve({ dataUrl: 'data:image/png;base64,newer' }); await second;
  assert.notEqual(currentImage.getAttribute('src'), 'data:image/png;base64,newer');
  assert.equal(h.quill.isEnabled(), false);
});

test('duplicate references share one native read and keep both image positions', async () => {
  const gate = deferred(), calls = [], h = fixture(id => { calls.push(id); return gate.promise; });
  const loading = h.load(note(imageId) + note(imageId));
  await tick(); assert.deepEqual(calls, [imageId]);
  gate.resolve({ dataUrl: png }); await loading;
  const images = [...h.quill.root.querySelectorAll('img')];
  assert.equal(images.length, 2);
  assert.ok(images.every(image => image.getAttribute('src') === png && image.dataset.memokeepImageId === imageId));
  assert.equal((h.features.serializeRichNote().match(/memokeep-image:\/\//g) || []).length, 2);
});

test('image hydration respects a read-only editor and a removed image is not reinserted', async () => {
  const gate = deferred(), h = fixture(() => gate.promise);
  h.quill.enable(false);
  const loading = h.load(note(imageId));
  h.quill.root.querySelector('.note-image-frame').remove();
  await tick(); gate.resolve({ dataUrl: png }); await loading;
  assert.equal(Boolean(h.quill.root.querySelector('img')), false);
  assert.equal(h.quill.isEnabled(), false);
});

test('editor rebuild waits for assets, cancels stale sessions, and creates Quill read-only', async () => {
  for (const stale of [true, false]) {
    const h = fixture(async () => null), options = [], assets = deferred();
    h.actions.loadNoteEditorAssets = () => assets.promise;
    h.env.window.Quill = class { constructor(_selector, value) { options.push(value); throw new Error('fixture constructor reached'); } };
    h.env.createNoteImageRegistry = () => ({});
    const initializing = h.features.initializeRichNoteEditor();
    await tick(); assert.equal(options.length, 0);
    if (stale) h.session.disposed = true;
    assets.resolve();
    if (stale) { await initializing; assert.equal(options.length, 0); }
    else { await assert.rejects(initializing, /fixture constructor reached/); assert.equal(options[0].readOnly, true); }
  }
});
