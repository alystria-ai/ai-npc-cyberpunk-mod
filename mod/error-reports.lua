-- Automatic error reports, game side (docs/ERROR_REPORTS.md). The game records what only it can see, in runtime/error-events.json:
--   * a conversation service that never came up (service-silent) or failed (service-status.lua notice(), once per failure),
--   * the first-load setup check's critical problems and the game-side versions (setup-check.lua, once per game session).
-- The service's supervisor reads that file (bridge/error-reports.mjs), turns events into reports and sends them; nothing is sent
-- from the game. Its own Lua errors are found by the supervisor in the mod's logs, so nothing here watches for them.
-- Nothing is recorded while Settings > Privacy > "Send error reports automatically" is off.
-- It also shows the one notice that says error reports are sent: once, at the first load after updating, in gameplay.
--
-- Cost: nothing per frame. A record is one small file read and write, at most ten per game session; tick() is one boolean test
-- once the notice was decided.
if type(convaiErrorReports) == 'table' and convaiErrorReports.version == 1 then return convaiErrorReports end
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}

local FILE = 'runtime/error-events.json'
local MAX_EVENTS = 10                 -- kept in the file, newest last
local MAX_PER_SESSION = 10            -- recorded in one game session
local KEEP_S = 7 * 24 * 3600          -- an event older than a week is dropped from the file
local NOTICE_DELAY_S = 40             -- after the world is ready: after the setup check's own first-load notice
-- 'nsui' is the check of the Companion Manager's host (Mod Configuration Menu or Native Settings UI, setup-check.lua): its code says which one answered.
local GAME_IDS = {'service', 'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'tweakxl', 'audioware', 'nsui'}

local manager
local recorded, count = {}, 0
local gameInfo
local noticeDue, noticeDone = nil, false

-- The settings domain (mod/manager.lua): the setting and the notice's flag. init.lua passes it once.
function M.configure(domain) manager = domain end

local function enabled()
    if type(manager) ~= 'table' or type(manager.errorReports) ~= 'function' then return false end
    local ok, on = pcall(manager.errorReports)
    return ok and on == true
end

-- Printable ASCII only, a bounded length: a code or a version, never a sentence of the player's.
local function plain(text, limit)
    if type(text) ~= 'string' then return nil end
    text = text:gsub('[^\32-\126]', ' '):gsub('%s+', ' '):gsub('^ ', ''):gsub(' $', '')
    if text == '' then return nil end
    return text:sub(1, limit)
end

local function readJson(path)
    local ok, value = pcall(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(65536); file:close()
        if type(raw) ~= 'string' or raw == '' then return nil end
        local decoded, result = pcall(json.decode, raw)
        return decoded and type(result) == 'table' and result or nil
    end)
    return ok and value or nil
end

-- Rewrites the file in place (a file replaced by rename would land in Mod Organizer 2's Overwrite folder): the events of the last week
-- (at most MAX_EVENTS), this session's game facts, and the new event.
local function write(event)
    local ok, written = pcall(function()
        local existing = readJson(FILE)
        local events, cutoff = {}, (os.time() - KEEP_S) * 1000.0
        if type(existing) == 'table' and type(existing.events) == 'table' then
            for _, row in ipairs(existing.events) do
                if type(row) == 'table' and type(row.kind) == 'string' and type(row.code) == 'string' and type(row.at) == 'number'
                    and row.at >= cutoff then events[#events + 1] = row end
            end
        end
        if event then events[#events + 1] = event end
        while #events > MAX_EVENTS do table.remove(events, 1) end
        local game = gameInfo or (type(existing) == 'table' and type(existing.game) == 'table' and existing.game or nil)
        local encoded, payload = pcall(json.encode, {version = 1, updated = os.time() * 1000.0, game = game, events = events})
        if not encoded then return false end
        local file = io.open(FILE, 'wb')
        if not file then return false end
        local done = file:write(payload)
        file:close()
        return done ~= nil
    end)
    return ok and written == true
end

-- One event: kind (service-failed, service-silent, setup-problem), a short code, an optional detail (the status's own code and stage).
-- Once per kind and code per game session. Returns true when it was written.
function M.record(kind, code, detail, frame)
    if type(kind) ~= 'string' or not kind:match('^[a-z][a-z0-9%-]+$') then return false end
    code = plain(code, 120)
    if not code or count >= MAX_PER_SESSION or not enabled() then return false end
    local key = kind .. '|' .. code
    if recorded[key] then return false end
    recorded[key], count = true, count + 1
    return write({kind = kind, code = code, detail = plain(detail, 200), frame = plain(frame, 60), at = os.time() * 1000.0})
end

-- The first-load setup check (setup-check.lua): the game-side versions and check lines for every report of this session, and each
-- critical problem the game itself found as an event. checks: id -> {state, code, version}; problems: ids, most fundamental first.
function M.noteSetup(problems, checks)
    if not enabled() or type(checks) ~= 'table' then return false end
    local info, lines = {}, {}
    local function version(id) local check = checks[id]; return type(check) == 'table' and plain(check.version, 40) or nil end
    info.game, info.cet, info.codeware, info.audioware, info.tweakxl = version('game'), version('cet'), version('codeware'), version('audioware'), version('tweakxl')
    info.scripts = version('files')
    -- The version of Mod Configuration Menu when it is the manager's host (or is there and too old): a report of 0.2.2 said "nsui missing" and nothing showed
    -- which of the two hosts the player had, because this key was never filled and the check was not in the lines below.
    local host = checks.nsui
    info.mcm = type(host) == 'table' and (host.code == 'mcm' or host.code == 'mcm-old') and plain(host.version, 40) or nil
    local redscript = checks.redscript
    info.redscript = type(redscript) == 'table' and plain(redscript.code, 20) or nil
    for _, id in ipairs(GAME_IDS) do
        local check = checks[id]
        if type(check) == 'table' then
            lines[#lines + 1] = id .. ': ' .. (plain(check.state, 20) or '?') .. ' ' .. (plain(check.code, 40) or '?')
                .. (id == 'nsui' and plain(check.version, 40) and (' ' .. plain(check.version, 40)) or '')
        end
    end
    info.setup = lines
    gameInfo = info
    local wrote = false
    for _, id in ipairs(type(problems) == 'table' and problems or {}) do
        local check = checks[id]
        if type(check) == 'table' and check.state == 'problem' then
            wrote = M.record('setup-problem', id .. ' ' .. (plain(check.code, 40) or 'problem'), plain(check.detail, 120), 'game-setup') or wrote
        end
    end
    -- No problem to record: the facts alone, so a later report of this session carries the versions.
    if not wrote then write(nil) end
    return true
end

-- Called from the slow update (mod/manager-ui.lua, hosted by mod/nsui.lua) with whether gameplay is on screen. Returns the one-time notice text once, else nil.
function M.tick(worldReady)
    if noticeDone or not worldReady then return nil end
    local now = os.time()
    if not noticeDue then noticeDue = now + NOTICE_DELAY_S; return nil end
    if now < noticeDue then return nil end
    noticeDone = true
    if type(manager) ~= 'table' or type(manager.errorReportsNoticeDue) ~= 'function' then return nil end
    local ok, due = pcall(manager.errorReportsNoticeDue)
    if not ok or due ~= true then return nil end
    pcall(manager.markErrorReportsNoticed)
    return ui.t('Error reports go to the developer automatically. Turn them off in Settings > Privacy.')
end

-- Tests only.
function M.inspect() return {recorded = recorded, count = count, gameInfo = gameInfo, noticeDue = noticeDue, noticeDone = noticeDone} end
function M.reset() recorded, count, gameInfo, noticeDue, noticeDone = {}, 0, nil, nil, false end

convaiErrorReports = M
return M
