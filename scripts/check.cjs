const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function checkSource(root = path.resolve(__dirname, '..')) {
  let files = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'vendor', 'dist'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:js|cjs)$/.test(entry.name)) {
        execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
        files++;
      }
    }
  }
  visit(root);
  return { root: path.resolve(root), files };
}

if (require.main === module) {
  try { console.log(checkSource(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkSource };
