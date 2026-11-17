// Draft-only editing and preview. Scheduling is owned by the real review flow.
const MemoKeepCardEditor = (() => {
  let instance;
  function mount() {
    if (instance) return instance;
    const $ = id => document.getElementById(id);
    const dialog = $('cardDialog'), form = $('cardForm');
    const fields = ['question', 'answer', 'cardLibrary', 'cardNotebookSelect', 'cardTags'];
    let baseline = '', saving = false, preview = false, source = '', sourceName = '';
    let pendingImages = 0, imageGeneration = 0, selectedImage = null, selectedField = null, replaceImage = null;
    const editors = {};
    const draftImages = new Set();
    dialog.addEventListener('close', () => {
      imageGeneration++;
      for (const id of draftImages) window.memoKeepDesktop?.deleteNoteImage?.(id).catch(() => {});
      draftImages.clear();
    });
    function serialize(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.tagName === 'IMG') return `![图片](${node.dataset.reference}#w=${node.dataset.width || 48})`;
      if (node.tagName === 'BR') return '\n';
      const text = Array.from(node.childNodes).map(serialize).join('');
      return ['DIV', 'P'].includes(node.tagName) ? text + '\n' : text;
    }
    function sync(id) { $(id).value = Array.from(editors[id].childNodes).map(serialize).join(''); formats?.refresh(); status(); }
    const imageTools = document.createElement('div'); imageTools.className = 'ce-image-tools'; imageTools.hidden = true;
    for (const [label, action] of [['放大', () => ReviewPresentation.enlarge(selectedImage)], ['替换', () => { replaceImage = selectedImage; $('cardImageInput').multiple = false; $('cardImageInput').click(); }], ['删除', () => { selectedImage.remove(); sync(selectedField); deselect(); }]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => { if (!saving && selectedImage) action(); }; imageTools.appendChild(button);
    }
    const size = document.createElement('input'); size.type = 'range'; size.min = 20; size.max = 100;
    size.setAttribute('aria-label', '图片宽度百分比'); size.oninput = () => {
      if (!selectedImage || saving) return;
      selectedImage.dataset.width = size.value; selectedImage.style.width = `${size.value}%`; sync(selectedField);
    }; imageTools.appendChild(size); $('cardForm').querySelector('.ce-content').appendChild(imageTools);
    function deselect() { selectedImage?.classList.remove('is-selected'); selectedImage = null; imageTools.hidden = true; }
    function loadEditors() {
      deselect();
      for (const id of ['question', 'answer']) {
        const root = editors[id]; root.textContent = '';
        ReviewPresentation.contentParts($(id).value).forEach(part => root.appendChild(part.reference ? ReviewPresentation.imageNode(part) : document.createTextNode(part.text)));
      }
    }
    const formats = window.MemoKeepCardFormatsEditor?.mount({ form,
      setField(id, value) { $(id).value = value; const root = editors[id]; if (root) { root.textContent = ''; for (const part of ReviewPresentation.contentParts(value)) root.appendChild(part.reference ? ReviewPresentation.imageNode(part) : document.createTextNode(part.text)); } status(); }, changed: () => status(), error,
      draftImage: id => draftImages.add(id), uploadState(delta) { pendingImages += delta; $('cardSaveButton').disabled = saving || pendingImages > 0; status(); }, isSaving: () => saving
    });
    function captureRange(root) {
      const selection = window.getSelection();
      return selection.rangeCount && root.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    }
    function insert(root, node, range) {
      if (range && root.contains(range.startContainer)) {
        range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      } else root.appendChild(node);
    }
    async function insertFiles(id, files, range, target = null) {
      const root = editors[id], generation = imageGeneration;
      pendingImages++; $('cardSaveButton').disabled = true;
      try {
        if (!window.memoKeepDesktop?.saveNoteImage) throw new Error('当前环境不支持本地图片存储');
        let first = true;
        for (const file of files) {
          if (file.size > 25 * 1024 * 1024) throw new Error('单张图片不能超过 25 MB');
          const saved = await window.memoKeepDesktop.saveNoteImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || '卡片图片', mimeType: file.type });
          draftImages.add(saved.id);
          if (generation !== imageGeneration) { window.memoKeepDesktop?.deleteNoteImage?.(saved.id).catch(() => {}); draftImages.delete(saved.id); return; }
          const image = ReviewPresentation.imageNode({ reference: saved.reference, alt: '图片', width: target?.dataset.width || 48 });
          if (target?.isConnected) { target.replaceWith(image); target = null; deselect(); }
          else { if (first) insert(root, document.createTextNode('\n'), range); insert(root, image, range); }
          first = false;
          sync(id);
        }
      } catch (cause) { if (generation === imageGeneration) error(`图片插入失败：${cause.message}`); }
      finally { pendingImages--; $('cardSaveButton').disabled = saving || pendingImages > 0; }
    }
    for (const id of ['question', 'answer']) {
      const root = $(id + 'Editor'); editors[id] = root;
      root.addEventListener('input', () => { if (selectedImage && !root.contains(selectedImage)) deselect(); sync(id); error(''); });
      root.addEventListener('click', event => {
        deselect();
        if (event.target.tagName !== 'IMG') return;
        selectedImage = event.target; selectedField = id; selectedImage.classList.add('is-selected');
        size.value = selectedImage.dataset.width || 48; imageTools.hidden = false;
        root.parentElement.querySelector('.ce-field-head').appendChild(imageTools);
      });
      root.addEventListener('paste', event => {
        event.preventDefault();
        const files = Array.from(event.clipboardData.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
        const range = captureRange(root);
        if (files.length) { insertFiles(id, files, range); return; }
        insert(root, document.createTextNode(event.clipboardData.getData('text/plain')), range); sync(id);
      });
      root.addEventListener('dragover', event => event.preventDefault());
      root.addEventListener('drop', event => {
        event.preventDefault(); const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'));
        if (files.length) insertFiles(id, files, null);
      });
    }
    document.addEventListener('pointerdown', event => {
      if (selectedImage && event.target !== selectedImage && !imageTools.contains(event.target)) deselect();
    });
    let fileField = 'question', fileRange = null;
    form.querySelectorAll('[data-card-image-field]').forEach(button => button.onclick = () => {
      fileField = button.dataset.cardImageField; fileRange = captureRange(editors[fileField]); replaceImage = null;
      $('cardImageInput').multiple = true; $('cardImageInput').click();
    });
    $('cardImageInput').onchange = () => {
      const target = replaceImage; insertFiles(target ? selectedField : fileField, Array.from($('cardImageInput').files), target ? null : fileRange, target);
      $('cardImageInput').value = ''; replaceImage = null;
    };
    function expandSettings(expanded) {
      if (!expanded) closeLibraryPicker();
      $('cardSettings').hidden = !expanded;
      $('cardSettingsToggle').setAttribute('aria-expanded', String(expanded));
    }
    $('cardSettingsToggle').onclick = () => expandSettings($('cardSettings').hidden);
    const librarySelect = $('cardLibrary'), libraryTrigger = $('cardLibraryTrigger');
    const libraryPopover = $('cardLibraryPopover'), librarySearch = $('cardLibrarySearch');
    function updateLibraryLabel() {
      const option = Array.from(librarySelect.options).find(option => option.value === librarySelect.value);
      $('cardLibraryValue').textContent = librarySelect.value ? option?.textContent || '不关联' : '不关联';
    }
    function renderLibraryChoices() {
      const list = $('cardLibraryChoices'); list.textContent = '';
      const query = librarySearch.value.trim().toLocaleLowerCase();
      const options = [{ value: '', label: '不关联' }, ...Array.from(librarySelect.options).filter(option => option.value).map(option => ({ value: option.value, label: option.textContent }))];
      for (const option of options.filter(option => !query || option.label.toLocaleLowerCase().includes(query))) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'ce-library-option';
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.value === librarySelect.value));
        const icon = document.createElement('span'); icon.className = 'ce-library-option-icon'; icon.setAttribute('aria-hidden', 'true');
        if (option.value) icon.innerHTML = '<svg><use href="#icon-book-open-text"></use></svg>';
        const label = document.createElement('span'); label.className = 'ce-library-option-label'; label.textContent = option.label;
        const check = document.createElement('span'); check.className = 'ce-library-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
        button.append(icon, label, check);
        button.onclick = () => {
          librarySelect.value = option.value; librarySelect.dispatchEvent(new Event('change', { bubbles: true }));
          libraryPopover.hidePopover(); libraryTrigger.focus();
        };
        list.appendChild(button);
      }
      $('cardLibraryNoResults').hidden = Boolean(list.children.length);
    }
    function positionLibraryPopover() {
      const bounds = libraryTrigger.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 24);
      libraryPopover.style.width = `${width}px`;
      libraryPopover.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
      const above = bounds.top - 20, below = window.innerHeight - bounds.bottom - 20;
      const upwards = above >= 240 || above > below;
      libraryPopover.style.maxHeight = `${Math.max(80, Math.min(320, upwards ? above : below))}px`;
      libraryPopover.style.top = upwards ? 'auto' : `${bounds.bottom + 6}px`;
      libraryPopover.style.bottom = upwards ? `${window.innerHeight - bounds.top + 6}px` : 'auto';
    }
    function closeLibraryPicker() {
      if (libraryPopover.matches(':popover-open')) libraryPopover.hidePopover();
    }
    libraryTrigger.onclick = () => {
      if (libraryPopover.matches(':popover-open')) { closeLibraryPicker(); return; }
      librarySearch.value = ''; renderLibraryChoices(); positionLibraryPopover();
      libraryPopover.showPopover(); librarySearch.focus({ preventScroll: true });
    };
    librarySearch.addEventListener('input', renderLibraryChoices);
    librarySelect.addEventListener('change', updateLibraryLabel);
    libraryPopover.addEventListener('toggle', event => libraryTrigger.setAttribute('aria-expanded', String(event.newState === 'open')));
    libraryPopover.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLibraryPicker(); libraryTrigger.focus(); return; }
      const options = Array.from($('cardLibraryChoices').children);
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && options.length) {
        event.preventDefault(); const index = options.indexOf(document.activeElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      } else if (event.key === 'Enter' && event.target === librarySearch) { event.preventDefault(); options[0]?.click(); }
    });
    form.querySelector('.ce-scroll').addEventListener('scroll', closeLibraryPicker);
    window.addEventListener('resize', closeLibraryPicker);
    dialog.addEventListener('close', closeLibraryPicker);
    const tags = () => [...new Set($('cardTags').value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean))];
    const values = () => JSON.stringify([fields.map(id => $(id).value), formats?.value() || null, formats?.createReverse() || false]);
    const dirty = () => values() !== baseline || Boolean($('cardTagDraft').value.trim());
    function status() {
      $('cardEditStatus').textContent = saving ? '正在保存…' : dirty() ? '有未保存的修改' : '尚未修改';
      $('cardEditStatus').classList.toggle('is-dirty', dirty());
      $('cardDiscardPrompt').hidden = true;
    }
    function renderTags() {
      $('cardTagChips').textContent = '';
      tags().forEach(tag => {
        const chip = document.createElement('span'); chip.className = 'ce-tag';
        const text = document.createElement('span'); text.textContent = tag;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
        remove.setAttribute('aria-label', `移除标签 ${tag}`);
        remove.onclick = () => { $('cardTags').value = tags().filter(t => t !== tag).join(', '); renderTags(); status(); $('cardTagDraft').focus(); };
        chip.appendChild(text); chip.appendChild(remove); $('cardTagChips').appendChild(chip);
      });
    }
    function flushTags() {
      if (!$('cardTagDraft').value.trim()) { status(); return; }
      $('cardTags').value = [...new Set([...tags(), ...$('cardTagDraft').value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)])].join(', ');
      $('cardTagDraft').value = ''; renderTags(); status();
    }
    function renderPreview() {
      const card = { question: $('question').value.trim() || '未填写问题', answer: $('answer').value.trim(), ...(formats?.value() || {}) };
      ReviewPresentation.renderContent($('cardPreviewQuestion'), card.question, card);
      $('cardPreviewSource').textContent = sourceName ? `来源：${sourceName}` : '手动创建';
      ReviewPresentation.renderAnswer($('cardPreviewAnswer'), card.answer, card);
      $('cardPreviewAnswerArea').hidden = true; $('cardPreviewReset').hidden = true;
      const empty = !$('question').value.trim() || !$('answer').value.trim();
      $('cardPreviewEmpty').hidden = !empty;
      $('cardPreviewEmpty').textContent = '请先填写问题和答案。';
      $('cardPreviewReveal').hidden = empty;
    }
    function switchTab(next, focus = false) {
      closeLibraryPicker(); flushTags(); preview = next;
      $('cardEditPanel').hidden = next; $('cardPreviewPanel').hidden = !next;
      ['cardEditTab', 'cardPreviewTab'].forEach((id, i) => { $(id).setAttribute('aria-selected', String(Boolean(i) === next)); $(id).tabIndex = Boolean(i) === next ? 0 : -1; });
      $('cardEditTab').hidden = !next; $('cardPreviewTab').hidden = next;
      $('cardEditTab').tabIndex = next ? 0 : -1; $('cardPreviewTab').tabIndex = next ? -1 : 0; deselect();
      if (next) renderPreview();
      form.querySelector('.ce-scroll').scrollTop = 0;
      if (focus) $(next ? 'cardEditTab' : 'cardPreviewTab').focus();
    }
    function close() {
      if (saving || pendingImages) return;
      if (!dirty()) { dialog.close(); return; }
      $('cardDiscardPrompt').hidden = false; $('cardKeepEditing').focus();
    }
    function error(message) { $('cardEditError').textContent = message; $('cardEditError').hidden = !message; }
    function validate() {
      if (pendingImages) { error('图片正在保存，请稍候。'); return false; }
      flushTags(); error('');
      if (formats?.value().cardType === 'cloze' && !$('answer').value.trim()) { $('answer').value = window.MemoKeepCardFormats.clozeAnswer($('question').value); loadEditors(); }
      const formatError = formats?.validate(); if (formatError) { switchTab(false); expandSettings(true); error(formatError); return false; }
      for (const [id, name] of [['question', '问题'], ['answer', '参考答案']]) {
        $(id).removeAttribute('aria-invalid');
        if (!$(id).value.trim()) { switchTab(false); $(id).setAttribute('aria-invalid', 'true'); error(`请填写${name}。`); editors[id].focus(); return false; }
      }
      return true;
    }
    function setSaving(value) {
      saving = value; form.setAttribute('aria-busy', String(value));
      form.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = value; });
      Object.values(editors).forEach(root => root.contentEditable = String(!value));
      status();
    }
    $('cardEditTab').onclick = () => switchTab(false);
    $('cardPreviewTab').onclick = () => switchTab(true);
    $('cardPreviewBack').onclick = () => { switchTab(false); editors.question.focus(); };
    $('cardPreviewReveal').onclick = () => { $('cardPreviewAnswerArea').hidden = false; $('cardPreviewReveal').hidden = true; $('cardPreviewReset').hidden = false; $('cardPreviewReset').focus({ preventScroll: true }); };
    $('cardPreviewReset').onclick = () => { renderPreview(); form.querySelector('.ce-scroll').scrollTop = 0; $('cardPreviewReveal').focus({ preventScroll: true }); };
    $('cardSourceExpand').onclick = () => { const expanded = $('cardSourceExpand').getAttribute('aria-expanded') !== 'true'; $('cardSourceExpand').setAttribute('aria-expanded', String(expanded)); $('cardSourceExpand').textContent = expanded ? '收起原文' : '查看原文'; $('cardSourceExcerpt').hidden = !expanded; $('cardSourceExcerpt').classList.toggle('is-expanded', expanded); };
    form.querySelectorAll('[data-card-close]').forEach(button => { button.onclick = close; });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    $('cardKeepEditing').onclick = () => {
      $('cardDiscardPrompt').hidden = true;
      $(preview ? 'cardEditTab' : 'questionEditor').focus();
    };
    $('cardDiscard').onclick = () => { if (!saving && !pendingImages) dialog.close(); };
    form.addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); error(''); status(); });
    form.addEventListener('change', status);
    $('cardTagDraft').addEventListener('blur', flushTags);
    $('cardTagDraft').addEventListener('keydown', event => { if (!event.isComposing && ['Enter', ',', '，'].includes(event.key)) { event.preventDefault(); flushTags(); } });
    // Capture save inside this dialog before global note-editor shortcuts.
    window.addEventListener('keydown', event => {
      if (!dialog.open || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 's' || event.key === 'Enter')) { event.preventDefault(); event.stopImmediatePropagation(); if (!saving) form.requestSubmit(); return; }
      if (saving || pendingImages) return;
      if (event.target.closest?.('[role="tablist"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); switchTab(event.key === 'Home' ? false : event.key === 'End' ? true : !preview, true); }
      if (preview && event.code === 'Space' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && (!event.target.closest?.('button,input,textarea,select') || event.target.getAttribute('role') === 'tab') && !$('cardPreviewReveal').hidden) { event.preventDefault(); $('cardPreviewReveal').click(); }
    }, true);
    instance = { flushTags, markSaved() {
      const content = $('question').value + '\n' + $('answer').value;
      for (const id of draftImages) if (!content.includes(`memokeep-image://${id}`)) window.memoKeepDesktop?.deleteNoteImage?.(id).catch(() => {});
      draftImages.clear();
    }, format: () => ({ ...(formats?.value() || {}), createReverse: formats?.createReverse() || false }), validate, setSaving, error, get saving() { return saving; }, reset(info) {
      closeLibraryPicker(); updateLibraryLabel();
      imageGeneration++; loadEditors(); expandSettings(Boolean(info.card?.cardType && info.card.cardType !== 'qa'));
      formats?.reset(info.card || {});
      setSaving(false); error(''); $('cardTagDraft').value = ''; $('cardTags').value = tags().join(', '); baseline = values();
      source = info.sourceText || ''; sourceName = info.sourceTitle || '';
      $('cardSourceName').textContent = sourceName || (info.hasSource ? '来源笔记不可用' : '手动创建');
      $('cardSourceExcerpt').textContent = source || (info.hasSource ? '来源不可用' : '未关联笔记');
      $('cardSourceExpand').hidden = !source; $('cardSourceExpand').setAttribute('aria-expanded', 'false'); $('cardSourceExpand').textContent = '查看原文'; $('cardSourceExcerpt').hidden = true; $('cardSourceExcerpt').classList.remove('is-expanded');
      $('cardSourceHint').hidden = true;
      $('cardSourceContext').hidden = !sourceName && !info.hasSource;
      $('cardSettingsToggle').hidden = false;
      $('cardEditFooterHint').textContent = info.editing ? '保留已有复习记录' : '保存后加入复习计划'; $('cardEditFooterHint').hidden = false;
      $('cardSaveLabel').textContent = info.editing ? '保存修改' : '保存卡片';
      $('cardSaveShortcut').textContent = /Mac/.test(window.navigator.platform) ? '⌘ S' : 'Ctrl S';
      renderTags(); switchTab(false);
      form.querySelectorAll('[aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
      form.querySelector('.ce-scroll').scrollTop = 0;
    } };
    return instance;
  }
  return { mount };
})();
