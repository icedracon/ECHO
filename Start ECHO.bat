@echo off
title ECHO Launcher & Auto-Installer
cd /d "%~dp0"

echo ==========================================
echo          ECHO — Desktop Companion         
echo ==========================================

rem 1. If prebuilt standalone ECHO.exe exists in root, launch instantly!
if exist "ECHO.exe" (
    echo [+] Launching standalone ECHO...
    start "" "ECHO.exe"
    exit /b
)

rem 2. If built release binary exists in src-tauri, launch instantly!
if exist "src-tauri\target\release\ECHO.exe" (
    echo [+] Launching release ECHO...
    start "" "src-tauri\target\release\ECHO.exe"
    exit /b
)

rem Helper: Reload PATH from registry + standard install locations
call :ReloadPath

rem 3. Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js not found. Installing Node.js LTS...
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] Downloading Node.js installer...
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_setup.msi'; Start-Process msiexec.exe -ArgumentList '/i %TEMP%\node_setup.msi /quiet /norestart' -Wait"
    )
    call :ReloadPath
)

rem 4. Check for Rust / Cargo
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Rust compiler (cargo) not found. Installing Rust...
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        winget install --id Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
    ) else (
        echo [*] Downloading Rust installer...
        powershell -Command "Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe'; Start-Process '%TEMP%\rustup-init.exe' -ArgumentList '-y' -Wait"
    )
    call :ReloadPath
)

rem Double check PATH again
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js was installed but PATH is not updated yet.
    echo [!] Please close this window and double-click Start ECHO.bat again!
    pause
    exit /b
)

rem 5. Install Node packages if node_modules is missing
if not exist "node_modules\" (
    echo [*] Installing node dependencies (npm install)...
    call npm install
)

echo [+] Starting ECHO dev server...
echo [*] Keep this window open while ECHO is running.
call npm run tauri dev
if %errorlevel% neq 0 (
    echo.
    echo [!] ECHO encountered an error. Press any key to close.
    pause
)
exit /b

:ReloadPath
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%USERPROFILE%\.cargo\bin" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
for /f "delims=" %%i in ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')"') do set "PATH=%%i;%PATH%"
exit /b
