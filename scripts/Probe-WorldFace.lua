-- Research probe: why a requested world face never becomes prepared.
-- run worldface survey [range]          nearby NPCs: face_rig graph, appearance, flags
-- run worldface request <entityHash>    ConvaiFaceRequest on it, then poll 15 s into gesture-probe.log
-- run worldface hook                    log every Entity/Extract builder for 60 s
return function(words, probe)
    local mode = words[3] or 'survey'
    local function read(fn) local ok, v = pcall(fn); if ok then return v end return 'ERR:' .. tostring(v) end
    local function hash(npc) return read(function() return tostring(npc:GetEntityID().hash) end) end
    local function faceInfo(npc)
        local out = {}
        local comp = read(function() return npc:FindComponentByName(CName.new('face_rig')) end)
        out.found = comp ~= nil and type(comp) ~= 'string'
        if out.found then
            pcall(function()
                local className = NameToString(comp:GetClassName())
                local cls = Reflection.GetClass(CName.new(className))
                local owner = ToVariant(comp)
                local rigRef = ResourceRef.FromVariant(cls:GetProperty(CName.new('rig')):GetValue(owner))
                local graphRef = ResourceRef.FromVariant(cls:GetProperty(CName.new('graph')):GetValue(owner))
                out.rig = ResRef.ToString(ResourceRef.GetPath(rigRef))
                out.graph = ResRef.ToString(ResourceRef.GetPath(graphRef))
                out.loaded = ResourceRef.IsLoaded(graphRef)
                out.compId = tostring(comp.id and comp.id.hash or '')
            end)
        end
        return out
    end
    local function describe(npc)
        local scene = Game.GetSceneSystem():GetScriptInterface()
        local id = npc:GetEntityID()
        local row = {id = hash(npc),
            appearance = read(function() return NameToString(npc:GetCurrentAppearanceName()) end),
            record = read(function() return TDBID.ToStringDEBUG(npc:GetRecordID()) end),
            crowd = read(function() return npc:IsCrowd() end), vendor = read(function() return npc:IsVendor() end),
            quest = read(function() return npc:IsQuest() end), autonomous = read(function() return npc:IsOnAutonomousAI() end),
            workspot = read(function() return Game.GetWorkspotSystem():IsActorInWorkspot(npc) end),
            inScene = read(function() return scene:IsEntityInScene(id) end),
            inDialogue = read(function() return scene:IsEntityInDialogue(id) end),
            managed = read(function() return Game.GetDynamicEntitySystem():IsManaged(id) end),
            face = faceInfo(npc),
            ready = read(function() return npc:ConvaiFaceReady() end), status = read(function() return npc:ConvaiFaceStatus() end)}
        local p = read(function() return npc:GetWorldPosition() end)
        if type(p) ~= 'string' then row.pos = {x = math.floor(p.x * 10) / 10, y = math.floor(p.y * 10) / 10, z = math.floor(p.z * 10) / 10} end
        return row
    end
    local function nearby(range)
        local player = Game.GetPlayer()
        local query = TSQ_ALL()
        query.searchFilter = Game['TSF_NPC;']()
        query.maxDistance = range
        query.includeSecondaryTargets = false
        query.filterObjectByDistance = true
        query.ignoreInstigator = true
        local targeting = Game.GetTargetingSystem()
        local seen, list = {}, {}
        local _, parts = targeting:GetTargetParts(player, query)
        for _, part in ipairs(parts or {}) do
            local component = TS_TargetPartInfo.GetComponent(part)
            local entity = component and component:GetEntity()
            if entity and entity:IsA('NPCPuppet') and not seen[hash(entity)] then seen[hash(entity)] = true; list[#list + 1] = entity end
        end
        local looked = read(function() return targeting:GetLookAtObject(player, true, true) end)
        if looked and type(looked) ~= 'string' and not seen[hash(looked)] then list[#list + 1] = looked end
        return list
    end
    if mode == 'ping' then return {pong = true} end
    if mode == 'ids' then
        local okN, list = pcall(nearby, tonumber(words[4]) or 20)
        if not okN then return {error = 'nearby: ' .. tostring(list)} end
        local ids = {}
        for _, npc in ipairs(list) do ids[#ids + 1] = hash(npc) end
        return {ids = ids}
    elseif mode == 'survey' then
        local rows = {}
        local okN, list = pcall(nearby, tonumber(words[4]) or 20)
        if not okN then return {error = 'nearby: ' .. tostring(list)} end
        for _, npc in ipairs(list) do
            local okD, row = pcall(describe, npc)
            rows[#rows + 1] = okD and row or {error = tostring(row)}
        end
        return {count = #rows, npcs = rows}
    elseif mode == 'request' then
        local wanted = words[4]
        local target
        for _, npc in ipairs(nearby(30)) do if hash(npc) == wanted then target = npc end end
        if not target then return {error = 'no such NPC in range'} end
        local state = {at = 0, left = 15, id = wanted}
        local before = describe(target)
        state.oldFace = read(function() return target:FindComponentByName(CName.new('face_rig')) end)
        state.oldCount = read(function() return #target:GetComponents() end)
        local status = read(function() return target:ConvaiFaceRequest() end)
        probe.watchers = probe.watchers or {}
        probe.watchers.worldface = function(player, step, rows, log)
            state.at = state.at - (tonumber(step) or 0)
            if state.at > 0 then return end
            state.at = 0.5
            state.left = state.left - 0.5
            local npc
            for _, c in ipairs(nearby(30)) do if hash(c) == state.id then npc = c end end
            local cur = npc and read(function() return npc:FindComponentByName(CName.new('face_rig')) end)
            log('worldface-poll', {left = state.left, found = npc ~= nil, sameFaceObject = read(function() return cur == state.oldFace end), components = npc and read(function() return #npc:GetComponents() end), was = state.oldCount, now = npc and describe(npc) or nil})
            if state.left <= 0 or not npc then probe.watchers.worldface = nil end
        end
        return {status = status, before = before}
    elseif mode == 'hook' then
        local state = {on = true, left = tonumber(words[4]) or 120}
        local function out(row)
            local f = io.open('runtime/worldface-extract.log', 'a')
            if f then f:write(json.encode(row), string.char(10)); f:close() end
        end
        local okReg, err = pcall(function()
            Observe('ConvaiFaceService', 'OnCompanionExtract', function(self, event)
                if not state.on then return end
                local row = {kind = 'extract'}
                pcall(function()
                    local builder = event:GetEntityBuilder()
                    row.has = builder:HasEntity()
                    row.app = builder:HasAppearance() and NameToString(builder:GetAppearanceName()) or nil
                    row.id = tostring(builder:GetEntityID().hash)
                    row.comps = {}
                    if builder:HasAppearance() then
                        for _, c in ipairs(builder:GetAppearance():GetComponents()) do
                            row.comps[#row.comps + 1] = NameToString(c:GetName()) .. ':' .. NameToString(c:GetClassName())
                        end
                    end
                end)
                out(row)
            end)
        end)
        probe.watchers = probe.watchers or {}
        probe.watchers.worldfaceHook = function(player, step)
            state.left = state.left - (tonumber(step) or 0)
            if state.left <= 0 then state.on = false; probe.watchers.worldfaceHook = nil end
        end
        return {registered = okReg, error = okReg and nil or tostring(err)}
    end
    return {error = 'unknown mode'}
end
