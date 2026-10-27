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
--
-- Threats and commands (docs/NPC_THREATS_COMMANDS.md), only with the Companion Manager switch "NPCs react to threats and commands" on (off by
-- default; `options.threats()`): a civilian may also cower, a fighter may brawl with fists (an insult or a threat to hurt) as well as attack with a
-- weapon (a death threat), and people may obey three commands: get down, stop, get out of the vehicle. Which of them a turn may use is narrowed by
-- the bridge from V's own words (bridge/threat-screen.mjs). For a clear threat, insult or command the GAME picks the reaction (`M.plan`, sent with
-- the offer; the bridge applies it the moment V's words are known and tells the model what the person does); the model's own choice is left only
-- for words the screen does not read.
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
    fleeVerify = 3,      -- seconds after a crowd person's flight started that its read-back (metres moved) is logged
    fleeMin = 1.5,       -- metres a fleeing crowd person must have moved by that read-back, or it is asked once more with the fear stage
    -- A walking crowd person's run (crowdRun): legs of a few metres, each read back, so a move the game turns into a jump jumps one leg at most.
    legProbe = 4, legLength = 8,   -- metres: the first leg, every later one
    probeAfter = 0.4, legCheck = 1.0,   -- seconds: the first leg's read-back, every later one's (the next leg is sent then)
    runSpeedMax = 7,     -- metres a second nobody runs faster than: a leg covered faster was a jump
    legJumpMin = 3,      -- metres a leg must cover before its speed counts as a jump
    legStall = 0.3,      -- metres: less in a read-back (twice) is a person that does not run
    legArrive = 2, legsMax = 10,
    -- A brawl: its friends joining and V's escalation (V holds a gun: everyone draws, for good). The friends are searched at the first
    -- read-back and again `joinAgain` seconds after the start (live test 4: the gang came in later than the one search at 1.2 s found).
    buddyRadius = 20, buddyMax = 4, joinAgain = {3, 6},
    escalateEvery = 1, escalateWatch = 120,
    armVerify = 1.5,     -- seconds after the escalation that every brawler's hand is read back (and one who still has no gun asked once more)
    jump = 12,           -- metres moved by the first read-back that mean the person was put there, not walked there
    commandCooldown = 30,   -- seconds after a command before the same person is offered another
    stopHold = 30, cowerHold = 20,   -- seconds a person who stopped, cowers or got down (not seated) holds still
    exitVerify = 3,      -- seconds after a get-out command that its read-back (still in the vehicle or not) is logged
}

M.KINDS = {'leave', 'call-police', 'attack', 'cower', 'brawl', 'get-down', 'stop', 'exit-vehicle'}
-- The three commands V may give (docs/NPC_THREATS_COMMANDS.md). A command is not the person's one reaction: it does not use up the once-only
-- rail, and a threat may still follow it.
M.COMMANDS = {['get-down'] = true, stop = true, ['exit-vehicle'] = true}
-- The kinds that turn on V or report V: one of them sets the cooldown for all of them.
M.HOSTILE = {attack = true, ['call-police'] = true, brawl = true}

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

-- With the threats switch on, these join the kinds above. Civilians, clerks and staff flee (leave) or cower and may obey; gangers, soldiers,
-- guards and cops fight, with fists for an insult or a threat to hurt (brawl) and with their weapon for a death threat (attack). A cop or a guard
-- never takes orders from V. Nomads walk off rather than fight, as above. `base` overrides `category`, as above.
M.THREAT_BY_CATEGORY = {
    resident = {'cower', 'get-down', 'stop', 'exit-vehicle'},
    vendor = {'cower', 'get-down'},                  -- a clerk ducks behind the counter; never walks off its post
    police = {'brawl'},
    ['corpo-security'] = {'brawl'},
    gang = {'brawl', 'get-down', 'stop', 'exit-vehicle'},
    faction = {'brawl', 'get-down', 'stop', 'exit-vehicle'},
}
M.THREAT_BY_BASE = {
    aldecaldos = {'get-down', 'stop', 'exit-vehicle'},
    biotechnica = {'cower', 'get-down', 'stop', 'exit-vehicle'},
    ['trauma-team'] = {'cower', 'get-down', 'stop', 'exit-vehicle'},
}
-- The game's own temper of the person (its reaction preset, `natives.temper`): a passive ganger, soldier or guard may also cower.
M.PASSIVE_COWER = {gang = true, faction = true, ['corpo-security'] = true}

-- The game decides (the owner's rule of 2026-10-26, docs/NPC_THREATS_COMMANDS.md "Who decides"): when V's words are a clear death threat, a threat
-- to hurt, an insult or one of the three commands (bridge/threat-screen.mjs), the reaction is the game's pick from who the person is, never the
-- model's: the model is told what the person does so its line fits. The plan is made once per offer, for every reading of V's words at once
-- (the words are often heard only after the offer: a voice turn), and it is the same for one person every time (seeded by the person, never
-- random per turn). Each row: {kind, weight}. The person's seed picks among the weighted kinds; when the pick is not allowed now (a safe zone, V
-- already wanted), the next kind of the row that is allowed stands in (weight 0: only ever a stand-in).
M.PLAN_KEYS = {'kill', 'hurt', 'insult', 'get-down', 'stop', 'exit-vehicle'}
local function listed(list, kind) for _, value in ipairs(list or {}) do if value == kind then return true end end return false end
M.TEMPERS = {
    -- An aggressive or ordinary ganger, soldier: fists for an insult or a threat to hurt, the weapon for a death threat.
    fighter = {kill = {{'attack', 1}, {'brawl', 0}, {'leave', 0}}, hurt = {{'brawl', 1}, {'attack', 0}, {'leave', 0}}, insult = {{'brawl', 1}, {'leave', 0}}},
    -- A passive ganger or soldier: hides from a death threat or backs off, walks off from the rest.
    wary = {kill = {{'cower', 1}, {'leave', 1}}, hurt = {{'leave', 1}, {'cower', 0}}, insult = {{'leave', 1}}},
    -- A cop or a guard: fights (a guard's police call only stands in for a fight the game does not allow).
    guard = {kill = {{'attack', 1}, {'brawl', 0}, {'call-police', 0}}, hurt = {{'brawl', 1}, {'attack', 0}, {'call-police', 0}}, insult = {{'brawl', 1}, {'call-police', 0}}},
    -- A civilian: runs or cowers, sometimes calls the police.
    civilian = {kill = {{'cower', 4}, {'leave', 4}, {'call-police', 2}}, hurt = {{'leave', 5}, {'cower', 3}, {'call-police', 2}},
        insult = {{'leave', 8}, {'call-police', 2}}},
    -- A clerk: calls the police or ducks behind the counter; never leaves its post.
    shop = {kill = {{'cower', 1}, {'call-police', 1}}, hurt = {{'call-police', 1}, {'cower', 1}}, insult = {{'call-police', 1}, {'cower', 0}}},
    -- Nomads walk off.
    nomad = {kill = {{'leave', 1}}, hurt = {{'leave', 1}}, insult = {{'leave', 1}}},
}
-- Which row of M.TEMPERS a person is: `base` first (nomads, the staff of a clinic or a lab), then the category, then the game's temper.
function M.temperOf(archetype, temper)
    if type(archetype) ~= 'table' then return nil end
    if archetype.base == 'aldecaldos' then return 'nomad' end
    if archetype.base == 'biotechnica' or archetype.base == 'trauma-team' then return 'civilian' end
    local category = archetype.category
    if category == 'resident' then return 'civilian' end
    if category == 'vendor' then return 'shop' end
    if category == 'police' or category == 'corpo-security' then return 'guard' end
    if category == 'gang' or category == 'faction' then return temper == 'passive' and 'wary' or 'fighter' end
    return nil
end
-- The person's own number: the same for one person every time (its entity id), different between people.
function M.seed(entity)
    local value = 0
    for index = 1, #tostring(entity or '') do value = (value * 31 + tostring(entity):byte(index)) % 2147483647 end
    return value
end
-- The plan for one person: {kill = kind, hurt = kind, insult = kind, ['get-down'] = 'get-down', ...}, only readings with an allowed kind, or nil
-- when none has one. kinds: what the game allows this person now (M.allowed). Pure.
function M.plan(archetype, temper, kinds, seed)
    local row = M.TEMPERS[M.temperOf(archetype, temper) or '']
    if type(kinds) ~= 'table' then return nil end
    local plan, any = {}, false
    for index, level in ipairs({'kill', 'hurt', 'insult'}) do
        local choices = row and row[level] or {}
        local total = 0
        for _, choice in ipairs(choices) do total = total + choice[2] end
        local pick
        if total > 0 then
            -- One roll per reading, mixed so a person's three rolls are not alike.
            local roll = (((seed or 0) % 1000003) * (index * 2 + 1) + index * 104729) % 9973 % total
            for _, choice in ipairs(choices) do
                if roll < choice[2] then pick = choice[1]; break end
                roll = roll - choice[2]
            end
        end
        if not listed(kinds, pick) then
            pick = nil
            for _, choice in ipairs(choices) do if listed(kinds, choice[1]) then pick = choice[1]; break end end
        end
        if pick then plan[level], any = pick, true end
    end
    for command in pairs(M.COMMANDS) do if listed(kinds, command) then plan[command], any = command, true end end
    return any and plan or nil
end
local function planText(plan)
    local parts = {}
    for _, key in ipairs(M.PLAN_KEYS) do if plan[key] then parts[#parts + 1] = key .. ':' .. plan[key] end end
    return table.concat(parts, ',')
end

local function copy(list) local out = {}; for index, value in ipairs(list) do out[index] = value end; return out end
local function has(list, kind) for _, value in ipairs(list or {}) do if value == kind then return true end end return false end

-- The kinds that fit this person, in the order of M.KINDS, or nil (no kind, a named character, a companion). archetype: the table the
-- adapter sends (base, category). threats: the threats switch is on; temper: 'aggressive', 'passive', 'neutral' or nil (not read). Pure.
function M.kindsFor(archetype, threats, temper)
    if type(archetype) ~= 'table' then return nil end
    local list = M.BY_BASE[archetype.base] or M.BY_CATEGORY[archetype.category]
    if type(list) ~= 'table' or #list == 0 then return nil end
    if threats ~= true then return copy(list) end
    local wanted = {}
    for _, kind in ipairs(list) do wanted[kind] = true end
    for _, kind in ipairs(M.THREAT_BY_BASE[archetype.base] or M.THREAT_BY_CATEGORY[archetype.category] or {}) do wanted[kind] = true end
    if temper == 'passive' and M.PASSIVE_COWER[archetype.category] then wanted.cower = true end
    local out = {}
    for _, kind in ipairs(M.KINDS) do if wanted[kind] then out[#out + 1] = kind end end
    return out
end

-- Which of `kinds` the game allows now, from plain facts. Returns the allowed kinds (possibly empty), and when none is allowed the reason
-- text (the first refusal of each kind). Facts:
--   ordinary   false for a companion, another mod's character, a named or story character
--   quest      true when the person is flagged as a quest actor
--   child, hostile, safe     booleans (nil: could not be read, which refuses what depends on it)
--   heat       V's wanted stage (number)           preventionReady   the game's prevention system would react to a crime now
--   refused    the reason the game is in charge (world-talk.lua), or nil
--   reacted    this person already had its one reaction     cooldown   a recent attack, brawl or call
--   commanded  this person obeyed a command a moment ago (commandCooldown)
--   playerMounted   V sits in a vehicle (nil: unread)    (a person in a vehicle: refused == 'vehicle')
--   off        {attack = true, call = true, walk = true, fear = true, hold = true, exit = true}: kinds of native call switched off after failures
-- A person in a vehicle is refused everything (the game is in charge of a ride) except the one command to get out of it, and only while V
-- herself is on foot. Pure.
function M.allowed(kinds, facts)
    if type(kinds) ~= 'table' or #kinds == 0 then return {}, 'no-kind' end
    if type(facts) ~= 'table' then return {}, 'unreadable' end
    if facts.ordinary ~= true then return {}, 'not-ordinary' end
    if facts.quest ~= false then return {}, facts.quest == true and 'quest-flag' or 'unreadable-quest' end
    if facts.reacted == true then return {}, 'already-reacted' end
    if facts.child ~= false then return {}, facts.child == true and 'child' or 'unreadable-child' end
    local riding = facts.refused == 'vehicle'
    if facts.refused and not (riding and has(kinds, 'exit-vehicle')) then return {}, 'game-in-charge:' .. tostring(facts.refused) end
    local off = type(facts.off) == 'table' and facts.off or {}
    local out, why = {}, {}
    for _, kind in ipairs(kinds) do
        local reason
        if riding and kind ~= 'exit-vehicle' then
            reason = 'game-in-charge:vehicle'
        elseif M.COMMANDS[kind] and facts.commanded == true then
            reason = 'command-cooldown'
        elseif kind == 'exit-vehicle' then
            if not riding then reason = 'not-in-vehicle'
            elseif facts.playerMounted ~= false then reason = facts.playerMounted == true and 'v-in-vehicle' or 'unreadable-v-vehicle'
            elseif off.exit then reason = 'exit-switched-off' end
        elseif kind == 'stop' then
            if off.hold then reason = 'hold-switched-off' end
        elseif kind == 'cower' or kind == 'get-down' then
            if off.fear and off.hold then reason = 'fear-switched-off' end
        elseif kind == 'leave' then
            if off.walk then reason = 'walk-switched-off' end
        elseif kind == 'attack' or kind == 'brawl' then
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
    -- continuing: a later leg of one run (no start animation: the person is already running).
    function N.walkTo(npc, point, gait, continuing)
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
        command.useStart = continuing ~= true
        command.useStop = false
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the walk command') end
        return command
    end
    -- The walkable point near the point (within radius metres), or nil.
    function N.snap(npc, point, radius)
        local found = Game.GetAINavigationSystem():FindPointInSphereForCharacter(Vector4.new(point.x, point.y, point.z, 1), radius, npc)
        local p = found and found.status == Enum.new('worldNavigationRequestStatus', 'OK') and found.point or nil
        if p and finite(p.x) and finite(p.y) and finite(p.z) then return {x = p.x, y = p.y, z = p.z} end
        return nil
    end
    function N.commandState(npc, command)
        local label = tostring(npc:GetAIControllerComponent():GetCommandState(command))
        return label:match('^AICommandState%s*:%s*(%w+)%s*%(%d+%)$') or label
    end
    -- Where the person stands, for the read-backs (metres moved).
    function N.position(npc) local p = npc:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    -- A crowd person (the city's pedestrians and the people on its benches and corners). The game moves a crowd person given an
    -- AIMoveToCommand to the end point at once instead of walking it there (a player report, 2026-10-25: `command state=Success` after 1.2 s
    -- and exactly 30.0 m moved by 3 s, three times, all crowd and workspot people), so a crowd person never gets one: it gets the crowd's own fear.
    function N.crowd(npc) return npc:IsCrowd() == true end
    -- The game's own temper of the person: its reaction preset (Ganger_Aggressive, Ganger_Passive, Civilian_Neutral, ...). 'aggressive',
    -- 'passive' or 'neutral'.
    function N.temper(npc)
        local text = tostring(npc:GetStimReactionComponent():GetReactionPreset():Type())
        if text:find('Aggressive', 1, true) then return 'aggressive' end
        if text:find('Passive', 1, true) or text:find('NoReaction', 1, true) then return 'passive' end
        return 'neutral'
    end
    -- The crowd's own fear, the way the game frightens a crowd person (reactionComponent.script OnCrowdReaction): the same event the game
    -- queues to the passengers of a car with a fixed fear phase (vehicles.script TriggerFearInsideVehicleBehavior, TriggerExitBehavior).
    -- phase 2: the person cowers or surrenders where it is (in a seat, the workspot's own fear); 3: it runs away from V along the crowd's
    -- own paths. The game then plays its fear voice, lets nearby people share the fright, and later removes the person out of sight, as it
    -- does for every frightened passer-by. One event, nothing per frame.
    -- The stimulus is a native class (stimuliEvents.script `import final class StimuliEvent`): CET's NewObject knows a native class only by its
    -- native name, so NewObject('StimuliEvent') gave nil in the game (the live test of 2026-10-26: "attempt to index local 'stim' (a nil value)").
    -- The type's own constructor (StimuliEvent.new(), which CET resolves by the script name, as EntityID.new() is) comes first, the native
    -- name second; neither one: an error, and the service falls back to the crowd's fear stage (N.crowdPanic).
    local function stimulus()
        local ok, made = pcall(function() return StimuliEvent.new() end)
        if ok and made ~= nil then return made end
        for _, name in ipairs({'senseStimuliEvent', 'StimuliEvent'}) do
            local okNew, value = pcall(NewObject, name)
            if okNew and value ~= nil then return value end
        end
        error('the stimulus event cannot be made from Lua')
    end
    function N.crowdFear(npc, player, phase)
        local stimType = Enum.new('gamedataStimType', 'Terror')
        local stim = stimulus()
        stim.sourceObject = player
        stim.sourcePosition = player:GetWorldPosition()
        stim:SetStimType(stimType)
        pcall(function()
            local record = Game.GetStimuliSystem():GetStimRecord(stimType)
            if record then stim.stimRecord = record end
        end)
        local event = NewObject('DelayedCrowdReactionEvent')
        if event == nil then error('the crowd reaction event cannot be made from Lua') end
        event.stimEvent = stim
        event.vehicleFearPhase = phase
        npc:QueueEvent(event)
    end
    -- The crowd's fear without the event: the public calls the game's own crowd reaction makes (reactionComponent.script OnCrowdReaction), in
    -- its order. V is the threat, the person may not use a workspot, its high-level state is fear, the fear and fear-locomotion animations are on,
    -- and the crowd member's fear stage is panic (phase 3: the crowd's own flight along its paths) or alarmed (phase 2). A person in a workspot
    -- (a bench, a counter) gets the workspot's own fear reaction, or is asked out of it first. No move command: a crowd person given one is put
    -- at its end point at once. Raises when the crowd member is missing or refuses the stage.
    function N.crowdPanic(npc, player, phase)
        local crowd = npc:GetCrowdMemberComponent()
        if crowd == nil then error('no crowd member component') end
        crowd:SetThreatLastKnownPosition(player:GetWorldPosition())
        crowd:AllowWorkspotsUsage(false)
        pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', 'Fear')) end)
        pcall(function()
            local spots = Game.GetWorkspotSystem()
            if spots:IsActorInWorkspot(npc) then
                if phase < 3 and spots:IsReactionAvailable(npc, CName.new('Fear')) then spots:SendReactionSignal(npc, CName.new('Fear'))
                else spots:SendFastExitSignal(npc) end
            end
        end)
        pcall(function()
            AnimationControllerComponent.SetAnimWrapperWeightOnOwnerAndItems(npc, CName.new(phase >= 3 and 'panic' or 'fear'), 1.0)
            local walk = npc:GetStimReactionComponent():GetRandomFearLocomotionAnimWrapper(phase)
            if walk then AnimationControllerComponent.SetAnimWrapperWeightOnOwnerAndItems(npc, walk, 1.0) end
        end)
        -- The running-away animation input (a script class: NewObject knows it by this name).
        if phase >= 3 then
            pcall(function()
                local feature = NewObject('AnimFeature_CrowdRunningAway')
                if feature ~= nil then
                    feature.isRunningAwayFromPlayersCar = false
                    AnimationControllerComponent.ApplyFeatureToReplicate(npc, CName.new('CrowdRunningAway'), feature)
                end
            end)
        end
        local stage = Enum.new('gameFearStage', phase >= 3 and 'Panic' or 'Alarmed')
        if crowd:ChangeFearStage(stage, true) == false then error('the crowd member refused the fear stage') end
    end
    -- Holds the person where it stands (the command the conversation hold and the companion actuator use). Returns the command.
    function N.hold(npc, seconds)
        local command = NewObject('AIHoldPositionCommand')
        command.duration = seconds
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the hold command') end
        return command
    end
    -- Fists for a brawl: the right hand takes the bare-hands item (failIfItemNotFound off: a person without it keeps what it has, nothing
    -- is added to its inventory). Unconfirmed on ordinary NPCs; the read-back says what the hand holds.
    function N.fists(npc)
        local command = NewObject('AIEquipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        command.itemId = TweakDBID.new('Items.w_melee_004__fists_a')
        pcall(function() command.failIfItemNotFound = false end)
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the fists command') end
        return 'fists asked'
    end
    -- Puts the drawn weapon away (mod/companion-equipment.lua's holster command): the second ask of a brawl whose person drew a weapon.
    function N.holster(npc)
        local command = NewObject('AIUnequipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the holster command') end
    end
    -- What the right hand holds: 'empty', 'fists' or the weapon's record.
    function N.hand(npc)
        local item = ScriptedPuppet.GetWeaponRight(npc)
        if item == nil then return 'empty' end
        local id = item:GetItemID()
        if WeaponObject.IsFists(id) then return 'fists' end
        return tostring(TDBID.ToStringDEBUG(ItemID.GetTDBID(id)) or 'weapon')
    end
    -- Out of the vehicle: the game's own exit event for a passenger (vehicles.script TriggerExitBehavior, `ExitVehicle`), queued to the person.
    function N.exitVehicle(npc)
        local event = NewObject('AIEvent')
        event.name = CName.new('ExitVehicle')
        npc:QueueEvent(event)
    end
    -- A person in a workspot (a bench, a counter, a wall to lean on). The conversation's focus does not hold such a person
    -- (Engagement.reds ConvaiBeginFocus), and a move command puts it at the end point at once (Shandor's report, 2026-10-25).
    function N.workspot(npc) return Game.GetWorkspotSystem():IsActorInWorkspot(npc) == true end
    -- The gun in V's hand: its record, or false (empty hands, fists, a blade). For the brawl's escalation (V draws, the brawlers draw).
    function N.vArmed(player)
        local item = ScriptedPuppet.GetWeaponRight(player)
        if item == nil then return false end
        local id = item:GetItemID()
        if not WeaponObject.IsRanged(id) then return false end
        return tostring(TDBID.ToStringDEBUG(ItemID.GetTDBID(id)) or 'gun')
    end
    -- A brawler draws its own weapon. Live test 4 (2026-10-27): the game's weapon switch command (AISwitchToPrimaryWeaponCommand) was taken
    -- ("1 of 1 draw") and nothing changed: the fists we equipped stayed. So the gun is equipped the same way the fists were, with the equip
    -- command into the right hand: the weapon the person was seen holding (`record`, read before it was put away), else the first ranged
    -- weapon it carries, else the switch command as the last way. Returns how it was asked.
    local function equipRight(npc, record)
        local command = NewObject('AIEquipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        command.itemId = TweakDBID.new(record)
        pcall(function() command.failIfItemNotFound = false end)
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the equip command') end
    end
    local function carriedGun(npc)
        local results = {pcall(function() return Game.GetTransactionSystem():GetItemList(npc) end)}
        if not results[1] then return nil end
        for index = 2, #results do
            if type(results[index]) == 'table' then
                for _, data in ipairs(results[index]) do
                    local okId, id = pcall(function() return data:GetID() end)
                    if okId and id ~= nil and WeaponObject.IsRanged(id) then return tostring(TDBID.ToStringDEBUG(ItemID.GetTDBID(id))) end
                end
            end
        end
        return nil
    end
    function N.weapons(npc, record)
        if type(record) == 'string' and record ~= '' then equipRight(npc, record); return 'equip ' .. record end
        local carried = carriedGun(npc)
        if carried then equipRight(npc, carried); return 'equip ' .. carried .. ' (carried)' end
        local command = NewObject('AISwitchToPrimaryWeaponCommand')
        if command == nil then error('the weapon switch command cannot be made from Lua') end
        command.unEquip = false
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the game refused the weapon switch') end
        return 'switch command'
    end
    -- The scared pose while a person is held (cower, get down): the fear animation set the game's crowd reaction turns on for its phase 2
    -- (reactionComponent.script GetFearAnimWrapper(2) = 'fear'), on, and off again when the hold ends. No crowd fear: on a walking crowd
    -- person that is the crowd's Surrender reaction, a second's cower before the crowd's alarmed stage walks it off (live test 4: 39 m in the
    -- 20 s hold, the hold never ran).
    function N.scared(npc, on)
        AnimationControllerComponent.SetAnimWrapperWeightOnOwnerAndItems(npc, CName.new('fear'), on and 1.0 or 0.0)
    end
    -- The people who joined the person's fight, within `radius` of V, from two places: the person's own squad (AISquadHelper.GetSquadmatesID,
    -- the gang it stands with; live test 4 found 0 with the targeting search alone while the gang joined), in combat or hostile to V, and one
    -- search of the game's targeting system, hostile to V. Returns the list and {squad = n, nearby = n}.
    function N.joined(player, npc, radius)
        local own, result, seen, counts = tostring(npc:GetEntityID().hash), {}, {}, {squad = 0, nearby = 0}
        local centre = player:GetWorldPosition()
        local function near(entity)
            local okAt, at = pcall(function() return entity:GetWorldPosition() end)
            if not okAt or at == nil then return false end
            return math.sqrt((at.x - centre.x) ^ 2 + (at.y - centre.y) ^ 2 + (at.z - centre.z) ^ 2) <= radius
        end
        local function take(entity, from)
            if not entity or not entity:IsNPC() then return end
            local key = tostring(entity:GetEntityID().hash)
            if key == own or seen[key] then return end
            seen[key] = true
            -- The squad: fighting or hostile to V (a friend of the brawler); anyone else only when hostile to V (never a person fighting someone else).
            local hostile = attitudeName(entity, player) == 'AIA_Hostile'
            if (hostile or (from == 'squad' and NPCPuppet.IsInCombat(entity) == true)) and near(entity) then
                result[#result + 1] = entity
                counts[from] = counts[from] + 1
            end
        end
        pcall(function()
            local outs = {AISquadHelper.GetSquadmatesID(npc)}
            for index = 1, #outs do
                if type(outs[index]) == 'table' then
                    for _, id in ipairs(outs[index]) do take(Game.FindEntityByID(id), 'squad') end
                end
            end
        end)
        local query = TargetSearchQuery.new()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = radius
        query.includeSecondaryTargets = false
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        query.testedSet = Enum.new('TargetingSet', 'Complete')
        local _, parts = Game.GetTargetingSystem():GetTargetParts(player, query)
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            take(component and component:GetEntity(), 'nearby')
        end
        return result, counts
    end
    function N.mounted(npc) return Game.GetMountingFacility():IsMountedToAnything(npc:GetEntityID()) == true end
    function N.playerMounted(player) return Game.GetMountingFacility():IsMountedToAnything(player:GetEntityID()) == true end
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
--   threats()           the Companion Manager switch "NPCs react to threats and commands" is on (read once per offer; absent or false: off)
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
    local commanded, commandedCount = {}, 0
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
        -- The crowd fear counts as off only when both of its ways are (the event and the fear stage).
        local f = {off = {attack = off.attack, call = off.call, walk = off.walk, fear = off.fear and (off.panic or not natives.crowdPanic), hold = off.hold, exit = off.exit}}
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
        -- Read only for a person in a vehicle (the one command it may get), and only by an adapter that has it.
        if f.refused == 'vehicle' and natives.playerMounted then read('playerMounted', 'read-mount', natives.playerMounted, player) end
        f.reacted = not fresh and reacted[entity] ~= nil
        f.cooldown = mode ~= 'run' and cooling(now)
        f.commanded = mode ~= 'run' and commanded[entity] ~= nil and now - commanded[entity] < cfg.commandCooldown
        return f
    end

    -- The threats switch, read once per offer (a manager read, never per frame). Absent or failing: off.
    local function threatsOn()
        if type(options.threats) ~= 'function' then return false end
        local ok, value = pcall(options.threats)
        return ok and value == true
    end

    -- The offer for V's message that is being admitted (mod/gameplay-actions.lua capture): {available, actor, kinds}, or nil. context: the
    -- request (entity, profileKey, archetype).
    function S.offer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        local threats = threatsOn()
        local kinds = M.kindsFor(context.archetype, threats)
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
        -- The person's own temper (a passive ganger may also cower; the game's plan reads it on both sides of the switch), one read per offer.
        local temper
        if natives.temper then
            local okTemper, value = guard('read-temper', natives.temper, npc)
            if okTemper then temper = value end
            if threats then kinds = M.kindsFor(context.archetype, true, temper) end
        end
        local allowed, why = M.allowed(kinds, facts(npc, player, entity))
        if #allowed == 0 then
            logOnce('npc-reaction-no:' .. entity .. ':' .. tostring(why), 'NPC reaction not offered: ' .. tostring(why) .. ' (' .. tostring(context.archetype.base or context.archetype.category) .. ')')
            return nil
        end
        -- The game decides (M.plan, the owner's rule of 2026-10-26) on BOTH sides of the switch: what this person does for each clear reading of
        -- V's words, from the kinds allowed now. With the switch off those are the old three (leave, call the police, attack): live test 3
        -- (2026-10-27, game 2.31, the switch off there) waited for a model tag on every threat, and none came.
        local plan = M.plan(context.archetype, temper, allowed, M.seed(entity))
        log('NPC reaction offered: kinds=' .. table.concat(allowed, ',') .. ' type=' .. tostring(context.archetype.base or context.archetype.category)
            .. ' message=' .. tostring(count) .. (threats and ' threats=on' or '') .. ' temper=' .. tostring(temper or '?') .. ' plan=' .. (plan and planText(plan) or '-'))
        -- `threats` tells the bridge to narrow the model's kinds by V's words (bridge/threat-screen.mjs); `plan` is what the game picked for each reading.
        return {available = true, actor = {id = entity, key = context.profileKey}, kinds = allowed, threats = threats or nil, plan = plan}
    end

    local function release(player)
        if type(options.release) == 'function' then pcall(options.release, player) end
    end

    -- Is this a crowd person? Only an adapter that can say (natives.crowd) is asked; a read that fails says no.
    local function crowdOf(npc)
        if not natives.crowd then return false end
        local ok, value = guard('read-crowd', natives.crowd, npc)
        return ok and value == true
    end
    local function where(npc)
        if not natives.position then return nil end
        local ok, value = pcall(natives.position, npc)
        return ok and type(value) == 'table' and value or nil
    end
    -- The crowd's own fear for a crowd person: phase 3 runs away, phase 2 cowers. First the game's crowd reaction event (natives.crowdFear);
    -- when it cannot be sent, the same fear through the crowd member's own calls (natives.crowdPanic, the fear stage). Never a move command.
    -- One read-back of the metres moved; a person who should flee and has not moved by then is asked once more with the fear stage.
    local function crowdFear(p, player, phase, why)
        local from = where(p.npc)
        local how
        if not off.fear and guard('fear', natives.crowdFear, p.npc, player, phase) then how = 'event'
        elseif natives.crowdPanic and not off.panic and guard('panic', natives.crowdPanic, p.npc, player, phase) then how = 'stage' end
        if not how then return false end
        log('NPC reaction: ' .. why .. ' started, the crowd\'s own ' .. (phase >= 3 and 'flight' or 'fear') .. ' ('
            .. (how == 'event' and 'the crowd reaction event' or 'the fear stage') .. ', no move command)')
        checks[#checks + 1] = {at = clock() + cfg.fleeVerify, kind = 'moved', npc = p.npc, from = from, why = why, seconds = cfg.fleeVerify,
            phase = phase, how = how, player = player}
        return true
    end

    local function seatedOf(npc)
        if not natives.workspot then return false end
        local ok, value = guard('read-workspot', natives.workspot, npc)
        return not ok or value == true   -- unreadable: treated as seated (never a move command that could put it somewhere at once)
    end
    local function distance(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + (a.z - b.z) ^ 2) end
    -- The next leg of a crowd person's run: at most `length` metres from `at` toward `goal`, on the navmesh when it can be snapped.
    local function legTo(npc, at, goal, length)
        local gap = distance(at, goal)
        local share = gap > length and length / gap or 1
        local point = {x = at.x + (goal.x - at.x) * share, y = at.y + (goal.y - at.y) * share, z = at.z + (goal.z - at.z) * share}
        if share < 1 and natives.snap then
            local ok, snapped = guard('walk', natives.snap, npc, point, cfg.awaySnap)
            if ok and type(snapped) == 'table' then point = snapped end
        end
        return point
    end

    -- A crowd person who walks (not seated) is run away by us, with the mechanism that already stops a crowd person when V talks to it: the
    -- conversation's focus holds it with an AIHoldPositionCommand (r6/scripts/CyberpunkConvai/Engagement.reds ConvaiBeginFocus), which takes it
    -- out of the crowd's traffic while the command runs. Let go first (the first build did: release, then the crowd event) and the crowd's
    -- traffic has it back at once: the person walks on (live test 2, 2026-10-27). So the person gets its own command while the conversation's
    -- hold still runs, and only then is the hold let go. The run is short legs (`legLength` m, the next one sent each `legCheck` s before the
    -- last one ends), each read back: a person that covers a leg faster than anyone runs (`runSpeedMax`) was put there, not run there, and gets
    -- no further move (the crowd's fear instead), so the worst jump is one leg. The crowd reaction event goes first: the game's own fright for
    -- the people around (they run, the owner's wish), its fear face and voice for the person.
    local function crowdRun(p, player, why)
        if not natives.walkTo then return false end
        local ok, points = guard('walk', natives.awayPoints, p.npc, player, cfg)
        local from = where(p.npc)
        if not ok or type(points) ~= 'table' or #points == 0 or not from then return false end
        if not off.fear then guard('fear', natives.crowdFear, p.npc, player, 3) end
        local leg = legTo(p.npc, from, points[1], cfg.legProbe)
        local started, command = guard('walk', natives.walkTo, p.npc, leg, 'Run')
        if not started then return false end
        release(player)
        log('NPC reaction: ' .. why .. ' started, taken from the crowd and run away in legs (' .. string.format('%.0f', points[1].gap)
            .. ' m from V; the conversation\'s hold let go after the first leg was sent)')
        checks[#checks + 1] = {at = clock() + cfg.probeAfter, kind = 'leg', npc = p.npc, command = command, goal = points[1], from = from, legFrom = from,
            sentAt = clock(), legs = 1, why = why, player = player, entity = p.entity}
        return true
    end

    -- The walk away: V's hold on the person is let go, then one command to the first walkable point away from V. A crowd person who walks is
    -- run away in legs (crowdRun); a seated one, or one that cannot be run, gets the crowd's own flight: a single move command puts a crowd
    -- person at its end point in an instant (the person "disappears").
    local function walkAway(p, player, why)
        if crowdOf(p.npc) then
            if not seatedOf(p.npc) and crowdRun(p, player, why) then return true end
            release(player)
            if crowdFear(p, player, 3, why) then return true end
            -- Neither the event nor the fear stage could be sent (both switched off after failures): no move command either (it would put the
            -- person 30 m off in an instant), so the honest outcome is written.
            logOnce('npc-reaction-nofear', 'NPC reaction: neither the crowd\'s reaction event nor its fear stage is available for ' .. why .. '; the person stays')
            return false
        end
        release(player)
        local gait = M.RUNS[p.category] and 'Run' or 'Walk'
        local ok, points = guard('walk', natives.awayPoints, p.npc, player, cfg)
        if not ok or type(points) ~= 'table' or #points == 0 then
            logOnce('npc-reaction-nopoint', 'NPC reaction: no walkable point away from V for ' .. why .. '; the person stays')
            return false
        end
        local from = where(p.npc)
        local started, command = guard('walk', natives.walkTo, p.npc, points[1], gait)
        if not started then return false end
        log('NPC reaction: ' .. why .. ' started, ' .. gait:lower() .. ' away (' .. string.format('%.0f', points[1].gap) .. ' m from V)')
        checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'walk', npc = p.npc, command = command, points = points, tried = 1, gait = gait, why = why, entity = p.entity,
            from = from}
        return true
    end

    -- Cower or get down. A crowd person who walks is held FIRST, while the conversation's hold still runs (the same command that stops it when
    -- V talks to it, see crowdRun), put in the scared pose, and only then is the conversation let go; it goes back to the crowd when the hold
    -- ends (`cowerHold`). No crowd fear for it (live test 4, 2026-10-27: the crowd's phase 2 is its Surrender reaction, a second's cower, then
    -- the crowd's alarmed stage walked the man off 39 m while our hold stayed `Enqueued`). A hold that is not running at the first read-back is
    -- sent once more for the rest of the time. A seated crowd person gets the seat's own fear (the event, phase 2); anyone else holds still.
    local function cower(p, player, why)
        local crowd = crowdOf(p.npc)
        if crowd and seatedOf(p.npc) then
            release(player)
            if crowdFear(p, player, 2, why) then return true end
        end
        local from = where(p.npc)
        local ok, command = guard('hold', natives.hold, p.npc, cfg.cowerHold)
        if not ok then release(player); return false end
        local posed = natives.scared ~= nil and (guard('pose', natives.scared, p.npc, true))
        release(player)
        log('NPC reaction: ' .. why .. ' started, holds still for ' .. cfg.cowerHold .. ' s'
            .. (crowd and ', taken from the crowd before the conversation let go' or ' (not a crowd person)')
            .. (posed and ', in the scared pose (no crowd fear)' or ''))
        local endsAt = clock() + cfg.cowerHold
        checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'hold', npc = p.npc, command = command, why = why, from = from,
            showFrom = crowd, again = true, endsAt = endsAt}
        checks[#checks + 1] = {at = endsAt, kind = 'back', npc = p.npc, why = why, from = from, crowd = crowd, posed = posed}
        return true
    end

    -- A reaction that actually started, for Street reputation (mod/reputation.lua; options.onReaction is set only while that setting is on).
    -- A brawl is the same deed as an attack and a cower the same as a person fleeing; a command V gave is no deed (reputation.lua ignores it).
    local DEED = {brawl = 'attack', cower = 'leave'}
    local function started(kind, p)
        kind = DEED[kind] or kind
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
        elseif p.kind == 'attack' or p.kind == 'brawl' then
            release(player)
            local hostile = guard('attack', natives.makeHostile, p.npc, player)
            local combat, way = guard('attack', natives.startCombat, p.npc, player)
            -- A brawl: the person's hand takes its fists (a weapon only for a death threat, the plain attack).
            local fists, how = false, nil
            if p.kind == 'brawl' and natives.fists then fists, how = guard('fists', natives.fists, p.npc) end
            log('NPC reaction: ' .. p.kind .. ' ' .. (hostile and 'hostile ok' or 'hostile failed') .. ', combat start ' .. (combat and tostring(way) or 'failed')
                .. (p.kind == 'brawl' and (', fists ' .. (fists and tostring(how) or 'not asked')) or ''))
            if hostile or combat then
                started(p.kind, p)
                -- A brawl is one fight of the person and the friends who join it (the first read-back finds them). It escalates when V does:
                -- the moment V holds a gun, every one of them draws its own weapon, and never goes back to fists (the owner's rule, 2026-10-27).
                -- Watched once a second while the brawl lasts (`escalateWatch`), never per frame.
                -- weapons[i]: the weapon person i was seen holding (equipped again when the brawl escalates); how[i]: how its draw was asked.
                local fight = p.kind == 'brawl' and {npcs = {p.npc}, weapons = {}, how = {}, keys = {[p.entity] = true}, escalated = false, player = player} or nil
                -- The watch first: when both come due together, V's gun is read before anything is put away.
                if fight and natives.vArmed and natives.weapons then
                    checks[#checks + 1] = {at = clock() + cfg.escalateEvery, kind = 'escalate', fight = fight, untilAt = clock() + cfg.escalateWatch}
                end
                checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'attack', npc = p.npc, entity = p.entity, brawl = p.kind == 'brawl', fight = fight}
                -- The friends searched again a few seconds in: a gang joins its friend's fight over a few seconds.
                for index, seconds in ipairs(fight and cfg.joinAgain or {}) do
                    checks[#checks + 1] = {at = clock() + seconds, kind = 'join', fight = fight, search = index + 1}
                end
            end
        elseif p.kind == 'cower' or p.kind == 'get-down' then
            if cower(p, player, p.kind) then started(p.kind, p) end
        elseif p.kind == 'stop' then
            -- The conversation's own hold already keeps the person here while V talks; this one outlasts it. No release: the talk goes on.
            local ok, command = guard('hold', natives.hold, p.npc, cfg.stopHold)
            if ok then
                log('NPC reaction: stop started, holds still for ' .. cfg.stopHold .. ' s')
                checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'hold', npc = p.npc, command = command, why = 'stop'}
                started('stop', p)
            end
        elseif p.kind == 'exit-vehicle' then
            release(player)
            local ok = guard('exit', natives.exitVehicle, p.npc)
            if ok then
                log('NPC reaction: exit-vehicle started, the game\'s own exit')
                checks[#checks + 1] = {at = clock() + cfg.exitVerify, kind = 'exit', npc = p.npc}
                started('exit-vehicle', p)
            end
        elseif p.kind == 'call-police' then
            local before = select(2, guard('read-heat', natives.heat))
            local called = guard('call', natives.callPolice, player)
            log('NPC reaction: police call ' .. (called and 'sent' or 'failed') .. ' (stage before ' .. tostring(before) .. ')')
            if called then checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'police', before = before}; started('call-police', p) end
            if not M.STAYS[p.category] then walkAway(p, player, 'run after the police call') end
        end
    end

    -- Metres from `from` to where the person stands now, or nil.
    local function moved(npc, from)
        local now = from and where(npc)
        if not now then return nil end
        return math.sqrt((now.x - from.x) ^ 2 + (now.y - from.y) ^ 2 + (now.z - from.z) ^ 2)
    end
    local function metres(value) return value and string.format('%.1f', value) or '?' end

    -- A brawler draws its weapon (the escalation): the one it was seen holding, else what it carries. Returns true when the ask was sent.
    local function arm(fight, index)
        local okArm, how = guard('weapons', natives.weapons, fight.npcs[index], fight.weapons[index])
        fight.how[index] = okArm and tostring(how) or 'failed'
        return okArm
    end
    -- The friends who joined a brawl, searched at its first read-back and again `joinAgain` seconds after it began (live test 4: the gang
    -- joined, the one search at 1.2 s found none). Each new one is an ordinary person by the same rails as the brawler (never a companion,
    -- another mod's character, a story or quest character, a child): its weapon is remembered, then put away and fists asked, or, once V has
    -- escalated, drawn. A few searches per brawl, never per frame.
    local function joinFight(fight, search)
        if not natives.joined or #fight.npcs >= cfg.buddyMax + 1 then return end
        local found, list, counts = guard('read-joined', natives.joined, fight.player, fight.npcs[1], cfg.buddyRadius)
        counts = type(counts) == 'table' and counts or {}
        local asked, drew = 0, 0
        for _, buddy in ipairs(found and type(list) == 'table' and list or {}) do
            if #fight.npcs >= cfg.buddyMax + 1 then break end
            local okKey, key = pcall(natives.key, buddy)
            key = okKey and key or buddy
            if not fight.keys[key] then
                local policy = type(options.policy) == 'table' and options.policy or {}
                local okPolicy, ordinary = pcall(function()
                    return policy.ours(buddy) ~= true and policy.spawned(buddy) ~= true and policy.protected(buddy) ~= true and policy.story(buddy) ~= true
                end)
                local okFlag, flagged = pcall(function() return options.storyFlag(buddy, nil) end)
                local okChild, child = guard('read-child', natives.child, buddy)
                if okPolicy and ordinary == true and okFlag and flagged == false and okChild and child == false then
                    fight.keys[key] = true
                    asked = asked + 1
                    local okHand, held = guard('read-hand', natives.hand, buddy)
                    local index = #fight.npcs + 1
                    fight.npcs[index] = buddy
                    if okHand and held ~= 'fists' and held ~= 'empty' then fight.weapons[index] = held end
                    if fight.escalated then
                        arm(fight, index)
                    else
                        if fight.weapons[index] and natives.holster then drew = drew + 1; guard('fists', natives.holster, buddy) end
                        if natives.fists then guard('fists', natives.fists, buddy) end
                    end
                end
            end
        end
        log('NPC reaction: brawl joined by ' .. asked .. ' more (search ' .. search .. ' of ' .. (1 + #cfg.joinAgain) .. ': squad ' .. tostring(counts.squad or '?')
            .. ', nearby ' .. tostring(counts.nearby or '?') .. ')'
            .. (asked > 0 and (fight.escalated and ', asked to draw (V has a gun out)' or (', asked for fists (' .. drew .. ' had a weapon out, asked to put it away)')) or ''))
    end

    -- One read-back per reaction, logged: what the game did with it. Never retried except a walk the game did not take.
    local function check(v)
        if v.kind == 'walk' then
            local ok, state = guard('read-command', natives.commandState, v.npc, v.command)
            local gone = moved(v.npc, v.from)
            -- A walk cannot cover `jump` metres in the first read-back's 1.2 s: the person was put there (the crowd case, docs/NPC_THREATS_COMMANDS.md).
            log('NPC reaction check: ' .. v.why .. ' command state=' .. (ok and tostring(state) or 'unreadable')
                .. (v.from and (' moved=' .. metres(gone) .. ' m' .. ((gone or 0) >= cfg.jump and ' (jumped, not walked)' or '')) or ''))
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
            local hand
            if v.brawl and natives.hand then local okHand, value = guard('read-hand', natives.hand, v.npc); hand = okHand and tostring(value) or 'unreadable' end
            log('NPC reaction check: ' .. (v.brawl and 'brawl' or 'attack') .. ' in_combat=' .. (okCombat and tostring(combat) or 'unreadable') .. ' hostile_to_v=' .. (okHostile and tostring(hostile) or 'unreadable')
                .. (hand and (' hand=' .. hand) or ''))
            local escalated = v.fight ~= nil and v.fight.escalated
            -- The weapon the brawler holds is remembered: the escalation equips that same one again (live test 4).
            if v.fight and hand and hand ~= 'fists' and hand ~= 'empty' and hand ~= 'unreadable' then v.fight.weapons[1] = v.fight.weapons[1] or hand end
            -- A brawl whose person drew a weapon: the weapon is put away once (its fists are what an insult earns), unless V already escalated.
            if v.brawl and hand and hand ~= 'fists' and hand ~= 'empty' and hand ~= 'unreadable' and not v.holstered and natives.holster and not escalated then
                local put = guard('fists', natives.holster, v.npc)
                log('NPC reaction: brawl drew ' .. hand .. ', asked to put it away (' .. (put and 'sent' or 'failed') .. ')')
                v.holstered = true
            end
            -- The friends who joined the brawl: searched now and again later (joinFight).
            if v.brawl and v.fight and not v.fight.searched then
                v.fight.searched = true
                joinFight(v.fight, 1)
            end
            -- Hostile but not fighting a second later (a person who has not noticed V): one stronger ask, then one more read-back.
            if okCombat and combat == false and not v.engaged and okHostile then
                local engaged, how = guard('attack', natives.engage, v.npc, player)
                log('NPC reaction: not in combat yet, asked again (' .. (engaged and tostring(how) or 'failed') .. ')')
                if engaged then checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'attack', npc = v.npc, entity = v.entity, engaged = true, brawl = v.brawl, holstered = v.holstered, fight = v.fight} end
            end
        elseif v.kind == 'police' then
            local ok, heat = guard('read-heat', natives.heat)
            log('NPC reaction check: police stage ' .. tostring(v.before) .. ' -> ' .. (ok and tostring(heat) or 'unreadable'))
        elseif v.kind == 'moved' then
            local gone = moved(v.npc, v.from)
            local attached = true
            pcall(function() attached = v.npc:IsAttached() ~= false end)
            log('NPC reaction check: ' .. v.why .. ' crowd moved=' .. metres(gone) .. ' m in ' .. tostring(v.seconds) .. ' s' .. (attached and '' or ' (streamed out)'))
            -- Fled but still where it stood (the event reached a handler that did nothing): once more with the fear stage, then one more read-back.
            if v.phase and v.phase >= 3 and attached and gone ~= nil and gone < cfg.fleeMin and not v.again and natives.crowdPanic and not off.panic then
                local here = where(v.npc)
                local asked = guard('panic', natives.crowdPanic, v.npc, v.player, v.phase)
                log('NPC reaction: ' .. v.why .. ' did not move; asked again with the fear stage (' .. (asked and 'sent' or 'failed') .. ')')
                if asked then
                    checks[#checks + 1] = {at = clock() + cfg.fleeVerify, kind = 'moved', npc = v.npc, from = here, why = v.why, seconds = cfg.fleeVerify,
                        phase = v.phase, how = 'stage', player = v.player, again = true}
                end
            end
        elseif v.kind == 'hold' then
            local ok, state = guard('read-command', natives.commandState, v.npc, v.command)
            log('NPC reaction check: ' .. v.why .. ' hold state=' .. (ok and tostring(state) or 'unreadable') .. (v.showFrom and (' moved=' .. metres(moved(v.npc, v.from)) .. ' m') or ''))
            -- Not running (live test 4: `Enqueued`, behind something else the person was doing): sent once more for the rest of the hold.
            local left = v.endsAt and v.endsAt - clock() or 0
            if v.again and ok and state ~= 'Executing' and left > 1 and not off.hold then
                local sent, command = guard('hold', natives.hold, v.npc, left)
                log('NPC reaction: ' .. v.why .. ' hold was ' .. tostring(state) .. ', sent again for ' .. string.format('%.0f', left) .. ' s (' .. (sent and 'sent' or 'failed') .. ')')
                if sent then checks[#checks + 1] = {at = clock() + cfg.verifyAfter, kind = 'hold', npc = v.npc, command = command, why = v.why, from = v.from, showFrom = v.showFrom} end
            end
        elseif v.kind == 'back' then
            -- The hold is over: the scared pose off, a crowd person back to the crowd (one line, so a person that never stayed shows up).
            local calm = v.posed and natives.scared ~= nil and (guard('pose', natives.scared, v.npc, false))
            log('NPC reaction check: ' .. v.why .. ' hold over' .. (v.crowd and ', back to the crowd' or '') .. ' (moved=' .. metres(moved(v.npc, v.from)) .. ' m in the hold'
                .. (v.posed and (calm and ', scared pose off' or ', scared pose not reset') or '') .. ')')
        elseif v.kind == 'leg' then
            local now, here = clock(), where(v.npc)
            local attached = true
            pcall(function() attached = v.npc:IsAttached() ~= false end)
            if not here or not attached then
                log('NPC reaction check: ' .. v.why .. ' run over after ' .. v.legs .. ' leg(s): the person streamed out (out of sight)')
            else
                local covered, elapsed = distance(here, v.legFrom), math.max(0.05, now - v.sentAt)
                local total = distance(here, v.from)
                if covered >= cfg.legJumpMin and covered / elapsed > cfg.runSpeedMax then
                    -- Put there, not run there: no further move. The crowd's own fear from here (the worst jump was this one leg).
                    log('NPC reaction check: ' .. v.why .. ' leg ' .. v.legs .. ' moved=' .. metres(covered) .. ' m in ' .. string.format('%.1f', elapsed)
                        .. ' s (jumped, not run); no more moves, the crowd\'s fear instead')
                    if natives.crowdPanic and not off.panic then guard('panic', natives.crowdPanic, v.npc, v.player, 3) end
                elseif distance(here, v.goal) <= cfg.legArrive or v.legs >= cfg.legsMax then
                    log('NPC reaction check: ' .. v.why .. ' ran ' .. metres(total) .. ' m in ' .. v.legs .. ' leg(s); back to the crowd')
                elseif covered < cfg.legStall then
                    if not v.stalled then
                        v.stalled, v.at = true, now + cfg.legCheck
                        checks[#checks + 1] = v
                    else
                        local ok, state = guard('read-command', natives.commandState, v.npc, v.command)
                        log('NPC reaction check: ' .. v.why .. ' did not run (leg ' .. v.legs .. ' moved=' .. metres(covered) .. ' m, command state='
                            .. (ok and tostring(state) or 'unreadable') .. '); the crowd\'s fear instead')
                        if natives.crowdPanic and not off.panic then guard('panic', natives.crowdPanic, v.npc, v.player, 3) end
                    end
                else
                    if v.legs == 1 then
                        log('NPC reaction check: ' .. v.why .. ' first leg moved=' .. metres(covered) .. ' m in ' .. string.format('%.1f', elapsed) .. ' s (running)')
                    end
                    -- The next leg from where the person is, sent before this one ends: one run, no stop and no start animation between legs.
                    local leg = legTo(v.npc, here, v.goal, cfg.legLength)
                    local started, command = guard('walk', natives.walkTo, v.npc, leg, 'Run', true)
                    if started then
                        checks[#checks + 1] = {at = now + cfg.legCheck, kind = 'leg', npc = v.npc, command = command, goal = v.goal, from = v.from,
                            legFrom = here, sentAt = now, legs = v.legs + 1, why = v.why, player = v.player, entity = v.entity}
                    else
                        log('NPC reaction check: ' .. v.why .. ' the next leg was refused after ' .. metres(total) .. ' m')
                    end
                end
            end
        elseif v.kind == 'escalate' then
            -- Once a second while the brawl lasts: V holding a gun makes every brawler draw its own weapon, once, for good.
            local fight = v.fight
            local now = clock()
            local alive = 0
            for _, npc in ipairs(fight.npcs) do
                local ok, up = guard('read-alive', natives.alive, npc)
                if ok and up then alive = alive + 1 end
            end
            if not fight.escalated and alive > 0 then
                local ok, gun = guard('read-v-weapon', natives.vArmed, fight.player)
                if ok and gun then
                    fight.escalated = true
                    local drew, ways = 0, {}
                    for index = 1, #fight.npcs do
                        if arm(fight, index) then drew = drew + 1 end
                        ways[#ways + 1] = fight.how[index]
                    end
                    log('NPC reaction: V drew ' .. tostring(gun) .. '; the brawl escalates: ' .. drew .. ' of ' .. #fight.npcs .. ' draw their own weapons ('
                        .. table.concat(ways, '; ') .. ')')
                    -- Every brawler's hand read back once: who holds a gun now, and one more ask for anyone who does not.
                    if natives.hand then checks[#checks + 1] = {at = now + cfg.armVerify, kind = 'armed', fight = fight} end
                elseif ok and now + cfg.escalateEvery <= v.untilAt then
                    v.at = now + cfg.escalateEvery
                    checks[#checks + 1] = v
                end
            end
        elseif v.kind == 'join' then
            joinFight(v.fight, v.search)
        elseif v.kind == 'armed' then
            -- After the escalation: each brawler's hand, by person; a hand still on fists or empty is asked once more without the remembered
            -- weapon (the first ranged weapon it carries, else the game's switch command), then read back one last time.
            local fight, hands, armed = v.fight, {}, 0
            for index, npc in ipairs(fight.npcs) do
                local okHand, held = guard('read-hand', natives.hand, npc)
                held = okHand and tostring(held) or 'unreadable'
                local bare = held == 'fists' or held == 'empty'
                if not bare and held ~= 'unreadable' then armed = armed + 1 end
                if bare and not v.again then
                    local okAgain, how = guard('weapons', natives.weapons, npc, nil)
                    held = held .. ' -> asked again (' .. (okAgain and tostring(how) or 'failed') .. ')'
                end
                hands[#hands + 1] = held
            end
            log('NPC reaction check: brawl escalated, ' .. armed .. ' of ' .. #fight.npcs .. ' hold a weapon (' .. table.concat(hands, ', ') .. ')')
            if not v.again and armed < #fight.npcs then checks[#checks + 1] = {at = clock() + cfg.armVerify, kind = 'armed', fight = fight, again = true} end
        elseif v.kind == 'exit' then
            local ok, mounted = guard('read-mount', natives.mounted, v.npc)
            log('NPC reaction check: exit-vehicle ' .. (ok and (mounted and 'still in the vehicle' or 'out of the vehicle') or 'unreadable'))
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
        local now = clock()
        if M.COMMANDS[kind] then
            -- A command is not the person's one reaction: it only keeps the next command away for a moment.
            if commandedCount >= cfg.limit then commanded, commandedCount = {}, 0 end
            commanded[entity], commandedCount = now, commandedCount + 1
        else
            if reactedCount >= cfg.limit then reacted, reactedCount = {}, 0 end
            reacted[entity], reactedCount = now, reactedCount + 1
        end
        if M.HOSTILE[kind] then lastHostile = now end
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
        commanded, commandedCount = {}, 0
    end

    function S.inspect()
        return {pending = pending ~= nil and pending.kind or nil, off = {attack = off.attack, call = off.call, walk = off.walk, fear = off.fear, panic = off.panic, hold = off.hold, exit = off.exit},
            failures = failures, cooling = cooling(clock()), reacted = reactedCount}
    end
    function S.cancel(entity)
        if pending and (entity == nil or pending.entity == entity) then pending = nil end
    end
    return S
end

return M
