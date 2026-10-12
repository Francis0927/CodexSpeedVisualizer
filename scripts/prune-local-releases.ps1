[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$CurrentVersion = '',
  [ValidateSet('NoUpdate', 'Portable', 'Installer')][string]$Mode = 'NoUpdate',
  [string]$PortableDirectory = '',
  [string]$ReleaseDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$workspaceRelease = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$packageVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $CurrentVersion) { $CurrentVersion = $packageVersion }
if ($CurrentVersion -notmatch '^\d+\.\d+\.\d+$' -or $CurrentVersion -ne $packageVersion) { throw 'Cleanup version must match the project version.' }
$current = [version]$CurrentVersion
$releasePath = if ($ReleaseDirectory) { [IO.Path]::GetFullPath($ReleaseDirectory) } else { $workspaceRelease }
if ($releasePath -ne $workspaceRelease -and -not $releasePath.StartsWith(($workspaceRelease + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Cleanup directory must be the workspace release directory or a child of it.'
}

function Assert-SafePath([string]$target) {
  $absolute = [IO.Path]::GetFullPath($target)
  $prefix = $workspaceRelease + [IO.Path]::DirectorySeparatorChar
  if ($absolute -ne $workspaceRelease -and -not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path is outside workspace releases.' }
  $cursor = $workspaceRelease
  foreach ($part in @('') + $absolute.Substring($workspaceRelease.Length).TrimStart('\', '/').Split(@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($part) { $cursor = Join-Path $cursor $part }
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Cleanup will not follow junctions or symbolic links.'
    }
  }
  return $absolute
}

function Assert-NoLinksInTree([string]$directory) {
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($directory)
  while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup target contains a junction or symbolic link.' }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Read-BuildVersion([string]$directory) {
  $value = node (Join-Path $PSScriptRoot 'read-release-version.cjs') $directory
  if ($LASTEXITCODE -ne 0 -or $value -notmatch '^\d+\.\d+\.\d+$') { return '' }
  return $value
}

function Read-Sha256([string]$file) {
  # Get-FileHash in Windows PowerShell inherits -WhatIf and may return no
  # hash. Validation is read-only and must still run during a cleanup preview.
  $stream = [IO.File]::OpenRead($file)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
}

$releasePath = Assert-SafePath $releasePath
if (-not (Test-Path -LiteralPath $releasePath -PathType Container)) { throw 'Release directory is missing.' }

# Require a complete latest build before selecting any deletion candidates.
# Callers invoke this only after their variant's build/verification succeeds.
if ($Mode -eq 'NoUpdate') {
  $output = Join-Path $releasePath "no-update-$CurrentVersion"
  [void](Assert-SafePath $output)
  $index = Get-Content -LiteralPath (Join-Path $output 'verified-assets.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $expected = @("Codex-Speed-Pet-Setup-$CurrentVersion-no-update.exe", "Codex-Speed-Pet-portable-$CurrentVersion-no-update.zip", 'SHA256SUMS.txt', 'README-no-update.txt')
  if ($index.version -ne $CurrentVersion -or @($index.assets).Count -ne 4 -or @($index.assets | Select-Object -ExpandProperty name -Unique).Count -ne 4) { throw 'Latest no-update build is not complete.' }
  foreach ($asset in $index.assets) {
    if ($asset.name -notin $expected) { throw 'Unexpected latest asset name.' }
    $file = Assert-SafePath (Join-Path $output $asset.name)
    if ((Get-Item -LiteralPath $file).Length -ne $asset.size -or (Read-Sha256 $file) -ne $asset.sha256) { throw 'Latest no-update package verification failed; old releases were retained.' }
  }
} elseif ($Mode -eq 'Portable') {
  $portable = if ($PortableDirectory) { [IO.Path]::GetFullPath($PortableDirectory) } else { Join-Path $releasePath 'Codex-Speed-Pet-portable' }
  [void](Assert-SafePath $portable)
  if (-not (Test-Path -LiteralPath (Join-Path $portable 'Codex Speed Pet.exe')) -or (Read-BuildVersion $portable) -ne $CurrentVersion) { throw 'Latest portable build is not complete.' }
} else {
  $installer = Join-Path $releasePath "Codex Speed Pet Setup $CurrentVersion.exe"
  [void](Assert-SafePath $installer)
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or (Read-BuildVersion (Join-Path $releasePath 'win-unpacked')) -ne $CurrentVersion) { throw 'Latest installer build is not complete.' }
}

$candidates = @()
foreach ($item in Get-ChildItem -LiteralPath $releasePath -Force) {
  $version = $null
  $temporary = $false
  if (-not $item.PSIsContainer) {
    if ($item.Name -match '^Codex(?: Speed Pet Setup |\-Speed\-Pet\-Setup\-)(\d+\.\d+\.\d+)(?:\-no\-update)?\.exe(?:\.blockmap)?$' -or
      $item.Name -match '^Codex\-Speed\-Pet\-portable\-(\d+\.\d+\.\d+)(?:\-no\-update)?\.zip$') {
      $version = [version]$Matches[1]
    }
  } elseif ($item.Name -match '^(?:no-update-|GitHub-Release-v)(\d+\.\d+\.\d+)$') {
    $version = [version]$Matches[1]
  } elseif ($item.Name -match '^\.(?:no-update-build|verify-retry-no-update|publish-portable)-(\d+\.\d+\.\d+)(?:-[a-f0-9]{32})?$') {
    $version = [version]$Matches[1]
    $temporary = $true
  } elseif ($item.Name -eq 'config-check') {
    [void](Assert-SafePath $item.FullName)
    $value = Read-BuildVersion $item.FullName
    if ($value) { $version = [version]$value }
  }
  # Keep all current/future deliverables. Completed no-update source/failed
  # build scratch directories are also disposable after successful validation.
  if ($null -ne $version -and ($version -lt $current -or ($temporary -and $version -eq $current -and $Mode -eq 'NoUpdate'))) {
    $absolute = Assert-SafePath $item.FullName
    if ([IO.Path]::GetDirectoryName($absolute) -ne $releasePath) { throw 'Cleanup candidate is not a direct child of the release directory.' }
    if ($item.PSIsContainer) { Assert-NoLinksInTree $absolute }
    $candidates += $item
  }
}

# The verified ZIP and win-unpacked archive are sufficient for reuse. The
# extra portable tree was only used while creating that ZIP.
if ($Mode -eq 'NoUpdate') {
  $portableScratch = Assert-SafePath (Join-Path $output 'Codex-Speed-Pet-portable')
  if (Test-Path -LiteralPath $portableScratch -PathType Container) {
    Assert-NoLinksInTree $portableScratch
    $candidates += Get-Item -LiteralPath $portableScratch
  }
}

# A concurrent build or an old portable process must not be damaged by pruning.
$preview = $WhatIfPreference
try {
  # Read-only query; avoid -WhatIf noise during the CIM module's auto-import.
  $WhatIfPreference = $false
  $processes = @(Get-CimInstance Win32_Process | Select-Object ExecutablePath,CommandLine)
} finally { $WhatIfPreference = $preview }
$failed = @()
foreach ($item in $candidates) {
  $target = Assert-SafePath $item.FullName
  $prefix = $target + [IO.Path]::DirectorySeparatorChar
  $busy = @($processes | Where-Object {
    ($_.ExecutablePath -and ($_.ExecutablePath -eq $target -or $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))) -or
    ($item.PSIsContainer -and $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }).Count -gt 0
  if ($busy) { $failed += $item.Name; Write-Warning "Retained busy release: $($item.Name)"; continue }
  if ($PSCmdlet.ShouldProcess($target, 'Remove old local release/build cache')) {
    try {
      if ($item.PSIsContainer) { Remove-Item -LiteralPath $target -Recurse -Force }
      else { Remove-Item -LiteralPath $target -Force }
      Write-Output "Removed local release: $($item.Name)"
    } catch { $failed += $item.Name; Write-Warning "Could not remove local release: $($item.Name)" }
  }
}
if ($failed.Count) { throw ('Local cleanup incomplete; close file owners and retry: ' + ($failed -join ', ')) }
$status = if ($WhatIfPreference) { 'preview complete' } else { 'complete' }
Write-Output "Local release cleanup $status; retained version $CurrentVersion"
