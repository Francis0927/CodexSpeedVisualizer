const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-speed-pet-ui-'));
async function main() {
  try {
    fs.writeFileSync(path.join(temporary, 'settings.json'), JSON.stringify({ size: 'small', reducedMotion: false, autoHideChrome: true, historyResetAt: 12345, style: 'old', petImage: 'old' }));
    fs.mkdirSync(path.join(temporary, 'codex/sessions'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'codex/sessions/synthetic.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'token_usage_record', payload: { response_id: 'synthetic-ui', usage: { input_tokens: 100, output_tokens: 40 } } }) + '\n');
    const launcher = path.join(temporary, 'Codex Speed Pet.exe');
    fs.copyFileSync(path.resolve(__dirname, '../src-tauri/target/release/codex-speed-pet.exe'), launcher);
    fs.writeFileSync(path.join(temporary, 'build-kind.json'), JSON.stringify({ kind: 'portable', appId: 'dev.codex.speedpet' }));
    const probe = spawnSync(launcher, ['--package-info'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    assert.equal(JSON.parse(probe.stdout).updateEnabled, true);
    assert.equal(fs.existsSync(path.join(temporary, 'SpeedPet.exe')), false, 'old updater package probes keep the two-file payload intact');
    const result = spawnSync(launcher, ['--ui-test', temporary], { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, CODEX_HOME: path.join(temporary, 'codex') } });
    const reportFile = path.join(temporary, 'report.json');
    const started = Date.now();
    while (result.status === 0 && !fs.existsSync(reportFile) && Date.now() - started < 60000) await new Promise(resolve => setTimeout(resolve, 100));
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
    assert.equal(result.status, 0, JSON.stringify({ report, error: result.error?.message, stderr: result.stderr, signal: result.signal }));
    assert.equal(report?.passed, true, JSON.stringify(report));
    assert.equal(report.runtime.processName, 'SpeedPet.exe');
    assert.equal(report.runtime.launcher.toLowerCase(), launcher.toLowerCase());
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'SpeedPet.exe')), fs.readFileSync(launcher), 'runtime bytes match the verified entry point');
    assert.equal(report.settings.historyResetAt, 12345);
    assert.equal(report.settings.tiboPollMinutes, 5);
    assert.equal(report.usage.total, 140);
    assert.equal(report.usage.historyTotal, 140);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'settings.json'), 'utf8')).historyResetAt, 12345);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'settings.json'), 'utf8')).tiboPollMinutes, 5);
    console.log('Real WebView2 React regression passed: ' + report.checks.join(', '));
  } finally { require('./cleanup-webview.cjs')(temporary); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
