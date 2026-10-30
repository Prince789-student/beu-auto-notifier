@echo off
title BEU Auto Notifier (Background Mode)
color 0B
echo.
echo  =============================================
echo   BEU Auto Notifier — Background Mode
echo  =============================================
echo.

cd /d "%~dp0"

:: Check if already running
netstat -ano | findstr :3001 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo  [INFO] Server pehle se background me chal raha hai!
    echo  Dashboard browser me khul raha hai...
    start http://localhost:3001
    timeout /t 3 >nul
    exit /b
)

echo  Starting background process...
wscript.exe run_hidden.vbs

echo  [OK] Server background me shuru ho gaya hai (No CMD window)!
echo  Dashboard: http://localhost:3001
echo  Ise band karne ke liye 'STOP.bat' double-click karein.
echo.

start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process http://localhost:3001"
timeout /t 4 >nul

