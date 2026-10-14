param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TauriArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargoBin = Join-Path $taskRoot '.tools\cargo\bin'
if (Test-Path -LiteralPath (Join-Path $taskCargoBin 'cargo.exe')) {
  $env:CARGO_HOME = Join-Path $taskRoot '.tools\cargo'
  $env:RUSTUP_HOME = Join-Path $taskRoot '.tools\rustup'
  $env:PATH = $taskCargoBin + ';' + $env:PATH
}
Push-Location $taskRoot
try { node (Join-Path $taskRoot 'node_modules\@tauri-apps\cli\tauri.js') @TauriArgs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
finally { Pop-Location }
