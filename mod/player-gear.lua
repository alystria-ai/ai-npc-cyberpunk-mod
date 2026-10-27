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
    -- The game's own Wardrobe (patch 2.0+, docs/PLAYER_GEAR_CONTEXT.md). Signatures and bodies read from the REDmod scripts of 2.5 (tools/redmod/scripts) and checked
    -- against the compiled final.redscripts of 2.31 and 2.5:
    -- EquipmentSystemPlayerData.GetActiveWardrobeSet() and WardrobeSystem.GetActiveClothingSet() -> ref<ClothingSet> {setID: gameWardrobeClothingSetIndex,
    -- clothingList: array<SSlotVisualInfo {areaType: gamedataEquipmentArea, visualItem: ItemID, isHidden: Bool}>}; EquipmentSystemPlayerData.IsWardrobeEnabled() -> Bool;
    -- EquipmentSystem.GetActiveWardrobeSet(player) is STATIC.
    -- CET call shapes (live 2026-10-26: "Function 'GetWardrobeSystem' requires 0 parameter(s)"): a GameInstance function takes the game instance IMPLICITLY, so it is
    -- Game.GetWardrobeSystem() or GameInstance.GetWardrobeSystem() with no argument, never GameInstance.GetWardrobeSystem(game); instance methods use a colon, static
    -- functions of a class (EquipmentSystem.GetActiveWardrobeSet(player), ScriptedPuppet.GetActiveWeapon(player)) pass exactly the declared parameters.
    -- Routes are tried in order until one returns a set; each failure is reported (its name and message), never swallowed.
    N.wardrobeRoutes = {
        {'data:GetActiveWardrobeSet', function(_, data) return data:GetActiveWardrobeSet() end},
        {'Game.GetWardrobeSystem', function() return Game.GetWardrobeSystem():GetActiveClothingSet() end},
        {'GameInstance.GetWardrobeSystem', function() return GameInstance.GetWardrobeSystem():GetActiveClothingSet() end},
        {'EquipmentSystem.GetActiveWardrobeSet', function(player) return EquipmentSystem.GetActiveWardrobeSet(player) end},
        -- The saved set the active index names (the game's own FindWardrobeClothingSetByID), when the routes above hand back nothing for it.
        {'WardrobeSystem.GetClothingSets', function(player, _, label) return N.storedSet(player, label) end, true}}
    function N.wardrobeEnabled(data) return data:IsWardrobeEnabled() end
    -- What the game's own paperdoll and inventory read (inGameMenuGameController, ItemPreviewGameController, inventoryDataManagerV2; REDmod scripts of 2.5):
    -- EquipmentSystemPlayerData.IsVisualSetActive() (= the native WardrobeSystem's active set index is not INVALID), then per clothing area
    -- GetVisualItemInSlot(area) (the applied visual while a set is active, else the equipped item) and IsSlotHidden(area) (never for Outfit: it has no visual row).
    function N.visualSetActive(data) return data:IsVisualSetActive() end
    function N.slotHidden(data, areaName) return data:IsSlotHidden(Enum.new('gamedataEquipmentArea', areaName)) end
    -- The native WardrobeSystem holds the active set index and the saved sets (GameInstance.GetWardrobeSystem; GetActiveClothingSetIndex() -> gameWardrobeClothingSetIndex,
    -- Slot1..Slot7 or INVALID). Read by every route that exists, so a facts line shows which ones answer and whether they agree.
    local function wardrobeSystem()
        local ok, system = pcall(function() return Game.GetWardrobeSystem() end)
        if ok and system ~= nil then return system end
        return GameInstance.GetWardrobeSystem()
    end
    N.activeIndexRoutes = {
        {'Game.GetWardrobeSystem', function() return Game.GetWardrobeSystem():GetActiveClothingSetIndex() end},
        {'GameInstance.GetWardrobeSystem', function() return GameInstance.GetWardrobeSystem():GetActiveClothingSetIndex() end},
        {'EquipmentSystem.GetActiveWardrobeSetID', function(player) return EquipmentSystem.GetActiveWardrobeSetID(player) end}}
    -- The labels of the saved sets ('Slot1', ...), and the one with a given label: the game's own lookup (FindWardrobeClothingSetByID) over GetClothingSets().
    function N.storedSetLabels(player)
        local labels = {}
        for _, stored in ipairs(wardrobeSystem():GetClothingSets() or {}) do labels[#labels + 1] = enumName(stored.setID) end
        return labels
    end
    function N.storedSet(player, label)
        for _, stored in ipairs(wardrobeSystem():GetClothingSets() or {}) do
            if enumName(stored.setID) == label then return stored end
        end
        return nil
    end
    -- The per-slot visual overrides the Wardrobe menu writes (an outfit applied there fills these; the set routes above can answer "none" while it is on):
    -- EquipmentSystemPlayerData.m_clothingVisualsInfo: array<SSlotVisualInfo> (a field, read first: it also says which slots are hidden), and the getter
    -- GetSlotOverridenVisualItem(area) -> ItemID (an empty ItemID: no override). Both compiler-checked against final.redscripts (docs/PLAYER_GEAR_CONTEXT.md).
    -- A field that reads as nil is a failure, not an empty list (live 2026-10-26: `rows=0/0/0` could not tell "no rows" from "the binding gives nothing"); a row
    -- field that cannot be read leaves the row without it and the first message is kept in entries.fault.
    local function structRows(list, what)
        if list == nil then error(what .. ' reads as nil') end
        if type(list) ~= 'table' then error(what .. ' reads as ' .. type(list)) end
        local entries = {}
        for _, entry in ipairs(list) do
            local row = {id = entry.visualItem}
            local okArea, area = pcall(function() return enumName(entry.areaType) end)
            if okArea then row.area = area elseif not entries.fault then entries.fault = 'areaType: ' .. failure(area) end
            local okHidden, hidden = pcall(function() return entry.isHidden == true end)
            if okHidden then row.hidden = hidden elseif not entries.fault then entries.fault = 'isHidden: ' .. failure(hidden) end
            entries[#entries + 1] = row
        end
        return entries
    end
    function N.visualsInfo(data) return structRows(data.m_clothingVisualsInfo, 'm_clothingVisualsInfo') end
    function N.visualsEmpty(data) return data:IsClothingVisualsInfoEmpty() end
    function N.overridden(data, areaName) return data:GetSlotOverridenVisualItem(Enum.new('gamedataEquipmentArea', areaName)) end
    -- {label = <set index name>, entries = {{id = ItemID, area = <equipment area name or nil>, hidden = bool}, ...}}
    function N.wardrobeContents(set)
        local label = enumName(set.setID)
        local entries = structRows(set.clothingList, 'clothingList')
        return {label = label, entries = entries, fault = entries.fault}
    end
    -- The equipment area name ('Head', 'OuterChest', ...) an item belongs to, from its record.
    function N.itemArea(id)
        local record = TweakDBInterface.GetItemRecord(ItemID.GetTDBID(id))
        if not record then return nil end
        return enumName(record:EquipArea():Type())
    end
    -- The item really attached to V's body in a clothing area's slot (EquipmentSystemPlayerData.InitializeClothingSlotsInfo names them), or nil when the slot is empty:
    -- TransactionSystem.GetItemInSlot(object, slotID) -> ItemObject. For the same item as equipped, ItemID.GetTDBID(a) == ItemID.GetTDBID(b) compares the records.
    local ATTACHMENT_SLOTS = {Head = 'AttachmentSlots.Head', Face = 'AttachmentSlots.Eyes', OuterChest = 'AttachmentSlots.Torso', InnerChest = 'AttachmentSlots.Chest',
        Legs = 'AttachmentSlots.Legs', Feet = 'AttachmentSlots.Feet', Outfit = 'AttachmentSlots.Outfit'}
    function N.attached(player, areaName)
        local object = Game.GetTransactionSystem():GetItemInSlot(player, TweakDBID.new(ATTACHMENT_SLOTS[areaName]))
        if object == nil then return nil end
        return object:GetItemID()
    end
    function N.sameItem(a, b) return ItemID.GetTDBID(a) == ItemID.GetTDBID(b) end
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
-- outfit(player) (the visible outfit of a wardrobe mod or nil, set by init.lua), outfitUnread() (true when such an outfit may hide V's clothes and was not read),
-- nudityLog(line) (one line per change of the nudity decision).
function M.new(options)
    options = options or {}
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil, lastWardrobe = nil, lastFacts = nil, lastClothing = nil}, Instance)
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
    local ok, valid = self:check('ItemID.IsValid', N.valid, id)
    if not ok or not valid then return nil end
    local okName, text = self:check('item name', N.name, id, player)
    if not okName then return nil end
    return clean(text, M.MAX_NAME)
end

-- One generic guarded native call: a failure is remembered (once per call name, in order) for the facts line, never swallowed. Outside a wardrobe read nothing is kept.
function Instance:check(label, fn, ...)
    if type(fn) ~= 'function' then return false end
    local ok, value = pcall(fn, ...)
    if not ok and self.faults then
        local seen = false
        for _, fault in ipairs(self.faults) do if fault.label == label then seen = true end end
        if not seen then self.faults[#self.faults + 1] = {label = label, text = label .. ': ' .. failure(value)} end
    end
    return ok, value
end

-- One diagnostic line per change of the wardrobe answer (probe.log), so a live run shows which path ran or why it failed.
function Instance:logWardrobe(line)
    if line == self.lastWardrobe then return end
    self.lastWardrobe = line
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- The raw facts behind that answer (what each game read returned), once per change and BEFORE the answer line: when an outfit is on and the answer is wrong, this
-- line says whether the game reports no active set, or the reads do not return what the game's scripts say they should.
function Instance:logFacts(line)
    if line == self.lastFacts then return end
    self.lastFacts = line
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- What V is described as wearing, once per change (probe.log): the names the character is given, to compare with what the player sees.
function Instance:logClothing(rows)
    local parts = {}
    for _, row in ipairs(rows) do parts[#parts + 1] = row.slot .. '=' .. row.name end
    local line = ('Player gear clothing: ' .. table.concat(parts, ', ')):sub(1, 320)
    if line == self.lastClothing then return end
    self.lastClothing = line
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- The attachment slot of each clothing area on V's body, in the order of the facts line: {fact code, area}.
M.ATTACH = {{'hd', 'Head'}, {'fc', 'Face'}, {'ot', 'OuterChest'}, {'it', 'InnerChest'}, {'lg', 'Legs'}, {'ft', 'Feet'}, {'of', 'Outfit'}}

-- The game's active Wardrobe outfit as {areaName = item name, or false for a slot that shows nothing}; empty when no outfit is active or none could be read.
-- How the game keeps it (REDmod scripts of 2.5, docs/PLAYER_GEAR_CONTEXT.md): the native WardrobeSystem holds the active set index, EquipWardrobeSet writes every area of
-- the set into EquipmentSystemPlayerData.m_clothingVisualsInfo (an area the set leaves empty is CLEARED: hidden, even when an item is equipped there), and the game's own
-- paperdoll then shows GetVisualItemInSlot(area) per area unless IsSlotHidden(area). Sources, in order, the first that places anything wins:
--   paperdoll   the applied visuals through IsVisualSetActive / the index routes, GetVisualItemInSlot and IsSlotHidden per area;
--   set         the set's own contents through the route list (an empty entry means a hidden slot);
--   visuals     m_clothingVisualsInfo, then GetSlotOverridenVisualItem per area (a per-item transmog, or a set the other sources could not see);
--   attached    the item that is really attached to V's body in a clothing slot when it is not the equipped one (a preview item), named by its own record.
-- Nothing is swallowed: every native call that fails is named in the facts line (ferr=) or the answer line (errors=).
function Instance:wardrobe(player, data)
    local N, covered, errors = self.native, {}, {}
    local facts = {}
    self.faults = {}
    local function probe(label, fn, ...) return self:check(label, fn, ...) end
    local function try(label, fn, ...)
        local ok, value = pcall(fn, ...)
        if not ok then errors[#errors + 1] = label .. ': ' .. failure(value) end
        return ok, value
    end
    local function isValid(id)
        local ok, value = probe('ItemID.IsValid', N.valid, id)
        return ok and value == true
    end
    local function factsLine()
        local parts = {}
        for _, key in ipairs({'enabled', 'active', 'idx', 'stored', 'empty', 'paper', 'set', 'rows', 'getter', 'att'}) do
            if facts[key] ~= nil then parts[#parts + 1] = key .. '=' .. facts[key] end
        end
        local text = 'wardrobe facts ' .. table.concat(parts, ' ')
        local faults = {}
        for _, fault in ipairs(self.faults) do faults[#faults + 1] = fault.text end
        if #faults > 0 then text = text .. ' ferr=' .. table.concat(faults, '; '):sub(1, 220) end
        return text
    end
    -- The answer line, with the failures of the reads on the way (a later source may still have answered).
    local function flush(line)
        self:logFacts(factsLine())
        self:logWardrobe(#errors > 0 and (line .. ' errors=' .. table.concat(errors, '; '):sub(1, 200)) or line)
    end
    -- Place rows {id, area, hidden} into covered (a slot's first row wins); returns shown, hidden, unplaced.
    -- emptyIsHidden: a row without an item hides its slot (a saved set says it that way); a plain override row without one changes nothing.
    local function place(entries, emptyIsHidden)
        local shown, hidden, unplaced = 0, 0, 0
        for _, entry in ipairs(entries or {}) do
            local areaName = entry.area
            if not areaName or not M.AREAS[areaName] then
                -- The row's own area is unreadable or not clothing: place the item by its record instead.
                if entry.id ~= nil then
                    local ok, value = probe('itemArea', N.itemArea, entry.id)
                    areaName = ok and value or nil
                else
                    areaName = nil
                end
            end
            if areaName and M.AREAS[areaName] and covered[areaName] == nil then
                if entry.hidden then
                    covered[areaName] = false; hidden = hidden + 1
                elseif emptyIsHidden and areaName ~= 'Outfit' and not isValid(entry.id) then
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
    local function clear() covered = {} end

    -- Is the Wardrobe usable at all (a quest can disable it: the set is then unequipped).
    local enabled = true
    if type(N.wardrobeEnabled) == 'function' then
        local ok, value = try('IsWardrobeEnabled', N.wardrobeEnabled, data)
        if ok and value == false then enabled = false end
    end
    facts.enabled = tostring(enabled)
    if not enabled then flush('wardrobe outfit=off (disabled)'); return covered end

    -- Is a set active: the flag the game's own scripts use, and the index of the native system (every route, they should agree).
    local flagOk, flag = probe('IsVisualSetActive', N.visualSetActive, data)
    facts.active = (flagOk and tostring(flag) or '?')
    local indexes, idx = {}, nil
    if type(N.activeIndexRoutes) == 'table' then
        for _, route in ipairs(N.activeIndexRoutes) do
            local ok, value = probe(route[1], route[2], player, data)
            if ok and value ~= nil then
                local name = tostring(enumName(value))
                if not idx then idx = name end
                local seen = false
                for _, known in ipairs(indexes) do if known == name then seen = true end end
                if not seen then indexes[#indexes + 1] = name end
            end
        end
    end
    facts.idx = (#indexes > 0 and table.concat(indexes, '/') or '?')
    local active = (flagOk and flag == true) or (idx ~= nil and idx ~= 'INVALID')
    if type(N.storedSetLabels) == 'function' then
        local ok, labels = probe('GetClothingSets', N.storedSetLabels)
        facts.stored = (ok and type(labels) == 'table' and (#labels > 0 and table.concat(labels, ',') or '0') or '?')
    end

    -- The applied visuals and overrides, read once: the rows of m_clothingVisualsInfo (it also says which slots are hidden), and the getter per clothing area.
    -- \`empty\` is the game's own answer to "are there no rows" (IsClothingVisualsInfoEmpty): rows=0/0/0 with empty=false means the field read gives nothing.
    if type(N.visualsEmpty) == 'function' then
        local ok, value = probe('IsClothingVisualsInfoEmpty', N.visualsEmpty, data)
        facts.empty = ok and tostring(value) or '?'
    end
    -- Their failures also join the answer line's errors if that source is needed (after the set routes', which come first there).
    local rows, rowsFailure = nil, nil
    if type(N.visualsInfo) == 'function' then
        local ok, value = pcall(N.visualsInfo, data)
        if ok and type(value) == 'table' then
            rows = value
            if value.fault then probe('m_clothingVisualsInfo row', error, value.fault) end
        elseif not ok then
            rowsFailure = 'm_clothingVisualsInfo: ' .. failure(value)
            probe('m_clothingVisualsInfo', error, failure(value))
        end
    end
    do
        local total, valid, hiddenRows = 0, 0, 0
        for _, row in ipairs(rows or {}) do
            total = total + 1
            if isValid(row.id) then valid = valid + 1 end
            if row.hidden then hiddenRows = hiddenRows + 1 end
        end
        facts.rows = (rows and (total .. '/' .. valid .. '/' .. hiddenRows) or '?')
    end
    local getterRows, getterFailed = nil, nil
    if type(N.overridden) == 'function' then
        getterRows = {}
        for _, row in ipairs(M.CLOTHING) do
            local ok, id = pcall(N.overridden, data, row[2])
            if ok then getterRows[#getterRows + 1] = {id = id, area = row[2]} elseif not getterFailed then getterFailed = failure(id) end
        end
        if getterFailed then probe('GetSlotOverridenVisualItem', error, getterFailed) end
        local valid = 0
        for _, row in ipairs(getterRows) do if isValid(row.id) then valid = valid + 1 end end
        facts.getter = (getterFailed and '?' or valid)
    end

    -- The paperdoll reads, always probed (even with no set active they show whether the calls work): per area except Outfit, GetVisualItemInSlot and IsSlotHidden.
    local paperRows, paperItems, paperFlagged = {}, 0, 0
    if type(N.visual) == 'function' then
        for _, row in ipairs(M.CLOTHING) do
            if row[2] ~= 'Outfit' then
                local okArea, area = probe('Enum.new', N.area, row[2])
                local okId, id = false, nil
                if okArea and area ~= nil then okId, id = probe('GetVisualItemInSlot', N.visual, data, area) end
                local okHidden, hidden = probe('IsSlotHidden', N.slotHidden, data, row[2])
                if okId then
                    local isHidden = okHidden and hidden == true
                    if isHidden then paperFlagged = paperFlagged + 1 elseif isValid(id) then paperItems = paperItems + 1 end
                    paperRows[#paperRows + 1] = {id = id, area = row[2], hidden = isHidden}
                end
            end
        end
        facts.paper = paperItems .. '/' .. paperFlagged
    end

    -- What is really attached to V's body in each clothing slot, against what is equipped: S the same item, N nothing, D a different one (a preview item shown in an
    -- empty slot), E the read failed. A D whose record belongs to that area is the last source.
    local attachedRows = {}
    if type(N.attached) == 'function' then
        local codes = {}
        for _, row in ipairs(M.ATTACH) do
            local okAttached, attachedId = probe('GetItemInSlot', N.attached, player, row[2])
            local symbol = 'E'
            if okAttached then
                if attachedId == nil then
                    symbol = 'N'
                else
                    local okArea, area = probe('Enum.new', N.area, row[2])
                    local okEq, equippedId = false, nil
                    if okArea and area ~= nil then okEq, equippedId = probe('GetItemInEquipSlot', N.equipped, data, area, 0) end
                    if okEq and isValid(equippedId) then
                        local okSame, same = probe('ItemID.GetTDBID', N.sameItem, attachedId, equippedId)
                        symbol = okSame and (same and 'S' or 'D') or 'E'
                    else
                        symbol = okEq and 'D' or 'E'
                    end
                    if symbol == 'D' then attachedRows[#attachedRows + 1] = {id = attachedId, area = row[2]} end
                end
            end
            codes[#codes + 1] = row[1] .. symbol
        end
        facts.att = table.concat(codes, ',')
    end

    -- Source 0, what the worn items hide (no Wardrobe set needed). An equipped Outfit-area item (a suit, a dress, a jumpsuit) and any long coat carry visual tags (hide_T1 inner
    -- torso, hide_T2 outer torso, hide_L1 legs, hide_S1 feet, hide_H1 head, hide_F1 face; EquipmentSystemPlayerData.InitializeClothingSlotsInfo, equipmentSystem.script l.696 to
    -- 702), and the game clears the appearance of every area whose tag one of them carries and sets that area's isHidden (ClearItemAppearance l.1441 to 1453). IsSlotHidden(area)
    -- is what the game's own paperdoll honours, so a hidden area is not visible on V even though its item is still equipped. Live 2026-10-27 (the owner wore Aguilar's suit over
    -- a jacket, tank top, pants and shoes): paper=1/4 (the aviators shown, outer torso, inner torso, legs and feet hidden), while the equipment listed all of them.
    -- Used when no set is active and at least one area is hidden; a set that is active is read by the sources below as before.
    if not active and paperFlagged > 0 then
        local shown, hidden = place(paperRows, false)
        if hidden > 0 then
            flush('wardrobe outfit=worn items=' .. shown .. ' hidden=' .. hidden .. ' via=IsSlotHidden')
            return covered
        end
        clear()
    end

    -- Source 1, the paperdoll: while a set is active, each area shows what GetVisualItemInSlot says, and nothing where IsSlotHidden (EquipWardrobeSet flags every area the
    -- set leaves empty). An area with neither keeps the equipped item (the set does not cover it, or its item blocks transmog).
    -- Taken only when it found an item or a hidden flag (a set that is active by index but whose rows are empty is not trusted: the next sources look).
    if active and paperItems + paperFlagged > 0 then
        local shown, hidden = place(paperRows, false)
        if shown + hidden > 0 then
            flush('wardrobe outfit=' .. (idx or 'active') .. ' items=' .. shown .. (hidden > 0 and (' hidden=' .. hidden) or '') .. ' via=paperdoll')
            return covered
        end
        clear()
    end

    -- Source 2, the set's own contents, from every route until one returns a set (the active index names the set for the stored-sets route).
    local set, via, answered, failed, routeErrors = nil, nil, false, false, ''
    if type(N.wardrobeRoutes) == 'table' and type(N.wardrobeContents) == 'function' then
        for _, route in ipairs(N.wardrobeRoutes) do
            -- route[3]: the route needs the active index (it looks the set up by it), so it is skipped without one.
            if not route[3] or (idx ~= nil and idx ~= 'INVALID') then
                local ok, value = try(route[1], route[2], player, data, idx)
                if ok then answered = true end
                if ok and value ~= nil then set, via = value, route[1]; break end
            end
        end
        if set == nil and not answered then failed = true end
    end
    local line = 'wardrobe outfit=off'
    if set ~= nil then
        local ok, contents = try('wardrobeContents', N.wardrobeContents, set)
        if not ok or type(contents) ~= 'table' then
            failed = true
        else
            if contents.fault then probe('clothingList row', error, contents.fault) end
            local label = tostring(contents.label or 'active')
            local count, valid = 0, 0
            for _, entry in ipairs(contents.entries or {}) do
                count = count + 1
                if isValid(entry.id) then valid = valid + 1 end
            end
            facts.set = label .. ':' .. count .. '/' .. valid
            -- A set without entries is the empty set the game hands out when nothing is active (the INVALID one too).
            if label ~= 'INVALID' and count > 0 then
                local shown, hidden, unplaced = place(contents.entries, true)
                if shown + hidden == 0 then
                    clear()
                    line = 'wardrobe outfit=' .. label .. ' items=0 unplaced=' .. unplaced .. ' via=' .. via
                else
                    flush('wardrobe outfit=' .. label .. ' items=' .. shown .. (hidden > 0 and (' hidden=' .. hidden) or '') .. ' via=' .. via)
                    return covered
                end
            end
        end
    else
        facts.set = (failed and '?' or 'none')
    end
    routeErrors = table.concat(errors, '; '):sub(1, 200)

    -- Source 3, the overrides: the rows of m_clothingVisualsInfo (hidden slots included), else the getter per area. An override row without an item changes nothing.
    if rowsFailure then errors[#errors + 1] = rowsFailure end
    if rows then
        local shown, hidden = place(rows, false)
        if shown + hidden > 0 then
            flush('wardrobe outfit=visuals items=' .. shown .. (hidden > 0 and (' hidden=' .. hidden) or '') .. ' via=m_clothingVisualsInfo')
            return covered
        end
        clear()
    end
    if getterRows then
        if getterFailed then errors[#errors + 1] = 'GetSlotOverridenVisualItem: ' .. getterFailed end
        local shown = place(getterRows, false)
        if shown > 0 then
            flush('wardrobe outfit=visuals items=' .. shown .. ' via=GetSlotOverridenVisualItem')
            return covered
        end
        clear()
    end

    -- Source 4, the attachments: an item attached to V that is not the equipped one and belongs to that area is what is visible there.
    do
        local candidates = {}
        for _, row in ipairs(attachedRows) do
            local ok, area = probe('itemArea', N.itemArea, row.id)
            if ok and area == row.area then candidates[#candidates + 1] = row end
        end
        if #candidates > 0 then
            local shown = place(candidates, false)
            if shown > 0 then
                flush('wardrobe outfit=attached items=' .. shown .. ' via=GetItemInSlot')
                return covered
            end
            clear()
        end
    end

    -- Nothing placed. Every set route failing with nothing else to show is an error; an index that says a set is active but nothing readable is said so.
    if failed then
        self:logFacts(factsLine())
        self:logWardrobe('wardrobe outfit=error(' .. routeErrors .. ')')
        return covered
    end
    if active and line == 'wardrobe outfit=off' then line = 'wardrobe outfit=' .. (idx or 'active') .. ' items=0 unreadable' end
    flush(line)
    return covered
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
    -- Whether each clothing slot visibly holds something, for the nudity note: 'worn', 'empty' or 'unknown' (a read that failed is never "empty").
    local worn = {}
    if type(outfit) == 'table' and type(outfit.parts) == 'table' then
        snapshot.layered = true
        for _, row in ipairs(M.CLOTHING) do worn[row[1]] = 'empty' end
        for _, part in ipairs(outfit.parts) do
            add('clothing', part.slot, self:itemName(part.id, player))
            if worn[part.slot] ~= nil and call(N.valid, part.id) then worn[part.slot] = 'worn' end
        end
    else
        -- The game's own Wardrobe: an active saved set shows its items on V; a slot the set does not cover keeps the visible/equipped item.
        -- A fault in the wardrobe reader costs only the wardrobe: it is named in the log and the equipment is described.
        local readOk, covered = pcall(self.wardrobe, self, player, data)
        if not readOk or type(covered) ~= 'table' then
            self:logWardrobe('wardrobe outfit=error(reader: ' .. failure(covered) .. ')')
            covered = {}
        end
        for _, row in ipairs(M.CLOTHING) do
            worn[row[1]] = 'unknown'
            if covered[row[2]] ~= nil then
                add('clothing', row[1], covered[row[2]] or nil)
                worn[row[1]] = covered[row[2]] and 'worn' or 'empty'
            else
                local area = call(N.area, row[2])
                if area ~= nil then
                    local okVisual, id = pcall(N.visual, data, area)
                    if okVisual and call(N.valid, id) then
                        worn[row[1]] = 'worn'
                    else
                        local okEquipped, equipped = pcall(N.equipped, data, area, 0)
                        if okEquipped then
                            id = equipped
                            worn[row[1]] = call(N.valid, id) and 'worn' or 'empty'
                        else
                            id = nil
                        end
                    end
                    add('clothing', row[1], self:itemName(id, player))
                end
            end
        end
    end
    if snapshot.clothing then self:logClothing(snapshot.clothing) end
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
    -- Nudity (docs/PLAYER_GEAR_CONTEXT.md): V's torso and legs visibly empty. Only from reads that succeeded, and never when a wardrobe mod's outfit may be hiding the clothes
    -- and was not read.
    local others = 0
    for _, list in ipairs({'weapons', 'cyberware'}) do others = others + #(snapshot[list] or {}) end
    for _, slot in ipairs({'head', 'face', 'feet'}) do
        for _, row in ipairs(snapshot.clothing or {}) do if row.slot == slot then others = others + 1 end end
    end
    local nudity, why = M.nudity(worn, others, self.options.outfitUnread and call(self.options.outfitUnread) == true)
    snapshot.nudity = nudity
    self:logNudity(nudity, why)
    if count == 0 and not nudity then return nil, 'no named items found' end
    return snapshot, count
end

-- 'topless' (the torso is empty, the legs are covered), 'nude' (both empty), else nil, and the reason in a few words for the log. `worn` maps a clothing slot to
-- 'worn', 'empty' or 'unknown'; `others` counts the items read outside the torso and legs (a read that found nothing at all is a failed read, not a naked V);
-- `hidden` is true when a wardrobe mod's outfit may be covering the real clothes and was not read.
function M.nudity(worn, others, hidden)
    if hidden then return nil, 'unknown(outfit mod not read)' end
    local function state(...)
        local result = 'empty'
        for _, slot in ipairs({...}) do
            local value = worn[slot]
            if value == 'worn' then return 'worn' end
            if value ~= 'empty' then result = 'unknown' end
        end
        return result
    end
    local torso, legs = state('outerTorso', 'innerTorso', 'outfit'), state('legs', 'outfit')
    if torso == 'unknown' or legs == 'unknown' then
        if torso == 'worn' and legs == 'unknown' then return nil, 'none' end
        return nil, 'unknown(a slot could not be read)'
    end
    if torso == 'worn' then return nil, 'none' end
    if legs == 'worn' then return 'topless', 'torso=empty legs=worn' end
    if others <= 0 then return nil, 'unknown(nothing else was read)' end
    return 'nude', 'torso=empty legs=empty'
end

-- One line per change (probe.log): what the nudity read decided, so a live test shows why V was or was not called topless.
function Instance:logNudity(nudity, why)
    -- A clothed V is silent (the usual case); a claim, its end, and a read that could not tell are logged.
    local line = 'Player gear: nudity=' .. tostring(nudity or 'none') .. (why and (' (' .. why .. ')') or '')
    local quiet = nudity == nil and not (self.lastNudity and self.lastNudity:find('nudity=none', 1, true) == nil) and not (why and why:find('^unknown'))
    if line == self.lastNudity or quiet then return end
    self.lastNudity = line
    if type(self.options.nudityLog) == 'function' then pcall(self.options.nudityLog, line) end
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
