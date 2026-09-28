-- Pure turn coordinator; the game adapter owns targeting and actual playback.
local M = {}

function M.choose(primary, candidates, supported)
    -- An explicitly addressed person must never silently become somebody else.
    if primary and not supported[primary.profileKey] then return {}, 'unsupported-primary' end
    local selected, seen = {}, {}
    local function add(candidate)
        if candidate and supported[candidate.profileKey] and not seen[candidate.profileKey] and #selected < 3 then
            seen[candidate.profileKey] = true
            selected[#selected + 1] = candidate
        end
    end
    add(primary)
    for _, candidate in ipairs(candidates) do add(candidate) end
    return selected
end

local function prepareChanged(value)
    if M.onPreparation then M.onPreparation(value) end
end

function M.cancel()
    M.round = nil
    prepareChanged(nil)
end

function M.start(id, participants, text)
    M.cancel()
    M.round = {id = id, participants = participants, text = text, index = 0, stage = 'next', heard = {}}
end

local function makeInput(r, index, generation, now, live, includePlaying)
    local speaker = r.participants[index]
    local audience, heard, total = {}, {}, index
    for i, participant in ipairs(r.participants) do
        if live[participant.entity] then
            audience[#audience + 1] = participant.profileKey
            if i > total then total = i end
        end
    end
    local function addHeard(utterance)
        for _, listener in ipairs(utterance.listeners) do
            if listener == speaker.profileKey then
                heard[#heard + 1] = {speaker = utterance.speaker, text = utterance.text}; break
            end
        end
    end
    for _, utterance in ipairs(r.heard) do addHeard(utterance) end
    if includePlaying and r.reply then addHeard(r.reply) end
    local input = {requestId = tostring(now) .. '-' .. tostring(generation) .. '-' .. speaker.entity,
        generation = generation, entity = speaker.entity, name = speaker.name, bodyType = speaker.bodyType,
        profileKey = speaker.profileKey, text = r.text, sentAt = now,
        group = {id = r.id, index = index, total = total, audience = audience, heard = heard}}
    return input
end

local function sameContext(a, b)
    if a.entity ~= b.entity or a.profileKey ~= b.profileKey or a.text ~= b.text
        or a.group.index ~= b.group.index or a.group.total ~= b.group.total
        or #a.group.audience ~= #b.group.audience or #a.group.heard ~= #b.group.heard then return false end
    for i, key in ipairs(a.group.audience) do if key ~= b.group.audience[i] then return false end end
    for i, utterance in ipairs(a.group.heard) do
        local other = b.group.heard[i]
        if utterance.speaker ~= other.speaker or utterance.text ~= other.text then return false end
    end
    return true
end

function M.preview(generation, now, live, deliveryFailed)
    local r = M.round
    if not r or r.stage ~= 'playing' or not r.reply then return nil end
    if deliveryFailed then
        if r.prepared then r.prepared = nil; prepareChanged(nil) end
        return nil
    end
    local index = r.index + 1
    while index <= #r.participants and not live[r.participants[index].entity] do index = index + 1 end
    if index > #r.participants or not live[r.participants[r.index].entity] then
        if r.prepared then r.prepared = nil; prepareChanged(nil) end
        return nil
    end
    local input = makeInput(r, index, generation, now, live, true)
    if r.prepared and sameContext(r.prepared, input) then return r.prepared end
    r.prepared = input
    prepareChanged({sourceRequestId = r.requestId, input = input})
    return input
end

function M.next(generation, now, live)
    local r = M.round
    if not r or r.stage ~= 'next' then return nil end
    repeat r.index = r.index + 1 until r.index > #r.participants or live[r.participants[r.index].entity]
    if r.index > #r.participants then M.cancel(); return nil end
    local speaker = r.participants[r.index]
    local input = makeInput(r, r.index, generation, now, live, false)
    if r.prepared and sameContext(r.prepared, input) then
        input = r.prepared
        input.sentAt = now
    else
        -- The listener set changed or the previous line was not delivered.
        prepareChanged(nil)
    end
    r.prepared = nil
    r.requestId, r.stage = input.requestId, 'waiting'
    return input, speaker.npc
end

function M.received(requestId, text, failed, listeners)
    local r = M.round
    if not r or r.requestId ~= requestId or r.stage ~= 'waiting' then return false end
    r.stage = failed and 'next' or 'playing'
    r.reply = failed and nil or {speaker = r.participants[r.index].name, text = text, listeners = listeners}
    return true
end

function M.completed(requestId, delivered)
    local r = M.round
    if not r or r.stage ~= 'playing' or r.requestId ~= requestId then return false end
    if delivered and r.reply then r.heard[#r.heard + 1] = r.reply end
    if not delivered then r.prepared = nil; prepareChanged(nil) end
    r.reply, r.stage = nil, 'next'
    return true
end

return M
