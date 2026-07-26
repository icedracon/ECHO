@echo off
title ECHO launcher
cd /d "%~dp0"

rem 1. If standalone ECHO.exe is in the root folder
if exist "ECHO.exe" (
    start "" "ECHO.exe"
    exit /b
)

rem 2. If built release binary exists in src-tauri
if exist "src-tauri\target\release\ECHO.exe" (
    start "" "src-tauri\target\release\ECHO.exe"
    exit /b
)

rem 3. Dev mode fallback (runs npm install if node_modules missing)
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

echo Starting ECHO in dev mode... (first run compiles, ~30s)
start "" /min cmd /c "npm run tauri dev"
exit /b
