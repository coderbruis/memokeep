const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const sharedManifest = path.join(__dirname, '../../Cargo.toml');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出状态：${result.status ?? result.signal}`);
}

function cargoMetadata(manifest) {
  return JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version=1', '--manifest-path', manifest], { encoding: 'utf8' }));
}

function buildBackupTool() {
  run('cargo', ['build', '--locked', '--manifest-path', sharedManifest, '-p', 'memokeep-storage', '--bin', 'memokeep-backup']);
  return path.join(cargoMetadata(sharedManifest).target_directory, 'debug', 'memokeep-backup');
}

function buildDesktop(features = []) {
  const manifest = path.resolve('src-tauri/Cargo.toml');
  const cargo = cargoMetadata(manifest);
  const application = cargo.packages.find(pkg => pkg.manifest_path === manifest);
  const binary = application?.targets.find(target => target.kind.includes('bin'));
  if (!binary) throw new Error('未找到桌面应用二进制入口');
  const featureArgs = features.length ? ['--features', features.join(',')] : [];
  run('cargo', ['build', '--locked', '--manifest-path', manifest, '--bin', binary.name, ...featureArgs]);
  return path.join(cargo.target_directory, 'debug', binary.name);
}

module.exports = { run, cargoMetadata, buildBackupTool, buildDesktop };
