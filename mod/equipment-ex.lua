-- Other mods' state, Equipment-EX (Settings > Dynamic info > Other mods' state, docs/PLAYER_GEAR_CONTEXT.md): what V visibly wears while a wardrobe
-- outfit of Equipment-EX is active. The outfit hides V's real equipment visually (the game's own equipment system keeps the real items), so
-- mod/player-gear.lua asks this module first and, when it answers, lists the outfit's items instead of the equipped clothes.
--
-- Loaded by init.lua only while the `mods` switch is on (never read from disk otherwise). Read on demand when a conversation turn's gear is
-- built (player-gear.lua's 5 second cached snapshot): no timer, hook, observer or file, nothing per frame. Every lookup and call is wrapped in
-- pcall; a missing or changed Equipment-EX drops the answer (the real clothes are listed as before), never the turn.
--
-- Source (Equipment-EX 1.2.9, its redscript was read, nothing of it is run or copied; it declares Codeware 1.18, ArchiveXL 1.26 and TweakXL 1.11,
-- so it is the build for game 2.31 and later): a ScriptableSystem fetched with Game.GetScriptableSystemsContainer():Get(CName.new('EquipmentEx.OutfitSystem'))
-- (OutfitSystem.GetInstance, EquipmentEx.reds:1680).
--   :IsActive() -> Bool                 an outfit is on (reds:1089); while it is, every base slot and every outfit slot is managed (reds:1653) and
--                                       the real clothes are hidden: Activate/HideEquipment unequips the Outfit area item and clears the visuals of
--                                       head, face, chest, torso, legs, feet and underwear (reds:935-945; EquipmentEx.Global.reds:199-202 makes the
--                                       game treat those areas as overridden)
--   :GetUsedSlots() -> array<TweakDBID> the slots that hold an outfit part (reds:1662)
--   Game.GetTransactionSystem():GetItemInSlot(V, slotID):GetItemID()   the item shown in that slot: the exact lookup Equipment-EX's own
--                                       PrintItems makes (EquipmentEx.Global.reds:44-62). A part is a preview item made from the real item's record.
--   :GetOutfits() -> array<CName> and :IsEquipped(CName) -> Bool   the saved outfit the current parts match, by hash (reds:1428, 1494, OutfitState.IsOutfit
--                                       reds:643); there is no "current outfit name" field, and an unsaved set of parts matches none
-- The slot ids are OutfitConfig.BaseSlots / OutfitSlots (reds:229-296); mapped here onto the categories player-gear.lua already uses.
-- Not confirmed (guesses about CET, not about Equipment-EX): that `TweakDBID.new(name) == slotID` compares ids, that `:IsEquipped(CName)` picks
-- the CName overload, that Game.NameToString exists, and that CET returns nil (not an error) for an unknown class name (pcall covers both).
--
-- Result: nil (not installed, not active, or unreadable), or {name = <saved outfit name or ''>, parts = {{slot = <category>, id = <ItemID>}, ...}}.
-- player-gear.lua turns the ids into display names itself, the way it does for every item.
local M = {}

-- Slot id -> player-gear.lua category. Each entry: {category, {slot ids...}}. Categories in this order also order the parts.
M.SLOTS = {
    {'head', {'AttachmentSlots.Head', 'OutfitSlots.Head', 'OutfitSlots.Balaclava'}},
    {'face', {'AttachmentSlots.Eyes', 'OutfitSlots.Mask', 'OutfitSlots.Glasses', 'OutfitSlots.Eyes', 'OutfitSlots.EyeLeft', 'OutfitSlots.EyeRight',
        'OutfitSlots.Wreath'}},
    {'ears', {'OutfitSlots.EarLeft', 'OutfitSlots.EarRight'}},
    {'neck', {'OutfitSlots.Neckwear', 'OutfitSlots.NecklaceTight', 'OutfitSlots.NecklaceShort', 'OutfitSlots.NecklaceLong'}},
    {'outerTorso', {'AttachmentSlots.Torso', 'OutfitSlots.TorsoMiddle', 'OutfitSlots.TorsoOuter', 'OutfitSlots.TorsoAux'}},
    {'innerTorso', {'AttachmentSlots.Chest', 'AttachmentSlots.UnderwearTop', 'OutfitSlots.TorsoUnder', 'OutfitSlots.TorsoInner'}},
    {'back', {'OutfitSlots.Back'}},
    {'waist', {'OutfitSlots.Waist'}},
    {'arms', {'OutfitSlots.ShoulderLeft', 'OutfitSlots.ShoulderRight', 'OutfitSlots.ElbowLeft', 'OutfitSlots.ElbowRight', 'OutfitSlots.WristLeft',
        'OutfitSlots.WristRight'}},
    {'hands', {'OutfitSlots.Hands', 'OutfitSlots.HandLeft', 'OutfitSlots.HandRight', 'OutfitSlots.HandPropLeft', 'OutfitSlots.HandPropRight',
        'OutfitSlots.FingersLeft', 'OutfitSlots.FingersRight', 'OutfitSlots.FingernailsLeft', 'OutfitSlots.FingernailsRight'}},
    {'legs', {'AttachmentSlots.Legs', 'AttachmentSlots.UnderwearBottom', 'OutfitSlots.LegsInner', 'OutfitSlots.LegsMiddle', 'OutfitSlots.LegsOuter',
        'OutfitSlots.ThighLeft', 'OutfitSlots.ThighRight', 'OutfitSlots.KneeLeft', 'OutfitSlots.KneeRight', 'OutfitSlots.AnkleLeft',
        'OutfitSlots.AnkleRight'}},
    {'feet', {'AttachmentSlots.Feet', 'OutfitSlots.Feet', 'OutfitSlots.ToesLeft', 'OutfitSlots.ToesRight', 'OutfitSlots.ToenailsLeft',
        'OutfitSlots.ToenailsRight'}},
    {'outfit', {'OutfitSlots.BodyUnder', 'OutfitSlots.BodyInner', 'OutfitSlots.BodyMiddle', 'OutfitSlots.BodyOuter'}},
}
M.CLASS = 'EquipmentEx.OutfitSystem'
-- The most parts sent (the bridge takes at most 16 clothing rows) and the longest outfit name logged.
M.MAX_PARTS, M.MAX_NAME = 14, 30
-- A player without the mod pays one failed lookup this often, at most.
M.RETRY_SECONDS = 60

local state = {ids = nil, last = nil, logged = {}, probedAt = nil}

-- Forget what was remembered (a test, or a new save).
function M.reset() state = {ids = nil, last = nil, logged = {}, probedAt = nil} end

local function say(log, line)
    if type(log) == 'function' then pcall(log, line) end
end

local function once(log, key, line)
    if state.logged[key] then return end
    state.logged[key] = true
    say(log, line)
end

local function short(problem) return (tostring(problem):gsub('%s+', ' '):sub(1, 140)) end

-- The slot ids as TweakDBID values, built once (comparing two of them is the only way to tell which slot a part is in).
local function slotIds()
    if state.ids then return state.ids end
    local ids = {}
    for _, row in ipairs(M.SLOTS) do
        for _, name in ipairs(row[2]) do ids[#ids + 1] = {category = row[1], id = TweakDBID.new(name)} end
    end
    state.ids = ids
    return ids
end

local function categoryOf(slotID)
    for _, entry in ipairs(slotIds()) do
        if entry.id == slotID then return entry.category end
    end
    return nil
end

local function nameOf(value)
    local ok, text = pcall(function() return Game.NameToString(value) end)
    if not ok or type(text) ~= 'string' then ok, text = pcall(tostring, value) end
    if not ok or type(text) ~= 'string' then return '' end
    text = text:gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    return text:sub(1, M.MAX_NAME)
end

-- The saved outfit the parts match, or '' (an unsaved set, or the lookup failed).
local function outfitName(system)
    local ok, names = pcall(function() return system:GetOutfits() end)
    if not ok or type(names) ~= 'table' then return '' end
    for _, name in ipairs(names) do
        local matched, equal = pcall(function() return system:IsEquipped(name) end)
        if matched and equal == true then return nameOf(name) end
    end
    return ''
end

local function order(category)
    for index, row in ipairs(M.SLOTS) do
        if row[1] == category then return index end
    end
    return #M.SLOTS + 1
end

-- The outfit V wears, or nil. `player` is V; `log(line)` gets one line per distinct reading; `now` is the clock in seconds (os.time by default).
function M.read(player, log, now)
    if player == nil then return nil end
    now = tonumber(now) or os.time()
    if state.probedAt ~= nil and state.absent and now >= state.probedAt and now - state.probedAt < M.RETRY_SECONDS then return nil end
    local okContainer, system = pcall(function() return Game.GetScriptableSystemsContainer():Get(CName.new(M.CLASS)) end)
    if not okContainer then
        once(log, 'get', 'Equipment-EX: lookup of ' .. M.CLASS .. ' failed (' .. short(system) .. ')')
        return nil
    end
    if system == nil then
        state.probedAt, state.absent = now, true
        return nil
    end
    state.absent = false
    local okActive, active = pcall(function() return system:IsActive() end)
    if not okActive then
        once(log, 'active', 'Equipment-EX: IsActive failed (' .. short(active) .. ')')
        return nil
    end
    if active ~= true then
        if state.last ~= 'off' then state.last = 'off'; say(log, 'equipment-ex outfit=off') end
        return nil
    end
    local okSlots, slots = pcall(function() return system:GetUsedSlots() end)
    if not okSlots or type(slots) ~= 'table' then
        once(log, 'slots', 'Equipment-EX: GetUsedSlots failed (' .. short(okSlots and 'not a list' or slots) .. ')')
        return nil
    end
    local okTransaction, transactions = pcall(function() return Game.GetTransactionSystem() end)
    if not okTransaction or transactions == nil then return nil end
    local parts, read, unmapped = {}, 0, 0
    for _, slotID in ipairs(slots) do
        local okItem, item = pcall(function() return transactions:GetItemInSlot(player, slotID) end)
        if okItem and item ~= nil then
            local okId, id = pcall(function() return item:GetItemID() end)
            if okId and id ~= nil then
                read = read + 1
                local okCategory, category = pcall(categoryOf, slotID)
                if okCategory and category then parts[#parts + 1] = {slot = category, id = id} else unmapped = unmapped + 1 end
            end
        end
    end
    -- Parts were there but none could be placed: the slot comparison does not work in this build, so say nothing rather than list nothing.
    if read > 0 and #parts == 0 then
        once(log, 'unmapped', 'Equipment-EX: ' .. read .. ' outfit parts but no slot recognised (names changed?)')
        return nil
    end
    local indexed = {}
    for index, part in ipairs(parts) do indexed[index] = {part = part, rank = order(part.slot), index = index} end
    table.sort(indexed, function(a, b) if a.rank ~= b.rank then return a.rank < b.rank end return a.index < b.index end)
    local sorted = {}
    for index, row in ipairs(indexed) do
        if index > M.MAX_PARTS then break end
        sorted[index] = row.part
    end
    local name = outfitName(system)
    local line = 'equipment-ex outfit=' .. (name ~= '' and name or 'unsaved') .. ' parts=' .. read
    if line ~= state.last then state.last = line; say(log, line) end
    return {name = name, parts = sorted}
end

return M
