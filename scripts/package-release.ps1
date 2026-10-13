param([switch]$SkipRendererBuild)

$ErrorActionPreference = 'Stop'

# Nested Windows PowerShell may not have Get-FileHash available through module
# auto-loading. Hash directly with .NET.
function Get-PackageFileHash([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [pscustomobject]@{ Hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') } }
  finally { $stream.Dispose(); $hasher.Dispose() }
}

$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$packagePath = Join-Path $root 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$output = Join-Path $root "release\github-$version"
$privateConfig = Join-Path $root 'electron\update-share.json'
$configHash = if (Test-Path -LiteralPath $privateConfig) { (Get-PackageFileHash -LiteralPath $privateConfig).Hash } else { $null }

function Export-GitHubUploadDirectory($assets) {
  $upload = Join-Path $root "release\GitHub-Release-v$version"
  $expected = @("Codex-Speed-Pet-Setup-$version.exe", "Codex-Speed-Pet-portable-$version.zip", 'SHA256SUMS.txt', 'README.txt')
  if (@($assets).Count -ne 4 -or @($assets | Where-Object { $_.name -notin $expected }).Count -gt 0) { throw 'Unexpected public release assets.' }
  if (Test-Path -LiteralPath $upload) {
    if (@(Get-ChildItem -LiteralPath $upload -Force | Where-Object { $_.PSIsContainer -or $_.Name -notin $expected }).Count -gt 0) {
      throw 'Upload directory contains extra files; preserve them and inspect before continuing.'
    }
  } else { New-Item -ItemType Directory -Path $upload | Out-Null }
  foreach ($asset in $assets) {
    $destination = Join-Path $upload $asset.name
    if (Test-Path -LiteralPath $destination) {
      if ((Get-PackageFileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Existing upload attachment differs; it will not be overwritten.' }
    } else { Copy-Item -LiteralPath (Join-Path $output $asset.name) -Destination $destination }
    if ((Get-PackageFileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Upload attachment checksum mismatch.' }
  }
  Write-Output "GitHub upload folder (select all 4 files): $upload"
}

Push-Location $root
try {
  if (-not $SkipRendererBuild) {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Renderer build failed.' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) { throw 'Renderer output is missing.' }
  # Hash shipped inputs and build options; retired private configuration is excluded.
  $inputs = @()
  foreach ($folder in @('electron', 'dist', 'assets')) {
    $inputs += Get-ChildItem -LiteralPath (Join-Path $root $folder) -File -Recurse |
      Where-Object { $_.Name -notin @('update-share.json', 'update-share.example.json') }
  }
  $sourceDescription = @('github-release-v2', ($package | ConvertTo-Json -Depth 20 -Compress))
  foreach ($relative in @('package-lock.json', 'scripts/package-release.ps1', 'scripts/verify-release.cjs')) {
    $sourceDescription += $relative + ':' + (Get-PackageFileHash -LiteralPath (Join-Path $root $relative)).Hash
  }
  # Local builds from a downloaded source ZIP still work without Git metadata.
  # Actions uploads additionally require this commit to match GITHUB_SHA.
  $sourceCommit = $null
  if (Test-Path -LiteralPath (Join-Path $root '.git')) {
    $sourceCommit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the source commit.' }
  }
  foreach ($file in $inputs | Sort-Object FullName) {
    $sourceDescription += $file.FullName.Substring($root.Length + 1).Replace('\', '/') + ':' + (Get-PackageFileHash -LiteralPath $file.FullName).Hash
  }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $sourceHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($sourceDescription -join "`n")))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  $indexPath = Join-Path $output 'verified-assets.json'
  if (Test-Path -LiteralPath $output) {
    if (-not (Test-Path -LiteralPath $indexPath)) { throw 'Existing release output is incomplete; preserve it and inspect before rebuilding.' }
    $index = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($index.sourceHash -ne $sourceHash -or $index.version -ne $version) { throw 'release inputs changed for an existing version. Increase the version before rebuilding.' }
    foreach ($asset in $index.assets) {
      if ((Get-PackageFileHash -LiteralPath (Join-Path $output $asset.name)).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Existing release asset checksum mismatch.' }
    }
    node (Join-Path $PSScriptRoot 'verify-release.cjs') (Join-Path $output 'win-unpacked\resources\app.asar') $version
    if ($LASTEXITCODE -ne 0) { throw 'Existing release archive verification failed.' }
    Export-GitHubUploadDirectory $index.assets
    & (Join-Path $PSScriptRoot 'prune-local-releases.ps1') -CurrentVersion $version -Mode Release
    Write-Output "Reused verified release artifacts: $output"
    return
  }

  $stage = Join-Path $root ("release\.github-build-$version-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach ($file in $inputs) {
    $destination = Join-Path $stage $file.FullName.Substring($root.Length + 1)
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
  }
  $build = $package.build
  $build.electronDist = Join-Path $root 'node_modules\electron\dist'
  $build.directories.output = $output
  $electronVersion = (Get-Content -LiteralPath (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
  $build | Add-Member -NotePropertyName electronVersion -NotePropertyValue $electronVersion -Force
  # The renderer already bundles React; the isolated app has no native deps.
  $sanitized = @{ name = $package.name; version = $version; private = $true; description = $package.description; main = $package.main; build = $build }
  [IO.File]::WriteAllText((Join-Path $stage 'package.json'), ($sanitized | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
  node (Join-Path $root 'node_modules\electron-builder\cli.js') --win nsis --projectDir $stage
  if ($LASTEXITCODE -ne 0) { throw 'release installer build failed.' }

  $archive = Join-Path $output 'win-unpacked\resources\app.asar'
  node (Join-Path $PSScriptRoot 'verify-release.cjs') $archive $version
  if ($LASTEXITCODE -ne 0) { throw 'release archive verification failed.' }
  $installerName = "Codex-Speed-Pet-Setup-$version.exe"
  Rename-Item -LiteralPath (Join-Path $output "Codex Speed Pet Setup $version.exe") -NewName $installerName
  # Inspect the payload actually embedded in the NSIS executable, not only its build tree.
  $installerCheck = Join-Path $stage 'installer-check'
  & (Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe') x (Join-Path $output $installerName) 'resources/app.asar' "-o$installerCheck" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installer payload extraction failed.' }
  $installerArchive = Join-Path $installerCheck 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $installerArchive) -or (Get-PackageFileHash -LiteralPath $installerArchive).Hash -ne (Get-PackageFileHash -LiteralPath $archive).Hash) {
    throw 'Installer payload differs from the verified application archive.'
  }
  $portable = Join-Path $output 'Codex-Speed-Pet-portable'
  New-Item -ItemType Directory -Path $portable | Out-Null
  Copy-Item -Path (Join-Path $output 'win-unpacked\*') -Destination $portable -Recurse
  $zipName = "Codex-Speed-Pet-portable-$version.zip"
  Compress-Archive -Path (Join-Path $portable '*') -DestinationPath (Join-Path $output $zipName)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $output $zipName))
  try {
    $entry = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'resources/app.asar' })
    if ($entry.Count -ne 1) { throw 'release ZIP root/payload mismatch.' }
    $stream = $entry[0].Open(); $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $zipHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
      if ($zipHash -ne (Get-PackageFileHash -LiteralPath $archive).Hash) { throw 'release ZIP archive differs from the verified installer payload.' }
    } finally { $stream.Dispose(); $hasher.Dispose() }
  } finally { $zip.Dispose() }

  $checksums = foreach ($name in @($installerName, $zipName)) {
    (Get-PackageFileHash -LiteralPath (Join-Path $output $name)).Hash.ToLowerInvariant() + '  ' + $name
  }
  [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), (($checksums -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
  $instructions = "Codex Drive $version - Windows x64`r`n`r`n通过 GitHub Releases 检查、下载并更新；下载完成后校验 SHA-256。`r`n安装版：运行 $installerName。`r`n便携版：解压 $zipName，运行 Codex Speed Pet.exe，请保留其他运行时文件。`r`n旧内网版和旧无更新地址版需手动升级一次：安装版退出后覆盖安装；便携版解压到新目录运行。之后可在设置中检查更新并点击立即更新。`r`nSHA256SUMS.txt 提供安装包和便携 ZIP 的 SHA-256 校验值。`r`n"
  [IO.File]::WriteAllText((Join-Path $output 'README.txt'), $instructions, (New-Object Text.UTF8Encoding $false))
  $assets = foreach ($name in @($installerName, $zipName, 'SHA256SUMS.txt', 'README.txt')) {
    $file = Get-Item -LiteralPath (Join-Path $output $name)
    @{ name = $name; size = $file.Length; sha256 = (Get-PackageFileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant() }
  }
  $index = @{ version = $version; sourceCommit = $sourceCommit; sourceHash = $sourceHash; assets = @($assets) }
  [IO.File]::WriteAllText($indexPath, ($index | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
  Export-GitHubUploadDirectory $assets
  & (Join-Path $PSScriptRoot 'prune-local-releases.ps1') -CurrentVersion $version -Mode Release
  Write-Output "Built and verified release artifacts: $output"
} finally {
  Pop-Location
  $afterHash = if (Test-Path -LiteralPath $privateConfig) { (Get-PackageFileHash -LiteralPath $privateConfig).Hash } else { $null }
  if ($afterHash -ne $configHash) { throw 'The local update configuration changed during the isolated build.' }
}
