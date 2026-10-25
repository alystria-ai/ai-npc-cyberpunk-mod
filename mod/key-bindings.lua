-- The mod's own key bindings (Companion Manager > Key bindings, docs/KEY_BINDINGS.md): for each of the five actions (talk by voice, talk by text, group voice
-- chat, group text chat, the Companion Manager) the player presses Set and then the keyboard key or controller button they want. They work at once, with no
-- restart, next to the Cyber Engine Tweaks bindings of the same actions, which keep working. The redscript half (r6/scripts/CyberpunkConvai/KeyBinds.reds)
-- listens to the game's key events for the chosen keys only; this half decides whether the moment is allowed and runs the code path the CET key of that action
-- runs (init.lua voiceKeyEdge, beginText, openManager), so the behaviour and the gating are the same.
--
-- Nothing here runs per frame. The redscript half calls ConvaiKeyBindNotify when a key goes down or up, and this module observes it (CET Observe), so a key is
-- handled at the moment it happens. The game's 10 Hz tick also drains the same queue (a call returning "" when empty) in case the observer was not installed,
-- registers the saved keys again for a new player after a load, and ends a Set that nobody answered. With no binding saved and no Set in progress the tick costs
-- one table check and the redscript listener is not registered.
--
--   hold actions (talk by voice, group voice chat)   key down = V's turn begins, key up = it ends, as the CET voice keys (hold to talk)
--   tap actions (text, group text, manager)          the action runs when the key comes back up, as a CET hotkey does (so the key's character is not typed
--                                                    into the box it opens)
local M = {}
M.clock = os.clock

-- The five actions, in the order of the page and of the redscript slots (slot 1 is voice), and the CET binding (hotkey or input) each one has.
M.ACTIONS = {'voice', 'text', 'group_voice', 'group_text', 'manager'}
M.CET_ID = {voice = 'cyberpunk_convai_voice', text = 'cyberpunk_convai_text', group_voice = 'cyberpunk_convai_group_voice',
    group_text = 'cyberpunk_convai_group_text', manager = 'cyberpunk_convai_manager'}
M.HOLD = {voice = true, group_voice = true}
local SLOT = {}
for index, action in ipairs(M.ACTIONS) do SLOT[action] = index end

local CAPTURE_S = 12      -- a Set nobody answers ends after this long
local GRACE_S = 0.4       -- a key that goes down this soon after Set is the key that chose Set (a held Enter repeating), not the choice
local AFTER_S = 0.5       -- bound keys are not acted on this long after a choice: the key just chosen is still down
local ONCE_S = 0.4        -- the same tap action asked twice within this (a CET key and an own key on the same key) runs once
local MISSING_RETRY_S = 30 -- scripts without the key methods (the redscript did not compile) are asked again this seldom

local state = {observed = nil, configured = nil, capture = nil, ignoreUntil = -100, down = {}, armed = {}, tapAt = {},
    missingAt = nil, missingLogged = false, cet = nil, cetAt = -100}
local configure  -- defined with the tick below

-- deps (set by init.lua once):
--   bindings()           the saved own bindings, {action = 'IK_F7'} (mod/manager.lua keyBindings; read, never changed here)
--   save(action, name)   saves one binding (name nil clears it): true, or false and a reason (manager.setKeyBinding)
--   voice(action, down)  the talk key of that voice action goes down or up (init.lua voiceKeyEdge)
--   tap(action)          the tap action runs (beginText, openManager)
--   typing(player)       true while V types somewhere (the phone's chat box); the text box and menus are refused by the actions themselves
--   observe(fn)          CET Observe on PlayerPuppet.ConvaiKeyBindNotify; fn(player) runs when the redscript queues an event
--   boundKey(id)         CET's own text for a binding ('F6', 'Ctrl + J'), and whether CET answers at all (ui-locale boundKey and IsBound)
--   readFile(path)       the text of a file, or nil (CET's bindings.json when the sandbox lets the mod read it)
--   changed(result)      a Set ended: {kind = 'bound' | 'duplicate' | 'cancelled' | 'timeout' | 'failed', action, name, other, reason}
--   player()             the current player, for a Set that ends without one in hand
--   log(line)
M.deps = nil

local function say(line) if M.deps and M.deps.log then pcall(M.deps.log, line) end end

-- ---- Key names ----------------------------------------------------------------------------------------------------------------------------------

local KEYBOARD = {
    IK_Space = 'Space', IK_Enter = 'Enter', IK_Tab = 'Tab', IK_Backspace = 'Backspace', IK_Insert = 'Insert', IK_Delete = 'Delete',
    IK_Home = 'Home', IK_End = 'End', IK_PageUp = 'Page up', IK_PageDown = 'Page down',
    IK_Up = 'Up arrow', IK_Down = 'Down arrow', IK_Left = 'Left arrow', IK_Right = 'Right arrow',
    IK_CapsLock = 'Caps lock', IK_NumLock = 'Num lock', IK_ScrollLock = 'Scroll lock', IK_Pause = 'Pause', IK_PrintScrn = 'Print screen',
    IK_NumPlus = 'Num +', IK_NumMinus = 'Num -', IK_NumStar = 'Num *', IK_NumSlash = 'Num /', IK_NumPeriod = 'Num .',
    IK_Semicolon = ';', IK_Equals = '=', IK_Comma = ',', IK_Minus = '-', IK_Period = '.', IK_Slash = '/', IK_Backslash = '\\',
    IK_IntlBackslash = '\\', IK_Tilde = '`', IK_LeftBracket = '[', IK_RightBracket = ']', IK_SingleQuote = '\'',
}
for letter in ('ABCDEFGHIJKLMNOPQRSTUVWXYZ'):gmatch('.') do KEYBOARD['IK_' .. letter] = letter end
for digit = 0, 9 do KEYBOARD['IK_' .. digit] = tostring(digit); KEYBOARD['IK_NumPad' .. digit] = 'Num ' .. digit end
for number = 1, 24 do KEYBOARD['IK_F' .. number] = 'F' .. number end

-- Controller buttons by the game's names. The face buttons carry the Xbox letters (the game names them after both makers); the triggers are buttons here
-- (they report a press), the sticks' directions are not offered. The Controller talk button (L3 held) is a different setting and keeps working.
local PAD = {
    IK_Pad_A_CROSS = 'A', IK_Pad_B_CIRCLE = 'B', IK_Pad_X_SQUARE = 'X', IK_Pad_Y_TRIANGLE = 'Y',
    IK_Pad_LeftShoulder = 'LB', IK_Pad_RightShoulder = 'RB', IK_Pad_LeftTrigger = 'LT', IK_Pad_RightTrigger = 'RT',
    IK_Pad_LeftThumb = 'L3', IK_Pad_RightThumb = 'R3',
    IK_Pad_DigitUp = 'D-pad up', IK_Pad_DigitDown = 'D-pad down', IK_Pad_DigitLeft = 'D-pad left', IK_Pad_DigitRight = 'D-pad right',
    IK_Pad_Back_Select = 'View', IK_Pad_Start = 'Menu',
}

-- 'key' or 'pad' and the English words of a key the player may choose, or nil: modifiers (Shift, Ctrl and Alt are how a key is told from a shortcut), the
-- mouse, the sticks' axes, Escape (it cancels) and every key without a name here are not offered.
function M.describe(name)
    if type(name) ~= 'string' then return nil end
    if KEYBOARD[name] then return 'key', KEYBOARD[name] end
    if PAD[name] then return 'pad', PAD[name] end
    return nil
end

-- Whether a stored value is the name of a key (the manager checks this before saving; the names are the game's, 'IK_F7').
function M.valid(name)
    return type(name) == 'string' and M.describe(name) ~= nil
end

-- The list the redscript half takes: the key of each slot in order, '-' for none; '' when there is none at all.
function M.list(bindings)
    if type(bindings) ~= 'table' or next(bindings) == nil then return '' end
    local parts, any = {}, false
    for index, action in ipairs(M.ACTIONS) do
        local name = bindings[action]
        if M.valid(name) then parts[index] = name; any = true else parts[index] = '-' end
    end
    return any and table.concat(parts, ',') or ''
end

-- ---- Cyber Engine Tweaks' own bindings (shown on the page, never changed) ------------------------------------------------------------------------

-- bindings.json holds one 64-bit number for each action of each mod: four 16-bit slots of Windows virtual-key codes, the first key in the top 16 bits
-- (F6 alone is 0x0075 followed by 48 zero bits). A chord such as Ctrl + J has the modifier in the first slot. CET reads the file when the game starts and
-- writes it when the game ends, so a binding changed during a session shows here after the next start; the live text (boundKey) is preferred.
local VK = {
    [0x08] = 'Backspace', [0x09] = 'Tab', [0x0D] = 'Enter', [0x10] = 'Shift', [0x11] = 'Ctrl', [0x12] = 'Alt', [0x13] = 'Pause', [0x14] = 'Caps lock',
    [0x1B] = 'Esc', [0x20] = 'Space', [0x21] = 'Page up', [0x22] = 'Page down', [0x23] = 'End', [0x24] = 'Home',
    [0x25] = 'Left arrow', [0x26] = 'Up arrow', [0x27] = 'Right arrow', [0x28] = 'Down arrow', [0x2C] = 'Print screen', [0x2D] = 'Insert', [0x2E] = 'Delete',
    [0x6A] = 'Num *', [0x6B] = 'Num +', [0x6D] = 'Num -', [0x6E] = 'Num .', [0x6F] = 'Num /', [0x90] = 'Num lock', [0x91] = 'Scroll lock',
    [0xA0] = 'Left Shift', [0xA1] = 'Right Shift', [0xA2] = 'Left Ctrl', [0xA3] = 'Right Ctrl', [0xA4] = 'Left Alt', [0xA5] = 'Right Alt',
    [0xBA] = ';', [0xBB] = '=', [0xBC] = ',', [0xBD] = '-', [0xBE] = '.', [0xBF] = '/', [0xC0] = '`', [0xDB] = '[', [0xDC] = '\\', [0xDD] = ']', [0xDE] = '\'',
    [0x01] = 'Left mouse', [0x02] = 'Right mouse', [0x04] = 'Middle mouse', [0x05] = 'Mouse 4', [0x06] = 'Mouse 5',
}
for code = 0x30, 0x39 do VK[code] = string.char(code) end
for code = 0x41, 0x5A do VK[code] = string.char(code) end
for number = 0, 9 do VK[0x60 + number] = 'Num ' .. number end
for number = 1, 24 do VK[0x6F + number] = 'F' .. number end

-- The virtual-key codes of a stored number, first key first. `value` is the decimal text from the file (a Lua number cannot hold every digit of one
-- above 2^53, so the text is divided by 65536 four times, each remainder being one slot), or a number small enough to be exact.
function M.decodeBind(value)
    local digits = type(value) == 'number' and string.format('%.0f', value) or tostring(value or '')
    if not digits:match('^%d+$') then return nil end
    local number = {}
    for digit in digits:gmatch('%d') do number[#number + 1] = tonumber(digit) end
    local slots = {}
    for index = 4, 1, -1 do
        local quotient, remainder = {}, 0
        for _, digit in ipairs(number) do
            local current = remainder * 10 + digit
            local part = math.floor(current / 65536)
            remainder = current - part * 65536
            if #quotient > 0 or part > 0 then quotient[#quotient + 1] = part end
        end
        slots[index] = remainder
        number = quotient
    end
    local keys = {}
    for index = 1, 4 do if slots[index] ~= 0 then keys[#keys + 1] = slots[index] end end
    return keys
end

-- 'F6', 'Ctrl + J': the codes as CET writes a chord. A code without a name is written as its number.
function M.bindText(keys)
    if type(keys) ~= 'table' or #keys == 0 then return nil end
    local words = {}
    for index, code in ipairs(keys) do words[index] = VK[code] or ('Key ' .. tostring(code)) end
    return table.concat(words, ' + ')
end

-- The text of the five actions in CET's bindings.json: {action = 'F6'}. Only this mod's own entries are read (the names are unique to it, wherever the
-- mod's folder is called), and an action without a binding (or a 0) is left out.
function M.decodeCet(text)
    local result = {}
    if type(text) ~= 'string' then return result end
    local byId = {}
    for action, id in pairs(M.CET_ID) do byId[id] = action end
    for id, digits in text:gmatch('"([%w_]+)"%s*:%s*(%d+)') do
        local action = byId[id]
        if action and result[action] == nil then
            local label = M.bindText(M.decodeBind(digits))
            if label then result[action] = label end
        end
    end
    return result
end

-- The Cyber Engine Tweaks binding of an action as text, or nil when there is none. CET's live answer wins when CET answers at all (a binding changed in
-- its overlay this session shows at once); the file is read only when CET gives no such call, and at most every 5 s.
function M.cetBinding(action)
    local deps = M.deps
    if not deps then return nil end
    if deps.boundKey then
        local ok, value, available = pcall(deps.boundKey, M.CET_ID[action])
        if ok and available then return value end
    end
    local now = M.clock()
    if not state.cet or now < state.cetAt or now - state.cetAt >= 5 then
        state.cet, state.cetAt = {}, now
        if deps.readFile then
            for _, path in ipairs({'../../bindings.json'}) do
                local ok, text = pcall(deps.readFile, path)
                if ok and type(text) == 'string' then state.cet = M.decodeCet(text); break end
            end
        end
    end
    return state.cet[action]
end

-- ---- Events ----------------------------------------------------------------------------------------------------------------------------------------

-- The tap actions run once for one press, whoever heard it: a CET hotkey and an own key on the same key both fire when it comes up, a few milliseconds
-- apart. init.lua asks this from the CET hotkeys too (convaiTapOnce) once the module is loaded.
function M.once(action)
    local now = M.clock()
    local last = state.tapAt[action]
    if last and now >= last and now - last < ONCE_S then return false end
    state.tapAt[action] = now
    return true
end

local function blocked(player)
    local deps = M.deps
    if not deps.typing then return nil end
    local ok, typing = pcall(deps.typing, player)
    if ok and typing == true then return 'typing' end
    return nil
end

local function endHolds(why)
    for _, action in ipairs(M.ACTIONS) do
        if state.down[action] then
            state.down[action] = nil
            say('Key binding ' .. action .. ': ended (' .. why .. ')')
            pcall(M.deps.voice, action, false)
        end
    end
    state.armed = {}
end

local function pressed(player, action)
    if state.capture or M.clock() < state.ignoreUntil then return end
    local reason = blocked(player)
    if M.HOLD[action] then
        if state.down[action] then return end
        if reason then say('Key binding ' .. action .. ': press ignored (' .. reason .. ')'); return end
        state.down[action] = true
        say('Key binding ' .. action .. ': down')
        pcall(M.deps.voice, action, true)
    else
        state.armed[action] = reason == nil or nil
    end
end

local function released(player, action)
    if M.HOLD[action] then
        if not state.down[action] then return end
        state.down[action] = nil
        say('Key binding ' .. action .. ': up')
        pcall(M.deps.voice, action, false)
    elseif state.armed[action] then
        state.armed[action] = nil
        if state.capture or M.clock() < state.ignoreUntil then return end
        if not M.once(action) then say('Key binding ' .. action .. ': ignored (the same key also ran it from Cyber Engine Tweaks)'); return end
        say('Key binding ' .. action .. ': pressed')
        pcall(M.deps.tap, action)
    end
end

local function endCapture(player, result)
    local capture = state.capture
    if not capture then return end
    state.capture = nil
    state.ignoreUntil = M.clock() + AFTER_S
    player = player or (M.deps.player and M.deps.player())
    if player then pcall(function() return player:ConvaiKeyBindsCapture(false) end) end
    say('Key binding ' .. capture.action .. ': ' .. result.kind .. (result.name and (' ' .. result.name) or ''))
    if M.deps.changed then pcall(M.deps.changed, result) end
end

-- The key that went down while a Set is waiting. Escape and the controller's B cancel; a key that cannot be bound (a modifier, a mouse button ...) is
-- ignored and the Set goes on waiting; a key another action already has is refused and says which.
local function captured(player, name)
    local capture = state.capture
    if not capture or M.clock() - capture.at < GRACE_S then return end
    if name == 'IK_Escape' or name == 'IK_Pad_B_CIRCLE' then
        endCapture(player, {kind = 'cancelled', action = capture.action})
        return
    end
    if not M.valid(name) then return end
    for action, bound in pairs(M.deps.bindings() or {}) do
        if bound == name and action ~= capture.action then
            endCapture(player, {kind = 'duplicate', action = capture.action, name = name, other = action})
            return
        end
    end
    local ok, saved, reason = pcall(M.deps.save, capture.action, name)
    if ok and saved == true then
        -- The new key is registered now, not on the next tick: the key is still down, and its release must find the listener.
        pcall(configure, player, M.list(M.deps.bindings()), M.clock())
        endCapture(player, {kind = 'bound', action = capture.action, name = name})
    else
        endCapture(player, {kind = 'failed', action = capture.action, name = name, reason = ok and reason or saved})
    end
end

local function handle(player, token)
    local kind = token:sub(1, 1)
    if kind == 'k' then captured(player, token:sub(2)); return end
    local action = M.ACTIONS[tonumber(token:sub(2)) or 0]
    if not action then return end
    if kind == 'd' then pressed(player, action) elseif kind == 'u' then released(player, action) end
end

-- Drain the redscript's queue (bounded). Called by the observer and by the tick.
function M.take(player)
    if not M.deps or not player then return end
    for _ = 1, 8 do
        local ok, token = pcall(function() return player:ConvaiKeyBindTake() end)
        if not ok or type(token) ~= 'string' or token == '' then return end
        handle(player, token)
    end
end

local function install()
    if state.observed ~= nil then return end
    local ok = pcall(M.deps.observe, function(player) M.take(player) end)
    state.observed = ok == true
    say('Key bindings: observer ' .. (ok and 'installed' or 'not installed, the tick reads the queue'))
end

-- ---- Set -----------------------------------------------------------------------------------------------------------------------------------------------

-- Starts waiting for the key of `action`. Returns true, or false and why: 'codeware' (the game has no Codeware, so keys cannot be heard), 'scripts' (this
-- mod's redscript did not load) or 'unknown'.
function M.beginCapture(player, action)
    if not M.deps or not SLOT[action] then return false, 'unknown' end
    if not player then return false, 'scripts' end
    local ok, ready = pcall(function() return player:ConvaiKeyBindsReady() end)
    if not ok then return false, 'scripts' end
    if ready ~= true then return false, 'codeware' end
    if state.capture then endCapture(player, {kind = 'cancelled', action = state.capture.action}) end
    local started, listening = pcall(function() return player:ConvaiKeyBindsCapture(true) end)
    if not started or listening ~= true then return false, 'scripts' end
    install()
    state.armed = {}
    state.capture = {action = action, at = M.clock()}
    say('Key binding ' .. action .. ': waiting for a key')
    return true
end

-- A Set in progress is dropped without a word (the page was left, the session ended); nobody is told.
function M.abandonCapture(player)
    local capture = state.capture
    if not capture then return end
    state.capture = nil
    player = player or (M.deps and M.deps.player and M.deps.player())
    if player then pcall(function() return player:ConvaiKeyBindsCapture(false) end) end
    say('Key binding ' .. capture.action .. ': Set dropped')
end

function M.capturing() return state.capture and state.capture.action or nil end

-- ---- The tick ----------------------------------------------------------------------------------------------------------------------------------------------

-- The saved keys, registered with the redscript half. The registration is gone with the player (a load makes a new one): the half is asked what it holds.
function configure(player, wanted, now)
    local ok, active = pcall(function() return player:ConvaiKeyBindsActive() end)
    if not ok then
        state.missingAt = now
        if not state.missingLogged then
            state.missingLogged = true
            say('Key bindings: the redscript half is not loaded (KeyBinds.reds), the bindings do nothing')
        end
        return false
    end
    state.missingAt, state.missingLogged = nil, false
    if active == wanted then state.configured = wanted; return true end
    endHolds('bindings changed')
    local set, done = pcall(function() return player:ConvaiKeyBindsConfigure(wanted) end)
    if not set or done ~= true then
        state.missingAt = now
        if not state.missingLogged then
            state.missingLogged = true
            say('Key bindings: Codeware is missing, the bindings do nothing')
        end
        return false
    end
    state.configured = wanted
    say('Key bindings: ' .. (wanted == '' and 'off' or wanted))
    return true
end

-- Called from the game's 10 Hz tick. `ready`: the world is playable.
function M.tick(player, ready)
    local deps = M.deps
    if not deps then return end
    local wanted = M.list(deps.bindings())
    if wanted == '' and not state.capture and (state.configured == nil or state.configured == '') and next(state.down) == nil then return end
    if not ready or not player then
        endHolds('world not ready')
        state.configured = nil
        state.capture = nil
        return
    end
    local now = M.clock()
    if state.capture and (now < state.capture.at or now - state.capture.at >= CAPTURE_S) then
        endCapture(player, {kind = 'timeout', action = state.capture.action})
    end
    if state.missingAt and now >= state.missingAt and now - state.missingAt < MISSING_RETRY_S then return end
    if not configure(player, wanted, now) then return end
    if wanted ~= '' or state.capture then install(); M.take(player) end
end

-- The session ends, or every binding is gone: holds end, a Set is dropped and the redscript listeners stop (best effort: the player may be gone).
function M.stop(player)
    if not M.deps then return end
    endHolds('stopped')
    M.abandonCapture(player)
    if player and state.configured ~= nil and state.configured ~= '' then pcall(function() return player:ConvaiKeyBindsConfigure('') end) end
    state.configured = nil
end

function M.observed() return state.observed end
function M.held(action) return state.down[action] == true end

return M
