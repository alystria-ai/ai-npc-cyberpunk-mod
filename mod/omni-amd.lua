-- Settings > Voices > OmniVoice for AMD (docs/OMNIVOICE_AMD.md): the one-button setup of OmniVoice on an AMD Radeon card. The mod downloads AMD's own ROCm PyTorch into its data
-- folder and the OmniVoice pack uses it. The MIOpen choice is an ordinary saved setting (`amdMiopen`, mod/manager.lua); this file keeps what the page needs to know about the
-- setup, in one place, so the page only draws rows.
--
--   * It writes one small command file when the player chooses something (runtime/omni-amd-command.json): install, cancel and remove.
--   * It reads the status file the service answers in (runtime/omni-amd-state.json), at most every 1.5 s and only when the page asks for it: nothing here runs per frame and
--     nothing is read while no page is drawn.
--   * It turns that state into rows with no widget in them (rows(): id, label, value, help, enabled, action), so the same rows can be drawn by the Companion Manager page
--     (mod/manager-ui.lua, shown by mod/nsui.lua) and by any other settings screen later.
--
-- Only the answer to the latest command counts: a finished job of an older command id is never shown. A job that is still running is always shown, so opening the page in the
-- middle of the download shows its progress.
local M = {version = 1}

local COMMAND, STATE = 'runtime/omni-amd-command.json', 'runtime/omni-amd-state.json'
local READ_EVERY = 1.5
local ACTIONS = {install = true, cancel = true, remove = true}
local JOB_ACTIONS = {install = true, remove = true}
local RUNNING = {checking = true, downloading = true, unpacking = true, testing = true}
local JOB_STATES = {checking = true, downloading = true, unpacking = true, testing = true, done = true, failed = true, cancelled = true, removed = true}
local CODES = {['no-pack'] = true, ['not-amd'] = true, ['unsupported-card'] = true, ['no-space'] = true, ['download-failed'] = true, checksum = true,
    ['unpack-failed'] = true, ['test-failed'] = true, busy = true, ['not-ready'] = true, cancelled = true}
local TEST_STATES = {used = true, refused = true, testing = true}
local BACKENDS = {rocm = true, cuda = true, none = true}

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
    if value:find('%c') then return nil end
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

-- Mebibytes as gigabytes with one decimal ("1.4").
local function gigabytes(mib)
    if type(mib) ~= 'number' or mib <= 0 then return nil end
    return string.format('%.1f', mib / 1024)
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
        local job, test
        local j = value.job
        if type(j) == 'table' and JOB_ACTIONS[j.action] and JOB_STATES[j.state] and type(j.id) == 'string' then
            local running = RUNNING[j.state] == true
            if running or (sent and j.id == sent.id) then
                local total = whole(j.totalMiB, 10000000)
                local done = whole(j.doneMiB, 10000000)
                if total and done and done > total then done = total end
                job = {id = j.id, action = j.action, state = j.state, running = running, doneMiB = done, totalMiB = total,
                    code = j.state == 'failed' and (CODES[j.code] and j.code or 'unknown') or nil}
            end
        end
        local t = value.test
        if type(t) == 'table' and TEST_STATES[t.state] then
            test = {state = t.state, backend = BACKENDS[t.backend] and t.backend or nil, device = text(t.device, 80),
                vramMiB = whole(t.vramMiB, 10000000)}
        end
        return {available = value.version == 1, offered = value.offered == true, installed = value.installed == true,
            arch = text(value.arch, 30, '^[%w_]+$'), card = text(value.card, 80),
            downloadMiB = whole(value.downloadMiB, 10000000), diskMiB = whole(value.diskMiB, 10000000),
            ownPython = value.ownPython == true, job = job, test = test, action = sent and sent.action or nil}
    end

    -- Whether the Voices page offers the setup at all: an AMD Radeon card and the OmniVoice pack, or a setup that is already on disk.
    function self.visible(force)
        local state = self.state(force)
        return state.available and (state.offered or state.installed)
    end

    -- One line for the settings page's redraw check: it changes when anything the rows show changes.
    function self.signature()
        local state = self.state()
        local job, test = state.job, state.test
        return table.concat({tostring(state.available), tostring(state.offered), tostring(state.installed), state.card or '',
            tostring(state.downloadMiB), tostring(state.diskMiB), tostring(state.ownPython),
            job and table.concat({job.id, job.action, job.state, tostring(job.doneMiB), tostring(job.totalMiB), job.code or ''}, '/') or '',
            test and table.concat({test.state, test.backend or '', test.device or '', tostring(test.vramMiB)}, '/') or ''}, '|')
    end

    -- Sends one command (see the top of this file). Returns ok, message; a command that could not be written returns false and a sentence.
    function self.request(action)
        if not ACTIONS[action] then return false, ui.t('The request could not be sent. Try again.') end
        counter = counter + 1
        local id = sessionId() .. ':amd:' .. tostring(counter)
        local payload = {version = 1, id = id, action = action, issuedAt = os.time() * 1000.0}
        local ok, done = pcall(writeCommand, COMMAND, payload)
        if not (ok and done == true) then return false, ui.t('The request could not be sent. Try again.') end
        sent = {id = id, action = action, at = clock()}
        readAt = nil
        if action == 'cancel' then return true, ui.t('Cancelling…') end
        if action == 'remove' then return true, ui.t('Removing the AMD setup…') end
        return true, ui.t('Starting the AMD setup…')
    end

    -- The plain sentence for a failed job's code.
    local function failureSentence(code)
        if code == 'no-pack' then return ui.t('The OmniVoice pack is not installed. Install it first.') end
        if code == 'not-amd' then return ui.t('This PC has no AMD Radeon card this setup can use.') end
        if code == 'unsupported-card' then return ui.t('AMD’s ROCm PyTorch does not support this card yet.') end
        if code == 'no-space' then return ui.t('There is not enough free space on drive C:. Free some up and try again.') end
        if code == 'download-failed' then return ui.t('The download did not finish. Check your connection and try again.') end
        if code == 'checksum' then return ui.t('The downloaded files did not check out. Try again.') end
        if code == 'unpack-failed' then return ui.t('The files could not be unpacked. Try again.') end
        if code == 'test-failed' then return ui.t('The setup did not pass the test on your card, so OmniVoice cannot use it.') end
        if code == 'busy' then return ui.t('Another setup is already running. Wait for it to finish.') end
        if code == 'not-ready' then return ui.t('The download is not ready yet in this version of the mod.') end
        if code == 'cancelled' then return ui.t('Cancelled.') end
        return ui.t('The setup did not finish. Try again.')
    end

    -- The live status: {first = the first paragraph of the help, info = the short word in brackets after the row's name, failed = whether the last job failed}.
    local function status(state)
        local job, test = state.job, state.test
        local card = state.card or ui.t('your AMD card')
        if job then
            if job.state == 'checking' then return {first = ui.t('Checking your card…'), info = ui.t('Checking…')} end
            if job.state == 'downloading' then
                if job.totalMiB and job.totalMiB > 0 then
                    local done = job.doneMiB or 0
                    local percent = math.max(0, math.min(100, math.floor(done * 100 / job.totalMiB)))
                    return {first = ui.t('Downloading {done} of {total} MB ({percent}%)', {done = done, total = job.totalMiB, percent = percent}),
                        info = tostring(percent) .. '%'}
                end
                return {first = ui.t('Downloading…'), info = ui.t('Downloading…')}
            end
            if job.state == 'unpacking' then return {first = ui.t('Unpacking…'), info = ui.t('Unpacking…')} end
            if job.state == 'testing' then return {first = ui.t('Testing it on your card…'), info = ui.t('Testing…')} end
            if job.state == 'removed' or (job.state == 'done' and job.action == 'remove') then
                return {first = ui.t('The AMD setup was removed.')}
            end
            if job.state == 'done' then
                return {first = ui.t('Ready. OmniVoice runs on {card} with AMD’s ROCm.', {card = card}), info = ui.t('Ready')}
            end
            if job.state == 'cancelled' then return {first = ui.t('Cancelled.'), info = ui.t('Cancelled')} end
            if job.state == 'failed' then return {first = failureSentence(job.code), info = ui.t('Failed'), failed = true} end
        end
        if state.installed then
            if test and test.state == 'used' then return {first = ui.t('Ready. OmniVoice runs on {card} with AMD’s ROCm.', {card = card}), info = ui.t('Ready')} end
            if test and test.state == 'refused' then
                return {first = ui.t('The setup is installed but did not pass the test on your card. Choose Reinstall.'), info = ui.t('Failed'), failed = true}
            end
            if test and test.state == 'testing' then return {first = ui.t('Testing it on your card…'), info = ui.t('Testing…')} end
            return {first = ui.t('Installed. OmniVoice uses it when it starts.'), info = ui.t('Installed')}
        end
        return {}
    end

    -- The rows, in the order they are drawn: {id, label, value, help, enabled, action}. `action` is what choosing the row sends through request(). The texts are
    -- already translated.
    function self.rows()
        local state = self.state()
        local job = state.job
        local running = job ~= nil and job.running
        local shown = status(state)
        local rows = {}

        -- What the download is and what it needs: the same under every status.
        local size, disk = gigabytes(state.downloadMiB), gigabytes(state.diskMiB)
        local explanation = {}
        explanation[#explanation + 1] = size and ui.t('One download of about {size} GB.', {size = size}) or ui.t('One download.')
        explanation[#explanation + 1] = disk and ui.t('It takes about {disk} GB on drive C: in the mod’s data folder.', {disk = disk})
            or ui.t('It is kept in the mod’s data folder on drive C:.')
        explanation[#explanation + 1] = ui.t('It runs in the background while you play. The game keeps running and nothing else changes.')
        local why = table.concat(explanation, ' ') .. '\n\n' .. ui.t('Experimental. Pocket speaks until it is ready. A local voice never switches to a cloud voice.')

        local first = shown.first
        local info = shown.info
        local enabled, value, action = true, ui.t('Install'), 'install'
        if running then
            value, action = ui.t('Cancel'), 'cancel'
        elseif state.installed or shown.failed then
            value = ui.t('Reinstall')
        end
        if not state.available then
            first, enabled = ui.t('The conversation service is not running. Restart the game.'), false
        elseif state.ownPython and not running then
            first = ui.t('Your own Python (omni-python.txt) is used instead. Delete that file to use this setup.')
            info, enabled = ui.t('Own Python'), false
        elseif not (state.offered or state.installed) and not running then
            first, enabled = ui.t('Not available on this PC. It needs an AMD Radeon card and the OmniVoice pack.'), false
        end
        local help = first and (first .. '\n\n' .. why) or why
        rows[#rows + 1] = {id = 'omni-amd-setup', label = ui.t('Set up OmniVoice for AMD') .. (info and (' (' .. info .. ')') or ''),
            value = value, help = help, enabled = enabled, action = action}

        -- Taking the setup off the drive again.
        if state.available and state.installed and not running then
            local freed = disk and ui.t('Frees about {disk} GB.', {disk = disk}) or ui.t('Frees the space it took.')
            rows[#rows + 1] = {id = 'omni-amd-remove', label = ui.t('Remove AMD setup'), value = ui.t('Remove'),
                help = freed .. ' ' .. ui.t('OmniVoice then no longer starts on this card until it is set up again.'), enabled = true, action = 'remove'}
        end
        return rows
    end

    -- The latest command sent ({id, action}), for the page's own bookkeeping and for tests.
    function self.lastCommand() return sent and {id = sent.id, action = sent.action} or nil end

    return self
end

return M
