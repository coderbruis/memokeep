// Shared answer presentation and post-rating memory details.
const ReviewPresentation = (() => {
  const panels = new WeakMap();
  const ratingLabels = { again: '忘记', hard: '有点难', good: '记住', easy: '很简单' };
  const timestamp = value => {
    if (value === null || value === undefined || value === '') return null;
    const time = typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  };
  function dateLabel(value) {
    const time = timestamp(value);
    return time === null ? '尚未复习' : new Date(time).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function element(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }
  // Only local image references are interpreted; all other content stays literal text.
  const imagePattern = /!\[([^\]\n]*)\]\((memokeep-image:\/\/[0-9a-f-]{36})(?:#w=(\d{1,3}))?\)/gi;
  function contentParts(value) {
    const parts = []; let start = 0;
    for (const match of String(value || '').matchAll(imagePattern)) {
      if (match.index > start) parts.push({ text: String(value).slice(start, match.index) });
      parts.push({ reference: match[2], alt: match[1], width: Math.max(20, Math.min(100, Number(match[3]) || 48)), token: match[0] });
      start = match.index + match[0].length;
    }
    if (start < String(value || '').length) parts.push({ text: String(value).slice(start) });
    return parts;
  }
  function imageNode(part) {
    const image = element('img', 'card-inline-image');
    image.alt = part.alt || '卡片图片'; image.dataset.reference = part.reference;
    image.dataset.width = String(part.width); image.style.width = `${part.width}%`;
    image.draggable = false;
    if (/^data:image\//i.test(part.reference)) { image.src = part.reference; return image; }
    const id = part.reference.split('://')[1];
    window.memoKeepDesktop?.readNoteImage?.(id).then(result => {
      if (result?.dataUrl) image.src = result.dataUrl;
      else image.alt = '图片不可用';
    }).catch(() => { image.alt = '图片读取失败'; });
    return image;
  }
  function enlarge(image) {
    if (!image.src) return;
    const dialog = document.createElement('dialog'); dialog.className = 'card-image-lightbox';
    const close = element('button', '', '关闭'); close.type = 'button'; close.onclick = () => dialog.close();
    const full = document.createElement('img'); full.src = image.src; full.alt = image.alt;
    dialog.append(close, full); document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  }
  function renderCloze(container, card, reveal) {
    container.textContent = ''; container.classList.add('card-rich-content');
    for (const part of window.MemoKeepCardFormats.clozeParts(card.question)) {
      if (part.answer !== undefined) {
        const span = element('span', 'cf-cloze' + (reveal ? ' revealed' : ''), reveal ? part.answer : part.hint || '［…］');
        span.setAttribute('aria-label', reveal ? part.answer : '填空，先试着回忆'); container.appendChild(span);
      } else for (const item of contentParts(part.text)) container.appendChild(item.reference ? imageNode(item) : document.createTextNode(item.text));
    }
  }
  function renderOcclusion(container, card, reveal) {
    const rect = window.MemoKeepCardFormats?.normalizeOcclusion(card.imageOcclusion);
    if (!rect) return false;
    container.textContent = ''; container.classList.add('card-rich-content');
    if (!reveal) for (const part of contentParts(card.question)) if (part.reference !== rect.reference) container.appendChild(part.reference ? imageNode(part) : document.createTextNode(part.text));
    const figure = element('figure', 'cf-occlusion'); figure.setAttribute('aria-label', reveal ? '题图原图，遮挡已揭示' : '题图，框选部分已遮挡');
    const image = imageNode({ reference: rect.reference, alt: reveal ? '完整题图' : '遮挡卡题图', width: 100 }); figure.appendChild(image);
    if (!reveal) {
      const mask = element('span', 'cf-occlusion-mask', '?'); mask.setAttribute('aria-label', '待回忆区域');
      Object.assign(mask.style, { left:rect.x*100+'%', top:rect.y*100+'%', width:rect.w*100+'%', height:rect.h*100+'%' }); figure.appendChild(mask);
    } else { image.tabIndex = 0; image.setAttribute('role','button'); image.onclick = () => enlarge(image); image.onkeydown = event => { if(['Enter',' '].includes(event.key)){event.preventDefault();enlarge(image)} }; }
    container.appendChild(figure);
    if (container.closest('.review-shell')) {
      const fit = () => { if (image.naturalWidth && image.naturalHeight) figure.style.width = Math.min(650, container.clientWidth || 650, Math.max(90, Math.min(220, window.innerHeight * .3)) * image.naturalWidth / image.naturalHeight) + 'px'; };
      image.addEventListener('load', fit, { once: true }); if (image.complete) fit();
    }
    if (!reveal) {
      figure.tabIndex = 0; figure.setAttribute('role','button'); figure.setAttribute('aria-label','放大遮挡题图，遮挡区域保持隐藏');
      const enlargeMasked = () => {
        if (!image.src) return;
        const dialog=document.createElement('dialog');dialog.className='card-image-lightbox cf-occlusion-lightbox';
        const close=element('button','','关闭');close.type='button';close.onclick=()=>dialog.close();
        const copy=figure.cloneNode(true);copy.removeAttribute('role');copy.removeAttribute('tabindex');copy.style.width='100%';copy.style.maxWidth='none';dialog.append(close,copy);document.body.appendChild(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();close.focus();
      };
      figure.onclick=enlargeMasked;figure.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();enlargeMasked()}};
    }
    return true;
  }
  function renderContent(container, value, card) {
    if (card?.cardType === 'cloze' && window.MemoKeepCardFormats) { renderCloze(container, card, false); return; }
    if (card?.cardType === 'image-occlusion' && renderOcclusion(container, card, false)) return;
    container.textContent = ''; container.classList.add('card-rich-content');
    for (const part of contentParts(value)) {
      if (part.reference) {
        const image = imageNode(part); image.tabIndex = 0; image.setAttribute('role', 'button');
        image.onclick = () => enlarge(image);
        image.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); enlarge(image); } };
        container.appendChild(image);
      } else container.appendChild(document.createTextNode(part.text));
    }
  }
  function summary(value) { return contentParts(value).map(part => part.reference ? ' [图片] ' : part.text).join('').replace(/\{\{c\d+::([^{}]+?)\}\}/g, '［…］'); }
  function renderAnswer(container, answer, card) {
    if (card?.cardType === 'cloze' && window.MemoKeepCardFormats) {
      renderCloze(container, card, true);
      if (answer && answer.trim() !== window.MemoKeepCardFormats.clozeAnswer(card.question).trim()) container.appendChild(element('div','review-answer-prose',answer));
      return;
    }
    if (card?.cardType === 'image-occlusion' && renderOcclusion(container, card, true)) { container.appendChild(element('div','review-answer-prose',answer)); return; }
    if (contentParts(answer).some(part => part.reference)) { renderContent(container, answer); return; }
    container.classList.remove('card-rich-content');
    container.textContent = '';
    const value = String(answer || '');
    const lines = value.split(/\r?\n/).filter(line => line.trim());
    // Only align explicit short label/value lists; preserve prose and code verbatim.
    const labelled = lines.length > 1 && !value.includes('```') && lines.every(line => /^\s*([^:：\n]{1,10}[:：])\s*(\S.*)$/.test(line));
    if (!labelled) {
      container.appendChild(element('div', 'review-answer-prose', value));
      return;
    }
    lines.forEach(line => {
      const match = line.match(/^\s*([^:：\n]{1,10}[:：])\s*(\S.*)$/);
      const row = element('div', 'review-answer-entry');
      row.appendChild(element('strong', 'review-answer-term', match[1]));
      row.appendChild(element('div', 'review-answer-definition', match[2]));
      container.appendChild(row);
    });
  }
  function renderTrend(trend) {
    const section = element('section', 'review-memory-trend');
    section.appendChild(element('h4', '', '趋势'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 260 76');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '评分后的记忆趋势，圆点表示下次复习');
    const x = day => 8 + day / trend.days * 244;
    // This unlabeled sparkline uses the visible data range, rather than leaving
    // most of the chart empty beneath values clustered near the top of 0–1.
    const low = Math.min(...trend.points.map(p => p.value), trend.dueValue);
    const range = Math.max(1 - low, 0.000001);
    const y = value => 10 + (1 - value) / range * 44;
    for (const at of [10, 60]) {
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '8'); line.setAttribute('x2', '252');
      line.setAttribute('y1', String(at)); line.setAttribute('y2', String(at));
      line.setAttribute('class', 'review-memory-trend-guide');
      svg.appendChild(line);
    }
    const path = document.createElementNS(svg.namespaceURI, 'path');
    // Include the exact scheduled-time sample so the marker lies on the curve.
    const points = [...trend.points, { day: trend.dueDays, value: trend.dueValue }].sort((a, b) => a.day - b.day);
    path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(2)},${y(p.value).toFixed(2)}`).join(' '));
    svg.appendChild(path);
    const marker = document.createElementNS(svg.namespaceURI, 'circle');
    marker.setAttribute('class', 'review-memory-trend-marker');
    marker.setAttribute('cx', x(trend.dueDays).toFixed(2));
    marker.setAttribute('cy', y(trend.dueValue).toFixed(2));
    marker.setAttribute('r', '3.5');
    svg.appendChild(marker);
    section.appendChild(svg);
    const labels = element('div', 'review-memory-trend-labels');
    labels.style.setProperty('--review-position', `${x(trend.dueDays) / 260 * 100}%`);
    labels.appendChild(element('span', '', '本次复习'));
    labels.appendChild(element('span', 'review-memory-trend-next', '下次复习'));
    const minutes = Math.round(trend.days * 1440);
    const horizon = minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Number((minutes / 60).toFixed(1))} 小时` : `${trend.days} 天`;
    labels.appendChild(element('span', '', `+${horizon}`));
    section.appendChild(labels);
    section.appendChild(element('p', 'review-memory-caption', '模型估计'));
    return section;
  }
  function mount({ host, footer, sourceButton, closeSource, onExpand }) {
    if (panels.has(host)) return panels.get(host);
    const toggle = element('button', 'review-memory-toggle hidden', '记忆详情');
    toggle.type = 'button';
    const aside = element('aside', 'review-memory-panel hidden');
    aside.id = `${host.id || 'quickReview'}MemoryDetails`;
    aside.setAttribute('aria-label', '记忆详情');
    toggle.setAttribute('aria-controls', aside.id);
    toggle.setAttribute('aria-expanded', 'false');
    const heading = element('div', 'review-memory-head');
    heading.appendChild(element('h3', '', '记忆详情'));
    const close = element('button', 'review-memory-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭记忆详情');
    heading.appendChild(close);
    const body = element('div', 'review-memory-body');
    aside.appendChild(heading); aside.appendChild(body);
    host.appendChild(aside);
    footer.insertBefore(toggle, Array.from(footer.children).find(node => node.tagName === 'SPAN') || null);
    const panel = {
      isOpen: false,
      available: false,
      open() {
        if (!panel.available) return;
        closeSource?.();
        panel.isOpen = true;
        aside.classList.remove('hidden'); host.classList.add('memory-open');
        toggle.setAttribute('aria-expanded', 'true'); onExpand?.(true);
        close.focus({ preventScroll: true });
      },
      close({ focus = false, resize = true } = {}) {
        const wasOpen = panel.isOpen;
        panel.isOpen = false;
        aside.classList.add('hidden'); host.classList.remove('memory-open');
        toggle.setAttribute('aria-expanded', 'false');
        if (wasOpen && resize) onExpand?.(false);
        if (focus) toggle.focus({ preventScroll: true });
      },
      update(card, note, records, rated) {
        panel.available = Boolean(rated);
        toggle.classList.toggle('hidden', !rated);
        body.textContent = '';
        if (!rated) { panel.close(); return; }
        const summary = MemoScheduler.history(card, records);
        const latestRating = summary.logs.at(-1)?.rating;
        body.appendChild(element('p', 'review-memory-label', '复习安排'));
        body.appendChild(element('strong', 'review-memory-plan', MemoScheduler.intervalLabel(card.dueAt, card.lastReviewedAt)));
        body.appendChild(element('p', 'review-memory-caption', `${ratingLabels[latestRating] || '评分'} · 已保存，下次复习：${new Date(card.dueAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`));
        const trend = MemoScheduler.trend(card);
        if (trend) body.appendChild(renderTrend(trend));
        const facts = element('dl', 'review-memory-facts');
        const stability = /^fsrs/i.test(card.schedulerVersion || '') ? Number(card.schedulerData?.stability) : NaN;
        const values = [
          ['稳定度', Number.isFinite(stability) && stability > 0 ? `约 ${Number(stability.toFixed(1))} 天` : '尚未建立'],
          ['最近复习', dateLabel(summary.lastReviewedAt)],
          ['累计复习', `${summary.count} 次`]
        ];
        values.forEach(([label, value]) => {
          const row = element('div', 'review-memory-fact');
          row.appendChild(element('dt', '', label)); row.appendChild(element('dd', '', value)); facts.appendChild(row);
        });
        body.appendChild(facts);
        const history = summary.logs.slice(-3).reverse();
        const historySection = element('section', 'review-memory-section');
        historySection.appendChild(element('h4', '', '最近复习记录'));
        if (!history.length) historySection.appendChild(element('p', 'review-memory-caption', '暂无记录'));
        history.forEach(record => {
          const row = element('div', 'review-memory-history');
          row.appendChild(element('span', '', dateLabel(record.reviewedAt)));
          row.appendChild(element('strong', '', ratingLabels[record.rating])); historySection.appendChild(row);
        });
        body.appendChild(historySection);
        const source = element('section', 'review-memory-section');
        source.appendChild(element('h4', '', '来源笔记'));
        source.appendChild(element('strong', 'review-memory-note-title', note?.title || '手动创建'));
        if (note) {
          let content = note.content || '';
          if (note.metadata?.editorMode === 'note' && note.metadata?.noteContentInitialized) {
            const template = document.createElement('template');
            template.innerHTML = note.metadata.noteContent || '';
            template.content.querySelectorAll('script, style').forEach(node => node.remove());
            content = template.content.textContent || '';
          }
          source.appendChild(element('p', 'review-memory-excerpt', content.slice(0, 600) || '暂无正文'));
          const openSource = element('button', 'review-memory-source-link', '查看原文 →');
          openSource.type = 'button'; openSource.onclick = () => sourceButton.click(); source.appendChild(openSource);
        }
        body.appendChild(source);
      }
    };
    toggle.onclick = () => panel.isOpen ? panel.close({ focus: true }) : panel.open();
    close.onclick = () => panel.close({ focus: true });
    panels.set(host, panel);
    return panel;
  }
  return { renderAnswer, renderContent, contentParts, imageNode, enlarge, summary, mount };
})();
