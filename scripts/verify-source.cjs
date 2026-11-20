const fs = require('node:fs');
const path = require('node:path');

const requiredFiles = [
  'package.json', 'apps/desktop/tauri-desktop.js', 'apps/desktop/src-tauri/src/main.rs', 'web/index.html',
  'modules/core/plugins.js', 'crates/memokeep-storage/src/backup.rs', 'modules/editions/current/plugins.js',
  'modules/content/editor/image-format.js', 'modules/content/editor/table-format.js',
  'modules/content/editor/code-format.js', 'modules/content/diagrams/canvas-model.js',
  'modules/content/diagrams/sequence-model.js', 'web/vendor/mermaid/mermaid.min.js'
];
const privatePaths = /^(?:modules\/(?:features|editions\/pro)(?:\/|$)|web\/(?:screenshot(?:-crop|-errors)?\.(?:js|html)|(?:shell\/)?free-review\.js)$)/;
const privateChannels = /\b(?:freeReview:(?:save-audio|read-audio|delete-audio|clear-audio|finish-active|finish-requested|finish-ack)|speech:(?:pause|resume)|screenshot:start|note:open-window|storage:choose-knowledge-folder|sync:(?:status|start|stop|create-pairing|revoke-device|changed))\b/;

function assertPublicFile(relative, source = '') {
  if (privatePaths.test(relative)) throw new Error(`Private implementation in public source: ${relative}`);
  if (/^modules\/.*\.cjs$/.test(relative)) throw new Error(`Retired Node host in browser source: ${relative}`);
  const browserSource = /^(?:web|modules)\//.test(relative) || /^apps\/desktop\/[^/]+\.js$/.test(relative);
  if (browserSource && /scripts\/(?:legacy-import\/|fixtures\/host-adapter\.cjs)/.test(source)) {
    throw new Error(`Development compatibility tool in runtime source: ${relative}`);
  }
  if (/(?:^|\/)(?:yes(?:\.pub)?|id_(?:rsa|ed25519)(?:\.pub)?|\.env(?:\.local|\.production)?|[^/]+\.(?:p12|pfx))$/.test(relative)) {
    throw new Error(`Credential file in public source: ${relative}`);
  }
  if (!/^(?:apps|web|modules|native)\//.test(relative) || /(?:^|\/)vendor\//.test(relative)) return;
  if (/\.(?:js|cjs|html|css|json)$/.test(relative)) {
    if (/(?:modules\/features\/|editions\/pro\/|(?:\.\.\/)+features\/(?:free-review|analytics|editor-pro|diagram-pro|workspace|screenshot|folder-publisher|sync|icloud-sync)\/)/.test(source)) {
      throw new Error(`Private module reference in public source: ${relative}`);
    }
    if (privateChannels.test(source)) throw new Error(`Private IPC in public source: ${relative}`);
    if (/function\s+(?:createMermaidCanvas|createMermaidSequenceEditor|createMermaidSequenceDrag|mermaidSequenceEditorParts|mermaidSequenceComponentIcon|paintMermaidSequenceRoute|positionMermaidSequenceRouteHandles|translateMermaidSequencePart|positionMermaidSequenceDrop|mermaidCanvasEdgeHandles|mermaidCanvasNodeHandles|mermaidCanvasResizeBox|mermaidCanvasBoxSelection|moveMermaidCanvasSelection|mermaidCanvasEditorMarkup|mermaidConnectionSample|bindNoteImageTools|bindNoteCodeStyles)\s*\(/.test(source)
      || /data-resize-corner|mermaid-edge-handle|mermaid-node-ports|mermaid-sequence-(?:message-hit|endpoint|segment)|mermaid-connection-sample/.test(source)) {
      throw new Error(`Private editor implementation in public source: ${relative}`);
    }
    if (/^modules\/editions\/[^/]+\/plugins\.js$/.test(relative) && /\bfeature:\s*['"](?:screenshot\.capture|workspace\.multiWindow|folder\.publish|analytics\.view|editor\.enhance|diagram\.visualEdit|review\.freeSpeak|sync\.(?:lan|icloud))['"]/.test(source)) {
      throw new Error(`Private plugin catalog in public source: ${relative}`);
    }
    if (/^modules\/content\/editor\/(?:code|image)\.css$/.test(relative) && /note-code-(?:style|language)-panel|note-image-(?:tools|toolbar|size-panel)/.test(source)) {
      throw new Error(`Private editor styles in public source: ${relative}`);
    }
  }
  if (/\.swift$/.test(relative) && /--detail\b|\bDetailedSpeechSession\b|\b(?:pitchSamples|pitchHz|estimatePitch|capturePitch|pitchValues)\b|func\s+(?:pause|resume)\s*\(/.test(source)) {
    throw new Error(`Detailed speech implementation in public source: ${relative}`);
  }
}

function sourceFiles(root) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'target'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (relative === 'build/speech') continue;
      assertPublicFile(relative);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative + '/');
      else files.push(relative);
    }
  }
  visit(root);
  return files;
}

function verifySource(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const files = sourceFiles(root);
  for (const file of requiredFiles) if (!files.includes(file)) throw new Error(`Missing public source: ${file}`);
  for (const file of files) {
    if (/\.(?:js|cjs|html|css|json|swift)$/.test(file)) assertPublicFile(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  return { root, files: files.length };
}

if (require.main === module) {
  try { console.log(verifySource(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifySource, assertPublicFile, requiredFiles };
