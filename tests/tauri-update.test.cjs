const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

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
