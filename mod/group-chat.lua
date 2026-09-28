-- Pure turn coordinator; the game adapter owns targeting and actual playback.
local M = {}

function M.choose(primary, candidates, supported)
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

function M.cancel() M.round = nil end

function M.start(id, participants, text)
    M.round = {id = id, participants = participants, text = text, index = 0, stage = 'next', heard = {}}
end

function M.next(generation, now, live)
    local r = M.round
    if not r or r.stage ~= 'next' then return nil end
    repeat r.index = r.index + 1 until r.index > #r.participants or live[r.participants[r.index].entity]
    if r.index > #r.participants then M.cancel(); return nil end
    local speaker = r.participants[r.index]
    local audience, heard, total = {}, {}, r.index
    for i, participant in ipairs(r.participants) do
        if live[participant.entity] then
            audience[#audience + 1] = participant.profileKey
            if i > total then total = i end
        end
    end
    for _, utterance in ipairs(r.heard) do
        for _, listener in ipairs(utterance.listeners) do
            if listener == speaker.profileKey then
                heard[#heard + 1] = {speaker = utterance.speaker, text = utterance.text}; break
            end
        end
    end
    local input = {requestId = tostring(now) .. '-' .. tostring(generation) .. '-' .. speaker.entity,
        generation = generation, entity = speaker.entity, name = speaker.name, bodyType = speaker.bodyType,
        profileKey = speaker.profileKey, text = r.text, sentAt = now,
        group = {id = r.id, index = r.index, total = total, audience = audience, heard = heard}}
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
    r.reply, r.stage = nil, 'next'
    return true
end

return M
