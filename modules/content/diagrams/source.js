const NOTE_MERMAID_TEMPLATES = {
  blank: { label: '空白画布', source: 'flowchart LR' },
  flowchart: { label: '流程图', source: 'flowchart LR\n  A["开始"] --> B["处理任务"]\n  B --> C{"是否完成？"}\n  C -->|是| D["完成"]\n  C -->|否| B' },
  architecture: { label: '系统架构图', source: '%% memokeep-diagram: architecture\nflowchart TB\n  subgraph Clients["接入层"]\n    Web["Web 客户端"]\n    App["移动应用"]\n  end\n  subgraph Services["服务层"]\n    Gateway["API 网关"]\n    Auth["认证服务"]\n    Business["业务服务"]\n  end\n  subgraph Data["数据层"]\n    DB[("业务数据库")]\n    Cache[("缓存")]\n    Queue[["消息队列"]]\n  end\n  Web --> Gateway\n  App --> Gateway\n  Gateway --> Auth\n  Gateway --> Business\n  Business --> DB\n  Business --> Cache\n  Business -.-> Queue' },
  topology: { label: '网络拓扑图', source: '%% memokeep-diagram: topology\nflowchart TB\n  Internet(("互联网"))\n  Firewall{{"防火墙"}}\n  Core[["核心交换机"]]\n  subgraph Office["办公网络"]\n    Access[["接入交换机"]]\n    PC["工作站"]\n    AP(["无线接入点"])\n  end\n  subgraph Servers["服务器网络"]\n    LB{{"负载均衡"}}\n    Server["应用服务器"]\n    DB[("数据库服务器")]\n  end\n  Internet <--> Firewall\n  Firewall <--> Core\n  Core --- Access\n  Access --- PC\n  Access --- AP\n  Core --- LB\n  LB --> Server\n  Server --> DB' },
  sequence: { label: '时序图', source: 'sequenceDiagram\n  participant U as 用户\n  participant S as 服务\n  U->>S: 发起请求\n  S-->>U: 返回结果' },
  mindmap: { label: '思维导图', source: 'mindmap\n  root((主题))\n    想法一\n      具体行动\n    想法二' },
  state: { label: '状态图', source: 'stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 处理中: 接收任务\n  处理中 --> 已完成: 执行成功\n  处理中 --> 待处理: 重试\n  已完成 --> [*]' },
  class: { label: '类图', source: 'classDiagram\n  class User {\n    +String name\n    +login()\n  }\n  class Order {\n    +String id\n    +submit()\n  }\n  User "1" --> "many" Order : creates' },
  er: { label: 'ER 关系图', source: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ ORDER_ITEM : contains\n  CUSTOMER {\n    string id PK\n    string name\n  }\n  ORDER {\n    string id PK\n    string customer_id FK\n  }\n  ORDER_ITEM {\n    string id PK\n    int quantity\n  }' },
  gantt: { label: '甘特图', source: 'gantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  section 设计\n  需求分析 :a, 2026-09-01, 3d\n  方案设计 :b, after a, 4d\n  section 交付\n  开发实现 :c, after b, 7d\n  测试验收 :after c, 3d' },
  mermaidArchitecture: { label: 'Mermaid 原生架构图', source: 'architecture-beta\n  group api(cloud)[Cloud]\n  service gateway(internet)[Gateway] in api\n  service server(server)[Service] in api\n  service db(database)[Database] in api\n  gateway:R --> L:server\n  server:R --> L:db' }
};

const MERMAID_EDGE_LINE_TYPES = [['orthogonal', '连接线直角'], ['rounded', '连接线圆角'], ['straight', '直线连接'], ['curve', '自由曲线']];
const MERMAID_EDGE_LINE_PATTERNS = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线'], ['dashdot', '点划线'], ['sketch', '实线手绘'], ['sketch-dashed', '虚线手绘']];
const MERMAID_EDGE_ARROW_TYPES = [['none', '无箭头'], ['triangle', '实心箭头'], ['triangle-outline', '空心箭头'], ['open', '开放箭头'], ['diamond', '实心菱形'], ['diamond-outline', '空心菱形'], ['circle', '实心圆点'], ['circle-outline', '空心圆点'], ['slash', '斜线'], ['half-top', '上半箭头'], ['half-bottom', '下半箭头'], ['circle-bar', '圆点横线'], ['bar', '垂直线'], ['double-bar', '双垂直线']];

const MERMAID_DIAGRAM_THEMES = {
  blue: { id: 'blue', label: '清透蓝', description: '清晰轻盈，适合流程梳理', fill: '#eef5ff', stroke: '#719ac6', text: '#254766', line: '#7190b2', group: '#f7faff', groupHeader: '#e8f0fa', groupStroke: '#c1d3e7', secondary: '#dceafd', accent: '#327ab9' },
  forest: { id: 'forest', label: '松林绿', description: '沉静自然，适合系统架构', fill: '#edf7f0', stroke: '#729780', text: '#284d3b', line: '#719481', group: '#f5faf6', groupHeader: '#e4f0e8', groupStroke: '#bfd5c6', secondary: '#daecdf', accent: '#387452' },
  sand: { id: 'sand', label: '暖砂橙', description: '温暖柔和，适合灵感规划', fill: '#fff4e7', stroke: '#bd956c', text: '#65452c', line: '#b08b67', group: '#fdf9f3', groupHeader: '#f5eadc', groupStroke: '#dfcfbb', secondary: '#f5dfc5', accent: '#99602c' }
};
function noteMermaidTheme(source) {
  const id = /^[ \t]*%% memokeep-theme: ([a-z]+)[ \t]*\r?$/m.exec(source)?.[1];
  return Object.hasOwn(MERMAID_DIAGRAM_THEMES, id) ? MERMAID_DIAGRAM_THEMES[id] : null;
}
function setNoteMermaidTheme(source, id) {
  if (!Object.hasOwn(MERMAID_DIAGRAM_THEMES, id)) return source;
  const clean = source.replace(/^[ \t]*%% memokeep-theme:[^\r\n]*(?:\r?\n|$)/gm, '');
  // Leave frontmatter and user directives intact; put our theme after the preamble.
  const preamble = /^(?:\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))?(?:[ \t]*\r?\n|[ \t]*%%\{[\s\S]*?\}%%[ \t]*(?:\r?\n|$)|[ \t]*%%[^\r\n]*(?:\r?\n|$))*/.exec(clean)[0];
  return `${preamble}${preamble && !preamble.endsWith('\n') ? '\n' : ''}%% memokeep-theme: ${id}\n${clean.slice(preamble.length)}`;
}
function themedMermaidSource(source) {
  const theme = noteMermaidTheme(source); if (!theme) return source;
  const themeVariables = {
    primaryColor: theme.fill, primaryBorderColor: theme.stroke, primaryTextColor: theme.text,
    secondaryColor: theme.secondary, secondaryBorderColor: theme.stroke, secondaryTextColor: theme.text,
    tertiaryColor: theme.group, tertiaryBorderColor: theme.groupStroke, tertiaryTextColor: theme.text,
    lineColor: theme.line, textColor: theme.text, mainBkg: theme.fill,
    clusterBkg: theme.group, clusterBorder: theme.groupStroke, edgeLabelBackground: '#ffffff',
    noteBkgColor: theme.secondary, noteBorderColor: theme.stroke, noteTextColor: theme.text
  };
  // Render-time configuration keeps saved source compact and visually editable.
  return source.replace(/^[ \t]*%% memokeep-theme:[^\r\n]*/m, `%%{init: ${JSON.stringify({ theme: 'base', themeVariables })}}%%`);
}

function noteMermaidDiagramType(source) {
  const tagged = /^%% memokeep-diagram: (architecture|topology)\s*$/m.exec(source)?.[1];
  if (tagged && /^(?:flowchart|graph)\s/m.test(source)) return tagged;
  const headers = { flowchart: /^(?:flowchart|graph)\s/im, sequence: /^sequenceDiagram\b/m, mindmap: /^mindmap\b/m, state: /^stateDiagram(?:-v2)?\b/m, class: /^classDiagram(?:-v2)?\b/m, er: /^erDiagram\b/m, gantt: /^gantt\b/m, mermaidArchitecture: /^architecture-beta\b/m };
  return Object.keys(headers).find(key => headers[key].test(source)) || 'mermaid';
}

// Parse only syntax we can round-trip without dropping styles, groups or directives.
// More complex diagrams keep their original source and use the source editor.
function parseEditableMermaidFlow(source) {
  const statements = [];
  let statement = '', quoted = false, comment = false, depth = 0;
  for (const char of source.replace(/\r\n?/g, '\n')) {
    if (comment) {
      if (char === '\n') { statements.push(statement.trim()); statement = ''; comment = false; }
      else statement += char;
      continue;
    }
    if (!quoted && depth === 0 && char === '%' && statement.trim() === '%') {
      comment = true; statement += char; continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && '[({'.includes(char)) depth += 1;
    if (!quoted && '])}'.includes(char)) depth -= 1;
    if (!quoted && depth === 0 && (char === '\n' || char === ';')) {
      statements.push(statement.trim()); statement = '';
    } else statement += char;
  }
  if (quoted || depth !== 0) return null;
  statements.push(statement.trim());
  const comments = [], nodes = new Map(), edges = [], groups = [], groupStack = [];
  let layout = null;
  let direction;
  const shapes = [['([', '])', 'stadium'], ['((', '))', 'circle'], ['[[', ']]', 'subroutine'], ['[(', ')]', 'database'], ['{{', '}}', 'hexagon'], ['[/', '/]', 'parallelogram'], ['[', ']', 'rectangle'], ['(', ')', 'rounded'], ['{', '}', 'diamond']];
  const readNode = input => {
    const id = /^[\p{L}_](?:[\p{L}\p{M}\p{N}_]|-(?=[\p{L}\p{M}\p{N}_]))*/u.exec(input)?.[0];
    if (!id || ['end', 'subgraph', 'style', 'class', 'classDef', 'direction', 'click', 'linkStyle'].includes(id)) return null;
    let rest = input.slice(id.length).trimStart(), label = id, shape = 'rectangle', explicit = false;
    for (const [open, close, type] of shapes) {
      if (!rest.startsWith(open)) continue;
      const quotedLabel = rest[open.length] === '"';
      const end = quotedLabel ? rest.indexOf(`"${close}`, open.length + 1) : rest.indexOf(close, open.length);
      if (end < 0) return null;
      label = rest.slice(open.length + (quotedLabel ? 1 : 0), end);
      if ((!quotedLabel && /[\[\](){}"]/.test(label)) || /\n/.test(label)) return null;
      rest = rest.slice(end + close.length + (quotedLabel ? 1 : 0)).trimStart();
      shape = type; explicit = true;
      break;
    }
    if (explicit || !nodes.has(id)) nodes.set(id, { ...nodes.get(id), id, label, shape });
    if (groupStack.length) {
      const group = groupStack.at(-1).id;
      if (nodes.get(id).group && nodes.get(id).group !== group) return null;
      nodes.get(id).group = group;
    }
    return { id, rest };
  };
  for (const line of statements) {
    if (!line) continue;
    if (line.startsWith('%%')) {
      if (line.startsWith('%% memokeep-layout:')) {
        try { layout = JSON.parse(line.slice('%% memokeep-layout:'.length)); } catch { return null; }
        continue;
      }
      if (line.startsWith('%%{')) return null;
      comments.push(line); continue;
    }
    if (!direction) {
      const header = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)$/i.exec(line);
      if (!header) return null;
      direction = header[1].toUpperCase(); continue;
    }
    if (line === 'end') { if (!groupStack.length) return null; groupStack.pop(); continue; }
    if (line.startsWith('subgraph ')) {
      const match = /^subgraph\s+([\p{L}_][\p{L}\p{M}\p{N}_-]*)(?:\s*\["([^"\n]*)"\]|\s*\[([^\[\]\n]*)\])?$/u.exec(line);
      if (!match || groups.some(group => group.id === match[1]) || nodes.has(match[1])) return null;
      const group = { id: match[1], label: match[2] ?? match[3] ?? match[1] };
      if (groupStack.length) group.parent = groupStack.at(-1).id;
      groups.push(group); groupStack.push(group); continue;
    }
    if (/^direction\s/.test(line)) {
      const match = /^direction\s+(TD|TB|BT|LR|RL)$/.exec(line);
      if (!match || !groupStack.length) return null;
      groupStack.at(-1).direction = match[1]; continue;
    }
    let node = readNode(line);
    if (!node) return null;
    while (node.rest) {
      const edge = /^(<-->|<-\.->|<==>|<---|<-\.-|<===|-->|---|-\.->|-\.-|==>)(?:\|([^|\n]*)\|)?\s*/.exec(node.rest);
      if (!edge) return null;
      const next = readNode(node.rest.slice(edge[0].length));
      if (!next) return null;
      edges.push({ from: node.id, to: next.id, label: (edge[2] || '').replace(/^"([\s\S]*)"$/, '$1'), style: edge[1] });
      node = next;
    }
  }
  if (!direction || groupStack.length || groups.some(group => nodes.has(group.id))) return null;
  if (layout && (layout.version !== 1 || !layout.nodes || typeof layout.nodes !== 'object')) return null;
  const model = { direction, nodes: [...nodes.values()], edges, comments };
  if (groups.length) model.groups = groups;
  if (layout?.version === 1 && layout.nodes && typeof layout.nodes === 'object') {
    model.layout = { version: 1, nodes: {} };
    for (const node of model.nodes) {
      const box = Object.hasOwn(layout.nodes, node.id) && layout.nodes[node.id];
      if (box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && Math.abs(box[key]) <= 100000)
        && box.width >= 24 && box.height >= 24) {
        Object.defineProperty(model.layout.nodes, node.id, { value: { x: box.x, y: box.y, width: box.width, height: box.height }, enumerable: true, configurable: true, writable: true });
        if (/^#[a-f\d]{6}$/i.test(box.fill || '')) model.layout.nodes[node.id].fill = box.fill;
      }
    }
    if (Array.isArray(layout.edges)) model.layout.edges = model.edges.map((_edge, index) => {
      return sanitizeMermaidEdgeLayout(layout.edges[index]);
    });
    if (groups.length && layout.groups && typeof layout.groups === 'object') {
      model.layout.groups = {};
      for (const group of groups) {
        const box = Object.hasOwn(layout.groups, group.id) && layout.groups[group.id];
        if (box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && Math.abs(box[key]) <= 100000) && box.width >= 24 && box.height >= 24) {
          Object.defineProperty(model.layout.groups, group.id, { value: { x: box.x, y: box.y, width: box.width, height: box.height }, enumerable: true, configurable: true, writable: true });
        }
      }
    }
  }
  return model;
}

function sanitizeMermaidEdgeLayout(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {}, ports = ['top', 'right', 'bottom', 'left'];
  for (const key of ['fromPort', 'toPort']) if (ports.includes(value[key])) result[key] = value[key];
  const arrows = MERMAID_EDGE_ARROW_TYPES.map(([value]) => value);
  for (const [key, choices] of Object.entries({ lineType: MERMAID_EDGE_LINE_TYPES.map(([value]) => value), linePattern: MERMAID_EDGE_LINE_PATTERNS.map(([value]) => value), arrowShape: arrows.filter(value => value !== 'none'), startArrow: arrows, endArrow: arrows })) {
    if (choices.includes(value[key])) result[key] = value[key];
  }
  if (typeof value.lineJump === 'boolean') result.lineJump = value.lineJump;
  for (const [key, min, max] of [['lineWidth', .5, 8], ['arrowSize', 4, 24]]) {
    if (Number.isFinite(value[key]) && value[key] >= min && value[key] <= max) result[key] = value[key];
  }
  if (Array.isArray(value.bends) && value.bends.length <= 100 && value.bends.every(p => p && ['x', 'y'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 100000))) {
    result.bends = value.bends.map(({ x, y }) => ({ x, y }));
  }
  return Object.keys(result).length ? result : null;
}

function serializeEditableMermaidFlow(model) {
  const shapes = { rectangle: ['[', ']'], rounded: ['(', ')'], diamond: ['{', '}'], circle: ['((', '))'], stadium: ['([', '])'], subroutine: ['[[', ']]'], database: ['[(', ')]'], hexagon: ['{{', '}}'], parallelogram: ['[/', '/]'] };
  const label = text => String(text).replace(/"/g, '#quot;').replace(/\r?\n/g, '<br/>');
  const contents = parent => [
    ...model.nodes.filter(node => (node.group || null) === parent).map(node => { const [open, close] = shapes[node.shape]; return `  ${node.id}${open}"${label(node.label)}"${close}`; }),
    ...(model.groups || []).filter(group => (group.parent || null) === parent).flatMap(group => [
      `  subgraph ${group.id}["${label(group.label)}"]`, ...(group.direction ? [`    direction ${group.direction}`] : []),
      ...contents(group.id).map(line => `  ${line}`), '  end'
    ])
  ];
  return [
    ...model.comments,
    ...(model.layout ? [`%% memokeep-layout: ${JSON.stringify(model.layout)}`] : []),
    `flowchart ${model.direction}`,
    ...contents(null),
    ...model.edges.map(edge => `  ${edge.from} ${edge.style}${edge.label ? `|"${label(edge.label).replace(/\|/g, '#124;')}"|` : ''} ${edge.to}`)
  ].join('\n');
}

function noteMermaidDelta(source) {
  const Delta = window.Quill.import('delta');
  return source.replace(/\r\n?/g, '\n').split('\n').reduce((delta, line) => {
    if (line) delta.insert(line);
    return delta.insert('\n', { 'code-block': 'mermaid' });
  }, new Delta());
}

function changeNoteMermaid(quill, target, source) {
  if (!quill.isEnabled() || !quill.root.isConnected) throw new Error('笔记已关闭或不可编辑，请重新打开。');
  if (JSON.stringify(quill.getContents()) !== target.document) throw new Error('笔记内容已发生变化，请复制保留当前源码，重新打开图表后再应用。');
  const Delta = window.Quill.import('delta');
  let change, index;
  if (target.block) {
    if (!quill.root.contains(target.block)) throw new Error('原图表已不存在，请重新打开。');
    const blot = window.Quill.find(target.block);
    index = quill.getIndex(blot);
    change = new Delta().retain(index).delete(blot.length());
    if (source !== null) change = change.concat(noteMermaidDelta(source));
  } else {
    const range = target.range;
    const lines = quill.getLines(range.index, Math.max(1, range.length));
    if (lines.some(line => line.formats().table)) throw new Error('请将光标移到表格外，再插入 Mermaid 图表。');
    const [first, offset] = quill.getLine(range.index);
    const [last] = quill.getLine(range.index + range.length);
    const prefix = new Delta();
    if (offset) prefix.insert('\n', first.formats());
    const previous = offset ? first : range.index > 0 ? quill.getLine(range.index - 1)[0] : null;
    if (previous?.formats()['code-block']) prefix.insert('\n');
    index = range.index + prefix.length();
    const content = noteMermaidDelta(source);
    if (last.statics.blotName !== 'block' || last.domNode.querySelector('img')) content.insert('\n');
    change = new Delta().retain(range.index).delete(range.length).concat(prefix).concat(content);
  }
  quill.history.cutoff();
  quill.updateContents(change, 'user');
  quill.setSelection(Math.min(index, quill.getLength() - 1), 0, 'user');
  quill.history.cutoff();
  quill.scrollSelectionIntoView();
  const block = source === null ? null : quill.getLine(index)[0]?.domNode.closest('.ql-code-block-container');
  if (block) quill.root.dispatchEvent(new CustomEvent('note-diagram-preview', { detail: { block } }));
  return block;
}
