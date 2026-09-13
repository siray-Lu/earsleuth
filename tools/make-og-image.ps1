# 產生 og-image.png（1200x630，分享到 LINE / FB / Threads 時的預覽圖）
# 用 .NET 的 System.Drawing 畫，Windows 內建，不需要安裝任何東西。

Add-Type -AssemblyName System.Drawing

$W = 1200
$H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

function RGB($r, $gg, $b) { [System.Drawing.Color]::FromArgb(255, $r, $gg, $b) }
function ARGB($a, $r, $gg, $b) { [System.Drawing.Color]::FromArgb($a, $r, $gg, $b) }

# ---------- 背景：左上偏紫、往右下沉成近黑，跟遊戲裡的底色同一套 ----------
$bgRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($W, $H)),
    (RGB 52 27 82), (RGB 13 8 24))
$g.FillRectangle($bgBrush, $bgRect)

# 左上角再疊一層柔光，避免整片死板
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-260, -320, 1000, 900)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glow.CenterColor = (ARGB 80 120 60 170)
$glow.SurroundColors = @((ARGB 0 52 27 82))
$g.FillPath($glow, $glowPath)

# ---------- 右側：黑膠唱片 ----------
$cx = 915.0
$cy = 300.0
# 注意：PowerShell 變數不分大小寫，半徑不能叫 $R —— 會跟迴圈變數 $r 撞成同一個
$discR = 193.0

# 外緣淡光暈
$halo = New-Object System.Drawing.Drawing2D.GraphicsPath
$halo.AddEllipse($cx - $discR - 40, $cy - $discR - 40, ($discR + 40) * 2, ($discR + 40) * 2)
$haloBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($halo)
$haloBrush.CenterColor = (ARGB 70 255 95 162)
$haloBrush.SurroundColors = @((ARGB 0 13 8 24))
$g.FillPath($haloBrush, $halo)

# 盤面
$disc = New-Object System.Drawing.Drawing2D.GraphicsPath
$disc.AddEllipse($cx - $discR, $cy - $discR, $discR * 2, $discR * 2)
$discBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($disc)
$discBrush.CenterColor = (RGB 46 42 58)
$discBrush.SurroundColors = @((RGB 18 16 24))
$g.FillPath($discBrush, $disc)

# 溝紋
$groove = New-Object System.Drawing.Pen((ARGB 80 255 255 255), 1.4)
for ($gr = 68.0; $gr -lt $discR - 8; $gr += 9.5) {
    $g.DrawEllipse($groove, $cx - $gr, $cy - $gr, $gr * 2, $gr * 2)
}

# 中央標籤
$labelR = 56.0
$labelBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point([int]($cx - $labelR), [int]($cy - $labelR))),
    (New-Object System.Drawing.Point([int]($cx + $labelR), [int]($cy + $labelR))),
    (RGB 255 95 162), (RGB 255 140 190))
$g.FillEllipse($labelBrush, $cx - $labelR, $cy - $labelR, $labelR * 2, $labelR * 2)
$g.FillEllipse((New-Object System.Drawing.SolidBrush((RGB 13 8 24))), $cx - 7, $cy - 7, 14, 14)

# ---------- 放大鏡：壓在唱片右下，偵探的視覺主體 ----------
$mx = 1002.0
$my = 425.0
$mr = 86.0

# 鏡片裡的淡藍玻璃
$lens = New-Object System.Drawing.Drawing2D.GraphicsPath
$lens.AddEllipse($mx - $mr, $my - $mr, $mr * 2, $mr * 2)
$lensBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($lens)
$lensBrush.CenterColor = (ARGB 45 95 208 255)
$lensBrush.SurroundColors = @((ARGB 110 95 208 255))
$g.FillPath($lensBrush, $lens)

# 握把（先畫，才會被鏡框蓋住接縫）
$handlePen = New-Object System.Drawing.Pen((RGB 95 208 255), 26.0)
$handlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$handlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($handlePen, ($mx + 58), ($my + 58), ($mx + 112), ($my + 112))

# 鏡框
$ringPen = New-Object System.Drawing.Pen((RGB 95 208 255), 15.0)
$g.DrawEllipse($ringPen, $mx - $mr, $my - $mr, $mr * 2, $mr * 2)

# 鏡片高光
$shinePen = New-Object System.Drawing.Pen((ARGB 120 255 255 255), 7.0)
$shinePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$shinePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($shinePen, $mx - $mr + 26, $my - $mr + 26, ($mr - 26) * 2, ($mr - 26) * 2, 200, 55)

# ---------- 左側文字 ----------
$titleFont = New-Object System.Drawing.Font("Microsoft JhengHei", 74, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(85, 0)),
    (New-Object System.Drawing.Point(400, 0)),
    (RGB 255 95 162), (RGB 95 208 255))
$g.DrawString("音隙偵探", $titleFont, $titleBrush, 85, 150)

# 英文名走全大寫、字距拉開，當作副標而不是搶戲的主角
$enFont = New-Object System.Drawing.Font("Segoe UI", 25, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$enBrush = New-Object System.Drawing.SolidBrush((ARGB 190 168 157 196))
$x = 90.0
foreach ($ch in "EARSLEUTH".ToCharArray()) {
    $g.DrawString([string]$ch, $enFont, $enBrush, $x, 253)
    $x += $g.MeasureString([string]$ch, $enFont).Width - 8 + 7
}

$subFont = New-Object System.Drawing.Font("Microsoft JhengHei", 31, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush((RGB 244 241 251))
$g.DrawString("聽一小段，猜猜這是哪首歌", $subFont, $subBrush, 85, 310)

# ---------- 膠囊標籤 ----------
$pillFont = New-Object System.Drawing.Font("Microsoft JhengHei", 21, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$pillText = New-Object System.Drawing.SolidBrush((RGB 226 220 240))
$pillFill = New-Object System.Drawing.SolidBrush((ARGB 30 255 255 255))
$pillPen = New-Object System.Drawing.Pen((ARGB 55 255 255 255), 1.5)

$px = 85.0
$py = 395.0
foreach ($t in @("699 首華語金曲", "全場即時競速", "線上排行榜")) {
    $tw = $g.MeasureString($t, $pillFont).Width
    $pw = $tw + 36
    $ph = 46.0
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($px, $py, $ph, $ph, 90, 180)
    $path.AddArc($px + $pw - $ph, $py, $ph, $ph, 270, 180)
    $path.CloseFigure()
    $g.FillPath($pillFill, $path)
    $g.DrawPath($pillPen, $path)
    $g.DrawString($t, $pillFont, $pillText, $px + 18, $py + 11)
    $px += $pw + 14
}

# ---------- 底部說明 ----------
$footFont = New-Object System.Drawing.Font("Microsoft JhengHei", 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$footBrush = New-Object System.Drawing.SolidBrush((ARGB 150 168 157 196))
$g.DrawString("70~90 年代懷舊金曲　·　2000 年後千禧新聲", $footFont, $footBrush, 88, 495)

# ---------- 輸出 ----------
$out = "C:\Users\Siray\Claude 程式\猜歌遊戲_副本\og-image.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

$size = (Get-Item $out).Length
Write-Output "已產生 $out"
Write-Output ("尺寸 {0}x{1}，檔案大小 {2:N0} bytes" -f $W, $H, $size)
