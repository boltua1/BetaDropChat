@echo off
title BetaDropChat Gateway Server
cd /d "%~dp0"

echo ======================================================
echo   BetaDropChat Gateway Server (127.0.0.1:9655)
echo ======================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] Node.js is not found. Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [1/2] Clearing port 9655...
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 9655 -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" >nul 2>&1

echo [2/2] Starting server...
echo [Info] Server is running on http://127.0.0.1:9655
echo [Info] Click 'Test connection' in Claude Desktop
echo ------------------------------------------------------
node server.js
pause
