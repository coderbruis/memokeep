const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const appIconPath = path.join(__dirname, '..', 'web', 'assets', 'app-icon.png');
const { createPortableBackup, validatePortableBackup, installBackupMedia } = require('./backup.cjs');
const { randomUUID } = require('node:crypto');
const { createPomodoroService } = require('./pomodoro.cjs');
const { createSpeechService: createBaseSpeechService } = require('./speech.cjs');
const Pomodoro = require('../web/domain/pomodoro.js');
const Plans = require('../web/domain/plans.js');
const { deleteNoteImage, readNoteImage, saveNoteImage } = require('./note-images.cjs');
const { exportDocumentContent } = require('./document-export.cjs');
const { mergeWindowData, createDataPatch, applyDataPatch, stateValuesEqual } = require('../web/state-merge.js');
const directoryTree = require('../web/directory-tree.js');
const { dataImageIds } = require('../web/domain/image-references.js');
const { engagementSummary: buildCompanionSummary } = require('../web/domain/engagement.js');
const { fetchLinkPreview } = require('./link-preview.cjs');
const { safeFileName, knowledgeDocumentExtension } = require('../modules/content/export-paths.cjs');
const { createWorkspace, createFolderPublisher, installScreenshotCapture, installServices, platform: editionPlatform = {}, createSpeechService: createEditionSpeechService,
  features: installedFeatures, productName: editionName } = require('../modules/editions/current/main.cjs');
if (editionName) {
  const usesDefaultProfile = app.getPath('userData') === path.join(app.getPath('appData'), app.getName());
  app.setName(editionName);
  if (usesDefaultProfile) app.setPath('userData', path.join(app.getPath('appData'), editionName));
}
// 同一份数据只允许一个实例：两个进程（例如安装版和开发版）各自在内存里持有数据，
// 会互相用旧数据覆盖对方的保存。锁按 userData 目录区分，所以要在设置 userData 之后申请。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv = [], cwd = '') => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  openFiles.addFromArgv(argv.slice(1), cwd);
});
const { createRuntime } = require('../modules/core/runtime.js');
const PluginState = require('../modules/core/plugins.js');
const plugins = require('../modules/editions/current/plugins.js');
const featurePlatform = { captureScreenshot: installScreenshotCapture, openNoteWindow: createWorkspace, publishFolder: createFolderPublisher, ...editionPlatform };
const editionRuntime = createRuntime({ features: installedFeatures, platform: featurePlatform });
const featureRuntime = createRuntime({ features: installedFeatures, platform: featurePlatform,
  hasEntitlement: id => PluginState.isEnabled(dataCache?.data.settings, plugins, id) });

let mainWindow;
let allowMainWindowClose = false;
let petWindow;
let reviewWindow;
const approvedWindowCloses = new Set();
let dataWriteQueue = Promise.resolve();
// 用 MemoKeep 打开 .md / .txt（design/prototype/open-with-20261113.md）。macOS 可能在窗口建好之前就发来 open-file，所以先排队。
const openFiles = require('./open-files.cjs').createOpenFiles({
  fs: require('node:fs/promises'), path,
  storageRoot: async () => noteImageRoot(await readCachedData()),
  notify: () => {
    if (!canSendToWindow(mainWindow)) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
    mainWindow.webContents.send('note-file:opened');
  }
});
app.on('open-file', (event, filePath) => { event.preventDefault(); openFiles.add(filePath); });
// Windows / Linux：文件路径在启动参数里。
if (process.platform !== 'darwin' && app.isPackaged) openFiles.addFromArgv(process.argv.slice(1));
const cleanedImageIds = new Set();
let dataCache = null, dataReadPending = null, dataCacheGeneration = 0;
const windowDataSnapshots = new Map();
let nextSnapshotToken = 0;
let isQuitting = false;
const workspace = createWorkspace?.({ BrowserWindow, appIconPath,
  preloadPath: path.join(__dirname, 'preload.cjs'), pagePath: path.join(__dirname, '..', 'web', 'index.html'),
  waitForWrites: () => dataWriteQueue, readData, approvedWindowCloses, canSendToWindow, isQuitting: () => isQuitting });
const noteWindows = workspace?.windows || new Set();
const folderPublisher = createFolderPublisher?.({ getLegacyImageRoot: () => app.getPath('userData') });
let petMoveTimer;
let pomodoro = null;
let speech = null;
let disposeEditionServices;
let petPositionWrite = Promise.resolve();
const petMenuIconCache = new Map();

function getPetWindowBounds(workArea, position) {
  // Electron work areas use logical pixels; Retina scaling must not enlarge the pet.
  const petWidth = Math.round(Math.max(140, Math.min(190, workArea.width * 0.12, workArea.height * 0.2)));
  // Match pet-scale.css: 32px on either side, 96px above and 14px below the cat.
  const width = Math.min(workArea.width, petWidth + 64);
  const height = Math.min(workArea.height, Math.ceil(petWidth * 760 / 1254) + 110);
  const x = position?.x ?? workArea.x + workArea.width - width - 12;
  const y = position?.y ?? workArea.y + workArea.height - height - 12;
  return {
    width,
    height,
    x: Math.max(workArea.x, Math.min(Math.round(x), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(y), workArea.y + workArea.height - height))
  };
}

function fitPetToDisplay() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const size = getPetWindowBounds(workArea);
  // Keep the cat's bottom-right corner steady when its display size changes.
  const next = getPetWindowBounds(workArea, {
    x: bounds.x + bounds.width - size.width,
    y: bounds.y + bounds.height - size.height
  });
  if (Object.keys(next).some(key => next[key] !== bounds[key])) {
    petWindow.setBounds(next, false);
  }
}

function canSendToWindow(window) {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
}

function petMenuIcon(name) {
  if (petMenuIconCache.has(name)) return petMenuIconCache.get(name);
  const image = nativeImage.createFromPath(path.join(
    __dirname,
    '..',
    'web',
    'assets',
    'icons',
    `pet-menu-${name}.png`
  ));
  if (image.isEmpty()) return undefined;
  if (process.platform === 'darwin') image.setTemplateImage(true);
  petMenuIconCache.set(name, image);
  return image;
}

const defaultData = {
  version: 2,
  knowledgeBases: [],
  noteTags: [],
  documents: [],
  items: [],
  cards: [],
  reviewRecords: [],
  memos: [],
  plans: [],
  focusSessions: [],
  freeReviews: [],
  streak: { count: 0, lastDay: '' },
  settings: {
    reminderMinutes: 30,
    petEnabled: true,
    notificationsEnabled: true,
    activeHoursStart: '08:00',
    activeHoursEnd: '22:00',
    petPosition: null,
    knowledgeStoragePath: '',
    cloudSyncEnabled: true
  }
};

const dataPath = () => path.join(app.getPath('userData'), 'memokeep-data.json');

async function writeFileAtomically(target, content, suffix) {
  const temporary = `${target}.tmp-${process.pid}-${suffix}`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function syncKnowledgeDocuments(data) {
  if (!editionRuntime.available('folder.publish') || !PluginState.isEnabled(data.settings, plugins, 'folder.publish')) return { root: null, filesWritten: 0 };
  return folderPublisher.publish(data);
}

async function chooseKnowledgeStorageFolder(_, currentPath) {
  await readCachedData();
  if (!featureRuntime.available('folder.publish')) throw new Error('当前目录输出功能不可用');
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择知识文档存储位置', defaultPath: currentPath || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

function noteImageRoot(data) {
  // Disabling exports must not move the attachment store or hide existing images.
  return editionRuntime.available('folder.publish') && data.settings.knowledgeStoragePath
    ? path.resolve(data.settings.knowledgeStoragePath)
    : app.getPath('userData');
}

async function configuredNoteImageRoot() {
  return noteImageRoot(await readData());
}

// 只被历史版本用到的图片放在应用自己的目录里（不在用户能看到的图片文件夹里），恢复那个版本时再搬回去。
const VERSION_IMAGE_DIRECTORY = 'version-images';
async function readStoredNoteImage(data, id) {
  return await readNoteImage(noteImageRoot(data), id)
    || await readNoteImage(app.getPath('userData'), id, { directoryName: VERSION_IMAGE_DIRECTORY })
    || readNoteImage(app.getPath('userData'), id, { directoryName: 'note-images' });
}

// 正在使用的图片：正文、富文本、卡片、备忘录、回收站……只是不算未删除笔记的历史版本。
function liveImageIds(data) {
  const withoutVersions = document => ({ ...document, metadata: { ...(document.metadata || {}), versions: [] } });
  return dataImageIds({ ...data, documents: (data.documents || []).map(withoutVersions), cardDocuments: (data.cardDocuments || []).map(withoutVersions) });
}

async function moveImageFile(id, fromDirectory, toDirectory) {
  let entries;
  try { entries = await fs.readdir(fromDirectory); } catch { return false; }
  const fileName = entries.find(entry => entry.toLowerCase().startsWith(`${id}.`));
  if (!fileName) return false;
  await fs.mkdir(toDirectory, { recursive: true });
  const from = path.join(fromDirectory, fileName), to = path.join(toDirectory, fileName);
  try { await fs.rename(from, to); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(from, to); await fs.rm(from, { force: true });
  }
  return true;
}

// 删掉图片后：如果只剩历史版本还用它，就把文件从图片文件夹挪进应用目录；恢复版本又用上时挪回来。
function relocateNoteImages(archive, restore) {
  return enqueueDataWrite(async () => {
    const data = await readCachedData(), live = new Set(liveImageIds(data)), all = new Set(dataImageIds(data));
    const visible = path.join(noteImageRoot(data), 'images'), hidden = path.join(app.getPath('userData'), VERSION_IMAGE_DIRECTORY);
    for (const id of archive) if (all.has(id) && !live.has(id)) await moveImageFile(id, visible, hidden).catch(() => {});
    for (const id of restore) if (live.has(id)) await moveImageFile(id, hidden, visible).catch(() => {});
  });
}

function deleteUnreferencedNoteImage(id) {
  return enqueueDataWrite(async () => {
    id = String(id || '').toLowerCase();
    if (new Set(dataImageIds(await readCachedData())).has(id)) return false;
    const root = await configuredNoteImageRoot();
    // Remember attempted cleanup even if only one of the two locations is removed.
    cleanedImageIds.add(id);
    const deletedCurrent = await deleteNoteImage(root, id);
    const deletedLegacy = await deleteNoteImage(app.getPath('userData'), id, { directoryName: 'note-images' });
    const deletedVersion = await deleteNoteImage(app.getPath('userData'), id, { directoryName: VERSION_IMAGE_DIRECTORY });
    return deletedCurrent || deletedLegacy || deletedVersion;
  });
}

// 已经没有任何地方引用的图片文件（正文、富文本、最近 5 个历史版本、卡片、回收站都不再用到）。
// 启动时清一遍以前漏掉的；只动文件名是图片 ID 的文件，且至少 10 分钟前写入，避免误删刚插入、还没保存的图片。
const ORPHAN_IMAGE_MIN_AGE_MS = 10 * 60 * 1000;
function sweepOrphanNoteImages() {
  return enqueueDataWrite(async () => {
    const data = await readCachedData();
    const referenced = new Set(dataImageIds(data)), live = new Set(liveImageIds(data));
    const visible = path.join(noteImageRoot(data), 'images'), hidden = path.join(app.getPath('userData'), VERSION_IMAGE_DIRECTORY);
    // 以前留在图片文件夹里、只被历史版本用到的图，挪进应用目录。
    try {
      for (const entry of await fs.readdir(visible)) {
        const id = entry.split('.')[0].toLowerCase();
        if (referenced.has(id) && !live.has(id)) await moveImageFile(id, visible, hidden).catch(() => {});
      }
    } catch {}
    const directories = [
      visible,
      path.join(app.getPath('userData'), 'images'),
      path.join(app.getPath('userData'), 'note-images'),
      hidden
    ];
    let removed = 0;
    for (const directory of new Set(directories)) {
      let entries;
      try { entries = await fs.readdir(directory); } catch { continue; }
      for (const entry of entries) {
        const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpe?g|gif|webp)$/i.exec(entry)?.[1]?.toLowerCase();
        if (!id || referenced.has(id)) continue;
        const file = path.join(directory, entry);
        try {
          if (Date.now() - (await fs.stat(file)).mtimeMs < ORPHAN_IMAGE_MIN_AGE_MS) continue;
          await fs.rm(file, { force: true });
          cleanedImageIds.add(id);
          removed++;
        } catch {}
      }
    }
    return removed;
  });
}

async function chooseNoteImage() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '插入图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  return saveNoteImage(await configuredNoteImageRoot(), {
    bytes: await fs.readFile(filePath),
    name: path.basename(filePath)
  });
}

function normalizeData(input = {}) {
  return {
    ...defaultData,
    ...input,
    version: 2,
    knowledgeBases: Array.isArray(input.knowledgeBases) ? input.knowledgeBases : [],
    noteTags: Array.isArray(input.noteTags) ? input.noteTags : [],
    documents: Array.isArray(input.documents) ? input.documents : [],
    cardFolders: Array.isArray(input.cardFolders) ? input.cardFolders : [],
    cardNotebooks: Array.isArray(input.cardNotebooks) ? input.cardNotebooks : [],
    cardDocuments: Array.isArray(input.cardDocuments) ? input.cardDocuments : [],
    items: Array.isArray(input.items) ? input.items : [],
    cards: Array.isArray(input.cards) ? input.cards : [],
    reviewRecords: Array.isArray(input.reviewRecords) ? input.reviewRecords : [],
    memos: Array.isArray(input.memos) ? input.memos : [],
    plans: Array.isArray(input.plans) ? input.plans : [],
    focusSessions: Array.isArray(input.focusSessions) ? input.focusSessions : [],
    freeReviews: Array.isArray(input.freeReviews) ? input.freeReviews : [],
    streak: { ...defaultData.streak, ...(input.streak || {}) },
    settings: { ...defaultData.settings, ...(input.settings || {}) }
  };
}

const sameDataStat = (a, b) => a && b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
async function readCachedData() {
  if (dataReadPending) return dataReadPending;
  const generation = dataCacheGeneration;
  const pending = (async () => {
    const target = dataPath();
    let stat;
    try { stat = await fs.stat(target); }
    catch (error) { if (error.code === 'ENOENT') { dataCache = null; return normalizeData(); } throw error; }
    if (dataCache?.target === target && sameDataStat(dataCache.stat, stat)) return dataCache.data;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = normalizeData(JSON.parse(await fs.readFile(target, 'utf8')));
      const after = await fs.stat(target);
      if (generation !== dataCacheGeneration && dataCache?.target === target) return dataCache.data;
      if (sameDataStat(stat, after)) { dataCache = { target, stat: after, data }; return data; }
      stat = after;
    }
    throw new Error('数据文件正在被其他程序修改，请稍后重试');
  })();
  dataReadPending = pending;
  try { return await pending; }
  finally { if (dataReadPending === pending) dataReadPending = null; }
}
// Internal callers may edit their copy; cached snapshots stay immutable.
async function readData() { return structuredClone(await readCachedData()); }

function windowDataResponse(event, data, full = false, token) {
  const id = event.sender.id, before = windowDataSnapshots.get(id);
  if (!windowDataSnapshots.has(id)) event.sender.once('destroyed', () => windowDataSnapshots.delete(id));
  const nextToken = ++nextSnapshotToken;
  windowDataSnapshots.set(id, { data, token: nextToken });
  return !full && before && before.token === token
    ? { patch: createDataPatch(before.data, data), token: nextToken } : { data, token: nextToken };
}

let cachedHomeSummary;
function homeSummary(data) {
  const timestamp = Date.now();
  const day = new Date().toLocaleDateString('en-CA');
  const sources = [data.cards, data.reviewRecords, data.documents, data.cardDocuments, data.items, data.knowledgeBases, data.streak?.count, data.streak?.lastDay];
  if (cachedHomeSummary && cachedHomeSummary.summary.day === day && timestamp < cachedHomeSummary.summary.validUntil
    && sources.every((source, index) => source === cachedHomeSummary.sources[index])) return cachedHomeSummary.summary;
  const cards = data.cards || [];
  const due = cards.filter(card => card.status === 'active' && Number(card.dueAt) <= timestamp);
  const documents = new Map([...(data.documents || []), ...(data.cardDocuments || [])].map(doc => [doc.id, doc.title]));
  const items = new Map((data.items || []).map(item => [item.id, item.documentId]));
  const libraries = new Map((data.knowledgeBases || []).map(lib => [lib.id, lib.name]));
  const summary = {
    day, validUntil: cards.reduce((limit, card) => card.status === 'active' && Number(card.dueAt) > timestamp ? Math.min(limit, Number(card.dueAt)) : limit, timestamp + 86_400_000),
    dueCount: due.length, cardCount: cards.length,
    doneCount: (data.reviewRecords || []).filter(record => new Date(record.reviewedAt).toLocaleDateString('en-CA') === day).length,
    rememberedCount: cards.filter(card => Number(card.strength) >= 3).length,
    streakCount: Number(data.streak?.count || 0),
    upcoming: (due.length ? due.slice(0, 5) : cards.filter(card => card.status === 'active').sort((a, b) => a.dueAt - b.dueAt).slice(0, 5))
      .map(card => ({ question: card.question, dueAt: card.dueAt, source: documents.get(items.get(card.knowledgeItemId)) || libraries.get(card.knowledgeBaseId) || '手动创建' }))
  };
  cachedHomeSummary = { sources, summary };
  return summary;
}

let cachedPetSummary;
async function readPetSummary() {
  const data = await readCachedData(), { cards, settings } = data, timestamp = Date.now(), day = new Date(timestamp).toLocaleDateString('en-CA');
  if (cachedPetSummary?.cards === cards && cachedPetSummary.settings === settings && cachedPetSummary.day === day && timestamp < cachedPetSummary.summary.nextDueAt) return cachedPetSummary.summary;
  let dueCount = 0, nextDueAt = timestamp + 60_000;
  for (const card of cards) {
    if (card.status !== 'active') continue;
    if (card.dueAt <= timestamp) dueCount++;
    else if (Number.isFinite(Number(card.dueAt))) nextDueAt = Math.min(nextDueAt, Number(card.dueAt));
  }
  const summary = { dueCount, cardCount: cards.length, nextDueAt, growth: buildCompanionSummary(data, timestamp) };
  cachedPetSummary = { cards, settings, day, summary };
  return summary;
}

async function cacheHomeSummary(data, summary = homeSummary(data)) {
  const source = await fs.stat(dataPath());
  await fs.writeFile(`${dataPath()}.home.json`, JSON.stringify({ mtimeMs: source.mtimeMs, size: source.size, summary }), 'utf8');
  return summary;
}

async function readHomeSummary() {
  try {
    const [source, cached] = await Promise.all([fs.stat(dataPath()), fs.readFile(`${dataPath()}.home.json`, 'utf8').then(JSON.parse)]);
    if (cached.mtimeMs === source.mtimeMs && cached.size === source.size && cached.summary.day === new Date().toLocaleDateString('en-CA') && Date.now() < cached.summary.validUntil) return cached.summary;
  } catch { /* Missing/stale cache is rebuilt from authoritative data. */ }
  const data = await readCachedData();
  const summary = homeSummary(data);
  await cacheHomeSummary(data, summary).catch(() => {});
  return summary;
}

function enqueueDataWrite(work) {
  const pending = dataWriteQueue.then(work);
  dataWriteQueue = pending.catch(() => {});
  return pending;
}

function writeData(input, base, patch) {
  return enqueueDataWrite(() => persistData(input, base, patch));
}

async function persistData(input, base, patch) {
  const previous = await readCachedData();
  const data = normalizeData(patch ? applyDataPatch(previous, patch) : base ? mergeWindowData(normalizeData(base), normalizeData(input), previous) : input);
  const previousImages = new Set(dataImageIds(previous));
  for (const id of new Set(dataImageIds(data))) {
    if (!previousImages.has(id) && cleanedImageIds.has(id)
      && !await readStoredNoteImage(data, id)) {
      throw new Error('图片已被清理，请重新插入后再保存。');
    }
  }
  const target = dataPath();
  const temporary = `${target}.tmp`;
  if (!dataCache || !stateValuesEqual(previous, data)) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(data), 'utf8');
    await fs.rename(temporary, target);
    dataCache = { target, data, stat: await fs.stat(target) };
    dataCacheGeneration++;
    await cacheHomeSummary(data).catch(() => {});
    // 这次保存后不再被任何地方引用的图片（例如 Markdown 里删掉的图、滑出历史版本的图、清空回收站），把磁盘上的文件也删掉。
    // 排在写入队列后面执行，删之前会再核对一次最新数据。
    const stillReferenced = new Set(dataImageIds(data));
    for (const id of previousImages) {
      if (!stillReferenced.has(id)) deleteUnreferencedNoteImage(id).catch(() => {});
    }
    // 只剩历史版本在用的图：从用户的图片文件夹挪走；恢复版本后重新用上的图：挪回来。
    const previousLive = new Set(liveImageIds(previous)), nowLive = new Set(liveImageIds(data));
    const archive = [...previousLive].filter(id => !nowLive.has(id) && stillReferenced.has(id));
    const restore = [...nowLive].filter(id => !previousLive.has(id));
    if (archive.length || restore.length) relocateNoteImages(archive, restore).catch(() => {});
  }
  if (canSendToWindow(petWindow)) petWindow.webContents.send('data:changed');
  try {
    await syncKnowledgeDocuments(data);
  } catch (error) {
    console.error('Knowledge document sync failed:', error);
    throw new Error(`本地数据已保存，但笔记文档同步失败：${error.message}`);
  }
  return dataCache?.data || data;
}

let pendingBackupRestore = null, lastBackupRestore = null;
async function exportBackup(_, data) {
  const backup = await createPortableBackup(normalizeData(data), id => readStoredNoteImage(data, id));
  const result = await dialog.showSaveDialog(mainWindow, {title:'导出MemoKeep完整备份',defaultPath:`MemoKeep-backup-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON完整备份',extensions:['json']}]});
  if(result.canceled||!result.filePath)return null;
  await fs.writeFile(result.filePath,JSON.stringify(backup,null,2),'utf8');return result.filePath;
}
function applyBackupRestore(candidate, undo = false) {
  // Keep media replacement, data publication and recovery in the existing write queue.
  return enqueueDataWrite(async () => {
  const previous = await readData();
  if(undo && (!lastBackupRestore || !stateValuesEqual(previous,lastBackupRestore.applied)))throw new Error('恢复后已有新的修改，请先备份当前内容；不能直接覆盖撤销');
  const normalized=normalizeData(candidate.data);normalized.settings={...normalized.settings,knowledgeStoragePath:previous.settings.knowledgeStoragePath||''};
  const before = undo ? null : await createPortableBackup(previous,id=>readStoredNoteImage(previous,id));
  const rollbackMedia=await installBackupMedia(noteImageRoot(normalized),candidate.media);
  try{
    const restored=await persistData(normalized);
    if(undo)lastBackupRestore=null;else lastBackupRestore={snapshot:before,applied:structuredClone(restored)};
    return restored;
  }catch(error){
    const failures=[];
    try{await rollbackMedia()}catch(rollbackError){failures.push(`图片：${rollbackError.message}`)}
    try{await persistData(previous)}catch(rollbackError){failures.push(`数据：${rollbackError.message}`)}
    if(failures.length)throw new Error(`恢复失败且回退未完成：${failures.join('；')}`);
    throw error;
  }
  });
}
function notifyBackupRestored(event) {
  if(event?.sender)windowDataSnapshots.delete(event.sender.id);
  for(const window of [mainWindow,...noteWindows]) {
    if(canSendToWindow(window)&&event?.sender!==window.webContents)window.webContents.send('data:changed');
  }
}
async function importBackup(event, options = {}) {
  if(options.status){await dataWriteQueue;return {canUndo:Boolean(lastBackupRestore&&stateValuesEqual(await readData(),lastBackupRestore.applied))};}
  if(options.cancel){if(pendingBackupRestore?.token===options.cancel)pendingBackupRestore=null;return null;}
  if(options.undo){if(!lastBackupRestore)throw new Error('没有可撤销的恢复');const restored=await applyBackupRestore(validatePortableBackup(lastBackupRestore.snapshot),true);notifyBackupRestored(event);return restored;}
  if(options.apply){
    const pending=pendingBackupRestore;
    if(!pending||pending.token!==options.apply||Date.now()-pending.at>15*60_000)throw new Error('备份预览已过期，请重新选择文件');
    if(pending.applying)throw new Error('正在恢复备份，请等待完成');
    pending.applying=true;
    try{const restored=await applyBackupRestore(pending.candidate);if(pendingBackupRestore===pending)pendingBackupRestore=null;notifyBackupRestored(event);return restored;}
    finally{pending.applying=false;}
  }
  const result=await dialog.showOpenDialog(mainWindow,{title:'选择MemoKeep备份',properties:['openFile'],filters:[{name:'JSON备份',extensions:['json']}]});
  if(result.canceled||!result.filePaths[0])return null;
  const stat=await fs.stat(result.filePaths[0]);if(stat.size>700*1024*1024)throw new Error('备份文件超过700MB，请拆分后恢复');
  const candidate=validatePortableBackup(JSON.parse(await fs.readFile(result.filePaths[0],'utf8')));
  if(options.preview){const token=randomUUID();pendingBackupRestore={token,candidate,at:Date.now()};return{preview:true,token,name:path.basename(result.filePaths[0]),summary:candidate.summary,legacy:candidate.legacy}}
  const restored=await applyBackupRestore(candidate);notifyBackupRestored(event);return restored;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function exportCards(_, cards) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出记忆卡片',
    defaultPath: `MemoKeep-cards-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return null;
  const rows = [['问题', '答案', '标签', '下次复习时间'], ...cards.map(card => [card.question, card.answer, (card.tags || []).join('|'), new Date(card.dueAt).toISOString()])];
  await fs.writeFile(result.filePath, `\uFEFF${rows.map(row => row.map(csvEscape).join(',')).join('\n')}`, 'utf8');
  return result.filePath;
}

// Allocate names atomically: preserve the title and number only real collisions.
async function createNamedExportEntry(parent, title, extension = null, content = '') {
  for (let number = 1; ; number++) {
    const name = `${title}${number === 1 ? '' : ` (${number})`}${extension || ''}`;
    const target = path.join(parent, name);
    try {
      if (extension === null) await fs.mkdir(target);
      else await fs.writeFile(target, content, { flag: 'wx' });
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EISDIR') throw error;
    }
  }
}

async function exportKnowledgeNotes(event, target = {}) {
    await dataWriteQueue;
    const current = await readData();
    const library = target.type === 'library' && current.knowledgeBases.find(item => item.id === target.id);
    const documents = target.type === 'document'
      ? current.documents.filter(item => item.id === target.id)
      : library ? current.documents.filter(item => directoryTree.ancestors(current.knowledgeBases, item.knowledgeBaseId).some(parent => parent.id === library.id)) : [];
    if (!documents.length) throw new Error('没有可导出的笔记。');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const selected = await dialog.showOpenDialog(owner, {
      title: '选择笔记导出位置', defaultPath: path.join(app.getPath('documents'), 'codex_tmp_dir'),
      properties: ['openDirectory', 'createDirectory'], buttonLabel: '导出到这里'
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const title = safeFileName(library ? library.name : documents[0].title, '知识库笔记').slice(0, 80);
    const root = await createNamedExportEntry(selected.filePaths[0], title);
    try {
      const sourceImageRoot = await configuredNoteImageRoot();
      await fs.mkdir(path.join(root, 'images'));
      const exportedFolders = new Map();
      for (const document of documents) {
        const parents = library ? directoryTree.ancestors(current.knowledgeBases, document.knowledgeBaseId) : [];
        const start = parents.findIndex(parent => parent.id === library?.id);
        let directory = root;
        for (const parent of start >= 0 ? parents.slice(start + 1) : []) {
          if (!exportedFolders.has(parent.id)) {
            exportedFolders.set(parent.id, await createNamedExportEntry(directory, safeFileName(parent.name, '目录').slice(0, 60)));
          }
          directory = exportedFolders.get(parent.id);
        }
        const name = safeFileName(document.title, '未命名笔记').slice(0, 80);
        const extension = knowledgeDocumentExtension(document);
        const relativePath = path.relative(root, path.join(directory, `${name}${extension}`));
        const content = await exportDocumentContent(document, { root, relativePath, sourceImageRoot, legacyImageRoot: app.getPath('userData') });
        await createNamedExportEntry(directory, name, extension, content);
      }
      return { path: root, count: documents.length };
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    icon: appIconPath,
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f7f4ed',
    center: true,
    // 打开时铺满屏幕（最大化，保留菜单栏和程序坞）；先隐藏，最大化后再显示，避免先闪一下小窗口。
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false }
  });
  const window = mainWindow;
  let shown = false;
  const showMaximized = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.maximize();
    window.show();
  };
  window.once('ready-to-show', showMaximized);
  setTimeout(showMaximized, 3000); // 页面加载异常时也要把窗口显示出来
  mainWindow.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
  mainWindow.on('close', event => {
    if (allowMainWindowClose) return;
    event.preventDefault();
    if (canSendToWindow(mainWindow)) mainWindow.webContents.send('app:request-close', false);
  });
}

async function openNoteWindow(event, target) {
  await readCachedData();
  if (!featureRuntime.available('workspace.multiWindow')) throw new Error('当前独立笔记窗口不可用');
  return workspace.openNoteWindow(event, target);
}

function requestNextWindowQuit() {
  const next = [mainWindow, ...noteWindows].find(window => canSendToWindow(window) && !approvedWindowCloses.has(window));
  if (next) {
    next.show();
    next.webContents.send('app:request-close', true);
  } else {
    allowMainWindowClose = true;
    app.quit();
  }
}

function openReviewWindow() {
  if (reviewWindow && !reviewWindow.isDestroyed()) {
    const bounds = reviewWindow.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(720, workArea.width);
    const height = Math.min(500, workArea.height);
    reviewWindow.setBounds({
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
      width,
      height
    }, true);
    reviewWindow.show();
    reviewWindow.focus();
    reviewWindow.webContents.send('review:reload');
    return;
  }

  reviewWindow = new BrowserWindow({
    width: 720,
    height: 500,
    minWidth: 600,
    minHeight: 460,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') }
  });
  reviewWindow.setHasShadow(false);
  reviewWindow.setAlwaysOnTop(true, 'floating');
  reviewWindow.loadFile(path.join(__dirname, '..', 'web', 'review.html'));
  reviewWindow.once('ready-to-show', () => {
    reviewWindow?.show();
    reviewWindow?.focus();
  });
  reviewWindow.on('closed', () => { reviewWindow = null; });
}

async function createPetWindow() {
  const data = await readData();
  let saved = data.settings.petPosition;
  try { saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'pet-position.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Pet position could not be read:', error); }
  const hasSavedPosition = Number.isFinite(saved?.x) && Number.isFinite(saved?.y);
  const { workArea } = hasSavedPosition
    ? screen.getDisplayNearestPoint({ x: Math.round(saved.x), y: Math.round(saved.y) })
    : screen.getPrimaryDisplay();
  petWindow = new BrowserWindow({
    ...getPetWindowBounds(workArea, hasSavedPosition ? saved : null),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: data.settings.petEnabled,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') }
  });
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.loadFile(path.join(__dirname, '..', 'web', 'pet.html'));
  petWindow.on('moved', () => {
    clearTimeout(petMoveTimer);
    petMoveTimer = setTimeout(async () => {
      const window = petWindow;
      if (!window || window.isDestroyed()) return;
      fitPetToDisplay();
      if (window.isDestroyed()) return;
      const [x, y] = window.getPosition();
      try {
        petPositionWrite = petPositionWrite.catch(() => {}).then(async () => {
          await fs.mkdir(app.getPath('userData'), { recursive: true });
          await writeFileAtomically(path.join(app.getPath('userData'), 'pet-position.json'), JSON.stringify({ x, y }), 'pet');
        });
        await petPositionWrite;
      } catch (error) { console.error('Pet position could not be saved:', error); }
    }, 400);
  });
  petWindow.on('closed', () => {
    clearTimeout(petMoveTimer);
    petWindow = null;
  });
}

async function setPetEnabled(enabled) {
  if (petWindow && !petWindow.isDestroyed()) {
    if (enabled) petWindow.show();
    else petWindow.hide();
  }

  const current = await readData();
  if (current.settings.petEnabled === enabled) return enabled;
  const base = structuredClone(current);
  current.settings.petEnabled = enabled;
  await writeData(current, base);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data:changed');
  }
  return enabled;
}

app.whenReady().then(async () => {
  setTimeout(() => { sweepOrphanNoteImages().catch(() => {}); }, 5000);
  disposeEditionServices = installServices?.({ app, ipcMain, readCachedData, writeFileAtomically, editionRuntime, featureRuntime,
    getWorkspaceWindows: () => [mainWindow, ...noteWindows], canSendToWindow, openNoteWindow, chooseKnowledgeStorageFolder });
  if (editionRuntime.available('screenshot.capture')) installScreenshotCapture({ canCapture: () => featureRuntime.available('screenshot.capture'), getWindows: () => BrowserWindow.getAllWindows(), getOwners: () => [mainWindow, ...noteWindows] });
  if (process.platform === 'darwin') app.dock.setIcon(appIconPath);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'MemoKeep', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]));
  ipcMain.handle('note-file:take', () => openFiles.take());
  ipcMain.handle('link:preview', async (_event, url) => {
    try { return await fetchLinkPreview(url); } catch (error) { return { error: error.message }; }
  });
  ipcMain.handle('data:read', async event => windowDataResponse(event, await readCachedData(), true).data);
  ipcMain.handle('data:read-changes', async (event, token) => windowDataResponse(event, await readCachedData(), false, token));
  ipcMain.handle('data:editing-preferences', async () => {
    const settings = (await readCachedData()).settings;
    return { selectionCardPopupEnabled: settings.selectionCardPopupEnabled !== false,
      ...(Object.hasOwn(settings, 'plugins') ? { plugins: settings.plugins } : {}),
      ...(Object.hasOwn(settings, 'pluginsSeen') ? { pluginsSeen: settings.pluginsSeen } : {}) };
  });
  ipcMain.handle('data:pet-summary', readPetSummary);
  ipcMain.handle('data:home-summary', readHomeSummary);
  ipcMain.handle('storage:get-local-data-path', () => dataPath());
  ipcMain.handle('data:write', async (event, data, base) => {
    const saved = await writeData(data, base);
    windowDataResponse(event, saved, true);
    for (const window of [mainWindow, ...noteWindows]) {
      if (canSendToWindow(window) && event.sender !== window.webContents) window.webContents.send('data:changed');
    }
    return saved;
  });
  ipcMain.handle('data:write-changes', async (event, patch, token) => {
    const saved = await writeData(null, null, patch);
    const response = windowDataResponse(event, saved, false, token);
    for (const window of [mainWindow, ...noteWindows]) {
      if (canSendToWindow(window) && event.sender !== window.webContents) window.webContents.send('data:changed');
    }
    return response;
  });
  ipcMain.handle('file:save-to-directory', async (_, payload = {}) => {
    const directory = typeof payload.directory === 'string' ? payload.directory : '';
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : '';
    if (!directory || !fileName || fileName.includes('/') || fileName.includes('\\')) throw new Error('保存路径无效');
    const target = path.join(directory, fileName);
    await fs.writeFile(target, String(payload.content || ''), 'utf8');
    return target;
  });
  ipcMain.handle('note-image:choose', chooseNoteImage);
  ipcMain.handle('note-image:save', async (_, payload) => saveNoteImage(await configuredNoteImageRoot(), payload));
  ipcMain.handle('note-image:read', async (_, id) => readStoredNoteImage(await readData(), id));
  ipcMain.handle('note-image:delete', (_, id) => deleteUnreferencedNoteImage(id));
  // 复制图片走系统剪贴板：不依赖网页的 navigator.clipboard（它要求窗口有焦点，偶尔会一直不返回）。
  ipcMain.handle('clipboard:write-image', (_, bytes) => {
    const buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
    if (!buffer.length || buffer.length > 64 * 1024 * 1024) throw new Error('图片数据无效');
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('图片数据无效');
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle('backup:export', exportBackup);
  ipcMain.handle('backup:import', importBackup);
  ipcMain.handle('cards:export', exportCards);
  ipcMain.handle('notes:export', exportKnowledgeNotes);
  ipcMain.handle('pet:hide', () => setPetEnabled(false));
  ipcMain.handle('pet:show', () => setPetEnabled(true));
  speech = (createEditionSpeechService || createBaseSpeechService)({ app, systemPreferences, shell });
  speech.register(ipcMain);
  ipcMain.handle('pomodoro:get', () => pomodoro?.view() ?? null);
  ipcMain.handle('pomodoro:command', (_, type, payload) => {
    if (!pomodoro) throw new Error('番茄钟还没准备好');
    return pomodoro.command(String(type), payload && typeof payload === 'object' ? payload : {});
  });
  const openPomodoroPanel = () => { if (!mainWindow || mainWindow.isDestroyed()) return; mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('pomodoro:open-panel'); };
  ipcMain.handle('pomodoro:open-panel', openPomodoroPanel);
  // 悬浮条上的「打开 MemoKeep」：唯一会把主窗口叫出来的地方。
  ipcMain.handle('pomodoro:show-app', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    app.focus({ steal: true });
    mainWindow.focus();
    return true;
  });
  ipcMain.handle('pomodoro:float-position', () => pomodoro?.floatPosition() ?? null);
  ipcMain.handle('pomodoro:float-move', (_, position, done) => pomodoro?.moveFloat(position, { save: Boolean(done) }) ?? null);
  ipcMain.handle('pet:context-menu', async () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const timer = pomodoro?.view(), command = (type, payload) => pomodoro?.command(type, payload).catch(error => console.error('Pomodoro command failed:', error));
    const today = Plans.dayKey(Date.now()), data = await readData();
    const activePlans = (data.plans || []).filter(plan => !Plans.planEnded(plan, today) && plan.startDate <= today);
    const pinItem = { label: '固定番茄钟到桌面', type: 'checkbox', checked: Boolean(timer?.settings.pinned), click: () => command('pin', { pinned: !timer?.settings.pinned }) };
    const settingsItem = { label: '番茄钟设置…', click: openPomodoroPanel };
    const pomodoroItem = !timer ? null : timer.phase === 'idle'
      ? { label: '开始专注', icon: petMenuIcon('pomodoro'), submenu: [{ label: '记到', enabled: false },
        ...activePlans.map(plan => ({ label: plan.name, type: 'checkbox', checked: timer.planId === plan.id, click: () => command('start', { planId: plan.id }) })),
        { label: '不归入计划', type: 'checkbox', checked: !timer.planId, click: () => command('start', { planId: null }) },
        { type: 'separator' }, pinItem, settingsItem] }
      : { label: `${timer.phase === 'focus' ? '专注中' : '休息中'} ${Pomodoro.clock(timer.leftMs)}`, icon: petMenuIcon('pomodoro'), submenu: [
        timer.running ? { label: '暂停', click: () => command('pause') } : { label: timer.phase === 'break' ? '开始休息' : '继续', click: () => command('resume') },
        timer.phase === 'focus' ? { label: '结束专注', click: () => command('stop') } : { label: '跳过休息', click: () => command('skip') },
        { type: 'separator' }, pinItem, settingsItem] };
    Menu.buildFromTemplate([
      ...(pomodoroItem ? [pomodoroItem, { type: 'separator' }] : []),
      {
        label: '显示应用',
        icon: petMenuIcon('show-app'),
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
      { label: '显示卡片', icon: petMenuIcon('show-cards'), click: openReviewWindow },
      {
        label: '显示备忘录',
        icon: petMenuIcon('show-memos'),
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send('navigate:view', 'memos');
        }
      },
      { type: 'separator' },
      { label: '隐藏', icon: petMenuIcon('hide'), click: () => setPetEnabled(false) }
    ]).popup({ window: petWindow });
  });
  ipcMain.handle('pet:get-position', () => {
    if (!petWindow || petWindow.isDestroyed()) return { x: 0, y: 0 };
    const [x, y] = petWindow.getPosition();
    return { x, y };
  });
  ipcMain.handle('pet:set-position', (_, position) => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    const x = Math.round(Number(position?.x));
    const y = Math.round(Number(position?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const bounds = petWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x, y });
    const area = display.workArea;
    const visibleEdge = 43;
    const safeX = Math.min(area.x + area.width - visibleEdge, Math.max(area.x - bounds.width + visibleEdge, x));
    const safeY = Math.min(area.y + area.height - visibleEdge, Math.max(area.y, y));
    petWindow.setPosition(safeX, safeY, false);
    return true;
  });
  ipcMain.handle('app:open', (_, view) => { mainWindow?.show(); mainWindow?.focus(); if (['cards','growth'].includes(view)) mainWindow?.webContents.send('navigate:view', view); });
  ipcMain.handle('app:confirm-close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow && !noteWindows.has(window)) return;
    if (isQuitting) {
      approvedWindowCloses.add(window);
      requestNextWindowQuit();
    } else if (noteWindows.has(window)) {
      approvedWindowCloses.add(window);
      window.close();
    } else {
      mainWindow.hide();
    }
  });
  ipcMain.handle('app:cancel-close', () => { isQuitting = false; approvedWindowCloses.clear(); });
  ipcMain.handle('app:review', openReviewWindow);
  ipcMain.handle('review:close', () => reviewWindow?.close());
  ipcMain.handle('review:source-open', (_event, open) => {
    if (!reviewWindow || reviewWindow.isDestroyed()) return;
    const bounds = reviewWindow.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const width = open ? Math.min(1080, workArea.width) : Math.min(720, workArea.width);
    const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
    reviewWindow.setBounds({ x, y: bounds.y, width, height: bounds.height }, true);
  });
  ipcMain.handle('notify', (_, message) => {
    if (!Notification.isSupported()) return;
    const payload = typeof message === 'string'
      ? { title: 'MemoKeep', body: message }
      : { title: message?.title || 'MemoKeep', body: message?.body || '' };
    const notification = new Notification(payload);
    if (message?.view) notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('navigate:view', message.view);
    });
    notification.show();
  });
  createMainWindow();
  // Backfill in the write queue after the window opens, so startup export work
  // does not hold the first window or race a user's first save.
  const startupSync = dataWriteQueue.then(async () => syncKnowledgeDocuments(await readCachedData()));
  dataWriteQueue = startupSync.catch(error => {
    console.error('Startup document sync failed:', error);
    dialog.showErrorBox('笔记文档同步失败', `本地数据仍保留，请检查存储目录后重新保存：${error.message}`);
  });
  await createPetWindow();
  pomodoro = createPomodoroService({ BrowserWindow, screen, Notification, readData, writeData, preload: path.join(__dirname, 'preload.cjs'),
    windows: () => [mainWindow, petWindow, reviewWindow, ...noteWindows],
    afterWrite: () => { for (const window of [mainWindow, ...noteWindows]) if (canSendToWindow(window)) window.webContents.send('data:changed'); } });
  await pomodoro.load().catch(error => console.error('Pomodoro could not load:', error));
  screen.on('display-metrics-changed', fitPetToDisplay);
  screen.on('display-added', fitPetToDisplay);
  screen.on('display-removed', fitPetToDisplay);
  // 点程序坞图标时显示主窗口；点番茄钟悬浮条（鼠标在悬浮条上）时 macOS 也会发 activate，这时不弹主窗口。
  app.on('activate', () => {
    const float = pomodoro?.floatWindow?.();
    if (float && !float.isDestroyed() && float.isVisible()) {
      const point = screen.getCursorScreenPoint(), bounds = float.getBounds();
      if (point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height) return;
    }
    mainWindow.show(); mainWindow.focus();
  });
});

app.on('before-quit', event => {
  if (allowMainWindowClose) return;
  event.preventDefault();
  if (isQuitting) return;
  isQuitting = true;
  requestNextWindowQuit();
});
app.on('will-quit', () => { disposeEditionServices?.(); pomodoro?.dispose(); speech?.dispose(); });
app.on('window-all-closed', event => process.platform === 'darwin' ? event.preventDefault() : app.quit());
