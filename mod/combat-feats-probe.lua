-- Combat feats, the cost study (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2, "Cool combat feats"). Players asked Johnny to remark on what V
-- pulls off in a fight: multi-kills, headshots, a Sandevistan or a Kerenzikov, quickhack chains. He stays quiet in fights, so a remark
-- would come after one; the question is what it costs to know what happened. This developer probe answers it in a real fight:
--   hooks     the per-hit, per-kill and per-use script functions a feats remark could observe, each with an O(1) counter: calls, calls
--             per second (and in the busiest WINDOW-second window), and an estimate of the main-thread time they cost
--   counters  the counters the game already keeps (the ones mod/combat-feats.lua reads at a fight's start and end), read at start and
--             at stop, so their difference can be checked against what happened
--   dilation  whether time is slowed (Sandevistan, Kerenzikov) and whether V is in combat, sampled on the dispatcher's 0.5 s tick
--
-- Run from mod/johnny-probe.lua in Developer mode: "johnny-probe:feats:start|status|stop:<stamp>" (start:<seconds> for a shorter run).
-- The hooks register on the first start, late and inside pcall (the pattern of mod/loot-probe.lua), and every callback returns at once
-- while no run is active. CET cannot remove an observer: reload CET (or restart the game) after the study. Bounded: a run lasts at most
-- MAX_SECONDS, keeps at most MAX_WINDOWS windows, and labels at most SAMPLE_LIMIT calls per hook (MAX_LABELS distinct labels).
--
-- Not observed on purpose: the damage system's own pipeline (DamageSystem.ProcessPipeline and ProcessLocalizedDamage, where the
-- Headshot flag is set): the hit data around it is guarded by read-write locks (NPCPuppet.script m_hitEventLock), a sign it may be read
-- off the main thread, where a Lua callback is unsafe. Nor the player state machine's SandevistanEvents and KerenzikovEvents (their
-- Decisions classes run every frame): V's status effects carry both activations instead.
local M = convaiCombatFeatsProbe or {active = false, hooks = {}, lifecycle = {}, serial = 0}
convaiCombatFeatsProbe = M

M.DEFAULT_SECONDS, M.MIN_SECONDS, M.MAX_SECONDS = 300, 10, 300
M.WINDOW, M.MAX_WINDOWS = 10, 30
M.SAMPLE_LIMIT, M.MAX_LABELS = 64, 16
M.TICK_SECONDS = 0.5
-- Calibration batch sizes: long enough to span several 1 ms clock ticks, short enough to be one small hitch at start.
M.CALIBRATION = {callbacks = 20000, native = 500}
-- An observer dispatch converts `this` and one argument into Lua values: about two crossings of the CET boundary, plus our callback.
M.DISPATCH_CROSSINGS = 2
-- Used only when the boundary cannot be timed (no game): the upper end of "a native call costs roughly 10-25 us"
-- (docs/PERFORMANCE_NATIVE_PLAN.md, section 1).
M.ASSUMED_BOUNDARY_US = 25
-- At 48 fps, 44 ms of main-thread time per second is 1 ms per frame, about 2 FPS (docs/PERFORMANCE_NATIVE_PLAN.md units).
M.NOMINAL_FPS = 48
-- Verdicts on the estimated cost in the busiest window, in ms per second of play.
M.BANDS = {negligible = 1, small = 5}
local unavailable = 'unavailable'

-- The candidates. kind: how often it fires; what: in words; source: the REDmod script (tools/redmod/scripts) that defines or sends it;
-- expected: our estimate for a heavy fight, before the measurement; label (optional): a short plain string for the first SAMPLE_LIMIT
-- calls, so the report shows what fired the hook (its time is kept apart from the counter's).
local function enumName(value)
    local text = tostring(value)
    return (text:match(':%s*([%w_]+)') or text:match('^([%w_]+)$') or 'unknown'):sub(1, 40)
end
local function recordName(id)
    return (TDBID.ToStringDEBUG(id) or 'unknown'):gsub('[^%w%._%-]', ''):sub(1, 60)
end
local function hitLabel(attack)
    local byV = attack:GetInstigator():IsPlayer() == true
    local label = byV and 'by-V' or 'other'
    if attack:HasFlag(Enum.new('hitFlag', 'Headshot')) then label = label .. ':headshot' end
    if attack:HasFlag(Enum.new('hitFlag', 'WeakspotHit')) then label = label .. ':weakspot' end
    if attack:GetAttackType() == Enum.new('gamedataAttackType', 'Hack') or attack:HasFlag(Enum.new('hitFlag', 'QuickHack')) then
        label = label .. ':quickhack'
    end
    return label
end

M.HOOKS = {
    {'NPCPuppet', 'OnHit', kind = 'per-hit', expected = '10-60/s, bursts above 100/s',
        what = 'every hit on any NPC, from anyone', source = 'cyberpunk/NPC/NPCPuppet.script:3260'},
    {'GameObject', 'OnDamageReceived', kind = 'per-hit', expected = '15-80/s',
        what = 'every damaging hit on any object (NPCs, V, devices, vehicles), after the damage pipeline (flags set)',
        source = 'core/entity/gameObject.script:1492',
        label = function(_, event) return hitLabel(event.hitEvent.attackData) end},
    {'NPCPuppet', 'OnDeath', kind = 'per-kill', expected = '0.1-1/s, bursts of 3-6 in a second',
        what = 'every NPC death, civilians and crowd included', source = 'cyberpunk/NPC/NPCPuppet.script:3666'},
    {'DataTrackingSystem', 'OnNPCKillDataTrackingRequest', kind = 'per-kill', expected = 'at most the NPC deaths plus defeats',
        what = 'each non-civilian NPC killed or downed, by anyone; the request carries the last hit (killer, flags)',
        source = 'cyberpunk/systems/dataTrackingSystem.script:258 (sent from NPCPuppet.script:3581)',
        label = function(_, request)
            return hitLabel(request.damageEntry.hitEvent.attackData) .. ':' .. enumName(request.eventType)
        end},
    {'DataTrackingSystem', 'OnTakedownActionDataTrackingRequest', kind = 'per-takedown', expected = 'under 0.2/s',
        what = "each of V's takedowns", source = 'cyberpunk/systems/dataTrackingSystem.script:337 (sent from locomotionTakedown.script:596)',
        label = function(_, request) return enumName(request.eventType) end},
    {'DataTrackingSystem', 'OnModifyTelemetryVariable', kind = 'per-shot', expected = '5-15/s with an automatic weapon',
        what = "each shot, melee attack or distraction quickhack of V's",
        source = 'cyberpunk/systems/dataTrackingSystem.script:108 (weaponTransitions.script:2462, meleeTransitions.script:2500)',
        label = function(_, request) return enumName(request.dataTrackingFact) end},
    {'PlayerPuppet', 'OnStatusEffectApplied', kind = 'per-effect', expected = '0.5-5/s',
        what = 'every status effect applied to V (a Sandevistan and a Kerenzikov among them)', source = 'cyberpunk/player/player.script:4977',
        label = function(_, event) return recordName(event.staticData:GetID()) end},
    {'NPCPuppet', 'OnStatusEffectApplied', kind = 'per-effect', expected = '2-30/s',
        what = 'every status effect applied to any NPC (quickhack effects among them)', source = 'cyberpunk/NPC/NPCPuppet.script:1494',
        label = function(_, event) return recordName(event.staticData:GetID()) end},
    {'ScriptedPuppet', 'OnUploadProgressStateChanged', kind = 'per-upload', expected = 'two per quickhack upload',
        what = 'a quickhack upload starting or completing on any puppet (V included)', source = 'cyberpunk/puppet/scriptedPuppet.script:5665',
        label = function(puppet, event) return (puppet:IsPlayer() and 'on-V:' or 'on-NPC:') .. enumName(event.state) end},
    {'QuickhacksListGameController', 'ApplyQuickHack', kind = 'per-quickhack', expected = 'at most 1/s',
        what = 'each quickhack V sends from the quickhack panel', source = 'cyberpunk/UI/widgets/quickhacks/quickhacks.script:693'},
}

-- The game's own counters (persistent: quest facts and the DataTrackingSystem's persistent fields are saved with the game). Note what
-- the facts really count: NPCPuppet.SendDataTrackingEvent (NPCPuppet.script:3581) skips civilians and crowd but never checks who the
-- killer was, so the *_by_player facts count kills by companions and other NPCs too. The m_downedWith* fields check IsSourcePlayer.
M.FACTS = {
    {'gmpl_npcs_killed_by_player', 'NPCs killed, by anyone (civilians and crowd excluded); dataTrackingSystem.script:371'},
    {'gmpl_npcs_finished_by_player', 'downed NPCs then killed; dataTrackingSystem.script:372'},
    {'gmpl_npcs_defeated_by_player', 'NPCs downed but not dead; dataTrackingSystem.script:373'},
    {'gmpl_npcs_incapacitated_by_player', 'NPCs knocked out (non-lethal, takedowns included); dataTrackingSystem.script:374'},
    {'gmpl_npcs_downed_by_player', 'the four above added up (a defeated NPC later finished counts twice); dataTrackingSystem.script:375'},
    {'gmpl_player_range_attacks', "V's shots; dataTrackingSystem.script:124"},
    {'gmpl_player_melee_attacks', "V's melee attacks; dataTrackingSystem.script:115"},
    {'gmpl_player_attacks', "V's attacks of all kinds; dataTrackingSystem.script:149"},
    {'gmpl_player_quickhacks', "V's distraction quickhacks on devices only, not quickhacks on people; deviceBase.script:4594"},
    {'gmpl_player_dodged', "V's dodges; locomotionTransitions.script:2942"},
}
M.FIELDS = {
    {'m_downedWithRanged', 'NPCs V downed with a ranged, direct or thrown attack (V only); dataTrackingSystem.script:285'},
    {'m_downedWithMelee', 'NPCs V downed in melee, with a blade or a thrown weapon (V only); dataTrackingSystem.script:275'},
    {'m_downedInTimeDilatation', 'NPCs V downed while time was slowed: Sandevistan, Kerenzikov or the focused-state perk (V only); '
        .. 'dataTrackingSystem.script:265'},
    {'m_downedEnemies', 'each downed NPC once, by anyone; dataTrackingSystem.script:264'},
    {'m_killedEnemies', 'the field behind gmpl_npcs_killed_by_player'},
    {'m_quickhacksMade', 'the field behind gmpl_player_quickhacks'},
}
-- Skill experience (PlayerDevelopmentData): indirect only. Hack damage feeds Netrunner, handguns, revolvers and snipers Headhunter
-- (10 % more on a headshot or weak spot), rpgManager.script:2160-2240; it says a kind of damage happened, not how often.
M.SKILLS = {{'StrengthSkill', 'Solo'}, {'ReflexesSkill', 'Shinobi'}, {'CoolSkill', 'Headhunter'},
    {'IntelligenceSkill', 'Netrunner'}, {'TechnicalAbilitySkill', 'Engineer'}}
-- The time dilation reasons (timeDilationHelper.script:224-247; the Kerenzikov key really is spelled 'kereznikov').
M.DILATION = {{'sandevistan', 'sandevistan'}, {'kerenzikov', 'kereznikov'}, {'focus', 'focusedStatePerkDilation'}}

local clock = os.clock

local function newState(spec)
    return {calls = 0, windowCalls = 0, seconds = 0, sampled = 0, sampleSeconds = 0, labels = {}, labelCount = 0, peak = 0,
        label = spec and spec.label or nil}
end

local function tally(state, label)
    label = type(label) == 'string' and label ~= '' and label or 'unreadable'
    if state.labels[label] == nil then
        if state.labelCount >= M.MAX_LABELS then label = 'other' end
        if state.labels[label] == nil then state.labelCount = state.labelCount + 1 end
    end
    state.labels[label] = (state.labels[label] or 0) + 1
end

-- The callback of one hook: one flag check while no run is active; while one is, a count and our own Lua time (os.clock, summed).
-- A run that has passed its end stops counting here and leaves the stop (its counter reads) to the next tick or status.
local function observer(state)
    return function(...)
        if not M.active then return end
        local t0 = clock()
        if t0 >= M.untilClock then M.active, M.pendingStop = false, 'expired'; return end
        state.calls, state.windowCalls = state.calls + 1, state.windowCalls + 1
        if state.label and state.sampled < M.SAMPLE_LIMIT then
            state.sampled = state.sampled + 1
            local ok, label = pcall(state.label, ...)
            tally(state, ok and label or 'unreadable')
            state.sampleSeconds = state.sampleSeconds + (clock() - t0)
            return
        end
        state.seconds = state.seconds + (clock() - t0)
        -- Returning nothing from an observer leaves the game's own call alone.
    end
end

local function register(class, method, mode, handler)
    local observe = mode == 'before' and ObserveBefore or (ObserveAfter or Observe)
    local ok, result = pcall(function()
        if type(observe) ~= 'function' then error('Observer unavailable') end
        return observe(class, method, handler)
    end)
    return ok and result ~= false, not ok and tostring(result):sub(1, 160) or nil
end

-- Registers every hook once per CET session (a second start reuses them), and the two lifecycle hooks that end a run: V's death
-- (the stop still reads the counters, on the next tick) and V's detach (a load or a quit: nothing is read from an unloading world).
function M.install()
    for _, spec in ipairs(M.HOOKS) do
        local key = spec[1] .. '.' .. spec[2]
        local state = M.hooks[key] or newState(spec)
        M.hooks[key] = state
        if not state.registered then
            state.registered, state.error = register(spec[1], spec[2], 'after', observer(state))
            state.registration = state.registered and 'registered' or 'registration-unavailable'
        end
    end
    local lifecycle = {
        {'PlayerPuppet', 'OnDeath', function() if M.active then M.active, M.pendingStop = false, 'player-died' end end},
        {'PlayerPuppet', 'OnDetach', function()
            if M.active or M.pendingStop then M.active, M.pendingStop, M.skipCounters = false, 'player-detached', true end
        end},
    }
    for _, row in ipairs(lifecycle) do
        local key = row[1] .. '.' .. row[2]
        if not M.lifecycle[key] then M.lifecycle[key] = register(row[1], row[2], 'before', row[3]) end
    end
end

-- What one callback costs, from two timed batches (os.clock has 1 ms resolution, so each batch spans many ticks): our counter
-- callback called with two stand-in arguments, and a round trip into the game that returns a handle (the conversion an observer pays
-- for `this` and its event). A batch that does not move the clock gives an upper bound (1 ms over the batch), never zero.
function M.calibrate(nativeCall)
    clock = os.clock
    nativeCall = nativeCall or function() return Game.GetPlayer() end
    local function perCall(seconds, count)
        if seconds > 0 then return 1e6 * seconds / count, false end
        return 1e6 * 0.001 / count, true
    end
    local scratch, this, event = newState(nil), {}, {}
    local callback = observer(scratch)
    local active, untilClock = M.active, M.untilClock
    M.active, M.untilClock = true, math.huge
    local t0 = clock()
    for _ = 1, M.CALIBRATION.callbacks do callback(this, event) end
    local luaSeconds = clock() - t0
    M.active, M.untilClock = active, untilClock
    local t1 = clock()
    local ok = pcall(function() for _ = 1, M.CALIBRATION.native do nativeCall() end end)
    local nativeSeconds = clock() - t1
    local callbackUs, callbackBound = perCall(luaSeconds, M.CALIBRATION.callbacks)
    local boundaryUs, boundaryBound = M.ASSUMED_BOUNDARY_US, false
    if ok then boundaryUs, boundaryBound = perCall(nativeSeconds, M.CALIBRATION.native) end
    return {callbacks = M.CALIBRATION.callbacks, callbackMs = luaSeconds * 1000, callbackUs = callbackUs,
        callbackBelowResolution = callbackBound, nativeCalls = M.CALIBRATION.native, nativeMs = ok and nativeSeconds * 1000 or nil,
        boundaryUs = boundaryUs, boundaryBelowResolution = boundaryBound, boundarySource = ok and 'measured' or 'assumed',
        dispatchCrossings = M.DISPATCH_CROSSINGS, perCallUs = callbackUs + M.DISPATCH_CROSSINGS * boundaryUs}
end

-- Calls per second -> estimated main-thread ms per second, and the FPS that is at the nominal frame rate. Pure.
function M.estimate(callsPerSecond, calibration)
    local ms = (tonumber(callsPerSecond) or 0) * (calibration and calibration.perCallUs or 0) / 1000
    return ms, M.NOMINAL_FPS * ms / 1000
end

-- The verdict on the estimated cost in the busiest window. Pure.
function M.verdict(msPerSecond)
    if msPerSecond < M.BANDS.negligible then return 'negligible' end
    if msPerSecond < M.BANDS.small then return 'small' end
    return 'too-costly'
end

local function number(read)
    local ok, value = pcall(read)
    if ok and type(value) == 'number' and value == value and math.abs(value) < math.huge then return value end
    return unavailable
end

-- A DataTrackingSystem field: CET reads script fields directly (as mod/companion-records.lua reads m_NPCManager); Codeware's
-- reflection is the fallback. Says which path worked.
local function field(system, name)
    local direct = number(function() return system[name] end)
    if direct ~= unavailable then return direct, 'field' end
    local reflected = number(function()
        local property = Reflection.GetClass(CName.new('DataTrackingSystem')):GetProperty(CName.new(name))
        return FromVariant(property:GetValue(ToVariant(system)))
    end)
    if reflected ~= unavailable then return reflected, 'reflection' end
    return unavailable, unavailable
end

-- One snapshot of the counters: plain numbers, or 'unavailable' for a read that failed. About 30 native calls, at start and stop only.
function M.counters(player)
    local snapshot = {facts = {}, fields = {}, fieldRead = unavailable, skills = {}, dilation = {}}
    local okQuests, quests = pcall(function() return Game.GetQuestsSystem() end)
    for _, row in ipairs(M.FACTS) do
        snapshot.facts[row[1]] = okQuests and quests and number(function() return quests:GetFactStr(row[1]) end) or unavailable
    end
    local okSystem, system = pcall(function() return Game.GetScriptableSystemsContainer():Get('DataTrackingSystem') end)
    for _, row in ipairs(M.FIELDS) do
        local value, path = unavailable, unavailable
        if okSystem and system then value, path = field(system, row[1]) end
        snapshot.fields[row[1]] = value
        if path ~= unavailable and snapshot.fieldRead == unavailable then snapshot.fieldRead = path end
    end
    local okData, data = pcall(function() return PlayerDevelopmentSystem.GetData(player) end)
    for _, row in ipairs(M.SKILLS) do
        local okKind, kind = pcall(Enum.new, 'gamedataProficiencyType', row[1])
        local ready = okData and data ~= nil and okKind and kind ~= nil
        snapshot.skills[row[2]] = {
            level = ready and number(function() return data:GetProficiencyLevel(kind) end) or unavailable,
            exp = ready and number(function() return data:GetCurrentLevelProficiencyExp(kind) end) or unavailable}
    end
    local okTime, time = pcall(function() return Game.GetTimeSystem() end)
    for _, row in ipairs(M.DILATION) do
        local ok, on = pcall(function() return time:IsTimeDilationActive(row[2]) end)
        snapshot.dilation[row[1]] = okTime and ok and type(on) == 'boolean' and on or unavailable
    end
    return snapshot
end

-- stop - start for every counter: a number, or 'unavailable' when either read failed. A skill whose level changed says so.
local function difference(start, stop)
    if type(start) ~= 'table' or type(stop) ~= 'table' then return nil end
    local diff = {facts = {}, fields = {}, skills = {}}
    local function delta(a, b) return type(a) == 'number' and type(b) == 'number' and b - a or unavailable end
    for _, row in ipairs(M.FACTS) do diff.facts[row[1]] = delta(start.facts[row[1]], stop.facts[row[1]]) end
    for _, row in ipairs(M.FIELDS) do diff.fields[row[1]] = delta(start.fields[row[1]], stop.fields[row[1]]) end
    for _, row in ipairs(M.SKILLS) do
        local a, b = start.skills[row[2]], stop.skills[row[2]]
        if type(a.level) == 'number' and a.level == b.level then diff.skills[row[2]] = delta(a.exp, b.exp)
        elseif type(a.level) == 'number' and type(b.level) == 'number' then diff.skills[row[2]] = 'level-up'
        else diff.skills[row[2]] = unavailable end
    end
    return diff
end

-- One sample on the dispatcher's tick: V in combat, and each time dilation reason (a start is a sample where it is on after one where
-- it was off). Five native calls per 0.5 s while a run is active.
local function sampleWorld(player)
    local world = M.world
    local ok, combat, a, b, c = pcall(function()
        local time = Game.GetTimeSystem()
        return player and player:IsInCombat() == true or false, time:IsTimeDilationActive(M.DILATION[1][2]),
            time:IsTimeDilationActive(M.DILATION[2][2]), time:IsTimeDilationActive(M.DILATION[3][2])
    end)
    if not ok then world.unreadable = world.unreadable + 1; return end
    world.samples = world.samples + 1
    if combat then world.combatSamples = world.combatSamples + 1 end
    for index, on in ipairs({a == true, b == true, c == true}) do
        local row = world[M.DILATION[index][1]]
        if on then
            row.samples = row.samples + 1
            if not row.on then row.starts = row.starts + 1 end
        end
        row.on = on
    end
end

-- Closes the open window: each hook's calls in it, and its peak rate (a window under a second is too short to be a rate).
local function closeWindow(at)
    local seconds = at - M.windowAt
    if seconds <= 0 then return end
    local row = {at = math.floor(M.windowAt - M.startClock + 0.5), seconds = math.floor(seconds * 100 + 0.5) / 100, calls = {}}
    for key, state in pairs(M.hooks) do
        if state.windowCalls > 0 then
            row.calls[key] = state.windowCalls
            if seconds >= 1 and state.windowCalls / seconds > state.peak then state.peak = state.windowCalls / seconds end
        end
        state.windowCalls = 0
    end
    if #M.windows < M.MAX_WINDOWS then M.windows[#M.windows + 1] = row else M.windowsDropped = M.windowsDropped + 1 end
    M.windowAt = at
end

-- Ends the run: the last window, then the counters again (not after a detach: the world is unloading).
local function finish(reason, player)
    local skip = M.skipCounters
    M.active, M.pendingStop, M.skipCounters = false, nil, nil
    if M.stoppedAt then return end
    M.stoppedAt, M.stopClock = os.time(), clock()
    M.stopReason = type(reason) == 'string' and reason:sub(1, 80) or 'stopped'
    if M.windowAt and M.stopClock - M.windowAt >= 1 then closeWindow(M.stopClock) end
    M.stopCounters = not skip and M.counters(player) or nil
end

local function settle(player)
    if M.pendingStop then finish(M.pendingStop, player)
    elseif M.active and clock() >= M.untilClock then finish('expired', player) end
end

function M.start(env, seconds)
    env = type(env) == 'table' and env or {}
    seconds = tonumber(seconds) or M.DEFAULT_SECONDS
    if seconds ~= seconds or math.abs(seconds) == math.huge then seconds = M.DEFAULT_SECONDS end
    seconds = math.max(M.MIN_SECONDS, math.min(M.MAX_SECONDS, math.floor(seconds)))
    if M.active or M.pendingStop then finish('restarted', env.player) end
    clock = os.clock
    M.calibration = M.calibrate()
    M.install()
    for _, state in pairs(M.hooks) do
        state.calls, state.windowCalls, state.seconds, state.sampled, state.sampleSeconds = 0, 0, 0, 0, 0
        state.labels, state.labelCount, state.peak = {}, 0, 0
    end
    M.serial = M.serial + 1
    M.world = {samples = 0, combatSamples = 0, unreadable = 0}
    for _, row in ipairs(M.DILATION) do M.world[row[1]] = {samples = 0, starts = 0, on = false} end
    M.windows, M.windowsDropped = {}, 0
    M.stoppedAt, M.stopClock, M.stopReason, M.stopCounters, M.pendingStop, M.skipCounters = nil, nil, nil, nil, nil, nil
    M.startCounters = M.counters(env.player)
    M.seconds, M.startedAt = seconds, os.time()
    M.expiresAt, M.runId = M.startedAt + seconds, tostring(M.startedAt) .. '-' .. tostring(M.serial)
    M.startClock = clock()
    M.untilClock, M.windowAt = M.startClock + seconds, M.startClock
    M.active = true
    return M.report()
end

function M.stop(env)
    env = type(env) == 'table' and env or {}
    if M.active or M.pendingStop then finish('stopped', env.player) end
    return M.report()
end

function M.status(env)
    settle(type(env) == 'table' and env.player or nil)
    return M.report()
end

-- The dispatcher's 0.5 s tick, while a run is active: the stop of a run that ended by itself, the world sample, the window.
function M.tick(env)
    local player = type(env) == 'table' and env.player or nil
    settle(player)
    if not M.active then return false end
    sampleWorld(player)
    local at = clock()
    if at - M.windowAt >= M.WINDOW then closeWindow(at) end
    return true
end

function M.run(action, env)
    local verb, value = tostring(action):match('^(%a+):?(%d*)$')
    if verb == 'start' then return M.start(env, tonumber(value)) end
    if verb == 'stop' then return M.stop(env) end
    if verb == 'status' then return M.status(env) end
    error('unknown action ' .. tostring(action) .. ' (start, start:<seconds>, status, stop)')
end

local function round(value, places)
    local scale = 10 ^ (places or 2)
    return math.floor(value * scale + 0.5) / scale
end

local HOW_TO_READ = 'hooks: each candidate with its calls over the run, calls per second (whole run, and the busiest '
    .. M.WINDOW .. ' s window: peak), and the estimated main-thread cost: calls per second times the calibrated cost of one dispatch '
    .. '(calibration.perCallUs). At ' .. M.NOMINAL_FPS .. ' fps, 44 ms/s is 1 ms per frame, about 2 FPS. Verdicts on the peak: under '
    .. M.BANDS.negligible .. ' ms/s negligible, under ' .. M.BANDS.small .. ' small, otherwise too costly for a feature that would '
    .. 'run in every fight. measuredLuaMs is our own Lua time inside the callbacks (os.clock, 1 ms resolution, summed); the CET '
    .. 'dispatch itself cannot be seen from Lua, hence the estimate. labels: what fired the hook, from its first ' .. M.SAMPLE_LIMIT
    .. ' calls. counters.diff: what the game\'s own counters say happened between start and stop (compare with the fight you played). '
    .. 'dilation: whether time was slowed, sampled every ' .. M.TICK_SECONDS .. ' s (starts = activations seen).'

function M.report()
    local now = clock()
    local span = M.startClock and math.max(0, (M.stopClock or now) - M.startClock) or 0
    local calibration = M.calibration
    local world = M.world or {samples = 0, combatSamples = 0, unreadable = 0}
    local combatSeconds = world.combatSamples * M.TICK_SECONDS
    local openSeconds = M.active and M.windowAt and now - M.windowAt or 0
    local hooks, ranked = {}, {}
    for _, spec in ipairs(M.HOOKS) do
        local key = spec[1] .. '.' .. spec[2]
        local state = M.hooks[key] or newState(spec)
        local rate = span > 0 and state.calls / span or 0
        local peak = state.peak
        if openSeconds >= 2 and state.windowCalls / openSeconds > peak then peak = state.windowCalls / openSeconds end
        if peak == 0 and span > 0 then peak = rate end
        local ms = M.estimate(rate, calibration)
        local peakMs, peakFps = M.estimate(peak, calibration)
        local verdict = not state.registered and 'registration-unavailable' or state.calls == 0 and 'not-observed' or M.verdict(peakMs)
        local labels = {}
        for label, count in pairs(state.labels) do labels[label] = count end
        hooks[key] = {what = spec.what, kind = spec.kind, source = spec.source, expectedInHeavyFight = spec.expected,
            registration = state.registration or 'not-registered', error = state.error,
            calls = state.calls, callsPerSecond = round(rate), peakCallsPerSecond = round(peak),
            callsPerCombatSecond = combatSeconds > 0 and round(state.calls / combatSeconds) or nil,
            measuredLuaMs = round(state.seconds * 1000, 3), sampledCalls = state.sampled, sampleMs = round(state.sampleSeconds * 1000, 3),
            labels = labels, estimatedMsPerSecond = round(ms, 3), peakEstimatedMsPerSecond = round(peakMs, 3),
            peakFpsAt48 = round(peakFps, 3), verdict = verdict}
        ranked[#ranked + 1] = {key = key, spec = spec, row = hooks[key]}
    end
    table.sort(ranked, function(a, b)
        if a.row.peakEstimatedMsPerSecond ~= b.row.peakEstimatedMsPerSecond then
            return a.row.peakEstimatedMsPerSecond > b.row.peakEstimatedMsPerSecond
        end
        return a.key < b.key
    end)
    local summary = {}
    if calibration then
        summary[#summary + 1] = string.format('Calibration: one counter callback costs about %.2f us of Lua, one crossing into the game about '
            .. '%.2f us (%s); one dispatch is estimated at %.2f us (the callback plus %d crossings, for `this` and the event).',
            calibration.callbackUs, calibration.boundaryUs, calibration.boundarySource, calibration.perCallUs, M.DISPATCH_CROSSINGS)
    end
    for _, item in ipairs(ranked) do
        local row = item.row
        if row.verdict == 'registration-unavailable' or row.verdict == 'not-observed' then
            summary[#summary + 1] = string.format('%s (%s): %s.', item.key, item.spec.what, row.verdict)
        else
            summary[#summary + 1] = string.format('%s (%s): %d calls, %.1f/s over the run, peak %.1f/s; estimated %.2f ms/s at the peak '
                .. '(about %.2f FPS at %d fps): %s.', item.key, item.spec.what, math.floor(row.calls), row.callsPerSecond,
                row.peakCallsPerSecond, row.peakEstimatedMsPerSecond, row.peakFpsAt48, M.NOMINAL_FPS, row.verdict)
        end
    end
    local diff = difference(M.startCounters, M.stopCounters)
    if diff then
        for _, row in ipairs(M.FACTS) do
            if diff.facts[row[1]] ~= 0 then summary[#summary + 1] = string.format('Counter %s: %s (%s).', row[1], tostring(diff.facts[row[1]]), row[2]) end
        end
        for _, row in ipairs(M.FIELDS) do
            if diff.fields[row[1]] ~= 0 then summary[#summary + 1] = string.format('Counter %s: %s (%s).', row[1], tostring(diff.fields[row[1]]), row[2]) end
        end
    end
    local dilation = {samples = world.samples, unreadable = world.unreadable, combatSeconds = combatSeconds}
    for _, row in ipairs(M.DILATION) do
        local seen = world[row[1]] or {samples = 0, starts = 0}
        dilation[row[1]] = {samples = seen.samples, starts = seen.starts, seconds = seen.samples * M.TICK_SECONDS}
    end
    summary[#summary + 1] = string.format('Time dilation, sampled every %.1f s over %d samples (%.1f s in combat): Sandevistan %d starts, '
        .. 'Kerenzikov %d starts, focused-state perk %d starts.', M.TICK_SECONDS, world.samples, combatSeconds,
        dilation.sandevistan.starts, dilation.kerenzikov.starts, dilation.focus.starts)
    summary[#summary + 1] = 'These hooks stay registered until CET is reloaded (callbacks return at once between runs): reload CET or '
        .. 'restart the game after the study.'
    local notes = {facts = {}, fields = {}}
    for _, row in ipairs(M.FACTS) do notes.facts[row[1]] = row[2] end
    for _, row in ipairs(M.FIELDS) do notes.fields[row[1]] = row[2] end
    return {version = 1, probe = 'combat-feats-cost', run = M.runId, active = M.active == true, startedAt = M.startedAt,
        expiresAt = M.expiresAt, stoppedAt = M.stoppedAt, stopReason = M.stopReason, seconds = round(span, 1),
        windowSeconds = M.WINDOW, calibration = calibration, hooks = hooks, windows = M.windows or {}, windowsDropped = M.windowsDropped or 0,
        dilation = dilation, counters = {start = M.startCounters, stop = M.stopCounters, diff = diff, notes = notes},
        verdictBands = M.BANDS, summary = summary, howToRead = HOW_TO_READ}
end

return M
