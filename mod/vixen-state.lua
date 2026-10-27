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
--       :GetTotalAlcohol(player), :GetTotalCigarettes(player) -> Int32   lifetime counts (not a state; watched for a rise, see below)
--       :IsStaminaRegenning() -> Bool           true while the pool is refilling (false in the cooldown, while moving at a jog or faster, or when the pool is at its ceiling)
--       :GetConfig() -> FACConfig               alcoholSoberBaseHours (6), alcoholSoberHoursPerExtraDrink (1), smokingPenaltyDurationMinutes (30), regenDelayCooldownMinutes (10)
--       Alcohol and cigarettes have no getter that says "now": the persistent fields it adds to PlayerPuppetPS do (m_facInitialized, m_facLastTimestamp = the mod's own
--       game clock as of its last tick, m_facAlcoholDrinks and m_facAlcoholSoberEnd = drinks in the sober-up window and when it ends, m_facSmokingPenaltyEnd = the end of the
--       30 minute regen penalty after a cigarette). The clock is the mod's own, so the comparison needs no guess about what DVClock.Now is.
--   Injuries.InjuriesSystem (Injuries_System.reds, Injuries_Effects.reds)
--       :IsLive() -> Bool                       the session is armed (false before it, after a death or a session end)
--       :GetAppliedTier(kind) -> Int32          0 to 3 per injury kind (0 limp, 1 broken arm, 2 concussion, 3 bleeding): what is in effect on V now, after healing items
--                                               (painkillers, a medkit) have suppressed some of it
--       :GetSeverity(region) -> Int32           0 to 3 per body region (0 head, 1 torso, 2 and 3 arms, 4 and 5 legs): the injury itself; above the applied tier of its
--                                               kind means a healing item is holding it back (V has treated it)
-- What the first live test (2026-10-27, game 2.31, probe.log) settled: CET returns both systems, dispatches IsEnabled, GetStaminaPercent, GetEnergyPercent, IsLive, GetAppliedTier and
-- GetSeverity on them with these arguments (every one answered, no "failed" line), and the stamina and energy stages follow the mod. What it did NOT settle, and what this version
-- therefore probes (every probe is one `Mod state probe:` line in probe.log with the raw values, never per frame, only while a turn is built):
--   * drinks and cigarettes read `?`: the persistent PlayerPuppetPS fields were not readable through `player:GetPS()`. The fields are now read directly and, when that gives nothing, through
--     Codeware's reflection (the way mod/combat-feats-probe.lua reads script fields), and the path that answered is logged. When neither answers, the mod's own PUBLIC getters
--     FACSystem:GetTotalAlcohol(player) and :GetTotalCigarettes(player) (lifetime counts, the same call shape that already works for GetStaminaPercent) are watched from one read to the
--     next: a count that went up since the last read is a drink or a cigarette just had, and the sober-up window (6 hours and one more per extra drink) or the 30 minute cigarette
--     penalty is counted from that read, on the game clock. The counts are the SAVE'S LIFETIME totals (FleshAndChrome.reds 1662/1675/1769/1781: only ever `+= 1`), never the drinks
--     in the body, so a count alone maps to nothing: a baseline read is made when a save has loaded (mod/init.lua convaiVixenBaseline), and a count or clock that goes back is another save.
--   * breath stays at the top stage for minutes: the reader follows the mod's pool (GetStaminaPercent is ps.m_facStamina / max), so a long stage 4 is the mod's own regeneration
--     rule unless the probe says otherwise: the pool refills only after a cooldown of 10 game minutes times how empty it was, only while V is not moving at a jog or faster, and no higher
--     than the daily energy pool allows. The probe line records the pool, the energy, the Exhausted status, IsStaminaRegenning(), the game's own stamina pool, the mod's cooldown left
--     and the game clock's pace, once at the first read, at every change of stage, and every two minutes while the stage is 3 or 4.
--   * injuries all zero: Injuries only injures after 50 percent of V's health in damage within 10 seconds (then a 75 percent roll) or one hit of 80 percent, so a fall or a few shots
--     may honestly give nothing. The probe line records IsLive, every kind's applied tier and every region's severity, and when the system says "none" the twelve Injuries status effects are
--     asked once a minute as a second opinion (a status effect in force is believed over a silent system, and the disagreement is logged).
-- Not confirmed (guesses about CET): that `player:GetPS()` hands CET the PlayerPuppetPS, that a field added by redscript reads as `ps.m_facLastTimestamp`, and that
-- `Game.GetStatusEffectSystem():HasStatusEffect(entityId, TweakDBID)` exists; the probe lines say which.
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
-- The mod's defaults, used when its config cannot be read: first drink 6 hours, each further one an hour, a cigarette's penalty 30 minutes.
M.SOBER_BASE_HOURS, M.SOBER_EXTRA_HOURS, M.SMOKE_MINUTES = 6, 1, 30
-- A breath probe line is repeated at most this often (real seconds) while the stage is 3 or 4; the injuries' second opinion (twelve status effects) at most this often.
M.BREATH_PROBE_SECONDS, M.EFFECT_CHECK_SECONDS = 120, 60
-- Injury kinds in the order of Injuries' own numbering, and the regions each is read from.
M.KINDS = {{key = 'limp', kind = 0, regions = {4, 5}}, {key = 'arm', kind = 1, regions = {2, 3}}, {key = 'head', kind = 2, regions = {0}}, {key = 'bleed', kind = 3, regions = {1}}}
-- The status effects Injuries applies for a kind in force (Injuries_Effects.reds TweakIDFor): Injuries.<Name>_T<tier>, kind 0 to 3 in this order.
M.EFFECT_NAMES = {'Limp', 'BrokenArm', 'Concussion', 'Bleeding'}

local state

-- Forget what was remembered (a test, or a new save).
function M.reset()
    state = {logged = {}, last = {}, probed = {}, totals = {}, events = {}, clock = nil, effectCheckedAt = nil}
end
M.reset()

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

-- A raw answer as a short word for a probe line: numbers to 4 digits, booleans, nil, or the kind of thing it is.
local function describe(value)
    local kind = type(value)
    if value == nil then return 'nil' end
    if kind == 'number' then return string.format('%.4g', value) end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'string' then return (value:gsub('%s+', ' '):sub(1, 40)) end
    return kind
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

-- A field of a script class: read directly (how CET reads script fields), else through Codeware's reflection (mod/combat-feats-probe.lua does the same). Second answer: the path.
local function scriptField(object, class, name)
    local value = field(object, name)
    if value ~= nil then return value, 'direct' end
    local ok, reflected = pcall(function()
        local property = Reflection.GetClass(CName.new(class)):GetProperty(CName.new(name))
        return FromVariant(property:GetValue(ToVariant(object)))
    end)
    if ok and reflected ~= nil then return reflected, 'reflection' end
    return nil, 'none'
end

local function below(value, bars)
    local stage = 0
    for index, bar in ipairs(bars) do if value < bar then stage = index end end
    return stage
end

local function shown(value) return value == nil and '?' or tostring(math.floor(value)) end

-- The game clock in seconds (the time system's own stamp, the same on every read), or nil.
local function gameClock()
    local ok, stamp = pcall(function() return tonumber(Game.GetTimeSystem():GetGameTimeStamp()) end)
    if ok and stamp and stamp == stamp and stamp >= 0 then return stamp end
    return nil
end

-- Game seconds per real second since the last read (about 8 at the game's normal pace; 0 while time is held), or nil. Real time is whole seconds: a rough pace.
local function pace(now)
    local real = os.time()
    local last = state.clock
    if now then state.clock = {real = real, game = now} end
    if not (now and last and real - last.real >= 2 and now >= last.game) then return nil end
    return (now - last.game) / (real - last.real)
end

local function className(object)
    local ok, name = pcall(function() return NameToString(object:GetClassName()) end)
    if ok and name ~= nil then return short(name) end
    local okRaw, raw = pcall(function() return tostring(object:GetClassName()) end)
    return okRaw and short(raw) or '?'
end

-- How many `m_fac` properties the game's PlayerPuppetPS class has, and one example (Codeware's reflection): whether the class carries Flesh and Chrome's fields at all.
local function factProperties()
    local ok, text = pcall(function()
        local count, sample = 0, nil
        for _, property in ipairs(Reflection.GetClass(CName.new('PlayerPuppetPS')):GetProperties()) do
            local name = NameToString(property:GetName())
            if name:find('^m_fac') then count = count + 1; sample = sample or name end
        end
        return count .. (sample and (' e.g. ' .. sample) or '')
    end)
    return ok and text or 'unreadable'
end

-- The ways to reach the persistent state of V, in the order tried: the object's own getter (what the mods' redscript uses), a getter named for the class, and the persistency system.
local function stateVariants(player)
    return {
        {'GetPS', function() return player:GetPS() end},
        {'GetPlayerPuppetPS', function() return player:GetPlayerPuppetPS() end},
        {'persistency', function() return Game.GetPersistencySystem():GetConstAccessToPSObject(player:GetPersistentID(), CName.new('PlayerPuppetPS')) end}}
end

-- V's persistent state, or nil. The first time every way is tried and one probe line says what each gave (the class and the raw `m_facInitialized`); the way whose field reads is
-- remembered and used from then on, else only the object's own getter is asked again.
local function playerState(player, log)
    local variants = stateVariants(player)
    if state.psVia ~= nil then
        for _, variant in ipairs(variants) do
            if variant[1] == state.psVia then
                local ok, ps = pcall(variant[2])
                if ok and ps ~= nil then return ps end
            end
        end
    end
    local okFirst, first = pcall(variants[1][2])
    if not okFirst or first == nil then
        once(log, 'ps:get', 'Mod state probe: player:GetPS() ' .. (okFirst and 'gave nothing' or 'failed (' .. short(first) .. ')') .. ': drinks and cigarettes are read from the mod\'s lifetime counts instead')
    end
    if state.psTried then return okFirst and first or nil end
    state.psTried = true
    local parts, found, any = {}, nil, nil
    for index, variant in ipairs(variants) do
        local ok, ps
        if index == 1 then ok, ps = okFirst, first else ok, ps = pcall(variant[2]) end
        if not ok then
            parts[#parts + 1] = variant[1] .. '=failed(' .. short(ps):sub(1, 50) .. ')'
        elseif ps == nil then
            parts[#parts + 1] = variant[1] .. '=nil'
        else
            any = any or ps
            local init = field(ps, 'm_facInitialized')
            parts[#parts + 1] = variant[1] .. '=' .. className(ps) .. '/init=' .. describe(init)
            if init ~= nil and found == nil then found, state.psVia = ps, variant[1] end
        end
    end
    say(log, 'Mod state probe: ways to V\'s persistent state: ' .. table.concat(parts, ' ') .. ' (PlayerPuppetPS m_fac properties: ' .. factProperties() .. ')')
    return found or any
end

-- The mod's config value (a number), or the default.
local function setting(config, name, default)
    local value = config ~= nil and tonumber(field(config, name)) or nil
    if value and value == value and value > 0 and value < 1000 then return value end
    return default
end

-- Drink and cigarettes from the persistent fields, against the mod's own clock: {drinks =, smoke =} stages (nil = unknown) and the raw answers for the probe.
local function fromFields(ps, log)
    local out, seen = {}, {}
    if ps == nil then return out, seen end
    local paths = {}
    for _, name in ipairs({'m_facInitialized', 'm_facLastTimestamp', 'm_facAlcoholDrinks', 'm_facAlcoholSoberEnd', 'm_facSmokingPenaltyEnd', 'm_facRegenCooldownEnd', 'm_facStamina', 'm_facEnergy'}) do
        seen[name], paths[name] = scriptField(ps, 'PlayerPuppetPS', name)
    end
    once(log, 'ps:fields', string.format('Mod state probe: PlayerPuppetPS fields init=%s(%s) now=%s(%s) drinks=%s(%s) soberEnd=%s(%s) smokeEnd=%s(%s) cooldownEnd=%s stamina=%s energy=%s',
        describe(seen.m_facInitialized), paths.m_facInitialized, describe(seen.m_facLastTimestamp), paths.m_facLastTimestamp, describe(seen.m_facAlcoholDrinks), paths.m_facAlcoholDrinks,
        describe(seen.m_facAlcoholSoberEnd), paths.m_facAlcoholSoberEnd, describe(seen.m_facSmokingPenaltyEnd), paths.m_facSmokingPenaltyEnd, describe(seen.m_facRegenCooldownEnd),
        describe(seen.m_facStamina), describe(seen.m_facEnergy)))
    if seen.m_facInitialized ~= true then return out, seen end
    local now = tonumber(seen.m_facLastTimestamp)
    if not (now and now > 0) then return out, seen end
    local drinks, soberEnd = integer(seen.m_facAlcoholDrinks, 0, M.MAX_DRINKS), tonumber(seen.m_facAlcoholSoberEnd)
    if drinks ~= nil and soberEnd ~= nil and soberEnd - now <= M.MAX_WINDOW_SECONDS then
        local effective = (drinks > 0 and now < soberEnd) and drinks or 0
        out.drinks = 0
        for stage, bar in ipairs(M.DRINK_BARS) do if effective >= bar then out.drinks = stage end end
    end
    local smokeEnd = tonumber(seen.m_facSmokingPenaltyEnd)
    if smokeEnd ~= nil and smokeEnd - now <= M.MAX_WINDOW_SECONDS then out.smoke = now < smokeEnd and 1 or 0 end
    return out, seen
end

-- Drink and cigarettes from the mod's lifetime counts (public getters that take the player, the shape that works for GetStaminaPercent): a count that rose since the last read is a
-- drink or a cigarette just had, counted from this read on the game clock. Nothing is known before a first read has the count to compare with (then 0, honestly "none seen").
local function fromTotals(system, config, player, log)
    local now = gameClock()
    local okAlcohol, alcohol = ask(system, 'GetTotalAlcohol', 'flesh-and-chrome', log, player)
    local okSmoke, cigarettes = ask(system, 'GetTotalCigarettes', 'flesh-and-chrome', log, player)
    alcohol, cigarettes = okAlcohol and integer(alcohol, 0, 100000000) or nil, okSmoke and integer(cigarettes, 0, 100000000) or nil
    local totals, events, out = state.totals, state.events, {}
    -- The counts of one save only ever rise, and so does its clock: a count that fell or a clock that went back is another save (or a new game). Its drinks are not this one's:
    -- forget what was watched and take the baseline again (the first live test: 9 in one session, 6 in the next).
    local fell = (alcohol ~= nil and totals.alcohol ~= nil and alcohol < totals.alcohol) or (cigarettes ~= nil and totals.cigarettes ~= nil and cigarettes < totals.cigarettes)
        or (now ~= nil and state.lastNow ~= nil and now < state.lastNow)
    if fell then
        say(log, 'Mod state probe: the counts or the game clock went back (alcohol ' .. describe(totals.alcohol) .. ' to ' .. describe(alcohol) .. ', cigarettes ' .. describe(totals.cigarettes) .. ' to ' .. describe(cigarettes) .. '): another save, the baseline is taken again')
        for key in pairs(totals) do totals[key] = nil end
        for key in pairs(events) do events[key] = nil end
    end
    if now ~= nil then state.lastNow = now end
    if now ~= nil then
        if alcohol ~= nil and totals.alcohol ~= nil and alcohol > totals.alcohol then
            local added = alcohol - totals.alcohol
            local live = events.alcohol and events.alcohol.endsAt > now and events.alcohol or nil
            local extra = setting(config, 'alcoholSoberHoursPerExtraDrink', M.SOBER_EXTRA_HOURS) * 3600
            local endsAt = live and live.endsAt + added * extra or now + setting(config, 'alcoholSoberBaseHours', M.SOBER_BASE_HOURS) * 3600 + (added - 1) * extra
            events.alcohol = {drinks = math.min((live and live.drinks or 0) + added, M.MAX_DRINKS), endsAt = endsAt}
        end
        if cigarettes ~= nil and totals.cigarettes ~= nil and cigarettes > totals.cigarettes then
            events.smoke = {endsAt = now + setting(config, 'smokingPenaltyDurationMinutes', M.SMOKE_MINUTES) * 60}
        end
    end
    if alcohol ~= nil then totals.alcohol = alcohol end
    if cigarettes ~= nil then totals.cigarettes = cigarettes end
    if now ~= nil and alcohol ~= nil then
        local drinks = (events.alcohol and events.alcohol.endsAt > now) and events.alcohol.drinks or 0
        out.drinks = 0
        for stage, bar in ipairs(M.DRINK_BARS) do if drinks >= bar then out.drinks = stage end end
    end
    if now ~= nil and cigarettes ~= nil then out.smoke = (events.smoke and events.smoke.endsAt > now) and 1 or 0 end
    return out, alcohol, cigarettes
end

-- A probe line, written again only when its text changes.
local function probe(log, key, line)
    if state.probed[key] == line then return end
    state.probed[key] = line
    say(log, 'Mod state probe: ' .. line)
end

-- Flesh and Chrome: {breath, energy, drinks, smoke} stages (0 = nothing) or nil when the mod is absent, and the note.
local function readFleshAndChrome(container, player, log)
    local system = lookup(container, M.FAC_CLASS, 'flesh-and-chrome', log)
    if system == nil then return nil, nil end
    local okEnabled, enabled = ask(system, 'IsEnabled', 'flesh-and-chrome', log)
    if okEnabled and enabled == false then
        return nil, 'installed=yes read=off state=-', 'flesh-and-chrome switched off in its own settings'
    end
    local raw = {}
    local okStamina, staminaRaw = ask(system, 'GetStaminaPercent', 'flesh-and-chrome', log, player)
    local stamina = okStamina and fraction(staminaRaw) or nil
    local exhausted
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
                exhausted = okEffect and has or nil
                if okEffect and has == true then raw.breath = 4 end
            end
        end
    end
    local okEnergy, energyRaw = ask(system, 'GetEnergyPercent', 'flesh-and-chrome', log, player)
    local energy = okEnergy and fraction(energyRaw) or nil
    if energy ~= nil then raw.energy = energy >= M.ENERGY_BARS[1] and 0 or below(energy, M.ENERGY_BARS) end
    -- Drink and cigarettes: the persistent fields when they read (exact, against the mod's own clock), else the lifetime counts watched from read to read.
    local fields, seen = fromFields(playerState(player, log), log)
    local okConfig, config = ask(system, 'GetConfig', 'flesh-and-chrome', log)
    local counted, alcoholTotal, cigaretteTotal = fromTotals(system, okConfig and config or nil, player, log)
    local source = (fields.drinks ~= nil or fields.smoke ~= nil) and 'fields' or ((counted.drinks ~= nil or counted.smoke ~= nil) and 'counts' or 'none')
    raw.drinks = fields.drinks ~= nil and fields.drinks or counted.drinks
    raw.smoke = fields.smoke ~= nil and fields.smoke or counted.smoke
    -- The breath probe: first read, a change of stage, and every two minutes while the stage is 3 or 4. What the mod says about its own pool, so a long "out of breath" can be
    -- told from a wrong read: the pool, the Exhausted status, whether it is refilling, the game's own stamina pool, the mod's cooldown left and the pace of the game clock.
    local rate = pace(gameClock())
    local due = state.probed.breathStage ~= raw.breath
    if raw.breath ~= nil and raw.breath >= 3 and not due then
        local last = state.probed.breathAt
        due = last == nil or os.time() - last >= M.BREATH_PROBE_SECONDS
    end
    if due then
        state.probed.breathStage, state.probed.breathAt = raw.breath, os.time()
        local okRegen, regenning = ask(system, 'IsStaminaRegenning', 'flesh-and-chrome', log)
        local okPool, pool = pcall(function()
            return Game.GetStatPoolsSystem():GetStatPoolValue(player:GetEntityID(), Enum.new('gamedataStatPoolType', 'Stamina'), true)
        end)
        local cooldownEnd, stamp = tonumber(seen.m_facRegenCooldownEnd), tonumber(seen.m_facLastTimestamp)
        say(log, string.format('Mod state probe: breath stage=%s stamina=%s energy=%s exhaustedStatus=%s regenning=%s gamePool=%s cooldownLeft=%s clock=%s',
            shown(raw.breath), describe(staminaRaw), describe(energyRaw), describe(exhausted), okRegen and describe(regenning) or '?', okPool and describe(pool) or '?',
            describe(cooldownEnd and stamp and cooldownEnd - stamp or nil), rate and string.format('%.1fx', rate) or '?'))
    end
    probe(log, 'drinks', string.format('drinks and cigarettes via=%s counts alcohol=%s cigarettes=%s stages drinks=%s smoke=%s', source, describe(alcoholTotal), describe(cigaretteTotal), shown(raw.drinks), shown(raw.smoke)))
    local out, any = {}, false
    for _, key in ipairs({'breath', 'energy', 'drinks', 'smoke'}) do
        if raw[key] ~= nil and raw[key] > 0 then out[key] = raw[key]; any = true end
    end
    local note = string.format('installed=yes read=%s state=breath%s,energy%s,drinks%s,smoke%s',
        (raw.breath ~= nil or raw.energy ~= nil or raw.drinks ~= nil) and 'ok' or 'none', shown(raw.breath), shown(raw.energy), shown(raw.drinks), shown(raw.smoke))
    return any and out or false, note, string.format('flesh-and-chrome breath=%s energy=%s drinks=%s smoke=%s',
        shown(raw.breath), shown(raw.energy), shown(raw.drinks), shown(raw.smoke))
end

-- The Injuries status effects in force, as the second opinion: {kind = worst tier}, or nil when the status system cannot be asked.
local function effectsInForce(player)
    local okId, id = pcall(function() return player:GetEntityID() end)
    if not okId then return nil end
    local found, asked = {}, 0
    for index, name in ipairs(M.EFFECT_NAMES) do
        for tier = 1, 3 do
            local ok, has = pcall(function() return Game.GetStatusEffectSystem():HasStatusEffect(id, TweakDBID.new('Injuries.' .. name .. '_T' .. tier)) end)
            if ok then
                asked = asked + 1
                if has == true then found[index - 1] = tier end
            end
        end
    end
    return asked > 0 and found or nil
end

local function csv(values, from, to)
    local parts = {}
    for index = from, to do parts[#parts + 1] = values[index] == nil and '?' or tostring(values[index]) end
    return table.concat(parts, ',')
end

-- Injuries: {limp, arm, head, bleed, treated} or nil when the mod is absent, and the note.
local function readInjuries(container, player, log)
    local system = lookup(container, M.INJ_CLASS, 'injuries', log)
    if system == nil then return nil, nil end
    local okLive, live = ask(system, 'IsLive', 'injuries', log)
    if okLive and live ~= true then
        probe(log, 'injuries', 'injuries live=' .. describe(live) .. ': idle, nothing read')
        return false, 'installed=yes read=idle state=-', 'injuries idle (no live session)'
    end
    local out, any, raw, treated, answered = {}, false, {}, false, 0
    local severities, tiers = {}, {}
    -- Every region's severity (the injury itself) once: it tells a treated injury (a healing item holds it back) from none, and goes to the probe line.
    for region = 0, 5 do
        local okSeverity, severity = ask(system, 'GetSeverity', 'injuries', log, region)
        severities[region] = okSeverity and integer(severity, 0, 3) or nil
    end
    for _, row in ipairs(M.KINDS) do
        local okTier, tier = ask(system, 'GetAppliedTier', 'injuries', log, row.kind)
        tier = okTier and integer(tier, 0, 3) or nil
        raw[row.key], tiers[row.kind] = tier, tier
        if tier ~= nil then
            answered = answered + 1
            if tier > 0 then out[row.key] = tier; any = true end
            -- Only while nothing is in effect: a severity above 0 there is held back by a healing item.
            if tier == 0 then
                for _, region in ipairs(row.regions) do
                    if (severities[region] or 0) > 0 then treated = true end
                end
            end
        end
    end
    -- The second opinion, at most once a minute while the system says "no injury": an Injuries status effect in force is believed over a system that answers zeros.
    local effects
    if not any and not treated then
        local at = os.time()
        if state.effectCheckedAt == nil or at - state.effectCheckedAt >= M.EFFECT_CHECK_SECONDS then
            state.effectCheckedAt = at
            effects = effectsInForce(player)
            if effects ~= nil then
                for _, row in ipairs(M.KINDS) do
                    local tier = effects[row.kind]
                    if tier ~= nil and tier > 0 then
                        out[row.key], raw[row.key], any = tier, tier, true
                        once(log, 'injuries:effect:' .. row.key, 'Mod state probe: injuries system said none but the status effect Injuries.' .. M.EFFECT_NAMES[row.kind + 1] .. '_T' .. tier .. ' is in force: believed')
                    end
                end
            end
        end
    end
    probe(log, 'injuries', string.format('injuries live=%s applied=%s severity=%s effects=%s', describe(live), csv(tiers, 0, 3), csv(severities, 0, 5),
        effects == nil and 'unchecked' or (next(effects) == nil and 'none' or 'some')))
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
    local inj, injNote, injLine = readInjuries(container, player, log)
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
