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
    -- clothingList: array<SSlotVisualInfo {areaType: gamedataEquipmentArea, visualItem: ItemID, isHidden: Bool}>}; GameInstance.GetWardrobeSystem(game) ->
    -- ref<WardrobeSystem>; EquipmentSystemPlayerData.IsWardrobeEnabled() -> Bool; EquipmentSystem.GetActiveWardrobeSet(player) is STATIC.
    -- Routes are tried in order until one returns a set; each failure is reported (its name and message), never swallowed.
    N.wardrobeRoutes = {
        {'data:GetActiveWardrobeSet', function(_, data) return data:GetActiveWardrobeSet() end},
        {'Game.GetWardrobeSystem', function() return Game.GetWardrobeSystem():GetActiveClothingSet() end},
        {'GameInstance.GetWardrobeSystem', function(player) return GameInstance.GetWardrobeSystem(player:GetGame()):GetActiveClothingSet() end},
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
    local function wardrobeSystem(player)
        local ok, system = pcall(function() return Game.GetWardrobeSystem() end)
        if ok and system ~= nil then return system end
        return GameInstance.GetWardrobeSystem(player:GetGame())
    end
    N.activeIndexRoutes = {
        {'Game.GetWardrobeSystem', function() return Game.GetWardrobeSystem():GetActiveClothingSetIndex() end},
        {'GameInstance.GetWardrobeSystem', function(player) return GameInstance.GetWardrobeSystem(player:GetGame()):GetActiveClothingSetIndex() end},
        {'EquipmentSystem.GetActiveWardrobeSetID', function(player) return EquipmentSystem.GetActiveWardrobeSetID(player) end}}
    -- The labels of the saved sets ('Slot1', ...), and the one with a given label: the game's own lookup (FindWardrobeClothingSetByID) over GetClothingSets().
    function N.storedSetLabels(player)
        local labels = {}
        for _, stored in ipairs(wardrobeSystem(player):GetClothingSets() or {}) do labels[#labels + 1] = enumName(stored.setID) end
        return labels
    end
    function N.storedSet(player, label)
        for _, stored in ipairs(wardrobeSystem(player):GetClothingSets() or {}) do
            if enumName(stored.setID) == label then return stored end
        end
        return nil
    end
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
    return setmetatable({options = options, native = options.native or nativeAdapter(), snapshot = nil, at = nil, lastWardrobe = nil, lastFacts = nil}, Instance)
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

-- The raw facts behind that answer (what each game read returned), once per change and BEFORE the answer line: when an outfit is on and the answer is wrong, this
-- line says whether the game reports no active set, or the reads do not return what the game's scripts say they should.
function Instance:logFacts(line)
    if line == self.lastFacts then return end
    self.lastFacts = line
    if type(self.options.log) == 'function' then pcall(self.options.log, line) end
end

-- The game's active Wardrobe outfit as {areaName = item name, or false for a slot that shows nothing}; empty when no outfit is active or none could be read.
-- How the game keeps it (REDmod scripts of 2.5, docs/PLAYER_GEAR_CONTEXT.md): the native WardrobeSystem holds the active set index, EquipWardrobeSet writes every area of
-- the set into EquipmentSystemPlayerData.m_clothingVisualsInfo (an area the set leaves empty is CLEARED: hidden, even when an item is equipped there), and the game's own
-- paperdoll then shows GetVisualItemInSlot(area) per area unless IsSlotHidden(area). Sources, in order, the first that places anything wins:
--   paperdoll   the applied visuals through IsVisualSetActive / the index routes, GetVisualItemInSlot and IsSlotHidden per area;
--   set         the set's own contents through the route list (an empty entry means a hidden slot);
--   visuals     m_clothingVisualsInfo, then GetSlotOverridenVisualItem per area (a per-item transmog, or a set the other sources could not see).
-- Nothing is swallowed: every read that fails is named in the facts or the answer line.
function Instance:wardrobe(player, data)
    local N, covered, errors, factErrors = self.native, {}, {}, {}
    local facts = {}
    local function try(label, fn, ...)
        local ok, value = pcall(fn, ...)
        if not ok then errors[#errors + 1] = label .. ': ' .. failure(value) end
        return ok, value
    end
    -- A read that only feeds the facts line (and the active decision): its failure never shows in the answer line.
    local function probe(label, fn, ...)
        if type(fn) ~= 'function' then return false end
        local ok, value = pcall(fn, ...)
        if not ok then factErrors[#factErrors + 1] = label .. ': ' .. failure(value) end
        return ok, value
    end
    local function factsLine()
        local parts = {}
        for _, key in ipairs({'enabled', 'active', 'idx', 'stored', 'paper', 'set', 'rows', 'getter'}) do
            if facts[key] ~= nil then parts[#parts + 1] = key .. '=' .. facts[key] end
        end
        local text = 'wardrobe facts ' .. table.concat(parts, ' ')
        if #factErrors > 0 then text = text .. ' ferr=' .. table.concat(factErrors, '; '):sub(1, 150) end
        return text
    end
    -- The answer line, with the failures of the reads on the way (a later source may still have answered).
    local function flush(line)
        self:logFacts(factsLine())
        self:logWardrobe(#errors > 0 and (line .. ' errors=' .. table.concat(errors, '; '):sub(1, 200)) or line)
    end
    -- Place rows {id, area, hidden} into covered (a slot's first row wins); returns shown, hidden, unplaced.
    -- emptyIsHidden: a row without an item hides its slot (a saved set and the applied visuals say it that way); a plain override row without one changes nothing.
    local function place(entries, emptyIsHidden)
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
                elseif emptyIsHidden and areaName ~= 'Outfit' and not call(N.valid, entry.id) then
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
        local ok, labels = probe('GetClothingSets', N.storedSetLabels, player)
        facts.stored = (ok and type(labels) == 'table' and (#labels > 0 and table.concat(labels, ',') or '0') or '?')
    end

    -- The applied visuals and overrides, read once: the rows of m_clothingVisualsInfo (it also says which slots are hidden), and the getter per clothing area.
    -- Their failures join the answer line's errors only if that source is needed (after the set routes', which come first there).
    local rows, rowsFailure = nil, nil
    if type(N.visualsInfo) == 'function' then
        local ok, value = pcall(N.visualsInfo, data)
        if ok and type(value) == 'table' then rows = value
        elseif not ok then rowsFailure = 'm_clothingVisualsInfo: ' .. failure(value) end
    end
    do
        local total, valid, hiddenRows = 0, 0, 0
        for _, row in ipairs(rows or {}) do
            total = total + 1
            if call(N.valid, row.id) then valid = valid + 1 end
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
        local valid = 0
        for _, row in ipairs(getterRows) do if call(N.valid, row.id) then valid = valid + 1 end end
        facts.getter = (getterFailed and '?' or valid)
    end

    -- Source 1, the paperdoll: while a set is active, each area shows what GetVisualItemInSlot says, and nothing where IsSlotHidden (EquipWardrobeSet flags every area the
    -- set leaves empty). An area with neither keeps the equipped item (the set does not cover it, or its item blocks transmog).
    -- Taken only when it found an item or a hidden flag (a set that is active by index but whose rows are empty is not trusted: the next sources look).
    local paper = nil
    if active and type(N.visual) == 'function' then
        local paperRows, items, flagged = {}, 0, 0
        for _, row in ipairs(M.CLOTHING) do
            if row[2] ~= 'Outfit' then
                local area = call(N.area, row[2])
                local okId, id = false, nil
                if area ~= nil then okId, id = probe('GetVisualItemInSlot', N.visual, data, area) end
                local okHidden, hidden = probe('IsSlotHidden', N.slotHidden, data, row[2])
                if okId then
                    local isHidden = okHidden and hidden == true
                    if isHidden then flagged = flagged + 1 elseif call(N.valid, id) then items = items + 1 end
                    paperRows[#paperRows + 1] = {id = id, area = row[2], hidden = isHidden}
                end
            end
        end
        facts.paper = items .. '/' .. flagged
        if items + flagged > 0 then paper = paperRows end
    end
    if paper then
        local shown, hidden = place(paper, false)
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
            local label = tostring(contents.label or 'active')
            local count, valid = 0, 0
            for _, entry in ipairs(contents.entries or {}) do
                count = count + 1
                if call(N.valid, entry.id) then valid = valid + 1 end
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
    if type(outfit) == 'table' and type(outfit.parts) == 'table' then
        snapshot.layered = true
        for _, part in ipairs(outfit.parts) do add('clothing', part.slot, self:itemName(part.id, player)) end
    else
        -- The game's own Wardrobe: an active saved set shows its items on V; a slot the set does not cover keeps the visible/equipped item.
        -- A fault in the wardrobe reader costs only the wardrobe: it is named in the log and the equipment is described.
        local readOk, covered = pcall(self.wardrobe, self, player, data)
        if not readOk or type(covered) ~= 'table' then
            self:logWardrobe('wardrobe outfit=error(reader: ' .. failure(covered) .. ')')
            covered = {}
        end
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
