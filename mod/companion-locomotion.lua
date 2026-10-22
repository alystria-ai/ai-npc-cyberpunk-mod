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

-- Which hook feeds the handler below (kept for diagnostics and the tests):
--  'filtered' (shipping): Lua observes ConvaiOwnedMoveUpdate, an empty method that r6/scripts/CyberpunkConvai/Locomotion.reds calls
--             from its wrap of AIMoveToCommandHandler.UpdateCommand only for a command marked by M.mark. Every other NPC's
--             walking costs one Bool read in script and never enters Lua.
--  'engine'   (fallback): the previous behaviour, Lua observes UpdateCommand itself for every walking NPC and returns on
--             M.active. Used when the redscript half is missing or older (an update-over install whose scripts did not
--             compile, CET reloaded against another build) and when runtime/locomotion-engine-hook.txt exists (the kill switch
--             for the first release with the filter; remove the file to go back).
M.mode = nil

local function fileExists(path)
    local opener = io and io.open
    local file = opener and opener(path, 'rb')
    if not file then return false end
    file:close()
    return true
end

-- True when both script methods the filter needs exist in the running game. Reflection is read once at install; a game
-- or a CET without it answers nil and the Observe call itself decides.
local function filterScripted()
    local ok, found = pcall(function()
        if not Reflection or not Reflection.GetClass then return nil end
        local handler = Reflection.GetClass('AIMoveToCommandHandler')
        local command = Reflection.GetClass('AIMoveToCommand')
        if not handler or not command then return false end
        return handler:GetFunction('ConvaiOwnedMoveUpdate') ~= nil and command:GetFunction('ConvaiMarkOwned') ~= nil
    end)
    if not ok then return nil end
    return found
end

-- Called by the movement controller for every move command it creates, before the command is sent. A no-op outside
-- 'filtered' mode. If the script half cannot mark (older scripts than this file), the engine hook is registered at once so the
-- stale-facing cleanup is never lost; nothing is raised.
function M.mark(command)
    if M.mode ~= 'filtered' or not command then return false end
    local ok = pcall(command.ConvaiMarkOwned, command)
    if ok then
        M.marked = (M.marked or 0) + 1
        return true
    end
    M.markFailed = (M.markFailed or 0) + 1
    if M.engineObserver then pcall(M.engineObserver) end
    return false
end

function M.install(ownsCommand)
    M.ownsCommand = ownsCommand
    if M.installed then return end
    -- M.active is false from the start and again from the moment a session is abandoned (a load, a detach): the engine is
    -- then destroying the AI contexts this callback would read the owner of, and no update runs to reset the flag until the
    -- next session is up. Without a travelling companion (M.active, kept by the caller) return before any native call;
    -- otherwise no closure is allocated per call.
    local function check(handler, context, command)
        local owner = ScriptExecutionContext.GetOwner(context)
        if M.ownsCommand and M.ownsCommand(owner, command) then M.apply(handler, context, command); return true end
        return false
    end
    local function handle(handler, context, command)
        if not M.active then return end
        local ok, done = pcall(check, handler, context, command)
        if not ok then M.error = tostring(done) end
        -- 'filtered' mode: the script wrapper disarms a command before it reports it, so a command is reported once and costs
        -- no Lua call (about a dozen CET calls) on its other AI ticks; the next walking command is marked again by M.mark. Only a
        -- report that could not finish (a failure, or the command is not yet this copy's current travel command) arms it again,
        -- so that case keeps retrying on the next tick as before. Never in 'engine' mode: that hook sees every NPC's command.
        if (not ok or done ~= true) and M.mode == 'filtered' then
            if pcall(command.ConvaiMarkOwned, command) then M.rearmed = (M.rearmed or 0) + 1 end
        end
    end
    local scripted = filterScripted()
    if scripted ~= false and not fileExists('runtime/locomotion-engine-hook.txt') then
        if pcall(ObserveAfter, 'AIMoveToCommandHandler', 'ConvaiOwnedMoveUpdate', handle) then
            M.mode = 'filtered'
        end
    end
    -- The previous hook, for the fallback modes. Registered at most once, here or by M.mark.
    M.engineObserver = function()
        if M.mode == 'engine' then return end
        ObserveAfter('AIMoveToCommandHandler', 'UpdateCommand', handle)
        M.mode = 'engine'
    end
    if not M.mode then M.engineObserver() end
    M.installed = true
end

return M
