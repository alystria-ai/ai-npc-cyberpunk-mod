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
    -- The game's own Wardrobe (patch 2.0+, docs/PLAYER_GEAR_CONTEXT.md): the active saved clothing set, or nil. The scripted WardrobeSystem
    -- (Game.GetWardrobeSystem()) answers GetActiveClothingSet() -> ClothingSet {setID, clothingList = array of {slotID, visualItem}}; the equipment
    -- system's GetActiveWardrobeSet(V) is the second route. Returns {label = <set index text>, items = {ItemID, ...}}.
    function N.wardrobeSet(player)
        local set
        local ok, system = pcall(function() return Game.GetWardrobeSystem() end)
        if ok and system ~= nil then
            local got, value = pcall(function() return system:GetActiveClothingSet() end)
            if got then set = value end
        end
        if set == nil then
            local got, value = pcall(function() return Game.GetScriptableSystemsContainer():Get(CName.new('EquipmentSystem')):GetActiveWardrobeSet(player) end)
            if got then set = value end
        end
        if set == nil then return nil end
        local items = {}
        for _, entry in ipairs(set.clothingList or {}) do
            if entry.visualItem ~= nil and ItemID.IsValid(entry.visualItem) then items[#items + 1] = entry.visualItem end
        end
        local label
        pcall(function() label = tostring(set.setID.value or set.setID) end)
        return {label = label, items = items}
    end
    -- The equipment area name ('Head', 'OuterChest', ...) an item belongs to, from its record.
    function N.itemArea(id)
        local record = TweakDBInterface.GetItemRecord(ItemID.GetTDBID(id))
        if not record then return nil end
        local kind = record:EquipArea():Type()
        for _, row in ipairs(M.CLOTHING) do
            if kind == Enum.new('gamedataEquipmentArea', row[2]) then return row[2] end
        end
        return tostring(kind.value or kind)
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
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil, lastWardrobe = 'wardrobe outfit=off'}, Instance)
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
        local set = call(N.wardrobeSet, player)
        local covered, found = {}, nil
        if type(set) == 'table' and type(set.items) == 'table' then
            found = {}
            for _, id in ipairs(set.items) do
                local areaName = call(N.itemArea, id)
                local name = self:itemName(id, player)
                if name and areaName then
                    for _, row in ipairs(M.CLOTHING) do
                        if row[2] == areaName and not covered[areaName] then covered[areaName] = true; found[#found + 1] = {row[1], name} end
                    end
                end
            end
            if #found == 0 then found, covered = nil, {} end
        end
        for _, row in ipairs(M.CLOTHING) do
            if covered[row[2]] then
                for _, item in ipairs(found) do if item[1] == row[1] then add('clothing', row[1], item[2]) end end
            else
                local area = call(N.area, row[2])
                if area ~= nil then
                    local id = call(N.visual, data, area)
                    if not call(N.valid, id) then id = call(N.equipped, data, area, 0) end
                    add('clothing', row[1], self:itemName(id, player))
                end
            end
        end
        local line = found and ('wardrobe outfit=' .. tostring(set.label or 'active') .. ' items=' .. #found) or 'wardrobe outfit=off'
        if line ~= self.lastWardrobe then
            self.lastWardrobe = line
            if type(self.options.log) == 'function' then pcall(self.options.log, line) end
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
