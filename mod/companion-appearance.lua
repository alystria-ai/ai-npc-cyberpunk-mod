-- Called only while attaching a copy created by our DynamicEntitySystem owner.
-- Story Johnny has a phantom controller: his meshes may be loaded and enabled
-- while that controller hides the entire entity. A companion copy is physical.
local M = {}

function M.prepare(npc)
    local phantomCount = 0
    for _, component in ipairs(npc:GetComponents()) do
        if component:IsA('gamePhantomEntityComponent') then
            component:Toggle(false)
            if component:IsEnabled() then
                error('The character visibility controller could not be disabled.')
            end
            phantomCount = phantomCount + 1
        end
    end
    if phantomCount > 0 then
        local event = NewObject('enteventsSetVisibility')
        event.visible = true
        event.source = Enum.new('entVisibilityParamSource', 'PhantomEntitySystem')
        npc:QueueEvent(event)
    end
    return phantomCount
end

return M
