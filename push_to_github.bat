@echo off
title Push SachCast to GitHub
cd /d "%~dp0"
echo ========================================================
echo   Pushing SachCast to https://github.com/sachinpatilx25/sachcast.git
echo ========================================================
echo.
"C:\Users\sachi\MinGit\cmd\git.exe" push -u origin main
echo.
pause
