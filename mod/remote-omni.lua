-- Settings > Voices > Custom voices > Remote OmniVoice (docs/REMOTE_OMNIVOICE.md): the server address and the connection test. The switch itself ("Remote OmniVoice") is an
-- ordinary saved setting (`remoteOmni`, mod/manager.lua); this file keeps what the page needs to know about the address, in one place, so the page only draws rows.
--
--   * It writes one small command file when the player chooses something (runtime/remote-omni-command.json): paste-address (the service reads the clipboard itself),
--     clear-address and test.
--   * It reads the status file the service answers in (runtime/remote-omni-state.json), at most every 1.5 s and only when the page asks for it: nothing here runs per
--     frame and nothing is read while no page is drawn.
--   * It turns that state into rows with no widget in them (rows(): id, label, value, help, enabled, action), so the same rows can be drawn by the Companion Manager page
--     (mod/manager-ui.lua, shown by mod/nsui.lua) and by any other settings screen later.
--
-- Only the answer to the latest command counts: an answer for an older command id is never shown (the same rule as the Custom provider's).
local M = {version = 1}

local COMMAND, STATE = 'runtime/remote-omni-command.json', 'runtime/remote-omni-state.json'
local READ_EVERY = 1.5
-- A test still "running" this long after it was sent (the service stopped, the game was reloaded under it) is no longer shown as running. A test is three small
-- questions with a few seconds' wait each, so this is long.
local TEST_STALE = 60
local ACTIONS = {['paste-address'] = true, ['clear-address'] = true, test = true}
local RESULT_STATES = {saved = true, cleared = true, invalid = true, unreadable = true, failed = true}
local REASONS = {empty = true, scheme = true, extras = true, host = true, port = true, long = true}
local TEST_CODES = {['no-address'] = true, unreachable = true, timeout = true, ['not-omnivoice'] = true, protocol = true, blocked = true, server = true}

local function readJSON(path)
    local ok, value = pcall(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local raw = file:read('*a'); file:close()
        if type(raw) ~= 'string' then return nil end
        -- Windows PowerShell and older Notepad save UTF-8 with a byte-order mark.
        if raw:sub(1, 3) == '\239\187\191' then raw = raw:sub(4) end
        return json.decode(raw)
    end)
    return ok and type(value) == 'table' and value or nil
end

local function defaultWrite(path, payload)
    local ok, done = pcall(function()
        local encoded = json.encode(payload)
        -- In place over the shipped placeholder: a new file here would land in Mod Organizer 2's Overwrite folder.
        local file = io.open(path, 'wb')
        if not file then return false end
        local wrote = file:write(encoded)
        local closed = file:close()
        return wrote and closed and true or false
    end)
    return ok and done == true
end

local function text(value, limit, pattern)
    if type(value) ~= 'string' or value == '' or #value > limit then return nil end
    if pattern and not value:match(pattern) then return nil end
    return value
end

local function whole(value, max)
    if type(value) ~= 'number' or value ~= value or value < 0 or value > max then return nil end
    return math.floor(value)
end

local function plainTranslator()
    return {t = function(source, args)
        if type(args) ~= 'table' then return source end
        return (source:gsub('{([A-Za-z_][A-Za-z0-9_]*)}', function(key)
            local value = rawget(args, key)
            return value ~= nil and tostring(value) or nil
        end))
    end}
end

-- options: ui (the translator, with t), readJSON(path) -> table or nil, writeCommand(path, value) -> true or false (the command file is written in place),
-- session() -> the id of this game session (command ids carry it), clock() -> seconds.
function M.new(options)
    options = options or {}
    local ui = options.ui or plainTranslator()
    local read = type(options.readJSON) == 'function' and options.readJSON or readJSON
    local writeCommand = type(options.writeCommand) == 'function' and options.writeCommand or defaultWrite
    local clock = type(options.clock) == 'function' and options.clock or function() return os.clock() end
    local self = {}
    local counter, raw, readAt, localSession = 0, {}, nil, nil
    -- The latest command this page sent: {id, action, at}.
    local sent = nil

    local function refresh(force)
        local now = clock()
        if not force and readAt and now >= readAt and now - readAt < READ_EVERY then return end
        readAt = now
        local ok, value = pcall(read, STATE)
        raw = ok and type(value) == 'table' and value or {}
    end

    local function sessionId()
        if type(options.session) == 'function' then
            local ok, value = pcall(options.session)
            if ok and text(value, 120, '^[A-Za-z0-9][A-Za-z0-9_.:%-]*$') then return value end
        end
        if not localSession then localSession = 'r' .. tostring(os.time()) .. '-' .. tostring(math.random(100000, 999999)) end
        return localSession
    end

    -- What the page shows, cleaned: anything malformed reads as absent, and nothing here ever raises.
    function self.state(force)
        refresh(force)
        local value = raw
        local result, test
        local r = value.result
        if sent and sent.action ~= 'test' and type(r) == 'table' and r.id == sent.id and RESULT_STATES[r.state] then
            result = {state = r.state, reason = r.state == 'invalid' and REASONS[r.reason] and r.reason or nil}
        end
        local t = value.test
        if sent and sent.action == 'test' and type(t) == 'table' and t.id == sent.id then
            if t.state == 'testing' then
                if not (clock() - sent.at > TEST_STALE) then test = {state = 'testing'} end
            elseif t.state == 'ok' or t.state == 'loading' then
                test = {state = t.state, ms = whole(t.ms, 600000), version = text(t.version, 60, '^[%w%._%-+ ]+$'),
                    device = text(t.device, 60, '^[%w%._:%-/ ]+$')}
            elseif t.state == 'failed' then
                test = {state = 'failed', code = TEST_CODES[t.code] and t.code or nil, version = text(t.version, 60, '^[%w%._%-+ ]+$')}
            end
        end
        return {available = value.version == 1, set = value.set == true,
            address = text(value.address, 255, '^[%w%.%-_:%[%]]+$'), result = result, test = test, action = sent and sent.action or nil}
    end

    -- One line for the settings page's redraw check: it changes when anything the rows show changes.
    function self.signature()
        local state = self.state()
        local result, test = state.result, state.test
        return table.concat({tostring(state.available), tostring(state.set), state.address or '',
            result and (result.state .. '/' .. (result.reason or '')) or '',
            test and table.concat({test.state, test.code or '', tostring(test.ms), test.version or '', test.device or ''}, '/') or ''}, '|')
    end

    -- Sends one command (see the top of this file). Returns ok, message; a command that could not be written returns false and a sentence.
    function self.request(action)
        if not ACTIONS[action] then return false, ui.t('The request could not be sent. Try again.') end
        counter = counter + 1
        local id = sessionId() .. ':remote:' .. tostring(counter)
        local payload = {version = 1, id = id, action = action, issuedAt = os.time() * 1000.0}
        local ok, done = pcall(writeCommand, COMMAND, payload)
        if not (ok and done == true) then return false, ui.t('The request could not be sent. Try again.') end
        sent = {id = id, action = action, at = clock()}
        readAt = nil
        if action == 'test' then return true, ui.t('Testing the connection…') end
        if action == 'clear-address' then return true, ui.t('The server address was removed.') end
        return true, ui.t('Checking…')
    end

    -- The first paragraph of the address row's help after a paste that did not work (nil for anything else).
    local function failure(result)
        if not result then return nil end
        if result.state == 'unreadable' then return ui.t('The clipboard could not be read.') end
        if result.state == 'failed' then return ui.t('It could not be saved.') end
        if result.state ~= 'invalid' then return nil end
        local reason = result.reason
        if reason == 'empty' then return ui.t('The clipboard is empty. Copy the address first.') end
        if reason == 'scheme' then return ui.t('Use the address the server window shows, such as 192.168.1.20:8765, without https://.') end
        if reason == 'extras' then return ui.t('Use the address only: no user name, no path, no #.') end
        if reason == 'host' then return ui.t('The clipboard does not hold a server address.') end
        if reason == 'port' then return ui.t('The port must be a number from 1 to 65535.') end
        if reason == 'long' then return ui.t('That is too long.') end
        return ui.t('That was not accepted.')
    end

    -- The plain sentence for a failed test's code.
    local function testSentence(test)
        local code = test.code
        if code == 'no-address' then return ui.t('Add a server address first.') end
        if code == 'unreachable' then
            return ui.t('Nothing answered at that address. Check that the server is running, that the address and port are right and that both PCs are on the same network. A server started with its default only listens on its own PC: start it with the listen address 0.0.0.0.')
        end
        if code == 'timeout' then return ui.t('The server took too long to answer.') end
        if code == 'not-omnivoice' then return ui.t('Something answered, but it is not the OmniVoice server. Check the port.') end
        if code == 'protocol' then return ui.t('The server is another version. Use the server folder and the mod from the same release.') end
        if code == 'blocked' then return ui.t('The server refused the request.') end
        if code == 'server' then return ui.t('The server answered but could not load its voice. Its window says why.') end
        return ui.t('The connection test failed.')
    end

    -- The rows, in the order they are drawn: {id, label, value, help, enabled, action}. `action` is what choosing the row sends through request(). The texts are
    -- already translated.
    function self.rows()
        local state = self.state()
        local result, test = state.result, state.test
        local rows = {}

        -- The server address.
        do
            local saved = state.address ~= nil
            local message = failure(result)
            local info = saved and state.address or (message and ui.t('Not added') or nil)
            local help
            if saved then
                help = ui.t('Deletes the saved server address. Remote OmniVoice needs one to speak.')
            else
                help = ui.t('Start the OmniVoice server on the other PC. Its window shows the address to use, for example 192.168.1.20:8765. Copy it, then choose Paste address. It is read from the clipboard once and saved on this computer.\n\nOn the same PC use 127.0.0.1:8765. You can also write address=192.168.1.20:8765 in player-remote-omnivoice.txt in the conversation service folder.\n\nNothing is sent to it until Remote OmniVoice is on and OmniVoice is chosen, or you press Test.')
            end
            if message then help = message .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'remote-address', label = ui.t('Server address') .. (info and (' (' .. info .. ')') or ''),
                value = saved and ui.t('Remove') or ui.t('Paste address'), help = help, enabled = true,
                action = saved and 'clear-address' or 'paste-address'}
        end

        -- The connection test: three small questions to the server, run by the service. It needs the service (the state file).
        do
            local info, first
            if not state.available then
                first = ui.t('The conversation service is not running, so nothing can be tested. Restart the game.')
            elseif test and test.state == 'testing' then
                info, first = ui.t('Testing…'), ui.t('Waiting for the server to answer…')
            elseif test and test.state == 'ok' then
                info = ui.t('OK')
                first = ui.t('The server is ready.')
                if test.ms then first = first .. ' ' .. ui.t('It answers in {ms} ms.', {ms = test.ms}) end
                if test.device then first = first .. ' ' .. ui.t('Its voice runs on {device}.', {device = test.device}) end
                if test.version then first = first .. ' ' .. ui.t('Version {version}.', {version = test.version}) end
            elseif test and test.state == 'loading' then
                info = ui.t('Loading')
                first = ui.t('The server answered but is still loading its voice. Try again in a minute.')
                if test.ms then first = first .. ' ' .. ui.t('It answers in {ms} ms.', {ms = test.ms}) end
            elseif test and test.state == 'failed' then
                info, first = ui.t('Failed'), testSentence(test)
            end
            local help = ui.t('Asks the server three times who it is and shows whether it is reachable, how long it takes to answer and its version. It sends no speech.')
            if first then help = first .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'remote-test', label = ui.t('Test connection') .. (info and (' (' .. info .. ')') or ''),
                value = ui.t('Test'), help = help, enabled = state.available and not (test and test.state == 'testing'),
                action = 'test'}
        end
        return rows
    end

    -- The latest command sent ({id, action}), for the page's own bookkeeping and for tests.
    function self.lastCommand() return sent and {id = sent.id, action = sent.action} or nil end

    return self
end

return M
