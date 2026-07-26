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

rem ---- 1. If running as standalone dist (no source code), launch prebuilt ECHO.exe ----
if not exist "package.json" (
    if exist "ECHO.exe" (
        echo [+] Found ECHO.exe. Launching ECHO...
        start "" "ECHO.exe"
        exit /b 0
    )
    if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
        echo [+] Found cached ECHO.exe. Launching...
        start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
        exit /b 0
    )
    goto FallbackDownload
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

rem ---- 5. Check for MSVC Build Tools (via vswhere) ----
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [!] Visual Studio Build Tools not found - needed to compile Tauri.
    echo [*] Installing Visual Studio Build Tools ^(C++ workload^)...
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-source-agreements --accept-package-agreements
    ) else (
        echo [!] winget not available. Please install manually from:
        echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/
        echo     ^(select the "Desktop development with C++" workload^)
    )
    echo ----------------------------------------------
) else (
    echo [+] Visual Studio Build Tools found.
)

rem ---- 6. Re-check Node and Cargo (minimum required) ----
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js still not available after install attempt.
    goto FallbackDownload
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo [!] Rust/Cargo still not available after install attempt.
    goto FallbackDownload
)

rem ---- 7. Install node packages if missing ----
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
echo.
echo [*] ECHO closed.
exit /b 0

:FallbackDownload
echo.
echo [!] Dev environment incomplete. Downloading standalone ECHO.exe instead...
echo ----------------------------------------------
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $dir = ""$env:LOCALAPPDATA\ECHO""; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Invoke-WebRequest -Uri 'https://github.com/icedracon/ECHO/releases/latest/download/ECHO.exe' -OutFile ""$dir\ECHO.exe"" -UseBasicParsing; Write-Host '[+] Download complete!' } catch { Write-Host '[!] Could not download ECHO.exe' }"
echo ----------------------------------------------

if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
    echo [+] Launching standalone ECHO...
    start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
    exit /b 0
)

echo [!] Unable to start ECHO automatically. Please install Node.js ^(https://nodejs.org^) and Rust ^(https://rustup.rs^) manually.
pause
exit /b 1
