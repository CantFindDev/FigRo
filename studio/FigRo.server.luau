--!strict
-- FigRo: snapshots the live PlayerGui of a playtest client as JSON for the local receiver
-- (receiver.mjs), which the Figma plugin turns into editable layers. Clients can't make HTTP requests,
-- so the client copy of this plugin sends the JSON in chunks over a RemoteEvent that the server copy makes, and the
-- server copy posts it. Trigger with the "Export UI" toolbar button, or from MCP `execute_luau` on the Client:
-- `game.Players.LocalPlayer.PlayerGui:SetAttribute("FigmaExport", "Shop")`, where the value names the snapshot.
-- In Edit mode it adds "Import from Figma", which builds the page last sent from the Figma plugin (FigmaImport.luau);
-- `game.StarterGui:SetAttribute("FigmaImport", true)` does the same from MCP.
-- Per-game settings are optional StarterGui attributes: FigRoReference (Vector2, the viewport size the UI is laid
-- out at when every ScreenGui scales by a UIScale named "AutoScale"), FigRoPanelSuffix (string, ScreenGuis whose
-- names end with it hold panels drawn over the HUD) and FigRoFullSnapshot (string, the snapshot label that keeps
-- hidden panels so ones never captured open still reach Figma).

local GuiService = game:GetService("GuiService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local TextService = game:GetService("TextService")

--- Where receiver.mjs listens.
local URL = "http://localhost:34873/snapshot"
--- The attribute on PlayerGui whose change triggers an export; its string value names the snapshot.
local TRIGGER = "FigmaExport"
--- TextScaled never draws text larger than this.
local MAX_SCALED = 100

--- The relay RemoteEvent's name in ReplicatedStorage.
local RELAY = "FigRoRelay"
--- Characters per relayed chunk, well under the RemoteEvent payload cap.
local CHUNK = 200000

--- Where receiver.mjs serves the last page sent from the Figma plugin.
local FROM_FIGMA = "http://localhost:34873/figma"

if not RunService:IsRunning() then
	local ChangeHistoryService = game:GetService("ChangeHistoryService")
	local FigmaImport = require(script:WaitForChild("FigmaImport")) :: any
	local toolbar = plugin:CreateToolbar("FigRo")
	local button = toolbar:CreateButton("Import from Figma", "Build the page last sent from Figma into StarterGui", "rbxasset://textures/ui/GuiImagePlaceholder.png")
	button.ClickableWhenViewportHidden = true
	--- Fetches the last page sent from Figma and builds it, as one undo step.
	local function import()
		local ok, body = pcall(HttpService.GetAsync, HttpService, FROM_FIGMA, true)
		if not ok then
			warn(`FigRo: nothing to import, is receiver.mjs running and was a page sent from Figma? {body}`)
			return
		end
		local recording = ChangeHistoryService:TryBeginRecording("Import from Figma")
		local okBuild, guis, missing = pcall(function()
			return FigmaImport.build(HttpService:JSONDecode(body))
		end)
		if recording then
			ChangeHistoryService:FinishRecording(recording, if okBuild then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
		end
		if not okBuild then
			warn(`FigRo: import failed: {guis}`)
			return
		end
		local names = {}
		for _, gui in guis do
			table.insert(names, gui.Name)
		end
		print(`FigRo: built {table.concat(names, ", ")} in StarterGui; disable them before playtesting the real UI`)
		if #missing > 0 then
			warn(`FigRo: {#missing} image layer(s) were drawn in Figma and need uploading; their FigmaImage attribute holds the PNG path:\n{table.concat(missing, "\n")}`)
		end
	end
	button.Click:Connect(import)
	-- MCP can't click toolbar buttons, so setting this StarterGui attribute to true imports too.
	StarterGui:GetAttributeChangedSignal("FigmaImport"):Connect(function()
		if StarterGui:GetAttribute("FigmaImport") == true then
			StarterGui:SetAttribute("FigmaImport", nil)
			import()
		end
	end)
	return
end

if RunService:IsServer() then
	local relay = Instance.new("RemoteEvent")
	relay.Name = RELAY
	relay.Archivable = false
	relay.Parent = game:GetService("ReplicatedStorage")
	-- Posts go out one at a time and in order, since HttpService caps each at 1 MB and the receiver joins them.
	local queue: { { any } } = {}
	local busy = false
	relay.OnServerEvent:Connect(function(_, index: number, count: number, part: string)
		table.insert(queue, { index, count, part })
		if busy then
			return
		end
		busy = true
		while #queue > 0 do
			local item = table.remove(queue, 1) :: { any }
			local ok, err = pcall(HttpService.PostAsync, HttpService, `{URL}?i={item[1]}&n={item[2]}`, item[3], Enum.HttpContentType.TextPlain)
			if not ok then
				warn(`FigRo: post failed, is receiver.mjs running? {err}`)
			elseif item[1] == item[2] then
				print("FigRo: snapshot posted")
			end
		end
		busy = false
	end)
	return
end

type Json = { [string]: any }

--- A Color3 as 0-255 integers.
local function rgb(c: Color3): { number }
	return { math.round(c.R * 255), math.round(c.G * 255), math.round(c.B * 255) }
end

--- Numbers rounded to hundredths, keeping the JSON small.
local function r2(n: number): number
	return math.round(n * 100) / 100
end

--- A UIGradient's colour and transparency keypoints, rotation and offset.
local function gradient(g: UIGradient): Json?
	if not g.Enabled then
		return nil
	end
	local colors, alphas = {}, {}
	for _, k in g.Color.Keypoints do
		local c = rgb(k.Value)
		table.insert(colors, { r2(k.Time), c[1], c[2], c[3] })
	end
	for _, k in g.Transparency.Keypoints do
		table.insert(alphas, { r2(k.Time), r2(k.Value) })
	end
	return { colors = colors, alphas = alphas, rot = r2(g.Rotation), off = { r2(g.Offset.X), r2(g.Offset.Y) } }
end

--- The first enabled UIGradient directly under `parent`.
local function gradientOf(parent: Instance): Json?
	for _, child in parent:GetChildren() do
		if child:IsA("UIGradient") then
			local g = gradient(child)
			if g then
				return g
			end
		end
	end
	return nil
end

--- The font family name from a Font's asset path, e.g. "FredokaOne".
local function family(font: Font): string
	return string.match(font.Family, "families/([%w_]+)%.json") or font.Family
end

--- The size TextScaled picks for `label`: the largest that fits its box, found by binary search.
local function scaledSize(label: TextLabel | TextButton | TextBox, box: Vector2): number
	local cap = MAX_SCALED
	local limit = label:FindFirstChildWhichIsA("UITextSizeConstraint")
	if limit then
		cap = limit.MaxTextSize
	end
	local params = Instance.new("GetTextBoundsParams")
	params.Text = label.ContentText
	params.Font = label.FontFace
	params.Width = if label.TextWrapped then box.X else math.huge
	local lo, hi = 1, cap
	while lo < hi do
		local mid = math.ceil((lo + hi) / 2)
		params.Size = mid
		local ok, bounds = pcall(TextService.GetTextBoundsAsync, TextService, params)
		if ok and bounds.X <= box.X + 0.5 and bounds.Y <= box.Y + 0.5 then
			lo = mid
		else
			hi = mid - 1
		end
	end
	return lo
end

local snapshotScale = 1

--- Serialises `obj` and its GuiObject descendants. `origin` is the parent's top-left in viewport pixels and `k`
--- the product of the UIScales above `obj`, so text and strokes come out in design units.
local function node(obj: GuiObject, origin: Vector2, k: number): Json
	local s = snapshotScale
	for _, child in obj:GetChildren() do
		if child:IsA("UIScale") then
			k *= child.Scale
		end
	end
	local abs, size = obj.AbsolutePosition, obj.AbsoluteSize
	local out: Json = {
		class = obj.ClassName,
		name = obj.Name,
		x = r2((abs.X - origin.X) / s),
		y = r2((abs.Y - origin.Y) / s),
		w = r2(size.X / s),
		h = r2(size.Y / s),
		visible = obj.Visible,
		z = obj.ZIndex,
	}
	if obj.Rotation ~= 0 then
		out.rot = r2(obj.Rotation)
	end
	if obj.ClipsDescendants then
		out.clip = true
	end
	if obj.BackgroundTransparency < 1 then
		out.bg = rgb(obj.BackgroundColor3)
		out.bgA = r2(obj.BackgroundTransparency)
	end
	if obj:IsA("CanvasGroup") then
		out.group = r2(obj.GroupTransparency)
	end
	if obj:IsA("ScrollingFrame") or obj:IsA("ViewportFrame") then
		out.clip = true
	end
	out.grad = gradientOf(obj)

	local corner = obj:FindFirstChildWhichIsA("UICorner")
	if corner then
		local px = corner.CornerRadius.Scale * math.min(size.X, size.Y) + corner.CornerRadius.Offset * k
		out.corner = r2(px / s)
	end
	local strokes = {}
	for _, child in obj:GetChildren() do
		if child:IsA("UIStroke") and child.Enabled and child.Transparency < 1 then
			local stroke: Json = {
				color = rgb(child.Color),
				a = r2(child.Transparency),
				w = r2(child.Thickness * k / s),
				text = child.ApplyStrokeMode == Enum.ApplyStrokeMode.Contextual
					and (obj:IsA("TextLabel") or obj:IsA("TextButton") or obj:IsA("TextBox")),
				grad = gradientOf(child),
			}
			local ok, position = pcall(function()
				return (child :: any).BorderStrokePosition
			end)
			stroke.align = if ok and position == Enum.BorderStrokePosition.Inner
				then "INSIDE"
				elseif ok and position == Enum.BorderStrokePosition.Center then "CENTER"
				else "OUTSIDE"
			table.insert(strokes, stroke)
		end
	end
	if #strokes > 0 then
		out.strokes = strokes
	end

	if obj:IsA("TextLabel") or obj:IsA("TextButton") or obj:IsA("TextBox") then
		local text = if obj:IsA("TextBox") and obj.Text == "" then obj.PlaceholderText else obj.ContentText
		if text ~= "" and obj.TextTransparency < 1 then
			local px = if obj.TextScaled then scaledSize(obj, size / k) else obj.TextSize
			out.text = {
				s = text,
				color = rgb(obj.TextColor3),
				a = r2(obj.TextTransparency),
				size = r2(px * k / s),
				font = family(obj.FontFace),
				weight = obj.FontFace.Weight.Value,
				italic = obj.FontFace.Style == Enum.FontStyle.Italic,
				xa = obj.TextXAlignment.Name,
				ya = obj.TextYAlignment.Name,
				wrap = obj.TextWrapped,
				lineHeight = r2(obj.LineHeight),
			}
			local pad = obj:FindFirstChildWhichIsA("UIPadding")
			if pad then
				local function side(u: UDim, length: number): number
					return r2((u.Scale * length + u.Offset * k) / s)
				end
				out.pad = {
					side(pad.PaddingLeft, size.X),
					side(pad.PaddingTop, size.Y),
					side(pad.PaddingRight, size.X),
					side(pad.PaddingBottom, size.Y),
				}
			end
			if obj.TextStrokeTransparency < 1 then
				out.text.stroke = { rgb(obj.TextStrokeColor3), r2(obj.TextStrokeTransparency) }
			end
		end
	elseif obj:IsA("ImageLabel") or obj:IsA("ImageButton") then
		if obj.Image ~= "" and obj.ImageTransparency < 1 then
			out.image = {
				id = obj.Image,
				color = rgb(obj.ImageColor3),
				a = r2(obj.ImageTransparency),
				scale = obj.ScaleType.Name,
			}
			if obj.ImageRectSize ~= Vector2.zero then
				out.image.rect = { obj.ImageRectOffset.X, obj.ImageRectOffset.Y, obj.ImageRectSize.X, obj.ImageRectSize.Y }
			end
			if obj.ScaleType == Enum.ScaleType.Slice then
				local c = obj.SliceCenter
				out.image.slice = { c.Min.X, c.Min.Y, c.Max.X, c.Max.Y, r2(obj.SliceScale * k / s) }
			end
		end
	end

	local kids = {}
	for index, child in obj:GetChildren() do
		if child:IsA("GuiObject") then
			table.insert(kids, { child = child, index = index })
		end
	end
	table.sort(kids, function(a, b)
		if a.child.ZIndex ~= b.child.ZIndex then
			return a.child.ZIndex < b.child.ZIndex
		end
		return a.index < b.index
	end)
	if #kids > 0 then
		out.kids = {}
		for _, entry in kids do
			table.insert(out.kids, node(entry.child, abs, k))
		end
	end
	return out
end

--- Viewport offset of a ScreenGui's origin: guis inside the top bar safe area start below it.
local function guiOrigin(gui: ScreenGui): Vector2
	if gui.ScreenInsets == Enum.ScreenInsets.CoreUISafeInsets or gui.ScreenInsets == Enum.ScreenInsets.TopbarSafeInsets then
		return (GuiService:GetGuiInset())
	end
	return Vector2.zero
end

--- Serialises every ScreenGui in PlayerGui, bottom layer first, in design units.
local function snapshot(label: string): Json
	local playerGui = (Players.LocalPlayer :: Player):WaitForChild("PlayerGui")
	local guis: { ScreenGui } = {}
	for _, child in playerGui:GetChildren() do
		if child:IsA("ScreenGui") then
			table.insert(guis, child)
		end
	end
	table.sort(guis, function(a, b)
		return a.DisplayOrder < b.DisplayOrder
	end)
	snapshotScale = 1
	for _, gui in guis do
		local auto = gui:FindFirstChild("AutoScale")
		if auto and auto:IsA("UIScale") then
			snapshotScale = auto.Scale
			break
		end
	end
	local camera = workspace.CurrentCamera :: Camera
	local out = {}
	for _, gui in guis do
		local origin = guiOrigin(gui)
		local entry: Json = {
			name = gui.Name,
			enabled = gui.Enabled,
			order = gui.DisplayOrder,
			x = r2(origin.X / snapshotScale),
			y = r2(origin.Y / snapshotScale),
			kids = {},
		}
		local scale = 1
		local auto = gui:FindFirstChild("AutoScale")
		if auto and auto:IsA("UIScale") then
			scale = auto.Scale
		end
		local kids = {}
		for index, child in gui:GetChildren() do
			if child:IsA("GuiObject") then
				table.insert(kids, { child = child, index = index })
			end
		end
		table.sort(kids, function(a, b)
			if a.child.ZIndex ~= b.child.ZIndex then
				return a.child.ZIndex < b.child.ZIndex
			end
			return a.index < b.index
		end)
		for _, item in kids do
			table.insert(entry.kids, node(item.child, gui.AbsolutePosition, scale))
		end
		table.insert(out, entry)
	end
	local reference = StarterGui:GetAttribute("FigRoReference")
	local suffix = StarterGui:GetAttribute("FigRoPanelSuffix")
	return {
		label = label,
		place = game.Name,
		reference = if typeof(reference) == "Vector2" then { x = reference.X, y = reference.Y } else nil,
		panelSuffix = if typeof(suffix) == "string" and suffix ~= "" then suffix else nil,
		full = label == StarterGui:GetAttribute("FigRoFullSnapshot"),
		width = r2(camera.ViewportSize.X / snapshotScale),
		height = r2(camera.ViewportSize.Y / snapshotScale),
		guis = out,
	}
end

--- Sends a snapshot to the server copy in chunks and reports the result in the output.
local function export(label: string)
	local ok, err = pcall(function()
		local relay = game:GetService("ReplicatedStorage"):WaitForChild(RELAY, 10) :: RemoteEvent
		assert(relay, "relay RemoteEvent missing, is the plugin running on the server?")
		local body = HttpService:JSONEncode(snapshot(label))
		local pieces = {}
		local start = 1
		while start <= #body do
			local stop = math.min(start + CHUNK - 1, #body)
			-- Never split a UTF-8 character: back off while the next byte is a continuation byte.
			while stop < #body and bit32.band(string.byte(body, stop + 1), 0xC0) == 0x80 do
				stop -= 1
			end
			table.insert(pieces, string.sub(body, start, stop))
			start = stop + 1
		end
		for i, piece in pieces do
			relay:FireServer(i, #pieces, piece)
		end
		print(`FigRo: sent "{label}" ({#body} bytes)`)
	end)
	if not ok then
		warn(`FigRo: export failed: {err}`)
	end
end

local toolbar = plugin:CreateToolbar("FigRo")
local button = toolbar:CreateButton("Export UI", "Send the live UI to the Figma receiver", "rbxasset://textures/ui/GuiImagePlaceholder.png")
button.ClickableWhenViewportHidden = true
button.Click:Connect(function()
	export("Screen " .. os.date("%H%M%S"))
end)

local playerGui = (Players.LocalPlayer :: Player):WaitForChild("PlayerGui")
playerGui:GetAttributeChangedSignal(TRIGGER):Connect(function()
	local label = playerGui:GetAttribute(TRIGGER)
	if typeof(label) == "string" and label ~= "" then
		export(label)
		playerGui:SetAttribute(TRIGGER, nil)
	end
end)
