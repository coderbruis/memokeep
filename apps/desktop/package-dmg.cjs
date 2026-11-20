const fs = require('node:fs');
const path = require('node:path');
const { cargoMetadata, run } = require('./desktop-build.cjs');

function packageDmg() {
  if (process.platform !== 'darwin') throw new Error('DMG 打包需要 macOS');
  const manifest = path.resolve('src-tauri/Cargo.toml');
  const config = JSON.parse(fs.readFileSync(path.resolve('src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = cargoMetadata(manifest);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'tauri', '--', 'build', '--ci', '--bundles', 'app,dmg', '--', '--locked']);
  const release = path.join(cargo.target_directory, process.env.CARGO_BUILD_TARGET || '', 'release');
  const bundle = path.join(release, 'bundle', 'dmg');
  const installers = fs.readdirSync(bundle).filter(name => name.startsWith(config.productName + '_') && name.endsWith('.dmg'));
  if (!installers.length) throw new Error('找不到 Tauri 安装盘');
  const output = path.resolve('../../dist/tauri-installers');
  fs.mkdirSync(output, { recursive: true });
  // Each edition owns its output; Tauri can reuse and clean its Cargo bundle directory.
  for (const name of installers) {
    const destination = path.join(output, name);
    fs.copyFileSync(path.join(bundle, name), destination);
    console.log(destination);
  }
}

try { packageDmg(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
