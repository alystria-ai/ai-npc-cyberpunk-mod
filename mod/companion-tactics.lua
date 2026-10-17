-- Companion tactics against the target chosen from the game's own tagging: Fight.
--
-- Ownership: while a tactic runs, this module supplies the movement decision for
-- exactly one managed copy through companions.tactics (owns/decide); the
-- companion's actuator still issues every native command, so there is one owner
-- per movement command. Fighting releases movement to native combat AI.
-- Every native change (hostility, the persistent threat, the reaction preset,
-- a weapon draw) is recorded and restored on completion or cancellation; world
-- teardown forgets handles without native calls.
local M = {}
local KINDS = {fight = true}
local DEFAULTS = {
    -- maxOfferDistance follows the tag radius of companion-marking.lua (100 m).
    maxOfferDistance = 100, fightApproach = 8, fightStartTimeout = 25, fightTimeout = 180,
    -- Combat start: the first request is made in startFight; if she is not in combat engageReadback seconds later the next
    -- stage re-asserts it (up to ENGAGE_STAGES). Without combat after the last stage she is at the target (within
    -- fightApproach + arriveSlack) for arriveGrace seconds, or fightStartTimeout passes, the order is given up.
    engageReadback = 1.0, arriveSlack = 3, arriveGrace = 4,
    -- After a tactic ends: the stance and high-level state are looked at every restoreGap seconds for at most
    -- restoreLimit seconds; a hostile threat that is not ours holds the restore back until it is gone.
    restoreGap = 0.4, restoreLimit = 14, threatRetry = 6, restoreCalm = 1.0, standGap = 0.6, holsterWatch = 9,
    -- Watching the fight: the evidence is read every observeGap seconds; a fight lost for lostGrace seconds sends her back to
    -- the target; a status line every statusGap seconds, statusMax lines at most.
    observeGap = 0.25, lostGrace = 3, statusGap = 5, statusMax = 12,
    -- Weapon draw: the switch-to-primary command, read back after drawReadback; an empty hand then gets the explicit
    -- equip, read back after drawReadback; then the bare slot equip, read back after drawRetryReadback.
    offerTtl = 125, drawReadback = 1.0, drawRetryReadback = 2.0,
    -- Once the engage stages are used up and there is still no fight, the combat target is set and the fight asked for again
    -- every reassertGap seconds (a few native calls each; only while the order is pending).
    reassertGap = 3,
    -- The target's squadmates within squadRadius metres of him (at most squadMax of them) are put into the fight.
    squadRadius = 40, squadMax = 12,
    -- A threat removed from her tracker is read again threatCheck seconds into the restore (her senses can list a hostile
    -- in view again at once); a weapon still drawn after holsterWatch seconds is asked for again, holsterTries times.
    threatCheck = 1.0, holsterTries = 2,
}
local DRAW_STAGES = {'switch', 'equip', 'slot'}
local ENGAGE_STAGES = 3

local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
local function toward(from, to, stop)
    local dx, dy = from.x - to.x, from.y - to.y
    local length = math.sqrt(dx * dx + dy * dy)
    if length < 0.01 then dx, dy, length = 1, 0, 1 end
    return {x = to.x + dx / length * stop, y = to.y + dy / length * stop, z = to.z}
end

-- GetBodyType returns a CName; tostring() of one prints 'ToCName{ hash_lo = ..., hash_hi = ... --[[ WomanAverage --]] }'.
-- This gives the plain name ('WomanAverage'), or '' when there is none.
local function bodyName(value)
    if value == nil then return '' end
    if type(value) == 'string' then return value end
    if type(NameToString) == 'function' then
        local ok, name = pcall(NameToString, value)
        if ok and type(name) == 'string' and name ~= '' and name ~= 'None' then return name end
    end
    local raw = tostring(value)
    return raw:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or raw
end

-- CET adapter for the native effects this module owns.
function M.nativeAdapter()
    local N = {}
    local function attitude(name) return Enum.new('EAIAttitude', name) end
    local function attitudeName(from, to)
        local text = tostring(from:GetAttitudeAgent():GetAttitudeTowards(to:GetAttitudeAgent()))
        for _, name in ipairs({'AIA_Hostile', 'AIA_Neutral', 'AIA_Friendly'}) do
            if text:find(name, 1, true) then return name end
        end
        return nil
    end
    local function persistenceSource()
        local record = TweakDBInterface.GetAIThreatPersistenceSourceRecord(TweakDBID.new('AIThreatPersistenceSource.CommandInjectThreat'))
        return record and record:EnumValue() or nil
    end
    function N.key(object) return tostring(object:GetEntityID().hash) end
    function N.position(object) local p = object:GetWorldPosition(); return {x = p.x, y = p.y, z = p.z} end
    function N.alive(npc)
        return npc ~= nil and npc:IsAttached() and not npc:IsDeadNoStatPool() and not ScriptedPuppet.IsDefeated(npc)
    end
    function N.inCombat(npc) return NPCPuppet.IsInCombat(npc) == true end
    function N.playerInCombat(player) return player:IsInCombat() == true end
    function N.playerMounted(player) return player:GetMountedVehicle() ~= nil end
    function N.hostileToPlayer(npc, player) return attitudeName(npc, player) == 'AIA_Hostile' end
    function N.name(npc) return tostring(npc:GetTweakDBFullDisplayName(true) or 'NPC') end
    function N.bodyType(npc) return bodyName(npc:GetBodyType()) end
    -- The reaction component (ReactionManagerComponent, reactionComponent.script). A follower carries the Follower
    -- preset, which ignores the hostile stimuli that make an ordinary NPC fight, so hostile attitudes alone can leave her
    -- watching. For the tactic only: an aggressive preset, then the component's own TriggerCombat (the game's
    -- AIActionHelper.TryStartCombatWithTarget). Both are script functions the game marks private; CET calls them by name.
    -- docs/COMPANION_IMPROVEMENTS_2026-10-17.md item 4.
    local PRESET_CANDIDATES = {'Ganger_Aggressive', 'Mercenary_Aggressive', 'Corpo_Aggressive'}
    local PRESET_EXCLUDED = {'Civilian', 'Child', 'Police', 'Guard', 'Prevention', 'Sleep', 'Vehicle', 'Lore', 'NoReaction'}
    local function presetLabel(record) return record and bodyName(record:EnumName()) or '?' end
    local function aggressivePreset()
        for _, name in ipairs(PRESET_CANDIDATES) do
            local record = TweakDBInterface.GetReactionPresetRecord(TweakDBID.new('ReactionPresets.' .. name))
            if record and record:IsAggressive() == true then return record end
        end
        -- The named presets are not in this install: the first aggressive combat preset by name.
        local found, foundName
        for _, record in ipairs(TweakDB:GetRecords('gamedataReactionPreset_Record') or {}) do
            local name = presetLabel(record)
            local skip = name:find('Aggressive', 1, true) == nil
            for _, word in ipairs(PRESET_EXCLUDED) do if name:find(word, 1, true) then skip = true end end
            if not skip and record:IsAggressive() == true and (not foundName or name < foundName) then found, foundName = record, name end
        end
        return found
    end
    local function reactionComponent(npc)
        local component = npc:GetStimReactionComponent()
        if not component then error('no reaction component') end
        return component
    end
    -- Raises the preset and prepares the component's combat start (run last, after the attitudes and the threat). Never
    -- raises: a failed step is noted and the fight goes on on the attitudes and the threat alone. reaction.notes are logged
    -- by the tactic.
    local function startReaction(companion, target, receipt)
        local reaction = {notes = {}}
        receipt.reaction = reaction
        local function note(text) reaction.notes[#reaction.notes + 1] = text end
        local component
        local reached, reachError = pcall(function() component = reactionComponent(companion) end)
        if not reached then note('reaction component unavailable: ' .. tostring(reachError)); return end
        -- Only a preset that can be put back is changed.
        local raised, raiseError = pcall(function()
            local current = component:GetReactionPreset()
            if not current then note('preset unreadable, left as it is'); return end
            if current:IsAggressive() == true then note('preset ' .. presetLabel(current) .. ' is already aggressive'); return end
            local wanted = aggressivePreset()
            if not wanted then note('no aggressive preset found, ' .. presetLabel(current) .. ' kept'); return end
            component:SetReactionPreset(wanted)
            reaction.presetFrom, reaction.presetTo = current:GetID(), wanted:GetID()
            local now = component:GetReactionPreset()
            note('preset ' .. presetLabel(current) .. ' -> ' .. presetLabel(wanted) .. ' (read back ' ..
                ((now and now:GetID() == wanted:GetID()) and 'ok' or ('differs: ' .. presetLabel(now))) .. ')')
        end)
        if not raised then note('preset change failed: ' .. tostring(raiseError)) end
        local function trigger()
            local started, startError = pcall(function()
                local civilian = false
                pcall(function() civilian = companion:IsCharacterCivilian() == true end)
                if civilian then
                    -- TriggerCombat also sends a security-breach stimulus for a civilian record; use its combat start directly.
                    if AIActionHelper.TryStartCombatWithTarget(companion, target) == false then error('the game refused combat with this target') end
                    note('combat start asked of the game directly (civilian record)')
                else
                    component:TriggerCombat(target)
                    note('combat start asked of the reaction component')
                end
            end)
            if not started then note('combat start failed: ' .. tostring(startError)) end
        end
        -- start runs once with the fight; trigger is asked again by the later engage stages.
        reaction.start, reaction.trigger = trigger, trigger
    end
    -- Gives the preset back, only while it still reads the one this tactic set (a preset the game chose since is its own).
    -- Needs only the companion: a defeated target does not excuse leaving her aggressive. Returns text for the log, or nil.
    function N.stopReaction(receipt, companion)
        local reaction = receipt and receipt.reaction
        if not reaction or not reaction.presetFrom then return nil end
        local component = reactionComponent(companion)
        local current = component:GetReactionPreset()
        if current and current:GetID() ~= reaction.presetTo then return 'preset left as the game set it (' .. presetLabel(current) .. ')' end
        local old = TweakDBInterface.GetReactionPresetRecord(reaction.presetFrom)
        if not old then error('the earlier preset record is gone') end
        component:SetReactionPreset(old)
        local now = component:GetReactionPreset()
        return 'preset restored to ' .. presetLabel(old) .. ' (read back ' ..
            ((now and now:GetID() == reaction.presetFrom) and 'ok' or ('differs: ' .. presetLabel(now))) .. ')'
    end
    -- The companion's high-level state (npcStateComponent): 'Relaxed', 'Stealth', 'Alerted', 'Combat', ... or nil.
    function N.highLevel(npc)
        local ok, value = pcall(function() local state = npc:GetHighLevelStateFromBlackboard(); return bodyName(state.value or state) end)
        if ok and value ~= '' then return value end
        return nil
    end
    -- NPCPuppet.ChangeHighLevelState: the call the game makes together with a threat when it forces a fight
    -- (npcPuppet.script OnFinisherEffectorActionOn, psychoSquadAVSystem.script, bossStealthComponent.script). Returns true or
    -- false and the error.
    function N.setHighLevel(npc, name)
        local ok, failure = pcall(function() NPCPuppet.ChangeHighLevelState(npc, Enum.new('gamedataNPCHighLevelState', name)) end)
        return ok, ok and nil or tostring(failure)
    end
    -- gamedataNPCStanceState: Any 0, Cover 1, Crouch 2, Stand 3, Swim 4, Vehicle 5, VehicleWindow 6.
    local STANCE_NAMES = {[1] = 'Cover', [2] = 'Crouch', [3] = 'Stand', [4] = 'Swim', [5] = 'Vehicle', [6] = 'VehicleWindow'}
    function N.stance(npc)
        local ok, value = pcall(function()
            return STANCE_NAMES[npc:GetPuppetStateBlackboard():GetInt(Game.GetAllBlackboardDefs().PuppetState.Stance)]
        end)
        if ok then return value end
        return nil
    end
    function N.setStance(npc, name)
        local ok, failure = pcall(function() NPCPuppet.ChangeStanceState(npc, Enum.new('gamedataNPCStanceState', name)) end)
        return ok, ok and nil or tostring(failure)
    end
    -- gamePSMLocomotionStates: Crouch 1, CrouchSprint 11, CrouchDodge 12 are crouched; Default 0, Sprint 2, Workspot 8 stand.
    function N.playerCrouched(player)
        local ok, value = pcall(function()
            local state = player:GetPlayerStateMachineBlackboard():GetInt(Game.GetAllBlackboardDefs().PlayerStateMachine.Locomotion)
            if state == 1 or state == 11 or state == 12 then return true end
            if state == 0 or state == 2 or state == 8 then return false end
            return nil
        end)
        if ok then return value end
    end
    -- Does her target tracker still hold a hostile entity threat (anything, not only ours)?
    function N.hasThreat(npc) return TargetTrackingExtension.HasHostileThreat(npc, false, true) == true end
    -- Is the target still on her threat list (hostile or not)? The game's own list test.
    function N.threatListed(npc, target) return TargetTrackingExtension.IsThreatInThreatList(npc, target, false, false) == true end
    -- Takes our threat out of her tracker (the call the game's TargetTrackingExtension.RemoveThreat makes). Returns text for
    -- the log. Raises when the tracker is not reachable.
    function N.removeThreat(npc, target)
        local tracker = npc:GetTargetTrackerComponent()
        if not tracker then error('no target tracker') end
        if not N.threatListed(npc, target) then return 'the target was no longer on her threat list' end
        tracker:RemoveThreat(tracker:MapThreat(target))
        -- Her senses can list a hostile in view again at once, so this read is not the verdict: the restore reads it again later.
        return 'threat on the target removed (read back ' .. (N.threatListed(npc, target) and 'listed again at once, checked again below' or 'gone') .. ')'
    end
    -- What the log and the player notice need when the combat does not start: plain facts, each read guarded.
    function N.diagnose(companion, target)
        local d = {}
        local function read(name, fn) local ok, value = pcall(fn); if ok then d[name] = value end end
        read('hls', function() return N.highLevel(companion) end)
        read('stance', function() return N.stance(companion) end)
        read('threat', function() return N.hasThreat(companion) end)
        read('listed', function() return N.threatListed(companion, target) end)
        read('out', function() return attitudeName(companion, target) end)
        read('back', function() return attitudeName(target, companion) end)
        read('civilian', function() return target:IsCharacterCivilian() == true end)
        read('crowd', function() return target:IsCrowd() == true end)
        read('preset', function() return presetLabel(reactionComponent(companion):GetReactionPreset()) end)
        read('combatTarget', function() return N.combatTarget(companion) end)
        return d
    end
    -- Whom her combat AI is shooting at: the entity id of the behavior argument 'CombatTarget' (aiComponent.script,
    -- npcStateComponent.script GetCombatTarget), or '' when there is none. Raises when the argument cannot be read.
    -- The Combat state alone proves nothing: it can be forced while the AI has no target.
    function N.combatTarget(npc)
        local variant = npc:GetAIControllerComponent():GetBehaviorArgument('CombatTarget')
        if variant == nil then return '' end
        local object = FromVariant(variant)
        if object == nil then return '' end
        return tostring(object:GetEntityID().hash)
    end
    -- Opens the fight on the target's side too. A target that never noticed her is no opponent for the combat AI (she
    -- crouches in the Stealth state and waits), so the game's own steps are made for him as well: she goes on his
    -- threat list (TargetTrackingExtension.InjectThreat does an AddThreat, not persistent) and his state is set to
    -- Combat (npcPuppet.script OnFinisherEffectorActionOn does both for the NPC it turns on). Attitudes are already
    -- hostile both ways. Returns text for the log.
    function N.alertTarget(companion, target, receipt)
        local tracker = target:GetTargetTrackerComponent()
        if not tracker then error('the target has no target tracker') end
        tracker:AddThreat(companion, true, companion:GetWorldPosition(), 1.0, -1.0, false)
        if receipt then receipt.targetThreat = true end
        local raised, raiseError = N.setHighLevel(target, 'Combat')
        return 'target alerted: she is on his threat list, ' .. (raised and ('his state asked, reads ' .. tostring(N.highLevel(target) or '?')) or ('his state refused: ' .. tostring(raiseError)))
    end
    -- Takes her off the target's threat list again (the target's own AI ends the fight state itself). Returns the log text.
    function N.releaseTarget(receipt, companion, target)
        if not (receipt and receipt.targetThreat) then return nil end
        receipt.targetThreat = nil
        local tracker = target:GetTargetTrackerComponent()
        if not tracker then error('the target has no target tracker') end
        if not (TargetTrackingExtension.IsThreatInThreatList(target, companion, false, false) == true) then return 'she was no longer on his threat list' end
        tracker:RemoveThreat(tracker:MapThreat(companion))
        return 'she is off his threat list (read back ' .. (TargetTrackingExtension.IsThreatInThreatList(target, companion, false, false) == true and 'STILL LISTED' or 'gone') .. ')'
    end
    -- Combat did not register yet: asks again, stronger each stage. It makes her believe she knows where the target is
    -- (the tracker's own ActivateThreat and SetThreatBeliefAccuracy), repeats the reaction component's combat start and
    -- forces the Combat state again. Returns the text for the log. Every step is optional.
    function N.engage(companion, target, stage, receipt)
        local notes = {}
        local tracker = companion:GetTargetTrackerComponent()
        local refreshed, refreshError = pcall(function()
            tracker:ActivateThreat(target)
            tracker:SetThreatBeliefAccuracy(target, 1.0)
        end)
        notes[#notes + 1] = refreshed and 'threat activated and believed' or ('threat refresh failed: ' .. tostring(refreshError))
        local alerted, alertText = pcall(N.alertTarget, companion, target, receipt)
        notes[#notes + 1] = alerted and alertText or ('target alert failed: ' .. tostring(alertText))
        local reaction = receipt and receipt.reaction
        if reaction and reaction.trigger then
            local before = #reaction.notes
            reaction.trigger()
            for index = before + 1, #reaction.notes do notes[#notes + 1] = reaction.notes[index] end
        end
        local ok, failure = N.setHighLevel(companion, 'Combat')
        notes[#notes + 1] = ok and ('Combat state asked again, reads ' .. tostring(N.highLevel(companion) or '?')) or ('Combat state refused: ' .. tostring(failure))
        return table.concat(notes, '; ')
    end

    -- A real combat target (aiComponent.script: the behavior argument 'CombatTarget' is what the shooting actions read; the game's
    -- own AICombatTargetHelper.SetNewCombatTarget sets it from inside the behavior). SetBehaviorArgument is a plain import, so
    -- no script half is needed; the AI commands that carry a target (AIInjectCombatTargetCommand, AIShootCommand) take an
    -- EntityReference, which holds only a node reference and cannot name a spawned NPC. Returns true when it reads back as the target.
    function N.setCombatTarget(companion, target)
        companion:GetAIControllerComponent():SetBehaviorArgument('CombatTarget', ToVariant(target))
        return N.combatTarget(companion) == N.key(target)
    end
    -- Makes the target a real opponent from his side as well: hostile to V (undone at the end only when it was not already),
    -- and his own reaction component starts combat against V and against her (reactionComponent TriggerCombat; a civilian
    -- record is spared V and gets the game's combat helper, so a bystander is never turned on V). Returns text for the log.
    function N.provoke(companion, target, player, receipt)
        local notes = {}
        local civilian = false
        pcall(function() civilian = target:IsCharacterCivilian() == true end)
        if not civilian and player then
            local ok, failure = pcall(function()
                local was = attitudeName(target, player)
                if was ~= 'AIA_Hostile' then
                    target:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), attitude('AIA_Hostile'))
                    if receipt and receipt.targetToPlayer == nil and was then receipt.targetToPlayer = was end
                    notes[#notes + 1] = 'he is hostile to V (was ' .. tostring(was) .. ')'
                end
            end)
            if not ok then notes[#notes + 1] = 'attitude to V failed: ' .. tostring(failure) end
        end
        local function against(who, label)
            local ok, failure = pcall(function()
                if civilian then
                    if AIActionHelper.TryStartCombatWithTarget(target, who) == false then error('the game refused combat') end
                else
                    reactionComponent(target):TriggerCombat(who)
                end
            end)
            notes[#notes + 1] = ok and ('his combat start against ' .. label .. ' asked') or ('his combat start against ' .. label .. ' failed: ' .. tostring(failure))
        end
        if not civilian and player then against(player, 'V') end
        against(companion, 'her')
        return table.concat(notes, '; ')
    end

    -- Squad: the target's squadmates (the game's squad member component keeps one squad per kind, the combat squad and the
    -- community the NPCs were spawned in). A list of NPC handles, the target not in it; raises when it cannot be read.
    function N.squadmates(target)
        local component = target:GetSquadMemberComponent()
        if not component then return {} end
        local result, seen = {}, {[N.key(target)] = true}
        for _, squad in ipairs(component:MySquads() or {}) do
            for _, member in ipairs(squad:ListMembersWeak() or {}) do
                local ok, key = pcall(N.key, member)
                if ok and not seen[key] then seen[key] = true; result[#result + 1] = member end
            end
        end
        return result
    end
    -- Plain facts that decide whether a squadmate may be pulled in (the same signals as companion-marking.lua facts, each read
    -- guarded: an unreadable signal is left nil).
    function N.squadFacts(npc, player)
        local f = {}
        local function read(name, fn) local ok, value = pcall(fn); if ok then f[name] = value == true end end
        read('npc', function() return npc:IsNPC() end)
        read('companion', function() return npc:IsPlayerCompanion() end)
        read('crowd', function() return npc:IsCrowd() end)
        read('civilian', function() return npc:IsCharacterCivilian() end)
        read('children', function() return npc:IsCharacterChildren() end)
        read('vendor', function() return npc:IsVendor() end)
        read('invulnerable', function() return npc:IsInvulnerable() end)
        read('story', function() return not npc:IsOnAutonomousAI() end)
        read('friendly', function() return attitudeName(npc, player) == 'AIA_Friendly' end)
        read('hostile', function() return attitudeName(npc, player) == 'AIA_Hostile' end)
        return f
    end
    -- Puts one squadmate into the fight: hostile to V and to her (and she to him; what was different is remembered), on her
    -- threat list, and his reaction component starts combat against both. Idempotent: a member already pulled in is only
    -- asked again. Returns text.
    function N.pullIn(companion, member, player, receipt)
        receipt.squad = receipt.squad or {}
        local key = N.key(member)
        local record = receipt.squad[key]
        if not record then
            record = {npc = member}
            receipt.squad[key] = record
            local function hostile(from, to, field)
                local was = attitudeName(from, to)
                if was ~= 'AIA_Hostile' then
                    from:GetAttitudeAgent():SetAttitudeTowards(to:GetAttitudeAgent(), attitude('AIA_Hostile'))
                    if was then record[field] = was end
                end
            end
            hostile(companion, member, 'fromHer'); hostile(member, companion, 'toHer'); hostile(member, player, 'toPlayer')
        end
        local component = reactionComponent(member)
        component:TriggerCombat(player)
        component:TriggerCombat(companion)
        local mine = companion:GetTargetTrackerComponent()
        if mine then mine:AddThreat(member, true, member:GetWorldPosition(), 1.0, -1.0, false); record.threat = true end
        return 'pulled in'
    end
    -- Gives a pulled-in squadmate's attitudes back and takes him off her threat list (his own AI ends his fight). Returns text.
    function N.releaseMember(receipt, companion, key)
        local record = receipt and receipt.squad and receipt.squad[key]
        if not record then return nil end
        receipt.squad[key] = nil
        local member = record.npc
        if record.fromHer then companion:GetAttitudeAgent():SetAttitudeTowards(member:GetAttitudeAgent(), attitude(record.fromHer)) end
        if record.toHer then member:GetAttitudeAgent():SetAttitudeTowards(companion:GetAttitudeAgent(), attitude(record.toHer)) end
        if record.toPlayer then
            local player = Game.GetPlayer()
            if player then member:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), attitude(record.toPlayer)) end
        end
        if record.threat and N.threatListed(companion, member) then
            local tracker = companion:GetTargetTrackerComponent()
            if tracker then tracker:RemoveThreat(tracker:MapThreat(member)) end
        end
        return 'released'
    end

    -- A drawn weapon the equipment owner did not holster: the unequip command it uses itself (companion-equipment.lua), for
    -- the right hand. Raises when the game refuses it.
    function N.holster(npc)
        local command = NewObject('AIUnequipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        if npc:GetAIControllerComponent():SendCommand(command) == false then error('the holster command was refused') end
    end

    -- Fight: agent-level hostility in both directions (never the whole attitude
    -- group, which would turn V's group against everyone of the target's group),
    -- then a persistent hostile threat so the companion's combat AI engages, the
    -- reaction component's own combat start on top, and finally the game's own
    -- forced-combat step: the Combat high-level state. Without that a follower
    -- holding a threat that has not noticed her walks up in the Stealth state and
    -- never starts the fight (live 2026-10-17).
    function N.startFight(companion, target)
        local receipt = {companionToTarget = attitudeName(companion, target), targetToCompanion = attitudeName(target, companion)}
        startReaction(companion, target, receipt)
        local started, failure = pcall(function()
            companion:GetAttitudeAgent():SetAttitudeTowards(target:GetAttitudeAgent(), attitude('AIA_Hostile'))
            target:GetAttitudeAgent():SetAttitudeTowards(companion:GetAttitudeAgent(), attitude('AIA_Hostile'))
            local tracker = companion:GetTargetTrackerComponent()
            tracker:AddThreat(target, true, target:GetWorldPosition(), 1.0, -1.0, true)
            local source = persistenceSource()
            if source then tracker:SetThreatPersistence(target, true, source); receipt.persistence = source end
            local reaction = receipt.reaction
            if reaction and reaction.start then local start = reaction.start; reaction.start = nil; start() end
            receipt.hlsFrom = N.highLevel(companion)
            local raised, raiseError = N.setHighLevel(companion, 'Combat')
            if reaction then
                reaction.notes[#reaction.notes + 1] = raised and ('Combat state asked (was ' .. tostring(receipt.hlsFrom) .. ')')
                    or ('Combat state refused: ' .. tostring(raiseError))
            end
        end)
        if not started then
            -- The caller never gets this receipt, so give back what was already changed.
            pcall(N.stopReaction, receipt, companion)
            pcall(N.stopFight, receipt, companion, target)
            error(failure, 0)
        end
        return receipt
    end
    function N.stopFight(receipt, companion, target)
        if receipt.persistence then companion:GetTargetTrackerComponent():SetThreatPersistence(target, false, receipt.persistence) end
        if receipt.companionToTarget then companion:GetAttitudeAgent():SetAttitudeTowards(target:GetAttitudeAgent(), attitude(receipt.companionToTarget)) end
        if receipt.targetToCompanion then target:GetAttitudeAgent():SetAttitudeTowards(companion:GetAttitudeAgent(), attitude(receipt.targetToCompanion)) end
        if receipt.targetToPlayer then
            local player = Game.GetPlayer()
            if player then target:GetAttitudeAgent():SetAttitudeTowards(player:GetAttitudeAgent(), attitude(receipt.targetToPlayer)) end
            receipt.targetToPlayer = nil
        end
    end
    -- What is in the right hand: true and the item record when a real weapon (not fists) is drawn, false when
    -- the hand is empty or holds fists. Raises when the game will not say.
    function N.weapon(npc)
        local item = ScriptedPuppet.GetWeaponRight(npc)
        if item == nil then return false end
        local id = item:GetItemID()
        if WeaponObject.IsFists(id) then return false end
        return true, tostring(ItemID.GetTDBID(id))
    end
    -- The native draw commands are shared with the combat-start draw in companion-equipment.lua (M.draw): the
    -- game's switch-to-primary command, an explicit equip of the primary item, and the bare right-hand slot
    -- equip. N.drawWeapon(npc, mode, itemId) returns a handle for N.cancelDraw.
    local function drawCalls()
        local ok, equipment = pcall(dofile, 'companion-equipment.lua')
        if not ok or type(equipment) ~= 'table' or type(equipment.draw) ~= 'table' then
            error('the draw commands are unavailable: ' .. tostring(equipment))
        end
        return equipment.draw
    end
    function N.drawWeapon(npc, mode, itemId) return drawCalls().send(npc, mode, itemId) end
    function N.primaryItem(npc) return drawCalls().primaryItem(npc) end
    function N.cancelDraw(handle, npc) return drawCalls().cancel(handle, npc) end
    return N
end

function M.new(options)
    options = options or {}
    local T, env, native = {}, options.env or {}, options.native or M.nativeAdapter()
    local settings = {}
    for key, value in pairs(DEFAULTS) do settings[key] = options[key] or value end
    local active, offers, sequence, clock, last = nil, {}, 0, 0, nil

    local function get(fn, ...)
        if type(fn) ~= 'function' then return nil end
        local ok, value = pcall(fn, ...)
        if ok then return value end
        return nil
    end
    local function log(line) if env.log then pcall(env.log, 'Companion tactic: ' .. line) end end
    local function feedback(message) if env.feedback and message then pcall(env.feedback, message) end end
    local function distanceBetween(a, b) return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2 + (a.z - b.z)^2) end
    -- ': hls=Stealth stance=Crouch threat=yes ...' for the log, from native.diagnose.
    local function diagnosisText(d)
        if type(d) ~= 'table' then return ' (nothing readable)' end
        local function word(value) if value == nil then return '?' end return tostring(value) end
        local function yes(value) if value == nil then return '?' end return value and 'yes' or 'no' end
        return ': state=' .. word(d.hls) .. ' stance=' .. word(d.stance) .. ' threat=' .. yes(d.threat) .. ' target-listed=' .. yes(d.listed)
            .. ' attitude=' .. word(d.out) .. '/' .. word(d.back) .. ' preset=' .. word(d.preset)
            .. ' target-civilian=' .. yes(d.civilian) .. ' target-crowd=' .. yes(d.crowd)
            .. ' combat-target=' .. (d.combatTarget == nil and '?' or (d.combatTarget == '' and 'none' or tostring(d.combatTarget)))
    end
    -- The player notice when the order could not start the fight, in plain words and short (the notice frame holds two lines).
    local function failureMessage(a)
        local who, what = a.companionName or 'Your companion', a.targetName or 'the target'
        a.diag = a.diag or get(native.diagnose, a.companion, a.target)
        local d = a.diag or {}
        if d.civilian == true or d.crowd == true then return who .. " can't attack " .. what .. ': not a fighter.' end
        local mine, theirs = get(native.position, a.companion), get(native.position, a.target)
        if mine and theirs and distanceBetween(mine, theirs) > settings.fightApproach + settings.arriveSlack + 2 then
            return who .. ' could not reach ' .. what .. '.'
        end
        return who .. ' could not start the fight with ' .. what .. '.'
    end

    local function op(kind, goal, gait, finish, face)
        local a = active
        local current = a.operation
        if not current or current.kind ~= kind or current.phase ~= a.phase or current.finish ~= finish then
            a.tickets = a.tickets + 1
            current = {ticket = 'tactic-' .. a.id .. '-' .. a.tickets, kind = kind, phase = a.phase}
            a.operation = current
        end
        current.goal = goal and copy(goal) or nil
        current.gait, current.finish, current.face = gait, finish, face
        return current
    end

    local function enter(phase, reason)
        if active.phase ~= phase then
            active.phase, active.since = phase, clock
            active.trace[#active.trace + 1] = {at = clock, phase = phase, reason = reason}
            if #active.trace > 24 then table.remove(active.trace, 1) end
            log(active.kind .. ' ' .. phase .. (reason and (': ' .. reason) or ''))
        end
    end

    local function releaseFight(a)
        if a.draw and a.draw.handle then
            local handle = a.draw.handle; a.draw.handle = nil
            if get(native.alive, a.companion) then pcall(native.cancelDraw, handle, a.companion) end
        end
        if not a.fightReceipt then return end
        local receipt = a.fightReceipt; a.fightReceipt = nil
        -- The preset goes back whenever the companion is still there, whatever became of the target.
        if get(native.alive, a.companion) and type(native.stopReaction) == 'function' then
            local restored, result = pcall(native.stopReaction, receipt, a.companion)
            if not restored then log('reaction: preset restore failed: ' .. tostring(result))
            elseif result then log('reaction: ' .. tostring(result)) end
        end
        -- The squadmates pulled in leave the fight: attitudes back, off her threat list (their own AI ends their combat).
        if type(native.releaseMember) == 'function' and type(receipt.squad) == 'table' and get(native.alive, a.companion) then
            local keys = {}
            for key in pairs(receipt.squad) do keys[#keys + 1] = key end
            local done, failed = 0, 0
            for _, key in ipairs(keys) do
                local member = receipt.squad[key] and receipt.squad[key].npc
                if member and get(native.alive, member) then
                    local ok, failure = pcall(native.releaseMember, receipt, a.companion, key)
                    if ok then done = done + 1 else failed = failed + 1; log('restore: squadmate release failed: ' .. tostring(failure)) end
                end
            end
            if done + failed > 0 then log('restore: ' .. done .. ' squadmates released' .. (failed > 0 and (', ' .. failed .. ' failed') or '')) end
            receipt.squad = nil
        end
        -- A defeated target needs nothing back; a living one gets its attitudes.
        if get(native.alive, a.target) and get(native.alive, a.companion) then
            pcall(native.stopFight, receipt, a.companion, a.target)
        end
        -- She leaves the target's threat list again (only when the engage stages put her there).
        if get(native.alive, a.target) and get(native.alive, a.companion) and type(native.releaseTarget) == 'function' then
            local released, text = pcall(native.releaseTarget, receipt, a.companion, a.target)
            if text or not released then log('restore: ' .. (released and tostring(text) or ('target threat removal failed: ' .. tostring(text)))) end
        end
        -- Our threat leaves her tracker whatever became of the target (the game does not always drop one that was
        -- injected as persistent, and a threat she still holds keeps her armed and in the Stealth state).
        if get(native.alive, a.companion) and type(native.removeThreat) == 'function' then
            local removed, result = pcall(native.removeThreat, a.companion, a.target)
            log('restore: ' .. (removed and tostring(result) or ('threat removal failed: ' .. tostring(result))))
        end
    end

    -- After a tactic ends the companion is put back the way she was before it: out of the stealth crouch, out of the
    -- Combat or Stealth state, and with the weapon holstered again (the equipment owner does the holster once she is
    -- calm, so it is re-armed here). Every step is asked, read back and logged. It is looked at every restoreGap seconds
    -- for at most restoreLimit seconds, and only while the tactic is over; a hostile threat that is not ours (V's own
    -- fight) holds it back. Nothing runs when no tactic ran.
    local restoring = nil
    local RESTORE_SKIPPED = {vehicle = true, ['companion-unavailable'] = true, replaced = true}
    local function beginRestore(a, reason)
        if RESTORE_SKIPPED[reason] or not get(native.alive, a.companion) then return end
        if type(native.highLevel) ~= 'function' and type(native.stance) ~= 'function' then return end
        restoring = {companion = a.companion, target = a.target, entity = a.entity, name = a.companionName or 'companion', serial = a.serial,
            startedAt = clock, nextAt = clock + settings.restoreGap, standTries = 0, hlsTries = 0, noted = {}}
    end
    local function restoreLog(r, line) log('restore: ' .. line) end
    local function restoreNote(r, key, line)
        if not r.noted[key] then r.noted[key] = true; restoreLog(r, line) end
    end
    -- The holster is asked of the equipment owner, which holsters once she is calm; read back after holsterWatch seconds. A weapon
    -- still drawn then is asked for again (up to holsterTries asks), and once more through the unequip command itself (live
    -- 2026-10-17: the second order's holster was asked once and the weapon was still drawn 9 s later).
    local function restoreHolster(r)
        local ok, drawn, record = pcall(native.weapon, r.companion)
        if r.rearmed then
            local still = ok and drawn == true
            local text = still and ('still drawn (' .. tostring(record) .. ')') or 'holstered'
            if not still then restoreLog(r, 'weapon read back: ' .. text); restoring = nil; return end
            if get(native.playerInCombat, get(env.player)) == true then
                restoreLog(r, 'weapon read back: ' .. text .. ', V is in combat, left to the game'); restoring = nil; return
            end
            if (r.holsterAsks or 1) < settings.holsterTries and type(env.rearm) == 'function' then
                r.holsterAsks = (r.holsterAsks or 1) + 1
                local armed, rearmError = pcall(env.rearm, r.entity)
                restoreLog(r, 'weapon read back: ' .. text .. ', holster asked of the equipment owner again (ask ' .. r.holsterAsks .. ')'
                    .. (armed and '' or (', could not be asked: ' .. tostring(rearmError))))
                if armed then r.rearmed = clock; return end
            end
            if not r.holsterDirect and type(native.holster) == 'function' then
                r.holsterDirect = true
                local sent, failure = pcall(native.holster, r.companion)
                restoreLog(r, 'weapon read back: ' .. text .. ', the unequip command sent directly' .. (sent and '' or (', refused: ' .. tostring(failure))))
                if sent then r.rearmed = clock; return end
            end
            restoreLog(r, 'weapon read back: ' .. text)
            restoring = nil; return
        end
        if ok and drawn ~= true then restoreLog(r, 'weapon already holstered'); restoring = nil; return end
        local armed, rearmError = true, nil
        if type(env.rearm) == 'function' then armed, rearmError = pcall(env.rearm, r.entity) end
        if armed then
            restoreLog(r, 'holster asked of the equipment owner (weapon in hand: ' .. ((ok and drawn == true) and tostring(record) or 'unreadable') .. ')')
            r.rearmed, r.holsterAsks = clock, 1
        else
            restoreLog(r, 'holster could not be asked: ' .. tostring(rearmError)); restoring = nil
        end
    end
    local function tickRestore(player)
        local r = restoring
        if not r or clock < r.nextAt then return end
        r.nextAt = clock + settings.restoreGap
        if (active and active.companion == r.companion) or not get(native.alive, r.companion) then restoring = nil; return end
        -- Our threat was taken out of her tracker when the tactic ended. Her senses can list a hostile in view again at once, so
        -- the verdict is read here, once, after threatCheck seconds; a threat still there is removed once more.
        if not r.threatChecked and type(native.threatListed) == 'function' and get(native.alive, r.target) == true
            and clock - r.startedAt >= settings.threatCheck then
            r.threatChecked = true
            local listed = get(native.threatListed, r.companion, r.target)
            local after = string.format('%.1f', clock - r.startedAt) .. ' s after the tactic ended'
            if listed == true then
                local diag = get(native.diagnose, r.companion, r.target)
                local removed, result = true, nil
                if type(native.removeThreat) == 'function' then removed, result = pcall(native.removeThreat, r.companion, r.target) end
                restoreLog(r, 'target still on her threat list ' .. after .. ' (her attitude to him ' .. tostring(type(diag) == 'table' and diag.out or '?')
                    .. '), removed again: ' .. (removed and tostring(result) or ('failed: ' .. tostring(result))))
            elseif listed == false then
                restoreLog(r, 'target off her threat list ' .. after)
            end
        end
        if r.rearmed then
            if clock - r.rearmed >= settings.holsterWatch then restoreHolster(r) end
            return
        end
        if clock - r.startedAt > settings.restoreLimit then
            restoreLog(r, 'gave up after ' .. settings.restoreLimit .. ' s (stance ' .. tostring(get(native.stance, r.companion))
                .. ', state ' .. tostring(get(native.highLevel, r.companion)) .. ')')
            restoring = nil; return
        end
        if get(native.playerInCombat, player) == true then
            restoreLog(r, 'V is in combat, her stance and state are left to the game'); restoreHolster(r); return
        end
        if get(native.hasThreat, r.companion) == true then
            r.calmSince = nil
            restoreNote(r, 'threat', 'waiting, she still tracks a hostile threat')
            -- Her senses can put the old target back on the list while his hostility is being undone: once more, then wait.
            r.waitSince = r.waitSince or clock
            if not r.threatRetried and clock - r.waitSince >= settings.threatRetry and type(native.removeThreat) == 'function' then
                r.threatRetried = true
                local removed, result = pcall(native.removeThreat, r.companion, r.target)
                restoreLog(r, 'threat still held after ' .. settings.threatRetry .. ' s, removed again: ' .. (removed and tostring(result) or ('failed: ' .. tostring(result))))
            end
            return
        end
        r.calmSince = r.calmSince or clock
        if clock - r.calmSince < settings.restoreCalm then return end
        local hls, stance = get(native.highLevel, r.companion), get(native.stance, r.companion)
        local crouchedWithV = get(native.playerCrouched, player) == true
        if r.standAsked and clock - r.standAsked >= settings.standGap then
            r.standAsked = nil
            restoreLog(r, 'stance read back ' .. tostring(stance) .. (stance == 'Crouch' and ' (still crouched)' or ' (ok)'))
        end
        if r.hlsAsked and clock - r.hlsAsked >= settings.standGap then
            r.hlsAsked = nil
            restoreLog(r, 'state read back ' .. tostring(hls) .. ((hls == 'Stealth' or hls == 'Combat') and ' (not changed yet)' or ' (ok)'))
        end
        if r.standAsked or r.hlsAsked then return end
        -- V is crouched: crouching with her is companion-stance.lua's job (it raises the Stealth state itself).
        if crouchedWithV then
            restoreNote(r, 'crouch', 'V is crouched, the crouch-with-V module keeps her stance and state'); restoreHolster(r); return
        end
        -- The stance first, then the state: two state-change signals in one frame can overwrite each other.
        if stance == 'Crouch' then
            if r.standTries < 3 and type(native.setStance) == 'function' then
                r.standTries = r.standTries + 1
                local ok, failure = native.setStance(r.companion, 'Stand')
                restoreLog(r, 'stance Crouch -> Stand asked (try ' .. r.standTries .. ')' .. (ok and '' or (', refused: ' .. tostring(failure))))
                r.standAsked = clock; return
            end
            restoreNote(r, 'standGaveUp', 'stance still Crouch after 3 tries, left to the game')
        end
        if hls == 'Stealth' or hls == 'Combat' then
            if r.hlsTries < 3 and type(native.setHighLevel) == 'function' then
                r.hlsTries = r.hlsTries + 1
                local ok, failure = native.setHighLevel(r.companion, 'Relaxed')
                restoreLog(r, 'state ' .. tostring(hls) .. ' -> Relaxed asked (try ' .. r.hlsTries .. ')' .. (ok and '' or (', refused: ' .. tostring(failure))))
                r.hlsAsked = clock; return
            end
            restoreNote(r, 'hlsGaveUp', 'state still ' .. tostring(hls) .. ' after 3 tries, left to the game')
        end
        restoreNote(r, 'settled', 'stance ' .. tostring(stance) .. ', state ' .. tostring(hls) .. ', follow resumes')
        restoreHolster(r)
    end

    local function finish(reason, message)
        local a = active
        if not a then return end
        releaseFight(a)
        beginRestore(a, reason)
        active = nil
        last = {id = a.id, kind = a.kind, result = reason, phase = a.phase, trace = a.trace}
        log('finished (' .. tostring(reason) .. ')')
        if message then feedback(message) end
    end

    function T.cancel(reason, message) if active then finish(reason or 'cancelled', message) end end

    -- Forget every handle without native calls (world teardown).
    function T.abandon()
        active, offers, restoring = nil, {}, nil
    end

    local function actorFor(entity)
        local actor = get(env.actor, entity)
        if type(actor) ~= 'table' or not actor.npc or type(actor.serial) ~= 'number' then return nil end
        return actor
    end

    -- Called at manual private request admission (gameplay-actions capture).
    function T.offer(entity)
        local player = get(env.player)
        if not player then return {available = false, reason = 'Player unavailable'} end
        if get(native.playerMounted, player) then return {available = false, reason = 'V is in a vehicle'} end
        local actor = actorFor(entity)
        if not actor then return {available = false, reason = 'Not a ready companion on foot'} end
        local target, info = nil, nil
        if env.marked then
            local ok, npc, detail = pcall(env.marked, player)
            if ok then target, info = npc, detail end
        end
        -- code: the one reason the bridge is told about, so the character does not claim to act on nobody.
        if not target or not info or not info.id then return {available = false, reason = 'No target', code = 'no-target'} end
        if info.id == entity or not get(native.alive, target) then return {available = false, reason = 'Target unavailable'} end
        local targetAt, playerAt = get(native.position, target), get(native.position, player)
        local gap = targetAt and playerAt and math.sqrt((targetAt.x - playerAt.x)^2 + (targetAt.y - playerAt.y)^2 + (targetAt.z - playerAt.z)^2) or math.huge
        if gap > settings.maxOfferDistance then return {available = false, reason = 'Target too far away'} end
        local name = info.name or get(native.name, target) or 'NPC'
        if #name > 120 then name = name:sub(1, 120) end
        offers[entity] = {entity = entity, serial = actor.serial, targetId = info.id, target = target, name = name, at = clock}
        return {available = true, actor = {serial = actor.serial, id = entity, key = actor.profileKey},
            target = {id = info.id, name = name, hostile = get(native.hostileToPlayer, target, player) == true,
                distance = math.floor(gap + 0.5)}, kinds = {'fight'}}
    end

    local function offered(offer, kind)
        for _, value in ipairs(offer.kinds or {}) do if value == kind then return true end end
        return false
    end

    -- The weapon in hand when the fight starts: already drawn, or asked for in stages (DRAW_STAGES): the game's
    -- switch-to-primary command, then an explicit equip of the primary item (the bare slot equip when no item can be
    -- named), then the bare slot equip. Each stage is read back in T.update; an empty hand moves on to the next.
    local function requestStage(a, from, hand)
        local lastError
        for index = from, #DRAW_STAGES do
            local mode, itemId = DRAW_STAGES[index], nil
            local usable = true
            if mode == 'equip' then
                local ok, id = pcall(native.primaryItem, a.companion)
                if ok and id ~= nil then itemId = id else usable, lastError = false, 'no primary item found' end
            end
            if usable then
                local sent, handle = pcall(native.drawWeapon, a.companion, mode, itemId)
                if sent then
                    a.draw = {state = 'requested', at = clock, handle = handle, index = index, readbacks = a.draw and a.draw.readbacks or 0}
                    log('weapon draw requested (' .. mode .. ', hand ' .. hand .. ')')
                    return true
                end
                lastError = handle
                log('weapon draw stage ' .. mode .. ' refused: ' .. tostring(handle))
            end
        end
        return false, lastError
    end

    local function drawWeapon(a)
        local ok, drawn, record = pcall(native.weapon, a.companion)
        if ok and drawn == true then
            a.draw = {state = 'drawn', at = clock}
            log('weapon already drawn (' .. tostring(record) .. ')')
            return
        end
        local requested, failure = requestStage(a, 1, ok and 'empty' or 'unreadable')
        if not requested then
            a.draw = {state = 'unavailable', at = clock}
            log('weapon draw unavailable: ' .. tostring(failure))
        end
    end

    local function readBackWeapon(a)
        local draw = a.draw
        if not draw or draw.state ~= 'requested' then return end
        local wait = draw.index < #DRAW_STAGES and settings.drawReadback or settings.drawRetryReadback
        if clock - draw.at < wait then return end
        draw.readbacks = draw.readbacks + 1
        local ok, drawn, record = pcall(native.weapon, a.companion)
        if ok and drawn == true then
            draw.state = 'drawn'
            log('weapon readback: drawn (' .. tostring(record) .. ') after ' .. string.format('%.1f', clock - draw.at) .. 's')
            return
        end
        local hand = ok and 'hand still empty' or 'unreadable'
        if draw.index < #DRAW_STAGES then
            -- The command may have been dropped while she was moving, or the item was not yet attached: the next
            -- stage replaces it.
            local old = draw.handle; draw.handle = nil
            if old then pcall(native.cancelDraw, old, a.companion) end
            local again, failure = requestStage(a, draw.index + 1, ok and 'empty' or 'unreadable')
            if again then log('weapon readback: ' .. hand .. ', draw asked again')
            else draw.state = 'unavailable'; log('weapon readback: ' .. hand .. ', draw refused: ' .. tostring(failure)) end
        else
            draw.state = 'empty'
            log('weapon readback: ' .. hand .. ', the combat AI decides')
        end
    end

    -- Whether a squadmate of the target may be pulled in, from plain facts: never a companion, a civilian or crowd NPC, a child,
    -- a vendor, an invulnerable or scene-controlled NPC, a named character, nor anyone friendly to V. Returns true, or false
    -- and the reason.
    local function squadVerdict(f, protected, owned)
        if owned or f.companion then return false, 'companion' end
        if f.npc == false then return false, 'not-npc' end
        if f.crowd or f.civilian then return false, 'civilian' end
        if f.children then return false, 'children' end
        if f.vendor then return false, 'vendor' end
        if f.invulnerable then return false, 'invulnerable' end
        if f.story then return false, 'story-controlled' end
        if protected then return false, 'story-character' end
        if f.friendly then return false, 'friendly' end
        return true, 'squadmate'
    end
    -- His group joins the fight: the target's squadmates within squadRadius of him are put into combat against V and her.
    -- Runs at the engage stages only (never per frame). Logs how many.
    local function pullSquad(a, label)
        if type(native.squadmates) ~= 'function' or not a.fightReceipt then return end
        local player = get(env.player)
        local read, mates = pcall(native.squadmates, a.target)
        if not read then
            if not a.squadFailed then a.squadFailed = true; log('squad (' .. label .. '): squadmates could not be listed: ' .. tostring(mates)) end
            return
        end
        local at = get(native.position, a.target)
        local pulled, skipped, listed, failures = {}, {}, 0, 0
        for _, member in ipairs(type(mates) == 'table' and mates or {}) do
            listed = listed + 1
            local verdict, why = false, 'unreadable'
            local where = get(native.position, member)
            if get(native.alive, member) ~= true then why = 'down'
            elseif at and where and distanceBetween(at, where) > settings.squadRadius then why = 'far'
            elseif #pulled >= settings.squadMax then why = 'over-limit'
            else
                local facts = get(native.squadFacts, member, player) or {}
                local protected = env.protected and get(env.protected, member) == true
                local owned = env.owned and get(env.owned, member) == true
                verdict, why = squadVerdict(facts, protected, owned)
            end
            if verdict then
                local ok, failure = pcall(native.pullIn, a.companion, member, player, a.fightReceipt)
                if ok then pulled[#pulled + 1] = get(native.name, member) or 'NPC'
                else failures = failures + 1; log('squad (' .. label .. '): pulling in ' .. tostring(get(native.name, member) or 'NPC') .. ' failed: ' .. tostring(failure)) end
            else
                skipped[why] = (skipped[why] or 0) + 1
            end
        end
        local parts = {}
        for why, n in pairs(skipped) do parts[#parts + 1] = why .. ' ' .. n end
        table.sort(parts)
        log('squad (' .. label .. '): ' .. listed .. ' squadmates listed, ' .. #pulled .. ' pulled in'
            .. (#pulled > 0 and (' (' .. table.concat(pulled, ', ') .. ')') or '')
            .. (#parts > 0 and ('; skipped: ' .. table.concat(parts, ', ')) or '')
            .. (failures > 0 and ('; ' .. failures .. ' failed') or ''))
    end
    -- Opens the fight for real: the target is a real opponent from his side (his reaction component starts combat against V and
    -- her), she holds him as her combat target (the behavior argument the shooting reads), and his group joins. The engine then
    -- positions her itself; the move command only runs until the target reads back. withSquad: the engage stages, not the slow retries.
    local function openCombat(a, label, withSquad)
        if not a.fightReceipt then return end
        local player = get(env.player)
        if type(native.provoke) == 'function' then
            local ok, text = pcall(native.provoke, a.companion, a.target, player, a.fightReceipt)
            log('opening (' .. label .. '): ' .. (ok and tostring(text) or ('target side failed: ' .. tostring(text))))
        end
        if type(native.setCombatTarget) == 'function' then
            local ok, result = pcall(native.setCombatTarget, a.companion, a.target)
            log('opening (' .. label .. '): her combat target ' .. (ok and (result and 'set, reads back as the target' or 'asked, reads back different') or ('could not be set: ' .. tostring(result))))
        end
        if withSquad then pullSquad(a, label) end
        a.evidence = nil
    end

    -- Called once per accepted Convai action, with the exact captured offer.
    function T.start(kind, offer, entity)
        if not KINDS[kind] or type(offer) ~= 'table' or type(offer.actor) ~= 'table' or type(offer.target) ~= 'table'
            or offer.actor.id ~= entity or not offered(offer, kind) then
            return false, 'That action is not available.'
        end
        local captured = offers[entity]
        if not captured or captured.targetId ~= offer.target.id or captured.serial ~= offer.actor.serial
            or clock - captured.at > settings.offerTtl then
            return false, 'The target changed. Ask again.'
        end
        local actor = actorFor(entity)
        if not actor or actor.serial ~= offer.actor.serial then return false, 'That companion is no longer ready.' end
        if not get(native.alive, captured.target) or get(native.key, captured.target) ~= captured.targetId then
            return false, 'The target is gone.'
        end
        local player = get(env.player)
        if not player or get(native.playerMounted, player) then return false, 'Step out of the vehicle first.' end
        if active then finish('replaced') end
        offers[entity] = nil
        sequence = sequence + 1
        active = {id = sequence, kind = 'fight', serial = actor.serial, entity = entity,
            companion = actor.npc, companionKey = actor.profileKey, companionName = actor.name or offer.actor.key,
            companionBody = get(native.bodyType, actor.npc) or '',
            target = captured.target, targetId = captured.targetId, targetName = captured.name,
            startedAt = clock, since = clock, tickets = 0, trace = {}}
        local started, receipt = pcall(native.startFight, actor.npc, captured.target)
        if not started or type(receipt) ~= 'table' then
            log('fight start failed: ' .. tostring(receipt))
            finish('fight-unavailable'); return false, 'Your companion could not engage that target.'
        end
        active.fightReceipt = receipt
        if type(native.engage) == 'function' then active.engage = {stage = 1, at = clock} end
        restoring = nil
        for _, line in ipairs(type(receipt.reaction) == 'table' and receipt.reaction.notes or {}) do log('reaction: ' .. tostring(line)) end
        enter('fight-approach', 'fight accepted: ' .. captured.name .. ' ' .. captured.targetId)
        openCombat(active, 'start', true)
        drawWeapon(active)
        return true, (actor.name or 'Your companion') .. ' is going after ' .. captured.name .. '.'
    end

    -- Is a fight really on? The Combat state alone is no proof (live 2026-10-17: it was forced while her combat AI had no
    -- target, and she crouched at the edge of nothing). It takes her being in combat AND her combat AI holding a target:
    -- ours, or any other (she may be fighting someone beside it). Where the target cannot be read, in combat and not
    -- crouched (the Stealth stance) stands in. Returns true or false and the reason.
    local function judge(a)
        if get(native.inCombat, a.companion) ~= true then return false, 'not in combat' end
        if type(native.combatTarget) ~= 'function' then return true, 'in combat' end
        local read, key = pcall(native.combatTarget, a.companion)
        if read and type(key) == 'string' then
            if key == a.targetId then return true, 'her combat target is ours' end
            if key ~= '' then return true, 'her combat target is ' .. key end
            return false, 'in combat but no combat target'
        end
        if not a.blindNoted then
            a.blindNoted = true
            log('combat target unreadable (' .. tostring(key) .. '), judging by her stance')
        end
        local stance = get(native.stance, a.companion)
        if stance == 'Crouch' then return false, 'in combat, crouched, target unreadable' end
        return true, 'in combat, stance ' .. tostring(stance) .. ', target unreadable'
    end
    local function observe(a)
        local seen = a.evidence
        if seen and clock - seen.at < settings.observeGap then return seen.engaged end
        local engaged, why = judge(a)
        a.evidence = {at = clock, engaged = engaged, why = why}
        return engaged
    end
    -- A line every statusGap seconds (the first statusMax of them) while the tactic runs: what she and the game read.
    local function statusLine(a)
        if (a.statusCount or 0) >= settings.statusMax or clock < (a.statusAt or a.startedAt + settings.statusGap) then return end
        a.statusAt, a.statusCount = clock + settings.statusGap, (a.statusCount or 0) + 1
        local mine, theirs = get(native.position, a.companion), get(native.position, a.target)
        local gap = (mine and theirs) and string.format('%.0f', distanceBetween(mine, theirs)) .. 'm' or '?'
        log('status ' .. string.format('%.0f', clock - a.startedAt) .. 's ' .. a.phase .. ', ' .. tostring(a.evidence and a.evidence.why)
            .. ', gap ' .. gap .. diagnosisText(get(native.diagnose, a.companion, a.target)))
    end

    function T.owns(serial) return active ~= nil and active.serial == serial end

    -- Movement decision for the owned copy, in the companion behavior schema.
    function T.decide(serial, context, _)
        local a = active
        if not a or a.serial ~= serial then return nil end
        local operation
        if a.phase == 'fight-approach' then
            -- Released to the combat AI only on real evidence of a fight (T.update), never on the Combat state alone:
            -- until then she is walked to the target.
            if a.evidence and a.evidence.engaged then operation = op('release')
            else
                local goal = get(native.position, a.target)
                if not goal then return nil end
                operation = op('move', toward(context.position or goal, goal, settings.fightApproach), 'Run', true, false)
            end
        elseif a.phase == 'fighting' then
            operation = op('release')
        else
            return nil
        end
        a.lastMotion = context.motion
        a.lastPosition = context.position and copy(context.position) or a.lastPosition
        return {phase = 'tactic-' .. a.phase, reason = a.kind, operation = operation, look = 'none'}
    end

    function T.update(player, dt, worldReady)
        -- Menus and loading freeze every tactic clock; nothing times out there.
        if not worldReady or not player then return end
        local step = tonumber(dt) or 0
        clock = clock + step
        for entity, captured in pairs(offers) do
            if clock - captured.at > settings.offerTtl then offers[entity] = nil end
        end
        if restoring then tickRestore(player) end
        local a = active
        if not a then return end
        local actor = actorFor(a.entity)
        if not actor or actor.serial ~= a.serial or actor.npc ~= a.companion and get(native.key, actor.npc) ~= a.entity then
            finish('companion-unavailable'); return
        end
        if get(native.playerMounted, player) then finish('vehicle'); return end
        local targetAlive = get(native.alive, a.target) == true
        if not targetAlive then finish('target-down'); return end
        readBackWeapon(a)
        local engaged = observe(a)
        if a.phase == 'fight-approach' then
            local elapsed = clock - (a.everEngaged and a.since or a.startedAt)
            if engaged then
                a.everEngaged, a.arrivedAt = true, nil
                enter('fighting', 'native combat engaged (' .. tostring(a.evidence.why) .. ')')
            else
                local engage = a.engage
                if engage and engage.stage < ENGAGE_STAGES and clock - engage.at >= settings.engageReadback then
                    -- No fight yet: ask again, stronger (stage 2 and 3).
                    engage.stage, engage.at = engage.stage + 1, clock
                    local asked, text = pcall(native.engage, a.companion, a.target, engage.stage, a.fightReceipt)
                    log('engage stage ' .. engage.stage .. ' (no fight after ' .. string.format('%.1f', clock - a.since) .. 's, ' .. tostring(a.evidence.why) .. '): '
                        .. (asked and tostring(text) or ('failed: ' .. tostring(text))))
                    openCombat(a, 'stage ' .. engage.stage, true)
                elseif engage and engage.stage >= ENGAGE_STAGES and not engage.reported and clock - engage.at >= settings.engageReadback then
                    engage.reported = true
                    a.diag = get(native.diagnose, a.companion, a.target)
                    log('engage: combat did not register after ' .. string.format('%.1f', clock - a.since) .. 's' .. diagnosisText(a.diag))
                end
                -- The asks are used up and there is still no fight: the same asks again at a low rate until the order is given up
                -- (the Combat state does not hold by itself: live 2026-10-17 it fell back to Relaxed and Stealth within seconds).
                if engage and engage.stage >= ENGAGE_STAGES and clock - (engage.again or engage.at) >= settings.reassertGap then
                    engage.again = clock
                    local asked, text = pcall(native.engage, a.companion, a.target, engage.stage, a.fightReceipt)
                    log('engage again (no fight after ' .. string.format('%.1f', clock - a.since) .. 's, ' .. tostring(a.evidence.why) .. '): '
                        .. (asked and tostring(text) or ('failed: ' .. tostring(text))))
                    openCombat(a, 'again', false)
                end
                if elapsed > settings.fightStartTimeout then
                    finish('no-combat', failureMessage(a)); return
                end
                -- At the target and still no fight once every ask is made: waiting longer helps nobody.
                if engage and engage.reported then
                    local mine, theirs = get(native.position, a.companion), get(native.position, a.target)
                    if mine and theirs and distanceBetween(mine, theirs) <= settings.fightApproach + settings.arriveSlack then
                        a.arrivedAt = a.arrivedAt or clock
                        if clock - a.arrivedAt >= settings.arriveGrace then finish('no-combat', failureMessage(a)); return end
                    else
                        a.arrivedAt = nil
                    end
                end
            end
        elseif a.phase == 'fighting' then
            -- Engagement is watched all the way: a fight that stops being one (no combat, or no target) for
            -- lostGrace seconds sends her back to the target, with the asks and the give-up starting again.
            if engaged then a.lostSince = nil
            else
                a.lostSince = a.lostSince or clock
                if clock - a.lostSince >= settings.lostGrace then
                    a.lostSince, a.arrivedAt = nil, nil
                    if a.engage then a.engage = {stage = 1, at = clock} end
                    enter('fight-approach', 'fight lost (' .. tostring(a.evidence.why) .. ')')
                end
            end
        end
        statusLine(a)
        if clock - a.startedAt > settings.fightTimeout then finish('fight-timeout') end
    end

    function T.snapshot()
        local a = active
        local value = {active = a ~= nil, last = last and copy(last) or nil}
        if a then
            value.kind, value.phase, value.serial, value.target = a.kind, a.phase, a.serial, a.targetId
            value.fighting = a.fightReceipt ~= nil
            value.weapon = a.draw and a.draw.state or nil
        end
        return value
    end
    return T
end

return M
