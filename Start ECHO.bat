@echo off
title ECHO Companion Launcher
cd /d "%~dp0"

echo ==========================================
echo          ECHO - Desktop Companion         
echo ==========================================

set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js is not found in PATH.
    pause
    exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
    echo [!] Rust/Cargo is not found in PATH.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [*] Installing node dependencies...
    call npm install
)

echo [+] Starting ECHO dev server...
call npm run tauri dev
