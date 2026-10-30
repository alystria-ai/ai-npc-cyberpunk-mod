-- The scripted line player of the bond quests (docs/QUEST_PRIMITIVES.md sections 4 and 5, BOND_QUESTS.md 14.2 to 14.5): one voice at a time, the talk gap and
-- the Phone Chat text rows. Pure: everything the game does comes in through options, so the module runs on a fake game in the tests
-- (bridge/quest-lines-lua.test.mjs). Nothing here runs per frame: the quest module calls update() from its tick, and update returns at a nil check while
-- nothing is waiting, playing or open.
--
--   L.setPack(pack, info)          info {character, lines, gaps, images, serial}: what the pack's lines, gaps and pictures are (replaced at each stage start)
--   L.say(pack, lineId, opts)      a scripted line is queued for its speaker (opts.bark). A bark waits at most 4 s and is then dropped, a plot line waits
--                                  (after 20 s it is also shown as a subtitle, and it is played at the next silence). A plot line on the own or remote channel whose speaker has no
--                                  copy of V's (options.present answers false: she is only a voice on the phone, or far away) waits for her without ageing, shows no subtitle and
--                                  is not given up: it plays when her copy is there, and is dropped with its stage (dropPack). opts.final marks a line of an ending: it cannot
--                                  wait for her, so it goes to her Phone Chat thread after 20 s and counts as done. opts.channel replaces the line's channel, opts.call
--                                  (true, or a function that answers whether the call is still on) marks a line of a scripted holocall (mod/quest-prims-calls.lua): it waits
--                                  for the silence like a plot line but is never shown or sent as a text, a line cut twice counts as heard so the call goes on, and once
--                                  the call is not on any more it is dropped without a word
--   L.dropCall(pack)               the call lines of that pack that still wait are dropped (the call ended), returns how many
--   L.text(pack, lineId, imageKey, inPerson) a Phone Chat message from the character, with a picture when the pack has one under that key (not sent when inPerson: she is beside V)
--   L.openGap / L.closeGap         the talk gap: the script waits, her idle plays, it ends by resumeAfterSeconds, a resumeOn event or a gap:<id>:* event
--   L.onEvent(pack, name)          the quest module tells every event, so a gap can end by one
--   L.stopped(requestId, reason)   the speech of the request ended ('finished' = heard to its end)
--   L.busy()                       a gap is open or a line is in progress: the speak-up scheduler and every automatic remark stay quiet
--   L.update(delta)                from the quest module's tick
--
-- options: clock() -> real seconds (monotonic), gameTime() -> the game clock in seconds | nil,
--   busy() -> true when V talks (key held, composer with text), any reply is produced or heard, an automatic remark plays or a scene, call or fight runs,
--   start(entry) -> requestId | nil, why   (builds the private turn of the speaking copy: reaction {kind = 'scripted', pack, line, channel, expiresAt}),
--   alive(requestId) -> bool   (the request is still in the air), subtitle(profileKey, text), phone(profileKey, text, image) -> bool (Phone Chat),
--   present(profileKey, channel) -> true | false | nil (optional: whether a copy of V of the speaker exists, nil or no function = assume yes. Asked once a second
--   while a plot line on the own or remote channel waits, never per frame),
--   idle(profileKey, idleKey, on, situation) (optional: the pose of a talk gap), emit(pack, name) (an event for the quest), onChange(), log(line).
--   The idle hook is asked ONCE when a gap opens with an `idle` (a seat kind or an idle key of assets/gestures/gestures.json) and/or a `situation` (nervous, celebrating, grieving,
--   angry, relaxed, working), with on = true, and once more with on = false when the gap closes. idleKey is the gap's idle, else the idle its situation stands for (M.SITUATIONS),
--   or nil (a situation with no pose of its own: the face and gesture bias is the hook's business). The hook may return a function: the line player calls it once a second
--   (never per frame) until it answers true, which is how an asynchronous pose (a device that streams in) gets started. A failure of the hook or of the pose is silent.
local M = {BARK_WAIT = 4, PLOT_SUBTITLE = 20, PLOT_GIVE_UP = 600, PLOT_RETRIES = 2, PLOT_QUEUE = 4, STEP = 0.5, BETWEEN = 1,
    MAX_PACKS = 16, TEXT_TRIES = 10, TEXT_RETRY = 2, LOST_CHECKS = 3, IDLE_STEP = 1, PRESENT_STEP = 1}

-- The situations of BOND_QUESTS.md 19.1 and the idle each one stands for when the gap names none (false: no pose of its own, the hook still hears the situation).
-- Every key is an idle key of assets/gestures/gestures.json idleWorkspots.
M.SITUATIONS = {nervous = false, celebrating = 'panam_beer', grieving = 'generic_front', angry = 'generic_arms_crossed', relaxed = false, working = 'judy_coffee'}

local function plainId(value) return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[%w][%w%.:_%-]*$') ~= nil end
local function speakerKey(value) return type(value) == 'string' and #value <= 80 and value:match('^[a-z0-9][a-z0-9%-]*$') ~= nil end

function M.new(options)
    options = options or {}
    local L = {}
    local packs, packCount = {}, 0
    local waiting = {}        -- entries in arrival order
    local texts = {}          -- Phone Chat rows that wait for the store
    local active = nil        -- {entry, requestId, startedAt, lost}
    local gaps = {}           -- pack -> {id, spec, gameAt, clockAt, profileKey}
    local gapCount = 0
    local acc, lastEnd = 0, -1e9
    local presentAt = -1e9

    local function clock()
        local ok, value = pcall(options.clock or os.clock)
        return ok and type(value) == 'number' and value or os.clock()
    end
    local function gameTime()
        if type(options.gameTime) ~= 'function' then return nil end
        local ok, value = pcall(options.gameTime)
        return ok and type(value) == 'number' and value == value and value or nil
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Quest lines: ' .. line) end end
    local function emit(pack, name) if type(options.emit) == 'function' then pcall(options.emit, pack, name) end end
    local function changed() if type(options.onChange) == 'function' then pcall(options.onChange) end end
    local function isBusy()
        if type(options.busy) ~= 'function' then return false end
        local ok, value = pcall(options.busy)
        return not ok or value == true
    end

    -- ---- packs --------------------------------------------------------------------------------------------------------------------------
    local function referenced(pack)
        if gaps[pack] or (active and active.entry.pack == pack) then return true end
        for _, e in ipairs(waiting) do if e.pack == pack then return true end end
        for _, t in ipairs(texts) do if t.pack == pack then return true end end
        return false
    end

    function L.setPack(pack, info)
        if not plainId(pack) or type(info) ~= 'table' then return false end
        if not packs[pack] then
            if packCount >= M.MAX_PACKS then
                for key in pairs(packs) do
                    if not referenced(key) then packs[key], packCount = nil, packCount - 1; break end
                end
            end
            packCount = packCount + 1
        end
        packs[pack] = {character = info.character, lines = type(info.lines) == 'table' and info.lines or {},
            gaps = type(info.gaps) == 'table' and info.gaps or {}, images = type(info.images) == 'table' and info.images or {}, serial = info.serial}
        return true
    end

    local function lineOf(pack, id)
        local info = packs[pack]
        local meta = info and info.lines[id]
        if type(meta) ~= 'table' then return nil, info end
        return meta, info
    end

    -- ---- the queue ----------------------------------------------------------------------------------------------------------------------
    local function shortText(text)
        if type(text) ~= 'string' then return nil end
        return text
    end

    function L.say(pack, lineId, opts)
        local meta, info = lineOf(pack, lineId)
        if not meta then log('unknown line ' .. tostring(lineId) .. ' of ' .. tostring(pack)); return false end
        local profileKey = speakerKey(meta.speaker) and meta.speaker or info.character
        if not speakerKey(profileKey) then log('line ' .. tostring(lineId) .. ' has no speaker'); return false end
        local bark = (opts and opts.bark == true) or meta.bark == true or meta.kind == 'bark'
        local call = opts and (opts.call == true or type(opts.call) == 'function') and opts.call or nil
        if call then bark = false end
        local channel = type(opts and opts.channel) == 'string' and opts.channel or (type(meta.channel) == 'string' and meta.channel or 'own')
        local entry = {pack = pack, id = lineId, profileKey = profileKey, bark = bark, channel = channel, call = call, final = opts and opts.final == true,
            emotion = meta.emotion, gesture = meta.gesture, text = shortText(meta.text), queuedAt = clock(), retries = 0, fails = 0}
        -- One slot per speaker for a bark (a newer one replaces an older waiting one, and none waits behind a plot line). A plot line is never lost:
        -- they queue in order, four deep per speaker.
        local plots = 0
        for index = #waiting, 1, -1 do
            local other = waiting[index]
            if other.profileKey == profileKey then
                if bark then
                    if other.bark then table.remove(waiting, index) else log('bark ' .. lineId .. ' dropped: a plot line waits'); return false end
                else
                    if not other.bark then plots = plots + 1 end
                end
            end
        end
        if not bark and plots >= M.PLOT_QUEUE then log('plot line ' .. lineId .. ' dropped: the queue is full'); return false end
        waiting[#waiting + 1] = entry
        changed()
        L.pump()
        return true
    end

    -- Lines on a held channel wait (the dead zone of a remote voice): see L.holdWhile.
    local holds = {}
    local function held(e)
        for _, h in ipairs(holds) do
            if h.channel == e.channel then
                local ok, value = pcall(h.fn)
                if ok and value == true then return true end
            end
        end
        return false
    end
    local function pick()
        for index, e in ipairs(waiting) do if not e.bark and not held(e) and not e.absent then return index, e end end
        for index, e in ipairs(waiting) do if not held(e) and not e.absent then return index, e end end
        return nil
    end

    -- A plot line said in person (own channel) or by a copy's voice (remote) needs a copy of V's of its speaker. Barks and call lines do not wait for one.
    local function needsSpeaker(e)
        return not e.bark and not e.call and (e.channel == 'own' or e.channel == 'remote')
    end
    -- Once a second, while such a line waits: is her copy there? Absent lines wait without ageing (the subtitle and the give-up are for a line that CAN play and
    -- is held up), and the moment she is there their clock starts again.
    local function checkPresence(now)
        if type(options.present) ~= 'function' or now - presentAt < M.PRESENT_STEP - 1e-6 then return end
        presentAt = now
        local answers = {}
        for _, e in ipairs(waiting) do
            if needsSpeaker(e) then
                local key = e.profileKey .. '|' .. e.channel
                if answers[key] == nil then
                    local ok, value = pcall(options.present, e.profileKey, e.channel)
                    answers[key] = (not ok or value ~= false) and 1 or 0
                end
                if answers[key] == 0 then
                    if not e.absent then e.absent = true; log('line ' .. e.id .. ' waits: ' .. e.profileKey .. ' has no copy of V here') end
                elseif e.absent then
                    e.absent = false; e.queuedAt = now
                    log('line ' .. e.id .. ' can play: ' .. e.profileKey .. ' is here')
                end
            elseif e.absent then e.absent = false end
        end
    end

    -- A call line belongs to its call: it is alive while the call is on (true, or the function the call gave answers true).
    local function callAlive(entry)
        if entry.call == true then return true end
        local ok, value = pcall(entry.call)
        return ok and value == true
    end

    -- A line that cannot be played is shown instead (the pack's text, as a subtitle), and the script moves on.
    local function showText(entry)
        if entry.text and not entry.shown then
            entry.shown = true
            if type(options.subtitle) == 'function' then pcall(options.subtitle, entry.profileKey, entry.text) end
        end
    end

    -- Try to start the next line now. Cheap: a few table reads when nothing is waiting.
    function L.pump()
        if active or #waiting == 0 then return false end
        local now = clock()
        if now - lastEnd < M.BETWEEN - 1e-6 then return false end
        if isBusy() then return false end
        local index, entry = pick()
        if not entry then return false end
        local ok, requestId, why = pcall(options.start or function() return nil, 'no player' end, entry)
        if ok and requestId then
            table.remove(waiting, index)
            active = {entry = entry, requestId = requestId, startedAt = now, lost = 0}
            changed()
            return true
        end
        entry.fails = entry.fails + 1
        entry.why = ok and why or requestId
        return false
    end

    -- A line has ended: success only when it was heard to its end.
    function L.stopped(requestId, reason)
        if not active or active.requestId ~= requestId then return false end
        local entry = active.entry
        active = nil
        lastEnd = clock()
        if reason == 'finished' then
            emit(entry.pack, 'line:' .. entry.id .. ':done')
        elseif entry.call then
            if not callAlive(entry) then
                log('call line ' .. entry.id .. ' was cut (' .. tostring(reason) .. '), the call is over')
            elseif entry.retries < M.PLOT_RETRIES then
                entry.retries = entry.retries + 1
                table.insert(waiting, 1, entry)
                log('call line ' .. entry.id .. ' was cut (' .. tostring(reason) .. '), it waits to be played again')
            else
                emit(entry.pack, 'line:' .. entry.id .. ':done')
                log('call line ' .. entry.id .. ' could not be played (' .. tostring(reason) .. '), the call goes on')
            end
        elseif not entry.bark then
            if entry.retries < M.PLOT_RETRIES then
                entry.retries = entry.retries + 1
                table.insert(waiting, 1, entry)
                log('line ' .. entry.id .. ' was cut (' .. tostring(reason) .. '), it waits to be played again')
            else
                showText(entry)
                emit(entry.pack, 'line:' .. entry.id .. ':done')
                log('line ' .. entry.id .. ' could not be played (' .. tostring(reason) .. '), shown instead')
            end
        else
            log('bark ' .. entry.id .. ' was cut (' .. tostring(reason) .. ')')
        end
        changed()
        return true
    end

    function L.active() return active and {pack = active.entry.pack, id = active.entry.id, requestId = active.requestId} or nil end

    -- ---- Phone Chat rows ----------------------------------------------------------------------------------------------------------------
    local function sendText(item)
        local meta, info = lineOf(item.pack, item.id)
        if not meta or type(meta.text) ~= 'string' or meta.text == '' then return true end   -- nothing to deliver, nothing to retry
        local profileKey = speakerKey(meta.speaker) and meta.speaker or info.character
        local key = item.image or meta.image
        local image = type(key) == 'string' and info.images[key] or nil
        local ok, sent = pcall(options.phone or function() return false end, profileKey, meta.text, type(image) == 'table' and image or nil)
        return ok and sent == true
    end

    -- `inPerson`: she stands beside V and the quest began in person, so the text is not sent (she says it in her reply), and the row still counts as done.
    function L.text(pack, lineId, imageKey, inPerson)
        local meta = lineOf(pack, lineId)
        if not meta then log('unknown text line ' .. tostring(lineId) .. ' of ' .. tostring(pack)); return false end
        if inPerson == true then
            log('text ' .. tostring(lineId) .. ' left out: she is beside V')
            emit(pack, 'line:' .. lineId .. ':done')
            return true
        end
        local item = {pack = pack, id = lineId, image = imageKey, tries = 1, nextAt = clock() + M.TEXT_RETRY}
        if sendText(item) then
            emit(pack, 'line:' .. lineId .. ':done')
            return true
        end
        texts[#texts + 1] = item
        changed()
        return true
    end

    -- ---- the gap ------------------------------------------------------------------------------------------------------------------------
    local function profileOf(pack)
        local info = packs[pack]
        return info and info.character or nil
    end

    function L.openGap(pack, gapId, restoredAt)
        if not plainId(gapId) or not packs[pack] then return false end
        local old = gaps[pack]
        local spec = packs[pack].gaps[gapId]
        if type(spec) ~= 'table' then spec = {} end
        if not old then gapCount = gapCount + 1
        elseif old.idleStarted and type(options.idle) == 'function' then pcall(options.idle, old.profileKey, old.idleKey, false, old.situation) end   -- one pose at a time
        local g = {id = gapId, spec = spec, gameAt = restoredAt or gameTime(), clockAt = clock(), profileKey = profileOf(pack)}
        gaps[pack] = g
        -- The pose of the gap, started once (a gap restored after a load starts it again): its own idle, else the one its situation stands for.
        local situation = type(spec.situation) == 'string' and M.SITUATIONS[spec.situation] ~= nil and spec.situation or nil
        local idleKey = type(spec.idle) == 'string' and spec.idle or (situation and M.SITUATIONS[situation]) or nil
        if type(options.idle) == 'function' and (idleKey or situation) then
            g.idleKey, g.situation, g.idleStarted = idleKey, situation, true
            local ok, stepper = pcall(options.idle, g.profileKey, idleKey, true, situation)
            if ok and type(stepper) == 'function' then g.idleStep, g.idleNext = stepper, clock() + M.IDLE_STEP end
        end
        if not restoredAt then emit(pack, 'gap:' .. gapId .. ':open') end
        changed()
        return true
    end

    function L.restoreGap(pack, gapId, openedAt)
        if type(openedAt) ~= 'number' or openedAt ~= openedAt then openedAt = nil end
        return L.openGap(pack, gapId, openedAt or gameTime() or 0)
    end

    -- Ends the gap. emitResume: tell the quest (gap:<id>:resume) unless the ending event came from the quest side.
    function L.closeGap(pack, gapId, emitResume)
        local g = gaps[pack]
        if not g or (gapId ~= nil and g.id ~= gapId) then return false end
        gaps[pack], gapCount = nil, gapCount - 1
        g.idleStep = nil
        if type(options.idle) == 'function' and g.idleStarted then pcall(options.idle, g.profileKey, g.idleKey, false, g.situation) end
        changed()
        if emitResume ~= false then emit(pack, 'gap:' .. g.id .. ':resume') end
        return true
    end

    function L.gap(pack)
        local g = gaps[pack]
        return g and {id = g.id, openedAt = g.gameAt} or nil
    end

    -- The quest module reports every event, so a gap can end by one.
    function L.onEvent(pack, name)
        local g = gaps[pack]
        if not g or type(name) ~= 'string' then return end
        local prefix = 'gap:' .. g.id .. ':'
        if name:sub(1, #prefix) == prefix then
            if name ~= prefix .. 'open' then L.closeGap(pack, g.id, false) end
            return
        end
        local on = g.spec.resumeOn
        if type(on) == 'table' then
            for _, wanted in ipairs(on) do
                if wanted == name then L.closeGap(pack, g.id, true); return end
            end
        end
    end

    -- ---- the step -----------------------------------------------------------------------------------------------------------------------
    local function step(now)
        -- Gaps by their timer: game seconds, with the real clock when the game clock cannot be read (a gap never stalls).
        if gapCount > 0 then
            local game = gameTime()
            local expired = {}
            for pack, g in pairs(gaps) do
                local after = tonumber(g.spec.resumeAfterSeconds)
                if after and after > 0 then
                    local elapsed = (g.gameAt and game) and (game - g.gameAt) or (now - g.clockAt)
                    if elapsed >= after or elapsed < -300 then expired[#expired + 1] = {pack, g.id} end
                end
            end
            for _, row in ipairs(expired) do L.closeGap(row[1], row[2], true) end
            -- A pose that needs a few seconds to start is stepped once a second until it answers done (or fails): the only repeated call, and only while it is starting.
            for _, g in pairs(gaps) do
                if g.idleStep and now >= g.idleNext then
                    g.idleNext = now + M.IDLE_STEP
                    local ok, done = pcall(g.idleStep)
                    if not ok or done == true then g.idleStep = nil end
                end
            end
        end
        -- Phone rows that waited for the saved chats.
        for index = #texts, 1, -1 do
            local item = texts[index]
            if now >= item.nextAt then
                item.tries = item.tries + 1
                item.nextAt = now + M.TEXT_RETRY
                if sendText(item) then
                    table.remove(texts, index)
                    emit(item.pack, 'line:' .. item.id .. ':done')
                elseif item.tries >= M.TEXT_TRIES then
                    table.remove(texts, index)
                    log('text line ' .. item.id .. ' could not be delivered')
                    emit(item.pack, 'line:' .. item.id .. ':done')
                end
            end
        end
        -- Waiting lines: a bark is dropped after 4 s, a plot line is shown after 20 s and kept (given up after ten minutes).
        checkPresence(now)
        for index = #waiting, 1, -1 do
            local e = waiting[index]
            if #holds > 0 and held(e) then e.queuedAt = now end   -- held lines do not age: a bark is not dropped and a plot line is not shown while the hold lasts
            local age = now - e.queuedAt
            if e.absent then
                -- Her copy is not here. A line of the stage waits for her (it is dropped with the stage), a line of an ending cannot, so it goes to her Phone Chat thread.
                if not e.final then e.queuedAt = now
                elseif age >= M.PLOT_SUBTITLE then
                    table.remove(waiting, index)
                    if type(options.phone) == 'function' and e.text then pcall(options.phone, e.profileKey, e.text, nil) end
                    emit(e.pack, 'line:' .. e.id .. ':done')
                    log('ending line ' .. e.id .. ' sent as a text: ' .. e.profileKey .. ' is not here')
                end
            elseif e.bark then
                if age > M.BARK_WAIT then
                    table.remove(waiting, index)
                    log('bark ' .. e.id .. ' dropped after ' .. string.format('%.1f', age) .. ' s' .. (e.why and (' (' .. tostring(e.why) .. ')') or ''))
                end
            elseif e.call then
                if not callAlive(e) then table.remove(waiting, index)
                elseif age >= M.PLOT_GIVE_UP then table.remove(waiting, index); emit(e.pack, 'line:' .. e.id .. ':done'); log('call line ' .. e.id .. ' given up after ' .. math.floor(age) .. ' s') end
            else
                if age >= M.PLOT_SUBTITLE then showText(e) end
                if age >= M.PLOT_GIVE_UP then
                    table.remove(waiting, index)
                    if type(options.phone) == 'function' and e.text then pcall(options.phone, e.profileKey, e.text, nil) end
                    emit(e.pack, 'line:' .. e.id .. ':done')
                    log('plot line ' .. e.id .. ' given up after ' .. math.floor(age) .. ' s, sent as a text')
                end
            end
        end
        -- The line in the air: lost when its request is gone without a word from the speech.
        if active and type(options.alive) == 'function' then
            local ok, alive = pcall(options.alive, active.requestId)
            if ok and alive == false then
                active.lost = active.lost + 1
                if active.lost >= M.LOST_CHECKS then L.stopped(active.requestId, 'lost') end
            else
                active.lost = 0
            end
        end
        L.pump()
    end

    -- From the quest module's tick, every call. One nil check while idle.
    function L.update(delta)
        if not active and #waiting == 0 and #texts == 0 and gapCount == 0 then return end
        acc = acc + (tonumber(delta) or 0)
        if acc < M.STEP - 1e-6 then return end
        acc = 0
        step(clock())
    end

    function L.busy() return active ~= nil or gapCount > 0 end
    function L.pending() return active ~= nil or gapCount > 0 or #waiting > 0 or #texts > 0 end
    function L.gapOpen() return gapCount > 0 end

    -- A pack's stage ended: its barks go, plot lines stay (they were scripted for the story, not for the stage), its gap is closed without a word.
    function L.dropPack(pack)
        for index = #waiting, 1, -1 do
            local e = waiting[index]
            if e.pack == pack and (e.bark or (e.absent and not e.final)) then table.remove(waiting, index) end
        end
        local g = gaps[pack]
        if g then L.closeGap(pack, g.id, false) end
        changed()
    end

    -- A scripted call ended or its stage did: the call lines of the pack that still wait are dropped without a word (the one in the air ends with the call's speech).
    function L.dropCall(pack)
        local dropped = 0
        for index = #waiting, 1, -1 do
            if waiting[index].pack == pack and waiting[index].call then table.remove(waiting, index); dropped = dropped + 1 end
        end
        if dropped > 0 then changed() end
        return dropped
    end

    -- The world changed or the setting went off: nothing is kept, and nothing is told to the quest.
    function L.reset()
        waiting, texts, active, gaps, gapCount, acc, holds = {}, {}, nil, {}, 0, 0, {}
        changed()
    end

    -- Lines on `channel` wait while fn() is true. Returns a function that removes the hold. Used by the remote primitive's dead zone.
    function L.holdWhile(channel, fn)
        if type(channel) ~= 'string' or type(fn) ~= 'function' then return function() end end
        local hold = {channel = channel, fn = fn}
        holds[#holds + 1] = hold
        return function()
            for index = #holds, 1, -1 do if holds[index] == hold then table.remove(holds, index) end end
        end
    end

    -- Developer probe: one line now, as if a row had asked for it.
    function L.playNow(pack, lineId)
        return L.say(pack, lineId, {bark = false})
    end

    function L.status()
        local rows = {}
        for _, e in ipairs(waiting) do
            rows[#rows + 1] = {pack = e.pack, id = e.id, bark = e.bark, waited = math.floor((clock() - e.queuedAt) * 10) / 10, why = e.why, absent = e.absent == true}
        end
        local openGaps = {}
        for pack, g in pairs(gaps) do openGaps[#openGaps + 1] = {pack = pack, id = g.id} end
        return {active = L.active(), waiting = rows, gaps = openGaps, texts = #texts}
    end

    return L
end

return M
