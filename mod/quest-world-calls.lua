local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The game side of the CALL primitives of the bond quests (mod/quest-prims-calls.lua: call-in and call-script, docs/QUEST_PRIMITIVES.md section 10.6). The native calls only,
-- each one guarded by its caller. None of them runs per frame: a call is started once, read once a second by the primitive while it rings or plays, and ended once.
--
-- A quest call is the mod's own holocall (mod/holocall.lua, docs/HOLOCALL.md) started by the quest instead of by V's Chat tab: the same call window, the same ring and
-- pick-up sounds, the same caller (her voice, the portrait or the live picture), the same hang-up. What a quest call adds is small and all in holocall.lua:
--   M.start(player, contact, sample, waited, opts)   opts.incoming: she rings V and the call waits for V to pick up (the phone button), opts.quiet: no notice when refused,
--                                                    opts.voice: the portrait voice call, opts.quest: the call is the quest's (its start hook is not told)
--   M.onCallStarted(profileKey, call)                called once when a call connects (V's own call to her, which a call-script plays on)
--   M.lastEnd                                        {serial, reason} of the call that ended last
--
-- UNVERIFIED in the game (offline-tested on a fake game only, the first live run must look at each):
--   callRing      the ring itself: ConvaiHolocallBegin shows the window as a RINGING call (IncomingCall: the contact's name, the ring sound), and holocall.lua keeps it there until V
--                 picks up. The phone button is the pick-up: the redscript reports a tap and a hold of it both as "hangup", and while an incoming call rings that is read as picking
--                 up (holocall.lua HANGUP_ANSWERS), so V cannot turn a quest call away, only let it ring out. A redscript that reports "answer" for a tap would make that exact.
--   callState     reads the open call of holocall.lua (state dialing = ringing, connected) and, once it is gone, M.lastEnd.
--   callLines     sets the global convaiQuestCallLines, which mod/init.lua convaiQuestLineBusy reads so the lines of a scripted call may start while the call is open.
-- Nothing here touches a character the game placed: a call is her voice on the phone, no body.
local M = {}

local function global(key)
    local ok, value = pcall(function() return _G[key] end)
    if ok and value ~= nil then return value end
    ok, value = pcall(rawget, _G, key)
    return ok and value or nil
end

-- deps: log(line).
function M.new(deps)
    deps = deps or {}
    local W = {}

    local function log(line) if type(deps.log) == 'function' then pcall(deps.log, 'Quest calls world: ' .. line) end end
    local function holocall()
        local module = global('convaiHolocall')
        return type(module) == 'table' and module or nil
    end
    local function player()
        local ok, value = pcall(function() return convaiPlayer() end)
        return ok and value or nil
    end

    -- true when no call may start or play now: the line player's own rule (V talks, a reply is made or heard, a scene, a fight, a game call, a call of V's is open, a dialogue).
    -- When the rule cannot be read it is busy, so a call never starts blind.
    function W.callBusy()
        local rule = global('convaiQuestLineBusy')
        if type(rule) ~= 'function' then return true end
        local ok, busy = pcall(rule)
        return not ok or busy ~= false
    end

    -- The contact id of a profile: the shipped phone contact of that character, else her profile key (a Chat row without a journal contact carries it as her contact id).
    local function contactOf(module, profileKey)
        for contact, entry in pairs(type(module.catalog) == 'table' and module.catalog or {}) do
            if type(entry) == 'table' and entry.key == profileKey then return contact end
        end
        return profileKey
    end

    -- Starts the ring. Returns the call's serial, or false and why (the primitive then sends the text).
    function W.callRing(profileKey, opts)
        local module, who = holocall(), player()
        if not module or not who or type(module.start) ~= 'function' then return false, 'no holocall module' end
        if module.call ~= nil then return false, 'a call is open' end
        local ok, started = pcall(module.start, who, contactOf(module, profileKey), nil, nil,
            {incoming = true, quiet = true, quest = true, voice = type(opts) == 'table' and opts.voice == true or nil})
        if not ok then return false, tostring(started):sub(1, 120) end
        local call = module.call
        if started ~= true or type(call) ~= 'table' then return false, 'the call was refused' end
        return call.serial
    end

    -- 'ringing' | 'connected' for the call with that serial while it is open, else 'ended' and why (holocall.lua's reason, or nil when it is not known).
    function W.callState(serial)
        local module = holocall()
        if not module then return 'ended', 'no holocall module' end
        local call = module.call
        if type(call) == 'table' and call.serial == serial then return call.state == 'connected' and 'connected' or 'ringing' end
        local last = module.lastEnd
        return 'ended', type(last) == 'table' and last.serial == serial and tostring(last.reason) or nil
    end

    -- The connected call V is on, as {serial, key}, or nil. A call-script plays on it.
    function W.callOpen()
        local module = holocall()
        local call = module and module.call
        if type(call) ~= 'table' or call.state ~= 'connected' then return nil end
        return {serial = call.serial, key = call.key, quest = call.quest == true}
    end

    -- Hangs up the call with that serial (the quest ended it, or the ring ran out). Silent: reason 'scripted' sends no notice.
    function W.callEnd(serial, reason)
        local module = holocall()
        local call = module and module.call
        if type(call) ~= 'table' or call.serial ~= serial or type(module.finish) ~= 'function' then return false end
        return pcall(module.finish, player(), reason or 'scripted') == true
    end

    -- The lines of a scripted call may start while a call is open (mod/init.lua convaiQuestLineBusy reads this global).
    function W.callLines(on)
        local ok = pcall(function() _G.convaiQuestCallLines = on == true or nil end)
        if not ok then log('the call lines flag could not be set') end
        return ok
    end

    -- fn(profileKey, call) is told once when a call connects. Returns a function that takes the hook away again (only if it is still this one).
    function W.callHook(fn)
        local module = holocall()
        if not module or type(fn) ~= 'function' then return nil end
        module.onCallStarted = fn
        return function() if module.onCallStarted == fn then module.onCallStarted = nil end end
    end

    return W
end

return M
