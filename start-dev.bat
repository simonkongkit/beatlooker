@echo off
setlocal
cd /d "%~dp0"

rem ===========================================================
rem  BeatLooker - quick start
rem
rem    start-dev.bat        LAN mode: https + all network interfaces,
rem                         so phones on the same Wi-Fi can open it
rem    start-dev.bat local  this computer only: plain http, and no
rem                         self-signed certificate warning
rem
rem  ASCII only on purpose: Chinese text in a .bat gets mis-parsed
rem  by cmd.exe when the console codepage is 936. The file must also
rem  keep CRLF line endings - LF-only makes cmd lose sync.
rem ===========================================================

if not defined PORT set "PORT=5173"
if not defined MAXWAIT set "MAXWAIT=60"

rem  默认就是 LAN 模式 —— 双击这个文件也能让手机访问。
rem  只想在电脑上用（不要证书警告）就加 local 参数：
rem      start-dev.bat local
set "LAN=1"
if /i "%~1"=="local" set "LAN=0"
if /i "%~1"=="lan" set "LAN=1"
if "%LAN%"=="1" (
  set "DEVSCRIPT=dev:lan"
  set "SCHEME=https"
  set "CURLOPT=-k"
) else (
  set "DEVSCRIPT=dev"
  set "SCHEME=http"
  set "CURLOPT="
)
set "URL=%SCHEME%://localhost:%PORT%/"

rem ---------- 找出手机能访问的局域网 IP（只有 lan 模式需要）----------
rem  优先 192.168.x -> 10.x -> 172.16-31.x -> 其它：开着 VPN 时
rem  Get-NetIPAddress 会多出虚拟网卡的地址，手机连不上那些，所以要排序。
rem  用 goto 跳过而不是 if 块，避免 %LANIP% 在块里被提前展开的坑。
set "LANIP="
set "LANIPS="
set "LANALSO="
set "LANURL="
if not "%LAN%"=="1" goto :skip_lan_ip

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress -Unique; $ranked = $ips | Sort-Object { if ($_ -like '192.168.*') { 0 } elseif ($_ -like '10.*') { 1 } elseif ($_ -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { 2 } else { 3 } }; ($ranked -join ' ')"`) do set "LANIPS=%%i"

if defined LANIPS for /f "tokens=1,* delims= " %%a in ("%LANIPS%") do (
  set "LANIP=%%a"
  set "LANALSO=%%b"
)
if defined LANIP set "LANURL=https://%LANIP%:%PORT%/"

:skip_lan_ip

echo.
echo   BeatLooker  -  quick start
if "%LAN%"=="1" echo   mode: LAN - https, reachable from phones on the same Wi-Fi
if "%LAN%"=="0" echo   mode: local only - http, no certificate needed
echo   ------------------------------------------------
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found in PATH.
  echo           Install it from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)
echo   [1/4] Node.js OK.

rem ---------- 2. dependencies ----------
if not exist "node_modules\" (
  echo   [2/4] Installing dependencies ^(first run only, takes about a minute^) ...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [ERROR] npm install failed - see the messages above.
    echo.
    pause
    exit /b 1
  )
) else (
  echo   [2/4] Dependencies OK.
)

set "HAVE_CURL=1"
where curl >nul 2>nul
if errorlevel 1 set "HAVE_CURL=0"

rem ---------- 3. already running? ----------
call :probe
if not errorlevel 1 (
  echo   [3/4] Dev server is already running on port %PORT%.
  goto open
)

echo   [3/4] Starting dev server in a new window ...
start "BeatLooker dev server" cmd /k "npm run %DEVSCRIPT% -- --port %PORT% --strictPort"

rem ---------- 4. wait until it answers ----------
if "%HAVE_CURL%"=="0" (
  echo   [4/4] curl.exe not found - waiting a fixed 8 seconds ...
  ping -n 9 127.0.0.1 >nul
  goto open
)

echo   [4/4] Waiting for %URL% ...
set /a tries=0
:wait
call :probe
if not errorlevel 1 goto open
set /a tries+=1
if %tries% geq %MAXWAIT% goto failed
ping -n 2 127.0.0.1 >nul
goto wait

:open
echo.
echo   Ready.
echo.
echo   ============================================================
if defined LANURL echo     Phone / LAN   :  %LANURL%
echo     This computer :  %URL%
if defined LANALSO for %%b in (%LANALSO%) do echo     Also try      :  https://%%b:%PORT%/
echo   ============================================================
echo.
if "%LAN%"=="1" (
  echo   On the phone: open the Phone / LAN address above. Same Wi-Fi required.
  echo   The certificate is self-signed - tap Advanced / Proceed to continue.
  echo   You MUST use https on the phone: plain http blocks the microphone.
)
if "%LAN%"=="0" echo   Want phone access too?  Just run start-dev.bat without the local argument.
echo.
echo   To stop: close the "BeatLooker dev server" window, or press Ctrl+C there.
echo.
start "" "%URL%"
exit /b 0

:failed
echo.
echo   [ERROR] No answer from %URL% within %MAXWAIT% seconds.
echo           Look at the "BeatLooker dev server" window for the reason.
echo           If port %PORT% is used by something else, pick another one:
echo               set PORT=5199
echo               start-dev.bat
echo.
pause
exit /b 1

rem ---------- helper: 0 when our dev server answers on %URL% ----------
:probe
if "%HAVE_CURL%"=="0" exit /b 1
curl %CURLOPT% -s --max-time 2 "%URL%" 2>nul | findstr /c:"BeatLooker" >nul 2>nul
exit /b %errorlevel%
