@echo off
setlocal
cd /d "%~dp0"

rem Avoid the Electron-as-Node trap and any injected NODE_OPTIONS
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo.
  echo [ERROR] Electron not found in node_modules.
  echo Please run "npm install" in this folder first.
  echo.
  pause
  exit /b 1
)

rem Pass through extra args, e.g. "start.bat --version"
if "%~1"=="" (
  "%ELECTRON_EXE%" .
) else (
  "%ELECTRON_EXE%" %*
)

if errorlevel 1 (
  echo.
  echo [ERROR] App exited with an error. See messages above.
  pause
)
