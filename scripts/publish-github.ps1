param([string]$Notes = '')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Push-Location $root
try {
  node (Join-Path $PSScriptRoot 'publish-github.cjs') --preflight
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Release preflight failed.' }
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'package-no-update.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'No-update package build failed.' }
  node (Join-Path $PSScriptRoot 'publish-github.cjs') --notes $Notes
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Release publish failed.' }
} finally { Pop-Location }
