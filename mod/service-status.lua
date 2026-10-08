-- Explains a missing, starting or failed conversation service in game instead
-- of letting a conversation wait silently for its 90-second timeout.
-- Evidence, read only from small files in runtime/ and at most once a second:
--   * the bridge's own heartbeats (knowledge-status.json every 0.5 s and
--     local-voice-state.json every 5 s): fresh means the service is up;
--   * bridge-service.json from the autostart supervisor or its RED4ext launcher.
-- With no evidence at all (a fresh install, tests) it stays silent, so the
-- previous behaviour is unchanged. Nothing here touches native game state.
if type(convaiServiceStatus) == 'table' and convaiServiceStatus.version == 1 then return convaiServiceStatus end
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}
local FRESH_MS = 20000          -- a heartbeat or supervisor status this recent is current
local SESSION_WINDOW_S = 180    -- a launcher failure written this long before load is this session's
local NOTICE_INTERVAL_S = 3
local loadedAt = os.time()
local cache, lastNoticeCheck, noticedSince = {}, nil, nil

local function readJson(path)
    local ok, value = pcall(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read(262144); file:close()
        if type(raw) ~= 'string' or raw == '' then return nil end
        local decoded, result = pcall(json.decode, raw)
        if decoded and type(result) == 'table' then return result end
        return nil
    end)
    return ok and value or nil
end

local function cached(path, now)
    local entry = cache[path]
    if entry and entry.at == now then return entry.value end
    local value = readJson(path)
    cache[path] = {at = now, value = value}
    return value
end

local function fresh(value, now)
    return type(value) == 'table' and type(value.updated) == 'number' and math.abs(now * 1000.0 - value.updated) <= FRESH_MS
end

local function supervisor(now)
    local value = cached('runtime/bridge-service.json', now)
    if type(value) ~= 'table' or type(value.state) ~= 'string' or type(value.updated) ~= 'number' then return nil end
    return value
end

local function failureKind(value)
    return value.code == 'missing-key' and 'setup' or 'failed'
end

-- nil when conversations may proceed; otherwise {kind = starting|stopped|setup|failed}.
function M.unavailable(now)
    now = now or os.time()
    local knowledge = cached('runtime/knowledge-status.json', now)
    if fresh(knowledge, now) then return nil end
    local voice = cached('runtime/local-voice-state.json', now)
    if fresh(voice, now) then return nil end
    local service = supervisor(now)
    if service then
        local current = fresh(service, now)
        if current and service.state == 'ready' then return nil end
        if current and (service.state == 'starting' or service.state == 'restarting' or service.state == 'stopping') then
            return {kind = 'starting'}
        end
        if service.state == 'failed' and (current or service.updated >= (loadedAt - SESSION_WINDOW_S) * 1000.0) then
            return {kind = failureKind(service)}
        end
        if current and service.state == 'stopped' then return {kind = 'stopped'} end
    end
    -- Only stale traces remain: nothing is serving this game now.
    if knowledge or voice or service then return {kind = 'stopped'} end
    return nil
end

function M.message(kind)
    if kind == 'starting' then return ui.t('The conversation service is starting. Try again in a few seconds.') end
    if kind == 'restarted' then return ui.t('The conversation service restarted. Please try again.') end
    if kind == 'setup' then return ui.t('The conversation service needs your Convai API key. Add it, then restart the game.') end
    if kind == 'failed' then return ui.t('The conversation service could not start. Restart the game, or see Help in Settings.') end
    return ui.t('The conversation service is not running. Restart the game to start it again.')
end

-- A localized explanation when a new conversation cannot be served, else nil.
function M.blockedMessage(now)
    local state = M.unavailable(now)
    return state and M.message(state.kind), state and state.kind
end

-- A localized explanation when the bridge that received a request sent at
-- sentAt (os.time seconds) has since exited, so its reply will never arrive.
-- Only the supervisor's own status is trusted here, never a heartbeat gap.
function M.lostSince(sentAt, now)
    now = now or os.time()
    local service = supervisor(now)
    if not service or type(sentAt) ~= 'number' or type(service.since) ~= 'number' or not fresh(service, now) then return nil end
    local since = service.since / 1000
    if since < sentAt - 1 then return nil end
    if service.state == 'restarting' or service.state == 'stopping' then return M.message('starting') end
    if service.state == 'failed' then return M.message(failureKind(service)) end
    if service.state == 'stopped' then return M.message('stopped') end
    if service.state == 'ready' and type(service.restarts) == 'number' and service.restarts > 0 and since > sentAt + 1 then
        return M.message('restarted')
    end
    return nil
end

-- One proactive notice per failure, so a broken setup is visible before the
-- player tries to talk. Checked at most every few seconds.
function M.notice(now)
    now = now or os.time()
    if lastNoticeCheck and now - lastNoticeCheck < NOTICE_INTERVAL_S then return nil end
    lastNoticeCheck = now
    local service = supervisor(now)
    if not service or service.state ~= 'failed' or service.since == noticedSince then return nil end
    if not fresh(service, now) and service.updated < (loadedAt - SESSION_WINDOW_S) * 1000.0 then return nil end
    -- A live bridge (for example, started by hand) supersedes the failure.
    if not M.unavailable(now) then return nil end
    noticedSince = service.since
    return M.message(failureKind(service))
end

convaiServiceStatus = M
return M
