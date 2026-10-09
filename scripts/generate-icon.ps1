Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 66, 70))
$mint = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(106, 232, 180))
$light = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(181, 255, 186))
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(19, 67, 77))
$pink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 155, 170))
$g.FillEllipse($dark, 8, 8, 240, 240)
$g.FillEllipse($mint, 43, 50, 170, 166)
$g.FillEllipse($light, 53, 54, 145, 122)
$g.FillEllipse($ink, 84, 116, 15, 22)
$g.FillEllipse($ink, 157, 116, 15, 22)
$g.FillEllipse($pink, 61, 148, 30, 14)
$g.FillEllipse($pink, 165, 148, 30, 14)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(19, 67, 77)), 8
$g.DrawArc($pen, 111, 143, 34, 24, 0, 180)
$pngPath = Join-Path $out 'icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$png = [System.IO.File]::ReadAllBytes($pngPath)
$icoPath = Join-Path $out 'icon.ico'
$stream = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$png.Length)
$writer.Write([uint32]22)
$writer.Write($png)
$writer.Dispose()
$pen.Dispose()
$dark.Dispose()
$mint.Dispose()
$light.Dispose()
$ink.Dispose()
$pink.Dispose()
