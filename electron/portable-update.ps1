$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'update.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stage = [IO.Path]::GetFullPath($PSScriptRoot)
$source = [IO.Path]::GetFullPath($config.source)
$target = [IO.Path]::GetFullPath($config.target)
$backup = Join-Path $stage 'backup'
$logFile = Join-Path $config.logDir 'updater-script-last.log'
function Write-UpdateLog([string]$message) { Add-Content -LiteralPath $logFile -Value "[$([DateTime]::UtcNow.ToString('o'))] $message" -Encoding UTF8 }
function Assert-NoLinks([string]$directory) {
  $cursor = Get-Item -LiteralPath $directory -Force
  while ($cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update paths cannot contain links.' }
    $cursor = $cursor.Parent
  }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($directory)
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update trees cannot contain links.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
    }
  }
}
function Read-Sha256([string]$filePath) {
  $stream = [IO.File]::OpenRead($filePath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)) }
  finally { $stream.Dispose(); $hasher.Dispose() }
}
function Copy-VerifiedFiles([string]$from, [string]$to) {
  # Preserve unrelated files in the user's portable directory.
  & robocopy.exe $from $to /E /IS /IT /R:3 /W:1 /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "File replacement failed (robocopy $LASTEXITCODE)." }
  # Do not rely on matching file sizes/timestamps to prove replacement.
  foreach ($file in Get-ChildItem -LiteralPath $from -File -Recurse -Force) {
    $destination = Join-Path $to $file.FullName.Substring($from.Length).TrimStart('\')
    $expectedHash = Read-Sha256 $file.FullName
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or $expectedHash -ne (Read-Sha256 $destination)) {
      # Force the bytes across if Windows' timestamp-based copy skipped them.
      [IO.File]::Copy($file.FullName, $destination, $true)
      if ($expectedHash -ne (Read-Sha256 $destination)) { throw 'Copied file checksum mismatch.' }
    }
  }
}
$replaced = $false
$succeeded = $false
try {
  # Validate the absolute targets before any mirror or recursive cleanup.
  if ($source -ne (Join-Path $stage 'files') -or $stage -eq [IO.Path]::GetPathRoot($stage) -or
      -not $stage.StartsWith(([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $stage) -notlike 'codex-speed-pet-update-*' -or
      $target -eq [IO.Path]::GetPathRoot($target) -or $target -eq $stage -or
      $stage.StartsWith(($target.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      $target.StartsWith(($stage + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      $config.exe -ne 'Codex Speed Pet.exe') { throw 'Unsafe update paths.' }
  Assert-NoLinks $stage
  Assert-NoLinks $target
  if (-not (Test-Path -LiteralPath (Join-Path $source $config.exe)) -or -not (Test-Path -LiteralPath (Join-Path $target $config.exe))) { throw 'Portable executable is missing.' }
  Write-UpdateLog 'Waiting for the application to exit.'
  $running = Get-Process -Id $config.appPid -ErrorAction SilentlyContinue
  if ($running) { $running | Wait-Process -Timeout 120 }
  Start-Sleep -Seconds 3
  Copy-VerifiedFiles $target $backup
  $replaced = $true
  Copy-VerifiedFiles $source $target
  # Retire the loose application directory used by older portable packages.
  $legacyApp = [IO.Path]::GetFullPath((Join-Path $target 'resources\app'))
  if ($legacyApp -ne (Join-Path $target 'resources\app')) { throw 'Unsafe legacy application path.' }
  if (Test-Path -LiteralPath $legacyApp -PathType Container) {
    $legacyManifest = Get-Content -LiteralPath (Join-Path $legacyApp 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($legacyManifest.name -ne 'codex-speed-pet' -or $legacyManifest.main -ne 'electron/main.cjs') { throw 'Unrecognized legacy application directory.' }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'resources\app.asar'))) { throw 'New application archive is missing.' }
    Remove-Item -LiteralPath $legacyApp -Recurse -Force
  }
  Remove-Item Env:CODEX_SPEED_PET_DEBUG_PORT -ErrorAction SilentlyContinue
  Start-Process -FilePath (Join-Path $target $config.exe) -WorkingDirectory $target
  $succeeded = $true
  Write-UpdateLog 'Update completed and application restarted.'
} catch {
  Write-UpdateLog "Update failed: $($_.Exception.Message)"
  if ($replaced) {
    try {
      # Remove only files introduced by this update, then restore original bytes.
      foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
        $relative = $file.FullName.Substring($source.Length).TrimStart('\')
        $destination = [IO.Path]::GetFullPath((Join-Path $target $relative))
        if (-not $destination.StartsWith(($target.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe restore path.' }
        if (-not (Test-Path -LiteralPath (Join-Path $backup $relative))) { Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue }
      }
      Copy-VerifiedFiles $backup $target
      Start-Process -FilePath (Join-Path $target $config.exe) -WorkingDirectory $target
      Write-UpdateLog 'Previous version restored.'
    } catch { Write-UpdateLog "Restore failed; backup retained at $backup" }
  }
} finally {
  if ($succeeded) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
