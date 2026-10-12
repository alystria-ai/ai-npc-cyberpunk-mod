-- Optional native companion tick (red4ext/plugins/CyberpunkConvaiNative, system "actuator").
-- mod/companions.lua senses every ready companion ten times a second: IsAttached,
-- IsDeadNoStatPool, GetWorldPosition, GetWorldForward, GetAIControllerComponent():GetCommandState,
-- NPCPuppet.IsInCombat and the speed, heading, distance and facing maths. From CET that is about
-- eight native calls and a dozen property reads per companion per tick (about 25 us a call, perf
-- probe 2026-10-12). With the plugin present and its "actuator" switch on, Life() answers the first
-- two in one call and Sense() answers the rest in one call, returning a line of text this module
-- decodes into the same fields. CommandState() is the same chain for the actuator's own
-- state checks. Without the plugin, with the switch off, or when any single read is unavailable,
-- the callers run their original code: every function here returns nil to say "ask the game
-- yourself".
-- Kill switch: a line "actuator" (or "all") in runtime/native-off.txt, or convaiNative.off('actuator')
-- in the CET console. Three native faults also switch it off. The first use logs
-- "Native core: actuator=native|lua (...)" to probe.log, and the capabilities line below follows.
local M = {}
local SYSTEM = 'actuator'

-- The wire format and constants, mirrored in native/core/src/systems/actuator/core/ActuatorCore.hpp
-- (the parity fixture native/core/tests/fixtures/actuator-sense.json carries them to the C++ tests).
M.FIELDS = 'flags x y z w fx fy state id speed dx dy gap facing'
M.CAPABILITY = {isAttached = 1, isDead = 2, worldPosition = 4, worldForward = 8, commandState = 16,
    commandId = 32, inCombat = 64}
M.REQUIRED = 15
M.FLAG = {combatKnown = 1, inCombat = 2, stateKnown = 4, idKnown = 8}
M.STATES = {[0] = 'NotExecuting', 'Enqueued', 'Executing', 'Cancelled', 'Interrupted', 'Success', 'Failure'}

-- The label CET prints for an AICommandState: companion-actuator.lua matches it with stateName().
local LABEL = {}
for number = 0, #M.STATES do LABEL[number] = 'AICommandState : ' .. M.STATES[number] .. ' (' .. number .. ')' end
M.LABEL = LABEL

local PATTERN = '^(%d+) (%S+) (%S+) (%S+) (%S+) (%S+) (%S+) (%-?%d+) (%S+) (%S+) (%S+) (%S+) (%S+) (%S+)$'
local tonumber, pcall, type = tonumber, pcall, type

local class, caps, retryAt = nil, 0, 0
local disabled = false

local function note(line)
    pcall(function()
        local file = io.open('runtime/probe.log', 'a')
        if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', line, '\n'); file:close() end
    end)
end

local function hasBit(value, bit) return math.floor(value / bit) % 2 == 1 end
local function missing(value)
    local names = {}
    for name, bit in pairs(M.CAPABILITY) do if not hasBit(value, bit) then names[#names + 1] = name end end
    table.sort(names)
    return table.concat(names, ',')
end

-- The plugin's class, once CET has bound it and the plugin found the game functions it needs.
local function native()
    if disabled then return nil end
    local switch = convaiNative
    if type(switch) ~= 'table' or not switch.use(SYSTEM) then return nil end
    if class then return class end
    local now = os.clock()
    if now < retryAt then return nil end
    retryAt = now + 5
    local ok, bound = pcall(function() return ConvaiNativeActuator end)
    if not ok or (type(bound) ~= 'table' and type(bound) ~= 'userdata') then return nil end
    local read, value = pcall(function() return bound.Capabilities() end)
    if not read or type(value) ~= 'number' then
        disabled = true
        switch.fail(SYSTEM, 'Capabilities failed: ' .. tostring(value))
        return nil
    end
    caps = value
    for _, bit in ipairs({1, 2, 4, 8}) do
        if not hasBit(caps, bit) then
            disabled = true
            switch.fail(SYSTEM, 'game functions missing: ' .. missing(caps))
            return nil
        end
    end
    local lacking = missing(caps)
    note('Native core: actuator capabilities ' .. caps .. (lacking ~= '' and (' (Lua keeps: ' .. lacking .. ')') or ' (all)'))
    class = bound
    return class
end

local function failed(err)
    if type(convaiNative) == 'table' then pcall(convaiNative.fail, SYSTEM, err) end
end

-- 0 = not attached, 1 = dead, 2 = alive; nil = ask the game from Lua (IsAttached, IsDeadNoStatPool).
function M.life(npc)
    local c = native()
    if not c then return nil end
    local ok, value = pcall(c.Life, npc)
    if not ok then failed(value); return nil end
    if value == 0 or value == 1 or value == 2 then return value end
    return nil
end

-- The "AICommandState : Name (n)" label of the command, or nil (not attached, no AI component,
-- the read failed, or no plugin): the caller runs its own GetCommandState chain then.
function M.commandState(npc, command)
    local c = native()
    if not c or not command or not npc then return nil end
    local ok, value = pcall(c.CommandState, npc, command)
    if not ok then failed(value); return nil end
    return LABEL[value]
end

-- One companion's tick. entry.position is last tick's position (nil on the first), player is V's
-- position this tick. Returns nil when the caller must run the original reads, else
--   {at = {x,y,z,w}, direction = {x,y}, speed, playerGap, facingError,
--    combat = true|false|nil, command = <the command read>, label = <state label or nil>, id = <number or nil>}
-- where combat, label and id are nil when that one read was unavailable (the caller reads it itself).
function M.sense(entry, player, step)
    local c = native()
    if not c then return nil end
    local npc, motor, previous = entry.npc, entry.motor, entry.position
    local command = motor and not motor.suspendedHold and motor.command or nil
    local ok, text
    if command then
        ok, text = pcall(c.Sense, npc, command, previous ~= nil, previous and previous.x or 0,
            previous and previous.y or 0, player.x, player.y, player.z or 0, step)
    else
        ok, text = pcall(c.SenseIdle, npc, previous ~= nil, previous and previous.x or 0,
            previous and previous.y or 0, player.x, player.y, player.z or 0, step)
    end
    if not ok then failed(text); return nil end
    if text == '' then return nil end -- position or forward unavailable for this companion
    local flags, x, y, z, w, _, _, state, id, speed, dx, dy, gap, facing = text:match(PATTERN)
    flags, x, y, z, w = tonumber(flags), tonumber(x), tonumber(y), tonumber(z), tonumber(w)
    state, id, speed, dx, dy, gap, facing = tonumber(state), tonumber(id), tonumber(speed), tonumber(dx),
        tonumber(dy), tonumber(gap), tonumber(facing)
    if not (flags and x and y and z and w and state and id and speed and dx and dy and gap and facing) then
        failed('unreadable Sense reply: ' .. tostring(text))
        return nil
    end
    local reading = {at = {x = x, y = y, z = z, w = w}, direction = {x = dx, y = dy}, speed = speed,
        playerGap = gap, facingError = facing, command = command}
    if hasBit(flags, M.FLAG.combatKnown) then reading.combat = hasBit(flags, M.FLAG.inCombat) end
    if command then
        if hasBit(flags, M.FLAG.stateKnown) then reading.label = LABEL[state] end
        if hasBit(flags, M.FLAG.idKnown) then reading.id = id end
    end
    return reading
end

return M
