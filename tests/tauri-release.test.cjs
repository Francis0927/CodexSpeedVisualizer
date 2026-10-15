const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { installerPayloadHash } = require('../scripts/verify-release.cjs');
const { buildIsolatedApp } = require('../scripts/package-release.cjs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

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
