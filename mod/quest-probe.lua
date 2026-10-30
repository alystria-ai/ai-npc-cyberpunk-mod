-- Developer probe for the bond quest primitives (docs/QUEST_PRIMITIVES.md): look at what the quest module holds, capture a place for a pack, and play one
-- event or one scripted line by hand, so a stage can be tried in the game without the story that leads to it.
--
-- Run from mod/johnny-probe.lua (the developer mailbox, Developer mode only) as "johnny-probe:quest:<action>:<stamp>", the report is runtime/johnny-probe.json.
-- Never loaded for a player, adds no hook, timer or write of its own (the one file it writes is the capture file, on request). Actions:
--   status                       what the quest module, the line player and the places hold
--   capture:<placeId>            V's position, the district and a radius guess, merged into runtime/quest-place-capture.json under that id, ready to paste
--                                into a pack's `places`
--   event:<name>                 an event as if the game saw it (every armed quest gets it: its rows fire, its gap can end)
--   line:<pack>:<lineId>         one scripted line of an armed quest now, as a plot line
--   reap                         every ctx, pin, spawn, timer and line is cleaned up now
--   reach                        what Characters text first holds: the timer, the listed items, the caps used, the play file's reach block (mod/quest-reach.lua)
--   gifts                        checks every id of runtime/quest-gift-allowlist.json (the bridge writes {version = 1, ids = [...]}) against the game with TweakDB:GetRecord,
--                                logs a line per missing id and writes runtime/quest-gift-check.json {version = 1, checked, missing = [...], ok = [...]}
local M = {}
M.CAPTURE = 'runtime/quest-place-capture.json'
M.ACTIONS = {status = true, capture = true, event = true, line = true, reap = true, gifts = true, reach = true}
M.ALLOWLIST, M.GIFT_CHECK, M.MAX_GIFT_IDS = 'runtime/quest-gift-allowlist.json', 'runtime/quest-gift-check.json', 400
M.OUTDOOR_RADIUS, M.INDOOR_RADIUS = 25, 8

local function round(value) return math.floor(value * 100 + 0.5) / 100 end

local function readCapture()
    local file = io.open(M.CAPTURE, 'rb')
    if not file then return {version = 1, places = {}} end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    if ok and type(value) == 'table' and type(value.places) == 'table' then return value end
    return {version = 1, places = {}}
end

-- The gift allowlist against the game: every id is looked up once with TweakDB:GetRecord (guarded), nothing is kept. Developer probe only.
local function checkGifts(env)
    local file = io.open(M.ALLOWLIST, 'rb')
    if not file then error('no ' .. M.ALLOWLIST .. ' (the bridge writes it)') end
    local raw = file:read('*a'); file:close()
    local okDecode, value = pcall(json.decode, raw)
    if not okDecode or type(value) ~= 'table' or value.version ~= 1 or type(value.ids) ~= 'table' then error(M.ALLOWLIST .. ' is not {version = 1, ids = [...]}') end
    local report = {version = 1, checked = 0, missing = {}, ok = {}}
    for _, id in ipairs(value.ids) do
        if report.checked >= M.MAX_GIFT_IDS then break end
        if type(id) == 'string' and #id <= 120 and id:match('^[%a][%w_%.]*$') then
            report.checked = report.checked + 1
            local okRecord, record = pcall(function() return TweakDB:GetRecord(id) end)
            if okRecord and record ~= nil then
                report.ok[#report.ok + 1] = id
            else
                report.missing[#report.missing + 1] = id
                local say = env and env.log
                if type(say) == 'function' then pcall(say, 'Quest gifts: the gift record ' .. id .. ' is not in the game') end
            end
        end
    end
    local out = io.open(M.GIFT_CHECK, 'wb')
    if not out then error('the check file cannot be written') end
    out:write(json.encode(report)); out:close()
    return {checked = report.checked, missing = report.missing, okCount = #report.ok, file = M.GIFT_CHECK}
end

function M.run(action, env)
    local verb, rest = tostring(action):match('^(%a+):?(.*)$')
    if not M.ACTIONS[verb or ''] then error('unknown action ' .. tostring(action)) end
    local play = convaiQuestPlay
    if verb == 'gifts' then return checkGifts(env) end
    if verb == 'reach' then
        local block = play and play.reach() or nil
        local ids = {}
        for _, item in ipairs(block and block.items or {}) do ids[#ids + 1] = item.id .. ':' .. item.via end
        return {loaded = convaiReach ~= nil, status = convaiReach and convaiReach.status() or nil,
            block = block and {enabled = block.enabled, items = #block.items, ids = ids, perHour = block.perHour, perDay = block.perDay} or nil}
    end
    if verb == 'status' then
        return {loaded = play ~= nil, status = play and play.status() or nil, world = convaiQuestWorld ~= nil}
    end
    if verb == 'capture' then
        local id = rest:match('^([%w%-_]+)$')
        if not id or #id > 40 then error('a place id of letters, digits, - and _ (capture:<placeId>)') end
        local player = env and env.player
        if not player then error('no player') end
        local at = player:GetWorldPosition()
        local inside = false
        pcall(function() inside = Game.IsEntityInInteriorArea(player) == true end)
        local district = convaiQuestWorld and convaiQuestWorld.district() or nil
        local capture = readCapture()
        local place = {name = id, x = round(at.x), y = round(at.y), z = round(at.z), radius = inside and M.INDOOR_RADIUS or M.OUTDOOR_RADIUS,
            captured = true}
        if type(district) == 'table' then place.district, place.area = district.district, district.area end
        capture.places[id] = place
        local file = io.open(M.CAPTURE, 'wb')
        if not file then error('the capture file cannot be written') end
        file:write(json.encode(capture)); file:close()
        return {captured = id, place = place, interior = inside, file = M.CAPTURE}
    end
    if not play then error('the quest module is not loaded (Character bonds and Story packs on, then a play file)') end
    if verb == 'event' then
        local name = rest:match('^([%w][%w:%-_%.]*)$')
        if not name then error('event:<name>') end
        return {event = name, quests = play.inject(name)}
    end
    if verb == 'line' then
        local pack, lineId = rest:match('^([%w][%w%-_]*):([%w][%w%.:_%-]*)$')
        if not pack then error('line:<pack>:<lineId>') end
        local lines = convaiQuestLines
        if not lines then error('the line player is not loaded') end
        return {pack = pack, line = lineId, queued = lines.playNow(pack, lineId) == true, lines = lines.status()}
    end
    if verb == 'reap' then
        play.reapAll('probe')
        return {reaped = true, status = play.status()}
    end
end

return M
