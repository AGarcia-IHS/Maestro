@echo off
rem Double-click to start Maestro and open it in your browser.
rem Keep this window open while you use the app; close it to stop Maestro.
title Maestro
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem If Maestro is already running, just open the browser.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1', 4173)).Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" http://localhost:4173
  exit /b 0
)

echo Starting Maestro at http://localhost:4173
echo Keep this window open while you use the app. Close it to stop Maestro.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4173'"
node --disable-warning=ExperimentalWarning server.js
pause
