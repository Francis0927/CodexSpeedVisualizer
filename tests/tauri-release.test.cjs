const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { installerPayloadHash } = require('../scripts/verify-release.cjs');
const { buildIsolatedApp } = require('../scripts/package-release.cjs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('installer hooks compile with real NSIS, default desktop opt-out and preserved start-menu macros', async t => {
  const compiler = path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe');
  if (process.platform !== 'win32' || !fs.existsSync(compiler)) { t.skip('NSIS compiler not cached locally; full installer compilation runs in Actions'); return; }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-nsis-hooks-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'hooks.nsi');
  const output = path.join(root, 'hooks.exe');
  const hooks = path.resolve(__dirname, '../src-tauri/installer-hooks.nsh');
  await fsp.writeFile(script, `Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
Var NoShortcutMode
Var AppStartMenuFolder
!define PRODUCTNAME "Codex Speed Pet"
!include "${hooks}"
!ifndef MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !error "Desktop shortcut must be opt-in"
!endif
Name "Codex installer hook compile test"
OutFile "${output}"
InstallDir "$TEMP\\codex-installer-hook-fixture"
RequestExecutionLevel user
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
Function CreateOrUpdateStartMenuShortcut
FunctionEnd
Function CreateOrUpdateDesktopShortcut
FunctionEnd
Section "Uninstall"
  !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
`);
  const result = spawnSync(compiler, ['/V2', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.ok((await fsp.stat(output)).size > 0, 'compiled fixture is never executed');
});

test('NSIS identity permits exactly the known Tauri UNK to NSS marker transformation', () => {
  const source = Buffer.from('code-prefix__TAURI_BUNDLE_TYPE_VAR_UNKcode-suffix');
  const installed = Buffer.from('code-prefix__TAURI_BUNDLE_TYPE_VAR_NSScode-suffix');
  assert.equal(installerPayloadHash(source), hash(installed));
  const changed = Buffer.from(installed); changed[0] ^= 1;
  assert.notEqual(installerPayloadHash(source), hash(changed), 'other bytes remain protected');
  assert.equal(source.toString(), 'code-prefix__TAURI_BUNDLE_TYPE_VAR_UNKcode-suffix', 'verification cannot modify source bytes');
});
test('missing or duplicated bundle markers cannot bypass installer payload verification', () => {
  assert.throws(() => installerPayloadHash(Buffer.from('unknown executable')));
  assert.throws(() => installerPayloadHash(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK')));
});

test('isolated packaging uses the shared compiler output and selects only the current installer', async t => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'tauri-release-cache-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const stage = path.join(temporary, 'isolated source');
  const shared = path.join(temporary, 'shared target');
  const env = { CARGO_TARGET_DIR: shared, RUSTUP_TOOLCHAIN: '1.99.0' };
  let calls = 0;
  const result = await buildIsolatedApp(stage, '1.2.3', env, (_command, args, options) => {
    calls++;
    assert.equal(options.cwd, stage, 'compilation must still use isolated source');
    assert.equal(options.env.CARGO_TARGET_DIR, shared);
    assert.equal(options.env.RUSTUP_TOOLCHAIN, env.RUSTUP_TOOLCHAIN);
    assert.equal(options.stdio, 'inherit', 'compiler progress and timings remain visible in CI logs');
    assert.ok(args.includes('custom-protocol'));
    const directory = path.join(options.env.CARGO_TARGET_DIR, 'release/bundle/nsis');
    fs.mkdirSync(directory, { recursive: true });
    for (const version of ['1.2.2', '1.2.3']) fs.writeFileSync(path.join(directory, 'Codex Speed Pet_' + version + '_x64-setup.exe'), version);
  });
  assert.equal(calls, 1, 'a cache hit must not bypass the build');
  assert.equal(result.target, path.join(shared, 'release'));
  assert.equal(await fsp.readFile(result.installerPath, 'utf8'), '1.2.3');
  assert.deepEqual(env, { CARGO_TARGET_DIR: shared, RUSTUP_TOOLCHAIN: '1.99.0' });
});

test('local packaging retains isolated output when no compiler cache is configured', async t => {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'tauri-release-local-'));
  t.after(() => fsp.rm(stage, { recursive: true, force: true }));
  const result = await buildIsolatedApp(stage, '1.2.3', {}, (_command, _args, options) => {
    const directory = path.join(options.env.CARGO_TARGET_DIR, 'release/bundle/nsis');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'Codex Speed Pet_1.2.3_x64-setup.exe'), 'current');
  });
  assert.equal(result.target, path.join(stage, 'src-tauri/target/release'));
});

test('cached installers cannot hide a missing current installer or a failed build', async t => {
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'tauri-release-stale-'));
  t.after(() => fsp.rm(stage, { recursive: true, force: true }));
  const shared = path.join(stage, 'shared');
  const directory = path.join(shared, 'release/bundle/nsis');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, 'Codex Speed Pet_1.2.2_x64-setup.exe'), 'stale');
  const env = { CARGO_TARGET_DIR: shared };
  await assert.rejects(buildIsolatedApp(stage, '1.2.3', env, () => {}), /Expected one NSIS installer for version 1\.2\.3/);
  await assert.rejects(buildIsolatedApp(stage, '1.2.3', env, () => { throw Error('compiler failed'); }), /compiler failed/);
});
