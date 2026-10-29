-- Character bonds and their story packs (docs/RELATIONSHIPS_AND_QUESTS.md, bridge/bonds.mjs). Settings > Gameplay > Character bonds and Story packs, Off by default.
--
-- The game half is small: the bridge keeps the bond and the packs and words them for the character; the game says what is on, how V stands with the
-- character, shows one notice when a level changes, and carries out the few things a pack stage can make the game do (section 7.4 of the doc).
--   attach(context)  once per private turn V sends to a named character (typed, spoken, on a holocall, in a group round or in Phone Chat), while the
--                    setting is On: a `bonds` block {version = 1, on = true, copy = 'party' | 'visitor' | 'housemate' | nil, packs = true | nil,
--                    invitations = true | nil, busy = true | nil} and a short watch for the bridge's status file. All of it is computed once, at the turn.
--   update(player)   from the 10 Hz tick, nothing unless a watch is armed: runtime/bonds-status.json is read at most once a second for 30 s after a
--                    turn. A level change newer than the last one seen is shown as one notice ("Bond with Judy: level 5, Good friend"), and a new
--                    `effectsRevision` makes the game read runtime/bond-effects.json once (items to give or take, outfits). The watch ends 3 s after the
--                    first notice or effect, or after 30 s.
--   vehicleBlocked(profileKey)  at a decision (the companion car choice, a visitor's car arrival): runtime/bond-effects.json is read there, then.
--   outfitState / anyOutfit / outfitDone  for mod/companion-outfits.lua, which puts a party copy in another look of the character (and back).
--   view(profileKey) for the Characters page: the bond level and the active story, from the status file, read at most every 5 s.
--   characters() for the Relationships page (Companion Manager home): the characters V has talked to, with their bond details, from the same cached read.
-- Effects belong to the save: an entry stamped with a game clock later than the loaded save's (plus a slack) belongs to a save that was loaded away
-- from and is ignored. Only the mod's own copies are ever dressed or driven; a game-placed character gets talk, face and audio only.
-- No per-frame work: Off, attach returns at the first check and update at a nil check. The game writes only runtime/bond-effects-done.json, and only
-- when an item was moved.
local M = {version = 1}
M.STATUS = 'runtime/bonds-status.json'
M.EFFECTS = 'runtime/bond-effects.json'
M.DONE = 'runtime/bond-effects-done.json'
local WATCH_SECONDS, POLL_SECONDS, GRACE_SECONDS, MAX_FILE, EFFECTS_MAX = 30, 1, 3, 65536, 65536
local VIEW_SECONDS, RESTORE_SECONDS, MAX_DONE, SLACK = 5, 600, 60, 120
local COPIES = {party = true, visitor = true, housemate = true}

-- options: enabled() -> bool; storyPacks() -> bool; invitations() -> bool (Immersive invitations on); busy() -> bool (a scene, dialogue choice, combat,
-- game call or vehicle chase); ownCopy(entity, profileKey) -> 'party' | 'visitor' | 'housemate' | nil; clock() -> seconds (os.clock);
-- gameTime() -> V's game clock in seconds or nil; read(path) -> text | nil; write(path, text) -> bool; encode / decode (json); player() -> V;
-- give(player, record, quantity), remove(player, record, quantity), quantity(player, record) (the game's transaction calls by default);
-- notice(player, text); t(text, vars) (mod/ui-locale.lua); log(line).
function M.new(options)
    options = options or {}
    local P = {}
    local watchUntil, pollAt, seen, lastRaw = nil, 0, nil, nil
    local effectsRev                   -- the last effectsRevision acted on (nil: none yet this session)
    local outfits, restore = nil, {}   -- the outfit entries of the effects file (nil until read), and the profiles to put back: key -> clock to give up at
    local wearing = {}                 -- the profiles that were in `outfits` at the last read (so a profile that went is put back)
    local viewAt, viewValue = nil, nil
    local done                         -- the ids of the items already moved, in order (loaded on demand)
    local function call(fn, ...)
        if type(fn) ~= 'function' then return false, nil end
        return pcall(fn, ...)
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Bonds: ' .. line) end end
    -- The game's translations (mod/ui-locale.lua, given as options.t); every text below is a literal so the UI catalogue finds it.
    local ui = {t = function(text, vars)
        if type(options.t) == 'function' then
            local ok, value = pcall(options.t, text, vars)
            if ok and type(value) == 'string' then return value end
        end
        return (text:gsub('{(%w+)}', function(key) return vars and vars[key] ~= nil and tostring(vars[key]) or '{' .. key .. '}' end))
    end}
    local function clock() local ok, value = call(options.clock); return ok and type(value) == 'number' and value or os.clock() end
    local function flag(fn) local ok, value = call(fn); return ok and value == true end
    local function enabled() return flag(options.enabled) end
    local function packsOn() return flag(options.storyPacks) end
    local function decode(raw) local ok, value = pcall(options.decode or json.decode, raw); return ok and value or nil end
    local function encode(value) local ok, raw = pcall(options.encode or json.encode, value); return ok and type(raw) == 'string' and raw or nil end
    local function read(path, limit)
        limit = limit or MAX_FILE
        if type(options.read) == 'function' then local ok, raw = pcall(options.read, path); return ok and raw or nil end
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(limit + 1); file:close()
        return raw
    end
    local function write(path, text)
        if type(options.write) == 'function' then local ok, finished = pcall(options.write, path, text); return ok and finished ~= false end
        local file = io.open(path, 'wb')
        if not file then return false end
        local written, closed = file:write(text), file:close()
        return written and closed and true or false
    end
    local function status()
        local raw = read(M.STATUS)
        if type(raw) ~= 'string' or raw == '' or #raw > MAX_FILE then return nil, raw end
        local value = decode(raw)
        if type(value) ~= 'table' or value.version ~= 1 or type(value.revision) ~= 'number' then return nil, raw end
        return value, raw
    end

    -- The level titles, in the menu language (bridge/bonds.mjs LEVELS holds the same English titles).
    local function title(level)
        if level == 1 then return ui.t('Acquaintance') elseif level == 2 then return ui.t('Familiar face')
        elseif level == 3 then return ui.t('Friendly') elseif level == 4 then return ui.t('Friend')
        elseif level == 5 then return ui.t('Good friend') elseif level == 6 then return ui.t('Close friend')
        elseif level == 7 then return ui.t('Trusted') elseif level == 8 then return ui.t('Confidant')
        elseif level == 9 then return ui.t('Family') elseif level == 10 then return ui.t('Ride or die') end
        return nil
    end
    M.title = title
    P.title = title

    local function whole(value, low, high)
        return type(value) == 'number' and value == value and value == math.floor(value) and value >= low and value <= high
    end
    local function plain(text, limit)
        return type(text) == 'string' and text ~= '' and #text <= limit and not text:find('%c') and text or nil
    end

    -- The words of one change, or nil for a malformed one.
    function P.text(change)
        if type(change) ~= 'table' or not whole(change.to, 1, 10) or not whole(change.from, 1, 10) or change.to == change.from then return nil end
        local name = plain(change.name, 80)
        if not name then return nil end
        local vars = {name = name, level = change.to, title = title(change.to)}
        if change.to > change.from then return ui.t('Bond with {name}: level {level}, {title}', vars) end
        return ui.t('Bond with {name} fell: level {level}, {title}', vars)
    end

    -- ---- the effects file -------------------------------------------------------------------------------------------------------------
    local function gameTime()
        local ok, value = call(options.gameTime)
        value = ok and tonumber(value) or nil
        return value and value == value and value >= 0 and math.floor(value) or nil
    end
    -- An entry stamped later than the loaded save's clock (plus a slack) belongs to a save that was loaded away from. `strict`: with the clock
    -- unknown an entry that has a stamp is not trusted (items are one-way; a car or a look is not).
    local function fresh(since, strict)
        if since == nil then return true end
        if not whole(since, 0, 1e12) then return false end
        local now = gameTime()
        if not now then return not strict end
        return since <= now + SLACK
    end
    local function effects()
        local raw = read(M.EFFECTS, EFFECTS_MAX)
        if type(raw) ~= 'string' or raw == '' or #raw > EFFECTS_MAX then return nil end
        local value = decode(raw)
        if type(value) ~= 'table' or value.version ~= 1 then return nil end
        return value
    end
    local function list(value) return type(value) == 'table' and value or {} end
    local function keyOf(profileKey) return type(profileKey) == 'string' and #profileKey <= 80 and profileKey:match('^[a-z0-9][a-z0-9-]*$') and profileKey or nil end

    -- Her own car is not available (a pack stage's `vehicleBlocked`; it ends when the entry goes: `vehicleReturned`). Read now, at the decision.
    function P.vehicleBlocked(profileKey)
        if not keyOf(profileKey) or not packsOn() or not enabled() then return false end
        local value = effects()
        if not value then return false end
        for _, row in ipairs(list(value.blocked)) do
            if type(row) == 'table' and row.profileKey == profileKey and fresh(row.since, false) then return true end
        end
        return false
    end

    -- ---- outfits ----------------------------------------------------------------------------------------------------------------------
    -- The entries are read when the effects file is (the first need, then at each new effectsRevision); freshness is judged at each ask.
    local function readOutfits(value)
        local rows, now = {}, {}
        for _, row in ipairs(list(value and value.outfits)) do
            local key = type(row) == 'table' and keyOf(row.profileKey) or nil
            if key and #rows < 64 then
                rows[#rows + 1] = {profileKey = key, since = row.since}
                if fresh(row.since, false) then now[key] = true end
            end
        end
        -- A profile that was dressed and is not any more is put back in its own look (until the copy shows it, or after a while).
        for key in pairs(wearing) do
            if not now[key] then restore[key] = clock() + RESTORE_SECONDS end
        end
        for key in pairs(now) do restore[key] = nil end
        wearing, outfits = now, rows
    end
    local function loadOutfits()
        if outfits == nil then readOutfits(effects()) end
    end
    -- 'wear': her copy wears another of her looks for the stage; 'restore': it goes back to its own; nil: nothing is asked.
    function P.outfitState(profileKey)
        if not keyOf(profileKey) or not packsOn() or not enabled() then return nil end
        loadOutfits()
        for _, row in ipairs(outfits or {}) do
            if row.profileKey == profileKey and fresh(row.since, false) then return 'wear' end
        end
        local until_ = restore[profileKey]
        if until_ then
            if clock() <= until_ then return 'restore' end
            restore[profileKey] = nil
        end
        return nil
    end
    function P.outfitWanted(profileKey) return P.outfitState(profileKey) == 'wear' end
    -- True while any look is asked for (a nil check and a table walk; no file is read, so it may be asked every tick).
    function P.anyOutfit()
        if outfits == nil or (#outfits == 0 and next(restore) == nil) then return false end
        if not packsOn() or not enabled() then return false end
        if #outfits > 0 then return true end
        local now = clock()
        for key, until_ in pairs(restore) do
            if now <= until_ then return true end
            restore[key] = nil
        end
        return false
    end
    -- The copy shows its own look again: nothing more is asked for that profile.
    function P.outfitDone(profileKey) restore[profileKey] = nil end

    -- ---- items ------------------------------------------------------------------------------------------------------------------------
    local function loadDone()
        if done then return done end
        done = {}
        local raw = read(M.DONE)
        local value = type(raw) == 'string' and raw ~= '' and #raw <= MAX_FILE and decode(raw) or nil
        if type(value) == 'table' and value.version == 1 and type(value.ids) == 'table' then
            for _, id in ipairs(value.ids) do
                if type(id) == 'string' and #id <= 120 and #done < MAX_DONE then done[#done + 1] = id end
            end
        end
        return done
    end
    local function wasDone(id)
        for _, known in ipairs(loadDone()) do if known == id then return true end end
        return false
    end
    local function saveDone(id)
        local ids = loadDone()
        ids[#ids + 1] = id
        while #ids > MAX_DONE do table.remove(ids, 1) end
        local raw = encode({version = 1, ids = ids})
        if not raw or not write(M.DONE, raw) then log('item list not written') end
    end
    local function giveItem(player, record, count)
        if type(options.give) == 'function' then return options.give(player, record, count) end
        return Game.GetTransactionSystem():GiveItem(player, ItemID.FromTDBID(TweakDBID.new(record)), count)
    end
    local function removeItem(player, record, count)
        if type(options.remove) == 'function' then return options.remove(player, record, count) end
        return Game.GetTransactionSystem():RemoveItem(player, ItemID.FromTDBID(TweakDBID.new(record)), count)
    end
    local function countItem(player, record)
        if type(options.quantity) == 'function' then return options.quantity(player, record) end
        return Game.GetTransactionSystem():GetItemQuantity(player, ItemID.FromTDBID(TweakDBID.new(record)))
    end

    -- One item entry, once. Returns true when it was moved or refused for good (its mark is kept), false when it is left for a later look.
    local function moveItem(player, row)
        if type(row) ~= 'table' or type(row.id) ~= 'string' or #row.id > 80 or not row.id:match('^[%w_.:-]+$') then return false end
        if row.kind ~= 'giveItem' and row.kind ~= 'takeItem' then return false end
        local record = type(row.record) == 'string' and row.record:match('^Items%.[%w_]+$') and #row.record <= 80 and row.record or nil
        if not record or not whole(row.quantity, 1, 10) or not keyOf(row.profileKey) then return false end
        if not fresh(row.since, true) then return false end
        local mark = row.id .. '@' .. tostring(row.since or '')
        if wasDone(mark) then return false end
        local count = row.quantity
        if row.kind == 'giveItem' then
            local ok, result = pcall(giveItem, player, record, count)
            log(string.format('person=%s item=%s give %s x%d %s', tostring(row.profileKey), row.id, record, count, (ok and result ~= false) and 'done' or 'failed'))
        else
            local okCount, have = pcall(countItem, player, record)
            have = okCount and tonumber(have) or nil
            if not have then return false end
            if have >= count then
                local ok, result = pcall(removeItem, player, record, count)
                log(string.format('person=%s item=%s take %s x%d %s', tostring(row.profileKey), row.id, record, count, (ok and result ~= false) and 'done' or 'failed'))
            else
                log(string.format('person=%s item=%s take %s x%d skipped (V has %d)', tostring(row.profileKey), row.id, record, count, have))
            end
        end
        saveDone(mark)
        return true
    end

    -- The effects file, read once for a new revision: the outfits are noted and the one-shot items are moved. Returns true when anything changed.
    local function applyEffects(player)
        local value = effects()
        if not value then
            outfits = outfits or {}
            return false
        end
        local before = #(outfits or {})
        readOutfits(value)
        local acted = before ~= #outfits
        if player and packsOn() then
            local tried = 0
            for _, row in ipairs(list(value.items)) do
                tried = tried + 1
                if tried > 16 then break end
                if moveItem(player, row) then acted = true end
            end
        end
        return acted
    end

    -- ---- the turn and the watch -------------------------------------------------------------------------------------------------------
    -- A private turn V sends to a named character (typed, spoken, on a holocall, in a group round or in Phone Chat): its block, while the setting is On.
    function P.attach(context)
        if type(context) ~= 'table' or not enabled() then return nil end
        local copy = nil
        if not context.holocall and not context.phone then
            local ok, value = call(options.ownCopy, context.entity, context.profileKey)
            copy = ok and COPIES[value] and value or nil
        end
        local block = {version = 1, on = true, copy = copy}
        if packsOn() then block.packs = true end
        if flag(options.invitations) then block.invitations = true end
        if flag(options.busy) then block.busy = true end
        context.bonds = block
        -- The first turn of a session learns where the level changes stand, so a change from before it is not shown again. (The effects are not
        -- skipped: the first poll reads them once, and the list of items done keeps an item from being moved twice.)
        if seen == nil then
            local value = status()
            seen = value and value.revision or 0
        end
        watchUntil, pollAt = clock() + WATCH_SECONDS, 0
        return block
    end

    function P.pending() return watchUntil ~= nil end

    -- From the 0.1 s tick, only while a watch is armed.
    function P.update(player)
        if not watchUntil then return end
        local now = clock()
        if now > watchUntil or not enabled() then watchUntil = nil; return end
        if now < pollAt then return end
        pollAt = now + POLL_SECONDS
        local value, raw = status()
        if raw == lastRaw then return end
        lastRaw = raw
        if not value then return end
        local acted = false
        -- A new effectsRevision: the bridge changed a pack stage. (The first one of a session is read too; it is not a change to wait for.)
        if whole(value.effectsRevision, 0, 1e15) and value.effectsRevision ~= effectsRev then
            local first = effectsRev == nil
            effectsRev, viewAt = value.effectsRevision, nil
            local ok, result = pcall(applyEffects, player)
            if not ok then log('effects failed: ' .. tostring(result):sub(1, 120)) end
            acted = ok and result == true and not first
        end
        local shown = false
        if type(value.changes) == 'table' then
            local newest = seen or 0
            for _, change in ipairs(value.changes) do
                if type(change) == 'table' and type(change.id) == 'number' and change.id > (seen or 0) then
                    if change.id > newest then newest = change.id end
                    local text = P.text(change)
                    if text and type(options.notice) == 'function' then
                        pcall(options.notice, player, text); shown = true
                        log('person=' .. tostring(change.profileKey) .. ' level=' .. tostring(change.from) .. '->' .. tostring(change.to))
                    end
                end
            end
            seen = newest
        end
        -- A notice or an effect is the answer of the turn; the status may still be written once more right after, so the watch lingers a moment.
        if shown or acted then watchUntil = math.min(watchUntil, now + GRACE_SECONDS) end
    end

    -- ---- the Characters page ----------------------------------------------------------------------------------------------------------
    -- How V stands with one character and the story they are in, from the status file (at most one read every 5 s); nil with the setting Off.
    -- The status file as the pages see it: read at most every 5 s (one read serves the Characters page and the Relationships page alike).
    local function viewStatus()
        local now = clock()
        if viewAt == nil or now - viewAt >= VIEW_SECONDS or now < viewAt then
            viewAt = now
            viewValue = status()
        end
        return viewValue
    end
    function P.view(profileKey)
        if not keyOf(profileKey) or not enabled() then return nil end
        local value = viewStatus()
        local row = type(value) == 'table' and type(value.levels) == 'table' and value.levels[profileKey] or nil
        if type(row) ~= 'table' or not whole(row.level, 1, 10) then return nil end
        local out = {level = row.level, title = title(row.level)}
        local pack = packsOn() and type(value.packs) == 'table' and value.packs[profileKey] or nil
        if type(pack) == 'table' then out.story = plain(pack.title, 80) end
        return out
    end

    -- The Relationships page (Companion Manager home): the characters V has talked to, as the bridge listed them (most recent first), from the same cached read.
    -- nil with the setting Off or no usable file; otherwise a list that may be empty. Every field may be missing or malformed: a bad entry is dropped (no name),
    -- a bad field is left out. The level title is in the menu language, a story pack's title and label are the pack's own English text.
    -- Stories (packs) are listed only with Story packs On.
    local MAX_CHARACTERS, MAX_PACKS = 300, 10
    local function count(value, high)
        if type(value) ~= 'number' or value ~= value or value < 0 or value > (high or 1e9) then return nil end
        return math.floor(value)
    end
    function P.characters()
        if not enabled() then return nil end
        local value = viewStatus()
        if type(value) ~= 'table' then return nil end
        local rows = type(value.characters) == 'table' and value.characters or {}
        local withPacks = packsOn()
        local out = {}
        for _, row in ipairs(rows) do
            if #out >= MAX_CHARACTERS then break end
            local name = type(row) == 'table' and plain(row.name, 80) or nil
            if name then
                local item = {profileKey = keyOf(row.profileKey), name = name}
                if whole(row.level, 1, 10) then item.level, item.title = row.level, title(row.level) end
                item.points, item.from, item.next = count(row.points), count(row.from), count(row.next)
                item.warm, item.hurt, item.hurtDays = count(row.warm), count(row.hurt), count(row.hurtDays, 100000)
                item.story, item.talk = count(row.story), count(row.talk)
                item.arcDone, item.arcTotal = count(row.arcDone, 100000), count(row.arcTotal, 100000)
                item.lastAt = count(row.lastAt, 1e15)
                if withPacks then
                    item.packs = {}
                    for _, pack in ipairs(type(row.packs) == 'table' and row.packs or {}) do
                        if #item.packs >= MAX_PACKS then break end
                        local packTitle = type(pack) == 'table' and plain(pack.title, 80) or nil
                        local state = type(pack) == 'table' and (pack.state == 'active' or pack.state == 'done') and pack.state or nil
                        if packTitle and state then
                            item.packs[#item.packs + 1] = {title = packTitle, state = state, label = plain(pack.label, 160)}
                        end
                    end
                end
                out[#out + 1] = item
            end
        end
        return out
    end

    return P
end

return M
