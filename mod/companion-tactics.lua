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
    offerTtl = 125, drawReadback = 1.5, drawRetryReadback = 2.0,
}

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
        reaction.start = function()
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
    -- Fight: agent-level hostility in both directions (never the whole attitude
    -- group, which would turn V's group against everyone of the target's group),
    -- then a persistent hostile threat so the companion's combat AI engages, and
    -- the reaction component's own combat start on top.
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
    -- The companion's own native equip command for the right-hand slot (the game's AIEquipCommand, the
    -- counterpart of the AIUnequipCommand the holster uses). Returns a handle for N.cancelDraw.
    function N.drawWeapon(npc)
        local command = NewObject('AIEquipCommand')
        command.slotId = TweakDBID.new('AttachmentSlots.WeaponRight')
        pcall(function() command.failIfItemNotFound = false end)
        local accepted = npc:GetAIControllerComponent():SendCommand(command)
        if accepted == false then error('the AI refused the equip command') end
        return {command = command}
    end
    function N.cancelDraw(handle, npc)
        if not handle or not handle.command then return end
        local ai = npc:GetAIControllerComponent()
        local state = tostring(ai:GetCommandState(handle.command))
        if state:find('Executing', 1, true) then ai:StopExecutingCommand(handle.command, true)
        elseif state:find('Enqueued', 1, true) then ai:CancelCommand(handle.command) end
    end
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
    end
    local function log(line) if env.log then pcall(env.log, 'Companion tactic: ' .. line) end end
    local function feedback(message) if env.feedback and message then pcall(env.feedback, message) end end

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
        -- A defeated target needs nothing back; a living one gets its attitudes.
        if get(native.alive, a.target) and get(native.alive, a.companion) then
            pcall(native.stopFight, receipt, a.companion, a.target)
        end
    end

    local function finish(reason, message)
        local a = active
        if not a then return end
        releaseFight(a)
        active = nil
        last = {id = a.id, kind = a.kind, result = reason, phase = a.phase, trace = a.trace}
        log('finished (' .. tostring(reason) .. ')')
        if message then feedback(message) end
    end

    function T.cancel(reason, message) if active then finish(reason or 'cancelled', message) end end

    -- Forget every handle without native calls (world teardown).
    function T.abandon()
        active, offers = nil, {}
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

    -- The weapon in hand when the fight starts: already drawn, or asked for through the native equip command. The
    -- result is read back once the command has had time to run (T.update).
    local function drawWeapon(a)
        local ok, drawn, record = pcall(native.weapon, a.companion)
        if ok and drawn == true then
            a.draw = {state = 'drawn', at = clock}
            log('weapon already drawn (' .. tostring(record) .. ')')
            return
        end
        local requested, handle = pcall(native.drawWeapon, a.companion)
        if not requested then
            a.draw = {state = 'unavailable', at = clock}
            log('weapon draw unavailable: ' .. tostring(handle))
            return
        end
        a.draw = {state = 'requested', at = clock, handle = handle, readbacks = 0}
        log('weapon draw requested (hand ' .. (ok and 'empty' or 'unreadable') .. ')')
    end

    local function readBackWeapon(a)
        local draw = a.draw
        if not draw or draw.state ~= 'requested' then return end
        local wait = draw.readbacks == 0 and settings.drawReadback or settings.drawRetryReadback
        if clock - draw.at < wait then return end
        draw.readbacks = draw.readbacks + 1
        local ok, drawn, record = pcall(native.weapon, a.companion)
        if ok and drawn == true then
            draw.state = 'drawn'
            log('weapon readback: drawn (' .. tostring(record) .. ') after ' .. string.format('%.1f', clock - draw.at) .. 's')
        elseif draw.readbacks == 1 then
            -- One more request: the first may have been dropped while she was moving or the item was not yet attached.
            local again, handle = pcall(native.drawWeapon, a.companion)
            draw.at = clock
            if again then draw.handle = handle; log('weapon readback: ' .. (ok and 'hand still empty' or 'unreadable') .. ', draw asked again')
            else draw.state = 'unavailable'; log('weapon readback: ' .. (ok and 'hand still empty' or 'unreadable') .. ', draw refused: ' .. tostring(handle)) end
        else
            draw.state = 'empty'
            log('weapon readback: ' .. (ok and 'hand still empty' or 'unreadable') .. ', the combat AI decides')
        end
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
        for _, line in ipairs(type(receipt.reaction) == 'table' and receipt.reaction.notes or {}) do log('reaction: ' .. tostring(line)) end
        enter('fight-approach', 'fight accepted: ' .. captured.name .. ' ' .. captured.targetId)
        drawWeapon(active)
        return true, (actor.name or 'Your companion') .. ' is going after ' .. captured.name .. '.'
    end

    function T.owns(serial) return active ~= nil and active.serial == serial end

    -- Movement decision for the owned copy, in the companion behavior schema.
    function T.decide(serial, context, _)
        local a = active
        if not a or a.serial ~= serial then return nil end
        local operation
        if a.phase == 'fight-approach' then
            if context.combat then operation = op('release')
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
        local a = active
        if not a then return end
        local actor = actorFor(a.entity)
        if not actor or actor.serial ~= a.serial or actor.npc ~= a.companion and get(native.key, actor.npc) ~= a.entity then
            finish('companion-unavailable'); return
        end
        if get(native.playerMounted, player) then finish('vehicle'); return end
        local targetAlive = get(native.alive, a.target) == true
        local elapsed = clock - a.since
        if not targetAlive then finish('target-down'); return end
        readBackWeapon(a)
        local fighting = get(native.inCombat, a.companion)
        if a.phase == 'fight-approach' then
            if fighting then enter('fighting', 'native combat engaged')
            elseif elapsed > settings.fightStartTimeout then
                finish('no-combat', (a.companionName or 'Your companion') .. ' could not engage the target.'); return
            end
        end
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
