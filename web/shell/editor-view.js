(function expose(root) {
  function createEditorView({ state, config, actions, env }) {
    function renderInlineMarkdownEditor(library, document) {
      if (env.MemoKeepNoteFiles.isText(document)) return env.renderPlainTextNoteEditor(library, document);
      const editorMode = document?.metadata?.editorMode === 'note' ? 'note' : 'card';
      const outlinePinned = env.localStorage.getItem(config.NOTE_OUTLINE_PINNED_KEY) === 'true';
      const titleInput = `<input id="inlineMarkdownNoteTitle" class="note-title-input" aria-label="笔记名称" maxlength="100" spellcheck="false" value="${actions.escapeHtml(document?.title || state.editor.pendingNewMarkdownNoteTitle)}" placeholder="笔记名称">`;
      const saveShortcut = env.MemoKeepShortcuts.label('save');
      // 保存按钮一开始就按「最可能的状态」渲染：已存在的笔记是已保存（禁用），草稿是未保存。
      // 否则按钮先以可点的蓝色出现，加载完才变灰，切换标签时会闪一下（按钮有颜色过渡）。
      const pendingDraft = Boolean(env.noteDraftTab?.());
      return `
    <div id="inlineMarkdownNoteForm" class="clean-note-editor${config.desktop?.platform === 'darwin' ? ' card-editor-mac' : ''}" data-editor-mode="${editorMode}">
      <div class="note-editor-toolbar">
        <button type="button" class="note-back-button" id="closeInlineEditorBtn" aria-label="返回知识库" title="返回知识库"><svg aria-hidden="true"><use href="#icon-arrow-left"></use></svg><span>返回</span></button>
        <div class="card-editor-breadcrumb card-editor-only"><span class="card-editor-divider" aria-hidden="true">/</span><span>记忆卡片</span></div>
        <span class="note-editor-toolbar-spacer card-editor-toolbar-spacer"></span>
        <div class="card-editor-zoom card-editor-only" role="group" aria-label="笔记缩放，范围 80% 至 150%">
          <button type="button" id="cardEditorZoomOut" aria-label="缩小笔记" title="缩小（⌘− / Ctrl+−），最小 80%">−</button>
          <button type="button" id="cardEditorZoomReset" aria-label="当前缩放 ${config.CARD_EDITOR_ZOOM_DEFAULT}%，点击恢复默认" title="恢复 ${config.CARD_EDITOR_ZOOM_DEFAULT}%（⌘0 / Ctrl+0）"><span aria-live="polite">${config.CARD_EDITOR_ZOOM_DEFAULT}%</span></button>
          <button type="button" id="cardEditorZoomIn" aria-label="放大笔记" title="放大（⌘+ / Ctrl++），最大 150%">+</button>
        </div>
        <span id="noteSaveStatus" class="note-save-status${pendingDraft ? ' is-dirty' : ''}" role="status">${pendingDraft ? '未保存' : '已保存'}</span>
        <button type="button" id="saveNoteButton" class="note-save-button" aria-label="保存笔记"${pendingDraft ? '' : ' disabled'} title="保存笔记（${saveShortcut}）"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 3h12l4 4v14H3V3zM7 3v6h9V3M7 21v-8h10v8"/></svg><span>保存</span><kbd class="card-editor-only">${saveShortcut}</kbd></button>
        <div class="note-history-control">
          <button type="button" id="noteHistoryButton" class="note-toolbar-icon-button" aria-label="历史版本" title="历史版本" aria-haspopup="menu" aria-expanded="false"><svg aria-hidden="true"><use href="#icon-history"></use></svg><span class="card-editor-only">历史版本</span></button>
          <div id="noteHistoryMenu" class="note-history-menu hidden" role="menu" aria-label="最近保存的版本"></div>
        </div>
      </div>
      <header class="card-editor-heading card-editor-only">
        ${editorMode === 'card' ? titleInput : ''}
        ${editorMode === 'card' && !state.editor.editingCardNotebookId ? env.renderNoteTagControl() : ''}
        <div class="card-editor-meta">
          <span id="cardEditorCount" aria-live="polite">${env.application.domain.parseInlineCards(document?.content || '').length} 张卡片</span>
          <div class="card-editor-insert-actions" role="toolbar" aria-label="插入内容">
            <button type="button" id="captureCardScreenshot" aria-label="截图并裁切"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z"/></svg><span>截图</span></button>
            <button type="button" id="insertCardEditorCard"><svg aria-hidden="true"><use href="#icon-file-plus-2"></use></svg><span>插入卡片</span></button>
          </div>
        </div>
      </header>
      <p id="cardQuestionError" class="card-question-error" role="alert" hidden></p>
      <div id="noteCardEditorPane" class="note-editor-canvas${editorMode === 'card' ? '' : ' hidden'}">
        <div id="inlineCardHoverLayer" class="inline-card-hover-layer" aria-hidden="true"></div>
        <textarea id="inlineMarkdownNoteContent" aria-label="卡片内容" aria-describedby="cardEditorHint cardQuestionError" wrap="soft" spellcheck="false" placeholder="开始记录，输入 / 插入卡片">${actions.escapeHtml(document?.content || '')}</textarea>
        <p id="cardEditorHint" class="card-editor-hint card-editor-only">输入 / 插入卡片，或继续书写</p>
        <div id="noteImageTokenLayer" class="note-image-token-layer" aria-live="polite"></div>
        <div id="inlineCardTokenLayer" class="inline-card-token-layer"></div>
        <div id="noteEditorContextMenu" class="note-editor-context-menu hidden" role="menu" aria-label="笔记编辑菜单">
          <button type="button" id="insertNoteImageMenuItem" role="menuitem">
            <svg aria-hidden="true"><use href="#icon-image-plus"></use></svg>
            <span>插入图片</span>
          </button>
        </div>
        <div id="noteCommandMenu" class="note-command-menu hidden" role="listbox" aria-label="笔记编辑命令">
          <button type="button" id="insertInlineCardCommand" role="option">
            <span class="note-command-icon">◇</span>
            <span class="note-command-copy">
              <strong>插入记忆卡片</strong>
              <small>单行问题与答案卡片</small>
            </span>
            <kbd>-&gt;</kbd>
          </button>
        </div>
      </div>
      <div id="noteRichEditorPane" class="note-rich-editor-pane${editorMode === 'note' ? '' : ' hidden'}">
        <div id="noteRichToolbar" class="note-rich-toolbar ql-toolbar ql-snow" role="toolbar" aria-label="笔记格式工具栏">
          <div class="note-rich-toolbar-content">
          <span class="ql-formats note-history-actions">
            <button type="button" id="undoNoteButton" class="note-rich-custom-tool" aria-label="撤销" title="撤销" disabled><svg aria-hidden="true"><use href="#icon-undo-2"></use></svg></button>
            <button type="button" id="redoNoteButton" class="note-rich-custom-tool" aria-label="恢复" title="恢复" disabled><svg aria-hidden="true"><use href="#icon-redo-2"></use></svg></button>
            <button type="button" id="formatPainterButton" class="note-rich-custom-tool" aria-label="格式刷" title="格式刷：复制当前文字格式"><svg aria-hidden="true"><use href="#icon-paint-roller"></use></svg></button>
          </span>
          <span class="ql-formats">
            <select class="ql-header" aria-label="标题级别" title="标题级别">
              <option selected>正文</option>
              <option value="1">标题 1</option>
              <option value="2">标题 2</option>
              <option value="3">标题 3</option>
              <option value="4">标题 4</option>
              <option value="5">标题 5</option>
              <option value="6">标题 6</option>
            </select>
          </span>
          <span class="ql-formats">
            <button type="button" class="ql-bold" aria-label="加粗" title="加粗"></button>
            <button type="button" class="ql-italic" aria-label="斜体" title="斜体"></button>
            <button type="button" class="ql-underline" aria-label="下划线" title="下划线"></button>
            <button type="button" class="ql-strike" aria-label="删除线" title="删除线"></button>
          </span>
          <span class="ql-formats">
            <span class="note-text-color-control">
              <button type="button" id="noteTextColorButton" class="note-text-color-button" aria-label="文字颜色" title="文字颜色" aria-expanded="false"><strong>A</strong><i></i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></button>
              <div id="noteTextColorMenu" class="note-text-color-menu" popover="manual" aria-label="选择文字颜色">
                <button type="button" class="note-color-default" data-note-text-color="" aria-label="默认文字颜色"><span style="background:#2c3035"></span><strong>默认</strong><i>✓</i></button>
                <div class="note-color-section-title">常用颜色</div>
                <div class="note-color-grid">${['#000000','#404040','#666666','#8c8c8c','#bfbfbf','#d9d9d9','#e8e8e8','#f2f2f2','#fafafa','#ffffff','#e52b3f','#f05b4f','#f59e0b','#facc15','#65b812','#14a77b','#1597e5','#3155d9','#6d28d9','#d62f9d','#f8d7dc','#fde1dc','#fde9c8','#fff0aa','#dcefc4','#c8eee2','#cae7fa','#cfd8fa','#ddd2f6','#f3cce6','#ed8994','#f69a86','#f5b349','#f0cd3d','#90cd44','#39bf95','#43afea','#667ee6','#925fdc','#db61ad','#b81d32','#ce3b34','#d47705','#a58b00','#4c8b16','#087b5c','#086da9','#2440a6','#521fa3','#a41670','#861324','#99251f','#9b5704','#6f5e00','#315e0d','#07513e','#074b75','#182b72','#36156d','#71104e'].map(color => `<button type="button" data-note-text-color="${color}" aria-label="文字颜色 ${color}" style="--swatch:${color}"></button>`).join('')}</div>
                <div class="note-color-section-title">最近使用</div>
                <div id="noteRecentTextColors" class="note-color-grid note-color-recent"><span>暂无</span></div>
                <button type="button" id="noteMoreTextColor" class="note-more-color"><span class="note-color-wheel"></span><strong>更多颜色</strong><i>›</i></button>
                <input id="noteCustomTextColor" type="color" tabindex="-1" aria-label="自定义文字颜色">
              </div>
            </span>
            <span class="note-background-color-control">
              <button type="button" id="noteBackgroundColorButton" class="note-background-color-button" aria-label="背景颜色" title="背景颜色" aria-expanded="false"><svg class="note-background-color-icon" aria-hidden="true"><use href="#icon-paint-bucket"></use></svg><i></i></button>
              <div id="noteBackgroundColorMenu" class="note-text-color-menu note-background-color-menu" popover="manual" aria-label="选择背景颜色">
                <button type="button" class="note-color-default" data-note-background-color="" aria-label="无填充"><span class="note-no-fill"></span><strong>无填充色</strong><i>✓</i></button>
                <div class="note-color-section-title">常用颜色</div>
                <div class="note-color-grid">${['#000000','#404040','#666666','#8c8c8c','#bfbfbf','#d9d9d9','#e8e8e8','#f2f2f2','#fafafa','#ffffff','#e52b3f','#f05b4f','#f59e0b','#facc15','#65b812','#14a77b','#1597e5','#3155d9','#6d28d9','#d62f9d','#f8d7dc','#fde1dc','#fde9c8','#fff0aa','#dcefc4','#c8eee2','#cae7fa','#cfd8fa','#ddd2f6','#f3cce6','#ed8994','#f69a86','#f5b349','#f0cd3d','#90cd44','#39bf95','#43afea','#667ee6','#925fdc','#db61ad','#b81d32','#ce3b34','#d47705','#a58b00','#4c8b16','#087b5c','#086da9','#2440a6','#521fa3','#a41670','#861324','#99251f','#9b5704','#6f5e00','#315e0d','#07513e','#074b75','#182b72','#36156d','#71104e'].map(color => `<button type="button" data-note-background-color="${color}" aria-label="背景颜色 ${color}" style="--swatch:${color}"></button>`).join('')}</div>
                <div class="note-color-section-title">最近使用</div>
                <div id="noteRecentBackgroundColors" class="note-color-grid note-color-recent"><span>暂无</span></div>
                <button type="button" id="noteMoreBackgroundColor" class="note-more-color"><span class="note-color-wheel"></span><strong>更多颜色</strong><i>›</i></button>
                <input id="noteCustomBackgroundColor" type="color" tabindex="-1" aria-label="自定义背景颜色">
              </div>
            </span>
          </span>
          <span class="ql-formats">
            <select class="ql-align" aria-label="段落对齐" title="段落对齐">
              <option value="" selected>左对齐</option>
              <option value="center">居中对齐</option>
              <option value="right">右对齐</option>
              <option value="justify">两端对齐</option>
            </select>
          </span>
          <span class="ql-formats">
            <button type="button" class="ql-list" value="ordered" aria-label="有序列表" title="有序列表"></button>
            <button type="button" class="ql-list" value="bullet" aria-label="无序列表" title="无序列表"></button>
            <button type="button" class="ql-list" value="check" aria-label="任务列表" title="任务列表（${env.MemoKeepShortcuts.label('todo')}）"></button>
            <button type="button" class="ql-blockquote" aria-label="引用" title="引用"></button>
          </span>
          <span class="ql-formats">
            <button type="button" class="ql-code-block" aria-label="代码块" title="代码块"></button>
            <button type="button" class="ql-link" aria-label="插入链接" title="插入链接"></button>
            <button type="button" class="ql-image" aria-label="插入图片" title="插入图片"></button>
            <button type="button" id="insertNoteTableButton" class="note-rich-custom-tool" aria-label="插入或编辑表格" title="插入或编辑表格"><svg aria-hidden="true"><use href="#icon-table"></use></svg></button>
            <button type="button" id="insertNoteMermaidButton" class="note-rich-custom-tool" aria-label="插入图表" title="插入图表：Mermaid、流程图、架构图、拓扑图"><svg aria-hidden="true"><use href="#icon-workflow"></use></svg></button>
            <button type="button" class="ql-clean" aria-label="清除格式" title="清除格式"></button>
          </span>
          </div>
          <button type="button" id="captureNoteScreenshot" class="note-rich-custom-tool" aria-label="截图并裁切" title="截图并裁切"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z"/></svg><span>截图</span></button>
          <button type="button" id="toggleNoteToolbarButton" class="note-toolbar-toggle note-rich-custom-tool" aria-label="展开格式工具栏" title="展开格式工具栏" aria-expanded="false"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>
        </div>
        <div id="noteTablePicker" class="note-table-picker hidden" role="dialog" aria-label="插入或编辑表格">
          <div class="note-table-picker-head"><strong>插入表格</strong><span id="noteTablePickerSize">选择行列</span></div>
          <div class="note-table-size-grid" role="grid" aria-label="选择表格尺寸">
            ${Array.from({ length: 36 }, (_item, index) => {
          const row = Math.floor(index / 6) + 1;
          const column = (index % 6) + 1;
          return `<button type="button" data-table-rows="${row}" data-table-columns="${column}" role="gridcell" aria-label="${row} 行 ${column} 列"></button>`;
        }).join('')}
          </div>
          <div id="noteTableEditActions" class="note-table-edit-actions hidden">
            <span>编辑当前表格</span>
            <div>
              <button type="button" data-table-action="insertRowBelow">下方加行</button>
              <button type="button" data-table-action="insertColumnRight">右侧加列</button>
              <button type="button" data-table-action="deleteRow">删除行</button>
              <button type="button" data-table-action="deleteColumn">删除列</button>
              <button type="button" data-table-action="deleteTable" class="danger-text">删除表格</button>
            </div>
          </div>
        </div>
        <div id="noteRichWorkspace" class="note-rich-workspace${outlinePinned ? ' is-outline-pinned' : ''}">
          <div class="note-rich-editor-column">
            <div class="note-document-heading">${editorMode === 'note' ? titleInput : ''}${editorMode === 'note' && !state.editor.editingCardNotebookId ? env.renderNoteTagControl() : ''}</div>
            <div id="noteRichEditor"></div>
            <div id="noteRichSlashMenu" class="note-rich-slash-menu hidden" role="listbox" aria-label="斜杠命令菜单"></div>
            <div id="noteCodeCopyLayer" class="note-code-copy-layer" aria-label="代码块操作"></div>
            <div id="noteTableFloatingTools" class="note-table-floating-tools hidden" aria-label="表格快捷操作">
              <button type="button" class="note-table-select-all-button" data-table-floating-action="selectTable" aria-label="全选表格" title="全选表格">
                <svg aria-hidden="true"><use href="#icon-table"></use></svg>
              </button>
              <button type="button" class="note-table-selection-action note-table-copy-selected" data-table-floating-action="copySelectedTable" aria-label="复制已选表格" title="复制表格"><svg aria-hidden="true"><use href="#icon-copy"></use></svg></button>
              <button type="button" class="note-table-selection-action note-table-delete-selected" data-table-floating-action="deleteSelectedTable" aria-label="删除已选表格" title="删除表格"><svg aria-hidden="true"><use href="#icon-trash"></use></svg></button>
              <button type="button" class="note-table-selection-action note-table-fit-width" data-table-floating-action="fitTableWidth" aria-label="宽度自适应：铺满编辑区，按内容分配列宽" title="宽度自适应"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5v14M21 5v14M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <button type="button" class="note-table-edge-button note-table-add-column" data-table-floating-action="insertColumnRight" aria-label="在右侧增加一列" title="增加一列"><svg aria-hidden="true"><use href="#icon-plus"></use></svg></button>
              <button type="button" class="note-table-edge-button note-table-add-row" data-table-floating-action="insertRowBelow" aria-label="在底部增加一行" title="增加一行"><svg aria-hidden="true"><use href="#icon-plus"></use></svg></button>
              <button type="button" class="note-table-axis-rail note-table-select-column" data-table-floating-action="selectColumn" aria-label="选中当前列" title="选中当前列"><svg aria-hidden="true"><use href="#icon-circle-check"></use></svg></button>
              <button type="button" class="note-table-axis-rail note-table-select-row" data-table-floating-action="selectRow" aria-label="选中当前行" title="选中当前行"><svg aria-hidden="true"><use href="#icon-circle-check"></use></svg></button>
              <button type="button" class="note-table-edge-button note-table-delete-column" data-table-floating-action="deleteColumn" aria-label="删除当前列" title="删除当前列"><svg aria-hidden="true"><use href="#icon-minus"></use></svg></button>
              <button type="button" class="note-table-edge-button note-table-delete-row" data-table-floating-action="deleteRow" aria-label="删除当前行" title="删除当前行"><svg aria-hidden="true"><use href="#icon-minus"></use></svg></button>
            </div>
          </div>
          <button type="button" id="noteOutlineHoverTarget" class="note-outline-hover-target" aria-label="鼠标移入以展开大纲" title="大纲">
            <span></span><span></span>
          </button>
          <aside id="noteOutlinePanel" class="note-outline-panel" aria-label="笔记大纲">
            <div class="note-outline-header">
              <span class="note-outline-title">
                <strong>大纲</strong>
              </span>
              <button type="button" id="pinNoteOutline" class="note-outline-pin${outlinePinned ? ' active' : ''}" aria-controls="noteOutlineList" aria-pressed="${outlinePinned}" aria-label="${outlinePinned ? '取消固定大纲' : '固定大纲'}" title="${outlinePinned ? '取消固定大纲' : '固定大纲'}">
                <svg aria-hidden="true"><use href="#icon-eye"></use></svg>
              </button>
            </div>
            <nav id="noteOutlineList" class="note-outline-list" aria-label="标题目录"></nav>
          </aside>
        </div>
        <input id="noteRichImageInput" class="hidden" type="file" accept="image/*" multiple>
      </div>
      <footer class="card-editor-footer"><span><button type="button" id="toggleCardImmersive" class="card-editor-immersive-toggle" aria-label="更多阅读与编辑模式" data-tooltip="更多" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><span class="card-editor-only">问题 → 答案</span><i class="card-editor-only" aria-hidden="true">·</i><span class="card-editor-only">每行一张卡片</span></span><span class="card-editor-only"><kbd>${saveShortcut}</kbd> 保存</span></footer>
      <div id="noteImageLightbox" class="note-image-lightbox hidden" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1">
        <div class="note-image-lightbox-panel">
          <button type="button" id="closeNoteImageLightbox" class="note-image-lightbox-close" aria-label="关闭图片预览"><svg aria-hidden="true"><use href="#icon-x"></use></svg></button>
          <div class="note-image-preview-viewport"><span class="note-image-frame"><img id="noteImageLightboxImage" alt=""></span></div>
          <div class="note-image-preview-toolbar" role="toolbar" aria-label="图片缩放">
            <button type="button" data-image-zoom="out" aria-label="缩小图片" title="缩小">−</button>
            <output data-image-zoom-value aria-label="图片缩放比例">100%</output>
            <button type="button" data-image-zoom="in" aria-label="放大图片" title="放大">＋</button>
            <span class="note-image-preview-divider"></span>
            <button type="button" data-image-zoom="actual" aria-label="图片原始大小" title="原始大小">1:1</button>
            <button type="button" data-image-zoom="fit" aria-label="图片适应窗口" title="适应窗口"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button>
          </div>
          <div id="noteImageLightboxCaption" class="note-image-lightbox-caption"></div>
        </div>
      </div>
      <div id="inlineCardPreviewOverlay" class="inline-card-preview-overlay hidden" role="dialog" aria-labelledby="inlineCardPreviewTitle">
        <section class="inline-card-preview-panel">
          <div class="inline-card-preview-head" title="拖动标题栏移动预览">
            <span class="inline-card-preview-title">
              <svg class="inline-card-preview-title-icon" aria-hidden="true"><use href="#icon-layers"></use></svg>
              <strong id="inlineCardPreviewTitle">记忆卡片预览</strong>
            </span>
            <button type="button" id="closeInlineCardPreview" aria-label="关闭预览">
              <svg aria-hidden="true"><use href="#icon-x"></use></svg>
            </button>
          </div>
          <div class="inline-card-preview-body">
            <div class="inline-card-preview-row">
              <strong id="inlineCardPreviewQuestion"></strong>
              <p id="inlineCardPreviewSource" class="inline-card-preview-source"></p>
            </div>
            <section id="inlineCardPreviewAnswerArea" class="inline-card-preview-answer-area" aria-labelledby="inlineCardPreviewAnswerLabel" hidden>
              <div class="inline-card-preview-answer-heading">
                <h3 id="inlineCardPreviewAnswerLabel">参考答案</h3>
                <button type="button" id="copyInlineCardAnswer" class="inline-card-preview-copy" aria-label="复制答案" title="复制答案" disabled>
                  <svg aria-hidden="true"><use href="#icon-copy"></use></svg>
                </button>
              </div>
              <div id="inlineCardPreviewAnswer" class="inline-card-preview-answer"></div>
            </section>
            <p class="inline-card-preview-hint">
              <svg aria-hidden="true"><use href="#icon-lightbulb"></use></svg>
              <span id="inlineCardPreviewHintText"></span>
            </p>
            <button type="button" id="revealInlineCardAnswer" class="inline-card-preview-reveal">
              <svg aria-hidden="true"><use id="revealInlineCardAnswerIcon" href="#icon-eye"></use></svg>
              <span id="revealInlineCardAnswerLabel">我已尝试回忆 · 显示答案</span>
            </button>
          </div>
        </section>
      </div>
    </div>`;
    }
    return { renderInlineMarkdownEditor };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorView });
})(globalThis);
