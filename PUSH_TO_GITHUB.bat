@echo off
title Push Changes to GitHub (main)
color 0A
echo.
echo ====================================================
echo   Pushing All Changes to GitHub (main)
echo ====================================================
echo.

echo [1/2] Pushing 'auto notification' (beu-auto-notifier)...
cd /d "%~dp0"
git push origin main

echo.
echo [2/2] Pushing 'Apna College Bihar'...
cd /d "%~dp0\..\Apna College Bihar"
git push origin main

echo.
echo ====================================================
echo   SUCCESS! Dono repositories GitHub main pe push ho gayi!
echo ====================================================
echo.
pause
