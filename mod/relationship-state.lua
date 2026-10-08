-- Read-only relationship receipts. No quest writes, dialogue or provider calls.
-- Zero is unknown because GetFactStr also returns zero for an absent fact.
local M = {}
local FACTS = {
    {'sq030_11_romance', 'core-arcs.judy.committed'},
    {'sq030_judy_lover', 'core-arcs.judy.committed'},
    {'sq030_romance', 'core-arcs.judy.committed'},
    {'sq030_friendship', 'core-arcs.judy.friends'},
    {'sq027_panzer_sex', 'aldecaldos.native.panam-basilisk-intimacy'},
    {'sq027_panam_lover', 'aldecaldos.native.panam-basilisk-intimacy'},
    {'sq029_river_lover', 'jr-native.river-relationship-committed'},
    {'sq029_done', 'jr-native.river-relationship-committed'},
    {'sq028_kerry_relationship', 'silverhand.beach-committed'},
    {'sq028_kerry_dislike', 'silverhand.beach-declined'},
    {'q003_stout_sex_done', 'ahe-native.stout-encounter'},
}

local function ready(frame)
    return type(frame) == 'table' and frame.status == 'ready'
        and type(frame.worldToken) == 'string' and #frame.worldToken > 0
        and type(frame.generation) == 'number' and frame.generation >= 1
        and frame.generation % 1 == 0
end

local function same(a, b)
    return ready(a) and ready(b) and a.worldToken == b.worldToken and a.generation == b.generation
end

local function nativeFact(key) return Game.GetQuestsSystem():GetFactStr(key) end
local function nativeVersion() return Game.GetSystemRequestsHandler():GetGameVersion() end
local function write(value)
    local ok, raw = pcall(json.encode, value)
    if not ok then return false end
    local path = 'runtime/relationship-state.json'
    local file = io.open(path .. '.tmp', 'wb')
    if not file then return false end
    local written, closed = file:write(raw), file:close()
    if not written or not closed then return false end
    -- Windows rename cannot replace a file: remove first (one operation fewer).
    os.remove(path)
    if not os.rename(path .. '.tmp', path) then return false end
    return true
end

function M.new(options)
    options = options or {}
    local currentWorld = assert(options.currentWorld, 'Relationship capture needs the current world owner')
    local readFact, readVersion = options.readFact or nativeFact, options.readVersion or nativeVersion
    local clock, publish = options.clock or function() return os.time() * 1000 end, options.publish or write
    local last = nil
    local collector = {}

    function collector:reset(reason)
        last = nil
        local value = {version = 1, status = 'unavailable', reason = reason or 'world-unavailable', capturedAt = clock()}
        return publish(value)
    end

    function collector:update(frame)
        if not same(frame, currentWorld()) then return self:reset('world-unavailable') end
        local now = clock()
        -- The bridge keeps a capture 5 s; recapture and republish every 2 s.
        if last and same(last, frame) and now >= last.capturedAt and now - last.capturedAt < 2000 then return true end
        local versionOk, version = pcall(readVersion)
        if not versionOk or version ~= '2.31' then return self:reset('unsupported-game-version') end
        local candidate = {version = 1, status = 'ready', gameVersion = version,
            worldToken = frame.worldToken, generation = frame.generation, capturedAt = now, facts = {}}
        for _, spec in ipairs(FACTS) do
            if not same(frame, currentWorld()) then return self:reset('world-changed-during-capture') end
            local ok, number = pcall(readFact, spec[1])
            if not ok or type(number) ~= 'number' or number ~= number or number < 0
                or number > 2147483647 or number % 1 ~= 0 then
                return self:reset('native-fact-unavailable')
            end
            candidate.facts[spec[1]] = number > 0 and {
                status = 'known', value = number, present = true,
                sourceId = 'native-quests-system', evidenceRefs = {spec[2]},
            } or {status = 'unknown', reason = 'zero-or-absent'}
        end
        if not same(frame, currentWorld()) then return self:reset('world-changed-during-capture') end
        if not publish(candidate) then last = nil; return false end
        last = candidate
        return true
    end

    return collector
end

return M
