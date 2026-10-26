-- Other mods' state (Settings > Dynamic info > Other mods' state, docs/DYNAMIC_INFO.md): V's needs, addictions and conditions from the Dark
-- Future mod, as plain small integers for the bridge to word ("V looks exhausted").
--
-- Loaded by init.lua only when Dark Future is installed and the switch is on (the `mods` reader there probes one class name first and never
-- dofiles this file otherwise). Read on demand when a conversation turn is built, inside turn-context.lua's 5 second cached snapshot: no
-- timer, hook, observer or file, nothing per frame. Every lookup and call is wrapped in pcall; a missing or changed Dark Future drops the
-- field (or the one system), never the turn.
--
-- Source (Dark Future 2.0.3, the build for game 2.31; its redscript was read, nothing of it is run or copied): there is no API for other mods
-- and no CET object, so the state is read the way any redscript would: every state class is a ScriptableSystem fetched with
-- Game.GetScriptableSystemsContainer():Get(CName.new('<Module>.<Class>')).
--   DarkFuture.Needs.DFHydrationSystem / DFNutritionSystem / DFEnergySystem / DFNerveSystem  :GetNeedStage() -> Int32, 0 (fine) to 4 (worst);
--       -1 when the system is not running (before its init, after death, the mod or the feature switched off in its settings)
--   DarkFuture.Addictions.DFAlcoholAddictionSystem / DFNicotineAddictionSystem / DFNarcoticAddictionSystem
--       :GetAddictionStage() -> Int32 0 to 4 and :GetWithdrawalLevel() -> Int32 0 to 5 (5 = cessation); 0 when not running
--   DarkFuture.Conditions.DFInjuryConditionSystem / DFHumanityLossConditionSystem  :GetConditionLevel() -> Uint32 0 to 4; 0 when not running
-- Not confirmed: that a build for game 2.5 exists, or keeps these names (no source found, see the report in docs/DYNAMIC_INFO.md). So every
-- system has a list of candidate class names tried in turn (the one that answered is remembered), a system that cannot be found is simply
-- missing from the table, and nil, -1 and an out-of-range number all mean "unknown", never a guess. Not confirmed either: that CET returns nil
-- (not an error) for an unknown class name (pcall covers both), and that it dispatches :GetNeedStage() on the handle Get() returns (the standard
-- CET behaviour, the same call PreventionSystem:GetHeatStage() makes in turn-context.lua); the first reading logs the names that answered.
--
-- Beside the result, `M.note()` answers one compact text of what the last read found (the nine raw stages, or why there were none), which rides the turn
-- context so the probe line of a turn can say what the game side saw: "installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1" (bridge/mod-state.mjs).
--
-- Result: nil, or {darkFuture = {hydration =, nutrition =, energy = (stages 1 to 4), nerve = (stages 3 or 4), injury =, humanity = (levels 3 or 4),
-- alcohol = {stage =, withdrawal =}, nicotine = ..., narcotic = ... (only while the withdrawal level is 3 or more)}}: only what is known and
-- worth saying. The bridge (bridge/mod-state.mjs) words it and decides what a character may know.
local M = {}

-- The least stage a need or condition must reach to be sent, and the least withdrawal level; bridge/mod-state.mjs holds the same bars.
-- Hunger, thirst and tiredness are sent from stage 1: that is where Dark Future itself starts a status effect on V (NeedPenalty_01, a live
-- test of 2026-10-26: nutrition=1 and the owner was hungry, a bar of 3 said nothing). Nerve and the conditions stay at 3: nerve sits at 1
-- nearly all day, and a companion would not see a lasting injury or a humanity loss before it is serious.
M.MIN_STAGE, M.MIN_WITHDRAWAL, M.MIN_BODY_STAGE = 3, 3, 1

-- Candidate class names per system, best first. The qualified name is what redscript registers; the bare name is a guess for a build that
-- moved its modules. Each entry: {key, names, method}.
M.NEEDS = {
    {key = 'hydration', body = true, method = 'GetNeedStage', names = {'DarkFuture.Needs.DFHydrationSystem', 'DFHydrationSystem'}},
    {key = 'nutrition', body = true, method = 'GetNeedStage', names = {'DarkFuture.Needs.DFNutritionSystem', 'DFNutritionSystem'}},
    {key = 'energy', body = true, method = 'GetNeedStage', names = {'DarkFuture.Needs.DFEnergySystem', 'DFEnergySystem'}},
    {key = 'nerve', method = 'GetNeedStage', names = {'DarkFuture.Needs.DFNerveSystem', 'DFNerveSystem'}},
}
M.ADDICTIONS = {
    {key = 'alcohol', names = {'DarkFuture.Addictions.DFAlcoholAddictionSystem', 'DFAlcoholAddictionSystem'}},
    {key = 'nicotine', names = {'DarkFuture.Addictions.DFNicotineAddictionSystem', 'DFNicotineAddictionSystem'}},
    {key = 'narcotic', names = {'DarkFuture.Addictions.DFNarcoticAddictionSystem', 'DFNarcoticAddictionSystem'}},
}
M.CONDITIONS = {
    {key = 'injury', method = 'GetConditionLevel', names = {'DarkFuture.Conditions.DFInjuryConditionSystem', 'DFInjuryConditionSystem'}},
    {key = 'humanity', method = 'GetConditionLevel', names = {'DarkFuture.Conditions.DFHumanityLossConditionSystem', 'DFHumanityLossConditionSystem'}},
}

local state = {memo = {}, logged = {}, last = nil, note = nil}

-- Forget what was remembered (a test, or a new save).
function M.reset() state = {memo = {}, logged = {}, last = nil, note = nil} end

-- What the last read found, as one short text for the turn's probe line: the needs always (their raw stage, "?" unknown or not running, "-" system not
-- found), an addiction or a condition only while it is not 0. Letters, digits, "=", "," and "-" only.
function M.note() return state.note end

local function integer(value, low, high)
    value = tonumber(value)
    if not value or value ~= value or value < low or value > high or value ~= math.floor(value) then return nil end
    return value
end

local function say(log, line)
    if type(log) == 'function' then pcall(log, line) end
end

-- One line per kind of event, ever (a failure that comes back every turn is logged once).
local function once(log, key, line)
    if state.logged[key] then return end
    state.logged[key] = true
    say(log, line)
end

local function short(problem) return (tostring(problem):gsub('%s+', ' '):sub(1, 140)) end

-- The system for one entry, or nil. The name that answered last time is tried first; a stale one is forgotten.
local function lookup(container, entry, log)
    local function try(name)
        local ok, system = pcall(function() return container:Get(CName.new(name)) end)
        if not ok then
            once(log, entry.key .. ':get:' .. name, 'Mod state: ' .. entry.key .. ' lookup of ' .. name .. ' failed (' .. short(system) .. ')')
            return nil
        end
        return system
    end
    local remembered = state.memo[entry.key]
    if remembered then
        local system = try(remembered)
        if system ~= nil then return system end
        state.memo[entry.key] = nil
    end
    for _, name in ipairs(entry.names) do
        if name ~= remembered then
            local system = try(name)
            if system ~= nil then
                state.memo[entry.key] = name
                once(log, entry.key .. ':found', 'Mod state: Dark Future ' .. entry.key .. ' system found as ' .. name)
                return system
            end
        end
    end
    return nil
end

-- One integer getter on a system: nil when it fails or answers outside the range (-1 is "not running").
local function stage(system, entry, method, low, high, log)
    local ok, value = pcall(function() return system[method](system) end)
    if not ok then
        once(log, entry.key .. ':' .. method .. ':error', 'Mod state: ' .. entry.key .. ' ' .. method .. ' failed (' .. short(value) .. ')')
        return nil
    end
    local number = integer(value, low, high)
    if number == nil and value ~= nil and tonumber(value) ~= -1 then
        once(log, entry.key .. ':' .. method .. ':range', 'Mod state: ' .. entry.key .. ' ' .. method .. ' answered ' .. short(value) .. ', not a stage')
    end
    return number
end

local function shown(value) return value == nil and '?' or tostring(math.floor(value)) end

-- The state, or nil. `player` is unused (the systems keep V's state themselves); `log(line)` gets one line per distinct reading.
function M.read(player, log)
    local okContainer, container = pcall(function() return Game.GetScriptableSystemsContainer() end)
    if not okContainer or container == nil then state.note = 'installed=yes read=failed stage=-'; return nil end
    local raw = {}          -- everything that was read, for the log line
    local out, any, found = {}, false, 0
    for _, entry in ipairs(M.NEEDS) do
        local system = lookup(container, entry, log)
        if system ~= nil then
            found = found + 1
            local value = stage(system, entry, entry.method, 0, 4, log)
            raw[entry.key] = shown(value)
            if value ~= nil and value >= (entry.body and M.MIN_BODY_STAGE or M.MIN_STAGE) then out[entry.key] = value; any = true end
        else
            raw[entry.key] = '-'
        end
    end
    for _, entry in ipairs(M.ADDICTIONS) do
        local system = lookup(container, entry, log)
        if system ~= nil then
            found = found + 1
            local withdrawal = stage(system, entry, 'GetWithdrawalLevel', 0, 5, log)
            raw[entry.key] = shown(withdrawal)
            if withdrawal ~= nil and withdrawal >= M.MIN_WITHDRAWAL then
                -- The addiction stage is asked only when it is going to be sent (a second call, rarely).
                out[entry.key] = {stage = stage(system, entry, 'GetAddictionStage', 0, 4, log) or 0, withdrawal = withdrawal}; any = true
            end
        else
            raw[entry.key] = '-'
        end
    end
    for _, entry in ipairs(M.CONDITIONS) do
        local system = lookup(container, entry, log)
        if system ~= nil then
            found = found + 1
            local value = stage(system, entry, entry.method, 0, 4, log)
            raw[entry.key] = shown(value)
            if value ~= nil and value >= M.MIN_STAGE then out[entry.key] = value; any = true end
        else
            raw[entry.key] = '-'
        end
    end
    if found == 0 then
        once(log, 'none', 'Mod state: Dark Future was detected but none of its state systems could be found (names changed?)')
    end
    local parts = {}
    for _, key in ipairs({'hydration', 'nutrition', 'energy', 'nerve'}) do parts[#parts + 1] = key .. (raw[key] or '-') end
    for _, key in ipairs({'alcohol', 'nicotine', 'narcotic', 'injury', 'humanity'}) do
        if raw[key] ~= nil and raw[key] ~= '0' and raw[key] ~= '-' then parts[#parts + 1] = key .. raw[key] end
    end
    state.note = 'installed=yes read=' .. (found > 0 and 'ok' or 'none') .. ' stage=' .. table.concat(parts, ',')
    -- One line per distinct reading (raw stages: ? unknown or not running, - system not found; the addictions show the withdrawal level 0 to 5).
    local line = string.format('Mod state: dark-future hydration=%s nutrition=%s energy=%s nerve=%s alcohol=%s nicotine=%s narcotic=%s injury=%s humanity=%s',
        raw.hydration, raw.nutrition, raw.energy, raw.nerve, raw.alcohol, raw.nicotine, raw.narcotic, raw.injury, raw.humanity)
    if found > 0 and line ~= state.last then state.last = line; say(log, line) end
    if not any then return nil end
    return {darkFuture = out}
end

return M
