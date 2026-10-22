-- Help page support: where the logs are, and a one-click report the player can
-- send to the developer.
--
-- Lua is sandboxed to this mod's folder, so the full report is built by the
-- conversation service (bridge/support-report.mjs), which can read the CET,
-- redscript and RED4ext logs. This module writes runtime/report-request.json,
-- waits for runtime/report-result.json, and shows the path it names. When no
-- service is answering (it never started, it stopped, or its status file is
-- missing, empty or stale) it writes a shorter text report at once, from the
-- files the game can read, and says so; a service that is up but silent gets
-- a few seconds first. That short report is
-- one fixed file, runtime/convai-report-lua.txt, shipped empty and rewritten in
-- place: a file with a new name would land in Mod Organizer 2's Overwrite folder.
--
-- Nothing here touches native game state. Call update() from the top-level CET
-- update only. Privacy: the same rules as the service. Only the files named
-- below are opened; every line goes through the redactor first.
local M = {version = 1}

local REQUEST, RESULT, PATHS = 'runtime/report-request.json', 'runtime/report-result.json', 'runtime/support-paths.json'
local MAX_LINES, MAX_BYTES, LINE_LIMIT = 2000, 1048576, 1000
local LOCAL_NAME = 'convai-report-lua.txt'
local FIRST_WAIT, BUILD_WAIT = 6, 30 -- seconds to wait for the service, before and after it reports "building"
-- Where the data and the zip reports are when the service has not published its folders (Lua cannot expand the variable).
local DATA_FALLBACK, REPORTS_FALLBACK = '%LOCALAPPDATA%\\AiNpcCyberpunkMod\\data', '%LOCALAPPDATA%\\AiNpcCyberpunkMod\\reports'

------------------------------------------------------------------ redaction

local KEYWORDS = {'authorization', 'convai-key', 'convai_key', 'api-key', 'api_key', 'apikey', 'x-api-key',
    'access-token', 'access_token', 'auth-token', 'auth_token', 'refresh-token', 'refresh_token', 'id-token',
    'id_token', 'token', 'secret', 'passwd', 'password', 'private-key', 'private_key', 'cookie', 'session-key',
    'session_key'}
local FILE_EXTENSIONS = {onnx = true, json = true, wav = true, mp3 = true, ogg = true, flac = true, wem = true, opus = true, mjs = true, js = true, cjs = true, ts = true, lua = true, txt = true, log = true, md = true, csv = true, gguf = true, bin = true, pt = true, pth = true, safetensors = true, yaml = true, yml = true, toml = true, ini = true, cfg = true, zip = true, dll = true, exe = true, pdb = true, so = true, archive = true, reds = true, xml = true, html = true, css = true, py = true, bat = true, ps1 = true, png = true, jpg = true, jpeg = true, webp = true, bmp = true, tga = true, dds = true, mp4 = true, webm = true, gz = true, tar = true, ['7z'] = true, bak = true, tmp = true}
local QUERY_NAMES = {'key', 'token', 'api_key', 'apikey', 'access_token', 'auth', 'signature', 'sig', 'pass', 'passwd', 'password', 'pwd', 'code',
    'secret', 'client_secret', 'refresh_token'}
local KEY_PREFIXES = {'hf', 'ghp', 'gho', 'ghs', 'ghu', 'sk', 'pk', 'xoxa', 'xoxb', 'xoxp', 'xoxr', 'AKIA', 'AIza', 'ya29'}
local SENSITIVE_NAME = {'key', 'token', 'secret', 'passw', 'credential', 'authorization', 'bearer', 'cookie', 'signature'}
local ID_NAME = {'enduserid', 'userid', 'sessionid', 'characterid', 'connectionid', 'roomid', 'participantid', 'ownerid',
    'end_user_id', 'user_id', 'session_id', 'character_id'}

local function hash8(value)
    -- Short, stable and not reversible for random IDs. Two 16-bit halves keep
    -- every intermediate value small, so the result is exact in any Lua number
    -- representation (doubles in the game, 32-bit integers in the test harness).
    local a, b = 5381, 52711
    for index = 1, #value do
        local byte = value:byte(index)
        a = (a * 31 + byte) % 65521
        b = (b * 37 + byte) % 65519
    end
    return string.format('%04x%04x', a, b)
end

local function maskKeyword(line, lower, keyword)
    local out, position = {}, 1
    while true do
        local first, last = lower:find(keyword, position, true)
        if not first then break end
        local prefix, valueStart = line:match('^(["\']?%s*[:=]%s*["\']?)()', last + 1)
        if prefix then
            local pattern = keyword == 'authorization' and '^[^\r\n"\',;}]*' or '^[^%s"\',;}&]+'
            local _, valueEnd = line:find(pattern, valueStart)
            out[#out + 1] = line:sub(position, valueStart - 1)
            if valueEnd and valueEnd >= valueStart then
                out[#out + 1] = '[redacted]'; position = valueEnd + 1
            else position = valueStart end
        else
            out[#out + 1] = line:sub(position, last); position = last + 1
        end
    end
    out[#out + 1] = line:sub(position)
    return table.concat(out)
end

local function isUuid(run)
    return #run == 36 and run:match('^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
end

function M.redactLine(line, secrets)
    line = tostring(line)
    for _, secret in ipairs(secrets or {}) do
        if type(secret) == 'string' and #secret >= 6 then
            local at = 1
            while true do
                local first, last = line:find(secret, at, true)
                if not first then break end
                line = line:sub(1, first - 1) .. '[secret-redacted]' .. line:sub(last + 1)
                at = first + #'[secret-redacted]'
            end
        end
    end
    for _, keyword in ipairs(KEYWORDS) do
        local lower = line:lower()
        if lower:find(keyword, 1, true) then line = maskKeyword(line, lower, keyword) end
    end
    line = line:gsub('[Bb][Ee][Aa][Rr][Ee][Rr]%s+([%w%._~%+/=%-]+)', function(token)
        if #token >= 8 then return 'Bearer [redacted]' end
    end)
    -- Well-known key prefixes (the same list as the service), 12+ characters after it.
    for _, prefix in ipairs(KEY_PREFIXES) do
        local out, position = {}, 1
        while true do
            local first, last = line:find(prefix, position, true)
            if not first then break end
            local before = first > 1 and line:sub(first - 1, first - 1) or ''
            local _, tailEnd = line:find('^[%w_%-%.]+', last + 1)
            if not before:match('[%w]') and tailEnd and tailEnd - last >= 12 then
                out[#out + 1] = line:sub(position, first - 1) .. '[token-redacted]'
                position = tailEnd + 1
            else
                out[#out + 1] = line:sub(position, last); position = last + 1
            end
        end
        out[#out + 1] = line:sub(position)
        line = table.concat(out)
    end
    -- Address parameters that carry a secret (the service's rule): ?code=..., &pass=..., ...
    for _, name in ipairs(QUERY_NAMES) do
        line = line:gsub('([?&]' .. name .. '=)[^&%s"\']+', '%1[redacted]')
    end
    -- user:password@host in an address, and email addresses (the service's rules, bridge/support-report.mjs).
    line = line:gsub('(%a[%w%+%.%-]*://)[^%s/%?#@"\'<>\\]+@', '%1[redacted]@')
    -- A file name such as kokoro@v1.0.onnx ends in a file extension, not a domain: left alone.
    line = line:gsub('[%w%._%%%+%-]+@[%w%-]+[%w%.%-]*%.%a%a+', function(match)
        if FILE_EXTENSIONS[match:match('%.(%a+)$'):lower()] then return nil end
        return '[email-redacted]'
    end)
    line = line:gsub('[%w%+_=%-]+', function(run)
        if isUuid(run) then return '[id:' .. hash8(run:lower()) .. ']' end
        if #run >= 32 and run:match('^%x+$') then return '[hex-redacted]' end
        -- 40 and more with a digit and a letter, like the service; and a Mistral key: exactly 32 letters and digits (no - or _, so a 32-character
        -- name with hyphens such as a model name stays readable), with a digit and a letter or both cases.
        if #run >= 40 and run:find('%d') and run:find('%a') then return '[token-redacted]' end
        if #run == 32 and run:match('^%w+$') and ((run:find('%d') and run:find('%a')) or (run:find('%l') and run:find('%u'))) then return '[token-redacted]' end
    end)
    -- A name with spaces ("John Smith") is taken whole up to the next separator (at most 64 characters); with no separator after it, only its first word.
    line = line:gsub('(%a:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+)([^\\/"\'<>|:*?,;=%+%[%]]+)([\\/])', function(prefix, name, separator)
        if #name <= 64 then return prefix .. '<user>' .. separator end
    end)
    line = line:gsub('(%a:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+)[^\\/%s"\'<>|:*?]+', '%1<user>')
    return line
end

local function nameMatches(name, list)
    local lower = tostring(name):lower()
    for _, part in ipairs(list) do if lower:find(part, 1, true) then return true end end
    return false
end

-- Text view of a decoded JSON value. Secret-looking names and provider IDs
-- never print their value; long arrays are summarised.
local function render(value, name, depth, out, indent)
    indent = indent or ''
    if depth > 4 then out[#out + 1] = indent .. tostring(name) .. ': ...'; return end
    if type(value) == 'table' then
        local count = 0
        for _ in pairs(value) do count = count + 1 end
        if #value > 0 and count == #value then
            if #value > 12 then out[#out + 1] = indent .. tostring(name) .. ': ' .. #value .. ' items'; return end
            out[#out + 1] = indent .. tostring(name) .. ':'
            for index, item in ipairs(value) do render(item, '[' .. index .. ']', depth + 1, out, indent .. '  ') end
        else
            out[#out + 1] = indent .. tostring(name) .. ':'
            local keys = {}
            for key in pairs(value) do keys[#keys + 1] = {text = tostring(key), key = key} end
            table.sort(keys, function(a, b) return a.text < b.text end)
            for index, entry in ipairs(keys) do
                if index > 60 then out[#out + 1] = indent .. '  ...'; break end
                render(value[entry.key], entry.text, depth + 1, out, indent .. '  ')
            end
        end
        return
    end
    local text = tostring(value)
    if type(value) == 'string' and value ~= '' then
        if nameMatches(name, ID_NAME) then text = '[id:' .. hash8(value) .. ']'
        elseif nameMatches(name, SENSITIVE_NAME) then text = '[redacted]'
        else text = M.redactLine(text) end
    end
    out[#out + 1] = indent .. tostring(name) .. ': ' .. text:sub(1, 300)
end

------------------------------------------------------------------- file I/O

local function readSmall(path)
    local ok, raw = pcall(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local text = file:read(262144); file:close()
        return text
    end)
    return ok and type(raw) == 'string' and raw ~= '' and raw or nil
end

local function readJson(path)
    local raw = readSmall(path)
    if not raw then return nil end
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

-- Last lines of a file, bounded by bytes and lines. nil when it cannot be read.
local function tail(path)
    local ok, result = pcall(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local size = file:seek('end') or 0
        local start = math.max(0, size - MAX_BYTES)
        file:seek('set', start)
        local data = file:read('*a') or ''
        file:close()
        local lines = {}
        for line in (data .. '\n'):gmatch('(.-)\r?\n') do lines[#lines + 1] = line end
        if start > 0 and #lines > 1 then table.remove(lines, 1) end
        while #lines > 0 and lines[#lines] == '' do lines[#lines] = nil end
        local omitted = #lines > MAX_LINES or start > 0
        if #lines > MAX_LINES then
            local kept = {}
            for index = #lines - MAX_LINES + 1, #lines do kept[#kept + 1] = lines[index] end
            lines = kept
        end
        for index, line in ipairs(lines) do
            if #line > LINE_LIMIT then lines[index] = line:sub(1, LINE_LIMIT) .. ' [truncated]' end
        end
        return {lines = lines, omitted = omitted, size = size}
    end)
    return ok and result or nil
end

local function listNames(folder)
    local names = {}
    if type(dir) ~= 'function' then return names end
    local ok, entries = pcall(dir, folder)
    if ok and type(entries) == 'table' then
        for _, entry in ipairs(entries) do
            if type(entry) == 'table' and type(entry.name) == 'string' and entry.type ~= 'directory' then
                names[#names + 1] = entry.name
            end
        end
    end
    return names
end

-- Names of files that may hold what the player or a character said. Never read.
local CONTENT_WORDS = {'chat', 'transcript', 'convers', 'history', 'dialog', 'message', 'input', 'reply', 'prompt',
    'journal', 'speech', 'audio', 'voice', 'mic', 'memory', 'subtitle'}
local function contentLike(name)
    local lower = tostring(name):lower()
    for _, word in ipairs(CONTENT_WORDS) do if lower:find(word, 1, true) then return true end end
    return false
end

local function baseName(path) return tostring(path):match('([^\\/]*)$') end
local function dirName(path) return tostring(path):match('^(.*)[\\/][^\\/]*$') end

-- A long path with no spaces overflows banners, popups and description panels.
-- Show its last two folders and break before the file name, so each line is
-- short: "…\runtime\reports\" then "convai-report-<time>.zip".
function M.displayPath(path)
    local text = tostring(path or '')
    local file, folder = baseName(text), dirName(text)
    if file == '' or not folder then return text end
    local parts = {}
    for part in folder:gmatch('[^\\/]+') do parts[#parts + 1] = part end
    local kept = {}
    for index = math.max(1, #parts - 1), #parts do kept[#kept + 1] = parts[index] end
    if #kept == 0 then return file end
    return '…\\' .. table.concat(kept, '\\') .. '\\\n' .. file
end

-- The whole path, for a player who has to find the file by hand (Copy report path cannot work without the service). Broken
-- after a folder separator so that no line is wider than WRAP characters, with the file name last, on a line of its own.
local WRAP = 44
function M.fullPath(path)
    local text = tostring(path or '')
    local file, folder = baseName(text), dirName(text)
    if file == '' or not folder then return text end
    local lines, line = {}, ''
    for part in (folder .. '\\'):gmatch('[^\\/]*[\\/]?') do
        if part ~= '' then
            if line ~= '' and #line + #part > WRAP then lines[#lines + 1] = line; line = '' end
            line = line .. part
        end
    end
    if line ~= '' then lines[#lines + 1] = line end
    lines[#lines + 1] = file
    return table.concat(lines, '\n')
end

------------------------------------------------------------------ instance

function M.new(options)
    options = options or {}
    local ui = options.ui or convaiUiLocale or dofile('ui-locale.lua')
    local self = {}
    local state = {phase = 'idle'} -- idle | working | ready | failed
    local counter, lastPoll = 0, -1
    local notice, pendingCopy
    local function hasGameClipboard() return type(ImGui) == 'table' and type(ImGui.SetClipboardText) == 'function' end

    local function now() return os.time() end

    local function serviceStatus()
        local ok, status = pcall(function() return convaiServiceStatus or dofile('service-status.lua') end)
        return ok and type(status) == 'table' and status or nil
    end

    local function heartbeatFresh()
        local stamp = now() * 1000.0
        for _, name in ipairs({'runtime/knowledge-status.json', 'runtime/local-voice-state.json'}) do
            local value = readJson(name)
            if value and type(value.updated) == 'number' and math.abs(stamp - value.updated) <= 20000 then return true end
        end
        return false
    end

    -- 'running' | 'starting' | 'stopped' | 'unknown'
    function self.serviceState()
        if heartbeatFresh() then return 'running' end
        local status = serviceStatus()
        local ok, down = false, nil
        if status then ok, down = pcall(status.unavailable, now()) end
        if ok and type(down) == 'table' then return down.kind == 'starting' and 'starting' or 'stopped' end
        return 'unknown'
    end

    -- 'live' | 'stopped' | 'never': can anything answer a request now? Unlike serviceState() this is never 'unknown': no status
    -- file, an empty or unreadable one, a stale one and no fresh heartbeat all mean nothing is answering ('never' when the service
    -- left no trace in this game session). Only a fresh heartbeat or a fresh ready/starting status from the supervisor is 'live'.
    function self.serviceReach()
        local status = serviceStatus()
        if status and type(status.reach) == 'function' then
            local ok, value = pcall(status.reach, now())
            if ok and (value == 'live' or value == 'stopped' or value == 'never') then return value end
        end
        return heartbeatFresh() and 'live' or 'never'
    end

    -- The kind of fault the service status names ('browser', 'setup', 'failed', ...), or nil; only meaningful while nothing is serving.
    local function serviceDown()
        if heartbeatFresh() then return nil end
        local status = serviceStatus()
        local ok, down = false, nil
        if status then ok, down = pcall(status.unavailable, now()) end
        if ok and type(down) == 'table' then return down end
        return nil
    end

    function self.serviceFault()
        local down = serviceDown()
        return down and down.kind or nil
    end

    -- The localized sentence for what is wrong with the service now (the one the notices use), or nil while it is running. A failed
    -- service's own code, stage and reason follow it in brackets.
    function self.serviceMessage()
        local down, status = serviceDown(), serviceStatus()
        if not down or not status or type(status.message) ~= 'function' then return nil end
        local ok, text = pcall(status.message, down.kind, down.detail)
        return ok and type(text) == 'string' and text or nil
    end

    -- The status codes the start script, the launcher or a silent start leave: the service's process was started and did not come up.
    -- These get a PROBLEM line in the short report; a bridge that crashed later has its own logs and keeps the ordinary report.
    local START_PROBLEMS = {['service-silent'] = true, ['install-incomplete'] = true, ['service-error'] = true,
        ['game-folder-not-visible'] = true, ['supervisor-error'] = true, ['launcher-failed'] = true,
        ['launcher-program-missing'] = true, ['launcher-directory-missing'] = true, ['launcher-not-configured'] = true}
    function self.startProblem()
        local down, status = serviceDown(), serviceStatus()
        if not down or down.kind ~= 'failed' or not status then return nil end
        local okCode, code = pcall(status.failureCode, now())
        if not okCode or not START_PROBLEMS[code] then return nil end
        return down.detail or code
    end

    function self.serviceLabel()
        local code = self.serviceState()
        if code ~= 'running' and self.serviceFault() == 'browser' then return ui.t('Needs a browser') end
        if code == 'running' then return ui.t('Running') end
        if code == 'starting' then return ui.t('Starting') end
        if code == 'stopped' then return ui.t('Not running') end
        return ui.t('Unknown')
    end

    ---------------------------------------------------------- where logs are
    local RELATIVE_MOD = 'bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\AiNpcCyberpunkMod'
    -- Rows: id, English label key handled by the caller; this returns paths only.
    function self.locations()
        local published = readJson(PATHS)
        local logs = published and type(published.logs) == 'table' and published.logs or {}
        local service = readJson('runtime/bridge-service.json')
        local game = (published and published.gameRoot) or (service and service.gameRoot)
        local stateDirectory = (published and published.stateDirectory) or (service and service.stateDirectory)
        local pick = function(id) return type(logs[id]) == 'table' and type(logs[id].path) == 'string' and logs[id].path or nil end
        local placeholder = ui.t('the game folder')
        local function underGame(relative) return (game or placeholder) .. '\\' .. relative end
        local known = game ~= nil or published ~= nil
        local result = {known = known}
        local mod = pick('probe') and dirName(pick('probe')) or (published and published.runtime)
            or underGame(RELATIVE_MOD .. '\\runtime')
        result.mod = mod
        result.reports = (published and published.reports) or REPORTS_FALLBACK
        local bridge = pick('bridge-stderr') and dirName(pick('bridge-stderr')) or stateDirectory
        result.bridge = bridge or DATA_FALLBACK
        result.launcher = pick('launcher') or underGame('red4ext\\plugins\\AiNpcCyberpunkMod\\launcher.log')
        result.cet = pick('cet') and dirName(pick('cet')) or underGame('bin\\x64\\plugins\\cyber_engine_tweaks')
        result.redscript = pick('redscript') or underGame('r6\\logs\\redscript_rCURRENT.log')
        result.red4ext = pick('red4ext') and dirName(pick('red4ext')) or underGame('red4ext\\logs')
        return result
    end

    -------------------------------------------------------- status for UI
    function self.status()
        return {phase = state.phase, mode = state.mode, path = state.path, fileName = state.fileName,
            reason = state.reason, failure = state.failure}
    end

    function self.signature()
        return table.concat({state.phase, state.mode or '', state.fileName or '', state.reason or '', state.failure or ''}, '|')
    end

    -- The path as shown in the menu and in popups: short, with a soft break.
    function self.displayPath(path) return M.displayPath(path or state.path) end

    -- Copying is always offered once a report exists. The service copies the
    -- path (see copyPath), so the game's own clipboard is only a second route.
    function self.canCopy() return state.path ~= nil end

    -- The line shown in the action banner for the current state.
    function self.banner()
        if state.phase == 'working' then return ui.t('Creating the report…') end
        if state.phase == 'failed' then
            return ui.t('The report could not be created. Check that the mod folder can be written to, then try again.')
        end
        if state.phase == 'ready' then
            if state.mode == 'lua' and state.reason == 'no-response' then
                return ui.t('Short report saved because the conversation service did not answer: {path}', {path = M.displayPath(state.path)})
            end
            if state.mode == 'lua' and state.reason == 'failed' then
                return ui.t('Short report saved because the conversation service could not build the full report: {path}', {path = M.displayPath(state.path)})
            end
            if state.mode == 'lua' then
                return ui.t('Short report saved because the conversation service is not running: {path}', {path = M.displayPath(state.path)})
            end
            return ui.t('Report saved: {path}', {path = M.displayPath(state.path)})
        end
        return nil
    end

    -- The popup naming the saved file is for Developer mode only. The report
    -- is always announced in the menu banner and on the Last report row.
    function self.takeNotice(worldReady)
        if not notice or not worldReady then return nil end
        local text = notice; notice = nil
        if not (options.developerMode and options.developerMode() == true) then return nil end
        return text
    end

    ------------------------------------------------------------ finishing
    local function finish(result)
        state = result
        if result.phase == 'ready' then
            notice = ui.t('Support report saved: {path}', {path = M.displayPath(result.path)})
        end
    end

    ----------------------------------------------------------- local report
    local function section(out, title) out[#out + 1] = ''; out[#out + 1] = '== ' .. title .. ' ==' end

    local function sanitizeParty()
        local rows = {}
        local ok, party = pcall(options.party or function() return {} end)
        if not ok or type(party) ~= 'table' then return rows end
        for index, member in ipairs(party) do
            if index > 12 then break end
            if type(member) == 'table' then
                rows[#rows + 1] = {profile = tostring(member.profileKey or member.key or ''):sub(1, 80),
                    name = tostring(member.name or ''):sub(1, 80), state = tostring(member.state or ''):sub(1, 40),
                    error = member.error and M.redactLine(tostring(member.error):sub(1, 160)) or nil}
            end
        end
        return rows
    end

    local function buildLocal(reason)
        local stamp = os.date('%Y%m%d-%H%M%S')
        local out = {'AI NPC Cyberpunk Mod support report (short report, made inside the game)',
            'Created: ' .. os.date('%Y-%m-%d %H:%M:%S') .. '   id ' .. stamp,
            'Why it is short: ' .. (reason == 'no-response' and 'the conversation service did not answer the request'
                or reason == 'failed' and 'the conversation service could not build the full report'
                or reason == 'service-never-started' and 'the conversation service never started in this game session'
                or 'the conversation service was not running'),
            'Not included: CET, redscript, RED4ext, launcher and conversation-service logs (outside the mod folder).',
            'Keys, tokens, IDs, audio and conversation text are never included; the paths for the other logs are in the Help page.'}
        -- The commonest reason the service never started: say it first, in plain words (the code is bridge-service.json's).
        if self.serviceFault() == 'browser' then
            table.insert(out, 2, 'PROBLEM: no browser for the conversation page (service status code browser-missing). a Chromium browser such as '
                .. 'Microsoft Edge, Google Chrome, Brave or Opera must be installed, or its path written in browser.txt next to launcher.ini, then restart the game.')
        elseif reason == 'service-never-started' then
            -- No status at all: the launcher that starts the service never ran. Likeliest first (the Runtime is a separate download).
            table.insert(out, 2, 'PROBLEM: the conversation service never started (runtime/bridge-service.json is missing, empty or from an earlier '
                .. 'session). Most likely the Runtime is missing or did not load: check that red4ext\\plugins\\AiNpcCyberpunkMod\\ exists in the '
                .. 'game folder, read the newest log in red4ext\\logs, and check that antivirus has not blocked or removed it. The service also '
                .. 'needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera.')
        elseif self.startProblem() then
            -- The service's process was started (the launcher says so) and never reported, or it said why it stopped: its own log has the cause.
            table.insert(out, 2, 'PROBLEM: the conversation service did not come up (' .. self.startProblem() .. '). Its log has the cause: '
                .. '%LOCALAPPDATA%\\AiNpcCyberpunkMod\\data\\bridge-service.log (the line starting "View:" says whether it runs inside Mod Organizer 2\'s '
                .. 'file system and sees the game\'s mod folder), and red4ext\\plugins\\AiNpcCyberpunkMod\\launcher.log (with Mod Organizer 2: in the '
                .. 'Runtime mod\'s folder, or in Overwrite).')
        end
        section(out, 'versions')
        local okVersion, cet = pcall(function() return GetVersion and GetVersion() or nil end)
        out[#out + 1] = 'cet: ' .. tostring(okVersion and cet or 'unknown')
        out[#out + 1] = 'interface language: ' .. tostring(ui.current and ui.current() or 'unknown')
        -- The setup check (mod/setup-check.lua): every game-side check, and the service's own checks when it answered this session.
        section(out, 'setup check')
        local setupOk, setupLines = pcall(function() return convaiSetupCheck and convaiSetupCheck.reportLines() or nil end)
        if setupOk and type(setupLines) == 'table' then
            for _, line in ipairs(setupLines) do out[#out + 1] = M.redactLine(tostring(line)) end
        else out[#out + 1] = 'not available' end
        section(out, 'service status')
        out[#out + 1] = 'state: ' .. self.serviceState()
        for _, name in ipairs({'bridge-service', 'bridge-status', 'knowledge-status', 'local-voice-state', 'party-connection-state'}) do
            local value = readJson('runtime/' .. name .. '.json')
            if value then
                local copy = {}
                for key, item in pairs(value) do
                    if type(item) ~= 'table' or key == 'connections' then copy[key] = item
                    elseif #item > 12 then copy[key] = #item .. ' items' else copy[key] = item end
                end
                render(copy, name, 1, out)
            else out[#out + 1] = name .. ': not available' end
        end
        section(out, 'settings')
        local settings = readJson('runtime/settings.json')
        if settings then
            local disabled, enabled = {}, 0
            if type(settings.enabledByKey) == 'table' then
                for key, value in pairs(settings.enabledByKey) do
                    if value == false then disabled[#disabled + 1] = tostring(key) else enabled = enabled + 1 end
                end
                table.sort(disabled)
            end
            local copy = {}
            for key, value in pairs(settings) do if key ~= 'enabledByKey' and key ~= 'enabled' then copy[key] = value end end
            copy.conversationEnabledCount = enabled
            copy.conversationDisabled = disabled
            render(copy, 'settings', 1, out)
        else out[#out + 1] = 'settings: not available' end
        section(out, 'party')
        local party = sanitizeParty()
        if #party == 0 then out[#out + 1] = 'no companions' end
        for _, member in ipairs(party) do
            out[#out + 1] = string.format('%s  state=%s  name=%s%s', member.profile, member.state, member.name,
                member.error and ('  error=' .. member.error) or '')
        end
        -- Logs the game can read: this mod's runtime folder and its CET log.
        local files, seen = {'runtime/probe.log', 'runtime/mcm.log', 'AiNpcCyberpunkMod.log'}, {}
        for _, path in ipairs(files) do seen[path] = true end
        for _, name in ipairs(listNames('runtime')) do
            local path = 'runtime/' .. name
            if name:match('%.log$') and not seen[path] and not contentLike(name) and #files < 9 then files[#files + 1] = path; seen[path] = true end
        end
        for _, path in ipairs(files) do
            local data = tail(path)
            section(out, 'log: ' .. path)
            if not data then out[#out + 1] = '(not found)'
            else
                out[#out + 1] = string.format('(last %d lines%s)', #data.lines, data.omitted and ', earlier lines omitted' or '')
                for _, line in ipairs(data.lines) do out[#out + 1] = M.redactLine(line) end
            end
        end
        return table.concat(out, '\n') .. '\n', stamp
    end

    -- One fixed file, written in place (the shipped empty file is truncated and rewritten). Nothing is created under a new
    -- name, renamed or removed, so under Mod Organizer 2 it stays the mod's own file instead of landing in Overwrite.
    local function writeLocal(reason)
        local ok, text = pcall(buildLocal, reason)
        if not ok then return nil end
        local file = io.open('runtime/' .. LOCAL_NAME, 'wb')
        if not file then return nil end
        local wrote = file:write(text); file:close()
        if not wrote then return nil end
        return LOCAL_NAME, self.locations().mod .. '\\' .. LOCAL_NAME
    end

    local function fallback(reason)
        local name, path = writeLocal(reason)
        if name then
            finish({phase = 'ready', mode = 'lua', reason = reason, fileName = name, path = path})
        else
            finish({phase = 'failed', failure = 'write-failed'})
        end
    end

    ------------------------------------------------------------ the request
    function self.request()
        if state.phase == 'working' then return false, ui.t('A report is already being created.') end
        counter = counter + 1
        local id = 'r' .. now() .. '-' .. counter
        -- Nothing answering (never started, stopped, or only stale or empty status files): the short report now, no wait. Only a
        -- service that is up (a fresh heartbeat, or a fresh ready/starting status) is asked, and given FIRST_WAIT to answer.
        local reach = self.serviceReach()
        if reach ~= 'live' then fallback(reach == 'never' and 'service-never-started' or 'service-stopped')
        else
            local payload = {version = 1, id = id, issuedAt = now() * 1000,
                lua = {cetVersion = (select(2, pcall(function() return GetVersion and GetVersion() or nil end))),
                    language = ui.current and ui.current() or nil, view = 'help',
                    developerMode = options.developerMode and options.developerMode() or nil, party = sanitizeParty(),
                    -- The game-side setup checks (mod/setup-check.lua), which the service cannot see.
                    setup = (select(2, pcall(function() return convaiSetupCheck and convaiSetupCheck.summary() or nil end)))}}
            local encoded = pcall(function()
                local file = io.open(REQUEST, 'wb')
                if not file then error('no file') end
                local wrote = file:write(json.encode(payload)); file:close()
                if not wrote then error('write failed') end
            end)
            if not encoded then fallback('failed')
            else
                state = {phase = 'working', id = id, deadline = now() + FIRST_WAIT, started = now()}
            end
        end
        if state.phase == 'failed' then return false, self.banner() end
        return true, self.banner()
    end

    -- Call from the top-level update. Returns a notification for gameplay when
    -- a new report is ready (once), else nil.
    function self.update(worldReady)
        if pendingCopy then
            local text = pendingCopy; pendingCopy = nil
            if hasGameClipboard() then pcall(ImGui.SetClipboardText, text) end
        end
        if state.phase == 'working' then
            local clock = os.clock()
            if clock - lastPoll >= 0.3 or clock < lastPoll then
                lastPoll = clock
                local result = readJson(RESULT)
                if result and result.id == state.id then
                    if result.state == 'ready' and type(result.path) == 'string' and type(result.fileName) == 'string' then
                        finish({phase = 'ready', mode = 'bridge', fileName = result.fileName, path = result.path})
                    elseif result.state == 'failed' then fallback('failed')
                    elseif result.state == 'building' then
                        state.deadline = math.max(state.deadline, state.started + BUILD_WAIT)
                    end
                end
            end
            if state.phase == 'working' and now() > state.deadline then fallback('no-response') end
        end
        return self.takeNotice(worldReady)
    end

    -- Copy Report path. Route one is a small request file: the conversation
    -- service puts the path on the Windows clipboard. Route two is the game's own
    -- clipboard, tried from the next top-level update because an ImGui call is not
    -- safe inside a native menu callback. Either one is enough.
    local CLIPBOARD = 'runtime/clipboard-request.json'

    -- What the Copy row says and shows, in the banner and in its help text, while no service can copy the path: the path itself,
    -- whole, for the player to find the file. nil once a service is up (or before a report exists).
    function self.copyUnavailableText()
        if not state.path or self.serviceReach() == 'live' then return nil end
        -- The path starts on a line of its own, below the sentence.
        return ui.t('Copying the path needs the conversation service, which is not running. The report file is at: {path}',
            {path = '\n' .. M.fullPath(state.path)})
    end

    function self.copyPath()
        if not state.path then return false, ui.t('Create a report first.') end
        -- No service to put the path on the clipboard: no request file is written (it would sit unread and be acted on whenever a
        -- service starts); the banner shows the path instead, and the game's own clipboard is still tried from the next update.
        local unavailable = self.copyUnavailableText()
        if unavailable then
            if hasGameClipboard() then pendingCopy = state.path end
            return true, unavailable
        end
        counter = counter + 1
        local requested = pcall(function()
            local file = io.open(CLIPBOARD, 'wb')
            if not file then error('no file') end
            local wrote = file:write(json.encode({version = 1, id = 'c' .. now() .. '-' .. counter,
                issuedAt = now() * 1000, text = state.path}))
            file:close()
            if not wrote then error('write failed') end
        end)
        if not requested and not hasGameClipboard() then
            return false, ui.t('The clipboard is not available here. Read the path from the Last report row.')
        end
        pendingCopy = state.path
        return true, ui.t('Report path copied to the clipboard.')
    end

    function self.reset() state, notice, pendingCopy = {phase = 'idle'}, nil, nil end

    return self
end

return M
