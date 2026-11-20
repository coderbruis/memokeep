const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');

const code = fs.readFileSync(path.join(__dirname, '../web/note-link-paste.js'), 'utf8');
const original = 'https://example.com/cover.png';
const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function setup(reader) {
  const window = domino.createWindow('<!doctype html><html><body></body></html>');
  window.Element.prototype.append ||= function (...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  };
  window.Element.prototype.replaceChildren ||= function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, 'dataset')) {
    Object.defineProperty(window.Element.prototype, 'dataset', { get() {
      const element = this;
      const attribute = key => 'data-' + key.replace(/[A-Z]/g, value => '-' + value.toLowerCase());
      return new Proxy({}, {
        get: (_, key) => element.getAttribute(attribute(key)) ?? undefined,
        set: (_, key, value) => { element.setAttribute(attribute(key), String(value)); return true; }
      });
    } });
  }
  window.memoKeepDesktop = { readLinkPreviewImage: reader };
  const frames = [];
  const context = vm.createContext({ window, document: window.document, URL, Promise,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; } });
  vm.runInContext(code, context);
  const card = window.document.createElement('a'); card.className = 'note-link-card';
  context.writeNoteLinkCard(card, { url: 'https://example.com/', title: '正文', image: original });
  window.document.body.append(card);
  return { context, window, card, flush: () => frames.splice(0).forEach(callback => callback()) };
}

test('native covers do not assign remote src and preserve the original shared URL', async () => {
  const calls = [];
  const { context, card, flush } = setup(async url => { calls.push(url); return data; });
  assert.equal(card.querySelector('img').getAttribute('src'), null);
  assert.equal(context.readNoteLinkCard(card).image, original);
  flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [original]);
  assert.equal(card.querySelector('img').getAttribute('src'), data);
  assert.equal(context.readNoteLinkCard(card).image, original);
  context.loadNoteLinkCover(card.querySelector('img'));
  assert.equal(calls.length, 1);
});

test('failed or non-raster cover responses never become a browser URL', async () => {
  for (const response of [{ error: '拒绝私网' }, 'http://127.0.0.1/private', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const { card, flush } = setup(async () => response);
    flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.querySelector('img').getAttribute('src'), null);
    assert.equal(card.querySelector('img').style.display, 'none');
  }
});

test('serialization creates cover elements in the inert owner document', async () => {
  const { context, window, card, flush } = setup(async () => data);
  flush(); await new Promise(resolve => setImmediate(resolve));
  // Domino lacks the browser's separate template owner, so supply an inert document explicitly.
  const inert = domino.createDocument('<!doctype html><html><body></body></html>');
  const content = inert.createElement('div');
  content.innerHTML = card.outerHTML;
  const activeFactory = window.document.createElement;
  window.document.createElement = () => { throw new Error('serialization used an active document'); };
  try {
    context.serializeNoteLinkCards(content);
    const image = content.querySelector('img');
    assert.equal(image.getAttribute('src'), original);
    assert.equal(image.ownerDocument, inert);
  } finally { window.document.createElement = activeFactory; }
});
