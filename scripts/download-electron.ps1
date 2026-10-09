$ErrorActionPreference = 'Stop'
$version = '29.4.6'
$name = "electron-v$version-win32-x64.zip"
$size = 108179999
$root = Split-Path -Parent $PSScriptRoot
$partsDir = Join-Path $root '.electron-parts'
$zip = Join-Path $root 'electron-runtime.zip'
$expected = ((Get-Content (Join-Path $root 'node_modules\electron\checksums.json') -Raw | ConvertFrom-Json).$name)
New-Item -ItemType Directory -Path $partsDir -Force | Out-Null
$jobs = @()
$parts = @()
for ($i = 0; $i -lt 8; $i++) {
  $start = [int64][math]::Floor($size * $i / 8)
  $end = [int64][math]::Floor($size * ($i + 1) / 8) - 1
  $part = Join-Path $partsDir ("part-$i")
  $parts += $part
  $rest = "$part.rest"
  if (Test-Path -LiteralPath $rest) {
    $target = [System.IO.File]::Open($part, [System.IO.FileMode]::Append)
    try {
      $source = [System.IO.File]::OpenRead($rest)
      try { $source.CopyTo($target) } finally { $source.Dispose() }
    } finally { $target.Dispose() }
    Remove-Item -LiteralPath $rest
  }
  $have = if (Test-Path -LiteralPath $part) { (Get-Item -LiteralPath $part).Length } else { 0 }
  $expectedPartSize = $end - $start + 1
  if ($have -gt $expectedPartSize) { throw "Oversized part: $part" }
  if ($have -eq $expectedPartSize) { continue }
  $jobs += Start-Job -ScriptBlock {
    param($url, $start, $end, $part, $expectedBytes)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $have = if (Test-Path -LiteralPath $part) { (Get-Item -LiteralPath $part).Length } else { 0 }
      if ($have -eq $expectedBytes) { return }
      $chunk = "$part.chunk"
      & curl.exe -fsSL --max-time 120 -r "$($start + $have)-$end" -o $chunk $url 2>$null
      if (Test-Path -LiteralPath $chunk) {
        $chunkSize = (Get-Item -LiteralPath $chunk).Length
        if ($have + $chunkSize -gt $expectedBytes) { throw "Oversized chunk: $part" }
        $target = [System.IO.File]::Open($part, [System.IO.FileMode]::Append)
        try {
          $source = [System.IO.File]::OpenRead($chunk)
          try { $source.CopyTo($target) } finally { $source.Dispose() }
        } finally { $target.Dispose() }
        Remove-Item -LiteralPath $chunk
      }
    }
    throw "download incomplete: $part"
  } -ArgumentList "https://github.com/electron/electron/releases/download/v$version/$name", $start, $end, $part, $expectedPartSize
}
$jobs | Wait-Job | Out-Null
$failed = @($jobs | Where-Object { $_.State -ne 'Completed' })
$jobs | Receive-Job -ErrorAction SilentlyContinue
$jobs | Remove-Job
if ($failed.Count) { throw 'One or more Electron download parts failed.' }
$output = [System.IO.File]::Create($zip)
try {
  foreach ($part in $parts) {
    $inputFile = [System.IO.File]::OpenRead($part)
    try { $inputFile.CopyTo($output) } finally { $inputFile.Dispose() }
  }
} finally { $output.Dispose() }
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Electron SHA256 mismatch: $actual" }
Write-Output "Verified $name ($actual)"
$dist = Join-Path $root 'node_modules\electron\dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $dist -Force
[System.IO.File]::WriteAllText((Join-Path $root 'node_modules\electron\path.txt'), 'electron.exe')
foreach ($part in $parts) { Remove-Item -LiteralPath $part }
Remove-Item -LiteralPath $partsDir
Remove-Item -LiteralPath $zip
