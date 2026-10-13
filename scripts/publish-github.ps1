param([string]$Notes = '')
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Push-Location $root
try {
  # Pass notes as data, including quotes/newlines, never as shell source.
  $previousNotes = $env:RELEASE_NOTES
  try {
    $env:RELEASE_NOTES = $Notes
    node (Join-Path $PSScriptRoot 'release-actions.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'GitHub Actions release did not complete. See the workflow URL and error above.' }
  } finally { $env:RELEASE_NOTES = $previousNotes }
} finally { Pop-Location }
