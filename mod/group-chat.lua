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

local function startRound(id, participants, text)
    M.cancel()
    -- Own a snapshot of the audience. Camera changes, party edits and mutable
    -- candidate lists must not redirect a recording to another actor/profile.
    local frozen = {}
    for _, person in ipairs(participants) do
        local row = {}
        for _, key in ipairs({'entity', 'profileKey', 'name', 'bodyType', 'npc'}) do row[key] = person[key] end
        frozen[#frozen + 1] = row
    end
    M.round = {id = id, participants = frozen, text = text, index = 0, stage = 'next', heard = {},
        followUpQuestions = type(M.captureFollowUpQuestions) == 'function' and M.captureFollowUpQuestions() == true,
        journal = M.captureJournal and M.captureJournal(), battle = M.captureBattle and M.captureBattle()}
end

function M.start(id, participants, text)
    startRound(id, participants, text)
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
        profileKey = speaker.profileKey, text = r.text, sentAt = now, journal = r.journal, battle = r.battle,
        followUpQuestions = r.followUpQuestions,
        group = {id = r.id, index = index, total = total, audience = audience, heard = heard}}
    return input
end

function M.startVoice(id, participants, generation, now)
    if type(participants) ~= 'table' or #participants < 2 then return nil end
    startRound(id, participants, nil)
    local r, live = M.round, {}
    for _, person in ipairs(r.participants) do live[person.entity] = true end
    local input = makeInput(r, 1, generation, now, live, false)
    input.text = '[Microphone]'
    r.mode, r.index, r.stage = 'voice', 1, 'recording'
    r.requestId, r.generation, r.entity = input.requestId, input.generation, input.entity
    return input
end

function M.voiceSubmitted(input)
    local r = M.round
    if not r or r.mode ~= 'voice' or r.stage ~= 'recording' or not input
        or input.requestId ~= r.requestId or input.generation ~= r.generation or input.entity ~= r.entity
        or not input.group or input.group.id ~= r.id then return false end
    -- The microphone refreshed these at finish. Later members discuss that same
    -- utterance, with fresh world knowledge attached by the normal send path.
    r.journal, r.battle = input.journal, input.battle
    r.stage = 'waiting'
    return true
end

local function recognizedText(value)
    if type(value) ~= 'string' or #value > 4800 or not value:find('%S') or value == '[Microphone]' then return nil end
    -- LuaJIT has no utf8 library. Count UTF-16 units to match the transport's
    -- 1200-unit limit, rejecting malformed UTF-8 rather than truncating speech.
    local units, index = 0, 1
    while index <= #value do
        local first, count, code = value:byte(index), 1, 0
        if first < 128 then code = first
        elseif first >= 194 and first <= 223 then count, code = 2, first - 192
        elseif first >= 224 and first <= 239 then count, code = 3, first - 224
        elseif first >= 240 and first <= 244 then count, code = 4, first - 240
        else return nil end
        for offset = 1, count - 1 do
            local byte = value:byte(index + offset)
            if not byte or byte < 128 or byte > 191 then return nil end
            code = code * 64 + byte - 128
        end
        if code == 0 or (count == 3 and code < 2048) or (count == 4 and code < 65536)
            or code > 1114111 or (code >= 55296 and code <= 57343) then return nil end
        units = units + (code > 65535 and 2 or 1)
        if units > 1200 then return nil end
        index = index + count
    end
    return value
end

local function sameContext(a, b)
    if a.entity ~= b.entity or a.profileKey ~= b.profileKey or a.text ~= b.text
        or a.followUpQuestions ~= b.followUpQuestions
        or a.group.index ~= b.group.index or a.group.total ~= b.group.total
        or #a.group.audience ~= #b.group.audience or #a.group.heard ~= #b.group.heard then return false end
    for i, key in ipairs(a.group.audience) do if key ~= b.group.audience[i] then return false end end
    for i, utterance in ipairs(a.group.heard) do
        local other = b.group.heard[i]
        if utterance.speaker ~= other.speaker or utterance.text ~= other.text then return false end
    end
    return true
end

local function refreshReply(r)
    if not r.reply or type(M.captureReply) ~= 'function' then return end
    local ok, value = pcall(M.captureReply, r.requestId, r.generation, r.entity)
    if not ok or type(value) ~= 'table' or value.requestId ~= r.requestId
        or value.generation ~= r.generation or value.entity ~= r.entity or value.streamVersion ~= 2
        or type(value.streamId) ~= 'string' or (r.reply.streamId and value.streamId ~= r.reply.streamId)
        or type(value.text) ~= 'string' or #value.text > 12000 or not value.text:find('%S')
        or type(value.textComplete) ~= 'boolean' or type(value.delivered) ~= 'boolean'
        or type(value.failed) ~= 'boolean' or type(value.finished) ~= 'boolean' then return end
    r.reply.streamVersion, r.reply.streamId = 2, value.streamId
    r.reply.text, r.reply.textComplete = value.text, value.textComplete
    r.reply.failed, r.reply.delivered, r.reply.finished = value.failed, value.delivered, value.finished
end

function M.preview(generation, now, live, deliveryFailed)
    local r = M.round
    if not r or r.stage ~= 'playing' or not r.reply then return nil end
    refreshReply(r)
    if deliveryFailed or r.reply.failed or r.reply.textComplete == false then
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
    r.requestId, r.generation, r.entity, r.stage = input.requestId, input.generation, input.entity, 'waiting'
    return input, speaker.npc
end

function M.received(requestId, text, failed, listeners, stream, userText)
    local r = M.round
    if not r or r.requestId ~= requestId or r.stage ~= 'waiting' then return false end
    if r.mode == 'voice' and r.index == 1 then
        local recognized = recognizedText(userText)
        -- The first reply already belongs to the actual microphone utterance.
        -- Without its finalized transcript, never invent a prompt for others.
        if failed or not recognized then M.cancel(); return true end
        r.text = recognized
    end
    r.stage = failed and 'next' or 'playing'
    r.reply = failed and nil or {speaker = r.participants[r.index].name, text = text, listeners = listeners}
    if r.reply and type(stream) == 'table' and stream.version == 2 then
        r.reply.streamVersion, r.reply.streamId, r.reply.textComplete = 2, stream.id, false
        r.reply.delivered = false
    end
    refreshReply(r)
    return true
end

function M.completed(requestId, delivered)
    local r = M.round
    if not r or r.stage ~= 'playing' or r.requestId ~= requestId then return false end
    refreshReply(r)
    if r.reply and r.reply.streamVersion == 2 then
        if r.reply.finished == false then return false end
        delivered = delivered and r.reply.textComplete == true and not r.reply.failed and r.reply.delivered == true
    end
    if delivered and r.reply then r.heard[#r.heard + 1] = r.reply end
    if not delivered then r.prepared = nil; prepareChanged(nil) end
    r.reply, r.stage = nil, 'next'
    return true
end

return M
