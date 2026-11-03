@echo off
title BetaDropChat Launcher
cd /d "%~dp0"

echo ======================================================
echo   BetaDropChat v2.1 - Launcher (Exact Model Routing)
echo ======================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [Error] Node.js is not found. Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Select AI Provider:
echo 1 - Google Gemini Pro (Google One AI Premium)
echo 2 - DeepSeek Web (V3 / R1)
set /p prov="Your choice [Enter = 1]: "

set ACTIVE_PROVIDER=gemini
if "%prov%"=="2" set ACTIVE_PROVIDER=deepseek

node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('settings.json'));s.primary_provider=process.argv[1];fs.writeFileSync('settings.json',JSON.stringify(s,null,2));" %ACTIVE_PROVIDER%

if "%ACTIVE_PROVIDER%"=="gemini" goto setup_gemini
if "%ACTIVE_PROVIDER%"=="deepseek" goto setup_deepseek

:setup_gemini
if not exist "%~dp0.gemini\gemini-auth.json" (
    echo [Info] Google Gemini auth required...
    node scripts\gemini_chrome_auth.js
)
if not exist "%~dp0.gemini\gemini-auth.json" (
    echo [Error] Gemini auth not found. Run: node scripts\auth.js
    pause
    exit /b 1
)
echo.
echo ======================================================
echo   Select Google Gemini Model:
echo ======================================================
echo 1 - gemini-4-argon        (4 Argon - Latest, Complex Tasks)
echo 2 - gemini-3.1-pro        (3.1 Pro - Advanced Reasoning)
echo 3 - gemini-3.8-flash      (3.8 Flash - General / All-around)
echo 4 - gemini-3.5-flash-lite (3.5 Flash-Lite - Fastest)
echo 5 - Auto (Switch via Claude Desktop dropdown: Fable=4 Argon, Sonnet=3.1 Pro, Haiku=3.8 Flash)
set /p gm_choice="Your choice [Enter = 1]: "

set SELECTED_MODEL=gemini-4-argon
set GEMINI_FORCE_MODEL=gemini-4-argon
if "%gm_choice%"=="2" (
    set SELECTED_MODEL=gemini-3.1-pro
    set GEMINI_FORCE_MODEL=gemini-3.1-pro
)
if "%gm_choice%"=="3" (
    set SELECTED_MODEL=gemini-3.8-flash
    set GEMINI_FORCE_MODEL=gemini-3.8-flash
)
if "%gm_choice%"=="4" (
    set SELECTED_MODEL=gemini-3.5-flash-lite
    set GEMINI_FORCE_MODEL=gemini-3.5-flash-lite
)
if "%gm_choice%"=="5" (
    set SELECTED_MODEL=gemini-4-argon
    set GEMINI_FORCE_MODEL=
)

echo [Launcher] Selected model: %SELECTED_MODEL% (Force lock: %GEMINI_FORCE_MODEL%)
goto start_server

:setup_deepseek
if not exist "%~dp0.deepseek\deepseek-auth.json" (
    echo [Info] DeepSeek auth required...
    node scripts\deepseek_chrome_auth.js
)
if not exist "%~dp0.deepseek\deepseek-auth.json" (
    echo [Error] DeepSeek auth not found.
    pause
    exit /b 1
)
echo.
echo ======================================================
echo   Select DeepSeek Model:
echo ======================================================
echo 1 - deepseek-flash    (DeepSeek-V4.1-Flash - Fast, Coding, Agentic, Vision)
echo 2 - deepseek-v4-pro   (DeepSeek-V4-Pro - Flagship 1.6T, Deep Reasoning, No Vision)
echo 3 - deepseek-reasoner (Flash with Reasoning / R1 mode)
set /p ds_choice="Your choice [Enter = 1]: "
set SELECTED_MODEL=deepseek-flash
if "%ds_choice%"=="2" set SELECTED_MODEL=deepseek-v4-pro
if "%ds_choice%"=="3" set SELECTED_MODEL=deepseek-reasoner
echo [Launcher] Selected model: %SELECTED_MODEL%
goto start_server

:start_server
echo.
echo [Launcher] Clearing port 9655...
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 9655 -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" >nul 2>&1

echo [Launcher] Starting BetaDropChat Gateway on port 9655...
set SKIP_ACCOUNT_MENU=1
set ACTIVE_PROVIDER=%ACTIVE_PROVIDER%
start "BetaDropChat Gateway" cmd /k "node server.js"

timeout /t 3 /nobreak >nul

set ANTHROPIC_BASE_URL=http://127.0.0.1:9655
set ANTHROPIC_API_KEY=sk-ant-api03-betadrop-chat-key-7777777777777777777777777777777777777777777777777777777777777777777777
set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

where claude >nul 2>nul
if %errorlevel% neq 0 (
    echo ======================================================
    echo   SERVER RUNNING ON http://127.0.0.1:9655 !
    echo   Active Model: %SELECTED_MODEL%
    echo ======================================================
    echo 1. In Claude Desktop: Fable/Opus = 4 Argon, Sonnet = 3.1 Pro, Haiku = 3.8 Flash
    echo 2. Or switch models right in chat: /gemini model argon ^| pro ^| flash ^| lite ^| auto
    echo.
    pause
    exit /b 0
)

echo [Launcher] Launching Claude Code with %SELECTED_MODEL%...
call claude --model %SELECTED_MODEL%
pause
