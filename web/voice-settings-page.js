// 设置 › 语音作答（精简版）：开关、停顿时长、判定严格程度，以及语音词库（web/voice-terms-settings.js）。
// 权限只在有问题时出现一条提示。字段和默认值见 web/domain/voice-settings.js。
(function () {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const model = () => window.MemoKeepVoiceSettings;
  const speech = () => window.memoKeepDesktop?.speech;
  const data = () => (typeof applicationShell !== 'undefined' ? applicationShell.state.persistence.data : null);
  const transact = fn => (typeof application !== 'undefined' ? application.persistence.transact(fn) : Promise.reject(new Error('unavailable')));
  const config = () => model().read(data()?.settings || {});
  let supported = null, statusToken = 0;

  function render() {
    if (!$('[data-settings-section="voice"]') || !model()) return;
    const current = config();
    $$('[data-settings-section="voice"] [data-voice-setting]').forEach(control => {
      const value = current[control.dataset.voiceSetting];
      if (control.matches('input[type="checkbox"]')) control.checked = Boolean(value);
      else control.querySelectorAll('[data-value]').forEach(button => button.setAttribute('aria-checked', String(String(value) === button.dataset.value)));
    });
    const state = $('#voiceLearningState');
    if (state) state.textContent = current.voiceReview ? '开' : '关';
    // 不支持语音的电脑：只保留语音词库能编辑。
    const off = supported === false;
    $('#voiceUnsupported').hidden = !off;
    $$('[data-settings-section="voice"] [data-voice-group]').forEach(group => group.classList.toggle('is-disabled', off && group.dataset.voiceGroup !== 'terms'));
  }

  // 权限：被拒绝时才显示一条提示和「打开系统设置」。
  async function refreshStatus() {
    const alert = $('#voicePermissionAlert');
    if (!alert) return;
    const token = ++statusToken, api = speech();
    let status = null;
    if (api?.status) { try { status = await api.status('zh-CN'); } catch {} }
    if (token !== statusToken) return;
    supported = Boolean(api?.status && status?.supported);
    const bad = value => value === 'denied' || value === 'restricted';
    const blocked = !supported ? '' : bad(status.microphone) ? 'microphone-denied' : bad(status.speech) ? 'speech-denied' : '';
    alert.hidden = !blocked;
    alert.dataset.code = blocked;
    $('#voicePermissionText').textContent = blocked === 'microphone-denied' ? 'MemoKeep 没有麦克风权限，语音作答用不了。' : blocked ? 'MemoKeep 没有语音识别权限，语音作答用不了。' : '';
    render();
  }

  async function save(key, raw) {
    const value = model().accept(key, raw);
    if (value === undefined) return;
    try { await transact(next => { next.settings[key] = value; }); } catch {}
    render();
  }

  // 打开 设置 › 语音作答；focus: 'terms' 定位到语音词库。
  function open({ focus } = {}) {
    if (typeof applicationShell !== 'undefined') applicationShell.actions.showView('settings');
    $('[data-settings-panel="voice"]')?.click();
    const group = $(`[data-settings-section="voice"] [data-voice-group="${focus === 'terms' ? 'terms' : 'basic'}"]`);
    if (group && focus) {
      group.scrollIntoView({ block: 'start', behavior: 'auto' });
      group.classList.remove('is-flash'); void group.offsetWidth; group.classList.add('is-flash');
    }
  }

  function onShow() { window.MemoKeepVoiceTermSettings?.reset(); render(); refreshStatus(); }

  function bind() {
    const page = $('[data-settings-section="voice"]');
    if (!page || !model()) return;
    page.addEventListener('change', event => {
      const control = event.target.closest('input[data-voice-setting]');
      if (control) save(control.dataset.voiceSetting, control.checked);
    });
    page.addEventListener('click', event => {
      const option = event.target.closest('.vs-seg[data-voice-setting] [data-value]');
      if (option) save(option.closest('[data-voice-setting]').dataset.voiceSetting, option.dataset.value);
    });
    $('#voicePermissionOpen')?.addEventListener('click', () => speech()?.openSettings?.($('#voicePermissionAlert').dataset.code || 'microphone-denied'));
    $$('[data-open-settings-panel]').forEach(button => button.addEventListener('click', () => $(`[data-settings-panel="${button.dataset.openSettingsPanel}"]`)?.click()));
    $('[data-settings-panel="voice"]')?.addEventListener('click', onShow);
    $('[data-settings-panel="learning"]')?.addEventListener('click', render);
    // 从系统设置改完权限回来，刷新提示。
    window.addEventListener('focus', () => { if (!page.hidden) refreshStatus(); });
    render();
  }

  window.MemoKeepVoiceSettingsPage = { open, render, refreshStatus };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
