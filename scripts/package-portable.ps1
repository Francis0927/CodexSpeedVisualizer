param()
$ErrorActionPreference = 'Stop'
# Both release formats share one verified, versioned build.
& (Join-Path $PSScriptRoot 'package-release.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
