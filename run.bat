@echo off
rem Starts the FigRo receiver that moves UI between the Studio and Figma plugins; extra arguments pass through
rem ("run.bat bundle" only rebuilds out\bundle.json). Stop it with Ctrl+C.
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo FigRo needs Node.js 18 or newer: https://nodejs.org
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "MAJOR=%%v"
if %MAJOR% LSS 18 (
  echo FigRo needs Node.js 18 or newer, found %MAJOR%.
  pause
  exit /b 1
)

node receiver.mjs %*
if errorlevel 1 pause
