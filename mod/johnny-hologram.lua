-- Johnny's hologram (docs/JOHNNY_IN_YOUR_HEAD.md, phase 3): with Johnny in your head on and Settings > Johnny's hologram on, Johnny now
-- and then shows himself for a few seconds as a glitching hologram when V sits down, the way the story shows him beside V.
--
-- The body is always our own copy: a private clone of his record (RECORD, never Character.Silverhand itself), created through the
-- dynamic entity system with our tag TAG only, never saved (persistState and persistSpawn false), with no AI role and without the
-- companion tag (so no speech face and no companion system ever looks at it). It stands two to three metres from V, facing V, and is
-- deleted after VISIBLE seconds, or at once when V stands up, a fight or a scene starts, the game gives a line, or the session ends; a
-- copy left by a reload is swept by tag. Only an entity that carries TAG is ever changed or deleted, so the game's own Johnny never is.
--
-- When (the policy, pure, tested): a sit seen by mod/seated-look.lua (WorkspotEvents.OnEnter: a named seat, or a scene sit at tier 3
-- with no workspot instance, which is how V's own chairs and couches read), not in a vehicle, while the story has Johnny in V's head,
-- after the sit has settled, with no fight, call, conversation or dialogue choice, at scene tier 3 or below, with no game line from
-- anyone (the crowd aside) in the last LINE_QUIET seconds or since the sit, none from the game's Johnny in the last JOHNNY_QUIET seconds,
-- V not talking to anyone, at most once per sit and once every COOLDOWN seconds. Right before he appears, one targeting query looks for
-- the game's own Johnny near V (by his records); if he is there, ours does not come.
--
-- Cost: nothing while either setting is off (init.lua loads this file only with both on). A sit is one table write. From the sit until
-- he is gone (at most ARM_SECONDS, then VISIBLE plus a second) the existing 0.5 s battle sample calls tick: the policy on that sample, at
-- most PLACE_PER_TICK spot candidates (three short raycasts each), one targeting query, one spawn, a few component reads on our copy,
-- one delete. Nothing per frame: his flicker is a handful of visibility events that the game's own delay system plays.
--
-- What only the live test can tell (mod/johnny-hologram-probe.lua, the LOOKS below): which look reads as the game's glitch at standing
-- distance, and whether his phantom controller hides him.
local M = {TAG = 'CyberpunkConvaiJohnnyHologram', RECORD = 'CyberpunkConvai.JohnnyHologram', SOURCE = 'Character.Silverhand',
    JOHNNY_KEY = 'johnny-silverhand'}

M.COOLDOWN = 600          -- at least ten minutes between two appearances
M.ARM_SECONDS = 20        -- a sit that has not let him appear within this is let go
M.SEARCH_AFTER = 2        -- his spot is searched once V has finished sitting down
M.SPAWN_SECONDS = 4       -- the copy must be in the world within this, or it is deleted
M.VISIBLE = 5             -- how long he stays
M.HOLD_MAX = 12           -- the longest options.hold may keep him (a remark of his still playing)
M.SCREEN_SECONDS = 0.6    -- V's screen glitch as he appears (options.screen), stopped on the next tick after this
M.LINE_QUIET = 30         -- no game line from anyone in this long
M.JOHNNY_QUIET = 60       -- and none from the game's Johnny in this long
M.PLACE_PER_TICK = 2
M.GAME_JOHNNY_RADIUS = 30
-- The game's own Johnny bodies (tweaks: primarycharacters.tweak Silverhand and johnny_mirror, q115.tweak q115_suicide_johnny). Our clone
-- has its own record, so it is never among them.
M.GAME_JOHNNY = {'Character.Silverhand', 'Character.johnny_mirror', 'Character.q115_suicide_johnny'}
-- The moments. sit: V sat down (mod/seated-look.lua kinds; 'scene' is a tier 3 scene sit with no workspot instance). restricted: the game
-- holds V still (a NoMovement restriction, sampled; not wired yet): only at tier 1 or 2 and after it has lasted a while.
M.MOMENTS = {
    sit = {maxTier = 3, settle = 4,
        kinds = {couch = true, bar = true, stool = true, bench = true, table = true, chair = true, scene = true}},
    restricted = {maxTier = 2, settle = 10, kinds = {['no-movement'] = true}},
}
-- Where he stands: {degrees round V's facing, metres}, tried in order (V's facing while seated is the seat's).
M.SPOTS = {{30, 2.5}, {-30, 2.5}, {0, 2.6}, {55, 2.3}, {-55, 2.3}, {30, 2.0}, {-30, 2.0}, {0, 3.0}}
M.GROUPS = {'Static', 'Terrain'}
-- The candidate looks; the live test picks one (DEFAULT_LOOK until then).
--   appearance  Johnny's template maps the blendable silverhand_default to the solid silverhand_riot__not_blendable (the phantom
--               component's own mapping, read live: docs/DEVELOPMENT_AUDIT_2026-09-30.md, "Johnny's seated hologram material")
--   phantom     'on': his gamePhantomEntityComponent as spawned (it may hide the whole entity, mod/companion-appearance.lua);
--               'off': switched off and the entity shown, as companions do (the 2 Oct state: blue and speckled when V looks at him)
--   effects     effect events started on him: the VFX of the game's own WorkspotStatus.JohnnySceneWorkspot status effect
--               (tweaks: status_effect/workspot_effects.tweak), which the game starts the same way (gameObject.script
--               StartStatusEffectVFX -> GameObjectEffectHelper.StartEffectEvent); whether his template has them shows only live
--   flicker     FLICKER_IN as he appears and FLICKER_OUT as he goes: the visibility event the phantom system itself uses
--               (enteventsSetVisibility, source PhantomEntitySystem; live in companions.lua and companion-adoption.lua)
M.LOOKS = {
    A = {appearance = 'silverhand_default', phantom = 'on'},
    B = {appearance = 'silverhand_riot__not_blendable', phantom = 'off', effects = {'glitch', 'johnny_intro'}},
    C = {appearance = 'silverhand_default', phantom = 'off'},
    D = {appearance = 'silverhand_default', phantom = 'off', flicker = true},
    E = {appearance = 'silverhand_riot__not_blendable', phantom = 'off', flicker = true},
}
M.DEFAULT_LOOK = 'D'
-- {seconds after the event, visible}. In: flickers in, then one short drop out halfway. Out: flickers out and stays hidden until the
-- delete on the next tick.
M.FLICKER_IN = {{0, false}, {0.08, true}, {0.16, false}, {0.28, true}, {0.34, false}, {0.46, true}, {2.3, false}, {2.36, true}}
M.FLICKER_OUT = {{0, false}, {0.07, true}, {0.17, false}, {0.23, true}, {0.33, false}}
-- The fast-forward glitch the game plays on V (player.script SceneFastForward, scenesFastForward.script StartGlitchFx).
M.SCREEN_EFFECT = 'transition_glitch_loop'

local atan2 = math.atan2 or math.atan

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The policy (pure).

-- The newest game lines (mod/game-dialogue.lua rows {at = os.time seconds, profileKey, channel}, newest last): seconds since the last
-- line anyone but the crowd spoke, seconds since the last line of the game's Johnny (any channel), and whether a line other than the
-- crowd's came at or after `since`. Pure.
function M.lineAges(rows, wall, since)
    if type(rows) ~= 'table' or type(wall) ~= 'number' then return nil, nil, false end
    local any, johnny, after = nil, nil, false
    for index = #rows, math.max(1, #rows - 39), -1 do
        local row = rows[index]
        if type(row) == 'table' and type(row.at) == 'number' then
            local age = wall - row.at
            if age > M.JOHNNY_QUIET then break end
            if johnny == nil and row.profileKey == M.JOHNNY_KEY then johnny = age end
            if row.channel ~= 'ambient' then
                if any == nil then any = age end
                if type(since) == 'number' and row.at >= since then after = true end
            end
        end
    end
    return any, johnny, after
end

-- May he appear now for this moment? nil, or why not and whether that ends the moment (true) or only waits (false). Pure.
--   moment   {event = 'sit'|'restricted', kind, at = clock seconds, wall = os.time at the event, vehicle}
--   sample   the battle observer's player-side sample (mod/battle-observer.lua)
--   context  {enabled, story ('active' while he is in V's head, mod/johnny-head.lua story), now (clock), wall (os.time), lastShown
--            (clock of the last appearance), lines (game-dialogue rows), talking (V talks to someone, records, or a reply plays)}
function M.decide(moment, sample, context)
    context = type(context) == 'table' and context or {}
    if context.enabled ~= true then return 'off', true end
    if context.story ~= 'active' then return 'story-' .. tostring(context.story or 'unknown'), true end
    local rule = type(moment) == 'table' and M.MOMENTS[moment.event] or nil
    if not rule or not rule.kinds[moment.kind] or type(moment.at) ~= 'number' then return 'kind', true end
    local now = context.now
    if type(now) ~= 'number' then return 'unreadable', false end
    if type(context.lastShown) == 'number' and now >= context.lastShown and now - context.lastShown < M.COOLDOWN then
        return 'cooldown', true
    end
    if now - moment.at > M.ARM_SECONDS then return 'expired', true end
    if moment.vehicle == true then return 'vehicle', true end
    if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable', false end
    if sample.replacer == true then return 'replacer', true end
    if sample.combat == true then return 'combat', true end
    if sample.dialogue == true or sample.choices == true then return 'dialogue', true end
    if sample.vehicle == true then return 'vehicle', true end
    if sample.call == true then return 'call', false end
    local tier = tonumber(sample.tier)
    if tier == nil then return 'unreadable', false end
    if tier > rule.maxTier then return 'scene', true end
    local any, johnny, after = M.lineAges(context.lines, context.wall, moment.wall)
    -- A line after the sit means the sit belongs to a scene: the game may stage its own Johnny there.
    if after then return 'scene-lines', true end
    if johnny ~= nil then return 'johnny-line', true end
    if any ~= nil and any <= M.LINE_QUIET then return 'line', false end
    if context.talking == true then return 'talking', false end
    if now - moment.at < rule.settle then return 'settling', false end
    return nil
end

-- Why a hologram that is there must go now, from the 0.5 s sample, or nil. Pure.
function M.interrupt(sample, maxTier)
    if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable' end
    if sample.combat == true then return 'combat' end
    if sample.replacer == true then return 'replacer' end
    if sample.dialogue == true or sample.choices == true or sample.call == true then return 'scene' end
    if sample.vehicle == true then return 'vehicle' end
    local tier = tonumber(sample.tier)
    if tier == nil or tier > (maxTier or 3) then return 'scene' end
    return nil
end

-- The spots round V, in M.SPOTS order (or `spots`): rows {x, y, z, angle, distance}. forward: V's facing {x, y}; the game's forward at yaw
-- t is (-sin t, cos t), and a positive angle turns to V's left. Pure.
function M.candidates(origin, forward, spots)
    local fx, fy = tonumber(forward and forward.x) or 0, tonumber(forward and forward.y) or 0
    local length = math.sqrt(fx * fx + fy * fy)
    if length < 0.01 then fx, fy, length = 0, 1, 1 end
    fx, fy = fx / length, fy / length
    local list = {}
    for _, row in ipairs(spots or M.SPOTS) do
        local a = math.rad(row[1])
        local dx, dy = fx * math.cos(a) - fy * math.sin(a), fx * math.sin(a) + fy * math.cos(a)
        list[#list + 1] = {x = origin.x + dx * row[2], y = origin.y + dy * row[2], z = origin.z, angle = row[1], distance = row[2]}
    end
    return list
end

-- The yaw (degrees) that makes a body at `from` face `to`. Pure.
function M.faceYaw(from, to)
    return math.deg(atan2(-(to.x - from.x), to.y - from.y))
end

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The game side. Each function is replaced by a fake in the tests; every one is called inside pcall by the service.

local N = {}
M.native = N

local function system()
    local dynamic = Game.GetDynamicEntitySystem()
    if not dynamic or not dynamic:IsReady() then error('entity system not ready') end
    return dynamic
end

-- Ours: managed by the dynamic entity system and carrying TAG. Nothing else is ever changed or deleted.
local function owned(dynamic, id)
    return id ~= nil and dynamic:IsManaged(id) == true and dynamic:IsTagged(id, CName.new(M.TAG)) == true
end

-- The nearest solid point between a and b over M.GROUPS: the point, false when clear, nil when the game could not answer.
local function trace(a, b)
    local spatial = Game.GetSpatialQueriesSystem()
    local from, to = Vector4.new(a.x, a.y, a.z, 1), Vector4.new(b.x, b.y, b.z, 1)
    local best, bestDistance = false, math.huge
    for _, group in ipairs(M.GROUPS) do
        local hit, out = spatial:SyncRaycastByCollisionGroup(from, to, CName.new(group), false, false)
        if type(hit) ~= 'boolean' then return nil end
        if hit then
            local p = out and out.position
            local point = p and {x = tonumber(p.x), y = tonumber(p.y), z = tonumber(p.z)} or nil
            if not point or not point.x or not point.y or not point.z then return nil end
            local distance = (point.x - a.x)^2 + (point.y - a.y)^2 + (point.z - a.z)^2
            if distance < bestDistance then best, bestDistance = point, distance end
        end
    end
    return best
end

-- V's feet and facing.
function N.position(player)
    local p, f = player:GetWorldPosition(), player:GetWorldForward()
    return {x = p.x, y = p.y, z = p.z}, {x = f.x, y = f.y}
end

-- Can he stand at this candidate: a floor level with V's, headroom, and V's eyes see his chest? The spot {x, y, z, yaw facing V}, or
-- nil and why not. Three traces, two groups each.
function N.spot(origin, candidate)
    local x, y = candidate.x, candidate.y
    local floor = trace({x = x, y = y, z = origin.z + 1.0}, {x = x, y = y, z = origin.z - 1.2})
    if floor == nil then return nil, 'no-answer' end
    if not floor then return nil, 'no-floor' end
    -- A hit right where the ray starts is the inside of something (a table, a wall), not a floor.
    if floor.z > origin.z + 0.9 then return nil, 'inside' end
    if math.abs(floor.z - origin.z) > 0.6 then return nil, 'not-level' end
    local head = trace({x = x, y = y, z = floor.z + 0.3}, {x = x, y = y, z = floor.z + 1.9})
    if head ~= false then return nil, head == nil and 'no-answer' or 'no-headroom' end
    local sight = trace({x = origin.x, y = origin.y, z = origin.z + 1.15}, {x = x, y = y, z = floor.z + 1.3})
    if sight ~= false then return nil, sight == nil and 'no-answer' or 'hidden' end
    return {x = x, y = y, z = floor.z, yaw = M.faceYaw({x = x, y = y}, origin)}
end

-- Is one of the game's own Johnny bodies within radius of V? One targeting query (the one mod/spawned-characters.lua scan makes). It
-- reports what V's camera can see, which is where ours would stand. Read only.
function N.gameJohnnyNear(player, radius)
    local query = TargetSearchQuery.new()
    query.searchFilter = Game['TSF_NPC;']()
    query.maxDistance = radius
    query.includeSecondaryTargets = false
    query.filterObjectByDistance = true
    query.ignoreInstigator = true
    query.testedSet = Enum.new('TargetingSet', 'Complete')
    local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
    local records = {}
    for index, name in ipairs(M.GAME_JOHNNY) do records[index] = TweakDBID.new(name) end
    for _, part in ipairs(parts or {}) do
        local component = TS_TargetPartInfo.GetComponent(part)
        local entity = component and component:GetEntity()
        if entity and entity:IsNPC() then
            local record = entity:GetRecordID()
            for _, id in ipairs(records) do if record == id then return true end end
        end
    end
    return false
end

-- Our record: a plain clone of his (template, appearances, voice), made once. No flat is changed, so it carries no weapon and no
-- combat set (mod/companion-records.lua arms the companion copy; a hologram needs none of that). A name that does not resolve to a
-- character record would spawn a body with no record, which crashes a few seconds later (mod/holocall.lua): it is checked first.
local prepared = nil
function N.record()
    if prepared then return prepared end
    if not TweakDB:GetRecord(M.RECORD) and not TweakDB:CloneRecord(M.RECORD, M.SOURCE) then error('clone failed') end
    local record = TweakDB:GetRecord(M.RECORD)
    if not record or not record:IsA('gamedataCharacter_Record') then error('not a character record') end
    prepared = M.RECORD
    return prepared
end

-- Create our copy: row {record, appearance, x, y, z, yaw}. Only our own record, only our tag, never saved. The entity ID.
function N.spawn(row)
    if row.record ~= M.RECORD then error('not our record') end
    local dynamic = system()
    local spec = NewObject('DynamicEntitySpec')
    spec.recordID = TweakDBID.new(row.record)
    spec.appearanceName = CName.new(row.appearance)
    spec.position = Vector4.new(row.x, row.y, row.z, 1)
    spec.orientation = EulerAngles.new(0, 0, row.yaw):ToQuat()
    spec.persistState, spec.persistSpawn = false, false
    spec.alwaysSpawned, spec.spawnInView, spec.active = true, true, true
    spec.tags = {CName.new(M.TAG)}
    local id = dynamic:CreateEntity(spec)
    if not id or tostring(id.hash):match('^0+[uUlL]*$') then error('copy was not created') end
    return id
end

-- The copy once it is in the world (spawned and attached), or nil. The handle is used at once and never kept.
function N.entity(id)
    local dynamic = system()
    if not owned(dynamic, id) or not dynamic:IsSpawned(id) then return nil end
    local npc = Game.FindEntityByID(id)
    if npc and npc:IsAttached() then return npc end
    return nil
end

function N.hash(npc) return tostring(npc:GetEntityID().hash) end

local function visibility(npc, visible, delay)
    local event = NewObject('enteventsSetVisibility')
    event.visible = visible == true
    event.source = Enum.new('entVisibilityParamSource', 'PhantomEntitySystem')
    if delay and delay > 0 then Game.GetDelaySystem():DelayEvent(npc, event, delay, false) else npc:QueueEvent(event) end
end

-- Play a flicker schedule on our copy (the delay system holds the entity weakly: a copy deleted early drops the rest). The count queued.
function N.flicker(npc, id, schedule)
    if not owned(system(), id) then return 0 end
    local count = 0
    for _, step in ipairs(schedule) do
        visibility(npc, step[2], step[1])
        count = count + 1
    end
    return count
end

-- Give our copy one of M.LOOKS: its phantom controller off and the entity shown (phantom 'off'), its effect events, its flicker in.
-- A plain report {phantom, effects, flicker}.
function N.look(npc, id, look)
    local dynamic = system()
    if not owned(dynamic, id) then error('not ours') end
    local report = {phantom = 0, effects = 0, flicker = 0}
    if look.phantom == 'off' then
        for _, component in ipairs(npc:GetComponents() or {}) do
            if component:IsA('gamePhantomEntityComponent') then component:Toggle(false); report.phantom = report.phantom + 1 end
        end
        if report.phantom > 0 and not look.flicker then visibility(npc, true, 0) end
    end
    for _, name in ipairs(look.effects or {}) do
        if pcall(function() GameObjectEffectHelper.StartEffectEvent(npc, CName.new(name), false) end) then
            report.effects = report.effects + 1
        end
    end
    if look.flicker then report.flicker = N.flicker(npc, id, M.FLICKER_IN) end
    return report
end

-- Delete our copy; anything that is not managed and tagged as ours is left alone. True when the delete was asked.
function N.delete(id)
    local dynamic = system()
    if not owned(dynamic, id) then return false end
    return dynamic:DeleteEntity(id) == true
end

-- Delete every copy of ours (left by a reload or a crash). The number asked.
function N.sweep()
    local dynamic = system()
    local count = 0
    for _, id in ipairs(dynamic:GetTaggedIDs(CName.new(M.TAG)) or {}) do
        if owned(dynamic, id) then dynamic:DeleteEntity(id); count = count + 1 end
    end
    return count
end

-- V's screen glitch on (as he appears) or off.
function N.screen(on)
    local player = Game.GetPlayer()
    if on then GameObjectEffectHelper.StartEffectEvent(player, CName.new(M.SCREEN_EFFECT), false)
    else GameObjectEffectHelper.StopEffectEvent(player, CName.new(M.SCREEN_EFFECT)) end
    return true
end

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The service.

-- options.enabled(): both settings on. options.story(): the story state ('active' while he is in V's head). options.lines(): the
-- game-dialogue rows. options.clock(): os.clock seconds (the timers). options.now(): os.time seconds (the rows' clock). options.log(line).
-- options.look: one of M.LOOKS (M.DEFAULT_LOOK). options.screen: V's screen glitch as he appears (off). options.hold(): true while he
-- should stay a little longer (a remark of his playing), up to HOLD_MAX. options.native: replaces M.native (tests).
function M.new(options)
    options = type(options) == 'table' and options or {}
    local native = options.native or N
    local clock, now = options.clock or os.clock, options.now or os.time
    local service = {look = M.LOOKS[options.look] and options.look or M.DEFAULT_LOOK, serial = 0, sweepDue = true}

    local function read(fn)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn)
        return ok and value or nil
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Johnny hologram: ' .. line) end end
    local function call(name, ...)
        local ok, a, b = pcall(native[name], ...)
        if not ok then return nil, tostring(a) end
        return a, b
    end

    local function drop(reason)
        local pending = service.pending
        service.pending = nil
        if pending then log('skipped ' .. pending.event .. ' kind=' .. tostring(pending.kind) .. ' reason=' .. reason) end
        return false
    end

    -- A few spot candidates per tick, so the raycasts are spread over the sit's first seconds.
    local function search(player)
        local pending = service.pending
        if pending.spot or pending.exhausted then return end
        if not pending.candidates then
            local origin, forward = call('position', player)
            if type(origin) ~= 'table' then pending.exhausted, pending.why = true, 'no-position'; return end
            pending.origin, pending.candidates, pending.next = origin, M.candidates(origin, forward), 1
        end
        for _ = 1, M.PLACE_PER_TICK do
            local candidate = pending.candidates[pending.next]
            if not candidate then pending.exhausted = true; return end
            pending.next = pending.next + 1
            local spot, why = call('spot', pending.origin, candidate)
            if type(spot) == 'table' then
                spot.angle, spot.distance = candidate.angle, candidate.distance
                pending.spot = spot
                return
            end
            pending.why = why or 'no-spot'
        end
    end

    local function appear(pending, at)
        service.pending = nil
        -- The cooldown starts with the attempt, so a spawn that fails is not tried again on every sit.
        service.lastShown = at
        local look = M.LOOKS[service.look]
        local record, problem = call('record')
        if type(record) ~= 'string' then log('skipped reason=record (' .. tostring(problem) .. ')'); return false end
        local spot = pending.spot
        local id, why = call('spawn', {record = record, appearance = look.appearance, x = spot.x, y = spot.y, z = spot.z, yaw = spot.yaw})
        if id == nil then log('skipped reason=spawn (' .. tostring(why) .. ')'); return false end
        service.serial = service.serial + 1
        service.visit = {id = id, serial = service.serial, state = 'spawning', at = at, wall = now(), look = service.look,
            event = pending.event, kind = pending.kind, maxTier = M.MOMENTS[pending.event].maxTier, spot = spot}
        log(string.format('spawning look=%s %s kind=%s at=%.1fm angle=%d', service.look, pending.event, tostring(pending.kind),
            spot.distance or 0, spot.angle or 0))
        return true
    end

    -- A moment began (event 'sit' with the seat kind and seat {tier, vehicle, path}, or 'restricted'). One table write; ignored while he
    -- is already there.
    function service:moment(event, kind, seat)
        if self.visit or not M.MOMENTS[event] then return false end
        local vehicle = type(seat) == 'table' and tonumber(seat.vehicle) ~= nil and tonumber(seat.vehicle) ~= 0
        self.pending = {event = event, kind = kind, at = clock(), wall = now(), vehicle = vehicle == true}
        return true
    end

    -- V stood up (or the restriction ended): the moment is over, and he goes at once.
    function service:stand()
        self.pending = nil
        if self.visit then return self:finish('stood') end
        return false
    end

    -- Does the 0.5 s sample need to call tick (a moment waiting, or he is there)?
    function service:active() return self.pending ~= nil or self.visit ~= nil end
    function service:visible() return self.visit ~= nil and self.visit.state == 'visible' end
    -- Is this entity (its hash) our hologram (so the talk target can pass over it)?
    function service:owns(entity) return self.visit ~= nil and self.visit.entity ~= nil and self.visit.entity == entity end

    -- He goes now: the delete (only ours), V's screen glitch off. reason for the log.
    function service:finish(reason)
        local visit = self.visit
        if not visit then return false end
        self.visit = nil
        if visit.screenAt then call('screen', false) end
        local deleted = call('delete', visit.id)
        log(string.format('gone reason=%s shown=%.1fs deleted=%s', reason, visit.shownAt and clock() - visit.shownAt or 0, tostring(deleted == true)))
        return true
    end

    -- While he is there: what ends him, his arrival, his time, his flicker out.
    local function step(sample)
        local visit, at = service.visit, clock()
        local why = read(options.enabled) ~= true and 'off' or M.interrupt(sample, visit.maxTier)
        if not why then
            local _, johnny, after = M.lineAges(read(options.lines), now(), visit.wall)
            if after then why = 'line' elseif johnny ~= nil and johnny <= now() - visit.wall then why = 'johnny-line' end
        end
        if why then return service:finish(why) end
        if visit.state == 'spawning' then
            local npc = call('entity', visit.id)
            if npc == nil then
                if at - visit.at > M.SPAWN_SECONDS then return service:finish('not-attached') end
                return true
            end
            local report, problem = call('look', npc, visit.id, M.LOOKS[visit.look])
            visit.entity = call('hash', npc)
            visit.state, visit.shownAt = 'visible', at
            if options.screen == true and call('screen', true) then visit.screenAt = at end
            log('shown look=' .. visit.look .. ' phantom=' .. tostring(report and report.phantom) .. ' effects='
                .. tostring(report and report.effects) .. ' flicker=' .. tostring(report and report.flicker)
                .. (problem and (' problem=' .. problem) or ''))
            return true
        end
        if visit.screenAt and at - visit.screenAt >= M.SCREEN_SECONDS then call('screen', false); visit.screenAt = nil end
        if visit.state == 'visible' then
            local held = read(options.hold) == true and at - visit.shownAt < M.HOLD_MAX
            if at - visit.shownAt >= M.VISIBLE and not held then
                local look = M.LOOKS[visit.look]
                if not look.flicker then return service:finish('done') end
                local npc = call('entity', visit.id)
                if npc then call('flicker', npc, visit.id, M.FLICKER_OUT) end
                visit.state = 'leaving'
            end
            return true
        end
        return service:finish('done')
    end

    -- From the existing 0.5 s battle sample, only while active(). sample: that sample; talking: V talks to someone, records, or a reply
    -- plays. True while it still needs the sample.
    function service:tick(player, sample, worldReady, talking)
        if self.visit then return step(sample) end
        local pending = self.pending
        if not pending then return false end
        if not worldReady then return true end
        local at = clock()
        local reason, final = M.decide(pending, sample, {enabled = read(options.enabled) == true, story = read(options.story),
            now = at, wall = now(), lastShown = self.lastShown, lines = read(options.lines), talking = talking == true})
        if final then return drop(reason) end
        if at - pending.at >= M.SEARCH_AFTER then search(player) end
        if reason then return true end
        if not pending.spot then
            if pending.exhausted then return drop('no-spot (' .. tostring(pending.why) .. ')') end
            return true
        end
        -- The game's own Johnny near V: ours does not come. An unanswered query counts as yes.
        local near = call('gameJohnnyNear', player, M.GAME_JOHNNY_RADIUS)
        if near ~= false then return drop(near == true and 'game-johnny' or 'game-johnny-unreadable') end
        return appear(pending, at)
    end

    -- Copies left by a reload or a crash, deleted by tag (once per session, from init.lua's start-up check). The number asked.
    function service:sweep()
        self.sweepDue = false
        if self.visit then return 0 end
        local count = call('sweep')
        if type(count) == 'number' and count > 0 then log('swept ' .. count .. ' copy(s) left from before') end
        return type(count) == 'number' and count or 0
    end

    -- The world went away (a load, a death, a detach): forget everything without a native call. A copy of ours that is still standing
    -- is gone with the world (it is never saved), or swept at the next start-up.
    function service:abandon(reason)
        if self.visit then log('gone reason=' .. tostring(reason or 'abandoned') .. ' (world released)') end
        self.pending, self.visit, self.sweepDue = nil, nil, true
    end

    -- A plain report for the probe and the log.
    function service:status()
        local at = clock()
        local pending, visit = self.pending, self.visit
        return {look = self.look, sweepDue = self.sweepDue,
            cooldownLeft = self.lastShown and math.max(0, M.COOLDOWN - (at - self.lastShown)) or 0,
            pending = pending and {event = pending.event, kind = pending.kind, age = at - pending.at, spot = pending.spot ~= nil} or nil,
            visit = visit and {state = visit.state, age = at - visit.at, look = visit.look, distance = visit.spot.distance,
                angle = visit.spot.angle, entity = visit.entity} or nil}
    end

    return service
end

return M
