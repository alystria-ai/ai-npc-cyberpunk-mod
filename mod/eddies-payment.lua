-- Paying a character in eddies (docs/EDDIES_PAYMENT.md, bridge/eddies-payment.mjs). Settings > Companion behavior > Pay characters in eddies, Off by default.
--
-- Two calls, both on demand and never per frame:
--   offer(entity, context)   made once when V's typed line to one of V's own characters is admitted (mod/gameplay-actions.lua leases it): who may be paid, V's balance
--                            and the most V may pay in one go. Nothing for a game-placed character, a spoken line, a group round, a call or a phone chat, and nothing
--                            while the setting is Off.
--   pay(amount, offer, ...)  made once when the bridge hands back a payment that the lease matched to the offer. The amount was decided by the bridge from V's own words;
--                            this side checks EVERYTHING again (the setting, the offer, a whole number from 1 to the cap and to the offered maximum, that the character is
--                            still one of ours, V's live balance) and takes the eddies with the game's own transaction call, the one the vendors and the taxi use. The
--                            game's inventory listener then shows its own "eddies" pop-up for the change; this module adds no notification of its own.
-- The result is read back from the balance: a payment counts only when the balance went down by exactly the amount.
local M = {version = 1}
-- The most V can pay a character in one line, whatever the balance (the bridge holds the same number).
M.CAP = 100000

local function whole(value)
    return type(value) == 'number' and value == value and value >= 0 and value < math.huge and value == math.floor(value)
end

-- Words that make a typed line worth one probe line when no offer is made (the line may be a payment the setting or the character ruled out). Never used to pay.
local MONEYISH = {'eddie', 'euro', '€', 'cash', 'pay', 'paid', 'gave', 'give', 'эдди', 'едді', 'エディ', '에디', '欧', '艾迪', '埃迪', '尤罗'}
local function moneyish(text)
    if type(text) ~= 'string' or not text:find('%d') then return false end
    text = text:lower()
    for _, word in ipairs(MONEYISH) do if text:find(word, 1, true) then return true end end
    return false
end

-- options: enabled() -> bool; payable(entity, profileKey) -> bool (one of our own copies: in the party, an invited visitor, a housemate); player() -> V's game object;
-- log(line); balance(player) and remove(player, amount) replace the game calls (tests).
function M.new(options)
    local P = {}
    local moneyId
    local function log(line)
        if type(options.log) == 'function' then pcall(options.log, line) end
    end
    -- The ItemID of Items.money is built once, the same record the turn context reads (mod/turn-context.lua) and the vanilla scripts' MarketSystem.Money().
    local function money()
        if moneyId == nil then moneyId = ItemID.FromTDBID(TweakDBID.new('Items.money')) end
        return moneyId
    end
    -- The balance as a plain number: the game's quantity is read through tonumber, so a boxed integer (cdata) is as good as a number.
    local function balance(player)
        if type(options.balance) == 'function' then return options.balance(player) end
        local have = Game.GetTransactionSystem():GetItemQuantity(player, money())
        return tonumber(have) or have
    end
    local function remove(player, amount)
        if type(options.remove) == 'function' then return options.remove(player, amount) end
        return Game.GetTransactionSystem():RemoveItem(player, money(), amount)
    end
    local function enabled()
        local ok, value = pcall(options.enabled)
        return ok and value == true
    end

    -- One probe line per typed line that talks of money (a digit and a money word), for the offer made or the reason none was: the reason is the whole point of it (docs/EDDIES_PAYMENT.md, "Probe lines").
    local function note(context, text)
        if type(context) == 'table' and moneyish(context.text) then
            log('Eddies payment: ' .. text .. (type(context.profileKey) == 'string' and (' person=' .. context.profileKey) or ''))
        end
    end

    function P.offer(entity, context)
        if type(entity) ~= 'string' or type(context) ~= 'table' or type(context.profileKey) ~= 'string' then return nil end
        if context.group ~= nil or context.holocall ~= nil or context.reaction ~= nil or context.head ~= nil or context.voiceOnly then
            note(context, 'offer=no(context)'); return nil
        end
        if not enabled() then note(context, 'offer=no(switch-off)'); return nil end
        local ok, ours = pcall(options.payable, entity, context.profileKey)
        if not ok or ours ~= true then note(context, 'offer=no(not-ours' .. (ok and '' or ':error') .. ')'); return nil end
        local okPlayer, player = pcall(options.player)
        if not okPlayer or player == nil then note(context, 'offer=no(no-player)'); return nil end
        local okBalance, have = pcall(balance, player)
        if not okBalance or not whole(have) then note(context, 'offer=no(balance-unreadable:' .. (okBalance and type(have) or 'error') .. ')'); return nil end
        if have < 1 then note(context, 'offer=no(no-eddies)'); return nil end
        local offer = {available = true, actor = {id = entity, key = context.profileKey}, balance = have, max = math.min(have, M.CAP)}
        note(context, 'offer=yes balance=' .. tostring(have) .. ' max=' .. tostring(offer.max))
        return offer
    end

    -- Returns true, or false and a short code: off, offer, amount, not-ours, no-player, unreadable, balance, error, unconfirmed.
    function P.pay(amount, offer, entity, requestId)
        local function refuse(code)
            log('Eddies payment refused: ' .. code)
            return false, code
        end
        if not enabled() then return refuse('off') end
        if type(offer) ~= 'table' or offer.available ~= true or type(offer.actor) ~= 'table' or type(entity) ~= 'string' or offer.actor.id ~= entity
            or type(offer.actor.key) ~= 'string' then return refuse('offer') end
        if not whole(amount) or amount < 1 or amount > M.CAP or not whole(offer.max) or amount > offer.max then return refuse('amount') end
        local okOurs, ours = pcall(options.payable, entity, offer.actor.key)
        if not okOurs or ours ~= true then return refuse('not-ours') end
        local okPlayer, player = pcall(options.player)
        if not okPlayer or player == nil then return refuse('no-player') end
        local okBefore, before = pcall(balance, player)
        if not okBefore or not whole(before) then return refuse('unreadable') end
        if before < amount then return refuse('balance') end
        local okRemove, answer = pcall(remove, player, amount)
        if not okRemove then
            log('Eddies payment failed: ' .. tostring(answer):sub(1, 120))
            return false, 'error'
        end
        local okAfter, after = pcall(balance, player)
        if okAfter and whole(after) and after == before - amount then
            log('Eddies payment: person=' .. offer.actor.key .. ' amount=' .. tostring(amount) .. ' paid=yes')
            return true
        end
        log('Eddies payment unconfirmed: asked=' .. tostring(amount) .. ' moved=' .. tostring(okAfter and whole(after) and before - after or '?') .. ' answer=' .. tostring(answer))
        return false, 'unconfirmed'
    end

    return P
end

return M
