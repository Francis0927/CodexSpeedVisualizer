param([string]$OutputDirectory = 'release\Codex-Speed-Pet-portable')

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'release'))
$target = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
}
if (-not $target.StartsWith(($releaseRoot + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Portable output path must be a child of the release directory.'
}
$electron = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path -LiteralPath (Join-Path $electron 'electron.exe'))) { throw 'Electron runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) { throw 'Run npm run build first.' }
if (Test-Path -LiteralPath $target) {
  if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable output cannot be a link.' }
  $busy = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(($target + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) })
  if ($busy.Count) { throw 'Exit the portable application before rebuilding its directory.' }
  Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $electron '*') -Destination $target -Recurse -Force
$app = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
$electronApp = Join-Path $app 'electron'
New-Item -ItemType Directory -Path $electronApp -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'electron') -File | Where-Object { $_.Name -notlike 'update-share*.json' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $electronApp
}
Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $app -Recurse
Copy-Item -LiteralPath (Join-Path $root 'assets') -Destination $app -Recurse
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$manifest = @{ name = 'codex-speed-pet'; version = $version; main = 'electron/main.cjs' } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $app 'package.json'), $manifest, (New-Object System.Text.UTF8Encoding $false))
Rename-Item -LiteralPath (Join-Path $target 'electron.exe') -NewName 'Codex Speed Pet.exe'
node (Join-Path $PSScriptRoot 'set-executable-icon.cjs') (Join-Path $target 'Codex Speed Pet.exe')
if ($LASTEXITCODE -ne 0) { throw 'Portable executable icon update failed.' }
& (Join-Path $PSScriptRoot 'prune-local-releases.ps1') -CurrentVersion $version -Mode Portable -PortableDirectory $target
Write-Output (Join-Path $target 'Codex Speed Pet.exe')
