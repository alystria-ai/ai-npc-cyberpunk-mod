-- Pure encounter policy. One opening/closing pair owns a ten-minute cooldown.
-- Native objects and conversation playback are owned by the game adapter.
local M = {}
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for key, item in pairs(value) do result[key] = copy(item) end
    return result
end

function M.new()
    local self = {}
    local clock, serial, cooldown, initialized = 0, 0, 0, false
    local current, sample, enabled, lastSpeaker

    function self.reset()
        clock, serial, cooldown, initialized = 0, 0, 0, false
        current, sample, lastSpeaker = nil, nil, nil
    end

    function self.update(observation, delta, now, allow, people)
        clock = clock + math.max(0, math.min(5, tonumber(delta) or 0))
        sample, enabled = observation, allow == true
        if not sample or not sample.available then return end
        local first = not initialized
        initialized = true
        if sample.combat then
            if not current or current.state == 'ended' then
                serial = serial + 1
                current = {id = 'battle-' .. serial, state = 'fighting', started = clock,
                    eligible = not first and enabled and not sample.blocked and now >= cooldown,
                    opponents = {}, seen = {}, witnesses = {}, count = 0, witnessCount = 0}
            end
            current.quiet = nil
            for _, person in ipairs(people or {}) do
                if not sample.blocked and person.profileKey and person.distance <= 20
                    and not current.witnesses[person.profileKey] and current.witnessCount < 8 then
                    current.witnesses[person.profileKey], current.witnessCount = true, current.witnessCount + 1
                end
            end
            for _, npc in ipairs(sample.opponents or {}) do
                if current.count < 12 and type(npc.entity) == 'string' and not current.seen[npc.entity]
                    and type(npc.name) == 'string' and #npc.name <= 240 then
                    current.seen[npc.entity], current.count = true, current.count + 1
                    local key = npc.name .. ':' .. (npc.kind or '')
                    local row = current.opponents[key]
                    if row then row.count = row.count + 1
                    else current.opponents[key] = {name = npc.name, kind = npc.kind, count = 1} end
                end
            end
        elseif current and current.state == 'fighting' then
            current.quiet = current.quiet or clock
            if clock - current.quiet >= 4 then
                current.state, current.ended = 'ended', clock
                if current.eligible then cooldown = now + 600 end
            end
        end
        -- Turning the option on during a battle never replays an old opening.
        if current and not enabled then current.eligible = false end
        if current and current.state == 'ended' and clock - current.ended > 900 then current = nil end
    end

    function self.capture()
        if not sample or not sample.available then return {version = 1, status = 'unavailable'} end
        if not current then return {version = 1, status = 'none'} end
        local opponents, witnesses = {}, {}
        for _, row in pairs(current.opponents) do opponents[#opponents + 1] = copy(row) end
        table.sort(opponents, function(a, b) return a.name .. (a.kind or '') < b.name .. (b.kind or '') end)
        for key in pairs(current.witnesses) do witnesses[#witnesses + 1] = key end
        table.sort(witnesses)
        return {version = 1, status = current.state, encounter = current.id,
            ageSeconds = math.floor(clock - (current.ended or current.started)),
            durationSeconds = math.floor((current.ended or clock) - current.started),
            opponents = opponents, witnesses = witnesses}
    end

    -- Reservation lasts only while this encounter still has a closing slot
    -- and a surviving nearby witness. Recent context lives much longer.
    function self.closingWindow(people)
        if not enabled or not sample or not sample.available or sample.blocked
            or not current or not current.eligible or current.closed or current.state ~= 'ended' then return nil end
        local elapsed = clock - current.ended
        if elapsed > 40 then return nil end
        for _, person in ipairs(people or {}) do
            if current.witnesses[person.profileKey] and person.distance <= 20
                and (person.available ~= false or person.voiceBusy == true) then
                return {encounter = current.id, elapsed = elapsed, remaining = 40 - elapsed}
            end
        end
        return nil
    end

    function self.offer(busy, people, now, holdClosing)
        if busy or not enabled or not sample or not sample.available or sample.blocked or not current or not current.eligible then return nil end
        local phase, remaining
        if current.state == 'fighting' then
            local elapsed = clock - current.started
            if current.opened or current.quiet or elapsed < 2 or elapsed > 12 then return nil end
            phase, remaining = 'start', 12 - elapsed
        else
            local elapsed = clock - current.ended
            if current.closed or holdClosing or elapsed < 4 or elapsed > 40 then return nil end
            phase, remaining = 'end', 40 - elapsed
        end
        local chosen
        for _, person in ipairs(people or {}) do
            if person.available ~= false and current.witnesses[person.profileKey] and person.distance <= 20 then
                if not chosen then chosen = person end
                if person.profileKey ~= lastSpeaker then chosen = person; break end
            end
        end
        if not chosen then return nil end
        return {encounter = current.id, phase = phase, expiresAt = math.floor((now + remaining) * 1000),
            battle = self.capture(), person = chosen}
    end

    function self.claim(event)
        if not current or current.id ~= event.encounter then return false end
        if event.phase == 'start' then current.opened = true else current.closed = true end
        lastSpeaker = event.person.profileKey
        return true
    end

    function self.valid(event, now, playbackAt)
        local playing = event and type(playbackAt) == 'number' and playbackAt * 1000 <= event.expiresAt
            and now >= playbackAt and now - playbackAt <= 30
        if not event then return false, 'event-missing' end
        if not enabled then return false, 'setting-disabled' end
        if not sample or not sample.available then return false, 'observation-unavailable' end
        if sample.blocked then return false, 'scene-blocked' end
        if not current or current.id ~= event.encounter then return false, 'encounter-changed' end
        if not current.eligible then return false, 'encounter-ineligible' end
        if not playing and now * 1000 > event.expiresAt then
            return false, type(playbackAt) == 'number' and now - playbackAt > 30
                and 'playback-window-expired' or 'admission-expired'
        end
        if event.phase == 'start' then
            if current.state ~= 'fighting' then return false, 'opening-after-combat' end
            if current.quiet then return false, 'combat-quiet' end
        elseif current.state ~= 'ended' or sample.combat then return false, 'combat-resumed' end
        return true, 'valid'
    end

    function self.status()
        return {clock = clock, cooldownUntil = cooldown, state = current and current.state or 'none',
            encounter = current and current.id, eligible = current and current.eligible,
            opening = current and current.opened, closing = current and current.closed,
            quiet = current ~= nil and current.quiet ~= nil,
            quietSeconds = current and current.quiet and math.max(0, clock - current.quiet),
            blocked = sample and sample.blocked, reason = sample and sample.reason, enabled = enabled}
    end
    return self
end
return M
