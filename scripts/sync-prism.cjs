// Usage: node scripts/sync-prism.cjs /path/to/unpacked/prismjs-1.30.0/package
// Vendored grammars keep the application fully offline; no runtime downloads.
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(process.argv[2] || 'node_modules/prismjs');
const info = require(path.join(source, 'package.json'));
if (info.version !== '1.30.0') throw new Error('Expected Prism 1.30.0');
const components = require(path.join(source, 'components.json'));
const languages = Object.keys(components.languages).filter(id => id !== 'meta');
const ids = require(path.join(source, 'dependencies.js'))(components, languages).getIds();
const target = path.resolve(__dirname, '../web/vendor/prism');
fs.mkdirSync(target, { recursive: true });
const bundle = ['/* PrismJS 1.30.0 | MIT | https://prismjs.com/ | all bundled languages */', 'window.Prism = { manual: true, disableWorkerMessageHandler: true };', fs.readFileSync(path.join(source, 'components/prism-core.min.js'), 'utf8')];
for (const id of ids) bundle.push(fs.readFileSync(path.join(source, `components/prism-${id}.min.js`), 'utf8'));
bundle.push(`Prism.languages.arkts = Prism.languages.extend('typescript', { keyword: /\\b(?:struct|${'abstract|as|async|await|break|case|catch|class|const|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|namespace|new|null|of|private|protected|public|readonly|return|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield'})\\b/ });`);
bundle.push("Prism.languages.vue = Prism.languages.extend('markup', {}); Prism.languages.insertBefore('vue', 'tag', { interpolation: { pattern: /\\{\\{[\\s\\S]*?\\}\\}/, inside: { delimiter: /^\\{\\{|\\}\\}$/, rest: Prism.languages.javascript } } });");
fs.writeFileSync(path.join(target, 'prism-languages.min.js'), bundle.join('\n'));
const catalog = languages.filter(id => id !== 'clike').map(id => {
  const entry = components.languages[id];
  return { id, label: ({ markup: 'HTML', nasm: 'Asm', basic: 'Basic', vbnet: 'VB.net', jsx: 'JSX', tsx: 'TSX' })[id] || entry.title, aliases: [entry.title, ...[].concat(entry.alias || []), ...Object.values(entry.aliasTitles || {})] };
});
catalog.push({ id: 'xml', label: 'XML', aliases: ['markup'] }, { id: 'arkts', label: 'ArkTS', aliases: ['ark', '鸿蒙'] }, { id: 'vue', label: 'Vue', aliases: ['vuejs'] }, { id: 'mermaid', label: 'Mermaid', aliases: ['流程图'] });
catalog.sort((a, b) => a.label.localeCompare(b.label, 'en'));
// Explicit plaintext opts out of legacy Mermaid inference on Quill's default 'plain'.
catalog.unshift({ id: 'plaintext', label: '纯文本', aliases: ['Plain Text', 'text', 'plain'] });
fs.writeFileSync(path.join(target, 'languages.js'), `// Generated from PrismJS 1.30.0 components.json; see scripts/sync-prism.cjs.\nconst NOTE_CODE_LANGUAGES = ${JSON.stringify(catalog)};\n`);
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
fs.writeFileSync(path.join(target, 'README.md'), '# PrismJS 1.30.0\n\nSource: https://registry.npmjs.org/prismjs/-/prismjs-1.30.0.tgz\n\nMIT licensed; license included. Core and all language components are bundled locally in dependency order using upstream dependencies.js. Manual mode prevents DOM rewriting. ArkTS extends TypeScript; Vue extends markup with JavaScript interpolation. Regenerate with `node scripts/sync-prism.cjs <unpacked-package-path>`.\n');
console.log(`Bundled ${ids.length} grammars, ${catalog.length} language choices`);
