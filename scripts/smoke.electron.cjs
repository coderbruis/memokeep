// Real Community application and preload with a disposable local profile.
// Run from the public checkout: electron scripts/smoke.electron.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const sourceRoot = path.resolve(process.env.MEMOKEEP_COMMUNITY_APP || path.join(__dirname, '..'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memokeep-community-smoke-'));
const profile = path.join(temporary, 'profile');
fs.mkdirSync(profile);
app.setPath('userData', profile);
const iso = new Date().toISOString();
fs.writeFileSync(path.join(profile, 'memokeep-data.json'), JSON.stringify({
  version: 2, cardOrganizationVersion: 1,
  knowledgeBases: [{ id: 'library', name: 'Community test', type: 'general' }],
  documents: [{ id: 'note', knowledgeBaseId: 'library', title: 'Public note', content: 'Original text', sourceType: 'manual-markdown', createdAt: iso, updatedAt: iso,
    metadata: { editorMode: 'note', noteContentInitialized: true, noteContent: '<p>Original text</p>' } }],
  cards: [{ id: 'card', knowledgeBaseId: 'library', question: 'Public card', answer: 'Public answer', status: 'active', createdAt: iso, updatedAt: iso }],
  settings: { petEnabled: false, notificationsEnabled: false }
}));
const errors = [];
app.on('browser-window-created', (_event, window) => window.hide());
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  contents.on('did-fail-load', (_event, code, description, url) => { if (code !== -3) errors.push(`${description}: ${url}`); });
  contents.on('preload-error', (_event, filename, error) => errors.push(`${filename}: ${error.message}`));
});
require(path.join(sourceRoot, 'electron/main.cjs'));
let main;
const run = code => main.webContents.executeJavaScript(code, true);
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; renderer errors: ${errors.join('; ')}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

app.whenReady().then(async () => {
  try {
    await until(() => { main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')); return main; }, 'main window');
    await until(() => run('typeof applicationShell !== "undefined" && applicationShell.state.persistence.applicationDataReady === true'), 'application data');
    assert.equal(app.getPath('userData'), profile);
    assert.equal(await run('MemoKeepEdition.id'), 'community');
    assert.deepEqual(await run('MemoKeepFeatures'), []);
    assert.deepEqual(await run('MemoKeepPlugins'), []);
    const boundaries = await run(`({
      privateGlobals: ['MemoKeepFreeReviewAnalysis','MemoKeepFreeReviewRecorder','MemoKeepFreeReviewView','MemoKeepStatistics','MemoKeepCodeFormatter','createMermaidCanvas','bindNoteImageTools','bindNoteCodeStyles'].filter(key => typeof globalThis[key] !== 'undefined'),
      privateServices: ['captureScreenshot','openNoteWindow','chooseKnowledgeStorageFolder','freeReview'].filter(key => typeof memoKeepDesktop[key] !== 'undefined'),
      privateSpeech: ['pause','resume'].filter(key => typeof memoKeepDesktop.speech[key] !== 'undefined'),
      basicSpeech: ['available','status','start','stop','cancel','onEvent'].every(key => typeof memoKeepDesktop.speech[key] === 'function'),
      privatePages: Boolean(document.querySelector('#freeReviewView, #statisticsView')),
      privateShortcut: MemoKeepShortcuts.entries.some(item => item.id === 'screenshot')
    })`);
    assert.deepEqual(boundaries, { privateGlobals: [], privateServices: [], privateSpeech: [], basicSpeech: true, privatePages: false, privateShortcut: false });
    const capabilityState = await run(`(() => {
      const runtime = MemoKeepRuntime.createRuntime({features: MemoKeepFeatures});
      return ['screenshot.capture','workspace.multiWindow','folder.publish','analytics.view','editor.enhance','diagram.visualEdit','review.freeSpeak'].map(id => runtime.available(id));
    })()`);
    assert.deepEqual(capabilityState, Array(7).fill(false));

    await run('applicationShell.actions.showView("libraries");');
    assert.equal(await run('document.querySelector("#librariesView").classList.contains("hidden")'), false);
    await run('applicationShell.actions.openMarkdownNoteEditor(applicationShell.actions.documentById("note"));');
    await until(() => run('Boolean(document.querySelector("#noteRichEditor") && globalThis.Quill?.find(document.querySelector("#noteRichEditor")))'), 'note editor assets');
    await run(`(async () => {
      const quill = Quill.find(document.querySelector('#noteRichEditor'));
      quill.insertText(quill.getLength() - 1, ' Saved by Community', 'user');
      await applicationShell.state.editor.saveActiveNoteEditor();
      await application.editor.session.leaveActiveNoteEditor();
      applicationShell.actions.showView('cards');
    })()`);
    assert.equal(await run('document.querySelector("#cardsView").textContent.includes("Public card")'), true);
    await run(`document.querySelector('#newCardBtn').click();
      document.querySelector('#question').value = 'Created in Community';
      document.querySelector('#answer').value = 'Saved card';
      document.querySelector('#cardForm').requestSubmit();`);
    await until(() => run('applicationShell.state.persistence.data.cards.some(card => card.question === "Created in Community") && !document.querySelector("#cardDialog").open'), 'create card');
    await run('applicationShell.actions.showView("settings");document.querySelector("[data-appearance-theme=mist]").click();');
    assert.equal(await run('document.querySelector("#settingsView").classList.contains("hidden")'), false);
    assert.equal(await run('document.documentElement.dataset.theme'), 'mist');

    const resources = await run(`Array.from(document.querySelectorAll('script[src], link[rel=stylesheet]'), node => node.src || node.href)`);
    assert.ok(resources.length > 100);
    for (const url of resources) {
      assert.equal(new URL(url).protocol, 'file:', `Unexpected remote application resource: ${url}`);
      assert.ok(fs.existsSync(fileURLToPath(url)), `Missing application resource: ${url}`);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'memokeep-data.json'), 'utf8'));
    assert.match(saved.documents.find(note => note.id === 'note').metadata.noteContent, /Saved by Community/);
    assert.ok(saved.cards.some(card => card.question === 'Created in Community'));
    await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
    await until(() => run('typeof applicationShell !== "undefined" && applicationShell.state.persistence.applicationDataReady === true'), 'reload');
    assert.match(await run('applicationShell.actions.documentById("note").metadata.noteContent'), /Saved by Community/);
    assert.equal(await run('applicationShell.state.persistence.data.cards.some(card => card.question === "Created in Community")'), true);
    assert.equal(await run('document.documentElement.dataset.theme'), 'mist');
    assert.deepEqual(errors, []);
    console.log(`PASS: Community real preload, renderer resources, note/card save and reload, settings, private boundaries, basic speech bridge; ${temporary}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try { await window.loadURL('about:blank'); } catch {}
      if (!window.isDestroyed()) window.destroy();
    }
    await new Promise(resolve => setImmediate(resolve));
    app.exit(process.exitCode || 0);
  }
});
