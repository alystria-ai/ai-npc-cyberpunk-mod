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

-- The copy's body type, lower case without separators ('womanaverage', 'manbig', ...), or nil when it cannot be
-- read. One native read; callers cache it per copy.
function M.bodyType(npc)
    local ok, value = call(function() return npc:GetBodyType() end)
    if not ok or value == nil then return nil end
    -- GetBodyType returns a CName: tostring() of one prints 'ToCName{ hash_lo = ..., hash_hi = ... --[[ WomanAverage --]] }'
    -- (live 2026-10-11, the first generic-fallback test read nothing useful), so resolve it with NameToString and
    -- fall back to the name inside that comment.
    local text
    if type(value) == 'string' then text = value
    else
        if type(NameToString) == 'function' then
            local okName, name = pcall(NameToString, value)
            if okName and type(name) == 'string' and name ~= '' and name ~= 'None' then text = name end
        end
        if not text then
            local raw = tostring(value)
            text = raw:match('%-%-%[%[%s*(.-)%s*%-%-%]%]') or raw
        end
    end
    text = text:lower():gsub('[^a-z0-9]', '')
    if text == '' or text == 'none' then return nil end
    return text
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

-- Hand slots (docs/COMPANION_GESTURES.md, Round 12, prop idles). The idle workspots put a prop in a hand slot through
-- their own animation events; these two calls read the slot and take exactly the declared item out of it again.
local function itemIs(item, wanted)
    local id = item:GetItemID()
    local tdb = ItemID.GetTDBID(id)
    local okEqual, same = pcall(function() return tdb == TweakDBID.new(wanted) end)
    if okEqual and same == true then return true, id end
    local okName, name = pcall(function() return TDBID.ToStringDEBUG(tdb) end)
    return okName and name == wanted, id, okName and name or nil
end

-- ok, nil when the slot is empty; ok, {match = <is the wanted item>, fists = <empty hands>, record = <name when known>}
-- when something is in it. One read; callers decide when to look (never per frame).
function M.slotItem(npc, slot, wanted)
    return call(function()
        local item = Game.GetTransactionSystem():GetItemInSlot(npc, TweakDBID.new(slot))
        if not item then return nil end
        local match, id, record = false, nil, nil
        if wanted then match, id, record = itemIs(item, wanted) else id = item:GetItemID() end
        local okFists, fists = pcall(function() return WeaponObject.IsFists(id) end)
        return {match = match == true, fists = okFists and fists == true, record = record}
    end)
end

-- Takes the declared item out of a slot and nothing else. ok, 'empty' | 'other' (something else is held: left alone) |
-- 'removed' | 'stuck' (still there after both removal calls). Safe to repeat.
function M.clearSlot(npc, slot, wanted)
    return call(function()
        local transactions = Game.GetTransactionSystem()
        local slotId = TweakDBID.new(slot)
        local item = transactions:GetItemInSlot(npc, slotId)
        if not item then return 'empty' end
        local match, id = itemIs(item, wanted)
        if not match then return 'other' end
        if not pcall(function() return transactions:RemoveItemFromSlot(npc, slotId, true) end) then
            pcall(function() return transactions:RemoveItemFromSlot(npc, slotId) end)
        end
        local left = transactions:GetItemInSlot(npc, slotId)
        if left and itemIs(left, wanted) then
            pcall(function() return transactions:RemoveItem(npc, id, 1) end)
            left = transactions:GetItemInSlot(npc, slotId)
            if left and itemIs(left, wanted) then return 'stuck' end
        end
        return 'removed'
    end)
end

-- Visual components of a copy by name (docs/COMPANION_GESTURES.md, Round 14). An idle that holds a worn item in the hand
-- (Johnny's aviators) hides the worn mesh while it plays and shows it again afterwards. `names` are plain substrings of the
-- component name (the appearance's own name carries a numeric suffix); only visual components are touched. ok, count of
-- components toggled. One walk of the component list per call, only at the start and end of such an idle (never per frame);
-- safe to repeat: showing an already shown component changes nothing.
function M.setComponentsVisible(npc, names, visible)
    return call(function()
        local changed = 0
        for _, component in ipairs(npc:GetComponents() or {}) do
            if component:IsA('entIVisualComponent') then
                local name = type(NameToString) == 'function' and NameToString(component:GetName()) or tostring(component:GetName())
                for _, wanted in ipairs(names) do
                    if name:find(wanted, 1, true) then
                        component:Toggle(visible == true)
                        changed = changed + 1
                        break
                    end
                end
            end
        end
        return changed
    end)
end

function M.stopInDevice(npc)
    return call(function()
        return Game.GetWorkspotSystem():StopInDevice(npc, Vector4.new(0, 0, 0, 0), Quaternion.new(0, 0, 0, 1))
    end)
end

return M
