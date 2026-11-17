const { contextBridge, ipcRenderer, webUtils } = require('electron');
let lastReadData;

const editionServices = {};
/* edition:services */

contextBridge.exposeInMainWorld('memoKeepDesktop', {
  ...editionServices,
  read: async () => {
    const data = await ipcRenderer.invoke('data:read');
    lastReadData = data;
    return data;
  },
  readLinkPreview: url => ipcRenderer.invoke('link:preview', url),
  readHomeSummary: () => ipcRenderer.invoke('data:home-summary'),
  readChanges: token => ipcRenderer.invoke('data:read-changes', token),
  writeChanges: (patch, token) => ipcRenderer.invoke('data:write-changes', patch, token),
  readEditingPreferences: () => ipcRenderer.invoke('data:editing-preferences'),
  readPetSummary: () => ipcRenderer.invoke('data:pet-summary'),
  getLocalDataPath: () => ipcRenderer.invoke('storage:get-local-data-path'),
  write: async (data, base = lastReadData) => {
    const saved = await ipcRenderer.invoke('data:write', data, base);
    lastReadData = saved;
    return saved;
  },
  saveFileToDirectory: payload => ipcRenderer.invoke('file:save-to-directory', payload),
  getPathForFile: file => webUtils.getPathForFile(file),
  chooseNoteImage: () => ipcRenderer.invoke('note-image:choose'),
  saveNoteImage: payload => ipcRenderer.invoke('note-image:save', payload),
  readNoteImage: id => ipcRenderer.invoke('note-image:read', id),
  deleteNoteImage: id => ipcRenderer.invoke('note-image:delete', id),
  copyImageToClipboard: bytes => ipcRenderer.invoke('clipboard:write-image', bytes),
  exportBackup: data => ipcRenderer.invoke('backup:export', data),
  backupPreviewSupported: true,
  importBackup: options => ipcRenderer.invoke('backup:import', options),
  exportNotes: target => ipcRenderer.invoke('notes:export', target),
  exportCards: cards => ipcRenderer.invoke('cards:export', cards),
  hidePet: () => ipcRenderer.invoke('pet:hide'),
  showPet: () => ipcRenderer.invoke('pet:show'),
  showPetContextMenu: () => ipcRenderer.invoke('pet:context-menu'),
  getPetPosition: () => ipcRenderer.invoke('pet:get-position'),
  setPetPosition: position => ipcRenderer.invoke('pet:set-position', position),
  openApp: view => ipcRenderer.invoke('app:open', view),
  startReview: () => ipcRenderer.invoke('app:review'),
  closeReview: () => ipcRenderer.invoke('review:close'),
  setReviewSourceOpen: open => ipcRenderer.invoke('review:source-open', Boolean(open)),
  notify: message => ipcRenderer.invoke('notify', message),
  onDataChanged: callback => ipcRenderer.on('data:changed', callback),
  onReviewStart: callback => ipcRenderer.on('review:start', callback),
  takeOpenedNoteFiles: () => ipcRenderer.invoke('note-file:take'),
  onNoteFilesOpened: callback => ipcRenderer.on('note-file:opened', () => callback()),
  onReviewReload: callback => ipcRenderer.on('review:reload', callback),
  onNavigateToView: callback => ipcRenderer.on('navigate:view', (_, view) => callback(view)),
  onRequestClose: callback => ipcRenderer.on('app:request-close', (_, quitting) => callback(quitting)),
  confirmClose: quitting => ipcRenderer.invoke('app:confirm-close', quitting),
  cancelClose: () => ipcRenderer.invoke('app:cancel-close'),
  speech: {
    available: () => ipcRenderer.invoke('speech:available'),
    start: (id, terms, options) => ipcRenderer.invoke('speech:start', id, terms, options),
    status: locale => ipcRenderer.invoke('speech:status', locale),
    stop: () => ipcRenderer.invoke('speech:stop'),
    cancel: () => ipcRenderer.invoke('speech:cancel'),
    openSettings: code => ipcRenderer.invoke('speech:open-settings', code),
    onEvent: callback => { const listener = (_, event) => callback(event); ipcRenderer.on('speech:event', listener); return () => ipcRenderer.removeListener('speech:event', listener); },
    ...editionServices.speech
  },
  pomodoro: {
    get: () => ipcRenderer.invoke('pomodoro:get'),
    command: (type, payload) => ipcRenderer.invoke('pomodoro:command', type, payload),
    openPanel: () => ipcRenderer.invoke('pomodoro:open-panel'),
    openApp: () => ipcRenderer.invoke('pomodoro:show-app'),
    getFloatPosition: () => ipcRenderer.invoke('pomodoro:float-position'),
    moveFloat: (position, done) => ipcRenderer.invoke('pomodoro:float-move', position, Boolean(done)),
    onState: callback => { const listener = (_, payload) => callback(payload); ipcRenderer.on('pomodoro:state', listener); return () => ipcRenderer.removeListener('pomodoro:state', listener); },
    onOpenPanel: callback => ipcRenderer.on('pomodoro:open-panel', () => callback()),
  },
  platform: process.platform
});
