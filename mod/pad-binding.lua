-- Controller talk button (Settings > Voices, off by default; docs/CONTROLLER_BINDING.md): hold the left stick click (L3) to talk by voice, let go to send,
-- the same hold-to-talk as the CET talk key. The redscript half (r6/scripts/CyberpunkConvai/PadTalk.reds) listens to the game's own action for that click
-- (ToggleSprint, which the game delivers only while V is walking: no menu, scene, choice, call or vehicle) and times the hold; this half decides whether the
-- moment is allowed and presses and releases the talk key's own code path (init.lua voiceKeyEdge).
--
-- Nothing here runs per frame. The redscript half calls ConvaiPadNotify when a hold begins or ends, and this module observes it (CET Observe), so an edge is
-- handled at the moment it happens. The game's 10 Hz tick also drains the same queue (one call returning -1 when empty) in case the observer was not
-- installed or did not fire, and while a hold lasts it checks that the moment is still allowed: a menu that opened under a held click swallows the release,
-- and the tick ends the turn then. Off, the tick costs one boolean and the redscript listener is not registered.
local M = {}
M.clock = os.clock

local MISSING_RETRY_S = 30   -- a game whose scripts do not have the pad methods (the redscript did not compile) is asked again this seldom
local WATCH_S = 0.25         -- how often the held-click check asks the game whether the moment is still allowed

local state = {configured = false, observed = nil, talking = false, missingAt = nil, missingLogged = false, watchedAt = -100,
    firstSource = nil}

-- deps (set by init.lua once):
--   enabled()        the setting
--   menu(player)     true in a menu, a loading screen or with the text box open (init.lua gameplayCanAcquire, inverted)
--   sample(player)   battle-observer's read of the game: combat, vehicle, scene tier, dialogue, choices, call
--   press()          the talk key goes down (init.lua voiceKeyEdge)
--   release()        the talk key comes up
--   observe(fn)      CET Observe on PlayerPuppet.ConvaiPadNotify; fn(player) runs when the redscript queues an edge
--   log(line)
M.deps = nil

local function say(line) if M.deps and M.deps.log then pcall(M.deps.log, line) end end

-- Why a hold is not allowed now, or nil. The sample is battle-observer's: the same flags the game's own scene and call checks read. Anything unreadable
-- counts as busy. V seated in an ordinary seat has the seat's own scene tier, which is not a cutscene.
function M.refusal(sample)
    if type(sample) ~= 'table' or sample.available ~= true then return 'unreadable' end
    if sample.combat then return 'combat' end
    if sample.vehicle then return 'vehicle' end
    if sample.dialogue or sample.choices then return 'dialogue' end
    if sample.call then return 'call' end
    if sample.replacer then return 'replacer' end
    if sample.tier ~= 1 and not sample.sitting then return 'scene' end
    return nil
end

function M.blocked(player)
    local deps = M.deps
    local ok, reason = pcall(function()
        if deps.menu(player) then return 'menu' end
        return M.refusal(deps.sample(player))
    end)
    if not ok then return 'unreadable' end
    return reason
end

local function endHold(why)
    if not state.talking then return end
    state.talking = false
    say('Controller talk button: ended (' .. why .. ')')
    pcall(M.deps.release)
end

local function handle(player, value, source)
    if value == 1 then
        if state.talking then return end
        state.firstSource = state.firstSource or source
        local reason = M.blocked(player)
        if reason then say('Controller talk button: hold ignored (' .. reason .. ')'); return end
        state.talking = true
        say('Controller talk button: down (' .. source .. ')')
        pcall(M.deps.press)
    elseif value == 0 then
        if not state.talking then return end
        state.talking = false
        say('Controller talk button: up (' .. source .. ')')
        pcall(M.deps.release)
    end
end

-- Drain the redscript's queue (bounded). Called by the observer and by the tick.
function M.take(player, source)
    if not M.deps or not player then return end
    for _ = 1, 8 do
        local ok, value = pcall(function() return player:ConvaiPadTake() end)
        if not ok or type(value) ~= 'number' or value < 0 then return end
        handle(player, value, source or 'tick')
    end
end

local function install()
    if state.observed ~= nil then return end
    local ok = pcall(M.deps.observe, function(player) M.take(player, 'observer') end)
    state.observed = ok == true
    say('Controller talk button: observer ' .. (ok and 'installed' or 'not installed, the tick reads the queue'))
end

-- The configuration is gone with the player (a load makes a new one): ask the redscript, switch it on again if needed.
local function configure(player, now)
    local ok, on = pcall(function() return player:ConvaiPadIsOn() end)
    if not ok then
        state.missingAt = now
        if not state.missingLogged then
            state.missingLogged = true
            say('Controller talk button: the redscript half is not loaded (PadTalk.reds), the setting does nothing')
        end
        return false
    end
    state.missingAt, state.missingLogged = nil, false
    if on == true then state.configured = true; return true end
    local set = pcall(function() return player:ConvaiPadConfigure(true) end)
    state.configured = set == true
    if state.configured then say('Controller talk button: on') end
    return state.configured
end

-- Called from the game's 10 Hz tick. `ready`: the world is playable.
function M.tick(player, ready)
    local deps = M.deps
    if not deps then return end
    if deps.enabled() ~= true then
        if state.configured or state.talking then M.stop(player) end
        return
    end
    if not ready or not player then
        endHold('world not ready')
        state.configured = false
        return
    end
    local now = M.clock()
    if state.missingAt and now - state.missingAt < MISSING_RETRY_S then return end
    if not configure(player, now) then return end
    install()
    M.take(player, 'tick')
    if not state.talking or now - state.watchedAt < WATCH_S then return end
    state.watchedAt = now
    local ok, held = pcall(function() return player:ConvaiPadHeld() end)
    if ok and held == false then endHold('release not seen'); return end
    local reason = M.blocked(player)
    if reason then endHold(reason) end
end

-- The setting went off, or the session ends: a hold in progress is ended, and the redscript listener stops (best effort: the player may be gone).
function M.stop(player)
    endHold('stopped')
    if state.configured and player then pcall(function() player:ConvaiPadConfigure(false) end) end
    if state.configured then say('Controller talk button: off') end
    state.configured = false
end

function M.talking() return state.talking end
function M.observed() return state.observed end
function M.firstSource() return state.firstSource end

return M
