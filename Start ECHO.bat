@echo off
setlocal EnableDelayedExpansion
title ECHO Companion Launcher
cd /d "%~dp0"

rem ---- 0. Windows-only guard ----
if not "%OS%"=="Windows_NT" (
    echo [!] This launcher only works on Windows.
    pause
    exit /b 1
)

echo ==========================================
echo          ECHO - Desktop Companion
echo ==========================================
echo.

rem ---- 1. Launch prebuilt release binary if present ----
if exist "src-tauri\target\release\ECHO.exe" (
    echo [+] Found release build. Launching ECHO...
    start "" "src-tauri\target\release\ECHO.exe"
    exit /b 0
)

rem ---- 2. Reload PATH for current session ----
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"

rem ---- 3. Check for Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js not found.
    echo [*] Installing Node.js LTS - progress below:
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] winget not available, downloading installer manually...
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_setup.msi'"
        echo [*] Running Node.js installer, please wait...
        msiexec /i "%TEMP%\node_setup.msi" /passive /norestart
    )
    echo ----------------------------------------------
    set "PATH=C:\Program Files\nodejs;%PATH%"
) else (
    echo [+] Node.js found.
)

rem ---- 4. Check for Rust / Cargo ----
where cargo >nul 2>nul
if errorlevel 1 (
    echo [!] Rust ^(cargo^) not found.
    echo [*] Installing Rust - progress below:
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] winget not available, downloading installer manually...
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe'"
        echo [*] Running Rust installer, please wait...
        "%TEMP%\rustup-init.exe" -y
    )
    echo ----------------------------------------------
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
) else (
    echo [+] Rust ^(cargo^) found.
)

rem ---- 5. Re-check dependencies after installation attempt ----
where node >nul 2>nul
if errorlevel 1 goto FallbackDownload

where cargo >nul 2>nul
if errorlevel 1 goto FallbackDownload

rem ---- 6. Install node packages if missing ----
if not exist "node_modules\" (
    echo.
    echo [*] Installing node dependencies ^(npm install^) - progress below:
    echo ----------------------------------------------
    call npm install
    echo ----------------------------------------------
)

echo.
echo [+] All dependencies ready. Starting ECHO dev server...
echo [*] Keep this window open while ECHO is running.
echo.
call npm run tauri dev
if not errorlevel 1 exit /b 0

:FallbackDownload
echo.
echo [!] Dev environment incomplete. Downloading standalone ECHO.exe instead...
echo ----------------------------------------------
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $dir = \"$env:LOCALAPPDATA\ECHO\"; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Invoke-WebRequest -Uri 'https://github.com/icedracon/ECHO/releases/latest/download/ECHO.exe' -OutFile \"$dir\ECHO.exe\" -UseBasicParsing; Write-Host '[+] Download complete!' } catch { Write-Host '[!] Could not download ECHO.exe' }"
echo ----------------------------------------------

if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
    echo [+] Launching standalone ECHO...
    start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
    exit /b 0
)

echo [!] Unable to start ECHO automatically. Please install Node.js ^(https://nodejs.org^) and Rust ^(https://rustup.rs^) manually.
pause
exit /b 1