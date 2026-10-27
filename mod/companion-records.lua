-- Spawn adaptations belong to private records. Never weaponize a quest actor
-- by changing Character.Silverhand (or a donor's shared equipment records).
local M = {}
local prepared
local johnnySource = 'Character.Silverhand'
local johnnyCopy = 'CyberpunkConvai.JohnnyCompanion'
-- Johnny's template maps both default/riot blendable appearances to this solid
-- appearance. Select it at creation: changing the appearance after attachment
-- replaces the prepared face_rig through an ownerless native builder request.
local johnnyAppearance = 'silverhand_riot__not_blendable'
-- The native Kerry template defaults to his Q203 shower appearance. Its old
-- no-sunglasses mapping has the normal shirt/pants outfit. Choose that in the
-- owned copy's spawn spec, before its facial components are initialized.
local kerrySource = 'Character.Kerry'
local kerryAppearance = 'kerry_eurodyne_kerry_eurodyne_old_no_sunglasses'

-- A pedestrian's record is flagged crowd (ScriptedPuppet.IsCrowd reads the
-- record), so a copy spawned from it is a crowd member and cannot follow. A
-- world character who joins V (docs/WORLD_COMPANIONS.md) is spawned from a
-- private clone with the crowd flags off: same template, appearances and
-- voice. nil = not a crowd record (or unreadable), false = the clone failed.
local crowdCopies = {}
local function nonCrowd(source)
    local key = tostring(source)
    if crowdCopies[key] ~= nil then return crowdCopies[key] or false, crowdCopies[key] and crowdCopies[key .. ':name'] end
    local ok, flags = pcall(function()
        local record = TweakDB:GetRecord(source)
        if not record then error('missing record') end
        local light = false
        pcall(function() light = record:IsLightCrowd() == true end)
        return {crowd = record:IsCrowd() == true, light = light}
    end)
    -- An unreadable flag adapts nothing; attachment still rejects a crowd copy.
    if not ok then return nil end
    if not flags.crowd and not flags.light then return nil end
    local cloned, result = pcall(function()
        local label = tostring(TDBID.ToStringDEBUG(source) or ''):gsub('^Character%.', ''):gsub('[^%w_]', '_')
        if label == '' or label:find('^<') then label = tostring(source.hash) .. '_' .. tostring(source.length) end
        local name = 'CyberpunkConvai.NonCrowd_' .. label
        if not TweakDB:GetRecord(name) and not TweakDB:CloneRecord(name, source) then error('clone failed') end
        TweakDB:SetFlat(name .. '.isCrowd', false)
        if flags.light then TweakDB:SetFlat(name .. '.isLightCrowd', false) end
        if TweakDB:GetFlat(name .. '.isCrowd') ~= false then error('crowd flag readback differs') end
        return name
    end)
    if not cloned then crowdCopies[key] = false; return false end
    crowdCopies[key], crowdCopies[key .. ':name'] = TweakDBID.new(result), result
    return crowdCopies[key], result
end

-- Quest-base records (Quest_NPC_Base: Alex, Johnny, ...) add only crouch and
-- sprint: no shooting or hand abilities, no combat archetype, no weapon. In
-- combat the game's autonomous AI then has nothing to fight with and the copy
-- runs away (Alex, 2026-10-11; Johnny, docs/COMPANION_COMBAT.md). Such a record
-- is spawned from a private clone with the known working ranged set of Judy
-- added to its own abilities. Shared game records are only read. A record that
-- already has a combat ability, or one that cannot be read, is left alone, and a
-- clone that fails leaves the original record in use (the copy may then flee,
-- but it still spawns). nil = no adaptation; otherwise the clone's id and name.
-- One probe.log line per spawn record decision (rare; never per frame). M.log may be replaced.
M.log = function(line)
    local file = io.open('runtime/probe.log', 'a')
    if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', line, '\n'); file:close() end
end
local function note(line) if M.log then pcall(M.log, line) end end
-- Switch off without a code change: create runtime/armed-clones-off (read at each spawn).
local function armedDisabled()
    if M.armedClones == false then return true end
    local ok, file = pcall(io.open, 'runtime/armed-clones-off', 'rb')
    if ok and file then file:close(); return true end
    return false
end
local combatDonor = 'Character.Judy'
local combatAbilities = {'Ability.CanShootWhileMoving', 'Ability.CanCloseCombat', 'Ability.HasChargeJump'}
local armedCopies = {}
local function combatCapable(source)
    local ok, result = pcall(function()
        local record = TweakDB:GetRecord(source)
        if not record then error('missing record') end
        local known = 0
        for _, name in ipairs(combatAbilities) do
            local ability = TweakDBInterface.GetGameplayAbilityRecord(TweakDBID.new(name))
            if ability then
                known = known + 1
                if record:AbilitiesContains(ability) then return true end
            end
        end
        if known == 0 then error('no ability records') end
        return false
    end)
    if ok then return result end
    return nil
end
local function armed(source)
    local key = tostring(source)
    local cached = armedCopies[key]
    if cached ~= nil then return cached and cached.id, cached and cached.name end
    local capable = combatCapable(source)
    if capable ~= false then
        armedCopies[key] = false
        note('Companion spawn record: original (' .. (capable == true and 'already combat-capable' or 'abilities unreadable') .. ')')
        return nil
    end
    local made, result = pcall(function()
        local changes = {}
        for _, field in ipairs({'abilities', 'archetypeData', 'primaryEquipment', 'secondaryEquipment'}) do
            local value = TweakDB:GetFlat(combatDonor .. '.' .. field)
            if value == nil then error('Missing ' .. combatDonor .. '.' .. field) end
            if field == 'archetypeData' or field == 'primaryEquipment' then
                if not TweakDB:GetRecord(value) then error('Missing combat record for ' .. field) end
            end
            changes[field] = value
        end
        if #changes.abilities == 0 then error('Ranged companion abilities are empty') end
        local label = tostring(TDBID.ToStringDEBUG(source) or ''):gsub('^Character%.', ''):gsub('[^%w_]', '_')
        if label == '' or label:find('^<') then label = tostring(source.hash) .. '_' .. tostring(source.length) end
        local name = 'CyberpunkConvai.Armed_' .. label
        if not TweakDB:GetRecord(name) and not TweakDB:CloneRecord(name, source) then error('clone failed') end
        -- Keep the record's own abilities and add the donor's that it lacks.
        local merged = {}
        for _, group in ipairs({TweakDB:GetFlat(name .. '.abilities') or {}, changes.abilities}) do
            for _, ability in ipairs(group) do
                local present = false
                for _, have in ipairs(merged) do if have == ability then present = true; break end end
                if not present then merged[#merged + 1] = ability end
            end
        end
        changes.abilities = merged
        if TweakDB:SetFlats(name, changes) == false then error('Could not apply combat capabilities') end
        local actual = TweakDB:GetFlat(name .. '.abilities')
        if not actual or #actual ~= #merged then error('Abilities were not applied') end
        for field, expected in pairs(changes) do
            if field ~= 'abilities' and TweakDB:GetFlat(name .. '.' .. field) ~= expected then
                error('Combat readback differs: ' .. field)
            end
        end
        return name
    end)
    if not made then
        armedCopies[key] = false
        note('Companion spawn record: armed clone failed (' .. tostring(result):sub(1, 160) .. '); using the original record')
        return nil
    end
    note('Companion spawn record: ' .. result .. ' (armed clone)')
    armedCopies[key] = {id = TweakDBID.new(result), name = result}
    return armedCopies[key].id, result
end

-- A record to spawn a body that is only seen (a holocall's copy, mod/holocall.lua): the record itself, or its private non-crowd clone when it is a
-- pedestrian's (a crowd copy gets no face layer). nil when it is a crowd record that cannot be cloned. The second value is the clone's name.
-- No combat adaptation: the copy stands in a pose and never fights.
function M.visual(source)
    local copy, name = nonCrowd(source)
    if copy == false then return nil end
    if copy then return copy, name end
    return source, nil
end

function M.resolve(source)
    if source == TweakDBID.new(kerrySource) then return source, nil, nil, kerryAppearance end
    if source ~= TweakDBID.new(johnnySource) then
        local copy, name = nonCrowd(source)
        if copy == false then return nil, 'This character cannot be copied as a companion.' end
        if armedDisabled() then
            if copy then return copy, nil, name end
            return source
        end
        -- The fifth value is the record to fall back to if the entity cannot be created from the clone.
        local armedId, armedName = armed(copy or source)
        if armedId then return armedId, nil, armedName, nil, copy or source end
        if copy then return copy, nil, name end
        return source
    end
    if prepared and TweakDB:GetRecord(prepared) then return prepared, nil, johnnyCopy, johnnyAppearance end

    local ok, result = pcall(function()
        -- Johnny's quest record has crouch/sprint, but no shooting abilities,
        -- combat archetype or weapon. Judy supplies the known working ranged
        -- capability set. Grayson's primary pool equips the NPC Malorian 3516.
        local changes = {}
        for field, donor in pairs({abilities = 'Character.Judy',
            archetypeData = 'Character.Judy', secondaryEquipment = 'Character.Judy',
            primaryEquipment = 'Character.Grayson'}) do
            local value = TweakDB:GetFlat(donor .. '.' .. field)
            if value == nil then error('Missing ' .. donor .. '.' .. field) end
            if field == 'abilities' then
                if #value == 0 then error('Ranged companion abilities are empty') end
                local copy = {}
                for i, ability in ipairs(value) do copy[i] = ability end
                value = copy
            elseif field ~= 'secondaryEquipment' and not TweakDB:GetRecord(value) then
                error('Missing combat record for ' .. field)
            end
            changes[field] = value
        end
        -- Preflight the donors before creating anything. Partial writes, if a
        -- native call fails, stay private and cannot be used for a spawn.
        if not TweakDB:GetRecord(johnnyCopy) then
            if not TweakDB:CloneRecord(johnnyCopy, johnnySource) then
                error('Could not prepare Johnny companion record')
            end
        end
        if TweakDB:SetFlats(johnnyCopy, changes) == false then
            error('Could not apply Johnny combat capabilities')
        end
        for field, expected in pairs(changes) do
            local actual = TweakDB:GetFlat(johnnyCopy .. '.' .. field)
            if field == 'abilities' then
                if not actual or #actual ~= #expected then error('Abilities were not applied') end
                for i, ability in ipairs(expected) do
                    if actual[i] ~= ability then error('Combat ability readback differs') end
                end
            elseif actual ~= expected then error('Combat readback differs: ' .. field) end
        end
        return TweakDBID.new(johnnyCopy)
    end)
    if not ok then return nil, 'Johnny combat preparation failed: ' .. tostring(result) end
    prepared = result
    return prepared, nil, johnnyCopy, johnnyAppearance
end

-- Invulnerability on the copy. Johnny and Alex carry the game's own `Invulnerable` record tag; the installed script
-- (cyberpunk/managers/npcManager.script, SetNPCImmortalityMode) turns that tag into
-- GodModeSystem:AddGodMode(entity, gameGodModeType.Invulnerable, 'Default') when the puppet initialises. Alt Cunningham's
-- record has no tags, and a flat that does not exist is not safe to create through TweakDB:SetFlat in this install
-- (docs/COMPANION_COMBAT.md). So her copy makes the same call itself, once, when the copy attaches (companions.lua
-- attachFollower), with its own source name (the script's UnInit clears only 'Default'), reads it back, and gives it back
-- before the copy is deleted. Nothing runs per frame. Only the mod-spawned copy is touched: the story character is not.
-- Keyed by model record, like the other per-model adaptations here, so her copy is protected under any chat profile.
local invulnerableModels = {'Character.Alt'}
local protectionSource = 'CyberpunkConvaiProtection'
function M.invulnerable(modelRecordID)
    if modelRecordID == nil then return false end
    for _, name in ipairs(invulnerableModels) do
        if modelRecordID == TweakDBID.new(name) then return true end
    end
    return false
end
local function protection(entityID, grant)
    local system = Game.GetGodModeSystem()
    if not system then error('no god mode system') end
    local mode = Enum.new('gameGodModeType', 'Invulnerable')
    if grant then
        system:AddGodMode(entityID, mode, CName.new(protectionSource))
        if system:HasGodMode(entityID, mode) ~= true then error('readback is false') end
    else
        system:RemoveGodMode(entityID, mode, CName.new(protectionSource))
    end
end
-- true: protected (read back); false: asked but not confirmed (logged); nil: this model is not protected.
function M.protect(entityID, modelRecordID)
    if not M.invulnerable(modelRecordID) then return nil end
    local ok, err = pcall(protection, entityID, true)
    note('Companion protection: invulnerable ' .. (ok and 'granted' or ('not granted (' .. tostring(err):sub(1, 120) .. ')')))
    return ok
end
-- Called once before the copy is deleted; a failure only leaves a stale entry for an entity that is going away.
function M.unprotect(entityID)
    local ok, err = pcall(protection, entityID, false)
    if not ok then note('Companion protection: release failed (' .. tostring(err):sub(1, 120) .. ')') end
    return ok
end

-- Combat readiness at attach (docs/COMPANION_IMPROVEMENTS_2026-10-17.md item 5). Called once from companions.lua
-- attachFollower for the copy this mod just created; nothing here runs per frame.
-- 1. Level: the game's own NPCManager.ScaleToPlayer (cyberpunk/managers/npcManager.script, a private script function; the
--    puppet keeps the manager in m_NPCManager and no accessor exists). It drops the copy's PowerLevel modifiers and adds
--    V's PowerLevel and Level as additive modifiers. If the manager cannot be reached, the same three stat calls are made
--    directly. The level is read before and after and logged. Equipment is not touched by either path.
-- 2. Attitude: the follower role (AIFollowerRole.OnRoleSet, aiRole.script) puts the copy into V's attitude group. The group
--    and the attitude towards V are read back once and a difference is logged. Nothing is corrected here.
-- Only a copy that carries our own spawn tag is touched, so a character of the game or of another mod never is.
-- Switch off without a code change: create runtime/companion-scaling-off (read at each attach).
local ownTag = 'CyberpunkConvaiCompanion'
local function scalingDisabled()
    if M.scaling == false then return true end
    local ok, file = pcall(io.open, 'runtime/companion-scaling-off', 'rb')
    if ok and file then file:close(); return true end
    return false
end
local function plainName(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    if type(NameToString) == 'function' then
        local ok, name = pcall(NameToString, value)
        if ok and type(name) == 'string' then return name end
    end
    local raw = tostring(value)
    return raw:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or raw
end
local function statLevel(entityID)
    return Game.GetStatsSystem():GetStatValue(entityID, Enum.new('gamedataStatType', 'Level'))
end
local function scaleToPlayer(npc, player)
    local reached, manager = pcall(function() return npc.m_NPCManager end)
    if reached and manager ~= nil then
        if pcall(function() manager:ScaleToPlayer() end) then return 'npc-manager' end
    end
    local stats = Game.GetStatsSystem()
    local power, level = Enum.new('gamedataStatType', 'PowerLevel'), Enum.new('gamedataStatType', 'Level')
    local additive = Enum.new('gameStatModifierType', 'Additive')
    local id, playerID = npc:GetEntityID(), player:GetEntityID()
    local playerPower, playerLevel = stats:GetStatValue(playerID, power), stats:GetStatValue(playerID, level)
    stats:RemoveAllModifiers(id, power)
    stats:AddModifier(id, RPGManager.CreateStatModifier(power, additive, playerPower))
    stats:AddModifier(id, RPGManager.CreateStatModifier(level, additive, playerLevel))
    return 'stats'
end
-- The follower role's attitude: same group as V and a friendly attitude towards V. Raises when the game will not say.
-- Returns true, or false and a description.
function M.attitudeReadBack(npc, player)
    local own, other = npc:GetAttitudeAgent(), player:GetAttitudeAgent()
    local group, wanted = plainName(own:GetAttitudeGroup()), plainName(other:GetAttitudeGroup())
    local towards = tostring(own:GetAttitudeTowards(other))
    local friendly = towards:find('AIA_Friendly', 1, true) ~= nil
    local detail = 'group ' .. tostring(group) .. ' (V: ' .. tostring(wanted) .. '), towards V ' .. (towards:match('AIA_%a+') or towards)
    return group == wanted and friendly, detail
end
-- Returns {scaled, method, before, after, attitude = 'ok'|'mismatch'|'unreadable'}, or nil when this is not our copy.
function M.prepare(system, entityID, npc, player, label)
    local owned, ours = pcall(function() return system:IsTagged(entityID, CName.new(ownTag)) end)
    if not owned or not ours then return nil end
    local report = {}
    if scalingDisabled() then
        note('Companion readiness: ' .. tostring(label) .. ' level scaling is switched off')
    else
        local before, after, playerLevel
        pcall(function() before = statLevel(npc:GetEntityID()) end)
        local scaled, method = pcall(scaleToPlayer, npc, player)
        if scaled then
            pcall(function() after = statLevel(npc:GetEntityID()) end)
            pcall(function() playerLevel = statLevel(player:GetEntityID()) end)
            report.scaled, report.method, report.before, report.after = true, method, before, after
            note(string.format('Companion readiness: %s level %s -> %s (V %s) via %s', tostring(label), tostring(before),
                tostring(after), tostring(playerLevel), method))
        else
            note('Companion readiness: ' .. tostring(label) .. ' level scaling failed (' .. tostring(method):sub(1, 160) .. ')')
        end
    end
    local read, ok, detail = pcall(M.attitudeReadBack, npc, player)
    if not read then
        report.attitude = 'unreadable'
        note('Companion readiness: ' .. tostring(label) .. ' attitude unreadable (' .. tostring(ok):sub(1, 120) .. ')')
    elseif ok then
        report.attitude = 'ok'
        note('Companion readiness: ' .. tostring(label) .. ' attitude ok, ' .. detail)
    else
        report.attitude = 'mismatch'
        note('Companion readiness: ' .. tostring(label) .. ' attitude differs at attach, ' .. detail .. '; read again shortly')
    end
    return report
end
-- The one re-read after a difference at attach (the role may not have finished). Returns true when it matches.
function M.attitudeRecheck(npc, player, label)
    local read, ok, detail = pcall(M.attitudeReadBack, npc, player)
    if not read then
        note('Companion readiness: ' .. tostring(label) .. ' attitude unreadable on re-read (' .. tostring(ok):sub(1, 120) .. ')')
        return false
    end
    note('Companion readiness: ' .. tostring(label) .. ' attitude ' .. (ok and 'ok on re-read, ' or 'MISMATCH, ') .. detail)
    return ok
end

return M
