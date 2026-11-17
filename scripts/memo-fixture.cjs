const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domino = require('@mixmark-io/domino');

const web = path.join(__dirname, '../web');
function setup(repeat = 'daily', completed = false) {
  const clock = { at: new Date('2026-10-07T10:00:00Z').getTime() };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.at])); }
    static now() { return clock.at; }
  }
  const window = domino.createWindow(fs.readFileSync(path.join(web, 'index.html'), 'utf8'), 'http://localhost/');
  const document = window.document;
  require('./shell-fixture.cjs').patchBrowserPopovers(window, document);
  const nodeList = Object.getPrototypeOf(document.querySelectorAll('button'));
  if (!nodeList[Symbol.iterator]) nodeList[Symbol.iterator] = Array.prototype[Symbol.iterator];
  if (!nodeList.forEach) nodeList.forEach = Array.prototype.forEach;
  Object.defineProperty(window.Element.prototype, 'dataset', { configurable: true, get() {
    const node = this;
    return new Proxy({}, { get: (_, key) => node.getAttribute(`data-${String(key).replace(/[A-Z]/g, v => `-${v.toLowerCase()}`)}`) || undefined, set: (_, key, value) => { node.setAttribute(`data-${String(key).replace(/[A-Z]/g, v => `-${v.toLowerCase()}`)}`, String(value)); return true; } });
  } });
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'showModal', { value: () => { dialog.open = true; } });
    Object.defineProperty(dialog, 'close', { value: () => {
      dialog.open = false;
      dialog.dispatchEvent(new window.Event('close'));
    } });
  }
  const storage = { value: {
    memos: [{ id: 'memo', title: '已经处理的事项', notes: '正文', repeat, completed,
      remindAt: '2026-10-07T09:00:00Z', notifiedFor: null, popupShownFor: null }],
    settings: { notificationsEnabled: true }
  } };
  const notifications = [];
  window.memoKeepDesktop = {
    write: async value => { storage.value = structuredClone(value); return structuredClone(value); },
    notify: message => notifications.push(message), openApp: async () => {}
  };
  const context = vm.createContext({ window, document, Date: ClockDate, URLSearchParams, structuredClone,
    crypto: require('node:crypto').webcrypto, localStorage: { getItem: () => null },
    requestAnimationFrame() {}, setTimeout() {}, clearInterval() {}, setInterval() {}, console });
  const run = code => vm.runInContext(code, context);
  for (const file of ["vendor/ts-fsrs/index.umd", "review-session", "fsrs-scheduler"]) vm.runInContext(fs.readFileSync(path.join(web, file + ".js"), "utf8"), context);
  for (const name of ["naming", "inline-cards", "image-references", "queries", "card-list"]) vm.runInContext(fs.readFileSync(path.join(web, "domain", name + ".js"), "utf8"), context);
  for (const name of ["storage-adapter", "save-coordinator", "sync-coordinator"]) vm.runInContext(fs.readFileSync(path.join(web, "persistence", name + ".js"), "utf8"), context);
  for (const file of ["state/application-state", "application/card-operations", "application/card-trash", "application/card-runtime", "application/memo-operations", "application/settings-operations", "application/knowledge-operations", "application/review-transactions", "application/review-operations", "application/review-runtime"]) vm.runInContext(fs.readFileSync(path.join(web, file + ".js"), "utf8"), context);
  for (const file of ["editor/session", "editor/save-session", "editor/content-transactions", "editor/quill-transactions", "views/note-tabs", "views/review", "views/review-events", "views/card-list", "views/card-bulk", "views/card-list-events", "views/card-editor", "views/card-detail", "views/card-dialog-events"]) vm.runInContext(fs.readFileSync(path.join(web, file + ".js"), "utf8"), context);
  for (const file of ["views/shell", "bootstrap/composition", "bootstrap/startup"]) vm.runInContext(fs.readFileSync(path.join(web, file + ".js"), "utf8"), context);
  require('./shell-fixture.cjs').loadShellModules(context, web);
  for (const file of ['directory-tree.js', 'card-workspace.js', 'note-tags.js', 'legacy/application.js', 'app.js']) {
    run(fs.readFileSync(path.join(web, file), 'utf8'));
  }
  require('./shell-fixture.cjs').bindShellFixture(context);
  Object.assign(context, { seed: storage.value });
  run('data = normalize(seed); persistedData = structuredClone(data); applicationDataReady = true; bindMemoEvents();');
  return { run, clock, storage, notifications, document, context, window };
}


module.exports = { setup };
