# =============================================================================
# run-bench.ps1 -- run the notation rendering benchmark in headless Chrome/Edge
#
# Usage (PowerShell blocks .ps1 by default, hence Bypass):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-bench.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-bench.ps1 -N 5000 -Scale 2
#
# Notes
#   * chrome.exe is a GUI-subsystem binary: calling it with `&` returns at once
#     and yields no stdout. Use Start-Process -Wait -RedirectStandardOutput.
#   * --force-device-scale-factor emulates a HiDPI/phone screen. Bitmap glyphs
#     then need a bigger atlas plus resampling -- the key variable for the
#     vector-vs-sprite comparison.
#   * Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1
#     files as ANSI and would mangle non-ASCII string literals.
# =============================================================================
param(
  [int]$N = 2000,
  [int]$Scale = 1,
  [double]$Size = 6,
  [int]$PerRow = 50,
  [string]$Vocab = 'mixed',
  [string]$Chrome = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'bench'

if (-not $Chrome) {
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  $Chrome = ($cands | Where-Object { Test-Path $_ } | Select-Object -First 1)
}
if (-not $Chrome) { throw 'Chrome/Edge not found; pass -Chrome <path>' }

$page = 'file:///' + ((Join-Path $dir 'bench.html') -replace '\\', '/') + "?n=$N&vocab=$Vocab&size=$Size&perRow=$PerRow"
$dump = Join-Path $dir "dump-dpr$Scale.html"
$errf = Join-Path $dir "chrome-err-dpr$Scale.txt"

Write-Host "browser : $Chrome"
Write-Host "page    : $page"

$chromeArgs = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--enable-precise-memory-info', "--force-device-scale-factor=$Scale",
  "--user-data-dir=$dir\.chrome-profile", '--dump-dom', $page
)
Start-Process -FilePath $Chrome -NoNewWindow -Wait `
  -ArgumentList $chromeArgs -RedirectStandardOutput $dump -RedirectStandardError $errf

$txt = Get-Content -LiteralPath $dump -Raw -Encoding UTF8
$m = [regex]::Match($txt, 'data-bench="([^"]*)"')
if (-not $m.Success) { throw "bench page produced no result; inspect $dump / $errf" }

$json = $m.Groups[1].Value.Replace('&quot;', '"').Replace('&amp;', '&').Replace('&lt;', '<').Replace('&gt;', '>')
$outFile = Join-Path $dir ("results-n{0}-s{1}-dpr{2}.json" -f $N, $Size, $Scale)
$json | Set-Content -LiteralPath $outFile -Encoding UTF8
Write-Host "saved   : $outFile`n"

$o = $json | ConvertFrom-Json
Write-Host ("N={0}  dpr={1}  layout={2}x{3}px  canvas={4} MP  atlas preraster={5} ms" -f `
  $o.n, $o.dpr, $o.layout.width, $o.layout.height, $o.canvasMP, $o.atlasMs)
Write-Host ("{0,-34}{1,10}{2,10}{3,10}{4,10}{5,9}{6,8}{7,11}{8,10}" -f 'renderer', 'build', 'buildHot', 'layout', 'raster', 'nodes', 'heapMB', 'redrawMs', 'redraw/s')
foreach ($pr in $o.results.PSObject.Properties) {
  $r = $pr.Value
  Write-Host ("{0,-34}{1,10}{2,10}{3,10}{4,10}{5,9}{6,8}{7,11}{8,10}" -f $r.label, $r.build, $r.buildHot, $r.layout, $r.raster, $r.nodes, $r.heapMB, $r.frameMs, $r.rps)
}
Write-Host "`nunicode glyph coverage (width equal to .notdef => missing):"
foreach ($pr in $o.unicodeCoverage.PSObject.Properties) {
  if ($pr.Name -eq 'fontUsed') { Write-Host ("  font-family = " + $pr.Value); continue }
  Write-Host ("  {0,-22} width={1,-8} hasGlyph={2}" -f $pr.Name, $pr.Value.w, $pr.Value.ok)
}
if ($o.errors.Count) { Write-Host "`npage errors: $($o.errors -join ' | ')" }

