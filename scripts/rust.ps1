param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargo = Join-Path $taskRoot '.tools\cargo\bin\cargo.exe'
if (Test-Path -LiteralPath $taskCargo) {
  $env:CARGO_HOME = Join-Path $taskRoot '.tools\cargo'
  $env:RUSTUP_HOME = Join-Path $taskRoot '.tools\rustup'
  $env:PATH = (Split-Path -Parent $taskCargo) + ';' + $env:PATH
} else { $taskCargo = 'cargo' }
Push-Location (Join-Path $taskRoot 'src-tauri')
try { & $taskCargo @CargoArgs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
finally { Pop-Location }
