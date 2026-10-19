-- The Relic glitch (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): with Johnny in your head on and Johnny speaks up at Rare or Normal, an episode
-- of the Relic's sickness on V (the breathing camera, the fullscreen distortion) becomes one event for a remark of his after it is over.
--
-- What marks an episode (the game's own data, 2.31):
--   tweaks/base/gameplay/static_data/database/status_effect/johnny_sickness.tweak: JohnnySicknessAbstract carries the gameplay tag
--   "JohnnySickness" (with "CameraAnimation"), an infinite duration and the UI data JohnnySicknessUI. Its children are
--   JohnnySicknessLow, JohnnySicknessMedium, JohnnySicknessMediumQuest (about 4 s: an infinite -1 plus 5) and JohnnySicknessHeavy, each
--   with its own fullscreen effect (johnny_sickness_lvl1, _lvl2, _lvl3) and sound (vfx_fullscreen_johnny_sickness_low/medium/heavy).
--   tweaks/ep1/.../status_effect/quest_custom.tweak: q304_songbird_relic_shock (Phantom Liberty) inherits the same tag, with the lvl1 look.
--   No script or effector applies them: the quest graphs do (and one quest consumable, mq036_unmarked_bd_cartridge, quest_items.tweak).
--   scripts/cyberpunk/player/player.script PlayerPuppet.OnStatusEffectApplied hands every effect with the tag to
--   ProcessBreathingEffectApplication, which removes the other JohnnySickness effects: low -> medium -> heavy replace one another.
--   With the game's "additive camera movements" at 0 the game removes them again at once (the CameraAnimation rule there).
--
-- Why an event works, and what it costs: the effect is applied to V through PlayerPuppet.OnStatusEffectApplied and taken off through
-- PlayerPuppet.OnStatusEffectRemoved (only the player's class overrides them, so no NPC reaches these callbacks). Both are observed
-- once, after the fact, and never per frame. For every other effect on V the callback is one flag read and, while enabled, one native
-- tag check (StatusEffect_Record.GameplayTagsContains with a CName made once): no table, no string. A tag check is cheaper than
-- comparing ids (GetID would build a TweakDBID for every effect) and covers every record that inherits the tag, the Phantom Liberty
-- one included. Only an effect that carries the tag reads its id, compared by hash with ids made once, to find the severity.
--
-- One episode is one event: from the first application to the moment no JohnnySickness effect is left on V (the native tag check on
-- that removal), the strongest severity kept. A new application within MERGE_SECONDS of that end continues the same episode (a chain
-- with a gap, or the at-once removal of the camera rule); it gives a second event only if it was stronger (the remark queue then
-- refreshes the same subject). An effect restored with a save (isAppliedOnSpawn) is not news.
--
-- Loaded and created by init.lua only while both settings are on; observers cannot be unregistered, so they are registered once per
-- Lua state (the global convaiJohnnyRelicHook), late and inside pcall like mod/loot-probe.lua, and a disabled service makes them
-- return at once. If the registration of the application fails, one log line says so and the service stays inert for the session (no
-- event, no retry). If only the removal fails, each application ends its episode at once (the remark still waits its quiet time).
local M = {TAG = 'JohnnySickness', MERGE_SECONDS = 60, MAX_TAGS = 12}

-- The records, by name, and the severity Johnny hears (from their fullscreen effect: lvl1 low, lvl2 medium, lvl3 heavy).
M.RECORDS = {
    {record = 'BaseStatusEffect.JohnnySicknessLow', severity = 'low'},
    {record = 'BaseStatusEffect.JohnnySicknessMedium', severity = 'medium'},
    {record = 'BaseStatusEffect.JohnnySicknessMediumQuest', severity = 'medium'},
    {record = 'BaseStatusEffect.JohnnySicknessHeavy', severity = 'heavy'},
    {record = 'BaseStatusEffect.q304_songbird_relic_shock', severity = 'low'},
}
M.RANK = {low = 1, medium = 2, heavy = 3}
-- A record that carries the tag but is not listed (a later patch): the mildest reading, never a guess upwards.
M.UNKNOWN = {record = 'unknown', severity = 'low'}
local BY_NAME = {}
for _, row in ipairs(M.RECORDS) do BY_NAME[row.record] = row end

-- An applied effect -> nil or its row {record, severity} (shared rows: never change them). record: the record name; tagged: the effect
-- carries the JohnnySickness tag. Pure.
function M.classify(record, tagged)
    local row = type(record) == 'string' and BY_NAME[record] or nil
    if row then return row end
    return tagged == true and M.UNKNOWN or nil
end

-- The rows by TweakDBID hash, from a TweakDBID constructor (TweakDBID.new in the game). Built once; an id that cannot be made is left
-- out (its effect still classifies through the tag). Pure apart from the constructor.
function M.hashTable(tdbid)
    local byHash = {}
    for _, row in ipairs(M.RECORDS) do
        local ok, id = pcall(tdbid, row.record)
        local hash = ok and type(id) ~= 'nil' and id.hash or nil
        if type(hash) == 'number' then byHash[hash] = row end
    end
    return byHash
end

-- The same as classify, from an id hash. Pure.
function M.classifyHash(hash, byHash, tagged)
    local row = hash ~= nil and type(byHash) == 'table' and byHash[hash] or nil
    if row then return row end
    return tagged == true and M.UNKNOWN or nil
end

-- The episode logic (pure, times in os.time seconds). applied(row, now) for each classified application; removed(now, remaining) for
-- each removal of a tagged effect, remaining = another tagged effect is still on V. removed returns the event when an episode ends:
-- {severity, record, startedAt, endedAt, seconds, applications, update}; update is true when this episode already gave a weaker one.
function M.tracker(options)
    options = type(options) == 'table' and options or {}
    local merge = tonumber(options.merge) or M.MERGE_SECONDS
    local tracker = {episode = nil}

    function tracker:applied(row, now)
        if type(row) ~= 'table' or not M.RANK[row.severity] or type(now) ~= 'number' then return nil end
        local episode = self.episode
        if not episode or (not episode.open and now - episode.endedAt > merge) then
            self.episode = {open = true, row = row, startedAt = now, lastAt = now, applications = 1, emitted = 0}
            return nil
        end
        episode.open, episode.lastAt, episode.applications = true, now, episode.applications + 1
        if M.RANK[row.severity] > M.RANK[episode.row.severity] then episode.row = row end
        return nil
    end

    function tracker:removed(now, remaining)
        local episode = self.episode
        if not episode or not episode.open or remaining == true or type(now) ~= 'number' then return nil end
        episode.open, episode.endedAt = false, now
        local rank = M.RANK[episode.row.severity]
        if rank <= episode.emitted then return nil end
        local update = episode.emitted > 0
        episode.emitted = rank
        return {severity = episode.row.severity, record = episode.row.record, startedAt = episode.startedAt, endedAt = now,
            seconds = now - episode.startedAt, applications = episode.applications, update = update}
    end

    function tracker:reset() self.episode = nil end
    return tracker
end

-- ---- The service: the two observers and the flag ------------------------------------------------------------------------------
-- The hook state lives in a global so that a second load of this file never registers twice; the callbacks reach the current service
-- through it (hook.target).
local function hookState()
    convaiJohnnyRelicHook = convaiJohnnyRelicHook or {}
    return convaiJohnnyRelicHook
end

local function nativeHasTag(player, tag) return StatusEffectSystem.ObjectHasStatusEffectWithTag(player, tag) end

-- The two callbacks' work once the flag is on. The first two lines are all an ordinary effect costs.
local function onApplied(hook, target, player, event)
    local record = event.staticData
    if not record or not record:GameplayTagsContains(hook.tag) then return end
    if event.isAppliedOnSpawn == true then return end
    local id = record:GetID()
    target:applied(M.classifyHash(id and id.hash, hook.byHash, true))
end

local function onRemoved(hook, target, player, event)
    local record = event.staticData
    if not record or not record:GameplayTagsContains(hook.tag) then return end
    local ok, remaining = pcall(hook.hasTag, player, hook.tag)
    target:removed(ok and remaining == true)
end

-- Register both observers once per Lua state. Returns the hook state; hook.applied and hook.removed are 'registered' or 'failed'.
local function install(hook, options)
    if hook.applied ~= nil then return hook end
    local observe = options.observe or ObserveAfter or Observe
    local ok, problem = pcall(function()
        if type(observe) ~= 'function' then error('Observer unavailable') end
        hook.tag = (options.cname or CName.new)(M.TAG)
        hook.byHash = M.hashTable(options.tdbid or TweakDBID.new)
        hook.hasTag = options.hasTag or nativeHasTag
    end)
    if not ok then
        hook.applied, hook.removed, hook.error = 'failed', 'failed', tostring(problem)
        return hook
    end
    local function register(method, work)
        local done, result = pcall(observe, 'PlayerPuppet', method, function(player, event)
            local target = hook.target
            if not target or not target.enabled then return end
            local fine = pcall(work, hook, target, player, event)
            if not fine then target.errors = target.errors + 1 end
            -- Returning nothing from an observer leaves the game's own handling alone.
        end)
        return done and result ~= false and 'registered' or 'failed', not done and tostring(result) or nil
    end
    local problemApplied, problemRemoved
    hook.applied, problemApplied = register('OnStatusEffectApplied', onApplied)
    hook.removed, problemRemoved = register('OnStatusEffectRemoved', onRemoved)
    hook.error = problemApplied or problemRemoved
    return hook
end

-- options.onEvent(event): the end of an episode (init.lua hands it to convaiJohnnyRemarkNote('relic', event)). options.log(line).
-- options.now(): os.time seconds. options.observe, options.cname, options.tdbid, options.hasTag: the natives (ObserveAfter,
-- CName.new, TweakDBID.new, StatusEffectSystem.ObjectHasStatusEffectWithTag), replaced in tests.
function M.new(options)
    options = type(options) == 'table' and options or {}
    local now, log = options.now or os.time, options.log or function() end
    local service = {enabled = true, errors = 0, events = 0, tracker = M.tracker({merge = options.merge})}

    local function emit(event)
        if not event then return end
        service.events, service.last = service.events + 1, event
        log('Johnny speaks up: Relic episode over severity=' .. event.severity .. ' record=' .. event.record
            .. ' seconds=' .. tostring(event.seconds) .. ' applications=' .. tostring(event.applications)
            .. (event.update and ' (stronger, same episode)' or ''))
        if type(options.onEvent) == 'function' then pcall(options.onEvent, event) end
    end

    -- From the callbacks (the flag is already on). Without the removal observer each application ends its episode at once.
    function service:applied(row)
        local at = now()
        self.tracker:applied(row, at)
        if self.degraded then emit(self.tracker:removed(at, false)) end
    end
    function service:removed(remaining) emit(self.tracker:removed(now(), remaining)) end

    -- init.lua switches the flag with the settings; a disabled service forgets a half-seen episode.
    function service:enable() self.enabled = self.hook.applied == 'registered' end
    function service:disable() self.enabled = false; self.tracker:reset() end
    -- A world change (save load) forgets the episode.
    function service:reset() self.tracker:reset() end

    -- A plain report for the developer probe.
    function service:status()
        local episode = self.tracker.episode
        return {enabled = self.enabled == true, applied = self.hook.applied, removed = self.hook.removed, degraded = self.degraded == true,
            error = self.hook.error, errors = self.errors, events = self.events,
            episode = episode and {open = episode.open, severity = episode.row.severity, record = episode.row.record,
                startedAt = episode.startedAt, endedAt = episode.endedAt, applications = episode.applications} or nil,
            last = self.last and {severity = self.last.severity, record = self.last.record, endedAt = self.last.endedAt} or nil}
    end

    local hook = hookState()
    local fresh = hook.applied == nil
    service.hook = install(hook, options)
    if hook.applied ~= 'registered' then
        service.enabled = false
        if fresh then log('Johnny speaks up: the Relic watch could not be registered (' .. tostring(hook.error) .. '); no Relic remarks this session') end
        return service
    end
    service.degraded = hook.removed ~= 'registered'
    if fresh then
        log('Johnny speaks up: Relic watch registered' .. (service.degraded and ' (without the removal; each application ends its episode)' or ''))
    end
    hook.target = service
    return service
end

return M
