-- The world facts and journal inventory a turn carries, published once per revision instead of inside every request
-- (docs/PERFORMANCE_NATIVE_PLAN.md item 1b). A request used to hold ~800 KB of them (643 KB journal, 151 KB facts),
-- so every turn JSON-encoded and wrote that much on the game thread (a 26-81 ms hitch, twice for a voice turn). Now
-- each part (world, active, history) is written to runtime/knowledge-<part>.json only when a turn needs a revision
-- not written yet, and the request names {part, revision}. The bridge (bridge/knowledge-parts.mjs) reads a part the
-- first time a request names it and keeps it. Runs only when a turn is captured; no per-frame work.
local M = {}
local NAMES = {world = true, active = true, history = true}

M.open = io.open
M.encode = function(value) return json.encode(value) end
-- name -> 'revision:generation:worldToken' of the content on disk.
M.written = {}

local function key(part)
    return tostring(part.revision) .. ':' .. tostring(part.generation) .. ':' .. tostring(part.worldToken)
end

-- Writes every part whose revision is not on disk yet. In place: the bridge reads a part only after the request that
-- names it, which is written after this returns, and checks the revision and world binding it finds.
function M.publish(parts)
    for _, part in ipairs(parts or {}) do
        if type(part) ~= 'table' or not NAMES[part.name] or type(part.revision) ~= 'number' or type(part.data) ~= 'table' then
            return false
        end
        local id = key(part)
        if M.written[part.name] ~= id then
            M.written[part.name] = nil
            local ok, raw = pcall(M.encode, {version = 1, part = part.name, revision = part.revision,
                generation = part.generation, worldToken = part.worldToken, data = part.data})
            if not ok or type(raw) ~= 'string' then return false end
            local file = M.open('runtime/knowledge-' .. part.name .. '.json', 'wb')
            if not file then return false end
            local written = file:write(raw)
            local closed = file:close()
            if not written or not closed then return false end
            M.written[part.name] = id
        end
    end
    return true
end

-- A new world or a reload: nothing on disk can be trusted to match the next revision numbers.
function M.reset() M.written = {} end

return M
