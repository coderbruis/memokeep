(function expose(root) {
  function createContent({ state, config, actions, env }) {
    function memoContentText(content = '') {
      const container = env.document.createElement('div');
      container.innerHTML = String(content);
      container.querySelectorAll('img').forEach(image => image.replaceWith('[图片]'));
      return (container.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function sanitizeMemoContent(content = '') {
      const template = env.document.createElement('template');
      template.innerHTML = String(content);
      const allowedTags = new Set(['P', 'BR', 'STRONG', 'EM', 'U', 'S', 'OL', 'UL', 'LI', 'BLOCKQUOTE', 'A', 'IMG']);
      const elements = [...template.content.querySelectorAll('*')];
      for (const element of elements) {
        if (['SCRIPT', 'STYLE'].includes(element.tagName)) {
          element.remove();
          continue;
        }
        if (!allowedTags.has(element.tagName)) {
          element.replaceWith(...element.childNodes);
          continue;
        }
        const href = element.tagName === 'A' ? element.getAttribute('href') : '';
        const listType = element.tagName === 'LI' ? element.getAttribute('data-list') : '';
        const imageId = element.tagName === 'IMG'
        ? (element.dataset.memokeepImageId || element.getAttribute('src')?.match(/^memokeep-image:\/\/([0-9a-f-]{36})$/i)?.[1] || '').toLowerCase()
        : '';
        const imageFileName = element.tagName === 'IMG'
        ? String(element.dataset.fileName || element.getAttribute('alt') || '图片').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160)
        : '';
        for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
        if (element.tagName === 'IMG') {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId)) {
            element.remove();
            continue;
          }
          element.setAttribute('src', `memokeep-image://${imageId}`);
          element.dataset.memokeepImageId = imageId;
          element.dataset.fileName = imageFileName || '图片';
          element.setAttribute('alt', imageFileName || '图片');
        }
        if (element.tagName === 'LI' && ['ordered', 'bullet'].includes(listType)) element.setAttribute('data-list', listType);
        if (element.tagName === 'A' && /^(https?:|mailto:)/i.test(href || '')) {
          element.setAttribute('href', href);
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      }
      return template.innerHTML;
    }

    function sanitizeRichNoteContent(content = '') {
      const template = env.document.createElement('template');
      template.innerHTML = String(content);
      const allowedTags = new Set([
        'P', 'BR', 'STRONG', 'EM', 'U', 'S', 'OL', 'UL', 'LI', 'BLOCKQUOTE', 'A', 'IMG',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'SPAN', 'DIV',
        'TABLE', 'TBODY', 'TR', 'TD'
      ]);
      const safeColor = value => /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(value || '');
      const elements = [...template.content.querySelectorAll('*')];
      for (const element of elements) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(element.tagName)) {
          element.remove();
          continue;
        }
        if (!allowedTags.has(element.tagName)) {
          element.replaceWith(...element.childNodes);
          continue;
        }

        const linkPreviewLoaded = element.matches('a.note-link-card[data-note-link-loaded="true"]');
        const href = element.tagName === 'A' ? element.getAttribute('href') : '';
        const listType = element.tagName === 'LI' ? element.getAttribute('data-list') : '';
        const language = ['PRE', 'DIV'].includes(element.tagName) ? element.getAttribute('data-language') : '';
        const classNames = [...element.classList].filter(name => /^(note-link-(card|title|url|body|cover|description|site)|ql-(align-(center|right|justify)|indent-[1-9]|direction-rtl|code-block(-container)?|ui))$/.test(name));
        const codeStyle = element.matches('.ql-code-block, pre') ? env.parseNoteCodeStyle(element.getAttribute('data-code-style')) : null;
        const codeName = element.matches('.ql-code-block, pre') ? env.normalizeNoteCodeName(element.getAttribute('data-code-name')) : '';
        const codeFold = element.matches('.ql-code-block, pre') && element.getAttribute('data-code-fold') === '1';
        const color = element.tagName === 'SPAN' ? element.style.color : '';
        const backgroundColor = element.tagName === 'SPAN' ? element.style.backgroundColor : '';
        const imageId = element.tagName === 'IMG'
        ? (element.dataset.memokeepImageId || element.getAttribute('src')?.match(/^memokeep-image:\/\/([0-9a-f-]{36})$/i)?.[1] || '').toLowerCase()
        : '';
        const imageSource = element.tagName === 'IMG' ? element.getAttribute('src') || '' : '';
        const imageLayout = element.tagName === 'IMG' ? env.noteImageLayout(element) : null;
        const imageFileName = element.tagName === 'IMG'
        ? String(element.dataset.fileName || element.getAttribute('alt') || '图片').replace(/[\r\n\t]/g, ' ').trim().slice(0, 160)
        : '';
        const tableRowId = element.tagName === 'TD' ? element.getAttribute('data-row') || '' : '';
        const tableCellWidth = element.tagName === 'TD' ? env.noteTableCellWidth(element.style.width) : 0;

        for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
        if (classNames.length) element.className = classNames.join(' ');
        if (codeStyle) element.setAttribute('data-code-style', env.packNoteCodeStyle(codeStyle));
        if (codeName) element.setAttribute('data-code-name', codeName);
        if (codeFold) element.setAttribute('data-code-fold', '1');
        if(linkPreviewLoaded) element.dataset.noteLinkLoaded = 'true';
        if (element.tagName === 'SPAN') {
          if (safeColor(color)) element.style.color = color;
          if (safeColor(backgroundColor)) element.style.backgroundColor = backgroundColor;
        }
        if (element.tagName === 'IMG') {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId)) {
            element.setAttribute('src', `memokeep-image://${imageId}`);
            element.dataset.memokeepImageId = imageId;
            element.dataset.fileName = imageFileName || '图片';
            element.setAttribute('alt', imageFileName || '图片');
          } else if (/^https?:\/\//i.test(imageSource)) {
            element.setAttribute('src', imageSource);
            element.setAttribute('alt', imageFileName || '图片');
          } else {
            element.remove();
            continue;
          }
          env.writeNoteImageLayout(element, imageLayout);
        }
        if (element.tagName === 'TD' && /^row-[\w-]{1,32}$/.test(tableRowId)) element.setAttribute('data-row', tableRowId);
        if (tableCellWidth) element.style.width = `${tableCellWidth}px`;
        if (element.tagName === 'LI' && ['ordered', 'bullet', 'checked', 'unchecked'].includes(listType)) {
          element.setAttribute('data-list', listType);
        }
        if (language && /^[\w-]{1,32}$/.test(language)) element.setAttribute('data-language', language);
        if (element.tagName === 'A' && /^(https?:|mailto:)/i.test(href || '')) {
          element.setAttribute('href', href);
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      }
      env.serializeNoteTableWidths(template.content);
      env.serializeNoteCodeStyles(template.content);
      return template.innerHTML;
    }

    function looksLikeMarkdown(value = '') {
      const text = String(value).replace(/\r\n?/g, '\n').trim();
      if (!text) return false;
      const lines = text.split('\n');
      if (lines.some((line, index) => index < lines.length - 1
      && line.includes('|')
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]))) return true;
      if (lines.some(line => /^\s{0,3}(#{1,6}\s+|```|~~~|>\s?|[-+*]\s+|\d+[.)]\s+|---+\s*$)/.test(line))) return true;
      const inlineMarkers = text.match(/(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|!??\[[^\]]+\]\([^)]+\))/g);
      return (inlineMarkers?.length || 0) >= 1;
    }

    function markdownInlineHtml(value = '') {
      const tokens = [];
      const stash = html => {
        const token = `\uE000${tokens.length}\uE001`;
        tokens.push(html);
        return token;
      };
      let text = String(value);
      text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${actions.escapeHtml(code)}</code>`));
      text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/gi, (_match, alt, url) => (
      stash(`<img src="${actions.escapeHtml(url)}" alt="${actions.escapeHtml(alt || '图片')}">`)
      ));
      text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)(?:\s+["'][^"']*["'])?\)/gi, (_match, label, url) => (
      stash(`<a href="${actions.escapeHtml(url)}">${actions.escapeHtml(label)}</a>`)
      ));
      text = actions.escapeHtml(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
      return text.replace(/\uE000(\d+)\uE001/g, (_match, index) => tokens[Number(index)] || '');
    }

    function splitMarkdownTableRow(line = '') {
      return String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map(cell => cell.replace(/\\\|/g, '|').trim());
    }

    function markdownToRichHtml(value = '') {
      const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
      const html = [];
      const isBlockStart = (line, index) => /^\s{0,3}(#{1,6}\s+|```|~~~|>\s?|[-+*]\s+|\d+[.)]\s+|---+\s*$)/.test(line)
      || (line.includes('|') && index < lines.length - 1
      && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]));

      for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!line.trim()) {
          index += 1;
          continue;
        }

        const fence = line.match(/^\s{0,3}(```|~~~)\s*([\w-]*)\s*$/);
        if (fence) {
          const code = [];
          index += 1;
          while (index < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          const language = fence[2] ? ` data-language="${actions.escapeHtml(fence[2])}"` : '';
          html.push(`<pre${language}><code>${actions.escapeHtml(code.join('\n'))}</code></pre>`);
          continue;
        }

        const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
          const level = Math.min(3, heading[1].length);
          html.push(`<h${level}>${actions.markdownInlineHtml(heading[2])}</h${level}>`);
          index += 1;
          continue;
        }

        if (line.includes('|') && index < lines.length - 1
        && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
          const rows = [actions.splitMarkdownTableRow(line)];
          index += 2;
          while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
            rows.push(actions.splitMarkdownTableRow(lines[index]));
            index += 1;
          }
          const columnCount = Math.max(...rows.map(row => row.length));
          html.push(`<table><tbody>${rows.map((row, rowIndex) => `<tr>${Array.from({ length: columnCount }, (_unused, columnIndex) => {
                const content = actions.markdownInlineHtml(row[columnIndex] || '');
                return `<td>${rowIndex === 0 ? `<strong>${content}</strong>` : content}</td>`;
              }).join('')}</tr>`).join('')}</tbody></table>`);
          continue;
        }

        if (/^\s{0,3}>/.test(line)) {
          const quote = [];
          while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
            index += 1;
          }
          html.push(`<blockquote>${quote.map(actions.markdownInlineHtml).join('<br>')}</blockquote>`);
          continue;
        }

        const listMatch = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (listMatch) {
          const ordered = /^\d/.test(listMatch[1]);
          const tag = ordered ? 'ol' : 'ul';
          const items = [];
          while (index < lines.length) {
            const item = lines[index].match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
            if (!item || /^\d/.test(item[1]) !== ordered) break;
            let content = item[2];
            const task = content.match(/^\[([ xX])\]\s+(.+)$/);
            if (task) content = `${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${task[2]}`;
            items.push(`<li>${actions.markdownInlineHtml(content)}</li>`);
            index += 1;
          }
          html.push(`<${tag}>${items.join('')}</${tag}>`);
          continue;
        }

        if (/^\s{0,3}---+\s*$/.test(line)) {
          html.push('<p>────────</p>');
          index += 1;
          continue;
        }

        const paragraph = [line.trim()];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], index)) {
          paragraph.push(lines[index].trim());
          index += 1;
        }
        html.push(`<p>${actions.markdownInlineHtml(paragraph.join(' '))}</p>`);
      }
      return html.join('');
    }

    function renderMarkdown(markdown) {
      const escaped = actions.escapeHtml(markdown).replace(/\r\n?/g, '\n');
      const codeBlocks = [];
      let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => { const token = `@@CODE${codeBlocks.length}@@`; codeBlocks.push(`<pre><code data-lang="${lang}">${code.trim()}</code></pre>`); return token; });
      html = html.split('\n').map(line => {
        if (/^@@CODE\d+@@$/.test(line)) return line;
        if (/^### /.test(line)) return `<h3>${line.slice(4)}</h3>`;
        if (/^## /.test(line)) return `<h2>${line.slice(3)}</h2>`;
        if (/^# /.test(line)) return `<h1>${line.slice(2)}</h1>`;
        if (/^&gt; /.test(line)) return `<blockquote>${line.slice(5)}</blockquote>`;
        if (/^[-*] /.test(line)) return `<li>${line.slice(2)}</li>`;
        if (!line.trim()) return '';
        return `<p>${line}</p>`;
      }).join('\n').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      codeBlocks.forEach((block, index) => { html = html.replace(`@@CODE${index}@@`, block); }); return html;
    }
    return { memoContentText, sanitizeMemoContent, sanitizeRichNoteContent, looksLikeMarkdown, markdownInlineHtml, splitMarkdownTableRow, markdownToRichHtml, renderMarkdown };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createContent });
})(globalThis);
