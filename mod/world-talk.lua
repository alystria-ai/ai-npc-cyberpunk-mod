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

-- The game's own injury and incapacitation signal (the same five tags mod/facial-playback.lua checks).
local INJURY = {'Injured', 'Defeated', 'Unconscious', 'Stunned', 'Ragdoll'}

-- The first reason the character cannot be talked to, from plain facts, or nil. A fact that could not be read is nil and the
-- answer is 'unreadable': the character is left alone rather than risk talking over the game. Pure.
--   gone      not in the world any more, or dead
--   hub       V is in a quest conversation (a choice hub), a phone call or a scene of her own (scene tier above 1)
--   dialogue  the character is in a scene or quest dialogue
--   driven    the game's AI is not on its own (a scene or quest commands it)
--   combat    the character or V is in a fight
--   hurt      the character is injured, defeated, unconscious, stunned or ragdolled
--   vehicle   the character is mounted in a vehicle
function M.classify(facts)
    if type(facts) ~= 'table' then return 'unreadable' end
    if facts.gone == true then return 'gone' end
    if facts.hub == true then return 'hub' end
    if facts.dialogue == true then return 'dialogue' end
    if facts.driven == true then return 'driven' end
    if facts.combat == true or facts.playerCombat == true then return 'combat' end
    if facts.hurt == true then return 'hurt' end
    if facts.mounted == true then return 'vehicle' end
    for _, name in ipairs({'gone', 'hub', 'dialogue', 'driven', 'combat', 'hurt', 'mounted'}) do
        if type(facts[name]) ~= 'boolean' then return 'unreadable' end
    end
    return nil
end

-- What the player is told, by reason (the notice text itself is the interface's, mod/init.lua).
M.REASONS = {gone = true, hub = true, dialogue = true, driven = true, combat = true, hurt = true, vehicle = true, unreadable = true}

-- The native reads, each in its own pcall so one missing API leaves only that fact unread. `sample` is the player-side sample of
-- mod/battle-observer.lua (V's scene tier, quest dialogue, choice hub, phone call and combat), asked once per call.
function M.read(npc, player, sample)
    local facts = {}
    local function try(name, read)
        local ok, value = pcall(read)
        if ok and type(value) == 'boolean' then facts[name] = value end
    end
    try('gone', function() return not npc:IsAttached() or npc:IsDeadNoStatPool() end)
    try('driven', function() return not npc:IsOnAutonomousAI() end)
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
        facts.hub = seen.dialogue == true or seen.choices == true or seen.call == true or (seen.tier ~= nil and seen.tier ~= 1)
        facts.playerCombat = seen.combat == true
    end
    return facts
end

-- options.sample(player): the player-side sample. options.clock: seconds (os.clock). The answers are held HOLD_SECONDS per
-- character, so a poll that asks twice in a row costs one set of reads.
function M.new(options)
    options = type(options) == 'table' and options or {}
    local clock = options.clock or os.clock
    local service = {held = {}, count = 0}

    -- The reason the character cannot be talked to now, or nil. entity: its entity hash text (the hold's key).
    function service:refusal(npc, player, entity)
        if not npc then return 'gone' end
        local now = clock()
        local held = entity and self.held[entity]
        if held and now >= held.at and now - held.at < M.HOLD_SECONDS then return held.reason end
        local reason = M.classify(M.read(npc, player, options.sample))
        if entity then
            if not self.held[entity] then
                if self.count >= M.LIMIT then self.held, self.count = {}, 0 end
                self.count = self.count + 1
            end
            self.held[entity] = {at = now, reason = reason}
        end
        return reason
    end

    function service:reset() self.held, self.count = {}, 0 end
    return service
end

return M
