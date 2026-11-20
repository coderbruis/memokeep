const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const fixture = require('./fixtures/fsrs-contract-vectors.json');
const nodeScheduler = require('../web/fsrs-scheduler.js');

const browser = createContext({});
for (const file of ['vendor/ts-fsrs/index.umd.js', 'fsrs-scheduler.js']) {
  runInContext(readFileSync(require.resolve(`../web/${file}`), 'utf8'), browser);
}
const webScheduler = runInContext('MemoScheduler', browser);
const json = value => JSON.parse(JSON.stringify(value));

for (const { id, input, expected, expectedError } of fixture.vectors) {
  test(`FSRS golden ${id} in Node and bundled browser`, () => {
    for (const scheduler of [nodeScheduler, webScheduler]) {
      assert.equal(scheduler.version, fixture.schedulerVersion);
      const { options, card, records, rating, at } = structuredClone(input);
      try {
        scheduler.configure(options);
        const review = () => scheduler.review(card, records, rating, at);
        if (expectedError) assert.throws(review, { message: expectedError });
        else {
          assert.deepEqual(json(review()), expected);
          assert.equal(scheduler.preview(card, records, at)[rating].dueAt, expected.card.dueAt);
        }
        assert.deepEqual({ options, card, records, rating, at }, input);
      } finally { scheduler.configure(); }
    }
  });
}
