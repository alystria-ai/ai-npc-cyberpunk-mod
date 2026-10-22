-- What a conversation can do to an ordinary world NPC (docs/NPC_REACTIONS.md).
--
-- A person the game placed and no story needs (a pedestrian, a ganger, a guard, a cop, a clerk) can end a conversation in one of three ways,
-- decided by what V said and by who the person is:
--   leave        the person ends the talk and walks or runs away
--   call-police  the person reports V: the game's own wanted level rises by one step (a civilian also runs; a clerk or a guard stays)
--   attack       the person turns hostile to V and the game's combat AI takes over
-- The model decides from the reply (bridge/text-actions.mjs for the text routes, Convai's action list for Convai); this module decides what
-- the GAME allows, offers only that, and carries out what the bridge hands back. Nothing here runs per frame: the offer is made once when V's
-- message is admitted, the reaction starts once when the NPC has finished speaking (update is one nil check while nothing is waiting), and the
-- natives are asked a handful of times in all.
--
-- Rails (all of them in `M.allowed`, which is pure and tested):
--   * ordinary NPCs only: never our companions, another mod's characters, a named or story character, a quest-flagged one;
--   * never a child, never when the game is in charge (a scene, a quest dialogue, a call, a fight, an injury, a vehicle: world-talk.lua);
--   * at most one reaction per person, and a cooldown before another attack or police call (V's very first message to a person may earn one:
--     no first-message rail since 2026-10-21, the owner's decision after a live test that threatened in the first message every time);
--   * the hostile kinds never in a safe zone or where combat is disabled, and a police call only while V is not wanted and the game's own
--     prevention system says it would react;
--   * every native call is guarded, logged once per failure kind and switched off after repeated failures; an unreadable fact refuses.
local M = {version = 1}

M.DEFAULTS = {
    cooldown = 120,      -- seconds after one attack or police call before another person may start either
    forget = 600,        -- seconds after V's last message to a person that the message count (only logged: `message=N`) starts again
    settle = 1.5,        -- seconds the reply must have been over before the reaction starts
    maxWait = 120,       -- seconds after which a reaction whose reply never seemed to end starts anyway
    maxFailures = 3,     -- failures of one kind of native call before it is switched off for the session
    limit = 64,          -- people remembered
    awayFar = 30, awayNear = 14, awaySnap = 3, awayMin = 10,   -- metres: where a leaving person goes, and the least it must gain on V
    verifyAfter = 1.2,   -- seconds after a reaction started that one read-back is logged
}

M.KINDS = {'leave', 'call-police', 'attack'}

-- Who may do what. The kinds fit the person: a civilian leaves or reports, a ganger leaves or attacks, a clerk can only report (a shop
-- the player needs is never abandoned), a cop can only attack (never leaves, never calmly: a threatened cop turns on V), a guard reports
-- or attacks. `base` (characters/archetypes.json) overrides `category`.
M.BY_CATEGORY = {
    resident = {'leave', 'call-police'},
    vendor = {'call-police'},
    police = {'attack'},
    ['corpo-security'] = {'call-police', 'attack'},
    gang = {'leave', 'attack'},
    faction = {'leave', 'attack'},
}
M.BY_BASE = {
    aldecaldos = {'leave'},                          -- nomads: they walk off, they do not take V on
    biotechnica = {'leave', 'call-police'},          -- staff, not soldiers
    ['trauma-team'] = {'leave', 'call-police'},
}
-- After a police call these stay where they stand (it is their post); everyone else with a police call also runs.
M.STAYS = {vendor = true, police = true, ['corpo-security'] = true}
-- Civilians run; everyone else walks off.
M.RUNS = {resident = true}

local function copy(list) local out = {}; for index, value in ipairs(list) do out[index] = value end; return out end

-- The kinds that fit this person, in the order of M.KINDS, or nil (no kind, a named character, a companion). archetype: the table the
-- adapter sends (base, category). Pure.
function M.kindsFor(archetype)
    if type(archetype) ~= 'table' then return nil end
    local list = M.BY_BASE[archetype.base] or M.BY_CATEGORY[archetype.category]
    if type(list) ~= 'table' or #list == 0 then return nil end
    return copy(list)
end

-- Which of `kinds` the game allows now, from plain facts. Returns the allowed kinds (possibly empty), and when none is allowed the reason
-- text (the first refusal of each kind). Facts:
--   ordinary   false for a companion, another mod's character, a named or story character
--   quest      true when the person is flagged as a quest actor
--   child, hostile, safe     booleans (nil: could not be read, which refuses what depends on it)
--   heat       V's wanted stage (number)           preventionReady   the game's prevention system would react to a crime now
--   refused    the reason the game is in charge (world-talk.lua), or nil
--   reacted    this person already had its one reaction     cooldown   a recent attack or call
--   off        {attack = true, call = true, walk = true}: kinds of native call switched off after failures
-- Pure.
function M.allowed(kinds, facts)
    if type(kinds) ~= 'table' or #kinds == 0 then return {}, 'no-kind' end
    if type(facts) ~= 'table' then return {}, 'unreadable' end
    if facts.ordinary ~= true then return {}, 'not-ordinary' end
    if facts.quest ~= false then return {}, facts.quest == true and 'quest-flag' or 'unreadable-quest' end
    if facts.reacted == true then return {}, 'already-reacted' end
    if facts.child ~= false then return {}, facts.child == true and 'child' or 'unreadable-child' end
    if facts.refused then return {}, 'game-in-charge:' .. tostring(facts.refused) end
    local off = type(facts.off) == 'table' and facts.off or {}
    local out, why = {}, {}
    for _, kind in ipairs(kinds) do
        local reason
        if kind == 'leave' then
            if off.walk then reason = 'walk-switched-off' end
        elseif kind == 'attack' then
            if off.attack then reason = 'attack-switched-off'
            elseif facts.cooldown == true then reason = 'cooldown'
            elseif facts.safe ~= false then reason = facts.safe == true and 'safe-zone' or 'unreadable-zone'
            elseif facts.hostile ~= false then reason = facts.hostile == true and 'already-hostile' or 'unreadable-attitude' end
        elseif kind == 'call-police' then
            if off.call then reason = 'call-switched-off'
            elseif facts.cooldown == true then reason = 'cooldown'
            elseif facts.safe ~= false then reason = facts.safe == true and 'safe-zone' or 'unreadable-zone'
            elseif type(facts.heat) ~= 'number' then reason = 'unreadable-heat'
            elseif facts.heat > 0 then reason = 'already-wanted'
            elseif facts.preventionReady ~= true then reason = 'prevention-would-not-react' end
        else
            reason = 'unknown-kind'
        end
        if reason then why[#why + 1] = kind .. ':' .. reason else out[#out + 1] = kind end
    end
    return out, #out == 0 and table.concat(why, ',') or nil
end

-- The native adapter: every call the module makes on the game, in one place. Each function raises on failure; the service guards them.
function M.nativeAdapter()
    local N = {}
    local function finite(value) return type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge end
    local function attitudeName(from, to)
        local text = tostring(from:GetAttitudeAgent():GetAttitudeTowards(to:GetAttitudeAgent()))
        for _, name in ipairs({'AIA_Hostile', 'AIA_Neutral', 'AIA_Friendly'}) do
            if text:find(name, 1, true) then return name end
        end
        return nil
    end
    function N.key(npc) return tostring(npc:GetEntityID().hash) end
    function N.alive(npc)
        return npc ~= nil and npc:IsAttached() == true and not npc:IsDeadNoStatPool() and not ScriptedPuppet.IsDefeated(npc)
    end
    function N.child(npc) return npc:IsCharacterChildren() == true end
    function N.hostile(npc, player) return attitudeName(npc, player) == 'AIA_Hostile' end
    function N.inCombat(npc) return NPCPuppet.IsInCombat(npc) == true end
    -- V stands where combat is disabled: the game's own zone (PlayerStateMachine.Zones == Safe, set from the city area type), its safe-area
    -- volumes (SafeAreaManager, what ReactionManagerComponent reads) or a NoCombat status. true when any says so, false when the zone was
    -- read and none does, nil when the zone could not be read (refuses the hostile kinds).
    function N.safe(player)
        local zone
        local ok, value = pcall(function()
            local defs = Game.GetAllBlackboardDefs().PlayerStateMachine
            local int = player:GetPlayerStateMachineBlackboard():GetInt(defs.Zones)
            local safe = tonumber(EnumInt(Enum.new('gamePSMZones', 'Safe')))
            return int == (safe or 2)
        end)
        if ok then zone = value == true end
        local area = false
        local areaOk, areaValue = pcall(function() return Game.GetSafeAreaManager():IsPointInSafeArea(player:GetWorldPosition()) == true end)
        if areaOk then area = areaValue end
        local noCombat = false
        local tagOk, tagValue = pcall(function()
            return StatusEffectSystem.ObjectHasStatusEffectWithTag(player, CName.new('NoCombat')) == true
        end)
        if tagOk then noCombat = tagValue end
        if zone == true or area or noCombat then return true end
        if zone == nil then return nil end
        return false
    end
    -- V's wanted stage, 0 to 5: the prevention system's own getter (mod/turn-context.lua reads the same).
    function N.heat()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        if system == nil then error('no prevention system') end
        local ok, value = pcall(function() return system:GetHeatStageAsInt() end)
        if not ok or tonumber(value) == nil then value = EnumInt(system:GetHeatStage()) end
        value = tonumber(value)
        if not finite(value) then error('the wanted stage is not a number') end
        return value
    end
    -- The game's own answer to "would the police react to a crime now": the system is on and unlocked, V is in no scene, and V is in no security
    -- area (safe zone). Public static functions of PreventionSystem (preventionSystem.script); read, never changed.
    -- CET fills a static function's leading GameInstance parameter itself ("requires 0 parameter(s)" live, 2026-10-21), so the call
    -- goes without it first; the explicit form stays as the fallback for a CET build that does not fill it.
    local function static(fn, game, ...)
        local ok, value = pcall(fn, ...)
        if ok then return value end
        if not tostring(value):find('parameter', 1, true) then error(value, 0) end
        return fn(game, ...)
    end
    function N.preventionReady(player)
        local game = player:GetGame()
        return static(PreventionSystem.CanPreventionReact, game) == true
            and static(PreventionSystem.ShouldReactionBeAgressive, game) == true
    end
    -- The police call: the request the game's own CallPolice behavior task sends when a pedestrian reports a crime
    -- (aiStimReactionTask.script CallPolice.Activate): PreventionSystem queues a crime witness at V's position and, when V is not wanted yet,
    -- raises the heat stage by exactly one (HeatPipeline("CrimeWitness")). Nothing else is touched.
    function N.callPolice(player)
        static(PreventionSystem.CrimeWitnessRequestToPreventionSystem, player:GetGame(), player:GetWorldPosition())
    end
    -- Hostile to V at the agent level (never the attitude group), as the companion tactic does for its target.
    function N.makeHostile(npc, player)
        npc:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), Enum.new('EAIAttitude', 'AIA_Hostile'))
        if attitudeName(npc, player) ~= 'AIA_Hostile' then error('the attitude did not read back as hostile') end
    end
    -- The person's own combat start against V: its reaction component's TriggerCombat (a script function the game marks private; CET calls
    -- it by name, as mod/companion-tactics.lua does), else the game's combat helper the component itself calls. Returns the name of the way.
    function N.startCombat(npc, player)
        local first, failure = pcall(function()
            local component = npc:GetStimReactionComponent()
            if not component then error('no reaction component') end
            component:TriggerCombat(player)
        end)
        if first then return 'reaction-component' end
        local second, helper = pcall(function()
            if AIActionHelper.TryStartCombatWithTarget(npc, player) == false then error('the game refused combat') end
        end)
        if second then return 'combat-helper' end
        error('reaction component: ' .. tostring(failure) .. '; combat helper: ' .. tostring(helper))
    end
    -- The stronger second ask, once, when the person is still not in combat a second after the first: the combat start again and the game's
    -- own forced-fight step, the Combat high-level state (NPCPuppet.ChangeHighLevelState, what the game itself calls together with a threat
    -- when it forces a fight; mod/companion-tactics.lua setHighLevel). Returns a text of what was accepted; raises when neither was.
    function N.engage(npc, player)
        local started = pcall(function() npc:GetStimReactionComponent():TriggerCombat(player) end)
        local state = pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Combat')) end)
        if not started and not state then error('neither the combat start nor the combat state was accepted') end
        return (started and 'combat start ' or '') .. (state and 'combat state' or '')
    end
    -- Up to three walkable points for a person to leave to: directly away from V, then 35 degrees to either side, far and then near
    -- (the nearest walkable ground to each, within awaySnap metres), each farther from V than the person stands by at least awayMin.
    function N.awayPoints(npc, player, cfg)
        local at, from = npc:GetWorldPosition(), player:GetWorldPosition()
        local dx, dy = at.x - from.x, at.y - from.y
        local length = math.sqrt(dx * dx + dy * dy)
        if length < 0.1 then dx, dy, length = 1, 0, 1 end
        dx, dy = dx / length, dy / length
        local nav = Game.GetAINavigationSystem()
        local success = Enum.new('worldNavigationRequestStatus', 'OK')
        local points = {}
        for _, row in ipairs({{cfg.awayFar, 0}, {cfg.awayFar, 35}, {cfg.awayFar, -35}, {cfg.awayNear, 0}, {cfg.awayNear, 60}, {cfg.awayNear, -60}}) do
            local angle = math.rad(row[2])
            local rx, ry = dx * math.cos(angle) - dy * math.sin(angle), dx * math.sin(angle) + dy * math.cos(angle)
            local found = nav:FindPointInSphereForCharacter(
                Vector4.new(at.x + rx * row[1], at.y + ry * row[1], at.z, 1), cfg.awaySnap, npc)
            local p = found and found.status == success and found.point or nil
            if p and finite(p.x) and finite(p.y) and finite(p.z) then
                local gap = math.sqrt((p.x - from.x) ^ 2 + (p.y - from.y) ^ 2)
                if gap >= cfg.awayMin and gap >= length + cfg.awayMin * 0.4 then
                    points[#points + 1] = {x = p.x, y = p.y, z = p.z, gap = gap}
                    if #points >= 3 then break end
                end
            end
        end
        return points
    end
    -- One walking command to a point (the command the companion code sends, mod/companion-actuator.lua walk): the person moves on the
    -- navmesh and the game's own AI takes it back when it arrives. Returns the command, to read its state later.
    function N.walkTo(npc, point, gait)
        local world = WorldPosition.new()
        world:SetVector4(Vector4.new(point.x, point.y, point.z, 1))
        local spec = AIPositionSpec.new()
        spec:SetWorldPosition(world)
        local command = NewObject('AIMoveToCommand')
        command.movementTarget = spec
        command.rotateEntityTowardsFacingTarget = false
        command.movementType = Enum.new('moveMovementType', gait)
        command.desiredDistanceFromTarget = 1.0
        command.finishWhenDestinationReached = true
        command.ignoreNavigation = false
        command.useStart = true
        command.useStop = false
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the walk command') end
        return command
    end
    function N.commandState(npc, command)
        local label = tostring(npc:GetAIControllerComponent():GetCommandState(command))
        return label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
    end
    return N
end

-- options:
--   natives(optional)   the adapter above (a test's fake)          clock()   seconds (os.clock)          log(line)   logOnce(key, line)
--   config              overrides of M.DEFAULTS
--   player()            V                                          npcFor(entity)   the conversation's NPC for this entity, or nil
--   policy              {ours, spawned, protected, story}(npc) -> boolean (convaiWorldPolicy)
--   storyFlag(npc, entity)   true when the person is flagged as a quest actor (the TweakDB quest flag), false, or nil when unread
--   refusal(npc, player, entity)   the reason the game is in charge (world-talk.lua) or nil
--   release(player)     lets go of the conversation's hold and look-at (endFocus in mod/init.lua)
--   awaiting(requestId) the reply for that request is still on its way         speaking(entity)   the person is speaking now
function M.new(options)
    options = type(options) == 'table' and options or {}
    local cfg = {}
    for key, value in pairs(M.DEFAULTS) do cfg[key] = value end
    for key, value in pairs(options.config or {}) do cfg[key] = value end
    local natives = options.natives or M.nativeAdapter()
    local clock = options.clock or os.clock
    local S = {options = options, cfg = cfg}
    local failures, off = {}, {}
    local exchanges, exchangeCount = {}, 0
    local reacted, reactedCount = {}, 0
    local lastHostile
    local pending
    local checks = {}   -- read-backs due later: {at, kind, ...}

    local function log(line) if type(options.log) == 'function' then pcall(options.log, line) end end
    local function logOnce(key, line)
        if type(options.logOnce) == 'function' then pcall(options.logOnce, key, line) else log(line) end
    end
    -- The switch a failing kind of call belongs to: kind -> which `off` flag it sets (reads switch off the facts they feed, which refuses).
    local function fail(kind, reason)
        failures[kind] = (failures[kind] or 0) + 1
        logOnce('npc-reaction:' .. kind, 'NPC reaction: ' .. kind .. ' failed: ' .. tostring(reason):sub(1, 200))
        if failures[kind] >= cfg.maxFailures and not off[kind] then
            off[kind] = true
            log('NPC reaction: ' .. kind .. ' switched off for this session after ' .. failures[kind] .. ' failures')
        end
    end
    -- A guarded native call. Returns ok, value, extra. A kind already switched off is not asked again.
    local function guard(kind, fn, ...)
        if off[kind] then return false, 'switched off' end
        local ok, value, extra = pcall(fn, ...)
        if ok then return true, value, extra end
        fail(kind, value)
        return false, value
    end

    local function touch(entity, now)
        local row = exchanges[entity]
        if row and now - row.at > cfg.forget then row = nil end
        if not row then
            if exchangeCount >= cfg.limit then exchanges, exchangeCount = {}, 0 end
            row = {count = 0, at = now}
            exchanges[entity] = row
            exchangeCount = exchangeCount + 1
        end
        row.count, row.at = row.count + 1, now
        return row.count
    end

    local function cooling(now) return lastHostile ~= nil and now - lastHostile < cfg.cooldown end

    -- The facts of one person now. mode: nil when V's message is admitted (every rail); 'start' when the bridge hands a reaction back (the
    -- once-only rail was applied when it was offered, the cooldown still counts: two people offered the same minute may not both act);
    -- 'run' when it begins, after the reply (the person's own start set the cooldown, so neither applies). There is no first-message rail since
    -- 2026-10-21: V's very first message to a person may earn a reaction (the live test threatened in the first message every time).
    local function facts(npc, player, entity, mode)
        local fresh = mode ~= nil
        local now = clock()
        local f = {off = {attack = off.attack, call = off.call, walk = off.walk}}
        local policy = type(options.policy) == 'table' and options.policy or {}
        local okPolicy, ordinary = pcall(function()
            return policy.ours(npc) ~= true and policy.spawned(npc) ~= true and policy.protected(npc) ~= true and policy.story(npc) ~= true
        end)
        f.ordinary = okPolicy and ordinary == true
        local okFlag, flagged = pcall(function() return options.storyFlag(npc, entity) end)
        if okFlag and type(flagged) == 'boolean' then f.quest = flagged end
        local okRefusal, refused = pcall(function() return options.refusal(npc, player, entity) end)
        if okRefusal then f.refused = refused else f.refused = 'unreadable' end
        local function read(name, kind, fn, ...)
            local ok, value = guard(kind, fn, ...)
            if ok and value ~= nil then f[name] = value end
        end
        read('child', 'read-child', natives.child, npc)
        read('hostile', 'read-attitude', natives.hostile, npc, player)
        read('safe', 'read-zone', natives.safe, player)
        read('heat', 'read-heat', natives.heat)
        read('preventionReady', 'read-prevention', natives.preventionReady, player)
        f.reacted = not fresh and reacted[entity] ~= nil
        f.cooldown = mode ~= 'run' and cooling(now)
        return f
    end

    -- The offer for V's message that is being admitted (mod/gameplay-actions.lua capture): {available, actor, kinds}, or nil. context: the
    -- request (entity, profileKey, archetype).
    function S.offer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        local kinds = M.kindsFor(context.archetype)
        if not kinds then
            logOnce('npc-reaction-no-kind:' .. entity, 'NPC reaction not offered: no-kind (' .. tostring(type(context.archetype) == 'table' and (context.archetype.base or context.archetype.category) or 'no archetype') .. ')')
            return nil
        end
        local now = clock()
        local count = touch(entity, now)
        local okNpc, npc = pcall(options.npcFor, entity)
        local okPlayer, player = pcall(options.player)
        if not (okNpc and npc and okPlayer and player) then
            logOnce('npc-reaction-no-person:' .. entity, 'NPC reaction not offered: no-person (not the conversation partner)')
            return nil
        end
        local readOk, alive = guard('read-alive', natives.alive, npc)
        if not (readOk and alive) then
            logOnce('npc-reaction-no-alive:' .. entity, 'NPC reaction not offered: not-alive-or-unreadable')
            return nil
        end
        exchanges[entity].category = context.archetype.base or context.archetype.category
        exchanges[entity].group = context.archetype.category
        exchanges[entity].base, exchanges[entity].affiliation = context.archetype.base, context.archetype.affiliation
        local allowed, why = M.allowed(kinds, facts(npc, player, entity))
        if #allowed == 0 then
            logOnce('npc-reaction-no:' .. entity .. ':' .. tostring(why), 'NPC reaction not offered: ' .. tostring(why) .. ' (' .. tostring(context.archetype.base or context.archetype.category) .. ')')
            return nil
        end
        log('NPC reaction offered: kinds=' .. table.concat(allowed, ',') .. ' type=' .. tostring(context.archetype.base or context.archetype.category)
            .. ' message=' .. tostring(count))
        return {available = true, actor = {id = entity, key = context.profileKey}, kinds = allowed}
    end

    local function release(player)
        if type(options.release) == 'function' then pcall(options.release, player) end
    end

    -- The walk away: V's hold on the person is let go, then one command to the first walkable point away from V.
    local function walkAway(p, player, why)
        release(player)
        local gait = M.RUNS[p.category] and 'Run' or 'Walk'
        local ok, points = guard('walk', natives.awayPoints, p.npc, player, cfg)
        if not ok or type(points) ~= 'table' or #points == 0 then
            logOnce('npc-reaction-nopoint', 'NPC reaction: no walkable point away from V for ' .. why .. '; the person stays')
            return false
        end
        local started, command = guard('walk', natives.walkTo, p.npc, points[1], gait)
        if not started then return false end
        log('NPC reaction: ' .. why .. ' started, ' .. gait:lower() .. ' away (' .. string.format('%.0f', points[1].gap) .. ' m from V)')
        checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'walk', npc = p.npc, command = command, points = points, tried = 1, gait = gait, why = why, entity = p.entity}
        return true
    end

    -- A reaction that actually started, for Street reputation (mod/reputation.lua; options.onReaction is set only while that setting is on).
    local function started(kind, p)
        if type(options.onReaction) == 'function' then
            pcall(options.onReaction, kind, {base = p.base, category = p.category, affiliation = p.affiliation})
        end
    end

    local function run(p)
        local player
        local okPlayer, value = pcall(options.player)
        if okPlayer then player = value end
        if not player then log('NPC reaction dropped: no player'); return end
        local alive, up = guard('read-alive', natives.alive, p.npc)
        local keyOk, key = pcall(natives.key, p.npc)
        if not (alive and up and keyOk and key == p.entity) then log('NPC reaction dropped: the person is gone (' .. p.kind .. ')'); return end
        local allowed, why = M.allowed({p.kind}, facts(p.npc, player, p.entity, 'run'))
        if #allowed == 0 then
            log('NPC reaction dropped before it started (' .. p.kind .. '): ' .. tostring(why))
            -- A person who would have called the police and cannot: the honest fallback is the walk away that goes with the call.
            if p.kind == 'call-police' and not M.STAYS[p.category] and not off.walk
                and not (type(why) == 'string' and (why:find('game%-in%-charge') or why:find('child') or why:find('not%-ordinary') or why:find('quest'))) then
                if walkAway(p, player, 'leave (no police call possible)') then started('leave', p) end
            end
            return
        end
        if p.kind == 'leave' then
            if walkAway(p, player, 'leave') then started('leave', p) end
        elseif p.kind == 'attack' then
            release(player)
            local hostile = guard('attack', natives.makeHostile, p.npc, player)
            local combat, way = guard('attack', natives.startCombat, p.npc, player)
            log('NPC reaction: attack ' .. (hostile and 'hostile ok' or 'hostile failed') .. ', combat start ' .. (combat and tostring(way) or 'failed'))
            if hostile or combat then
                checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'attack', npc = p.npc, entity = p.entity}
                started('attack', p)
            end
        elseif p.kind == 'call-police' then
            local before = select(2, guard('read-heat', natives.heat))
            local called = guard('call', natives.callPolice, player)
            log('NPC reaction: police call ' .. (called and 'sent' or 'failed') .. ' (stage before ' .. tostring(before) .. ')')
            if called then checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'police', before = before}; started('call-police', p) end
            if not M.STAYS[p.category] then walkAway(p, player, 'run after the police call') end
        end
    end

    -- One read-back per reaction, logged: what the game did with it. Never retried except a walk the game did not take.
    local function check(v)
        if v.kind == 'walk' then
            local ok, state = guard('read-command', natives.commandState, v.npc, v.command)
            log('NPC reaction check: ' .. v.why .. ' command state=' .. (ok and tostring(state) or 'unreadable'))
            if ok and (state == 'Failure' or state == 'Cancelled' or state == 'Interrupted') and v.points[v.tried + 1] and not off.walk then
                local started, command = guard('walk', natives.walkTo, v.npc, v.points[v.tried + 1], v.gait)
                if started then
                    log('NPC reaction: the first walk was not taken (' .. state .. '); the next point')
                    checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'walk', npc = v.npc, command = command, points = v.points, tried = v.tried + 1, gait = v.gait, why = v.why, entity = v.entity}
                end
            end
        elseif v.kind == 'attack' then
            local okCombat, combat = guard('read-combat', natives.inCombat, v.npc)
            local player = select(2, pcall(options.player))
            local okHostile, hostile = guard('read-attitude', natives.hostile, v.npc, player)
            log('NPC reaction check: attack in_combat=' .. (okCombat and tostring(combat) or 'unreadable') .. ' hostile_to_v=' .. (okHostile and tostring(hostile) or 'unreadable'))
            -- Hostile but not fighting a second later (a person who has not noticed V): one stronger ask, then one more read-back.
            if okCombat and combat == false and not v.engaged and okHostile then
                local engaged, how = guard('attack', natives.engage, v.npc, player)
                log('NPC reaction: not in combat yet, asked again (' .. (engaged and tostring(how) or 'failed') .. ')')
                if engaged then checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'attack', npc = v.npc, entity = v.entity, engaged = true} end
            end
        elseif v.kind == 'police' then
            local ok, heat = guard('read-heat', natives.heat)
            log('NPC reaction check: police stage ' .. tostring(v.before) .. ' -> ' .. (ok and tostring(heat) or 'unreadable'))
        end
    end

    -- A reaction the bridge handed back (mod/gameplay-actions.lua, after it checked the lease). Returns true, or false and a reason.
    function S.start(kind, offer, entity, requestId)
        if type(kind) ~= 'string' or type(offer) ~= 'table' or type(offer.kinds) ~= 'table' then return false, 'no-offer' end
        local offered = false
        for _, value in ipairs(offer.kinds) do if value == kind then offered = true end end
        if not offered then return false, 'not-offered' end
        if reacted[entity] then return false, 'already-reacted' end
        if pending then return false, 'busy' end
        local okNpc, npc = pcall(options.npcFor, entity)
        local okPlayer, player = pcall(options.player)
        if not (okNpc and npc and okPlayer and player) then
            log('NPC reaction refused (' .. kind .. '): the person is not the conversation partner any more')
            return false, 'no-person'
        end
        local row = exchanges[entity]
        local allowed, why = M.allowed({kind}, facts(npc, player, entity, 'start'))
        if #allowed == 0 then log('NPC reaction refused (' .. kind .. '): ' .. tostring(why)); return false, why end
        if reactedCount >= cfg.limit then reacted, reactedCount = {}, 0 end
        local now = clock()
        reacted[entity], reactedCount = now, reactedCount + 1
        if kind ~= 'leave' then lastHostile = now end
        pending = {kind = kind, entity = entity, requestId = requestId, npc = npc, at = now, category = row and row.group,
            base = row and row.base, affiliation = row and row.affiliation}
        log('NPC reaction accepted: ' .. kind .. ', starts when the reply has been heard')
        return true
    end

    -- Called from the game's update; one nil check while nothing waits.
    function S.update()
        if pending == nil and checks[1] == nil then return end
        local now = clock()
        if pending then
            local p = pending
            local busy = false
            if type(options.awaiting) == 'function' then local ok, value = pcall(options.awaiting, p.requestId); busy = ok and value == true end
            if not busy and type(options.speaking) == 'function' then local ok, value = pcall(options.speaking, p.entity); busy = ok and value == true end
            if busy then p.quiet = nil elseif not p.quiet then p.quiet = now end
            if (p.quiet and now - p.quiet >= cfg.settle) or now - p.at >= cfg.maxWait then
                pending = nil
                run(p)
            end
        end
        local index = 1
        while checks[index] do
            local due = checks[index]
            if now >= due.at then table.remove(checks, index); check(due) else index = index + 1 end
        end
    end

    -- A new world, a reload, a menu: nothing waits, nobody is remembered. The failure switches stay: a native that does not work does not
    -- start working because the save was reloaded.
    function S.reset()
        pending, checks = nil, {}
        exchanges, exchangeCount, reacted, reactedCount, lastHostile = {}, 0, {}, 0, nil
    end

    function S.inspect()
        return {pending = pending ~= nil and pending.kind or nil, off = {attack = off.attack, call = off.call, walk = off.walk},
            failures = failures, cooling = cooling(clock()), reacted = reactedCount}
    end
    function S.cancel(entity)
        if pending and (entity == nil or pending.entity == entity) then pending = nil end
    end
    return S
end

return M
