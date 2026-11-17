// 设置 › 语音作答（design/prototype/voice-settings-20261111.md，精简版）：只留最常用的三项可以改，
// 其余行为固定（中文普通话、只在本机识别、最长 3 分钟、说完直接对照、显示建议评分、按词库纠正、改字后询问记住）。
(function expose(root) {
  // 可以在设置页里改的。
  const DEFAULTS = Object.freeze({ voiceReview: true, voicePauseSeconds: 12, voiceStrictness: 'normal' });
  const CHOICES = Object.freeze({ voicePauseSeconds: [8, 12, 20, 0], voiceStrictness: ['loose', 'normal', 'strict'] });
  // 固定的行为（以前版本存过的旧值不再生效）。
  const FIXED = Object.freeze({ voiceLocale: 'zh-CN', voiceOnDevice: true, voiceMaxMinutes: 3, voiceAutoReveal: true, voiceSuggestRating: true, voiceCorrectTerms: true, voiceLearnTerms: true });
  // 一个要点说中多少关键词才算说中。
  const RATIOS = Object.freeze({ loose: 0.25, normal: 0.35, strict: 0.5 });

  function read(settings = {}) {
    const config = { ...FIXED };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = settings?.[key];
      config[key] = typeof fallback === 'boolean' ? (typeof value === 'boolean' ? value : fallback) : CHOICES[key].includes(value) ? value : fallback;
    }
    return config;
  }

  // 校验要写入的值；不能改的项或不合法的值返回 undefined。
  function accept(key, value) {
    if (!Object.hasOwn(DEFAULTS, key)) return undefined;
    if (typeof DEFAULTS[key] === 'boolean') return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
    const parsed = typeof DEFAULTS[key] === 'number' ? Number(value) : value;
    return CHOICES[key].includes(parsed) ? parsed : undefined;
  }

  const ratioOf = strictness => RATIOS[strictness] ?? RATIOS.normal;

  const api = { DEFAULTS, CHOICES, FIXED, RATIOS, read, accept, ratioOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepVoiceSettings = api;
})(globalThis);
