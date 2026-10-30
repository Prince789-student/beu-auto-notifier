@echo off
title Stop BEU Auto Notifier
color 0C
echo.
echo  =============================================
echo   Stopping BEU Auto Notifier...
echo  =============================================
echo.

cd /d "%~dp0"

set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
    set FOUND=1
)

if "%FOUND%"=="1" (
    echo  [OK] Server successfully band kar diya gaya hai!
) else (
    echo  [INFO] Port 3001 par koi server chalu nahi mila.
)

echo.
timeout /t 3 >nul

