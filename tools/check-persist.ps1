# Score draft persistence check.
#
# Why a separate script: the draft save/load path caused repeated bugs where
# the stored score came back with all notes crammed into one measure. Unit
# tests could not catch it because the library round-trip was always fine --
# the corruption happened before saving. So this test does what a human does:
# build a score, close the browser, open it again, and compare.
#
# Two separate Chrome launches share one --user-data-dir, so localStorage
# really does survive across processes. The profile lives in TEMP, never in
# the project: Vite watches the project tree and a Chrome profile inside it
# makes the watcher die with EBUSY.
#
# Usage:  powershell -File tools/check-persist.ps1

param(
  [string]$Url = 'https://localhost:5173',
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { Write-Output "chrome not found"; exit 2 }

$prof = Join-Path $env:TEMP 'beatlooker-persist-prof'
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue

function Invoke-Phase([string]$query) {
  $dump = Join-Path $env:TEMP ("bl_persist_" + $query + ".txt")
  $html = ''
  for ($i = 1; $i -le 5; $i++) {
    Remove-Item -Force $dump -ErrorAction SilentlyContinue
    Start-Process -FilePath $chrome -Wait -RedirectStandardOutput $dump -ArgumentList @(
      '--headless=new', '--disable-gpu', '--ignore-certificate-errors',
      '--virtual-time-budget=30000', "--user-data-dir=$prof",
      '--dump-dom', "$Url/?persist=$query"
    )
    if (Test-Path $dump) { $html = [System.IO.File]::ReadAllText($dump, [System.Text.Encoding]::UTF8) }
    if ($html -match '<title>PERSIST') { break }
    Start-Sleep -Milliseconds 900
  }
  Remove-Item -Force $dump -ErrorAction SilentlyContinue
  if ($html -match '<title>([^<]*)</title>') { return $Matches[1] }
  return ''
}

Write-Output 'phase 1: build a score and let the debounced save land'
$w = Invoke-Phase 'write'
Write-Output ("  " + $w)
Start-Sleep -Milliseconds 1500
Write-Output 'phase 2: fresh page load, same profile'
$r = Invoke-Phase 'read'
Write-Output ("  " + $r)
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Compare the bar counts reported by both phases.
$wBars = ''
$rBars = ''
if ($w -match 'BARS=([0-9/]+)') { $wBars = $Matches[1] }
if ($r -match 'BARS=([0-9/]+)') { $rBars = $Matches[1] }
if ($wBars -eq '' -or $rBars -eq '') { Write-Output 'FAIL: could not read bar counts'; exit 1 }
if ($wBars -ne $rBars) {
  Write-Output ("FAIL: saved '" + $wBars + "' but restored '" + $rBars + "'")
  exit 1
}
if ($r -match 'WARN=([1-9])') { Write-Output 'FAIL: restore reported warnings'; exit 1 }

# The capo is a user setting and must survive too: it feeds the pitch analysis.
$wCapo = ''
$rCapo = ''
if ($w -match 'CAPO=([0-9]+)') { $wCapo = $Matches[1] }
if ($r -match 'CAPO=([0-9]+)') { $rCapo = $Matches[1] }
if ($wCapo -eq '' -or $rCapo -eq '') { Write-Output 'FAIL: could not read capo'; exit 1 }
if ($wCapo -ne $rCapo) {
  Write-Output ("FAIL: saved capo " + $wCapo + " but restored " + $rCapo)
  exit 1
}
if ($wCapo -eq '0') { Write-Output 'FAIL: test did not actually set a capo'; exit 1 }

Write-Output ("PASS: " + $wBars + " and capo " + $wCapo + " survived a real reload")
exit 0
