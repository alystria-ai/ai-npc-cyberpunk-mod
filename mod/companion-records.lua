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

function M.resolve(source)
    if source == TweakDBID.new(kerrySource) then return source, nil, nil, kerryAppearance end
    if source ~= TweakDBID.new(johnnySource) then
        local copy, name = nonCrowd(source)
        if copy then return copy, nil, name end
        if copy == false then return nil, 'This character cannot be copied as a companion.' end
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
