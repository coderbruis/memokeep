(function expose(root) {
  function createShellView({ window, document, Element, $$, state, notify }) {
    function bind() {
      // Show compact-sidebar labels from one fixed layer so they are not clipped
      // or intercepted by the full-height collapse control.
      const sidebarTooltip = document.createElement('div');
      sidebarTooltip.id = 'shellHoverTooltip';
      sidebarTooltip.className = 'sidebar-hover-tooltip';
      sidebarTooltip.setAttribute('role', 'tooltip');
      document.body.appendChild(sidebarTooltip);
      let tooltipTarget = null, tooltipTitle = null, pendingTooltipTarget = null, tooltipTimer = null;
      let lastToolbarTooltipAt = 0;
      const sidebarTooltipSelector = '.shell nav .nav, .shell .sidebar-more-button, .sidebar-action-bar button, #sidebarPluginManage';
      const nameTooltipSelector = '.tree-document, .tree-library, .card-tree-label, .document-summary h3, .card-content-cell > strong, .card-notebook-copy > strong, .note-tab-select';
      const hideSidebarTooltip = () => {
        window.clearTimeout(tooltipTimer);
        tooltipTimer = null; pendingTooltipTarget = null;
        tooltipObserver.disconnect();
        if (tooltipTarget && sidebarTooltip.classList.contains('toolbar-tooltip')) lastToolbarTooltipAt = window.performance.now();
        if (tooltipTarget) {
          if (tooltipTitle !== null && !tooltipTarget.hasAttribute('title')) tooltipTarget.setAttribute('title', tooltipTitle);
          const description = (tooltipTarget.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== sidebarTooltip.id).join(' ');
          if (description) tooltipTarget.setAttribute('aria-describedby', description);
          else tooltipTarget.removeAttribute('aria-describedby');
        }
        tooltipTarget = null; tooltipTitle = null;
        sidebarTooltip.classList.remove('visible', 'name-tooltip', 'in-place', 'toolbar-tooltip');
        sidebarTooltip.style.height = '';
      };
      const tooltipObserver = new window.MutationObserver(() => {
        if (tooltipTarget && !tooltipTarget.isConnected) hideSidebarTooltip();
      });
      const positionToolbarTooltip = rect => {
        const gap = 10, edge = 8;
        const width = sidebarTooltip.offsetWidth, height = sidebarTooltip.offsetHeight;
        let left = rect.left + (rect.width - width) / 2;
        let top = rect.top - height - gap;
        if (document.querySelector('.shell.sidebar-collapsed') || top < edge) {
          left = rect.right + gap;
          if (left + width > window.innerWidth - edge) left = rect.left - width - gap;
          top = rect.top + (rect.height - height) / 2;
        }
        sidebarTooltip.style.left = `${Math.round(Math.max(edge, Math.min(left, window.innerWidth - width - edge)))}px`;
        sidebarTooltip.style.top = `${Math.round(Math.max(edge, Math.min(top, window.innerHeight - height - edge)))}px`;
      };
      const showSidebarTooltip = target => {
        if (!(target instanceof Element) || !target.matches(sidebarTooltipSelector)) return;
        hideSidebarTooltip();
        // The compact rail can be expanded while the pointer remains over a button.
        const toolbarAction = target.matches('.sidebar-action-bar button');
        if (!toolbarAction && !document.querySelector('.shell.sidebar-collapsed')) { hideSidebarTooltip(); return; }
        const label = (toolbarAction ? target.getAttribute('aria-label') : null) || target.getAttribute('title') || target.querySelector('.nav-label')?.textContent?.trim();
        if (!label) { hideSidebarTooltip(); return; }
        tooltipTarget = target;
        sidebarTooltip.textContent = label;
        const rect = target.getBoundingClientRect();
        sidebarTooltip.style.left = `${Math.round(rect.right + 10)}px`;
        sidebarTooltip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
        sidebarTooltip.classList.toggle('toolbar-tooltip', toolbarAction);
        sidebarTooltip.classList.add('visible');
        if (toolbarAction) {
          tooltipTitle = target.getAttribute('title');
          target.removeAttribute('title');
          target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), sidebarTooltip.id].filter(Boolean).join(' '));
          positionToolbarTooltip(rect);
          lastToolbarTooltipAt = window.performance.now();
          tooltipObserver.observe(document.body, { childList: true, subtree: true });
        }
      };
      const scheduleSidebarTooltip = target => {
        if (!target.matches('.sidebar-action-bar button')) { showSidebarTooltip(target); return; }
        const delay = lastToolbarTooltipAt && window.performance.now() - lastToolbarTooltipAt < 500 ? 80 : 350;
        hideSidebarTooltip();
        pendingTooltipTarget = target;
        tooltipTimer = window.setTimeout(() => {
          if (target.isConnected && target.getClientRects().length) showSidebarTooltip(target);
          else hideSidebarTooltip();
        }, delay);
      };
      const showNameTooltip = target => {
        hideSidebarTooltip();
        const label = target.querySelector('.tree-label-text, .note-tab-title') || target.querySelector(':scope > span') || target;
        if (!label.getClientRects().length || label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1) return;
        const text = label.textContent.trim();
        if (!text) return;
        tooltipTarget = target; tooltipTitle = target.getAttribute('title');
        // Native title delays are controlled by the OS; suppress its duplicate while shown.
        target.removeAttribute('title');
        target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), sidebarTooltip.id].filter(Boolean).join(' '));
        sidebarTooltip.textContent = text;
        sidebarTooltip.classList.remove('toolbar-tooltip');
        // 侧栏目录名：在名称原位向右展开、与行同高，不遮住相邻的行。
        const row = target.closest('.shell > header :is(.tree-library-row, .tree-document-row, .card-tree-row)');
        sidebarTooltip.classList.toggle('in-place', Boolean(row));
        sidebarTooltip.classList.add('name-tooltip', 'visible');
        if (row) {
          const labelRect = label.getBoundingClientRect(), rowRect = row.getBoundingClientRect();
          sidebarTooltip.style.height = `${Math.round(rowRect.height)}px`;
          const width = sidebarTooltip.offsetWidth;
          sidebarTooltip.style.left = `${Math.round(Math.max(8, Math.min(labelRect.left - 11, window.innerWidth - width - 8)))}px`;
          sidebarTooltip.style.top = `${Math.round(rowRect.top)}px`;
          tooltipObserver.observe(document.body, { childList: true, subtree: true });
          return;
        }
        sidebarTooltip.style.height = '';
        const rect = label.getBoundingClientRect(), width = sidebarTooltip.offsetWidth, height = sidebarTooltip.offsetHeight;
        sidebarTooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
        const top = rect.bottom + 8 + height <= window.innerHeight - 8 ? rect.bottom + 8 : rect.top - height - 8;
        sidebarTooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
        tooltipObserver.observe(document.body, { childList: true, subtree: true });
      };
      // Capturing enter/leave also covers names created by tree and list rerenders.
      document.addEventListener('mouseenter', event => {
        if (event.target instanceof Element && event.target.matches(nameTooltipSelector)) showNameTooltip(event.target);
      }, true);
      document.addEventListener('mouseleave', event => { if (event.target === tooltipTarget || event.target === pendingTooltipTarget) hideSidebarTooltip(); }, true);
      document.addEventListener('focusin', event => {
        if (!(event.target instanceof Element)) return;
        const target = event.target.closest(nameTooltipSelector) || event.target.querySelector(nameTooltipSelector);
        if (target) showNameTooltip(target);
      });
      document.addEventListener('focusout', event => {
        if (tooltipTarget && event.target.contains(tooltipTarget)) hideSidebarTooltip();
      });
      document.addEventListener('pointerdown', hideSidebarTooltip, true);
      document.addEventListener('click', hideSidebarTooltip, true);
      document.addEventListener('keydown', event => { if (event.key === 'Escape') hideSidebarTooltip(); });
      document.addEventListener('scroll', hideSidebarTooltip, true);
      window.addEventListener('blur', hideSidebarTooltip);
      // Bind to the buttons themselves. Delegated pointerover is unreliable in the
      // desktop WebView when the SVG <use> element is the event target.
      $$(sidebarTooltipSelector).forEach(target => {
        if (target.matches('.sidebar-action-bar button')) target.removeAttribute('title');
        target.addEventListener('pointerdown', hideSidebarTooltip);
        target.addEventListener('mouseenter', () => scheduleSidebarTooltip(target));
        target.addEventListener('mouseleave', hideSidebarTooltip);
        target.addEventListener('focus', () => showSidebarTooltip(target));
        target.addEventListener('blur', hideSidebarTooltip);
      });
      window.addEventListener('resize', hideSidebarTooltip);
      // Do not allow commands to mutate the empty placeholder model during hydration.
      document.addEventListener('click', event => {
        if (state.ready || !event.target.closest('.shell')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        notify('正在加载笔记数据，请稍候…');
      }, true);
      document.addEventListener('keydown', event => {
        if (!state.ready && event.target.closest('.shell')) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
    }
    return { bind };
  }
  const api = { createShellView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
