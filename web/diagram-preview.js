let diagramRendererPromise;
let diagramPreviewSequence = 0;
let diagramTooltipsBound = false;

function setDiagramButtonTooltip(button, label, showTooltip = true) {
  button.setAttribute('aria-label', label);
  if (showTooltip) {
    bindDiagramButtonTooltips();
    button.dataset.diagramTooltip = label;
  } else delete button.dataset.diagramTooltip;
  button.removeAttribute('title');
}

// Delegate once so dynamically rendered diagrams share one tooltip and cleanup.
function bindDiagramButtonTooltips() {
  if (diagramTooltipsBound) return;
  diagramTooltipsBound = true;
  let tooltip = null, target = null;
  const observer = new MutationObserver(() => {
    if (target && !target.isConnected) hide();
  });
  const hide = () => {
    observer.disconnect();
    if (target && tooltip) {
      const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (descriptions.length) target.setAttribute('aria-describedby', descriptions.join(' '));
      else target.removeAttribute('aria-describedby');
    }
    tooltip?.remove();
    tooltip = target = null;
  };
  const show = button => {
    hide();
    const label = button?.dataset.diagramTooltip;
    if (!label || (button.disabled && button.dataset.diagramTooltipWhenDisabled !== 'true')) return;
    target = button;
    tooltip = document.createElement('div');
    tooltip.id = 'diagramButtonTooltip';
    tooltip.className = 'note-toolbar-tooltip diagram-button-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = label;
    // Escape the scrolling preview; fullscreen tooltips must stay in its top-layer dialog.
    (button.closest('dialog') || document.body).append(tooltip);
    target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '));
    const rect = button.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tip.width - 8, rect.left + (rect.width - tip.width) / 2))}px`;
    const top = rect.bottom + 8 + tip.height <= innerHeight - 8 ? rect.bottom + 8 : rect.top - tip.height - 8;
    tooltip.style.top = `${Math.max(8, top)}px`;
    observer.observe(document.body, { childList: true, subtree: true });
  };
  const buttonFor = element => element instanceof Element ? element.closest('[data-diagram-tooltip]') : null;
  document.addEventListener('pointerover', event => {
    const button = buttonFor(event.target);
    if (button && !button.contains(event.relatedTarget)) show(button);
  });
  document.addEventListener('pointerout', event => {
    if (target?.contains(event.target) && !target.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', event => show(buttonFor(event.target)));
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('click', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('close', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}

const DIAGRAM_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
// design/prototype/diagram-viewer-20261109.md: neutral nodes, four tinted group lanes.
const DIAGRAM_PALETTES = {
  light: { node: '#FFFFFF', nodeLine: '#C9D0DC', text: '#20232B', muted: '#5B6474', edge: '#8C95A5', label: '#FFFFFF',
    db: '#EEF3FE', dbLine: '#AFC1EC', diamond: '#FFF6E5', diamondLine: '#E3C37C',
    lanes: [['#F2F6FE', '#D3DEF7', '#3D5DB8'], ['#F0F8F4', '#CDE7D9', '#2D7A55'], ['#F6F3FD', '#DDD3F3', '#6A4FB0'], ['#FDF7EC', '#F0DDB5', '#94661A']] },
  dark: { node: '#1F232C', nodeLine: '#3A4150', text: '#E6E8EE', muted: '#A2AAB8', edge: '#7D8696', label: '#181B22',
    db: '#1D2740', dbLine: '#3E5288', diamond: '#2E2716', diamondLine: '#7A6230',
    lanes: [['#1A2131', '#2C3A5C', '#9DB3F0'], ['#18251F', '#2B4638', '#8BD3AE'], ['#211D30', '#3D3459', '#BBA8F0'], ['#272116', '#4D3F22', '#E8C47F']] }
};
function diagramIsDark() { return document.documentElement.dataset.appearance === 'dark'; }
function diagramRendererConfig(dark) {
  const p = DIAGRAM_PALETTES[dark ? 'dark' : 'light'];
  // Lane tints only replace Mermaid's theme defaults; inline classDef/style colors still win.
  const lanes = p.lanes.map(([fill, line, ink], index) => `
    .clusters > g:nth-child(4n+${index + 1}) > rect { fill: ${fill}; stroke: ${line}; }
    .clusters > g:nth-child(4n+${index + 1}) .cluster-label text { fill: ${ink}; }`).join('');
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      darkMode: dark, background: dark ? '#181B22' : '#FFFFFF', fontFamily: DIAGRAM_FONT, fontSize: '14px',
      primaryColor: p.node, primaryBorderColor: p.nodeLine, primaryTextColor: p.text, secondaryColor: p.db, tertiaryColor: p.label,
      lineColor: p.edge, textColor: p.text, titleColor: p.muted, edgeLabelBackground: p.label,
      clusterBkg: p.lanes[0][0], clusterBorder: p.lanes[0][1], noteBkgColor: p.diamond, noteBorderColor: p.diamondLine, noteTextColor: p.text
    },
    themeCSS: `
      .node rect, .node path, .node polygon, .node circle { stroke-width: 1px; }
      .node rect { rx: 8px; ry: 8px; }
      .node path { fill: ${p.db}; stroke: ${p.dbLine}; }
      .node polygon { fill: ${p.diamond}; stroke: ${p.diamondLine}; }
      .cluster rect { rx: 12px; ry: 12px; stroke-width: 1px; }
      .cluster-label text { font-size: 12.5px; font-weight: 600; }
      .flowchart-link { stroke-width: 1.3px; }
      .edgeLabel, .edgeLabel text { font-size: 12px; fill: ${p.muted}; color: ${p.muted}; }
      .edgeLabel rect, .labelBkg { fill: ${p.label}; opacity: 1; }
      .marker { fill: ${p.edge}; stroke: ${p.edge}; }
      ${lanes}`,
    // Compact spacing keeps large diagrams readable when fitted to the note width.
    flowchart: {
      useMaxWidth: true, htmlLabels: false,
      nodeSpacing: 44, rankSpacing: 56, padding: 14,
      diagramPadding: 16, subGraphTitleMargin: { top: 8, bottom: 14 }
    },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart']
  };
}
// Mermaid keeps one global config, so theme switches and renders run one at a time.
let diagramRenderQueue = Promise.resolve();
function renderDiagramSvg(renderer, source, dark) {
  const run = diagramRenderQueue.then(() => {
    renderer.initialize(diagramRendererConfig(dark));
    return renderer.render(`memokeep-diagram-${++diagramPreviewSequence}`, typeof themedMermaidSource === 'function' ? themedMermaidSource(source) : source);
  });
  diagramRenderQueue = run.catch(() => {});
  return run;
}

function loadDiagramRenderer() {
  if (!diagramRendererPromise) {
    diagramRendererPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/mermaid/mermaid.min.js';
      script.onload = () => {
        window.mermaid.initialize(diagramRendererConfig(diagramIsDark()));
        resolve(window.mermaid);
      };
      script.onerror = () => {
        script.remove();
        diagramRendererPromise = undefined;
        reject(new Error('流程图渲染组件加载失败'));
      };
      document.head.append(script);
    });
  }
  return diagramRendererPromise;
}

function isMermaidSource(value, requireBody = false) {
  let source = String(value).replace(/\r\n?/g, '\n').trimStart();
  if (/^---[ \t]*\n/.test(source)) {
    const frontmatter = source.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
    if (!frontmatter) return false;
    source = source.slice(frontmatter[0].length).trimStart();
  }
  // Mermaid permits comments and multiline initialization directives before the header.
  while (source.startsWith('%%')) {
    const comment = source.startsWith('%%{')
      ? source.match(/^%%\{[\s\S]*?\}%%[ \t]*(?:\n|$)/)
      : source.match(/^%%[^\n]*(?:\n|$)/);
    if (!comment) return false;
    source = source.slice(comment[0].length).trimStart();
  }
  const [firstLine, ...body] = source.split('\n');
  const header = firstLine.trim();
  if (requireBody && !body.join('\n').trim() && !/;\s*\S/.test(header)) return false;
  return /^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)(?:\s*;.*)?$/i.test(header)
    || /^(?:sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|architecture-beta|C4(?:Context|Container|Component|Dynamic|Deployment)|mindmap|timeline|gantt|journey|quadrantChart|requirementDiagram|kanban|block-beta|sankey-beta|packet-beta|radar-beta|treemap-beta)\s*;?$/i.test(header)
    || /^pie(?:\s+showData)?\s*;?$/i.test(header)
    || /^gitGraph(?:\s+(?:LR|TB|BT))?\s*:?$/i.test(header)
    || /^xychart(?:-beta)?(?:\s+horizontal)?\s*;?$/i.test(header);
}

function isDiagramCodeBlock(block) {
  const code = block.querySelector('code');
  const classLanguage = code?.getAttribute?.('class')?.match(/(?:^|\s)(?:language|lang)-([\w-]+)/)?.[1];
  const language = (block.dataset.language || code?.dataset.lang || classLanguage || '').toLowerCase();
  return language === 'mermaid' || (['', 'plain', 'text'].includes(language) && isMermaidSource(block.textContent));
}

function serializeDiagramSvg(svg) {
  // Mermaid may return HTML-style void elements inside SVG foreignObject labels
  // (e.g. <br>). Parse as HTML first, then serialize namespaces and closing tags
  // as XML, which the browser's SVG image decoder requires.
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content.querySelector('svg');
  if (!root) throw new Error('流程图未生成有效的 SVG');
  const serialized = new XMLSerializer().serializeToString(root);
  const xml = new DOMParser().parseFromString(serialized, 'image/svg+xml');
  if (xml.querySelector('parsererror')) throw new Error('流程图 SVG 格式无效');
  return { svg: serialized, root: xml.documentElement };
}

// Reopening a tab rebuilds its editor, but unchanged diagrams need no new layout.
const diagramPreviewCache = new Map();
let diagramPreviewCacheBytes = 0;
const DIAGRAM_PREVIEW_CACHE_LIMIT = 24 * 1024 * 1024;
async function cachedDiagramPreview(source, renderer) {
  const dark = diagramIsDark(), key = `${dark ? 'dark' : 'light'}\n${source}`;
  const cached = diagramPreviewCache.get(key);
  if (cached) {
    diagramPreviewCache.delete(key);
    diagramPreviewCache.set(key, cached);
    return cached.promise;
  }
  const entry = { bytes: source.length * 2, promise: null };
  entry.promise = Promise.resolve().then(async () => {
    const savedCanvas = typeof renderSavedMermaidCanvas === 'function' ? renderSavedMermaidCanvas(source) : null;
    const { svg } = savedCanvas ? { svg: savedCanvas } : await renderDiagramSvg(renderer, source, dark);
    const normalized = serializeDiagramSvg(svg);
    if (typeof applyMermaidSequenceOffsets === 'function' && /^\s*sequenceDiagram\s*$/m.test(source)) {
      applyMermaidSequenceOffsets(normalized.root, source);
      normalized.svg = new XMLSerializer().serializeToString(normalized.root);
    }
    const viewBox = (normalized.root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized.svg)}`;
    if (diagramPreviewCache.get(key) === entry) {
      diagramPreviewCacheBytes += src.length * 2;
      entry.bytes += src.length * 2;
      trimDiagramPreviewCache();
    }
    return { viewBox, src };
  }).catch(error => {
    if (diagramPreviewCache.get(key) === entry) {
      diagramPreviewCache.delete(key);
      diagramPreviewCacheBytes -= entry.bytes;
    }
    throw error;
  });
  diagramPreviewCache.set(key, entry);
  diagramPreviewCacheBytes += entry.bytes;
  trimDiagramPreviewCache();
  return entry.promise;
}
function trimDiagramPreviewCache() {
  while (diagramPreviewCache.size > 20 || diagramPreviewCacheBytes > DIAGRAM_PREVIEW_CACHE_LIMIT) {
    const key = diagramPreviewCache.keys().next().value;
    diagramPreviewCacheBytes -= diagramPreviewCache.get(key).bytes;
    diagramPreviewCache.delete(key);
  }
}

async function renderPreviewDiagrams(container) {
  for (const block of container.querySelectorAll('pre')) {
    if (!isDiagramCodeBlock(block) || block.dataset.diagramProcessed) continue;
    block.dataset.diagramProcessed = 'true';
    const source = block.textContent;
    const figure = document.createElement('figure');
    figure.className = 'markdown-diagram';
    const status = document.createElement('p');
    status.className = 'hint';
    status.textContent = '正在渲染流程图…';
    status.setAttribute('role', 'status');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看图表源码';
    block.replaceWith(figure);
    details.append(summary, block);
    figure.append(status, details);
    try {
      const renderer = await loadDiagramRenderer();
      if (!container.contains(figure)) continue;
      const { viewBox, src } = await cachedDiagramPreview(source, renderer);
      if (!container.contains(figure)) continue;
      // An SVG image keeps diagram markup separate from the application's DOM.
      const image = document.createElement('img');
      image.className = 'markdown-diagram-image';
      image.alt = 'Mermaid 流程图';

      if (viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0) image.width = Math.ceil(viewBox[2]);
      image.src = src;
      await image.decode();
      if (!container.contains(figure)) continue;
      status.replaceWith(createDiagramViewer(image, viewBox));
    } catch (error) {
      if (!container.contains(figure)) continue;
      status.textContent = `图表无法显示：${error.message || '未知错误'}。源码已保留。`;
      status.classList.add('markdown-diagram-error');
      details.open = true;
    }
  }
}

function zoomDiagramTransform(state, scale, anchor) {
  const nextScale = Math.max(0.05, Math.min(8, scale));
  const ratio = nextScale / state.scale;
  return { scale: nextScale, x: anchor.x - (anchor.x - state.x) * ratio, y: anchor.y - (anchor.y - state.y) * ratio };
}

const DIAGRAM_ICON_PATHS = {
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>'
};
function createDiagramIconButton(label, icon, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diagram-icon-button';
  setDiagramButtonTooltip(button, label);
  button.innerHTML = DIAGRAM_ICON_PATHS[icon]
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">${DIAGRAM_ICON_PATHS[icon]}</svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`;
  button.onclick = action;
  return button;
}

// The heading above a diagram names it in fullscreen and in exported files.
function diagramHeading(trigger) {
  const block = trigger.closest('.note-diagram-toggle-host')?.noteCodeBlock || trigger.closest('.markdown-diagram');
  for (let node = block; node; ) {
    const previous = node.previousElementSibling;
    if (!previous) { node = node.parentElement; if (!node || node.matches('.ql-editor, .markdown-body, body')) break; continue; }
    node = previous;
    if (/^H[1-6]$/.test(node.tagName) && node.textContent.trim()) return node.textContent.trim();
  }
  return '';
}

async function exportDiagramPng(image, width, height, name) {
  const scale = Math.min(3, Math.max(1, 4096 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = diagramIsDark() ? '#181B22' : '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const source = new Image();
  source.src = image.src;
  await source.decode();
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图表导出失败');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(name || 'Mermaid 图表').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Mermaid 图表'}.png`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function openDiagramFullscreen(image, viewBox, trigger) {
  if (document.querySelector('.diagram-fullscreen-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'diagram-fullscreen-dialog';
  dialog.setAttribute('aria-label', 'Mermaid 图表全屏预览');
  const header = document.createElement('div');
  header.className = 'diagram-fullscreen-header';
  const title = document.createElement('h2');
  const block = trigger.closest('.note-diagram-toggle-host')?.noteCodeBlock;
  const name = block?.dataset.codeTitle?.trim() || '';
  title.textContent = name || 'Mermaid 图表';
  const heading = diagramHeading(trigger);
  const crumb = document.createElement('span');
  crumb.className = 'diagram-fullscreen-crumb';
  crumb.textContent = heading;
  crumb.hidden = !heading;
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'diagram-fullscreen-export';
  exportButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DIAGRAM_ICON_PATHS.download}</svg><span>导出 PNG</span>`;
  exportButton.onclick = async () => {
    exportButton.disabled = true;
    try { await exportDiagramPng(image, viewBox[2], viewBox[3], name || heading); }
    catch (error) { exportButton.querySelector('span').textContent = error.message || '导出失败'; }
    finally { exportButton.disabled = false; }
  };
  const hint = document.createElement('kbd');
  hint.className = 'diagram-fullscreen-exit-hint';
  hint.textContent = 'Esc';
  hint.title = '按 Esc 退出全屏';
  const close = createDiagramIconButton('退出全屏预览', 'minimize', () => dialog.close());
  close.classList.add('diagram-fullscreen-close');
  close.setAttribute('aria-keyshortcuts', 'Escape');
  header.append(title, crumb, exportButton, hint, close);
  // A separate viewer keeps the inline diagram's zoom, position and editor content intact.
  const controller = new AbortController();
  const viewer = createDiagramViewer(image.cloneNode(), viewBox, { allowFullscreen: false, resizeSignal: controller.signal, fullscreen: true });
  dialog.append(header, viewer);
  dialog.addEventListener('close', () => {
    controller.abort();
    dialog.remove();
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  }, { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
    event.stopPropagation();
  });
  document.body.append(dialog);
  dialog.showModal();
  viewer.querySelector('.diagram-viewport').focus({ preventScroll: true });
}

function createDiagramViewer(image, viewBox, { allowFullscreen = true, resizeSignal, onZoom, initialTransform, preserveViewport = false, fullscreen = false } = {}) {
  const viewer = document.createElement('div');
  viewer.className = 'diagram-viewer';
  const toolbar = document.createElement('div');
  toolbar.className = 'diagram-viewer-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '流程图缩放');
  const viewport = document.createElement('div');
  viewport.className = 'diagram-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '流程图：拖动移动，Alt / Option + 滚轮或触控板捏合缩放，+ − 缩放，0 适应宽度，方向键移动');
  const width = viewBox[2] > 0 ? viewBox[2] : image.naturalWidth;
  const height = viewBox[3] > 0 ? viewBox[3] : image.naturalHeight;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.draggable = false;
  // Minimap and fade only appear while part of the diagram is outside the viewport.
  const minimap = document.createElement('div');
  minimap.className = 'diagram-minimap';
  minimap.hidden = true;
  minimap.setAttribute('aria-hidden', 'true');
  const thumb = image.cloneNode();
  thumb.className = 'diagram-minimap-image';
  thumb.removeAttribute('width');
  thumb.style.cssText = '';
  thumb.alt = '';
  const frame = document.createElement('span');
  frame.className = 'diagram-minimap-frame';
  minimap.append(thumb, frame);
  const thumbWidth = Math.min(132, 110 * width / height), thumbHeight = thumbWidth * height / width;
  thumb.style.width = `${thumbWidth}px`; thumb.style.height = `${thumbHeight}px`;
  const fade = document.createElement('div');
  fade.className = 'diagram-viewport-fade';
  fade.hidden = true;
  let state = initialTransform ? { ...initialTransform } : { scale: 1, x: 0, y: 0 }, drag = null;
  let viewportInitialized = Boolean(initialTransform);
  const percent = document.createElement('output');
  const autoHeight = () => !fullscreen && !viewer.closest('.note-diagram-inline-preview');
  const paint = () => {
    image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    percent.textContent = `${Math.round(state.scale * 100)}%`;
    const w = viewport.clientWidth, h = viewport.clientHeight;
    const overflow = w > 0 && (width * state.scale > w + 1 || height * state.scale > h + 1);
    minimap.hidden = !overflow;
    fade.hidden = !(w > 0 && state.y + height * state.scale > h + 4 && state.y < h);
    if (overflow) {
      const ratio = thumbWidth / width;
      const left = Math.max(0, -state.x / state.scale), top = Math.max(0, -state.y / state.scale);
      const right = Math.min(width, (w - state.x) / state.scale), bottom = Math.min(height, (h - state.y) / state.scale);
      frame.style.left = `${left * ratio}px`; frame.style.top = `${top * ratio}px`;
      frame.style.width = `${Math.max(6, (right - left) * ratio)}px`; frame.style.height = `${Math.max(6, (bottom - top) * ratio)}px`;
    }
    onZoom?.(state.scale);
  };
  const center = () => ({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
  const zoom = (scale, anchor = center()) => { state = zoomDiagramTransform(state, scale, anchor); paint(); };
  // Default view: fill the width (never enlarge past 100%) and start at the top.
  const fit = () => {
    const scale = Math.max(0.05, Math.min(1, (viewport.clientWidth - 48) / width));
    if (autoHeight()) viewport.style.height = `${Math.round(Math.min(560, Math.max(220, height * scale + 48)))}px`;
    const tall = height * scale + 48 > viewport.clientHeight;
    state = { scale, x: (viewport.clientWidth - width * scale) / 2, y: tall ? 24 : (viewport.clientHeight - height * scale) / 2 };
    paint();
  };
  const fitAll = () => {
    const scale = Math.max(0.05, Math.min(1, (viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    state = { scale, x: (viewport.clientWidth - width * scale) / 2, y: (viewport.clientHeight - height * scale) / 2 };
    paint();
  };
  const textButton = (label, text, action, className) => {
    const item = document.createElement('button');
    item.type = 'button'; item.className = className; item.onclick = action;
    if (typeof text === 'string') item.textContent = text; else item.append(text);
    setDiagramButtonTooltip(item, label, false);
    return item;
  };
  const separator = () => { const line = document.createElement('span'); line.className = 'diagram-toolbar-separator'; return line; };
  toolbar.append(
    createDiagramIconButton('缩小', 'minus', () => zoom(state.scale / 1.2)),
    textButton('原始大小', percent, () => (Math.abs(state.scale - 1) < .001 ? fit() : zoom(1)), 'diagram-zoom-percent'),
    createDiagramIconButton('放大', 'plus', () => zoom(state.scale * 1.2)),
    separator(),
    createDiagramIconButton('适应宽度', 'fit', fit));
  if (fullscreen) toolbar.append(textButton('查看全图', '全图', fitAll, 'diagram-fit-all'));
  if (allowFullscreen) {
    const fullscreenButton = createDiagramIconButton('全屏预览图表', 'maximize', () => openDiagramFullscreen(image, [0, 0, width, height], fullscreenButton));
    fullscreenButton.classList.add('diagram-fullscreen-button');
    fullscreenButton.setAttribute('aria-haspopup', 'dialog');
    toolbar.append(fullscreenButton);
  }
  viewport.append(image);
  viewer.append(viewport, fade, minimap, toolbar);
  const jump = event => {
    const rect = thumb.getBoundingClientRect(), ratio = thumbWidth / width;
    const x = Math.max(0, Math.min(width, (event.clientX - rect.left) / ratio)), y = Math.max(0, Math.min(height, (event.clientY - rect.top) / ratio));
    state = { ...state, x: viewport.clientWidth / 2 - x * state.scale, y: viewport.clientHeight / 2 - y * state.scale };
    paint();
  };
  minimap.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); minimap.setPointerCapture(event.pointerId); jump(event);
    const move = next => jump(next);
    minimap.addEventListener('pointermove', move);
    minimap.addEventListener('pointerup', () => minimap.removeEventListener('pointermove', move), { once: true });
  });
  viewport.addEventListener('wheel', event => {
    // Alt/Option + wheel, or a trackpad pinch (reported as Ctrl + wheel).
    if (!event.altKey && !event.ctrlKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1) * (event.ctrlKey && !event.altKey ? 2.5 : 1);
    zoom(state.scale * Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.004), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); viewport.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-dragging');
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    state.x += event.clientX - drag.x; state.y += event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY; paint();
  });
  const stop = event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; viewport.classList.remove('is-dragging');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener('pointerup', stop);
  viewport.addEventListener('pointercancel', stop);
  viewport.addEventListener('lostpointercapture', stop);
  viewport.addEventListener('keydown', event => {
    if (event.key === '+' || event.key === '=') zoom(state.scale * 1.2);
    else if (event.key === '-') zoom(state.scale / 1.2);
    else if (event.key === '0') fit();
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      state.x += event.key === 'ArrowLeft' ? -30 : event.key === 'ArrowRight' ? 30 : 0;
      state.y += event.key === 'ArrowUp' ? -30 : event.key === 'ArrowDown' ? 30 : 0; paint();
    } else return;
    event.preventDefault(); event.stopPropagation();
  });
  if (resizeSignal) {
    const observer = new ResizeObserver(() => { if (viewer.isConnected && (!preserveViewport || !viewportInitialized)) { fit(); viewportInitialized = true; } });
    observer.observe(viewport);
    resizeSignal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }
  requestAnimationFrame(() => { if (viewer.isConnected) { if (preserveViewport && viewportInitialized) paint(); else fit(); viewportInitialized = true; } });
  viewer.diagramControls = { zoom, fit, fitAll, getTransform: () => ({ ...state }) };
  return viewer;
}

function richEditorDiagramSources(root) {
  return [...root.querySelectorAll('.ql-code-block-container')].map(block => {
    const lines = [...block.querySelectorAll('.ql-code-block')];
    const source = lines.map(line => line.textContent).join('\n');
    const language = (lines[0]?.dataset.language || '').toLowerCase();
    return language === 'mermaid' || (['', 'plain', 'text'].includes(language) && isMermaidSource(source)) ? source : null;
  }).filter(source => source !== null);
}

function bindEditorDiagramPreview(root, column, { onEdit } = {}) {
  // The overlay is outside Quill, so toggling never changes saved content or undo.
  const layer = document.createElement('div');
  layer.className = 'note-diagram-toggle-layer';
  column.append(layer);
  const entries = new Map();
  const codeActionsLayer = column.querySelector('.note-code-copy-layer');
  let timer, disposed = false;
  const position = () => {
    const parent = column.getBoundingClientRect();
    const blocks = [...root.querySelectorAll('.ql-code-block-container')];
    for (const [block, entry] of entries) {
      const rect = block.getBoundingClientRect();
      entry.host.style.display = rect.width && rect.height && block.dataset.codeCollapsed !== 'true' ? '' : 'none';
      entry.host.style.left = `${rect.left - parent.left}px`;
      entry.host.style.top = `${rect.top - parent.top}px`;
      entry.host.style.width = `${rect.width}px`;
      entry.host.style.height = `${rect.height}px`;
      const more = codeActionsLayer?.querySelector(`.note-code-more[data-code-block-index="${blocks.indexOf(block)}"]`);
      const actions = more?.closest('.note-code-actions');
      // Both toolbars are overlays outside Quill. Measure the visible action row
      // instead of assuming the collapsed more button is its only content.
      if (actions && actions.classList.contains('is-diagram-preview') !== entry.showing) actions.classList.toggle('is-diagram-preview', entry.showing);
      const occupied = actions?.querySelector('.note-code-primary-actions') || (actions?.classList.contains('is-open') ? actions : more);
      const hostRect = entry.host.getBoundingClientRect();
      const scale = hostRect.width / entry.host.offsetWidth || 1;
      const right = occupied ? (hostRect.right - occupied.getBoundingClientRect().left) / scale + 8 : 54;
      entry.button.style.right = `${Math.max(54, right)}px`;
      const edit = entry.host.querySelector('.note-diagram-edit');
      if (edit) { edit.style.left = 'auto'; edit.style.right = `${Math.max(54, right) + entry.button.offsetWidth + 6}px`; }
      const beforeRight = Math.max(54, right) + entry.button.offsetWidth + 6 + (edit ? edit.offsetWidth + 6 : 0);
      entry.before.style.right = `${beforeRight}px`;
      entry.before.disabled = root.getAttribute('contenteditable') !== 'true';
      entry.actions = actions;
      if (actions) {
        const reserved = block.dataset.codeCollapsed === 'true' ? '' : `${beforeRight + entry.before.offsetWidth + 8}px`;
        if (actions.style.getPropertyValue('--note-diagram-controls-width') !== reserved) {
          if (reserved) actions.style.setProperty('--note-diagram-controls-width', reserved);
          else actions.style.removeProperty('--note-diagram-controls-width');
        }
      }
    }
  };
  const draw = entry => {
    entry.preview.replaceChildren();
    const pre = document.createElement('pre');
    pre.dataset.language = 'mermaid';
    pre.textContent = entry.source;
    entry.preview.append(pre);
    void renderPreviewDiagrams(entry.preview);
  };
  const setPreview = (entry, showing) => {
    entry.showing = showing;
    entry.preview.hidden = !showing;
    entry.button.textContent = showing ? '源码' : '预览';
    setDiagramButtonTooltip(entry.button, showing ? '查看图表源码' : '预览图表', false);
    entry.button.setAttribute('aria-pressed', String(showing));
    entry.host.classList.toggle('is-preview', showing);
    if (showing) draw(entry);
    else entry.preview.replaceChildren();
  };
  const refresh = (previewInitially = false) => {
    if (disposed) return;
    const blocks = [...root.querySelectorAll('.ql-code-block-container')];
    const retained = new Set();
    for (const block of blocks) {
      const sources = richEditorDiagramSources({ querySelectorAll: () => [block] });
      if (!sources.length) continue;
      retained.add(block);
      let entry = entries.get(block);
      if (!entry) {
        const host = document.createElement('div');
        host.className = 'note-diagram-toggle-host';
        host.noteCodeBlock = block;
        const preview = document.createElement('div');
        preview.className = 'note-diagram-inline-preview';
        preview.setAttribute('aria-label', '流程图预览');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'note-diagram-toggle';
        const before = document.createElement('button');
        before.type = 'button'; before.className = 'note-diagram-insert-before';
        setDiagramButtonTooltip(before, '在图表上方插入空行');
        before.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 19h16M12 14V4m-4 4 4-4 4 4"/></svg>';
        host.append(preview, before, button);
        if (onEdit) {
          const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'note-diagram-edit';
          setDiagramButtonTooltip(edit, '编辑 Mermaid 图表', false);
          edit.innerHTML = '<svg aria-hidden="true"><use href="#icon-pencil"></use></svg><span>编辑图表</span>';
          edit.onclick = () => onEdit(block, edit);
          host.append(edit);
        }
        layer.append(host);
        entry = { host, preview, button, before, source: sources[0], showing: false };
        entries.set(block, entry);
        button.onclick = () => {
          setPreview(entry, !entry.showing);
          position();
        };
        setPreview(entry, previewInitially);
      } else if (entry.source !== sources[0]) {
        entry.source = sources[0];
        if (entry.showing) draw(entry);
      }
    }
    for (const [block, entry] of entries) {
      if (!retained.has(block)) { entry.actions?.style.removeProperty('--note-diagram-controls-width'); entry.host.remove(); entries.delete(block); }
    }
    position();
  };
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-language', 'data-code-collapsed', 'contenteditable'] });
  // Includes menu toggles, rebuilt action rows and the temporary “已复制” label.
  const actionsObserver = new MutationObserver(position);
  if (codeActionsLayer) actionsObserver.observe(codeActionsLayer, { childList: true, subtree: true, attributes: true, characterData: true });
  const resize = new ResizeObserver(position);
  resize.observe(root);
  resize.observe(column);
  window.addEventListener('resize', position);
  const showRequestedPreview = event => {
    refresh();
    const entry = entries.get(event.detail?.block);
    if (entry && !entry.showing) { setPreview(entry, true); position(); }
  };
  root.addEventListener('note-diagram-preview', showRequestedPreview);
  // Diagram colors follow the app appearance; redraw open previews when it changes.
  const appearanceObserver = new MutationObserver(() => { for (const entry of entries.values()) if (entry.showing) draw(entry); });
  appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] });
  // Preview saved diagrams on open; newly inserted blocks stay editable while writing.
  refresh(true);
  return () => {
    disposed = true;
    clearTimeout(timer);
    observer.disconnect();
    actionsObserver.disconnect();
    resize.disconnect();
    window.removeEventListener('resize', position);
    root.removeEventListener('note-diagram-preview', showRequestedPreview);
    appearanceObserver.disconnect();
    layer.remove();
    for (const entry of entries.values()) entry.actions?.style.removeProperty('--note-diagram-controls-width');
    entries.clear();
  };
}
