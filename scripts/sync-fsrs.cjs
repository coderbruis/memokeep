// Bundle the pinned upstream browser build for the desktop and web clients.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.dirname(require.resolve('ts-fsrs'));
const target = path.join(root, 'web/vendor/ts-fsrs');
fs.mkdirSync(target, { recursive: true });
for (const [from, to] of [['index.umd.js', 'index.umd.js'], ['../LICENSE', 'LICENSE']]) {
  fs.copyFileSync(path.join(source, from), path.join(target, to));
}
