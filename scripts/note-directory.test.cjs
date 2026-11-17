const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./memo-fixture.cjs');
function fixture() {
  const f = setup();
  const proto = f.window.Element.prototype;
  const host = f.document.querySelector('#libraryContent');
  const queryAll = host.querySelectorAll;
  Object.defineProperty(host, 'querySelectorAll', { configurable: true, value(selector) { return selector.includes(':popover-open') ? Array.from(queryAll.call(this, selector.replaceAll(':popover-open', ''))).filter(node => { try { return node.matches(':popover-open'); } catch { return false; } }) : queryAll.call(this, selector); } });
  if (!proto.append) proto.append = function(node) { this.appendChild(node); };
  if (!proto.prepend) proto.prepend = function(node) { this.insertBefore(node, this.firstChild); };
  f.context.TextEncoder = TextEncoder; f.context.Event = f.window.Event;
  f.context.requestAnimationFrame = fn => { fn(); return 1; }; f.context.cancelAnimationFrame = () => {};
  for (const file of ['note-file-types.js', 'note-directory.js']) f.run(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'));
  f.run(`data.knowledgeBases = [{ id: 'library', name: '<知识库>', type: 'general', description: '保留描述', language: 'Java' }];
    data.noteTags = Array.from({length: 12}, (_, i) => ({ id: 'tag-' + i, name: '标签' + i, updatedAt: '2026-10-01T00:00:00Z' }));
    data.documents = Array.from({length: 13}, (_, i) => ({ id: 'doc-' + i, title: '笔记' + i, knowledgeBaseId: 'library', content: '正文' + i, tagIds: i < 11 ? ['tag-0'] : [], metadata: {fileType: i % 2 ? 'txt' : 'md'}, updatedAt: '2026-10-01T00:00:00Z' }));`);
  f.run("application.editor.session.leaveActiveNoteEditor = async () => true; applicationShell.actions.showView = () => renderNoteTagDirectory(document.querySelector('#newNoteBtn'));");
  const $ = selector => f.document.querySelector(selector);
  return { ...f, $, mount() { f.run("document.querySelector('#libraryContent').innerHTML = renderNoteDirectory(data.knowledgeBases[0], data.documents, [], ''); mountNoteDirectory(data.knowledgeBases[0], data.documents)"); }, home() { f.run('renderNoteTagHome()'); } };
}
test('compact directory preserves metadata and exposes count, search, sort, views and edit action', () => {
  const f = fixture(); const before = f.run('JSON.stringify(data)'); f.mount();
  assert.equal(f.$('.note-directory-description'), undefined); assert.equal(f.$('.library-meta'), undefined);
  assert.equal(f.$('.note-directory-title h2').textContent, '<知识库>'); assert.equal(f.$('#noteDirectoryCount').textContent, '13');
  for (const selector of ['#noteDirectorySearch','#noteDirectorySort','#noteDirectoryFileType','[data-note-directory-view=card]','[data-edit-library=library]']) assert.ok(f.$(selector));
  assert.equal(f.run('JSON.stringify(data)'), before);
});
test('directory search, file filters, pagination and view changes retain the current scope', () => {
  const f = fixture(); f.mount(); assert.equal(f.document.querySelectorAll('[data-document-row]').length, 10);
  const next = f.$('[data-note-directory-page-action=next]'); f.$('#noteDirectoryPagination').onclick({ target: next }); assert.equal(f.document.querySelectorAll('[data-document-row]').length, 3);
  f.$('#noteDirectoryFileType').value = 'txt'; f.$('#noteDirectoryFileType').onchange({ target: f.$('#noteDirectoryFileType') }); assert.equal(f.document.querySelectorAll('[data-document-row]').length, 6);
  f.$('#noteDirectorySearch').value = '笔记1'; f.$('#noteDirectorySearch').oninput({ target: f.$('#noteDirectorySearch') }); assert.equal(f.document.querySelectorAll('[data-document-row]').length, 2);
  f.$('[data-note-directory-view=card]').onclick(); assert.equal(f.document.querySelectorAll('.note-directory-card').length, 2);
});
test('tag home keeps counts, search, sort, pagination and escaped tag names without modifying persisted data', () => {
  const f = fixture(); f.run("data.noteTags[11].name = '<标签>'"); const before = f.run('JSON.stringify(data)'); f.home();
  assert.equal(f.$('.note-directory-description'), undefined); assert.match(f.$('.library-meta').textContent, /12 个标签/); assert.match(f.$('.library-meta').textContent, /11 篇笔记/);
  assert.equal(f.document.querySelectorAll('[data-note-tag-card]').length, 10);
  f.$('#noteTagHomePagination').onclick({ target: f.$('[data-note-tag-home-page-action=next]') }); assert.equal(f.document.querySelectorAll('[data-note-tag-card]').length, 2);
  f.$('#noteTagHomeSearch').value = '<标签>'; f.$('#noteTagHomeSearch').oninput({ target: f.$('#noteTagHomeSearch') }); assert.equal(f.$('.note-tag-home-card h3').textContent, '<标签>'); assert.equal(f.$('.note-tag-home-card h3').children.length, 0);
  f.$('#noteTagHomeSort').value = 'name'; f.$('#noteTagHomeSort').onchange({ target: f.$('#noteTagHomeSort') }); assert.equal(f.run('JSON.stringify(data)'), before);
});
test('untagged notes remain reachable through a visible button and real directory click handler', async () => {
  const f = fixture(); f.home(); const button = f.$('[data-note-tag-open=untagged]'); assert.ok(button, 'The untagged scope needs a user-facing entry');
  f.context.target = button; f.run('handleNoteTagDirectoryClick({target})'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run('selectedNoteTagId'), 'untagged'); assert.equal(f.$('#noteDirectoryCount').textContent, '2');
});
test('tag directory maintains breadcrumb, scoped notes and new-note tag preset', () => {
  const f = fixture(); f.run("selectedNoteTagId = 'tag-0'; renderNoteTagDirectory(document.querySelector('#newNoteBtn'))");
  assert.ok(f.$('[data-note-tag-home]')); assert.equal(f.$('#noteDirectoryCount').textContent, '11'); assert.match(f.$('#newNoteBtn').title, /标签0/);
});
