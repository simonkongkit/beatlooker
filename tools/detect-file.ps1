# Run the full detection pipeline against a real recording, using headless Chrome.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\detect-file.ps1 samples\test.webm
#         powershell -NoProfile -ExecutionPolicy Bypass -File tools\detect-file.ps1 samples\test.webm "q|qqqq|hqee"
#
# It goes through the app's OWN analyseAudioBuffer -> detectOnsetsWithNotes -> matchTempo,
# not a parallel reimplementation, so what shows up here is what the user sees in the browser.
#
# NOTE 1: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
#         which shreds non-ASCII comments and can even swallow newlines, breaking param().
# NOTE 2: headless Chrome's decodeAudioData is FLAKY - it sometimes never resolves, and the
#         page just stops after printing the file size. That is a Chrome audio-service issue,
#         not our code (a minimal fetch+decode probe hangs the same way). So we retry.
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Bars = 'q|qqqq|hqee',
  [string]$Base = 'https://localhost:5173',
  [int]$Attempts = 4
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$full = Join-Path $root $File
if (-not (Test-Path $full)) { Write-Output "file not found: $full"; exit 1 }

$rel = $File -replace '\\', '/'
$rel = ($rel -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'

$cands = @()
if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
$chrome = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Output 'chrome.exe not found'; exit 1 }

$url = "$Base/tools/detect-file.html?file=/$rel&bars=" + [uri]::EscapeDataString($Bars)
$html = ''
$done = $false

for ($i = 1; $i -le $Attempts -and -not $done; $i++) {
  $dump = Join-Path $env:TEMP ('bl-detect-' + [guid]::NewGuid().ToString('N') + '.txt')
  Start-Process -FilePath $chrome -Wait -RedirectStandardOutput $dump -ArgumentList @(
    '--headless=new', '--disable-gpu', '--ignore-certificate-errors',
    '--virtual-time-budget=120000', '--dump-dom', $url
  )
  $html = [System.IO.File]::ReadAllText($dump, [System.Text.Encoding]::UTF8)
  Remove-Item -Force $dump -ErrorAction SilentlyContinue
  # The page sets this title only after everything finished.
  $done = $html -match 'ready::'
  if (-not $done -and $i -lt $Attempts) {
    # NOTE: must be ${i}, not $i - PowerShell reads "$i:" as a variable in the "i:" scope/drive
    Write-Output "(attempt ${i}: page did not finish - headless decode likely hung, retrying)"
    Start-Sleep -Milliseconds 800
  }
}

if ($html -match '<title>([^<]*)</title>') { Write-Output ("title: " + $Matches[1]) }
if ($html -match '(?s)<pre id="out"[^>]*>(.*?)</pre>') {
  $body = $Matches[1] -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>'
  $body -split "`n" | ForEach-Object { $_ }
} else {
  Write-Output '(no output captured - the page may not have run)'
}
