--!strict
-- Builds Roblox UI from pages sent back by the Figma plugin (the same JSON shape FigRo.server writes): one ScreenGui per
-- Figma screen frame under StarterGui, one Frame per original ScreenGui inside it, and one GuiObject per layer with its
-- fills, corners, strokes, gradients, text and images. Coordinates are design units; snapshots with a
-- reference size scale by an AutoScale UIScale, as the game's own guis do.

local StarterGui = game:GetService("StarterGui")
local TextService = game:GetService("TextService")

--- Classes a Figma layer may become; anything else falls back to Frame.
local CLASSES = {
	Frame = true, CanvasGroup = true, ScrollingFrame = true, ViewportFrame = true,
	TextLabel = true, TextButton = true, TextBox = true, ImageLabel = true, ImageButton = true,
}

type Json = { [string]: any }

local FigmaImport = {}

--- A Color3 from 0-255 integers.
local function color(c: { number }): Color3
	return Color3.fromRGB(c[1], c[2], c[3])
end

--- The enum item named `name`, or `fallback` when the name is missing or unknown.
local function enum<T>(list: any, name: string?, fallback: T): T
	local ok, item = pcall(function()
		return list[name]
	end)
	return if ok and item then item else fallback
end

--- Keypoints sorted and pinned to times 0 and 1, which sequences require; `make` builds one from a key row.
local function keypoints(keys: { { number } }, make: (number, { number }) -> any): { any }
	table.sort(keys, function(a, b)
		return a[1] < b[1]
	end)
	local out = {}
	for i, k in keys do
		local t = math.clamp(k[1], 0, 1)
		if i == 1 then
			t = 0
		elseif i == #keys then
			t = 1
		elseif t <= out[#out].Time then
			continue
		end
		table.insert(out, make(t, k))
	end
	if #out == 1 then
		table.insert(out, make(1, keys[1]))
	end
	return out
end

--- A UIGradient from an exported gradient description.
local function gradient(g: Json, parent: Instance)
	local ui = Instance.new("UIGradient")
	ui.Color = ColorSequence.new(keypoints(g.colors, function(t, k)
		return ColorSequenceKeypoint.new(t, Color3.fromRGB(k[2], k[3], k[4]))
	end))
	ui.Transparency = NumberSequence.new(keypoints(g.alphas, function(t, k)
		return NumberSequenceKeypoint.new(t, math.clamp(k[2], 0, 1))
	end))
	ui.Rotation = g.rot or 0
	ui.Offset = Vector2.new(g.off and g.off[1] or 0, g.off and g.off[2] or 0)
	ui.Parent = parent
end

--- Position, size and anchor on one axis from a Figma constraint, so the layer follows its parent like in Figma.
local function axis(mode: string?, pos: number, len: number, full: number): (UDim, UDim, number)
	if mode == "MAX" then
		return UDim.new(1, pos + len - full), UDim.new(0, len), 1
	elseif mode == "CENTER" then
		return UDim.new(0.5, pos + len / 2 - full / 2), UDim.new(0, len), 0.5
	elseif mode == "STRETCH" then
		return UDim.new(0, pos), UDim.new(1, len - full), 0
	elseif mode == "SCALE" and full > 0 then
		return UDim.new(pos / full, 0), UDim.new(len / full, 0), 0
	end
	return UDim.new(0, pos), UDim.new(0, len), 0
end

--- How much wider than its box a label's one-line text may measure and still count as one line.
local ONE_LINE_SLACK = 1.2
--- Measured one-line text widths, keyed by text, font and size; shadow copies repeat the same text.
local widths: { [string]: number } = {}

--- Width of `s` on a single line, or infinity when it can't be measured so the label keeps wrapping.
local function lineWidth(s: string, font: Font, size: number): number
	local key = `{s}\0{font.Family}\0{font.Weight.Value}\0{size}`
	local width = widths[key]
	if not width then
		local params = Instance.new("GetTextBoundsParams")
		params.Text = s
		params.Font = font
		params.Size = size
		params.Width = math.huge
		local ok, bounds = pcall(TextService.GetTextBoundsAsync, TextService, params)
		width = if ok then bounds.X else math.huge
		widths[key] = width
	end
	return width
end

--- Applies the exported text of `n` to `obj`, a TextLabel, TextButton or TextBox.
local function applyText(obj: any, n: Json)
	local t = n.text
	obj.Text = ""
	if not t then
		return
	end
	if obj:IsA("TextBox") then
		obj.PlaceholderText = t.s
		obj.PlaceholderColor3 = color(t.color)
	else
		obj.Text = t.s
	end
	obj.TextColor3 = color(t.color)
	obj.TextTransparency = t.a
	obj.TextSize = t.size
	local weight = Enum.FontWeight.Regular
	pcall(function()
		weight = Enum.FontWeight:FromValue(math.round(t.weight / 100) * 100) or weight
	end)
	obj.FontFace = Font.new(
		`rbxasset://fonts/families/{t.font}.json`,
		weight,
		if t.italic then Enum.FontStyle.Italic else Enum.FontStyle.Normal
	)
	obj.TextXAlignment = enum(Enum.TextXAlignment, t.xa, Enum.TextXAlignment.Center)
	obj.TextYAlignment = enum(Enum.TextYAlignment, t.ya, Enum.TextYAlignment.Center)
	obj.LineHeight = t.lineHeight or 1
	-- Auto-sized labels export at their in-play text width, up to ~10% under the measured one (pixel snapping at the
	-- play scale), so wrapping them would split one word; text that really wrapped is far wider than its box.
	obj.TextWrapped = t.wrap ~= false and lineWidth(t.s, obj.FontFace, t.size) > n.w * ONE_LINE_SLACK
	if t.stroke then
		obj.TextStrokeColor3 = color(t.stroke[1])
		obj.TextStrokeTransparency = t.stroke[2]
	end
	if n.pad then
		local pad = Instance.new("UIPadding")
		pad.PaddingLeft = UDim.new(0, n.pad[1])
		pad.PaddingTop = UDim.new(0, n.pad[2])
		pad.PaddingRight = UDim.new(0, n.pad[3])
		pad.PaddingBottom = UDim.new(0, n.pad[4])
		pad.Parent = obj
	end
end

--- Applies the exported image of `n` to `obj`; images drawn in Figma have no asset id yet and are listed in `missing`.
local function applyImage(obj: any, n: Json, files: Json, missing: { string })
	local img = n.image
	if not img then
		return
	end
	if string.sub(img.id, 1, 6) == "figma:" then
		obj:SetAttribute("FigmaImage", files[img.id] or img.id)
		table.insert(missing, obj:GetFullName())
	else
		obj.Image = img.id
	end
	obj.ImageColor3 = color(img.color or { 255, 255, 255 })
	obj.ImageTransparency = img.a or 0
	obj.ScaleType = enum(Enum.ScaleType, img.scale, Enum.ScaleType.Stretch)
	if img.rect then
		obj.ImageRectOffset = Vector2.new(img.rect[1], img.rect[2])
		obj.ImageRectSize = Vector2.new(img.rect[3], img.rect[4])
	end
	if img.slice then
		obj.SliceCenter = Rect.new(img.slice[1], img.slice[2], img.slice[3], img.slice[4])
		obj.SliceScale = img.slice[5]
	end
end

--- A UIStroke from an exported stroke.
local function stroke(s: Json, parent: Instance)
	local ui = Instance.new("UIStroke")
	ui.Color = color(s.color)
	ui.Transparency = s.a
	ui.Thickness = s.w
	ui.ApplyStrokeMode = if s.text then Enum.ApplyStrokeMode.Contextual else Enum.ApplyStrokeMode.Border
	pcall(function()
		(ui :: any).BorderStrokePosition = if s.align == "INSIDE"
			then Enum.BorderStrokePosition.Inner
			elseif s.align == "CENTER" then Enum.BorderStrokePosition.Center
			else Enum.BorderStrokePosition.Outer
	end)
	if s.grad then
		gradient(s.grad, ui)
	end
	ui.Parent = parent
end

--- Padding of a node without a UIPadding.
local NO_PAD = { 0, 0, 0, 0 }

--- Builds the GuiObject for exported node `n` (z is its draw order) inside a parent whose content box is `pw` x `ph`
--- and starts `ox`, `oy` into the parent (its UIPadding, which Roblox also applies to children).
local function build(
	n: Json,
	z: number,
	pw: number,
	ph: number,
	ox: number,
	oy: number,
	parent: Instance,
	files: Json,
	missing: { string }
)
	local class = if CLASSES[n.class] then n.class else "Frame"
	local obj = Instance.new(class) :: any
	obj.Name = n.name
	local px, sx, ax = axis(n.cx, n.x - ox, n.w, pw)
	local py, sy, ay = axis(n.cy, n.y - oy, n.h, ph)
	obj.AnchorPoint = Vector2.new(ax, ay)
	obj.Position = UDim2.new(px, py)
	obj.Size = UDim2.new(sx, sy)
	obj.Rotation = n.rot or 0
	obj.Visible = n.visible ~= false
	obj.ZIndex = z
	obj.ClipsDescendants = n.clip == true
	obj.BorderSizePixel = 0
	if n.bg then
		obj.BackgroundColor3 = color(n.bg)
		obj.BackgroundTransparency = n.bgA
	else
		obj.BackgroundTransparency = 1
	end
	if class == "CanvasGroup" then
		obj.GroupTransparency = n.group or 0
	end
	if n.grad then
		gradient(n.grad, obj)
	end
	if n.corner then
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, n.corner)
		corner.Parent = obj
	end
	for _, s in n.strokes or {} do
		stroke(s, obj)
	end
	local pad = NO_PAD
	if obj:IsA("TextLabel") or obj:IsA("TextButton") or obj:IsA("TextBox") then
		applyText(obj, n)
		pad = n.pad or NO_PAD
	elseif obj:IsA("ImageLabel") or obj:IsA("ImageButton") then
		applyImage(obj, n, files, missing)
	end
	local bottom, right = 0, 0
	for i, k in n.kids or {} do
		build(k, i, n.w - pad[1] - pad[3], n.h - pad[2] - pad[4], pad[1], pad[2], obj, files, missing)
		right = math.max(right, k.x + k.w)
		bottom = math.max(bottom, k.y + k.h)
	end
	if class == "ScrollingFrame" then
		obj.CanvasSize = UDim2.fromOffset(right, bottom)
	end
	obj.Parent = parent
end

--- Scales `gui` to fit `reference` (the viewport size the game lays its UI out at) in the viewport, as the game's own
--- AutoScale does in play, so the Edit viewport shows the design at its real size.
local function autoScale(gui: ScreenGui, reference: Vector2)
	local scale = Instance.new("UIScale")
	scale.Name = "AutoScale"
	local camera = workspace.CurrentCamera
	local function fit()
		scale.Scale = math.min(camera.ViewportSize.X / reference.X, camera.ViewportSize.Y / reference.Y)
	end
	fit()
	local conn = camera:GetPropertyChangedSignal("ViewportSize"):Connect(fit)
	scale.Destroying:Connect(function()
		conn:Disconnect()
	end)
	scale.Parent = gui
end

--- Replaces StarterGui's "Figma - <label>" ScreenGui for each snapshot in `data`; returns the built guis and the
--- paths of image layers that still need an uploaded asset id.
function FigmaImport.build(data: Json): ({ ScreenGui }, { string })
	local built, missing = {}, {}
	local files = data.files or {}
	for _, snap in data.snapshots do
		local name = `Figma - {snap.label}`
		local old = StarterGui:FindFirstChild(name)
		if old then
			old:Destroy()
		end
		local gui = Instance.new("ScreenGui")
		gui.Name = name
		gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
		gui.ScreenInsets = Enum.ScreenInsets.None
		gui.IgnoreGuiInset = true
		gui.ResetOnSpawn = false
		if snap.reference then
			autoScale(gui, Vector2.new(snap.reference.x, snap.reference.y))
		end
		local guis = table.clone(snap.guis)
		table.sort(guis, function(a, b)
			return (a.order or 0) < (b.order or 0)
		end)
		for i, g in guis do
			local layer = Instance.new("Frame")
			layer.Name = g.name
			layer.BackgroundTransparency = 1
			layer.Position = UDim2.fromOffset(g.x, g.y)
			layer.Size = UDim2.new(1, -g.x, 1, -g.y)
			layer.ZIndex = i
			layer.Visible = g.enabled ~= false
			for z, k in g.kids do
				build(k, z, snap.width - g.x, snap.height - g.y, 0, 0, layer, files, missing)
			end
			layer.Parent = gui
		end
		gui.Parent = StarterGui
		table.insert(built, gui)
	end
	return built, missing
end

return FigmaImport
