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

-- options: now() (seconds), enabled(), native (adapter override).
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil}, Instance)
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
    if not player or not call(N.ready, player) then return nil end
    local data = call(N.data, player)
    if data == nil then return nil end
    local snapshot, count = {version = 1, status = 'ready'}, 0
    local function add(list, slot, name)
        if not name then return end
        snapshot[list] = snapshot[list] or {}
        local rows = snapshot[list]
        rows[#rows + 1] = {slot = slot, name = name}
        count = count + 1
    end
    for _, row in ipairs(M.CLOTHING) do
        local area = call(N.area, row[2])
        if area ~= nil then
            local id = call(N.visual, data, area)
            if not call(N.valid, id) then id = call(N.equipped, data, area, 0) end
            add('clothing', row[1], self:itemName(id, player))
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
    if count == 0 then return nil end
    return snapshot
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
    local ok, snapshot = pcall(self.read, self)
    if not ok or not snapshot then self.snapshot, self.at = nil, nil; return nil end
    self.snapshot, self.at = snapshot, now
    return snapshot
end

return M
