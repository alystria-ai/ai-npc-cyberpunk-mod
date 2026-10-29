-- One safe way to ask the game for V.
--
-- Every module asked for the player with Game.GetPlayer(). Game is one table shared by every Cyber Engine Tweaks mod, and one mod
-- (error report aa500cce) replaced Game.GetPlayer with a table that cannot be called: "attempt to call field 'GetPlayer' (a table
-- value)". Each frame of this mod then raised that error and nothing worked. The getter below is what the whole mod calls instead:
--
--   convaiPlayer()   V, or nil when there is no player yet (the menu, a loading screen). Never raises because Game.GetPlayer was replaced.
--
-- init.lua loads this at the top of the file (after the native io shim), before any other mod's onInit, and sets the global convaiPlayer. A module that can be loaded without
-- init.lua (the tests) starts with `local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end`, so it keeps
-- working alone.
--
-- The chain, first that works:
--   1. Game.GetPlayer, when it is a function or a table the engine can call (a metatable with __call);
--   2. the Game.GetPlayer captured when this file loaded, when that was a function;
--   3. Game.GetPlayerSystem():GetLocalPlayerMainGameObject(), what CET's own Game.GetPlayer does (needs no Game.GetPlayer).
-- If none of them can answer the getter returns nil, which every caller already handles (it is what the menu returns too).
--
-- Cost. The ordinary frame is one table read, one comparison with the captured function and the call itself: no type() call,
-- no table, no closure, no pcall. Only when Game.GetPlayer is not the captured function is the value looked at (once per distinct
-- value: the answer is kept), and a broken one keeps costing the same few comparisons, not a pcall.
--
-- When the guard steps in it says so once per game session (convaiLogOnce, so probe.log and the console), in words that do not look
-- like a Lua error, so no error report is sent for it. A notice needs V (it is a phone popup), so when even step 3 cannot answer
-- there is only a second log line, never a popup.
local M = {version = 1}

local original = nil        -- the function Game.GetPlayer was when this file loaded (nil when it was not a function)
local seen, mode = nil, nil -- the last Game.GetPlayer value that was not `original`, and how it is answered: 'call', 'original' or 'system'
-- What still has to be said (a kind of value, or true), and what has been said. Each line goes out once per game session.
local due = {replaced = nil, lost = false}
local said = {replaced = false, lost = false}

do
    local ok, value = pcall(function() return Game.GetPlayer end)
    if ok and type(value) == 'function' then original = value end
end

-- What can be called: a function, or a table or userdata whose metatable has a __call.
local function callable(value)
    local kind = type(value)
    if kind == 'function' then return true end
    if kind ~= 'table' and kind ~= 'userdata' then return false end
    local meta = getmetatable(value)
    return type(meta) == 'table' and type(meta.__call) == 'function'
end

-- Game.GetPlayerSystem():GetLocalPlayerMainGameObject(), the same call CET makes for Game.GetPlayer. No pcall: a missing
-- Game.GetPlayerSystem is a nil answer (and the second log line), and a raised error is what Game.GetPlayer() itself would have raised.
local function system()
    local getSystem = Game and Game.GetPlayerSystem
    if type(getSystem) ~= 'function' then
        if not said.lost then due.lost = true end
        return nil
    end
    local players = getSystem()
    if players == nil then return nil end
    return players:GetLocalPlayerMainGameObject()
end

local function classify(value)
    seen = value
    if callable(value) then
        mode = 'call'
        return
    end
    if not said.replaced then due.replaced = type(value) end
    mode = original and 'original' or 'system'
end

-- convaiLogOnce is defined by init.lua after this file loads: a line that is due before that waits for the next call. Only the slow
-- path comes here, and only until both lines are out.
local function tell()
    if not convaiLogOnce then return end
    if due.replaced then
        local kind = due.replaced
        convaiLogOnce('player-getter-replaced', 'Another mod replaced Game.GetPlayer (it is '
            .. (kind == 'nil' and 'nil' or 'a ' .. kind) .. ' now, not a function): working around it with '
            .. (original and 'the original function' or 'Game.GetPlayerSystem') .. '.')
        due.replaced, said.replaced = nil, true
    end
    if due.lost then
        convaiLogOnce('player-getter-lost', 'Game.GetPlayer is replaced and Game.GetPlayerSystem does not answer either: the player is not available to this mod.')
        due.lost, said.lost = false, true
    end
end

local function slow(value)
    if value ~= seen or mode == nil then classify(value) end
    local player
    if mode == 'call' then player = value()
    elseif mode == 'original' then player = original()
    else player = system() end
    if due.replaced or due.lost then tell() end
    return player
end

function M.get()
    local value = Game.GetPlayer
    if value ~= nil and value == original then return value() end
    return slow(value)
end

-- For tests and the developer report: how the getter answers now ('call', 'original', 'system', or nil before the first odd value).
function M.mode() return mode end

return M
