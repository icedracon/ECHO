@echo off
setlocal EnableDelayedExpansion
title ECHO Companion Launcher
cd /d "%~dp0"

rem ---- Windows-only guard ----
if not "%OS%"=="Windows_NT" (
    echo [!] This launcher only works on Windows.
    pause
    exit /b 1
)

rem ---- "Start ECHO.bat dev" = developer mode: dev server, console stays open ----
if /i "%~1"=="dev" goto DevServer

echo ==========================================
echo          ECHO - Desktop Companion
echo ==========================================
echo.

rem ---- Prebuilt first. A normal user never compiles anything. ----
if exist "ECHO.exe" (
    echo [+] Launching ECHO...
    start "" "ECHO.exe"
    goto Done
)
if exist "src-tauri\target\release\ECHO.exe" (
    echo [+] Launching ECHO...
    start "" "src-tauri\target\release\ECHO.exe"
    goto Done
)
if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
    echo [+] Launching ECHO...
    start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
    goto Done
)

rem ---- No exe anywhere: try the release download ----
echo [*] First run - downloading ECHO...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $dir = ""$env:LOCALAPPDATA\ECHO""; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Invoke-WebRequest -Uri 'https://github.com/icedracon/ECHO/releases/latest/download/ECHO.exe' -OutFile ""$dir\ECHO.exe"" -UseBasicParsing; Unblock-File ""$dir\ECHO.exe""; exit 0 } catch { exit 1 }"
if exist "%LOCALAPPDATA%\ECHO\ECHO.exe" (
    echo [+] Download complete. Launching ECHO...
    start "" "%LOCALAPPDATA%\ECHO\ECHO.exe"
    goto Done
)

rem ---- Download unavailable: build from source if the source is here ----
if exist "package.json" goto BuildFromSource

echo [!] Could not get ECHO.exe automatically.
echo     Ask for a release build, or clone the source repo and run this again.
pause
exit /b 1

rem =====================================================================
rem  Source build: installs what is missing, builds ONCE (release),
rem  launches the exe, and the console closes. Next runs skip all of it.
rem =====================================================================
:BuildFromSource
echo.
echo [*] No prebuilt ECHO found - building it from source.
echo [*] This is a one-time setup and can take a while on first run.
echo.

rem ---- Reload PATH for tools installed in this session ----
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"

rem ---- Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [*] Installing Node.js LTS...
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    ) else (
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_setup.msi'"
        msiexec /i "%TEMP%\node_setup.msi" /passive /norestart
    )
    echo ----------------------------------------------
    set "PATH=C:\Program Files\nodejs;%PATH%"
) else (
    echo [+] Node.js found.
)

rem ---- Rust ----
where cargo >nul 2>nul
if errorlevel 1 (
    echo [*] Installing Rust...
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
    ) else (
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe'"
        "%TEMP%\rustup-init.exe" -y
    )
    echo ----------------------------------------------
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
) else (
    echo [+] Rust found.
)

rem ---- MSVC Build Tools (check the C++ workload, not just vswhere) ----
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "HAVE_MSVC="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "HAVE_MSVC=1"
)
if not defined HAVE_MSVC (
    echo [*] Installing Visual Studio Build Tools ^(C++ workload, several GB^)...
    echo ----------------------------------------------
    where winget >nul 2>nul
    if not errorlevel 1 (
        winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-source-agreements --accept-package-agreements
    ) else (
        echo [!] winget not available. Install manually from:
        echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/
        echo     ^(select "Desktop development with C++"^), then run this again.
        pause
        exit /b 1
    )
    echo ----------------------------------------------
) else (
    echo [+] Visual Studio Build Tools found.
)

rem ---- Final tool check ----
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js still not available. Restart this launcher once - a fresh
    echo     console picks up the new PATH.
    pause
    exit /b 1
)
where cargo >nul 2>nul
if errorlevel 1 (
    echo [!] Rust still not available. Restart this launcher once.
    pause
    exit /b 1
)

rem ---- npm install ----
if not exist "node_modules\" (
    echo [*] Installing dependencies...
    echo ----------------------------------------------
    call npm install
    if errorlevel 1 (
        echo [!] npm install failed - check the log above.
        pause
        exit /b 1
    )
    echo ----------------------------------------------
)

rem ---- Build the release exe (one time) ----
echo [*] Building ECHO ^(release^) - takes a few minutes the first time...
echo ----------------------------------------------
call npm run tauri build
if errorlevel 1 (
    echo [!] Build failed - check the log above.
    pause
    exit /b 1
)
echo ----------------------------------------------

if exist "src-tauri\target\release\ECHO.exe" (
    echo [+] Build complete. Launching ECHO...
    start "" "src-tauri\target\release\ECHO.exe"
    goto Done
)
echo [!] Build finished but ECHO.exe was not found.
pause
exit /b 1

rem =====================================================================
:DevServer
echo [*] Dev mode: npm run tauri dev ^(console stays open^).
set "PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
if not exist "node_modules\" call npm install
call npm run tauri dev
exit /b 0

:Done
echo.
echo [+] Dante is on your taskbar. This window closes itself.
timeout /t 3 >nul
exit /b 0
