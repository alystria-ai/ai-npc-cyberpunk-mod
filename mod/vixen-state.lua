-- Other mods' state (Settings > Dynamic info > Other mods' state, docs/DYNAMIC_INFO.md): V's stamina, energy, drink and cigarettes from the Flesh and
-- Chrome mod, and V's injuries from the Injuries mod (both by Digital Vixen), as plain small integers for the bridge to word ("V is out of breath",
-- "V is limping"). The Dark Future reader is mod/mod-state.lua; this one is its sibling.
--
-- Loaded by init.lua only when one of the two mods is installed and the switch is on (the `vixen` reader there probes the class names first and never
-- dofiles this file otherwise). Read on demand when a conversation turn is built, inside turn-context.lua's 5 second cached snapshot: no timer, hook,
-- observer or file, nothing per frame. Both mods are read in the same pass from one scriptable systems container and one player; every lookup and call is
-- wrapped in pcall, and a missing or changed mod drops its own field, never the turn and never the other mod.
--
-- Source (Flesh and Chrome 1.31.0 and Injuries 1.7.4; their redscript was read, nothing of it is run or copied). Neither has a CET object: the state is read the
-- way any redscript would read it, from a ScriptableSystem fetched with Game.GetScriptableSystemsContainer():Get(CName.new('<Module>.<Class>')).
--   FleshAndChrome.FACSystem (FleshAndChrome.reds)
--       :IsEnabled() -> Bool                    the mod's own switch (modON)
--       :GetStaminaPercent(player) -> Float     0.0 to 1.0, the short-term exertion pool (1.0 before its pools exist)
--       :GetEnergyPercent(player) -> Float      0.0 to 1.0, the daily energy pool that sleep, meals and drinks refill
--       The mod's own penalties start at 20 percent (tunnel vision) and at 10 (heavy breathing, weapon sway), and "Exhausted" (FACStatusEffect.Exhausted) is applied at 0 and
--       cleared above 5 percent; no sprint, jump or dodge while it is on.
--       Alcohol and cigarettes have no getter that says "now": the persistent fields it adds to PlayerPuppetPS do (m_facInitialized, m_facLastTimestamp = the mod's own
--       game clock as of its last tick, m_facAlcoholDrinks and m_facAlcoholSoberEnd = drinks in the sober-up window and when it ends, m_facSmokingPenaltyEnd = the end of the
--       30 minute regen penalty after a cigarette). The clock is the mod's own, so the comparison needs no guess about what DVClock.Now is.
--   Injuries.InjuriesSystem (Injuries_System.reds, Injuries_Effects.reds)
--       :IsLive() -> Bool                       the session is armed (false before it, after a death or a session end)
--       :GetAppliedTier(kind) -> Int32          0 to 3 per injury kind (0 limp, 1 broken arm, 2 concussion, 3 bleeding): what is in effect on V now, after healing items
--                                               (painkillers, a medkit) have suppressed some of it
--       :GetSeverity(region) -> Int32           0 to 3 per body region (0 head, 1 torso, 2 and 3 arms, 4 and 5 legs): the injury itself; above the applied tier of its
--                                               kind means a healing item is holding it back (V has treated it)
-- Not confirmed (guesses about CET, not about the mods): that CET returns nil (not an error) for an unknown class name (pcall covers both), that it dispatches these
-- getters on the handle Get() returns (the standard CET behaviour, the same call mod/mod-state.lua makes), that a persistent field added by redscript reads as
-- `ps.m_facStamina` from CET, and that `Game.GetStatusEffectSystem():HasStatusEffect(entityId, TweakDBID)` exists. The first reading logs the result of each.
--
-- Result: nil, or {fleshAndChrome = {breath =, energy = (1 to 4), drinks = (1 to 3), smoke = 1}, injuries = {limp =, arm =, head =, bleed = (1 to 3), treated = 1}}: only what
-- is known and worth saying. And a second answer {fac = <note>, inj = <note>} of what each read found ("installed=yes read=ok state=breath0,energy1,drinks0,smoke0"),
-- which rides the turn context so the probe line of a turn (fac: ..., inj: ...) can say what the game side saw (bridge/mod-state.mjs). The bridge words the result.
local M = {}

M.FAC_CLASS, M.INJ_CLASS = 'FleshAndChrome.FACSystem', 'Injuries.InjuriesSystem'
-- Stamina (a fraction of the pool) below which the stage is 1, 2, 3; 4 is exhausted. The first two are the mod's own penalty bars (20 and 10 percent).
M.STAMINA_BARS = {0.20, 0.10, 0.05}
-- Energy below which the stage is 1, 2, 3, 4. The mod's own penalties start at 20 percent; a day awake only brings the pool to about 60 percent.
M.ENERGY_BARS = {0.35, 0.20, 0.10, 0.05}
-- Drinks in the sober-up window: 1 to 2 is stage 1, 3 to 5 stage 2, 6 and more stage 3.
M.DRINK_BARS = {1, 3, 6}
-- The longest sober-up window that can be real (a drink adds an hour, the mod caps nothing): 40 drinks is a day and a half. A window beyond it is a clock that does not match.
M.MAX_WINDOW_SECONDS, M.MAX_DRINKS = 48 * 3600, 99
-- Injury kinds in the order of Injuries' own numbering, and the regions each is read from.
M.KINDS = {{key = 'limp', kind = 0, regions = {4, 5}}, {key = 'arm', kind = 1, regions = {2, 3}}, {key = 'head', kind = 2, regions = {0}}, {key = 'bleed', kind = 3, regions = {1}}}

local state = {logged = {}, last = {}}

-- Forget what was remembered (a test, or a new save).
function M.reset() state = {logged = {}, last = {}} end

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

local function integer(value, low, high)
    value = tonumber(value)
    if not value or value ~= value or value < low or value > high or value ~= math.floor(value) then return nil end
    return value
end

-- A fraction 0 to 1 (a little over, for rounding), else nil.
local function fraction(value)
    value = tonumber(value)
    if not value or value ~= value or value < 0 or value > 1.001 then return nil end
    return value
end

local function lookup(container, class, label, log)
    local ok, system = pcall(function() return container:Get(CName.new(class)) end)
    if not ok then
        once(log, label .. ':get', 'Mod state: ' .. label .. ' lookup of ' .. class .. ' failed (' .. short(system) .. ')')
        return nil
    end
    return system
end

-- One getter call on a system: true and the value, or false (logged once per method). `argument` is the one parameter the getter takes, or nil for none
-- (a call is made with exactly the arguments the game's method has, so the argument is passed only when there is one).
local function ask(system, method, label, log, argument)
    local ok, value = pcall(function()
        if argument == nil then return system[method](system) end
        return system[method](system, argument)
    end)
    if not ok then
        once(log, label .. ':' .. method, 'Mod state: ' .. label .. ' ' .. method .. ' failed (' .. short(value) .. ')')
        return false
    end
    return true, value
end

local function field(object, name)
    local ok, value = pcall(function() return object[name] end)
    if ok then return value end
    return nil
end

local function below(value, bars)
    local stage = 0
    for index, bar in ipairs(bars) do if value < bar then stage = index end end
    return stage
end

local function shown(value) return value == nil and '?' or tostring(math.floor(value)) end

-- Flesh and Chrome: {breath, energy, drinks, smoke} stages (0 = nothing) or nil when the mod is absent, and the note.
local function readFleshAndChrome(container, player, log)
    local system = lookup(container, M.FAC_CLASS, 'flesh-and-chrome', log)
    if system == nil then return nil, nil end
    local okEnabled, enabled = ask(system, 'IsEnabled', 'flesh-and-chrome', log)
    if okEnabled and enabled == false then
        return nil, 'installed=yes read=off state=-', 'flesh-and-chrome switched off in its own settings'
    end
    local raw = {}
    local okStamina, stamina = ask(system, 'GetStaminaPercent', 'flesh-and-chrome', log, player)
    stamina = okStamina and fraction(stamina) or nil
    if stamina ~= nil then
        raw.breath = stamina >= M.STAMINA_BARS[1] and 0 or below(stamina, M.STAMINA_BARS)
        -- Exhausted: the pool is empty, or the mod's own status is still on (it clears above 5 percent). One more call, only down here.
        if stamina < M.STAMINA_BARS[3] then
            if stamina <= 0.0 then
                raw.breath = 4
            else
                local okEffect, has = pcall(function()
                    return Game.GetStatusEffectSystem():HasStatusEffect(player:GetEntityID(), TweakDBID.new('FACStatusEffect.Exhausted'))
                end)
                if okEffect and has == true then raw.breath = 4 end
            end
        end
    end
    local okEnergy, energy = ask(system, 'GetEnergyPercent', 'flesh-and-chrome', log, player)
    energy = okEnergy and fraction(energy) or nil
    if energy ~= nil then raw.energy = energy >= M.ENERGY_BARS[1] and 0 or below(energy, M.ENERGY_BARS) end
    -- Drink and cigarettes, from the persistent fields, against the mod's own clock.
    local okPs, ps = pcall(function() return player:GetPS() end)
    if okPs and ps ~= nil and field(ps, 'm_facInitialized') == true then
        local now = tonumber(field(ps, 'm_facLastTimestamp'))
        if now and now > 0 then
            local drinks, soberEnd = integer(field(ps, 'm_facAlcoholDrinks'), 0, M.MAX_DRINKS), tonumber(field(ps, 'm_facAlcoholSoberEnd'))
            if drinks ~= nil and soberEnd ~= nil and soberEnd - now <= M.MAX_WINDOW_SECONDS then
                local effective = (drinks > 0 and now < soberEnd) and drinks or 0
                raw.drinks = 0
                for stage, bar in ipairs(M.DRINK_BARS) do if effective >= bar then raw.drinks = stage end end
            end
            local smokeEnd = tonumber(field(ps, 'm_facSmokingPenaltyEnd'))
            if smokeEnd ~= nil and smokeEnd - now <= M.MAX_WINDOW_SECONDS then raw.smoke = now < smokeEnd and 1 or 0 end
        end
    end
    local out, any = {}, false
    for _, key in ipairs({'breath', 'energy', 'drinks', 'smoke'}) do
        if raw[key] ~= nil and raw[key] > 0 then out[key] = raw[key]; any = true end
    end
    local note = string.format('installed=yes read=%s state=breath%s,energy%s,drinks%s,smoke%s',
        (raw.breath ~= nil or raw.energy ~= nil or raw.drinks ~= nil) and 'ok' or 'none', shown(raw.breath), shown(raw.energy), shown(raw.drinks), shown(raw.smoke))
    return any and out or false, note, string.format('flesh-and-chrome breath=%s energy=%s drinks=%s smoke=%s',
        shown(raw.breath), shown(raw.energy), shown(raw.drinks), shown(raw.smoke))
end

-- Injuries: {limp, arm, head, bleed, treated} or nil when the mod is absent, and the note.
local function readInjuries(container, log)
    local system = lookup(container, M.INJ_CLASS, 'injuries', log)
    if system == nil then return nil, nil end
    local okLive, live = ask(system, 'IsLive', 'injuries', log)
    if okLive and live ~= true then return false, 'installed=yes read=idle state=-', 'injuries idle (no live session)' end
    local out, any, raw, treated, answered = {}, false, {}, false, 0
    for _, row in ipairs(M.KINDS) do
        local okTier, tier = ask(system, 'GetAppliedTier', 'injuries', log, row.kind)
        tier = okTier and integer(tier, 0, 3) or nil
        raw[row.key] = tier
        if tier ~= nil then
            answered = answered + 1
            if tier > 0 then out[row.key] = tier; any = true end
            -- The injury itself, only to tell a treated one (a healing item holds it back) from none: asked only while nothing is in effect.
            if tier == 0 then
                for _, region in ipairs(row.regions) do
                    local okSeverity, severity = ask(system, 'GetSeverity', 'injuries', log, region)
                    severity = okSeverity and integer(severity, 0, 3) or nil
                    if severity ~= nil and severity > 0 then treated = true end
                end
            end
        end
    end
    if treated then out.treated = 1; any = true end
    local note = string.format('installed=yes read=%s state=limp%s,arm%s,head%s,bleed%s,treated%s', answered > 0 and 'ok' or 'none',
        shown(raw.limp), shown(raw.arm), shown(raw.head), shown(raw.bleed), treated and '1' or (answered > 0 and '0' or '?'))
    return any and out or false, note, string.format('injuries limp=%s arm=%s head=%s bleed=%s treated=%s',
        shown(raw.limp), shown(raw.arm), shown(raw.head), shown(raw.bleed), treated and '1' or '0')
end

-- The state, or nil, and the notes {fac =, inj =}. `player` is V; `log(line)` gets one line per distinct reading.
function M.read(player, log)
    local okContainer, container = pcall(function() return Game.GetScriptableSystemsContainer() end)
    if not okContainer or container == nil or player == nil then return nil, nil end
    local result, notes = {}, {}
    local fac, facNote, facLine = readFleshAndChrome(container, player, log)
    local inj, injNote, injLine = readInjuries(container, log)
    if facNote then notes.fac = facNote end
    if injNote then notes.inj = injNote end
    if fac then result.fleshAndChrome = fac end
    if inj then result.injuries = inj end
    for key, line in pairs({fac = facLine, inj = injLine}) do
        if line and line ~= state.last[key] then state.last[key] = line; say(log, 'Mod state: ' .. line) end
    end
    return next(result) ~= nil and result or nil, notes
end

return M
