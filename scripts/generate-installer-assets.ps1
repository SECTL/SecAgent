# Build installer/assets/*.png for the custom Inno wizard UI.
# This file is UTF-8 with BOM so Windows PowerShell 5.1 preserves Chinese
# captions before System.Drawing renders them.
# - logo.png: auto-crop the Electron-rendered logo to its alpha bounds
# - button-primary.png / button-finish.png: 3x blue rounded pill with baked caption
# - button-browse.png: 3x outlined pill with baked caption
# - progress-track.png / progress-fill.png / progress-fill-full.png: progress bar pieces
Add-Type -AssemblyName System.Drawing

$repo = 'D:\Code\SecAgentAll\SecAgent'
$out = Join-Path $repo 'installer\assets'
New-Item -ItemType Directory -Force $out | Out-Null

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$name) {
    $path = Join-Path $out $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "wrote $name ($($bmp.Width)x$bmp.Height))"
}

# ---------- 1. Auto-crop the logo to its alpha bounding box ----------
$srcPath = Join-Path $repo '.tmp\logo-uncropped.png'
$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$rect = New-Object System.Drawing.Rectangle(0, 0, $src.Width, $src.Height)
$data = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $data.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$src.UnlockBits($data)

$minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $src.Height; $y++) {
    for ($x = 0; $x -lt $src.Width; $x++) {
        $alpha = $bytes[$y * $data.Stride + $x * 4 + 3]
        if ($alpha -gt 8) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
$cropW = $maxX - $minX + 1
$cropH = $maxY - $minY + 1
$cropped = New-Object System.Drawing.Bitmap($cropW, $cropH)
$g = [System.Drawing.Graphics]::FromImage($cropped)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cropW, $cropH)), (New-Object System.Drawing.Rectangle($minX, $minY, $cropW, $cropH)), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
Save-Png $cropped 'logo.png'
$src.Dispose()
$cropped.Dispose()

# ---------- 2. Rounded-rect pill helper ----------
function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-ButtonBitmap([int]$w, [int]$h, [int]$radius, [string]$fillHex, [string]$strokeHex, [float]$strokeW, [string]$textHex, [string]$text, [float]$textPx, [string]$font) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    # keep AA edge pixels from vanishing: draw slightly inset
    $inset = [Math]::Ceiling($strokeW / 2) + 0.5
    $path = New-RoundedPath $inset $inset ($w - 2 * $inset) ($h - 2 * $inset) ($radius - $inset)
    if ($fillHex) {
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($fillHex))
        $g.FillPath($brush, $path)
        $brush.Dispose()
    }
    if ($strokeHex -and $strokeW -gt 0) {
        $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($strokeHex), $strokeW)
        $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }
    $path.Dispose()
    if ($text) {
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
        $f = New-Object System.Drawing.Font($font, $textPx, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($textHex))
        $g.DrawString($text, $f, $brush, (New-Object System.Drawing.RectangleF(0, -1, $w, $h)), $sf)
        $brush.Dispose(); $f.Dispose(); $sf.Dispose()
    }
    $g.Dispose()
    return $bmp
}

$font = 'Microsoft YaHei UI'

# Primary pill: on-screen 218x69 r30 -> 3x = 654x207 r90. Fill #8AABFF (from the Figma design).
Save-Png (New-ButtonBitmap 654 207 90 '#8AABFF' $null 0 '#FFFFFF' '安装' 105 $font) 'button-primary.png'
Save-Png (New-ButtonBitmap 654 207 90 '#8AABFF' $null 0 '#FFFFFF' '完成' 105 $font) 'button-finish.png'
# Browse pill: on-screen 88x34 r17 -> 3x = 264x102 r51. White fill, brand-blue outline/text.
Save-Png (New-ButtonBitmap 264 102 51 '#FFFFFF' '#2389EC' 6 '#2389EC' '浏览' 45 $font) 'button-browse.png'
# Close hit target is a text glyph, no bitmap needed.

# Dir-input pill: on-screen 368x34 r17 -> 3x = 1104x102 r51. White fill, light grey stroke.
Save-Png (New-ButtonBitmap 1104 102 51 '#FFFFFF' '#D9D9D9' 6 $null '' 0 $font) 'input-pill.png'

# Progress bar, on-screen 468x14 r7 -> 3x = 1404x42 r21.
Save-Png (New-ButtonBitmap 1404 42 21 '#DFE3EA' $null 0 $null '' 0 $font) 'progress-track.png'
# Partial fill: plain rectangle (stretched horizontally at runtime), #8AABFF.
$fill = New-Object System.Drawing.Bitmap(126, 42)
$g = [System.Drawing.Graphics]::FromImage($fill)
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#8AABFF'))
$g.Dispose()
Save-Png $fill 'progress-fill.png'
$fill.Dispose()
# Full fill: rounded pill used at 100%.
Save-Png (New-ButtonBitmap 1404 42 21 '#8AABFF' $null 0 $null '' 0 $font) 'progress-fill-full.png'

Write-Host 'done.'
