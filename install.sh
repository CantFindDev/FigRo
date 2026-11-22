#!/usr/bin/env sh
# Installs FigRo: builds the Studio plugin into Roblox Studio's Plugins folder, then shows how to add the Figma plugin
# (Figma has no command-line install for development plugins, so that part is one menu click).
set -e
cd "$(dirname "$0")"
ROOT=$(pwd)

command -v rokit >/dev/null 2>&1 && rokit install --no-trust-check >/dev/null 2>&1 || true
command -v rojo >/dev/null 2>&1 || { echo "FigRo needs Rojo on PATH to build the Studio plugin: https://rojo.space/docs/v7/getting-started/installation/"; exit 1; }
command -v node >/dev/null 2>&1 || echo "Note: the receiver needs Node.js 18 or newer: https://nodejs.org"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    PLUGINS="$(cygpath -u "$LOCALAPPDATA")/Roblox/Plugins"
    MANIFEST="$(cygpath -w "$ROOT/figma-plugin/manifest.json")"
    ;;
  Darwin)
    PLUGINS="$HOME/Documents/Roblox/Plugins"
    MANIFEST="$ROOT/figma-plugin/manifest.json"
    ;;
  *)
    echo "Roblox Studio only runs on Windows and macOS."
    exit 1
    ;;
esac

mkdir -p "$PLUGINS"
rojo build studio.project.json -o "$PLUGINS/FigRo.rbxm"
echo "Roblox: installed $PLUGINS/FigRo.rbxm; restart Studio and allow HTTP requests when it asks."
echo
echo "Figma (desktop app, once): Plugins > Development > Import plugin from manifest..., then pick:"
echo "  $MANIFEST"
echo
echo "Start the receiver whenever you move UI between them:  node receiver.mjs"
