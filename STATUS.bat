@echo off
title BEU Auto Notifier — System Status
color 0B
echo.
echo  ====================================================
echo    BEU Auto Notifier — System Live Status Check
echo  ====================================================
echo.

cd /d "%~dp0"

netstat -ano | findstr :3001 | findstr LISTENING >nul
if %errorlevel% neq 0 (
    color 0C
    echo  [STATUS] SERVER IS STOPPED (Port 3001 par koi server nahi chal raha)
    echo.
    echo  Shuru karne ke liye:
    echo    - Double-click 'START.bat' (Visible Window)
    echo    - Ya double-click 'START_BACKGROUND.bat' (Background Mode)
    echo.
    pause
    exit /b
)

echo  [STATUS] SERVER IS ONLINE (Port 3001 ACTIVE)
echo.
powershell -NoProfile -Command ^
    "$ErrorActionPreference = 'SilentlyContinue'; " ^
    "try { " ^
    "  $s = Invoke-RestMethod -Uri 'http://localhost:3001/api/status' -TimeoutSec 5; " ^
    "  Write-Host '  WhatsApp Status   : ' -NoNewline; " ^
    "  if ($s.waStatus -eq 'connected') { Write-Host 'CONNECTED (Logged In)' -ForegroundColor Green } " ^
    "  elseif ($s.waStatus -eq 'qr_ready') { Write-Host 'QR READY (Scan Required)' -ForegroundColor Yellow } " ^
    "  else { Write-Host ($s.waStatus.ToUpper()) -ForegroundColor Red }; " ^
    "  Write-Host '  Auto Dispatch     : ' -NoNewline; Write-Host ($s.autoDispatch) -ForegroundColor Cyan; " ^
    "  Write-Host '  Delivery Mode     : ' -NoNewline; Write-Host ($s.dispatchMode) -ForegroundColor Cyan; " ^
    "  Write-Host '  Channel JID       : ' -NoNewline; Write-Host ($s.channelId) -ForegroundColor Green; " ^
    "  Write-Host '  Total Notices     : ' -NoNewline; Write-Host ($s.totalNotices) -ForegroundColor White; " ^
    "  Write-Host '  Sent Today        : ' -NoNewline; Write-Host ($s.totalSentToday) -ForegroundColor Green; " ^
    "  Write-Host '  Last Scan Time    : ' -NoNewline; Write-Host ($s.lastCheckTime) -ForegroundColor Gray; " ^
    "} catch { " ^
    "  Write-Host '  [WARNING] API respond nahi kar rahi: ' $_.Exception.Message -ForegroundColor Red; " ^
    "}"

echo.
echo  ----------------------------------------------------
echo  [1] Open Dashboard in Browser (http://localhost:3001)
echo  [2] Trigger Manual Scan Now
echo  [3] Exit
echo  ----------------------------------------------------
set /p choice="Option select karein (1-3): "

if "%choice%"=="1" (
    start http://localhost:3001
    exit /b
)
if "%choice%"=="2" (
    echo.
    echo  Scanning BEU portal...
    powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method POST -Uri 'http://localhost:3001/api/sync' -TimeoutSec 30; Write-Host ('  Scan Result: ' + ($r | ConvertTo-Json -Compress)) -ForegroundColor Green } catch { Write-Host ('  Scan Error: ' + $_.Exception.Message) -ForegroundColor Red }"
    echo.
    pause
    exit /b
)
