@echo off
title SachCast - Screen Share with Friends
cd /d "%~dp0"
echo =================================================================
echo   Starting SachCast Screen Share (Dual Port 80 & 3000)...
echo   Smooth 60 FPS • Stereo Audio • Zero Lag
echo =================================================================
echo.
if not exist "node_modules\ws" (
  echo [+] First-time setup: Installing fast WebSocket dependency...
  cmd /c npm install --no-fund --no-audit
)
start "" "http://localhost:3000"
node server.js
pause
