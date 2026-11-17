// 侧栏宽度拖动与滚动条显示时机（design/prototype/sidebar-tree-width-20261108.md）。
(function sidebarLayout() {
  const WIDTH_KEY = 'memokeep-sidebar-width', MIN = 180, MAX = 360, DEFAULT = 208, STEP = 8;
  const clamp = value => Math.round(Math.min(MAX, Math.max(MIN, value)));
  const read = () => {
    try { const value = Number(localStorage.getItem(WIDTH_KEY)); return value ? clamp(value) : DEFAULT; } catch { return DEFAULT; }
  };

  function init() {
    if (document.documentElement.classList.contains('note-window')) return;
    const header = document.querySelector('.shell > header'), nav = header?.querySelector(':scope > nav');
    if (!header || !nav) return;

    let width = read();
    const resizer = document.createElement('div');
    resizer.className = 'sidebar-resizer';
    resizer.tabIndex = 0;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', '调整侧栏宽度');
    resizer.setAttribute('aria-valuemin', String(MIN));
    resizer.setAttribute('aria-valuemax', String(MAX));
    resizer.title = '拖动调整侧栏宽度，双击恢复默认';
    const badge = document.createElement('span');
    badge.className = 'sidebar-resizer-badge';
    badge.hidden = true;
    resizer.append(badge);
    header.append(resizer);

    const apply = (value, { save = true, show = false } = {}) => {
      width = clamp(value);
      document.documentElement.style.setProperty('--workspace-sidebar-width', `${width}px`);
      resizer.setAttribute('aria-valuenow', String(width));
      resizer.setAttribute('aria-valuetext', `${width} 像素`);
      badge.textContent = `${width}px`;
      badge.hidden = !show;
      if (save) { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {} }
    };
    apply(width, { save: false });

    // 拖动时只改 .shell 自身的列宽（不改根变量，避免全页样式重算），每帧最多一次；
    // 右侧内容固定在按下时的宽度，拖动中不重排笔记，松开后再统一重排一次。
    const shell = header.parentElement;
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      const startX = event.clientX, startWidth = width;
      const frozen = [...shell.children].filter(element => element !== header && !element.classList.contains('window-toolbar')
        && element.getClientRects().length && !['fixed', 'absolute'].includes(getComputedStyle(element).position));
      const saved = frozen.map(element => [element, element.style.width, element.style.maxWidth]);
      frozen.forEach(element => { element.style.width = `${element.getBoundingClientRect().width}px`; element.style.maxWidth = 'none'; });
      resizer.classList.add('dragging');
      document.body.classList.add('sidebar-resizing');
      let pendingX = startX, frame = 0;
      const tabsBar = document.querySelector('#librariesView.has-note-tabs:not(.hidden) #noteTabsBar');
      const pageTab = document.querySelector('.workspace-titlebar');
      const paint = () => {
        frame = 0;
        width = clamp(startWidth + pendingX - startX);
        shell.style.gridTemplateColumns = `${width}px minmax(0, 1fr)`;
        tabsBar?.style.setProperty('--workspace-sidebar-width', `${width}px`); // 第一个标签跟着编辑区左边走（note-tabs.css）
        pageTab?.style.setProperty('--workspace-sidebar-width', `${width}px`); // 页面标签也一样（workspace-design.css）
        badge.textContent = `${width}px`;
        badge.hidden = false;
      };
      const move = moveEvent => { pendingX = moveEvent.clientX; if (!frame) frame = requestAnimationFrame(paint); };
      const end = () => {
        if (frame) { cancelAnimationFrame(frame); paint(); }
        resizer.classList.remove('dragging');
        document.body.classList.remove('sidebar-resizing');
        resizer.removeEventListener('pointermove', move);
        saved.forEach(([element, previousWidth, previousMaxWidth]) => { element.style.width = previousWidth; element.style.maxWidth = previousMaxWidth; });
        shell.style.gridTemplateColumns = '';
        tabsBar?.style.removeProperty('--workspace-sidebar-width');
        pageTab?.style.removeProperty('--workspace-sidebar-width');
        apply(width);
        window.dispatchEvent(new Event('resize'));
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', end, { once: true });
      resizer.addEventListener('pointercancel', end, { once: true });
    });
    resizer.addEventListener('dblclick', () => { apply(DEFAULT); window.dispatchEvent(new Event('resize')); });
    resizer.addEventListener('keydown', event => {
      const next = { ArrowLeft: width - STEP, ArrowRight: width + STEP, Home: MIN, End: MAX }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      apply(next, { show: true });
    });
    resizer.addEventListener('blur', () => { badge.hidden = true; });

    // 滚动中显示滚动条，停止 800ms 后淡出；悬停时由 CSS 显示。
    let scrollTimer = 0;
    nav.addEventListener('scroll', () => {
      nav.classList.add('is-scrolling');
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => nav.classList.remove('is-scrolling'), 800);
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
