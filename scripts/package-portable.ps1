$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$target = [System.IO.Path]::GetFullPath((Join-Path $root 'release\Codex-Speed-Pet-portable'))
if (-not $target.StartsWith(($root + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Portable output path is outside the project.'
}
$electron = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path -LiteralPath (Join-Path $electron 'electron.exe'))) { throw 'Electron runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) { throw 'Run npm run build first.' }
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $electron '*') -Destination $target -Recurse -Force
$app = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'electron') -Destination $app -Recurse
Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $app -Recurse
Copy-Item -LiteralPath (Join-Path $root 'assets') -Destination $app -Recurse
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$manifest = @{ name = 'codex-speed-pet'; version = $version; main = 'electron/main.cjs' } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $app 'package.json'), $manifest, (New-Object System.Text.UTF8Encoding $false))
Rename-Item -LiteralPath (Join-Path $target 'electron.exe') -NewName 'Codex Speed Pet.exe'
Write-Output (Join-Path $target 'Codex Speed Pet.exe')
