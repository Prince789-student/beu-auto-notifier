@echo off
title WhatsApp Cloud Session Exporter
color 0B
echo.
echo  ======================================================
echo    BEU Auto Notifier — Cloud Session Exporter
echo    Laptop band hone par bhi 24/7 Cloud pe chalane ke liye
echo  ======================================================
echo.

cd /d "%~dp0"

if not exist "auth_info\creds.json" (
    color 0C
    echo  [ERROR] WhatsApp credentials nahi mile!
    echo  Pehle WhatsApp scanner scan karein fir dubara run karein.
    pause
    exit /b
)

echo  Reading credentials and generating CREDS_BASE64...
powershell -NoProfile -Command ^
    "$bytes = [System.IO.File]::ReadAllBytes('auth_info\creds.json'); " ^
    "$b64 = [Convert]::ToBase64String($bytes); " ^
    "Set-Clipboard -Value $b64; " ^
    "Write-Host ''; " ^
    "Write-Host '  [SUCCESS] Aapka WhatsApp Session Token CLIPBOARD ME COPY HO GAYA HAI!' -ForegroundColor Green; " ^
    "Write-Host ''; " ^
    "Write-Host '  Render.com ya Railway pe 24/7 Cloud Setup: ' -ForegroundColor Yellow; " ^
    "Write-Host '  1. Render.com par New Web Service banayein (beu-auto-notifier repo)' -ForegroundColor White; " ^
    "Write-Host '  2. Environment Variables me add karein:' -ForegroundColor White; " ^
    "Write-Host '     Key   : CREDS_BASE64' -ForegroundColor Cyan; " ^
    "Write-Host '     Value : (Paste karein - Ctrl+V)' -ForegroundColor Cyan; " ^
    "Write-Host ''; " ^
    "Write-Host '  Bas! Deploy hote hi WhatsApp cloud me bina QR scan ke 24/7 active ho jayega!' -ForegroundColor Green; "

echo.
pause
