@echo off
title AirCast Wireless Screen Broadcast
cd /d "%~dp0"
echo ========================================================
echo   Starting AirCast Wireless Screen Broadcast Server...
echo ========================================================
node server.js
pause
