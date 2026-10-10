Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(9, 31, 42))
$face = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 57, 68))
$light = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 255, 239))
$orange = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 155, 103))
$rim = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(72, 130, 129)), 5
$track = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(51, 83, 91)), 12
$progress = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(148, 234, 179)), 12
$tick = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(184, 221, 211)), 4
$g.FillEllipse($dark, 7, 7, 242, 242)
$g.DrawEllipse($rim, 10, 10, 236, 236)
$g.FillEllipse($face, 36, 44, 184, 184)
$g.DrawArc($track, 49, 59, 158, 158, 140, 260)
$g.DrawArc($progress, 49, 59, 158, 158, 140, 170)
for ($i = 0; $i -le 12; $i++) {
  $angle = (140 + $i * 260 / 12) * [Math]::PI / 180
  $inner = if ($i % 3 -eq 0) { 91 } else { 97 }
  $g.DrawLine($tick, [single](128 + $inner * [Math]::Cos($angle)), [single](138 + $inner * [Math]::Sin($angle)), [single](128 + 105 * [Math]::Cos($angle)), [single](138 + 105 * [Math]::Sin($angle)))
}
$needle = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(122, 134),
  [System.Drawing.PointF]::new(181, 75),
  [System.Drawing.PointF]::new(134, 142)
)
$g.FillPolygon($orange, $needle)
$g.FillEllipse($orange, 117, 127, 22, 22)
$g.FillEllipse($dark, 123, 133, 10, 10)
$g.FillRectangle($dark, 92, 170, 72, 31)
$font = New-Object System.Drawing.Font 'Segoe UI', 19, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('T/s', $font, $light, [System.Drawing.RectangleF]::new(92, 173, 72, 26), $format)
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
foreach ($resource in @($dark, $face, $light, $orange, $rim, $track, $progress, $tick, $font, $format)) { $resource.Dispose() }
