-- The raw phone shortcut callback cannot consume native game actions. Gate
-- their menu destination separately, without changing the user's key bindings.
-- This module can also be installed into an existing CET session once.
local M = convaiPhoneInput or {blocked = 0}

local function phoneOpen()
    local player = Game.GetPlayer()
    return player and player:ConvaiPhoneIsOpen() or false
end

function M.blocksMenuAction(action)
    if not phoneOpen() then return false end
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
    if M.installed and M.version == 1 then return end
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
        if phoneOpen() and event:IsAction('toggle_journal') then
            M.blocked = M.blocked + 1
            event:Handle()
            event:Consume()
            return false
        end
        return wrapped(event)
    end)
    M.installed = true
    M.version = 1
end

convaiPhoneInput = M
return M
