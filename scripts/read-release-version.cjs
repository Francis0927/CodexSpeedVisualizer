const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { spawnSync } = require('node:child_process');

function readVersion(directory) {
  for (const relative of ['Codex Speed Pet.exe', 'app/Codex Speed Pet.exe', 'win-unpacked/Codex Speed Pet.exe']) {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) continue;
    const quoted = file.replace(/'/g, "''");
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "$taskInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo('" + quoted + "'); if ($taskInfo.ProductName -eq 'Codex Speed Pet') { $taskInfo.ProductVersion }"], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const value = result.stdout?.trim();
    if (result.status === 0 && /^\d+\.\d+\.\d+(?:\.0)?$/.test(value)) return value.split('.').slice(0, 3).join('.');
  }
  for (const relative of ["resources/app/package.json", "resources/app.asar", "win-unpacked/resources/app.asar", "package.json"]) {
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) continue;
    try {
      const bytes = file.endsWith(".asar") ? asar.extractFile(file, "package.json") : fs.readFileSync(file);
      const version = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")).version;
      if (/^\d+\.\d+\.\d+$/.test(version)) return version;
    } catch { /* An incomplete build is not evidence of a specific version. */ }
  }
  return "";
}
module.exports = { readVersion };
if (require.main === module) console.log(readVersion(path.resolve(process.argv[2])));
