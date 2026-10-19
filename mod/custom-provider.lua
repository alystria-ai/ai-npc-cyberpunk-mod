-- Settings > Conversation provider > Custom (OpenAI-compatible): any OpenAI-style chat-completions endpoint (OpenRouter, Nano-GPT, or a
-- server on this computer such as Ollama or LM Studio). The conversation service does all the work (the bridge): this file keeps
-- everything the settings page needs to know about the provider in one place, so the page itself only draws rows.
--
--   * It writes one small command file when the player chooses something (runtime/custom-provider-command.json): paste-url, paste-key
--     and paste-model (the service reads the clipboard itself), clear-url, clear-key, clear-model and test.
--   * It reads the status file the service answers in (runtime/custom-provider-state.json), at most every 1.5 s and only when the page
--     asks for it: nothing here runs per frame and nothing is read while no page is drawn. The key never reaches either file; only its
--     last four characters (a key of 16 or more characters) are ever shown.
--   * It turns that state into rows with no widget in them (rows(): id, label, value, help, enabled, action), so the same rows can be
--     drawn by Mod Configuration Menu today and by any other settings screen later, and into the notice texts and provider notes.
--
-- Only the answer to the latest command counts: an answer for an older command id is never shown (the same rule as the Mistral key).
local M = {version = 1}

local COMMAND, STATE = 'runtime/custom-provider-command.json', 'runtime/custom-provider-state.json'
local READ_EVERY = 1.5
-- A test still "running" this long after it was sent (the service stopped, the game was reloaded under it) is no longer shown as running.
local TEST_STALE = 60

-- The field each command changes; `test` changes none.
local FIELD_OF = {['paste-url'] = 'url', ['clear-url'] = 'url', ['paste-key'] = 'key', ['clear-key'] = 'key',
    ['paste-model'] = 'model', ['clear-model'] = 'model', test = false}
local FIELDS = {url = true, key = true, model = true}
local RESULT_STATES = {saved = true, cleared = true, invalid = true, unreadable = true, failed = true}
local REASONS = {empty = true, ['not-a-url'] = true, scheme = true, insecure = true, extras = true, long = true,
    ['not-a-key'] = true, ['not-a-model'] = true}
local TEST_CODES = {['no-setup'] = true, key = true, credits = true, model = true, limit = true, unreachable = true,
    timeout = true, server = true, empty = true, request = true, redirect = true}
local LIMITS = {rate = true, invalid = true, model = true, credits = true}

-- The ids of the notices this provider adds (mod/notices.lua, docs/NOTIFICATIONS.md): five failures of a turn V asked for and two
-- one-time notices on the first reply.
M.NOTICE_IDS = {'custom-key', 'custom-credits', 'custom-model', 'custom-limit', 'custom-unreachable', 'custom-no-setup', 'custom-voice'}

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

-- A string of at most `limit` bytes that matches `pattern`, else nil.
local function text(value, limit, pattern)
    if type(value) ~= 'string' or value == '' or #value > limit then return nil end
    if pattern and not value:match(pattern) then return nil end
    return value
end

local function whole(value, max)
    if type(value) ~= 'number' or value ~= value or value < 0 or value > max then return nil end
    return math.floor(value)
end

-- The provider's own words: one line of at most 160 bytes, cut before a half character.
local function cleanDetail(value)
    if type(value) ~= 'string' then return nil end
    local clean = value:gsub('%c', ' ')
    clean = clean:gsub('%s+', ' ')
    clean = clean:gsub('^ ', ''):gsub(' $', '')
    if #clean > 160 then
        local last = 160
        while last > 0 do
            local byte = clean:byte(last + 1)
            if not byte or byte < 128 or byte >= 192 then break end
            last = last - 1
        end
        clean = clean:sub(1, last)
    end
    return clean ~= '' and clean or nil
end

-- A name that is too long for a row's label: its first characters and an ellipsis (host names and model ids are plain ASCII).
local function shorten(value, limit)
    if #value <= limit then return value end
    return value:sub(1, limit - 1) .. '…'
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

-- options: ui (the translator, with t), readJSON(path) -> table or nil, writeCommand(path, value) -> true or false (the command files
-- are written in place), session() -> the id of this game session (command ids carry it), clock() -> seconds.
function M.new(options)
    options = options or {}
    local ui = options.ui or plainTranslator()
    local read = type(options.readJSON) == 'function' and options.readJSON or readJSON
    local writeCommand = type(options.writeCommand) == 'function' and options.writeCommand or defaultWrite
    local clock = type(options.clock) == 'function' and options.clock or function() return os.clock() end
    local self = {}
    local counter, raw, readAt, localSession = 0, {}, nil, nil
    -- The latest command this page sent: {id, action, field (false for a test), at}.
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
        if not localSession then localSession = 'c' .. tostring(os.time()) .. '-' .. tostring(math.random(100000, 999999)) end
        return localSession
    end

    -- What the page shows, cleaned: anything malformed reads as absent, and nothing here ever raises. `result` is the outcome of the
    -- latest paste or remove (and only if that was the latest command), `test` that of the latest test (likewise).
    function self.state(force)
        refresh(force)
        local value = raw
        local result, test
        local r = value.result
        if sent and sent.field and type(r) == 'table' and r.id == sent.id and RESULT_STATES[r.state] then
            local field = FIELDS[r.field] and r.field or sent.field
            if field == sent.field then
                result = {field = field, state = r.state, reason = r.state == 'invalid' and REASONS[r.reason] and r.reason or nil}
            end
        end
        local t = value.test
        if sent and sent.action == 'test' and type(t) == 'table' and t.id == sent.id then
            if t.state == 'testing' then
                if not (clock() - sent.at > TEST_STALE) then test = {state = 'testing'} end
            elseif t.state == 'ok' then
                test = {state = 'ok', ms = whole(t.ms, 600000)}
            elseif t.state == 'failed' then
                local wait = type(t.waitS) == 'number' and t.waitS == t.waitS and t.waitS > 0 and t.waitS <= 86400 and math.ceil(t.waitS) or nil
                test = {state = 'failed', code = TEST_CODES[t.code] and t.code or nil, status = whole(t.status, 599),
                    waitS = wait, detail = cleanDetail(t.detail)}
            end
        end
        return {available = value.version == 1, ready = value.ready == true,
            host = text(value.host, 255, '^[%w%.%-_:%[%]]+$'), secure = value.secure == true, isLocal = value['local'] == true,
            model = text(value.model, 120, '^[%w%._:/@%+%-]+$'),
            keySaved = value.keySaved == true, tail = text(value.tail, 8, '^[%w%p]+$'),
            result = result, test = test, limit = LIMITS[value.limit] and value.limit or nil,
            action = sent and sent.action or nil}
    end

    -- One line for the settings page's redraw check: it changes when anything the rows show changes.
    function self.signature()
        local state = self.state()
        local result, test = state.result, state.test
        return table.concat({tostring(state.available), tostring(state.ready), state.host or '', tostring(state.secure),
            state.model or '', tostring(state.keySaved), state.tail or '', state.limit or '',
            result and (result.field .. '/' .. result.state .. '/' .. (result.reason or '')) or '',
            test and table.concat({test.state, test.code or '', tostring(test.status), tostring(test.waitS), test.detail or '',
                tostring(test.ms)}, '/') or ''}, '|')
    end

    -- Sends one command (see the top of this file). Returns ok, message; a command that could not be written returns false and a
    -- sentence, and leaves the latest answer as it was.
    function self.request(action)
        if FIELD_OF[action] == nil then return false, ui.t('The request could not be sent. Try again.') end
        counter = counter + 1
        local id = sessionId() .. ':cust:' .. tostring(counter)
        local payload = {version = 1, id = id, action = action, issuedAt = os.time() * 1000.0}
        local ok, done = pcall(writeCommand, COMMAND, payload)
        if not (ok and done == true) then return false, ui.t('The request could not be sent. Try again.') end
        sent = {id = id, action = action, field = FIELD_OF[action], at = clock()}
        readAt = nil
        if action == 'test' then return true, ui.t('Testing the connection…') end
        if action == 'clear-url' then return true, ui.t('The endpoint URL was removed.') end
        if action == 'clear-key' then return true, ui.t('Your key was removed.') end
        if action == 'clear-model' then return true, ui.t('The model ID was removed.') end
        return true, ui.t('Checking…')
    end

    -- The first paragraph of a row's help after a paste that did not work (nil for anything else).
    local function failure(result, field)
        if not result or result.field ~= field then return nil end
        if result.state == 'unreadable' then return ui.t('The clipboard could not be read.') end
        if result.state == 'failed' then return ui.t('It could not be saved.') end
        if result.state ~= 'invalid' then return nil end
        local reason = result.reason
        if reason == 'empty' then return ui.t('The clipboard is empty. Copy it first.') end
        if reason == 'not-a-url' then return ui.t('The clipboard does not hold a web address.') end
        if reason == 'scheme' then return ui.t('The address must start with https:// or http://.') end
        if reason == 'insecure' then return ui.t('Only https:// works outside this computer and your home network.') end
        if reason == 'extras' then return ui.t('Use the base URL only: no password, query or #.') end
        if reason == 'long' then return ui.t('That is too long.') end
        if reason == 'not-a-key' then return ui.t('The clipboard does not hold an API key.') end
        if reason == 'not-a-model' then return ui.t('The clipboard does not hold a model ID.') end
        return ui.t('That was not accepted.')
    end

    -- The plain sentence for a failed test's code.
    local function testSentence(test)
        local code = test.code
        if code == 'no-setup' then return ui.t('Add an endpoint URL and a model ID first.') end
        if code == 'key' then return ui.t('The endpoint did not accept your API key.') end
        if code == 'credits' then return ui.t('The account is out of credits. Add credits with your provider.') end
        if code == 'model' then return ui.t('The endpoint does not know that model ID.') end
        if code == 'limit' then
            if test.waitS then return ui.t('The endpoint is rate limiting you. Wait about {seconds} seconds, then try again.', {seconds = test.waitS}) end
            return ui.t('The endpoint is rate limiting you. Try again in a moment.')
        end
        if code == 'unreachable' then return ui.t('The endpoint did not answer. Check its address.') end
        if code == 'timeout' then return ui.t('The endpoint took too long to answer.') end
        if code == 'server' then return ui.t('The endpoint reported an error on its side. Try again in a moment.') end
        if code == 'empty' then return ui.t('The endpoint answered with no text. Check the model ID.') end
        if code == 'request' then return ui.t('The endpoint refused the request. Check the model ID and the address.') end
        if code == 'redirect' then return ui.t('The address sends you somewhere else. Use the final address from your provider.') end
        return ui.t('The connection test failed.')
    end

    -- The four rows, in the order they are drawn: {id, field, label, value, help, enabled, action}. `action` is what choosing the row
    -- sends through request(). The texts are already translated.
    function self.rows()
        local state = self.state()
        local result, test = state.result, state.test
        local rows = {}

        -- The endpoint URL.
        do
            local saved = state.host ~= nil
            local message = failure(result, 'url')
            local info = saved and shorten(state.host, 32) or (message and ui.t('Not added') or nil)
            local help
            if saved then
                help = ui.t('Deletes the saved endpoint URL. The custom provider needs one to answer.')
                if not state.secure then help = help .. '\n\n' .. ui.t('This address is not encrypted, which is fine on your own computer or home network.') end
            else
                help = ui.t('Copy the base URL from your provider, for example https://openrouter.ai/api/v1, https://nano-gpt.com/api/v1 or http://localhost:11434/v1 (Ollama). It is read from the clipboard once and saved on this computer.\n\nOnly this computer and your home network may use http://. You can also fill in endpoint=, model= and api-key= in player-custom-endpoint.txt in the conversation service folder.\n\nNothing is sent until you choose this provider or press Test connection.')
            end
            if message then help = message .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'custom-url', field = 'url', label = ui.t('Custom endpoint URL') .. (info and (' (' .. info .. ')') or ''),
                value = saved and ui.t('Remove') or ui.t('Paste endpoint URL'), help = help, enabled = true,
                action = saved and 'clear-url' or 'paste-url'}
        end

        -- The API key: only its last four characters (a key of 16 or more characters), or Added for a short one.
        do
            local saved = state.keySaved
            local message = failure(result, 'key')
            local info
            if saved then info = state.tail and ('…' .. state.tail) or ui.t('Added')
            elseif message then info = ui.t('Not added') end
            local help
            if saved then
                help = ui.t('Deletes the saved key. Replies from the custom provider are then asked for without a key.')
                    .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.')
            else
                help = ui.t('Copy your API key from your provider first. It is read from the clipboard once and saved on this computer only. A server on your own computer, such as Ollama or LM Studio, usually needs no key.')
            end
            if message then help = message .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'custom-key', field = 'key', label = ui.t('Custom API key') .. (info and (' (' .. info .. ')') or ''),
                value = saved and ui.t('Remove') or ui.t('Paste API key'), help = help, enabled = true,
                action = saved and 'clear-key' or 'paste-key'}
        end

        -- The model id.
        do
            local saved = state.model ~= nil
            local message = failure(result, 'model')
            local info = saved and shorten(state.model, 26) or (message and ui.t('Not added') or nil)
            local help
            if saved then
                help = ui.t('Model ID: {model}', {model = state.model}) .. '\n\n'
                    .. ui.t('Deletes the saved model ID. The custom provider needs one to answer.')
            else
                help = ui.t('Copy the model ID from your provider first, for example meta-llama/llama-3.1-8b-instruct on OpenRouter or llama3.2 on Ollama. It is read from the clipboard once and saved on this computer.')
            end
            if message then help = message .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'custom-model', field = 'model', label = ui.t('Custom model ID') .. (info and (' (' .. info .. ')') or ''),
                value = saved and ui.t('Remove') or ui.t('Paste model ID'), help = help, enabled = true,
                action = saved and 'clear-model' or 'paste-model'}
        end

        -- The connection test: one tiny request, run by the service. It needs the service (the state file) and runs one at a time.
        do
            local info, first
            if not state.available then
                first = ui.t('The conversation service is not running, so nothing can be tested. Restart the game.')
            elseif test and test.state == 'testing' then
                info, first = ui.t('Testing…'), ui.t('Waiting for the endpoint to answer…')
            elseif test and test.state == 'ok' then
                info, first = ui.t('OK'), ui.t('The connection works. The endpoint accepted your model and key.')
                if test.ms then first = first .. ' ' .. ui.t('It answered in {ms} ms.', {ms = test.ms}) end
            elseif test and test.state == 'failed' then
                info, first = ui.t('Failed'), testSentence(test)
                if test.detail then first = first .. '\n\n' .. ui.t('The provider said: {detail}', {detail = test.detail}) end
            end
            local help = ui.t('Sends one tiny message to your endpoint with the saved model ID and key, and shows how it answered. It uses next to nothing of your credits.')
            if first then help = first .. '\n\n' .. help end
            rows[#rows + 1] = {id = 'custom-test', field = 'test', label = ui.t('Test connection') .. (info and (' (' .. info .. ')') or ''),
                value = ui.t('Test'), help = help, enabled = state.available and not (test and test.state == 'testing'),
                action = 'test'}
        end
        return rows
    end

    -- The last paragraph of the provider row's help while Custom answers and a limit is on (the stored `limit` of the provider state).
    function self.noteFor(limit)
        if limit == 'rate' then return ui.t('Custom: rate limited for now') end
        if limit == 'invalid' then return ui.t('Custom: key not accepted') end
        if limit == 'model' then return ui.t('Custom: model unavailable') end
        if limit == 'credits' then return ui.t('Custom: out of credits') end
        return nil
    end

    -- The same while Custom is chosen but not set up, so Convai answers.
    function self.notSetUpNote() return ui.t('Convai: the custom provider is not set up yet') end

    -- The text of one of the notices (NOTICE_IDS), or nil.
    function self.notice(id)
        if id == 'custom-key' then return ui.t('The custom provider did not accept your key. Check it in Settings > Conversation provider.') end
        if id == 'custom-credits' then return ui.t('The custom provider says your account is out of credits. Add credits there, then try again.') end
        if id == 'custom-model' then return ui.t('The custom provider does not know that model ID. Check it in Settings.') end
        if id == 'custom-limit' then return ui.t('The custom provider is rate limiting you. Try again in a moment.') end
        if id == 'custom-unreachable' then return ui.t('The custom provider did not answer. Check its address in Settings, or try again.') end
        if id == 'custom-no-setup' then return ui.t('The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.') end
        if id == 'custom-voice' then return ui.t('Custom provider replies are spoken by a local voice instead of the Convai cloud voice.') end
        return nil
    end

    -- The latest command sent ({id, action}), for the page's own bookkeeping and for tests.
    function self.lastCommand() return sent and {id = sent.id, action = sent.action} or nil end

    return self
end

return M
