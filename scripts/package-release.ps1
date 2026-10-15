param([switch]$SkipRendererBuild)
$ErrorActionPreference = 'Stop'
$taskArgs = @()
if ($SkipRendererBuild) { $taskArgs += '--skip-renderer' }
node (Join-Path $PSScriptRoot 'package-release.cjs') @taskArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
