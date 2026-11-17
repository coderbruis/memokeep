// Editable geometry is saved as a Mermaid comment. Other Mermaid readers can
// still render the graph, while MemoKeep restores the user's exact placement.
const MERMAID_CANVAS_SHAPES = [
  ['rectangle', '矩形'], ['rounded', '圆角矩形'], ['diamond', '判断'],
  ['stadium', '开始 / 结束'], ['circle', '圆形'], ['subroutine', '子流程'],
  ['database', '数据库'], ['hexagon', '六边形'], ['parallelogram', '输入 / 输出']
];
const MERMAID_CANVAS_LIBRARIES = {
  general: { label: '通用图形', items: MERMAID_CANVAS_SHAPES.map(([shape, label]) => ({ shape, label })) },
  architecture: { label: '架构组件', items: [
    ['rounded', '客户端', '#eff6ff'], ['hexagon', 'API 网关', '#eff6ff'], ['rectangle', '业务服务', '#eff6ff'],
    ['database', '数据库', '#edf9f1'], ['database', '缓存', '#edf9f1'], ['subroutine', '消息队列', '#fff8e5'],
    ['parallelogram', '对象存储', '#edf9f1'], ['subroutine', '服务集群', '#eff6ff'], ['circle', '外部系统', '#fff8e5']
  ].map(([shape, label, fill]) => ({ shape, label, fill })) },
  topology: { label: '网络设备', items: [
    ['circle', '互联网', '#eff6ff'], ['hexagon', '路由器', '#eff6ff'], ['subroutine', '交换机', '#eff6ff'],
    ['hexagon', '防火墙', '#fff0ef'], ['rectangle', '服务器', '#edf9f1'], ['rounded', '工作站', '#ffffff'],
    ['stadium', '无线接入点', '#eff6ff'], ['hexagon', '负载均衡', '#fff8e5'], ['database', '数据库', '#edf9f1']
  ].map(([shape, label, fill]) => ({ shape, label, fill })) }
};
const MERMAID_CANVAS_EDGE_STYLES = [['-->', '单向箭头'], ['<-->', '双向箭头'], ['---', '普通连线'], ['-.->', '虚线箭头'], ['-.-', '虚线'], ['==>', '粗箭头'], ['<-.->', '双向虚线'], ['<==>', '双向粗线']];
// Matches the note preview palette (design/prototype/diagram-viewer-20261109.md).
const MERMAID_CANVAS_DEFAULT_COLORS = { fill: '#ffffff', stroke: '#b9c2d0', text: '#20232b', line: '#8c95a5', group: '#f5f7fb', groupHeader: '#ecf0f7', groupStroke: '#d3dbe8', groupText: '#4d5a70', edgeText: '#5b6474' };
function mermaidCanvasTheme(model) {
  return noteMermaidTheme(model.comments.join('\n')) || MERMAID_CANVAS_DEFAULT_COLORS;
}
function applyMermaidCanvasTheme(model, id) {
  if (!Object.hasOwn(MERMAID_DIAGRAM_THEMES, id)) return;
  model.comments = setNoteMermaidTheme(model.comments.join('\n'), id).trimEnd().split('\n');
  // A theme recolors the whole diagram; geometry and connections stay untouched.
  Object.values(model.layout.nodes).forEach(box => { delete box.fill; });
}
const mermaidCanvasEscape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
function mermaidCanvasLabel(value) {
  return String(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/#(quot|amp|lt|gt|\d+);/g, (all, name) => {
    if (/^\d+$/.test(name)) { const code = Number(name); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all; }
    return { quot: '"', amp: '&', lt: '<', gt: '>' }[name];
  }).replace(/&(quot|amp|lt|gt);/g, (_, name) => ({ quot: '"', amp: '&', lt: '<', gt: '>' }[name]));
}
function mermaidCanvasTextLines(label, width) {
  const lines = [], limit = Math.max(4, (width - 24) / 13);
  for (const paragraph of mermaidCanvasLabel(label).split('\n')) {
    let line = '', length = 0;
    for (const char of paragraph) {
      const size = /[\u0000-\u00ff]/.test(char) ? .55 : 1;
      if (line && length + size > limit && !/[，。！？、,.!?;:；：）]/.test(char)) { lines.push(line); line = ''; length = 0; }
      line += char; length += size;
    }
    lines.push(line);
  }
  return lines;
}
function mermaidCanvasDefaultBox(node, x = 0, y = 0) {
  const width = node.shape === 'diamond' ? 184 : node.shape === 'circle' ? 124 : 168;
  const lines = mermaidCanvasTextLines(node.label, node.shape === 'diamond' ? width * .65 : width);
  let height = Math.max(node.shape === 'diamond' ? 104 : 56, lines.length * 18 + (node.shape === 'diamond' ? 48 : 24));
  return { x, y, width: node.shape === 'circle' ? Math.max(width, height) : width, height: node.shape === 'circle' ? Math.max(width, height) : height };
}
function mermaidCanvasHasLayout(model) {
  return !!model?.layout && model.nodes.every(node => Object.hasOwn(model.layout.nodes, node.id));
}
function seedMermaidCanvasLayout(model, root) {
  if (!model.layout) model.layout = { version: 1, nodes: {} };
  model.layout.edges ||= model.edges.map(() => null);
  // Mermaid uses paths for cylinders and other shapes. Measure their real SVG
  // bounds, otherwise a wider fallback box can overlap its neighboring nodes.
  let measurement;
  if (root?.localName === 'svg' && typeof document !== 'undefined') {
    measurement = document.createElement('div'); measurement.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    root = document.importNode(root, true); measurement.append(root); document.body.append(measurement);
  }
  try {
    const rendered = root ? [...root.querySelectorAll('g.node')] : [];
    model.nodes.forEach((node, index) => {
      if (Object.hasOwn(model.layout.nodes, node.id)) return;
      const group = rendered.find(group => {
        if (group.getAttribute('data-id') === node.id) return true;
        const id = group.getAttribute('id') || '', prefix = `flowchart-${node.id}-`, at = id.lastIndexOf(prefix);
        return at >= 0 && (at === 0 || id[at - 1] === '-') && /^\d+$/.test(id.slice(at + prefix.length));
      });
      const box = mermaidCanvasDefaultBox(node, (index % 4) * 240, Math.floor(index / 4) * 160);
      if (group) {
        let x = 0, y = 0;
        for (let el = group; el && el !== root; el = el.parentElement) {
          const translate = /translate\(\s*([\d.e+-]+)[,\s]+([\d.e+-]+)\s*\)/i.exec(el.getAttribute('transform') || '');
          if (translate) { x += Number(translate[1]); y += Number(translate[2]); }
        }
        if (Number.isFinite(x) && Number.isFinite(y)) { box.x = x; box.y = y; }
        const shape = [...group.children].find(el => ['rect', 'polygon', 'circle', 'ellipse'].includes(el.tagName));
        if (shape?.tagName === 'rect') {
          box.width = Math.max(64, Number(shape.getAttribute('width')) || box.width);
          box.height = Math.max(40, Number(shape.getAttribute('height')) || box.height);
        } else if (shape?.tagName === 'polygon') {
          const numbers = (shape.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
          const xs = numbers.filter((_v, i) => i % 2 === 0), ys = numbers.filter((_v, i) => i % 2 === 1);
          if (xs.length && numbers.every(Number.isFinite)) { box.width = Math.max(64, Math.max(...xs) - Math.min(...xs)); box.height = Math.max(40, Math.max(...ys) - Math.min(...ys)); }
        } else if (shape?.tagName === 'circle') box.width = box.height = Math.max(64, Number(shape.getAttribute('r')) * 2 || box.width);
        const bounds = group.getBBox?.();
        if (bounds?.width > 0 && bounds?.height > 0) {
          box.x += bounds.x + bounds.width / 2; box.y += bounds.y + bounds.height / 2;
          box.width = Math.max(64, bounds.width); box.height = Math.max(40, bounds.height);
        }
      }
      Object.defineProperty(model.layout.nodes, node.id, { value: box, enumerable: true, configurable: true, writable: true });
    });
    if (model.groups?.length) {
      model.layout.groups ||= {};
      model.groups.forEach((group, index) => {
        if (!Object.hasOwn(model.layout.groups, group.id)) Object.defineProperty(model.layout.groups, group.id, { value: { x: index * 320, y: 0, width: 280, height: 180 }, enumerable: true, configurable: true, writable: true });
      });
    }
    return model;
  } finally { measurement?.remove(); }
}
function mermaidCanvasGroupBox(model, id) {
  const boxes = model.nodes.filter(node => node.group === id).map(node => model.layout.nodes[node.id]);
  boxes.push(...(model.groups || []).filter(group => group.parent === id).map(group => mermaidCanvasGroupBox(model, group.id)));
  if (!boxes.length) return (model.layout.groups && Object.hasOwn(model.layout.groups, id) && model.layout.groups[id]) || { x: (model.groups || []).findIndex(group => group.id === id) * 320, y: 0, width: 280, height: 180 };
  const left = Math.min(...boxes.map(box => box.x - box.width / 2)) - 24, right = Math.max(...boxes.map(box => box.x + box.width / 2)) + 24;
  const top = Math.min(...boxes.map(box => box.y - box.height / 2)) - 46, bottom = Math.max(...boxes.map(box => box.y + box.height / 2)) + 24;
  return { x: (left + right) / 2, y: (top + bottom) / 2, width: Math.max(180, right - left), height: bottom - top };
}
function mermaidCanvasGroupIds(model, id) {
  const ids = new Set([id]);
  for (let size = 0; size !== ids.size;) { size = ids.size; for (const group of model.groups || []) if (group.parent && ids.has(group.parent)) ids.add(group.id); }
  return ids;
}
function moveMermaidCanvasGroup(model, id, dx, dy) {
  const ids = mermaidCanvasGroupIds(model, id);
  const moved = new Set(model.nodes.filter(node => ids.has(node.group)).map(node => node.id));
  model.edges.forEach((edge, index) => {
    if (moved.has(edge.from) && moved.has(edge.to)) model.layout.edges?.[index]?.bends?.forEach(point => { point.x += dx; point.y += dy; });
  });
  model.nodes.filter(node => ids.has(node.group)).forEach(node => { const box = model.layout.nodes[node.id]; box.x += dx; box.y += dy; });
  ids.forEach(groupId => { const box = model.layout.groups && Object.hasOwn(model.layout.groups, groupId) && model.layout.groups[groupId]; if (box) { box.x += dx; box.y += dy; } });
}
function mermaidCanvasBounds(model) {
  const boxes = model.nodes.map(node => model.layout.nodes[node.id]);
  boxes.push(...(model.groups || []).map(group => mermaidCanvasGroupBox(model, group.id)));
  model.edges.forEach((edge, index) => mermaidCanvasRoute(model, edge, index)?.points.forEach(point => boxes.push({ ...point, width: 24, height: 24 })));
  if (!boxes.length) return { x: -200, y: -150, width: 400, height: 300 };
  const left = Math.min(...boxes.map(box => box.x - box.width / 2)) - 64;
  const top = Math.min(...boxes.map(box => box.y - box.height / 2)) - 64;
  return { x: left, y: top, width: Math.max(...boxes.map(box => box.x + box.width / 2)) - left + 64, height: Math.max(...boxes.map(box => box.y + box.height / 2)) - top + 64 };
}
function mermaidCanvasShape(shape, width, height, attributes = '') {
  const w = width / 2, h = height / 2;
  if (shape === 'diamond') return `<polygon points="0,${-h} ${w},0 0,${h} ${-w},0" ${attributes}/>`;
  if (shape === 'circle') return `<ellipse rx="${w}" ry="${h}" ${attributes}/>`;
  if (shape === 'hexagon') return `<polygon points="${-w + 16},${-h} ${w - 16},${-h} ${w},0 ${w - 16},${h} ${-w + 16},${h} ${-w},0" ${attributes}/>`;
  if (shape === 'parallelogram') return `<polygon points="${-w + 18},${-h} ${w},${-h} ${w - 18},${h} ${-w},${h}" ${attributes}/>`;
  if (shape === 'database') return `<path d="M${-w},${-h + 10} a${w},10 0 0 1 ${width},0 v${height - 20} a${w},10 0 0 1 ${-width},0 Z M${-w},${-h + 10} a${w},10 0 0 0 ${width},0" ${attributes}/>`;
  const radius = shape === 'stadium' ? h : shape === 'rounded' ? 10 : 2;
  const rect = `<rect x="${-w}" y="${-h}" width="${width}" height="${height}" rx="${radius}" ${attributes}/>`;
  return shape === 'subroutine' ? `${rect}<path d="M${-w + 9},${-h}v${height}M${w - 9},${-h}v${height}" fill="none" stroke="currentColor" stroke-width="1.2"/>` : rect;
}
function mermaidCanvasPort(box, port) {
  return { x: box.x + (port === 'right' ? box.width / 2 : port === 'left' ? -box.width / 2 : 0),
    y: box.y + (port === 'bottom' ? box.height / 2 : port === 'top' ? -box.height / 2 : 0) };
}
function mermaidCanvasEdgeAppearance(model, index) {
  const style = model.edges[index].style, custom = model.layout.edges?.[index] || {};
  const shape = custom.arrowShape || 'triangle', startArrow = custom.startArrow ?? (style.startsWith('<') ? shape : 'none'), endArrow = custom.endArrow ?? (style.endsWith('>') ? shape : 'none');
  return { lineType: custom.lineType || 'orthogonal', linePattern: custom.linePattern || (style.includes('.') ? 'dashed' : 'solid'),
    lineWidth: custom.lineWidth ?? (style.includes('=') ? 2.6 : 1.4), arrowShape: shape, arrowSize: custom.arrowSize ?? 10,
    startArrow, endArrow, lineJump: custom.lineJump === true,
    arrowDirection: startArrow !== 'none' ? endArrow !== 'none' ? 'both' : 'reverse' : endArrow !== 'none' ? 'forward' : 'none' };
}
function updateMermaidCanvasEdge(model, index, key, value) {
  const edge = model.edges[index]; if (!edge) return false;
  model.layout.edges ||= model.edges.map(() => null);
  const custom = { ...model.layout.edges[index] }, appearance = mermaidCanvasEdgeAppearance(model, index);
  if (key === 'reverse') {
    const route = mermaidCanvasRoute(model, edge, index);
    [edge.from, edge.to] = [edge.to, edge.from];
    custom.fromPort = route.toPort; custom.toPort = route.fromPort;
    if (custom.bends) custom.bends = [...custom.bends].reverse();
  } else if (key === 'resetRoute') {
    delete custom.bends; delete custom.fromPort; delete custom.toPort;
  } else if (key === 'edgeStyle' && MERMAID_CANVAS_EDGE_STYLES.some(([style]) => style === value)) {
    edge.style = value; delete custom.linePattern; delete custom.lineWidth; delete custom.startArrow; delete custom.endArrow;
  } else if (key === 'arrowDirection' && ['forward', 'both', 'none'].includes(value)) {
    custom.startArrow = appearance.startArrow = value === 'both' ? appearance.arrowShape : 'none';
    custom.endArrow = appearance.endArrow = value !== 'none' ? appearance.arrowShape : 'none';
  } else {
    const allowed = sanitizeMermaidEdgeLayout({ [key]: value });
    if (!allowed || !Object.hasOwn(appearance, key)) return false;
    Object.assign(custom, allowed); Object.assign(appearance, allowed);
    if (key === 'lineType' && ![appearance.lineType, model.layout.edges[index]?.lineType || 'orthogonal'].every(type => ['orthogonal', 'rounded'].includes(type))) delete custom.bends;
    if (key === 'arrowShape') {
      if (appearance.startArrow !== 'none') custom.startArrow = appearance.startArrow = value;
      if (appearance.endArrow !== 'none') custom.endArrow = appearance.endArrow = value;
    }
  }
  if (['linePattern', 'arrowDirection', 'startArrow', 'endArrow'].includes(key)) {
    const dashed = !['solid', 'sketch'].includes(appearance.linePattern), start = appearance.startArrow !== 'none', end = appearance.endArrow !== 'none';
    edge.style = start ? end ? (dashed ? '<-.->' : '<-->') : (dashed ? '<-.-' : '<---') : end ? (dashed ? '-.->' : '-->') : (dashed ? '-.-' : '---');
    // Preserve a legacy thick line when only its arrow direction changes.
    custom.lineWidth ??= appearance.lineWidth;
  }
  model.layout.edges[index] = Object.keys(custom).length ? custom : null;
  return true;
}
function mermaidCanvasCleanPoints(points) {
  return points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
    .reduce((result, point) => {
      while (result.length > 1) {
        const a = result.at(-2), b = result.at(-1);
        if ((a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0) || (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)) result.pop(); else break;
      }
      result.push({ ...point }); return result;
    }, []);
}
function mermaidCanvasArrowMarkup(shape) {
  const paths = {
    triangle: '<path d="M1 1 L9 5 L1 9 Z" fill="currentColor" stroke="none"/>',
    'triangle-outline': '<path d="M1 1 L9 5 L1 9 Z" fill="#fff" stroke="currentColor" stroke-width="1.2"/>',
    open: '<path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    diamond: '<path d="M0 5 L5 1 L10 5 L5 9 Z" fill="currentColor" stroke="none"/>',
    'diamond-outline': '<path d="M0 5 L5 1 L10 5 L5 9 Z" fill="#fff" stroke="currentColor" stroke-width="1.2"/>',
    circle: '<circle cx="5" cy="5" r="4" fill="currentColor" stroke="none"/>',
    'circle-outline': '<circle cx="5" cy="5" r="4" fill="#fff" stroke="currentColor" stroke-width="1.2"/>',
    slash: '<path d="M2 0 L8 10"/>', 'half-top': '<path d="M1 1 L9 5"/>', 'half-bottom': '<path d="M1 9 L9 5"/>',
    bar: '<path d="M8 0 V10"/>', 'double-bar': '<path d="M4 0 V10 M8 0 V10"/>',
    'circle-bar': '<path d="M0 5 H10"/><circle cx="5" cy="5" r="3" fill="#fff"/>'
  };
  return `<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths[shape] || ''}</g>`;
}
function mermaidCanvasDash(pattern, width) {
  return { dashed: '7 5', dotted: `0 ${width * 3 + 2}`, dashdot: `9 4 0 4`, 'sketch-dashed': '7 5' }[pattern] || '';
}
function mermaidCanvasStrokeBounds(route) {
  const padding = route.appearance.arrowSize + 8, points = route.points;
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 };
}
function mermaidCanvasPathParts(route) {
  if (route.lineType === 'curve') return [{ type: 'C', start: route.start, c1: route.points[1], c2: route.points[2], end: route.end }];
  const parts = [], points = route.points;
  let start = points[0];
  for (let i = 1; i < points.length; i++) {
    const end = points[i], next = points[i + 1], previous = points[i - 1];
    if (route.lineType === 'rounded' && next) {
      const incoming = Math.hypot(end.x - previous.x, end.y - previous.y), outgoing = Math.hypot(next.x - end.x, next.y - end.y), radius = Math.min(14, incoming / 2, outgoing / 2);
      if (radius > .01) {
        const before = { x: end.x + (previous.x - end.x) / incoming * radius, y: end.y + (previous.y - end.y) / incoming * radius };
        const after = { x: end.x + (next.x - end.x) / outgoing * radius, y: end.y + (next.y - end.y) / outgoing * radius };
        parts.push({ type: 'L', start, end: before }, { type: 'Q', start: before, c1: end, end: after }); start = after; continue;
      }
    }
    parts.push({ type: 'L', start, end }); start = end;
  }
  return parts;
}
function mermaidCanvasPartsPath(parts) {
  if (!parts.length) return '';
  const xy = p => `${p.x},${p.y}`;
  return `M${xy(parts[0].start)} ` + parts.map(part => `${part.type}${part.c1 ? `${xy(part.c1)} ` : ''}${part.c2 ? `${xy(part.c2)} ` : ''}${xy(part.end)}`).join(' ');
}
function mermaidCanvasSampleParts(parts) {
  if (!parts.length) return [];
  const points = [{ ...parts[0].start, distance: 0 }];
  for (const part of parts) {
    const control = [part.start, part.c1, part.c2, part.end].filter(Boolean);
    const length = control.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - control[i].x, point.y - control[i].y), 0);
    const steps = part.type === 'L' ? 1 : Math.max(8, Math.min(160, Math.ceil(length / 8)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t, p = {};
      for (const axis of ['x', 'y']) p[axis] = part.type === 'L' ? part.end[axis] : part.type === 'Q' ? u * u * part.start[axis] + 2 * u * t * part.c1[axis] + t * t * part.end[axis]
        : u ** 3 * part.start[axis] + 3 * u * u * t * part.c1[axis] + 3 * u * t * t * part.c2[axis] + t ** 3 * part.end[axis];
      const previous = points.at(-1); p.distance = previous.distance + Math.hypot(p.x - previous.x, p.y - previous.y);
      if (p.distance > previous.distance + .001) points.push(p);
    }
  }
  return points;
}
function mermaidCanvasDisplayRoutes(model) {
  const routes = model.edges.map((edge, index) => {
    const route = mermaidCanvasRoute(model, edge, index); if (!route) return null;
    const parts = mermaidCanvasPathParts(route);
    return { ...route, d: mermaidCanvasPartsPath(parts), samples: mermaidCanvasSampleParts(parts), appearance: mermaidCanvasEdgeAppearance(model, index), bridgeD: '' };
  });
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  routes.forEach((route, index) => {
    if (!route?.appearance.lineJump || route.samples.length < 2) return;
    const radius = 7 + route.appearance.lineWidth / 2, crossings = [], points = route.samples, total = points.at(-1).distance;
    routes.forEach((other, otherIndex) => {
      if (!other || otherIndex === index || (other.appearance.lineJump && otherIndex > index)) return;
      for (let i = 1; i < points.length; i++) for (let j = 1; j < other.samples.length; j++) {
        const a = points[i - 1], b = points[i], c = other.samples[j - 1], d = other.samples[j];
        if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.min(a.x, b.x) > Math.max(c.x, d.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.min(a.y, b.y) > Math.max(c.y, d.y)) continue;
        const ab = { x: b.x - a.x, y: b.y - a.y }, cd = { x: d.x - c.x, y: d.y - c.y }, ac = { x: c.x - a.x, y: c.y - a.y }, determinant = cross(ab, cd);
        if (Math.abs(determinant) < .001) continue;
        const t = cross(ac, cd) / determinant, u = cross(ac, ab) / determinant;
        if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) continue;
        const distance = a.distance + (b.distance - a.distance) * t, otherDistance = c.distance + (d.distance - c.distance) * u;
        if (distance > radius + 4 && distance < total - radius - 4 && otherDistance > 4 && otherDistance < other.samples.at(-1).distance - 4) crossings.push(distance);
      }
    });
    const stops = crossings.sort((a, b) => a - b).filter((distance, i, list) => !i || distance - list[i - 1] > radius * 2 + 4);
    if (!stops.length) return;
    const at = distance => {
      const i = points.findIndex(p => p.distance >= distance), b = points[Math.max(1, i)], a = points[Math.max(1, i) - 1], t = (distance - a.distance) / (b.distance - a.distance);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    const xy = p => `${p.x},${p.y}`;
    let d = `M${xy(points[0])}`, cursor = 1, halos = [];
    for (const distance of stops) {
      const before = at(distance - radius), after = at(distance + radius), length = Math.hypot(after.x - before.x, after.y - before.y);
      if (length < radius * 1.8) continue; // Keep sharp bends intact.
      const dx = (after.x - before.x) / length, dy = (after.y - before.y) / length, sign = dx < 0 || (Math.abs(dx) < .001 && dy < 0) ? -1 : 1;
      const control = { x: (before.x + after.x) / 2 + dy * radius * 2 * sign, y: (before.y + after.y) / 2 - dx * radius * 2 * sign };
      while (cursor < points.length && points[cursor].distance < distance - radius) d += ` L${xy(points[cursor++])}`;
      const arc = `Q${xy(control)} ${xy(after)}`; d += ` L${xy(before)} ${arc}`; halos.push(`M${xy(before)} ${arc}`);
      while (cursor < points.length && points[cursor].distance <= distance + radius) cursor++;
    }
    while (cursor < points.length) d += ` L${xy(points[cursor++])}`;
    route.d = d; route.bridgeD = halos.join(' ');
  });
  return routes;
}
function mermaidCanvasMoveSegment(route, segment, dx, dy) {
  const points = route.points.map(point => ({ ...point })), a = points[segment], b = points[segment + 1];
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y), axis = horizontal ? 'y' : 'x', offset = horizontal ? dy : dx;
  const movedA = { ...a, [axis]: a[axis] + offset }, movedB = { ...b, [axis]: b[axis] + offset };
  // Fixed endpoints retain a short departure/arrival segment at the node boundary.
  const before = points.slice(0, segment), after = points.slice(segment + 2);
  if (!segment) {
    const stub = horizontal ? { x: a.x + Math.sign(b.x - a.x) * Math.min(20, Math.abs(b.x - a.x) / 3), y: a.y } : { x: a.x, y: a.y + Math.sign(b.y - a.y) * Math.min(20, Math.abs(b.y - a.y) / 3) };
    before.push(a, stub); Object.assign(movedA, { ...stub, [axis]: stub[axis] + offset });
  }
  if (segment === points.length - 2) {
    const stub = horizontal ? { x: b.x - Math.sign(b.x - a.x) * Math.min(20, Math.abs(b.x - a.x) / 3), y: b.y } : { x: b.x, y: b.y - Math.sign(b.y - a.y) * Math.min(20, Math.abs(b.y - a.y) / 3) };
    after.unshift(stub, b); Object.assign(movedB, { ...stub, [axis]: stub[axis] + offset });
  }
  return mermaidCanvasCleanPoints([...before, movedA, movedB, ...after]).slice(1, -1);
}
function mermaidCanvasRoute(model, edge, index) {
  const a = model.layout.nodes[edge.from], b = model.layout.nodes[edge.to];
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y, horizontal = Math.abs(dx) > Math.abs(dy);
  const custom = model.layout.edges?.[index];
  const hasPorts = custom?.fromPort || custom?.toPort;
  const backwards = !hasPorts && (model.direction === 'LR' ? dx < 0 : model.direction === 'RL' ? dx > 0 : model.direction === 'BT' ? dy > 0 : dy < 0);
  const gapX = Math.abs(dx) - (a.width + b.width) / 2, gapY = Math.abs(dy) - (a.height + b.height) / 2;
  const alongX = gapX >= 0 && (gapY < 0 || horizontal);
  let fromPort = custom?.fromPort || (alongX ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top');
  let toPort = custom?.toPort || (alongX ? dx >= 0 ? 'left' : 'right' : dy >= 0 ? 'top' : 'bottom');
  if (backwards) fromPort = toPort = ['LR', 'RL'].includes(model.direction) ? 'bottom' : 'right';
  else if (!hasPorts && gapX < 0 && gapY < 0) fromPort = toPort = ['LR', 'RL'].includes(model.direction) ? 'top' : 'left';
  if (edge.from === edge.to && !hasPorts) { fromPort = 'right'; toPort = 'top'; }
  const start = custom?.previewFrom || mermaidCanvasPort(a, fromPort), end = custom?.previewTo || mermaidCanvasPort(b, toPort);
  const outward = (point, port, distance) => ({ x: point.x + (port === 'right' ? distance : port === 'left' ? -distance : 0), y: point.y + (port === 'bottom' ? distance : port === 'top' ? -distance : 0) });
  const offset = Math.max(28, Math.min(64, Math.hypot(dx, dy) * .2));
  const first = outward(start, fromPort, offset), last = outward(end, toPort, offset);
  let points;
  const { lineType } = mermaidCanvasEdgeAppearance(model, index);
  if (lineType === 'curve') {
    let defaults = [first, last];
    if (edge.from === edge.to) {
      const distance = Math.max(a.width, a.height) * 1.6;
      defaults = [outward(start, fromPort, distance), outward(end, toPort, distance)];
      if (fromPort === toPort) {
        const axis = ['left', 'right'].includes(fromPort) ? 'y' : 'x';
        defaults[0][axis] -= distance / 2; defaults[1][axis] += distance / 2;
      }
    }
    const controls = custom?.bends?.length === 2 ? custom.bends : defaults;
    const [c1, c2] = controls;
    return { start, end, fromPort, toPort, lineType, points: [start, c1, c2, end],
      d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
      label: { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 } };
  }
  if (lineType === 'straight' && edge.from !== edge.to) points = [start, end];
  else if (custom?.bends?.length) {
    const bends = custom.bends, head = bends[0], tail = bends.at(-1);
    const joinStart = ['left', 'right'].includes(fromPort) ? { x: head.x, y: start.y } : { x: start.x, y: head.y };
    const joinEnd = ['left', 'right'].includes(toPort) ? { x: tail.x, y: end.y } : { x: end.x, y: tail.y };
    points = [start, joinStart, ...bends, joinEnd, end];
  } else if (edge.from === edge.to && fromPort === toPort) {
    const horizontalPort = ['left', 'right'].includes(fromPort), axis = horizontalPort ? 'y' : 'x';
    const near = outward(start, fromPort, 24), far = outward(start, fromPort, 64);
    points = [start, far, { ...far, [axis]: far[axis] - 56 }, { ...near, [axis]: near[axis] - 56 }, near, end];
  } else if (fromPort === toPort) {
    const boxes = Object.values(model.layout.nodes), horizontalPort = ['left', 'right'].includes(fromPort);
    const positive = fromPort === 'right' || fromPort === 'bottom';
    const values = boxes.map(box => horizontalPort ? box.x + (positive ? 1 : -1) * box.width / 2 : box.y + (positive ? 1 : -1) * box.height / 2);
    const lane = (positive ? Math.max(...values) + 36 : Math.min(...values) - 36);
    points = horizontalPort ? [start, { x: lane, y: start.y }, { x: lane, y: end.y }, end] : [start, { x: start.x, y: lane }, { x: end.x, y: lane }, end];
  } else if (['left', 'right'].includes(fromPort) && ['left', 'right'].includes(toPort)
    && (fromPort === 'right' ? end.x >= start.x : end.x <= start.x)) {
    const mid = (start.x + end.x) / 2; points = [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  } else if (['top', 'bottom'].includes(fromPort) && ['top', 'bottom'].includes(toPort)
    && (fromPort === 'bottom' ? end.y >= start.y : end.y <= start.y)) {
    const mid = (start.y + end.y) / 2; points = [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  } else points = [start, first, ['left', 'right'].includes(fromPort) ? { x: first.x, y: last.y } : { x: last.x, y: first.y }, last, end];
  points = mermaidCanvasCleanPoints(points);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let remaining = lengths.reduce((sum, n) => sum + n, 0) / 2, label = start;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i]) { const ratio = remaining / lengths[i]; label = { x: points[i].x + (points[i + 1].x - points[i].x) * ratio, y: points[i].y + (points[i + 1].y - points[i].y) * ratio }; break; }
    remaining -= lengths[i];
  }
  return { d, label, start, end, points, fromPort, toPort, lineType };
}
function mermaidCanvasMarkup(model, { marker = 'canvas-arrow' } = {}) {
  const escape = mermaidCanvasEscape, theme = mermaidCanvasTheme(model);
  const groups = (model.groups || []).map(group => {
    const box = mermaidCanvasGroupBox(model, group.id);
    return `<g class="mermaid-canvas-group" data-group-id="${escape(group.id)}" transform="translate(${box.x - box.width / 2},${box.y - box.height / 2})" aria-label="分组 ${escape(mermaidCanvasLabel(group.label))}"><rect class="mermaid-group-frame" width="${box.width}" height="${box.height}" rx="8" fill="${theme.group}" stroke="${theme.groupStroke}" stroke-dasharray="6 4" pointer-events="none"/><rect class="mermaid-group-header" width="${box.width}" height="32" rx="8" fill="${theme.groupHeader}"/><text x="14" y="21" fill="${theme.groupText || theme.text}" font-size="12" font-weight="600" pointer-events="none">${escape(mermaidCanvasLabel(group.label).replace(/\n/g, ' '))}</text></g>`;
  }).join('');
  const markers = [], routes = mermaidCanvasDisplayRoutes(model);
  const edges = model.edges.map((edge, index) => ({ edge, index })).sort((a, b) => Number(routes[a.index]?.appearance.lineJump) - Number(routes[b.index]?.appearance.lineJump)).map(({ edge, index }) => {
    const route = routes[index]; if (!route) return '';
    const color = theme.line;
    const appearance = route.appearance, arrowId = `${marker}-${index}`, dash = mermaidCanvasDash(appearance.linePattern, appearance.lineWidth), sketch = appearance.linePattern.startsWith('sketch');
    for (const side of ['start', 'end']) {
      const shape = appearance[`${side}Arrow`]; if (shape === 'none') continue;
      markers.push(`<marker id="${arrowId}-${side}" data-marker-edge="${index}" viewBox="0 0 10 10" overflow="visible" refX="${shape.startsWith('diamond') ? 10 : 9}" refY="5" markerUnits="userSpaceOnUse" markerWidth="${appearance.arrowSize}" markerHeight="${appearance.arrowSize}" orient="auto-start-reverse" color="${color}">${mermaidCanvasArrowMarkup(shape)}</marker>`);
    }
    if (sketch) markers.push(`<filter id="${arrowId}-sketch" data-sketch-edge="${index}" filterUnits="userSpaceOnUse" ${Object.entries(mermaidCanvasStrokeBounds(route)).map(([key, value]) => `${key}="${value}"`).join(' ')} color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="2" seed="${index + 1}" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.2" xChannelSelector="R" yChannelSelector="G"/></filter>`);
    const label = mermaidCanvasLabel(edge.label), width = [...label].reduce((n, c) => n + (/[\u0000-\u00ff]/.test(c) ? 6.5 : 12), 0) + 12;
    return `<g class="mermaid-canvas-edge" data-edge-index="${index}" aria-label="${escape(`连线 ${edge.from} 到 ${edge.to}${label ? `：${label}` : ''}`)}">
      <path class="mermaid-edge-bridge-halo" d="${route.bridgeD}" fill="none" stroke="#fff" stroke-width="${appearance.lineWidth + 5}" pointer-events="none"/>
      <path class="mermaid-edge-line" d="${route.d}" fill="none" stroke="${color}" stroke-width="${appearance.lineWidth}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}${sketch ? ` filter="url(#${arrowId}-sketch)"` : ''}${appearance.endArrow !== 'none' ? ` marker-end="url(#${arrowId}-end)"` : ''}${appearance.startArrow !== 'none' ? ` marker-start="url(#${arrowId}-start)"` : ''}/>
      ${label ? `<g class="mermaid-edge-label" transform="translate(${route.label.x},${route.label.y})"><rect x="${-width / 2}" y="-12" width="${width}" height="23" rx="3" fill="#fff"/><text text-anchor="middle" dominant-baseline="central" fill="${theme.edgeText || theme.text}" font-size="12">${escape(label)}</text></g>` : ''}
    </g>`;
  }).join('');
  const nodes = model.nodes.map(node => {
    const box = model.layout.nodes[node.id]; if (!box) return '';
    const fill = /^#[a-f\d]{3,8}$/i.test(box.fill || '') ? box.fill : theme.fill;
    const stroke = theme.stroke;
    const lines = mermaidCanvasTextLines(node.label, node.shape === 'diamond' ? box.width * .65 : box.width);
    const height = lines.length * 18;
    return `<g class="mermaid-canvas-node" data-node-id="${escape(node.id)}" transform="translate(${box.x},${box.y})" color="${stroke}" aria-label="${escape(`节点 ${node.id}：${mermaidCanvasLabel(node.label)}`)}">
      ${mermaidCanvasShape(node.shape, box.width, box.height, `fill="${fill}" stroke="${stroke}" stroke-width="1.3"`)}
      <text class="mermaid-node-label" text-anchor="middle" fill="${theme.text}" font-size="13" style="pointer-events:none">${lines.map((line, i) => `<tspan x="0" y="${-height / 2 + 14 + i * 18}">${escape(line)}</tspan>`).join('')}</text>
    </g>`;
  }).join('');
  return `<defs>${markers.join('')}</defs><g class="mermaid-canvas-groups">${groups}</g><g class="mermaid-canvas-edges">${edges}</g><g class="mermaid-canvas-nodes">${nodes}</g>`;
}
function renderSavedMermaidCanvas(source) {
  const model = parseEditableMermaidFlow(source);
  if (!mermaidCanvasHasLayout(model)) return null;
  const b = mermaidCanvasBounds(model);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" style="font-family:system-ui, sans-serif">${mermaidCanvasMarkup(model)}</svg>`;
}
