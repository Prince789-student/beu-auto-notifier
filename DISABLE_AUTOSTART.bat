@echo off
title Disable Auto-Start
color 0C
echo.
echo  ======================================================
echo    BEU Auto Notifier — Disable Auto-Start
echo  ======================================================
echo.

set "STARTUP_SCRIPT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\BEU_Auto_Notifier.bat"

if exist "%STARTUP_SCRIPT%" (
    del /f /q "%STARTUP_SCRIPT%"
    echo  [SUCCESS] Auto-start disable ho gaya hai!
) else (
    echo  [INFO] Auto-start pehle se disabled tha.
)
echo.
pause
