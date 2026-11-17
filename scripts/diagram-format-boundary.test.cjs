const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('public diagram format preserves saved layouts without shipping visual editing controls', () => {
  const api = vm.createContext({});
  for (const file of ['source.js', 'canvas-model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../modules/content/diagrams', file), 'utf8'), api);
  for (const name of ['mermaidCanvasEdgeHandles', 'mermaidCanvasNodeHandles', 'mermaidCanvasResizeBox',
    'mermaidCanvasBoxSelection', 'moveMermaidCanvasSelection', 'mermaidCanvasEditorMarkup', 'mermaidConnectionSample']) assert.equal(api[name], undefined, name);
  const model = api.seedMermaidCanvasLayout(api.parseEditableMermaidFlow('flowchart LR\nA[开始]-->B[结束]'));
  Object.assign(model.layout.nodes.A, { x: -240.5, y: 180, width: 280, height: 96, fill: '#eff6ff' });
  model.layout.edges[0] = { fromPort: 'right', toPort: 'left', bends: [{ x: 100, y: 180 }], linePattern: 'dashed' };
  const source = api.serializeEditableMermaidFlow(model);
  assert.deepEqual(JSON.parse(JSON.stringify(api.parseEditableMermaidFlow(source))), JSON.parse(JSON.stringify(model)));
  const svg = api.renderSavedMermaidCanvas(source);
  assert.match(svg, /translate\(-240\.5,180\)/);
  assert.match(svg, /fill="#eff6ff"/);
  assert.doesNotMatch(svg, /mermaid-node-(?:resize|ports)|mermaid-edge-(?:handles|hit)|is-selected|tabindex/);
  assert.equal(api.mermaidCanvasMarkup(model, { selected: { type: 'node', id: 'A' }, editable: true }), api.mermaidCanvasMarkup(model));
});

test('public sequence rendering restores saved offsets and bends without editing handles', () => {
  const { createWindow } = require('@mixmark-io/domino');
  const window = createWindow('<svg viewBox="0 0 220 140"><g data-et="participant" data-id="A"></g><g data-et="participant" data-id="B"></g><line class="actor-line" name="A" x1="20" x2="20"/><line class="actor-line" name="B" x1="180" x2="180"/><line data-et="message" data-from="A" data-to="B" x1="20" x2="180" y1="40" y2="40"/><text class="messageText" x="100">hello</text></svg>');
  if (!Object.getOwnPropertyDescriptor(window.Element.prototype, 'dataset')) Object.defineProperty(window.Element.prototype, 'dataset', {
    get() {
      const node = this, attribute = key => 'data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
      return new Proxy({}, { get: (_, key) => node.getAttribute(attribute(key)),
        set: (_, key, value) => { node.setAttribute(attribute(key), value); return true; },
        deleteProperty: (_, key) => { node.removeAttribute(attribute(key)); return true; } });
    }
  });
  const api = vm.createContext({ document: window.document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../modules/content/diagrams/sequence-model.js'), 'utf8'), api);
  for (const name of ['createMermaidSequenceDrag', 'mermaidSequenceComponentIcon', 'mermaidSequenceEditorParts',
    'paintMermaidSequenceRoute', 'positionMermaidSequenceRouteHandles', 'translateMermaidSequencePart', 'positionMermaidSequenceDrop']) assert.equal(api[name], undefined, name);
  let source = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hello';
  source = api.setMermaidSequenceOffset(source, 'A', -24);
  source = api.setMermaidSequenceOffset(source, 'B', 32);
  source = api.setMermaidSequenceElementPosition(source, 'message:A->>B: hello:0', 0, 12);
  source = api.setMermaidSequenceElementPosition(source, 'route:A->>B: hello:0', 25, 40);
  source = api.setMermaidSequenceElementPosition(source, 'step:A->>B: hello:0', 50, 16);
  const svg = window.document.querySelector('svg');
  api.applyMermaidSequenceOffsets(svg, source);
  const route = svg.querySelector('[data-et="message"]');
  assert.equal(svg.querySelector('.actor-line[name="A"]').getAttribute('x1'), '-4');
  assert.equal(svg.querySelector('.actor-line[name="B"]').getAttribute('x1'), '212');
  assert.equal(route.tagName, 'path');
  assert.equal(route.getAttribute('d'), 'M -4 40 L 129 40 L 129 56 L 154 56 L 154 80 L 212 80');
  assert.equal(route.getAttribute('transform').trim(), 'translate(0 12)');
  assert.equal(svg.querySelector('.messageText').getAttribute('x'), '104');
  assert.equal(api.mermaidSequenceParts(svg, api.parseMermaidSequence(source), true).length, 1);
  assert.equal(svg.querySelectorAll('[tabindex], [data-sequence-endpoint], [data-sequence-segment], .mermaid-sequence-message-hit').length, 0);
});
