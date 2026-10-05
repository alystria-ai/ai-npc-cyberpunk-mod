-- Read-only acquisition evidence. Native values stay inside observer callbacks.
-- A positive inventory event alone is never provenance for a world pickup.
local M = {}
local LIMIT, INTENT_LIMIT, RECEIPT_LIMIT, WINDOW = 4096, 64, 128, 3
local captureContext, context, owner
local owned, seen, intents, vetoes, receipts = {}, {}, {}, {}, {}
local seenCount, epoch, serial, baselineReads = 0, 0, 0, 0
local baselineNeeded, baselineAttempted, ownershipComplete = true, false, true
local inventoryCoverage = false
local hooks, counts = {}, {}
local qualities = {Common=true, CommonPlus=true, Uncommon=true, UncommonPlus=true,
    Rare=true, RarePlus=true, Epic=true, EpicPlus=true, Legendary=true,
    LegendaryPlus=true, LegendaryPlusPlus=true, Iconic=true}
local categories = {Clothing=true, Consumable=true, Cyberware=true, Gadget=true,
    General=true, Part=true, Weapon=true, WeaponMod=true}

local function count(name) counts[name] = (counts[name] or 0) + 1 end
local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < math.huge end
local function quantity(value) return finite(value) and value >= 0 and value <= 2147483647 and value % 1 == 0 end
local function hash(value)
    if value == nil then return nil end
    local text = tostring(value)
    if #text <= 40 and (text:match('^%d+ULL$') or text:match('^%d+$')) then return text end
end
local function entity(object)
    if not object then return nil end
    local id = object:GetEntityID()
    return id and hash(id.hash)
end
local function identity(id)
    if id == nil or ItemID.IsValid(id) ~= true then return nil end
    return hash(ItemID.GetCombinedHash(id))
end
local function now() return context and context.now or os.time() end
local function allowed(value)
    return type(value) == 'table' and value.available == true and value.blocked == false
        and value.worldReady == true and value.enabled == true and finite(value.now)
end
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end; return result
end
local function clearPending() intents, vetoes, receipts = {}, {}, {} end
local function suspend()
    clearPending()
    baselineNeeded = true
end
local function plainContext(value)
    if type(value) ~= 'table' then return {available=false, blocked=true, enabled=false, worldReady=false, now=os.time()} end
    return {available=value.available == true, blocked=value.blocked ~= false,
        enabled=value.enabled == true, worldReady=value.worldReady == true,
        now=finite(value.now) and value.now or os.time()}
end
local function witnesses(value)
    local result, unique = {}, {}
    for index, person in ipairs(type(value.people) == 'table' and value.people or {}) do
        if index > 64 then break end
        if type(person) == 'table' then
            local key = person.profileKey
            local id = hash(person.entity)
            if id and type(key) == 'string' and #key <= 80 and key:match('^[a-z0-9%-]+$')
                and (person.available == true or person.voiceBusy == true) and person.enabled ~= false and finite(person.distance)
                and person.distance >= 0 and person.distance <= 20 and #result < 8 then
                local pair = id .. ':' .. key
                if not unique[pair] then
                    unique[pair] = true
                    result[#result + 1] = {entity=id, profileKey=key, distance=person.distance,
                        available=person.available == true, voiceBusy=person.voiceBusy == true,
                        availableReason=type(person.availableReason) == 'string' and person.availableReason:sub(1, 96) or nil}
                end
            end
        end
    end
    return result
end
local function fresh(player)
    if type(captureContext) ~= 'function' then return nil end
    local value = captureContext(player)
    context = plainContext(value)
    if not allowed(context) then suspend(); return nil end
    return value
end
local function prune()
    local current = now()
    for index = #intents, 1, -1 do
        if current < intents[index].at or current - intents[index].at > WINDOW then table.remove(intents, index) end
    end
    for key, expires in pairs(vetoes) do if current > expires then vetoes[key] = nil end end
end
local function remember(key, total)
    if not key then ownershipComplete = false; return end
    if not seen[key] then
        if seenCount >= LIMIT then ownershipComplete = false; return end
        seen[key], seenCount = true, seenCount + 1
    end
    if quantity(total) then owned[key] = total end
end
local function localPlayer(player)
    if not context or context.available ~= true or not player then return false end
    if player:IsAttached() ~= true or player:IsDeadNoStatPool() ~= false then return false end
    local live = Game.GetPlayer()
    local id = entity(player)
    return id ~= nil and id == entity(live) and (not owner or id == owner)
end
local function cancelIdentity(key)
    for index = #intents, 1, -1 do if intents[index].identity == key then table.remove(intents, index) end end
end
local function veto(key)
    if not key then suspend(); ownershipComplete = false; return end
    prune(); cancelIdentity(key)
    local size = 0; for _ in pairs(vetoes) do size = size + 1 end
    if size >= INTENT_LIMIT and not vetoes[key] then
        -- Losing an exclusion must not make an older interaction eligible.
        clearPending()
        count('vetoOverflow')
    end
    vetoes[key] = now() + WINDOW
end
local function baseline(player)
    baselineAttempted, baselineNeeded = true, false
    owned = {}
    -- Incompleteness records MISSED EVENTS (a failed callback, an unreadable
    -- item, an unavailable-player gap). A clean full read of the inventory
    -- closes those, and the ever-owned set already persists across it, so one
    -- bad event no longer disables new-equipment detection for the whole
    -- session. Failures in this very read, or an overflowing ever-owned set,
    -- still keep it off.
    ownershipComplete = true
    local success, items = Game.GetTransactionSystem():GetItemList(player)
    baselineReads = baselineReads + 1
    if success ~= true or type(items) ~= 'table' then ownershipComplete = false; count('baselineUnavailable'); return end
    if #items > LIMIT then ownershipComplete = false; count('baselineTruncated') end
    for index = 1, math.min(#items, LIMIT) do
        local data = items[index]
        local ok, key, total = pcall(function()
            if not data then return nil end
            return identity(data:GetID()), data:GetQuantity()
        end)
        if not ok or not key or not quantity(total) then ownershipComplete = false
        elseif total > 0 then remember(key, total) end
    end
end
local function enumName(value, kind, names)
    if value == nil then return nil end
    local text = tostring(value)
    local name = text:match('^' .. kind .. '%s*:%s*([%a]+)%s*%(%d+%)$') or text
    return names[name] and name or nil
end
-- Descriptive only (never a gate): a bounded enum token such as Wea_AssaultRifle.
local function enumToken(value, kind)
    if value == nil then return nil end
    local text = tostring(value)
    local name = text:match('^' .. kind .. '%s*:%s*([%a][%w_]*)%s*%(%d+%)$') or text
    if #name > 48 or not name:match('^%a[%w_]*$') or name == 'Invalid' or name == 'Count' then return nil end
    return name
end
local function label(value)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('<[^>]*>', ''):gsub('%c', ' '):match('^%s*(.-)%s*$')
    if value == '' or #value > 240 or value:match('^LocKey#') then return nil end
    return value
end
-- A bounded plain excerpt of game text: markup and control characters removed,
-- whitespace collapsed, cut at a sentence (else word) end without splitting a
-- UTF-8 character. Unresolved localization keys and empty text are absent.
local EXCERPT = 280
local function excerpt(value, limit)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('<[^>]*>', ' '):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if value == '' or value:match('^LocKey#') then return nil end
    if #value <= limit then return value end
    local cut = value:sub(1, limit)
    -- Do not end inside a multi-byte character.
    while #cut > 0 and cut:byte(#cut) >= 0x80 and cut:byte(#cut) < 0xC0 do cut = cut:sub(1, -2) end
    if #cut > 0 and cut:byte(#cut) >= 0xC0 then cut = cut:sub(1, -2) end
    local sentence = cut:match('^(.*[%.!?])%s')
    if sentence and #sentence >= limit * 0.5 then return sentence end
    local word = cut:match('^(.*)%s%S*$')
    return (word and #word >= limit * 0.5 and word or cut) .. '...'
end
-- The inventory tooltip shows LocKeyToString(record.LocalizedDescription()).
-- Item_Record.LocalizedDescription returns a CName key. Try the game's own
-- resolvers in turn; an unreadable or empty description is simply absent.
local function localizedDescription(definition)
    local ok, key = pcall(function() return definition:LocalizedDescription() end)
    if not ok or key == nil then return nil end
    local readers = {
        function() return LocKeyToString(key) end,
        function() return Game.LocKeyToString(key) end,
        function() return GetLocalizedTextByKey(key) end,
        function() return Game.GetLocalizedTextByKey(key) end,
        function() return GetLocalizedItemNameByCName(key) end,
    }
    for _, read in ipairs(readers) do
        local success, text = pcall(read)
        text = success and excerpt(text, EXCERPT) or nil
        if text then return text end
    end
    return nil
end
local function describe(id, data)
    if not data or identity(data:GetID()) ~= identity(id) then return nil end
    if ItemID.HasFlag(id, Enum.new('gameEItemIDFlag', 'Preview')) ~= false or RPGManager.IsItemBroken(data) ~= false then return nil end
    for _, tag in ipairs({'Currency', 'Recipe', 'IconicRecipe', 'SkipActivityLog', 'SkipActivityLogOnLoot'}) do
        if data:HasTag(CName.new(tag)) ~= false then return nil end
    end
    local recordId = ItemID.GetTDBID(id)
    local record = TDBID.ToStringDEBUG(recordId)
    if type(record) ~= 'string' or #record > 240 or not record:match('^Items%.[%w_%.%-]+$') or record == 'Items.money' then return nil end
    local definition = TweakDBInterface.GetItemRecord(recordId)
    if not definition then return nil end
    local name = label(UIItemsHelper.GetItemName(definition, data))
    local quality = enumName(RPGManager.GetItemDataQuality(data), 'gamedataQuality', qualities)
    local category = enumName(RPGManager.GetItemCategory(id), 'gamedataItemCategory', categories)
    if not name or not quality or not category then return nil end
    -- The item's own type (for example an assault rifle) helps a reaction name
    -- what was found. An unreadable type simply stays absent.
    local itemType
    pcall(function() itemType = enumToken(data:GetItemType(), 'gamedataItemType') end)
    -- The item's own tooltip text lets a reaction talk about what the item is.
    local description = localizedDescription(definition)
    return {record=record, name=name, quality=quality, category=category, itemType=itemType,
        description=description}
end

local function onIntent(inventory, event)
    if not event or not inventory then return end
    local player = Game.GetPlayer()
    if not player or player:IsAttached() ~= true or player:IsDeadNoStatPool() ~= false
        or entity(event.activator) ~= entity(player) then return end
    -- Menus/scenes can end between polling updates. Check the source callback's
    -- current scene before consulting context-dependent player ownership.
    local value = fresh(player)
    if not value or not localPlayer(player) then return end
    local wrapper = LootChoiceActionWrapper.Unwrap(event)
    if not wrapper or LootChoiceActionWrapper.IsValid(wrapper) ~= true or NameToString(wrapper.action) ~= 'Loot' then return end
    local id, source = wrapper.itemId, inventory:GetEntity()
    local key, from = identity(id), entity(source)
    if not key or not from or from == entity(player) or source:IsPlayer() ~= false
        or source:IsPlayerStash() ~= false or source:IsVehicle() ~= false then return end
    local transaction = Game.GetTransactionSystem()
    local previous, amount = transaction:GetItemQuantity(player, id), transaction:GetItemQuantity(source, id)
    if not quantity(previous) or (amount ~= nil and (not quantity(amount) or amount <= 0)) then return end
    prune()
    if vetoes[key] then return end
    cancelIdentity(key)
    if #intents >= INTENT_LIMIT then table.remove(intents, 1); count('intentOverflow') end
    serial = serial + 1
    intents[#intents + 1] = {identity=key, previous=previous, sourceQuantity=amount,
        sourceEntity=from, at=now(), witnesses=witnesses(value),
        newlyAcquired=inventoryCoverage and baselineAttempted and not baselineNeeded and ownershipComplete and not seen[key] and previous == 0,
        acquisitionId='loot-' .. math.floor(now()) .. '-' .. epoch .. '-' .. serial}
    -- Existing ownership found by the source read must survive later removal.
    if previous > 0 then remember(key, previous) end
    count('intents')
end

local function onAdded(player, event)
    if not localPlayer(player) or not event then return end
    local id, data = event.itemID, event.itemData
    local key = identity(id)
    if not key then ownershipComplete = false; return end
    if not data then veto(key); ownershipComplete = false; return end
    local total = data:GetQuantity()
    if not quantity(total) then veto(key); ownershipComplete = false; return end
    prune()
    local intent
    for index, item in ipairs(intents) do
        if item.identity == key then intent = item; table.remove(intents, index); break end
    end
    remember(key, total)
    if event.flaggedAsSilent ~= false then veto(key); count('silent'); return end
    if not intent or vetoes[key] then count('unattributed'); return end
    local value = fresh(player)
    if not value or now() < intent.at or now() - intent.at > WINDOW then return end
    local previous = event.currentQuantity -- Observed native Added field is the OLD total.
    if not quantity(previous) or previous ~= intent.previous or total <= previous then return end
    local amount = total - previous
    if intent.sourceQuantity and amount > intent.sourceQuantity then return end
    local item = describe(id, data)
    if not item then count('excluded'); return end
    if #receipts >= RECEIPT_LIMIT then count('receiptOverflow'); return end
    item.acquisitionId, item.identity, item.quantity = intent.acquisitionId, key, amount
    item.newlyAcquired = intent.newlyAcquired and ownershipComplete
    item.source, item.confirmed, item.witnesses = 'world', true, intent.witnesses
    receipts[#receipts + 1] = item
    count('accepted')
end

local function onChanged(player, event)
    if not localPlayer(player) or not event then return end
    local key, total, difference = identity(event.itemID), event.currentQuantity, event.difference
    if not key or not quantity(total) or not finite(difference) then ownershipComplete = false; return end
    -- Changed has no silent flag. It updates ownership, never emits a receipt.
    remember(key, total)
    cancelIdentity(key)
    count(difference < 0 and 'removed' or 'changed')
end
local function onRemoving(player, event)
    if not localPlayer(player) or not event then return end
    local key = identity(event.itemID)
    if not key then ownershipComplete = false; return end
    -- The later Changed event gives the verified remaining total. Preserve
    -- ever-owned identity here without guessing the removal event's semantics.
    remember(key)
    cancelIdentity(key)
end
local function onTransfer(_, source, target, data)
    if not context or context.available ~= true then return end
    local player = Game.GetPlayer()
    if not localPlayer(player) then return end
    local who = entity(player)
    if entity(source) ~= who and entity(target) ~= who then return end
    veto(data and identity(data:GetID()))
end
local function onPurchase(_, data)
    if context and context.available == true then veto(data and identity(data:GetID())) end
end

function M.configure(options)
    captureContext = type(options) == 'table' and options.captureContext or nil
end
function M.reset()
    epoch = epoch + 1
    context, owner, owned, seen, seenCount = nil, nil, {}, {}, 0
    baselineNeeded, baselineAttempted, ownershipComplete = true, false, true
    clearPending()
end
function M.update(value)
    local prior = context
    context = plainContext(value)
    if not allowed(context) then
        if not context.available and prior and prior.available then ownershipComplete = false end
        suspend(); return
    end
    prune()
    if not baselineNeeded then return end
    local ok = pcall(function()
        local player = Game.GetPlayer()
        if not localPlayer(player) then return end
        owner = entity(player)
        baseline(player)
    end)
    if not ok then baselineNeeded, baselineAttempted, ownershipComplete = false, true, false; count('baselineErrors') end
end
function M.drain()
    local result = receipts
    receipts = {}
    return result
end
function M.status()
    prune()
    local vetoCount = 0; for _ in pairs(vetoes) do vetoCount = vetoCount + 1 end
    return copy({version=1, enabled=allowed(context), owner=owner,
        baseline={attempted=baselineAttempted, needed=baselineNeeded, complete=inventoryCoverage and baselineAttempted and not baselineNeeded and ownershipComplete,
            reads=baselineReads, seen=seenCount, limit=LIMIT},
        intents=#intents, vetoes=vetoCount, queued=#receipts, counts=counts, hooks=hooks,
        routes={worldItem='observed-before-transfer-and-added', changedOnly='unsupported-no-silent-flag', corpseLootAll='unverified-disabled'},
        limits={intents=INTENT_LIMIT, receipts=RECEIPT_LIMIT, ownership=LIMIT, seconds=WINDOW}})
end
function M.install()
    local specs = {
        {'Inventory', 'OnInteractionUsed', 'before', onIntent},
        {'PlayerPuppet', 'OnItemAddedToInventory', 'after', onAdded},
        {'PlayerPuppet', 'OnItemChangedEvent', 'after', onChanged},
        {'PlayerPuppet', 'OnItemBeingRemovedFromInventory', 'before', onRemoving},
        {'VendorDataManager', 'TransferItem', 'before', onTransfer},
        {'VendorDataManager', 'BuyItemFromVendor', 'before', onPurchase},
        {'VendorDataManager', 'BuybackItemFromVendor', 'before', onPurchase},
        {'PlayerPuppet', 'OnDetach', 'before', M.reset},
        {'PlayerPuppet', 'OnDeath', 'before', M.reset}
    }
    for _, spec in ipairs(specs) do
        local key = spec[1] .. '.' .. spec[2]
        local state = hooks[key] or {calls=0, errors=0}
        hooks[key] = state
        if not state.registered then
            local observe = spec[3] == 'before' and ObserveBefore or (ObserveAfter or Observe)
            local ok, result = pcall(function()
                if type(observe) ~= 'function' then return false end
                return observe(spec[1], spec[2], function(...)
                    state.calls = state.calls + 1
                    local success = pcall(spec[4], ...)
                    if not success then
                        state.errors = state.errors + 1
                        ownershipComplete = false
                        suspend()
                    end
                end)
            end)
            state.registered = ok and result ~= false
        end
    end
    -- Missing inventory callbacks mean earlier ownership cannot be complete.
    inventoryCoverage = true
    for _, key in ipairs({'PlayerPuppet.OnItemAddedToInventory', 'PlayerPuppet.OnItemChangedEvent',
        'PlayerPuppet.OnItemBeingRemovedFromInventory'}) do
        if not hooks[key].registered then inventoryCoverage, ownershipComplete = false, false end
    end
    return M.status()
end
return M
