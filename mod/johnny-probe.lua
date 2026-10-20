-- Developer probes for Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): the live evidence the offline tests cannot
-- give (the Relic's status effects, the cost of combat hooks, the district V is read in).
--
-- Dispatched from init.lua's developer mailbox (runtime/diagnostic-request.txt, its existing poll) as
-- "johnny-probe:<feature>:<action>:<stamp>", in Developer mode only; scripts/Send-JohnnyProbe.ps1 writes the request and prints
-- runtime/johnny-probe.json. Never loaded otherwise, and it adds no hook of its own. Each feature is its own file whose run(action, env)
-- returns a plain report; a feature that acts over time also has tick(env), called on the existing 0.5 s battle sample (through the
-- global convaiJohnnyProbeTick, nil while nothing ticks) until it returns false.
local M = convaiJohnnyProbe or {modules = {}, ticking = {}}
convaiJohnnyProbe = M

M.FEATURES = {relic = 'johnny-relic-probe.lua', feats = 'combat-feats-probe.lua'}
M.RESPONSE = 'runtime/johnny-probe.json'
local MAX_REQUEST, MAX_REPORT = 200, 262144

-- "johnny-probe:<feature>:<action...>:<stamp>" -> feature, action ("spawn:A" keeps its colon), or nil. Pure.
function M.parse(request)
    if type(request) ~= 'string' or #request > MAX_REQUEST then return nil end
    local parts = {}
    for part in request:gmatch('[^:]+') do parts[#parts + 1] = part end
    if #parts < 4 or parts[1] ~= 'johnny-probe' or not parts[2]:match('^[a-z]+$') then return nil end
    local action = table.concat(parts, ':', 3, #parts - 1)
    if not action:match('^[%w%-:_]+$') then return nil end
    return parts[2], action
end

local function environment(log)
    return {player = Game.GetPlayer(), now = os.time(), clock = os.clock(), log = log}
end

-- The place feature lives here: what the district sample reads now and what it would make of it, and a test arrival that puts one
-- place event in the queue (its cooldown cleared), so the remark's words can be heard without travelling there.
local function place(action, env)
    local module = convaiJohnnyRemarksModule
    local report = {johnnyInHead = manager.johnnyInHead(), johnnyRemarks = manager.johnnyRemarks(), loaded = module ~= nil}
    local ok, chain = pcall(function()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        local district = system and system:GetCurrentDistrict()
        local record = district and TweakDBInterface.GetDistrictRecord(district:GetDistrictID())
        local names, guard = {}, 0
        while record and guard < 8 do
            names[#names + 1] = Game.NameToString(record:EnumName())
            record, guard = record:ParentDistrict(), guard + 1
        end
        return names
    end)
    report.chain = ok and chain or nil
    report.chainError = not ok and tostring(chain) or nil
    local row = module and ok and module.placeOf(chain) or nil
    report.place = row and row.key or nil
    local remarks = convaiJohnnyRemarks or nil
    if action:match('^note:') then
        local key = action:match('^note:([%w%-]+)$')
        local target
        for _, candidate in ipairs(module and module.PLACES or {}) do if candidate.key == key then target = candidate end end
        if not remarks or not target then
            report.noted, report.why = false, not remarks and 'Johnny speaks up is not loaded (both settings on, then wait a few seconds)' or 'unknown place'
        else
            remarks.subjects['place:' .. key] = nil
            convaiJohnnyRemarkNote('place', target)
            report.noted = true
        end
    end
    if remarks then
        report.queue = {}
        for _, entry in ipairs(remarks.queue) do report.queue[#report.queue + 1] = {subject = entry.subject, kind = entry.kind, at = entry.heardAt} end
        report.rateAllows = remarks:allowed(env.now)
        report.lastRemarkAt = remarks.said[#remarks.said]
    end
    -- Why a remark could not start now ('none': nothing stops it; 'off': Johnny in your head is not loaded).
    local head = convaiJohnnyHeadService and convaiJohnnyHeadService() or nil
    if head then report.refusal = head:refusal(env.player) or 'none' else report.refusal = 'off' end
    return report
end

local function respond(request, feature, action, ok, report, err)
    local body = {nonce = request, feature = feature, action = action, ok = ok, report = ok and report or nil,
        error = not ok and tostring(err) or nil, at = os.time()}
    local encoded, text = pcall(json.encode, body)
    if not encoded or #text > MAX_REPORT then
        text = json.encode({nonce = request, feature = feature, action = action, ok = false, at = os.time(),
            error = not encoded and ('report not encodable: ' .. tostring(text)) or 'report too large'})
    end
    local file = io.open(M.RESPONSE, 'wb')
    if file then file:write(text); file:close() end
end

local function tick()
    local env = environment(convaiLogLine)
    for feature, module in pairs(M.ticking) do
        local ok, keep = pcall(module.tick, env)
        if not ok or not keep then M.ticking[feature] = nil end
    end
    if next(M.ticking) == nil then convaiJohnnyProbeTick = nil end
end

-- One request from the mailbox. Developer mode only: for a player the request is read and dropped.
function M.run(request)
    if not manager.developerMode() then return false end
    local feature, action = M.parse(request)
    if not feature then respond(request, nil, nil, false, nil, 'malformed request'); return false end
    local env = environment(convaiLogLine)
    local ok, report
    if feature == 'place' then
        ok, report = pcall(place, action, env)
    elseif M.FEATURES[feature] then
        local module = M.modules[feature]
        if not module then
            local loaded, value = pcall(dofile, M.FEATURES[feature])
            module = loaded and type(value) == 'table' and type(value.run) == 'function' and value or nil
            if not module then respond(request, feature, action, false, nil, 'probe unavailable: ' .. tostring(value)); return false end
            M.modules[feature] = module
        end
        ok, report = pcall(module.run, action, env)
        if ok and type(module.tick) == 'function' then M.ticking[feature] = module; convaiJohnnyProbeTick = tick end
    else
        ok, report = false, 'unknown feature ' .. feature
    end
    respond(request, feature, action, ok, report, report)
    if convaiLogLine then convaiLogLine('Johnny probe: ' .. feature .. ' ' .. action .. (ok and '' or ' failed')) end
    return ok
end

return M
