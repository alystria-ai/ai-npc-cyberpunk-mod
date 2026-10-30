-- Eddies between V and the characters (docs/EDDIES.md, bridge/eddies.mjs). Settings > Gameplay > Eddies with characters, Off by default.
--
-- The game half. It owns the money and the ledger; the bridge only proposes, and the game moves the money when the character has agreed:
--   block(context)   once per private turn V sends to a named character, while the setting is On: whether the character is one of V's own copies
--                    (party, invited visitor, housemate), V's balance (own copies only), the clock and the character's ledger row. A game-placed
--                    character gets the row only (talk only: nothing can move). Arms a short watch for the bridge's proposal of this turn.
--   update(player)   from the 10 Hz tick. Nothing at all unless a watch or a proposal is open: the proposal file is read at most twice a second while
--                    a watch is armed (at most 150 s after a turn to an own copy). A proposal for that turn waits until the reply is spoken and V is
--                    free (no menu, scene or text box), then the eddies move at once, no question asked: the character's reply was the agreement.
--                    First everything is checked (the setting, the character still one of V's copies, a whole sum from 1 to the cap, V's live
--                    balance, the debt a payback settles); the eddies move with the game's transaction calls (the vendors' and the taxi's, so the game
--                    shows its own eddies notification), read back from the balance. A character that only ASKS V for a loan moves nothing: V's
--                    money leaves only on V's own words in a later turn. The ledger
--                    (runtime/eddies-ledger.json) is written only when something happened: once per transfer or refusal, once when a character
--                    first deals with V, and once when a load went back before some of it.
-- The ledger is a list of entries per character, each stamped with V's game clock: an entry from later than the clock of the save now loaded (a load of
-- an earlier save, the eddies the game took back with it) is forgotten for good, like Street reputation's rollback guard. A load can only forget, never invent.
-- No per-frame work: with the setting Off, block() returns at the first check and update() at a nil check.
local M = {version = 1}
-- The most one transfer moves (bridge/eddies.mjs EDDIES_CAP).
M.CAP = 100000
M.HALF_LIFE_DAYS = 7
M.FLOWS = {loanToV = true, loanFromV = true, repayByV = true, repayToV = true, giftFromV = true, giftToV = true}
M.TO_V = {loanToV = true, repayToV = true, giftToV = true}
M.LEDGER = 'runtime/eddies-ledger.json'
M.OFFER = 'runtime/eddies-offer.json'
local DAY = 86400
local WATCH_SECONDS, POLL_SECONDS, WAIT_SECONDS = 150, 0.5, 45
local MAX_CHARACTERS, MAX_ENTRIES, MAX_FILE = 400, 40, 524288
-- Game seconds of slack before an entry counts as later than the loaded save (the clock read and the stamp are a moment apart).
local ROLLBACK_SLACK = 120
local RESULTS = {done = true, declined = true, missed = true, failed = true}

local function whole(value, low, high)
    return type(value) == 'number' and value == value and value == math.floor(value) and value >= (low or 0) and value <= (high or 1e12)
end

-- The story a proposal belongs to ("<pack id>:<stage id>", docs/RELATIONSHIPS_AND_QUESTS.md section 7.5), or nil for anything else.
function M.story(value)
    if type(value) ~= 'string' or #value > 100 or not value:match('^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$') then return nil end
    return value
end

-- What V owes the character and what the character owes V, from a view row (M.view).
function M.debts(row)
    local t = type(row) == 'table' and type(row.totals) == 'table' and row.totals or {}
    local function n(key) return tonumber(t[key]) or 0 end
    return math.max(0, n('loanToV') - n('repayByV')), math.max(0, n('loanFromV') - n('repayToV'))
end

-- The row the bridge reads (bridge/eddies.mjs parseRow) from a stored row: totals of the transfers made, the faded flow at `now`, the last entry
-- (with the story it was made for, when it was one).
function M.view(stored, now)
    if type(stored) ~= 'table' then return nil end
    local row = {seed = stored.seed, met = stored.met, asked = stored.asked, totals = {}, flow = 0, flowAt = now}
    for flow in pairs(M.FLOWS) do row.totals[flow] = 0 end
    for _, entry in ipairs(stored.entries) do
        if entry.r == 'done' then
            row.totals[entry.f] = row.totals[entry.f] + entry.n
            local days = math.max(0, (now - entry.at) / DAY)
            row.flow = row.flow + (M.TO_V[entry.f] and -entry.n or entry.n) * (0.5 ^ (days / M.HALF_LIFE_DAYS))
        end
    end
    local last = stored.entries[#stored.entries]
    if last then row.last = {flow = last.f, amount = last.n, result = last.r, at = last.at, origin = last.o, story = last.s} end
    return row
end

-- options: enabled() -> bool; ownCopy(entity, profileKey) -> 'party' | 'visitor' | 'housemate' | nil; player() -> V; now() -> seconds (os.time);
-- gameTime() -> V's game clock in seconds or nil (world-knowledge.lua nativeGameTime: entries are stamped with it, and a load before them forgets them);
-- clock() -> seconds (os.clock); read(path) -> text | nil; write(path, text) -> bool; encode / decode (json); random(n) -> 0..n-1;
-- balance(player), give(player, amount), remove(player, amount) (the game's transaction calls by default);
-- busy(player) -> bool (a reply still playing, a menu, a scene, the text box: the transfer waits); notice(player, text); t(text, vars); log(line).
function M.new(options)
    options = options or {}
    local P = {}
    local ledger, watch, offer, lastRaw, pollAt = nil, nil, nil, nil, 0
    local moneyId
    local function call(fn, ...)
        if type(fn) ~= 'function' then return false, nil end
        return pcall(fn, ...)
    end
    local function log(line) if type(options.log) == 'function' then pcall(options.log, 'Eddies: ' .. line) end end
    -- The game's translations (mod/ui-locale.lua, given as options.t); every text below is a literal so the UI catalogue finds it.
    local ui = {t = function(text, vars)
        if type(options.t) == 'function' then
            local ok, value = pcall(options.t, text, vars)
            if ok and type(value) == 'string' then return value end
        end
        return (text:gsub('{(%w+)}', function(key) return vars and vars[key] ~= nil and tostring(vars[key]) or '{' .. key .. '}' end))
    end}
    local function now() local ok, value = call(options.now); return ok and whole(value, 1) and value or os.time() end
    local function clock() local ok, value = call(options.clock); return ok and type(value) == 'number' and value or os.clock() end
    local function enabled() local ok, value = call(options.enabled); return ok and value == true end
    local function encode(value) local ok, raw = pcall(options.encode or json.encode, value); return ok and type(raw) == 'string' and raw or nil end
    local function decode(raw) local ok, value = pcall(options.decode or json.decode, raw); return ok and value or nil end
    local function read(path)
        if type(options.read) == 'function' then local ok, raw = pcall(options.read, path); return ok and raw or nil end
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(MAX_FILE + 1); file:close()
        return raw
    end
    local function write(path, text)
        if type(options.write) == 'function' then local ok, done = pcall(options.write, path, text); return ok and done ~= false end
        local file = io.open(path, 'wb')
        if not file then return false end
        local written, closed = file:write(text), file:close()
        return written and closed and true or false
    end
    local function money()
        if moneyId == nil then moneyId = ItemID.FromTDBID(TweakDBID.new('Items.money')) end
        return moneyId
    end
    local function balance(player)
        if type(options.balance) == 'function' then return options.balance(player) end
        return Game.GetTransactionSystem():GetItemQuantity(player, money())
    end
    local function give(player, amount)
        if type(options.give) == 'function' then return options.give(player, amount) end
        return Game.GetTransactionSystem():GiveItem(player, money(), amount)
    end
    local function remove(player, amount)
        if type(options.remove) == 'function' then return options.remove(player, amount) end
        return Game.GetTransactionSystem():RemoveItem(player, money(), amount)
    end
    local function random(n)
        if type(options.random) == 'function' then local ok, value = pcall(options.random, n); if ok and whole(value, 0, n - 1) then return value end end
        return math.random(0, n - 1)
    end

    local function gameTime()
        local ok, value = call(options.gameTime)
        value = ok and tonumber(value) or nil
        return value and value == value and value >= 0 and math.floor(value) or nil
    end

    -- The ledger, read once (a missing or unreadable file is an empty ledger; a bad row or entry is dropped).
    local function cleanEntry(entry)
        if type(entry) ~= 'table' or not M.FLOWS[entry.f] or not whole(entry.n, 1, M.CAP) or not whole(entry.at, 0) or not RESULTS[entry.r] then return nil end
        return {f = entry.f, n = entry.n, at = entry.at, r = entry.r, o = (entry.o == 'asked' or entry.o == 'offered') and entry.o or nil,
            g = whole(entry.g, 0) and entry.g or nil, s = M.story(entry.s)}
    end
    local function cleanRow(row)
        if type(row) ~= 'table' then return nil end
        local out = {seed = whole(row.seed, 0, 999) and row.seed or 500, met = whole(row.met, 0) and row.met or 0,
            asked = whole(row.asked, 0) and row.asked or 0, entries = {}}
        if type(row.entries) == 'table' then
            for _, entry in ipairs(row.entries) do
                local clean = cleanEntry(entry)
                if clean then out.entries[#out.entries + 1] = clean end
            end
        end
        while #out.entries > MAX_ENTRIES do table.remove(out.entries, 1) end
        return out
    end
    local function load()
        if ledger then return ledger end
        ledger = {}
        local raw = read(M.LEDGER)
        local value = type(raw) == 'string' and #raw > 0 and #raw <= MAX_FILE and decode(raw) or nil
        if type(value) == 'table' and value.version == 2 and type(value.characters) == 'table' then
            local count = 0
            for key, row in pairs(value.characters) do
                if type(key) == 'string' and key:match('^[a-z0-9][a-z0-9-]*$') and #key <= 80 and count < MAX_CHARACTERS then
                    local clean = cleanRow(row)
                    if clean then ledger[key] = clean; count = count + 1 end
                end
            end
        end
        return ledger
    end
    local function save()
        local raw = encode({version = 2, characters = load()})
        if not raw or not write(M.LEDGER, raw) then log('ledger not written'); return false end
        return true
    end
    -- The rollback guard: entries stamped later than the loaded save's clock are forgotten (the load took their eddies back). Returns how many went.
    local function forgetFuture(row, clockNow)
        if not row or not clockNow then return 0 end
        local kept, gone = {}, 0
        for _, entry in ipairs(row.entries) do
            if entry.g and entry.g > clockNow + ROLLBACK_SLACK then gone = gone + 1 else kept[#kept + 1] = entry end
        end
        if gone > 0 then row.entries = kept end
        return gone
    end
    P.row = function(profileKey) return load()[profileKey] end

    -- The `eddies` block of a request (bridge/eddies.mjs parseEddies), or nil.
    function P.block(context)
        if type(context) ~= 'table' or type(context.profileKey) ~= 'string' or not enabled() then return nil end
        if context.group ~= nil or context.reaction ~= nil or context.holocall ~= nil or context.head ~= nil or context.voiceOnly then return nil end
        local key, at = context.profileKey, now()
        local okOwn, copy = call(options.ownCopy, context.entity, key)
        if not okOwn or (copy ~= 'party' and copy ~= 'visitor' and copy ~= 'housemate') then copy = nil end
        local have
        if copy then
            local okPlayer, player = call(options.player)
            local okBalance, value = false, nil
            if okPlayer and player then okBalance, value = pcall(balance, player) end
            value = okBalance and tonumber(value) or nil
            if whole(value, 0) then have = value else copy = nil end
        end
        local rows = load()
        local gone = forgetFuture(rows[key], gameTime())
        if gone > 0 then log(string.format('person=%s forgot=%d (later than this save)', key, gone)) end
        local changed = gone > 0
        -- The first time one of V's own copies deals with V: the character's means are set (a seed that varies the data's usual cash) and remembered.
        if copy and not rows[key] then
            rows[key] = cleanRow({seed = random(1000), met = at})
            changed = true
        end
        if changed then save() end
        local block = {version = 1, on = true, now = at, own = copy ~= nil, row = M.view(rows[key], at)}
        if copy then
            block.copy, block.balance = copy, have
            if type(context.requestId) == 'string' then
                watch = {requestId = context.requestId, entity = context.entity, profileKey = key, ['until'] = clock() + WATCH_SECONDS}
                pollAt = 0
            end
        end
        return block
    end

    local function valid(p)
        return type(p) == 'table' and p.version == 1 and type(p.id) == 'string' and #p.id <= 80 and M.FLOWS[p.flow]
            and whole(p.amount, 1, M.CAP) and type(p.profileKey) == 'string' and type(p.requestId) == 'string'
    end

    local function record(p, result)
        local rows = load()
        local row = rows[p.profileKey] or cleanRow({seed = random(1000), met = now()})
        local at = now()
        row.entries[#row.entries + 1] = {f = p.flow, n = p.amount, at = at, r = result, o = p.origin == 'asked' and 'asked' or 'offered', g = gameTime(),
            s = M.story(p.story)}
        -- The oldest go first. Every entry was a proposal of a turn, so 40 is a long stretch of play.
        while #row.entries > MAX_ENTRIES do table.remove(row.entries, 1) end
        if p.origin == 'asked' then row.asked = at end
        rows[p.profileKey] = row
        save()
        log(string.format('person=%s flow=%s amount=%d result=%s', p.profileKey, p.flow, p.amount, result))
    end

    local function notice(player, text) if type(options.notice) == 'function' then pcall(options.notice, player, text) end end

    -- The transfer, once the character has agreed. Returns 'done' or 'failed' plus a notice.
    local function transfer(player, p)
        if not enabled() then return 'failed', nil end
        local okOwn, copy = call(options.ownCopy, p.entity, p.profileKey)
        if not okOwn or not copy then return 'failed', ui.t('{name} is no longer with you, so no eddies moved.', {name = p.name}) end
        local vOwes, owesV = M.debts(M.view(load()[p.profileKey], now()))
        if (p.flow == 'repayByV' and p.amount > vOwes) or (p.flow == 'repayToV' and p.amount > owesV) then
            return 'failed', ui.t('The eddies could not be moved.')
        end
        local okBefore, before = pcall(balance, player)
        before = okBefore and tonumber(before) or nil
        if not whole(before, 0) then return 'failed', ui.t('The eddies could not be moved.') end
        local toV = M.TO_V[p.flow]
        if not toV and before < p.amount then return 'failed', ui.t('You do not have enough eddies for that.') end
        local okMove, answer = pcall(toV and give or remove, player, p.amount)
        if not okMove then log('transfer failed: ' .. tostring(answer):sub(1, 120)); return 'failed', ui.t('The eddies could not be moved.') end
        local okAfter, after = pcall(balance, player)
        after = okAfter and tonumber(after) or nil
        if after == before + (toV and p.amount or -p.amount) then return 'done', nil end
        log('transfer unconfirmed: asked=' .. p.amount .. ' moved=' .. tostring(after and after - before or '?'))
        -- The balance moved by something else as well (a vendor, a reward): count what was asked if the direction is right, else nothing.
        if after and ((toV and after > before) or (not toV and after < before)) then return 'done', nil end
        return 'failed', ui.t('The eddies could not be moved.')
    end

    -- A character that only asks V for a loan (its own move): V has not agreed to anything, so nothing leaves V's wallet. Only the time of the ask is
    -- kept (the cooldown between asks); V lends in a later turn in V's own words, which is then an ordinary proposal.
    local function markAsked(p)
        local rows = load()
        local row = rows[p.profileKey] or cleanRow({seed = random(1000), met = now()})
        row.asked = now()
        rows[p.profileKey] = row
        save()
        log(string.format('person=%s flow=%s amount=%d asked (nothing moves)', p.profileKey, p.flow, p.amount))
    end

    function P.update(player)
        if not watch and not offer then return end
        local at = clock()
        if watch and not offer then
            if at > watch['until'] then watch = nil
            elseif at >= pollAt then
                pollAt = at + POLL_SECONDS
                local raw = read(M.OFFER)
                if type(raw) == 'string' and raw ~= lastRaw and #raw > 0 and #raw <= 4096 then
                    lastRaw = raw
                    local p = decode(raw)
                    if valid(p) and p.requestId == watch.requestId and p.profileKey == watch.profileKey and p.entity == watch.entity then
                        p.name = type(p.name) == 'string' and p.name:sub(1, 80) or ''
                        offer = {p = p, readyAt = at + 1, expiresAt = at + WAIT_SECONDS}
                        watch = nil
                        log(string.format('proposal person=%s flow=%s amount=%d origin=%s', p.profileKey, p.flow, p.amount, tostring(p.origin)))
                    end
                end
            end
        end
        if not offer then return end
        if not enabled() then offer = nil; return end
        if at > offer.expiresAt then record(offer.p, 'missed'); offer = nil; return end
        if at < offer.readyAt then return end
        local okBusy, busy = call(options.busy, player)
        if okBusy and busy then return end
        -- The reply is over and V is free: the character agreed in it, so the eddies move now. The offer is cleared first: one transfer per proposal.
        local p = offer.p
        offer = nil
        if p.flow == 'loanFromV' and p.origin == 'asked' then markAsked(p); return end
        local result, text = transfer(player, p)
        record(p, result)
        if text then notice(player, text) end
    end

    -- A load needs no reset: a proposal waits at most 45 s and must match the request id of the turn it answers.
    P.pending = function() return watch ~= nil or offer ~= nil end
    return P
end

return M
