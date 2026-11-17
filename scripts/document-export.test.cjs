const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { exportDocumentContent, richNoteMarkdown } = require('../electron/document-export.cjs');
const { saveNoteImage } = require('../electron/note-images.cjs');

test('preserves Quill code indentation, blank lines, language and embedded fences', () => {
  const html = '<div class="ql-code-block-container">'
    + '<div class="ql-code-block" data-language="mermaid">flowchart TD</div>'
    + '<div class="ql-code-block" data-language="mermaid">  A --&gt; B</div>'
    + '<div class="ql-code-block" data-language="mermaid"><br></div>'
    + '<div class="ql-code-block" data-language="mermaid">  B --&gt; C</div></div>';
  assert.equal(richNoteMarkdown(html), '```mermaid\nflowchart TD\n  A --> B\n\n  B --> C\n```\n');
  assert.equal(richNoteMarkdown('<pre data-language="js">  let x = 1;\n```</pre>'), '````js\n  let x = 1;\n```\n````\n');
});

test('exports editor tables as Markdown while retaining inline code, pipes and line breaks', () => {
  const html = '<table><tbody><tr><td><strong>快捷键</strong></td><td>作用</td></tr>'
    + '<tr><td><code>cmd | k</code></td><td>清屏<br>继续</td></tr></tbody></table>';
  assert.equal(richNoteMarkdown(html), '| **快捷键** | 作用 |\n| --- | --- |\n| `cmd \\| k` | 清屏  <br>继续 |\n');
});

test('keeps Quill list types, nesting, formatting and links', () => {
  const markdown = richNoteMarkdown('<ol><li data-list="ordered"><span class="ql-ui"></span>第一项</li>'
    + '<li data-list="bullet" class="ql-indent-1">子项</li><li data-list="ordered">第二项</li>'
    + '<li data-list="checked">完成</li><li data-list="unchecked">待办</li></ol>'
    + '<p><s>删除</s> <u>下划线</u> <a href="https://example.com/?a=1&amp;b=2">链接</a></p>');
  assert.match(markdown, /1\. 第一项\n {4}- 子项\n2\. 第二项\n- \[x\] 完成\n- \[ \] 待办/);
  assert.match(markdown, /~~删除~~ <u>下划线<\/u> \[链接\]\(https:\/\/example.com\/\?a=1&b=2\)/);
});

test('copies legacy images and resolves existing source references without mutating the note', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memokeep-export-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'exports');
  const legacyImageRoot = path.join(directory, 'profile');
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const image = await saveNoteImage(legacyImageRoot, { bytes }, { directoryName: 'note-images' });
  const document = { title: '截图', content: `![图片](${image.reference})`, metadata: { editorMode: 'card' } };
  const before = JSON.stringify(document);
  const options = { root, relativePath: '记忆卡片/目录/截图.md', legacyImageRoot };
  assert.equal(await exportDocumentContent(document, options), `![图片](../../images/${image.fileName})`);
  assert.deepEqual(await fs.readFile(path.join(root, 'images', image.fileName)), bytes);
  assert.deepEqual(await fs.readFile(path.join(legacyImageRoot, 'note-images', image.fileName)), bytes);
  assert.equal(JSON.stringify(document), before);
  assert.equal(await exportDocumentContent(document, options), `![图片](../../images/${image.fileName})`);
  document.content = '![缺失](memokeep-image://00000000-0000-4000-8000-000000000000)';
  await assert.rejects(exportDocumentContent(document, options), /图片文件不存在/);
});

test('plain text exports preserve literal markup, whitespace and image-looking references', async () => {
  const content = '# 保持原文\r\n\r\n  **字面文本**\t中文😀\r\n<img src="example">\r\nmemokeep-image://11111111-2222-3333-4444-555555555555';
  const doc = { title: '原文', sourceType: 'manual-text', content,
    metadata: { fileType: 'txt', editorMode: 'note', noteContentInitialized: true, noteContent: '<p>不能导出这段旧缓存</p>' } };
  assert.equal(await exportDocumentContent(doc, { root: '/unused', relativePath: '原文.txt' }), content);
});
