-- Developer probe for the Relic glitch (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2; mod/johnny-relic.lua), run through mod/johnny-probe.lua
-- as "johnny-probe:relic:<action>:<stamp>" in Developer mode only. The offline data says an episode is a status effect with the
-- gameplay tag JohnnySickness on V; this shows it live: which records the game applies and removes, in which order, at which scene
-- tier, and what mod/johnny-relic.lua would have made of them.
--   start     watch every status effect applied to or removed from V for up to WATCH_SECONDS (a fresh run each time)
--   status    the watch so far (read only)
--   stop      end the watch and report it
--   snapshot  V's effects right now, the Relic watch of the mod, the settings and the story-gate facts (read only)
-- Observers cannot be unregistered: the two are registered once per Lua state, at the first start, inside pcall (mod/loot-probe.lua),
-- and return at once while no watch runs. Everything is bounded: time, rows, tags per row, distinct records. No native handle is kept.
local M = convaiJohnnyRelicProbe or {active = false, hooks = {}, serial = 0}
convaiJohnnyRelicProbe = M
M.WATCH_SECONDS, M.MAX_EVENTS, M.MAX_CANDIDATES, M.MAX_RECORDS, M.MAX_EFFECTS, M.MAX_EMITS = 300, 200, 60, 80, 64, 10
local unavailable = 'unavailable'

local function relic()
    if not M.relic then
        local ok, module = pcall(dofile, 'johnny-relic.lua')
        M.relic = ok and type(module) == 'table' and type(module.classify) == 'function' and module or false
    end
    return M.relic or nil
end

local function read(fn, ...)
    local ok, value = pcall(fn, ...)
    if ok then return value end
    return nil
end

local function nameOf(value)
    if value == nil then return nil end
    local text = read(function() return Game.NameToString(value) end)
    if type(text) ~= 'string' or text == '' or text == 'None' then text = read(function() return value.value end) end
    return type(text) == 'string' and text:sub(1, 60) or nil
end

local function tagCName()
    if M.tag == nil then M.tag = read(function() return CName.new('JohnnySickness') end) or false end
    return M.tag or nil
end

-- What the game says about one record: name, hash, tags (bounded), and the classifier's readings by name and by hash.
local function describe(record)
    local module, tag = relic(), tagCName()
    local id = read(function() return record:GetID() end)
    local row = {record = id and read(function() return TDBID.ToStringDEBUG(id) end) or unavailable,
        hash = id and read(function() return id.hash end) or unavailable, tags = {}}
    if type(row.record) ~= 'string' or row.record == '' then row.record = unavailable end
    local count = tonumber(read(function() return record:GetGameplayTagsCount() end)) or 0
    for index = 0, math.min(count, module and module.MAX_TAGS or 12) - 1 do
        row.tags[#row.tags + 1] = nameOf(read(function() return record:GetGameplayTagsItem(index) end)) or unavailable
    end
    if count > #row.tags then row.moreTags = count - #row.tags end
    row.relic = tag and read(function() return record:GameplayTagsContains(tag) end) == true or false
    local classified
    if module then
        local byName = module.classify(row.record, row.relic)
        if M.byHash == nil then M.byHash = read(function() return module.hashTable(TweakDBID.new) end) or false end
        local byHash = module.classifyHash(type(row.hash) == 'number' and row.hash or nil, M.byHash or nil, row.relic)
        row.byName, row.byHash = byName and byName.severity or false, byHash and byHash.severity or false
        -- The live service reads the hash; the name is the fallback when the hash table could not be made.
        classified = (byHash ~= module.UNKNOWN and byHash) or byName or byHash
    end
    return row, classified
end

-- Where V is when a Relic effect comes or goes: scene tier (1 open play, 2 staged, 3+ limited or cinematic), fight, vehicle, camera.
local function context(player)
    return {tier = read(function() return PlayerPuppet.GetSceneTier(player) end) or unavailable,
        combat = read(function() return player:IsInCombat() end),
        vehicle = read(function() return VehicleComponent.IsMountedToVehicle(player:GetGame(), player) end),
        additiveCamera = read(function() return GameplaySettingsSystem.GetAdditiveCameraMovementsSetting(player) end) or unavailable,
        relicStillOn = read(function() return StatusEffectSystem.ObjectHasStatusEffectWithTag(player, tagCName()) end)}
end

local function open()
    if not M.active then return false end
    if os.time() >= M.expiresAt then M.active, M.stoppedAt, M.stopReason = false, os.time(), 'expired'; return false end
    return true
end

local function capture(kind, player, event)
    local record = event.staticData
    if not record then return end
    local row, classified = describe(record)
    M.sequence = M.sequence + 1
    row.sequence, row.kind, row.at = M.sequence, kind, os.time()
    row.t = math.floor((os.clock() - M.startedClock) * 100 + 0.5) / 100
    row.stacks = tonumber(read(function() return event.stackCount end)) or unavailable
    if kind == 'applied' then
        row.newApplication = read(function() return event.isNewApplication end)
        row.appliedOnSpawn = read(function() return event.isAppliedOnSpawn end)
    else
        row.finalRemoval = read(function() return event.isFinalRemoval end)
    end
    local count = M.counts[row.record]
    if not count and M.distinct < M.MAX_RECORDS then
        count = {record = row.record, applied = 0, removed = 0, relic = row.relic}
        M.counts[row.record], M.distinct = count, M.distinct + 1
    end
    if count then count[kind] = count[kind] + 1 end
    if #M.events < M.MAX_EVENTS then M.events[#M.events + 1] = row else M.dropped = M.dropped + 1 end
    if not row.relic and not row.byName then return end
    -- A Relic effect: where V was, and what the mod's episode logic would have done with it (the same rules as the live service).
    local copy = {}
    for key, value in pairs(row) do copy[key] = value end
    copy.context = context(player)
    if #M.candidates < M.MAX_CANDIDATES then M.candidates[#M.candidates + 1] = copy end
    local module = relic()
    if module and M.tracker then
        local emitted
        if kind == 'applied' and copy.appliedOnSpawn ~= true then
            M.tracker:applied(classified, os.time())
        elseif kind == 'removed' then
            emitted = M.tracker:removed(os.time(), copy.context.relicStillOn == true)
        end
        if emitted and #M.emits < M.MAX_EMITS then
            M.emits[#M.emits + 1] = {severity = emitted.severity, record = emitted.record, seconds = emitted.seconds,
                applications = emitted.applications, update = emitted.update, t = copy.t, sequence = copy.sequence}
        end
    end
end

local specs = {{'OnStatusEffectApplied', 'applied'}, {'OnStatusEffectRemoved', 'removed'}}

function M.install()
    for _, spec in ipairs(specs) do
        local key = 'PlayerPuppet.' .. spec[1]
        local state = M.hooks[key] or {calls = 0, errors = 0}
        M.hooks[key] = state
        if not state.registered then
            local observe = ObserveAfter or Observe
            local ok, result = pcall(function()
                if type(observe) ~= 'function' then error('Observer unavailable') end
                return observe('PlayerPuppet', spec[1], function(player, event)
                    if not open() then return end
                    state.calls = state.calls + 1
                    if not pcall(capture, spec[2], player, event) then state.errors = state.errors + 1 end
                end)
            end)
            state.registered = ok and result ~= false
            state.registration = state.registered and 'registered' or ('unavailable: ' .. tostring(result)):sub(1, 160)
        end
    end
end

local function summary()
    local lines = {}
    if not M.runId then return {'No watch has run yet: send the start action, then trigger a Relic episode in the game.'} end
    lines[#lines + 1] = (M.active and 'Watching' or 'Watched') .. ' V\'s status effects: ' .. M.sequence .. ' changes seen, '
        .. #M.candidates .. ' of them Relic sickness (tag JohnnySickness).'
    for index = 1, math.min(#M.candidates, 12) do
        local row = M.candidates[index]
        lines[#lines + 1] = string.format('%.1f s %s %s tier=%s classified=%s', row.t, row.kind, row.record,
            tostring(row.context and row.context.tier), tostring(row.byName))
    end
    for _, emit in ipairs(M.emits) do
        lines[#lines + 1] = string.format('The mod would note one remark at %.1f s: severity %s (%s, %d applications)%s', emit.t,
            emit.severity, emit.record, emit.applications, emit.update and ', stronger update of the same episode' or '')
    end
    if M.runId and #M.candidates == 0 then
        lines[#lines + 1] = 'No Relic effect seen: if an episode played, it was not a JohnnySickness status effect (see events for what was).'
    end
    return lines
end

function M.status()
    if M.active then open() end
    local hooks = {}
    for key, state in pairs(M.hooks) do hooks[key] = {registration = state.registration, calls = state.calls, errors = state.errors} end
    local counts = {}
    for _, count in pairs(M.counts or {}) do counts[#counts + 1] = count end
    table.sort(counts, function(a, b) return (a.applied + a.removed) > (b.applied + b.removed) end)
    return {version = 1, probe = 'johnny-relic', run = M.runId, active = M.active == true, startedAt = M.startedAt,
        expiresAt = M.expiresAt, stoppedAt = M.stoppedAt, stopReason = M.stopReason, seen = M.sequence or 0,
        limits = {seconds = M.WATCH_SECONDS, events = M.MAX_EVENTS, candidates = M.MAX_CANDIDATES, records = M.MAX_RECORDS},
        dropped = M.dropped or 0, hooks = hooks, summary = summary(),
        candidates = M.candidates or {}, wouldNote = M.emits or {}, records = counts, events = M.events or {},
        read = 'candidates: the Relic sickness effects with where V was (tier 1 open play, 2 staged, 3+ cinematic) and additiveCamera '
            .. '(0 makes the game remove them at once); wouldNote: what mod/johnny-relic.lua would hand to Johnny speaks up; '
            .. 'records: every effect seen, by count; events: the first ' .. M.MAX_EVENTS .. ' changes in order (t: seconds since start).'}
end

function M.start()
    M.serial = M.serial + 1
    M.active, M.events, M.candidates, M.emits, M.counts, M.distinct = false, {}, {}, {}, {}, 0
    M.sequence, M.dropped, M.startedAt, M.startedClock = 0, 0, os.time(), os.clock()
    M.expiresAt, M.stoppedAt, M.stopReason = M.startedAt + M.WATCH_SECONDS, nil, nil
    M.runId = tostring(M.startedAt) .. '-' .. tostring(M.serial)
    local module = relic()
    M.tracker = module and module.tracker() or nil
    for _, state in pairs(M.hooks) do state.calls, state.errors = 0, 0 end
    M.install()
    M.active = true
    return M.status()
end

function M.stop(reason)
    if M.active then M.active, M.stoppedAt, M.stopReason = false, os.time(), reason or 'stopped' end
    return M.status()
end

-- V's effects now, and everything that decides whether a Relic remark could happen.
function M.snapshot(env)
    local player = env and env.player
    local report = {version = 1, probe = 'johnny-relic', action = 'snapshot', at = os.time(), effects = {}}
    local list = player and read(function() return Game.GetStatusEffectSystem():GetAppliedEffects(player:GetEntityID()) end)
    report.available = type(list) == 'table'
    for _, effect in ipairs(type(list) == 'table' and list or {}) do
        if #report.effects >= M.MAX_EFFECTS then report.moreEffects = (report.moreEffects or 0) + 1
        else
            local record = read(function() return effect:GetRecord() end)
            local row = record and describe(record) or {record = unavailable}
            row.remaining = read(function() return effect:GetRemainingDuration() end)
            row.total = read(function() return effect:GetTotalDuration() end)
            row.stacks = read(function() return effect:GetStackCount() end)
            report.effects[#report.effects + 1] = row
        end
    end
    report.context = player and context(player) or nil
    report.settings = {johnnyInHead = read(manager.johnnyInHead), johnnyRemarks = read(manager.johnnyRemarks)}
    local service = convaiJohnnyRelic
    report.relicWatch = service and read(service.status, service) or (service == false and 'failed to load' or 'not created (both settings on, then wait a few seconds)')
    local remarks = convaiJohnnyRemarks
    if remarks then
        report.remarkQueue = {}
        for _, entry in ipairs(remarks.queue) do report.remarkQueue[#report.remarkQueue + 1] = {subject = entry.subject, kind = entry.kind, at = entry.heardAt} end
        report.relicCooledAt = remarks.subjects['relic:episode']
    end
    local head = read(dofile, 'johnny-head.lua')
    report.facts = {}
    if type(head) == 'table' and type(head.START) == 'string' then
        local names = {head.START}
        for _, name in ipairs(type(head.ENDINGS) == 'table' and head.ENDINGS or {}) do names[#names + 1] = name end
        for _, name in ipairs(names) do
            report.facts[name] = read(function() return Game.GetQuestsSystem():GetFactStr(name) end) or unavailable
        end
    end
    report.factsNote = 'No quest fact tied to the Relic sickness was found offline; these are the story-gate facts of mod/johnny-head.lua '
        .. '(q101_done set and no ending fact: Johnny is in V\'s head).'
    return report
end

function M.run(action, env)
    if action == 'start' then return M.start() end
    if action == 'status' then return M.status() end
    if action == 'stop' then return M.stop('stopped') end
    if action == 'snapshot' then return M.snapshot(env) end
    error('unknown action ' .. tostring(action) .. ' (start, status, stop, snapshot)')
end

-- On the existing 0.5 s battle sample while a watch runs (mod/johnny-probe.lua); false once it is over.
function M.tick()
    return open()
end

return M
