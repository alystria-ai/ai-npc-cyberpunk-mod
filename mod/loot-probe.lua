local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- Opt-in evidence only. Observe callbacks never replace native behavior.
-- No native reference survives a callback, and this module writes no files.
local M = convaiLootProbe or {active = false, events = {}, hooks = {}, serial = 0}
local unavailable = 'unavailable'

local function text(read)
    local ok, value = pcall(read)
    if ok and type(value) == 'string' and value ~= '' then return value:sub(1, 180) end
    return unavailable
end

local function display(read)
    local ok, value = pcall(read)
    if not ok or value == nil then return unavailable end
    return text(function() return tostring(value) end)
end

local function number(read)
    local ok, value = pcall(read)
    if ok and type(value) == 'number' and value == value and math.abs(value) < math.huge then return value end
    return unavailable
end

local function boolean(read)
    local ok, value = pcall(read)
    if ok and type(value) == 'boolean' then return value end
    return unavailable
end

local function native(read)
    local ok, value = pcall(read)
    if ok then return value end
end

local function plainCopy(value)
    if type(value) ~= 'table' then return value end
    local copy = {}
    for key, item in pairs(value) do copy[key] = plainCopy(item) end
    return copy
end

local function objectInfo(object)
    if not object then return {id = unavailable, kind = unavailable, localPlayer = unavailable} end
    local id = display(function() return object:GetEntityID().hash end)
    local playerId = display(function() return convaiPlayer():GetEntityID().hash end)
    local isPlayer = boolean(function() return object:IsPlayer() end)
    local isStash = boolean(function() return object:IsPlayerStash() end)
    local isVehicle = boolean(function() return object:IsVehicle() end)
    local isNpc = boolean(function() return object:IsNPC() end)
    local kind = isStash == true and 'player-stash' or isPlayer == true and 'player'
        or isVehicle == true and 'vehicle' or isNpc == true and 'npc' or unavailable
    return {id = id, kind = kind,
        class = text(function() return NameToString(object:GetClassName()) end),
        localPlayer = id ~= unavailable and playerId ~= unavailable and id == playerId
            or (id == unavailable or playerId == unavailable) and unavailable or false,
        isPlayerStash = isStash, isVehicle = isVehicle}
end

local function itemInfo(id, data)
    local item = {
        valid = boolean(function() return ItemID.IsValid(id) end),
        hash = display(function() return ItemID.GetCombinedHash(id) end),
        record = text(function() return TDBID.ToStringDEBUG(ItemID.GetTDBID(id)) end),
        recordHash = display(function() return TDBID.ToNumber(ItemID.GetTDBID(id)) end),
        seed = number(function() return ItemID.GetRngSeed(id) end),
        quantity = number(function() return data:GetQuantity() end),
        quality = display(function() return RPGManager.GetItemDataQuality(data) end),
        category = display(function() return RPGManager.GetItemCategory(id) end),
        itemType = display(function() return data:GetItemType() end),
        iconic = boolean(function() return RPGManager.IsItemIconic(data) end),
        broken = boolean(function() return RPGManager.IsItemBroken(data) end),
        preview = boolean(function() return ItemID.HasFlag(id, Enum.new('gameEItemIDFlag', 'Preview')) end),
        ownedByPlayer = boolean(function() return Game.GetTransactionSystem():HasItem(convaiPlayer(), id) end),
        name = text(function() return UIItemsHelper.GetItemName(TweakDBInterface.GetItemRecord(ItemID.GetTDBID(id)), data) end),
        tags = {}}
    for _, tag in ipairs({'SkipActivityLog', 'SkipActivityLogOnLoot', 'Currency', 'Recipe', 'IconicRecipe', 'Quest'}) do
        item.tags[tag] = boolean(function() return data:HasTag(CName.new(tag)) end)
    end
    return item
end

local function open()
    if not M.active then return false end
    if os.time() >= M.expiresAt then M.stop('expired'); return false end
    return true
end

local function append(hook, row)
    if not row or not open() then return end
    M.sequence = M.sequence + 1
    row.sequence, row.at, row.hook = M.sequence, os.time() * 1000, hook
    -- Every builder below creates a fresh table of primitive fields only.
    M.events[#M.events + 1] = row
    M.hooks[hook].captured = (M.hooks[hook].captured or 0) + 1
    if #M.events >= M.maxEvents then M.stop('event-limit') end
end

local function inventoryEvent(kind, player, event, hasSilent)
    local owner = objectInfo(player)
    if owner.localPlayer == false then return end
    local id = native(function() return event.itemID end)
    local data = native(function() return event.itemData end)
    local silent = unavailable
    if hasSilent then silent = boolean(function() return event.flaggedAsSilent end) end
    return {kind = kind, evidence = 'inventory-event', owner = owner, item = itemInfo(id, data),
        delta = kind == 'inventory-added' and unavailable or number(function() return event.difference end),
        total = number(function() return event.currentQuantity end),
        silent = silent,
        source = {id = unavailable, kind = unavailable}}
end

local function slotEvent(kind, player, event)
    local owner = objectInfo(player)
    if owner.localPlayer == false then return end
    return {kind = kind, evidence = 'equipment-slot-event', owner = owner,
        item = itemInfo(native(function() return event:GetItemID() end)),
        slot = text(function() return TDBID.ToStringDEBUG(event:GetSlotID()) end)}
end

local function transferEvent(_, source, target, data, amount)
    local from, to = objectInfo(source), objectInfo(target)
    if from.localPlayer == false and to.localPlayer == false then return end
    return {kind = 'vendor-data-transfer', evidence = 'source-bearing-call', source = from, target = to,
        item = itemInfo(native(function() return data:GetID() end), data),
        amount = number(function() return amount end), success = unavailable}
end

local function vendorEvent(kind, controller, data, amount, requestId)
    return {kind = kind, evidence = 'request-intent',
        source = objectInfo(native(function() return controller:GetVendorInstance() end)),
        target = objectInfo(native(function() return convaiPlayer() end)),
        item = itemInfo(native(function() return data:GetID() end), data),
        amount = number(function() return amount end), request = number(function() return requestId end), success = unavailable}
end

-- All methods below exist in the checked reference scripts. CET registration
-- and actual callback coverage are reported separately; neither is assumed.
local specs = {
    {'PlayerPuppet', 'OnItemAddedToInventory', 'after', function(p, e) return inventoryEvent('inventory-added', p, e, true) end},
    {'PlayerPuppet', 'OnItemChangedEvent', 'after', function(p, e) return inventoryEvent('inventory-changed', p, e, false) end},
    {'PlayerPuppet', 'OnItemBeingRemovedFromInventory', 'before', function(p, e) return inventoryEvent('inventory-removing', p, e, false) end},
    {'PlayerPuppet', 'OnItemAddedToSlot', 'after', function(p, e) return slotEvent('slot-added', p, e) end},
    {'PlayerPuppet', 'OnItemRemovedFromSlot', 'after', function(p, e) return slotEvent('slot-removed', p, e) end},
    {'VendorDataManager', 'TransferItem', 'before', transferEvent},
    {'VendorDataManager', 'BuyItemFromVendor', 'before', function(...) return vendorEvent('vendor-buy-request', ...) end},
    {'VendorDataManager', 'BuybackItemFromVendor', 'before', function(...) return vendorEvent('vendor-buyback-request', ...) end},
    {'Inventory', 'OnInteractionUsed', 'before', function(inventory, event)
        local target = objectInfo(native(function() return event.activator end))
        if target.localPlayer == false then return end
        local wrapper = native(function() return LootChoiceActionWrapper.Unwrap(event) end)
        if boolean(function() return LootChoiceActionWrapper.IsValid(wrapper) end) ~= true then return end
        return {kind = 'inventory-loot-choice', evidence = 'interaction-intent', target = target,
            source = objectInfo(native(function() return inventory:GetEntity() end)),
            item = itemInfo(native(function() return wrapper.itemId end)),
            action = text(function() return NameToString(wrapper.action) end),
            handledByCode = boolean(function() return LootChoiceActionWrapper.IsHandledByCode(wrapper) end)}
    end},
    {'Inventory', 'OnLootAllEvent', 'before', function(inventory)
        return {kind = 'loot-all-signal', evidence = 'container-signal-without-activator',
            source = objectInfo(native(function() return inventory:GetEntity() end)), target = {id = unavailable, kind = unavailable}}
    end},
    {'ScriptedPuppet', 'OnInteraction', 'before', function(puppet, event)
        if text(function() return event.choice.choiceMetaData.tweakDBName end) ~= 'Loot' then return end
        local target = objectInfo(native(function() return event.activator end))
        if target.localPlayer == false then return end
        return {kind = 'puppet-loot-all-choice', evidence = 'interaction-intent', source = objectInfo(puppet), target = target}
    end},
    {'VirtualItem_TEMP', 'OnInteractionChoice', 'before', function(object, event)
        local target = objectInfo(native(function() return event.activator end))
        if target.localPlayer == false then return end
        return {kind = 'virtual-item-choice', evidence = 'interaction-intent', source = objectInfo(object), target = target,
            item = {hash = unavailable, record = unavailable}}
    end},
    {'Stash', 'OnOpenStash', 'before', function(object)
        return {kind = 'storage-open', evidence = 'storage-source', source = objectInfo(object)}
    end},
    {'VehicleComponent', 'OnVehiclePlayerTrunk', 'before', function(component)
        return {kind = 'vehicle-storage-open', evidence = 'storage-source',
            source = objectInfo(native(function() return component:GetVehicle() end))}
    end},
    {'PlayerPuppet', 'OnDetach', 'before', function() M.stop('player-detached') end},
    {'PlayerPuppet', 'OnDeath', 'before', function() M.stop('player-died') end}
}

M.handlers = {}
for _, spec in ipairs(specs) do M.handlers[spec[1] .. '.' .. spec[2]] = spec[4] end

function M.install()
    for _, spec in ipairs(specs) do
        local key = spec[1] .. '.' .. spec[2]
        local state = M.hooks[key] or {captured = 0, calls = 0}
        M.hooks[key] = state
        if not state.registered then
            local observe = spec[3] == 'before' and ObserveBefore or (ObserveAfter or Observe)
            local ok, result = pcall(function()
                if type(observe) ~= 'function' then error('Observer unavailable') end
                return observe(spec[1], spec[2], function(...)
                    if not open() then return end
                    state.calls = state.calls + 1
                    local captured, row = pcall(M.handlers[key], ...)
                    if captured then append(key, row)
                    else M.errors = (M.errors or 0) + 1; state.lastError = 'callback-read-unavailable' end
                    -- Returning nothing from an observer leaves native results alone.
                end)
            end)
            state.registered = ok and result ~= false
            state.registration = state.registered and 'registered-not-yet-observed' or 'registration-unavailable'
        end
    end
    return M.status()
end

function M.start(options)
    options = type(options) == 'table' and options or {seconds = options}
    local seconds = tonumber(options.seconds) or 120
    if seconds ~= seconds or math.abs(seconds) == math.huge then seconds = 120 end
    seconds = math.max(1, math.min(300, math.floor(seconds)))
    local limit = tonumber(options.maxEvents) or 512
    if limit ~= limit or math.abs(limit) == math.huge then limit = 512 end
    M.serial = M.serial + 1
    M.active, M.events, M.sequence, M.errors = false, {}, 0, 0
    M.startedAt, M.expiresAt = os.time(), os.time() + seconds
    M.stoppedAt, M.stopReason, M.maxEvents = nil, nil, math.max(1, math.min(512, math.floor(limit)))
    M.run = tostring(M.startedAt) .. '-' .. tostring(M.serial)
    for _, state in pairs(M.hooks) do state.calls, state.captured, state.lastError = 0, 0, nil end
    M.install()
    M.active = true
    return M.status()
end

function M.stop(reason)
    if M.active then
        M.active, M.stoppedAt = false, os.time()
        M.stopReason = type(reason) == 'string' and reason:sub(1, 80) or 'stopped'
    end
    return M.status()
end

function M.status()
    if M.active and os.time() >= M.expiresAt then
        M.active, M.stoppedAt, M.stopReason = false, os.time(), 'expired'
    end
    return plainCopy({version = 1, probe = 'loot-evidence', run = M.run, active = M.active == true,
        startedAt = M.startedAt, expiresAt = M.expiresAt, stoppedAt = M.stoppedAt, stopReason = M.stopReason,
        maxEvents = M.maxEvents or 512, errors = M.errors or 0, hooks = M.hooks, events = M.events})
end

convaiLootProbe = M
return M
