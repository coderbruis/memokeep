(function expose(root) {
  function createMemos({ state, config, actions, env }) {
    const newMemoSession = () => ({ active: true, saving: false, uploads: new Set() });
    let memoSession = newMemoSession();
    const isCurrentMemoSession = session => session === memoSession && session.active;

    const pendingMemoImageCleanup = new Set();
    let memoImageCleanupTail = Promise.resolve();
    let memoWritesPending = 0;

    function setMemoSaving(session, saving) {
      session.saving = saving;
      if (session !== memoSession) return;
      const form = config.$('#memoForm'), editor = state.memos.memoContentEditor;
      form.setAttribute('aria-busy', String(saving));
      if (saving && !session.lockedControls) {
        session.lockedControls = new Map();
        form.querySelectorAll('input, select, textarea, button').forEach(control => {
          if (control.hasAttribute('data-close-dialog')) return;
          session.lockedControls.set(control, control.disabled);
          control.disabled = true;
        });
        if (editor) {
          session.editorLock = { editor, enabled: editor.isEnabled?.() ?? true, editable: editor.root.getAttribute('contenteditable') };
          editor.enable?.(false);
          editor.root.setAttribute('contenteditable', 'false');
        }
      } else if (!saving && session.lockedControls) {
        session.lockedControls.forEach((disabled, control) => { control.disabled = disabled; });
        session.lockedControls = null;
        if (session.editorLock) {
          const { editor: locked, enabled, editable } = session.editorLock;
          locked.enable?.(enabled);
          if (editable === null) locked.root.removeAttribute('contenteditable');
          else locked.root.setAttribute('contenteditable', editable);
          session.editorLock = null;
        }
      }
    }

    function cleanupMemoImages(imageIds, session, message = '临时图片清理失败') {
      imageIds.forEach(id => pendingMemoImageCleanup.add(id));
      const cleanup = memoImageCleanupTail.then(async () => {
        if (memoWritesPending) return;
        for (const id of [...pendingMemoImageCleanup]) {
          if (state.memos.memoDraftImageIds.has(id)) continue;
          try {
            // Re-evaluate shared references on every attempt, including retries.
            await actions.deleteUnreferencedNoteImageFiles([id]);
            pendingMemoImageCleanup.delete(id);
          } catch (error) {
            if (session === memoSession) actions.showToast(`${message}：${error.message}`, true);
          }
        }
      });
      memoImageCleanupTail = cleanup.catch(() => {});
      return cleanup;
    }

    function memoTimestamp(memo) {
      const value = memo.remindAt ? new Date(memo.remindAt).getTime() : Number.POSITIVE_INFINITY;
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    }

    function memoDateLabel(memo) {
      if (!memo.remindAt) return '未设置提醒';
      const timestamp = actions.memoTimestamp(memo);
      const date = new Date(timestamp);
      const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const day = actions.todayKey(timestamp);
      if (day === actions.todayKey()) return `今天 ${time}`;
      if (day === actions.todayKey(config.now() + config.DAY)) return `明天 ${time}`;
      return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
    }

    function memoMatchesFilter(memo) {
      if (state.memos.activeMemoFilter === 'completed') return memo.completed;
      if (memo.completed) return false;
      if (state.memos.activeMemoFilter === 'today') return memo.remindAt && actions.todayKey(actions.memoTimestamp(memo)) === actions.todayKey();
      if (state.memos.activeMemoFilter === 'upcoming') return memo.remindAt && actions.memoTimestamp(memo) > config.now();
      return true;
    }

    function memoGroup(memo) {
      if (memo.completed) return '已完成';
      if (!memo.remindAt) return '无日期';
      const timestamp = actions.memoTimestamp(memo);
      if (timestamp < config.now() && actions.todayKey(timestamp) !== actions.todayKey()) return '已逾期';
      if (actions.todayKey(timestamp) === actions.todayKey()) return '今天';
      return '之后';
    }

    function renderMemos() {
      const host = config.$('#memoList');
      if (!host) return;
      const openMemos = env.application.state.memos.all.filter(memo => !memo.completed);
      const today = openMemos.filter(memo => memo.remindAt && actions.todayKey(actions.memoTimestamp(memo)) === actions.todayKey());
      const overdue = openMemos.filter(memo => memo.remindAt && actions.memoTimestamp(memo) < config.now());
      const counts = { all: openMemos.length, today: today.length, upcoming: openMemos.filter(memo => memo.remindAt && actions.memoTimestamp(memo) > config.now()).length, completed: env.application.state.memos.all.filter(memo => memo.completed).length };
      config.$$('#memoFilterChips [data-memo-count]').forEach(node => { const count = counts[node.dataset.memoCount]; node.textContent = count; node.hidden = !count; });
      const navBadge = config.$('#memoNavBadge');
      const attentionCount = new Set([...today, ...overdue].map(memo => memo.id)).size;
      navBadge.textContent = attentionCount;
      navBadge.classList.toggle('hidden', attentionCount === 0);
      config.$$('#memoFilterChips [data-memo-filter]').forEach(button => { const active = button.dataset.memoFilter === state.memos.activeMemoFilter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
      const menu = config.$('#memoRowMenu');
      if (menu?.matches(':popover-open')) menu.hidePopover();

      const query = (config.$('#memoSearch')?.value || '').trim().toLocaleLowerCase('zh-CN');
      const priorityRank = { high: 0, medium: 1, normal: 2 };
      const visible = env.application.state.memos.all
      .filter(actions.memoMatchesFilter)
      .filter(memo => !query || [memo.title, actions.memoContentText(memo.notes), ...(memo.tags || [])].join(' ').toLocaleLowerCase('zh-CN').includes(query))
      .sort((a, b) => Number(a.completed) - Number(b.completed)
      || actions.memoTimestamp(a) - actions.memoTimestamp(b)
      || priorityRank[a.priority] - priorityRank[b.priority]
      || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      if (!visible.length) {
        host.innerHTML = `<div class="memo-empty"><svg aria-hidden="true" viewBox="0 0 48 48"><path d="M12 5h24a4 4 0 0 1 4 4v22L28 43H12a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z"/><path d="M28 43V35a4 4 0 0 1 4-4h8M16 16h16M16 24h10"/></svg><h2>${query ? '未找到备忘录' : state.memos.activeMemoFilter === 'completed' ? '暂无已完成事项' : state.memos.activeMemoFilter === 'today' ? '今天暂无备忘录' : state.memos.activeMemoFilter === 'upcoming' ? '暂无计划事项' : '暂无备忘录'}</h2></div>`;
        return;
      }

      const groupOrder = ['已逾期', '今天', '之后', '无日期', '已完成'];
      const groups = Map.groupBy ? Map.groupBy(visible, actions.memoGroup) : visible.reduce((map, memo) => {
        const group = actions.memoGroup(memo);
        if (!map.has(group)) map.set(group, []);
        map.get(group).push(memo);
        return map;
      }, new Map());
      host.innerHTML = groupOrder.filter(group => groups.has(group)).map(group => `
    <section class="memo-group ${group === '已逾期' ? 'overdue' : ''}">
      <div class="memo-group-title"><h2>${group}</h2><span>${groups.get(group).length}</span></div>
      <div class="memo-group-items">${groups.get(group).map(memo => {
          const repeatLabel = config.memoRepeatLabels[memo.repeat];
          const tagHtml = (memo.tags || []).slice(0, 1).map(tag => `<span class="memo-tag">${actions.escapeHtml(tag)}</span>`).join('');
          const isOverdue = !memo.completed && memo.remindAt && actions.memoTimestamp(memo) < config.now();
          const dateLabel = actions.memoDateLabel(memo).replace(/^今天 /, '');
          return `<article class="memo-item${memo.completed ? ' completed' : ''}${isOverdue ? ' overdue' : ''}" data-memo-id="${actions.escapeHtml(memo.id)}">
          <button type="button" class="memo-check" data-memo-action="toggle" aria-label="${memo.completed ? '标记为未完成' : '完成备忘录'}" aria-pressed="${Boolean(memo.completed)}"><svg aria-hidden="true"><use href="#icon-check"></use></svg></button>
          <button type="button" class="memo-item-main" data-memo-action="edit"><span class="memo-item-title"><strong>${actions.escapeHtml(memo.title)}</strong>${tagHtml}${memo.priority && memo.priority !== 'normal' ? `<svg class="memo-priority ${actions.escapeHtml(memo.priority)}" role="img" aria-label="${config.memoPriorityLabels[memo.priority] || '优先级'}"><use href="#icon-flag"></use></svg>` : ''}${repeatLabel ? `<svg class="memo-row-repeat" role="img" aria-label="${repeatLabel}"><use href="#icon-repeat-2"></use></svg>` : ''}</span></button>
          <span class="memo-time${isOverdue ? ' overdue' : ''}">${memo.remindAt ? `<svg aria-hidden="true"><use href="#icon-bell"></use></svg>${actions.escapeHtml(dateLabel)}` : ''}</span>
          <button type="button" class="memo-more" data-memo-action="more" aria-label="更多操作" aria-haspopup="true" aria-expanded="false" aria-controls="memoRowMenu"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></button>
        </article>`;
        }).join('')}</div>
    </section>`).join('');
    }

    function serializeMemoContent() {
      if (!state.memos.memoContentEditor) return '';
      const content = state.memos.memoContentEditor.root.cloneNode(true);
      content.querySelectorAll('img').forEach(image => {
        const imageId = String(image.dataset.memokeepImageId || '').toLowerCase();
        if (!imageId) {
          image.remove();
          return;
        }
        image.setAttribute('src', `memokeep-image://${imageId}`);
      });
      return actions.sanitizeMemoContent(content.innerHTML);
    }

    async function loadMemoContentIntoEditor(content = '') {
      const session = memoSession;
      if (!state.memos.memoContentEditor) return;
      state.memos.memoContentEditor.setText('');
      if (!content) return;
      if (!/<[a-z][\s\S]*>/i.test(content)) {
        state.memos.memoContentEditor.setText(content);
        return;
      }

      const template = env.document.createElement('template');
      template.innerHTML = actions.sanitizeMemoContent(content);
      const storedImages = [...template.content.querySelectorAll('img')].map(image => ({
        element: image,
        id: image.dataset.memokeepImageId,
        fileName: image.dataset.fileName || image.alt || '图片'
      }));
      const resolvedImages = await Promise.all(storedImages.map(async image => ({
        ...image,
        preview: config.desktop?.readNoteImage ? await config.desktop.readNoteImage(image.id).catch(() => null) : null
      })));
      if (!isCurrentMemoSession(session)) return;
      resolvedImages.forEach(image => {
        if (image.preview?.dataUrl) image.element.setAttribute('src', image.preview.dataUrl);
        else image.element.replaceWith('[图片不可用]');
      });
      state.memos.memoContentEditor.clipboard.dangerouslyPasteHTML(template.innerHTML);
      const editorImages = [...state.memos.memoContentEditor.root.querySelectorAll('img')];
      resolvedImages.filter(image => image.preview?.dataUrl).forEach((image, index) => {
        const editorImage = editorImages[index];
        if (!editorImage) return;
        editorImage.dataset.memokeepImageId = image.id;
        editorImage.dataset.fileName = image.preview.fileName || image.fileName;
        editorImage.alt = image.preview.fileName || image.fileName;
      });
    }

    async function cleanupMemoDraftImages() {
      const session = memoSession;
      session.active = false;
      setMemoSaving(session, false);
      const imageIds = [...state.memos.memoDraftImageIds];
      state.memos.memoDraftImageIds.clear();
      await cleanupMemoImages(imageIds, session);
    }

    function updateMemoDialogControls() {
      const value = config.$('#memoRemindAt').value;
      const date = value ? new Date(value) : null;
      config.$('#memoTimeLabel').textContent = date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '不提醒';
      config.$('#memoClearTime').hidden = !value;
      const tags = config.$('#memoTags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
      config.$('#memoTagsButton').textContent = tags.length ? tags.join(' · ') : '＋ 添加标签';
    }

    function showMemoCustomTime(visible) {
      config.$('#memoCustomTimeField').hidden = !visible;
      config.$('#memoCustomTime').setAttribute('aria-expanded', String(visible));
      // A closed date picker must not block form submission after clearing its segments in WebKit.
      config.$('#memoRemindAt').disabled = !visible;
    }

    async function openMemoDialog(memo = null) {
      void actions.cleanupMemoDraftImages();
      const session = memoSession = newMemoSession();
      setMemoSaving(session, false);
      if (!isCurrentMemoSession(session)) return;
      try { await actions.loadApplicationScript('vendor/quill/quill.js'); }
      catch (error) { if (isCurrentMemoSession(session)) actions.showToast(error.message, true); return; }
      if (!isCurrentMemoSession(session)) return;
      actions.initializeMemoContentEditor();
      config.$('#memoForm').reset();
      config.$('#editingMemoId').value = memo?.id || '';
      config.$('#memoDialogTitle').textContent = memo ? '编辑备忘录' : '新建备忘录';
      config.$('#memoTitle').value = memo?.title || '';
      await actions.loadMemoContentIntoEditor(memo?.notes || '');
      if (!isCurrentMemoSession(session)) return;
      config.$('#memoRemindAt').value = memo ? (memo.remindAt ? actions.toDateTimeLocal(memo.remindAt) : '') : actions.toDateTimeLocal(actions.roundedHourFromNow());
      config.$('#memoRepeat').value = memo?.repeat || 'none';
      config.$('#memoPriority').value = memo?.priority || 'normal';
      config.$('#memoTags').value = (memo?.tags || []).join(', ');
      config.$('#memoContentToolbar').hidden = true; config.$('#memoContentToolbar').dataset.explicit = 'false'; config.$('#memoFormatToggle').setAttribute('aria-expanded', 'false');
      showMemoCustomTime(false);
      actions.updateMemoDialogControls();
      config.$('#memoDialog').showModal();
      env.requestAnimationFrame(() => config.$('#memoTitle').focus());
    }

    function setMemoTimePreset(preset) {
      const date = new Date();
      if (preset === 'clear') {
        config.$('#memoRemindAt').value = '';
        config.$('#memoRepeat').value = 'none';
        showMemoCustomTime(false);
        actions.updateMemoDialogControls();
        return;
      }
      if (preset === 'later') date.setTime(config.now() + 60 * 60_000);
      if (preset === 'evening') date.setHours(18, 0, 0, 0);
      if (preset === 'tomorrow') {
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
      }
      if (preset === 'evening' && date.getTime() <= config.now()) date.setDate(date.getDate() + 1);
      config.$('#memoRemindAt').value = actions.toDateTimeLocal(date);
      actions.updateMemoDialogControls();
    }

    async function handleSaveMemo(event) {
      event.preventDefault();
      const session = memoSession;
      if (!isCurrentMemoSession(session) || session.saving) return;
      setMemoSaving(session, true);
      try {
        const uploaded = await Promise.all([...session.uploads]);
        if (!isCurrentMemoSession(session)) return;
        if (uploaded.some(success => !success)) {
          actions.showToast('图片插入失败，请重试上传或再次保存现有内容。', true);
          return;
        }
        const id = config.$('#editingMemoId').value;
        const existing = env.application.state.memos.byId(id);
        const previousImageIds = env.application.domain.noteImageIdsFromContent(existing?.notes);
        const reminderValue = config.$('#memoRemindAt').value;
        const timestamp = new Date().toISOString();
        const serializedContent = actions.serializeMemoContent();
        const fields = {
          title: config.$('#memoTitle').value.trim(),
          notes: actions.memoContentText(serializedContent) || env.application.domain.noteImageIdsFromContent(serializedContent).length
          ? serializedContent
          : '',
          remindAt: reminderValue ? new Date(reminderValue).toISOString() : null,
          repeat: reminderValue ? config.$('#memoRepeat').value : 'none',
          priority: config.$('#memoPriority').value,
          tags: config.$('#memoTags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
          notifiedFor: existing?.remindAt === (reminderValue ? new Date(reminderValue).toISOString() : null) ? existing.notifiedFor : null,
          popupShownFor: existing?.remindAt === (reminderValue ? new Date(reminderValue).toISOString() : null) ? existing.popupShownFor : null,
          updatedAt: timestamp
        };
        memoWritesPending++;
        try { await env.application.operations.memos.upsert(existing, fields, timestamp); }
        finally {
          memoWritesPending--;
          // A failed write must roll back before its discarded draft files are checked.
          void cleanupMemoImages([], session);
        }
        if (!isCurrentMemoSession(session)) return;
        const cleanupImageIds = [...previousImageIds, ...state.memos.memoDraftImageIds];
        state.memos.memoDraftImageIds.clear();
        await cleanupMemoImages(cleanupImageIds, session, '备忘录已保存，但图片文件清理失败');
        if (!isCurrentMemoSession(session)) return;
        config.$('#memoDialog').close();
        actions.renderMemos();
        actions.scheduleMemoReminders();
      } finally { setMemoSaving(session, false); }
    }

    async function toggleMemoCompletion(memo) {
      await env.application.operations.memos.toggleCompletion(memo);
      actions.renderMemos();
    }

    async function snoozeMemo(memo) {
      await env.application.operations.memos.snooze(memo);
      actions.renderMemos();
    }

    async function deleteMemo(memoId) {
      const memo = env.application.state.memos.byId(memoId);
      const imageIds = env.application.domain.noteImageIdsFromContent(memo?.notes);
      await env.application.operations.memos.remove(memoId);
      await cleanupMemoImages(imageIds, memoSession, '备忘录已删除，但图片文件清理失败');
      actions.renderMemos();
    }

    async function checkMemoReminders() {
      if (state.memos.memoReminderCheckRunning) return;
      const dueMemos = state.persistence.data.memos.filter(memo => !memo.completed
      && memo.remindAt
      && actions.memoTimestamp(memo) <= config.now()
      && memo.popupShownFor !== memo.remindAt);
      if (!dueMemos.length) return;
      state.memos.memoReminderCheckRunning = true;
      try {
        if (config.desktop?.openApp) await config.desktop.openApp();
        actions.enqueueMemoReminders(dueMemos);
        const reminded = [];
        for (const memo of dueMemos) {
          const contentText = actions.memoContentText(memo.notes);
          const body = contentText ? `${memo.title}\n${contentText}` : memo.title;
          if (state.persistence.data.settings.notificationsEnabled && memo.notifiedFor !== memo.remindAt) {
            if (config.desktop) config.desktop.notify({ title: '备忘录提醒', body, view: 'memos' });
            else if (env.Notification.permission === 'granted') new env.Notification('备忘录提醒', { body });
            reminded.push({ id: memo.id, remindAt: memo.remindAt, notified: true });
          }
          if (!reminded.some(entry => entry.id === memo.id)) reminded.push({ id: memo.id, remindAt: memo.remindAt, notified: false });
        }
        await env.application.operations.memos.markReminded(reminded, new Date().toISOString());
        actions.renderMemos();
      } finally {
        state.memos.memoReminderCheckRunning = false;
      }
    }

    function enqueueMemoReminders(memos) {
      const queuedIds = new Set([state.memos.activeMemoReminderId, ...state.memos.memoReminderQueue]);
      memos.forEach(memo => {
        if (!queuedIds.has(memo.id)) {
          state.memos.memoReminderQueue.push(memo.id);
          queuedIds.add(memo.id);
        }
      });
      actions.showNextMemoReminder();
    }

    function showNextMemoReminder() {
      const dialog = config.$('#memoReminderDialog');
      if (!dialog || dialog.open || state.memos.activeMemoReminderId) return;
      let memo = null;
      while (state.memos.memoReminderQueue.length && !memo) {
        const memoId = state.memos.memoReminderQueue.shift();
        const candidate = state.persistence.data.memos.find(item => item.id === memoId);
        const due = config.desktop?.reminders ? delivery?.reminderOffer(candidate?.id)
          : candidate?.remindAt && actions.memoTimestamp(candidate) <= config.now();
        if (candidate && !candidate.completed && due) memo = candidate;
      }
      if (!memo) return;

      state.memos.activeMemoReminderId = memo.id;
      config.$('#memoReminderTitle').textContent = memo.title;
      const content = actions.memoContentText(memo.notes);
      config.$('#memoReminderContent').textContent = content;
      config.$('#memoReminderContent').classList.toggle('hidden', !content);
      const offer = delivery?.reminderOffer(memo.id);
      config.$('#memoReminderTime').textContent = actions.memoDateLabel(offer ? { ...memo, remindAt: offer.at } : memo);
      dialog.showModal();
      config.$('#memoReminderComplete').focus();
    }

    function closeActiveMemoReminder() {
      const dialog = config.$('#memoReminderDialog');
      if (dialog?.open) dialog.close();
    }

    function scheduleMemoReminders() {
      env.clearInterval(state.memos.memoReminderTimer);
      if (config.isNoteWindow) return;
      actions.checkMemoReminders();
      state.memos.memoReminderTimer = env.setInterval(actions.checkMemoReminders, 5_000);
    }

    function bindMemoEvents() {
      config.$('#newMemoBtn').onclick = () => actions.openMemoDialog();
      config.$('#memoForm').onsubmit = actions.handleSaveMemo;
      const memoPopovers = [['memoOptionsButton', 'memoOptionsPopover'], ['memoTimeButton', 'memoTimePopover'], ['memoTagsButton', 'memoTagsPopover']];
      function closeMemoPopovers() {
        memoPopovers.forEach(([, id]) => { const panel = config.$( '#' + id); if (panel.matches(':popover-open')) panel.hidePopover(); });
      }
      memoPopovers.forEach(([triggerId, panelId]) => {
        const trigger = config.$('#' + triggerId), panel = config.$('#' + panelId);
        trigger.onclick = () => {
          if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
          closeMemoPopovers();
          const bounds = trigger.getBoundingClientRect(), width = Math.min(panelId === 'memoOptionsPopover' ? 260 : 240, env.window.innerWidth - 24);
          panel.style.width = `${width}px`;
          panel.style.left = `${Math.max(12, Math.min(bounds.left, env.window.innerWidth - width - 12))}px`;
          const upwards = env.window.innerHeight - bounds.bottom < 310 && bounds.top > 310;
          panel.style.top = upwards ? 'auto' : `${bounds.bottom + 6}px`;
          panel.style.bottom = upwards ? `${env.window.innerHeight - bounds.top + 6}px` : 'auto';
          panel.showPopover();
          if (panelId === 'memoTagsPopover') config.$('#memoTags').focus({ preventScroll: true });
        };
        panel.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
        panel.addEventListener('keydown', event => {
          if (event.key === 'Escape' || (event.key === 'Enter' && event.target.matches('input'))) {
            event.preventDefault(); event.stopPropagation(); panel.hidePopover(); trigger.focus();
          }
        });
      });
      config.$('#memoDialog').addEventListener('close', closeMemoPopovers);
      env.window.addEventListener('resize', closeMemoPopovers);
      config.$('#memoClearTime').onclick = () => { actions.setMemoTimePreset('clear'); closeMemoPopovers(); };
      config.$('#memoCustomTime').onclick = () => {
        showMemoCustomTime(true);
        config.$('#memoRemindAt').focus();
        try { config.$('#memoRemindAt').showPicker?.(); } catch { /* The date input remains editable. */ }
      };
      config.$('#memoRemindAt').addEventListener('change', actions.updateMemoDialogControls);
      config.$('#memoTags').addEventListener('input', actions.updateMemoDialogControls);
      config.$('#memoInsertImage').onclick = () => config.$('#memoImageInput').click();
      config.$('#memoImageInput').onchange = async () => {
        const files = Array.from(config.$('#memoImageInput').files); config.$('#memoImageInput').value = '';
        if (files.length) await actions.insertMemoImages(files);
      };
      config.$('#memoFormatToggle').onclick = () => {
        const toolbar = config.$('#memoContentToolbar'), visible = toolbar.hidden;
        toolbar.dataset.explicit = String(visible); toolbar.hidden = !visible;
        config.$('#memoFormatToggle').setAttribute('aria-expanded', String(visible));
      };

      config.$('#memoRemindAt').onclick = event => {
        try { event.currentTarget.showPicker?.(); }
        catch { /* The native picker may already be open. */ }
      };
      config.$('#memoSearch').oninput = actions.renderMemos;
      config.$('#memoFilterChips').onclick = event => {
        const button = event.target.closest('[data-memo-filter]');
        if (!button) return;
        state.memos.activeMemoFilter = button.dataset.memoFilter;
        actions.renderMemos();
      };
      let memoMenuTrigger = null;
      config.$('#memoRowMenu').addEventListener('toggle', event => memoMenuTrigger?.setAttribute('aria-expanded', String(event.newState === 'open')));
      config.$('#memoRowMenu').addEventListener('keydown', event => {
        const menu = config.$('#memoRowMenu');
        if (event.key === 'Escape') { event.preventDefault(); menu.hidePopover(); memoMenuTrigger?.focus(); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); const buttons = Array.from(menu.querySelectorAll('button')).filter(button => !button.hidden);
          const index = buttons.indexOf(env.document.activeElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      });
      env.window.addEventListener('resize', () => { const menu = config.$('#memoRowMenu'); if (menu.matches(':popover-open')) menu.hidePopover(); });
      const handleMemoAction = event => {
        if (event.target.closest('[data-empty-new-memo]')) {
          actions.openMemoDialog();
          return;
        }
        const item = event.target.closest('[data-memo-id]');
        const action = event.target.closest('[data-memo-action]')?.dataset.memoAction;
        if (!item || !action) return;
        const memo = state.persistence.data.memos.find(candidate => candidate.id === item.dataset.memoId);
        if (!memo) return;
        const menu = config.$('#memoRowMenu');
        if (action === 'more') {
          if (menu.matches(':popover-open')) menu.hidePopover();
          memoMenuTrigger?.setAttribute('aria-expanded', 'false');
          memoMenuTrigger = event.target.closest('[data-memo-action="more"]');
          menu.dataset.memoId = memo.id;
          menu.querySelector('[data-memo-action="snooze"]').hidden = memo.completed || !memo.remindAt;
          const bounds = memoMenuTrigger.getBoundingClientRect();
          menu.style.left = `${Math.max(12, Math.min(bounds.right - 170, env.window.innerWidth - 182))}px`;
          const upwards = env.window.innerHeight - bounds.bottom < 150;
          menu.style.top = upwards ? 'auto' : `${bounds.bottom + 4}px`;
          menu.style.bottom = upwards ? `${env.window.innerHeight - bounds.top + 4}px` : 'auto';
          menu.showPopover(); memoMenuTrigger.setAttribute('aria-expanded', 'true');
          menu.querySelector('button').focus({ preventScroll: true });
          return;
        }
        if (menu.matches(':popover-open')) menu.hidePopover();
        if (action === 'edit') actions.openMemoDialog(memo);
        if (action === 'toggle') actions.toggleMemoCompletion(memo);
        if (action === 'snooze') actions.snoozeMemo(memo);
        if (action === 'delete') actions.deleteMemo(memo.id);
      };
      config.$('#memoList').onclick = handleMemoAction;
      config.$('#memoRowMenu').onclick = handleMemoAction;
      config.$('#memoDialog').onclick = event => {
        const preset = event.target.closest('[data-memo-preset]')?.dataset.memoPreset;
        if (preset) { actions.setMemoTimePreset(preset); config.$('#memoTimePopover').hidePopover(); }
      };
      config.$('#memoDialog').addEventListener('close', actions.cleanupMemoDraftImages);
      config.$('#memoReminderDismiss').onclick = actions.closeActiveMemoReminder;
      config.$('#memoReminderDismissIcon').onclick = actions.closeActiveMemoReminder;
      const currentReminder = async () => {
        const id = state.memos.activeMemoReminderId;
        if (config.desktop?.reminders && !await delivery.isCurrentReminder()) {
          if (state.memos.activeMemoReminderId === id) actions.closeActiveMemoReminder();
          return null;
        }
        return state.memos.activeMemoReminderId === id ? state.persistence.data.memos.find(item => item.id === id && !item.completed) : null;
      };
      config.$('#memoReminderSnooze').onclick = async () => {
        const memo = await currentReminder();
        if (!memo) return;
        actions.closeActiveMemoReminder();
        if (memo) await actions.snoozeMemo(memo);
        actions.scheduleMemoReminders();
      };
      config.$('#memoReminderComplete').onclick = async () => {
        const memo = await currentReminder();
        if (!memo) return;
        actions.closeActiveMemoReminder();
        await env.application.operations.memos.complete(memo);
        actions.renderMemos();
        actions.scheduleMemoReminders();
      };
      config.$('#memoReminderDialog').addEventListener('close', () => {
        state.memos.activeMemoReminderId = null;
        env.setTimeout(actions.showNextMemoReminder, 0);
      });
    }

    function initializeMemoContentEditor() {
      if (state.memos.memoContentEditor) return;
      if (!config.$('#memoContentEditor') || typeof env.window.Quill !== 'function') return;
      state.memos.memoContentEditor = new env.window.Quill('#memoContentEditor', {
        theme: 'snow',
        placeholder: '写点内容…',
        formats: ['bold', 'italic', 'underline', 'strike', 'list', 'blockquote', 'link', 'image'],
        modules: { toolbar: '#memoContentToolbar' }
      });
      state.memos.memoContentEditor.on('selection-change', range => {
        if (!range) return;
        const visible = range.length > 0 || config.$('#memoContentToolbar').dataset.explicit === 'true';
        config.$('#memoContentToolbar').hidden = !visible;
        config.$('#memoFormatToggle').setAttribute('aria-expanded', String(visible));
      });
      env.bindNotePlainPaste(state.memos.memoContentEditor, actions.showToast);
      state.memos.memoContentEditor.root.addEventListener('paste', async event => {
        const itemImages = [...(event.clipboardData?.items || [])]
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);
        const imageFiles = itemImages.length
        ? itemImages
        : [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if (!imageFiles.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!config.desktop?.saveNoteImage || !config.desktop?.readNoteImage) {
          actions.showToast('当前环境不支持粘贴本地图片', true);
          return;
        }

        await actions.insertMemoImages(imageFiles);
      }, true);
    }

    function insertMemoImages(imageFiles) {
      const session = memoSession, editor = state.memos.memoContentEditor;
      if (!isCurrentMemoSession(session) || !editor) return Promise.resolve(false);
      if (session.saving) { actions.showToast('正在保存，请稍候再插入图片。', true); return Promise.resolve(false); }
      if (!config.desktop?.saveNoteImage || !config.desktop?.readNoteImage) { actions.showToast('当前环境不支持本地图片', true); return Promise.resolve(false); }
      const range = editor.getSelection(true) || { index: editor.getLength() - 1, length: 0 };
      const task = (async () => {
        let insertIndex = range.index, savedId = null;
        try {
          for (const file of imageFiles) {
            const bytes = new env.Uint8Array(await file.arrayBuffer());
            if (!isCurrentMemoSession(session)) return false;
            const savedImage = await config.desktop.saveNoteImage({ bytes, mimeType: file.type, name: file.name || '粘贴图片' });
            savedId = savedImage.id;
            if (!isCurrentMemoSession(session)) { await cleanupMemoImages([savedId], session); return false; }
            state.memos.memoDraftImageIds.add(savedId);
            const preview = await config.desktop.readNoteImage(savedId);
            if (!isCurrentMemoSession(session)) { await cleanupMemoImages([savedId], session); return false; }
            if (!preview?.dataUrl) throw new Error('图片保存后无法读取。');
            const insertImage = () => {
              if (insertIndex === range.index && range.length) editor.deleteText(range.index, range.length, 'user');
              const imagesBeforeInsert = new Set(editor.root.querySelectorAll('img'));
              editor.insertEmbed(insertIndex, 'image', preview.dataUrl, 'user');
              const insertedImage = [...editor.root.querySelectorAll('img')].find(image => !imagesBeforeInsert.has(image));
              if (!insertedImage) throw new Error('图片未能插入编辑器。');
              insertedImage.dataset.memokeepImageId = savedId;
              insertedImage.dataset.fileName = preview.fileName || savedImage.fileName;
              insertedImage.alt = preview.fileName || savedImage.fileName;
            };
            const insertAtomically = () => env.application.editor.factories.createQuillTransactions().preserveOnFailure(editor, insertImage);
            // Quill preserves user-source history while its UI remains read-only.
            if (session.saving) {
              let insertionError;
              editor.editReadOnly(() => { try { insertAtomically(); } catch (error) { insertionError = error; } });
              if (insertionError) throw insertionError;
            }
            else insertAtomically();
            savedId = null;
            insertIndex += 1;
          }
          editor.setSelection(insertIndex, 0, 'silent');
          actions.showToast(`已粘贴 ${imageFiles.length} 张图片`);
          return true;
        } catch (error) {
          if (savedId) {
            if (isCurrentMemoSession(session)) state.memos.memoDraftImageIds.delete(savedId);
            await cleanupMemoImages([savedId], session);
          }
          if (isCurrentMemoSession(session)) actions.showToast(`粘贴图片失败：${error.message}`, true);
          return false;
        }
      })();
      session.uploads.add(task);
      task.finally(() => session.uploads.delete(task));
      return task;
    }
    const delivery = root.MemoKeepReminderDelivery?.create({ state, config, actions, legacyCheck: checkMemoReminders, legacyShow: showNextMemoReminder });
    return { memoTimestamp, memoDateLabel, memoMatchesFilter, memoGroup, renderMemos, serializeMemoContent, loadMemoContentIntoEditor, cleanupMemoDraftImages, updateMemoDialogControls, openMemoDialog, setMemoTimePreset, handleSaveMemo, toggleMemoCompletion, snoozeMemo, deleteMemo, checkMemoReminders, enqueueMemoReminders, showNextMemoReminder, closeActiveMemoReminder, scheduleMemoReminders, bindMemoEvents, initializeMemoContentEditor, insertMemoImages, ...delivery };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createMemos });
})(globalThis);
