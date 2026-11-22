@echo off
rem Installs FigRo: builds the Studio plugin into Roblox Studio's Plugins folder, then shows how to add the Figma plugin
rem (Figma has no command-line install for development plugins, so that part is one menu click).
setlocal
cd /d "%~dp0"

where rokit >nul 2>&1 && rokit install --no-trust-check >nul 2>&1
where rojo >nul 2>&1 || (
  echo FigRo needs Rojo on PATH to build the Studio plugin: https://rojo.space/docs/v7/getting-started/installation/
  goto fail
)
where node >nul 2>&1 || echo Note: the receiver needs Node.js 18 or newer: https://nodejs.org

set "PLUGINS=%LOCALAPPDATA%\Roblox\Plugins"
if not exist "%PLUGINS%" mkdir "%PLUGINS%"
rojo build studio.project.json -o "%PLUGINS%\FigRo.rbxm" || goto fail
echo Roblox: installed %PLUGINS%\FigRo.rbxm; restart Studio and allow HTTP requests when it asks.
echo.
echo Figma (desktop app, once): Plugins ^> Development ^> Import plugin from manifest..., then pick:
echo   %~dp0figma-plugin\manifest.json
echo.
echo Start the receiver whenever you move UI between them: run.bat
pause
exit /b 0

:fail
pause
exit /b 1
