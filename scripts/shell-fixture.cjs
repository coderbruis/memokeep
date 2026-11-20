// Test-only adapters keep historical assertions pointed at the single module owner.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manifest = require('./fixtures/shell-manifest.json');
function loadShellModules(context, web) {
  for (const file of manifest.files) vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), context);
}
function bindShellFixture(context) {
  const shell = vm.runInContext('applicationShell', context);
  for (const [name, route] of Object.entries({ ...manifest.fields, ...manifest.constants, ...manifest.functions })) {
    const parts = route.split('.'); const key = parts.pop(); let owner = shell;
    for (const part of parts) owner = owner[part];
    Object.defineProperty(context, name, { configurable: true, enumerable: true, get: () => owner[key], set: value => { owner[key] = value; } });
  }
  return shell;
}
function syntheticShell(context) {
  const shell = { state: { persistence: {}, knowledge: {}, editor: {}, memos: {}, shell: {} }, config: {}, actions: {} };
  for (const [name, route] of Object.entries({ ...manifest.fields, ...manifest.constants, ...manifest.functions })) {
    const parts = route.split('.'); const key = parts.pop(); let owner = shell;
    for (const part of parts) owner = owner[part];
    Object.defineProperty(owner, key, { configurable: true, get: () => context[name], set: value => { context[name] = value; } });
  }
  context.applicationShell = shell;
  return shell;
}
function patchBrowserPopovers(window, document) {
  const opened = new WeakSet();
  const patch = element => {
    const matches = element.matches.bind(element);
    Object.defineProperty(element, 'matches', { value: selector => selector === ':popover-open' ? opened.has(element) : matches(selector) });
    const toggle = open => {
      open ? opened.add(element) : opened.delete(element);
      const event = new window.Event('toggle'); event.newState = open ? 'open' : 'closed'; element.dispatchEvent(event);
    };
    element.showPopover = () => toggle(true); element.hidePopover = () => toggle(false);
    return element;
  };
  Array.from(document.querySelectorAll('*')).forEach(patch);
  const create = document.createElement.bind(document);
  Object.defineProperty(document, 'createElement', { value: tag => patch(create(tag)) });
  const query = document.querySelectorAll.bind(document);
  Object.defineProperty(document, 'querySelectorAll', { value: selector => selector.includes(':popover-open')
    ? Array.from(query(selector.replaceAll(':popover-open', ''))).filter(node => opened.has(node)) : query(selector) });
}
module.exports = { loadShellModules, bindShellFixture, syntheticShell, patchBrowserPopovers };
