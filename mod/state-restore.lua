-- Is the service still restoring the player's saved files? (docs/PACKAGING.md, "Mod Organizer 2: the player's state")
--
-- Under Mod Organizer 2 a file created in the game folder does not survive a launch. The conversation service keeps a copy of each
-- player-state file (settings.json, phone-history.json, addon-settings.json, npc-names.json, ...) outside the game folder
-- (bridge/game-state.mjs) and, as the first thing it does, writes those copies back into runtime/ wherever the file is missing or
-- empty, then writes runtime/state-restore.json. This module tells a reader of one of those files whether a restore may still be on its
-- way, so it never mistakes "not restored yet" for "nothing saved" and never saves defaults over the player's settings:
--
--   convaiStateRestore.waiting()   true:  the file you found missing or empty may be about to be restored. Use defaults in memory only,
--                                         save nothing, and ask again later.
--                                  false: the restore is over (the signal came), or none is coming (see GRACE): what is on disk is
--                                         what there is.
--
-- Asked only by a reader that found its file missing or empty (never on an ordinary start, never per frame), and the answer stays false
-- once it has been false. A signal written before this game session started is ignored: the file is shipped empty and the service
-- modifies it in place, so a signal from the last session is still there at the next launch. The time the game process started is
-- os.time() - os.clock() (the C runtime's clock() is the wall time since the process began); when the signal has not come GRACE seconds
-- after the first question (an older Runtime package, the service not started, or the clock not behaving as that), waiting ends and the
-- reader carries on as it always did.
local M = {GRACE = 120, POLL = 1, SLACK = 5, PATH = 'runtime/state-restore.json'}

local finished, firstAsk, lastRead = false, nil, nil

local function gameStart()
    local ok, value = pcall(function() return os.time() - os.clock() end)
    return ok and type(value) == 'number' and value or nil
end

-- A finished restore from this game session; an empty, cut-short or older signal is "not yet".
local function signalSeen()
    local file = io.open(M.PATH, 'rb')
    if not file then return false end
    local raw = file:read('*a')
    file:close()
    if type(raw) ~= 'string' or raw == '' then return false end
    local ok, value = pcall(json.decode, raw)
    if not ok or type(value) ~= 'table' or value.version ~= 1 or value.state ~= 'done' or type(value.written) ~= 'number' then return false end
    local started = gameStart()
    return started ~= nil and value.written / 1000 >= started - M.SLACK
end

function M.waiting()
    if finished then return false end
    local now = os.clock()
    firstAsk = firstAsk or now
    if lastRead == nil or now - lastRead >= M.POLL then
        lastRead = now
        if signalSeen() then finished = true; return false end
    end
    if now - firstAsk >= M.GRACE then finished = true; return false end
    return true
end

return M
