@echo off
title Reset WhatsApp Scanner - BEU Auto Notifier
color 0E
echo.
echo  ====================================================
echo    BEU Auto Notifier - WhatsApp Scanner Reset
echo    Purana session delete karke naya QR generate karein
echo  ====================================================
echo.

cd /d "%~dp0"

echo [1/3] Checking auth_info folder...
if exist "auth_info" (
    rmdir /s /q "auth_info"
    echo      [OK] auth_info folder successfully deleted!
) else (
    echo      [INFO] auth_info pehle se empty hai.
)

echo [2/3] Checking old .wpp_session cache...
if exist ".wpp_session" (
    rmdir /s /q ".wpp_session"
    echo      [OK] .wpp_session folder successfully deleted!
) else (
    echo      [INFO] .wpp_session nahi mila.
)

echo [3/3] Checking old .wwebjs_cache...
if exist ".wwebjs_cache" (
    rmdir /s /q ".wwebjs_cache"
    echo      [OK] .wwebjs_cache folder successfully deleted!
) else (
    echo      [INFO] .wwebjs_cache nahi mila.
)

echo.
echo  ====================================================
echo    SUCCESS: Session clear ho gaya hai!
echo    Ab 'START.bat' chalaayein aur naya QR code scan karein:
echo    1. Browser me open karein: http://localhost:3001
echo    2. Ya terminal me direct QR code scan karein
echo  ====================================================
echo.
pause
