(function expose(root) {
  const origin = 'https://memokeep.invalid';
  const route = '/notes/';
  const address = id => `${origin}${route}${encodeURIComponent(id)}`;
  function destination(href) {
    if (!href?.startsWith(origin + route)) return null;
    try {
      const url = new URL(href);
      if (url.origin !== origin || url.search || url.hash || url.pathname.slice(route.length).includes('/')) return null;
      return decodeURIComponent(url.pathname.slice(route.length)) || null;
    } catch { return null; }
  }

  function createNoteNavigation({ state, config, actions, env }) {
    const document = env.document;
    const saved = () => state.persistence.data;
    const getDocuments = () => [...(saved().documents || []), ...(saved().cardDocuments || [])];
    const editor = () => config.$('#inlineMarkdownNoteForm');
    const activeDocument = () => actions.documentById(state.editor.editingMarkdownDocumentId);
    const rich = () => {
      const node = config.$('#noteRichEditor');
      return node ? env.window.Quill?.find(node) : null;
    };
    const visibleTextarea = () => config.$('#notePlainTextContent') || config.$('#noteCardEditorPane:not(.hidden) #inlineMarkdownNoteContent');

    const passages = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, pre, .ql-code-block';
    function findNotePassage(note, terms) {
      if (!note) return null;
      const html = note.metadata?.noteContent;
      let blocks;
      if (html) {
        const template = document.createElement('template');
        template.innerHTML = html;
        for (const node of template.content.querySelectorAll('script, style')) node.remove();
        const leaves = [...template.content.querySelectorAll(passages)].filter(node => !node.querySelector(passages));
        blocks = leaves.length ? leaves.map(node => node.textContent) : [template.content.textContent];
      } else blocks = String(note.content || '').split(/\r?\n/);

      const lowerTerms = terms.map(term => term.normalize('NFKC').toLocaleLowerCase());
      let best = null;
      let score = 0;
      for (const block of blocks) {
        const text = block.trim();
        const normalized = text.normalize('NFKC').toLocaleLowerCase();
        const hits = lowerTerms.filter(term => normalized.includes(term));
        if (hits.length <= score) continue;
        const lower = text.toLocaleLowerCase();
        const quoteTerm = hits.find(term => lower.includes(term));
        const at = quoteTerm ? lower.indexOf(quoteTerm) : 0;
        const quote = quoteTerm ? text.slice(at, at + quoteTerm.length) : text.slice(0, 50);
        best = { text, quote };
        score = hits.length;
        if (score === lowerTerms.length) break;
      }
      return best;
    }

    async function openAndReveal(id, reveal) {
      if (!await actions.openWorkspaceNote(id)) return false;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (state.editor.editingMarkdownDocumentId !== id) return false;
        const result = reveal();
        if (result !== undefined) return result;
        await new Promise(resolve => env.setTimeout(resolve, 50));
      }
      return false;
    }

    function openNoteAtText(id, quote, passage) {
      return openAndReveal(id, () => env.window.MemoKeepNoteFind?.reveal(editor(), quote, passage));
    }

    function openIncomingReference(id, targetId) {
      return openAndReveal(id, () => {
        const quill = rich();
        if (quill && !visibleTextarea()) {
          const link = [...quill.root.querySelectorAll('a[href]')]
            .find(node => destination(node.getAttribute('href')) === targetId);
          if (!link) return undefined;
          link.scrollIntoView({ block: 'center' });
          link.animate?.([{ backgroundColor: 'var(--blue-soft)' }, { backgroundColor: 'transparent' }], { duration: 1500 });
          return true;
        }
        if (visibleTextarea()) return env.window.MemoKeepNoteFind?.reveal(editor(), address(targetId));
        return undefined;
      });
    }

    function linkedIds(note) {
      const ids = new Set();
      if (note.metadata?.noteContent) {
        const template = document.createElement('template');
        template.innerHTML = note.metadata.noteContent;
        for (const link of template.content.querySelectorAll('a[href]')) {
          const id = destination(link.getAttribute('href'));
          if (id) ids.add(id);
        }
      }
      if (note.metadata?.editorMode !== 'note') {
        for (const match of String(note.content || '').matchAll(/\]\((https:\/\/memokeep\.invalid\/notes\/[^)\s]+)\)/g)) {
          const id = destination(match[1]);
          if (id) ids.add(id);
        }
      }
      return ids;
    }

    function cardsFor(noteId) {
      const items = new Map((saved().items || []).map(item => [item.id, item.documentId]));
      const notebooks = new Map((saved().cardNotebooks || []).map(book => [book.id, book.sourceDocumentId]));
      return (saved().cards || []).filter(card => card.status !== 'deleted'
        && [card.sourceAnchor?.documentId, card.pointDocumentId, card.sourceDocumentId,
          items.get(card.knowledgeItemId), notebooks.get(card.cardNotebookId)].includes(noteId));
    }

    function list(section, title, entries, open) {
      const heading = document.createElement('h3');
      heading.textContent = `${title} · ${entries.length}`;
      section.append(heading);
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = '暂无记录';
        section.append(empty);
      }
      for (const entry of entries) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.referenceId = entry.id;
        button.textContent = entry.title || '未命名笔记';
        button.addEventListener('click', () => {
          section.closest('dialog').close();
          void open(entry.id);
        });
        section.append(button);
      }
    }

    function insertReference(target, noteId, quill, range, textarea) {
      if (state.editor.editingMarkdownDocumentId !== noteId || !editor()?.isConnected) return;
      const title = target.title || '未命名笔记';
      const href = address(target.id);
      if (quill && quill.root.isConnected) {
        const index = range?.index ?? Math.max(0, quill.getLength() - 1);
        const Delta = env.window.Quill.import('delta');
        quill.updateContents(new Delta().retain(index).delete(range?.length || 0).insert(title, { link: href }), 'user');
        quill.setSelection(index + title.length, 0, 'silent');
      } else if (textarea?.isConnected) {
        const label = title.replace(/[\[\]\\\r\n]/g, ' ');
        textarea.setRangeText(`[${label}](${href})`, range.start, range.end, 'end');
        textarea.dispatchEvent(new env.Event('input', { bubbles: true }));
        textarea.focus();
      }
    }

    function openReferences() {
      const note = activeDocument();
      if (!note) { actions.showToast('请先保存笔记'); return; }
      const textarea = visibleTextarea();
      const quill = textarea ? null : rich();
      const range = textarea ? { start: textarea.selectionStart, end: textarea.selectionEnd } : quill?.getSelection();
      const dialog = document.createElement('dialog');
      dialog.className = 'note-references-dialog';
      dialog.setAttribute('aria-labelledby', 'noteReferencesTitle');
      dialog.innerHTML = `<header><h2 id="noteReferencesTitle">笔记关联</h2><button type="button" aria-label="关闭">×</button></header>
        <form><label>添加笔记引用<input type="search" aria-label="筛选笔记" placeholder="按名称或知识库筛选">
          <select aria-label="选择要引用的笔记" required></select></label><button class="primary">插入引用</button></form>
        <section data-note-outgoing></section><section data-note-incoming></section><section data-note-related-cards></section>`;
      const notes = getDocuments().filter(item => item.id !== note.id);
      const byId = new Map(notes.map(item => [item.id, item]));
      const select = dialog.querySelector('select');
      const filter = dialog.querySelector('input');
      const choices = notes.map(item => {
        const folder = env.MemoKeepDirectoryTree?.label(saved().knowledgeBases || [], item.knowledgeBaseId);
        return { id: item.id, label: [folder, item.title || '未命名笔记'].filter(Boolean).join(' / ') };
      });
      const updateChoices = () => {
        const selected = select.value;
        const query = filter.value.trim().normalize('NFKC').toLocaleLowerCase();
        select.replaceChildren(new env.window.Option('选择笔记', ''));
        for (const item of choices.filter(item => item.label.normalize('NFKC').toLocaleLowerCase().includes(query))) {
          select.add(new env.window.Option(item.label, item.id));
        }
        if ([...select.options].some(option => option.value === selected)) select.value = selected;
      };
      filter.addEventListener('input', updateChoices);
      updateChoices();
      dialog.querySelector('form').onsubmit = event => {
        event.preventDefault();
        const target = byId.get(select.value);
        if (target) { dialog.close(); insertReference(target, note.id, quill, range, textarea); }
      };
      dialog.querySelector('header button').onclick = () => dialog.close();
      const live = quill ? { metadata: { editorMode: 'note', noteContent: quill.root.innerHTML } }
        : textarea ? { content: textarea.value } : note;
      const outgoing = [...linkedIds(live)].map(id => byId.get(id) || { id, title: '引用的笔记已移除' });
      list(dialog.querySelector('[data-note-outgoing]'), '已引用', outgoing, actions.openWorkspaceNote);
      list(dialog.querySelector('[data-note-incoming]'), '引用此笔记', notes.filter(item => linkedIds(item).has(note.id)),
        id => openIncomingReference(id, note.id));
      const cards = cardsFor(note.id);
      list(dialog.querySelector('[data-note-related-cards]'), '关联卡片', cards.map(card => ({ id: card.id, title: card.question })), id => {
        const card = cards.find(item => item.id === id);
        env.application.views.cardDetail.openCardDetail(card);
      });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      document.body.append(dialog);
      dialog.showModal();
    }

    function refreshNoteReferences() {
      const view = config.$('#librariesView');
      for (const link of view?.querySelectorAll(`a[href^="${origin}${route}"]`) || []) {
        const title = actions.documentById(destination(link.getAttribute('href')))?.title || '引用的笔记已移除';
        if (link.dataset.memokeepTitle === title) continue;
        link.dataset.memokeepTitle = title;
        link.setAttribute('aria-label', title);
      }
    }

    function bindNoteNavigation() {
      document.addEventListener('mousedown', event => {
        if (event.target.closest?.('[data-open-note-references]')) event.preventDefault();
      });
      document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]');
        const id = destination(link?.getAttribute('href'));
        if (id) {
          event.preventDefault(); event.stopImmediatePropagation();
          void actions.openWorkspaceNote(id);
        } else if (event.target.closest?.('[data-open-note-references]')) openReferences();
      }, true);
      const view = config.$('#librariesView');
      if (!view || !env.MutationObserver) return;
      new env.MutationObserver(refreshNoteReferences).observe(view, { childList: true, characterData: true, subtree: true });
    }
    return { bindNoteNavigation, refreshNoteReferences, findNotePassage, openNoteAtText };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createNoteNavigation });
})(globalThis);
