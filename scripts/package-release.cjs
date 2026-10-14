const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { run, hashFile, verifyRelease } = require('./verify-release.cjs');
const root = path.resolve(__dirname, '..');
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";

async function files(directory) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (['target', 'node_modules', '.tools'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if ((await fsp.lstat(file)).isSymbolicLink()) throw Error('Build inputs cannot contain links');
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
async function exportAssets(output, version, assets) {
  const destination = path.join(root, 'release/GitHub-Release-v' + version);
  await fsp.mkdir(destination, { recursive: true });
  const names = assets.map(a => a.name);
  if ((await fsp.readdir(destination)).some(name => !names.includes(name))) throw Error('Upload directory contains unknown files; retained.');
  for (const asset of assets) {
    const target = path.join(destination, asset.name);
    if (fs.existsSync(target)) {
      if ((await fsp.stat(target)).size !== asset.size || await hashFile(target) !== asset.sha256) throw Error('Existing attachment differs; increase version.');
    } else await fsp.copyFile(path.join(output, asset.name), target);
    if (await hashFile(target) !== asset.sha256) throw Error('Upload copy checksum mismatch');
  }
}
async function main() {
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
  if (!process.argv.includes('--skip-renderer')) run('npm.cmd', ['run', 'build'], { cwd: root, shell: true });
  const inputs = [];
  for (const directory of ['src-tauri', 'src', 'dist', 'assets', 'scripts']) inputs.push(...await files(path.join(root, directory)));
  for (const file of ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'index.html']) inputs.push(path.join(root, file));
  const hash = createHash('sha256');
  for (const file of inputs.sort()) {
    const name = path.relative(root, file).replace(/\\/g, '/');
    if (/update-share|update.*example/i.test(name)) throw Error('Retired config cannot be a build input');
    hash.update(name + ':' + await hashFile(file) + '\n');
  }
  const sourceHash = hash.digest('hex');
  const sourceCommit = fs.existsSync(path.join(root, '.git')) && !run('git', ['status', '--porcelain'], { cwd: root }).trim() ? run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim() : null;
  const output = path.join(root, 'release/github-' + version);
  const indexFile = path.join(output, 'verified-assets.json');
  if (fs.existsSync(output)) {
    if (!fs.existsSync(indexFile)) throw Error('Existing build is incomplete; preserve it and inspect before retrying.');
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    if (index.version !== version || index.sourceHash !== sourceHash || index.sourceCommit !== sourceCommit) throw Error('Build inputs changed for existing version. Increase the version.');
    for (const asset of index.assets) if ((await fsp.stat(path.join(output, asset.name))).size !== asset.size || await hashFile(path.join(output, asset.name)) !== asset.sha256) throw Error('Existing build checksum mismatch');
    await verifyRelease(output, version);
    await exportAssets(output, version, index.assets);
  } else {
    const stage = path.join(root, 'release/.github-build-' + version + '-' + randomUUID().replace(/-/g, ''));
    await fsp.mkdir(stage, { recursive: true });
    for (const file of inputs) {
      const destination = path.join(stage, path.relative(root, file));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(file, destination);
    }
    const env = { ...process.env };
    const cargo = path.join(root, '.tools/cargo');
    if (fs.existsSync(path.join(cargo, 'bin/cargo.exe'))) {
      env.CARGO_HOME = cargo; env.RUSTUP_HOME = path.join(root, '.tools/rustup');
      env.PATH = path.join(cargo, 'bin') + ';' + env.PATH;
    }
    // Empty hook: renderer is already built and copied; the isolated source
    // does not need node_modules or any machine-specific update configuration.
    run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--features', 'custom-protocol', '--config', JSON.stringify({ build: { beforeBuildCommand: '' } })], { cwd: stage, env, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const target = path.join(stage, 'src-tauri/target/release');
    const installers = (await fsp.readdir(path.join(target, 'bundle/nsis'))).filter(name => name.endsWith('.exe'));
    if (installers.length !== 1) throw Error('Expected one NSIS installer');
    await fsp.mkdir(path.join(output, 'app'), { recursive: true });
    await fsp.copyFile(path.join(target, 'Codex Speed Pet.exe'), path.join(output, 'app/Codex Speed Pet.exe'));
    await fsp.writeFile(path.join(output, 'app/build-kind.json'), JSON.stringify({ kind: 'portable', appId: 'dev.codex.speedpet' }));
    const installer = 'Codex-Speed-Pet-Setup-' + version + '.exe';
    const portable = 'Codex-Speed-Pet-portable-' + version + '.zip';
    await fsp.copyFile(path.join(target, 'bundle/nsis', installers[0]), path.join(output, installer));
    run('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath ' + psQuote(path.join(output, 'app/Codex Speed Pet.exe')) + ',' + psQuote(path.join(output, 'app/build-kind.json')) + ' -DestinationPath ' + psQuote(path.join(output, portable))]);
    await verifyRelease(output, version);
    const sums = [];
    for (const name of [installer, portable]) sums.push(await hashFile(path.join(output, name)) + '  ' + name);
    await fsp.writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    await fsp.writeFile(path.join(output, 'README.txt'), 'Codex Drive ' + version + ' — Windows 10/11 x64\r\n\r\n安装版：运行 ' + installer + '。\r\n便携版：解压 ZIP，运行 Codex Speed Pet.exe，保留 build-kind.json。\r\n需要 Microsoft Edge WebView2，缺少时按提示安装：https://developer.microsoft.com/microsoft-edge/webview2/\r\n首次从 Electron 切换：退出旧版，安装版卸载旧程序后安装新版（保留用户数据）；便携版解压到新目录。\r\n旧内网版及旧无更新地址版同样手动切换一次。之后两种版本均从 GitHub Releases 更新：https://github.com/Francis0927/CodexSpeedVisualizer/releases\r\n更新下载后核对大小与 SHA-256，便携更新失败保留备份与日志。\r\n设置与统计重置记录沿用原用户数据目录；不修改 Codex 会话或遗留本机更新配置。\r\nSHA256SUMS.txt 包含安装包和便携 ZIP 校验值。\r\n');
    const assets = [];
    for (const name of [installer, portable, 'SHA256SUMS.txt', 'README.txt']) assets.push({ name, size: (await fsp.stat(path.join(output, name))).size, sha256: await hashFile(path.join(output, name)) });
    await fsp.writeFile(indexFile, JSON.stringify({ version, sourceCommit, sourceHash, assets }, null, 2));
    await exportAssets(output, version, assets);
  }
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/prune-local-releases.ps1'), '-CurrentVersion', version, '-Mode', 'Release']);
  console.log('Built and verified Tauri release: ' + output);
}
main().catch(error => { console.error(error.message); console.error('Incomplete artifacts and isolated source are retained; no old packages were pruned.'); process.exitCode = 1; });
