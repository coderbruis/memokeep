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
const bridge = `(() => { if (typeof applicationShell === 'undefined' || globalThis.__shellFixtureBound) return; globalThis.__shellFixtureBound = true;
 const shell = applicationShell, routes = ${JSON.stringify({ ...manifest.fields, ...manifest.constants, ...manifest.functions })};
 for (const [name, route] of Object.entries(routes)) { const parts = route.split('.'), key = parts.pop(); let owner = shell; for (const part of parts) owner = owner[part];
 if (Object.getOwnPropertyDescriptor(globalThis, name)?.configurable === false) continue;
 Object.defineProperty(globalThis, name, { configurable: true, get: () => owner[key], set: value => { owner[key] = value; } }); }
})();`;
const observed = new WeakSet();
function shellTest(contents) {
  if (!observed.has(contents)) { observed.add(contents); contents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); }); }
  return { executeJavaScript: (source, ...args) => contents.executeJavaScript(bridge + '\n' + source, ...args) };
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
module.exports = { loadShellModules, bindShellFixture, syntheticShell, shellTest, patchBrowserPopovers };
