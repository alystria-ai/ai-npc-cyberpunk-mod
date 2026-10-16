-- Optional native companion tick (red4ext/plugins/AiNpcCyberpunkModNative, system "actuator").
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
-- Kill switch: a line "actuator" (or "all") in runtime/native-off.txt (the plugin re-reads it about
-- once a second; the CET console cannot reach convaiNative, each CET mod has its own environment).
-- Three native faults also switch it off. The first use logs "Native core: actuator=native|lua (...)"
-- to probe.log, and the capabilities line below follows. To find which read matters, switch one part
-- off alone: the lines "actuator.life", "actuator.sense" or "actuator.state" turn only that part back
-- to the game's own reads.
--
-- Parity proof (2026-10-13). A live test showed a companion that did not follow V up stairs and
-- stopped short of V with the native tick on, and followed with it off. Nothing in the maths differs
-- (the parity fixture replays the real Lua), so the plugin's reads are checked against the game's own,
-- here, in the game: for the first PROOF.ticks senses (and at least PROOF.moving of them with the
-- companion walking) every native answer is compared with the same reads made by Lua, and Lua's
-- reading is the one used. Only a clean proof lets the native answers through; after that one sense in
-- CANARY.every is compared again for the rest of the session. Three differences switch the system
-- off for the session (convaiNative.fail logs it) and every difference is logged to probe.log as
-- "Native core: actuator PARITY MISMATCH <field>: plugin <value>, Lua <value>". A line "actuator" in
-- runtime/native-verify.txt compares every sense and never lets the native answers through.
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

-- One part of the system on its own: a line "actuator.life", "actuator.sense" or "actuator.state" in
-- runtime/native-off.txt sends that part back to the game's own reads and leaves the others native.
local function part(name)
    local switch = convaiNative
    return type(switch) == 'table' and switch.use(SYSTEM .. '.' .. name) == true
end

-- Parity proof ----------------------------------------------------------------------------------
local PROOF_TICKS, PROOF_MOVING, CANARY_EVERY, MAX_MISMATCHES = 40, 10, 100, 3
local proof = {ticks = 0, moving = 0, mismatches = 0, compared = 0, calls = 0, lifeCalls = 0,
    combatSeen = 0, combatCompared = 0, proven = false}

-- Test hook: how long the proof runs and how often the canary compares (0 skips each).
function M.configure(ticks, moving, every)
    PROOF_TICKS, PROOF_MOVING, CANARY_EVERY = ticks, moving, every
    proof = {ticks = 0, moving = 0, mismatches = 0, compared = 0, calls = 0, lifeCalls = 0,
        combatSeen = 0, combatCompared = 0, proven = false}
end
function M.state()
    return {proven = proof.proven, ticks = proof.ticks, moving = proof.moving, mismatches = proof.mismatches,
        compared = proof.compared, combatSeen = proof.combatSeen, combatCompared = proof.combatCompared}
end

-- While the proof runs, every plugin read is made twice (the plugin's and Lua's own), so a companion
-- that stands still keeps the window open at about twice the plain cost for as long as it stands
-- (the proof needs some walking). Once the first PROOF_TICKS senses are in and only the walking is
-- missing, the window narrows to one sense in four (and one life or state read in four) unless the
-- companion is walking, which is the case the proof is waiting for. The same checks, a quarter of the cost.
local function sparse(entry)
    if proof.proven or proof.ticks < PROOF_TICKS or proof.moving >= PROOF_MOVING then return false end
    return not (entry and (entry.speed or 0) > 0.5)
end

-- Rows for the perf probe (Developer mode, runtime/perf-probe.json): what each entry point costs in
-- the shim, so the plugin path can be compared with the plain Lua path (switch the system off in
-- runtime/native-off.txt and read the same rows). Registered once, on first use; no cost without the probe.
local watching = false
local function watch()
    watching = true
    local probe = convaiPerfProbe
    if type(probe) ~= 'table' or type(probe.watch) ~= 'function' then return end
    pcall(function()
        probe.watch(M, 'life', 'tickNative.life')
        probe.watch(M, 'sense', 'tickNative.sense')
        probe.watch(M, 'commandState', 'tickNative.commandState')
    end)
end

local space
local function spaceModule()
    if not space then space = dofile('companion-space.lua') end
    return space
end

local function finite(value) return type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge end
local function close(a, b, tolerance)
    return finite(a) and finite(b) and math.abs(a - b) <= tolerance * (1 + math.abs(b))
end

local function mismatch(what, plugin, lua)
    proof.mismatches = proof.mismatches + 1
    if proof.mismatches <= 20 then
        note('Native core: actuator PARITY MISMATCH ' .. what .. ': plugin ' .. tostring(plugin) .. ', Lua ' .. tostring(lua))
    end
    if proof.mismatches >= MAX_MISMATCHES and not disabled then
        disabled = true
        failed('parity: the plugin and the game read different values (' .. what .. '; the PARITY MISMATCH lines above have them)')
    end
end

local function verifying()
    local api = convaiNative
    return type(api) == 'table' and type(api.verifying) == 'function' and api.verifying(SYSTEM) == true
end

-- The original reads and maths of mod/companions.lua, from the same game objects.
local function luaLife(npc)
    local ok, value = pcall(function()
        if not npc:IsAttached() then return 0 end
        return npc:IsDeadNoStatPool() and 1 or 2
    end)
    return ok and value or nil
end
local function luaLabel(npc, command)
    local ok, label = pcall(function()
        if not npc:IsAttached() then return nil end
        return tostring(npc:GetAIControllerComponent():GetCommandState(command))
    end)
    return ok and label or nil
end

-- Compares the plugin's reading with the same reads made by Lua, now. Counts the proof, and may
-- switch the system off.
local function compareSense(entry, player, step, reading, command)
    local sp = spaceModule()
    local npc = entry.npc
    local ok, err = pcall(function()
        local at = sp.copy(npc:GetWorldPosition())
        local previous = entry.position
        local speed = previous and sp.ground(previous, at) / step or 0
        local forward = npc:GetWorldForward()
        local direction = sp.unit(forward.x, forward.y)
        local gap = sp.distance(at, player)
        local facing = sp.angle(direction, sp.bearing(at, player))
        if not (finite(at.x) and finite(at.y) and finite(at.z) and finite(speed) and finite(gap) and finite(facing)) then
            return -- the plugin returns nil for these, and Lua keeps its own (non-finite) values
        end
        local before = proof.mismatches
        local p = reading.at
        for _, axis in ipairs({'x', 'y', 'z', 'w'}) do
            if not close(p[axis], at[axis], 1e-6) then mismatch('position.' .. axis, p[axis], at[axis]) end
        end
        if not close(reading.direction.x, direction.x, 1e-6) or not close(reading.direction.y, direction.y, 1e-6) then
            mismatch('direction', reading.direction.x .. ',' .. reading.direction.y, direction.x .. ',' .. direction.y)
        end
        if not close(reading.speed, speed, 1e-6) then mismatch('speed', reading.speed, speed) end
        if not close(reading.playerGap, gap, 1e-6) then mismatch('playerGap', reading.playerGap, gap) end
        if not close(reading.facingError, facing, 1e-4) then mismatch('facingError', reading.facingError, facing) end
        if command then
            if reading.label then
                local label = luaLabel(npc, command)
                if label ~= nil and label ~= reading.label then mismatch('command state', reading.label, label) end
            end
            if reading.id then
                local id = tonumber(command.id)
                if id ~= nil and id ~= reading.id then mismatch('command id', reading.id, id) end
            end
        end
        if reading.combat ~= nil then
            -- The plugin's combat flag is a field of its own: it counts toward the proof, and a proof
            -- that saw the flag needs it compared on every counted sense (below).
            proof.combatSeen = proof.combatSeen + 1
            local asked, fighting = pcall(function() return NPCPuppet.IsInCombat(npc) end)
            if asked then
                proof.combatCompared = proof.combatCompared + 1
                if (fighting == true) ~= reading.combat then mismatch('in combat', reading.combat, fighting) end
            end
        end
        proof.compared = proof.compared + 1
        if not proof.proven then
            proof.ticks = proof.ticks + 1
            if speed > 0.5 then proof.moving = proof.moving + 1 end
            local combatProven = proof.combatSeen == 0 or proof.combatCompared >= math.min(proof.ticks, PROOF_TICKS)
            if proof.ticks >= PROOF_TICKS and proof.moving >= PROOF_MOVING and proof.mismatches == 0 and combatProven then
                proof.proven = true
                note('Native core: actuator parity proven over ' .. proof.ticks .. ' senses (' .. proof.moving
                    .. ' with the companion walking); combat flag '
                    .. (proof.combatSeen > 0 and ('read by the plugin, compared ' .. proof.combatCompared .. ' times')
                        or 'read by Lua (the plugin could not read it)')
                    .. '; the plugin reads are in use')
            end
        elseif proof.mismatches == before and proof.compared % 250 == 0 then
            note('Native core: actuator parity checked ' .. proof.compared .. ' senses, ' .. proof.mismatches .. ' differences')
        end
    end)
    if not ok then
        -- A read Lua could not make is not evidence against the plugin; nothing is proven this time.
        note('Native core: actuator parity check could not read: ' .. tostring(err))
    end
end

-- 0 = not attached, 1 = dead, 2 = alive; nil = ask the game from Lua (IsAttached, IsDeadNoStatPool).
function M.life(npc)
    if not watching then watch() end
    local c = native()
    if not c or not part('life') then return nil end
    if not proof.proven and sparse(nil) then
        proof.lifeSkipped = (proof.lifeSkipped or 0) + 1
        if proof.lifeSkipped % 4 ~= 0 then return nil end
    end
    local ok, value = pcall(c.Life, npc)
    if not ok then failed(value); return nil end
    if not (value == 0 or value == 1 or value == 2) then return nil end
    proof.lifeCalls = proof.lifeCalls + 1
    local dev = verifying()
    if dev or not proof.proven or (CANARY_EVERY > 0 and proof.lifeCalls % CANARY_EVERY == 0) then
        local lua = luaLife(npc)
        if lua ~= nil and lua ~= value then mismatch('life', value, lua) end
        if dev or not proof.proven or disabled then return lua end
    end
    return value
end

-- The "AICommandState : Name (n)" label of the command, or nil (not attached, no AI component,
-- the read failed, or no plugin): the caller runs its own GetCommandState chain then.
function M.commandState(npc, command)
    local c = native()
    if not c or not command or not npc or not part('state') then return nil end
    if not proof.proven and sparse(nil) then
        proof.stateSkipped = (proof.stateSkipped or 0) + 1
        if proof.stateSkipped % 4 ~= 0 then return nil end
    end
    local ok, value = pcall(c.CommandState, npc, command)
    if not ok then failed(value); return nil end
    local label = LABEL[value]
    if label and (not proof.proven or verifying()) then
        local lua = luaLabel(npc, command)
        if lua ~= nil and lua ~= label then mismatch('command state', label, lua) end
        return nil
    end
    return label
end

-- One companion's tick. entry.position is last tick's position (nil on the first), player is V's
-- position this tick. Returns nil when the caller must run the original reads, else
--   {at = {x,y,z,w}, direction = {x,y}, speed, playerGap, facingError,
--    combat = true|false|nil, command = <the command read>, label = <state label or nil>, id = <number or nil>}
-- where combat, label and id are nil when that one read was unavailable (the caller reads it itself).
-- Until the parity proof has passed (and in developer verify mode) the plugin's answer is only
-- compared and nil is returned: the original Lua reads are the ones used.
function M.sense(entry, player, step)
    local c = native()
    if not c or not part('sense') then return nil end
    if not proof.proven and sparse(entry) then
        proof.skipped = (proof.skipped or 0) + 1
        if proof.skipped % 4 ~= 0 then return nil end
    end
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
    proof.calls = proof.calls + 1
    local dev = verifying()
    if dev or not proof.proven or (CANARY_EVERY > 0 and proof.calls % CANARY_EVERY == 0) then
        compareSense(entry, player, step, reading, command)
        if disabled or dev or not proof.proven then return nil end
    end
    return reading
end

return M
