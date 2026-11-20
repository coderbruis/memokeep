const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`${command} 无法运行：${result.error.message}`);
    if (command === 'cargo') console.error('请安装 Rust stable 和 clippy，并将 cargo 加入 PATH。');
  }
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

const tests = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.cjs')).sort()
  .map(file => path.join(__dirname, file));
run(process.execPath, ['--test', ...tests]);
run('cargo', ['clippy', '--locked', '-p', 'memokeep-storage', '-p', 'memokeep-desktop-services', '--all-targets', '--all-features', '--', '-D', 'warnings']);
run('cargo', ['test', '--locked', '-p', 'memokeep-storage', '-p', 'memokeep-desktop-services', '--all-features']);
