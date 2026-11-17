const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../web/domain/voice-settings.js');
const answer = require('../web/domain/voice-answer.js');

test('only three settings can change; the rest is fixed', () => {
  assert.deepEqual(Object.keys(voice.DEFAULTS), ['voiceReview', 'voicePauseSeconds', 'voiceStrictness']);
  assert.deepEqual(voice.read({}), { voiceLocale: 'zh-CN', voiceOnDevice: true, voiceMaxMinutes: 3, voiceAutoReveal: true, voiceSuggestRating: true, voiceCorrectTerms: true, voiceLearnTerms: true,
    voiceReview: true, voicePauseSeconds: 12, voiceStrictness: 'normal' });
});

test('read keeps valid values, replaces invalid ones and ignores values saved by the earlier, larger settings page', () => {
  const config = voice.read({ voiceReview: false, voicePauseSeconds: 0, voiceStrictness: 'harsh', voiceAutoReveal: false, voiceLocale: 'en-US', voiceOnDevice: false });
  assert.equal(config.voiceReview, false);
  assert.equal(config.voicePauseSeconds, 0, '0 means never end automatically');
  assert.equal(config.voiceStrictness, 'normal');
  assert.equal(config.voiceAutoReveal, true, 'Removed setting falls back to the fixed behaviour');
  assert.equal(config.voiceLocale, 'zh-CN');
  assert.equal(config.voiceOnDevice, true);
});

test('accept parses page values and rejects removed or unknown settings', () => {
  assert.equal(voice.accept('voicePauseSeconds', '20'), 20);
  assert.equal(voice.accept('voicePauseSeconds', '15'), undefined);
  assert.equal(voice.accept('voiceReview', false), false);
  assert.equal(voice.accept('voiceStrictness', 'loose'), 'loose');
  assert.equal(voice.accept('voiceAutoReveal', false), undefined);
  assert.equal(voice.accept('somethingElse', true), undefined);
});

test('strictness changes how many keywords make a point count', () => {
  const reference = ['follower 落后超过 replica.lag.time.max.ms 会被移出 ISR。'];
  const spoken = 'follower 落后太久就会被踢出去';
  assert.equal(voice.ratioOf('loose'), 0.25);
  assert.equal(answer.compare(reference, spoken, '', { ratio: voice.ratioOf('loose') }).hits, 1);
  assert.equal(answer.compare(reference, spoken, '', { ratio: voice.ratioOf('strict') }).hits, 0);
});
