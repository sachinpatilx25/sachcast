@echo off
title SachCast - Wireless Screen Broadcaster
cd /d "%~dp0"
echo =================================================================
echo   Starting SachCast Screen Broadcaster (Dual Port 80 & 3000)...
echo =================================================================
echo.
node server.js
pause
