@echo off
title Enable Auto-Start on Windows Boot
color 0A
echo.
echo  ======================================================
echo    BEU Auto Notifier — Windows Auto-Start Setup
echo  ======================================================
echo.

cd /d "%~dp0"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%~dp0START_BACKGROUND.bat"
set "STARTUP_SCRIPT=%STARTUP_FOLDER%\BEU_Auto_Notifier.bat"

(
  echo @echo off
  echo cd /d "%~dp0"
  echo start "" "%TARGET_BAT%"
) > "%STARTUP_SCRIPT%"

echo  [SUCCESS] Auto-start successfully enable ho gaya hai!
echo  Ab jab bhi aapka computer on hoga, BEU Auto Notifier
echo  background me automatically shuru ho jayega.
echo.
echo  Startup Script Location:
echo  %STARTUP_SCRIPT%
echo.
pause
