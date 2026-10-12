-- Optional native core (red4ext/plugins/CyberpunkConvaiNative). When the plugin is loaded and
-- its "io" switch is on, the bridge mailbox, lease and log files listed below go through it:
-- a CET io.open costs about 3 ms of the game thread, os.rename about 4.8 ms (perf probe
-- 2026-10-11); a native call costs microseconds and a worker thread does the disk work.
-- Without the plugin nothing here changes anything: io and os stay the game's own tables.
--
-- Routing (whitelisted runtime/<name> files only, everything else uses the real io):
--   io.open(path, 'w'/'wb')  buffers; close() queues an atomic replace of the file.
--   io.open(tmp, 'wb') + os.rename(tmp, path)  the temp file never touches disk; the rename
--                            becomes one atomic replace of path (os.remove(path) before it is a no-op).
--   io.open(path, 'r'/'rb')  the worker's latest copy (it polls the file); a Lua string is reused
--                            until the file's revision changes. A missing file returns nil.
--   io.open(log, 'a')        buffered appends, flushed by the worker every 0.5 s.
-- Kill switch: a line "io" or "all" in runtime/native-off.txt (convaiNative.off('io')). Three
-- faults inside the plugin's io natives also switch it off. Every change logs one probe.log line.
local M = {API = 1}

-- Read by the bridge, polled by the worker every N ms (the Lua readers ran at about this rate).
local READS = {
    ['continuous-speech.json'] = 15, ['continuous-face.json'] = 30, ['speech-stream.json'] = 30,
    ['reply.json'] = 30, ['microphone-heard.json'] = 50, ['microphone-state.json'] = 50,
    ['companion-actions.json'] = 50, ['phone-chat-output.json'] = 50,
    ['audio-delay.json'] = 250, ['memory-chat-resets.json'] = 250, ['diagnostic-request.txt'] = 250,
    ['companion-invitations-state.json'] = 250, ['bridge-service.json'] = 250, ['knowledge-status.json'] = 250,
    ['local-voice-state.json'] = 250, ['memory-status.json'] = 250, ['own-key-state.json'] = 250,
    ['mistral-state.json'] = 250, ['party-connection-state.json'] = 250,
}
-- Written by the mod (in place or through name.tmp + rename).
local WRITES = {
    'world-session.json', 'party-connections.json', 'companion-invitations.json', 'relationship-state.json',
    'nearby-connections.json', 'speech-state.json', 'phone-chat-input.json', 'phone-history.json',
    'continuous-control.json', 'last-input.json', 'reaction-lease.json', 'battle-cancellations.json',
    'group-prefetch.json', 'conversation-prewarm.json', 'knowledge-phone-delivery.json',
    'microphone-command.json', 'diagnostic-response.txt',
}
local APPENDS = {['probe.log'] = true, ['mcm.log'] = true}
local ROUTED = {}
for name in pairs(READS) do ROUTED[name] = true end
for _, name in ipairs(WRITES) do ROUTED[name] = true end
for name in pairs(APPENDS) do ROUTED[name] = true end
M.routed = ROUTED

local SWITCH_RECHECK = 0.5 -- seconds between SystemEnabled checks

-- runtime/<name>, runtime/<name>.tmp and runtime/<name>.previous for a routed name.
local function channelOf(path)
    if type(path) ~= 'string' then return nil end
    local name = path:gsub('\\', '/'):gsub('^%./', ''):match('^runtime/([%w][%w%._%-]*)$')
    if not name or name:find('..', 1, true) then return nil end
    local base = name:gsub('%.tmp$', ''):gsub('%.previous$', '')
    if not ROUTED[base] then return nil end
    return name, base
end
M.channelOf = channelOf

-- A file object over a string, enough of Lua's file API for the readers in this mod.
local unpack = table.unpack or unpack
local Reader = {}
Reader.__index = Reader
local function newReader(content) return setmetatable({content = content, pos = 1}, Reader) end
local function readOne(self, format)
    local content, pos = self.content, self.pos
    if type(format) == 'number' then
        if pos > #content then return nil end
        if format <= 0 then return '' end
        local piece = content:sub(pos, pos + format - 1); self.pos = pos + #piece; return piece
    end
    format = tostring(format or '*l'):gsub('^%*', '')
    local kind = format:sub(1, 1)
    if kind == 'a' then self.pos = #content + 1; return content:sub(pos) end
    if kind == 'l' or kind == 'L' then
        if pos > #content then return nil end
        local stop = content:find('\n', pos, true)
        local line = content:sub(pos, stop or #content)
        self.pos = (stop or #content) + 1
        if kind == 'l' then line = line:gsub('\r?\n$', '') end
        return line
    end
    if kind == 'n' then
        local from, to = content:find('^%s*[-+]?%d*%.?%d+[eE]?[-+]?%d*', pos)
        if not from then return nil end
        self.pos = to + 1; return tonumber(content:sub(from, to))
    end
    error("bad argument #1 to 'read' (invalid format)", 3)
end
function Reader:read(...)
    if self.closed then return nil, 'attempt to use a closed file' end
    local count = select('#', ...)
    if count == 0 then return readOne(self, '*l') end
    local results = {}
    for index = 1, count do
        results[index] = readOne(self, (select(index, ...)))
        if results[index] == nil then return unpack(results, 1, index) end
    end
    return unpack(results, 1, count)
end
function Reader:lines(format) return function() return self:read(format or '*l') end end
function Reader:seek(whence, offset)
    whence, offset = whence or 'cur', offset or 0
    local base = whence == 'set' and 0 or whence == 'end' and #self.content or self.pos - 1
    self.pos = math.max(0, math.min(#self.content, base + offset)) + 1
    return self.pos - 1
end
function Reader:close() self.closed = true; return true end
function Reader:flush() return self end
function Reader:setvbuf() return true end
function Reader:write() return nil, 'file opened for reading' end

-- A file object that collects writes; close() hands the bytes to a commit function.
local Writer = {}
Writer.__index = Writer
local function newWriter(commit) return setmetatable({parts = {}, commit = commit}, Writer) end
function Writer:write(...)
    if self.closed then return nil, 'attempt to use a closed file' end
    for index = 1, select('#', ...) do
        local value = select(index, ...)
        local kind = type(value)
        if kind == 'number' then value = tostring(value)
        elseif kind ~= 'string' then
            error("bad argument #" .. index .. " to 'write' (string expected, got " .. kind .. ")", 2)
        end
        self.parts[#self.parts + 1] = value
    end
    return self
end
function Writer:close()
    if self.closed then return nil, 'attempt to use a closed file' end
    self.closed = true
    return self.commit(table.concat(self.parts))
end
function Writer:flush() return self end
function Writer:setvbuf() return true end
function Writer:seek() return 0 end
function Writer:read() return nil, 'file opened for writing' end
function Writer:lines() return function() return nil end end

-- options (tests): core, io (the native tables), realIo, realOs, clock, print, date.
function M.install(options)
    options = options or {}
    if type(convaiNative) == 'table' and convaiNative.installed then return convaiNative end
    local realIo, realOs = options.realIo or io, options.realOs or os
    local realOpen, realRename, realRemove = realIo.open, realOs.rename, realOs.remove
    local clock = options.clock or os.clock
    local say = options.print or print
    local date = options.date or os.date
    local api = {installed = true, plugin = nil, reason = nil}
    convaiNative = api

    -- CET resolves a native class by its global name; without the plugin the name is nil.
    local Core, Io = options.core, options.io
    if Core == nil then local ok, value = pcall(function() return ConvaiNative end); Core = ok and value or nil end
    if Io == nil then local ok, value = pcall(function() return ConvaiNativeIo end); Io = ok and value or nil end

    local open -- the routed io.open, set below once the plugin checks out
    local function log(line)
        local ok = pcall(function()
            local file = (open or realOpen)('runtime/probe.log', 'a')
            if file then file:write(date('!%Y-%m-%dT%H:%M:%SZ'), ' ', line, '\n'); file:close() end
        end)
        pcall(say, '[CyberpunkConvai] ' .. line)
        return ok
    end

    -- Plugin present and the same API?
    local present, reason = false, nil
    if type(Core) ~= 'table' and type(Core) ~= 'userdata' then
        reason = 'plugin not loaded'
    else
        local ok, compatible = pcall(function() return Core.CheckVersion(M.API) end)
        if not ok then reason = 'CheckVersion failed: ' .. tostring(compatible)
        elseif compatible ~= true then reason = 'plugin API differs or its file worker is not running'
        else present = true end
        if present then
            local okVersion, version = pcall(function() return Core.PluginVersion() end)
            api.plugin = okVersion and tostring(version) or '?'
        end
    end
    api.present = present

    -- Systems: native only while the plugin is present and the system's switch is on.
    local systems = {}
    local function evaluate(system)
        local row = systems[system]
        if not row then row = {on = nil, next = -math.huge}; systems[system] = row end
        local now = clock()
        if now < row.next then return row.on end
        row.next = now + SWITCH_RECHECK
        local on, why = false, reason or 'plugin not loaded'
        if present then
            local ok, enabled = pcall(function() return Core.SystemEnabled(system) end)
            if not ok then why = 'switch check failed: ' .. tostring(enabled)
            elseif enabled ~= true then why = 'off (runtime/native-off.txt or tripped by faults)'
            else on = true end
        end
        if row.on ~= on then
            local first = row.on == nil
            row.on = on
            if row.onChange then pcall(row.onChange, on) end
            log('Native core: ' .. system .. '=' .. (on and ('native (plugin ' .. tostring(api.plugin) .. ', api '
                .. M.API .. ')') or ('lua (' .. why .. ')')) .. (first and '' or ' [changed]'))
        end
        return on
    end
    -- A native call failed in Lua (missing function, bad argument): this system stays on Lua.
    local function fail(system, detail)
        local row = systems[system] or {}
        systems[system] = row
        row.next = math.huge
        if row.on ~= false then
            row.on = false
            if row.onChange then pcall(row.onChange, false) end
            log('Native core: ' .. system .. '=lua (native call failed: ' .. tostring(detail) .. ')')
        end
    end
    api.use = function(system) return evaluate(system) == true end
    api.fail = fail
    api.onChange = function(system, callback)
        systems[system] = systems[system] or {on = nil, next = -math.huge}
        systems[system].onChange = callback
    end
    api.status = function()
        if not present then return '{"present":false,"reason":"' .. tostring(reason):gsub('"', "'") .. '"}' end
        local ok, text = pcall(function() return Core.Status() end)
        return ok and text or nil
    end
    api.probe = function()
        if not present then return nil end
        local ok, text = pcall(function() return Core.GameProbe() end)
        return ok and text or nil
    end
    local function editSwitches(system, off)
        local names, seen = {}, false
        local file = realOpen('runtime/native-off.txt', 'rb')
        if file then
            for line in (file:read('*a') or ''):gmatch('[^\r\n]+') do
                local name = line:match('^%s*(.-)%s*$')
                if name == system then seen = true end
                if name ~= '' and (name ~= system or off) then names[#names + 1] = name end
            end
            file:close()
        end
        if off and not seen then names[#names + 1] = system end
        file = realOpen('runtime/native-off.txt', 'wb')
        if not file then return false end
        file:write(table.concat(names, '\n'), #names > 0 and '\n' or ''); file:close()
        for _, row in pairs(systems) do row.next = -math.huge end
        return true
    end
    api.off = function(system) return editSwitches(tostring(system or 'all'), true) end
    api.on = function(system) return editSwitches(tostring(system or 'all'), false) end

    if not present then
        evaluate('io')
        return api
    end

    -- The plugin must be watching this mod's runtime folder (it derives the path from the game
    -- folder and the mod folder name). One real read at load proves it.
    local nonce = 'native-handshake ' .. tostring(clock()) .. ' ' .. tostring(math.random(100000000, 999999999))
    local matched = pcall(function()
        assert(Io.Write('native-handshake.txt', nonce) == true)
        Io.Flush(500)
        local file = realOpen('runtime/native-handshake.txt', 'rb')
        local text = file and file:read('*a'); if file then file:close() end
        Io.Remove('native-handshake.txt')
        assert(text == nonce)
    end)
    if not matched then
        present, reason = false, 'the plugin writes to a different runtime folder'
        api.present = false
        evaluate('io')
        return api
    end

    -- io routing -------------------------------------------------------------------------------
    local held = {}     -- name.tmp -> bytes written but not yet renamed into place
    local cache = {}    -- channel -> {revision, content}
    local watched = {}
    local function native(fn, ...)
        local ok, result = pcall(fn, ...)
        if not ok then fail('io', result); return nil end
        return result
    end
    local function ioActive() return evaluate('io') == true end
    api.onChange('io', function(on)
        if not on then pcall(function() Io.Flush(500) end) end
        cache = {}
    end)

    -- Bytes for a routed file: the worker, or the real file if the native call fails.
    local function store(path, name, text)
        if ioActive() and native(Io.Write, name, text) == true then return true end
        local file = realOpen(path, 'wb')
        if not file then return nil, 'Cannot write ' .. path end
        local written = file:write(text)
        return file:close() and written and true or nil
    end

    local function nativeRead(path, name)
        if not watched[name] then
            watched[name] = true
            native(Io.Watch, name, READS[name] or 250, name:sub(-5) == '.json')
        end
        local revision = native(Io.Revision, name)
        if type(revision) ~= 'number' or revision == 0 then return realOpen(path, 'rb') end
        if revision < 0 then cache[name] = nil; return nil, path .. ': No such file or directory', 2 end
        local row = cache[name]
        if not row or row.revision ~= revision then
            local content = native(Io.Read, name)
            if type(content) ~= 'string' then return realOpen(path, 'rb') end
            local after = native(Io.Revision, name)
            row = {revision = after == revision and revision or nil, content = content}
            cache[name] = row
        end
        return newReader(row.content)
    end

    open = function(path, mode, ...)
        local name, base = channelOf(path)
        local kind = type(mode) == 'string' and mode or 'r'
        if not name then return realOpen(path, mode, ...) end
        -- A held temp file reads back its bytes, whatever the switch says.
        if held[name] and kind:sub(1, 1) == 'r' then return newReader(held[name]) end
        if not ioActive() or kind:find('+', 1, true) then return realOpen(path, mode, ...) end
        local first = kind:sub(1, 1)
        if first == 'w' then
            if name ~= base then -- name.tmp / name.previous: hold the bytes until the rename
                return newWriter(function(text) held[name] = text; return true end)
            end
            return newWriter(function(text) return store(path, name, text) end)
        elseif first == 'a' then
            if not APPENDS[name] then native(Io.Flush, 200); return realOpen(path, mode, ...) end
            return newWriter(function(text)
                if text == '' or native(Io.Append, name, text) == true then return true end
                local file = realOpen(path, 'ab'); if not file then return nil end
                file:write(text); return file:close()
            end)
        elseif first == 'r' then
            if APPENDS[name] then native(Io.Flush, 200); return realOpen(path, mode, ...) end
            return nativeRead(path, name)
        end
        return realOpen(path, mode, ...)
    end

    local function rename(from, to, ...)
        local fromName = channelOf(from)
        local toName = channelOf(to)
        if fromName and held[fromName] then
            local text = held[fromName]; held[fromName] = nil
            if toName then return store(to, toName, text) end
            local file = realOpen(to, 'wb'); if not file then return nil, 'Cannot write ' .. tostring(to) end
            file:write(text); return file:close() and true or nil
        end
        if fromName and toName and ioActive() and native(Io.Rename, fromName, toName) == true then return true end
        if (fromName or toName) and ioActive() then native(Io.Flush, 200) end
        return realRename(from, to, ...)
    end

    local function remove(path, ...)
        local name = channelOf(path)
        if name and held[name] then held[name] = nil; return true end
        if name and ioActive() and native(Io.Remove, name) == true then return true end
        return realRemove(path, ...)
    end

    -- New tables in this mod's environment; the game's io and os tables are never changed.
    io = setmetatable({open = open}, {__index = realIo})
    os = setmetatable({rename = rename, remove = remove}, {__index = realOs})
    api.realIo, api.realOs = realIo, realOs
    api.flush = function(timeoutMs) return native(Io.Flush, timeoutMs or 500) == true end
    api.held = function() local count = 0; for _ in pairs(held) do count = count + 1 end; return count end
    evaluate('io')
    return api
end

return M
