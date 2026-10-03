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

function M.resolve(source)
    if source == TweakDBID.new(kerrySource) then return source, nil, nil, kerryAppearance end
    if source ~= TweakDBID.new(johnnySource) then return source end
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
