-- On-demand Lua heap report (runtime/lua-heap.json). Never per frame: init.lua loads and runs this file only when the
-- developer mailbox (runtime/diagnostic-request.txt) holds a new 'lua-heap:<nonce>' request (scripts/Request-LuaHeap.ps1),
-- and nothing of it stays loaded afterwards except the report on disk.
--
-- What it reports:
--   * heapBeforeKB: collectgarbage('count') as the request arrived. CET runs every mod in ONE Lua state, so this is the
--     whole state (every CET mod, CET's own bindings) plus garbage not yet collected: the figure perf-probe.json's luaKB shows.
--   * heapAfterKB: the same after one full collect (collectMs says how long that took). This is what is really held.
--     'lua-heap:count:<nonce>' skips the collect (no pause) and reports heapBeforeKB only.
--   * modKB and roots[]: an estimate of the bytes reachable from this mod's own tables (its convai* globals and the roots
--     init.lua passes in), by root and by the largest first-level fields, plus the largest single tables. Sizes follow
--     LuaJIT 2.1's 64-bit object layout, checked against a real LuaJIT 2.1 (GC64) on this mod's data: the estimate lands
--     within about 15 % of the real figure. Compiled code (about 3 MB for this mod, measured offline) and userdata payloads
--     are not counted. otherKB = heapAfterKB - modKB: other mods, CET, and this mod's compiled code.
--   * loadsAlive: how many loads of this mod are still in memory after the collect. Each request registers its load (a module
--     table of that load, as a weak key) in a registry kept on the string metatable, the one table every mod and every CET
--     reload shares. 1 is right; 2 or more after a 'Reload all mods' means an earlier load's whole environment is still held.
--   * history: the previous reports (the last 12, kept in the file), so the heap after each CET reload or load can be compared.
-- The walk stops after NODE_CAP objects or TIME_CAP seconds (truncated = true).
local M = {version = 1}

local RESULT = 'runtime/lua-heap.json'
local KEEP_REPORTS, TOP_TABLES, TOP_FIELDS = 12, 15, 25
local NODE_CAP, TIME_CAP = 4000000, 3.0
-- LuaJIT 2.1 GC64 sizes in bytes (lj_obj.h, measured): GCtab, TValue array slot, hash Node, GCstr header + NUL (rounded to
-- 8 B, plus about 12 B of the string intern table), GCfuncL with its first upvalue ref, each further ref, GCupval, and a
-- rough userdata (GCudata header plus a small CET payload).
local TAB, SLOT, NODE, STR, STRTAB, FUNC, UPREF, UPVAL, UDATA = 64, 8, 24, 25, 12, 40, 8, 48, 64

local function pow2(n)
    local p = 1
    while p < n do p = p * 2 end
    return p
end
local function strBytes(text) return 8 * math.ceil((STR + #text) / 8) + STRTAB end

-- Estimated bytes of the table object itself (not its contents) and its entry count.
local function tableBytes(t)
    local border = rawget(t, 1) ~= nil and #t or 0
    local hash, count = 0, 0
    for key in next, t do
        count = count + 1
        if not (type(key) == 'number' and key >= 1 and key <= border and key % 1 == 0) then hash = hash + 1 end
    end
    local bytes = TAB
    if border > 0 then bytes = bytes + SLOT * (pow2(border) + 1) end
    if hash > 0 then bytes = bytes + NODE * pow2(hash) end
    return bytes, count
end

local function label(key)
    local kind = type(key)
    if kind == 'string' then return #key <= 40 and key or (key:sub(1, 37) .. '...') end
    if kind == 'number' then return '[' .. tostring(key) .. ']' end
    return '<' .. kind .. '>'
end

-- Tables shared by every mod (the standard library, CET's own globals): never walked or counted.
local function sharedSet()
    local shared = {}
    local names = {'_G', 'string', 'table', 'math', 'io', 'os', 'coroutine', 'debug', 'package', 'bit', 'bit32', 'jit',
        'ffi', 'utf8', 'json', 'Game', 'GameUI', 'Observe', 'Override', 'ObserveAfter', 'ObserveBefore'}
    for _, name in ipairs(names) do
        local ok, value = pcall(function() return _G[name] end)
        if ok and type(value) == 'table' then
            shared[value] = true
            if name ~= '_G' then for _, member in next, value do if type(member) == 'table' then shared[member] = true end end end
        end
    end
    local ok, meta = pcall(getmetatable, '')
    if ok and type(meta) == 'table' then shared[meta] = true end
    return shared
end

-- roots: an ordered list of {name, value}. Each object is counted once, for the first root (and first-level field) that
-- reaches it. Returns {totalBytes, roots = {...}, fields = {...}, tables = {...}, nodes, truncated}.
function M.walk(roots, options)
    options = options or {}
    local clock = options.clock or os.clock
    local started = clock()
    local cap, timeCap = options.nodeCap or NODE_CAP, options.timeCap or TIME_CAP
    local seen = sharedSet()
    local getupvalue = type(debug) == 'table' and debug.getupvalue or nil
    local upvalueid = type(debug) == 'table' and debug.upvalueid or nil
    local seenUp = {}
    local nodes, truncated, total = 0, false, 0
    local rootBytes, fieldBytes, fieldNames, largest = {}, {}, {}, {}
    -- The walk's stack: three parallel arrays (value, bucket, path; path is false when the object is too deep to name).
    local values, buckets, paths, top = {}, {}, {}, 0
    local function push(value, bucket, path)
        top = top + 1
        values[top], buckets[top], paths[top] = value, bucket, path or false
    end
    local function charge(bucket, bytes, rootIndex)
        fieldBytes[bucket] = (fieldBytes[bucket] or 0) + bytes
        rootBytes[rootIndex] = (rootBytes[rootIndex] or 0) + bytes
        total = total + bytes
    end
    local function newBucket(name)
        local bucket = #fieldNames + 1
        fieldNames[bucket] = name
        return bucket
    end
    local function consider(path, bytes, count)
        if #largest < TOP_TABLES then largest[#largest + 1] = {path = path, bytes = bytes, entries = count}
        elseif bytes > largest[#largest].bytes then largest[#largest] = {path = path, bytes = bytes, entries = count}
        else return end
        table.sort(largest, function(a, b) return a.bytes > b.bytes end)
    end
    for rootIndex, root in ipairs(roots) do
        local name, value = root[1], root[2]
        local kind = type(value)
        if (kind == 'table' or kind == 'function') and not seen[value] then
            local rootBucket = newBucket(name)
            -- First-level string fields of a root table get their own buckets, so the report names the big ones; the
            -- elements of a list root (the profiles) share one bucket, name[].
            if kind == 'table' then
                seen[value] = true
                nodes = nodes + 1
                local bytes, count = tableBytes(value)
                charge(rootBucket, bytes, rootIndex)
                if bytes >= 4096 then consider(name, bytes, count) end
                local listBucket
                for key, member in next, value do
                    if type(key) == 'string' and not seen[key] then seen[key] = true; charge(rootBucket, strBytes(key), rootIndex) end
                    local memberKind = type(member)
                    if memberKind == 'table' or memberKind == 'function' then
                        if not seen[member] then
                            if type(key) == 'string' then
                                push(member, newBucket(name .. '.' .. label(key)), name .. '.' .. label(key))
                            else
                                listBucket = listBucket or newBucket(name .. '[]')
                                push(member, listBucket, name .. label(key))
                            end
                        end
                    elseif memberKind == 'string' and not seen[member] then
                        seen[member] = true; charge(rootBucket, strBytes(member), rootIndex)
                    end
                end
            else
                push(value, rootBucket, name)
            end
            while top > 0 do
                if nodes >= cap or clock() - started > timeCap then truncated = true; break end
                local item, bucket, path = values[top], buckets[top], paths[top]
                values[top], buckets[top], paths[top] = nil, nil, nil
                top = top - 1
                if not seen[item] then
                    seen[item] = true
                    nodes = nodes + 1
                    local itemKind = type(item)
                    if itemKind == 'table' then
                        local bytes, count = tableBytes(item)
                        charge(bucket, bytes, rootIndex)
                        if path and bytes >= 4096 then consider(path, bytes, count) end
                        local meta = getmetatable(item)
                        if type(meta) == 'table' and not seen[meta] then push(meta, bucket) end
                        for key, member in next, item do
                            local keyKind, memberKind = type(key), type(member)
                            if keyKind == 'string' then
                                if not seen[key] then seen[key] = true; charge(bucket, strBytes(key), rootIndex) end
                            elseif (keyKind == 'table' or keyKind == 'function') and not seen[key] then push(key, bucket)
                            elseif keyKind == 'userdata' and not seen[key] then seen[key] = true; charge(bucket, UDATA, rootIndex) end
                            if memberKind == 'string' then
                                if not seen[member] then seen[member] = true; charge(bucket, strBytes(member), rootIndex) end
                            elseif (memberKind == 'table' or memberKind == 'function') and not seen[member] then
                                -- A child keeps a path only while it is short: deep paths are not reported anyway.
                                push(member, bucket, path and #path < 120 and (path .. '.' .. label(key)) or nil)
                            elseif memberKind == 'userdata' and not seen[member] then seen[member] = true; charge(bucket, UDATA, rootIndex) end
                        end
                    elseif itemKind == 'function' then
                        local count = 0
                        if getupvalue then
                            for index = 1, 255 do
                                local okUp, upName, upValue = pcall(getupvalue, item, index)
                                if not okUp or upName == nil then break end
                                count = count + 1
                                local id = upvalueid and select(2, pcall(upvalueid, item, index)) or nil
                                if id == nil or not seenUp[id] then
                                    if id ~= nil then seenUp[id] = true end
                                    charge(bucket, UPVAL, rootIndex)
                                    local upKind = type(upValue)
                                    if upKind == 'string' then
                                        if not seen[upValue] then seen[upValue] = true; charge(bucket, strBytes(upValue), rootIndex) end
                                    elseif (upKind == 'table' or upKind == 'function') and not seen[upValue] then
                                        push(upValue, bucket, path and #path < 120 and (path .. '^' .. label(upName)) or nil)
                                    end
                                end
                            end
                        end
                        charge(bucket, FUNC + UPREF * math.max(count - 1, 0), rootIndex)
                    end
                end
            end
            if truncated then break end
        end
    end
    local rootRows, fieldRows = {}, {}
    for index, root in ipairs(roots) do
        if rootBytes[index] then rootRows[#rootRows + 1] = {name = root[1], kb = rootBytes[index] / 1024} end
    end
    table.sort(rootRows, function(a, b) return a.kb > b.kb end)
    for bucket, name in ipairs(fieldNames) do
        if fieldBytes[bucket] then fieldRows[#fieldRows + 1] = {name = name, kb = fieldBytes[bucket] / 1024} end
    end
    table.sort(fieldRows, function(a, b) return a.kb > b.kb end)
    while #fieldRows > TOP_FIELDS do fieldRows[#fieldRows] = nil end
    local tableRows = {}
    for index, row in ipairs(largest) do tableRows[index] = {path = row.path, kb = row.bytes / 1024, entries = row.entries} end
    return {totalBytes = total, roots = rootRows, fields = fieldRows, tables = tableRows, nodes = nodes, truncated = truncated,
        upvalues = getupvalue ~= nil, walkMs = 1000 * (clock() - started)}
end

-- This mod's globals: the known convai* names, read directly (this chunk runs in the mod's own CET environment, so a plain
-- global read finds them whatever _G is), then any other convai* name the environment table lists.
local function knownGlobals()
    return {
        {'convaiAddons', convaiAddons}, {'convaiAttentionProbe', convaiAttentionProbe},
        {'convaiAutoConnect', convaiAutoConnect}, {'convaiBattleReactions', convaiBattleReactions},
        {'convaiCloneRecordIds', convaiCloneRecordIds}, {'convaiCompanionAdoption', convaiCompanionAdoption},
        {'convaiCompanions', convaiCompanions}, {'convaiComposerInput', convaiComposerInput},
        {'convaiComposerWatch', convaiComposerWatch}, {'convaiDemandKnowledge', convaiDemandKnowledge},
        {'convaiExpressionFrame', convaiExpressionFrame}, {'convaiFaceProbe', convaiFaceProbe},
        {'convaiFaceTest', convaiFaceTest}, {'convaiFacialPlayback', convaiFacialPlayback},
        {'convaiGameDialogue', convaiGameDialogue}, {'convaiGameplayActions', convaiGameplayActions},
        {'convaiGestureOptions', convaiGestureOptions}, {'convaiGestureProbe', convaiGestureProbe},
        {'convaiGestures', convaiGestures}, {'convaiGroupChat', convaiGroupChat}, {'convaiHeadTalk', convaiHeadTalk},
        {'convaiHeartbeat', convaiHeartbeat}, {'convaiHolocall', convaiHolocall}, {'convaiInvitations', convaiInvitations},
        {'convaiJohnnyHead', convaiJohnnyHead}, {'convaiJohnnyRemarks', convaiJohnnyRemarks},
        {'convaiLocomotion', convaiLocomotion}, {'convaiLog', convaiLog}, {'convaiLootProbe', convaiLootProbe},
        {'convaiLootReactions', convaiLootReactions}, {'convaiManager', convaiManager}, {'convaiNative', convaiNative},
        {'convaiNotices', convaiNotices}, {'convaiNpcNames', convaiNpcNames}, {'convaiPerfProbe', convaiPerfProbe},
        {'convaiPhoneChat', convaiPhoneChat}, {'convaiPhoneChatStyle', convaiPhoneChatStyle},
        {'convaiPhoneInput', convaiPhoneInput}, {'convaiPhoneLayout', convaiPhoneLayout},
        {'convaiPlayerGear', convaiPlayerGear}, {'convaiQuestContext', convaiQuestContext}, {'convaiSeating', convaiSeating},
        {'convaiSeatingOptions', convaiSeatingOptions}, {'convaiServiceStatus', convaiServiceStatus},
        {'convaiSetupCheck', convaiSetupCheck}, {'convaiSpawnedCharacters', convaiSpawnedCharacters},
        {'convaiSpawnedPeople', convaiSpawnedPeople}, {'convaiSpeech', convaiSpeech},
        {'convaiStory', convaiStory},
        {'convaiSubtitles', convaiSubtitles}, {'convaiTalkGate', convaiTalkGate}, {'convaiTalkNative', convaiTalkNative},
        {'convaiTalkTarget', convaiTalkTarget}, {'convaiTargetMarking', convaiTargetMarking},
        {'convaiTeleportLog', convaiTeleportLog}, {'convaiTurnContext', convaiTurnContext}, {'convaiUiFonts', convaiUiFonts},
        {'convaiUiLocale', convaiUiLocale}, {'convaiUnloadPins', convaiUnloadPins},
        {'convaiVanillaReactions', convaiVanillaReactions}, {'convaiWitnessReceipts', convaiWitnessReceipts},
        {'convaiWorldKnowledge', convaiWorldKnowledge}, {'convaiWorldPolicy', convaiWorldPolicy},
        {'convaiWorldTalk', convaiWorldTalk}
    }
end
function M.globalRoots(environment)
    local roots, named = {}, {}
    local function add(name, value)
        if named[name] or (type(value) ~= 'table' and type(value) ~= 'function') then return end
        named[name] = true
        roots[#roots + 1] = {name, value}
    end
    for _, row in ipairs(knownGlobals()) do add(row[1], row[2]) end
    if type(environment) == 'table' then
        local names = {}
        for name in next, environment do
            if type(name) == 'string' and name:find('^convai') and not named[name] then names[#names + 1] = name end
        end
        table.sort(names)
        for _, name in ipairs(names) do add(name, rawget(environment, name)) end
    end
    return roots
end

-- The cross-reload registry (see loadsAlive above): weak keys, so it never keeps a load alive itself. nil when the string
-- metatable cannot be used.
local REGISTRY = '__convaiHeapLoads'
local function registry()
    local okMeta, meta = pcall(getmetatable, '')
    if not okMeta or type(meta) ~= 'table' then return nil end
    local ok, value = pcall(function()
        local held = rawget(meta, REGISTRY)
        if type(held) ~= 'table' then held = setmetatable({}, {__mode = 'k'}); rawset(meta, REGISTRY, held) end
        return held
    end)
    return ok and value or nil
end

local function readHistory(open, decode)
    local file = open(RESULT, 'rb')
    if not file then return {} end
    local raw = file:read(1024 * 1024); file:close()
    if type(raw) ~= 'string' or raw == '' then return {} end
    local ok, value = pcall(decode, raw)
    if not ok or type(value) ~= 'table' or type(value.history) ~= 'table' then return {} end
    local history = {}
    for _, row in ipairs(value.history) do if type(row) == 'table' then history[#history + 1] = row end end
    if type(value.latest) == 'table' then history[#history + 1] = value.latest end
    while #history > KEEP_REPORTS - 1 do table.remove(history, 1) end
    return history
end

-- env = {nonce, roots (ordered {name, value} list from init.lua), environment, loadedAt, sentinel (a table unique to this load);
-- open, encode, decode, clock and collectgarbage default to the real ones (tests replace them).
-- Returns the report (also written to runtime/lua-heap.json).
function M.run(env)
    env = env or {}
    local clock, gc = env.clock or os.clock, env.collectgarbage or collectgarbage
    local nonce = tostring(env.nonce or '')
    local countOnly = nonce:find('^lua%-heap:count:') ~= nil
    local report = {version = 1, nonce = nonce, at = os.date('!%Y-%m-%dT%H:%M:%SZ'), loadedAt = env.loadedAt,
        secondsSinceLoad = env.loadedAt and (os.time() - env.loadedAt) or nil}
    report.heapBeforeKB = gc('count')
    if not countOnly then
        local loads = type(env.sentinel) == 'table' and registry() or nil
        if loads and loads[env.sentinel] == nil then loads[env.sentinel] = env.loadedAt or os.time() end
        local t0 = clock()
        gc('collect')
        report.collectMs = 1000 * (clock() - t0)
        report.heapAfterKB = gc('count')
        report.garbageKB = report.heapBeforeKB - report.heapAfterKB
        if loads then
            local count = 0
            for _ in next, loads do count = count + 1 end
            report.loadsAlive = count
        end
        local roots = {}
        for _, root in ipairs(env.roots or {}) do roots[#roots + 1] = root end
        for _, root in ipairs(M.globalRoots(env.environment)) do roots[#roots + 1] = root end
        local walked = M.walk(roots, {clock = clock})
        report.modKB = walked.totalBytes / 1024
        report.otherKB = report.heapAfterKB - report.modKB
        report.roots, report.fields, report.tables = walked.roots, walked.fields, walked.tables
        report.walkMs, report.objects, report.truncated, report.upvaluesWalked = walked.walkMs, walked.nodes, walked.truncated, walked.upvalues
        -- The walk's own tables are garbage now; the next collect frees them (not forced here: one pause per request).
    end
    local open, encode, decode = env.open or io.open, env.encode or json.encode, env.decode or json.decode
    local history = readHistory(open, decode)
    local ok, text = pcall(encode, {version = 1, latest = report, history = history})
    if ok and type(text) == 'string' then
        local file = open(RESULT, 'wb')
        if file then file:write(text); file:close() end
    end
    return report
end

return M
