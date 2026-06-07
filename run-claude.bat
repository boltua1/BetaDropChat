@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: ЗАПОМИНАЕМ ПУТИ
set PROXY_DIR=%~dp0
set PROJECT_DIR=%cd%

echo ======================================================
echo   BetaDropChat + Claude Code (Global Launcher)
echo ======================================================
echo [Launcher] Прокси: %PROXY_DIR%
echo [Launcher] Проект: %PROJECT_DIR%

:: Проверка node
where node >nul 2>nul
if %errorlevel% neq 0 (echo [Error] Node.js не найден. & pause & exit /b)

:: Проверка авторизации
if not exist "%PROXY_DIR%.deepseek\deepseek-auth.json" (
    echo [Warning] Нужно авторизоваться.
    pushd "%PROXY_DIR%"
    node scripts\auth.js
    popd
    if not exist "%PROXY_DIR%.deepseek\deepseek-auth.json" (
        echo [Error] Авторизация не пройдена.
        pause
        exit /b
    )
)

:: 1. Выбор модели
echo.
echo Выберите модель DeepSeek для Claude:
echo 1 - deepseek-chat (V3)
echo 2 - deepseek-reasoner (R1)
set /p choice="Ваш выбор (Enter = 1): "

set SELECTED_MODEL=deepseek-chat
if "%choice%"=="2" set SELECTED_MODEL=deepseek-reasoner

:: 2. Очистка порта и запуск сервера
echo [Launcher] Проверка порта 9655...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :9655 ^| findstr LISTENING') do (
    echo [Launcher] Порт занят процессом %%a. Очистка...
    taskkill /F /PID %%a >nul 2>&1
)

echo [Launcher] Запуск прокси-сервера...
set SKIP_ACCOUNT_MENU=1
start "DeepSeek Proxy Server" cmd /k "node server.js"

:: Получаем PID последнего запущенного процесса node (примерный способ для Windows)
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /nh ^| sort /r') do (
    set SERVER_PID=%%a
    goto :found_pid
)
:found_pid

echo [Launcher] Сервер запущен (PID: %SERVER_PID%).
echo [Launcher] Ожидание готовности (5 сек)...
timeout /t 5 /nobreak >nul

:: 3. Настройка окружения
set ANTHROPIC_BASE_URL=http://127.0.0.1:9655
set ANTHROPIC_API_KEY=BetaDropChat-key
set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

:: 4. Запуск Claude
echo ------------------------------------------------------
call claude --model %SELECTED_MODEL%

:: 5. Очистка
echo.
echo ------------------------------------------------------
echo [Launcher] Завершение. Выключаю сервер (PID %SERVER_PID%)...
taskkill /F /PID %SERVER_PID% >nul 2>&1
echo [Launcher] Готово.
pause
