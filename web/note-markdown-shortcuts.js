function createNoteMarkdownBindings() {
  const Delta = window.Quill.import('delta');
  const escaped = (text, index) => {
    let slashes = 0;
    while (index > 0 && text[--index] === '\\') slashes += 1;
    return slashes % 2 === 1;
  };
  const contextAt = (quill, range, context) => {
    const event = context.event;
    if (!quill.isEnabled() || range.length || event.isComposing || event.keyCode === 229
      || quill.selection.composing || event.altKey || event.ctrlKey || event.metaKey) return null;
    const [line, offset] = quill.getLine(range.index);
    if (!line || line.formats()['code-block']) return null;
    const start = quill.getIndex(line);
    const prefix = quill.getText(start, offset);
    // getText omits embeds; offsets must still refer to the original document.
    if (prefix.length !== offset) return null;
    return { line, offset, start, prefix };
  };
  const finish = (quill, delta, index) => {
    quill.history.cutoff();
    quill.updateContents(delta, 'user');
    quill.setSelection(index, 0, 'user');
    quill.history.cutoff();
    quill.scrollSelectionIntoView();
  };
  const transformBlock = (quill, state, format, value, space) => {
    const length = state.offset + (space ? 1 : 0);
    // Retain the typed space in history so one undo recovers the literal Markdown.
    if (space) quill.insertText(state.start + state.offset, ' ', 'user');
    const delta = new Delta().retain(state.start).delete(length)
      .retain(state.line.length() - length - 1).retain(1, { [format]: value });
    finish(quill, delta, state.start);
    return false;
  };
  return {
    // Handle the whole line instead of Quill's current text leaf (which changes with inline formatting).
    'list autofill': false,
    // 多级列表：光标在列表项的任意位置按 Tab 都缩进一级（Quill 默认只在行首缩进，行中插入制表符）。
    // Shift+Tab 同样在任意位置减少一级（下面的 indent 负责 Tab）。
    outdent: {
      key: 'Tab', shiftKey: true, format: ['blockquote', 'indent', 'list'],
      handler(range, context) {
        if (context.format.table || context.format['code-block']) return true;
        if (range.length === 0 && context.offset !== 0 && !context.format.list) return true;
        this.quill.format('indent', '-1', 'user');
        return false;
      }
    },
    indent: {
      key: 'Tab', format: ['blockquote', 'indent', 'list'],
      handler(range, context) {
        if (context.format.table || context.format['code-block']) return true;
        if (range.length === 0 && context.offset !== 0 && !context.format.list) return true;
        this.quill.format('indent', '+1', 'user');
        return false;
      }
    },
    'markdown block': {
      key: ' ', collapsed: true,
      handler(range, context) {
        const state = contextAt(this.quill, range, context);
        // Once a heading exists, spaces must not reinterpret its text as another block.
        if (!state || state.line.formats().table || state.line.formats().header
          || context.format.code || context.format.link) return true;
        const prefix = state.prefix.replace(/^ {0,3}/, '');
        const heading = /^(#{1,6})$/.exec(prefix);
        const task = /^(?:[-+*] )?\[([ xX]?)\]$/.exec(prefix);
        // 引用（包括要点块）里不能再套列表或标题：Quill 一行只能有一种块格式，转换会把这一行挤出引用。
        // 「1. 」「- 」等留作普通文字，导出 Markdown 时仍是引用里的列表。
        if (state.line.formats().blockquote && (heading || task || /^(?:[-+*]|\d{1,9}[.)])$/.test(prefix))) return true;
        if (heading) return transformBlock(this.quill, state, 'header', heading[1].length, true);
        if (prefix === '>') return transformBlock(this.quill, state, 'blockquote', true, true);
        if (/^[-+*]$/.test(prefix)) return transformBlock(this.quill, state, 'list', 'bullet', true);
        if (/^\d{1,9}[.)]$/.test(prefix)) return transformBlock(this.quill, state, 'list', 'ordered', true);
        if (task) return transformBlock(this.quill, state, 'list', /x/i.test(task[1]) ? 'checked' : 'unchecked', true);
        return true;
      }
    },
    'markdown code fence': {
      key: 'Enter', collapsed: true,
      handler(range, context) {
        const state = contextAt(this.quill, range, context);
        if (!state || state.line.statics.blotName !== 'block' || context.format.code || context.format.link
          || state.offset !== state.line.length() - 1) return true;
        const fence = /^ {0,3}(?:```|~~~)([\w-]{1,32})?$/.exec(state.prefix);
        if (!fence) return true;
        return transformBlock(this.quill, state, 'code-block', fence[1]?.toLowerCase() || true, false);
      }
    },
    'markdown inline': {
      key: ['*', '_', '~', '`'], shiftKey: null, collapsed: true,
      handler(range, context) {
        const quill = this.quill;
        const state = contextAt(quill, range, context);
        if (!state || context.format.code || context.format.link) return true;
        const text = state.prefix + context.event.key;
        const rules = [['**', 'bold'], ['__', 'bold'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic'], ['`', 'code']];
        for (const [marker, format] of rules) {
          if (!text.endsWith(marker)) continue;
          const end = text.length - marker.length;
          const start = text.lastIndexOf(marker, end - marker.length);
          if (start < 0 || escaped(text, start) || escaped(text, end) || text[start - 1] === marker[0]) continue;
          const body = text.slice(start + marker.length, end);
          if (!body || body.trim() !== body || body.includes(marker[0])) continue;
          // Underscores inside identifiers remain literal, including Unicode identifiers.
          if (marker[0] === '_' && /[\p{L}\p{N}_]/u.test(text[start - 1] || '')) continue;
          const preceding = text.slice(0, start);
          const openCode = preceding.split('').reduce((count, char, index) => count + (char === '`' && !escaped(preceding, index) ? 1 : 0), 0) % 2;
          if (format !== 'code' && openCode) continue;
          const index = state.start + start;
          const content = quill.getContents(index, range.index - index);
          if (content.ops.some(op => typeof op.insert !== 'string' || op.attributes?.code || op.attributes?.link)) continue;
          quill.insertText(range.index, context.event.key, 'user');
          const delta = new Delta().retain(index).delete(marker.length)
            .retain(body.length, { [format]: true }).delete(marker.length);
          const caret = range.index + 1 - marker.length * 2;
          finish(quill, delta, caret);
          // Continue typing after the closing marker without extending the converted style.
          quill.format(format, false, 'silent');
          return false;
        }
        return true;
      }
    }
  };
}
