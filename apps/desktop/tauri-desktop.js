import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import StateMerge from '../../web/state-merge.js';
import Search from '../../web/domain/content-search.js';

const { mergeWindowData, applyDataPatch, createDataPatch } = StateMerge;
const scope = 'desktop';
const readSnapshot = async () => { await prepareRecords(); return invoke('plugin:memokeep-workspace|read', { scope }); };
const readFields = fields => invoke('plugin:memokeep-workspace|read_fields', { fields });
const bridgeError = error => error instanceof Error ? error : new Error(error?.message || String(error));
let updatingIndex;
let recordPreparation;
async function prepareRecords() {
  return recordPreparation ??= (async () => {
    const status = await invoke('plugin:memokeep-workspace|record_status');
    if (!status || typeof status.enabled !== 'boolean') return false;
    if (!status.enabled && status.isolated && getCurrentWindow().label === 'main') {
      await invoke('plugin:memokeep-workspace|activate_records', { expectedRevision: status.revision, confirm: true });
      return true;
    }
    return status.enabled;
  })().catch(error => { recordPreparation = undefined; throw bridgeError(error); });
}

async function writeRecordChanges(patch, token, context) {
  const notes = patch.fields.filter(field => field.kind === 'entities' && ['documents', 'cardDocuments'].includes(field.key));
  if (!notes.length || notes.some(field => field.beforeOrder || field.afterOrder) || patch.reviewBaseline || !await prepareRecords()) return null;
  const ordinary = patch.fields.filter(field => !notes.includes(field));
  for (let attempt = 0; attempt < 3; attempt++) {
    const requests = notes.map(field => ({ field: field.key, changes: field.changes.map(row => ({ id: row.id, value: null })) }));
    const selected = await invoke('plugin:memokeep-workspace|read_records', { requests });
    const other = ordinary.length ? await readFields(ordinary.map(field => field.key)) : null;
    if (other && other.revision !== selected.revision) continue;
    const data = { ...selected.data, ...other?.data }, merged = applyDataPatch(data, patch);
    const records = notes.map(field => ({ field: field.key, changes: field.changes.map(row => ({ id: row.id, value: merged[field.key]?.find(value => value.id === row.id) || null })) }));
    const updated = Object.fromEntries(ordinary.filter(field => Object.hasOwn(merged, field.key)).map(field => [field.key, merged[field.key]]));
    const removed = ordinary.filter(field => !Object.hasOwn(merged, field.key)).map(field => field.key);
    let saved;
    try { saved = await invoke('plugin:memokeep-workspace|write_records', { expectedRevision: selected.revision, records, updated, removed, ...(context ? { context } : {}) }); }
    catch (error) { if (error?.code === 'STALE_REVISION') continue; throw error; }
    const response = { fields: patch.fields.map(field => field.kind === 'entities'
      ? { ...field, changes: field.changes.map(row => ({ id: row.id, before: row.before, after: merged[field.key]?.find(value => value.id === row.id) })) }
      : { ...field, after: merged[field.key] }) };
    const refreshRequired = token !== selected.revision;
    return { patch: response, token: refreshRequired ? null : saved, refreshRequired };
  }
  throw new Error('其他窗口正在保存，请重试。');
}

async function searchContent(query) {
  const terms = Search.searchTerms(query);
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await invoke('plugin:memokeep-workspace|query_search', { terms });
    if (rows) return rows;
    updatingIndex ??= (async () => {
      const snapshot = await readSnapshot();
      try {
        await invoke('plugin:memokeep-workspace|index_search', {
          revision: snapshot.revision, entries: Search.indexContent(snapshot.data),
        });
      } catch (error) {
        if (error?.code !== 'STALE_REVISION') throw error;
      }
    })().finally(() => { updatingIndex = undefined; });
    await updatingIndex;
  }
  return Search.searchContent((await readSnapshot()).data, query);
}

async function imageCommand(name, args) {
  try { return await invoke(`plugin:memokeep-workspace|${name}`, args); }
  catch (error) { throw bridgeError(error); }
}

async function workspaceBackup(action, token) {
  try { return await invoke('plugin:memokeep-workspace|workspace_backup', { request: { action, token } }); }
  catch (error) { throw bridgeError(error); }
}

async function saveNoteImage({ bytes, name }) {
  const blob = new Blob([bytes]);
  if (blob.size > 25 * 1024 * 1024) throw new Error('图片不能超过 25 MB');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return imageCommand('save_image', { bytes: dataUrl.slice(dataUrl.indexOf(',') + 1), name: name || '' });
}

async function chooseNoteImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.hidden = true;
  document.body.append(input);
  try {
    const file = await new Promise(resolve => {
      input.addEventListener('change', () => resolve(input.files[0]), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
    return file ? await saveNoteImage({ bytes: file, name: file.name }) : null;
  } finally {
    input.remove();
  }
}

async function save(data, base, context) {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await readSnapshot();
      const merged = mergeWindowData(base ?? snapshot.data, data, snapshot.data);
      try {
        await invoke('plugin:memokeep-workspace|write', { scope, expectedRevision: snapshot.revision, data: merged, ...(context ? { context } : {}) });
        return merged;
      } catch (error) {
        if (error?.code !== 'STALE_REVISION') throw error;
      }
    }
    throw new Error('其他窗口正在保存，请重试。');
  } catch (error) {
    throw bridgeError(error);
  }
}

async function readChanges(token) {
  try {
    if (token != null && (await readFields([])).revision === token) return { patch: { fields: [] }, token };
    const { data, revision } = await readSnapshot();
    return { data, token: revision };
  } catch (error) { throw bridgeError(error); }
}

async function writeChanges(patch, token, context) {
  const keys = patch.fields.map(field => field.key);
  const fields = patch.reviewBaseline ? [...new Set([...keys, 'reviewRecords'])] : keys;
  try {
    const records = await writeRecordChanges(patch, token, context);
    if (records) return records;
    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = token == null ? null : await readFields(fields);
      const matches = selected !== null && selected.revision === token;
      const { data, revision } = matches ? selected : await readSnapshot();
      const merged = applyDataPatch(data, patch);
      const response = matches ? { patch: createDataPatch(data, merged) } : { data: merged };
      const removed = keys.filter(key => !Object.hasOwn(merged, key));
      const updated = Object.fromEntries(keys.filter(key => Object.hasOwn(merged, key)).map(key => [key, merged[key]]));
      let saved;
      try {
        saved = await invoke('plugin:memokeep-workspace|write_fields', { expectedRevision: revision, updated, removed, ...(context ? { context } : {}) });
      } catch (error) {
        if (error?.code === 'STALE_REVISION') continue;
        throw error;
      }
      return { ...response, token: saved };
    }
    throw new Error('其他窗口正在保存，请重试。');
  } catch (error) { throw bridgeError(error); }
}

function subscribe(callback) {
  let disposed = false;
  const registration = listen('workspace-changed', () => { if (!disposed) callback(); });
  registration.catch(console.error);
  return () => {
    if (disposed) return;
    disposed = true;
    void registration.then(dispose => dispose(), console.error);
  };
}

const speechCommand = (name, args) => invoke(`plugin:memokeep-workspace|speech_${name}`, args)
  .catch(error => { throw bridgeError(error); });
const speechListeners = new Set();
let speechRegistration;
const registerSpeechEvents = () => speechRegistration ??= listen('workspace-speech', ({ payload }) => {
  for (const callback of speechListeners) callback(payload);
}).catch(error => { speechRegistration = undefined; throw error; });
const speechControl = action => speechCommand('control', { action });

function desktopEvent(name, callback) {
  let released = false;
  const registration = listen(name, ({ payload }) => { if (!released) callback(payload); });
  registration.catch(console.error);
  return () => {
    if (released) return;
    released = true;
    void registration.then(dispose => dispose(), console.error);
  };
}

const pomodoroCommand = (name, args) => invoke(`plugin:memokeep-workspace|pomodoro_${name}`, args)
  .catch(error => { throw bridgeError(error); });

const openedFileListeners = new Set();
let openedFileRegistration;
function watchOpenedFiles() {
  return openedFileRegistration ??= listen('workspace-files', () => {
    for (const callback of openedFileListeners) callback();
  }).catch(error => { openedFileRegistration = undefined; throw bridgeError(error); });
}
const fileCommand = (name, args) => invoke(`plugin:memokeep-workspace|files_${name}`, args)
  .catch(error => { throw bridgeError(error); });

window.memoKeepDesktop = {
  platform: 'darwin',
  nativeDocumentDrop: /^Mac/.test(globalThis.navigator?.platform || '') && !(globalThis.navigator?.maxTouchPoints > 1),
  read: async () => {
    try { return (await readSnapshot()).data; }
    catch (error) { throw bridgeError(error); }
  },
  write: save,
  readChanges,
  writeChanges,
  recordStorageStatus: () => invoke('plugin:memokeep-workspace|record_status'),
  async activateRecordStorage({ confirm = false } = {}) {
    if (!confirm) throw new Error('请先确认记录存储升级；原数据未修改。');
    const status = await invoke('plugin:memokeep-workspace|record_status');
    await invoke('plugin:memokeep-workspace|activate_records', { expectedRevision: status.revision, confirm: true });
    recordPreparation = Promise.resolve(true);
    return invoke('plugin:memokeep-workspace|record_status');
  },
  listNoteSummaries: async (collection = 'documents', offset = 0, limit = 50) => await prepareRecords()
    ? invoke('plugin:memokeep-workspace|note_summaries', { collection, offset, limit }) : null,
  async readNoteRecord(collection, id, knownRevision = null) {
    if (!await prepareRecords()) return null;
    if (knownRevision != null) {
      const current = await readFields([]);
      // The caller keeps its own token invalidation if another window commits after this check.
      if (current.revision === knownRevision) return { unchanged: true, revision: current.revision };
    }
    const result = await invoke('plugin:memokeep-workspace|read_records', { requests: [{ field: collection, changes: [{ id, value: null }] }] });
    return { revision: result.revision, record: result.data[collection]?.[0] || null };
  },
  searchContent,
  readLinkPreview: (url, options = {}) => invoke('plugin:memokeep-workspace|read_link_preview', { url, refresh: options.refresh === true })
    .catch(error => ({ error: error?.message || String(error) })),
  readLinkPreviewImage: url => invoke('plugin:memokeep-workspace|read_link_preview_image', { url })
    .catch(error => ({ error: error?.message || String(error) })),
  async takeOpenedNoteFiles() {
    // Subscribe before the readiness/drain call; the SQLite queue survives earlier events.
    await watchOpenedFiles();
    return fileCommand('pending');
  },
  onNoteFilesOpened(callback) {
    openedFileListeners.add(callback);
    void watchOpenedFiles().catch(console.error);
    return () => openedFileListeners.delete(callback);
  },
  acknowledgeOpenedNoteFile: id => fileCommand('ack', { id }),
  releaseOpenedNoteFile: token => fileCommand('revoke', { token }),
  saveFileToDirectory: ({ token, fileName, content }) => fileCommand('save', { token, fileName, content }),
  onNativeFileDrag: callback => desktopEvent('workspace-file-drag', callback),
  onNativeFileError: callback => desktopEvent('workspace-file-error', callback),
  backupPreviewSupported: true,
  exportBackup: () => workspaceBackup('export'),
  exportModuleJson: () => workspaceBackup('exportModules'),
  markdownPublishing: true,
  getMarkdownPublishStatus: () => invoke('plugin:memokeep-workspace|publishing_status'),
  chooseKnowledgeStorageFolder: () => invoke('plugin:memokeep-workspace|choose_publish_directory'),
  importBackup: options => {
    if (options.apply) return workspaceBackup('apply', options.apply);
    if (options.cancel) return workspaceBackup('cancel', options.cancel);
    if (options.undo) return workspaceBackup('undo');
    if (options.status) return workspaceBackup('status');
    return workspaceBackup('preview');
  },
  onDataChanged: subscribe,
  getLocalDataPath: () => invoke('plugin:memokeep-workspace|data_path'),
  notify: input => invoke('plugin:memokeep-workspace|desktop_notify', {
    notification: typeof input === 'string' ? { title: 'MemoKeep', body: input } : input,
  }).catch(error => { console.warn('系统通知未发送', error); return false; }),
  openApp: () => invoke('plugin:memokeep-workspace|open_app').catch(error => { throw bridgeError(error); }),
  onRequestClose(callback) {
    return getCurrentWindow().onCloseRequested(event => {
      event.preventDefault();
      return callback(false);
    }).catch(console.error);
  },
  confirmClose: () => getCurrentWindow().destroy(),
  setNoteWindowTitle: title => getCurrentWindow().setTitle(title),
  reminders: {
    check: activeReceipt => invoke('plugin:memokeep-workspace|reminders_check', { activeReceipt: activeReceipt || null }).catch(error => { throw bridgeError(error); }),
    acknowledge: receipt => invoke('plugin:memokeep-workspace|reminders_ack', { receipt }).catch(error => { throw bridgeError(error); }),
    onDue: callback => desktopEvent('workspace-reminders', callback),
  },
  pomodoro: {
    get: () => pomodoroCommand('get'),
    command: (command, payload = {}) => pomodoroCommand('command', { command, payload }),
    onState: callback => desktopEvent('workspace-pomodoro', callback),
    onOpenPanel: callback => desktopEvent('workspace-pomodoro-open', callback),
  },
  speech: {
    available: () => speechCommand('available').catch(() => false),
    status: (language = 'zh-CN') => speechCommand('status', { language }).catch(() => ({ supported: false })),
    async start(id, terms = [], options = {}) {
      await registerSpeechEvents();
      return speechCommand('start', { id, terms, options });
    },
    stop: () => speechControl('stop'),
    cancel: () => speechControl('cancel'),
    openSettings: code => speechCommand('settings', { code }),
    onEvent(callback) {
      speechListeners.add(callback);
      return () => speechListeners.delete(callback);
    },
  },
  saveNoteImage,
  chooseNoteImage,
  readNoteImage: id => imageCommand('read_image', { id }),
  deleteNoteImage: id => imageCommand('delete_image', { id }),
};
