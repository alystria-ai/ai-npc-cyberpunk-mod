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
--   P.emit(quest, name)       an event of a quest. P.inject(name) is the developer probe, it injects one for every armed quest
--   P.status()                what the module holds
--
-- ctx (the single cleanup owner of a quest stage): ctx:track(kind, handle, undo), ctx:after(seconds, fn), ctx:every(seconds, fn), ctx:on(event, fn),
-- ctx:emit(name), ctx:reap() (LIFO, idempotent). A stage change reaps the old stage's ctx and starts the new one. A quest that leaves the file, the setting
-- going off and a quest stamped later than the loaded save's clock + 120 s (it belongs to a save that was loaded away from) are handled the same way.
--
-- options: enabled() -> bool, clock() -> seconds (monotonic real clock), gameTime() -> the game clock in seconds | nil, read(path), write(path, text),
--   encode, decode, places (mod/quest-places.lua), lines (mod/quest-lines.lua), prims (mod/quest-prims.lua), session (a fixed session id, for tests), log(line).
local M = {PLAY = 'runtime/quest-play.json', EVENTS = 'runtime/quest-events.json', TAG = 'CyberpunkConvaiQuest', STEP = 1, SLACK = 120, MAX_FILE = 262144,
    MAX_QUESTS = 8, MAX_EVENTS = 32, MAX_DRAIN = 64, MAX_DO = 16, MAX_ROWS = 64, MAX_FAILS = 3, MAX_SEEN = 256}

local function plainId(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[%w][%w%.:_%-]*$') ~= nil end
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end
local function keyName(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[a-z0-9][a-z0-9%-]*$') ~= nil end
local function whole(value, low, high)
    return type(value) == 'number' and value == value and value == math.floor(value) and value >= low and value <= high
end
local function list(value) return type(value) == 'table' and value or {} end

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
        local raw = encode({version = 1, session = session, seq = seq, events = events})
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

    local function record(q, name)
        seq = seq + 1
        events[#events + 1] = {seq = seq, pack = q.pack, serial = q.serial, name = name, at = gameTime() or 0}
        while #events > M.MAX_EVENTS do table.remove(events, 1) end
        eventsDirty = true
    end

    -- ---- rows and events ----------------------------------------------------------------------------------------------------------------
    local function runRow(q, row)
        if type(row) ~= 'table' then return end
        if lines then
            if type(row.say) == 'string' then lines.say(q.pack, row.say, {bark = row.bark == true}) end
            if type(row.text) == 'string' then lines.text(q.pack, row.text, type(row.image) == 'string' and row.image or nil) end
            if type(row.gap) == 'string' then lines.openGap(q.pack, row.gap) end
        end
        if type(row.event) == 'string' then P.emit(q, row.event) end
    end

    local function handle(item)
        local q, name = item.q, item.name
        if q.dead then return end
        if item.report then record(q, name) end
        if lines then lines.onEvent(q.pack, name) end
        if q.ctx then q.ctx:dispatch(name) end
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
        queue[#queue + 1] = {q = q, name = name, report = not (opts and opts.report == false)}
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
            tracked = {}, timers = {}, listeners = {}, prims = {}, reaped = false}
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
        function ctx:dispatch(name)
            if self.reaped or #self.listeners == 0 then return end
            local snapshot = {}
            for index, l in ipairs(self.listeners) do snapshot[index] = l end
            for _, l in ipairs(snapshot) do
                if l.name == name and not self.reaped then pcall(l.fn, name) end
            end
        end
        function ctx:emit(name) if not self.reaped then P.emit(q, name) end end
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
            places = type(q.places) == 'table' and q.places or {}, doList = list(q['do']), rows = list(q.script), lines = list(q.lines),
            gaps = list(q.gaps), images = list(q.images), gap = type(q.gap) == 'table' and q.gap or nil,
            timeoutAt = type(q.timeoutAt) == 'number' and q.timeoutAt == q.timeoutAt and q.timeoutAt >= 0 and q.timeoutAt or nil}
    end

    local function endQuest(q)
        q.dead = true
        if quests[q.pack] == q then quests[q.pack] = nil end
        if q.ctx then q.ctx:reap() end
        if lines then lines.dropPack(q.pack) end
    end

    local function startQuest(c)
        c.fired = {}
        closingScopes[c.pack] = nil
        c.ctx = newCtx(c)
        quests[c.pack] = c
        if lines then
            lines.setPack(c.pack, {character = c.character, lines = c.lines, gaps = c.gaps, images = c.images, serial = c.serial})
            if c.gap and plainId(c.gap.id) then lines.restoreGap(c.pack, c.gap.id, c.gap.openedAt) end
        end
        armStage(c)
        -- The stage's own timeout (game seconds, from the pack): the bridge checks timers only when a turn or an event reaches it, so the game says when it has run out.
        if c.timeoutAt then
            local now = gameTime()
            if now then c.ctx:after(math.max(0, c.timeoutAt - now), function() P.emit(c, 'stage:timeout') end) end
        end
        P.emit(c, 'stage:enter')
    end

    local function runClosing(c)
        local script, ending = list(c.script), c.ending
        if lines then lines.setPack(c.pack, {character = c.character, lines = list(c.lines), images = list(c.images), serial = c.serial}) end
        local scope = {pack = c.pack, serial = c.serial, character = c.character, rows = script, fired = {}}
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
            P.emit(q, c.name, {report = false})
        elseif c.cmd == 'resume' and lines then
            lines.closeGap(q.pack, plainId(c.gap) and c.gap or nil, true)
        end
    end

    -- Apply a decoded play file. startup: the quest's ending rows and commands already in the file belong to a time before this one (they are not played).
    local function apply(value, startup)
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
        for _, q in ipairs(gone) do endQuest(q) end
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
        for _, q in ipairs(all) do endQuest(q) end
        rearm()
    end

    -- Read the play file. A file that did not change since the last read costs the read and one string compare.
    local function readPlay(startup)
        local raw = read(M.PLAY)
        if type(raw) ~= 'string' or raw == '' or #raw > M.MAX_FILE then
            if raw == nil and next(quests) ~= nil and lastRaw ~= nil then lastRaw = nil; reapAll() end   -- the file is gone: no quest
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
        if not enabled() then return end
        readPlay(false)
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

    function P.armed() return armed end

    function P.status()
        local rows = {}
        for pack, q in pairs(quests) do
            local ctx = q.ctx
            rows[#rows + 1] = {pack = pack, character = q.character, stage = q.stage, serial = q.serial, prims = #ctx.prims, tracked = #ctx.tracked,
                timers = #ctx.timers, fired = (function() local n = 0 for _ in pairs(q.fired) do n = n + 1 end return n end)()}
        end
        table.sort(rows, function(a, b) return a.pack < b.pack end)
        return {armed = armed, session = session, seq = seq, quests = rows, events = #events,
            lines = lines and lines.status() or nil, places = places and places.status() or nil}
    end

    return P
end

return M
