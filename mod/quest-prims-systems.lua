-- The SYSTEMS group of bond quest primitives (docs/QUEST_PRIMITIVES.md section 10, BOND_QUESTS.md section 21): pay, gift, garage and memory-share. install(R, env) adds the four
-- definitions to R.defs (mod/quest-prims.lua calls it through R.extend) and the native calls they need to env.world (the ones the world adapter does not have yet come from
-- mod/quest-world-systems.lua). Pure: every native call goes through env.world, so bridge/quest-prims-systems-lua.test.mjs runs all of it on a fake game.
--
-- Nothing here runs per frame and none of it ticks. Each primitive acts on an event or on one timer of a second after the stage armed: pay when the bridge sends
-- pay:<id>:offer, gift (give) when it sends gift:<id>:offer, gift (receive) and garage once at arm, memory-share once at arm. The ctx owns every listener, timer and registry entry.
--
-- Entity handles are never kept. The cast member of a pay stage is found through the stage's own cast primitive (its handle is plain data, looked up again by the world adapter
-- each time), and used only when the game has attached it. A primitive here gives or takes things from V and never touches a character the game placed.
--
--   pay          pay:<id>:paid (data {amount}), :short, :broke (data {amount})         listens pay:<id>:offer (data {amount}), pay:<id>:declined
--   gift         receive: gift:<id>:given, :second, :failed (data {item})              listens gift:<id>:go (an extra way to start it at once)
--                give: gift:<id>:loved, :liked, :neutral, :disliked (data {item}), :nothing    listens gift:<id>:offer (data {words})
--   garage       garage:<id>:added, :owned, :failed (data {vehicle})
--   memory-share memory-share:<id>:done (the bridge does the memory work)
--
-- pay in detail. V must be within 15 m of the cast member `to` of the same stage. The offer is compared with spec.min when it is set, else with spec.amount: below it is :short and
-- nothing is taken. At or above it, the money taken is the offer but never more than spec.amount (V is not charged extra), when V's balance covers it, else :broke. One payment
-- resolves the primitive (:paid), :short and :broke may happen again. The cast member is given nothing physical. R.payTargets() lists {pack, cast} of the pay stages that still wait
-- and R.payTargetFor(entity, profileKey) names the stage whose cast member that entity is (mod/init.lua adds quest = {pack, cast} to the turn).
--
-- gift in detail. receive: the bridge has resolved spec.item and spec.second into the play file. One second after arm the item is given to V (spec.second instead, when V already has
-- the first and a second is named). A record that is not a vanilla record is made first by mod/quest-tweak.lua when the spec lists it (spec.tweak = {name, base, flats}, name defaults
-- to spec.item, or spec.tweakSpecs = a list of those). give: one read of V's gift-able items (at most 200), the item V named matched on lowercase words of the display names, the
-- stage's `gifts` rules (ctx.gifts = {loved, liked, disliked}, each a list of {prefix} | {id} | {contains}) classify it, one is taken after a quantity check.
--
-- garage: the game's own vehicle unlock, once per save. UNVERIFIED and it CHANGES THE SAVE. The unlock call is idempotent in the game, so the primitive asks the unlock list first and
-- says :owned when the vehicle is there. There is no done-list of its own: a vehicle this very session added is reported :added again if the stage arms again (a reload of a save
-- in the same session). A restart of the game says :owned.
local M = {PAY_RANGE = 15, PAY_HEIGHT = 8, MAX_GIVE_OFFERS = 10, MAX_ROWS = 200, MAX_TWEAKS = 4, START_DELAY = 1, DONE_SLACK = 120, MAX_DONE = 128}

-- Words that carry no item: skipped on both sides of the match.
M.STOP = {}
for word in ([[the and for you your got get this that here there some something with have has had give gave gift present brought bring take its are was were just thing one new old mine from but not
    can will would hey too very really also them they then than into onto over what who how why when where which while]]):gmatch('%S+') do M.STOP[word] = true end

local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < 1e7 end
local function point(p) return type(p) == 'table' and finite(p.x) and finite(p.y) and finite(p.z) end
local function flat(a, b) local dx, dy = a.x - b.x, a.y - b.y; return math.sqrt(dx * dx + dy * dy) end
local function whole(value, low, high)
    if type(value) ~= 'number' or value ~= value or value ~= math.floor(value) or value < low or value > high then return nil end
    return value
end
local function eventId(value, default)
    if type(value) == 'string' and #value > 0 and #value <= 60 and value:match('^[%w][%w%.%-_]*$') then return value end
    return default
end
local function recordOf(value)
    if type(value) == 'string' and #value >= 3 and #value <= 80 and value:match('^[%a][%w_%.]*$') then return value end
    return nil
end

-- Lowercase words of a text (bytes of other scripts count as letters), without the stop words and the short ones. A trailing s is dropped from the longer words.
function M.words(text)
    local out, seen = {}, {}
    if type(text) ~= 'string' then return out end
    for word in text:lower():gmatch('[%w\128-\255]+') do
        local plain = word
        if #word > 3 and word:sub(-1) == 's' then word = word:sub(1, -2) end
        if #word >= 3 and not M.STOP[plain] and not M.STOP[word] and not seen[word] then seen[word] = true; out[#out + 1] = word end
    end
    return out
end

-- The words of an item row: its display name, else the record id without its group ("Items.Nomad_Jacket" gives nomad, jacket).
local function rowWords(row)
    if type(row.name) == 'string' and row.name ~= '' then
        local words = M.words(row.name)
        if #words > 0 then return words end
    end
    local tail = tostring(row.record or ''):gsub('^[%w]+%.', ''):gsub('[_%.]+', ' ')
    return M.words(tail)
end

-- The row V named: most words of the name found in V's words, then the larger share of the name, ties go to the first. nil when no word matches.
function M.match(said, rows)
    local wanted = {}
    for _, word in ipairs(M.words(said)) do wanted[word] = true end
    local best, bestHits, bestShare
    for _, row in ipairs(rows) do
        if type(row) == 'table' and type(row.record) == 'string' then
            local words = rowWords(row)
            local hits = 0
            for _, word in ipairs(words) do if wanted[word] then hits = hits + 1 end end
            local share = #words > 0 and hits / #words or 0
            if hits > 0 and (best == nil or hits > bestHits or (hits == bestHits and share > bestShare)) then best, bestHits, bestShare = row, hits, share end
        end
    end
    return best
end

-- loved | liked | disliked by the first rule that fits, else neutral. Rules compare lowercase.
function M.classify(gifts, record)
    local id = tostring(record):lower()
    for _, tier in ipairs({'loved', 'liked', 'disliked'}) do
        local rules = type(gifts) == 'table' and gifts[tier] or nil
        if type(rules) == 'table' then
            for _, rule in ipairs(rules) do
                if type(rule) == 'table' then
                    if type(rule.id) == 'string' and id == rule.id:lower() then return tier end
                    if type(rule.prefix) == 'string' and rule.prefix ~= '' and id:sub(1, #rule.prefix) == rule.prefix:lower() then return tier end
                    if type(rule.contains) == 'string' and rule.contains ~= '' and id:find(rule.contains:lower(), 1, true) then return tier end
                end
            end
        end
    end
    return 'neutral'
end

function M.install(R, env)
    env.world = env.world or {}
    local world0 = env.world

    local function log(line) if type(env.log) == 'function' then pcall(env.log, 'Quest primitive: ' .. line) end end
    local logged = {}
    local function logOnce(key, line)
        if logged[key] then return end
        logged[key] = true
        log(line)
    end
    local function gameTime()
        if type(env.gameTime) ~= 'function' then return nil end
        local ok, value = pcall(env.gameTime)
        return ok and type(value) == 'number' and value == value and value or nil
    end
    local function world(name, ...)
        local fn = env.world[name]
        if type(fn) ~= 'function' then return nil end
        local ok, a, b = pcall(fn, ...)
        if not ok then return nil end
        return a, b
    end

    -- ---- the native calls -------------------------------------------------------------------------------------------------------------------
    -- Whatever the game adapter does not have yet comes from mod/quest-world-systems.lua. A world that already has a function by that name (a test's fake) keeps it. If the file
    -- cannot be loaded the primitives still arm and every call answers nothing, which each one treats as "cannot do it now" (a gift fails, a garage fails, a payment is not taken).
    local natives = env.systemsNatives
    if natives == nil and type(dofile) == 'function' then
        local ok, module = pcall(dofile, 'quest-world-systems.lua')
        if ok and type(module) == 'table' and type(module.new) == 'function' then
            local built, W = pcall(module.new, {tweak = env.tweak, log = env.log})
            if built then natives = W end
        end
    end
    if type(natives) == 'table' then
        for name, fn in pairs(natives) do
            if type(fn) == 'function' and world0[name] == nil then world0[name] = fn end
        end
    end

    -- ---- what was done in this session ---------------------------------------------------------------------------------------------------------
    -- key -> the game clock when it was done. A mark from later than the loaded game's clock belongs to a save that was loaded away from and is forgotten.
    R.systemsDone = R.systemsDone or {}
    local doneCount = 0
    local function wasDone(key)
        local at = R.systemsDone[key]
        if at == nil then return false end
        local now = gameTime()
        if now and type(at) == 'number' and at > now + M.DONE_SLACK then R.systemsDone[key] = nil; return false end
        return true
    end
    local function markDone(key)
        if doneCount >= M.MAX_DONE then R.systemsDone, doneCount = {}, 0 end
        if R.systemsDone[key] == nil then doneCount = doneCount + 1 end
        R.systemsDone[key] = gameTime() or 0
    end

    -- The handle of a cast member of this stage (the cast primitive's state), looked up by its id on the ctx's instances.
    local function castHandle(ctx, id)
        if type(ctx.prims) ~= 'table' then return nil end
        for _, inst in ipairs(ctx.prims) do
            if inst.name == 'cast' and type(inst.state) == 'table' and inst.state.id == id and inst.state.handle ~= nil then return inst.state.handle end
        end
        return nil
    end

    -- ====================================================================================================================================
    -- pay
    -- ====================================================================================================================================
    R.payRegistry = R.payRegistry or {}

    local function payOffer(ctx, state, data)
        if state.paid or ctx.reaped then return end
        local offered = type(data) == 'table' and tonumber(data.amount) or nil
        if not offered or offered ~= offered or offered > 1e9 then logOnce('pay-data:' .. ctx.pack .. state.id, 'pay ' .. state.id .. ': the offer carries no amount'); return end
        offered = math.floor(offered)
        -- V must stand by the cast member (a plain position read of each, nothing kept).
        local handle = castHandle(ctx, state.to)
        local found = handle ~= nil and world('castLookup', handle) or nil
        local vpos = world('playerPosition')
        local near = point(vpos) and type(found) == 'table' and point(found.position)
            and flat(vpos, found.position) <= M.PAY_RANGE and math.abs(vpos.z - found.position.z) <= M.PAY_HEIGHT
        if not near then logOnce('pay-far:' .. ctx.pack .. state.id, 'pay ' .. state.id .. ': V is not by ' .. state.to .. ', the offer is ignored'); return end
        if offered < state.need then
            ctx:emit('pay:' .. state.id .. ':short', {amount = offered})
            return
        end
        local taken = math.min(offered, state.amount)
        local balance = world('moneyBalance')
        if type(balance) ~= 'number' then logOnce('pay-balance:' .. ctx.pack .. state.id, 'pay ' .. state.id .. ': the balance cannot be read, nothing is taken'); return end
        if balance < taken or not world('moneyTake', taken) then
            ctx:emit('pay:' .. state.id .. ':broke', {amount = taken})
            return
        end
        state.paid = true
        ctx:emit('pay:' .. state.id .. ':paid', {amount = taken})
    end

    R.defs.pay = {
        arm = function(ctx, spec)
            local id, to = eventId(spec.id, nil), eventId(spec.to, nil)
            local amount = whole(spec.amount, 1, 20000)
            if not id or not to or not amount then log('pay needs an id, a cast to pay and a whole amount'); return nil end
            local min = whole(spec.min, 1, 20000)
            local state = {id = id, to = to, amount = amount, need = (min and min < amount) and min or amount, paid = false, declined = false}
            local entry = {ctx = ctx, state = state}
            R.payRegistry[entry] = true
            ctx:track('pay', entry, function(e) R.payRegistry[e] = nil end)
            ctx:on('pay:' .. id .. ':offer', function(_, data) payOffer(ctx, state, data) end)
            -- The bridge may say V declined: it needs no action here (the stage's rows answer it), it is only a recognised event.
            ctx:on('pay:' .. id .. ':declined', function() state.declined = true end)
            return state
        end,
    }

    -- The pay stages that still wait: [{pack, cast}]. A ctx that was reaped or forgotten (a world change clears it without undo) drops out here.
    function R.payTargets()
        local out = {}
        for entry in pairs(R.payRegistry) do
            if entry.ctx.reaped then R.payRegistry[entry] = nil
            elseif not entry.state.paid then out[#out + 1] = {pack = entry.ctx.pack, cast = entry.state.to} end
        end
        table.sort(out, function(a, b) return a.pack .. ':' .. a.cast < b.pack .. ':' .. b.cast end)
        return out
    end

    -- {pack, cast} when `entity` (or the copy `profileKey` of the turn) is the cast member of a pay stage that still waits, else nil. A nil check while no pay stage is armed.
    function R.payTargetFor(entity, profileKey)
        if next(R.payRegistry) == nil then return nil end
        for entry in pairs(R.payRegistry) do
            if entry.ctx.reaped then R.payRegistry[entry] = nil
            elseif not entry.state.paid then
                local handle = castHandle(entry.ctx, entry.state.to)
                if handle ~= nil and world('castIs', handle, entity, profileKey) == true then return {pack = entry.ctx.pack, cast = entry.state.to} end
            end
        end
        return nil
    end

    -- ====================================================================================================================================
    -- gift
    -- ====================================================================================================================================
    local function ensureTweaks(spec)
        local specs = {}
        if type(spec.tweak) == 'table' then specs[#specs + 1] = {name = spec.tweak.name or spec.item, base = spec.tweak.base, flats = spec.tweak.flats} end
        if type(spec.tweakSpecs) == 'table' then
            for _, row in ipairs(spec.tweakSpecs) do
                if #specs >= M.MAX_TWEAKS then break end
                if type(row) == 'table' then specs[#specs + 1] = {name = row.name, base = row.base, flats = row.flats} end
            end
        end
        for index, row in ipairs(specs) do
            if index > M.MAX_TWEAKS then break end
            local ok, why = world('tweakEnsure', row.name, row.base, row.flats)
            if ok ~= true then log('gift: the record ' .. tostring(row.name) .. ' could not be made: ' .. tostring(why)) end
        end
    end

    local function giftReceive(ctx, spec, state)
        if state.done or ctx.reaped then return end
        state.done = true
        ensureTweaks(spec)
        local function fail(record, why)
            log('gift ' .. state.id .. ' failed: ' .. why)
            ctx:emit('gift:' .. state.id .. ':failed', {item = record})
        end
        if world('itemExists', state.item) ~= true then return fail(state.item, 'the record ' .. state.item .. ' does not exist') end
        local have = world('itemCount', state.item)
        if type(have) ~= 'number' then return fail(state.item, 'the inventory cannot be read') end
        local record, event = state.item, 'given'
        if have > 0 and state.second then record, event = state.second, 'second' end
        if record ~= state.item and world('itemExists', record) ~= true then return fail(record, 'the record ' .. record .. ' does not exist') end
        if world('itemGive', record, state.quantity) ~= true then return fail(record, 'the item could not be given') end
        markDone(ctx.pack .. '#' .. tostring(ctx.serial) .. '#' .. state.id)
        ctx:emit('gift:' .. state.id .. ':' .. event, {item = record})
    end

    local function giftGive(ctx, state, data)
        if ctx.reaped or state.offers >= M.MAX_GIVE_OFFERS then return end
        state.offers = state.offers + 1
        local said = type(data) == 'table' and type(data.words) == 'string' and data.words or ''
        local function nothing(why)
            if why then log('gift ' .. state.id .. ': ' .. why) end
            ctx:emit('gift:' .. state.id .. ':nothing')
        end
        local rows = world('inventoryGifts', M.MAX_ROWS)
        if type(rows) ~= 'table' or #rows == 0 then return nothing(rows == nil and 'the inventory cannot be read' or nil) end
        local capped = {}
        for index = 1, math.min(#rows, M.MAX_ROWS) do capped[index] = rows[index] end
        local row = M.match(said, capped)
        if not row then return nothing() end
        local record = recordOf(row.record)
        if not record then return nothing() end
        local have = world('itemCount', record)
        if type(have) ~= 'number' or have < 1 then return nothing('V does not have ' .. record) end
        if world('itemTake', record, 1) ~= true then return nothing('the item could not be taken') end
        local tier = M.classify(ctx.gifts, record)
        ctx:emit('gift:' .. state.id .. ':' .. tier, {item = record})
    end

    R.defs.gift = {
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('gift has no id'); return nil end
            if spec.dir == 'give' then
                local state = {id = id, dir = 'give', offers = 0}
                ctx:on('gift:' .. id .. ':offer', function(_, data) giftGive(ctx, state, data) end)
                return state
            end
            if spec.dir ~= 'receive' then log('gift ' .. id .. ' has no direction'); return nil end
            local item = recordOf(spec.item)
            if not item then log('gift ' .. id .. ' names no item'); return nil end
            local state = {id = id, dir = 'receive', item = item, second = recordOf(spec.second), quantity = whole(spec.quantity, 1, 20) or 1,
                done = wasDone(ctx.pack .. '#' .. tostring(ctx.serial) .. '#' .. id)}
            if state.done then logOnce('gift-again:' .. ctx.pack .. id, 'gift ' .. id .. ' was given in this session already'); return state end
            local function run() giftReceive(ctx, spec, state) end
            ctx:after(M.START_DELAY, run, {real = true})
            ctx:on('gift:' .. id .. ':go', run)
            return state
        end,
    }

    -- ====================================================================================================================================
    -- garage
    -- ====================================================================================================================================
    R.defs.garage = {
        arm = function(ctx, spec)
            local id, vehicle = eventId(spec.id, nil), recordOf(spec.vehicle)
            if not id or not vehicle then log('garage needs an id and a vehicle record'); return nil end
            local state = {id = id, vehicle = vehicle, done = false}
            local key = 'garage#' .. vehicle
            ctx:after(M.START_DELAY, function()
                if state.done or ctx.reaped then return end
                state.done = true
                local outcome
                local owned = world('vehicleOwned', vehicle)
                if owned == true then
                    outcome = wasDone(key) and 'added' or 'owned'
                else
                    local ok, why = world('vehicleAdd', vehicle)
                    if ok == true and world('vehicleOwned', vehicle) ~= false then
                        markDone(key)
                        outcome = 'added'
                    else
                        log('garage ' .. id .. ' failed: ' .. tostring(why or 'the vehicle is not in the garage afterwards'))
                        outcome = 'failed'
                    end
                end
                ctx:emit('garage:' .. id .. ':' .. outcome, {vehicle = vehicle})
            end, {real = true})
            return state
        end,
    }

    -- ====================================================================================================================================
    -- memory-share
    -- ====================================================================================================================================
    R.defs['memory-share'] = {
        arm = function(ctx, spec)
            local id = eventId(spec.id, nil)
            if not id then log('memory-share has no id'); return nil end
            -- At the next step, after stage:enter: the bridge has done the memory work by now, the event only tells the stage's rows.
            ctx:after(0, function() ctx:emit('memory-share:' .. id .. ':done') end, {real = true})
            return {id = id}
        end,
    }
end

return M
