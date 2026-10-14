const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectExe, run, hashFile, installerPayloadHash } = require('./verify-release.cjs');

async function main() {
  // Installer execution writes Windows registration and shortcuts. Keep this
  // check on the disposable hosted runner, away from the user's installed app.
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'Francis0927/CodexSpeedVisualizer') throw Error('Installed smoke test is only permitted on this repository Actions runner');
  const directory = path.resolve(process.argv[2]);
  const version = process.argv[3];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid version');
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installed-'));
  if (/\s/.test(target)) throw Error('NSIS test installation path must not contain spaces');
  const installer = path.join(directory, 'Codex-Speed-Pet-Setup-' + version + '.exe');
  let installed = false;
  try {
    run(installer, ['/S', '/NS', '/D=' + target], { timeout: 240000 });
    installed = true;
    const exe = path.join(target, 'Codex Speed Pet.exe');
    inspectExe(exe, version, 'installed');
    const expected = installerPayloadHash(await fs.readFile(path.join(directory, 'app/Codex Speed Pet.exe')));
    if (await hashFile(exe) !== expected) throw Error('Installed payload differs from verified EXE');
    // Reinstall without /D: the update handoff must retain a custom directory.
    run(installer, ['/S', '/NS'], { timeout: 240000 });
    inspectExe(exe, version, 'installed');
    if (await hashFile(exe) !== expected) throw Error('Reinstalled payload differs');
    console.log('Actual NSIS install, installed marker and custom-directory reinstall verified');
  } finally {
    if (installed) {
      const uninstallers = (await fs.readdir(target)).filter(name => /uninstall.*\.exe$/i.test(name));
      if (uninstallers.length !== 1) throw Error('Could not identify the disposable test uninstaller');
      run(path.join(target, uninstallers[0]), ['/S'], { timeout: 120000 });
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
