-- The raw phone shortcut callback cannot consume native game actions. Gate
-- their menu destination separately, without changing the user's key bindings.
-- This module can also be installed into an existing CET session once.
local M = convaiPhoneInput or {blocked = 0}

-- The menu controller's OnAction and OnHandleMenuInput see every input event,
-- several per frame (mouse and movement axes). The two native phone queries are
-- answered once per STATE_SECONDS, not once per event.
local STATE_SECONDS = .02
local stateAt, stateTyping, stateOpen = nil, false, false
local function queryTyping(player) return player:ConvaiPhoneChatTyping() end
local function queryOpen(player) return player:ConvaiPhoneIsOpen() end
local function phoneState()
    local now = os.clock()
    if stateAt and now >= stateAt and now - stateAt < STATE_SECONDS then return stateTyping, stateOpen end
    local player = Game.GetPlayer()
    local okTyping, typing, okOpen, open = false, false, false, false
    if player then
        okTyping, typing = pcall(queryTyping, player)
        okOpen, open = pcall(queryOpen, player)
    end
    stateAt, stateTyping, stateOpen = now, okTyping and typing == true, okOpen and open == true
    return stateTyping, stateOpen
end
M.phoneState = phoneState

local function phoneOpen()
    local _, open = phoneState()
    return open
end

function M.blocksMenuAction(action)
    local typing, open = phoneState()
    if typing then return true end
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
        if typing or (open and event:IsAction('toggle_journal')) then
            M.blocked = M.blocked + 1
            event:Handle()
            event:Consume()
            return false
        end
        return wrapped(event)
    end)
    M.installed = true
    M.version = 2
end

convaiPhoneInput = M
return M
