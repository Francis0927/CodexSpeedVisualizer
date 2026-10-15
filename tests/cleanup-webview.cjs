const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

module.exports = function cleanup(temporary) {
  const root = path.resolve(temporary);
  const leaf = path.basename(root);
  if (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !/^(?:codex-speed-pet-ui|tauri-window)-[a-z0-9]+$/i.test(leaf)) throw Error('Unsafe UI test cleanup path');
  // WebView2 may keep its private browser profile alive after the test host
  // exits. Kill only the processes referring to this exact generated folder.
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match [regex]::Escape('" + leaf + "') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw Error('Could not stop private WebView2 test processes: ' + result.stderr);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
};
