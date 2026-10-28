-- Controller talk button (Settings > Voices, off by default; docs/CONTROLLER_BINDING.md): hold the left stick click (L3) to talk by voice, let go to send,
-- the same hold-to-talk as the CET talk key. The redscript half (r6/scripts/CyberpunkConvai/PadTalk.reds) listens to the game's own action for that click
-- (ToggleSprint, which the game delivers only while V is walking: no menu, scene, choice, call or vehicle) and times the hold; this half decides whether the
-- moment is allowed and presses and releases the talk key's own code path (init.lua voiceKeyEdge).
--
-- Nothing here runs per frame. The game's 10 Hz tick drains the redscript's queue (one call returning -1 when empty), and while a hold lasts it checks that
-- the moment is still allowed: a menu that opened under a held click swallows the release, and the tick ends the turn then. Off, the tick costs one
-- boolean and the redscript listener is not registered.
--
-- No Lua runs inside the game event that produced an edge (player report on 0.3.3: the game froze, sometimes, on the first hold after a load). The
-- redscript half queues the edge and, one frame later, from a one-shot next-frame DelayCallback that does nothing else, calls ConvaiPadNotify, which this
-- module observes (CET Observe): worst delay one frame, not the tick's 0.1 s. If the redscript answers ConvaiPadObservable() with no (or lacks it) the
-- observer is not installed and the tick reads the queue. Handling is never re-entered (state.inside) and a run of hold starts is capped (CHATTER_MAX
-- in CHATTER_S), so a loop through the game's events cannot spin the talk path.
local M = {}
M.clock = os.clock

local MISSING_RETRY_S = 30   -- a game whose scripts do not have the pad methods (the redscript did not compile) is asked again this seldom
local WATCH_S = 0.25         -- how often the held-click check asks the game whether the moment is still allowed

local CHATTER_S = 5      -- a run of hold starts is counted over this long ...
local CHATTER_MAX = 8    -- ... and more than this many is not a person holding a button: the rest are ignored until the run is over

local state = {inside = false, starts = {}, chatterLogged = false, configured = false, observed = nil, talking = false, missingAt = nil, missingLogged = false, watchedAt = -100,
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

-- True when a hold start now would be the ninth within CHATTER_S seconds (and records it otherwise).
local function chatter()
    local now = M.clock()
    local kept = {}
    for _, at in ipairs(state.starts) do if now - at < CHATTER_S then kept[#kept + 1] = at end end
    state.starts = kept
    if #kept >= CHATTER_MAX then return true end
    kept[#kept + 1] = now
    return false
end

local function handle(player, value, source)
    if value == 1 then
        if state.talking then return end
        if chatter() then
            if not state.chatterLogged then
                state.chatterLogged = true
                say('Controller talk button: hold ignored (more than ' .. CHATTER_MAX .. ' in ' .. CHATTER_S .. ' s)')
            end
            return
        end
        state.chatterLogged = false
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
-- Never entered from inside itself: an edge that arrives while one is handled stays in the queue, and the loop that is already running takes it.
function M.take(player, source)
    if not M.deps or not player or state.inside then return end
    state.inside = true
    local ok, err = pcall(function()
        for _ = 1, 8 do
            local taken, value = pcall(function() return player:ConvaiPadTake() end)
            if not taken or type(value) ~= 'number' or value < 0 then return end
            handle(player, value, source or 'tick')
        end
    end)
    state.inside = false
    if not ok then say('Controller talk button: edge failed (' .. tostring(err) .. ')') end
end

-- The observer only where the redscript says it notifies from its next-frame step (PadTalk.reds ConvaiPadNotifyDeferred): otherwise the tick reads the queue.
local function install(player)
    if state.observed ~= nil then return end
    local asked, observable = pcall(function() return player:ConvaiPadObservable() end)
    if asked and observable == true then
        local ok = pcall(M.deps.observe, function(who) M.take(who, 'observer') end)
        state.observed = ok == true
        say('Controller talk button: observer ' .. (ok and 'installed' or 'not installed, the tick reads the queue'))
    else
        state.observed = false
        say('Controller talk button: the tick reads the queue (the redscript does not notify)')
    end
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
    install(player)
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
