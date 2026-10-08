-- Who the talk keys (and the gaze focus) address when several characters are
-- in front of V. targetAtCrosshair in init.lua gathers the candidates (native
-- target parts, the native look-at object, same-car passengers and managed
-- on-foot copies) and measures each one; choose() decides between them.
--
-- A row is {id, npc, angle, distance, looked, party}:
--   angle    degrees between the crosshair and the character's best aim point
--            (torso or Head slot), measured, never the native look-at shortcut
--   distance metres to that point
--   looked   the native look-at object is this character
--   party    a ready party member (companions.owns)
--
-- The rules, in order:
-- 1. An ongoing conversation keeps its partner: the character V talked to in
--    the last stickyWindow seconds stays the target while it is a candidate
--    (within the eight-metre talk range) and roughly in view (stickyAngle).
--    Another character takes over only when V clearly looks at it: within
--    clearAngle of the crosshair and clearMargin degrees closer to it than the
--    partner. An ambient character never takes over from a party partner that
--    is still roughly centred (partyAngle).
-- 2. A party member roughly centred (partyAngle) beats every ambient character,
--    whatever the distances and whatever the native look-at object says (a
--    pedestrian crossing the line of sight becomes the look-at object).
-- 3. Otherwise the original ranking: angle / 32 + distance / 8, with the native
--    look-at object counted as dead centre.
-- describe() renders one probe-log line for a decision.
local M = {version = 1}

M.DEFAULTS = {
    maxAngle = 32.0,     -- the talk cone (degrees); targetAtCrosshair already gates on it
    maxDistance = 8.0,   -- the talk range (metres)
    partyAngle = 15.0,   -- a party member this close to the crosshair is roughly centred
    stickyAngle = 25.0,  -- the current partner stays while it is this roughly in view
    stickyWindow = 120,  -- seconds after the last talk a conversation is still ongoing
    clearAngle = 6.0,    -- re-targeting needs the other character this close to the crosshair ...
    clearMargin = 8.0,   -- ... and this many degrees closer to it than the current partner
}

local function score(row, cfg)
    local angle = row.looked and 0 or row.angle
    return angle / cfg.maxAngle + row.distance / cfg.maxDistance
end

-- Lower is better; ties go to the smaller id so the choice is stable.
local function better(a, b, cfg)
    local sa, sb = score(a, cfg), score(b, cfg)
    if sa ~= sb then return sa < sb end
    return tostring(a.id) < tostring(b.id)
end

local function best(rows, cfg, accept)
    local result
    for _, row in ipairs(rows) do
        if (not accept or accept(row)) and (not result or better(row, result, cfg)) then result = row end
    end
    return result
end

local function closest(rows, accept)
    local result
    for _, row in ipairs(rows) do
        if (not accept or accept(row)) and (not result or row.angle < result.angle) then result = row end
    end
    return result
end

function M.new(options)
    options = options or {}
    local cfg = {}
    for key, value in pairs(M.DEFAULTS) do cfg[key] = options[key] or value end
    local clock = options.clock or os.time
    local T = {config = cfg}
    local partner = nil -- {id, at}

    -- The character V just started talking to (the talk keys, text or voice).
    function T.remember(id)
        if id == nil then return end
        partner = {id = tostring(id), at = clock()}
    end
    function T.forget() partner = nil end
    function T.partner()
        if partner and clock() - partner.at <= cfg.stickyWindow then return partner.id end
        return nil
    end

    -- rows: the measured candidates. Returns the chosen row (or nil) and the reason.
    function T.choose(rows)
        if type(rows) ~= 'table' or #rows == 0 then return nil, 'none' end
        local roughlyCentred = function(row) return row.party and row.angle <= cfg.partyAngle end
        local current = T.partner()
        local sticky
        if current then
            for _, row in ipairs(rows) do
                if row.id == current and row.distance <= cfg.maxDistance and row.angle <= cfg.stickyAngle then
                    sticky = row
                end
            end
        end
        if sticky then
            -- Only a party member may challenge a party partner that is still roughly centred.
            local guarded = roughlyCentred(sticky)
            local challenger = closest(rows, function(row) return row ~= sticky and (row.party or not guarded) end)
            if challenger and challenger.angle <= cfg.clearAngle
                and challenger.angle + cfg.clearMargin <= sticky.angle then
                return challenger, 'retarget'
            end
            return sticky, 'ongoing'
        end
        local party = best(rows, cfg, roughlyCentred)
        if party then return party, 'party-centred' end
        return best(rows, cfg), 'nearest-to-centre'
    end

    -- One probe-log line: the chosen character, the reason and every candidate.
    -- label(row) may name a row (its profile key); it defaults to the id.
    function T.describe(rows, chosen, reason, label)
        local function name(row)
            local text
            if type(label) == 'function' then
                local ok, value = pcall(label, row)
                if ok and value ~= nil then text = tostring(value) end
            end
            return text or tostring(row.id)
        end
        local parts = {}
        for _, row in ipairs(rows or {}) do
            parts[#parts + 1] = string.format('%s/%s a=%.1f d=%.1f%s%s%s', name(row), tostring(row.id),
                row.angle or -1, row.distance or -1, row.party and ' party' or '', row.looked and ' looked' or '',
                row.id == T.partner() and ' partner' or '')
        end
        return 'Talk target: chose=' .. (chosen and (name(chosen) .. '/' .. tostring(chosen.id)) or 'none')
            .. ' reason=' .. tostring(reason) .. ' partner=' .. tostring(T.partner() or 'none')
            .. ' candidates=[' .. table.concat(parts, '; ') .. ']'
    end

    return T
end

return M
