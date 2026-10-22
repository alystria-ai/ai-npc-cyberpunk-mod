-- Street reputation, the game side (docs/REPUTATION_DESIGN.md). Loaded and hooked only while Settings > Conversations > Street reputation
-- is on (settings.reputation, default off): with it off init.lua never loads this file, so no hook is registered and nothing is written.
--
-- It records V's deeds as they happen, event-driven only (no update function, nothing per frame):
--   kill / defeat   an ordinary NPC V killed or took down (NPCPuppet.OnDeath / OnDefeated, ObserveAfter): the person's affiliation, police and
--                   crowd flags, whether it happened in an open fight (V in combat: the person's crew saw it), the district, the game clock
--   heat            a wanted episode starts or rises (PreventionSystem.ChangeHeatStage, ObserveAfter): the game raised heat, so a crime was seen
--   react           an ordinary NPC's reaction actually started (mod/npc-reactions.lua: leave, call the police, attack)
-- into a ring of the last 64 deeds. The ring rides with the next turn to an ordinary NPC (capture, inline: no extra write) and is written
-- to runtime/reputation-events.json only at a load, a fast travel, the game's shutdown, or when 64 deeds wait unwritten (flush). The bridge
-- (bridge/reputation.mjs) counts each deed once by its sequence number. Named, story, quest and companion characters are never recorded:
-- their consequences are the quest facts the bridge already reads.
--
-- Every native call is guarded; a hook whose reads keep failing logs once. CET cannot remove an observer, so after the setting is turned
-- off again the hooks stay until the game restarts but return at their first line.
local M = {version = 1}
M.PATH = 'runtime/reputation-events.json'
M.RING = 64
M.DISTRICT_CACHE = 15   -- seconds a district read is reused (a firefight kills several people in the same place)

-- options:
--   enabled()            the setting (manager.reputation)             observe(class, method, fn)   ObserveAfter (a test's fake)
--   player()             V                                             gameTime()   game seconds or nil      lifepath()   'nomad' ...
--   district()           {district =, area =} or nil (init.lua currentDistrict)
--   ordinary(npc)        false for our companions, another mod's characters, named, story and quest people
--   stat(name)           V's stat by gamedataStatType name (StreetCred, Level), or nil
--   write(path, raw)     optional; default io.open 'wb' in place (the file ships as an empty placeholder: Mod Organizer 2)
--   clock()              seconds (os.clock)       log(line)       session   this CET session's id
function M.new(options)
    options = type(options) == 'table' and options or {}
    local S = {options = options, ring = {}, seq = 0, flushed = 0, hooks = {}, counts = {calls = 0, recorded = 0, skipped = {}, seconds = 0},
        lastHeat = nil, lp = nil, districtAt = nil, districtValue = nil, logged = {}}
    S.session = type(options.session) == 'string' and options.session or ('lua-' .. tostring(os.time()) .. '-' .. tostring(math.random(100000, 999999)))
    local clock = options.clock or os.clock

    local function call(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end
    local function say(key, line)
        if S.logged[key] then return end
        S.logged[key] = true
        if type(options.log) == 'function' then pcall(options.log, line) end
    end
    local function skip(reason)
        S.counts.skipped[reason] = (S.counts.skipped[reason] or 0) + 1
        say('skip:' .. reason, 'Reputation: deed not recorded (' .. reason .. ')')
    end

    function S.on()
        local ok, value = pcall(options.enabled or function() return false end)
        return ok and value == true
    end

    local function district()
        local now = clock()
        if S.districtAt and now - S.districtAt < M.DISTRICT_CACHE and now >= S.districtAt then return S.districtValue end
        local value = call(options.district)
        S.districtAt, S.districtValue = now, type(value) == 'table' and value or nil
        return S.districtValue
    end
    local function lifepath()
        if S.lp == nil then
            local value = call(options.lifepath)
            if value == 'nomad' or value == 'streetkid' or value == 'corpo' then S.lp = value end
        end
        return S.lp
    end

    -- One deed into the ring. Writes only when 64 deeds wait unwritten (the bridge sees the ring with every ordinary-NPC turn).
    local function record(row)
        local seconds = call(options.gameTime)
        if type(seconds) ~= 'number' or seconds ~= seconds or seconds < 0 then skip('no-game-clock'); return false end
        local where = district()
        S.seq = S.seq + 1
        row.s, row.t = S.seq, math.floor(seconds)
        if where then row.d, row.r = where.district, where.area end
        row.lp = lifepath()
        S.ring[#S.ring + 1] = row
        while #S.ring > M.RING do table.remove(S.ring, 1) end
        S.counts.recorded = S.counts.recorded + 1
        if S.counts.recorded <= 3 then
            if type(options.log) == 'function' then pcall(options.log, 'Reputation: deed recorded #' .. S.counts.recorded .. ' (' .. row.k .. ')') end
        end
        if S.seq - S.flushed >= M.RING then S.flush('ring-full') end
        return true
    end

    local function nameOf(value)
        if value == nil then return nil end
        if type(value) == 'string' then return value end
        local ok, text = pcall(function() return Game.NameToString(value) end)
        if ok and type(text) == 'string' and text ~= '' and text ~= 'None' then return text end
        ok, text = pcall(tostring, value)
        return ok and type(text) == 'string' and text or nil
    end

    -- V killed or took down this person. `instigator`: the event's instigator (nil when the event carries none). The killer must read as V:
    -- an unreadable killer is not counted. Witnessed: V was in an open fight at that moment.
    function S.deed(kind, npc, instigator)
        if not S.on() then return false end
        local started = clock()
        S.counts.calls = S.counts.calls + 1
        local done = false
        local ok, err = pcall(function()
            if npc == nil then return end
            local byPlayer = instigator ~= nil and call(function() return instigator:IsPlayer() end)
            if byPlayer ~= true then return end
            if call(options.ordinary, npc) ~= true then skip('not-ordinary'); return end
            local player = call(options.player)
            local fighting = player ~= nil and call(function() return player:IsInCombat() end) == true
            local row = {k = kind, w = fighting,
                a = nameOf(call(function() return npc:GetAffiliation() end)),
                p = call(function() return npc:IsCharacterPolice() end) == true,
                c = call(function() return npc:IsCrowd() end) == true}
            done = record(row)
        end)
        if not ok then skip('read-failed'); say('error:' .. kind, 'Reputation: ' .. kind .. ' hook failed: ' .. tostring(err):sub(1, 160)) end
        S.counts.seconds = S.counts.seconds + math.max(0, clock() - started)
        return done
    end

    -- The prevention system changed V's heat: a new wanted episode (from 0) or a further stage. A fall only updates what is remembered.
    function S.heat(system)
        if not S.on() then return false end
        local started = clock()
        S.counts.calls = S.counts.calls + 1
        local stage = call(function() return system:GetHeatStageAsInt() end)
        stage = tonumber(stage)
        local done = false
        if stage == nil then skip('heat-unreadable')
        else
            local before = S.lastHeat or 0
            S.lastHeat = stage
            if stage > before then done = record({k = 'heat', x = before == 0 and 'start' or 'rise'}) end
        end
        S.counts.seconds = S.counts.seconds + math.max(0, clock() - started)
        return done
    end

    -- An ordinary NPC's reaction actually started (mod/npc-reactions.lua onReaction). who: {base, category, affiliation}.
    function S.reaction(kind, who)
        if not S.on() then return false end
        if kind ~= 'leave' and kind ~= 'call-police' and kind ~= 'attack' then return false end
        who = type(who) == 'table' and who or {}
        local function text(value) return type(value) == 'string' and value or nil end
        return record({k = 'react', x = kind, b = text(who.base), g = text(who.category), a = text(who.affiliation)})
    end

    -- Registers the hooks once (when the setting is first on in this CET session). Returns how many registered.
    function S.install()
        if S.installed then return #S.hooks end
        S.installed = true
        local observe = options.observe
        if type(observe) ~= 'function' then return 0 end
        local function hook(class, method, fn)
            local ok, err = pcall(observe, class, method, fn)
            if ok then S.hooks[#S.hooks + 1] = class .. '.' .. method
            else say('hook:' .. method, 'Reputation hook unavailable: ' .. class .. '.' .. method .. ' ' .. tostring(err)) end
        end
        -- The event's instigator is read inside the callback and never kept.
        hook('NPCPuppet', 'OnDeath', function(npc, event)
            if not S.on() then return end
            S.deed('kill', npc, call(function() return event.instigator end))
        end)
        hook('NPCPuppet', 'OnDefeated', function(npc, event)
            if not S.on() then return end
            S.deed('defeat', npc, call(function() return event.instigator end))
        end)
        hook('PreventionSystem', 'ChangeHeatStage', function(system) if S.on() then S.heat(system) end end)
        if type(options.log) == 'function' then pcall(options.log, 'Reputation hooks: ' .. table.concat(S.hooks, ', ')) end
        return #S.hooks
    end

    -- The `reputation` field of a turn to an ordinary NPC: the session, V's Street Cred, level and game clock now, and the ring.
    function S.capture()
        if not S.on() then return nil end
        local cred, level, seconds = tonumber(call(options.stat, 'StreetCred')), tonumber(call(options.stat, 'Level')), call(options.gameTime)
        local events = {}
        for index, row in ipairs(S.ring) do events[index] = row end
        local out = {version = 1, session = S.session, events = events}
        if cred and cred == cred then out.cred = math.floor(cred) end
        if level and level == level then out.level = math.floor(level) end
        if type(seconds) == 'number' and seconds == seconds and seconds >= 0 then out.t = math.floor(seconds) end
        return out
    end

    -- Writes the ring when deeds wait unwritten. Called at a load or quit (world reset), a fast travel, shutdown, and when the ring is full.
    function S.flush(reason)
        if S.seq <= S.flushed then return false end
        local encoded, raw = pcall(function() return json.encode({version = 1, session = S.session, events = S.ring}) end)
        if not encoded or type(raw) ~= 'string' then skip('encode-failed'); return false end
        local written = false
        if type(options.write) == 'function' then
            local ok, result = pcall(options.write, M.PATH, raw)
            written = ok and result ~= false
        else
            local okOpen, file = pcall(io.open, M.PATH, 'wb')
            if okOpen and file then
                written = pcall(function() file:write(raw) end)
                pcall(function() file:close() end)
            end
        end
        if not written then skip('write-failed'); return false end
        S.flushed = S.seq
        say('flush:' .. tostring(reason), 'Reputation: deeds written (' .. tostring(reason) .. ')')
        return true
    end

    -- A load, a quit to the menu or a death: write what waits, then start the new world empty (its clock, lifepath and heat are its own).
    function S.reset(reason)
        S.flush(reason or 'world-reset')
        S.ring, S.lastHeat, S.lp, S.districtAt, S.districtValue = {}, nil, nil, nil, nil
    end

    function S.status()
        local skipped = {}
        for reason, count in pairs(S.counts.skipped) do skipped[reason] = count end
        return {enabled = S.on(), hooks = S.hooks, calls = S.counts.calls, recorded = S.counts.recorded, ring = #S.ring,
            unwritten = S.seq - S.flushed, hookMs = math.floor(S.counts.seconds * 100000 + 0.5) / 100, skipped = skipped}
    end
    return S
end

return M
