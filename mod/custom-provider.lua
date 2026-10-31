-- Settings > Conversation provider > Custom (OpenAI-compatible): any OpenAI-style chat-completions endpoint (OpenRouter, Nano-GPT, or a
-- server on this computer such as Ollama or LM Studio). The conversation service does all the work (the bridge): this file keeps
-- everything the settings page needs to know about the provider in one place, so the page itself only draws rows.
--
--   * It writes one small command file when the player chooses something (runtime/custom-provider-command.json): paste-url, paste-key
--     and paste-model (the service reads the clipboard itself), clear-url, clear-key, clear-model, test, and preset-mistral
--     (the service reads the key from the clipboard and fills in the endpoint, the model id and the key of that preset in one go), with
--     clear-preset-mistral to remove it, its key included.
--   * A second instance (options.kind = 'gemini') is the page of the Google Gemini provider: runtime/gemini-provider-command.json and
--     runtime/gemini-provider-state.json, the same protocol, one row (the key, Add and Remove through preset-gemini and clear-preset-gemini). Add also has the service try the key once
--     with a tiny request; the answer comes back as `check` and is told on the key row itself. That page has no Test connection.
--   * It reads the status file the service answers in (runtime/custom-provider-state.json), at most every 1.5 s and only when the page
--     asks for it: nothing here runs per frame and nothing is read while no page is drawn. The key never reaches either file; only its
--     last four characters (a key of 16 or more characters) are ever shown.
--   * It turns that state into rows with no widget in them (rows(): id, label, value, help, enabled, action), so the same rows can be
--     drawn by the Companion Manager page (mod/manager-ui.lua, shown by mod/nsui.lua) and by any other settings screen later, and into the notice texts and provider notes.
--
-- Only the answer to the latest command counts: an answer for an older command id is never shown (the same rule as the Mistral key).
local M = {version = 1}

local COMMAND, STATE = 'runtime/custom-provider-command.json', 'runtime/custom-provider-state.json'
local GEMINI_COMMAND, GEMINI_STATE = 'runtime/gemini-provider-command.json', 'runtime/gemini-provider-state.json'
local READ_EVERY = 1.5
-- A test still "running" this long after it was sent (the service stopped, the game was reloaded under it) is no longer shown as running.
-- Longer than the longest real test: a server on this computer gets 90 s, and once more as long when it refuses a request field.
local TEST_STALE = 200

-- The field each command changes; `test` changes none.
local FIELD_OF = {['paste-url'] = 'url', ['clear-url'] = 'url', ['paste-key'] = 'key', ['clear-key'] = 'key',
    ['paste-model'] = 'model', ['clear-model'] = 'model', ['preset-gemini'] = 'preset',
    ['clear-preset-gemini'] = 'preset', ['preset-mistral'] = 'preset', ['clear-preset-mistral'] = 'preset', test = false}
local FIELDS = {url = true, key = true, model = true, preset = true}
-- The one-press setups of the free cloud plans (bridge/custom-endpoint.mjs PRESETS); the service says which one is saved.
local PRESETS = {gemini = true, mistral = true}
local RESULT_STATES = {saved = true, cleared = true, invalid = true, unreadable = true, failed = true}
local REASONS = {empty = true, ['not-a-url'] = true, scheme = true, insecure = true, extras = true, long = true,
    ['not-a-key'] = true, ['not-a-model'] = true}
local TEST_CODES = {['no-setup'] = true, ['no-key'] = true, key = true, credits = true, model = true, limit = true, unreachable = true, region = true,
    timeout = true, server = true, empty = true, request = true, redirect = true, daily = true, reasoning = true,
    webpage = true, ['webpage-openrouter'] = true}
local LIMITS = {rate = true, daily = true, invalid = true, model = true, credits = true, region = true}

-- The ids of the notices this provider adds (mod/notices.lua, docs/NOTIFICATIONS.md): seven failures of a turn V asked for and two
-- one-time notices on the first reply.
M.NOTICE_IDS = {'custom-key', 'custom-credits', 'custom-model', 'custom-limit', 'custom-daily', 'custom-reasoning', 'custom-unreachable', 'custom-no-setup', 'custom-voice'}
-- The notices of the Google Gemini provider (notice() words them too): its two one-time notices, then seven failures of a turn V asked for, in Google's own terms.
M.GEMINI_NOTICE_IDS = {'gemini-no-key', 'gemini-voice', 'gemini-key', 'gemini-daily', 'gemini-limit', 'gemini-region', 'gemini-server', 'gemini-unreachable', 'gemini-model'}

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
    -- A reset time the bridge sends ("HH:MM", this computer's clock) as the player reads a time of day: "5:30 AM" in English (the UI locale decides).
    local function timeOf(hhmm) return type(ui.clockText) == 'function' and ui.clockText(hhmm) or hhmm end
    local isGemini = options.kind == 'gemini'
    local COMMAND, STATE = isGemini and GEMINI_COMMAND or COMMAND, isGemini and GEMINI_STATE or STATE
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
        -- The Google Gemini page's check of a key just added (there is no test row): only the answer to the latest Add counts.
        local c, check = value.check, nil
        if sent and sent.action == 'preset-gemini' and type(c) == 'table' and c.id == sent.id then
            if c.state == 'checking' then
                if not (clock() - sent.at > TEST_STALE) then check = {state = 'checking'} end
            elseif c.state == 'ok' then
                check = {state = 'ok'}
            elseif c.state == 'failed' then
                check = {state = 'failed', code = TEST_CODES[c.code] and c.code or nil}
            end
        end
        if sent and sent.action == 'test' and type(t) == 'table' and t.id == sent.id then
            if t.state == 'testing' then
                if not (clock() - sent.at > TEST_STALE) then test = {state = 'testing'} end
            elseif t.state == 'ok' then
                test = {state = 'ok', ms = whole(t.ms, 600000)}
            elseif t.state == 'failed' then
                local wait = type(t.waitS) == 'number' and t.waitS == t.waitS and t.waitS > 0 and t.waitS <= 86400 and math.ceil(t.waitS) or nil
                test = {state = 'failed', code = TEST_CODES[t.code] and t.code or nil, status = whole(t.status, 599),
                    waitS = wait, detail = cleanDetail(t.detail), resetTime = text(t.resetTime, 5, '^%d%d:%d%d$')}
            end
        end
        return {available = value.version == 1, ready = value.ready == true,
            host = text(value.host, 255, '^[%w%.%-_:%[%]]+$'), secure = value.secure == true, isLocal = value['local'] == true,
            model = text(value.model, 120, '^[%w%._:/@%+%-]+$'),
            keySaved = value.keySaved == true, tail = text(value.tail, 8, '^[%w%p]+$'),
            -- A key was forgotten because the address moved to another host, and none is saved since: the key row says to paste it again.
            keyForgotten = value.keyForgotten == true and value.keySaved ~= true,
            result = result, test = test, check = check, limit = LIMITS[value.limit] and value.limit or nil, preset = PRESETS[value.preset] and value.preset or nil,
            action = sent and sent.action or nil}
    end

    -- One line for the settings page's redraw check: it changes when anything the rows show changes.
    function self.signature()
        local state = self.state()
        local result, test, check = state.result, state.test, state.check
        return table.concat({tostring(state.available), tostring(state.ready), state.host or '', tostring(state.secure),
            state.model or '', tostring(state.keySaved), state.tail or '', state.limit or '', tostring(state.keyForgotten), state.preset or '',
            result and (result.field .. '/' .. result.state .. '/' .. (result.reason or '')) or '',
            check and (check.state .. '/' .. (check.code or '')) or '',
            test and table.concat({test.state, test.code or '', tostring(test.status), tostring(test.waitS), test.detail or '',
                tostring(test.ms), test.resetTime or ''}, '/') or ''}, '|')
    end

    -- Sends one command (see the top of this file). Returns ok, message; a command that could not be written returns false and a
    -- sentence, and leaves the latest answer as it was.
    function self.request(action)
        if FIELD_OF[action] == nil or (isGemini and action == 'test') then return false, ui.t('The request could not be sent. Try again.') end
        counter = counter + 1
        local id = sessionId() .. ':cust:' .. tostring(counter)
        local payload = {version = 1, id = id, action = action, issuedAt = os.time() * 1000.0}
        local ok, done = pcall(writeCommand, COMMAND, payload)
        if not (ok and done == true) then return false, ui.t('The request could not be sent. Try again.') end
        sent = {id = id, action = action, field = FIELD_OF[action], at = clock()}
        readAt = nil
        if action == 'test' then return true, ui.t('Testing the connection…') end
        if action == 'clear-url' then return true, ui.t('The endpoint URL was removed.') end
        if action == 'clear-key' or action == 'clear-preset-gemini' or action == 'clear-preset-mistral' then return true, ui.t('Your key was removed.') end
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
        if code == 'no-key' then return ui.t('No API key is saved yet. Copy your key from your provider, press Paste API key, then test again.') end
        if code == 'key' then return ui.t('The endpoint did not accept your API key.') end
        if code == 'credits' then return ui.t('The account is out of credits. Add credits with your provider.') end
        if code == 'model' then return ui.t('The endpoint does not know that model ID.') end
        if code == 'region' then return ui.t('The service is not available in your region.') end
        if code == 'limit' then
            if test.waitS then return ui.t('The endpoint is rate limiting you. Wait about {seconds} seconds, then try again.', {seconds = test.waitS}) end
            return ui.t('The endpoint is rate limiting you. Try again in a moment.')
        end
        if code == 'daily' then
            if test.resetTime then return ui.t('The free daily limit for this model was reached. It resets at {time}.', {time = timeOf(test.resetTime)}) end
            return ui.t('The free daily limit for this model was reached. Try again after it resets.')
        end
        if code == 'reasoning' then return ui.t('This model spends its reply on thinking. Choose a non-reasoning model in Settings.') end
        if code == 'unreachable' then return ui.t('The endpoint did not answer. Check its address.') end
        if code == 'timeout' then return ui.t('The endpoint took too long to answer.') end
        if code == 'server' then return ui.t('The endpoint reported an error on its side. Try again in a moment.') end
        if code == 'empty' then return ui.t('The endpoint answered with no text. Check the model ID.') end
        if code == 'request' then return ui.t('The endpoint refused the request. Check the model ID and the address.') end
        if code == 'redirect' then return ui.t('The address sends you somewhere else. Use the final address from your provider.') end
        if code == 'webpage-openrouter' then return ui.t('That address is a web page, not the API. For OpenRouter use https://openrouter.ai/api/v1.') end
        if code == 'webpage' then return ui.t('That address is a web page, not the API. Use the API address from your provider.') end
        return ui.t('The connection test failed.')
    end

    -- The rows of the Custom page (the free setup, then the endpoint URL, key, model ID and test), in the order they are drawn: {id, field, label, value, help, enabled, action}. `action` is what choosing the row
    -- sends through request(). The texts are already translated.
    function self.rows()
        if isGemini then return self.geminiRows() end
        local state = self.state()
        local result, test = state.result, state.test
        local rows = {}

        -- The free setup: with the key on the clipboard, one press saves the endpoint URL, the model ID and the key of a free cloud plan. The button is Add, and Remove while this plan is the one
        -- saved (it deletes the endpoint, the model and the key).
        do
            local message = failure(result, 'preset')
            local function presetRow(id, name, label, addHelp)
                local saved = state.preset == name
                local help = saved and ui.t('Deletes this free setup: the endpoint URL, the model ID and the API key saved with it.') or addHelp
                if message then help = message .. '\n\n' .. help end
                rows[#rows + 1] = {id = id, field = 'preset', label = label, value = saved and ui.t('Remove') or ui.t('Add'),
                    help = help, enabled = true, action = (saved and 'clear-preset-' or 'preset-') .. name}
            end
            presetRow('custom-preset-mistral', 'mistral', ui.t('Mistral'),
                ui.t('Copy your Mistral API key first, then press Add. It fills in the endpoint URL and the model ID for Mistral (Ministral 8B) and saves your key from the clipboard. The same key powers the Voxtral cloud voice.\n\nNew Mistral accounts may not get a free API key any more.'))
        end

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
            elseif message or state.keyForgotten or state.preset then info = ui.t('Not added') end
            local help
            if saved then
                help = ui.t('Deletes the saved key. Replies from the custom provider are then asked for without a key.')
                    .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.')
            else
                help = ui.t('Copy your API key from your provider first. It is read from the clipboard once and saved on this computer only. A server on your own computer, such as Ollama or LM Studio, usually needs no key.')
            end
            if message then help = message .. '\n\n' .. help
            elseif state.keyForgotten then help = ui.t('New address saved. Paste your API key again for it.') .. '\n\n' .. help
            end
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
                help = help .. '\n\n' .. ui.t('A model ID is a short name like that, not a web address.')
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

    -- What the one-time check of a key just added says (Add has the service try it with a tiny request), as the first paragraph of the key row's help; nil while it runs or when nothing was checked.
    local function checkSentence(check)
        if not check or check.state == 'checking' then return nil end
        if check.state == 'ok' then return ui.t('Google accepted the key.') end
        local code = check.code
        if code == 'key' then return ui.t('Google did not accept this key. Check it in Google AI Studio, then Remove it and Add the right one.') end
        if code == 'limit' or code == 'daily' then return ui.t('Google accepted the key, but the free allowance is used up for now.') end
        if code == 'region' then return ui.t('The key is saved, but Google Gemini is not available in your region.') end
        return ui.t('The key is saved, but Google could not be reached to check it.')
    end
    function self.keyCheckSentence(check) return checkSentence(check) end

    -- The one row of the Google Gemini page: the key (Add reads it from the clipboard, fills in the fixed endpoint and model and has the key tried once; Remove deletes all three).
    function self.geminiRows()
        local state = self.state()
        local result, check = state.result, state.check
        local rows = {}
        local saved = state.preset == 'gemini' and state.keySaved
        local message = failure(result, 'preset') or (saved and checkSentence(check) or nil)
        local info = saved and (check and check.state == 'checking' and ui.t('Checking…') or (state.tail and ('…' .. state.tail) or ui.t('Added'))) or (message and ui.t('Not added') or nil)
        local help = saved and (ui.t('Deletes the saved key.') .. '\n\n' .. ui.t('Saved on this computer only. Only the last four characters are ever shown.'))
            or ui.t('Copy your key from Google AI Studio first (aistudio.google.com/apikey, a Google account is enough, no card). It is read from the clipboard once and saved on this computer.\n\nThe free plan has a daily limit of about 500 replies, is not offered in every country, and Google may use free-plan chats to improve its products.')
        if message then help = message .. '\n\n' .. help end
        rows[#rows + 1] = {id = 'gemini-key', field = 'preset', label = ui.t('Google Gemini API key') .. (info and (' (' .. info .. ')') or ''),
            value = saved and ui.t('Remove') or ui.t('Add'), help = help, enabled = true, action = saved and 'clear-preset-gemini' or 'preset-gemini'}
        return rows
    end

    -- The last paragraph of the provider row's help while Custom answers and a limit is on (the stored `limit` of the provider state).
    function self.noteFor(limit)
        if limit == 'rate' then return ui.t('Custom: rate limited for now') end
        if limit == 'daily' then return ui.t('Custom: free daily limit reached') end
        if limit == 'invalid' then return ui.t('Custom: key not accepted') end
        if limit == 'model' then return ui.t('Custom: model unavailable') end
        if limit == 'credits' then return ui.t('Custom: out of credits') end
        return nil
    end

    -- The same for Google Gemini.
    function self.geminiNoteFor(limit)
        if limit == 'rate' then return ui.t('Google Gemini: rate limited for a minute') end
        if limit == 'daily' then return ui.t('Google Gemini: free allowance used up for today') end
        if limit == 'invalid' then return ui.t('Google Gemini: key not accepted') end
        if limit == 'region' then return ui.t('Google Gemini: not available in your region') end
        if limit == 'model' then return ui.t('Google Gemini: model unavailable') end
        return nil
    end

    -- The same while Custom is chosen but not set up, so Convai answers.
    function self.notSetUpNote() return ui.t('Convai: the custom provider is not set up yet') end

    -- The text of one of the notices (NOTICE_IDS), or nil.
    function self.notice(id, resetTime)
        if id == 'custom-key' then return ui.t('The custom provider did not accept your key. Check it in Settings > Conversation provider.') end
        if id == 'custom-credits' then return ui.t('The custom provider says your account is out of credits. Add credits there, then try again.') end
        if id == 'custom-model' then return ui.t('The custom provider does not know that model ID. Check it in Settings.') end
        if id == 'custom-limit' then return ui.t('The custom provider is rate limiting you. Try again in a moment.') end
        -- `resetTime` ("HH:MM" on this computer's clock): when the daily limit resets, if the endpoint said.
        if id == 'custom-daily' then
            if resetTime and tostring(resetTime):match('^%d%d:%d%d$') then return ui.t('The free daily limit for this model was reached. It resets at {time}.', {time = timeOf(resetTime)}) end
            return ui.t('The free daily limit for this model was reached. Try again after it resets.')
        end
        if id == 'custom-reasoning' then return ui.t('This model spends its reply on thinking. Choose a non-reasoning model in Settings.') end
        if id == 'custom-unreachable' then return ui.t('The custom provider did not answer. Check its address in Settings, or try again.') end
        if id == 'custom-no-setup' then return ui.t('The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.') end
        if id == 'custom-voice' then return ui.t('Custom provider replies are spoken by a local voice instead of the Convai cloud voice.') end
        if id == 'gemini-no-key' then return ui.t('Google Gemini has no key yet, so Convai is used. Add your key in Settings > Conversation provider.') end
        if id == 'gemini-voice' then return ui.t('Google Gemini replies are spoken by a local voice instead of the Convai cloud voice.') end
        if id == 'gemini-key' then return ui.t('Google did not accept your Gemini key. Check it in Google AI Studio and add it again.') end
        if id == 'gemini-daily' then
            if resetTime and tostring(resetTime):match('^%d%d:%d%d$') then return ui.t('Your free Gemini allowance for today is used up. It resets at {time}. Use Convai or Local AI.', {time = timeOf(resetTime)}) end
            return ui.t('Your free Gemini allowance for today is used up. It resets tomorrow. Use Convai or Local AI.')
        end
        if id == 'gemini-limit' then return ui.t('Google Gemini is rate limiting you. Wait a minute, then try again.') end
        if id == 'gemini-region' then return ui.t('Google Gemini is not available in your region. Use Convai or Local AI.') end
        if id == 'gemini-server' then return ui.t('Google Gemini is busy or had an error. Wait a minute, then try again.') end
        if id == 'gemini-unreachable' then return ui.t('Google Gemini could not be reached. Check your internet connection, then try again.') end
        if id == 'gemini-model' then return ui.t('The Gemini model is not available right now. Try again later or use Local AI.') end
        return nil
    end

    -- The latest command sent ({id, action}), for the page's own bookkeeping and for tests.
    function self.lastCommand() return sent and {id = sent.id, action = sent.action} or nil end

    return self
end

return M
