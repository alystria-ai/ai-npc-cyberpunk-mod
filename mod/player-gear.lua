-- What V is wearing and carrying, for mod conversations (docs/PLAYER_GEAR_CONTEXT.md).
-- Read-only and on demand: the snapshot is read when a conversation turn is built and reused for MAX_AGE seconds,
-- never per frame. Every native call is guarded; a failure drops that item (or the whole snapshot), never the turn.
-- It hands plain strings to the bridge, which words them (bridge/player-gear.mjs).
local M = {}
M.MAX_AGE, M.MAX_NAME = 5, 60
-- {id sent to the bridge, gamedataEquipmentArea}. Clothing is read as the VISIBLE item (the wardrobe outfit or
-- transmog if one is active, else what is equipped): that is what a person looking at V sees.
M.CLOTHING = {{'head', 'Head'}, {'face', 'Face'}, {'outerTorso', 'OuterChest'}, {'innerTorso', 'InnerChest'},
    {'legs', 'Legs'}, {'feet', 'Feet'}, {'outfit', 'Outfit'}}
-- Cyberware is read from its first slot (the implant itself; a second eye slot holds a mod or faceplate).
M.CYBERWARE = {{'arms', 'ArmsCW'}, {'eyes', 'EyesCW'}, {'os', 'SystemReplacementCW'}}
M.WEAPON_SLOTS = 3
M.AREAS = {}
for _, row in ipairs(M.CLOTHING) do M.AREAS[row[2]] = true end

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:match('^LocKey#') then return nil end
    if #text > limit then
        -- Cut on a UTF-8 boundary, never inside a character.
        local cut = limit - 3
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut) .. '...'
    end
    return text
end

-- The name of a CET enum value ('OuterChest'), whatever way the binding hands it over.
local function enumName(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    local ok, name = pcall(function() return value.value end)
    if ok and type(name) == 'string' then return name end
    return tostring(value)
end

-- A failure message for the log: without the script position, on one line, bounded.
local function failure(err) return (tostring(err):gsub('^[^:]*:%d+: ', ''):gsub('%s+', ' '):sub(1, 90)) end

-- Default native adapter. Every call is guarded by the caller; tests replace it.
local function nativeAdapter()
    local N = {}
    function N.player() return Game.GetPlayer() end
    function N.ready(player)
        return player ~= nil and player:IsAttached() and not player:IsDeadNoStatPool() and not player:IsReplacer()
    end
    function N.data(player)
        return Game.GetScriptableSystemsContainer():Get(CName.new('EquipmentSystem')):GetPlayerData(player)
    end
    function N.area(name) return Enum.new('gamedataEquipmentArea', name) end
    function N.visual(data, area) return data:GetVisualItemInSlot(area) end
    function N.equipped(data, area, index) return data:GetItemInEquipSlot(area, index) end
    -- The weapon actually in V's hands now; bare fists are not a weapon.
    function N.hand(player)
        local weapon = ScriptedPuppet.GetActiveWeapon(player)
        if not weapon then return nil end
        local id = weapon:GetItemID()
        if WeaponObject.IsFists(id) then return nil end
        return id
    end
    -- The game's own Wardrobe (patch 2.0+, docs/PLAYER_GEAR_CONTEXT.md). Signatures read from the compiled final.redscripts of 2.31 and 2.5:
    -- EquipmentSystemPlayerData.GetActiveWardrobeSet() and WardrobeSystem.GetActiveClothingSet() -> ref<ClothingSet> {setID: gameWardrobeClothingSetIndex,
    -- clothingList: array<SSlotVisualInfo {areaType: gamedataEquipmentArea, visualItem: ItemID, isHidden: Bool}>}; GameInstance.GetWardrobeSystem(game) ->
    -- ref<WardrobeSystem>; EquipmentSystemPlayerData.IsWardrobeEnabled() -> Bool; EquipmentSystem.GetActiveWardrobeSet(player) is STATIC.
    -- Routes are tried in order until one returns a set; each failure is reported (its name and message), never swallowed.
    N.wardrobeRoutes = {
        {'data:GetActiveWardrobeSet', function(_, data) return data:GetActiveWardrobeSet() end},
        {'Game.GetWardrobeSystem', function() return Game.GetWardrobeSystem():GetActiveClothingSet() end},
        {'GameInstance.GetWardrobeSystem', function(player) return GameInstance.GetWardrobeSystem(player:GetGame()):GetActiveClothingSet() end},
        {'EquipmentSystem.GetActiveWardrobeSet', function(player) return EquipmentSystem.GetActiveWardrobeSet(player) end}}
    function N.wardrobeEnabled(data) return data:IsWardrobeEnabled() end
    -- The per-slot visual overrides the Wardrobe menu writes (an outfit applied there fills these; the set routes above can answer "none" while it is on):
    -- EquipmentSystemPlayerData.m_clothingVisualsInfo: array<SSlotVisualInfo> (a field, read first: it also says which slots are hidden), and the getter
    -- GetSlotOverridenVisualItem(area) -> ItemID (an empty ItemID: no override). Both compiler-checked against final.redscripts (docs/PLAYER_GEAR_CONTEXT.md).
    function N.visualsInfo(data)
        local entries = {}
        for _, entry in ipairs(data.m_clothingVisualsInfo or {}) do
            local row = {id = entry.visualItem}
            pcall(function() row.area = enumName(entry.areaType) end)
            pcall(function() row.hidden = entry.isHidden == true end)
            entries[#entries + 1] = row
        end
        return entries
    end
    function N.overridden(data, areaName) return data:GetSlotOverridenVisualItem(Enum.new('gamedataEquipmentArea', areaName)) end
    -- {label = <set index name>, entries = {{id = ItemID, area = <equipment area name or nil>, hidden = bool}, ...}}
    function N.wardrobeContents(set)
        local label = enumName(set.setID)
        local entries = {}
        for _, entry in ipairs(set.clothingList or {}) do
            local row = {id = entry.visualItem}
            pcall(function() row.area = enumName(entry.areaType) end)
            pcall(function() row.hidden = entry.isHidden == true end)
            entries[#entries + 1] = row
        end
        return {label = label, entries = entries}
    end
    -- The equipment area name ('Head', 'OuterChest', ...) an item belongs to, from its record.
    function N.itemArea(id)
        local record = TweakDBInterface.GetItemRecord(ItemID.GetTDBID(id))
        if not record then return nil end
        return enumName(record:EquipArea():Type())
    end
    function N.valid(id) return id ~= nil and ItemID.IsValid(id) end
    function N.name(id, player)
        local record = TweakDBInterface.GetItemRecord(ItemID.GetTDBID(id))
        if not record then return nil end
        local ok, text = pcall(function() return Game.GetLocalizedTextByKey(record:DisplayName()) end)
        if ok and type(text) == 'string' and text:find('%S') then return text end
        -- The inventory's own naming (iconic items); needs the item's data.
        return UIItemsHelper.GetItemName(record, Game.GetTransactionSystem():GetItemData(player, id))
    end
    return N
end

local Instance = {}
Instance.__index = Instance

-- options: now() (seconds), enabled(), log(line) (one line per real read, never per frame), native (adapter override),
-- outfit(player) (the visible outfit of a wardrobe mod or nil, set by init.lua).
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil, lastWardrobe = nil}, Instance)
end

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a = pcall(fn, ...)
    if ok then return a end
    return nil
end

function Instance:now()
    local value = self.options.now and self.options.now() or os.time()
    return type(value) == 'number' and value or os.time()
end

function Instance:reset(reason)
    self.snapshot, self.at, self.resetReason = nil, nil, reason
end

-- One item's display name, or nil for an empty slot or an unnamed (internal) item.
function Instance:itemName(id, player)
    local N = self.native
    if not call(N.valid, id) then return nil end
    return clean(call(N.name, id, player), M.MAX_NAME)
end

-- One diagnostic line per change of the wardrobe answer (probe.log), so a live run shows which path ran or why it failed.
function Instance:logWardrobe(line)
    if line == self.lastWardrobe then return end
    self.lastWardrobe = line
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- The game's active Wardrobe set as {areaName = item name, or false for a slot the set hides}; empty when no set is active or none could be read.
-- Routes are tried in order (N.wardrobeRoutes) until one returns a set. Nothing is swallowed: the log line says off (a route answered, no set),
-- the set (and the route that gave it), or error(<call>: <message>) when every route failed.
function Instance:wardrobe(player, data)
    local N, covered, errors, answered, set, via = self.native, {}, {}, false, nil, nil
    local function try(label, fn, ...)
        local ok, value = pcall(fn, ...)
        if not ok then errors[#errors + 1] = label .. ': ' .. failure(value) end
        return ok, value
    end
    -- A line that also names the calls that failed on the way (a later route may still have answered).
    local function finish(line)
        self:logWardrobe(#errors > 0 and (line .. ' errors=' .. table.concat(errors, '; '):sub(1, 200)) or line)
        return covered
    end
    -- Place rows {id, area, hidden} into covered (a slot's first row wins); returns shown, hidden, unplaced.
    local function place(entries)
        local shown, hidden, unplaced = 0, 0, 0
        for _, entry in ipairs(entries or {}) do
            local areaName = entry.area
            if not areaName or not M.AREAS[areaName] then
                -- The row's own area is unreadable or not clothing: place the item by its record instead.
                areaName = entry.id ~= nil and call(N.itemArea, entry.id) or nil
            end
            if areaName and M.AREAS[areaName] and covered[areaName] == nil then
                if entry.hidden then
                    covered[areaName] = false; hidden = hidden + 1
                else
                    local name = self:itemName(entry.id, player)
                    if name then covered[areaName] = name; shown = shown + 1 else unplaced = unplaced + 1 end
                end
            else
                unplaced = unplaced + 1
            end
        end
        return shown, hidden, unplaced
    end
    -- The set routes: returns the line to log (and true when every route failed). Fills covered when the set places anything.
    local function fromSet()
        if type(N.wardrobeRoutes) ~= 'table' or type(N.wardrobeContents) ~= 'function' then return 'wardrobe outfit=off' end
        for _, route in ipairs(N.wardrobeRoutes) do
            local ok, value = try(route[1], route[2], player, data)
            if ok then answered = true end
            if ok and value ~= nil then set, via = value, route[1]; break end
        end
        if set == nil then
            if answered then return 'wardrobe outfit=off' end
            return 'wardrobe outfit=error(' .. table.concat(errors, '; '):sub(1, 200) .. ')', true
        end
        local ok, contents = try('wardrobeContents', N.wardrobeContents, set)
        if not ok or type(contents) ~= 'table' then
            return 'wardrobe outfit=error(' .. table.concat(errors, '; '):sub(1, 200) .. ')', true
        end
        local label = tostring(contents.label or 'active')
        if label == 'INVALID' then return 'wardrobe outfit=off' end
        local shown, hidden, unplaced = place(contents.entries)
        if shown + hidden == 0 then
            covered = {}
            return 'wardrobe outfit=' .. label .. ' items=0 unplaced=' .. unplaced .. ' via=' .. via
        end
        return 'wardrobe outfit=' .. label .. ' items=' .. shown .. (hidden > 0 and (' hidden=' .. hidden) or '') .. ' via=' .. via
    end
    -- The per-slot visual overrides of the player data: the field first (it also carries hidden slots), then the getter per clothing area.
    -- Returns the log line when it placed something, else nil (nothing overridden, or neither read worked: the failure is in errors).
    local function fromVisuals()
        if type(N.visualsInfo) == 'function' then
            local ok, rows = try('m_clothingVisualsInfo', N.visualsInfo, data)
            if ok and type(rows) == 'table' then
                local shown, hidden = place(rows)
                if shown + hidden > 0 then
                    return 'wardrobe outfit=visuals items=' .. shown .. (hidden > 0 and (' hidden=' .. hidden) or '') .. ' via=m_clothingVisualsInfo'
                end
                covered = {}
            end
        end
        if type(N.overridden) == 'function' then
            local rows, failed = {}, nil
            for _, row in ipairs(M.CLOTHING) do
                local ok, id = pcall(N.overridden, data, row[2])
                if ok then rows[#rows + 1] = {id = id, area = row[2]} elseif not failed then failed = failure(id) end
            end
            if failed then errors[#errors + 1] = 'GetSlotOverridenVisualItem: ' .. failed end
            local shown = place(rows)
            if shown > 0 then return 'wardrobe outfit=visuals items=' .. shown .. ' via=GetSlotOverridenVisualItem' end
            covered = {}
        end
        return nil
    end
    if type(N.wardrobeEnabled) == 'function' then
        local ok, enabled = try('IsWardrobeEnabled', N.wardrobeEnabled, data)
        if ok and enabled == false then return finish('wardrobe outfit=off (disabled)') end
    end
    local line, failed = fromSet()
    if next(covered) ~= nil then return finish(line) end
    local visuals = fromVisuals()
    if visuals then return finish(visuals) end
    if failed then self:logWardrobe(line); return covered end
    return finish(line)
end

function Instance:read()
    local N = self.native
    local player = call(N.player)
    if not player or not call(N.ready, player) then return nil, 'V is not ready (loading, dead or in a flashback)' end
    local data = call(N.data, player)
    if data == nil then return nil, 'the equipment data could not be read' end
    local snapshot, count = {version = 1, status = 'ready'}, 0
    local function add(list, slot, name)
        if not name then return end
        snapshot[list] = snapshot[list] or {}
        local rows = snapshot[list]
        rows[#rows + 1] = {slot = slot, name = name}
        count = count + 1
    end
    -- A wardrobe mod's active outfit (options.outfit, mod/equipment-ex.lua; only while Settings > Dynamic info > Other mods' state is on) hides the
    -- equipped clothes: what it shows replaces them, and an outfit that shows nothing means V visibly wears nothing. No answer: the equipment as ever.
    local outfit = self.options.outfit and call(self.options.outfit, player) or nil
    if type(outfit) == 'table' and type(outfit.parts) == 'table' then
        snapshot.layered = true
        for _, part in ipairs(outfit.parts) do add('clothing', part.slot, self:itemName(part.id, player)) end
    else
        -- The game's own Wardrobe: an active saved set shows its items on V; a slot the set does not cover keeps the visible/equipped item.
        local covered = self:wardrobe(player, data)
        for _, row in ipairs(M.CLOTHING) do
            if covered[row[2]] ~= nil then
                add('clothing', row[1], covered[row[2]] or nil)
            else
                local area = call(N.area, row[2])
                if area ~= nil then
                    local id = call(N.visual, data, area)
                    if not call(N.valid, id) then id = call(N.equipped, data, area, 0) end
                    add('clothing', row[1], self:itemName(id, player))
                end
            end
        end
    end
    add('weapons', 'hand', self:itemName(call(N.hand, player), player))
    local weaponArea = call(N.area, 'Weapon')
    if weaponArea ~= nil then
        for index = 0, M.WEAPON_SLOTS - 1 do
            add('weapons', 'slot' .. (index + 1), self:itemName(call(N.equipped, data, weaponArea, index), player))
        end
    end
    for _, row in ipairs(M.CYBERWARE) do
        local area = call(N.area, row[2])
        if area ~= nil then add('cyberware', row[1], self:itemName(call(N.equipped, data, area, 0), player)) end
    end
    if count == 0 then return nil, 'no named items found' end
    return snapshot, count
end

-- The snapshot for this turn, or nil. Reused for MAX_AGE seconds so a burst of turns (a group round, a prefetch,
-- a voice start and finish) reads the game once. A failed or empty read is not cached: the next turn tries again.
function Instance:capture()
    if self.options.enabled then
        local ok, enabled = pcall(self.options.enabled)
        if not ok or enabled ~= true then return nil end
    end
    local now = self:now()
    if self.snapshot and self.at and now >= self.at and now - self.at < M.MAX_AGE then return self.snapshot end
    local ok, snapshot, detail = pcall(self.read, self)
    -- One diagnostic line per real read (a turn, at most once per window), so a test shows what the adapter built.
    if type(self.options.log) == 'function' then
        pcall(self.options.log, (ok and snapshot) and ('Player gear: ' .. tostring(detail) .. ' items')
            or ('Player gear: none (' .. tostring(ok and detail or snapshot):sub(1, 160) .. ')'))
    end
    if not ok or not snapshot then self.snapshot, self.at = nil, nil; return nil end
    self.snapshot, self.at = snapshot, now
    return snapshot
end

return M
