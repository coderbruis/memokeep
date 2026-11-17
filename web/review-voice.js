// 复习弹窗里的语音作答（design/prototype/voice-review-20261111.md）。
// 题目面：「语音作答」→ 正在听（实时文字）→ 说完直接翻面 → 参考答案逐条对照 + 建议评分（不自动评分）。
// 识别由主进程的 macOS 语音识别辅助程序完成（desktop.speech）；对照在本机计算（MemoKeepVoiceAnswer）。
// 术语纠正（design/prototype/voice-terms-20261111.md）：识别前给提示词、识别后按词库纠正、改字时学会、对照时别名也算说中。
// 记得更牢（design/prototype/memory-boost-20261112.md）：先作答再对照（打字或说）、3 条以上的答案逐条判断「想起 / 没想起」，结果随评分保存。
(function expose(root) {
  // 停顿是在想答案，不打断：停顿到一半才显示倒计时，到时间自动结束（设置 › 语音作答，默认 12 秒）；一直没声音 10 秒算没听到。
  const NOTHING_MS = 10000, SPEAKING_LEVEL = 0.45;
  const FALLBACK = { voiceReview: true, voiceLocale: 'zh-CN', voiceOnDevice: true, voicePauseSeconds: 12, voiceMaxMinutes: 3, voiceAutoReveal: true, voiceStrictness: 'normal', voiceSuggestRating: true, voiceCorrectTerms: true, voiceLearnTerms: true };
  const RATING_LABELS = { again: '忘记', hard: '有点难', good: '记住', easy: '很简单' };

  function create({ $, document, desktop, compare, terms = null, saveTerms = null, savePacks = null, openSettings = null, shortcuts, settings = () => ({}), reveal, isRevealed, now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
    const speech = desktop?.speech;
    let available = false, sequence = 0;
    let state = 'idle'; // idle | starting | listening | finishing | done | editing | error
    let session = null, text = '', live = { committed: '', current: '', stable: 0 }, transcript = compare.createTranscript();
    let startedAt = 0, duration = 0, lastActivity = 0, level = 0;
    let errorCode = '', question = '', ticker = null, silenceTimer = null, unsubscribe = null;
    // 纠正后的实时文字：head（已说完的段）+ current（当前段），fixes 是纠正过的位置（相对 text）。
    let display = { head: '', current: '', stable: 0, fixes: [] }, fixes = [], learnPairs = null, learnSaved = '';
    let dictionaryCache = { mine: undefined, disabled: undefined, packs: undefined, entries: null };
    // 先作答：composing = 题目面正在写答案；noRecall = 点了「想不起来」；grading = 逐条判断的状态。
    let currentCard = null, practice = false, composing = false, noRecall = false, grading = null;
    const recall = () => root.MemoKeepPointRecall || null;
    // 回放：语音作答时同时在应用里录一份音，只放在内存里（换卡、关掉复习就丢掉，不写磁盘）。
    let recorder = null, recordStream = null, recordChunks = [], recordToken = 0, audioUrl = '', player = null;
    function startRecording() {
      dropRecording();
      const token = ++recordToken;
      const media = root.navigator?.mediaDevices;
      if (!media?.getUserMedia || typeof root.MediaRecorder !== 'function') return;
      media.getUserMedia({ audio: true }).then(stream => {
        if (token !== recordToken || !active()) { stream.getTracks().forEach(track => track.stop()); return; }
        recordStream = stream; recordChunks = [];
        recorder = new root.MediaRecorder(stream);
        recorder.ondataavailable = event => { if (event.data?.size) recordChunks.push(event.data); };
        recorder.onstop = () => {
          stream.getTracks().forEach(track => track.stop());
          if (token !== recordToken || !recordChunks.length) return;
          audioUrl = URL.createObjectURL(new Blob(recordChunks, { type: recorder?.mimeType || 'audio/webm' }));
          recordChunks = [];
          paintPlay();
        };
        recorder.start(250);
      }).catch(() => {});
    }
    // keep = true：说完了，留下这段录音给回放；false：取消 / 出错 / 重说，丢掉。
    function stopRecording(keep) {
      if (!keep) recordToken++;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
      else recordStream?.getTracks().forEach(track => track.stop());
      recorder = null; recordStream = null;
    }
    function dropRecording() {
      stopRecording(false);
      player?.pause(); player = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = ''; recordChunks = [];
    }
    function togglePlay() {
      if (!audioUrl) return;
      if (player && !player.paused) { player.pause(); player.currentTime = 0; paintPlay(); return; }
      player ||= new Audio(audioUrl);
      player.onended = paintPlay; player.onpause = paintPlay;
      player.currentTime = 0;
      player.play().then(paintPlay).catch(() => paintPlay());
    }
    // 「你的回答」标题栏里的「听录音」按钮（录音整理好之后才出现）。
    function paintPlay() {
      const slot = panel()?.querySelector('[data-voice-play-slot]');
      if (!slot) return;
      slot.textContent = '';
      if (!audioUrl) return;
      const playing = Boolean(player && !player.paused && !player.ended);
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.voicePlay = ''; button.className = `rv-voice-play${playing ? ' is-playing' : ''}`;
      button.setAttribute('aria-pressed', String(playing));
      button.title = playing ? '停止播放' : '听刚才说的录音';
      button.innerHTML = playing ? '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>停止' : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>听录音';
      button.onclick = togglePlay;
      slot.append(button);
    }
    const answerFirst = () => (settings() || {}).answerFirst !== false;
    const answerText = () => $('#reviewAnswer')?.textContent || '';
    function entries() {
      if (!terms) return null;
      const current = settings() || {};
      if (dictionaryCache.entries && dictionaryCache.mine === current.voiceTerms && dictionaryCache.disabled === current.voiceTermsDisabled && dictionaryCache.packs === current.voicePacks) return dictionaryCache.entries;
      dictionaryCache = { mine: current.voiceTerms, disabled: current.voiceTermsDisabled, packs: current.voicePacks, entries: terms.dictionary({ mine: current.voiceTerms, disabled: current.voiceTermsDisabled, packs: current.voicePacks }) };
      return dictionaryCache.entries;
    }
    const correct = value => terms && voice().voiceCorrectTerms ? terms.correct(value, { entries: entries(), reference: answerText() }) : { text: value, fixes: [] };
    const panel = () => $('#reviewVoicePanel');
    // 设置 › 语音作答 的当前值（web/domain/voice-settings.js）。
    const voice = () => root.MemoKeepVoiceSettings ? root.MemoKeepVoiceSettings.read(settings() || {}) : { ...FALLBACK, ...(settings() || {}) };
    const pauseEndMs = () => voice().voicePauseSeconds > 0 ? voice().voicePauseSeconds * 1000 : Infinity;

    if (speech?.available) Promise.resolve(speech.available()).then(value => { available = Boolean(value); refreshButton(); }).catch(() => {});
    if (speech?.onEvent) unsubscribe = speech.onEvent(onEvent);

    const enabled = () => available && settings()?.voiceReview !== false;
    const hasTextAnswer = () => Boolean($('#reviewAnswer')?.textContent.trim());
    const active = () => ['starting', 'listening', 'finishing'].includes(state);

    function refreshButton() {
      const show = enabled() && hasTextAnswer() && !isRevealed() && !active() && !composing;
      $('#reviewVoiceBtn')?.classList.toggle('hidden', !show);
      const listening = active();
      // 先作答时「显示答案」换成作答框里的「对照答案」。
      $('#revealBtn')?.classList.toggle('rv-voice-away', listening || composing && !isRevealed());
      $('#reviewVoiceRedo')?.classList.toggle('hidden', !listening);
      $('#reviewVoiceDone')?.classList.toggle('hidden', !listening);
      $('#reviewDialog')?.classList.toggle('is-voice-listening', listening);
    }

    function clearTimers() { if (ticker) clearInterval(ticker); ticker = null; if (silenceTimer) clearTimer(silenceTimer); silenceTimer = null; }

    function reset() {
      if (active()) speech?.cancel?.();
      clearTimers();
      state = 'idle'; session = null; text = ''; clearLive(); duration = 0; errorCode = ''; learnPairs = null; learnSaved = '';
      composing = false; noRecall = false; grading = null;
      dropRecording();
      if (panel()) { panel().className = 'rv-voice hidden'; panel().textContent = ''; }
      $('#reviewVoiceCompare')?.classList.add('hidden');
      if ($('#reviewVoiceCompare')) $('#reviewVoiceCompare').textContent = '';
      $('#reviewAnswer')?.classList.remove('rv-voice-replaced');
      clearSuggestion();
      refreshButton();
    }

    function onCard(card, options = {}) {
      reset();
      currentCard = card || null; practice = Boolean(options.practice);
      question = $('#reviewQuestion')?.textContent || card?.question || '';
      if (answerFirst() && hasTextAnswer()) compose();
      refreshButton();
    }

    // 题目面直接是作答框：写关键词或说出来，再对照答案。
    function compose() {
      composing = true; state = 'editing'; text = '';
      render(); refreshButton();
    }
    function skipCompose() {
      composing = false; state = 'idle';
      panel()?.classList.add('hidden');
      refreshButton();
      $('#revealBtn')?.focus({ preventScroll: true });
    }
    function cannotRecall() {
      composing = false; noRecall = true; state = 'idle'; text = '';
      panel()?.classList.add('hidden');
      refreshButton();
      reveal();
    }

    async function start() {
      if (!enabled() || active()) return false;
      if (state === 'editing' || state === 'error' || state === 'done') { clearSuggestion(); $('#reviewVoiceCompare')?.classList.add('hidden'); $('#reviewAnswer')?.classList.remove('rv-voice-replaced'); }
      const id = `voice-${++sequence}`;
      composing = false;
      session = id; text = ''; clearLive(); level = 0; errorCode = ''; state = 'starting'; learnPairs = null; learnSaved = '';
      startedAt = now(); lastActivity = startedAt;
      render(); refreshButton();
      // 提示词：这张卡片里的英文术语 + 我的词库 + 内置词库（最多 100 个）。
      const hints = terms ? terms.hints({ question, answer: answerText(), entries: entries() }) : [];
      let result;
      try { result = await speech.start(id, hints, { locale: voice().voiceLocale, onDevice: voice().voiceOnDevice }); } catch (error) { result = { ok: false, code: 'launch', message: error?.message }; }
      if (session !== id) return false;
      if (!result?.ok) { fail(result?.code || 'launch'); return false; }
      state = 'listening';
      startRecording();
      ticker = setInterval(tick, 250);
      render(); refreshButton();
      return true;
    }

    // 重说：丢掉正在进行的收音，重新开始。
    function restart() {
      if (active()) { session = null; speech?.cancel?.(); clearTimers(); state = 'idle'; }
      return start();
    }

    function tick() {
      if (state !== 'listening') return;
      const at = now();
      if (at - startedAt >= voice().voiceMaxMinutes * 60000) { finish(); return; }
      if (!text && at - lastActivity >= NOTHING_MS) { speech?.cancel?.(); fail('silent'); return; }
      const paused = at - lastActivity, endMs = pauseEndMs();
      if (text && paused >= endMs) { finish(); return; }
      const time = panel()?.querySelector('.rv-voice-time');
      if (time) time.textContent = clock(at - startedAt);
      const hint = panel()?.querySelector('.rv-voice-hint');
      if (hint) {
        const waiting = text && Number.isFinite(endMs) && paused >= endMs / 2;
        hint.classList.toggle('is-countdown', Boolean(waiting));
        hint.textContent = waiting ? `停顿中 · ${Math.ceil((endMs - paused) / 1000)} 秒后自动结束` : 'Space 说完 · Esc 取消';
      }
    }

    function onEvent(event) {
      if (!event || event.session !== session) return;
      if (event.type === 'level') {
        level = Number(event.value) || 0;
        if (level >= SPEAKING_LEVEL && state === 'listening') lastActivity = now();
        paintLevel(); return;
      }
      // 每次结果只代表「当前这一段」，交给 transcript 按段拼接，前面说的不会被覆盖。
      if (event.type === 'partial' && state === 'listening') {
        live = transcript.push(event.text, Boolean(event.segmentEnd));
        if (applyLive() !== false) { lastActivity = now(); paintText(); }
        return;
      }
      if (event.type === 'final' && active()) { live = transcript.push(event.text, true); applyLive(); complete(); return; }
      if (event.type === 'error' && active()) fail(event.code || 'recognition', event.message);
    }

    // 结束收音，等系统给出最终文字；兜底 4 秒后用当前文字。
    function finish() {
      if (state !== 'listening' && state !== 'starting') return;
      state = 'finishing';
      clearTimers();
      duration = now() - startedAt;
      stopRecording(true);
      render(); refreshButton();
      speech?.stop?.();
      const id = session;
      silenceTimer = setTimer(() => { if (session === id && state === 'finishing') complete(); }, 4000);
    }

    function complete() {
      clearTimers();
      if (!duration) duration = now() - startedAt;
      speech?.cancel?.();
      session = null;
      if (!text.trim()) { fail('silent'); return; }
      stopRecording(true);
      state = 'done';
      refreshButton();
      showResult();
    }

    // 说完（或改字确认）后：默认直接翻面对照；设置里关掉「说完后直接显示答案」时，先停在你的回答，按 Space 再翻面。
    function showResult() {
      if (isRevealed()) { onReveal(); return; }
      if (voice().voiceAutoReveal) { reveal(); return; }
      render(null);
    }

    function cancel() {
      if (!active()) return false;
      dropRecording();
      session = null;
      speech?.cancel?.();
      clearTimers();
      state = 'idle'; text = '';
      panel()?.classList.add('hidden');
      if (answerFirst() && !isRevealed() && hasTextAnswer()) compose();
      refreshButton();
      return true;
    }

    function fail(code) {
      dropRecording();
      clearTimers();
      session = null;
      errorCode = code;
      state = 'error';
      render(); refreshButton();
    }

    // 显示答案时：有回答就逐条对照（手动按「显示答案」打断收音时，用已经识别出的文字）。
    function onReveal() {
      if (active()) {
        session = null; speech?.cancel?.(); clearTimers();
        duration = now() - startedAt;
        state = text.trim() ? 'done' : 'idle';
        if (state === 'done') stopRecording(true); else dropRecording();
        if (state === 'idle') panel()?.classList.add('hidden');
      }
      if (composing) { composing = false; if (state === 'editing') { state = 'idle'; panel()?.classList.add('hidden'); } }
      refreshButton();
      if (state !== 'done') { renderGrading(null); return; }
      renderComparison();
    }

    function answerLines() {
      const answer = $('#reviewAnswer');
      if (!answer) return [];
      const items = [...answer.querySelectorAll('li')].filter(item => !item.querySelector('li'));
      if (items.length) return items.map(item => item.textContent);
      const blocks = [...answer.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, div:not(:has(p, div, li))')].filter(node => !node.closest('pre'));
      const lines = blocks.length ? blocks.map(node => node.textContent) : [answer.innerText || answer.textContent];
      return lines.flatMap(line => line.split('\n'));
    }

    function renderComparison() {
      // 对照时再按词库归一一次：改回原识别或打字作答时，「卡夫卡」也能对上答案里的 Kafka。
      const ratio = root.MemoKeepVoiceSettings ? root.MemoKeepVoiceSettings.ratioOf(voice().voiceStrictness) : undefined;
      const result = compare.compare(answerLines(), text, question, { ratio });
      if (terms) {
        const normalized = correct(text).text;
        if (normalized !== text) {
          const loose = compare.compare(answerLines(), normalized, question, { ratio });
          if (loose.hits > result.hits) { Object.assign(result, loose); result.points = loose.points.map((point, index) => ({ ...point, matched: [...new Set([...point.matched, ...result.points[index]?.matched || []])] })); }
        }
      }
      const answer = $('#reviewAnswer'), host = $('#reviewVoiceCompare');
      const rich = Boolean(answer?.querySelector('img, pre, table, .ql-code-block, code'));
      render(result);
      clearSuggestion();
      if (!host) return result;
      host.textContent = '';
      if (!result.total) { host.classList.add('hidden'); answer?.classList.remove('rv-voice-replaced'); return result; }
      // 3 条以上：逐条判断，按你的回答先标好，可以改。
      if (renderGrading(result)) return result;
      // 多行答案但没有标判断项：整张卡打一个分，不逐行对照（引子、说明不算要点）；只标出回答里说中的词。
      if (result.total > 1) { host.classList.add('hidden'); host.textContent = ''; answer?.classList.remove('rv-voice-replaced'); return result; }
      const head = document.createElement('div'); head.className = 'rv-voice-compare-head';
      const label = document.createElement('strong'); label.textContent = rich ? '要点对照' : '参考答案';
      const score = document.createElement('span'); score.className = `rv-voice-score${result.hits === result.total ? ' is-all' : ''}`;
      score.textContent = `说中 ${result.hits} / ${result.total} 个要点`;
      head.append(label, score);
      const list = document.createElement('ul'); list.className = 'rv-voice-points';
      for (const point of result.points) {
        const item = document.createElement('li'); item.className = point.hit ? 'is-hit' : 'is-miss';
        item.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${point.hit ? '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>' : '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>'}</svg>`;
        const body = document.createElement('span'); body.textContent = point.text;
        const sr = document.createElement('span'); sr.className = 'rv-sr'; sr.textContent = point.hit ? '（说中）' : '（没说到）';
        item.append(body, sr); list.append(item);
      }
      host.append(head, list);
      host.classList.remove('hidden');
      // 纯文字答案：要点列表就是答案本身，原文收起；带图片 / 代码的答案保留原文。
      answer?.classList.toggle('rv-voice-replaced', !rich);
      if (result.suggestion && voice().voiceSuggestRating) {
        const button = $('#ratings')?.querySelector(`[data-rating="${result.suggestion}"]`);
        button?.classList.add('is-suggested');
        button?.setAttribute('aria-description', `建议：${RATING_LABELS[result.suggestion]}`);
      }
      return result;
    }

    // ---------- 按要点评分（design/prototype/memory-boost-20261112.md） ----------
    // 判断项（design/prototype/check-items-20261112.md）：只有答案里的列表项逐条判断，2 项以上才生效；
    // 说明、引子照常显示在上面。有回答时按对照结果先标好；「想不起来」全部标没想起。
    // 返回 true 表示已经画了逐条判断（调用方不再画只读对照）。
    function renderGrading(result) {
      const host = $('#reviewVoiceCompare'), answer = $('#reviewAnswer'), module = recall();
      const answerSource = String(currentCard?.answer || '');
      const items = module && currentCard && !['cloze', 'image-occlusion'].includes(currentCard.cardType) ? module.checkItems(answerSource) : [];
      if (!host || items.length < (module?.GRADE_MIN_ITEMS || 2)) {
        grading = null;
        if (noRecall && !result) suggest('again');
        return false;
      }
      // 有回答：每个判断项单独对照（原文和按词库纠正后的文字，任一说中就算）。
      const spoken = state === 'done' ? text.trim() : '';
      const ratio = root.MemoKeepVoiceSettings ? root.MemoKeepVoiceSettings.ratioOf(voice().voiceStrictness) : undefined;
      const variants = spoken ? [...new Set([spoken, terms ? correct(spoken).text : spoken])] : [];
      const hitOf = item => variants.some(value => { const check = compare.compare([item], value, question, { ratio }); return check.total > 0 && check.hits * 2 >= check.total; });
      // 先整体对照（几条共有的词分摊权重）；判断项被拆成多句、对不齐时再逐条对照。
      const whole = variants.map(value => compare.compare(items, value, question, { ratio }));
      const aligned = whole.length && whole.every(check => check.points.length === items.length);
      const hits = aligned ? items.map((_, index) => whole.some(check => check.points[index].hit)) : items.map(hitOf);
      const missedBefore = currentCard ? module.lastMissedKeys(currentCard) : new Set();
      grading = { prefilled: Boolean(spoken) || noRecall, showAll: true, context: module.contextLines(answerSource),
        points: items.map((item, index) => ({ text: item, got: spoken ? hits[index] : noRecall ? false : null, last: missedBefore.has(module.key(item)) })) };
      // 再练时只看上次漏的，其他折叠。
      if (practice && grading.points.some(point => point.last)) grading.showAll = false;
      const rich = Boolean(answer?.querySelector('img, pre, table, .ql-code-block, code'));
      answer?.classList.toggle('rv-voice-replaced', !rich);
      grading.showContext = !rich;
      paintGrading();
      return true;
    }

    function paintGrading() {
      const host = $('#reviewVoiceCompare');
      if (!host || !grading) return;
      // 只看上次漏的时，分数也只算看得见的那几条。
      const points = grading.points, counted = grading.showAll ? points : points.filter(point => point.last);
      const decided = counted.filter(point => point.got !== null), got = counted.filter(point => point.got === true).length;
      host.textContent = '';
      host.classList.remove('hidden');
      const head = document.createElement('div'); head.className = 'rv-voice-compare-head rv-grade-head';
      const label = document.createElement('strong'); label.textContent = '逐条判断：想起来了吗？';
      const hint = document.createElement('span'); hint.className = 'rv-grade-hint';
      hint.textContent = `只判断标了的 ${points.length} 项${grading.prefilled ? '，已按你的回答标好' : points.some(point => point.last) ? '，上次没想起的标了红' : ''}`;
      const score = document.createElement('span'); score.className = `rv-voice-score${decided.length === counted.length && got === counted.length ? ' is-all' : ''}`;
      score.textContent = decided.length ? `想起 ${got} / ${counted.length}` : `共 ${counted.length} 条`;
      head.append(label, hint, score);
      const list = document.createElement('ul'); list.className = 'rv-grade-list';
      points.forEach((point, index) => {
        if (!grading.showAll && !point.last) return;
        const item = document.createElement('li'); item.className = `rv-grade${point.got === true ? ' is-got' : point.got === false ? ' is-miss' : ''}`;
        const body = document.createElement('span'); body.className = 'rv-grade-text'; body.textContent = point.text;
        if (point.last) { const badge = document.createElement('em'); badge.className = 'rv-grade-last'; badge.textContent = '上次没想起'; body.append(badge); }
        const group = document.createElement('span'); group.className = 'rv-grade-seg'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', `第 ${index + 1} 条`);
        for (const [value, text] of [[true, '想起'], [false, '没想起']]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = value ? 'is-yes' : 'is-no';
          button.textContent = text; button.dataset.gradeIndex = String(index); button.dataset.gradeValue = value ? 'y' : 'n';
          button.setAttribute('aria-pressed', String(point.got === value));
          group.append(button);
        }
        item.append(body, group); list.append(item);
      });
      // 说明和引子（不是判断项的行）照常显示在判断项上面。
      if (grading.showContext && grading.context.length) {
        const context = document.createElement('div'); context.className = 'rv-grade-context';
        for (const line of grading.context) { const paragraph = document.createElement('p'); paragraph.textContent = line; context.append(paragraph); }
        host.append(context);
      }
      host.append(head, list);
      if (!grading.showAll) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'rv-grade-more'; more.dataset.gradeAll = '';
        more.textContent = `只看了上次漏的 · 显示全部 ${points.length} 条`;
        host.append(more);
      }
      host.onclick = event => {
        if (event.target.closest('[data-grade-all]')) { grading.showAll = true; paintGrading(); return; }
        const button = event.target.closest('[data-grade-index]');
        if (!button || !grading) return;
        const point = grading.points[Number(button.dataset.gradeIndex)];
        const value = button.dataset.gradeValue === 'y';
        point.got = point.got === value ? null : value;
        paintGrading();
      };
      clearSuggestion();
      const visible = grading.showAll ? points : points.filter(point => point.last);
      if (visible.every(point => point.got !== null)) {
        const hits = visible.filter(point => point.got).length;
        suggest(compare.suggestRating ? compare.suggestRating(hits, visible.length) : hits === visible.length ? 'good' : hits * 2 >= visible.length ? 'hard' : 'again');
      } else if (noRecall) suggest('again');
    }

    function suggest(rating) {
      if (!rating || voice().voiceSuggestRating === false) return;
      clearSuggestion();
      const button = $('#ratings')?.querySelector(`[data-rating="${rating}"]`);
      button?.classList.add('is-suggested');
      button?.setAttribute('aria-description', `建议：${RATING_LABELS[rating]}`);
    }

    // 评分时保存：每一条想起 / 没想起（没判断的为 null）。
    function pointResults() {
      return grading ? grading.points.map(point => ({ text: point.text, got: point.got })) : null;
    }

    function clearSuggestion() {
      $('#ratings')?.querySelectorAll('.is-suggested').forEach(button => { button.classList.remove('is-suggested'); button.removeAttribute('aria-description'); });
    }

    function clock(ms) { const seconds = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

    function icon(name) { return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`; }
    // 语音区域右上角的齿轮：去 设置 › 语音作答（会先退出复习，进度已保存）。
    const gear = () => openSettings ? `<button type="button" class="rv-voice-gear" data-voice-settings title="语音设置（会先退出复习，进度已保存）" aria-label="语音设置">${icon('settings')}</button>` : '';
    // ---------- 复习时快速切换词库（design/prototype/voice-term-packs-20261111.md） ----------
    const packList = () => terms?.packs ? terms.packs({ mine: (settings() || {}).voiceTerms, packs: (settings() || {}).voicePacks }) : [];
    function packLabel() {
      const on = packList().filter(pack => pack.enabled);
      if (!on.length) return '未选词库';
      const main = on.find(pack => pack.kind !== 'mine') || on[0];
      return `${main.name}${on.length > 1 ? ` +${on.length - 1}` : ''}`;
    }
    const packButton = () => terms?.packs && savePacks ? `<button type="button" class="rv-voice-packs" data-voice-packs aria-haspopup="true" aria-expanded="false" title="切换语音词库">${icon('book-open')}<span>${packLabel()}</span>${icon('chevron-down')}</button>` : '';
    function closePacks() {
      document.querySelector('#reviewDialog .rv-voice-pack-pop')?.remove();
      panel()?.querySelector('[data-voice-packs]')?.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outsidePacks, true);
    }
    function outsidePacks(event) { if (!event.target.closest?.('.rv-voice-pack-pop, [data-voice-packs]')) closePacks(); }
    function openPacks(button) {
      closePacks();
      const pop = document.createElement('div');
      pop.className = 'rv-voice-pack-pop'; pop.setAttribute('role', 'group'); pop.setAttribute('aria-label', '使用的词库');
      for (const pack of packList()) {
        const label = document.createElement('label');
        const box = document.createElement('input'); box.type = 'checkbox'; box.checked = pack.enabled; box.dataset.packToggle = pack.id;
        const name = document.createElement('span'); name.textContent = pack.name;
        const count = document.createElement('small'); count.textContent = String(pack.terms.length);
        label.append(box, name, count); pop.append(label);
      }
      if (openSettings) { const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'rv-voice-pack-manage'; manage.textContent = '管理词库…'; manage.onclick = () => { closePacks(); if (active()) cancel(); openSettings('terms'); }; pop.append(manage); }
      pop.addEventListener('change', async event => {
        const box = event.target.closest('[data-pack-toggle]');
        if (!box) return;
        const id = box.dataset.packToggle;
        try { await savePacks(config => ({ ...config, enabled: box.checked ? [...new Set([...config.enabled, id])] : config.enabled.filter(item => item !== id) })); }
        catch { box.checked = !box.checked; return; }
        // 立即生效：重新纠正当前文字，更新按钮上的名字。
        const label = panel()?.querySelector('[data-voice-packs] span'); if (label) label.textContent = packLabel();
        if (active() && live.text) { applyLive(); paintText(); }
        else if (state === 'done' && isRevealed()) { renderComparison(); }
      });
      pop.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePacks(); button.focus(); } });
      // 放在弹窗本身上、固定定位：题目区域会滚动，放在里面会被裁掉。
      (button.closest('dialog') || panel()).append(pop);
      const anchor = button.getBoundingClientRect();
      pop.style.top = `${Math.min(anchor.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
      pop.style.left = `${Math.max(8, Math.min(anchor.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
      button.setAttribute('aria-expanded', 'true');
      pop.querySelector('input')?.focus({ preventScroll: true });
      document.addEventListener('pointerdown', outsidePacks, true);
    }
    function bindPacks(host) {
      host.querySelector('[data-voice-packs]')?.addEventListener('click', event => { const button = event.currentTarget; if (button.getAttribute('aria-expanded') === 'true') closePacks(); else openPacks(button); });
    }

    function bindSettingsLink(host, focus) {
      host.querySelectorAll('[data-voice-settings]').forEach(button => { button.onclick = () => { if (active()) cancel(); openSettings?.(button.dataset.voiceSettings || focus); }; });
    }

    const ERRORS = {
      'microphone-denied': { text: 'MemoKeep 没有麦克风权限', action: '打开系统设置', icon: 'lock', warn: true },
      'speech-denied': { text: 'MemoKeep 没有语音识别权限', action: '打开系统设置', icon: 'lock', warn: true },
      silent: { text: '没有听到声音，检查一下麦克风？', action: '再试一次', icon: 'mic' },
      'no-microphone': { text: '没有找到可用的麦克风', action: '再试一次', icon: 'mic', warn: true },
      unsupported: { text: '这台电脑不支持语音作答', action: '', icon: 'alert-triangle', warn: true },
      'offline-unsupported': { text: '这台电脑还不能在本机识别中文：请在 系统设置 › 键盘 › 听写 里打开听写并下载中文', action: '', icon: 'alert-triangle', warn: true }
    };

    function render(result) {
      const host = panel();
      if (!host) return;
      closePacks();
      host.classList.remove('hidden');
      host.className = 'rv-voice';
      if (state === 'starting' || state === 'listening' || state === 'finishing') {
        host.classList.add('is-live');
        const label = state === 'starting' ? '准备麦克风…' : state === 'finishing' ? '正在整理文字…' : '正在听';
        host.innerHTML = `<p class="rv-voice-head"><span class="rv-voice-dot"></span><span class="rv-voice-state">${label}</span><span class="rv-voice-level" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="rv-grow"></span><span class="rv-voice-hint">Space 说完 · Esc 取消</span>${packButton()}<span class="rv-voice-time">${clock(now() - startedAt)}</span>${gear()}</p><p class="rv-voice-text"></p>`;
        bindSettingsLink(host); bindPacks(host);
        paintText(); paintLevel();
        return;
      }
      if (state === 'error') {
        const info = ERRORS[errorCode] || { text: '语音识别出了问题', action: '再试一次', icon: 'alert-triangle', warn: true };
        host.classList.add('is-error');
        host.innerHTML = `<p class="rv-voice-alert${info.warn ? ' is-warn' : ''}">${icon(info.icon)}<span></span>${info.action ? '<button type="button" data-voice-action></button>' : ''}${openSettings ? '<button type="button" class="rv-voice-type" data-voice-settings>语音设置</button>' : ''}<button type="button" class="rv-voice-type" data-voice-type>改用打字</button></p>`;
        host.querySelector('.rv-voice-alert > span').textContent = info.text;
        const action = host.querySelector('[data-voice-action]');
        if (action) {
          action.textContent = info.action;
          action.onclick = () => /denied$/.test(errorCode) ? speech?.openSettings?.(errorCode) : start();
        }
        host.querySelector('[data-voice-type]').onclick = () => edit();
        bindSettingsLink(host, /denied$/.test(errorCode) ? 'recognition' : undefined);
        return;
      }
      if (state === 'editing' && composing) {
        host.classList.add('is-editing', 'is-compose');
        const missed = recall() && currentCard ? recall().lastMissedKeys(currentCard).size : 0;
        host.innerHTML = `<p class="rv-voice-head">${icon('pencil')}<span>先写下你想得起来的，关键词就行</span>${missed ? `<em class="rv-compose-missed">上次漏了 ${missed} 条</em>` : ''}<span class="rv-grow"></span><span class="rv-voice-hint">Enter 对照 · Shift+Enter 换行 · Esc 直接看答案</span></p><textarea class="rv-voice-input" rows="3" aria-label="你的回答" placeholder="想不起来也没关系，点「想不起来」。"></textarea><p class="rv-compose-tools">${enabled() ? `<button type="button" class="rv-compose-voice" data-compose-voice>${icon('mic')}说出来<kbd>${shortcuts.label?.('review-voice') || 'V'}</kbd></button>` : ''}<span class="rv-grow"></span><button type="button" class="rv-compose-skip" data-compose-none>想不起来</button><button type="button" class="primary rv-compose-go" data-compose-go>对照答案<kbd>Enter</kbd></button></p>`;
        const input = host.querySelector('textarea');
        input.value = text;
        input.addEventListener('keydown', event => {
          if (event.isComposing) return;
          if (event.key === 'Enter' && (!event.shiftKey || event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); confirmEdit(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipCompose(); }
        });
        host.querySelector('[data-compose-go]').onclick = () => confirmEdit(input.value);
        host.querySelector('[data-compose-none]').onclick = () => cannotRecall();
        const voiceButton = host.querySelector('[data-compose-voice]');
        if (voiceButton) voiceButton.onclick = () => { text = ''; start(); };
        input.focus({ preventScroll: true });
        return;
      }
      if (state === 'editing') {
        host.classList.add('is-editing');
        host.innerHTML = `<p class="rv-voice-head">${icon('pencil')}<span>${text ? '修改识别结果' : '打字作答'}</span><span class="rv-grow"></span><span class="rv-voice-hint">Enter 确认 · Esc 取消</span></p><textarea class="rv-voice-input" rows="3" aria-label="你的回答"></textarea>`;
        const input = host.querySelector('textarea');
        input.value = text;
        input.addEventListener('keydown', event => {
          if (event.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); confirmEdit(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state = text ? 'done' : 'idle'; if (state === 'done') renderComparison(); else host.classList.add('hidden'); refreshButton(); }
        });
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        return;
      }
      if (state === 'done') {
        host.innerHTML = `<p class="rv-voice-head">${icon('mic')}<span>你的回答${duration ? ` · ${clock(duration)}` : ''}</span><span class="rv-grow"></span><span class="rv-voice-play-slot" data-voice-play-slot></span>${packButton()}<button type="button" data-voice-edit>${icon('pencil')}改字</button>${enabled() ? `<button type="button" data-voice-redo>${icon('refresh-cw')}重说</button>` : ''}${gear()}</p><p class="rv-voice-text"></p>`;
        bindSettingsLink(host); bindPacks(host);
        paintPlay();
        if (!isRevealed()) { const tip = document.createElement('p'); tip.className = 'rv-voice-learned'; tip.textContent = '按 Space 显示答案并对照'; host.append(tip); }
        const body = host.querySelector('.rv-voice-text');
        appendFragments(body, fragments(text, (result?.points || []).flatMap(point => point.matched)), { revertable: true });
        body.onclick = event => { const node = event.target.closest('[data-voice-fix]'); if (node) revertFix(Number(node.dataset.voiceFix)); };
        body.onkeydown = event => { const node = event.target.closest('[data-voice-fix]'); if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); revertFix(Number(node.dataset.voiceFix)); } };
        // 改字学到的新读法：问一次要不要记住。
        if (learnPairs?.length) {
          const bar = document.createElement('p'); bar.className = 'rv-voice-learn';
          const label = document.createElement('span');
          label.append('以后把');
          learnPairs.forEach((pair, index) => { if (index) label.append('、'); label.append(`「${pair.from}」`); });
          label.append('都识别成 ');
          learnPairs.forEach((pair, index) => { if (index) label.append('、'); const term = document.createElement('b'); term.textContent = pair.to; label.append(term); });
          label.append('？');
          const keep = document.createElement('button'); keep.type = 'button'; keep.dataset.voiceLearn = 'keep'; keep.textContent = '记住';
          const once = document.createElement('button'); once.type = 'button'; once.dataset.voiceLearn = 'once'; once.className = 'ghost'; once.textContent = '只改这次';
          keep.onclick = () => rememberLearned();
          once.onclick = () => { learnPairs = null; renderComparison(); };
          bar.append(label, keep, once);
          host.append(bar);
        } else if (learnSaved) {
          const note = document.createElement('p'); note.className = 'rv-voice-learned'; note.textContent = `已加入语音词库：${learnSaved}`;
          if (openSettings) { const link = document.createElement('button'); link.type = 'button'; link.className = 'rv-voice-link'; link.dataset.voiceSettings = 'terms'; link.textContent = '查看词库'; note.append(' · ', link); }
          host.append(note);
          bindSettingsLink(host);
        }
        host.querySelector('[data-voice-edit]').onclick = () => edit();
        const redo = host.querySelector('[data-voice-redo]');
        if (redo) redo.onclick = () => start();
      }
    }

    function clearLive() { transcript.reset(); live = { committed: '', current: '', stable: 0 }; display = { head: '', current: '', stable: 0, fixes: [] }; fixes = []; }

    // 把拼好的识别结果按词库纠正：已说完的部分和当前段分开纠正，灰字按纠正后的当前段计算。返回 false 表示没有变化。
    function applyLive() {
      if (!live.text) return false;
      const rawHead = live.current ? live.text.slice(0, live.text.length - live.current.length) : live.text;
      const head = correct(rawHead), current = correct(live.current);
      const stable = compare.stablePrefix(display.current, current.text);
      const next = head.text + current.text;
      const changed = next !== text;
      display = { head: head.text, current: current.text, stable, fixes: [...head.fixes, ...current.fixes.map(fix => ({ ...fix, start: fix.start + head.text.length, end: fix.end + head.text.length }))] };
      text = next; fixes = display.fixes;
      return changed;
    }

    // 文字按「说中的词 / 纠正过的词」切成片段。
    function fragments(value, tokens, offset = 0) {
      const hits = new Array(value.length).fill(false), owner = new Array(value.length).fill(-1);
      let at = 0;
      for (const part of tokens ? compare.highlight(value, tokens) : [{ text: value, hit: false }]) { if (part.hit) hits.fill(true, at, at + part.text.length); at += part.text.length; }
      fixes.forEach((fix, index) => { const start = fix.start - offset, end = fix.end - offset; if (start >= 0 && value.slice(start, end) === fix.to) owner.fill(index, start, end); });
      const parts = [];
      for (let index = 0; index < value.length; index++) {
        const last = parts[parts.length - 1];
        if (last && last.hit === hits[index] && last.fix === owner[index]) last.text += value[index];
        else parts.push({ text: value[index], hit: hits[index], fix: owner[index] });
      }
      return parts;
    }

    function appendFragments(body, parts, { revertable = false } = {}) {
      for (const part of parts) {
        if (part.fix < 0) {
          if (part.hit) { const mark = document.createElement('mark'); mark.textContent = part.text; body.append(mark); } else body.append(part.text);
          continue;
        }
        const fix = fixes[part.fix];
        const node = document.createElement(part.hit ? 'mark' : 'span');
        node.className = 'rv-voice-fix';
        node.textContent = part.text;
        node.title = `原识别：${fix.from}${revertable ? '（点一下改回）' : ''}`;
        node.dataset.voiceFix = String(part.fix);
        if (revertable) { node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `${fix.to}，原识别为${fix.from}，点一下改回`); }
        body.append(node);
      }
    }

    // 纠正错了：把这个词改回原识别，重新对照。
    function revertFix(index) {
      const fix = fixes[index];
      if (!fix || text.slice(fix.start, fix.end) !== fix.to) return;
      const delta = fix.from.length - fix.to.length;
      text = text.slice(0, fix.start) + fix.from + text.slice(fix.end);
      fixes = fixes.filter((_, at) => at !== index).map(item => item.start > fix.start ? { ...item, start: item.start + delta, end: item.end + delta } : item);
      renderComparison();
    }

    async function rememberLearned() {
      const pairs = learnPairs;
      if (!pairs?.length || !saveTerms) return;
      try { await saveTerms(pairs); learnSaved = pairs.map(pair => pair.to).join('、'); }
      catch { learnSaved = ''; }
      learnPairs = null;
      renderComparison();
    }

    // 已说完的段和当前段里没变的部分是黑字，当前段还在变的尾巴是灰字。
    function paintText() {
      const body = panel()?.querySelector('.rv-voice-text');
      if (!body) return;
      const stable = display.current ? Math.min(display.stable, display.current.length) : 0;
      const black = text.slice(0, text.length - display.current.length + stable);
      body.textContent = '';
      appendFragments(body, fragments(black, null));
      const partial = document.createElement('span'); partial.className = 'rv-voice-partial';
      appendFragments(partial, fragments(text.slice(black.length), null, black.length));
      const caret = document.createElement('span'); caret.className = 'rv-voice-caret';
      body.append(partial);
      if (state === 'listening') body.append(caret);
      if (!text && state === 'listening') { const hint = document.createElement('span'); hint.className = 'rv-voice-placeholder'; hint.textContent = '说出你的答案…'; body.prepend(hint); }
    }

    function paintLevel() {
      const bars = panel()?.querySelectorAll('.rv-voice-level i');
      if (!bars?.length) return;
      const shape = [0.45, 0.8, 1, 0.65, 0.35];
      bars.forEach((bar, index) => { bar.style.transform = `scaleY(${Math.max(0.18, Math.min(1, level * 1.4 * shape[index]))})`; });
    }

    function edit() {
      if (active()) cancel();
      state = 'editing';
      render(); refreshButton();
    }

    function confirmEdit(value) {
      const before = text, after = String(value || '').trim();
      // 先作答：空着点「对照答案」= 心里想过了，直接看答案逐条判断；写了就对照。
      if (composing) {
        composing = false; learnPairs = null; learnSaved = ''; fixes = [];
        text = after;
        state = text ? 'done' : 'idle';
        if (!text) panel()?.classList.add('hidden');
        refreshButton();
        reveal();
        return;
      }
      // 改字学会：把「原词 → 英文术语」的改动记下来，确认后问要不要加入语音词库。
      learnPairs = terms && voice().voiceLearnTerms && before && after ? terms.learn(before, after, { entries: entries(), reference: answerText() }) : null;
      if (!learnPairs?.length || !saveTerms) learnPairs = null;
      learnSaved = '';
      text = after;
      fixes = [];
      if (!text) { state = 'idle'; panel()?.classList.add('hidden'); refreshButton(); return; }
      state = 'done';
      refreshButton();
      showResult();
    }

    // 复习弹窗的快捷键：V 开始，Space 说完，R 重说，Esc 取消。返回 true 表示已处理。
    function handleKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (active()) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return true; }
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finish(); return true; }
        if (shortcuts.matches(event, 'review-voice-redo')) { event.preventDefault(); restart(); return true; }
        // 收音时复习快捷键（翻页、稍后、撤销等）都不响应，避免误触；Tab 等照常。
        if (event.key === 'Tab' || event.key.length > 1 && !/^Arrow/.test(event.key)) return false;
        event.preventDefault();
        return true;
      }
      if (shortcuts.matches(event, 'review-voice') && !$('#reviewVoiceBtn')?.classList.contains('hidden')) { event.preventDefault(); start(); return true; }
      if (shortcuts.matches(event, 'review-voice-redo') && state === 'done' && enabled()) { event.preventDefault(); start(); return true; }
      return false;
    }

    function stop() { cancel(); }

    function bind() {
      if ($('#reviewVoiceBtn')) $('#reviewVoiceBtn').onclick = () => start();
      if ($('#reviewVoiceDone')) $('#reviewVoiceDone').onclick = () => finish();
      if ($('#reviewVoiceRedo')) $('#reviewVoiceRedo').onclick = () => restart();
      $('#reviewDialog')?.addEventListener('close', reset);
    }

    return { bind, onCard, onReveal, handleKey, start, restart, finish, cancel, stop, reset, refresh: refreshButton, pointResults, compose,
      get composing() { return composing; }, get grading() { return grading; },
      get state() { return state; }, get text() { return text; }, dispose: () => { reset(); unsubscribe?.(); } };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemoKeepReviewVoice = api;
})(globalThis);
