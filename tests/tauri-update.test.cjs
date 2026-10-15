const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

async function installedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-installed-update-'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-speed-pet-update-'));
  const target = path.join(root, 'custom install with spaces');
  await fs.mkdir(target);
  const installer = 'Codex-Speed-Pet-Setup-1.2.3.exe';
  const bytes = Buffer.from('validation-only fixture: never execute');
  const config = { installer, version: '1.2.3', sha256: createHash('sha256').update(bytes).digest('hex'), target, appPid: 99999999, logDir: root };
  await fs.writeFile(path.join(stage, installer), bytes);
  await fs.copyFile(path.resolve(__dirname, '../src-tauri/installed-update.ps1'), path.join(stage, 'apply-update.ps1'));
  await fs.writeFile(path.join(target, 'Codex Speed Pet.exe'), 'original application');
  await fs.writeFile(path.join(target, 'build-kind.json'), JSON.stringify({ appId: 'dev.codex.speedpet', kind: 'installed' }));
  await fs.writeFile(path.join(stage, 'update.json'), JSON.stringify(config));
  return { root, stage, target, config, cleanup: async () => { await fs.rm(stage, { recursive: true, force: true }); await fs.rm(root, { recursive: true, force: true }); } };
}

function validateInstalled(sample, extra = []) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sample.stage, 'apply-update.ps1'), '-ValidateOnly', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

test('installed update is silent, in-place, has no new shortcuts and keeps the unquoted custom directory last', { skip: process.platform !== 'win32' }, async () => {
  const sample = await installedFixture();
  try {
    let result = validateInstalled(sample);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(await fs.realpath(plan.target), await fs.realpath(sample.target));
    assert.equal(plan.arguments, '/S /UPDATE /NS /R /D=' + plan.target);
    result = validateInstalled(sample, ['-NoRestart']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).arguments, '/S /UPDATE /NS /D=' + plan.target);
    assert.equal(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe'), 'utf8'), 'original application');
    assert.ok(await fs.stat(sample.stage), 'validation does not launch an installer or remove staging');
  } finally { await sample.cleanup(); }
});

test('installed update rejects changed installer bytes without touching the application', { skip: process.platform !== 'win32' }, async () => {
  const sample = await installedFixture();
  try {
    await fs.appendFile(path.join(sample.stage, sample.config.installer), 'tampered');
    const result = validateInstalled(sample);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Installer checksum mismatch/);
    assert.equal(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe'), 'utf8'), 'original application');
    assert.ok(await fs.stat(sample.stage));
  } finally { await sample.cleanup(); }
});

test('installed update rejects a portable directory and unsafe installer names', { skip: process.platform !== 'win32' }, async () => {
  const sample = await installedFixture();
  try {
    await fs.writeFile(path.join(sample.target, 'build-kind.json'), JSON.stringify({ appId: 'dev.codex.speedpet', kind: 'portable' }));
    assert.match(validateInstalled(sample).stderr, /Installed application is missing or invalid/);
    await fs.writeFile(path.join(sample.stage, 'update.json'), JSON.stringify({ ...sample.config, installer: '../outside.exe' }));
    assert.match(validateInstalled(sample).stderr, /Unsafe installed update configuration/);
  } finally { await sample.cleanup(); }
});

test('installed helper executes a silent NSIS fixture in the spaced directory and verifies the resulting app', { skip: process.platform !== 'win32' }, async t => {
  const compiler = path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe');
  const binary = path.resolve(__dirname, '../src-tauri/target/release/codex-speed-pet.exe');
  try { await fs.access(compiler); await fs.access(binary); } catch { t.skip('requires locally cached NSIS and an embedded release EXE'); return; }
  const probe = spawnSync(binary, ['--package-info'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const info = JSON.parse(probe.stdout);
  if (probe.status !== 0 || !info.frontendEmbedded || !info.updateEnabled) { t.skip('requires embedded release EXE'); return; }
  const sample = await installedFixture();
  try {
    await fs.unlink(path.join(sample.stage, sample.config.installer));
    sample.config.version = info.version;
    sample.config.installer = 'Codex-Speed-Pet-Setup-' + info.version + '.exe';
    const output = path.join(sample.stage, sample.config.installer);
    const script = path.join(sample.root, 'silent-fixture.nsi');
    const escape = value => value.replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"');
    await fs.writeFile(script, `Unicode true
!include "FileFunc.nsh"
!include "LogicLib.nsh"
Name "Codex isolated silent handoff fixture"
OutFile "${escape(output)}"
InstallDir "${escape(path.join(sample.root, 'wrong destination'))}"
RequestExecutionLevel user
SilentInstall silent
Section
  ClearErrors
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${If} \${Errors}
    SetErrorLevel 7
    Quit
  \${EndIf}
  ClearErrors
  \${GetOptions} $CMDLINE "/NS" $0
  \${If} \${Errors}
    SetErrorLevel 8
    Quit
  \${EndIf}
  SetOutPath "$INSTDIR"
  File "/oname=Codex Speed Pet.exe" "${escape(binary)}"
SectionEnd
`);
    const compiled = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    sample.config.sha256 = createHash('sha256').update(await fs.readFile(output)).digest('hex');
    await fs.writeFile(path.join(sample.stage, 'update.json'), JSON.stringify(sample.config));
    await fs.writeFile(path.join(sample.target, 'user-note.txt'), 'preserve me');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sample.stage, 'apply-update.ps1'), '-NoRestart'], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe')), await fs.readFile(binary));
    assert.equal(await fs.readFile(path.join(sample.target, 'user-note.txt'), 'utf8'), 'preserve me');
    assert.match(await fs.readFile(path.join(sample.root, 'updater-script-last.log'), 'utf8'), /Silent installed update completed/);
    await assert.rejects(fs.stat(sample.stage), error => error.code === 'ENOENT');
  } finally { await sample.cleanup(); }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-update-test-'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-speed-pet-update-'));
  const source = path.join(stage, 'files');
  const target = path.join(root, 'portable');
  await fs.mkdir(source); await fs.mkdir(target);
  // Harmless Windows console tools stand in for application bytes. They do not
  // initialize a dashboard, write preferences or access Codex/GitHub.
  const old = await fs.readFile(path.join(process.env.SystemRoot, 'System32/whoami.exe'));
  const replacement = await fs.readFile(path.join(process.env.SystemRoot, 'System32/where.exe'));
  await fs.writeFile(path.join(target, 'Codex Speed Pet.exe'), old);
  await fs.writeFile(path.join(source, 'Codex Speed Pet.exe'), replacement);
  await fs.writeFile(path.join(source, 'build-kind.json'), JSON.stringify({ appId: 'dev.codex.speedpet', kind: 'portable' }));
  await fs.writeFile(path.join(target, 'user-note.txt'), 'preserve me');
  await fs.writeFile(path.join(target, 'update-share.json'), 'legacy local config');
  await fs.copyFile(path.resolve(__dirname, '../src-tauri/portable-update.ps1'), path.join(stage, 'apply-update.ps1'));
  await fs.writeFile(path.join(stage, 'update.json'), JSON.stringify({ source, target, exe: 'Codex Speed Pet.exe', appPid: 99999999, logDir: root }));
  return { root, stage, source, target, old, replacement, cleanup: async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await fs.rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } };
}
function run(sample, extra) {
  const script = path.join(sample.stage, 'apply-update.ps1');
  return spawnSync('powershell.exe', extra || ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoRestart'], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
}
function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => resolve(code));
  });
}
test('portable replacement verifies bytes and preserves unrelated files and legacy config', { skip: process.platform !== 'win32' }, async () => {
  const sample = await fixture();
  try {
    const result = run(sample);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe')), sample.replacement);
    assert.equal(await fs.readFile(path.join(sample.target, 'user-note.txt'), 'utf8'), 'preserve me');
    assert.equal(await fs.readFile(path.join(sample.target, 'update-share.json'), 'utf8'), 'legacy local config');
    assert.match(await fs.readFile(path.join(sample.root, 'updater-script-last.log'), 'utf8'), /Update completed/);
  } finally { await sample.cleanup(); }
});
test('unknown portable payload is rejected before modifying the installed bytes', { skip: process.platform !== 'win32' }, async () => {
  const sample = await fixture();
  try {
    await fs.writeFile(path.join(sample.source, 'unexpected.txt'), 'bad');
    run(sample);
    assert.deepEqual(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe')), sample.old);
    assert.match(await fs.readFile(path.join(sample.root, 'updater-script-last.log'), 'utf8'), /Unexpected portable payload/);
    assert.ok(await fs.stat(sample.stage));
  } finally { await sample.cleanup(); }
});
test('occupied executable preserves original bytes and the recovery backup', { skip: process.platform !== 'win32' }, async () => {
  const sample = await fixture();
  try {
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    const script = '$taskLock = [IO.File]::Open(' + quote(path.join(sample.target, 'Codex Speed Pet.exe')) + ', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { & ' + quote(path.join(sample.stage, 'apply-update.ps1')) + ' -NoRestart } finally { $taskLock.Dispose() }';
    await Promise.all([
      runAsync(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]),
      new Promise(resolve => setTimeout(resolve, 4100)).then(() => fs.writeFile(path.join(sample.target, 'user-note.txt'), 'edited during update'))
    ]);
    assert.deepEqual(await fs.readFile(path.join(sample.target, 'Codex Speed Pet.exe')), sample.old);
    assert.deepEqual(await fs.readFile(path.join(sample.stage, 'backup/Codex Speed Pet.exe')), sample.old);
    assert.match(await fs.readFile(path.join(sample.root, 'updater-script-last.log'), 'utf8'), /Update failed/);
    assert.equal(await fs.readFile(path.join(sample.target, 'update-share.json'), 'utf8'), 'legacy local config');
    assert.equal(await fs.readFile(path.join(sample.target, 'user-note.txt'), 'utf8'), 'edited during update');
    assert.deepEqual((await fs.readdir(path.join(sample.stage, 'backup'))).sort(), ['Codex Speed Pet.exe']);
  } finally { await sample.cleanup(); }
});
