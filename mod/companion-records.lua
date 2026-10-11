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
    if combatCapable(source) ~= false then armedCopies[key] = false; return nil end
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
    if not made then armedCopies[key] = false; return nil end
    armedCopies[key] = {id = TweakDBID.new(result), name = result}
    return armedCopies[key].id, result
end

function M.resolve(source)
    if source == TweakDBID.new(kerrySource) then return source, nil, nil, kerryAppearance end
    if source ~= TweakDBID.new(johnnySource) then
        local copy, name = nonCrowd(source)
        if copy == false then return nil, 'This character cannot be copied as a companion.' end
        local armedId, armedName = armed(copy or source)
        if armedId then return armedId, nil, armedName end
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

return M
