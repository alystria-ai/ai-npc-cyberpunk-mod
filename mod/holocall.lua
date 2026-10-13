-- Holocalls with the mod's characters (docs/HOLOCALL.md).
--
-- V calls a Chat contact from the phone (the Holocall action on the phone's Chat tab, or Call inside an AI Chat
-- conversation). The game's call window opens at the top left with that character's portrait and name
-- (Holocall.reds drives it; the game's own call path, its quest facts and its call blackboard are never used). While the
-- call is connected, the talk keys (typed and voice) address that character wherever V is, through the same request
-- path as a face to face talk; the reply is spoken in the mod voice at full volume (no distance) with call subtitles,
-- and the turn says V is on a call (bridge/turn-context.mjs).
--
-- Live picture (setting "Live holocall picture", experimental, off by default): the game's holocall picture is a
-- render-to-texture camera filming a real character (base\cinematics\cameras\holocall_camera.ent, component
-- RenderToTextureCamera). With the setting on, a copy of the character is placed far above V, held still in a talk
-- pose, and that camera is spawned in front of it and switched on. Whether the picture appears cannot be detected from
-- script; if the copy or camera cannot be placed the call falls back to the portrait.
--
-- Cost: idle, update() is one nil check and drain() runs only on the phone's own request drain. A call ticks every
-- 0.25 s and reads one native event queue per tick. One probe line per call state change: "[Holocall] ...".
local M = convaiHolocall or {}
local ui = (convaiUiLocale or dofile('ui-locale.lua'))

M.TAG = 'CyberpunkConvaiHolocall'
M.COMPANION_TAG = 'CyberpunkConvaiCompanion'
M.CAMERA = 'base\\cinematics\\cameras\\holocall_camera.ent'
M.CAMERA_COMPONENT = 'RenderToTextureCamera'
M.TICK = 0.25
-- The call rings at least RING_MIN seconds (the character's connection warms meanwhile), and waits for the live
-- picture at most RING_MAX seconds.
M.RING_MIN, M.RING_MAX = 1.5, 5
-- No turn and no speech for this long hangs up; no call is longer than MAX_LENGTH (seconds of play, pauses excluded).
M.IDLE_LIMIT, M.MAX_LENGTH = 180, 1800
-- Live picture placement: the copy stands this far above V; the camera is this far in front of it, at face height.
M.HOLO_HEIGHT, M.CAMERA_DISTANCE, M.CAMERA_HEIGHT = 40, 0.9, 1.62
-- The copy may drift this far from its place before the picture is given up.
M.HOLO_DRIFT = 1.5
-- Never on a holocall, whatever a catalogue says.
M.NEVER = {johnny = true, ['johnny-silverhand'] = true, silverhand = true}

M.env = M.env or {}
M.catalog = M.catalog or {}
M.serial = M.serial or 0

local function log(line)
    if type(M.env.log) == 'function' then pcall(M.env.log, '[Holocall] ' .. line) end
end

local function readJson(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function excluded(row)
    local record = type(row.record) == 'string' and row.record:lower() or ''
    return M.NEVER[row.key] or M.NEVER[row.contact] or record:find('johnny', 1, true) or record:find('silverhand', 1, true)
end

-- The phone contacts of the mod's characters (characters/phone-contacts.json): contact id -> {key, name, record}.
function M.loadCatalog(list)
    local catalog = {}
    for _, row in ipairs(type(list) == 'table' and list or {}) do
        if type(row) == 'table' and type(row.contact) == 'string' and row.contact ~= '' and type(row.key) == 'string'
            and row.key:match('^[a-z0-9-]+$') and not excluded(row) then
            catalog[row.contact] = {contact = row.contact, key = row.key,
                name = type(row.name) == 'string' and row.name ~= '' and row.name or row.contact,
                record = type(row.record) == 'string' and row.record or nil}
        end
    end
    return catalog
end

-- env: log(line), supported(key), profileEnabled(key), warm(key, entity), liveImage(), busy(call),
-- onConnected(call), onEnded(call, reason), contacts() (the catalogue rows; phone-contacts.json when absent).
function M.configure(env)
    M.env = type(env) == 'table' and env or {}
    local rows = type(M.env.contacts) == 'function' and M.env.contacts() or readJson('phone-contacts.json')
    M.catalog = M.loadCatalog(rows)
    M.sweepDue = true
end

-- The translated phone label (the Chat tab's Holocall action), pushed when the language changes.
function M.pushLabel(player)
    local revision = type(ui.revision) == 'function' and ui.revision() or 0
    if M.labelRevision == revision or not player then return end
    local ok = pcall(function() player:ConvaiHolocallSetLabel(ui.t('Holocall')) end)
    if ok then M.labelRevision = revision end
end

-- Why a call cannot be on now, from the battle observer's half-second sample (mod/battle-observer.lua), or nil.
-- An unknown sample blocks nothing: the game's own call checks (Holocall.reds) still apply.
function M.blocked(sample)
    if type(sample) ~= 'table' or sample.available ~= true then return nil end
    if sample.combat == true then return 'combat' end
    if sample.replacer == true then return 'replacer' end
    if sample.call == true then return 'quest-call' end
    if (sample.tier ~= nil and sample.tier ~= 1) or sample.dialogue == true or sample.choices == true then return 'scene' end
    return nil
end

local function system()
    local ok, value = pcall(function() return Game.GetDynamicEntitySystem() end)
    return ok and value or nil
end

local function deleteTagged(id)
    local dynamic = system()
    if not dynamic or not id then return end
    pcall(function()
        if dynamic:IsManaged(id) and dynamic:IsTagged(id, CName.new(M.TAG)) then dynamic:DeleteEntity(id) end
    end)
end

-- Copies and cameras left by a reload or a crash. Run once after configure, from the first drain.
function M.sweep()
    M.sweepDue = false
    local dynamic = system()
    if not dynamic then return end
    pcall(function()
        for _, id in ipairs(dynamic:GetTaggedIDs(CName.new(M.TAG)) or {}) do dynamic:DeleteEntity(id) end
    end)
end

local function workspot()
    if M.workspot == nil then
        local ok, module = pcall(dofile, 'gesture-workspot.lua')
        M.workspot = ok and type(module) == 'table' and module or false
    end
    return M.workspot or nil
end

-- The talk pose the copy is held in: the character's own talk family, its rig's, or the generic one.
local function holdComponent(record)
    -- The gesture catalogue is large: read once, on the first live picture only.
    if M.gestures == nil then
        local ok, value = pcall(dofile, 'gesture-catalog.lua')
        M.gestures = ok and type(value) == 'table' and type(value.families) == 'table' and value or false
    end
    local catalog = M.gestures
    if not catalog then return nil, nil end
    local character = type(catalog.characters) == 'table' and catalog.characters[record] or nil
    local family = character and catalog.families[character.talk]
    if not family and character and type(catalog.generic) == 'table' and type(catalog.generic.rigs) == 'table' then
        local rig = catalog.generic.rigs[character.rig]
        family = rig and catalog.families[rig.talk]
    end
    family = family or catalog.families.on_sides
    return catalog.device, family and family.component
end

local function holoFail(call, reason)
    local holo = call.holo
    if not holo or holo.failed then return end
    holo.failed, holo.reason = true, reason
    log('holo failed contact=' .. call.contact .. ' reason=' .. tostring(reason) .. ' fallback=audio')
end

local function holoBegin(call, player)
    local holo = {wait = 0}
    call.holo = holo
    if not call.record then holoFail(call, 'no-record'); return end
    local ok, err = pcall(function()
        local dynamic = system()
        assert(dynamic and dynamic:IsReady(), 'entity system not ready')
        local origin = player:GetWorldPosition()
        local anchor = Vector4.new(origin.x, origin.y, origin.z + M.HOLO_HEIGHT, 1)
        holo.anchor = {x = anchor.x, y = anchor.y, z = anchor.z}
        local copy = NewObject('DynamicEntitySpec')
        copy.recordID = TweakDBID.new(call.record)
        copy.position = anchor
        copy.orientation = EulerAngles.new(0, 0, 0):ToQuat()
        copy.persistState, copy.persistSpawn = false, false
        copy.alwaysSpawned, copy.spawnInView, copy.active = true, true, true
        -- The companion tag gives the copy the speech face layer (Face.reds) before it attaches.
        copy.tags = {CName.new(M.COMPANION_TAG), CName.new(M.TAG)}
        holo.copyId = dynamic:CreateEntity(copy)
        assert(holo.copyId and not tostring(holo.copyId.hash):match('^0+[uUlL]*$'), 'copy was not created')
        -- Facing yaw 0 the copy looks along +Y; the camera stands in front of it and looks back (yaw 180).
        local camera = NewObject('DynamicEntitySpec')
        if not pcall(function() camera.templatePath = M.CAMERA end) then camera.templatePath = ResRef.FromString(M.CAMERA) end
        camera.position = Vector4.new(anchor.x, anchor.y + M.CAMERA_DISTANCE, anchor.z + M.CAMERA_HEIGHT, 1)
        camera.orientation = EulerAngles.new(0, 0, 180):ToQuat()
        camera.persistState, camera.persistSpawn = false, false
        camera.alwaysSpawned, camera.spawnInView, camera.active = true, true, true
        camera.tags = {CName.new(M.TAG)}
        holo.cameraId = dynamic:CreateEntity(camera)
        assert(holo.cameraId and not tostring(holo.cameraId.hash):match('^0+[uUlL]*$'), 'camera was not created')
    end)
    if not ok then holoFail(call, 'spawn: ' .. tostring(err)) return end
    log('holo spawn contact=' .. call.contact .. ' record=' .. call.record)
end

local function spawned(id)
    local dynamic = system()
    if not dynamic or not id then return nil end
    local ok, entity = pcall(function()
        if not dynamic:IsSpawned(id) then return nil end
        return Game.FindEntityByID(id)
    end)
    return ok and entity or nil
end

local function drift(holo)
    local ok, distance = pcall(function()
        local p, a = holo.npc:GetWorldPosition(), holo.anchor
        return math.sqrt((p.x - a.x)^2 + (p.y - a.y)^2 + (p.z - a.z)^2)
    end)
    return ok and distance or math.huge
end

-- Place the copy and the camera: both spawned, the copy held in its talk pose, the camera switched on.
local function holoStep(call, dt)
    local holo = call.holo
    if not holo or holo.failed or holo.ready then return end
    holo.wait = holo.wait + dt
    if holo.wait > M.RING_MAX then holoFail(call, 'placement-timeout'); return end
    holo.npc = holo.npc or spawned(holo.copyId)
    holo.camera = holo.camera or spawned(holo.cameraId)
    if not holo.npc or not holo.camera then return end
    if not holo.held then
        local spots = workspot()
        local template, component = holdComponent(call.record)
        if not spots or not template or not component then holoFail(call, 'no-talk-pose'); return end
        local created, device = spots.spawnDevice(holo.npc, template)
        if not created then holoFail(call, 'device: ' .. tostring(device)); return end
        holo.deviceId, holo.component, holo.held = device, component, 'waiting'
    end
    if holo.held == 'waiting' then
        local spots = workspot()
        local device = spots.deviceEntity(holo.deviceId)
        if device == false then holoFail(call, 'device-lost'); return end
        if not device then return end
        local played, err = spots.play(device, holo.npc, holo.component)
        if not played then holoFail(call, 'hold: ' .. tostring(err)); return end
        holo.held = 'yes'
    end
    local camera = holo.camera
    local switched, err = pcall(function()
        local component = camera:FindComponentByName(CName.new(M.CAMERA_COMPONENT))
        assert(component, 'no ' .. M.CAMERA_COMPONENT .. ' component')
        component:Toggle(true)
    end)
    if not switched then holoFail(call, 'camera: ' .. tostring(err)); return end
    pcall(function() holo.npc:ConvaiFaceRequest() end)
    local identity = pcall(function() holo.entity = tostring(holo.npc:GetEntityID().hash) end)
    if not identity then holoFail(call, 'copy-identity'); return end
    holo.ready = true
    log('holo ready contact=' .. call.contact .. ' held=' .. tostring(holo.held) .. ' camera=on'
        .. string.format(' drift=%.2f', drift(holo)))
end

local function holoValid(call)
    local holo = call.holo
    if not holo or not holo.ready or holo.failed or not holo.npc then return false end
    local ok, attached = pcall(function() return holo.npc:IsAttached() end)
    if not ok or not attached then return false end
    return drift(holo) <= M.HOLO_DRIFT
end

local function holoCleanup(holo)
    if not holo or holo.cleaned then return end
    holo.cleaned = true
    local spots = holo.held and workspot()
    if spots and holo.npc then pcall(spots.exit, holo.npc, true) end
    if spots and holo.deviceId then pcall(spots.deleteDevice, holo.deviceId) end
    if holo.cameraId and holo.camera then
        pcall(function() holo.camera:FindComponentByName(CName.new(M.CAMERA_COMPONENT)):Toggle(false) end)
    end
    deleteTagged(holo.copyId)
    deleteTagged(holo.cameraId)
end

local function notifyEnded(player, call, reason)
    -- V hung up, called again, or the game's own call took over (its window shows): no notice.
    if reason == 'hangup' or reason == 'replaced' or reason == 'quest-call' or not player then return end
    convaiNotices.send(player, 'holocall-ended', reason == 'combat' and ui.t('Holocall ended: combat started.')
        or ui.t('Holocall with {name} ended.', {name = call.name}))
end

function M.finish(player, reason)
    local call = M.call
    if not call then return false end
    M.call = nil
    if player then pcall(function() player:ConvaiHolocallEnd() end) end
    holoCleanup(call.holo)
    log('state=ended contact=' .. call.contact .. ' reason=' .. tostring(reason) .. ' length=' .. math.floor(call.age) .. 's')
    if type(M.env.onEnded) == 'function' then pcall(M.env.onEnded, call, reason) end
    notifyEnded(player, call, reason)
    return true
end

-- The world went away (a load, death, the game shutting down): forget the call without native calls. The HUD and its
-- window are rebuilt by the game; a copy or camera left behind is swept after the next configure.
function M.abandon(reason)
    M.request = nil
    local call = M.call
    if not call then return end
    M.call = nil
    M.sweepDue = true
    log('state=ended contact=' .. call.contact .. ' reason=' .. tostring(reason or 'abandoned') .. ' length=' .. math.floor(call.age) .. 's')
end

local function refuse(player, contact, reason, text)
    log('refused contact=' .. tostring(contact) .. ' reason=' .. reason)
    if text then convaiNotices.send(player, 'holocall-refused', text) end
    return false
end

function M.start(player, contact, sample)
    if M.call then
        local same = M.call.contact == contact
        M.finish(player, 'replaced')
        -- Calling the same character again from the phone hangs up.
        if same then return false end
    end
    local entry = M.catalog[contact]
    if not entry then return refuse(player, contact, 'not-a-mod-character', ui.t('This contact cannot take a holocall.')) end
    if type(M.env.supported) == 'function' and not M.env.supported(entry.key) then
        return refuse(player, contact, 'no-profile', ui.t('This contact cannot take a holocall.'))
    end
    if type(M.env.profileEnabled) == 'function' and not M.env.profileEnabled(entry.key) then
        return refuse(player, contact, 'disabled', ui.t('Conversations are disabled for this contact.'))
    end
    local blocked = M.blocked(sample)
    if blocked then
        return refuse(player, contact, blocked, blocked == 'combat' and ui.t('Calls are not available during combat.')
            or blocked == 'quest-call' and ui.t('You are already on a call.') or ui.t('Calls are not available right now.'))
    end
    local began, result = pcall(function() return player:ConvaiHolocallBegin(contact) end)
    result = began and type(result) == 'string' and result or 'no-hud'
    if result ~= 'ok' then
        return refuse(player, contact, result, result == 'quest-call' and ui.t('You are already on a call.')
            or result == 'unknown-contact' and ui.t('This contact cannot take a holocall.')
            or ui.t('Calls are not available right now.'))
    end
    local identity, entity = pcall(function() return tostring(player:GetEntityID().hash) end)
    M.serial = M.serial + 1
    local call = {serial = M.serial, contact = contact, key = entry.key, name = entry.name, record = entry.record,
        state = 'dialing', mode = 'audio', entity = identity and entity or nil, ring = 0, age = 0, idle = 0, tick = 0,
        wantLive = type(M.env.liveImage) == 'function' and M.env.liveImage() == true}
    M.call = call
    if type(M.env.warm) == 'function' then pcall(M.env.warm, call.key, call.entity) end
    log('state=dialing contact=' .. contact .. ' profile=' .. call.key .. ' mode=' .. (call.wantLive and 'holo' or 'audio') .. ' hud=ok')
    if call.wantLive then holoBegin(call, player) end
    return true
end

local function connect(call, player)
    local live = call.wantLive and call.holo ~= nil and call.holo.ready == true and not call.holo.failed
    if call.wantLive and not live then
        holoFail(call, call.holo and call.holo.reason or 'not-ready')
        convaiNotices.send(player, 'holocall-live-fallback', ui.t('Live picture unavailable. The call continues with the portrait.'))
        holoCleanup(call.holo)
    end
    local ok, window = pcall(function() return player:ConvaiHolocallConnect(live) end)
    window = ok and type(window) == 'string' and window or 'ended'
    if window == 'ended' then return M.finish(player, 'hud-lost') end
    call.state, call.mode, call.window, call.idle = 'connected', live and 'holo' or 'audio', window, 0
    log('state=connected contact=' .. call.contact .. ' mode=' .. call.mode .. ' window=' .. window)
    convaiNotices.send(player, 'holocall-connected', ui.t('Holocall with {name}. Tap the phone button to hang up.', {name = call.name}))
    if type(M.env.onConnected) == 'function' then pcall(M.env.onConnected, call) end
end

local EVENTS = {hangup = 'hangup', ['quest-call'] = 'quest-call', ['hud-lost'] = 'hud-lost'}

local function step(call, player, dt, sample)
    for _ = 1, 4 do
        local ok, event = pcall(function() return player:ConvaiHolocallTakeEvent() end)
        if not ok or type(event) ~= 'string' or event == '' then break end
        if EVENTS[event] then return M.finish(player, EVENTS[event]) end
    end
    local blocked = M.blocked(sample)
    if blocked then return M.finish(player, blocked) end
    if type(M.env.profileEnabled) == 'function' and not M.env.profileEnabled(call.key) then return M.finish(player, 'disabled') end
    call.age = call.age + dt
    if call.state == 'dialing' then
        call.ring = call.ring + dt
        if call.wantLive then holoStep(call, dt) end
        local settled = not call.wantLive or not call.holo or call.holo.ready or call.holo.failed
        if call.ring >= M.RING_MIN and (settled or call.ring >= M.RING_MAX) then connect(call, player) end
        return
    end
    if call.mode == 'holo' and not holoValid(call) then
        -- The copy fell, streamed out or was moved: the call goes on with the portrait.
        holoFail(call, 'copy-lost')
        holoCleanup(call.holo)
        call.mode = 'audio'
        local ok, window = pcall(function() return player:ConvaiHolocallConnect(false) end)
        call.window = ok and window or 'ended'
        log('state=connected contact=' .. call.contact .. ' mode=audio window=' .. tostring(call.window))
        convaiNotices.send(player, 'holocall-live-fallback', ui.t('Live picture unavailable. The call continues with the portrait.'))
        if call.window == 'ended' then return M.finish(player, 'hud-lost') end
    end
    if call.window == 'pending' then
        -- The window was still being created when the call connected: show it once it exists.
        local ok, window = pcall(function() return player:ConvaiHolocallConnect(call.mode == 'holo') end)
        window = ok and window or 'ended'
        if window == 'ended' then return M.finish(player, 'hud-lost') end
        if window ~= 'pending' then call.window = window; log('window=' .. window .. ' contact=' .. call.contact) end
    end
    local busy = type(M.env.busy) == 'function' and M.env.busy(call) == true
    if busy then call.idle = 0 else call.idle = call.idle + dt end
    if call.idle >= M.IDLE_LIMIT then return M.finish(player, 'idle') end
    if call.age >= M.MAX_LENGTH then return M.finish(player, 'max-length') end
end

-- The phone's request drain (init.lua phoneDrainDue): while the phone is open, briefly after, and once a second.
function M.drain(player)
    if not player then return end
    M.pushLabel(player)
    if M.sweepDue then M.sweep() end
    local ok, contact = pcall(function() return player:ConvaiHolocallTakeRequest() end)
    if not ok or type(contact) ~= 'string' or contact == '' then return end
    M.request = {contact = contact}
    log('requested contact=' .. contact)
end

-- From the 0.1 s game tick. A request starts once the world is playable (the phone has closed); a call advances only
-- while the world is playable, every TICK seconds.
function M.update(player, elapsed, worldReady, sample)
    if not M.request and not M.call then return end
    if not player or not worldReady then return end
    if M.request then
        local request = M.request
        M.request = nil
        M.start(player, request.contact, sample)
    end
    local call = M.call
    if not call then return end
    call.tick = call.tick + (tonumber(elapsed) or 0)
    if call.tick < M.TICK then return end
    local dt = call.tick
    call.tick = 0
    step(call, player, dt, sample)
end

function M.connected()
    return M.call ~= nil and M.call.state == 'connected'
end

-- A turn was sent to the call's character: the idle timer starts again.
function M.touch()
    if M.call then M.call.idle = 0 end
end

-- The conversation partner the talk keys address while a call is connected (the shape of init.lua selectConversation's
-- result), or nil. Group chat keeps its usual nearby partners.
function M.partner(player, groupMode)
    local call = M.call
    if groupMode or not call or call.state ~= 'connected' or not player then return nil end
    local holo = call.holo
    if call.mode == 'holo' and holo and holo.ready and holo.npc and holo.entity then
        return {npc = holo.npc, name = call.name, entity = holo.entity, bodyType = '', profileKey = call.key,
            holocall = {version = 1, contact = call.contact, mode = 'holo'}}
    end
    if not call.entity then return nil end
    return {npc = player, name = call.name, entity = call.entity, bodyType = '', profileKey = call.key, voiceOnly = true,
        holocall = {version = 1, contact = call.contact, mode = 'audio'}}
end

-- Is the call a recording or reply was started for still the live call (the microphone's target check)?
function M.partnerValid(context)
    local call = M.call
    if not call or call.state ~= 'connected' or type(context) ~= 'table' or type(context.holocall) ~= 'table'
        or context.holocall.contact ~= call.contact then return false end
    if context.holocall.mode == 'holo' then
        return call.mode == 'holo' and holoValid(call) and context.entity == call.holo.entity
    end
    return context.entity == call.entity
end

convaiHolocall = M
return M
