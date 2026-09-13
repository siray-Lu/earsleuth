# 由 icon-source.png 產生全部的圖示與分享預覽圖。
#
# 來源是一張 839x839 的方形插畫（偵探拿放大鏡，下方有「音隙偵探／猜歌大挑戰」字樣），
# 四個角是白色圓角。各平台需要的規格不同，所以這裡統一重新輸出：
#
#   icon-192 / icon-512      一般圖示。把白色圓角換成底色，輸出成完整方形
#   apple-touch-icon         iOS 會自己加圓角，來源的圓角要拿掉，否則會出現雙重圓角
#   icon-maskable-512        Android 會裁成圓形，安全區只有中間 80%，所以內容要縮小留邊
#   og-image                 1200x630 橫式，社群分享用。取來源中間的圓形插畫，重新排版
#
# 注意：PowerShell 變數不分大小寫，半徑不要取名 $R，會跟迴圈變數 $r 撞在一起。

Add-Type -AssemblyName System.Drawing

$ProjectDir = Split-Path -Parent $PSScriptRoot
$SrcPath = Join-Path $ProjectDir "icon-source.png"

if (-not (Test-Path $SrcPath)) {
    Write-Error "找不到來源圖 $SrcPath"
    exit 1
}

$src = New-Object System.Drawing.Bitmap($SrcPath)
Write-Output ("來源: {0}x{1}" -f $src.Width, $src.Height)

function RGB($r, $g, $b) { [System.Drawing.Color]::FromArgb(255, $r, $g, $b) }
function ARGB($a, $r, $g, $b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }

# 來源圖的底色與重點色，後面的版面都跟著這一套走
$NAVY = RGB 3 25 62
$NAVY_LIGHT = RGB 10 42 88
$TEAL = RGB 46 227 220
$WHITE = RGB 255 255 255

# 來源圖裡那顆圓形插畫的位置（掃描像素量出來的）
$CIRCLE_CX = 420.0
$CIRCLE_CY = 347.0
$CIRCLE_RADIUS = 240.0

# 來源圖的白色圓角半徑
$SRC_CORNER = 141.0

function New-Canvas($w, $h) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    return @{ Bitmap = $bmp; Graphics = $g }
}

function New-RoundedPath($x, $y, $w, $h, $rad) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $rad * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# 畫出來源圖，但把白色圓角換成底色。
# 做法是先鋪滿底色，再把繪製範圍限制在圓角矩形內 —— 白色的部分根本不會被畫上去。
# 補角落的顏色直接從來源圖的邊緣取樣，不要自己指定一個「看起來很像」的深藍。
# 差個五階就會在圓角邊緣浮出一條淡淡的接縫，在純色圖示上特別明顯。
$EDGE = $src.GetPixel([int]($src.Width / 2), 6)

function Draw-IconInto($g, $size, $inset) {
    $g.Clear($EDGE)
    $box = $size - $inset * 2
    $rad = $SRC_CORNER * ($box / $src.Width)
    $path = New-RoundedPath $inset $inset $box $box $rad
    $g.SetClip($path)
    $g.DrawImage($src, $inset, $inset, $box, $box)
    $g.ResetClip()
}

function Save-Icon($name, $size, $inset) {
    $c = New-Canvas $size $size
    Draw-IconInto $c.Graphics $size $inset
    $out = Join-Path $ProjectDir $name
    $c.Bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $c.Graphics.Dispose(); $c.Bitmap.Dispose()
    Write-Output ("  {0}  {1}x{1}  {2:N0} bytes" -f $name, $size, (Get-Item $out).Length)
}

Write-Output "產生圖示："
Save-Icon "icon-192.png" 192 0
Save-Icon "icon-512.png" 512 0
Save-Icon "apple-touch-icon.png" 180 0
# Android 會把圖示裁成圓形，中間 80% 以外都可能被切掉，所以內容要往內縮
Save-Icon "icon-maskable-512.png" 512 51

# ---------------------------------------------------------------- 分享預覽圖
Write-Output "產生分享圖："

$W = 1200
$H = 630
$c = New-Canvas $W $H
$g = $c.Graphics

# 底：左上略亮、往右下沉，跟來源圖同一個藍
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($W, $H)),
    $NAVY_LIGHT, $NAVY)
$g.FillRectangle($bg, 0, 0, $W, $H)

# 背景音波柱：來源圖的招牌元素，用固定的高度表重現，
# 每次產生的結果才會一樣（用亂數的話每跑一次背景都不同）
$heights = @(0.22,0.38,0.55,0.34,0.68,0.45,0.28,0.52,0.76,0.41,0.30,0.60,0.85,0.48,0.26,0.44,
             0.62,0.36,0.24,0.50,0.72,0.40,0.29,0.56,0.80,0.46,0.32,0.58,0.66,0.38,0.25,0.47,
             0.70,0.42,0.27,0.53,0.88,0.44,0.31,0.59,0.64,0.35,0.23,0.49,0.74,0.43,0.33,0.57)
$barBrush = New-Object System.Drawing.SolidBrush((ARGB 46 96 170 235))
$barW = 7.0
$gap = 18.0
$i = 0
for ($bx = 12.0; $bx -lt $W; $bx += $gap) {
    $hh = $heights[$i % $heights.Length] * $H * 0.82
    $by = ($H - $hh) / 2
    $bp = New-RoundedPath $bx $by $barW $hh ($barW / 2)
    $g.FillPath($barBrush, $bp)
    $i++
}

# 幾顆音符，稀疏地散在背景，跟來源圖呼應
$noteFont = New-Object System.Drawing.Font("Segoe UI Symbol", 34, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$noteBrush = New-Object System.Drawing.SolidBrush((ARGB 60 120 190 245))
foreach ($n in @(@(60,80,"♪"), @(150,520,"♫"), @(620,120,"♪"), @(660,470,"♫"), @(1140,540,"♪"))) {
    $g.DrawString($n[2], $noteFont, $noteBrush, [float]$n[0], [float]$n[1])
}

# ---- 右側：來源圖中間那顆圓形插畫（不含文字）----
$dSize = 430.0
$dx = 700.0
$dy = ($H - $dSize) / 2

# 外圈光暈
$halo = New-Object System.Drawing.Drawing2D.GraphicsPath
$halo.AddEllipse($dx - 34, $dy - 34, $dSize + 68, $dSize + 68)
$haloBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($halo)
$haloBrush.CenterColor = (ARGB 90 46 227 220)
$haloBrush.SurroundColors = @((ARGB 0 3 25 62))
$g.FillPath($haloBrush, $halo)

# 只取圓形內部：裁切成圓再把來源的對應區域畫進來
$clip = New-Object System.Drawing.Drawing2D.GraphicsPath
$clip.AddEllipse($dx, $dy, $dSize, $dSize)
$g.SetClip($clip)
# 這裡一定要 RectangleF 對 RectangleF 的多載。混用浮點與整數參數的話，
# PowerShell 會挑到整數版的多載然後轉型失敗，圓形就整個沒畫上去。
$destRect = New-Object System.Drawing.RectangleF($dx, $dy, $dSize, $dSize)
$srcRect = New-Object System.Drawing.RectangleF(
    ($CIRCLE_CX - $CIRCLE_RADIUS), ($CIRCLE_CY - $CIRCLE_RADIUS),
    ($CIRCLE_RADIUS * 2), ($CIRCLE_RADIUS * 2))
$g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.ResetClip()

# 圓框
$ringPen = New-Object System.Drawing.Pen((ARGB 150 46 227 220), 4.0)
$g.DrawEllipse($ringPen, $dx, $dy, $dSize, $dSize)

# ---- 左側文字 ----
$titleFont = New-Object System.Drawing.Font("Microsoft JhengHei", 78, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("音隙偵探", $titleFont, (New-Object System.Drawing.SolidBrush($WHITE)), 82, 178)

# 英文名拉開字距當副標
$enFont = New-Object System.Drawing.Font("Segoe UI", 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$enBrush = New-Object System.Drawing.SolidBrush((ARGB 210 46 227 220))
$ex = 88.0
foreach ($ch in "EARSLEUTH".ToCharArray()) {
    $g.DrawString([string]$ch, $enFont, $enBrush, $ex, 286)
    $ex += $g.MeasureString([string]$ch, $enFont).Width - 8 + 8
}

# 膠囊標籤
$pillFont = New-Object System.Drawing.Font("Microsoft JhengHei", 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$pillText = New-Object System.Drawing.SolidBrush((RGB 225 245 250))
$pillFill = New-Object System.Drawing.SolidBrush((ARGB 34 46 227 220))
$pillPen = New-Object System.Drawing.Pen((ARGB 110 46 227 220), 1.6)
$px = 82.0
foreach ($t in @("全場即時競速", "線上排行榜")) {
    $tw = $g.MeasureString($t, $pillFont).Width
    $pw = $tw + 38
    $ph = 48.0
    $pp = New-RoundedPath $px 366 $pw $ph ($ph / 2)
    $g.FillPath($pillFill, $pp)
    $g.DrawPath($pillPen, $pp)
    $g.DrawString($t, $pillFont, $pillText, $px + 19, 378)
    $px += $pw + 15
}

# 底部說明
$footFont = New-Object System.Drawing.Font("Microsoft JhengHei", 21, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$footBrush = New-Object System.Drawing.SolidBrush((ARGB 165 150 200 235))
$g.DrawString("70~90 年代懷舊金曲　·　2000 年後千禧新聲", $footFont, $footBrush, 85, 470)

$ogOut = Join-Path $ProjectDir "og-image.png"
$c.Bitmap.Save($ogOut, [System.Drawing.Imaging.ImageFormat]::Png)
$c.Graphics.Dispose(); $c.Bitmap.Dispose()
Write-Output ("  og-image.png  {0}x{1}  {2:N0} bytes" -f $W, $H, (Get-Item $ogOut).Length)

$src.Dispose()
Write-Output "完成"
