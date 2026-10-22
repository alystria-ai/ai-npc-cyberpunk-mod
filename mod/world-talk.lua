-- Talking to the game's own named characters where they stand (docs/WORLD_CHARACTERS.md).
--
-- The rule since 2026-10-18: a story or named character the game placed (Judy, Jackie, Panam, Rogue, anyone on the roster) answers
-- the talk keys with their own profile, voice and memory, and the mod drives only their voice and their face while they speak
-- (lip sync and the expressive emotions). Nothing else of theirs is touched: no look-at, no turn, no idle or gesture, no
-- movement, no action, no party, no attitude, no equipment, no scanner name.
--
-- This module answers one question, and only when the player acts: "may V talk to this character right now?" It reads the
-- character and V once on a talk key press, on a voice recording's validity poll, and about twice a second while that
-- character's reply is being heard. It never runs without a conversation, never per frame, and it changes nothing. It names
-- the reasons the game itself is in charge of the character: a scene or quest dialogue, a quest conversation V is in, an AI a
-- scene or quest commands, a fight, an injury or a ride in a vehicle.
local M = {HOLD_SECONDS = 0.4, LIMIT = 16}

-- Characters that are a projection of V's own head, not a person the game stages (2026-10-21, a player's "busy right now" with no quest
-- running): Johnny Silverhand shows up in ambient moments (the passenger seat of V's car, V's apartment, a rooftop) through the game's
-- own scenes, workspots and mounts, so his AI is always commanded and he is often mounted. For him those two facts say nothing about
-- a quest, so they do not refuse (`driven` and `vehicle`). Everything that says the game has the floor still does: V in a quest
-- conversation, a call or a scene tier 3 or above (hub), Johnny in a scene dialogue (a line of the game's), a fight, an injury, gone.
M.PROJECTIONS = {['johnny-silverhand'] = true}

-- The game's own injury and incapacitation signal (the same five tags mod/facial-playback.lua checks).
local INJURY = {'Injured', 'Defeated', 'Unconscious', 'Stunned', 'Ragdoll'}

-- The first reason the character cannot be talked to, from plain facts, or nil. A fact that could not be read is nil and the
-- answer is 'unreadable': the character is left alone rather than risk talking over the game. Pure.
--   gone      not in the world any more, or dead
--   hub       V is in a quest conversation (a dialogue the game runs, with or without choices), a phone call or a scene of her own
--             (scene tier 3 or above: limited gameplay or a cinematic). Tier 2 is staged gameplay, V walking freely where the game
--             has staged its people (Viktor's clinic, Misty's shop), so it does not refuse by itself. A dialogue choice that is only
--             an interaction prompt ("Talk" on a ripperdoc, a vendor, a fixer standing at their post) is not a conversation: with V
--             at tier 1 or 2, not in a dialogue and not on a call, the prompt alone never refuses. A scene that commands the
--             character itself is still refused below (dialogue, driven)
--   dialogue  the character is in a scene or quest dialogue
--   driven    the game's AI is not on its own (a scene or quest commands it)
--             idle (a quest-bound person with no roster profile: the receptionist, the Afterlife bouncer) lets a commanded AI through
--             while the person stands in a workspot and V is in open gameplay (scene tier 1, `staged` not true): a post the quest gave
--             them is not a scene, but a scene's own seated or waiting actor is in a workspot too, with V past tier 1. V's own scene, dialogue and call (hub),
--             the person's dialogue, a fight, an injury and a ride still refuse
--   combat    the character or V is in a fight
--   hurt      the character is injured, defeated, unconscious, stunned or ragdolled
--   vehicle   the character is mounted in a vehicle
-- projection (true for M.PROJECTIONS' keys): `driven` and `mounted` are not asked (see M.PROJECTIONS), read or not.
-- idle (true for a quest-bound person who is not on the roster): a commanded AI in a workspot is not `driven` (see above).
function M.classify(facts, projection, idle)
    if type(facts) ~= 'table' then return 'unreadable' end
    if facts.gone == true then return 'gone' end
    if facts.hub == true then return 'hub' end
    if facts.dialogue == true then return 'dialogue' end
    if facts.driven == true and projection ~= true and not (idle == true and facts.workspot == true and facts.staged ~= true) then return 'driven' end
    if facts.combat == true or facts.playerCombat == true then return 'combat' end
    if facts.hurt == true then return 'hurt' end
    if facts.mounted == true and projection ~= true then return 'vehicle' end
    for _, name in ipairs({'gone', 'hub', 'dialogue', 'driven', 'combat', 'hurt', 'mounted'}) do
        if type(facts[name]) ~= 'boolean' and not (projection == true and (name == 'driven' or name == 'mounted')) then return 'unreadable' end
    end
    return nil
end

-- The facts behind an answer as one plain line for the probe log (a refusal only): "gone=false hub=false ... " with "?" for a fact
-- that could not be read. Pure.
function M.describe(facts, projection)
    if type(facts) ~= 'table' then return 'facts=none' end
    local parts = {}
    for _, name in ipairs({'gone', 'hub', 'dialogue', 'driven', 'workspot', 'staged', 'combat', 'playerCombat', 'hurt', 'mounted'}) do
        local value = facts[name]
        -- workspot and staged are read only for a quest-bound person with no roster profile (idle), so they are listed only when read.
        if (name ~= 'workspot' and name ~= 'staged') or value ~= nil then parts[#parts + 1] = name .. '=' .. (type(value) == 'boolean' and tostring(value) or '?') end
    end
    if projection == true then parts[#parts + 1] = 'projection=true' end
    return table.concat(parts, ' ')
end

-- What the player is told, by reason (the notice text itself is the interface's, mod/init.lua).
M.REASONS = {gone = true, hub = true, dialogue = true, driven = true, combat = true, hurt = true, vehicle = true, unreadable = true}

-- The native reads, each in its own pcall so one missing API leaves only that fact unread. `sample` is the player-side sample of
-- mod/battle-observer.lua (V's scene tier, quest dialogue, choice hub, phone call and combat), asked once per call.
-- idle: also read whether the person stands in a workspot (only a quest-bound person with no roster profile is asked).
function M.read(npc, player, sample, idle)
    local facts = {}
    local function try(name, read)
        local ok, value = pcall(read)
        if ok and type(value) == 'boolean' then facts[name] = value end
    end
    try('gone', function() return not npc:IsAttached() or npc:IsDeadNoStatPool() end)
    try('driven', function() return not npc:IsOnAutonomousAI() end)
    if idle == true then try('workspot', function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) == true end) end
    try('combat', function() return NPCPuppet.IsInCombat(npc) == true end)
    try('dialogue', function()
        return Game.GetSceneSystem():GetScriptInterface():IsEntityInDialogue(npc:GetEntityID()) == true
    end)
    try('mounted', function() return Game.GetMountingFacility():IsMountedToAnything(npc:GetEntityID()) == true end)
    try('hurt', function()
        for _, tag in ipairs(INJURY) do
            if StatusEffectSystem.ObjectHasStatusEffectWithTag(npc, CName.new(tag)) then return true end
        end
        return false
    end)
    local seen = type(sample) == 'function' and select(2, pcall(sample, player)) or nil
    if type(seen) == 'table' and seen.available == true then
        -- IsEntityInScene is deliberately not read: it stays true in ordinary gameplay (docs/WORLD_COMPANIONS.md).
        -- A shown dialogue choice (seen.choices) is also the game's own "Talk" prompt on an idle character V aims at (a ripperdoc, a
        -- vendor, a fixer): it counts only when the scene tier is unknown (fail closed). Tier 2 (staged gameplay) was V standing at
        -- Viktor's and Misty's posts with the Talk prompt up (18 Oct 11:02Z); a quest conversation sets V's dialogue flag or holds
        -- her at tier 3 or above, and a scene that commands the character is refused by dialogue or driven.
        local tier = tonumber(seen.tier)
        facts.hub = seen.dialogue == true or seen.call == true or (tier ~= nil and tier >= 3)
            or (seen.choices == true and tier == nil)
        facts.hubWhy = 'dialogue=' .. tostring(seen.dialogue) .. ' choices=' .. tostring(seen.choices) .. ' call=' .. tostring(seen.call)
            .. ' tier=' .. tostring(seen.tier)
        facts.playerCombat = seen.combat == true
        -- Staged or limited gameplay (tier 2 or more) or an unknown tier: a workspot is then no proof of an idle post (quest-marked idle persons only, as Face.reds).
        if idle == true then facts.staged = tier == nil or tier >= 2 end
    elseif idle == true then
        facts.staged = true   -- no player-side sample: fail closed, as Face.reds does when it cannot read the tier
    end
    -- An idle person the game does not mark as a quest person keeps the workspot as before (the bouncer at his door).
    if idle == true and facts.staged == true then
        local ok, marked = pcall(function() return npc:IsQuest() end)
        if ok and marked == false then facts.staged = false end
    end
    return facts
end

-- options.sample(player): the player-side sample. options.clock: seconds (os.clock). The answers are held HOLD_SECONDS per
-- character, so a poll that asks twice in a row costs one set of reads.
function M.new(options)
    options = type(options) == 'table' and options or {}
    local clock = options.clock or os.clock
    local service = {held = {}, count = 0}

    -- The reason the character cannot be talked to now, or nil. entity: its entity hash text (the hold's key). profileKey: the
    -- character's profile (a projection of V's head, M.PROJECTIONS, is not refused for a scene's AI or a ride). idle: a quest-bound person
    -- with no roster profile (a commanded AI at a workspot is not refused, see M.classify).
    function service:refusal(npc, player, entity, profileKey, idle)
        if not npc then return 'gone' end
        local now = clock()
        local held = entity and self.held[entity]
        if held and now >= held.at and now - held.at < M.HOLD_SECONDS then
            self.detail, self.facts = held.detail, held.facts
            return held.reason
        end
        local projection = profileKey ~= nil and M.PROJECTIONS[profileKey] == true
        local facts = M.read(npc, player, options.sample, idle)
        local reason = M.classify(facts, projection, idle)
        -- The player-side facts behind a hub refusal and every fact read, for the probe-log line on the talk key press (set on every
        -- read, never held beyond the answer's own hold; text built only when something refuses).
        self.detail = reason == 'hub' and type(facts) == 'table' and facts.hubWhy or nil
        self.facts = reason ~= nil and M.describe(facts, projection) or nil
        if entity then
            if not self.held[entity] then
                if self.count >= M.LIMIT then self.held, self.count = {}, 0 end
                self.count = self.count + 1
            end
            self.held[entity] = {at = now, reason = reason, detail = self.detail, facts = self.facts}
        end
        return reason
    end

    function service:reset() self.held, self.count = {}, 0 end
    return service
end

return M
