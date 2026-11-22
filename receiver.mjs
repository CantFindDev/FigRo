// Receives UI snapshots from the FigRo Studio plugin, saves each as out/<label>.json, fetches every image it
// references, and writes out/bundle.json (all snapshots plus base64 images) for the Figma plugin to import.
// It also takes pages sent back from the Figma plugin (POST /figma), saving out/figma/latest.json and any new images
// as out/figma/images/<hash>.png, and serves that JSON to the Studio plugin's "Import from Figma" (GET /figma).
// Run: node receiver.mjs   (no dependencies); add `bundle` to only rebuild bundle.json and exit.

import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 34873;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const IMAGES = join(OUT, "images");
/** Pages sent back from Figma for the Studio plugin. */
const FROM_FIGMA = join(OUT, "figma");
/** Roblox's thumbnail API caps image thumbnails at this size. */
const THUMB = "420x420";
/** Studio's install folders, newest last, for rbxasset:// textures. */
const VERSIONS = join(process.env.LOCALAPPDATA ?? "", "Roblox", "Versions");

/** File-safe name for a snapshot label or image id. */
const safe = (s) => s.replace(/[^\w.-]+/g, "_").slice(0, 80);

/** Every image id referenced in a snapshot tree. */
function collectImages(snap, into) {
  const walk = (n) => {
    if (n.image) into.add(n.image.id);
    n.kids?.forEach(walk);
  };
  snap.guis.forEach((g) => g.kids.forEach(walk));
  return into;
}

/** The numeric asset id of an rbxassetid:// or roblox.com asset URL, or null. */
function assetId(id) {
  const m = id.match(/^rbxassetid:\/\/(\d+)/) ?? id.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Downloads uploaded images through the thumbnail API, retrying while thumbnails render. */
async function fetchAssets(ids) {
  const pending = new Map(ids.map((id) => [assetId(id), id]));
  for (let attempt = 0; attempt < 6 && pending.size > 0; attempt++) {
    const batch = [...pending.keys()];
    for (let i = 0; i < batch.length; i += 100) {
      const chunk = batch.slice(i, i + 100).join(",");
      try {
        const res = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${chunk}&size=${THUMB}&format=Png`);
        if (!res.ok) continue;
        for (const item of (await res.json()).data ?? []) {
          const key = String(item.targetId);
          if (item.state !== "Completed" || !item.imageUrl) continue;
          const png = await fetch(item.imageUrl);
          if (png.ok) {
            await writeFile(join(IMAGES, safe(pending.get(key)) + ".png"), Buffer.from(await png.arrayBuffer()));
            pending.delete(key);
          }
        }
      } catch (err) {
        console.warn(`  thumbnail fetch failed, retrying: ${err.message}`);
      }
    }
    if (pending.size > 0) await sleep(3000);
  }
  for (const id of pending.values()) console.warn(`  image not available: ${id}`);
}

/** Copies an rbxasset:// texture from the newest Studio install that has it. */
async function fetchBuiltin(id) {
  const rel = id.replace(/^rbxasset:\/\//, "");
  const versions = (await readdir(VERSIONS).catch(() => [])).reverse();
  for (const v of versions) {
    const path = join(VERSIONS, v, "content", rel);
    try {
      await writeFile(join(IMAGES, safe(id) + ".png"), await readFile(path));
      return;
    } catch {}
  }
  console.warn(`  built-in texture not found: ${id}`);
}

/** Fetches any referenced image not already saved; rbxthumb:// avatars and .dds files are skipped. */
async function fetchImages(ids) {
  const missing = [];
  for (const id of ids) {
    try {
      await access(join(IMAGES, safe(id) + ".png"));
    } catch {
      missing.push(id);
    }
  }
  await fetchAssets(missing.filter(assetId));
  for (const id of missing.filter((i) => i.startsWith("rbxasset://") && !i.endsWith(".dds"))) await fetchBuiltin(id);
}

/** Drops hidden ScreenGuis and GuiObjects, so each panel page holds just that panel's visible layers. */
function prune(snap) {
  const keep = (n) => n.visible && { ...n, kids: n.kids?.map(keep).filter(Boolean) };
  snap.guis = snap.guis.filter((g) => g.enabled).map((g) => ({ ...g, kids: g.kids.map(keep).filter(Boolean) }));
  return snap;
}

/** Rebuilds out/bundle.json from every saved snapshot and image. */
async function writeBundle() {
  const snapshots = [];
  for (const f of (await readdir(OUT)).filter((f) => f.endsWith(".json") && f !== "bundle.json").sort()) {
    const snap = JSON.parse(await readFile(join(OUT, f), "utf8"));
    snapshots.push(snap.full ? snap : prune(snap));
  }
  snapshots.sort((a, b) => !!b.full - !!a.full);
  const ids = new Set();
  snapshots.forEach((s) => collectImages(s, ids));
  const images = {};
  for (const id of ids) {
    try {
      images[id] = (await readFile(join(IMAGES, safe(id) + ".png"))).toString("base64");
    } catch {}
  }
  await writeFile(join(OUT, "bundle.json"), JSON.stringify({ snapshots, images }));
  console.log(`bundle.json: ${snapshots.length} snapshots, ${Object.keys(images).length}/${ids.size} images`);
}

await mkdir(IMAGES, { recursive: true });
await mkdir(join(FROM_FIGMA, "images"), { recursive: true });
if (process.argv.includes("bundle")) {
  await writeBundle();
  process.exit(0);
}

/** Serialises image fetching and bundling so overlapping snapshots never read a half-written file. */
let queue = Promise.resolve();

/** Parts of the snapshot being received; the plugin posts them in order, part i of n. */
let parts = [];

/** Saves a page sent by the Figma plugin; images arrive as base64 PNGs keyed "figma:<hash>". */
async function saveFromFigma(body) {
  const { snapshots, images } = JSON.parse(body);
  if (!Array.isArray(snapshots) || snapshots.some((s) => typeof s.label !== "string" || !Array.isArray(s.guis))) throw new Error("not a Figma export");
  const files = {};
  for (const [id, b64] of Object.entries(images ?? {})) {
    const file = join(FROM_FIGMA, "images", safe(id.replace(/^figma:/, "")) + ".png");
    await writeFile(file, Buffer.from(b64, "base64"));
    files[id] = file;
  }
  await writeFile(join(FROM_FIGMA, "latest.json"), JSON.stringify({ snapshots, files }));
  console.log(`from Figma: ${snapshots.map((s) => s.label).join(", ")} (${Object.keys(files).length} new images)`);
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/figma") {
    if (req.method === "GET") {
      readFile(join(FROM_FIGMA, "latest.json")).then(
        (data) => res.writeHead(200, { "Content-Type": "application/json" }).end(data),
        () => res.writeHead(404).end("nothing sent from Figma yet"),
      );
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () =>
        saveFromFigma(Buffer.concat(chunks).toString("utf8")).then(
          () => res.writeHead(200).end("ok"),
          (err) => res.writeHead(400).end(String(err)),
        ),
      );
      return;
    }
  }
  const i = Number(url.searchParams.get("i") ?? 1);
  const n = Number(url.searchParams.get("n") ?? 1);
  if (req.method !== "POST" || url.pathname !== "/snapshot" || !(i >= 1 && i <= n)) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    if (i === 1) parts = [];
    parts[i - 1] = Buffer.concat(chunks);
    if (i < n) {
      res.writeHead(200).end("part");
      return;
    }
    try {
      const whole = Buffer.concat(parts);
      parts = [];
      const snap = JSON.parse(whole.toString("utf8"));
      if (typeof snap.label !== "string" || !Array.isArray(snap.guis)) throw new Error("not a FigRo snapshot");
      await writeFile(join(OUT, safe(snap.label) + ".json"), JSON.stringify(snap, null, 1));
      console.log(`snapshot "${snap.label}" saved`);
      res.writeHead(200).end("ok");
      const ids = [...collectImages(snap, new Set())];
      queue = queue.then(() => fetchImages(ids)).then(writeBundle).catch(console.error);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(400).end(String(err));
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`FigRo receiver on http://localhost:${PORT}, writing ${OUT}`));
