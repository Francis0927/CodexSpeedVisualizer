[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$Share,
  [Parameter(Mandatory = $true)][string]$CurrentVersion
)

$ErrorActionPreference = 'Stop'
if ($CurrentVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$current = [version]$CurrentVersion
$directory = Get-Item -LiteralPath $Share -ErrorAction Stop
if (-not $directory.PSIsContainer) { throw 'Release share is not a directory.' }

$manifestPath = Join-Path $directory.FullName 'version.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = "Codex Speed Pet Setup $CurrentVersion.exe"
$portableZip = "Codex-Speed-Pet-portable-$CurrentVersion.zip"
if ($manifest.version -ne $CurrentVersion -or $manifest.installer -ne $installer -or $manifest.portableZip -ne $portableZip) {
  throw 'Release manifest does not point to the current packages.'
}
foreach ($name in @($installer, $portableZip)) {
  if (-not (Test-Path -LiteralPath (Join-Path $directory.FullName $name) -PathType Leaf)) {
    throw "Current package is missing: $name"
  }
}

foreach ($file in Get-ChildItem -LiteralPath $directory.FullName -File) {
  $oldVersion = $null
  if ($file.Name -match '^Codex Speed Pet Setup (\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$') {
    $oldVersion = [version]$Matches[1]
  } elseif ($file.Name -match '^Codex-Speed-Pet-portable-(\d+\.\d+\.\d+)\.zip$') {
    $oldVersion = [version]$Matches[1]
  }
  if ($null -ne $oldVersion -and $oldVersion -lt $current -and $PSCmdlet.ShouldProcess($file.FullName, 'Remove old release')) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Output "Removed old release: $($file.Name)"
  }
}
