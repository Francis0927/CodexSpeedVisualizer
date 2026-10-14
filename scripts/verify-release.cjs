const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr || result.stdout || command + ' failed');
  return result.stdout;
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function installerPayloadHash(bytes) {
  // Tauri's bundler changes only this documented runtime bundle-type marker
  // from UNK to NSS when embedding the EXE in NSIS (tauri-utils/platform.rs).
  // Compare every other byte; never ignore an arbitrary PE/header difference.
  const original = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const replacement = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const offset = bytes.indexOf(original);
  assert.ok(offset >= 0 && bytes.indexOf(original, offset + original.length) < 0, 'Expected one Tauri bundle-type marker');
  const expected = Buffer.from(bytes);
  replacement.copy(expected, offset);
  return createHash('sha256').update(expected).digest('hex');
}
function sevenZip() {
  for (const file of ['C:/Program Files/7-Zip/7z.exe', path.resolve(__dirname, '../node_modules/7zip-bin/win/x64/7za.exe')]) {
    if (fs.existsSync(file)) return file;
  }
  throw Error('7-Zip is required to inspect the actual NSIS payload.');
}
async function assertTree(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await fsp.lstat(file);
    assert.ok(!stat.isSymbolicLink(), 'Package tree must not contain links');
    assert.ok(!/^(?:update-share.*\.json|app\.asar|node\.exe|electron\.exe)$/i.test(entry.name), 'Retired runtime/configuration in package');
    if (entry.isDirectory()) await assertTree(file);
  }
}
function inspectExe(file, version, kind) {
  const info = JSON.parse(run(file, ['--package-info']));
  assert.deepEqual(info, { version, appId: 'dev.codex.speedpet', runtime: 'tauri', frontendEmbedded: true, buildKind: kind, updateEnabled: true, repository: 'Francis0927/CodexSpeedVisualizer' });
  const quoted = file.replace(/'/g, "''");
  const peVersion = run('powershell.exe', ['-NoProfile', '-Command', "([Diagnostics.FileVersionInfo]::GetVersionInfo('" + quoted + "')).ProductVersion"]).trim();
  assert.ok(peVersion === version || peVersion === version + '.0', 'Actual PE version differs: ' + peVersion);
  return info;
}
async function findExe(directory) {
  const found = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findExe(file));
    else if (entry.name === 'Codex Speed Pet.exe') found.push(file);
  }
  return found;
}
async function verifyRelease(directory, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const app = path.join(directory, 'app');
  await assertTree(app);
  assert.deepEqual((await fsp.readdir(app)).sort(), ['Codex Speed Pet.exe', 'build-kind.json']);
  const exe = path.join(app, 'Codex Speed Pet.exe');
  inspectExe(exe, version, 'portable');
  const digest = await hashFile(exe);
  const temporary = await fsp.mkdtemp(path.join(directory, '.verify-'));
  try {
    const installerCheck = path.join(temporary, 'installer');
    run(sevenZip(), ['x', path.join(directory, 'Codex-Speed-Pet-Setup-' + version + '.exe'), '-o' + installerCheck, '-y'], { maxBuffer: 8 * 1024 * 1024 });
    const embedded = await findExe(installerCheck);
    assert.equal(embedded.length, 1, 'Installer must contain one application executable');
    assert.equal(await hashFile(embedded[0]), installerPayloadHash(await fsp.readFile(exe)), 'Actual NSIS payload differs beyond its Tauri bundle-type marker');
    await fsp.writeFile(path.join(path.dirname(embedded[0]), 'build-kind.json'), JSON.stringify({ kind: 'installed', appId: 'dev.codex.speedpet' }));
    inspectExe(embedded[0], version, 'installed');
    const zipCheck = path.join(temporary, 'zip');
    run(sevenZip(), ['x', path.join(directory, 'Codex-Speed-Pet-portable-' + version + '.zip'), '-o' + zipCheck, '-y']);
    await assertTree(zipCheck);
    assert.deepEqual((await fsp.readdir(zipCheck)).sort(), ['Codex Speed Pet.exe', 'build-kind.json']);
    assert.equal(await hashFile(path.join(zipCheck, 'Codex Speed Pet.exe')), digest, 'Portable ZIP payload differs');
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(zipCheck, 'build-kind.json'), 'utf8')), { kind: 'portable', appId: 'dev.codex.speedpet' });
    inspectExe(path.join(zipCheck, 'Codex Speed Pet.exe'), version, 'portable');
  } finally {
    // This directory is created by this invocation, inside the verified build.
    assert.equal(path.dirname(temporary), path.resolve(directory));
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  return true;
}
module.exports = { verifyRelease, inspectExe, hashFile, installerPayloadHash, sevenZip, run };
if (require.main === module) verifyRelease(path.resolve(process.argv[2]), process.argv[3]).then(() => console.log('Tauri EXE, actual NSIS/ZIP payload and GitHub updates verified')).catch(error => { console.error(error.message); process.exitCode = 1; });
