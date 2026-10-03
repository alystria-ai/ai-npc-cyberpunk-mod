-- Read-only native sampling. Never retain an entity, component, or blackboard.
local M = {}

local function label(value)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('<[^>]*>', ''):gsub('%c', ' '):match('^%s*(.-)%s*$')
    if value == '' or #value > 240 or value:match('^LocKey#') then return nil end
    return value
end

function M.sample(player)
    local sample = {available = false, blocked = true, reason = 'Player unavailable', opponents = {}}
    local ok, err = pcall(function()
        if not player or not player:IsAttached() or player:IsDeadNoStatPool() then return end
        sample.combat = player:IsInCombat()
        if type(sample.combat) ~= 'boolean' then error('Combat state unavailable') end
        sample.available = true
        local scene = Game.GetSceneSystem():GetScriptInterface()
        sample.tier = PlayerPuppet.GetSceneTier(player)
        sample.dialogue = scene:IsEntityInDialogue(player:GetEntityID())
        sample.scene = scene:IsEntityInScene(player:GetEntityID())
        local defs = Game.GetAllBlackboardDefs()
        local board = Game.GetBlackboardSystem():Get(defs.UI_ComDevice)
        local call = FromVariant(board:GetVariant(defs.UI_ComDevice.PhoneCallInformation))
        sample.call = call ~= nil and (call.callPhase == Enum.new('questPhoneCallPhase', 'IncomingCall')
            or call.callPhase == Enum.new('questPhoneCallPhase', 'StartCall'))
        local choices = FromVariant(Game.GetBlackboardSystem():Get(defs.UIInteractions):GetVariant(defs.UIInteractions.DialogChoiceHubs))
        sample.choices = choices ~= nil and #choices.choiceHubs > 0
        sample.vehicle = player:GetMountedVehicle() ~= nil
        sample.replacer = player:IsReplacer()
        -- IsEntityInScene can remain true in ordinary tier-one gameplay.
        sample.blocked = sample.tier ~= 1 or sample.dialogue or sample.choices or sample.call or sample.vehicle or sample.replacer
        sample.reason = sample.blocked and 'Scripted scene, call or vehicle' or 'Open gameplay'
        if not sample.combat then return end
        -- Record only a hostile NPC V is actually looking at, not every actor
        -- in the district. No names from hidden assets, kills, or victory guesses.
        local npc = Game.GetTargetingSystem():GetLookAtObject(player, true, true)
        if not npc or not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return end
        if npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent()) ~= Enum.new('EAIAttitude', 'AIA_Hostile')
            or not NPCPuppet.IsInCombat(npc) then return end
        local a, b = player:GetWorldPosition(), npc:GetWorldPosition()
        if (a.x-b.x)^2 + (a.y-b.y)^2 + (a.z-b.z)^2 > 40^2 then return end
        local name = label(npc:GetTweakDBFullDisplayName(true))
        if not name then return end
        local kind
        pcall(function()
            local nativeType = npc:GetNPCType()
            for _, value in ipairs({'Human', 'Android', 'Drone', 'Mech'}) do
                if nativeType == Enum.new('gamedataNPCType', value) then kind = value; break end
            end
        end)
        sample.opponents[1] = {entity = tostring(npc:GetEntityID().hash), name = name, kind = kind}
    end)
    if not ok then sample.blocked, sample.reason, sample.error = true, 'Native observation unavailable', tostring(err) end
    return sample
end

function M.canSpeak(npc, phase)
    local ok, ready, reason, waiting = pcall(function()
        if not npc then return false, 'missing' end
        if not npc:IsAttached() then return false, 'detached' end
        if npc:IsDeadNoStatPool() then return false, 'dead' end
        -- Callers supply owned companion copies. A story-controlled actor is
        -- unavailable; native speech on autonomous AI may finish shortly.
        if not npc:IsOnAutonomousAI() then return false, 'story-control' end
        local scene = Game.GetSceneSystem():GetScriptInterface()
        if scene:IsEntityInDialogue(npc:GetEntityID()) then return false, 'native-dialogue', true end
        if scene:IsEntityInScene(npc:GetEntityID()) then return false, 'native-scene', true end
        if phase ~= 'start' and NPCPuppet.IsInCombat(npc) then return false, 'still-in-combat' end
        return true, 'available'
    end)
    return ok and ready, ok and reason or 'native-read-failed', ok and waiting == true
end

-- Admission is sampled again when audio/captions are actually ready. A scene,
-- call or combat transition can start between the half-second policy polls.
-- Unlike a temporary autonomous NPC bark, these player transitions cancel the
-- automatic reply rather than letting it wait through scripted dialogue.
function M.canDeliver(player, npc, phase)
    local sample = M.sample(player)
    if not sample.available then return false, 'player-observation-unavailable', false end
    if sample.blocked then return false, 'player-scene-blocked', false end
    if phase == 'start' and not sample.combat then return false, 'combat-ended', false end
    if phase ~= 'start' and sample.combat then return false, 'combat-resumed', false end
    return M.canSpeak(npc, phase)
end

return M
