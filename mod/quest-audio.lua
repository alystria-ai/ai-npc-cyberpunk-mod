-- The music and sound effects of the bond quests (docs/QUEST_PRIMITIVES.md section 10.10, BOND_QUESTS.md 19.2 and 19.3): a stage's `music` (up to 3) and `sfx` (up to 6) arrays,
-- which the bridge puts in the play file of the quest (quest.music, quest.sfx) and mod/quest-play.lua hands to R.stageStart when the stage begins. install(R, env) fills that
-- hook and R.sounds (mod/quest-prims.lua calls it through R.extend). Pure: the game comes in through env.world (the natives are in mod/quest-world-audio.lua), so
-- bridge/quest-audio-lua.test.mjs runs all of it on a fake game.
--
-- An item: {source, start, stop, fadeIn, fadeOut, volume, duck (music) | at, loop (sfx)}. `start` and `stop` are event names of the stage, start defaults to stage:enter. The
-- source decides who plays it:
--   file:music/<name>.ogg | file:sfx/<name>.ogg   a file of the pack. The BRIDGE plays it: this module writes commands into runtime/media-command.json (the shape is in
--                                                 bridge/media-request.mjs: play, load, stop, fade, duck), a file the bridge rewrites in place like the other runtime files.
--   radio:<station name>                          V's car radio is tuned to that station (on if it was off) and given back as it was on stop or reap. V must be in a car: on foot it
--                                                 does nothing and says so once. The pocket radio is not touched.
--   game:<event>                                  a game sound event through the audio system, flat or on the copy (`at: copy`), stopped with the matching stop call.
--
-- THE COMMAND FILE. {version = 1, session, seq, commands}: session is random per game start, seq grows by one with every write, at most 8 commands. Nothing is written when there is
-- nothing to say. The bridge reads the file about every 200 ms and acts on the newest seq only, so two writes are never closer than 0.25 s: commands that come sooner wait in a queue and
-- go out in the next write. Every command waits for update() (the 0.1 s tick of mod/init.lua calls it only while something is queued or a place loop plays), so what one moment says goes out in one write. A stage end or the ctx's reap sends a
-- stop for every id the ctx started, and a quest that ends sends `stop` with no id for the pack. A sound started and stopped before its play went out is never sent. The sound id is
-- m<serial>-<n> for music and s<serial>-<n> for effects, so a stage's sounds never meet the next stage's.
--
-- Positions. `at: copy` sends a pan, computed once when the sound starts from the camera and the copy (the sign and the formula of the speech pan). `at: place:<id>` with `loop` is steered
-- with `fade` commands (volume and pan from the camera and the place) at most 4 times a second, only while that loop plays and V is within 60 m, beyond 60 m it is silent (one fade to 0)
-- and V's position is only looked at every 2 s to notice a return. The steering stops with the loop. Nothing here runs per frame.
--
-- NOT DONE: ducking game sounds under speech, `RequestSongOnRadioStation`, a pocket radio, a place sound without a position (a place the play file does not carry: the bridge only sends
-- the places a `do` entry names, see the report), a music file that loops (the bridge's `loop` defaults to false and music has no loop field).
local M = {FILE = 'runtime/media-command.json', WRITE_GAP = 0.25, MOST = 8, QUEUE_MOST = 64, RANGE = 60, STEER = 0.25, FAR = 2, WRITE_FAILS = 20,
    MUSIC_MOST = 3, SFX_MOST = 6, LOAD_MOST = 4, NEAR = 5}

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function point(p) return type(p) == 'table' and finite(p.x) and finite(p.y) and finite(p.z) end
local function ranged(value, low, high)
    if type(value) == 'number' and value == value and value >= low and value <= high then return value end
    return nil
end
local function eventName(value) return type(value) == 'string' and #value > 0 and #value <= 120 and value:match('^[%w][%w:%-_%.]*$') ~= nil end
local function clampPan(value) return math.max(-1, math.min(1, value)) end

-- The pan of `target` {x, y} seen from the camera pose {x, y, fx, fy}: -1 left to 1 right, the formula and the sign of the speech pan (mod/continuous-speech.lua).
function M.pan(pose, target)
    if type(pose) ~= 'table' or type(target) ~= 'table' or not finite(pose.x) or not finite(pose.y) or not finite(pose.fx) or not finite(pose.fy) or not finite(target.x) or not finite(target.y) then return nil end
    local dx, dy = target.x - pose.x, target.y - pose.y
    local horizontal, direction = math.sqrt(dx * dx + dy * dy), math.sqrt(pose.fx * pose.fx + pose.fy * pose.fy)
    if horizontal < 0.001 or direction < 0.001 then return 0 end
    return clampPan((dx * pose.fy - dy * pose.fx) / (horizontal * direction))
end

-- The level of a sound at a place `distance` metres away: full within NEAR, none at RANGE, smooth between.
function M.gain(distance)
    if distance <= M.NEAR then return 1 end
    if distance >= M.RANGE then return 0 end
    local x = 1 - (distance - M.NEAR) / (M.RANGE - M.NEAR)
    return x * x
end

-- 'file', 'music/x.ogg' | 'radio', 'Station' | 'game', 'event' | nil
local function parseSource(kind, source)
    if type(source) ~= 'string' then return nil end
    local file = source:match('^file:(.+)$')
    if file then
        local folder = file:match('^(%a+)/')
        if folder == kind and #file <= 85 and file:match('^%a+/[%w][%w%._%-]*%.%a+$') and (file:match('%.wav$') or file:match('%.ogg$') or file:match('%.opus$')) then return 'file', file end
        return nil
    end
    local station = source:match('^radio:(.+)$')
    if station then
        if kind == 'music' and #station >= 2 and #station <= 41 then return 'radio', station end
        return nil
    end
    local event = source:match('^game:([%w_]+)$')
    if event and #event >= 3 and #event <= 80 then return 'game', event end
    return nil
end

function M.install(R, env)
    env.world = env.world or {}
    local world0 = env.world

    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest sounds: ' .. line) end end
    local logged = {}
    local function logOnce(key, line)
        if logged[key] then return end
        logged[key] = true
        log(line)
    end
    local function clock()
        local ok, value = pcall(env.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function world(name, ...)
        local fn = env.world[name]
        if type(fn) ~= 'function' then return nil end
        local ok, a, b = pcall(fn, ...)
        if not ok then return nil end
        return a, b
    end

    -- ---- the native calls -------------------------------------------------------------------------------------------------------------------
    -- Whatever the game adapter does not have yet comes from mod/quest-world-audio.lua. A world that already has a function by that name (a test's fake) keeps it. If the file cannot
    -- be loaded the file sounds still go to the bridge, and the radio, the game sounds, the pan of a copy and a place loop do nothing.
    local natives = env.audioNatives
    if natives == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'quest-world-audio.lua')
        if ok and type(module) == 'table' and type(module.new) == 'function' then
            local built, W = pcall(module.new, {companions = env.companions, log = env.log})
            if built then natives = W end
        end
    end
    if type(natives) == 'table' then
        for name, fn in pairs(natives) do
            if type(fn) == 'function' and world0[name] == nil then world0[name] = fn end
        end
    end

    -- ---- the command file ---------------------------------------------------------------------------------------------------------------------
    local session = env.audioSession or string.format('%x%x', os.time() % 16777215, math.random(0, 16777215))
    local seq, lastWrite, fails = 0, -1e9, 0
    local queue = {}
    local function encode(value)
        local ok, raw = pcall(env.audioEncode or json.encode, value)
        return ok and type(raw) == 'string' and raw or nil
    end
    local function write(path, text)
        if type(env.audioWrite) == 'function' then
            local ok, done = pcall(env.audioWrite, path, text)
            return ok and done ~= false
        end
        local file = io.open(path, 'wb')
        if not file then return false end
        local written, closed = file:write(text), file:close()
        return written and closed and true or false
    end

    local function flush(now)
        if #queue == 0 or now - lastWrite < M.WRITE_GAP then return false end
        local take = {}
        for index = 1, math.min(M.MOST, #queue) do take[index] = queue[index] end
        local raw = encode({version = 1, session = session, seq = seq + 1, commands = take})
        if raw and write(M.FILE, raw) then
            seq, lastWrite, fails = seq + 1, now, 0
            for _ = 1, #take do table.remove(queue, 1) end
            return true
        end
        fails = fails + 1
        if fails >= M.WRITE_FAILS then
            fails, queue = 0, {}
            logOnce('write', 'the media command file cannot be written, the queued sounds are dropped')
        end
        return false
    end

    local S = {}
    R.sounds = S

    -- A command is queued and goes out with the next update() (the 0.1 s tick, so everything one moment says goes out in one write), no sooner than 0.25 s after the last write.
    -- A stop first takes back a play (and the fades) of the same id that never went out.
    local function send(command)
        if command.op == 'stop' and command.id then
            for index = #queue, 1, -1 do
                local other = queue[index]
                if other.id == command.id and other.pack == command.pack then
                    if other.op == 'play' then
                        for drop = #queue, 1, -1 do
                            if queue[drop].id == command.id and queue[drop].pack == command.pack then table.remove(queue, drop) end
                        end
                        return
                    elseif other.op == 'fade' then table.remove(queue, index) end
                end
            end
        elseif command.op == 'fade' then
            for index = #queue, 1, -1 do
                local other = queue[index]
                if other.op == 'fade' and other.id == command.id and other.pack == command.pack then table.remove(queue, index) end
            end
        end
        if #queue >= M.QUEUE_MOST then logOnce('queue', 'the media command queue is full, a command is dropped'); return end
        queue[#queue + 1] = command
    end

    -- ---- the sounds ---------------------------------------------------------------------------------------------------------------------------
    local live = {}                  -- rec -> true, every sound that plays now
    local steering = {}              -- the place loops that play now (their recs)
    local packFiles = {}             -- pack -> true while a file sound of the pack may still play in the bridge
    local loaded = {}                -- 'pack|file' -> true, a load was sent
    local radio = {count = 0, token = nil}
    local steerAcc = 0
    local maxFade = setmetatable({}, {__mode = 'k'})   -- ctx -> the longest fade out of the sounds it stopped

    local function placeOf(ctx, text)
        local id = type(text) == 'string' and text:match('^place:(.+)$') or nil
        local place = id and type(ctx.places) == 'table' and ctx.places[id] or nil
        if point(place) then return {x = place.x, y = place.y, z = place.z}, id end
        return nil, id
    end

    -- The pan and the level for a place loop now, or nil when V's position is not known.
    local function placeMix(rec, vpos)
        local distance = math.sqrt((vpos.x - rec.place.x) ^ 2 + (vpos.y - rec.place.y) ^ 2 + (vpos.z - rec.place.z) ^ 2)
        if distance > M.RANGE then return 0, rec.pan or 0, distance end
        local pose = world('cameraPose')
        local pan = M.pan(pose, rec.place)
        return rec.volume * M.gain(distance), pan or 0, distance
    end

    local function startFile(rec)
        local item, ctx = rec.item, rec.ctx
        local command = {kind = 'media', op = 'play', pack = ctx.pack, id = rec.id, file = rec.path}
        if rec.loop then command.loop = true end
        if item.volume ~= nil then command.volume = item.volume end
        if item.fadeIn ~= nil then command.fadeIn = item.fadeIn end
        if item.fadeOut ~= nil then command.fadeOut = item.fadeOut end
        if rec.kind == 'music' and type(item.duck) == 'boolean' then command.duck = item.duck end
        local at = rec.kind == 'sfx' and type(item.at) == 'string' and item.at or 'bed'
        if at ~= 'bed' then command.at = at end
        if at == 'copy' then
            -- Once, now: the bearing of the copy from the camera. A copy or a camera that cannot be read leaves the sound flat.
            local copy = world('copyOf', ctx.character)
            local pan = type(copy) == 'table' and M.pan(world('cameraPose'), copy.position) or nil
            if pan ~= nil then command.pan = pan end
        elseif at:sub(1, 6) == 'place:' then
            local place, id = placeOf(ctx, at)
            if not place then
                logOnce('place:' .. ctx.pack .. tostring(id), 'sound ' .. rec.id .. ' is at the place ' .. tostring(id) .. ', which the stage does not carry, it is not played')
                return false
            end
            rec.place = place
            local vpos = world('playerPosition')
            if point(vpos) then
                local volume, pan = placeMix(rec, vpos)
                command.volume, command.pan = volume, pan
                rec.level, rec.pan = volume, pan
            else
                command.volume, command.pan, rec.level, rec.pan = 0, 0, 0, 0
            end
            if rec.loop then
                rec.nextAt = clock() + M.STEER
                steering[#steering + 1] = rec
            end
        end
        packFiles[ctx.pack] = true
        send(command)
        return true
    end

    local function startGame(rec)
        local at = rec.kind == 'sfx' and rec.item.at == 'copy'
        local handle, why = world('gamePlay', rec.event, at and rec.ctx.character or nil)
        if handle == nil then
            logOnce('game:' .. rec.event, 'the game sound ' .. rec.event .. ' did not start (' .. tostring(why or 'no audio system') .. ')')
            return false
        end
        rec.handle = handle
        return true
    end

    local function startRadio(rec)
        local token, why = world('radioSwitch', rec.station, radio.token)
        if token == nil then
            logOnce('radio:' .. rec.station, 'the radio station ' .. rec.station .. ' was not switched to (' .. tostring(why or 'no radio call') .. '), V\'s radio is left as it is')
            return false
        end
        radio.token, radio.count = token, radio.count + 1
        rec.radio = true
        return true
    end

    local function start(rec)
        if rec.playing or rec.ctx.reaped then return end
        local started
        if rec.source == 'file' then started = startFile(rec)
        elseif rec.source == 'game' then started = startGame(rec)
        else started = startRadio(rec) end
        if not started then return end
        rec.playing = true
        live[rec] = true
        log('started ' .. rec.ctx.pack .. ' ' .. rec.id .. ' ' .. rec.source .. ':' .. tostring(rec.path or rec.event or rec.station))
    end

    local function halt(rec, reaping)
        if not rec.playing then return end
        rec.playing = false
        live[rec] = nil
        for index = #steering, 1, -1 do if steering[index] == rec then table.remove(steering, index) end end
        if rec.source == 'file' then
            local command = {kind = 'media', op = 'stop', pack = rec.ctx.pack, id = rec.id}
            if rec.item.fadeOut ~= nil then
                command.fadeOut = rec.item.fadeOut
                maxFade[rec.ctx] = math.max(maxFade[rec.ctx] or 0, rec.item.fadeOut)
            end
            send(command)
        elseif rec.source == 'game' then
            -- A loop and a music event are stopped by the reap too, a one-shot ends by itself.
            if rec.handle ~= nil and (not reaping or rec.loop or rec.kind == 'music') then world('gameStop', rec.handle) end
            rec.handle = nil
        elseif rec.radio then
            rec.radio = nil
            radio.count = math.max(0, radio.count - 1)
            if radio.count == 0 then
                local token = radio.token
                radio.token = nil
                local ok, why = world('radioRestore', token)
                if ok ~= true then logOnce('radio-restore', 'the radio was not given back (' .. tostring(why or 'no radio call') .. ')') end
            end
        end
        log('stopped ' .. rec.ctx.pack .. ' ' .. rec.id)
    end

    -- At the end of a ctx (after its sounds were stopped): a quest that ends tells the bridge to stop everything of the pack.
    local function finalize(ctx)
        if ctx.final == true and packFiles[ctx.pack] then
            packFiles[ctx.pack] = nil
            local command = {kind = 'media', op = 'stop', pack = ctx.pack}
            if (maxFade[ctx] or 0) > 0 then command.fadeOut = maxFade[ctx] end
            send(command)
        end
    end

    local function armItem(ctx, serial, kind, index, item, state)
        if type(item) ~= 'table' then return end
        local source, detail = parseSource(kind, item.source)
        if not source then logOnce('source:' .. ctx.pack .. kind .. index, kind .. ' ' .. index .. ' has a source the game cannot play, it is skipped'); return end
        local rec = {ctx = ctx, kind = kind, index = index, item = {source = item.source, start = item.start, stop = item.stop, fadeIn = ranged(item.fadeIn, 0, 10),
            fadeOut = ranged(item.fadeOut, 0, 10), volume = ranged(item.volume, 0, 1), duck = type(item.duck) == 'boolean' and item.duck or nil,
            at = type(item.at) == 'string' and item.at or nil, loop = item.loop == true}, source = source, playing = false}
        rec.id = (kind == 'music' and 'm' or 's') .. tostring(serial) .. '-' .. tostring(index)
        rec.loop = rec.item.loop
        rec.volume = rec.item.volume or 1
        if source == 'file' then rec.path = detail elseif source == 'game' then rec.event = detail else rec.station = detail end
        local startEvent = eventName(item.start) and item.start or 'stage:enter'
        ctx:on(startEvent, function() start(rec) end)
        if eventName(item.stop) then ctx:on(item.stop, function() halt(rec, false) end) end
        ctx:track('sound', rec, function() halt(rec, true) end)
        -- A sound that starts later is decoded now, so it starts at once when its event comes.
        if source == 'file' and startEvent ~= 'stage:enter' and state.loads < M.LOAD_MOST and not loaded[ctx.pack .. '|' .. detail] then
            state.loads = state.loads + 1
            loaded[ctx.pack .. '|' .. detail] = true
            packFiles[ctx.pack] = true
            send({kind = 'media', op = 'load', pack = ctx.pack, file = detail})
        end
    end

    -- Called by mod/quest-play.lua when a stage begins (q: the stage's scope: pack, serial, music, sfx).
    local previous = R.stageStart
    function R.stageStart(ctx, q)
        if type(previous) == 'function' then pcall(previous, ctx, q) end
        if type(q) ~= 'table' then return end
        -- A stage with no sounds still ends the pack's, when the quest ends, if an earlier stage started one (the bridge may hold it).
        if type(q.music) ~= 'table' and type(q.sfx) ~= 'table' and not packFiles[ctx.pack] then return end
        ctx:track('sound-final', ctx, finalize)   -- tracked first, so it is undone after the stage's sounds
        local state = {loads = 0}
        local serial = tonumber(q.serial) or 0
        for index, item in ipairs(type(q.music) == 'table' and q.music or {}) do
            if index > M.MUSIC_MOST then break end
            armItem(ctx, serial, 'music', index, item, state)
        end
        for index, item in ipairs(type(q.sfx) == 'table' and q.sfx or {}) do
            if index > M.SFX_MOST then break end
            armItem(ctx, serial, 'sfx', index, item, state)
        end
    end

    -- ---- from the 0.1 s tick, only while pending() ----------------------------------------------------------------------------------------
    local function steer(now)
        local snapshot = {}
        for index, rec in ipairs(steering) do if now >= rec.nextAt then snapshot[#snapshot + 1] = rec end end
        if #snapshot == 0 then return end
        local vpos = world('playerPosition')
        if not point(vpos) then return end
        for _, rec in ipairs(snapshot) do
            if rec.playing then
                local volume, pan, distance = placeMix(rec, vpos)
                if distance > M.RANGE then
                    -- Beyond 60 m: silent (one fade), looked at again every 2 s.
                    if (rec.level or 0) > 0 then
                        rec.level = 0
                        send({kind = 'media', op = 'fade', pack = rec.ctx.pack, id = rec.id, volume = 0, seconds = 0.5})
                    end
                    rec.nextAt = now + M.FAR
                else
                    rec.nextAt = now + M.STEER
                    if math.abs(volume - (rec.level or 0)) >= 0.02 or math.abs(pan - (rec.pan or 0)) >= 0.05 then
                        rec.level, rec.pan = volume, pan
                        send({kind = 'media', op = 'fade', pack = rec.ctx.pack, id = rec.id, volume = volume, pan = pan, seconds = 0.3})
                    end
                end
            end
        end
    end

    function S.update(delta)
        local now = clock()
        if #queue > 0 then flush(now) end
        if #steering > 0 then
            steerAcc = steerAcc + (tonumber(delta) or 0)
            if steerAcc >= M.STEER - 1e-6 then
                steerAcc = 0
                steer(now)
            end
        else
            steerAcc = 0
        end
    end

    function S.pending() return #queue > 0 or #steering > 0 end

    -- The world ended (a load, a detach): the bridge stops what it plays for the packs, the game sounds are asked to stop, nothing else is asked of the world.
    function S.worldChanged()
        for rec in pairs(live) do
            if rec.source == 'game' and rec.handle ~= nil and (rec.loop or rec.kind == 'music') then world('gameStop', rec.handle) end
        end
        local packs = {}
        for pack in pairs(packFiles) do packs[#packs + 1] = pack end
        table.sort(packs)
        live, steering, packFiles, loaded, radio, steerAcc = {}, {}, {}, {}, {count = 0, token = nil}, 0
        for _, pack in ipairs(packs) do send({kind = 'media', op = 'stop', pack = pack}) end
    end

    function S.status()
        local playing = 0
        for _ in pairs(live) do playing = playing + 1 end
        return {playing = playing, queued = #queue, steering = #steering, seq = seq, session = session, radio = radio.count}
    end
end

return M
