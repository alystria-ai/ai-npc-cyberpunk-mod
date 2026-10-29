local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end
-- The raw phone shortcut callback cannot consume native game actions. Gate
-- their menu destination separately, without changing the user's key bindings.
-- This module can also be installed into an existing CET session once.
local M = convaiPhoneInput or {blocked = 0}

-- The menu controller's OnAction and OnHandleMenuInput see every input event,
-- several per frame (mouse and movement axes). The two native phone queries are
-- answered once per STATE_SECONDS, not once per event.
-- A player that answers neither (this mod's scripts did not compile, so it has neither method) is asked again only every
-- ABSENT_SECONDS: the two failing calls would otherwise run for every input event for as long as the game is open.
local STATE_SECONDS, ABSENT_SECONDS = .02, 1
local stateAt, stateTyping, stateOpen, stateAbsent = nil, false, false, false
local function queryTyping(player) return player:ConvaiPhoneChatTyping() end
local function queryOpen(player) return player:ConvaiPhoneIsOpen() end
local function phoneState()
    local now = os.clock()
    if stateAt and now >= stateAt and now - stateAt < (stateAbsent and ABSENT_SECONDS or STATE_SECONDS) then return stateTyping, stateOpen end
    local player = convaiPlayer()
    local okTyping, typing, okOpen, open = false, false, false, false
    if player then
        okTyping, typing = pcall(queryTyping, player)
        okOpen, open = pcall(queryOpen, player)
    end
    stateAt, stateTyping, stateOpen = now, okTyping and typing == true, okOpen and open == true
    stateAbsent = player ~= nil and not okTyping and not okOpen
    return stateTyping, stateOpen
end
M.phoneState = phoneState

local function phoneOpen()
    local _, open = phoneState()
    return open
end

-- While the player types, the in-game menu controller must not act on their
-- keys. A key-up is another matter: a key that was already held when typing began
-- (V strafing right until D is pressed again) has to be seen coming up by the
-- game. So a release is consumed only when it is one of the menu actions the
-- controller listens for (RegisterInputListenersForPlayer in
-- inGameMenuGameController.script); every other release passes through. Passing a
-- release the game never saw pressed is harmless.
local MENU_ACTIONS = {'OpenPauseMenu', 'OpenMapMenu', 'OpenCraftingMenu', 'OpenJournalMenu', 'OpenPerksMenu',
    'OpenInventoryMenu', 'OpenHubMenu', 'QuickSave', 'QuickLoad', 'FastForward_Hold'}
-- The controller's global pointer callback (OnPostOnRelease, so every event is a key-up)
-- reacts to exactly these.
local MENU_RELEASES = {'back', 'toggle_menu', 'toggle_inventory', 'toggle_perks', 'toggle_journal', 'toggle_map',
    'toggle_crafting'}

local function isMenuAction(action)
    for _, name in ipairs(MENU_ACTIONS) do
        local ok, matched = pcall(ListenerAction.IsAction, action, name)
        if ok and matched then return true end
    end
    return false
end
M.isMenuAction = isMenuAction

-- True for the key-up of an action that is not a menu action.
local function passesRelease(action)
    local ok, released = pcall(ListenerAction.IsButtonJustReleased, action)
    return ok and released == true and not isMenuAction(action)
end
M.passesRelease = passesRelease

local function menuPointerEvent(event)
    for _, name in ipairs(MENU_RELEASES) do
        local ok, matched = pcall(function() return event:IsAction(name) end)
        if ok and matched then return true end
    end
    return false
end

function M.blocksMenuAction(action)
    local typing, open = phoneState()
    if typing then return not passesRelease(action) end
    if not open then return false end
    -- The standard journal binding is J. GetKey also covers menu actions the
    -- player has rebound to either of our phone keys.
    if ListenerAction.IsAction(action, 'OpenJournalMenu') then return true end
    local ok, keys = pcall(ListenerAction.GetKey, action)
    if ok and type(keys) == 'table' then
        for _, key in ipairs(keys) do
            if tonumber(key) == 74 or tonumber(key) == 76 then return true end
        end
    end
    return false
end

function M.install()
    if M.installed then return end
    Override('gameuiInGameMenuGameController', 'OnAction', function(self, action, consumer, wrapped)
        local ok, blocked = pcall(M.blocksMenuAction, action)
        if ok and blocked then
            M.blocked = M.blocked + 1
            ListenerActionConsumer.Consume(consumer)
            return false
        end
        return wrapped(action, consumer)
    end)
    Override('gameuiInGameMenuGameController', 'OnHandleMenuInput', function(self, event, wrapped)
        local typing, open = phoneState()
        if typing and not menuPointerEvent(event) then return false end -- any other key-up reaches the game
        if typing or (open and event:IsAction('toggle_journal')) then
            M.blocked = M.blocked + 1
            event:Handle()
            event:Consume()
            return false
        end
        return wrapped(event)
    end)
    M.installed = true
    M.version = 3
end

convaiPhoneInput = M
return M
