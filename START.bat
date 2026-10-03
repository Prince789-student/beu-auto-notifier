@echo off
title BEU Auto Notifier
color 0A
echo.
echo  =============================================
echo   BEU Auto Notifier — WhatsApp Auto System
echo  =============================================
echo.

cd /d "%~dp0"

echo [1/2] Packages check kar raha hai...
call npm install --silent 2>nul
if %errorlevel% neq 0 (
    echo  ERROR: npm install fail hua!
    pause
    exit /b
)

echo [2/2] Server shuru ho raha hai...
echo.
echo  Dashboard: http://localhost:3001
echo  Press Ctrl+C to stop
echo.
node server.js
pause
