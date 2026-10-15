const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-speed-pet-ui-'));
try {
  fs.writeFileSync(path.join(temporary, 'settings.json'), JSON.stringify({ size: 'small', reducedMotion: false, autoHideChrome: true, historyResetAt: 12345, style: 'old', petImage: 'old' }));
  fs.mkdirSync(path.join(temporary, 'codex/sessions'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'codex/sessions/synthetic.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'token_usage_record', payload: { response_id: 'synthetic-ui', usage: { input_tokens: 100, output_tokens: 40 } } }) + '\n');
  const result = spawnSync(path.resolve(__dirname, '../src-tauri/target/release/codex-speed-pet.exe'), ['--ui-test', temporary], { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, CODEX_HOME: path.join(temporary, 'codex') } });
  const reportFile = path.join(temporary, 'report.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  assert.equal(result.status, 0, report ? JSON.stringify(report) : result.error?.message || result.stderr || 'No UI report');
  assert.equal(report?.passed, true, JSON.stringify(report));
  assert.equal(report.settings.historyResetAt, 12345);
  assert.equal(report.usage.total, 140);
  assert.equal(report.usage.historyTotal, 140);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, 'settings.json'), 'utf8')).historyResetAt, 12345);
  console.log('Real WebView2 React regression passed: ' + report.checks.join(', '));
} finally { require('./cleanup-webview.cjs')(temporary); }
