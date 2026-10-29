local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The game side of the SYSTEMS group of bond quest primitives (mod/quest-prims-systems.lua: pay, gift, garage, memory-share). The native calls only, each one guarded by
-- its caller. None of them runs per frame: a balance read, an item count, one inventory read or one vehicle call happens when V pays, gives or is given something, or when a
-- garage stage arms. Nothing here touches a character the game placed.
--
-- Entity handles are never kept. The cast member of a pay stage is a plain handle of the cast primitive ({kind = 'extra', id = EntityID} or {kind = 'copy', profileKey}), and the
-- entity of a turn is compared by its entity ID text at the moment of the turn.
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   moneyBalance, moneyTake   TransactionSystem item quantity and RemoveItem on Items.money, the calls mod/eddies.lua uses. Taken money is read back from the balance.
--   itemExists                TweakDB:GetRecord(record) for an item record.
--   itemCount, itemGive, itemTake   TransactionSystem GetItemQuantity, GiveItem and RemoveItem with ItemID.FromTDBID, the calls mod/bonds.lua uses for its item effects.
--   inventoryGifts            one GetItemList of V, the item type and category read as mod/loot-observer.lua reads them, the display name from UIItemsHelper.GetItemName, the
--                             equipped check through the EquipmentSystem player data (IsEquipped). When the equipped check cannot be read, clothing, weapons and cyberware are left out.
--   vehicleOwned              VehicleSystem GetPlayerUnlockedVehicles, the PlayerVehicle recordID compared as text. The way the list comes back through Cyber Engine Tweaks is a guess.
--   vehicleAdd                VehicleSystem EnablePlayerVehicle(record, true, false). IT CHANGES THE SAVE and cannot be taken back.
--   castIs                    the entity ID hash of the turn's entity against the cast spawn's.
--   tweakEnsure               mod/quest-tweak.lua ensure (a custom item record cloned from a vanilla base), unverified there too.
local M = {
    -- Item categories and types that count as something V could hand to a character (a drink, food, junk, clothing, a weapon, a cyberware item, a quickhack).
    CATEGORIES = {Consumable = true, Clothing = true, Weapon = true, Cyberware = true, Programs = true},
    TYPES = {Gen_Junk = true, Gen_Jewellery = true, Prt_Program = true},
    -- Without a readable equipped check these stay out (taking an equipped piece from V is not something a gift may do).
    WORN = {Clothing = true, Weapon = true, Cyberware = true},
}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e12 end
local function validRecord(text) return type(text) == 'string' and #text >= 3 and #text <= 120 and text:match('^[%a][%w_%.]*$') ~= nil end

local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

local function enumToken(value, kind)
    if value == nil then return nil end
    local text = tostring(value)
    local name = text:match('^' .. kind .. '%s*:%s*([%a][%w_]*)%s*%(%d+%)$') or text
    if #name > 48 or not name:match('^%a[%w_]*$') then return nil end
    return name
end

local function label(value)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if value == '' or #value > 120 or value:match('^LocKey#') then return nil end
    return value
end

-- deps: tweak (a mod/quest-tweak.lua instance, else it is loaded when first asked), log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}
    local tweak

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest systems world: ' .. line) end end
    local function player() return convaiPlayer() end
    local function transactions() return Game.GetTransactionSystem() end
    local function itemId(record) return ItemID.FromTDBID(TweakDBID.new(record)) end

    -- ---- eddies -------------------------------------------------------------------------------------------------------------------------
    function W.moneyBalance()
        local p = player()
        if not p then return nil end
        local value = transactions():GetItemQuantity(p, itemId('Items.money'))
        return finite(value) and value or nil
    end

    -- Takes `amount` eddies from V and reads the balance back. true when exactly that much left V's balance.
    function W.moneyTake(amount)
        local p = player()
        if not p or not finite(amount) or amount < 1 then return false end
        local before = W.moneyBalance()
        if not before or before < amount then return false end
        local id = itemId('Items.money')
        local ok, result = pcall(function() return transactions():RemoveItem(p, id, amount) end)
        if not ok or result == false then return false end
        local after = W.moneyBalance()
        return after ~= nil and after <= before - amount
    end

    -- ---- items --------------------------------------------------------------------------------------------------------------------------
    function W.itemExists(record)
        if not validRecord(record) then return false end
        local db = global('TweakDB')
        if db == nil then return false end
        local ok, found = pcall(function() return db:GetRecord(record) end)
        return ok and found ~= nil
    end

    function W.itemCount(record)
        local p = player()
        if not p or not validRecord(record) then return nil end
        local value = transactions():GetItemQuantity(p, itemId(record))
        return finite(value) and value or nil
    end

    -- Gives `quantity` of an item and reads the count back. true when the count rose by that much.
    function W.itemGive(record, quantity)
        local p = player()
        if not p or not validRecord(record) or not finite(quantity) or quantity < 1 then return false end
        local before = W.itemCount(record) or 0
        local ok, result = pcall(function() return transactions():GiveItem(p, itemId(record), quantity) end)
        if not ok or result == false then return false end
        local after = W.itemCount(record)
        return after ~= nil and after >= before + quantity
    end

    function W.itemTake(record, quantity)
        local p = player()
        if not p or not validRecord(record) or not finite(quantity) or quantity < 1 then return false end
        local before = W.itemCount(record)
        if not before or before < quantity then return false end
        local ok, result = pcall(function() return transactions():RemoveItem(p, itemId(record), quantity) end)
        if not ok or result == false then return false end
        local after = W.itemCount(record)
        return after ~= nil and after <= before - quantity
    end

    -- Whether an item is worn or wielded: true, false, or nil when it cannot be read.
    local function equipped(p, id)
        local ok, value = pcall(function()
            local container = Game.GetScriptableSystemsContainer()
            local system = container and container:Get(CName.new('EquipmentSystem'))
            local data = system and system:GetPlayerData(p)
            if not data then return nil end
            return data:IsEquipped(id)
        end)
        if ok and (value == true or value == false) then return value end
        return nil
    end

    -- V's gift-able items, one inventory read: [{record, name, kind, quantity}], at most `limit` rows (200 by default). name is the display name (nil when unreadable),
    -- kind is the category token. Money, quest items, currency and what V wears or wields are never listed.
    function W.inventoryGifts(limit)
        limit = (finite(limit) and limit >= 1 and limit <= 400) and math.floor(limit) or 200
        local p = player()
        if not p then return nil end
        local first, second = transactions():GetItemList(p)
        local items = type(second) == 'table' and second or type(first) == 'table' and first or nil
        if not items then return nil end
        local out = {}
        for _, data in ipairs(items) do
            if #out >= limit then break end
            local ok, row = pcall(function()
                local id = data:GetID()
                if ItemID.HasFlag(id, Enum.new('gameEItemIDFlag', 'Preview')) ~= false then return nil end
                for _, tag in ipairs({'Currency', 'Quest', 'Recipe', 'SkipActivityLog'}) do
                    if data:HasTag(CName.new(tag)) ~= false then return nil end
                end
                local tdb = ItemID.GetTDBID(id)
                local record = TDBID.ToStringDEBUG(tdb)
                if type(record) ~= 'string' or not record:match('^Items%.[%w_%.%-]+$') or #record > 120 or record == 'Items.money' then return nil end
                local category = enumToken(RPGManager.GetItemCategory(id), 'gamedataItemCategory')
                local kind = enumToken(data:GetItemType(), 'gamedataItemType')
                if not (category and M.CATEGORIES[category]) and not (kind and M.TYPES[kind]) then return nil end
                local worn = equipped(p, id)
                if worn == true then return nil end
                if worn == nil and category and M.WORN[category] then return nil end
                local definition = TweakDBInterface.GetItemRecord(tdb)
                local name = definition and label(UIItemsHelper.GetItemName(definition, data)) or nil
                local quantity = data:GetQuantity()
                if not finite(quantity) or quantity < 1 then return nil end
                return {record = record, name = name, kind = category or kind, quantity = quantity}
            end)
            if ok and row then out[#out + 1] = row end
        end
        return out
    end

    -- ---- the garage -----------------------------------------------------------------------------------------------------------------------
    local function vehicleSystem()
        return Game.GetVehicleSystem()
    end

    -- true when V has the vehicle unlocked, false when the list was read and it is not in it, nil when the list cannot be read.
    function W.vehicleOwned(record)
        if not validRecord(record) then return nil end
        local ok, owned = pcall(function()
            local system = vehicleSystem()
            if not system then return nil end
            local first, second = system:GetPlayerUnlockedVehicles()
            local list = type(second) == 'table' and second or type(first) == 'table' and first or nil
            if not list then return nil end
            for _, entry in ipairs(list) do
                local id = entry.recordID
                if id ~= nil and TDBID.ToStringDEBUG(id) == record then return true end
            end
            return false
        end)
        if ok then return owned end
        return nil
    end

    -- The game's own unlock. Idempotent in the game. true when it answered true.
    function W.vehicleAdd(record)
        if not validRecord(record) then return false, 'bad record' end
        local ok, result = pcall(function()
            local system = vehicleSystem()
            if not system then return nil end
            return system:EnablePlayerVehicle(record, true, false)
        end)
        if not ok then return false, tostring(result) end
        if result == nil then return false, 'no vehicle system' end
        return result == true, result == true and nil or 'refused'
    end

    -- ---- the turn's entity ------------------------------------------------------------------------------------------------------------------
    -- Whether `entity` (or the copy `profileKey` of a turn) is the cast member of `handle`.
    function W.castIs(handle, entity, profileKey)
        if type(handle) ~= 'table' then return false end
        if handle.kind == 'extra' then
            if entity == nil or handle.id == nil then return false end
            local ok, same = pcall(function() return tostring(entity:GetEntityID().hash) == tostring(handle.id.hash) end)
            return ok and same == true
        end
        return type(profileKey) == 'string' and handle.profileKey == profileKey
    end

    -- ---- custom item records ------------------------------------------------------------------------------------------------------------------
    function W.tweakEnsure(name, base, flats)
        if tweak == nil then
            tweak = deps.tweak or false
            if not tweak and type(dofile) == 'function' then
                local ok, module = pcall(dofile, 'quest-tweak.lua')
                if ok and type(module) == 'table' and type(module.new) == 'function' then
                    local built, instance = pcall(module.new, {log = deps.log})
                    if built and type(instance) == 'table' then tweak = instance end
                end
            end
        end
        if not tweak or type(tweak.ensure) ~= 'function' then return false, 'the tweak module is not available' end
        local ok, done, why = pcall(tweak.ensure, name, base, flats)
        if not ok then log('ensure raised: ' .. tostring(done)); return false, tostring(done) end
        return done == true, why
    end

    return W
end

return M
