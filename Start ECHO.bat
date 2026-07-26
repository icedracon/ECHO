@echo off
title "ECHO Companion Launcher"
cd /d "%~dp0"

echo ==========================================
echo          ECHO - Desktop Companion         
echo ==========================================

rem 1. Launch prebuilt release binary if present
if exist "src-tauri\target\release\ECHO.exe" (
    echo [+] Launching release ECHO...
    start "" "src-tauri\target\release\ECHO.exe"
    exit /b 0
)

rem 2. Reload PATH for current session
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"

rem 3. Check for Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js not found. Auto-installing Node.js LTS...
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] Downloading Node.js installer...
        powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_setup.msi'; Start-Process msiexec.exe -ArgumentList '/i %TEMP%\node_setup.msi /quiet /norestart' -Wait"
    )
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

rem 4. Check for Rust / Cargo
where cargo >nul 2>nul
if errorlevel 1 (
    echo [!] Rust compiler (cargo) not found. Auto-installing Rust...
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] Downloading Rust installer...
        powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe'; Start-Process '%TEMP%\rustup-init.exe' -ArgumentList '-y' -Wait"
    )
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

rem 5. Check dependencies after installation attempt
where node >nul 2>nul
if errorlevel 1 goto FallbackDownload

where cargo >nul 2>nul
if errorlevel 1 goto FallbackDownload

rem 6. Install node packages if missing
if not exist "node_modules\" (
    echo [*] Installing node dependencies (npm install)...
    call npm install
)

echo [+] Starting ECHO dev server...
echo [*] Keep this window open while ECHO is running.
call npm run tauri dev
if not errorlevel 1 exit /b 0

:FallbackDownload
echo.
echo [!] Dev environment incomplete. Downloading standalone ECHO.exe...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $dir = '$env:LOCALAPPDATA\ECHO'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Invoke-WebRequest -Uri 'https://github.com/icedracon/ECHO/releases/latest/download/ECHO.exe' -OutFile '$dir\ECHO.exe' -UseBasicParsing; Write-Host '[+] Download complete!' } catch { Write-Host '[!] Could not download ECHO.exe' }"

if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
    echo [+] Launching standalone ECHO...
    start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
    exit /b 0
)

echo [!] Unable to start ECHO automatically. Please install Node.js (https://nodejs.org) and Rust (https://rustup.rs).
pause
exit /b 1
