-- Explains a missing, starting or failed conversation service in game instead
-- of letting a conversation wait silently for its 90-second timeout.
-- Evidence, read only from small files in runtime/ and at most once a second:
--   * the bridge's own heartbeats (knowledge-status.json every 0.5 s and
--     local-voice-state.json every 5 s): fresh means the service is up;
--   * bridge-service.json from the autostart supervisor, its start script or its RED4ext launcher.
-- A "starting" that only the launcher or the start script wrote (source "launcher" or "service") and that nothing has refreshed for
-- STALLED_S seconds is a service that never came up: its process crashed or hung before the supervisor wrote, or it looks at another
-- file system than the game (Mod Organizer 2). It is reported as a failure, with the code and the stage the file names.
-- With no evidence at all in the first seconds after load it stays silent (a bridge started by hand may still be coming up); after that,
-- no trace of this session (no launcher status, no heartbeat) means the service never started, and it is said at once.
-- Nothing here touches native game state.
if type(convaiServiceStatus) == 'table' and convaiServiceStatus.version == 1 then return convaiServiceStatus end
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}
local FRESH_MS = 20000          -- a heartbeat or supervisor status this recent is current
local SESSION_WINDOW_S = 180    -- a launcher failure written this long before load is this session's
local NOTICE_INTERVAL_S = 3
local NEVER_GRACE_S = 15         -- seconds after load before "no trace of this session" counts as a service that never started
local STALLED_S = 90             -- a launcher or start-script "starting" this long without a refresh: the process never came up
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

local function ofThisSession(value)
    return type(value) == 'table' and type(value.updated) == 'number' and value.updated >= (loadedAt - SESSION_WINDOW_S) * 1000.0
end

-- True when this status only says "starting" from the launcher or the start script and was left to go stale: the service that was
-- started never reported (a crash or hang before its supervisor, or a file system that is not the game's).
local function stalled(value, now)
    return type(value) == 'table' and value.state == 'starting' and (value.source == 'launcher' or value.source == 'service')
        and not fresh(value, now) and now * 1000.0 - value.updated >= STALLED_S * 1000.0
end

-- A short plain-ASCII phrase for what the status says about itself: its code, the stage it was in and the reason it gave. The start script
-- writes the reason without paths; this keeps only printable characters and a bounded length, whoever wrote the file.
local function detailOf(value)
    local function plain(text, limit)
        if type(text) ~= 'string' then return nil end
        text = text:gsub('[^\32-\126]', ' '):gsub('%s+', ' '):gsub('^ ', ''):gsub(' $', '')
        if text == '' then return nil end
        return text:sub(1, limit)
    end
    local code = type(value.code) == 'string' and value.code:match('^[%w%-_]+$') and value.code:sub(1, 60) or nil
    local stage = type(value.stage) == 'string' and value.stage:match('^[%w%-_]+$') and value.stage:sub(1, 40) or nil
    local reason = plain(value.reason, 140)
    local text = code or 'no-code'
    if stage and stage ~= 'starting' then text = text .. ' at ' .. stage end
    if reason then text = text .. ': ' .. reason end
    return text
end

local function failureKind(value)
    if value.code == 'missing-key' then return 'setup' end
    -- No Edge, Chrome or other Chromium browser to run the hidden conversation page (bridge/system-browser.mjs).
    if value.code == 'browser-missing' then return 'browser' end
    return 'failed'
end

-- nil when conversations may proceed; otherwise {kind = starting|stopped|setup|browser|failed, detail = the status's own words for a
-- failed kind, code = a stable code for the stalled case}.
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
        if service.state == 'failed' and (current or ofThisSession(service)) then
            local kind = failureKind(service)
            return {kind = kind, detail = kind == 'failed' and detailOf(service) or nil}
        end
        -- The launcher's or the start script's own "starting" with nothing after it: within the time a first start may take the service
        -- is coming up; past it, the process that was started never reported.
        if ofThisSession(service) and (service.source == 'launcher' or service.source == 'service') and service.state == 'starting' then
            if not stalled(service, now) then return {kind = 'starting'} end
            return {kind = 'failed', code = 'service-silent', detail = 'service-silent after ' .. detailOf(service)}
        end
        if current and service.state == 'stopped' then return {kind = 'stopped'} end
    end
    -- No trace of this session at all (the Runtime package is missing, RED4ext did not load its launcher, the launcher was blocked): the
    -- RED4ext launcher starts the service before this script loads, so a working install always has one by now. Say so, instead of
    -- letting a request wait its full 90 seconds (or telling the player to restart the game for a service an earlier session left behind).
    if now - loadedAt >= NEVER_GRACE_S and M.reach(now) == 'never' then return {kind = 'failed'} end
    -- Only stale traces remain: nothing is serving this game now.
    if knowledge or voice or service then return {kind = 'stopped'} end
    return nil
end

-- Whether anything can answer a request now, for a caller that must decide before it waits (the in-game support report):
--   'live'     a heartbeat is fresh, or the supervisor's own fresh status says ready, starting or restarting;
--   'stopped'  the service left traces in this game session (a failure, a stop, a heartbeat gone quiet) but nothing answers now;
--   'never'    no trace of it in this session: no bridge-service.json, an empty or unreadable one, or one from an earlier session.
-- Unlike unavailable(), no evidence at all is a definite answer here. Reads the same cached files; nothing new is opened.
function M.reach(now)
    now = now or os.time()
    local knowledge = cached('runtime/knowledge-status.json', now)
    local voice = cached('runtime/local-voice-state.json', now)
    if fresh(knowledge, now) or fresh(voice, now) then return 'live' end
    local service = supervisor(now)
    if service and fresh(service, now) and (service.state == 'ready' or service.state == 'starting' or service.state == 'restarting') then
        return 'live'
    end
    if ofThisSession(service) or ofThisSession(knowledge) or ofThisSession(voice) then return 'stopped' end
    return 'never'
end

-- The supervisor's or launcher's own status code ('browser-missing', 'install-incomplete', 'launcher-program-missing' ...) while
-- unavailable() says the service failed, for the setup check's line; nil otherwise. Reads the same cached file.
function M.failureCode(now)
    now = now or os.time()
    local down = M.unavailable(now)
    if not down or (down.kind ~= 'failed' and down.kind ~= 'setup' and down.kind ~= 'browser') then return nil end
    if down.code then return down.code end
    local service = supervisor(now)
    local code = service and service.code
    return type(code) == 'string' and code:match('^[%w%-_]+$') and code:sub(1, 60) or nil
end

-- The sentence for a kind of fault. `detail` (a failed kind's own words from detailOf) follows the failed sentence in brackets: it is the
-- service's code, stage and reason, in English. Only places with room pass it (the Settings rows built from the short report's
-- serviceMessage): the notices (notice, blockedMessage, lostSince) are the game's warning line, which holds two lines, and the failed
-- sentence alone fills them (docs/NOTIFICATIONS.md, "How much a notice can say"); its own words are in failureDetail and the short report.
function M.message(kind, detail)
    if kind == 'starting' then return ui.t('The conversation service is starting. Try again in a few seconds.') end
    if kind == 'restarted' then return ui.t('The conversation service restarted. Please try again.') end
    if kind == 'setup' then return ui.t('The conversation service needs your Convai API key. Add it, then restart the game.') end
    if kind == 'browser' then return ui.t('The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, then restart the game.') end
    if kind == 'failed' then
        local text = ui.t('The conversation service could not start. Restart the game, or see Help in Settings.')
        if type(detail) == 'string' and detail ~= '' then text = text .. ' (' .. detail .. ')' end
        return text
    end
    return ui.t('The conversation service is not running. Restart the game to start it again.')
end

-- A localized explanation when a new conversation cannot be served, else nil. A notice: the plain sentence, without the status's words.
function M.blockedMessage(now)
    local state = M.unavailable(now)
    return state and M.message(state.kind), state and state.kind
end

-- The status's own words (code, stage, reason) while the service is reported as failed, for the short report; nil otherwise.
function M.failureDetail(now)
    now = now or os.time()
    local down = M.unavailable(now)
    return down and down.kind == 'failed' and down.detail or nil
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
    if not service or service.since == noticedSince then return nil end
    local failed = service.state == 'failed'
    if not failed and not (stalled(service, now) and ofThisSession(service)) then return nil end
    if failed and not fresh(service, now) and not ofThisSession(service) then return nil end
    -- A live bridge (for example, started by hand) supersedes the failure.
    local down = M.unavailable(now)
    if not down then return nil end
    noticedSince = service.since
    return M.message(down.kind)
end

convaiServiceStatus = M
return M
