# Publish both packages to the hardcoded LAN share used by the updater.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-share.ps1 [-Notes "更新说明"]
param([string]$Notes = "")

$ErrorActionPreference = 'Stop'

function Get-ReleaseSha256([string]$FilePath) {
  $stream = [System.IO.File]::OpenRead($FilePath)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
  } finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
}

# ==================== 局域网共享目录（唯一配置点：electron/update-share.json）====================
$shareConfigPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'electron\update-share.json'
if (-not (Test-Path -LiteralPath $shareConfigPath)) { throw "缺少配置文件：$shareConfigPath" }
$Share = (Get-Content -LiteralPath $shareConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).share
if ([string]::IsNullOrWhiteSpace($Share)) { throw 'electron/update-share.json 中的 share 为空' }
# ==============================================================================================

$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Push-Location $root
try {
  if (Get-Process -Name 'Codex Speed Pet' -ErrorAction SilentlyContinue) {
    throw '检测到正在运行的 Codex Speed Pet，请先关闭（便携版目录会被重建），再运行本脚本。'
  }
  if (-not (Test-Path -LiteralPath $Share)) { throw "共享目录不可访问：$Share" }
  $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "无效版本号：$version" }
  $manifestPath = Join-Path $Share 'version.json'
  if (Test-Path -LiteralPath $manifestPath) {
    $publishedVersion = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($publishedVersion -notmatch '^\d+\.\d+\.\d+$') { throw "共享目录版本号无效：$publishedVersion" }
    if ([version]$version -le [version]$publishedVersion) { throw "共享目录已有 v$publishedVersion，新版本必须高于它" }
  }

  Write-Host '== 构建安装包 ==' -ForegroundColor Cyan
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw 'npm run dist 失败' }
  Write-Host '== 构建便携版 ==' -ForegroundColor Cyan
  npm run dist:portable
  if ($LASTEXITCODE -ne 0) { throw 'npm run dist:portable 失败' }

  $setupName = "Codex Speed Pet Setup $version.exe"
  $zipName = "Codex-Speed-Pet-portable-$version.zip"
  $setupPath = Join-Path $root "release\$setupName"
  if (-not (Test-Path -LiteralPath $setupPath)) { throw "缺少安装包：$setupPath" }

  Write-Host '== 压缩便携版 ==' -ForegroundColor Cyan
  $zipPath = Join-Path $root "release\$zipName"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath }
  Compress-Archive -Path (Join-Path $root 'release\Codex-Speed-Pet-portable\*') -DestinationPath $zipPath

  Write-Host "== 推送到共享目录 $Share ==" -ForegroundColor Cyan
  Copy-Item -LiteralPath $setupPath -Destination (Join-Path $Share $setupName) -Force
  Copy-Item -LiteralPath $zipPath -Destination (Join-Path $Share $zipName) -Force
  foreach ($name in @($setupName, $zipName)) {
    $source = Join-Path $root "release\$name"
    $destination = Join-Path $Share $name
    if ((Get-Item -LiteralPath $source).Length -ne (Get-Item -LiteralPath $destination).Length -or
        (Get-ReleaseSha256 $source) -ne (Get-ReleaseSha256 $destination)) {
      throw "共享目录文件校验失败：$name"
    }
  }
  $manifest = @{ version = $version; notes = $Notes; installer = $setupName; portableZip = $zipName } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding $false))

  Write-Host '== 清理旧版本 ==' -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot 'prune-share-releases.ps1') -Share $Share -CurrentVersion $version

  Write-Host "已发布 v$version 到 $Share" -ForegroundColor Green
} finally {
  Pop-Location
}
