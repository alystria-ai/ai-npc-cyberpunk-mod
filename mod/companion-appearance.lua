-- Called only while attaching a copy created by our DynamicEntitySystem owner.
-- Story Johnny has a phantom controller: his meshes may be loaded and enabled
-- while that controller hides the entire entity. A companion copy is physical.
local M = {}

function M.prepare(npc)
    local components = npc:GetComponents()
    local physicalAppearance
    -- Disabling the phantom controller does not replace Johnny's blendable
    -- materials. They still fade/glitch when the camera faces a seated copy.
    -- Use the template's explicit mapping rather than guessing a wardrobe name
    -- or changing shared story records. This runs once on our attached copy.
    for _, component in ipairs(components) do
        if component:IsA('gamePhantomEntityComponent') then
            local matches = component.params and component.params.blendableAppearanceMatches
            if matches and #matches > 0 then
                local current = npc:GetCurrentAppearanceName()
                for _, match in ipairs(matches) do
                    if match.blendable == current then
                        local target = match.notBlendable
                        local name = target and NameToString(target)
                        if name and name ~= '' and name ~= 'None' and target ~= current then
                            if physicalAppearance and physicalAppearance ~= target then
                                error('The character has conflicting physical appearance mappings.')
                            end
                            physicalAppearance = target
                        end
                    end
                end
            end
        end
    end
    local phantomCount = 0
    for _, component in ipairs(components) do
        if component:IsA('gamePhantomEntityComponent') then
            component:Toggle(false)
            if component:IsEnabled() then
                error('The character visibility controller could not be disabled.')
            end
            phantomCount = phantomCount + 1
        end
    end
    if physicalAppearance then npc:ScheduleAppearanceChange(physicalAppearance) end
    if phantomCount > 0 then
        local event = NewObject('enteventsSetVisibility')
        event.visible = true
        event.source = Enum.new('entVisibilityParamSource', 'PhantomEntitySystem')
        npc:QueueEvent(event)
    end
    return phantomCount
end

return M
