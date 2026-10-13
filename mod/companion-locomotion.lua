-- The native MoveTo handler leaves its previous facing entity in the behavior
-- argument when the next command has no facing target. Clear it for our own
-- ordinary travel commands, before native locomotion consumes those arguments.
-- active: false until a managed copy exists. companions.lua keeps it (spawn, every update, and false again in abandon).
local M = {cleared = 0, checked = 0, active = false}

function M.apply(handler, context, command)
    if command.rotateEntityTowardsFacingTarget
        or AIPositionSpec.IsEntity(command.facingTarget) then return false end
    local mapping = handler.outFacingTarget
    if not mapping then return false end
    if not tostring(mapping:GetArgumentType()):find('Object', 1, true)
        or not tostring(mapping:GetParameterizationType()):find('BehaviorArgument', 1, true) then
        return false
    end
    local argument = mapping:GetArgumentName()
    M.checked = M.checked + 1
    if not ScriptExecutionContext.GetArgumentObject(context, argument) then return false end
    -- A typed weak GameObject setter can express null without guessing how to
    -- construct an untyped nil Variant. Never retain the context or handler.
    ScriptExecutionContext.SetArgumentObject(context, argument, nil)
    if ScriptExecutionContext.GetArgumentObject(context, argument) then
        error('The native walking facing target was not cleared')
    end
    M.cleared = M.cleared + 1
    return true
end

function M.install(ownsCommand)
    M.ownsCommand = ownsCommand
    if M.installed then return end
    -- UpdateCommand runs every frame for every NPC walking on a MoveTo command.
    -- Without a travelling companion (M.active, kept by the caller) return
    -- before any native call; otherwise no closure is allocated per call.
    -- M.active is false from the start and again from the moment a session is
    -- abandoned (a load, a detach): the engine is then destroying the AI
    -- contexts this callback would read the owner of, and no update runs to
    -- reset the flag until the next session is up.
    local function check(handler, context, command)
        local owner = ScriptExecutionContext.GetOwner(context)
        if M.ownsCommand and M.ownsCommand(owner, command) then M.apply(handler, context, command) end
    end
    ObserveAfter('AIMoveToCommandHandler', 'UpdateCommand', function(handler, context, command)
        if not M.active then return end
        local ok, err = pcall(check, handler, context, command)
        if not ok then M.error = tostring(err) end
    end)
    M.installed = true
end

return M
