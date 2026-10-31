-- The game side executor of the bond quests (docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md sections 14 and 21).
--
-- The bridge owns the quest (the stage, the gap, the choices, the endings, all stamped with the game clock) and writes the stage to execute into
-- runtime/quest-play.json. This module reads it, arms the stage's `do` primitives (mod/quest-prims.lua), evaluates the stage's `script` rows when an event
-- happens (a scripted line, a text, a gap, another event: mod/quest-lines.lua) and reports what happened by rewriting runtime/quest-events.json.
--
--   P.update(player, delta)   from the 0.1 s tick. One nil check while no quest is armed. With a quest it works once a second: the play file is read (a
--                             changed file is applied), the ctx timers and the primitives are ticked, the places are watched.
--   P.onPlayRevision()        the bridge says the play file changed (a playRevision in runtime/bonds-status.json): read it now
--   P.restore()               session start: read the play file once and arm what it names (a quest ending is not played again)
--   P.worldChanged()          a save was loaded or the world ended: every pin is dead (forgotten without asking the system), every ctx is reaped, the file is
--                             read again from the saved stage
--   P.emit(quest, name, opts) an event of a quest, opts {report = false, data = {...}}. P.inject(name) is the developer probe, it injects one for every armed quest
--   P.factsWanted()           the facts the bridge wants read (the play file's factsWanted, cleaned), or nil when there are none (mod/quest-facts.lua)
--   P.reach()                 the play file's reach block, cleaned (mod/quest-reach.lua), or nil. options.onReach(block | nil) is called whenever a play file is applied
--                             (block nil when the file is gone or the world ended). P.refresh() reads the play file now (the reach tick, while it has items to watch)
--   P.emitReach(id, data)     the event `reach:<id>` of a delivered reach-out, with pack "reach" and serial 0 (it belongs to no quest), written to the events file at once
--   P.status()                what the module holds
--   options.journal           the real quests (mod/quest-journal.lua, docs/REAL_QUESTS.md): handed the play file's journal block whenever a play file is applied,
--                             cleared when the file is gone or the setting is off, reset when the world ends. Nothing of it runs on the tick
--
-- Event data: an event may carry `data`, a flat table of at most 6 keys whose values are numbers, booleans or strings of at most 80 characters (anything else is
-- dropped). It goes to the bridge in runtime/quest-events.json with the event, and a bridge command may carry it too (it reaches the listeners).
--
-- ctx (the single cleanup owner of a quest stage): ctx:track(kind, handle, undo), ctx:after(seconds, fn), ctx:every(seconds, fn), ctx:on(event, fn(name, data)),
-- ctx:emit(name, data), ctx:reap() (LIFO, idempotent). A stage change reaps the old stage's ctx and starts the new one. A quest that leaves the file, the setting
-- going off and a quest stamped later than the loaded save's clock + 120 s (it belongs to a save that was loaded away from) are handled the same way.
--
-- options: enabled() -> bool, clock() -> seconds (monotonic real clock), gameTime() -> the game clock in seconds | nil, read(path), write(path, text),
--   encode, decode, places (mod/quest-places.lua), lines (mod/quest-lines.lua), prims (mod/quest-prims.lua), session (a fixed session id, for tests), log(line).
local M = {PLAY = 'runtime/quest-play.json', EVENTS = 'runtime/quest-events.json', TAG = 'CyberpunkConvaiQuest', STEP = 1, SLACK = 120, MAX_FILE = 262144,
    MAX_QUESTS = 8, MAX_EVENTS = 32, MAX_DRAIN = 64, MAX_DO = 16, MAX_ROWS = 64, MAX_FAILS = 3, MAX_SEEN = 256, MAX_DATA = 6, MAX_FACTS = 32, MAX_FACT_NAMES = 8,
    MAX_REACH = 24}

local function plainId(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[%w][%w%.:_%-]*$') ~= nil end
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end
local function keyName(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[a-z0-9][a-z0-9%-]*$') ~= nil end
local function whole(value, low, high)
    return type(value) == 'number' and value == value and value == math.floor(value) and value >= low and value <= high
end
local function list(value) return type(value) == 'table' and value or {} end

-- Event data (docs/QUEST_PRIMITIVES.md section 10.1): a flat table of at most 6 keys, each value a finite number, a boolean or a string of at most 80 characters.
-- Returns a fresh clean table, or nil when nothing is left. Keys are short plain names.
function M.cleanData(value)
    if type(value) ~= 'table' then return nil end
    local out, count = {}, 0
    for key, item in pairs(value) do
        if type(key) == 'string' and #key > 0 and #key <= 32 and key:match('^[%w_%-]+$') then
            local kind, keep = type(item), nil
            if kind == 'number' and item == item and item ~= math.huge and item ~= -math.huge then keep = item
            elseif kind == 'boolean' then keep = item
            elseif kind == 'string' then keep = #item <= 80 and item or item:sub(1, 80):gsub('[\128-\191]+$', '') end
            if keep ~= nil and count < M.MAX_DATA then out[key], count = keep, count + 1 end
        end
    end
    return count > 0 and out or nil
end

-- The facts the bridge wants read: {id, names = {...}, kind = 'bool' | 'enum', values = {...}}. At most 32 facts of 8 names each, names of 80 characters.
local function cleanFacts(value)
    local out = {}
    for _, row in ipairs(list(value)) do
        if #out >= M.MAX_FACTS then break end
        if type(row) == 'table' and plainId(row.id) and (row.kind == 'bool' or row.kind == 'enum') and type(row.names) == 'table' then
            local names = {}
            for _, name in ipairs(row.names) do
                if #names < M.MAX_FACT_NAMES and type(name) == 'string' and #name > 0 and #name <= 80 and name:match('^[%w_%.:%-]+$') then names[#names + 1] = name end
            end
            if #names > 0 then
                local values
                if row.kind == 'enum' and type(row.values) == 'table' then
                    values = {}
                    for index, name in ipairs(names) do
                        local text = row.values[index]
                        if text == nil then text = row.values[name] end
                        if type(text) == 'string' and #text > 0 and #text <= 80 then values[index] = text end
                    end
                end
                out[#out + 1] = {id = row.id, names = names, kind = row.kind, values = values}
            end
        end
    end
    return #out > 0 and out or nil
end

-- The reach block of the play file (docs/QUEST_PRIMITIVES.md section 10.7): {enabled, items = [{id, character, via, text, image?, when?, offer?}], perHour?, perDay?}.
-- Cleaned here (shapes and sizes only, the conditions are judged by mod/quest-reach.lua): at most 24 items, a bad item is dropped, nil when nothing usable is left.
local REACH_VIAS = {text = true, call = true, voice = true}
local function cleanReach(value)
    if type(value) ~= 'table' or type(value.items) ~= 'table' then return nil end
    local items, seen = {}, {}
    for _, row in ipairs(value.items) do
        if #items >= M.MAX_REACH then break end
        if type(row) == 'table' and type(row.id) == 'string' and row.id:match('^[a-z][a-z0-9%-]+$') and #row.id <= 32 and not seen[row.id]
            and keyName(row.character) and REACH_VIAS[row.via] and type(row.text) == 'string' and #row.text > 0 and #row.text <= 600 then
            seen[row.id] = true
            local when = nil
            if type(row.when) == 'table' and type(row.when.kind) == 'string' and #row.when.kind <= 24 then
                when = {}
                for key, item in pairs(row.when) do
                    local kind = type(item)
                    if type(key) == 'string' and #key <= 24 and (kind == 'boolean' or kind == 'string' and #item <= 60
                        or kind == 'number' and item == item and item ~= math.huge and item ~= -math.huge) then when[key] = item end
                end
            end
            items[#items + 1] = {id = row.id, character = row.character, via = row.via, text = row.text,
                image = keyName(row.image) and row.image or nil, when = when, offer = plainId(row.offer) and row.offer or nil}
        end
    end
    if #items == 0 then return nil end
    return {enabled = value.enabled == true, items = items,
        perHour = whole(value.perHour, 1, 6) and value.perHour or nil, perDay = whole(value.perDay, 1, 12) and value.perDay or nil}
end

function M.new(options)
    options = options or {}
    local P = {}
    local quests = {}            -- pack -> quest scope {pack, character, stage, serial, rows, fired, ctx, ...}
    local armed = false
    local acc = 0
    local lastRaw = nil
    local seq, events, eventsDirty, flushFails = 0, {}, false, 0
    local session = options.session or string.format('%x%x', os.time() % 16777215, math.random(0, 16777215))
    local seenCommands, seenCount = {}, 0
    local closed, closedCount = {}, 0
    local queue, draining = {}, false
    local closingScopes = {}     -- pack -> the scope of an ended quest, so the events of its ending lines still reach the bridge
    local logged = {}
    local places, lines, prims = options.places, options.lines, options.prims
    local wantedFacts = nil      -- the play file's factsWanted, cleaned (mod/quest-facts.lua reads them), nil when there are none
    local reachBlock = nil       -- the play file's reach block, cleaned (mod/quest-reach.lua reads it), nil when there is none
    local journal = options.journal   -- the real quests (mod/quest-journal.lua), or nil

    -- ---- the game's calls, all guarded --------------------------------------------------------------------------------------------------
    local function clock()
        local ok, value = pcall(options.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function gameTime()
        if type(options.gameTime) ~= 'function' then return nil end
        local ok, value = pcall(options.gameTime)
        return ok and type(value) == 'number' and value == value and value >= 0 and value or nil
    end
    local function enabled()
        if type(options.enabled) ~= 'function' then return false end
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Quest play: ' .. line) end end
    local function logOnce(key, line)
        if logged[key] then return end
        logged[key] = true
        log(line)
    end
    local function decode(raw) local ok, value = pcall(options.decode or json.decode, raw); return ok and value or nil end
    local function encode(value) local ok, raw = pcall(options.encode or json.encode, value); return ok and type(raw) == 'string' and raw or nil end
    local function read(path)
        if type(options.read) == 'function' then local ok, raw = pcall(options.read, path); return ok and raw or nil end
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(M.MAX_FILE + 1); file:close()
        return raw
    end
    local function write(path, text)
        if type(options.write) == 'function' then local ok, done = pcall(options.write, path, text); return ok and done ~= false end
        local file = io.open(path, 'wb')
        if not file then return false end
        local written, closedOk = file:write(text), file:close()
        return written and closedOk and true or false
    end

    -- The reach block (mod/quest-reach.lua): held cleaned, and the owner is told whenever a play file is applied (or the file goes away).
    local function setReach(block)
        reachBlock = block
        if type(options.onReach) == 'function' then
            local ok, err = pcall(options.onReach, block)
            if not ok then logOnce('reach', 'the reach block could not be handed over: ' .. tostring(err)) end
        end
    end

    -- The real quests (mod/quest-journal.lua): every call guarded, a failure there never stops a quest stage.
    local function journalCall(name, ...)
        if journal == nil or type(journal[name]) ~= 'function' then return end
        local ok, err = pcall(journal[name], ...)
        if not ok then logOnce('journal:' .. name, 'the journal could not be updated: ' .. tostring(err)) end
    end

    local function rearm()
        armed = next(quests) ~= nil or eventsDirty
            or (lines ~= nil and lines.pending()) or (places ~= nil and places.active())
    end
    P.rearm = rearm

    -- ---- the events file ----------------------------------------------------------------------------------------------------------------
    -- A write that fails is tried again on the next steps. After twenty failures in a row the events are given up (the file cannot be written), so a
    -- read-only folder cannot keep the module busy for ever.
    local function flush()
        if not eventsDirty then return end
        -- `at`: the game clock (seconds) of this write, so the bridge's clocks stay current (left out when the game cannot say).
        local raw = encode({version = 1, session = session, seq = seq, at = gameTime(), events = events})
        if raw and write(M.EVENTS, raw) then
            eventsDirty, flushFails = false, 0
            return
        end
        flushFails = flushFails + 1
        if flushFails >= 20 then
            eventsDirty, flushFails = false, 0
            logOnce('events', 'the events file cannot be written, events are dropped')
        end
    end

    local function record(q, name, data)
        seq = seq + 1
        events[#events + 1] = {seq = seq, pack = q.pack, serial = q.serial, name = name, at = gameTime() or 0, data = data}
        while #events > M.MAX_EVENTS do table.remove(events, 1) end
        eventsDirty = true
    end

    -- ---- rows and events ----------------------------------------------------------------------------------------------------------------
    -- A text from a character who stands beside V is odd: a quest that V began in person (not by Phone Chat or a holocall) says it in her reply, so a plain text row
    -- (no picture) is left out while she is near (options.near, asked here at the row, never per frame). The row still counts as done for the script.
    local function textInPerson(q, row)
        if q.via == 'phone' or q.via == 'holocall' or row.image ~= nil or type(options.near) ~= 'function' then return false end
        local ok, near = pcall(options.near, q.character)
        return ok and near == true
    end

    local function runRow(q, row)
        if type(row) ~= 'table' then return end
        if lines then
            -- A line of an ending (the scope of an ended quest) cannot wait for her to come: the line player sends it as a text when her copy is not here.
            if type(row.say) == 'string' then lines.say(q.pack, row.say, {bark = row.bark == true, final = q.closing == true}) end
            if type(row.text) == 'string' then lines.text(q.pack, row.text, type(row.image) == 'string' and row.image or nil, textInPerson(q, row)) end
            if type(row.gap) == 'string' then lines.openGap(q.pack, row.gap) end
        end
        if type(row.event) == 'string' then P.emit(q, row.event) end
    end

    local function handle(item)
        local q, name = item.q, item.name
        if q.dead then return end
        if item.report then record(q, name, item.data) end
        if lines then lines.onEvent(q.pack, name) end
        if q.ctx then q.ctx:dispatch(name, item.data) end
        for index, row in ipairs(q.rows) do
            if index > M.MAX_ROWS then break end
            if not q.fired[index] and type(row) == 'table' and row.when == name then
                q.fired[index] = true
                local ok, err = pcall(runRow, q, row)
                if not ok then logOnce('row:' .. q.pack .. ':' .. index, 'a script row failed: ' .. tostring(err)) end
            end
        end
    end

    -- An event of a quest: reported to the bridge (unless it came from the bridge), offered to the ctx's listeners and the gap, and answered by the stage's
    -- rows (each once per stage visit, in file order). Events raised while one is handled wait their turn.
    function P.emit(q, name, opts)
        if type(q) ~= 'table' or q.dead or not eventName(name) then return false end
        queue[#queue + 1] = {q = q, name = name, report = not (opts and opts.report == false), data = opts and M.cleanData(opts.data) or nil}
        if draining then return true end
        draining = true
        local guard = 0
        while #queue > 0 and guard < M.MAX_DRAIN do
            guard = guard + 1
            local item = table.remove(queue, 1)
            local ok, err = pcall(handle, item)
            if not ok then logOnce('event:' .. item.name, 'event ' .. item.name .. ' failed: ' .. tostring(err)) end
        end
        if #queue > 0 then logOnce('loop', 'an event loop was cut'); queue = {} end
        draining = false
        flush()
        rearm()
        return true
    end

    -- ---- the ctx ------------------------------------------------------------------------------------------------------------------------
    local function newCtx(q)
        local ctx = {pack = q.pack, character = q.character, serial = q.serial, stage = q.stage, places = q.places, tag = M.TAG .. ':' .. q.pack,
            gifts = q.gifts, calls = q.calls, tracked = {}, timers = {}, listeners = {}, prims = {}, reaped = false}
        function ctx:track(kind, handle, undo)
            if self.reaped then
                if type(undo) == 'function' then pcall(undo, handle) end
                return nil
            end
            self.tracked[#self.tracked + 1] = {kind = kind, handle = handle, undo = undo}
            return handle
        end
        function ctx:untrack(handle, run)
            for index = #self.tracked, 1, -1 do
                local item = self.tracked[index]
                if item.handle == handle then
                    table.remove(self.tracked, index)
                    if run ~= false and type(item.undo) == 'function' then pcall(item.undo, handle) end
                    return true
                end
            end
            return false
        end
        local function timer(self, seconds, fn, opts, every)
            if self.reaped or type(fn) ~= 'function' then return nil end
            seconds = tonumber(seconds)
            if not seconds or seconds ~= seconds or seconds < 0 or seconds > 1e8 then return nil end
            local game = gameTime()
            local real = (opts and opts.real == true) or game == nil
            local t = {fn = fn, real = real, every = every and math.max(1, seconds) or nil}
            t.at = (real and clock() or game) + seconds
            self.timers[#self.timers + 1] = t
            return t
        end
        function ctx:after(seconds, fn, opts) return timer(self, seconds, fn, opts, false) end
        function ctx:every(seconds, fn, opts) return timer(self, seconds, fn, opts, true) end
        function ctx:cancel(t)
            for index = #self.timers, 1, -1 do if self.timers[index] == t then table.remove(self.timers, index) end end
        end
        function ctx:on(name, fn)
            if self.reaped or type(name) ~= 'string' or type(fn) ~= 'function' then return nil end
            self.listeners[#self.listeners + 1] = {name = name, fn = fn}
            return fn
        end
        function ctx:dispatch(name, data)
            if self.reaped or #self.listeners == 0 then return end
            local snapshot = {}
            for index, l in ipairs(self.listeners) do snapshot[index] = l end
            for _, l in ipairs(snapshot) do
                if l.name == name and not self.reaped then pcall(l.fn, name, data) end
            end
        end
        function ctx:emit(name, data) if not self.reaped then P.emit(q, name, data ~= nil and {data = data} or nil) end end
        -- The world is gone (a load, a detach): nothing is asked of it any more, the ctx just lets go.
        function ctx:forget()
            self.reaped = true
            self.timers, self.listeners, self.prims, self.tracked = {}, {}, {}, {}
        end
        function ctx:reap()
            if self.reaped then return false end
            self.reaped = true
            self.timers, self.listeners = {}, {}
            for index = #self.prims, 1, -1 do
                local inst = self.prims[index]
                local disarm = inst.def.disarm
                if disarm then pcall(disarm, self, inst.spec, inst.state, prims and prims.env) end
            end
            self.prims = {}
            for index = #self.tracked, 1, -1 do
                local item = self.tracked[index]
                self.tracked[index] = nil
                if type(item.undo) == 'function' then pcall(item.undo, item.handle) end
            end
            return true
        end
        return ctx
    end

    local function runTimers(ctx)
        if #ctx.timers == 0 then return end
        local real, game = clock(), gameTime()
        local due = {}
        for _, t in ipairs(ctx.timers) do
            local now = t.real and real or game
            if now and now >= t.at then due[#due + 1] = {t, now} end
        end
        for _, row in ipairs(due) do
            local t, now = row[1], row[2]
            if ctx.reaped then return end
            if t.every then t.at = now + t.every else ctx:cancel(t) end
            local ok, err = pcall(t.fn)
            if not ok then logOnce('timer:' .. ctx.pack, 'a timer failed: ' .. tostring(err)) end
        end
    end

    local function tickPrims(ctx)
        if #ctx.prims == 0 then return end
        local now = clock()
        local snapshot = {}
        for index, inst in ipairs(ctx.prims) do snapshot[index] = inst end
        for _, inst in ipairs(snapshot) do
            if ctx.reaped then return end
            if inst.def.tick and not inst.dead and now >= inst.nextAt then
                inst.nextAt = now + (inst.def.interval or 1)
                local ok, err = pcall(inst.def.tick, ctx, inst.spec, inst.state, prims.env)
                if ok then inst.fails = 0
                else
                    inst.fails = inst.fails + 1
                    logOnce('prim:' .. inst.name .. ctx.pack, 'primitive ' .. inst.name .. ' failed: ' .. tostring(err))
                    if inst.fails >= M.MAX_FAILS then inst.dead = true end
                end
            end
        end
    end

    local function armStage(q)
        if not prims then return end
        local ctx = q.ctx
        for index, spec in ipairs(q.doList) do
            if index > M.MAX_DO then break end
            if type(spec) == 'table' and type(spec.p) == 'string' then
                local def = prims.get(spec.p)
                if not def then
                    logOnce('unknown:' .. spec.p, 'unknown primitive ' .. spec.p)
                else
                    local ok, state = pcall(def.arm, ctx, spec, prims.env)
                    if not ok then
                        logOnce('arm:' .. spec.p .. q.pack, 'primitive ' .. spec.p .. ' could not start: ' .. tostring(state))
                    elseif state ~= nil then
                        ctx.prims[#ctx.prims + 1] = {name = spec.p, def = def, spec = spec, state = state, nextAt = 0, fails = 0}
                    end
                end
            end
        end
    end

    -- ---- quests -------------------------------------------------------------------------------------------------------------------------
    local function fresh(since)
        if since == nil then return true end
        if type(since) ~= 'number' or since ~= since or since < 0 then return false end
        local now = gameTime()
        if not now then return true end
        return since <= now + M.SLACK
    end

    local function clean(q)
        if type(q) ~= 'table' or not plainId(q.pack) or not keyName(q.character) or not plainId(q.stage) or not whole(q.serial, 0, 1e9) then return nil end
        return {pack = q.pack, character = q.character, stage = q.stage, serial = q.serial, since = q.since,
            via = (q.via == 'own' or q.via == 'phone' or q.via == 'holocall') and q.via or nil,   -- how V began the quest: in person, Phone Chat or a holocall
            places = type(q.places) == 'table' and q.places or {}, doList = list(q['do']), rows = list(q.script), lines = list(q.lines),
            gaps = list(q.gaps), images = list(q.images), gap = type(q.gap) == 'table' and q.gap or nil,
            gifts = type(q.gifts) == 'table' and q.gifts or nil,   -- the character's likes rules for a gift primitive (loved, liked, disliked)
            calls = type(q.calls) == 'table' and q.calls or nil, music = type(q.music) == 'table' and q.music or nil, sfx = type(q.sfx) == 'table' and q.sfx or nil,   -- the call-in / call-script calls and the stage's sounds (mod/quest-prims-calls.lua, mod/quest-audio.lua)
        }
    end

    local function endQuest(q, final)
        q.dead = true
        if quests[q.pack] == q then quests[q.pack] = nil end
        if q.ctx and final then q.ctx.final = true end
        if q.ctx then q.ctx:reap() end
        if final and prims and type(prims.dropCarried) == 'function' then pcall(prims.dropCarried, q.pack) end
        if lines then lines.dropPack(q.pack) end
    end

    -- A place the pack ships without a position takes the one the developer probe captured in this game (runtime/quest-place-capture.json), so a pack can be tried
    -- before its positions are pasted in. Read once per stage start, and only when a place of the stage has no position.
    local function capturedPlaces(c)
        local missing = false
        for _, place in pairs(c.places) do if type(place) == 'table' and place.x == nil then missing = true end end
        if not missing then return end
        local raw = read('runtime/quest-place-capture.json')
        local value = type(raw) == 'string' and raw ~= '' and #raw <= M.MAX_FILE and decode(raw) or nil
        if type(value) ~= 'table' or type(value.places) ~= 'table' then return end
        for id, place in pairs(c.places) do
            local got = type(place) == 'table' and place.x == nil and value.places[id] or nil
            if type(got) == 'table' and type(got.x) == 'number' and type(got.y) == 'number' and type(got.z) == 'number' then
                place.x, place.y, place.z = got.x, got.y, got.z
                if place.district == nil then place.district = got.district end
            end
        end
    end

    local function startQuest(c)
        capturedPlaces(c)
        c.fired = {}
        closingScopes[c.pack] = nil
        c.ctx = newCtx(c)
        quests[c.pack] = c
        if lines then
            lines.setPack(c.pack, {character = c.character, lines = c.lines, gaps = c.gaps, images = c.images, serial = c.serial})
            if c.gap and plainId(c.gap.id) then lines.restoreGap(c.pack, c.gap.id, c.gap.openedAt) end
        end
        armStage(c)
        -- The stage's music and sound effects (a hook of the primitive registry that mod/quest-audio.lua fills, nothing without it).
        if prims and type(prims.stageStart) == 'function' then pcall(prims.stageStart, c.ctx, c) end
        P.emit(c, 'stage:enter')
    end

    local function runClosing(c)
        local script, ending = list(c.script), c.ending
        if lines then lines.setPack(c.pack, {character = c.character, lines = list(c.lines), images = list(c.images), serial = c.serial}) end
        local scope = {pack = c.pack, serial = c.serial, character = c.character, rows = script, fired = {}, closing = true}
        closingScopes[c.pack] = scope
        P.emit(scope, 'ending:' .. ending)
    end

    local function markClosed(key)
        if closed[key] then return false end
        if closedCount >= M.MAX_SEEN then closed, closedCount = {}, 0 end
        closed[key], closedCount = true, closedCount + 1
        return true
    end

    local function markCommand(key)
        if seenCommands[key] then return false end
        if seenCount >= M.MAX_SEEN then seenCommands, seenCount = {}, 0 end
        seenCommands[key], seenCount = true, seenCount + 1
        return true
    end

    local function runCommand(q, c)
        if c.cmd == 'event' and eventName(c.name) then
            P.emit(q, c.name, {report = false, data = c.data})
        elseif c.cmd == 'resume' and lines then
            lines.closeGap(q.pack, plainId(c.gap) and c.gap or nil, true)
        end
    end

    -- Apply a decoded play file. startup: the quest's ending rows and commands already in the file belong to a time before this one (they are not played).
    local function apply(value, startup)
        wantedFacts = cleanFacts(value.factsWanted)
        setReach(cleanReach(value.reach))
        -- The journal, the tracker and the waypoints first: they only show what the bridge holds, whatever a stage below does.
        journalCall('apply', type(value.journal) == 'table' and value.journal or {}, {startup = startup == true, fresh = fresh})
        local wanted, fresh_ = {}, {}
        for _, q in ipairs(list(value.quests)) do
            if #fresh_ >= M.MAX_QUESTS then break end
            local c = clean(q)
            if c and fresh(c.since) then fresh_[#fresh_ + 1] = c
            elseif c then logOnce('stale:' .. c.pack .. c.serial, 'quest ' .. c.pack .. ' is stamped later than this save, ignored') end
        end
        for _, c in ipairs(fresh_) do
            wanted[c.pack] = true
            local cur = quests[c.pack]
            if not (cur and cur.serial == c.serial and cur.stage == c.stage) then
                if cur then endQuest(cur) end
                startQuest(c)
            end
        end
        local gone = {}
        for pack, q in pairs(quests) do if not wanted[pack] then gone[#gone + 1] = q end end
        for _, q in ipairs(gone) do endQuest(q, true) end
        for _, c in ipairs(list(value.closing)) do
            if type(c) == 'table' and plainId(c.pack) and keyName(c.character) and plainId(c.ending) and whole(c.serial, 0, 1e9) then
                local key = c.pack .. '#' .. c.serial .. '#' .. c.ending
                if markClosed(key) and not startup then
                    local ok, err = pcall(runClosing, c)
                    if not ok then logOnce('closing:' .. key, 'an ending failed: ' .. tostring(err)) end
                end
            end
        end
        for _, c in ipairs(list(value.commands)) do
            if type(c) == 'table' and plainId(c.pack) and whole(c.serial, 0, 1e9) and whole(c.seq, 0, 1e15) then
                local q = quests[c.pack]
                if markCommand(c.pack .. '#' .. c.serial .. '#' .. c.seq) and q and q.serial == c.serial and not startup then
                    local ok, err = pcall(runCommand, q, c)
                    if not ok then logOnce('command:' .. tostring(c.seq), 'a command failed: ' .. tostring(err)) end
                end
            end
        end
        rearm()
    end

    local function reapAll()
        local all = {}
        for _, q in pairs(quests) do all[#all + 1] = q end
        for _, q in ipairs(all) do endQuest(q, true) end
        rearm()
    end

    -- Read the play file. A file that did not change since the last read costs the read and one string compare.
    local function readPlay(startup)
        local raw = read(M.PLAY)
        if type(raw) ~= 'string' or raw == '' or #raw > M.MAX_FILE then
            if raw == nil and lastRaw ~= nil then lastRaw, wantedFacts = nil, nil; setReach(nil); journalCall('clear', 'play file gone'); if next(quests) ~= nil then reapAll() end end   -- the file is gone: no quest, no facts, no reach-outs, no journal
            return
        end
        if raw == lastRaw then return end
        lastRaw = raw
        local value = decode(raw)
        if type(value) ~= 'table' or value.version ~= 1 then logOnce('format', 'the play file is not format 1'); return end
        local ok, err = pcall(apply, value, startup)
        if not ok then logOnce('apply', 'the play file could not be applied: ' .. tostring(err)) end
    end

    -- ---- entry points -------------------------------------------------------------------------------------------------------------------
    local function step()
        if not enabled() then
            if next(quests) ~= nil then reapAll() end
            if lines then lines.reset() end
            journalCall('clear', 'off')
            rearm()
            return
        end
        readPlay(false)
        local snapshot = {}
        for _, q in pairs(quests) do snapshot[#snapshot + 1] = q end
        for _, q in ipairs(snapshot) do
            if not q.dead then
                runTimers(q.ctx)
                if not q.dead then tickPrims(q.ctx) end
            end
        end
        if places then places.update() end
        flush()
        rearm()
    end

    function P.update(player, delta)
        if not armed then return end
        if lines then lines.update(delta) end
        acc = acc + (tonumber(delta) or 0)
        if acc < M.STEP - 1e-6 then return end
        acc = 0
        step()
    end

    function P.onPlayRevision()
        if not enabled() then journalCall('clear', 'off'); return end
        readPlay(false)
        rearm()
    end

    -- Story packs (or Character bonds) went off: nothing of the quests is shown any more. The stages are reaped as on the tick.
    function P.settingOff()
        if next(quests) ~= nil then reapAll() end
        if lines then lines.reset() end
        journalCall('clear', 'off')
        lastRaw = nil
        rearm()
    end

    function P.restore()
        if not enabled() then return false end
        lastRaw = nil
        readPlay(true)
        rearm()
        return armed
    end

    -- The world ended (a load, a detach, a fast travel): every pin is dead and every spawn goes with the world, so nothing is asked of the game. The quests are
    -- forgotten here and read again from the saved stage by restore() once the new world is ready.
    function P.abandon()
        local all = {}
        for _, q in pairs(quests) do all[#all + 1] = q end
        for _, q in ipairs(all) do q.dead = true; if q.ctx then q.ctx:forget() end end
        quests = {}
        if places then places.forget() end
        if lines then lines.reset() end
        seenCommands, seenCount, queue, draining, closingScopes = {}, 0, {}, false, {}
        lastRaw, acc = nil, 0
        setReach(nil)
        journalCall('reset')
        rearm()
    end

    function P.worldChanged()
        P.abandon()
        return P.restore()
    end

    function P.reapAll(reason)
        reapAll()
        if lines then lines.reset() end
        log('everything reaped' .. (reason and (' (' .. tostring(reason) .. ')') or ''))
        rearm()
    end

    -- The developer probe: an event as if the game saw it, for every armed quest. Returns how many quests got it.
    function P.inject(name)
        if not eventName(name) then return 0 end
        local all, count = {}, 0
        for _, q in pairs(quests) do all[#all + 1] = q end
        for _, q in ipairs(all) do if P.emit(q, name) then count = count + 1 end end
        return count
    end

    -- An event for a pack by its id (the line player reports a line done or a gap open this way): the current quest's, else an ended quest's.
    function P.emitPack(pack, name, opts)
        local q = quests[pack] or closingScopes[pack]
        if not q then return false end
        return P.emit(q, name, opts)
    end

    function P.quest(pack) return quests[pack] end

    -- V abandons a quest (the developer probe now, a journal action later): the event goes to the bridge, which closes the quest with no bond change and no time limit
    -- involved (bridge/bond-pack-runner.mjs abandon). The next play file has no row for it, so the journal entry, the tracker line and the pin go. False when the pack is not armed.
    function P.abandonQuest(pack)
        local q = type(pack) == 'string' and quests[pack] or nil
        if not q then return false end
        P.emit(q, 'quest:abandon')
        return true
    end

    function P.armed() return armed end

    -- The facts the bridge wants read (mod/quest-facts.lua), a list of {id, names, kind, values}, or nil. Held from the last play file applied, so asking is free.
    function P.factsWanted() return wantedFacts end

    -- The reach block of the play file (cleaned), or nil. Held from the last play file applied, so asking is free.
    function P.reach() return reachBlock end

    -- Read the play file now (a file that did not change costs the read and one string compare). The reach tick calls it once a minute while it has items to watch,
    -- because the play file is otherwise read only while a quest is armed, at a play revision and at a session start.
    function P.refresh()
        if not enabled() then return false end
        readPlay(false)
        rearm()
        return true
    end

    -- A delivered reach-out (docs/QUEST_PRIMITIVES.md section 10.7): the event reach:<id> with pack "reach" and serial 0, written to the events file at once. `data` is optional.
    function P.emitReach(id, data)
        if type(id) ~= 'string' or not id:match('^[a-z][a-z0-9%-]+$') or #id > 32 then return false end
        record({pack = 'reach', serial = 0}, 'reach:' .. id, M.cleanData(data))
        flush()
        rearm()
        return true
    end

    function P.status()
        local rows = {}
        for pack, q in pairs(quests) do
            local ctx = q.ctx
            rows[#rows + 1] = {pack = pack, character = q.character, stage = q.stage, serial = q.serial, prims = #ctx.prims, tracked = #ctx.tracked,
                timers = #ctx.timers, fired = (function() local n = 0 for _ in pairs(q.fired) do n = n + 1 end return n end)()}
        end
        table.sort(rows, function(a, b) return a.pack < b.pack end)
        return {armed = armed, session = session, seq = seq, quests = rows, events = #events, facts = wantedFacts and #wantedFacts or 0,
            lines = lines and lines.status() or nil, places = places and places.status() or nil, journal = journal and journal.status() or nil}
    end

    return P
end

return M
