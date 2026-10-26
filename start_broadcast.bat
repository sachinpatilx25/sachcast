@echo off
title SachCast - Wireless Screen Broadcaster
cd /d "%~dp0"
echo =================================================================
echo   Starting SachCast Screen Broadcaster (Dual Port 80 & 3000)...
echo   Maximum 4K UHD 60FPS Quality Locked - Real-Time ~10ms Latency
echo =================================================================
echo.
if not exist "node_modules\ws" (
  echo [+] First-time setup: Installing fast WebSocket dependency...
  cmd /c npm install --no-fund --no-audit
)
start "" "http://localhost:3000"
node server.js
pause
