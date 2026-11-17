const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const files = ['naming', 'inline-cards', 'image-references', 'queries'];
const api = Object.assign({}, ...files.map(name => require('../web/domain/' + name + '.js')));
const fixtures = require('./fixtures/app-domain-baseline.json');
for (const [index, { fn, args, expected }] of fixtures.entries()) {
  test(`pre-extraction behavior ${index}: ${fn}`, () => {
    const before = structuredClone(args);
    assert.deepEqual(api[fn](...args), expected);
    assert.deepEqual(args, before, 'Queries and rules must not mutate inputs');
  });
}
test('snapshot queries preserve source precedence, due boundaries and local day semantics', () => {
  const timestamp = new Date(2026, 9, 17, 12).getTime();
  const snapshot = { knowledgeBases: [{ id: 'lib' }], documents: [{ id: 'note', title: 'primary' }],
    cardDocuments: [{ id: 'note', title: 'legacy' }, { id: 'legacy' }], items: [{ id: 'item' }],
    cards: [{ id: 'due', status: 'active', dueAt: timestamp }, { status: 'paused', dueAt: 0 }, { status: 'active', dueAt: timestamp + 1 }],
    reviewRecords: [{ reviewedAt: timestamp }, { reviewedAt: new Date(2026, 9, 16, 23).getTime() }] };
  const before = structuredClone(snapshot);
  assert.equal(api.documentById(snapshot, 'note'), snapshot.documents[0]);
  assert.equal(api.documentById(snapshot, 'legacy'), snapshot.cardDocuments[1]);
  assert.equal(api.documentById(snapshot, 'missing'), undefined);
  assert.equal(api.documentById({ documents: [] }, 'missing'), undefined);
  assert.equal(api.libraryById(snapshot, 'lib'), snapshot.knowledgeBases[0]);
  assert.equal(api.itemById(snapshot, 'item'), snapshot.items[0]);
  assert.deepEqual(api.dueCards(snapshot, timestamp), [snapshot.cards[0]]);
  assert.deepEqual(api.reviewsToday(snapshot, timestamp), [snapshot.reviewRecords[0]]);
  assert.equal(api.todayKey(timestamp), '2026-10-17');
  assert.deepEqual(snapshot, before);
});
test('browser globals and CommonJS expose the same rules without platform dependencies', () => {
  const context = vm.createContext({});
  for (const name of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/domain', name + '.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.MemoKeepDomain).sort(), Object.keys(api).sort());
  for (const { fn, args, expected } of fixtures) assert.equal(JSON.stringify(context.MemoKeepDomain[fn](...args)), JSON.stringify(expected));
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  for (const name of files) assert.ok(html.indexOf(`src="domain/${name}.js"`) < html.indexOf('src="app.js"'));
});
