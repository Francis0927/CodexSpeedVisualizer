const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-window-'));
try {
  const report = path.join(temporary, 'report.json');
  const result = spawnSync(path.resolve(__dirname, '../src-tauri/target/debug/codex-speed-pet.exe'), ['--test-window', report], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const value = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(value.passed, true);
  console.log('Real Tauri Windows regression passed: ' + value.checks.join(', '));
} finally { require('./cleanup-webview.cjs')(temporary); }
