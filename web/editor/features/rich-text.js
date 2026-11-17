(function expose(root) {
  // 笔记图片按 ID 存放，内容不会变：读过一次就留在内存里，切换标签时不再走 IPC 重新读整张图，
  // 正文可以和编辑器在同一帧里出现（否则先闪一下空白再填内容）。按总大小淘汰最久没用的。
  const noteImageCache = new Map();
  const NOTE_IMAGE_CACHE_LIMIT = 96 * 1024 * 1024;
  let noteImageCacheSize = 0;
  const cachedNoteImage = id => {
    const hit = noteImageCache.get(id);
    if (hit) { noteImageCache.delete(id); noteImageCache.set(id, hit); }
    return hit || null;
  };
  const rememberNoteImage = (id, preview) => {
    if (!id || !preview?.dataUrl || noteImageCache.has(id)) return;
    noteImageCache.set(id, preview);
    noteImageCacheSize += preview.dataUrl.length;
    for (const [oldId, old] of noteImageCache) {
      if (noteImageCacheSize <= NOTE_IMAGE_CACHE_LIMIT || oldId === id) break;
      noteImageCache.delete(oldId);
      noteImageCacheSize -= old.dataUrl.length;
    }
  };
  let prefetchingNoteImages = false;
  function createEditorRichText({ state, config, actions, env, session, features }) {
    let creatingCard = false;
    const createCardFromNote = async (selectedText, selectedRange = null) => {
      if (creatingCard || !features.isCurrentEditor() || config.$('#cardDialog')?.open) return false;
      creatingCard = true;
      const editorToken = session.editorToken;
      const savedDocument = () => [...state.persistence.data.documents, ...(state.persistence.data.cardDocuments || [])]
        .find(document => document.id === session.target?.id);
      try {
        let quote = typeof selectedText === 'string' ? selectedText : '';
        // 制卡标记（design/prototype/note-card-marks-20261112.md）：记下这段原文在笔记里的位置。
        let anchorRange = selectedRange && selectedRange.length ? { ...selectedRange } : null;
        if (selectedText === undefined) {
          if (session.editorMode === 'note' && session.richEditor) {
            const range = session.richEditor.getSelection() || session.lastRichSelection;
            if (range?.length) { quote = session.richEditor.getText(range.index, range.length); anchorRange = { index: range.index, length: range.length }; }
          } else if (session.editor && session.editor.selectionEnd > session.editor.selectionStart) {
            quote = session.editor.value.slice(session.editor.selectionStart, session.editor.selectionEnd);
          }
        }
        quote = quote.trim();
        if (!savedDocument() || session.saveInFlight || state.editor.activeNoteEditorHasChanges?.()) {
          const saved = await session.noteSaveSession.save({ quiet: true });
          if (!features.isCurrentEditor() || session.editorToken !== editorToken) return false;
          if (!saved || state.editor.activeNoteEditorHasChanges?.()) {
            actions.showToast('笔记尚未保存，请保存后再制卡', true);
            return false;
          }
        }
        if (!features.isCurrentEditor() || session.editorToken !== editorToken || config.$('#cardDialog')?.open) return false;
        const sourceDocument = savedDocument();
        if (!sourceDocument) {
          actions.showToast('来源笔记已不存在，请重新打开笔记', true);
          return false;
        }
        const title = sourceDocument.title || '当前笔记';
        const anchors = env.window?.MemoKeepCardAnchors;
        let sourceAnchor = null;
        if (anchors && anchorRange && session.editorMode === 'note' && session.richEditor?.getContents) {
          const text = anchors.textOf(session.richEditor.getContents());
          const heads = session.richEditor.getLines().filter(line => line.formats?.().header).map(line => ({ index: session.richEditor.getIndex(line), text: line.domNode.textContent.trim() }));
          sourceAnchor = anchors.create(text, anchorRange.index, anchorRange.length, { documentId: sourceDocument.id, heading: anchors.headingAt(heads, anchorRange.index) });
        }
        env.application.views.cardEditor.openCardDialog(null, {
          sourceAnchor,
          question: '', answer: quote, sourceQuote: quote, sourceQuotePlainText: true,
          knowledgeBaseId: sourceDocument.knowledgeBaseId || session.editorLibraryId,
          sourceDocumentId: sourceDocument.id, sourceTitle: title, tags: [title]
        });
        return true;
      } catch (error) {
        if (features.isCurrentEditor() && session.editorToken === editorToken) actions.showToast(`无法制卡：${error.message || '请稍后重试'}`, true);
        return false;
      } finally {
        creatingCard = false;
      }
    };

    // 其他已打开标签里的图片趁空闲先读进缓存，第一次切过去也不用等 IPC。
    const prefetchOpenTabImages = () => {
      const read = config.desktop?.readNoteImage, idle = env.window.requestIdleCallback?.bind(env.window);
      if (!read || !idle || prefetchingNoteImages) return;
      const data = state.persistence.data, ids = [];
      for (const tab of env.openNoteTabs || []) {
        const document = [...(data.documents || []), ...(data.cardDocuments || [])].find(item => item.id === tab.id);
        for (const match of String(document?.metadata?.noteContent || '').matchAll(/data-memokeep-image-id="([^"]+)"/g)) {
          if (!noteImageCache.has(match[1]) && !ids.includes(match[1])) ids.push(match[1]);
        }
      }
      if (!ids.length) return;
      prefetchingNoteImages = true;
      const next = () => idle(async () => {
        const id = ids.shift();
        if (!id || noteImageCacheSize > NOTE_IMAGE_CACHE_LIMIT * 0.8) { prefetchingNoteImages = false; return; }
        if (!noteImageCache.has(id)) rememberNoteImage(id, await read(id).catch(() => null));
        next();
      }, { timeout: 2000 });
      next();
    };

    const loadRichNote = async content => {
      if (!session.richEditor) return;
      session.richEditorLoading = true;
      try {
        session.richEditor.setText('', 'silent');
        if (!content) return;
        if (!/<[a-z][\s\S]*>/i.test(content)) {
          session.richEditor.setText(content, 'silent');
          return;
        }

        const template = env.window.document.createElement('template');
        template.innerHTML = actions.sanitizeRichNoteContent(content);
        const storedImages = [...template.content.querySelectorAll('img')].map(image => ({
          element: image,
          id: image.dataset.memokeepImageId,
          source: image.getAttribute('src') || '',
          fileName: image.dataset.fileName || image.alt || '图片'
        }));
        const readImage = async image => {
          const cached = image.id && cachedNoteImage(image.id);
          if (cached) return cached;
          if (!image.id || !config.desktop?.readNoteImage) return /^https?:\/\//i.test(image.source) ? { dataUrl: image.source, fileName: image.fileName } : null;
          const preview = await config.desktop.readNoteImage(image.id).catch(() => null);
          rememberNoteImage(image.id, preview);
          return preview;
        };
        const resolvedImages = await Promise.all(storedImages.map(async image => ({ ...image, preview: await readImage(image) })));
        if (!features.isCurrentEditor()) return;
        resolvedImages.forEach(image => {
          if (image.preview?.dataUrl) image.element.setAttribute('src', image.preview.dataUrl);
          else image.element.replaceWith('[图片不可用]');
        });
        // Restore the complete document; paste conversion drops its final empty paragraph.
        session.richEditor.setContents(session.richEditor.clipboard.convertHTML(template.innerHTML), 'silent');
        prefetchOpenTabImages();
        const editorImages = [...session.richEditor.root.querySelectorAll('img')];
        resolvedImages.filter(image => image.preview?.dataUrl).forEach((image, index) => {
          const editorImage = editorImages[index];
          if (!editorImage) return;
          if (image.id) editorImage.dataset.memokeepImageId = image.id;
          editorImage.dataset.fileName = image.preview.fileName || image.fileName;
          editorImage.alt = image.preview.fileName || image.fileName;
        });
      } finally {
        session.richEditorLoading = false;
      }
    };

    const insertRichNoteImages = async files => {
      const imageFiles = [...files].filter(file => file?.type?.startsWith('image/'));
      if (!imageFiles.length) return;
      if (!config.desktop?.saveNoteImage || !config.desktop?.readNoteImage) {
        actions.showToast('当前环境不支持插入本地图片', true);
        return;
      }
      const range = session.richEditor.getSelection(true) || { index: session.richEditor.getLength() - 1, length: 0 };
      if (range.length) session.richEditor.deleteText(range.index, range.length, 'user');
      let insertIndex = range.index;
      try {
        for (const file of imageFiles) {
          const bytes = new env.Uint8Array(await file.arrayBuffer());
          const savedImage = await config.desktop.saveNoteImage({ bytes, mimeType: file.type, name: file.name || '笔记图片' });
          session.richDraftImageIds.add(savedImage.id);
          const preview = await config.desktop.readNoteImage(savedImage.id);
          rememberNoteImage(savedImage.id, preview);
          if (!preview?.dataUrl) throw new Error('图片保存后无法读取。');
          const Delta = env.window.Quill.import('delta');
          env.application.editor.factories.createQuillTransactions().insertImage(session.richEditor, Delta, insertIndex, preview.dataUrl, {
            imageId: savedImage.id,
            imageName: preview.fileName || savedImage.fileName,
            alt: preview.fileName || savedImage.fileName
          });
          insertIndex += 1;
        }
        session.richEditor.setSelection(insertIndex, 0, 'silent');
        actions.showToast(`已插入 ${imageFiles.length} 张图片`);
      } catch (error) {
        actions.showToast(`插入图片失败：${error.message}`, true);
      }
    };

    const applyEditorMode = (focus = false) => {
      features.scheduleOutlineHoverTargetPosition();
      config.$('#inlineMarkdownNoteForm').dataset.editorMode = session.editorMode;
      config.$('#librariesView').classList.toggle('editing-card-note', session.editorMode === 'card');
      const title = config.$('#inlineMarkdownNoteTitle');
      if (session.editorMode === 'card') config.$('.card-editor-heading').prepend(title);
      else config.$('.note-document-heading').prepend(title);
      const tagControl = config.$('#inlineMarkdownNoteForm .note-tag-control');
      if (tagControl) title.after(tagControl);
      session.canvas.classList.toggle('hidden', session.editorMode !== 'card');
      session.richEditorPane.classList.toggle('hidden', session.editorMode !== 'note');
      env.application.views.tabs.mountNoteTabControls();
      session.layoutSignature = '';
      features.renderCardEditorLayout();
      features.renderNoteOutline();
      if (focus) {
        if (session.editorMode === 'note') session.richEditor?.focus();
        else session.editor.focus();
      }
    };

    const handleModeMenuOutsideClick = event => {
      if (!event.target.closest('.note-history-control')) features.closeVersionMenu();
      if (!event.target.closest('.note-text-color-control') && !event.target.closest('#noteTextColorMenu')) {
        session.textColorMenu?.hidePopover?.();
        session.textColorButton?.setAttribute('aria-expanded', 'false');
      }
      if (!event.target.closest('.note-background-color-control') && !event.target.closest('#noteBackgroundColorMenu')) {
        session.backgroundColorMenu?.hidePopover?.();
        session.backgroundColorButton?.setAttribute('aria-expanded', 'false');
      }
    };

    const initializeRichNoteEditor = async () => {
      await actions.loadNoteEditorAssets();
      if (!features.isCurrentEditor()) return;
      if (typeof env.window.Quill !== 'function') {
        actions.showToast('富文本组件加载失败，请重新打开应用', true);
        return;
      }
      // indent：多级列表（粘贴的嵌套列表、Tab 缩进）靠它保留层级；不注册的话所有列表项都会被压成一级。
      const richFormats = ['header', 'bold', 'italic', 'underline', 'strike', 'color', 'background', 'align', 'list', 'indent', 'blockquote', 'code', 'code-block', 'link', 'image', 'table'];
      const noteRegistry = env.createNoteImageRegistry(env.window.Quill, richFormats);
      env.registerNoteLinkCard(noteRegistry, env.window.Quill);
      env.registerNoteCodeStyle(env.window.Quill, noteRegistry, { getDefault: () => state.persistence.data.settings.noteCodeStyle, isLoading: () => session.richEditorLoading });
      session.richEditor = new env.window.Quill('#noteRichEditor', {
        theme: 'snow',
        placeholder: '开始撰写笔记，支持 Markdown 快捷输入…',
        registry: noteRegistry,
        modules: { toolbar: '#noteRichToolbar', table: true, keyboard: { bindings: { 'code exit': false, ...env.createNoteMarkdownBindings() } } }
      });
      session.richContentObserver = new env.MutationObserver(records => { if (records.length) session.serializedRichNote = null; });
      env.bindNotePlainPaste(session.richEditor, actions.showToast);
      session.richContentObserver.observe(session.richEditor.root, { subtree: true, childList: true, characterData: true, attributes: true });
      const enhancementRuntime = env.MemoKeepRuntime.createRuntime({ features: env.MemoKeepFeatures, hasEntitlement: id => actions.isPluginEnabled?.(id) ?? true });
      const enhancements = env.MemoKeepEditorEnhancements.create(enhancementRuntime);
      env.registerNoteImageClipboard(session.richEditor);
      env.registerNoteTableClipboard(session.richEditor);
      session.disposeNoteImageTools = enhancements.bindImages(session.richEditor, session.richEditorColumn);
      session.disposeNoteTableResize = enhancements.bindTables(session.richEditor, session.richEditorColumn);
      env.registerNoteDiagramClipboard(session.richEditor);
      session.disposeNoteLinkPaste = env.bindNoteLinkPaste(session.richEditor);
      session.noteMermaidEditor = env.MemoKeepDiagramAuthoring.create(session.richEditor, enhancementRuntime, {
        confirmDiscard: options => actions.showConfirmDialog(options)
      });
      config.$('#insertNoteMermaidButton').onmousedown = event => event.preventDefault();
      config.$('#insertNoteMermaidButton').onclick = event => session.noteMermaidEditor.insert(null, event.currentTarget);
      env.registerNoteCodeClipboard(session.richEditor);
      const codeStyles = enhancements.bindCode(session.richEditor, session.richEditorColumn, session.codeCopyLayer, {
        saveDefault: async style => {
          const previous = state.persistence.data.settings.noteCodeStyle;
          state.persistence.data.settings.noteCodeStyle = env.normalizeNoteCodeStyle(style);
          try { await env.application.persistence.save(); }
          catch (error) { state.persistence.data.settings.noteCodeStyle = previous; throw error; }
        },
        copy: actions.copyTextToClipboard, notify: actions.showToast
      });
      features.renderCodeCopyButtons = codeStyles.render;
      session.disposeNoteCodeStyles = codeStyles.dispose;
      let preferredToolbarExpanded = env.localStorage.getItem('memokeep-note-toolbar-expanded') === 'true';
      const setToolbarExpanded = expanded => {
        session.richToolbar.classList.toggle('is-expanded', expanded);
        session.toolbarToggleButton.setAttribute('aria-expanded', String(expanded));
        const label = expanded ? '收起格式工具栏' : '展开格式工具栏';
        session.toolbarToggleButton.setAttribute('aria-label', label);
        if (session.toolbarToggleButton.dataset.tooltip) session.toolbarToggleButton.dataset.tooltip = label;
      };
      const refreshToolbarOverflow = () => {
        const content = session.richToolbar.querySelector('.note-rich-toolbar-content');
        session.richToolbar.classList.remove('can-toggle');
        const groups = [...content.children].filter(element => !element.hidden);
        const firstRowTop = groups[0]?.getBoundingClientRect().top;
        const hasOverflow = firstRowTop !== undefined
        && groups.some(element => element.getBoundingClientRect().top > firstRowTop + 3);
        session.richToolbar.classList.toggle('can-toggle', hasOverflow);
        setToolbarExpanded(hasOverflow && preferredToolbarExpanded);
      };
      // 先按「不展开」排版，等下面量过是否换行再决定，避免新标签第一帧闪出展开后的两行高度。
      setToolbarExpanded(false);
      session.toolbarToggleButton.onclick = () => {
        const expanded = !session.richToolbar.classList.contains('is-expanded');
        preferredToolbarExpanded = expanded;
        setToolbarExpanded(expanded);
        env.localStorage.setItem('memokeep-note-toolbar-expanded', String(expanded));
      };
      session.richToolbar.querySelectorAll('.ql-picker').forEach(picker => {
        const source = picker.nextElementSibling?.matches('select') ? picker.nextElementSibling : null;
        const chineseTitle = source?.title || source?.getAttribute('aria-label');
        const label = picker.querySelector('.ql-picker-label');
        if (label && chineseTitle) {
          label.title = chineseTitle;
          label.setAttribute('aria-label', chineseTitle);
        }
        picker.querySelectorAll('.ql-picker-item').forEach(item => {
          const optionTitle = item.dataset.label || chineseTitle;
          if (optionTitle) item.title = optionTitle;
        });
        if (picker.classList.contains('ql-header')) {
          picker.removeAttribute('title');
          // Keep the editor selection and its selected heading visible while opening the menu.
          picker.onmousedown = event => {
            if (event.target.closest('.ql-picker-label')) event.preventDefault();
          };
          picker.querySelectorAll('.ql-picker-item').forEach(item => {
            item.removeAttribute('title');
            item.setAttribute('aria-label', item.dataset.label);
            const level = env.window.document.createElement('span');
            level.className = 'note-heading-level';
            level.textContent = item.dataset.value ? `H${item.dataset.value}` : 'Aa';
            level.setAttribute('aria-hidden', 'true');
            item.appendChild(level);
          });
        }
      });
      // 列表和引用四个按钮用同一套线性图标（Quill 自带的粗细、实心/空心不统一）。
      // 参考常见编辑器的列表图标：细线（1.5）、小标记、标记和文字线之间留空。
      const thin = 'style="stroke-width:1.5"', fine = 'style="stroke-width:1.15"';
      const rows = x => `<path class="ql-stroke" ${thin} d="M${x} 4.5h8.5M${x} 9h8.5M${x} 13.5h8.5"/>`;
      const listIcons = {
        'ordered': rows(7) + `<path class="ql-stroke" ${fine} d="M2.9 3.4 4 2.8v3.5M2.6 11.9c.2-.5.6-.8 1.2-.8.7 0 1.1.4 1.1 1 0 .5-.3.8-.7 1.2l-1.6 1.6h2.4"/>`,
        'bullet': rows(7) + '<circle class="ql-fill" cx="3.4" cy="4.5" r="1.05"/><circle class="ql-fill" cx="3.4" cy="9" r="1.05"/><circle class="ql-fill" cx="3.4" cy="13.5" r="1.05"/>',
        'check': rows(7.5) + `<path class="ql-stroke" ${fine} d="m2.2 4.5 1.1 1.1 2.1-2.3M2.2 9l1.1 1.1 2.1-2.3"/><rect class="ql-stroke" ${fine} x="2.3" y="12" width="3" height="3" rx=".7"/>`,
        'blockquote': `<path class="ql-stroke" ${thin} d="M3 3.5v11M7 4.5h8.5M7 9h8.5M7 13.5h6"/>`
      };
      session.richToolbar.querySelectorAll('button.ql-list, button.ql-blockquote').forEach(button => {
        const icon = listIcons[button.classList.contains('ql-blockquote') ? 'blockquote' : button.value];
        if (icon) button.innerHTML = `<svg viewBox="0 0 18 18" aria-hidden="true">${icon}</svg>`;
      });
      const tooltipTargets = session.richToolbar.querySelectorAll('button[aria-label], .ql-picker-label[aria-label]');
      tooltipTargets.forEach(target => {
        target.dataset.tooltip = target.getAttribute('aria-label');
        target.removeAttribute('title');
      });
      const hideToolbarTooltip = () => {
        session.toolbarTooltip?.remove();
        session.toolbarTooltip = null;
      };
      const showToolbarTooltip = target => {
        hideToolbarTooltip();
        const label = target?.dataset.tooltip;
        if (!label || target.closest('.ql-picker.ql-expanded')) return;
        session.toolbarTooltip = env.window.document.createElement('div');
        session.toolbarTooltip.className = 'note-toolbar-tooltip';
        session.toolbarTooltip.textContent = label;
        env.window.document.body.appendChild(session.toolbarTooltip);
        const targetRect = target.getBoundingClientRect();
        const tooltipRect = session.toolbarTooltip.getBoundingClientRect();
        const left = Math.min(
        env.window.innerWidth - tooltipRect.width - 8,
        Math.max(8, targetRect.left + (targetRect.width - tooltipRect.width) / 2)
        );
        session.toolbarTooltip.style.left = `${left}px`;
        // 提示放在按钮上方：放下方会被鼠标指针挡住。顶部放不下时才退到下方。
        const above = targetRect.top - tooltipRect.height - 8;
        session.toolbarTooltip.classList.toggle('is-below', above < 4);
        session.toolbarTooltip.style.top = `${above < 4 ? targetRect.bottom + 8 : above}px`;
      };
      session.richToolbar.onmouseover = event => {
        const target = event.target.closest('[data-tooltip]');
        if (target && !target.contains(event.relatedTarget)) showToolbarTooltip(target);
      };
      session.richToolbar.onmouseout = event => {
        const target = event.target.closest('[data-tooltip]');
        if (target && !target.contains(event.relatedTarget)) hideToolbarTooltip();
      };
      session.richToolbar.onfocusin = event => showToolbarTooltip(event.target.closest('[data-tooltip]'));
      session.richToolbar.onfocusout = hideToolbarTooltip;
      session.richToolbar.onmousedown = hideToolbarTooltip;
      session.richToolbar.onkeydown = hideToolbarTooltip;
      session.toolbarResizeObserver = new env.ResizeObserver(refreshToolbarOverflow);
      session.toolbarResizeObserver.observe(session.richToolbar);
      // 同步量一次，让新编辑器第一帧就是正确的折叠状态；下一帧再量一次兜底（布局可能还没稳定）。
      refreshToolbarOverflow();
      env.window.requestAnimationFrame(refreshToolbarOverflow);
      session.tableModule = session.richEditor.getModule('table');
      const richHistory = session.richEditor.getModule('history');
      const undoButton = config.$('#undoNoteButton');
      const redoButton = config.$('#redoNoteButton');
      const formatPainterButton = config.$('#formatPainterButton');
      let formatPainterFormats = null;
      let slashCommandState = null;
      let slashCommandIndex = 0;
      const slashCommands = [
        { id: 'paragraph', label: '正文', group: '基础', icon: 'T', keywords: '正文 normal text' },
        ...Array.from({ length: 6 }, (_item, index) => ({ id: `heading-${index + 1}`, label: `标题 ${index + 1}`, group: '基础', icon: `H${index + 1}`, keywords: `标题 h${index + 1}` })),
        { id: 'bullet', label: '无序列表', group: '基础', icon: '•', keywords: '列表 无序 bullet' },
        { id: 'ordered', label: '有序列表', group: '基础', icon: '1.', keywords: '列表 有序 ordered' },
        { id: 'task', label: '任务列表', group: '基础', icon: '☑', keywords: '任务 待办 checklist' },
        { id: 'quote', label: '引用', group: '基础', icon: '❞', keywords: '引用 quote' },
        { id: 'code', label: '代码块', group: '插入', icon: '</>', keywords: '代码 code' },
        { id: 'link', label: '链接', group: '插入', icon: '↗', keywords: '链接 link' },
        { id: 'image', label: '图片', group: '插入', icon: '▧', keywords: '图片 image' },
        { id: 'table', label: '表格', group: '插入', icon: '▦', keywords: '表格 table' },
        { id: 'mermaid', label: '图表 · Mermaid', group: '插入', icon: '◇', keywords: 'mermaid 图表 流程图 架构图 拓扑图 时序图 思维导图 类图 ER diagram flowchart architecture topology' },
        { id: 'clean', label: '清除格式', group: '其他', icon: 'Tx', keywords: '清除 格式 clean' }
      ];
      const recentSlashCommandIds = () => {
        try { return JSON.parse(env.localStorage.getItem('memokeep-recent-slash-commands') || '[]').slice(0, 3); }
        catch { return []; }
      };
      const closeRichSlashMenu = () => {
        session.richSlashMenu.classList.add('hidden');
        session.richSlashMenu.innerHTML = '';
        slashCommandState = null;
        slashCommandIndex = 0;
      };
      session.disposeNoteBlockNavigation = env.bindNoteBlockNavigation(session.richEditor, session.richEditorColumn, closeRichSlashMenu);
      const visibleSlashCommands = query => {
        const normalized = query.trim().toLowerCase();
        return normalized ? slashCommands.filter(command => `${command.label} ${command.keywords}`.toLowerCase().includes(normalized)) : slashCommands;
      };
      const renderRichSlashMenu = () => {
        if (!slashCommandState) return;
        const commands = visibleSlashCommands(slashCommandState.query);
        if (!commands.length) { closeRichSlashMenu(); return; }
        slashCommandIndex = Math.min(slashCommandIndex, commands.length - 1);
        const recentIds = recentSlashCommandIds();
        const groups = slashCommandState.query
        ? [['搜索结果', commands]]
        : [['最近使用', recentIds.map(id => commands.find(command => command.id === id)).filter(Boolean)], ['基础', commands.filter(command => command.group === '基础')], ['插入', commands.filter(command => command.group === '插入')], ['其他', commands.filter(command => command.group === '其他')]];
        session.richSlashMenu.innerHTML = groups.filter(([_label, items]) => items.length).map(([label, items]) => `
        <section><span>${label}</span><div>${items.map(command => {
            const index = commands.indexOf(command);
            const selected = index === slashCommandIndex;
            return `<button type="button" role="option" data-rich-slash-command="${command.id}" data-command-index="${index}" aria-selected="${selected}" class="${selected ? 'is-selected' : ''}"><i>${command.icon}</i><strong>${command.label}</strong></button>`;
          }).join('')}</div></section>`).join('');
        const bounds = session.richEditor.getBounds(slashCommandState.start);
        const columnRect = session.richEditorColumn.getBoundingClientRect();
        const editorRect = session.richEditor.root.getBoundingClientRect();
        session.richSlashMenu.style.left = `${Math.max(10, Math.min(session.richEditorColumn.clientWidth - 292, editorRect.left - columnRect.left + bounds.left))}px`;
        session.richSlashMenu.style.top = `${editorRect.top - columnRect.top + bounds.top + bounds.height + 8}px`;
        session.richSlashMenu.classList.remove('hidden');
        session.richSlashMenu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
      };
      const refreshRichSlashMenu = () => {
        const range = session.richEditor.getSelection();
        if (!range || range.length || session.richEditor.getLine(range.index)[0]?.formats()['code-block']) { closeRichSlashMenu(); return; }
        const lineStart = session.richEditor.getText(0, range.index).lastIndexOf('\n') + 1;
        const line = session.richEditor.getText(lineStart, range.index - lineStart);
        const match = line.match(/^(\s*)\/([^\s/]*)$/);
        if (!match) { closeRichSlashMenu(); return; }
        slashCommandState = { start: lineStart + match[1].length, length: match[2].length + 1, query: match[2] };
        slashCommandIndex = 0;
        renderRichSlashMenu();
      };
      const runRichSlashCommand = id => {
        const state = slashCommandState;
        const command = slashCommands.find(item => item.id === id);
        if (!state || !command) return;
        closeRichSlashMenu();
        if (id === 'mermaid') {
          session.noteMermaidEditor.insert({ index: state.start, length: state.length });
          return;
        }
        session.richEditor.deleteText(state.start, state.length, 'user');
        session.richEditor.setSelection(state.start, 0, 'silent');
        if (id === 'paragraph') session.richEditor.formatLine(state.start, 1, 'header', false, 'user');
        else if (id.startsWith('heading-')) session.richEditor.formatLine(state.start, 1, 'header', Number(id.slice(-1)), 'user');
        else if (id === 'bullet') session.richEditor.formatLine(state.start, 1, 'list', 'bullet', 'user');
        else if (id === 'ordered') session.richEditor.formatLine(state.start, 1, 'list', 'ordered', 'user');
        else if (id === 'task') session.richEditor.formatLine(state.start, 1, 'list', 'unchecked', 'user');
        else if (id === 'quote') session.richEditor.formatLine(state.start, 1, 'blockquote', true, 'user');
        else if (id === 'code') session.richEditor.formatLine(state.start, 1, 'code-block', true, 'user');
        else if (id === 'link') {
          session.richEditor.insertText(state.start, '链接', 'user');
          session.richEditor.setSelection(state.start, 2, 'silent');
          session.richToolbar.querySelector('.ql-link')?.click();
        } else if (id === 'image') session.richImageInput.click();
        else if (id === 'table') session.tableModule?.insertTable(3, 3);
        else if (id === 'clean') session.richEditor.removeFormat(state.start, 1, 'user');
        env.localStorage.setItem('memokeep-recent-slash-commands', JSON.stringify([id, ...recentSlashCommandIds().filter(item => item !== id)].slice(0, 3)));
        if (!['link', 'image'].includes(id)) session.richEditor.focus();
      };
      session.richSlashMenu.onclick = event => {
        const option = event.target.closest('[data-rich-slash-command]');
        if (option) runRichSlashCommand(option.dataset.richSlashCommand);
      };
      session.richSlashMenu.onmousemove = event => {
        const option = event.target.closest('[data-command-index]');
        if (!option) return;
        slashCommandIndex = Number(option.dataset.commandIndex);
        session.richSlashMenu.querySelectorAll('[data-command-index]').forEach(item => {
          const selected = Number(item.dataset.commandIndex) === slashCommandIndex;
          item.classList.toggle('is-selected', selected);
          item.setAttribute('aria-selected', String(selected));
        });
      };
      session.richEditor.root.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (session.richSlashMenu.classList.contains('hidden')) return;
        const commands = visibleSlashCommands(slashCommandState?.query || '');
        if (event.key === 'Escape') { event.preventDefault(); closeRichSlashMenu(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          slashCommandIndex = (slashCommandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length;
          renderRichSlashMenu();
        } else if (event.key === 'Enter' && commands[slashCommandIndex]) {
          event.preventDefault();
          runRichSlashCommand(commands[slashCommandIndex].id);
        }
      }, true);
      let recentTextColors = [];
      try {
        recentTextColors = JSON.parse(env.localStorage.getItem('memokeep-recent-text-colors') || '[]')
        .filter(color => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 10);
      } catch {
        env.localStorage.removeItem('memokeep-recent-text-colors');
      }
      const renderRecentTextColors = () => {
        const recent = config.$('#noteRecentTextColors');
        recent.innerHTML = recentTextColors.length
        ? recentTextColors.map(color => `<button type="button" data-note-text-color="${color}" aria-label="最近使用颜色 ${color}" style="--swatch:${color}"></button>`).join('')
        : '<span>暂无</span>';
      };
      const closeTextColorMenu = () => {
        session.textColorMenu.hidePopover?.();
        session.textColorButton.setAttribute('aria-expanded', 'false');
      };
      const applyTextColor = color => {
        const range = session.richEditor.getSelection() || session.lastRichSelection;
        if (!range) return;
        session.richEditor.setSelection(range.index, range.length, 'silent');
        if (range.length) session.richEditor.formatText(range.index, range.length, 'color', color || false, 'user');
        else session.richEditor.format('color', color || false, 'user');
        if (color) {
          recentTextColors = [color, ...recentTextColors.filter(item => item !== color)].slice(0, 10);
          env.localStorage.setItem('memokeep-recent-text-colors', JSON.stringify(recentTextColors));
        }
        session.textColorButton.style.setProperty('--note-text-color', color || '#2c3035');
        renderRecentTextColors();
        closeTextColorMenu();
        session.richEditor.focus();
      };
      renderRecentTextColors();
      session.textColorButton.onclick = event => {
        event.stopPropagation();
        const opening = !session.textColorMenu.matches(':popover-open');
        if (!opening) { closeTextColorMenu(); return; }
        session.textColorMenu.showPopover?.();
        const rect = session.textColorButton.getBoundingClientRect();
        session.textColorMenu.style.left = `${Math.max(8, Math.min(env.window.innerWidth - 278, rect.left))}px`;
        session.textColorMenu.style.top = `${rect.bottom + 6}px`;
        session.textColorButton.setAttribute('aria-expanded', 'true');
      };
      session.textColorMenu.onclick = event => {
        const colorOption = event.target.closest('[data-note-text-color]');
        if (colorOption) applyTextColor(colorOption.dataset.noteTextColor);
      };
      config.$('#noteMoreTextColor').onclick = () => config.$('#noteCustomTextColor').click();
      config.$('#noteCustomTextColor').oninput = event => applyTextColor(event.target.value);
      let recentBackgroundColors = [];
      try {
        recentBackgroundColors = JSON.parse(env.localStorage.getItem('memokeep-recent-background-colors') || '[]')
        .filter(color => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 10);
      } catch {
        env.localStorage.removeItem('memokeep-recent-background-colors');
      }
      const renderRecentBackgroundColors = () => {
        const recent = config.$('#noteRecentBackgroundColors');
        recent.innerHTML = recentBackgroundColors.length
        ? recentBackgroundColors.map(color => `<button type="button" data-note-background-color="${color}" aria-label="最近使用背景颜色 ${color}" style="--swatch:${color}"></button>`).join('')
        : '<span>暂无</span>';
      };
      const closeBackgroundColorMenu = () => {
        session.backgroundColorMenu.hidePopover?.();
        session.backgroundColorButton.setAttribute('aria-expanded', 'false');
      };
      const applyBackgroundColor = color => {
        const range = session.richEditor.getSelection() || session.lastRichSelection;
        if (!range) return;
        session.richEditor.setSelection(range.index, range.length, 'silent');
        if (range.length) session.richEditor.formatText(range.index, range.length, 'background', color || false, 'user');
        else session.richEditor.format('background', color || false, 'user');
        if (color) {
          recentBackgroundColors = [color, ...recentBackgroundColors.filter(item => item !== color)].slice(0, 10);
          env.localStorage.setItem('memokeep-recent-background-colors', JSON.stringify(recentBackgroundColors));
        }
        session.backgroundColorButton.style.setProperty('--note-background-color', color || 'transparent');
        renderRecentBackgroundColors();
        closeBackgroundColorMenu();
        session.richEditor.focus();
      };
      renderRecentBackgroundColors();
      session.backgroundColorButton.onclick = event => {
        event.stopPropagation();
        const opening = !session.backgroundColorMenu.matches(':popover-open');
        if (!opening) { closeBackgroundColorMenu(); return; }
        session.backgroundColorMenu.showPopover?.();
        const rect = session.backgroundColorButton.getBoundingClientRect();
        session.backgroundColorMenu.style.left = `${Math.max(8, Math.min(env.window.innerWidth - 278, rect.left))}px`;
        session.backgroundColorMenu.style.top = `${rect.bottom + 6}px`;
        session.backgroundColorButton.setAttribute('aria-expanded', 'true');
      };
      session.backgroundColorMenu.onclick = event => {
        const colorOption = event.target.closest('[data-note-background-color]');
        if (colorOption) applyBackgroundColor(colorOption.dataset.noteBackgroundColor);
      };
      config.$('#noteMoreBackgroundColor').onclick = () => config.$('#noteCustomBackgroundColor').click();
      config.$('#noteCustomBackgroundColor').oninput = event => applyBackgroundColor(event.target.value);
      const blockFormats = new Set(['align', 'blockquote', 'code-block', 'header', 'list']);
      const setFormatPainterActive = active => {
        formatPainterButton.classList.toggle('ql-active', active);
        formatPainterButton.setAttribute('aria-pressed', String(active));
        const label = active ? '格式刷已启用：选择目标文字' : '格式刷';
        formatPainterButton.setAttribute('aria-label', label);
        if (formatPainterButton.dataset.tooltip) formatPainterButton.dataset.tooltip = label;
      };
      const cancelFormatPainter = () => {
        formatPainterFormats = null;
        setFormatPainterActive(false);
      };
      const refreshHistoryActions = () => {
        undoButton.disabled = !richHistory?.stack?.undo?.length;
        redoButton.disabled = !richHistory?.stack?.redo?.length;
      };
      undoButton.onclick = () => {
        richHistory?.undo();
        session.richEditor.focus();
        refreshHistoryActions();
      };
      redoButton.onclick = () => {
        richHistory?.redo();
        session.richEditor.focus();
        refreshHistoryActions();
      };
      formatPainterButton.onclick = () => {
        if (formatPainterFormats) {
          cancelFormatPainter();
          session.richEditor.focus();
          return;
        }
        const range = session.richEditor.getSelection() || session.lastRichSelection;
        if (!range) {
          actions.showToast('请先选择要复制格式的文字', true);
          return;
        }
        formatPainterFormats = session.richEditor.getFormat(range.index, range.length);
        setFormatPainterActive(true);
        session.richEditor.focus();
        actions.showToast('格式已复制，请选择目标文字');
      };
      session.richEditor.getModule('toolbar').addHandler('image', () => session.richImageInput.click());
      session.richToolbar.addEventListener('click', features.handleSelectedTableToolbarClick, true);
      session.richToolbar.addEventListener('change', features.handleSelectedTableToolbarChange, true);
      session.richToolbar.addEventListener('click', features.handleAlignmentTooltipRefresh);
      session.richToolbar.addEventListener('change', features.handleAlignmentTooltipRefresh);
      features.refreshAlignmentTooltips();

      if (!session.richNoteInitialized && session.editorMode === 'note') {
        session.richEditorLoading = true;
        session.richEditor.setText(session.editor.value, 'silent');
        session.richEditorLoading = false;
        session.richNoteInitialized = true;
      } else {
        await features.loadRichNote(session.richNoteContent);
      }
      if (!features.isCurrentEditor()) return;
      session.richNoteContent = features.serializeRichNote();
      richHistory?.clear();
      session.disposeEditorDiagramPreview?.();
      session.disposeEditorDiagramPreview = env.bindEditorDiagramPreview(session.richEditor.root, session.richEditorColumn, {
        onEdit: (block, trigger) => session.noteMermaidEditor.edit(block, trigger)
      });
      session.disposeNoteHeadingFold = env.bindNoteHeadingFold(session.richEditor, session.richEditorColumn, features.renderCodeCopyButtons);
      session.disposeNoteGist?.();
      session.disposeNoteGist = env.bindNoteGist?.(session.richEditor, session.richEditorColumn, { onLayout: features.renderCodeCopyButtons }) || null;
      // 制卡标记：制过卡的段落标出来，避免重复制卡。
      session.noteCardMarks?.dispose();
      session.noteCardMarks = env.bindNoteCardMarks?.(session.richEditor, session.richEditorColumn, {
        documentId: () => session.target?.id || '',
        cards: () => state.persistence.data.cards,
        sourceDocumentOf: card => (state.persistence.data.items || []).find(item => item.id === card.knowledgeItemId)?.documentId || card.pointDocumentId || '',
        enabled: () => state.persistence.data.settings.noteCardMarks !== false,
        saveAnchors: updates => env.application.persistence.transact(data => {
          for (const update of updates) {
            const card = data.cards.find(item => item.id === update.cardId);
            if (!card) continue;
            if (update.anchor) { card.sourceAnchor = update.anchor; delete card.sourceAnchorDismissed; }
            else { delete card.sourceAnchor; card.sourceAnchorDismissed = true; }
          }
        }).catch(() => {}),
        openCard: id => { const card = state.persistence.data.cards.find(item => item.id === id); if (card) env.application.views.cardEditor.openCardDialog(card); },
        reviewCard: async id => {
          const now = config.now();
          await env.application.persistence.transact(data => { const card = data.cards.find(item => item.id === id); if (card && Number(card.dueAt) > now) card.dueAt = now; });
          await env.application.operations.review.startReview(false, [id], { key: `card:${id}` });
        },
        createCard: (text, range) => features.createCardFromNote(text, range)
      }) || null;
      features.renderNoteOutline();
      features.renderCodeCopyButtons();
      session.codeBlocksResizeObserver = new env.ResizeObserver(features.renderCodeCopyButtons);
      session.codeBlocksResizeObserver.observe(session.richEditor.root);
      env.window.addEventListener('resize', features.renderCodeCopyButtons);

      session.richEditor.on('text-change', () => {
        if (session.richEditorLoading) return;
        session.serializedRichNote = null;
        session.richNoteContent = features.serializeRichNote();
        features.renderNoteOutline();
        features.markNoteChanged();
        env.window.queueMicrotask(refreshRichSlashMenu);
        env.window.queueMicrotask(features.renderCodeCopyButtons);
        env.window.queueMicrotask(refreshHistoryActions);
      });
      session.richEditor.on('selection-change', (range, _oldRange, source) => {
        if (range) {
          session.lastRichSelection = range;
          if (formatPainterFormats && range.length && source === 'user') {
            const formats = formatPainterFormats;
            cancelFormatPainter();
            session.richEditor.removeFormat(range.index, range.length, 'user');
            const inlineFormats = Object.fromEntries(
            Object.entries(formats).filter(([name, value]) => !blockFormats.has(name) && !Array.isArray(value))
            );
            const lineFormats = Object.fromEntries(
            Object.entries(formats).filter(([name, value]) => blockFormats.has(name) && !Array.isArray(value))
            );
            if (Object.keys(inlineFormats).length) session.richEditor.formatText(range.index, range.length, inlineFormats, 'user');
            if (Object.keys(lineFormats).length) session.richEditor.formatLine(range.index, range.length, lineFormats, 'user');
            session.richEditor.setSelection(range.index, range.length, 'silent');
            actions.showToast('格式已应用');
          }
          const tableSelection = features.getTableSelection(range);
          if (tableSelection) session.lastTableSelection = tableSelection;
          features.updateActiveOutlineItem();
          features.refreshTableEditActions();
          features.refreshAlignmentTooltips();
          env.window.queueMicrotask(refreshRichSlashMenu);
        }
      });
      session.selectionCards = env.bindNoteSelectionCards(session.richEditor, session.richEditorColumn, {
        getEnabled: () => state.persistence.data.settings.selectionCardPopupEnabled !== false,
        setEnabled: actions.setNoteSelectionCardPopupEnabled,
        openSettings: actions.openNoteEditingSettings,
        createCard: features.createCardFromNote,
        // 选中的文字和制过卡的段落重叠时提醒（制卡标记）。
        getOverlap: range => session.noteCardMarks?.overlapping(range) || [],
        openExisting: cards => session.noteCardMarks?.openGroupFor(cards),
        copy: actions.copyTextToClipboard,
        notifyDisabled: actions.showNoteSelectionCardDisabledToast
      });
      session.richEditor.root.addEventListener('paste', async event => {
        const itemImages = [...(event.clipboardData?.items || [])]
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);
        const imageFiles = itemImages.length
        ? itemImages
        : [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if (imageFiles.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          await features.insertRichNoteImages(imageFiles);
          features.markNoteChanged();
          return;
        }

        const markdown = event.clipboardData?.getData('text/plain') || '';
        const currentRange = session.richEditor.getSelection();
        // 粘贴到表格单元格里：多行文字留在这一格（换行合成空格），不要把每一行拆成新的列 / 行，
        // 整个粘贴是一次可以撤回的修改。
        const [startLine] = currentRange ? session.richEditor.getLine(currentRange.index) : [];
        const [endLine] = currentRange ? session.richEditor.getLine(currentRange.index + currentRange.length) : [];
        if (currentRange && startLine && startLine === endLine && startLine.formats().table) {
          const html = event.clipboardData?.getData('text/html') || '';
          let text = markdown;
          if (!text && html) {
            const holder = env.document.createElement('div');
            holder.innerHTML = html.replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>|<br\s*\/?>/gi, '$&\n').replace(/<\/t[dh]>/gi, '$&\t');
            text = holder.textContent || '';
          }
          if (/[\r\n\t]/.test(text) || /<(table|tr|p|div|li|h[1-6]|br|pre|blockquote)\b/i.test(html)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const single = text.split(/\r\n|\r|\n/).map(line => line.replace(/\t+/g, ' ').trim()).filter(Boolean).join(' ');
            const Delta = env.window.Quill.import('delta');
            const quill = session.richEditor;
            quill.history.cutoff();
            quill.updateContents(new Delta().retain(currentRange.index).delete(currentRange.length).insert(single), 'user');
            quill.history.cutoff();
            quill.setSelection(currentRange.index + single.length, 0, 'user');
            return;
          }
        }
        if (currentRange && (session.richEditor.getFormat(currentRange)['code-block']
        || session.richEditor.getLine(currentRange.index)[0]?.formats().table
        || session.richEditor.getLine(currentRange.index + currentRange.length)[0]?.formats().table)) return;
        if (env.pasteNoteDiagram(session.richEditor, markdown)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          actions.showToast('已转为图表代码块，点击“预览”查看');
          return;
        }
        if (!actions.looksLikeMarkdown(markdown)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const range = session.richEditor.getSelection(true) || { index: session.richEditor.getLength() - 1, length: 0 };
        if (range.length) session.richEditor.deleteText(range.index, range.length, 'user');
        session.richEditor.clipboard.dangerouslyPasteHTML(range.index, actions.markdownToRichHtml(markdown), 'user');
        features.renderNoteOutline();
        features.markNoteChanged();
        actions.showToast('Markdown 已转换为富文本');
      }, true);
      session.richEditor.root.addEventListener('click', event => {
        const tableCell = event.target.closest('td');
        if (tableCell) {
          session.lastTableSelection = features.getTableSelectionFromCell(tableCell);
        }
        const image = event.target.closest('img');
        if (!image || image.closest('.note-link-card')) return;
        env.prepareNoteImagePreview(image, config.$('#noteImageLightboxImage'));
        config.$('#noteImageLightboxImage').src = image.src;
        config.$('#noteImageLightboxImage').alt = image.dataset.fileName || image.alt || '笔记图片';
        config.$('#noteImageLightboxCaption').textContent = image.dataset.fileName || image.alt || '笔记图片';
        session.activeLightboxImageId = image.dataset.memokeepImageId || null;
        session.imageLightbox.classList.remove('hidden');
        session.imagePreviewViewer.reset();
        session.imageLightbox.focus();
      });
      session.richEditor.root.addEventListener('pointerdown', () => {
        if (session.selectedTableCells.length) features.clearTableAxisSelection();
      });
      session.richEditor.root.addEventListener('copy', event => {
        if (session.selectedTableCells.length) features.copySelectedTableAxis(event);
      });
      session.richEditor.root.addEventListener('pointerover', event => {
        const table = event.target.closest('table');
        if (table) features.updateTableFloatingTools(event);
      });
      session.richEditor.root.addEventListener('pointermove', event => {
        if (event.target.closest('table')) features.updateTableFloatingTools(event);
      });
      session.richEditor.root.addEventListener('pointerout', event => {
        const table = event.target.closest('table');
        if (!table || table.contains(event.relatedTarget) || session.tableFloatingTools.contains(event.relatedTarget)) return;
        features.scheduleHideTableFloatingTools();
      });
      session.tableFloatingTools.onpointerenter = () => env.clearTimeout(session.tableToolsHideTimer);
      session.tableFloatingTools.onpointerleave = features.scheduleHideTableFloatingTools;
      session.tableFloatingTools.onmousedown = event => event.preventDefault();
      session.tableFloatingTools.onclick = async event => {
        const action = event.target.closest('[data-table-floating-action]')?.dataset.tableFloatingAction;
        if (!action) return;
        if (action === 'selectTable') features.selectEntireTable(session.activeTableElement);
        else if (action === 'copySelectedTable' && session.selectedTableAxis?.axis === 'table') await features.copyRichTable(session.selectedTableAxis.table);
        else if (action === 'deleteSelectedTable' && session.selectedTableAxis?.axis === 'table') features.runFloatingTableAction('deleteTable');
        else if (action === 'fitTableWidth') {
          if (typeof env.fitNoteTableWidth === 'function') env.fitNoteTableWidth(session.richEditor, session.activeTableElement);
          features.positionTableFloatingTools();
        }
        else if (action === 'selectRow') features.selectTableAxis(session.activeTableElement, 'row');
        else if (action === 'selectColumn') features.selectTableAxis(session.activeTableElement, 'column');
        else features.runFloatingTableAction(action);
      };
      session.tableToolsResizeObserver = new env.ResizeObserver(features.positionTableFloatingTools);
      session.tableToolsResizeObserver.observe(session.richEditor.root);
      session.richImageInput.onchange = async event => {
        await features.insertRichNoteImages(event.target.files || []);
        event.target.value = '';
        features.markNoteChanged();
      };
      refreshHistoryActions();
    };
    return { createCardFromNote, loadRichNote, insertRichNoteImages, applyEditorMode, handleModeMenuOutsideClick, initializeRichNoteEditor };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorRichText });
})(globalThis);
