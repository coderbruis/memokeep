// Editing library metadata never changes its ID, hierarchy, notes or cards.
let librarySettingsContext = null;
let librarySettingsSaving = false;

function librarySettingsValues(library) {
  return { name: library.name || '', description: library.description || '', type: library.type || 'general', language: library.language || '' };
}

function openLibrarySettings(id) {
  if (librarySettingsSaving) return;
  const library = application.state.knowledge.libraryById(id);
  if (!library) { applicationShell.actions.showToast('知识库已不存在', true); return; }
  const dialog = applicationShell.config.$('#librarySettingsDialog');
  const values = librarySettingsValues(library);
  librarySettingsContext = { id, values };
  applicationShell.config.$('#librarySettingsForm').reset();
  applicationShell.config.$('#librarySettingsError').textContent = '';
  applicationShell.config.$('#libraryEditName').removeAttribute('aria-invalid');
  applicationShell.config.$('#libraryEditName').value = values.name;
  applicationShell.config.$('#libraryEditDescription').value = values.description;
  // Keep longer descriptions from older backups intact when editing other fields.
  applicationShell.config.$('#libraryEditDescription').maxLength = Math.max(120, values.description.length);
  applicationShell.config.$('#libraryDescriptionCount').textContent = `${values.description.length}/${applicationShell.config.$('#libraryEditDescription').maxLength}`;
  const types = applicationShell.config.$('#libraryEditType');
  types.querySelector('[data-legacy-library-type]')?.remove();
  if (![...types.options].some(option => option.value === values.type)) {
    const option = new Option(values.type, values.type); option.dataset.legacyLibraryType = ''; types.add(option);
  }
  types.value = values.type;
  const languages = ['', '中文', '英语', '日语', '韩语', '法语', '德语', '西班牙语', 'JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift', 'SQL', 'Shell'];
  if (!languages.includes(values.language)) languages.push(values.language);
  applicationShell.config.$('#libraryEditLanguage').replaceChildren(...languages.map(value => new Option(value || '不设置', value)));
  applicationShell.config.$('#libraryEditLanguage').value = values.language;
  applicationShell.config.$('#libraryEditMore').open = Boolean(values.language);
  dialog.showModal();
  applicationShell.config.$('#libraryEditName').focus({ preventScroll: true });
}

function bindLibrarySettings() {
  const dialog = applicationShell.config.$('#librarySettingsDialog'), form = applicationShell.config.$('#librarySettingsForm');
  const clearError = () => { applicationShell.config.$('#librarySettingsError').textContent = ''; applicationShell.config.$('#libraryEditName').removeAttribute('aria-invalid'); };
  form.addEventListener('input', clearError);
  form.addEventListener('change', clearError);
  applicationShell.config.$('#libraryEditDescription').addEventListener('input', event => {
    applicationShell.config.$('#libraryDescriptionCount').textContent = `${event.target.value.length}/${event.target.maxLength}`;
  });
  dialog.querySelectorAll('[data-library-settings-close]').forEach(button => {
    button.onclick = () => { if (!librarySettingsSaving) dialog.close(); };
  });
  dialog.addEventListener('cancel', event => { if (librarySettingsSaving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    const id = librarySettingsContext?.id;
    librarySettingsContext = null;
    const trigger = applicationShell.state.knowledge.selectedLibraryId === id && !selectedNoteTagId && !applicationShell.state.editor.editingMarkdownDocumentId
      ? applicationShell.config.$('.note-directory-header-actions [data-note-directory-menu="library"]')
      : [...applicationShell.config.$$('[data-tree-library]')].find(button => button.dataset.treeLibrary === id);
    if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
  });
  form.onsubmit = async event => {
    event.preventDefault();
    if (librarySettingsSaving || !librarySettingsContext) return;
    clearError();
    const { id, values } = librarySettingsContext;
    const library = application.state.knowledge.libraryById(id);
    if (!library) { applicationShell.config.$('#librarySettingsError').textContent = '知识库已不存在，请关闭后刷新。'; return; }
    if (JSON.stringify(values) !== JSON.stringify(librarySettingsValues(library))) {
      applicationShell.config.$('#librarySettingsError').textContent = '知识库信息已在其他窗口更新，请重新打开后编辑。'; return;
    }
    const requestedName = applicationShell.config.$('#libraryEditName').value.trim();
    if (!requestedName) {
      applicationShell.config.$('#librarySettingsError').textContent = '请输入知识库名称。';
      applicationShell.config.$('#libraryEditName').setAttribute('aria-invalid', 'true'); applicationShell.config.$('#libraryEditName').focus(); return;
    }
    const name = requestedName === library.name ? requestedName : application.domain.nextAvailableName(requestedName,
      application.state.knowledge.libraries.filter(item => item.id !== id && (item.parentId || null) === (library.parentId || null)).map(item => item.name), 80);
    const next = { name, description: applicationShell.config.$('#libraryEditDescription').value.trim(), type: applicationShell.config.$('#libraryEditType').value, language: applicationShell.config.$('#libraryEditLanguage').value };
    if (JSON.stringify(next) === JSON.stringify(values)) { dialog.close(); return; }
    librarySettingsSaving = true;
    const busy = value => {
      form.setAttribute('aria-busy', String(value));
      form.querySelector('fieldset').disabled = value;
      dialog.querySelectorAll('[data-library-settings-close], #librarySettingsSave').forEach(button => { button.disabled = value; });
      applicationShell.config.$('#librarySettingsSave').textContent = value ? '保存中…' : '保存';
    };
    busy(true);
    try {
      await application.operations.knowledge.updateLibrary(library, next);
    } catch (error) {
      applicationShell.config.$('#librarySettingsError').textContent = `保存失败：${error.message || '请稍后重试'}`;
      return;
    } finally { librarySettingsSaving = false; busy(false); }
    applicationShell.actions.renderAll(Boolean(applicationShell.state.editor.editingMarkdownDocumentId));
    dialog.close();
    applicationShell.actions.showToast(name === requestedName ? '知识库信息已保存' : `名称重复，已保存为“${name}”`);
  };
}
