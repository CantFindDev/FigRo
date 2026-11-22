# FigRo

**Round-trip Roblox UI through Figma.** Capture the live UI of any Roblox game during a playtest, edit it in Figma as
real, editable 1920x1080 frames, and send it back to Studio as ScreenGuis.

FigRo is two plugins and a small local server:

- **Studio plugin** (`studio/`) captures every ScreenGui the player can see, and rebuilds ScreenGuis from Figma frames.
- **Figma plugin** (`figma-plugin/`) builds Figma layers from captured snapshots, and exports frames back.
- **Receiver** (`receiver.mjs`) is a zero-dependency Node server on `localhost:34873` that moves data between the two.

## Features

- **Exact conversion.** Frames, text, images, strokes, corners, gradients, rotation and clipping become native,
  editable Figma layers at the exact positions Roblox laid them out, not screenshots.
- **Real images.** Decals and image assets are downloaded once and embedded in Figma.
- **Both directions.** Edit a layout in Figma and import it back as a ScreenGui with the same hierarchy and names.
- **Works on any game.** No setup needed. Optional StarterGui attributes add scale-aware layouts and per-panel frames.
- **Fits the Figma Starter plan.** Everything goes on one page you pick, grouped in Sections, so the 3-page limit
  never gets in the way.
- **Scriptable.** Trigger exports and imports from scripts, the command bar, or an MCP agent.

## How it works

```
Studio playtest ──Export UI──▶ receiver.mjs ──out/bundle.json──▶ Figma plugin ──▶ Figma page
Figma selection ──Send to Roblox──▶ receiver.mjs ──▶ Studio plugin "Import from Figma" ──▶ StarterGui
```

Each Export UI click saves a snapshot to `out/` and rebuilds `out/bundle.json`, a single file with every snapshot and
its images that the Figma plugin opens.

## Requirements

- Roblox Studio
- The Figma desktop app (development plugins can't run in the browser)
- [Node.js](https://nodejs.org) 18 or newer
- [Rojo](https://rojo.space) 7, or [Rokit](https://github.com/rojo-rbx/rokit), which installs the pinned Rojo from `rokit.toml`

## Install

```sh
git clone https://github.com/CantFindDev/FigRo.git
cd FigRo
./install.sh
```

The script builds `FigRo.rbxm` into Studio's local Plugins folder (Windows and macOS). Restart Studio and a FigRo
toolbar appears.

Then, once, in the Figma desktop app: **Plugins > Development > Import plugin from manifest**, and choose
`figma-plugin/manifest.json`.

## Usage

Start the receiver and leave it running:

```sh
node receiver.mjs
```

### Roblox to Figma

1. Start a playtest in Studio.
2. Open the screen or panel you want and click **FigRo > Export UI**. Repeat for each screen.
3. In Figma, run **Plugins > Development > FigRo**.
4. Click **Choose bundle.json** and pick `out/bundle.json`.
5. Pick a page (or **+ New page**) and click **Import**.

The page is renamed `<game> UI` and the import goes below anything already on it, so you can import again without
losing earlier work.

### Figma to Roblox

1. Select frames or sections in Figma, or select nothing to send the whole page.
2. Click **Send to Roblox**.
3. In Studio (Edit mode), click **FigRo > Import from Figma**.

Each frame becomes a `Figma - <frame>` ScreenGui in StarterGui. Images added in Figma are saved to `out/` and need
uploading to Roblox before they show in game.

### From scripts

```lua
-- In a playtest: export a snapshot with this label.
game.Players.LocalPlayer.PlayerGui:SetAttribute("FigmaExport", "Shop")

-- In Edit mode: import whatever Figma last sent.
game.StarterGui:SetAttribute("FigmaImport", true)
```

To rebuild `out/bundle.json` without starting the server, run `node receiver.mjs bundle`.

## Per-game settings

All optional. Set them as attributes on StarterGui (with Rojo, as `$attributes` in your project file).

| Attribute | Type | Effect |
| --- | --- | --- |
| `FigRoReference` | Vector2 | Viewport size your UI is laid out at, for games that scale each ScreenGui with a UIScale named `AutoScale`. Frames show that layout as it looks on 1920x1080, and imports get an `AutoScale` too. |
| `FigRoPanelSuffix` | string | ScreenGuis whose names end with this hold panels (shop, settings and so on). Each gets its own section, with one frame per open panel over a locked HUD background. Without it, every snapshot lands in Screens. |
| `FigRoFullSnapshot` | string | Snapshot label that keeps hidden panels, so panels that were never captured open still get a frame. |

Example Rojo project:

```json
"StarterGui": {
  "$className": "StarterGui",
  "$attributes": {
    "FigRoReference": { "Vector2": [1470, 840] },
    "FigRoPanelSuffix": { "String": "Windows" },
    "FigRoFullSnapshot": { "String": "Lobby" }
  }
}
```

## Layout in Figma

One page holds everything, in Sections:

- **HUD:** the always-on screens as components, reused as backgrounds.
- **One section per panel ScreenGui:** a frame for each panel, drawn over a locked HUD instance. The background is
  never sent back to Roblox.
- **Screens:** every other snapshot.

## Limitations

- Fonts Figma doesn't have are replaced by the closest available one.
- Images drawn or pasted in Figma come back as files in `out/` and must be uploaded to Roblox by hand.
- Layouts (UIListLayout, UIGridLayout) are captured as the positions they produced, not as Figma auto layout.
- Roblox-only content (scripts, tweens, 3D in ViewportFrames) has no Figma equivalent; ViewportFrames export as
  empty clipped frames. `TextScaled` text is exported at the size Roblox picked.
- The receiver only listens on `localhost`, and `out/` can grow large with images. It is gitignored.

## Contributing

Issues and pull requests are welcome. Keep the receiver dependency-free and test both directions on a real game
before opening a PR.

## License

[Apache License 2.0](LICENSE).
