param([switch]$NoRestart, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$stage = [IO.Path]::GetFullPath($PSScriptRoot)
$logFile = $null
$succeeded = $false
function Write-UpdateLog([string]$message) {
  if ($logFile) { Add-Content -LiteralPath $logFile -Value "[$([DateTime]::UtcNow.ToString('o'))] $message" -Encoding UTF8 }
}
function Read-Sha256([string]$filePath) {
  $stream = [IO.File]::OpenRead($filePath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
}
function Assert-NoLinks([string]$directory, [switch]$Tree) {
  $entry = Get-Item -LiteralPath $directory -Force
  while ($entry) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update paths cannot contain links.' }
    $entry = $entry.Parent
  }
  if ($Tree) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($directory)
    while ($pending.Count) {
      foreach ($child in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update trees cannot contain links.' }
        if ($child.PSIsContainer) { $pending.Push($child.FullName) }
      }
    }
  }
}
try {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $stage) -notlike 'codex-speed-pet-update-*') { throw 'Unsafe installer staging path.' }
  Assert-NoLinks $stage -Tree
  $config = Get-Content -LiteralPath (Join-Path $stage 'update.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($config.target)
  if ($config.version -notmatch '^\d+\.\d+\.\d+$' -or $config.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      $config.installer -ne ('Codex-Speed-Pet-Setup-' + $config.version + '.exe') -or
      $target -eq [IO.Path]::GetPathRoot($target) -or $target -eq $stage -or
      $target.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      $stage.StartsWith(($target.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      $target.Contains('"')) { throw 'Unsafe installed update configuration.' }
  Assert-NoLinks $target
  $exe = Join-Path $target 'Codex Speed Pet.exe'
  $marker = Get-Content -LiteralPath (Join-Path $target 'build-kind.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.appId -ne 'dev.codex.speedpet' -or $marker.kind -ne 'installed' -or
      -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed application is missing or invalid.' }
  $installer = Join-Path $stage $config.installer
  if ((Get-Item -LiteralPath $installer).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer cannot be a link.' }
  if ((Read-Sha256 $installer) -ne $config.sha256) { throw 'Installer checksum mismatch.' }
  # NSIS requires /D last, unquoted, including when the directory contains spaces.
  # ProcessStartInfo launches the EXE directly; no shell interprets this string.
  $arguments = '/S /UPDATE /NS'
  if (-not $NoRestart) { $arguments += ' /R' }
  $arguments += ' /D=' + $target
  if ($ValidateOnly) {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    ConvertTo-Json -Compress @{ installer = $installer; arguments = $arguments; target = $target }
    return
  }
  New-Item -ItemType Directory -Path $config.logDir -Force | Out-Null
  $logFile = Join-Path $config.logDir 'updater-script-last.log'
  Write-UpdateLog 'Waiting for the application to exit before silent in-place update.'
  $running = Get-Process -Id $config.appPid -ErrorAction SilentlyContinue
  if ($running) { $running | Wait-Process -Timeout 120 }
  Start-Sleep -Seconds 1
  if ((Read-Sha256 $installer) -ne $config.sha256) { throw 'Installer checksum changed before launch.' }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $installer
  $start.Arguments = $arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $process = [Diagnostics.Process]::Start($start)
  try {
    if (-not $process.WaitForExit(600000)) { throw 'Silent installer timed out; retained for inspection.' }
    if ($process.ExitCode -ne 0) { throw "Silent installer failed (exit $($process.ExitCode))." }
  } finally { $process.Dispose() }
  $probe = New-Object Diagnostics.ProcessStartInfo
  $probe.FileName = $exe
  $probe.Arguments = '--package-info'
  $probe.UseShellExecute = $false
  $probe.CreateNoWindow = $true
  $probe.RedirectStandardOutput = $true
  $process = [Diagnostics.Process]::Start($probe)
  try {
    if (-not $process.WaitForExit(30000)) { throw 'Updated application probe timed out.' }
    $info = $process.StandardOutput.ReadToEnd() | ConvertFrom-Json
    if ($process.ExitCode -ne 0 -or $info.version -ne $config.version -or
        $info.appId -ne 'dev.codex.speedpet' -or $info.buildKind -ne 'installed' -or
        $info.frontendEmbedded -ne $true -or $info.updateEnabled -ne $true) { throw 'Updated installed application validation failed.' }
  } finally { $process.Dispose() }
  Write-UpdateLog 'Silent installed update completed; installation directory and user data preserved.'
  $succeeded = $true
} catch {
  try { Write-UpdateLog "Installed update failed: $($_.Exception.Message); staging retained at $stage" } catch { }
  [Console]::Error.WriteLine('Installed update failed: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($succeeded) {
    Assert-NoLinks $stage -Tree
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
