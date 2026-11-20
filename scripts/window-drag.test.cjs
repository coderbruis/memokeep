const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');
const { createNoteTabView } = require('../web/views/note-tabs.js');

const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function fixture() {
  const window = domino.createWindow(html), document = window.document;
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, 'dataset')) {
    Object.defineProperty(window.Element.prototype, 'dataset', { get() {
      const element = this;
      return new Proxy({}, {
        get: (_, key) => element.getAttribute(`data-${String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase())}`) ?? undefined,
        set: (_, key, value) => { element.setAttribute(`data-${String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase())}`, value); return true; },
      });
    } });
  }
  if (!window.Element.prototype.append) window.Element.prototype.append = function (...nodes) { nodes.forEach(node => this.appendChild(node)); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const state = { tabs: [{ id: 'one' }, { id: 'two' }], activeId: 'one', isNoteWindow: false, hasChanges: () => false };
  const notes = [{ id: 'one', title: '第一篇' }, { id: 'two', title: '第二篇' }], calls = [], frames = [];
  const actions = {
    documentById: id => notes.find(note => note.id === id), activeNotebooks: () => [], escapeHtml,
    shortcuts: { label: () => '⌘S', matches: () => false },
    fileExtension: () => '', fileIcon: () => '<svg aria-hidden="true"></svg>',
    activate: async id => { calls.push(['activate', id]); return true; },
    closeTab: async id => { calls.push(['close', id]); },
    requestNew: async () => { calls.push(['new']); },
  };
  class Observer { observe() {} disconnect() {} }
  const platform = { window, document, requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame() {}, ResizeObserver: Observer, MutationObserver: Observer };
  const view = createNoteTabView({ state, actions, $: selector => document.querySelector(selector), platform });
  const event = (node, type, values = {}) => {
    const event = document.createEvent('Event'); event.initEvent(type, true, true);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    node.dispatchEvent(event); return event;
  };
  return { window, document, state, actions, calls, frames, view, event };
}

test('shared title surfaces opt into direct-hit Tauri dragging without marking controls or deep subtrees', () => {
  const { document } = fixture();
  for (const selector of ['.window-toolbar', '#workspacePageTabs', '.workspace-titlebar', '#workspaceOpenTabs', '#noteTabsBar']) {
    assert.equal(document.querySelector(selector).getAttribute('data-tauri-drag-region'), '', selector);
  }
  assert.equal(document.querySelectorAll('[data-tauri-drag-region="deep"]').length, 0);
  assert.equal(document.querySelectorAll('button[data-tauri-drag-region], input[data-tauri-drag-region], a[data-tauri-drag-region]').length, 0);
  assert.equal(document.querySelector('#sidebarCollapseBtn').closest('[data-tauri-drag-region]'), document.querySelector('.window-toolbar'));
});

test('real note-tab markup keeps its blank containers draggable and tabs explicitly excluded', async () => {
  const f = fixture();
  f.view.renderNoteTabs();
  for (const selector of ['.note-tab-navigation', '.note-tab-list', '.note-tab-actions']) {
    assert.equal(f.document.querySelector(selector).getAttribute('data-tauri-drag-region'), '', selector);
  }
  const bar = f.document.querySelector('#noteTabsBar');
  for (const tab of bar.querySelectorAll('[draggable="true"]')) assert.equal(tab.getAttribute('data-tauri-drag-region'), 'false');
  f.view.bindNoteTabs();
  const menu = f.document.querySelector('#noteTabContextMenu');
  Object.defineProperty(menu, 'matches', { value: () => false }); // Domino has no native popover state.
  f.event(f.document.querySelector('[data-note-tab="two"] .note-tab-title'), 'click'); await turn();
  f.event(f.document.querySelector('[data-close-note-tab="one"] svg'), 'click'); await turn();
  f.event(f.document.querySelector('#newNoteTabButton'), 'click'); await turn();
  assert.deepEqual(f.calls, [['activate', 'two'], ['close', 'one'], ['new']]);
  assert.equal(f.document.querySelector('#newNoteTabButton').hasAttribute('data-tauri-drag-region'), false);
});

test('HTML tab reorder remains active and close buttons cannot start a tab drag', () => {
  const f = fixture(); f.view.renderNoteTabs(); f.view.bindNoteTabs();
  const data = new Map(), transfer = { setData: (type, value) => data.set(type, value) };
  const source = f.document.querySelector('[data-note-tab-order="one"]');
  assert.equal(f.event(source, 'dragstart', { dataTransfer: transfer }).defaultPrevented, false);
  assert.equal(data.get('application/x-memokeep-note-tab'), 'one');
  assert.equal(source.getAttribute('data-tauri-drag-region'), 'false');
  const target = f.document.querySelector('[data-note-tab-order="two"]');
  Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ left: 0, width: 100 }) });
  f.event(target, 'drop', { clientX: 99, dataTransfer: transfer });
  assert.deepEqual(f.state.tabs.map(tab => tab.id), ['two', 'one']);
  data.clear();
  const close = f.document.querySelector('[data-close-note-tab="one"]');
  assert.equal(f.event(close, 'dragstart', { dataTransfer: transfer }).defaultPrevented, true);
  assert.equal(data.size, 0);
});

test('the inactive-note strip preserves button actions and direct-hit dragging around real page tabs', async () => {
  const f = fixture();
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/shell/page-tabs.js'), 'utf8'), context);
  const pageTabs = context.MemoKeepShell.createPageTabFeatures({
    state: { shell: {}, persistence: {} }, config: { $: selector => f.document.querySelector(selector) },
    actions: { escapeHtml }, env: { window: f.window, get openNoteTabs() { return f.state.tabs; } },
  });
  pageTabs.rememberPageTab('settings');
  f.actions.pageTabItems = () => pageTabs.workspacePageTabItems();
  f.state.activeId = null; f.view.renderNoteTabs();
  const strip = f.document.querySelector('#workspaceOpenTabs');
  assert.equal(strip.getAttribute('data-tauri-drag-region'), '');
  assert.equal(strip.querySelector('.workspace-open-tabs-list').getAttribute('data-tauri-drag-region'), '');
  for (const tab of strip.querySelectorAll('.workspace-open-tab')) assert.equal(tab.getAttribute('data-tauri-drag-region'), 'false');
  const page = strip.querySelector('[data-workspace-tab-key="page:settings"]');
  assert.equal(page.hasAttribute('data-tauri-drag-region'), false, 'unmarked page-tab descendants do not inherit a bare ancestor drag region');
  assert.equal(page.closest('[data-tauri-drag-region]').getAttribute('data-tauri-drag-region'), '');
  f.event(strip.querySelector('[data-open-tab="two"] span'), 'click'); await turn();
  f.event(strip.querySelector('[data-close-open-tab="one"] svg'), 'click'); await turn();
  f.event(strip.querySelector('[data-new-open-tab]'), 'click'); await turn();
  assert.deepEqual(f.calls, [['activate', 'two'], ['close', 'one'], ['new']]);
});

test('the existing blank-window drag layer carries a direct native drag marker', () => {
  const f = fixture(); f.view.renderNoteTabs();
  f.view.bindNoteTabWindowDrag(f.document.querySelector('#noteTabsBar'));
  const layer = f.document.querySelector('.note-window-drag-space');
  assert.equal(layer.getAttribute('data-tauri-drag-region'), '');
  assert.equal(layer.getAttribute('aria-hidden'), 'true');
  assert.equal(layer.childElementCount, 0);
});

test('the community main capability grants the two narrow commands used by Tauri title regions', () => {
  const capability = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/desktop/src-tauri/capabilities/workspace-main.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main']);
  for (const permission of ['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize']) assert(capability.permissions.includes(permission));
  assert(!capability.permissions.includes('core:window:default'));
});
