const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');

const code = fs.readFileSync(path.join(__dirname, '../web/note-link-paste.js'), 'utf8');

class Delta {
  constructor() { this.ops = []; }
  retain(count) { this.ops.push({ retain: count }); return this; }
  delete(count) { this.ops.push({ delete: count }); return this; }
  insert(value, attributes) { this.ops.push({ insert: value, attributes }); return this; }
  concat(other) { this.ops.push(...other.ops); return this; }
  length() { return this.ops.reduce((sum, op) => sum + (typeof op.insert === 'string' ? op.insert.length : op.insert ? 1 : 0), 0); }
}

function fixture(reader) {
  const window = domino.createWindow('<!doctype html><html><body><div id="editor"></div></body></html>');
  window.Element.prototype.append ||= function (...nodes) { nodes.forEach(node => this.appendChild(node)); };
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, 'dataset')) {
    Object.defineProperty(window.Element.prototype, 'dataset', { get() {
      const element = this;
      return new Proxy({}, { get: (_, key) => element.getAttribute('data-' + key.replace(/[A-Z]/g, value => '-' + value.toLowerCase())) });
    } });
  }
  window.Element.prototype.showPopover = function () {};
  window.Element.prototype.hidePopover = function () {};
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400 });
  const root = window.document.querySelector('#editor');
  const updates = [];
  const quill = {
    root, container: root,
    history: { cutoff() {} },
    getBounds: () => ({ left: 0, bottom: 20 }),
    getSelection: () => ({ index: 0, length: 0 }),
    getFormat: () => ({}),
    getLine: () => [{ formats: () => ({}) }],
    isEnabled: () => true,
    updateContents: value => updates.push(value.ops),
    setSelection() {}, on() {}, off() {},
  };
  window.Quill = { import: name => name === 'delta' ? Delta : { link: '' } };
  window.memoKeepDesktop = { readLinkPreview: reader };
  const context = vm.createContext({ window, document: window.document, URL, Promise, AbortController,
    innerWidth: 800, innerHeight: 600, requestAnimationFrame: () => 0, cancelAnimationFrame() {} });
  vm.runInContext(code, context);
  context.bindNoteLinkPaste(quill);
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { items: [], getData: type => type === 'text/plain' ? 'https://example.com/' : '' };
  root.dispatchEvent(event);
  return { window, menu: window.document.querySelector('.note-link-menu'), updates };
}

test('link menu requests a fresh read only for its explicit refresh action and reports failure', async () => {
  const calls = [];
  const { window, menu, updates } = fixture(async (url, options) => {
    calls.push({ url, refresh: options?.refresh });
    return calls.length === 1 ? { title: 'Cached title', description: 'Existing metadata' } : { error: 'offline' };
  });
  menu.querySelector('[data-link-view="card"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ url: 'https://example.com/', refresh: false }]);
  menu.querySelector('[data-link-refresh]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [
    { url: 'https://example.com/', refresh: false },
    { url: 'https://example.com/', refresh: true },
  ]);
  assert.equal(menu.querySelector('.note-link-status').textContent, '暂时无法读取网页，可稍后重试');
  const card = updates.at(-1).find(op => op.insert?.noteLinkCard).insert.noteLinkCard;
  assert.equal(card.title, 'Cached title');
  assert.equal(card.description, 'Existing metadata');
});

test('refresh also reads metadata while keeping the plain link display selected', async () => {
  const calls = [];
  const { window, menu, updates } = fixture(async (url, options) => {
    calls.push({ url, refresh: options?.refresh });
    return { title: 'Fresh title' };
  });
  menu.querySelector('[data-link-refresh]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ url: 'https://example.com/', refresh: true }]);
  assert.equal(menu.querySelector('[data-link-view="link"]').getAttribute('aria-checked'), 'true');
  assert.equal(updates.at(-1).find(op => typeof op.insert === 'string').insert, 'https://example.com/');

  menu.querySelector('[data-link-view="card"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(updates.at(-1).find(op => op.insert?.noteLinkCard).insert.noteLinkCard.title, 'Fresh title');
});
