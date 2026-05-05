# Génère build/icon.ico (multi-résolutions) et build/icon.png (256x256)
# pour vMux. Utilise System.Drawing pour dessiner sans dépendance externe.
#
# Le design : carré arrondi gris très foncé, "v" orange en gros au centre.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot "..\build"
$buildDir = (Resolve-Path $buildDir).Path

function New-VmuxBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # Background : carré arrondi #0f0f12 → #1a1a1f gradient
    $radius = [Math]::Round($Size * 0.19)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $bgPath.AddArc(0, 0, $d, $d, 180, 90)
    $bgPath.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $bgPath.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $bgPath.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $bgPath.CloseFigure()

    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 15, 15, 18),
        [System.Drawing.Color]::FromArgb(255, 26, 26, 31),
        45.0
    )
    $g.FillPath($bgBrush, $bgPath)
    $bgBrush.Dispose()

    # Bordure subtile
    if ($Size -ge 48) {
        $borderPen = New-Object System.Drawing.Pen(
            [System.Drawing.Color]::FromArgb(180, 39, 39, 42),
            [Math]::Max(1, $Size / 170)
        )
        $g.DrawPath($borderPen, $bgPath)
        $borderPen.Dispose()
    }

    # Le "v" : deux traits formant un V
    # Calculé pour les coordonnées 256 puis scalé.
    $scale = $Size / 256.0
    $strokeW = [Math]::Max(2, [Math]::Round(22 * $scale))

    $vPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p1 = New-Object System.Drawing.PointF((60 * $scale), (70 * $scale))
    $p2 = New-Object System.Drawing.PointF((128 * $scale), (188 * $scale))
    $p3 = New-Object System.Drawing.PointF((196 * $scale), (70 * $scale))
    $vPath.AddLine($p1, $p2)
    $vPath.AddLine($p2, $p3)

    # Gradient vertical orange
    $vBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, (70 * $scale))),
        (New-Object System.Drawing.PointF(0, (188 * $scale))),
        [System.Drawing.Color]::FromArgb(255, 251, 146, 60),   # #fb923c
        [System.Drawing.Color]::FromArgb(255, 234, 88, 12)     # #ea580c
    )
    $vPen = New-Object System.Drawing.Pen($vBrush, $strokeW)
    $vPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $vPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $vPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($vPen, $vPath)
    $vPen.Dispose()
    $vBrush.Dispose()

    $g.Dispose()
    return $bmp
}

# Génère les PNG individuels en mémoire pour chaque taille
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBuffers = @{}
foreach ($s in $sizes) {
    $bmp = New-VmuxBitmap -Size $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBuffers[$s] = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
}

# Sauve un PNG 256x256 en build/icon.png (utilisé pour les notifications)
[System.IO.File]::WriteAllBytes((Join-Path $buildDir 'icon.png'), $pngBuffers[256])
Write-Host "Generated build/icon.png (256x256)"

# Construit l'ICO multi-résolutions :
# Header ICO : 6 bytes (reserved=0, type=1, count=N)
# Suivi de N entrées de 16 bytes (width, height, palette, reserved, planes, bpp, size, offset)
# Suivi des données PNG concaténées.
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ico)

# Header
$bw.Write([uint16]0)         # reserved
$bw.Write([uint16]1)         # type ICO
$bw.Write([uint16]$sizes.Count)

$dataOffset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
    $data = $pngBuffers[$s]
    $w = if ($s -eq 256) { 0 } else { [byte]$s }   # 0 signifie 256 dans le format ICO
    $h = $w
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)       # palette
    $bw.Write([byte]0)       # reserved
    $bw.Write([uint16]1)     # planes
    $bw.Write([uint16]32)    # bpp
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$dataOffset)
    $dataOffset += $data.Length
}
foreach ($s in $sizes) {
    $bw.Write($pngBuffers[$s])
}
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $buildDir 'icon.ico'), $ico.ToArray())
$bw.Dispose()
$ico.Dispose()

Write-Host "Generated build/icon.ico (multi-resolution: $($sizes -join 'x, '))"
Write-Host "Done."
