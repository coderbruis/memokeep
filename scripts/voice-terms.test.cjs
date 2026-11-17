const test = require('node:test');
const assert = require('node:assert/strict');
const terms = require('../web/domain/voice-terms.js');

const entries = terms.dictionary();

test('built-in list: enough terms, aliases are at least two characters and never shared between terms', () => {
  assert.ok(terms.BUILTIN.length >= 150, `${terms.BUILTIN.length} built-in terms`);
  const owner = new Map();
  for (const entry of terms.BUILTIN) for (const alias of entry.aliases) {
    assert.ok([...alias].length >= 2, `${entry.term}: ${alias}`);
    const key = terms.normalizeKey(alias);
    assert.ok(!owner.has(key) || owner.get(key) === entry.term, `${alias} belongs to ${owner.get(key)} and ${entry.term}`);
    owner.set(key, entry.term);
  }
});

test('correct: aliases become terms, spelled-out letters are joined, positions point at the new text', () => {
  const result = terms.correct('卡夫卡的 I S R 就是和黎德保持同步，还有瑞迪斯', { entries });
  assert.equal(result.text, 'Kafka的 ISR 就是和leader保持同步，还有Redis');
  assert.deepEqual(result.fixes.map(fix => [fix.from, fix.to, result.text.slice(fix.start, fix.end)]),
    [['卡夫卡', 'Kafka', 'Kafka'], ['I S R', 'ISR', 'ISR'], ['黎德', 'leader', 'leader'], ['瑞迪斯', 'Redis', 'Redis']]);
});

test('correct: the card answer decides the spelling; case-only changes are not marked as fixes', () => {
  const result = terms.correct('卡夫卡和 mysql', { entries, reference: 'kafka 用 MySQL 存 offset' });
  assert.equal(result.text, 'kafka和 MySQL');
  assert.deepEqual(result.fixes.map(fix => fix.from), ['卡夫卡'], 'mysql → MySQL is a silent case fix');
});

test('correct: only whole words for English, ordinary Chinese is left alone', () => {
  assert.equal(terms.correct('能力的提升给特别的人', { entries }).text, '能力的提升给特别的人');
  assert.equal(terms.correct('kafkaesque 和 javascripts', { entries }).text, 'kafkaesque 和 javascripts', 'Longer English words are not cut');
  assert.equal(terms.correct('', { entries }).text, '');
});

test('my word list wins and disabled built-ins are skipped', () => {
  const mine = terms.dictionary({ mine: [{ term: 'Kafka', aliases: ['咖啡卡'] }, { term: 'PolarDB', aliases: ['破啦DB'] }], disabled: ['Redis'] });
  assert.equal(terms.correct('咖啡卡和卡夫卡', { entries: mine }).text, 'Kafka和Kafka', 'My aliases and built-in aliases both apply');
  assert.equal(terms.correct('破啦DB', { entries: mine }).text, 'PolarDB');
  assert.equal(terms.correct('瑞迪斯', { entries: mine }).text, '瑞迪斯', 'Disabled built-in term is not corrected');
  assert.equal(mine.filter(entry => entry.term === 'Kafka').length, 1, 'No duplicate entry for a built-in I also own');
});

test('hints: card terms first, then my words, then built-ins, at most 100', () => {
  const mine = terms.dictionary({ mine: [{ term: 'PolarDB', aliases: [] }] });
  const list = terms.hints({ question: 'kafka的ISR是什么？', answer: 'ISR（In-Sync Replicas）是与 leader 保持同步的副本集合', entries: mine });
  assert.deepEqual(list.slice(0, 6), ['kafka', 'ISR', 'In-Sync', 'Replicas', 'leader', 'PolarDB']);
  assert.equal(list.length, 100);
  assert.equal(new Set(list.map(terms.normalizeKey)).size, list.length, 'No duplicates (kafka / Kafka)');
});

test('learn: edits that turn Chinese into an English term become word-list suggestions', () => {
  assert.deepEqual(terms.learn('卡夫卡的爱四月就是同步副本', 'kafka的ISR就是同步副本', { entries, reference: 'Kafka 的 ISR' }),
    [{ from: '卡夫卡', to: 'Kafka' }, { from: '爱四月', to: 'ISR' }]);
  assert.deepEqual(terms.learn('就是同步副本', '就是同步的副本', { entries }), [], 'Chinese edits are not learned');
  assert.deepEqual(terms.learn('用了瑞', '用了Redis', { entries }), [], 'Single-character readings are not learned');
  assert.deepEqual(terms.learn('破啦DB 很快', 'PolarDB 很快', { entries }), [{ from: '破啦DB', to: 'PolarDB' }]);
});

test('remember merges into my word list without duplicates', () => {
  const first = terms.remember([], [{ from: '卡夫卡', to: 'Kafka' }]);
  assert.deepEqual(first, [{ term: 'Kafka', aliases: ['卡夫卡'] }]);
  const second = terms.remember(first, [{ from: '咖夫卡', to: 'kafka' }, { from: '卡夫卡', to: 'Kafka' }, { from: '破啦DB', to: 'PolarDB' }]);
  assert.deepEqual(second, [{ term: 'Kafka', aliases: ['卡夫卡', '咖夫卡'] }, { term: 'PolarDB', aliases: ['破啦DB'] }]);
  assert.deepEqual(first, [{ term: 'Kafka', aliases: ['卡夫卡'] }], 'Input is not mutated');
});

test('word lists: defaults are my words + IT, built-in packs have safe aliases', () => {
  const list = terms.packs({});
  assert.deepEqual(list.map(pack => pack.id), ['mine', 'it', 'workplace', 'business', 'english', 'daily', 'finance']);
  assert.deepEqual(list.filter(pack => pack.enabled).map(pack => pack.id), ['mine', 'it']);
  for (const pack of list.filter(item => item.kind === 'builtin')) {
    assert.ok(pack.terms.length >= 10, `${pack.name} has terms`);
    for (const entry of pack.terms) for (const alias of entry.aliases) assert.ok([...alias].length >= 2, `${pack.name}: ${entry.term} ← ${alias}`);
  }
  assert.equal(terms.dictionary({}).length, terms.BUILTIN.length, 'Default dictionary is the IT list');
});

test('word lists: only enabled packs correct, and enabling more adds their terms', () => {
  const it = terms.dictionary({});
  assert.equal(terms.correct('戴德兰之前交', { entries: it }).text, '戴德兰之前交', 'Workplace terms are off by default');
  const more = terms.dictionary({ packs: { enabled: ['mine', 'it', 'workplace'] } });
  assert.equal(terms.correct('戴德兰之前交，开批爱', { entries: more }).text, 'deadline之前交，KPI');
  const only = terms.dictionary({ packs: { enabled: ['workplace'] } });
  assert.equal(terms.correct('卡夫卡', { entries: only }).text, '卡夫卡', '「只用这个」leaves IT off');
});

test('word lists: a reading in several packs follows the card answer, then my words, then pack order', () => {
  const both = terms.dictionary({ packs: { enabled: ['it', 'finance'] } });
  assert.equal(terms.correct('斯威夫特', { entries: both }).text, 'Swift', 'IT comes first in the default order');
  assert.equal(terms.correct('斯威夫特', { entries: both, reference: 'SWIFT 报文' }).text, 'SWIFT', 'The card answer wins');
  const reordered = terms.dictionary({ packs: { enabled: ['it', 'finance'], order: ['finance', 'it'] } });
  assert.equal(terms.correct('斯威夫特', { entries: reordered }).text, 'SWIFT', 'Pack order decides');
  const mine = terms.dictionary({ mine: [{ term: 'Taylor Swift', aliases: ['斯威夫特'] }], packs: { enabled: ['mine', 'it', 'finance'] } });
  assert.equal(terms.correct('斯威夫特', { entries: mine }).text, 'Taylor Swift', 'My words come before every pack');
});

test('word lists: custom packs, hints take turns between packs, addTo writes to the right place', () => {
  const settings = { voiceTerms: [], voicePacks: { enabled: ['mine', 'it', 'custom-a'], custom: [{ id: 'custom-a', name: '公司内部', terms: [{ term: 'Polaris', aliases: ['波拉瑞斯'] }] }], order: [] } };
  const list = terms.packs({ mine: settings.voiceTerms, packs: settings.voicePacks });
  assert.deepEqual(list.at(-1), { id: 'custom-a', name: '公司内部', kind: 'custom', terms: [{ term: 'Polaris', aliases: ['波拉瑞斯'] }], enabled: true });
  const entries = terms.dictionary({ packs: settings.voicePacks });
  assert.equal(terms.correct('波拉瑞斯上线', { entries }).text, 'Polaris上线');
  const hints = terms.hints({ entries: terms.dictionary({ packs: { enabled: ['it', 'workplace'] } }) });
  assert.deepEqual(hints.slice(0, 4), ['Kafka', 'deadline', 'Redis', 'KPI'], 'Hints alternate between packs');
  assert.deepEqual(terms.addTo(settings, 'mine', 'PolarDB', ['破啦DB']), { voiceTerms: [{ term: 'PolarDB', aliases: ['破啦DB'] }] });
  const added = terms.addTo(settings, 'custom-a', 'Orion', ['欧瑞恩']).voicePacks;
  assert.deepEqual(added.custom[0].terms.map(item => item.term), ['Polaris', 'Orion']);
  assert.deepEqual(terms.packConfig({ enabled: ['it', 'nope'], custom: [{ id: 'bad', name: 'x' }] }).enabled, ['it'], 'Unknown ids and malformed packs are dropped');
});
