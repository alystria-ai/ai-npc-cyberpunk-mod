-- Witness receipts (docs/QUEST_DECISIONS.md section 4.3, step C2). OFF unless options.enabled() is true (settings.witnessReceipts, default false).
-- When the world-knowledge scan sees a quest fact or journal entry change (an "edge", mod/world-knowledge.lua onEdges), this keeps which of V's
-- spawned companions stood within 15 m at that moment, and writes runtime/witness-receipts.json. The bridge lets such a companion hear a
-- rule whose perspective is `witnessed`, which it could not before (bridge/witness-receipts.mjs). The receipt is approximate (the scan runs
-- up to about 30 s after the moment); a world change or a CET reload starts empty, so the character falls back to its declared audience.
-- Runs once per scan that found a new edge, never per frame. No fact names are logged.
local M = {}
M.MAX_ROWS, M.MAX_NEAR, M.NEAR_RADIUS, M.PATH = 256, 6, 15, 'runtime/witness-receipts.json'
local MAX_LOGGED = 3

local Instance = {}
Instance.__index = Instance

-- options: enabled() -> boolean; worldToken() -> string; gameTime() -> game seconds or nil; near(radius) -> {profileKey};
-- write(path, raw) (optional, default io.open 'wb'); log(text) (optional, the first sightings go to probe.log).
function M.new(options)
    return setmetatable({options = options or {}, counts = {recorded = 0, skipped = {}}, logged = 0, loggedSkips = {}}, Instance)
end

local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, value = pcall(fn, ...)
    if ok then return value end
    return nil
end

function Instance:on()
    local enabled = self.options.enabled
    if type(enabled) ~= 'function' then return false end
    local ok, value = pcall(enabled)
    return ok and value == true
end

function Instance:say(text)
    local log = self.options.log
    if type(log) == 'function' then pcall(log, text) end
end

function Instance:skip(reason)
    self.counts.skipped[reason] = (self.counts.skipped[reason] or 0) + 1
    if not self.loggedSkips[reason] then
        self.loggedSkips[reason] = true
        self:say('Witness receipts: not recorded (' .. reason .. ')')
    end
    return false
end

-- The same rules as the bridge's parser (bridge/witness-receipts.mjs), which rejects the whole file for one bad row.
local function key(value)
    return type(value) == 'string' and #value > 0 and #value <= 80 and value:match('^[a-z0-9%-]+$') ~= nil
        and value:sub(1, 9) ~= 'resident-'
end
local function identifier(value)
    return type(value) == 'string' and #value > 0 and #value <= 160
        and value:match('^[A-Za-z0-9_:%-][A-Za-z0-9_.:/@+#%-]*$') ~= nil
        and value ~= '__proto__' and value ~= 'constructor' and value ~= 'prototype'
end

-- Who stood beside V: the keys the options.near(15) returned, de-duplicated, at most MAX_NEAR (nil when the lookup failed). An empty list
-- is a real answer ("nobody").
function Instance:nearby()
    local keys, seen = {}, {}
    local list = call(self.options.near, M.NEAR_RADIUS)
    if type(list) ~= 'table' then return nil end -- the lookup failed: no receipt, rather than a false "nobody was near"
    for _, value in ipairs(list) do
        if key(value) and not seen[value] then
            seen[value] = true
            keys[#keys + 1] = value
            if #keys >= M.MAX_NEAR then break end
        end
    end
    return keys
end

-- edges: {{type = 'fact'|'journal', key = string, value = ...}}. Returns true when the file was written.
function Instance:record(edges)
    if not self:on() then return false end
    if type(edges) ~= 'table' or #edges == 0 then return false end
    local token, seconds = call(self.options.worldToken), call(self.options.gameTime)
    if type(token) ~= 'string' or token == '' or type(seconds) ~= 'number' or seconds ~= seconds or seconds < 0 then
        return self:skip('unbound')
    end
    seconds = math.floor(seconds)
    local state = self.state
    if not state or state.worldToken ~= token then state = {worldToken = token, rows = {}}; self.state = state end
    local near = self:nearby()
    if not near then return self:skip('near-unavailable') end
    -- One new row per edge (the last one wins when an edge repeats); it replaces any older row for the same type and key.
    local fresh, replaced = {}, {}
    for _, edge in ipairs(edges) do
        if type(edge) == 'table' and (edge.type == 'fact' or edge.type == 'journal') and identifier(edge.key) then
            local row = {type = edge.type, key = edge.key, t = seconds}
            if #near > 0 then row.near = near end
            local id = row.type .. ':' .. row.key
            if replaced[id] then fresh[replaced[id]] = false end
            fresh[#fresh + 1] = row
            replaced[id] = #fresh
        end
    end
    -- A row stamped later than the game clock came from a save that has since been replaced: forget it.
    local rows = {}
    for _, row in ipairs(state.rows) do
        if row.t <= seconds and not replaced[row.type .. ':' .. row.key] then rows[#rows + 1] = row end
    end
    for _, row in ipairs(fresh) do
        if row then rows[#rows + 1] = row end
    end
    while #rows > M.MAX_ROWS do table.remove(rows, 1) end
    state.rows = rows
    local ok, raw = pcall(function() return json.encode({version = 1, worldToken = token, gameTimeSeconds = seconds, edges = rows}) end)
    if not ok or type(raw) ~= 'string' then return self:skip('encode-failed') end
    local written
    local write = self.options.write
    if type(write) == 'function' then
        local okWrite, result = pcall(write, M.PATH, raw)
        written = okWrite and result ~= false
    else
        local okOpen, file = pcall(io.open, M.PATH, 'wb')
        written = false
        if okOpen and file then
            local okFile = pcall(function() file:write(raw) end)
            pcall(function() file:close() end)
            written = okFile
        end
    end
    if not written then return self:skip('write-failed') end
    self.counts.recorded = self.counts.recorded + 1
    if self.logged < MAX_LOGGED then
        self.logged = self.logged + 1
        self:say(string.format('Witness receipts: recorded #%d (edges=%d near=%d)', self.counts.recorded, #edges, #near))
    end
    return true
end

function Instance:status()
    local skipped = {}
    for reason, count in pairs(self.counts.skipped) do skipped[reason] = count end
    return {enabled = self:on(), recorded = self.counts.recorded, skipped = skipped, rows = self.state and #self.state.rows or 0}
end

return M
