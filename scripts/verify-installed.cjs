const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { inspectExe, run, hashFile, installerPayloadHash } = require('./verify-release.cjs');

async function main() {
  // Installer execution writes Windows registration and shortcuts. Keep this
  // check on the disposable hosted runner, away from the user's installed app.
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'Francis0927/CodexSpeedVisualizer') throw Error('Installed smoke test is only permitted on this repository Actions runner');
  const directory = path.resolve(process.argv[2]);
  const version = process.argv[3];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid version');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installed-'));
  const target = path.join(root, 'custom install with spaces');
  await fs.mkdir(target);
  const folders = JSON.parse(run('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); ConvertTo-Json -Compress @{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs') }"]));
  if (!folders.desktop || !folders.programs) throw Error('Could not locate disposable runner shortcut directories');
  const desktopLink = path.join(folders.desktop, 'Codex Speed Pet.lnk');
  const startLink = path.join(folders.programs, 'Codex Speed Pet.lnk');
  const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  assert.equal(await exists(desktopLink), false, 'runner must not have a preexisting application desktop link');
  const installer = path.join(directory, 'Codex-Speed-Pet-Setup-' + version + '.exe');
  let installed = false;
  try {
    // No /NS: fresh silent installation itself must default to no desktop link,
    // while still providing the start-menu entry. NSIS /D is last and unquoted.
    run(installer, ['/S', '/D=' + target], { timeout: 240000, windowsVerbatimArguments: true });
    installed = true;
    const exe = path.join(target, 'Codex Speed Pet.exe');
    inspectExe(exe, version, 'installed');
    const expected = installerPayloadHash(await fs.readFile(path.join(directory, 'app/Codex Speed Pet.exe')));
    if (await hashFile(exe) !== expected) throw Error('Installed payload differs from verified EXE');
    assert.equal(await exists(desktopLink), false, 'silent install must not create a desktop link by default');
    assert.equal(await exists(startLink), true, 'default start-menu entry is retained');
    await fs.writeFile(path.join(target, 'user-note.txt'), 'preserve during update');
    await fs.copyFile(exe, path.join(target, 'SpeedPet.exe'));
    await fs.writeFile(path.join(target, 'update-share.json'), 'legacy local config');
    // No /UPDATE, /P or /S: select overwrite mode as on double-click.
    // The post-install launch only probes package info, avoiding live user data.
    run(installer, ['/ARGS', '--package-info', '/D=' + target], { timeout: 240000, windowsVerbatimArguments: true });
    inspectExe(exe, version, 'installed');
    assert.equal(await fs.readFile(path.join(target, 'user-note.txt'), 'utf8'), 'preserve during update');
    assert.equal(await exists(desktopLink), false, 'manual upgrade must not add a desktop shortcut');
    await fs.copyFile(exe, path.join(target, 'SpeedPet.exe'));
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-speed-pet-update-'));
    const setupName = path.basename(installer);
    await fs.copyFile(installer, path.join(stage, setupName));
    await fs.copyFile(path.resolve(__dirname, '../src-tauri/installed-update.ps1'), path.join(stage, 'apply-update.ps1'));
    await fs.writeFile(path.join(stage, 'update.json'), JSON.stringify({ installer: setupName, version, sha256: await hashFile(installer), target, appPid: 99999999, logDir: root }));
    // Exercise the exact application handoff, including /UPDATE and the spaced
    // custom directory, with automatic restart disabled only for this test.
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stage, 'apply-update.ps1'), '-NoRestart'], { timeout: 300000 });
    inspectExe(exe, version, 'installed');
    if (await hashFile(exe) !== expected) throw Error('Reinstalled payload differs');
    assert.equal(await exists(path.join(target, 'SpeedPet.exe')), false, 'installer clears the stale generated runtime before the next launch');
    assert.equal(await exists(desktopLink), false, 'silent update must not add a desktop link');
    assert.equal(await fs.readFile(path.join(target, 'user-note.txt'), 'utf8'), 'preserve during update');
    assert.equal(await fs.readFile(path.join(target, 'update-share.json'), 'utf8'), 'legacy local config');
    assert.equal(await exists(stage), false, 'successful update removes its completed staging directory');
    console.log('Actual NSIS install, silent in-place update, spaced custom directory and no default desktop shortcut verified');
  } finally {
    if (installed) {
      const uninstallers = (await fs.readdir(target)).filter(name => /uninstall.*\.exe$/i.test(name));
      if (uninstallers.length !== 1) throw Error('Could not identify the disposable test uninstaller');
      run(path.join(target, uninstallers[0]), ['/S'], { timeout: 120000 });
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
