// Edit individual sequence statements without converting them to a flowchart.
function parseMermaidSequence(source) {
  const lines = source.split('\n');
  const header = lines.findIndex(line => /^\s*sequenceDiagram\s*$/.test(line));
  if (header < 0) return null;
  const actors = new Map(), messages = [];
  let reorderable = true;
  const actor = id => {
    if (!actors.has(id)) actors.set(id, { id, label: id, kind: 'participant', line: null });
    return actors.get(id);
  };
  lines.slice(header + 1).forEach((line, offset) => {
    const index = header + 1 + offset;
    if ((/^\s*(?:box|create|destroy)\b|@\{/.test(line) || line.split(':')[0].includes(';')) && !/^\s*%%/.test(line)) reorderable = false;
    const declaration = /^(\s*)(participant|actor)\s+([\w\u0080-\uffff]+)(?:\s+as\s+(.+?))?\s*$/.exec(line);
    if (declaration) {
      const item = actor(declaration[3]);
      if (item.line !== null) reorderable = false;
      Object.assign(item, { kind: declaration[2], label: declaration[4] || item.id, line: index, indent: declaration[1] });
      return;
    }
    const message = /^(\s*([\w\u0080-\uffff]+)\s*(?:<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\)|--)\s*[+-]?\s*([\w\u0080-\uffff]+)\s*:\s*)(.*)$/.exec(line);
    if (message) {
      actor(message[2]); actor(message[3]);
      messages.push({ line: index, prefix: message[1], label: message[4] });
    }
  });
  return { source, lines, header, actors: [...actors.values()], messages, reorderable };
}

function reconnectMermaidSequenceMessage(model, index, endpoint, actorId) {
  if (!['from', 'to'].includes(endpoint) || !model.actors.some(actor => actor.id === actorId)) return model.source;
  if (model.reorderable && model.actors.some(actor => actor.line === null)) {
    model = parseMermaidSequence(reorderMermaidSequence(model, model.actors.map(actor => actor.id)));
  }
  const message = model.messages[index];
  if (!message) return model.source;
  const lines = [...model.lines];
  const pattern = /^(\s*)([\w\u0080-\uffff]+)(\s*(?:<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\)|--)\s*[+-]?\s*)([\w\u0080-\uffff]+)(\s*:.*)$/;
  lines[message.line] = lines[message.line].replace(pattern, (_all, indent, from, arrow, to, rest) =>
    indent + (endpoint === 'from' ? actorId : from) + arrow + (endpoint === 'to' ? actorId : to) + rest);
  return carryMermaidSequenceMessagePositions(model.source, lines.join('\n'));
}

function editMermaidSequenceLabel(model, type, key, value) {
  const lines = [...model.lines];
  // Escape statement separators and markup; multiline input stays one statement.
  const label = String(value).replace(/[&;<>#]/g, char => `#${char.charCodeAt(0)};`).replace(/\r?\n/g, '<br/>');
  if (type === 'message') {
    const message = model.messages[key];
    if (!message) return model.source;
    lines[message.line] = message.prefix + label;
  } else {
    const actor = model.actors.find(item => item.id === key);
    if (!actor || !value.trim()) return model.source;
    if (actor.line === null) {
      if (!model.reorderable) return model.source;
      return editMermaidSequenceLabel(parseMermaidSequence(reorderMermaidSequence(model, model.actors.map(item => item.id))), type, key, value);
    }
    const declaration = `${actor.indent || '  '}${actor.kind} ${actor.id} as ${label}`;
    lines[actor.line] = declaration;
  }
  const edited = lines.join('\n');
  return type === 'message' ? carryMermaidSequenceMessagePositions(model.source, edited) : edited;
}

function reorderMermaidSequence(model, ids) {
  if (!model.reorderable || ids.length !== model.actors.length || new Set(ids).size !== ids.length
    || ids.some(id => !model.actors.some(actor => actor.id === id))) return model.source;
  const declarations = new Set(model.actors.map(actor => actor.line).filter(line => line !== null));
  const lines = model.lines.filter((_line, index) => !declarations.has(index));
  const ordered = ids.map(id => {
    const actor = model.actors.find(item => item.id === id);
    return actor.line === null ? `  participant ${id}` : model.lines[actor.line];
  });
  lines.splice(model.header + 1, 0, ...ordered);
  return lines.join('\n');
}

function deleteMermaidSequenceComponent(model, selection) {
  const selections=Array.isArray(selection)?selection:[selection];
  const lines=[...model.lines], removed=new Set();
  const messageInfo = line => /^(\s*)([\w\u0080-\uffff]+)(\s*(?:<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\)|--)\s*)([+-]?)(\s*)([\w\u0080-\uffff]+)(\s*:.*)$/.exec(line);
  const notes=[], fragments=[], stack=[], activations=[], active=new Map();
  lines.forEach((line,index)=>{
    if(/^\s*Note\s+(?:over|left of|right of)\b/i.test(line)) notes.push(index);
    if(/^\s*(?:loop|alt|opt|par|critical|break|rect)\b/.test(line)) {
      const block={start:index,branches:[],end:null};fragments.push(block);stack.push(block);
    } else if(/^\s*end\s*$/.test(line) && stack.length) stack.pop().end=index;
    else if(/^\s*(?:else|and|option)\b/.test(line) && stack.length) stack.at(-1).branches.push(index);
    const explicit=/^\s*(activate|deactivate)\s+([\w\u0080-\uffff]+)/.exec(line), message=messageInfo(line);
    const kind=explicit?.[1] || (message?.[4]==='+'?'activate':message?.[4]==='-'?'deactivate':null);
    const id=explicit?.[2] || (message?.[4]==='+'?message?.[6]:message?.[2]);
    if(kind==='activate') {
      const entry={start:index,end:null};activations.push(entry);
      if(!active.has(id)) active.set(id,[]);active.get(id).push(entry);
    } else if(kind==='deactivate') { const entry=active.get(id)?.pop();if(entry)entry.end=index; }
  });
  const stripActivation=index=>{
    const message=messageInfo(lines[index]);
    if(message) {message[4]='';lines[index]=message.slice(1).join('');}
    else removed.add(index);
  };
  for(const selection of selections) {
  if(selection.type==='actor') {
    const actor=model.actors.find(actor=>actor.id===selection.id);if(!actor)continue;
    if(actor.line!==null)removed.add(actor.line);
    lines.forEach((line,index)=>{
      const message=messageInfo(line);
      if(message && (message[2]===selection.id || message[6]===selection.id)) removed.add(index);
      const command=/^\s*(?:activate|deactivate|destroy|create(?:\s+(?:participant|actor))?)\s+([\w\u0080-\uffff]+)/.exec(line);
      if(command?.[1]===selection.id)removed.add(index);
      const note=/^\s*Note\s+(?:over|left of|right of)\s+([^:]+):/i.exec(line);
      if(note && note[1].split(',').map(id=>id.trim()).includes(selection.id))removed.add(index);
    });
  } else if(selection.type==='message') {
    const item=model.messages[selection.index];if(item)removed.add(item.line);
  } else if(selection.type==='note') {
    if(notes[selection.index]!==undefined)removed.add(notes[selection.index]);
  } else if(selection.type==='fragment') {
    const block=fragments[selection.index];
    if(block && block.end!==null) [block.start,block.end,...block.branches].forEach(index=>removed.add(index));
  } else if(selection.type==='activation') {
    const block=activations[selection.index];
    if(block) {stripActivation(block.start);if(block.end!==null)stripActivation(block.end);}
  }
  }
  // Remove the paired activation marker if one of its messages was deleted.
  activations.forEach(block=>{
    if(removed.has(block.start) && block.end!==null && !removed.has(block.end)) stripActivation(block.end);
    if(block.end!==null && removed.has(block.end) && !removed.has(block.start)) stripActivation(block.start);
  });
  if(!removed.size && lines.every((line,index)=>line===model.lines[index])) return model.source;
  // Keep implicit participants alive when their only message is removed.
  const implicit=model.actors.filter(actor=>actor.line===null && !selections.some(selection=>selection.type==='actor' && actor.id===selection.id));
  const kept=lines.filter((_line,index)=>!removed.has(index));
  if(implicit.length) kept.splice(model.header+1,0,...implicit.map(actor=>'  participant '+actor.id));
  let result=kept.join('\n');
  const elements=mermaidSequenceElementPositions(model.source), updated={};
  const counts=new Map(), nextCounts=new Map();
  model.messages.forEach(message=>{
    const raw=model.lines[message.line].trim(), occurrence=counts.get(raw)||0;counts.set(raw,occurrence+1);
    if(removed.has(message.line))return;
    const nextRaw=lines[message.line].trim(), nextOccurrence=nextCounts.get(nextRaw)||0;nextCounts.set(nextRaw,nextOccurrence+1);
    for(const prefix of ['message','route','step']) {
      const key=prefix+':'+raw+':'+occurrence;
      if(elements[key])updated[prefix+':'+nextRaw+':'+nextOccurrence]=elements[key];
    }
  });
  for(const [key,value] of Object.entries(elements)) {
    if(!/^(message|route|step):/.test(key) && !selections.some(selection=>key===selection.key)) updated[key]=value;
  }
  result=result.replace(/^[ \t]*%% memokeep-sequence-elements: .*\n?/gm,'');
  if(Object.keys(updated).length)result=result.replace(/(^[ \t]*sequenceDiagram[ \t]*$)/m,header=>header+'\n%% memokeep-sequence-elements: '+JSON.stringify(updated));
  for(const selection of selections.filter(item=>item.type==='actor')) {
    const offsets=mermaidSequenceOffsets(result);delete offsets[selection.id];
    result=result.replace(/^[ \t]*%% memokeep-sequence-layout: .*\n?/gm,'');
    if(Object.keys(offsets).length)result=result.replace(/(^[ \t]*sequenceDiagram[ \t]*$)/m,header=>header+'\n%% memokeep-sequence-layout: '+JSON.stringify(offsets));
  }
  return result;
}

function moveMermaidSequencePath(path, dx, from, to) {
  const coordinates = [];
  path.replace(/([MLCQST])([^A-Za-z]*)/gi, (_all, command, args) => {
    const values = args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    if (command === command.toUpperCase()) for (let i = 0; i < values.length; i += 2) coordinates.push(values[i]);
    return '';
  });
  if (!coordinates.length) return path;
  const start = coordinates[0], end = coordinates.at(-1);
  return path.replace(/([MLCQST])([^A-Za-z]*)/gi, (all, command, args) => {
    if (command !== command.toUpperCase()) return all;
    let index = 0;
    return command + args.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, value => {
      if (index++ % 2) return value;
      const ratio = start === end ? .5 : Math.max(0, Math.min(1, (Number(value) - start) / (end - start)));
      return Number(value) + dx * (from && to ? 1 : from ? 1 - ratio : ratio);
    });
  });
}

function mermaidSequenceOffsets(source) {
  try {
    const value = JSON.parse(/^\s*%% memokeep-sequence-layout: (.+)$/m.exec(source)?.[1] || '{}');
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([id, x]) => /^[\w\u0080-\uffff]+$/.test(id) && Number.isFinite(x) && Math.abs(x) <= 50000)));
  } catch { return Object.create(null); }
}
function setMermaidSequenceOffset(source, id, x) {
  const offsets = mermaidSequenceOffsets(source);
  offsets[id] = Math.round(Math.max(-50000, Math.min(50000, x)) * 100) / 100;
  return source.replace(/^\s*%% memokeep-sequence-layout: .*\n?/gm, '')
    .replace(/(^\s*sequenceDiagram\s*$)/m, `$1\n%% memokeep-sequence-layout: ${JSON.stringify(offsets)}`);
}
// Restore saved participant geometry once; live drag sessions belong to the editor.
function applyMermaidSequenceActorOffset(svg, id, dx, centers) {
  const attribute = (node, name, scale = 1) => {
    if (node.hasAttribute(name)) node.setAttribute(name, Number(node.getAttribute(name)) + dx * scale);
  };
  const translate = node => node.setAttribute('transform', `translate(${dx} 0) ${node.getAttribute('transform') || ''}`);
  svg.querySelectorAll('[data-et="participant"]').forEach(node => {
    if (node.getAttribute('data-id') === id && dx) translate(node);
  });
  svg.querySelectorAll('.actor-line[name]').forEach(node => {
    if (node.getAttribute('name') === id && dx) { attribute(node, 'x1'); attribute(node, 'x2'); }
  });
  [...svg.childNodes].filter(node => node.nodeType === 1 && node.tagName.toLowerCase() === 'g' && !node.querySelector('.actor-line, [data-et="participant"]'))
    .forEach(node => {
      const label = node.querySelector('text.actor');
      if (!label) return;
      if (!node.hasAttribute('data-sequence-owner')) node.setAttribute('data-sequence-owner', [...centers]
        .sort((a, b) => Math.abs(a.x - Number(label.getAttribute('x'))) - Math.abs(b.x - Number(label.getAttribute('x'))))[0]?.id || '');
      if (node.getAttribute('data-sequence-owner') === id && dx) translate(node);
    });
  svg.querySelectorAll('rect[class*="activation"]').forEach(node => {
    const x = Number(node.getAttribute('x')) + Number(node.getAttribute('width')) / 2;
    if (!node.hasAttribute('data-sequence-owner')) node.setAttribute('data-sequence-owner', [...centers]
      .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0]?.id || '');
    if (node.getAttribute('data-sequence-owner') === id && dx) attribute(node, 'x');
  });
  if (!dx) return;
  const labels = Array.from(svg.querySelectorAll('.messageText'));
  Array.from(svg.querySelectorAll('[data-et="message"]')).forEach((node, index) => {
    const from = node.getAttribute('data-from') === id, to = node.getAttribute('data-to') === id;
    if (!from && !to) return;
    if (node.dataset.sequenceRoute) {
      if (from) attribute(node, 'x1');
      if (to) attribute(node, 'x2');
      applySavedMermaidSequenceRoute({ nodes: [node] }, JSON.parse(node.dataset.sequenceRoute));
    } else if (node.tagName.toLowerCase() === 'line') {
      if (from) attribute(node, 'x1');
      if (to) attribute(node, 'x2');
    } else if (from && to) translate(node);
    else if (node.hasAttribute('d')) node.setAttribute('d', moveMermaidSequencePath(node.getAttribute('d'), dx, from, to));
    const label = labels[index], portion = from && to ? 1 : .5;
    if (label) { attribute(label, 'x', portion); label.querySelectorAll('[x]').forEach(span => attribute(span, 'x', portion)); }
  });
}
function applyMermaidSequenceOffsets(svg, source) {
  const offsets = mermaidSequenceOffsets(source);
  const centers = Array.from(svg.querySelectorAll('.actor-line[name]')).map(node => ({ id: node.getAttribute('name'), x: Number(node.getAttribute('x1')) }));
  if (!centers.length) return;
  centers.forEach(({ id }) => applyMermaidSequenceActorOffset(svg, id, offsets[id] || 0, centers));
  const box = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  const values = centers.map(({id}) => offsets[id] || 0), left = Math.min(0, ...values), right = Math.max(0, ...values);
  svg.setAttribute('viewBox', `${box[0] + left} ${box[1]} ${box[2] + right - left} ${box[3]}`);
  svg.style.maxWidth = 'none';
  const elements = mermaidSequenceElementPositions(source);
  mermaidSequenceParts(svg, parseMermaidSequence(source)).forEach(part => {
    const route=elements[part.key.replace(/^message:/,'route:')];
    if(part.type==='message' && route) applySavedMermaidSequenceRoute(part,route,elements[part.key.replace(/^message:/,'step:')] || null);
    if (elements[part.key]) applyMermaidSequencePartOffset(part, ...elements[part.key]);
  });
  const positions = Object.values(elements);
  if (positions.length) {
    const current = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
    const minX = Math.min(0, ...positions.map(p => p[0])), maxX = Math.max(0, ...positions.map(p => p[0]));
    const minY = Math.min(0, ...positions.map(p => p[1])), maxY = Math.max(0, ...positions.map(p => p[1]));
    svg.setAttribute('viewBox', `${current[0] + minX} ${current[1] + minY} ${current[2] + maxX - minX} ${current[3] + maxY - minY}`);
  }
}

function insertMermaidSequenceComponent(model, kind, { from, to, text = '', after = -1, actorIndex } = {}) {
  if (!['participant', 'actor', 'sync', 'async', 'return', 'self', 'activation', 'note', 'loop', 'alt'].includes(kind)) return model.source;
  const label = value => String(value).replace(/[&;<>#]/g, char => `#${char.charCodeAt(0)};`).replace(/\r?\n/g, '<br/>');
  if (kind === 'participant' || kind === 'actor') {
    let number = 1; while (model.source.includes(`Seq${number}`)) number++;
    const id = `Seq${number}`;
    let source = model.reorderable ? reorderMermaidSequence(model, model.actors.map(item => item.id)) : model.source;
    const updated = parseMermaidSequence(source);
    const at = model.reorderable ? updated.header + 1 + Math.max(0, Math.min(model.actors.length, actorIndex ?? model.actors.length)) : updated.header + 1;
    const lines = source.split('\n'); lines.splice(at, 0, `  ${kind} ${id} as ${label(text || (kind === 'actor' ? '角色' : '对象'))}`);
    return lines.join('\n');
  }
  let source = model.source;
  if (!model.actors.length) {
    source = insertMermaidSequenceComponent(model, 'participant', { text: '发起方' });
    source = insertMermaidSequenceComponent(parseMermaidSequence(source), 'participant', { text: '接收方' });
    model = parseMermaidSequence(source);
  }
  from = model.actors.some(item => item.id === from) ? from : model.actors[0].id;
  to = model.actors.some(item => item.id === to) ? to : (model.actors[1] || model.actors[0]).id;
  const message = label(text || '消息');
  const statements = {
    sync: `${from}->>${to}: ${message}`, async: `${from}-)${to}: ${message}`,
    return: `${from}-->>${to}: ${label(text || '返回结果')}`, self: `${from}->>${from}: ${label(text || '内部处理')}`,
    note: `Note over ${from}: ${label(text || '备注')}`,
    activation: `activate ${from}\n${from}->>${from}: ${label(text || '处理任务')}\ndeactivate ${from}`,
    loop: `loop ${label(text || '循环条件')}\n  ${from}->>${to}: 重复执行\nend`,
    alt: `alt ${label(text || '条件成立')}\n  ${from}->>${to}: 执行操作\nelse 其他情况\n  ${from}->>${to}: 其他操作\nend`
  };
  const lines = [...model.lines];
  const position = Number.isInteger(Number(after)) && model.messages[Number(after)] ? model.messages[Number(after)].line + 1 : lines.length;
  lines.splice(position, 0, ...statements[kind].split('\n').map(line => `  ${line}`));
  const inserted = lines.join('\n');
  const insertionIndex = model.messages.filter(message => message.line < position).length;
  return carryMermaidSequenceMessagePositions(model.source, inserted, insertionIndex);
}

function mermaidSequenceElementPositions(source) {
  try {
    const entries = JSON.parse(/^[ \t]*%% memokeep-sequence-elements: (.+)$/m.exec(source)?.[1] || '{}');
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(entries).filter(([key, value]) => /^(message|route|step|note|activation|fragment):/.test(key) && key.length <= 4000 && Array.isArray(value) && value.length === 2 && value.every(number => Number.isFinite(number) && Math.abs(number) <= 50000))));
  } catch { return Object.create(null); }
}
function setMermaidSequenceElementPosition(source, key, x, y) {
  const positions = mermaidSequenceElementPositions(source);
  positions[key] = [x, y].map(value => Math.round(Math.max(-50000, Math.min(50000, value)) * 100) / 100);
  return source.replace(/^[ \t]*%% memokeep-sequence-elements: .*\n?/gm, '')
    .replace(/(^[ \t]*sequenceDiagram[ \t]*$)/m, header => `${header}\n%% memokeep-sequence-elements: ${JSON.stringify(positions)}`);
}
function mermaidSequenceParts(svg, model) {
  const parts = [], occurrences = new Map();
  const add = (type, identity, nodes) => {
    const base = `${type}:${identity}`, occurrence = occurrences.get(base) || 0;
    occurrences.set(base, occurrence + 1);
    parts.push({ key: `${base}:${occurrence}`, type, nodes: nodes.filter(Boolean) });
  };
  const labels = Array.from(svg.querySelectorAll('.messageText')), numbers = Array.from(svg.querySelectorAll('.sequenceNumber'));
  Array.from(svg.querySelectorAll('[data-et="message"]')).forEach((line, index) => {
    add('message', model?.messages[index] ? model.lines[model.messages[index].line].trim() : `${line.getAttribute('data-from')}:${line.getAttribute('data-to')}:${labels[index]?.textContent}`, [line, labels[index], numbers[index]]);
  });
  svg.querySelectorAll('[data-et="note"]').forEach(node => add('note', node.textContent.trim(), [node]));
  svg.querySelectorAll('rect[class*="activation"]').forEach(node => add('activation', node.getAttribute('data-sequence-owner') || node.getAttribute('class'), [node]));
  svg.querySelectorAll('[data-et="control-structure"]').forEach(node => add('fragment', node.textContent.trim(), [node]));
  return parts;
}

// Apply persisted route geometry to a read-only renderer, without editing overlays.
function applySavedMermaidSequenceRoute(part, route, step = undefined) {
  let line = part.nodes[0];
  if (line.getAttribute('data-from') === line.getAttribute('data-to')) return;
  if (line.tagName.toLowerCase() === 'line') {
    const path = line.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const attribute of line.attributes) path.setAttribute(attribute.name, attribute.value);
    path.style.fill = 'none'; line.replaceWith(path); part.nodes[0] = path; line = path;
  }
  if (!line.hasAttribute('x1')) return;
  if (step === undefined) step = JSON.parse(line.dataset.sequenceStep || 'null');
  if (step) line.dataset.sequenceStep = JSON.stringify(step); else delete line.dataset.sequenceStep;
  line.dataset.sequenceRoute = JSON.stringify(route);
  const x1 = +line.getAttribute('x1'), x2 = +line.getAttribute('x2'), y1 = +line.getAttribute('y1'), y2 = +line.getAttribute('y2') + route[1];
  const mid = (x1 + x2) / 2 + route[0];
  const mid2 = step ? (x1 + x2) / 2 + step[0] : mid, middleY = step ? y1 + step[1] : (y1 + y2) / 2;
  line.setAttribute('d', step
    ? `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${middleY} L ${mid2} ${middleY} L ${mid2} ${y2} L ${x2} ${y2}`
    : `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`);
}

function applyMermaidSequencePartOffset(part, x, y) {
  for (const node of part.nodes) node.setAttribute('transform', `translate(${x} ${y}) ${node.getAttribute('transform') || ''}`);
}

function carryMermaidSequenceMessagePositions(before, after, insertionIndex = Infinity) {
  const positions = mermaidSequenceElementPositions(before);
  if (!Object.keys(positions).some(key => /^(message|route|step):/.test(key))) return after;
  const keys = source => {
    const model = parseMermaidSequence(source), counts = new Map();
    return model.messages.map(message => {
      const raw = model.lines[message.line].trim(), index = counts.get(raw) || 0;
      counts.set(raw, index + 1); return `message:${raw}:${index}`;
    });
  };
  const oldKeys = keys(before), newKeys = keys(after), added = newKeys.length - oldKeys.length;
  const updated = Object.fromEntries(Object.entries(positions).filter(([key]) => !/^(message|route|step):/.test(key)));
  oldKeys.forEach((key, index) => { const newKey = newKeys[index + (index >= insertionIndex ? added : 0)]; if (newKey) for (const prefix of ['message:', 'route:', 'step:']) {
    const oldKey=key.replace(/^message:/,prefix), nextKey=newKey.replace(/^message:/,prefix);
    if(positions[oldKey]) updated[nextKey]=positions[oldKey];
  } });
  return after.replace(/^[ \t]*%% memokeep-sequence-elements: .*\n?/gm, '')
    .replace(/(^[ \t]*sequenceDiagram[ \t]*$)/m, header => `${header}\n%% memokeep-sequence-elements: ${JSON.stringify(updated)}`);
}
