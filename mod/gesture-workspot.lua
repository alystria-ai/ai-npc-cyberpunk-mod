-- Native workspot plumbing for companion body gestures (docs/COMPANION_GESTURES.md).
-- Signatures from Codeware reflection on 2.31. Every call is pcall-wrapped and
-- returns ok, result|error. No state; callers own entity ids and handles.
local M = {}
M.TAG = 'CyberpunkConvaiGestureDevice'

local function call(fn) return pcall(fn) end

function M.inWorkspot(npc)
    local ok, value = call(function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) end)
    if not ok then return nil, value end
    return value == true
end

-- An invisible, non-persistent gameObject carrying the gesture workspot
-- components, placed exactly at the companion.
function M.spawnDevice(npc, template)
    return call(function()
        local spec = NewObject('DynamicEntitySpec')
        if not pcall(function() spec.templatePath = template end) then spec.templatePath = ResRef.FromString(template) end
        spec.position = npc:GetWorldPosition()
        spec.orientation = npc:GetWorldOrientation()
        spec.persistState, spec.persistSpawn = false, false
        spec.alwaysSpawned, spec.spawnInView, spec.active = true, true, true
        spec.tags = {CName.new(M.TAG)}
        local id = Game.GetDynamicEntitySystem():CreateEntity(spec)
        if not id or tostring(id.hash):match('^0+[uUlL]*$') then error('Device entity was not created') end
        return id
    end)
end

function M.deviceEntity(id)
    local ok, entity = call(function()
        local system = Game.GetDynamicEntitySystem()
        if not system:IsManaged(id) then return false end
        if not system:IsSpawned(id) then return nil end
        return Game.FindEntityByID(id)
    end)
    if not ok then return false, entity end
    return entity
end

function M.moveDevice(device, npc)
    return call(function()
        Game.GetTeleportationFacility():Teleport(device, npc:GetWorldPosition(), npc:GetWorldOrientation():ToEulerAngles())
    end)
end

-- Has the device actually reached the companion's pose? A teleport of the device lands a frame
-- or more after the call and the workspot plays at the device's transform, so the controller
-- plays only once this is true. true / false; nil when the poses cannot be read.
function M.devicePlaced(device, npc, maxDistance, maxYaw)
    local ok, value = call(function()
        local a, b = device:GetWorldPosition(), npc:GetWorldPosition()
        local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
        if math.sqrt(dx * dx + dy * dy + dz * dz) > (maxDistance or .12) then return false end
        local ya = device:GetWorldOrientation():ToEulerAngles().yaw
        local yb = npc:GetWorldOrientation():ToEulerAngles().yaw
        return math.abs((ya - yb + 180) % 360 - 180) <= (maxYaw or 8)
    end)
    if not ok then return nil end
    return value == true
end

function M.deleteDevice(id)
    return call(function()
        local system = Game.GetDynamicEntitySystem()
        if system:IsManaged(id) and system:IsTagged(id, CName.new(M.TAG)) then system:DeleteEntity(id) end
    end)
end

function M.sweep()
    return call(function()
        local system = Game.GetDynamicEntitySystem()
        for _, id in ipairs(system:GetTaggedIDs(CName.new(M.TAG)) or {}) do system:DeleteEntity(id) end
    end)
end

local function sliding()
    local ok, value = pcall(function() return Enum.new('gameWorkspotSlidingBehaviour', 'DontPlayAtResourcePosition') end)
    return ok and value or 1
end

-- In place, no slide (gameWorkspotSlidingBehaviour.DontPlayAtResourcePosition).
function M.play(device, npc, component)
    local none = CName.new('None')
    return call(function()
        return Game.GetWorkspotSystem():PlayInDevice(device, npc, none, CName.new(component), none, none, 0, sliding(), nil)
    end)
end

function M.jump(npc, clip, instant)
    return call(function() return Game.GetWorkspotSystem():SendJumpToAnimEnt(npc, CName.new(clip), instant == true) end)
end

-- The native fast exit with default arguments is the only exit observed to
-- leave the AI command queue healthy (October 6 live probe). instant=true is
-- used for combat; StopNpcInWorkspot is never used (it wedged the AI).
function M.exit(npc, instant)
    if instant then
        local ok, result = call(function()
            return Game.GetWorkspotSystem():SendFastExitSignal(npc, Vector3.new(0, 0, 0), false, true, true, false)
        end)
        if ok then return ok, result end
    end
    return call(function() return Game.GetWorkspotSystem():SendFastExitSignal(npc) end)
end

function M.stopInDevice(npc)
    return call(function()
        return Game.GetWorkspotSystem():StopInDevice(npc, Vector4.new(0, 0, 0, 0), Quaternion.new(0, 0, 0, 1))
    end)
end

return M
