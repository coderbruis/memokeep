const fs = require('node:fs/promises');
const path = require('node:path');
const { createDocument } = require('@mixmark-io/domino');
const TurndownService = require('turndown');
const { isText: isPlainTextDocument } = require('../web/note-file-types.js');
const { readNoteImage } = require('./note-images.cjs');

function isRichTextNote(document) {
  return !isPlainTextDocument(document) && document.metadata?.editorMode === 'note' && Boolean(document.metadata?.noteContentInitialized);
}

function richNoteMarkdown(html) {
  const document = createDocument(`<body>${html || ''}</body>`);
  const root = document.body;
  Array.from(root.querySelectorAll('script, style, iframe, object, .ql-ui')).forEach(node => node.parentNode.removeChild(node));

  // Quill stores code as one DIV per line. Normalize before Turndown collapses
  // HTML whitespace, otherwise indentation and blank code lines would be lost.
  Array.from(root.querySelectorAll('.ql-code-block-container')).forEach(container => {
    const fragment = document.createDocumentFragment();
    let code;
    let previousLanguage;
    Array.from(container.children).forEach(line => {
      const language = line.getAttribute('data-language') || 'plain';
      if (!code || language !== previousLanguage) {
        const pre = document.createElement('pre');
        code = document.createElement('code');
        if (/^[\w-]+$/.test(language) && language !== 'plain') code.className = `language-${language}`;
        pre.appendChild(code);
        fragment.appendChild(pre);
      } else {
        code.appendChild(document.createTextNode('\n'));
      }
      code.appendChild(document.createTextNode(line.textContent));
      previousLanguage = language;
    });
    container.parentNode.replaceChild(fragment, container);
  });
  Array.from(root.querySelectorAll('pre')).forEach(pre => {
    if (pre.firstChild?.nodeName === 'CODE') return;
    const code = document.createElement('code');
    code.textContent = pre.textContent;
    const language = pre.getAttribute('data-language') || '';
    if (/^[\w-]+$/.test(language) && language !== 'plain') code.className = `language-${language}`;
    pre.textContent = '';
    pre.appendChild(code);
  });

  const converter = new TurndownService({
    headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', preformattedCode: true
  });
  converter.keep('u');
  converter.addRule('strikethrough', {
    filter: ['s', 'del', 'strike'], replacement: content => `~~${content}~~`
  });
  converter.addRule('quill-list', {
    filter: node => node.nodeName === 'LI' && Boolean(node.getAttribute('data-list')),
    replacement(content, node) {
      const level = item => Number(item.className.match(/\bql-indent-([1-9])\b/)?.[1] || 0);
      const indent = level(node);
      const type = node.getAttribute('data-list');
      let number = 1;
      if (type === 'ordered') {
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (level(sibling) < indent) break;
          if (level(sibling) === indent) {
            if (sibling.getAttribute('data-list') !== type) break;
            number += 1;
          }
        }
      }
      const marker = type === 'ordered' ? `${number}. ` : type === 'checked' ? '- [x] ' : type === 'unchecked' ? '- [ ] ' : '- ';
      const padding = '    '.repeat(indent);
      return `${padding}${marker}${content.trim().replace(/\n/g, `\n${padding}${' '.repeat(marker.length)}`)}\n`;
    }
  });
  converter.addRule('note-table', {
    filter: 'table',
    replacement(_content, table) {
      // The editor represents every cell with TD, including the first row.
      const rows = Array.from(table.rows).map(row => Array.from(row.cells).map(cell => (
        converter.turndown(cell.innerHTML).trim().replace(/\r?\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|')
      )));
      if (!rows.length) return '';
      const columns = Math.max(...rows.map(row => row.length));
      const line = row => `| ${Array.from({ length: columns }, (_, index) => row[index] || '').join(' | ')} |`;
      return `\n\n${[line(rows[0]), line(Array(columns).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
    }
  });
  const markdown = converter.turndown(root).trim();
  return markdown ? `${markdown}\n` : '';
}

async function exportDocumentContent(document, { root, relativePath, legacyImageRoot, sourceImageRoot, onMissingImage }) {
  if (isPlainTextDocument(document)) return String(document.content || '');
  let content = isRichTextNote(document)
    ? richNoteMarkdown(document.metadata.noteContent)
    : String(document.content || '');
  const imageIds = new Set([...content.matchAll(/memokeep-image:\/\/([0-9a-f-]{36})/gi)].map(match => match[1].toLowerCase()));
  for (const id of imageIds) {
    let image = await readNoteImage(root, id);
    if (!image && sourceImageRoot && sourceImageRoot !== root) {
      image = await readNoteImage(sourceImageRoot, id);
      if (image) {
        await fs.mkdir(path.join(root, 'images'), { recursive: true });
        await fs.copyFile(path.join(sourceImageRoot, 'images', image.fileName), path.join(root, 'images', image.fileName), fs.constants.COPYFILE_EXCL);
      }
    }
    if (!image && legacyImageRoot) {
      image = await readNoteImage(legacyImageRoot, id, { directoryName: 'note-images' });
      if (image) {
        await fs.mkdir(path.join(root, 'images'), { recursive: true });
        await fs.copyFile(path.join(legacyImageRoot, 'note-images', image.fileName), path.join(root, 'images', image.fileName), fs.constants.COPYFILE_EXCL);
      }
    }
    if (!image) {
      const message = `笔记「${document.title || '未命名笔记'}」的图片文件不存在：${id}`;
      // Automatic sync keeps the reference recoverable and saves the text.
      // Explicit exports stay strict unless the caller handles missing assets.
      if (!onMissingImage) throw new Error(message);
      onMissingImage({ documentId: document.id, imageId: id, relativePath, message });
      continue;
    }
    const imagePath = path.relative(path.dirname(relativePath), path.join('images', image.fileName))
      .split(path.sep).map(encodeURIComponent).join('/');
    content = content.replace(new RegExp(`memokeep-image:\\/\\/${id}`, 'gi'), () => imagePath);
  }
  return content;
}

module.exports = { exportDocumentContent, isRichTextNote, richNoteMarkdown };
