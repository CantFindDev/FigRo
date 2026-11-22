// FigRo: builds editable Figma layers from FigRo snapshots on one chosen page (Starter files allow 3 pages): one
// section per panel ScreenGui (name ends with the game's FigRoPanelSuffix) with a 1920x1080 frame per panel state over
// a locked HUD instance, a HUD section holding those HUD components, and a Screens section for everything else. Each
// ScreenGui is one frame, each GuiObject one frame with its fills, corners, strokes, gradients, text and images, laid
// out and scaled the way the game shows them on a 1920x1080 screen. The second half sends frames back to Roblox.

figma.showUI(__html__, { width: 560, height: 248, themeColors: true });

/** Figma style names for Roblox font weights. */
const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
/** Figma families to try for each Roblox font family, best first; Inter is the last resort for all. */
const FAMILIES = {
  FredokaOne: ["Fredoka One", "Fredoka"],
  BuilderSans: ["Builder Sans", "Nunito Sans", "Nunito"],
  GothamSSm: ["Gotham", "Montserrat"],
  Gotham: ["Gotham", "Montserrat"],
  SourceSansPro: ["Source Sans Pro", "Source Sans 3"],
};
/** Roblox ScaleType to Figma scaleMode; CROP with an identity transform stretches like Roblox's Stretch. */
const SCALE = { Stretch: "CROP", Slice: "CROP", Fit: "FIT", Crop: "FILL", Tile: "TILE" };
const ALIGN_X = { Left: "LEFT", Center: "CENTER", Right: "RIGHT" };
const ALIGN_Y = { Top: "TOP", Center: "CENTER", Bottom: "BOTTOM" };
/** Stand-in for the 3D world behind the UI. */
const WORLD = { r: 0.17, g: 0.17, b: 0.2 };
/** Screen every frame is drawn at. */
const SCREEN_W = 1920, SCREEN_H = 1080;
/** Screen pixels per design unit for `snap`: how its game's AutoScale fits the reference size on 1920x1080, else 1. */
const fitOf = (snap) => (snap.reference ? Math.min(SCREEN_W / snap.reference.x, SCREEN_H / snap.reference.y) : 1);
/** Roblox's top bar inset in screen pixels; ScreenGuis that respect it start this far down. */
const INSET = 58;
/** Space between frames on a page, and frames per row. */
const GAP = 200, COLUMNS = 4;

/** Inner padding of each section around its frames, and the space between stacked sections. */
const SECTION_PAD = 75, SECTION_GAP = 600;

const rgb = (c) => ({ r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 });
const tick = () => new Promise((r) => setTimeout(r, 0));
const say = (log) => figma.ui.postMessage({ log });

/** Linear sample of keypoints [[time, ...values]] at `t`. */
function sample(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b[0]) {
      const f = b[0] === a[0] ? 1 : (t - a[0]) / (b[0] - a[0]);
      return a.slice(1).map((v, j) => v + (b[j + 1] - v) * f);
    }
  }
  return keys[keys.length - 1].slice(1);
}

/** A linear gradient paint for a UIGradient tinting `base` (0-255 rgb) at opacity `alpha`, as Roblox multiplies them. */
function gradientPaint(g, base, alpha) {
  const times = [...new Set(g.colors.map((k) => k[0]).concat(g.alphas.map((k) => k[0])))].sort((a, b) => a - b);
  const stops = times.map((t) => {
    const c = sample(g.colors, t);
    const a = sample(g.alphas, t)[0];
    return {
      position: Math.min(1, Math.max(0, t)),
      color: { r: (base[0] * c[0]) / 65025, g: (base[1] * c[1]) / 65025, b: (base[2] * c[2]) / 65025, a: alpha * (1 - a) },
    };
  });
  const th = (g.rot * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const px = 0.5 + g.off[0], py = 0.5 + g.off[1];
  return {
    type: "GRADIENT_LINEAR",
    gradientStops: stops,
    gradientTransform: [[c, s, 0.5 - (c * px + s * py)], [-s, c, 0.5 - (-s * px + c * py)]],
  };
}

/** A solid paint, or the gradient version when the object has a UIGradient. */
function paint(color, transparency, grad) {
  if (grad) return gradientPaint(grad, color, 1 - transparency);
  return { type: "SOLID", color: rgb(color), opacity: 1 - transparency };
}

/** Resolves every Roblox font in the snapshots to an installed Figma font and loads it. */
async function loadFonts(snapshots) {
  const available = new Map();
  for (const f of await figma.listAvailableFontsAsync()) {
    if (!available.has(f.fontName.family)) available.set(f.fontName.family, new Set());
    available.get(f.fontName.family).add(f.fontName.style);
  }
  const wanted = new Map();
  const walk = (n) => {
    if (n.text) wanted.set(`${n.text.font}|${n.text.weight}|${n.text.italic}`, n.text);
    if (n.kids) n.kids.forEach(walk);
  };
  snapshots.forEach((s) => s.guis.forEach((g) => g.kids.forEach(walk)));
  const resolved = new Map();
  const missing = new Set();
  for (const [key, t] of wanted) {
    const split = t.font.replace(/([a-z])([A-Z])/g, "$1 $2");
    const families = (FAMILIES[t.font] || [split]).concat("Inter");
    const weight = WEIGHTS[Math.round(t.weight / 100) * 100] || "Regular";
    const style = t.italic ? (weight === "Regular" ? "Italic" : weight + " Italic") : weight;
    let font = null;
    for (const family of families) {
      const styles = available.get(family);
      if (!styles) continue;
      const pick = styles.has(style) ? style : styles.has("Regular") ? "Regular" : styles.values().next().value;
      font = { family, style: pick };
      break;
    }
    if (font.family !== families[0]) missing.add(families[0]);
    await figma.loadFontAsync(font);
    resolved.set(key, font);
  }
  return { resolved, missing };
}

/** Places `node` at the exported box, rotating about its centre as Roblox does. */
function place(node, n) {
  if (!n.rot) {
    node.x = n.x;
    node.y = n.y;
    return;
  }
  const th = (n.rot * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  node.relativeTransform = [
    [c, -s, cx - (c * n.w) / 2 + (s * n.h) / 2],
    [s, c, cy - (s * n.w) / 2 - (c * n.h) / 2],
  ];
}

/** Builder state for one import. */
const ctx = { fonts: null, hashes: new Map(), images: {}, count: 0 };

/** The Figma image hash for an exported image id, created once. */
function imageHash(id) {
  if (!ctx.hashes.has(id)) ctx.hashes.set(id, ctx.images[id] ? figma.createImage(ctx.images[id]).hash : null);
  return ctx.hashes.get(id);
}

/** The text layer for a GuiObject's text, filling its box inside the padding. */
function textNode(n) {
  const t = n.text;
  const node = figma.createText();
  node.fontName = ctx.fonts.resolved.get(`${t.font}|${t.weight}|${t.italic}`);
  node.characters = t.s;
  node.fontSize = Math.max(1, t.size);
  node.fills = [paint(t.color, t.a, n.grad)];
  node.textAlignHorizontal = ALIGN_X[t.xa] || "CENTER";
  node.textAlignVertical = ALIGN_Y[t.ya] || "CENTER";
  if (t.lineHeight && t.lineHeight !== 1) node.lineHeight = { unit: "PERCENT", value: t.lineHeight * 100 };
  const textStroke = (n.strokes || []).find((s) => s.text);
  if (textStroke) {
    node.strokes = [paint(textStroke.color, textStroke.a, textStroke.grad)];
    node.strokeWeight = textStroke.w;
    node.strokeAlign = "OUTSIDE";
  } else if (t.stroke) {
    node.strokes = [paint(t.stroke[0], t.stroke[1])];
    node.strokeWeight = 1;
    node.strokeAlign = "OUTSIDE";
  }
  const p = n.pad || [0, 0, 0, 0];
  node.textAutoResize = "NONE";
  node.resize(Math.max(1, n.w - p[0] - p[2]), Math.max(1, n.h - p[1] - p[3]));
  node.x = p[0];
  node.y = p[1];
  node.name = "Text";
  return node;
}

/** Builds the frame for exported GuiObject `n` and its children under `parent`. */
async function build(n, parent) {
  const f = figma.createFrame();
  f.name = n.name;
  f.setPluginData("class", n.class);
  parent.appendChild(f);
  f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  place(f, n);
  f.clipsContent = !!n.clip;
  f.visible = n.visible;
  if (n.group) f.opacity = 1 - n.group;
  const fills = [];
  if (n.bg) fills.push(paint(n.bg, n.bgA, n.grad));
  if (n.image) {
    const hash = imageHash(n.image.id);
    if (hash) fills.push({ type: "IMAGE", imageHash: hash, scaleMode: SCALE[n.image.scale] || "CROP", opacity: 1 - n.image.a });
    else f.setPluginData("image", n.image.id);
  }
  f.fills = fills;
  const { kids, ...own } = n;
  f.setPluginData("src", JSON.stringify(own));
  if (fills.length && fills[fills.length - 1].type === "IMAGE") f.setPluginData("imageHash", fills[fills.length - 1].imageHash);
  if (n.corner) f.cornerRadius = n.corner;
  const border = (n.strokes || []).find((s) => !s.text);
  if (border) {
    f.strokes = [paint(border.color, border.a, border.grad)];
    f.strokeWeight = border.w;
    f.strokeAlign = border.align;
  }
  if (n.text) f.appendChild(textNode(n));
  if (++ctx.count % 400 === 0) {
    say(`Building layers... ${ctx.count}`);
    await tick();
  }
  if (n.kids) for (const k of n.kids) await build(k, f);
  return f;
}

/** Figma constraints guessed from where a top-level panel sits in its ScreenGui, so resizing the screen frame moves it
 * the way Roblox anchoring would. Only a guess: the snapshot holds boxes, not the original UDims. */
function guessConstraints(n, W, H) {
  const axis = (pos, len, full) =>
    len >= full - 1 ? "STRETCH" : Math.abs(pos + len / 2 - full / 2) <= Math.max(1, full * 0.03) ? "CENTER" : pos + len / 2 > full / 2 ? "MAX" : "MIN";
  return { horizontal: axis(n.x, n.w, W), vertical: axis(n.y, n.h, H) };
}

/** Whether ScreenGui `g` of `snap` holds panels; everything else counts as HUD. */
const isPanelGui = (g, snap) => !!snap.panelSuffix && g.name.endsWith(snap.panelSuffix);

/** `snap` without hidden ScreenGuis and GuiObjects, as receiver.mjs prunes every snapshot but the full one. */
function prune(snap) {
  const keep = (n) => n.visible && { ...n, kids: n.kids && n.kids.map(keep).filter(Boolean) };
  return { ...snap, guis: snap.guis.filter((g) => g.enabled).map((g) => ({ ...g, kids: g.kids.map(keep).filter(Boolean) })) };
}

/** Panel ScreenGuis of `snap` that have a panel open, holding only the open panels. */
const openGuis = (snap) =>
  snap.guis.filter((g) => isPanelGui(g, snap) && g.enabled && g.kids.some((k) => k.visible)).map((g) => ({ ...g, kids: g.kids.filter((k) => k.visible) }));

/** HUD ScreenGuis of `snap` with something on screen. */
const hudGuis = (snap) => snap.guis.filter((g) => !isPanelGui(g, snap) && g.enabled && g.kids.some((k) => k.visible));

/** A new 1920x1080 frame (or component) placed in the next grid cell of `section`. */
function newScreen(section, name, component) {
  const screen = component ? figma.createComponent() : figma.createFrame();
  const i = section.children.length;
  section.appendChild(screen);
  screen.name = name;
  screen.resize(SCREEN_W, SCREEN_H);
  screen.fills = [{ type: "SOLID", color: WORLD }];
  screen.clipsContent = true;
  screen.x = SECTION_PAD + (i % COLUMNS) * (SCREEN_W + GAP);
  screen.y = SECTION_PAD + Math.floor(i / COLUMNS) * (SCREEN_H + GAP);
  screen.setPluginData("screen", "1");
  return screen;
}

/** Builds ScreenGuis `guis` of `snap` into `screen`: each is laid out on the 1920x1080 screen's canvas in design units,
 * moving panels by their guessed constraints, then scaled up the way the game's AutoScale would. */
async function buildLayers(screen, snap, guis) {
  const fit = fitOf(snap);
  screen.setPluginData("unit", String(fit));
  screen.setPluginData("reference", JSON.stringify(snap.reference || null));
  for (const g of guis) {
    const layer = figma.createFrame();
    layer.name = g.name;
    layer.fills = [];
    layer.clipsContent = false;
    screen.appendChild(layer);
    layer.resize(Math.max(1, snap.width - g.x), Math.max(1, snap.height - g.y));
    layer.visible = g.enabled;
    for (const k of g.kids) {
      const f = await build(k, layer);
      f.constraints = guessConstraints(k, layer.width, layer.height);
    }
    const top = g.y > 0 ? INSET : 0;
    layer.resize(SCREEN_W / fit, (SCREEN_H - top) / fit);
    if (fit !== 1) layer.rescale(fit);
    layer.x = 0;
    layer.y = top;
    layer.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
    layer.setPluginData("gui", JSON.stringify({ name: g.name, order: g.order, enabled: g.enabled }));
  }
}

/** Tells the UI which pages exist and which is open, for its target page picker. */
const sendPages = () =>
  figma.ui.postMessage({ pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })), current: figma.currentPage.id });
sendPages();
figma.on("currentpagechange", sendPages);

/** Sizes each section around its grid of frames and stacks them downwards from `top`. */
function arrange(sections, top) {
  for (const section of sections) {
    const n = section.children.length, cols = Math.min(Math.max(n, 1), COLUMNS), rows = Math.max(1, Math.ceil(n / COLUMNS));
    section.resizeWithoutConstraints(2 * SECTION_PAD + cols * SCREEN_W + (cols - 1) * GAP, 2 * SECTION_PAD + rows * SCREEN_H + (rows - 1) * GAP);
    section.x = 0;
    section.y = top;
    top += section.height + SECTION_GAP;
  }
}

figma.ui.onmessage = async ({ snapshots, images, cmd, pageId }) => {
  if (cmd === "export") return exportPage();
  if (cmd === "pages") return sendPages();
  try {
    ctx.images = images;
    ctx.count = 0;
    say("Loading fonts...");
    ctx.fonts = await loadFonts(snapshots);
    const full = snapshots.find((s) => s.full);
    const shown = snapshots.map((s) => (s === full ? prune(s) : s));
    let page = pageId && (await figma.getNodeByIdAsync(pageId));
    if (!page) {
      try {
        page = figma.createPage();
      } catch {
        return say("This file has no room for a new page: pick an existing page and import again.");
      }
    }
    await figma.setCurrentPageAsync(page);
    await page.loadAsync();
    page.name = `${(snapshots[0] && snapshots[0].place) || "Roblox"} UI`;
    say("Clearing the page...");
    for (const node of [...page.children]) node.remove();
    const start = 0;
    const sections = new Map();
    const sectionFor = (name) => {
      if (!sections.has(name)) {
        const section = figma.createSection();
        section.name = name;
        sections.set(name, section);
      }
      return sections.get(name);
    };
    const screenIn = (sectionName, name, component) => {
      const screen = newScreen(sectionFor(sectionName), name, component);
      arrange(sections.values(), start);
      return screen;
    };
    const hudKey = (s) => hudGuis(s).map((g) => g.name).join(",");
    const huds = new Map();
    const hudFor = async (snap) => {
      const key = hudKey(snap);
      if (!huds.has(key)) {
        const source = shown.find((s) => !openGuis(s).length && hudKey(s) === key) || snap;
        const comp = screenIn("HUD", `${source.label} HUD`, true);
        await buildLayers(comp, source, hudGuis(source));
        huds.set(key, { comp, source });
      }
      return huds.get(key).comp;
    };
    const panelFrame = async (name, snap, gui) => {
      const hud = await hudFor(snap);
      const screen = screenIn(gui.name, name);
      const bg = hud.createInstance();
      screen.appendChild(bg);
      bg.x = 0;
      bg.y = 0;
      bg.name = "HUD (background, not exported)";
      bg.locked = true;
      bg.setPluginData("bg", "1");
      await buildLayers(screen, snap, [gui]);
    };
    sectionFor("HUD");
    const done = new Set();
    for (const s of shown) {
      for (const g of openGuis(s)) {
        await panelFrame(s.label, s, g);
        g.kids.forEach((k) => done.add(g.name + "/" + k.name));
      }
    }
    for (const g of full ? full.guis.filter((g) => isPanelGui(g, full)) : []) {
      for (const k of g.kids) {
        if (done.has(g.name + "/" + k.name)) continue;
        done.add(g.name + "/" + k.name);
        await panelFrame(k.name, full, { ...g, enabled: true, kids: [{ ...k, visible: true }] });
      }
    }
    const sources = new Set([...huds.values()].map((h) => h.source));
    for (const s of shown) {
      if (openGuis(s).length || sources.has(s)) continue;
      await buildLayers(screenIn("Screens", s.label), s, s.guis);
    }
    figma.viewport.scrollAndZoomIntoView([...sections.values()]);
    sendPages();
    const note = ctx.fonts.missing.size ? ` Missing fonts (substituted): ${[...ctx.fonts.missing].join(", ")}.` : "";
    say(`Done: ${ctx.count} layers in ${sections.size} sections.${note}`);
    figma.notify(`Imported ${ctx.count} layers.${note}`);
  } catch (err) {
    say("Import failed: " + (err && err.message ? err.message : err) + (err && err.stack ? "\n" + err.stack : ""));
  }
};

// ---- Figma to Roblox: turns the current page back into snapshots for the Studio plugin's "Import from Figma". ----

const r2 = (v) => Math.round(v * 100) / 100;
const to255 = (c) => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
/** Figma scaleMode back to Roblox ScaleType; CROP keeps Slice when the source was sliced. */
const SCALE_BACK = { FIT: "Fit", FILL: "Crop", TILE: "Tile" };
const X_BACK = { LEFT: "Left", CENTER: "Center", RIGHT: "Right", JUSTIFIED: "Left" };
const Y_BACK = { TOP: "Top", CENTER: "Center", BOTTOM: "Bottom" };
const WEIGHT_BACK = Object.fromEntries(Object.entries(WEIGHTS).map(([k, v]) => [v, Number(k)]));
/** Classes whose text or image properties the Studio builder sets. */
const TEXT_CLASSES = ["TextLabel", "TextButton", "TextBox"];
const IMAGE_CLASSES = ["ImageLabel", "ImageButton"];

/** Comparable form of a paint, rounded so values that went through import compare equal. */
const norm = (p) =>
  JSON.stringify({ t: p.type, c: p.color, o: p.opacity ?? 1, s: p.gradientStops, m: p.gradientTransform }, (k, v) =>
    typeof v === "number" ? Math.round(v * 1000) / 1000 : v,
  );

/** Visible paints of a fills or strokes list, empty when mixed. */
const visiblePaints = (list) => (Array.isArray(list) ? list.filter((p) => p.visible !== false) : []);

/** A UIGradient description from a Figma linear gradient, inverting gradientPaint. */
function toGradient(p) {
  const m = p.gradientTransform;
  const c = m[0][0], s = m[0][1];
  const u = 0.5 - m[0][2], v = 0.5 - m[1][2];
  const op = p.opacity ?? 1;
  const stops = [...p.gradientStops].sort((a, b) => a.position - b.position);
  return {
    colors: stops.map((k) => [r2(k.position), ...to255(k.color)]),
    alphas: stops.map((k) => [r2(k.position), r2(1 - k.color.a * op)]),
    rot: r2((Math.atan2(s, c) * 180) / Math.PI),
    off: [r2(c * u - s * v - 0.5), r2(s * u + c * v - 0.5)],
  };
}

/** Roblox colour, transparency and gradient for paint `p`; returns `src` itself when `p` is what import made of it. */
function fromPaint(p, src) {
  if (src && src.color && norm(p) === norm(paint(src.color, src.a, src.grad))) return src;
  if (p.type === "SOLID") return { color: to255(p.color), a: r2(1 - (p.opacity ?? 1)) };
  if (p.type === "GRADIENT_LINEAR") return { color: [255, 255, 255], a: 0, grad: toGradient(p) };
  return null;
}

/** Unrotated box of `node` in its parent, plus rotation, inverting place(). */
function box(node) {
  const w = node.width, h = node.height;
  const size = (v) => (v <= 0.011 ? 0 : r2(v));
  const [[a, b, tx], [d, e, ty]] = node.relativeTransform;
  const rot = (Math.atan2(d, a) * 180) / Math.PI;
  if (Math.abs(rot) < 0.01) return { x: r2(tx), y: r2(ty), w: size(w), h: size(h) };
  const cx = tx + (a * w + b * h) / 2, cy = ty + (d * w + e * h) / 2;
  return { x: r2(cx - w / 2), y: r2(cy - h / 2), w: size(w), h: size(h), rot: r2(rot) };
}

/** The Roblox font family a Figma family stands for, keeping the source font when import substituted it. */
function robloxFamily(family, src) {
  const tried = src && (FAMILIES[src.font] || [src.font.replace(/([a-z])([A-Z])/g, "$1 $2")]).concat("Inter");
  if (tried && tried.includes(family)) return src.font;
  return Object.keys(FAMILIES).find((k) => FAMILIES[k][0] === family) || family.replace(/\s+/g, "");
}

/** Text, gradient, stroke and padding of TEXT node `t` inside an owner box `w` x `h`; `src` is the imported node. */
function readText(t, w, h, src, warn) {
  const s = src && src.text;
  const font = t.fontName === figma.mixed ? t.getRangeFontName(0, 1) : t.fontName;
  const size = t.fontSize === figma.mixed ? t.getRangeFontSize(0, 1) : t.fontSize;
  if (t.fontName === figma.mixed || t.fontSize === figma.mixed) warn(`mixed text styles in "${t.name}", using the first character's`);
  const style = font.style.replace(/\s*Italic/, "") || "Regular";
  const fill = visiblePaints(t.fills)[0];
  const look = fill ? fromPaint(fill, s && { color: s.color, a: s.a, grad: src.grad }) || { color: [255, 255, 255], a: 0 } : { color: [255, 255, 255], a: 1 };
  const family = robloxFamily(font.family, s);
  const keepWeight = s && family === s.font && (style === "Regular" || WEIGHTS[Math.round(s.weight / 100) * 100] === style);
  const lh = t.lineHeight;
  const text = {
    s: t.characters,
    color: look.color,
    a: look.a,
    size: r2(size),
    font: family,
    weight: keepWeight ? s.weight : WEIGHT_BACK[style] || 400,
    italic: /Italic/.test(font.style),
    xa: X_BACK[t.textAlignHorizontal] || "Center",
    ya: Y_BACK[t.textAlignVertical] || "Center",
    wrap: s && s.s === t.characters ? s.wrap : true,
    lineHeight: lh && lh.unit === "PERCENT" ? r2(lh.value / 100) : s ? s.lineHeight : 1,
  };
  const out = { text, grad: look.grad };
  const stroke = visiblePaints(t.strokes)[0];
  if (stroke) {
    const old = s && s.stroke && { color: s.stroke[0], a: s.stroke[1] };
    const v = fromPaint(stroke, old);
    if (v && v === old && Math.abs(t.strokeWeight - exportUnit) < 0.01) text.stroke = s.stroke;
    else if (v) out.stroke = { color: v.color, a: v.a, grad: v.grad, w: r2(t.strokeWeight), text: true, align: "OUTSIDE" };
  }
  const pad = [r2(t.x), r2(t.y), r2(w - t.x - t.width), r2(h - t.y - t.height)];
  if (pad.some((v) => Math.abs(v) > 0.01)) out.pad = pad;
  return out;
}

/** The exported image of IMAGE paint `p` on `node`; new images go into `images` as PNG bytes keyed "figma:<hash>". */
async function readImage(p, node, src, images) {
  const a = r2(1 - (p.opacity ?? 1));
  const scale = SCALE_BACK[p.scaleMode] || (src && src.image && src.image.scale === "Slice" ? "Slice" : "Stretch");
  if (src && src.image && node.getPluginData("imageHash") === p.imageHash) return { ...src.image, a, scale };
  const id = "figma:" + p.imageHash;
  if (!images[id]) images[id] = await figma.getImageByHash(p.imageHash).getBytesAsync();
  return { id, color: [255, 255, 255], a, scale };
}

/** Exported nodes for Figma layer `node`; groups flatten into their parent, vectors become PNG images. */
async function exportNode(node, images, warn) {
  if (node.type === "GROUP") {
    const out = [];
    for (const k of node.children) out.push(...(await exportNode(k, images, warn)));
    return node.visible ? out : out.map((k) => ({ ...k, visible: false }));
  }
  const src = JSON.parse(node.getPluginData("src") || "null");
  const out = { class: src ? src.class : "Frame", name: node.name, ...box(node), visible: node.visible };
  if ("constraints" in node) {
    if (node.constraints.horizontal !== "MIN") out.cx = node.constraints.horizontal;
    if (node.constraints.vertical !== "MIN") out.cy = node.constraints.vertical;
  }
  if (node.type === "TEXT") {
    const t = readText(node, node.width, node.height, src, warn);
    return [{ ...out, class: "TextLabel", text: t.text, grad: t.grad, strokes: t.stroke && [t.stroke] }];
  }
  if (!["FRAME", "COMPONENT", "INSTANCE", "RECTANGLE", "ELLIPSE"].includes(node.type)) {
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    const id = "figma:" + figma.createImage(bytes).hash;
    images[id] = bytes;
    return [{ ...out, class: "ImageLabel", image: { id, color: [255, 255, 255], a: 0, scale: "Stretch" } }];
  }
  if ("clipsContent" in node && node.clipsContent) out.clip = true;
  const fills = visiblePaints(node.fills);
  const bg = fills.find((p) => p.type === "SOLID" || p.type === "GRADIENT_LINEAR");
  if (bg) {
    const v = fromPaint(bg, src && src.bg && { color: src.bg, a: src.bgA, grad: src.grad });
    if (v) Object.assign(out, { bg: v.color, bgA: v.a, grad: v.grad });
  }
  const img = fills.find((p) => p.type === "IMAGE");
  if (img) out.image = await readImage(img, node, src, images);
  else if (src && src.image && node.getPluginData("image")) out.image = src.image;
  const radius = node.type === "ELLIPSE" ? Math.min(node.width, node.height) / 2 : node.cornerRadius === figma.mixed ? node.topLeftRadius : node.cornerRadius;
  if (radius) out.corner = r2(radius);
  const strokes = [];
  const sp = visiblePaints(node.strokes)[0];
  if (sp) {
    const v = fromPaint(sp, src && (src.strokes || []).find((s) => !s.text));
    const w = node.strokeWeight === figma.mixed ? node.strokeTopWeight : node.strokeWeight;
    if (v) strokes.push({ color: v.color, a: v.a, grad: v.grad, w: r2(w), text: false, align: node.strokeAlign });
  }
  if (node.opacity < 1) {
    if (out.class === "Frame" || out.class === "CanvasGroup") Object.assign(out, { class: "CanvasGroup", group: r2(1 - node.opacity) });
    else warn(`opacity on ${out.class} "${node.name}" has no Roblox equivalent, ignored`);
  }
  if (out.image && !IMAGE_CLASSES.includes(out.class)) out.class = "ImageLabel";
  const children = "children" in node ? node.children : [];
  const own = children.find((k) => k.type === "TEXT");
  const kids = [];
  if (own) {
    const t = readText(own, node.width, node.height, src, warn);
    if (IMAGE_CLASSES.includes(out.class) || !TEXT_CLASSES.includes(out.class) && out.class !== "Frame") {
      kids.push({ class: "TextLabel", name: own.name, x: 0, y: 0, w: out.w, h: out.h, visible: own.visible, text: t.text, pad: t.pad, grad: t.grad, strokes: t.stroke && [t.stroke] });
    } else {
      out.class = TEXT_CLASSES.includes(out.class) ? out.class : "TextLabel";
      Object.assign(out, { text: t.text, pad: t.pad });
      if (t.grad && !out.grad) out.grad = t.grad;
      if (t.stroke) strokes.push(t.stroke);
      if (!own.visible) out.text.a = 1;
    }
  } else if (src && src.strokes) strokes.push(...src.strokes.filter((k) => k.text));
  if (!out.grad && !bg && src && src.grad) out.grad = src.grad;
  if (strokes.length) out.strokes = strokes;
  for (const k of children) if (k !== own) kids.push(...(await exportNode(k, images, warn)));
  if (kids.length) out.kids = kids;
  return [out];
}

/** A ScreenGui description from a layer frame; `info` is the ScreenGui data import stored on it. */
async function exportGui(layer, info, images, warn) {
  const kids = [];
  for (const k of layer.children) if (!isBackground(k)) kids.push(...(await exportNode(k, images, warn)));
  return { name: info.name, enabled: layer.visible && info.enabled !== false, order: info.order || 0, x: r2(layer.x), y: r2(layer.y), kids };
}

/** Screen pixels per design unit in the frame being exported, saved on it at import; 1 for frames drawn by hand. */
let exportUnit = 1;

/** The locked HUD instance import puts behind each panel; reference only, never exported. */
const isBackground = (node) => node.getPluginData("bg") === "1";

/** Divides every length in exported node `n` by `unit`, turning screen pixels back into the game's design units. */
function toDesignUnits(n, unit) {
  for (const f of ["x", "y", "w", "h", "corner"]) if (n[f] != null) n[f] = r2(n[f] / unit);
  if (n.text) n.text = { ...n.text, size: r2(n.text.size / unit) };
  if (n.pad) n.pad = n.pad.map((v) => r2(v / unit));
  if (n.strokes) n.strokes = n.strokes.map((s) => ({ ...s, w: r2(s.w / unit) }));
  if (n.kids) n.kids.forEach((k) => toDesignUnits(k, unit));
}

/** Screen frames among `nodes`: frames and components themselves, plus the ones inside sections. */
const screensIn = (nodes) =>
  nodes.flatMap((n) => (n.type === "SECTION" ? screensIn(n.children) : n.type === "FRAME" || n.type === "COMPONENT" ? [n] : []));

/** Serialises the selected screen frames (or every frame in selected sections), else every one on the current page,
 * and hands them to the UI to post. */
async function exportPage() {
  try {
    const warnings = new Set();
    const warn = (w) => warnings.add(w);
    const images = {};
    const snapshots = [];
    const all = screensIn(figma.currentPage.children);
    const picked = screensIn(figma.currentPage.selection).filter((n) => all.includes(n));
    for (const screen of picked.length ? picked : all) {
      say(`Exporting "${screen.name}"...`);
      exportUnit = Number(screen.getPluginData("unit")) || 1;
      const reference = JSON.parse(screen.getPluginData("reference") || "null");
      const guis = [];
      const own = screen.children.filter((k) => !isBackground(k));
      const layers = own.filter((k) => k.type === "FRAME" && k.getPluginData("gui"));
      if (layers.length && layers.length === own.length) {
        for (const layer of layers) guis.push(await exportGui(layer, JSON.parse(layer.getPluginData("gui")), images, warn));
      } else {
        if (layers.length) warn(`"${screen.name}" has layers outside its ScreenGui frames, so it exports as one ScreenGui`);
        guis.push({ ...(await exportGui(screen, { name: screen.name }, images, warn)), x: 0, y: 0 });
      }
      guis.forEach((g) => toDesignUnits(g, exportUnit));
      snapshots.push({ label: screen.name, reference, width: r2(screen.width / exportUnit), height: r2(screen.height / exportUnit), guis });
    }
    exportUnit = 1;
    if (!snapshots.length) return say("Nothing to export: this page has no top-level frames.");
    figma.ui.postMessage({ upload: { snapshots, images }, warnings: [...warnings] });
  } catch (err) {
    say("Export failed: " + (err && err.message ? err.message : err));
  }
}
