@echo off
title BEU Auto Notifier — WhatsApp Auto System
color 0A
echo.
echo  =============================================
echo   BEU Auto Notifier — WhatsApp Auto System
echo  =============================================
echo.

cd /d "%~dp0"

:: Check if port 3001 is already running
netstat -ano | findstr :3001 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo  [INFO] Server pehle se port 3001 par chal raha hai!
    echo  Dashboard browser me khul raha hai...
    start http://localhost:3001
    pause
    exit /b
)

echo [1/2] Checking dependencies...
if not exist "node_modules\@whiskeysockets\baileys" (
    echo Packages install ho rahe hain, kripya intezar karein...
    call npm install --silent
)

echo [2/2] Server shuru ho raha hai...
echo.
echo  Dashboard: http://localhost:3001
echo  Tip: Scanner change/reset ke liye 'RESET_SCANNER.bat' use karein
echo  Tip: Server stop karne ke liye 'STOP.bat' use karein ya Ctrl+C dabayein
echo.

:: Open browser after 2 seconds in background
start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process http://localhost:3001"

node server.js
pause
