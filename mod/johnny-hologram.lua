-- Johnny's hologram (docs/JOHNNY_IN_YOUR_HEAD.md, phase 3): with Johnny in your head on and Settings > Johnny's hologram on, Johnny
-- shows himself as a glitching hologram when V sits down, the way the story shows him beside V, and stays, silent, flickering now and
-- then, for as long as V sits plainly (he glitches out when V stands up).
--
-- The body is always our own copy: a private clone of his record (RECORD, never Character.Silverhand itself), created through the
-- dynamic entity system with our tag TAG only, never saved (persistState and persistSpawn false), with no AI role and without the
-- companion tag (so no speech face and no companion system ever looks at it). It stands two to three metres from V, facing V, and is
-- deleted when V stands up (after a short glitch out), a fight, a call or a scene starts, the game gives a line, the setting goes off,
-- or the session ends; a copy left by a reload is swept by tag. Only an entity that carries TAG is ever changed or deleted, so the
-- game's own Johnny never is. The hologram look is the game's own effects for Johnny (M.FX, see M.LOOKS): a plain copy of him is a
-- plain model, and the 2026-10-19 live test, which started none, showed exactly that.
--
-- When (the policy, pure, tested): a sit seen by mod/seated-look.lua (WorkspotEvents.OnEnter: a named seat, or a scene sit at tier 3
-- with no workspot instance, which is how V's own chairs and couches read), not in a vehicle, while the story has Johnny in V's head,
-- after the sit has settled, with no fight, call, conversation or dialogue choice, at scene tier 3 or below, with no game line from
-- anyone (the crowd aside) in the last LINE_QUIET seconds or since the sit, none from the game's Johnny in the last JOHNNY_QUIET seconds,
-- V not talking to anyone, at most once per sit and once every COOLDOWN seconds. Right before he appears, one targeting query looks for
-- the game's own Johnny near V (by his records); if he is there, ours does not come.
-- A plain sit looks like a scene: V's chairs and couches are scene sits at tier 3, and the first live test (2026-10-19) skipped both sits as
-- "dialogue" (the dialogue or the choice flag was up). While the sample says V sits in an ordinary seat (sample.sitting, from
-- mod/seated-look.lua M.plain: no call, fight, replacer or vehicle, tier 3 or below, no game line since V sat), those two flags are the sit's
-- own and do not count; the lines, the tier, a call, a fight and the rest still do. Every skip, spawn and departure logs the flags it saw.
--
-- Cost: nothing while either setting is off (init.lua loads this file only with both on). A sit is one table write. From the sit until
-- he is gone the existing 0.5 s battle sample calls tick: the policy on that sample, at most PLACE_PER_TICK spot candidates (three short
-- raycasts each), one targeting query, one spawn, a few component reads on our copy, one delete; while he stays, a clock comparison per
-- sample and, every BURST_MIN to BURST_MAX seconds, one burst (a few visibility events and one effect start and stop). Nothing per
-- frame: his flicker is a handful of visibility events that the game's own delay system plays.
--
-- What only the live test can tell (mod/johnny-hologram-probe.lua, the LOOKS below): which look reads as the game's glitch at standing
-- distance, and whether his phantom controller hides him.
local M = {TAG = 'CyberpunkConvaiJohnnyHologram', RECORD = 'CyberpunkConvai.JohnnyHologram', SOURCE = 'Character.Silverhand',
    JOHNNY_KEY = 'johnny-silverhand'}

M.COOLDOWN = 600          -- at least ten minutes between his leaving and the next appearance
M.ARM_SECONDS = 20        -- a sit that has not let him appear within this is let go
M.SEARCH_AFTER = 2        -- his spot is searched once V has finished sitting down
M.SPAWN_SECONDS = 4       -- the copy must be in the world within this, or it is deleted
-- He stays as long as V sits plainly (2026-10-20: "he can stay, no need to keep popping"): there is no timer. He goes when V stands up
-- (a short glitch out first), when a fight, a call or a scene starts, when the game gives a line, when the setting goes off, or when the
-- seat hook stopped saying V sits (options.seated false on NOT_SEATED_TICKS samples in a row).
M.NOT_SEATED_TICKS = 2
M.GLITCH_SECONDS = 8      -- the game's glitch loop (look.effects) plays this long as he appears, then he is quiet
M.BURST_MIN = 15          -- then now and then (BURST_MIN to BURST_MAX seconds apart, drawn each time) a short flicker and glitch
M.BURST_MAX = 35
M.BURST_SECONDS = 1.4     -- the burst's own glitch effect is stopped after this
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
--   effects     effect events started on him as he appears. These are Johnny's OWN effects, named in his entity template
--               (base\characters\entities\main_npc\silverhand.ent, effect spawner "effectDescs", read from the game's archive 2026-10-20)
--               and used by his gamePhantomEntityComponent, whose parameters name them: spawnEffect johnny_spawn_normal,
--               glitchEffect johnny_glitch_idle_01, teleportStartEffect johnny_teleport_start, teleportEndEffect johnny_teleport_end.
--               Their particles use the game's own shaders base\fx\shaders\screen_glitch.mt and johnny_glitch.mt (a pixel-sorting
--               glitch round his body, with the game's glitch sound events), which is the look he has when the story shows him. The
--               phantom controller starts them itself only while he is in the RootMotion or Workspot state; our copy stands idle with
--               the controller off, so nothing played them (the 2026-10-19 live test: look D had no effects and read as a plain model).
--               Started with GameObjectEffectHelper.StartEffectEvent, stopped with StopEffectEvent (the loops run until stopped).
--   burst       the short silent glitch (no sound events) played with each flicker burst while he stays
--   leave       played as he goes (the teleport-out), with FLICKER_OUT
--   flicker     FLICKER_IN as he appears, a FLICKER_BURST now and then, FLICKER_OUT as he goes: the visibility event the phantom
--               system itself uses (enteventsSetVisibility, source PhantomEntitySystem; live in companions.lua and companion-adoption.lua)
M.FX = {spawn = 'johnny_spawn_normal', glitch = 'johnny_glitch_idle_01', burst = 'johnny_glitch_idle_03', leave = 'johnny_teleport_start'}
M.LOOKS = {
    A = {appearance = 'silverhand_default', phantom = 'on'},
    -- B had the names 'glitch' and 'johnny_intro', which his template does not have (the call succeeds and nothing plays).
    B = {appearance = 'silverhand_riot__not_blendable', phantom = 'off', effects = {M.FX.spawn, M.FX.glitch}},
    C = {appearance = 'silverhand_default', phantom = 'off'},
    D = {appearance = 'silverhand_default', phantom = 'off', flicker = true},
    E = {appearance = 'silverhand_riot__not_blendable', phantom = 'off', flicker = true},
    F = {appearance = 'silverhand_default', phantom = 'off', flicker = true, effects = {M.FX.spawn, M.FX.glitch}, burst = M.FX.burst,
        leave = M.FX.leave},
}
M.DEFAULT_LOOK = 'F'
-- {seconds after the event, visible}. In: flickers in, then one short drop out halfway. Out: flickers out and stays hidden until the
-- delete on the next tick.
M.FLICKER_IN = {{0, false}, {0.08, true}, {0.16, false}, {0.28, true}, {0.34, false}, {0.46, true}, {2.3, false}, {2.36, true}}
M.FLICKER_OUT = {{0, false}, {0.07, true}, {0.17, false}, {0.23, true}, {0.33, false}}
-- A short glitch while he stays: drops out twice and is back (he stays visible after it).
M.FLICKER_BURST = {{0, false}, {0.06, true}, {0.14, false}, {0.2, true}, {0.3, false}, {0.36, true}}
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
    if (sample.dialogue == true or sample.choices == true) and sample.sitting ~= true then return 'dialogue', true end
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
    if ((sample.dialogue == true or sample.choices == true) and sample.sitting ~= true) or sample.call == true then return 'scene' end
    if sample.vehicle == true then return 'vehicle' end
    local tier = tonumber(sample.tier)
    if tier == nil or tier > (maxTier or 3) then return 'scene' end
    return nil
end

-- The sample's scene facts for a log line (what the next live check reads to see why he came, stayed or went): ' (dialogue=.. choices=.. ...)',
-- or '' without a sample. Pure.
function M.flags(sample)
    if type(sample) ~= 'table' then return '' end
    return string.format(' (dialogue=%s choices=%s tier=%s call=%s combat=%s sitting=%s)', tostring(sample.dialogue), tostring(sample.choices),
        tostring(sample.tier), tostring(sample.call), tostring(sample.combat), tostring(sample.sitting == true))
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

-- The effect names his template defines (entEffectSpawnerComponent.effectDescs[].effectName), as a set, or nil when the game would not
-- show them. Read only, once per copy: a name that is not in it would be started without an error and never play.
local function templateEffects(npc)
    local ok, names = pcall(function()
        local set, count = {}, 0
        for _, component in ipairs(npc:GetComponents() or {}) do
            if component:IsA('entEffectSpawnerComponent') then
                for _, desc in ipairs(component.effectDescs or {}) do
                    local name = Game.NameToString(desc.effectName)
                    if type(name) == 'string' and name ~= '' then set[name] = true; count = count + 1 end
                end
            end
        end
        return count > 0 and set or nil
    end)
    return ok and names or nil
end

-- Start or stop one named effect on our copy. true, or false and why. The helpers the game's own scripts use first (StartEffectEvent; a
-- loop is ended with BreakEffectLoopEvent, which lets it play its tail, and StopEffectEvent is the harder stop when that errors); when
-- they error, the event they queue (entSpawnEffectEvent; entBreakEffectLoopEvent ends a loop).
local function effect(npc, name, start)
    local cname = CName.new(name)
    local ok, problem = pcall(function()
        if start then GameObjectEffectHelper.StartEffectEvent(npc, cname, false)
        elseif pcall(GameObjectEffectHelper.BreakEffectLoopEvent, npc, cname) then return
        else GameObjectEffectHelper.StopEffectEvent(npc, cname) end
    end)
    if ok then return true end
    local event = pcall(function()
        local ev = NewObject(start and 'entSpawnEffectEvent' or 'entBreakEffectLoopEvent')
        ev.effectName = cname
        npc:QueueEvent(ev)
    end)
    if event then return true end
    return false, tostring(problem)
end

-- Start or stop effects by name on our copy (nothing else is ever touched). A plain report {ok = {names}, failed = {"name (why)"}}.
function N.effects(npc, id, names, start)
    if not owned(system(), id) then error('not ours') end
    local report = {ok = {}, failed = {}}
    for _, name in ipairs(names) do
        local done, why = effect(npc, name, start)
        if done then report.ok[#report.ok + 1] = name
        else report.failed[#report.failed + 1] = name .. ' (' .. tostring(why):sub(1, 80) .. ')' end
    end
    return report
end

-- A flicker burst while he stays: the visibility drops and the short silent glitch (look.burst). A plain report like N.effects, plus the
-- flickers queued.
function N.burst(npc, id, look)
    local report = N.effects(npc, id, look.burst and {look.burst} or {}, true)
    report.flicker = N.flicker(npc, id, M.FLICKER_BURST)
    return report
end

-- He goes: the flicker out and look.leave (the teleport-out). The same report.
function N.leave(npc, id, look)
    local report = N.effects(npc, id, look.leave and {look.leave} or {}, true)
    report.flicker = N.flicker(npc, id, M.FLICKER_OUT)
    return report
end

-- Give our copy one of M.LOOKS: its phantom controller off and the entity shown (phantom 'off'), its effect events, its flicker in.
-- A plain report {phantom, effects (how many started), flicker, applied = {names}, failed = {"name (why)"}, known = {name = true|false}
-- (against his template's effect list, absent when that could not be read)}.
function N.look(npc, id, look)
    local dynamic = system()
    if not owned(dynamic, id) then error('not ours') end
    local report = {phantom = 0, effects = 0, flicker = 0, applied = {}, failed = {}}
    if look.phantom == 'off' then
        for _, component in ipairs(npc:GetComponents() or {}) do
            if component:IsA('gamePhantomEntityComponent') then component:Toggle(false); report.phantom = report.phantom + 1 end
        end
        if report.phantom > 0 and not look.flicker then visibility(npc, true, 0) end
    end
    if look.effects and #look.effects > 0 then
        local template = templateEffects(npc)
        if template then
            report.known = {}
            for _, name in ipairs(look.effects) do report.known[name] = template[name] == true end
        end
        local started = N.effects(npc, id, look.effects, true)
        report.applied, report.failed, report.effects = started.ok, started.failed, #started.ok
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
-- options.look: one of M.LOOKS (M.DEFAULT_LOOK). options.screen: V's screen glitch as he appears (off). options.seated(): whether the
-- seat hook still says V sits (a stay needs it; absent counts as yes). options.random(): a number in [0, 1) for the burst spacing
-- (math.random). options.native: replaces M.native (tests).
function M.new(options)
    options = type(options) == 'table' and options or {}
    local native = options.native or N
    local clock, now = options.clock or os.clock, options.now or os.time
    local random = options.random or math.random
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

    local function drop(reason, sample)
        local pending = service.pending
        service.pending = nil
        if pending then log('skipped ' .. pending.event .. ' kind=' .. tostring(pending.kind) .. ' reason=' .. reason .. M.flags(sample)) end
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

    local function appear(pending, at, sample)
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
        log(string.format('spawning look=%s %s kind=%s at=%.1fm angle=%d%s', service.look, pending.event, tostring(pending.kind),
            spot.distance or 0, spot.angle or 0, M.flags(sample)))
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

    -- V stood up (or the restriction ended): the moment is over. He glitches out (a flicker and the teleport-out of his look), which the
    -- next sample ends with the delete; a look without that, or a copy still arriving, goes at once.
    function service:stand()
        self.pending = nil
        local visit = self.visit
        if not visit then return false end
        if visit.state == 'visible' and M.LOOKS[visit.look].flicker then return service:leave('stood') end
        return self:finish('stood')
    end

    -- He starts going: the flicker out and the teleport-out play and the next sample deletes him. reason for the log.
    function service:leave(reason)
        local visit = self.visit
        if not visit or visit.state ~= 'visible' then return false end
        local npc = call('entity', visit.id)
        if npc then
            local report, problem = call('leave', npc, visit.id, M.LOOKS[visit.look])
            if type(report) ~= 'table' then log('leave effects problem=' .. tostring(problem))
            elseif #report.failed > 0 then log('leave effects failed: ' .. table.concat(report.failed, ', ')) end
        end
        visit.state, visit.leaveReason = 'leaving', reason
        return true
    end

    -- Does the 0.5 s sample need to call tick (a moment waiting, or he is there)?
    function service:active() return self.pending ~= nil or self.visit ~= nil end
    function service:visible() return self.visit ~= nil and self.visit.state == 'visible' end
    -- Is this entity (its hash) our hologram (so the talk target can pass over it)?
    function service:owns(entity) return self.visit ~= nil and self.visit.entity ~= nil and self.visit.entity == entity end

    -- He goes now: the delete (only ours), V's screen glitch off. reason for the log.
    function service:finish(reason, sample)
        local visit = self.visit
        if not visit then return false end
        self.visit = nil
        -- The cooldown runs from his leaving too, so a long stay is not followed at once by another on the next micro re-sit.
        self.lastShown = clock()
        if visit.screenAt then call('screen', false) end
        local deleted = call('delete', visit.id)
        log(string.format('gone reason=%s shown=%.1fs deleted=%s%s', reason, visit.shownAt and clock() - visit.shownAt or 0, tostring(deleted == true),
            M.flags(sample)))
        return true
    end

    -- The effects line of the 'shown' log, once per spawn: which effects started, which failed, and whether his template names them.
    local function effectsText(look, report)
        if type(report) ~= 'table' or not look.effects then return '' end
        local parts = {}
        for _, name in ipairs(report.applied or {}) do
            local known = report.known and (report.known[name] and ' known' or ' NOT-IN-TEMPLATE') or ''
            parts[#parts + 1] = name .. known
        end
        local text = ' applied=[' .. table.concat(parts, ', ') .. ']'
        if report.failed and #report.failed > 0 then text = text .. ' failed=[' .. table.concat(report.failed, ', ') .. ']' end
        return text
    end

    local function nextBurst(at)
        return at + M.BURST_MIN + (M.BURST_MAX - M.BURST_MIN) * (tonumber(random()) or 0.5)
    end

    -- While he stays: the glitch loop of his arrival is stopped after GLITCH_SECONDS, then now and then a short silent flicker burst.
    local function stay(visit, at)
        local look = M.LOOKS[visit.look]
        if not look.effects and not look.burst and not look.flicker then return end
        local npc
        if visit.glitchOn and at - visit.shownAt >= M.GLITCH_SECONDS then
            visit.glitchOn = nil
            npc = call('entity', visit.id)
            if npc and look.effects then call('effects', npc, visit.id, {M.FX.glitch}, false) end
        end
        if visit.burstStopAt and at >= visit.burstStopAt then
            visit.burstStopAt = nil
            npc = npc or call('entity', visit.id)
            if npc and look.burst then call('effects', npc, visit.id, {look.burst}, false) end
        end
        if look.flicker and visit.burstAt and at >= visit.burstAt then
            visit.burstAt = nextBurst(at)
            npc = npc or call('entity', visit.id)
            if npc then
                local report = call('burst', npc, visit.id, look)
                visit.bursts = (visit.bursts or 0) + 1
                if look.burst and type(report) == 'table' and #report.ok > 0 then visit.burstStopAt = at + M.BURST_SECONDS end
                if type(report) == 'table' and #report.failed > 0 and not visit.burstLogged then
                    visit.burstLogged = true
                    log('burst effects failed: ' .. table.concat(report.failed, ', '))
                end
            end
        end
    end

    -- While he is there: what ends him, his arrival, his stay, his going.
    local function step(sample)
        local visit, at = service.visit, clock()
        -- Already going (V stood up): the glitch-out has played, the delete is all that is left.
        if visit.state == 'leaving' then return service:finish(visit.leaveReason or 'done', sample) end
        local why = read(options.enabled) ~= true and 'off' or M.interrupt(sample, visit.maxTier)
        if not why then
            local _, johnny, after = M.lineAges(read(options.lines), now(), visit.wall)
            if after then why = 'line' elseif johnny ~= nil and johnny <= now() - visit.wall then why = 'johnny-line' end
        end
        if not why and visit.event == 'sit' and type(options.seated) == 'function' then
            -- The seat hook stopped saying V sits (a missed exit hook): a few samples in a row, so a hiccup does not end the stay.
            local answered, seatedNow = pcall(options.seated)
            if answered and not seatedNow then
                visit.unseated = (visit.unseated or 0) + 1
                if visit.unseated >= M.NOT_SEATED_TICKS then why = 'not-seated' end
            else
                visit.unseated = 0
            end
        end
        if why then return service:finish(why, sample) end
        if visit.state == 'spawning' then
            local npc = call('entity', visit.id)
            if npc == nil then
                if at - visit.at > M.SPAWN_SECONDS then return service:finish('not-attached') end
                return true
            end
            local look = M.LOOKS[visit.look]
            local report, problem = call('look', npc, visit.id, look)
            visit.entity = call('hash', npc)
            visit.state, visit.shownAt = 'visible', at
            visit.glitchOn = type(report) == 'table' and look.effects ~= nil and (report.effects or 0) > 0 or nil
            visit.burstAt = look.flicker and nextBurst(at + M.GLITCH_SECONDS) or nil
            if options.screen == true and call('screen', true) then visit.screenAt = at end
            log('shown look=' .. visit.look .. ' phantom=' .. tostring(report and report.phantom) .. ' effects='
                .. tostring(report and report.effects) .. effectsText(look, report) .. ' flicker=' .. tostring(report and report.flicker)
                .. (problem and (' problem=' .. problem) or ''))
            return true
        end
        if visit.screenAt and at - visit.screenAt >= M.SCREEN_SECONDS then call('screen', false); visit.screenAt = nil end
        if visit.state == 'visible' then
            stay(visit, at)
            return true
        end
        return true
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
        if final then return drop(reason, sample) end
        if at - pending.at >= M.SEARCH_AFTER then search(player) end
        if reason then return true end
        if not pending.spot then
            if pending.exhausted then return drop('no-spot (' .. tostring(pending.why) .. ')') end
            return true
        end
        -- The game's own Johnny near V: ours does not come. An unanswered query counts as yes.
        local near = call('gameJohnnyNear', player, M.GAME_JOHNNY_RADIUS)
        if near ~= false then return drop(near == true and 'game-johnny' or 'game-johnny-unreadable') end
        return appear(pending, at, sample)
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
