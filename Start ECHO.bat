@echo off
title ECHO launcher
cd /d "%~dp0"

rem If a release build exists, launch the standalone exe (no console, instant).
if exist "src-tauri\target\release\ECHO.exe" (
    start "" "src-tauri\target\release\ECHO.exe"
    exit /b
)

rem Otherwise run in dev mode (needs Node + Rust installed).
echo Starting ECHO in dev mode... (first run compiles, ~30s)
start "" /min cmd /c "npm run tauri dev"
exit /b
