-- Development probe: does a deliberately EXTREME facial pose become visible on a
-- companion? Inert until a request arrives in runtime/face-test-request.txt
--   line 1: a fresh nonce, line 2: face-test <who> <pose> [seconds] [mode]
-- (scripts/Send-FaceTest.ps1 writes it). Results: runtime/face-test-response.txt
-- (nonce + JSON) and a JSON-lines trace in runtime/face-test.log.
--
-- It is driven from mod/facial-playback.lua (the single native face writer):
-- poll() once per frame, pre()/post() around its feature composition, and
-- direct() before its idle write. It never changes speech weights.
--
-- Modes:
--   writer  after the writer composed speech + expression, the pose is written
--           over the ten expression fields (no caps, no smoothing). Mouth fields
--           (jaw, lips_together, funnel, purse...) are never touched, so this also
--           works WHILE the companion speaks.
--   policy  injects the real policy at scale 3 (joy, sadness, surprise, anger)
--           through the normal smoothing, caps and mouth-priority budget. Use it
--           to see the real strength and the speech interaction.
--   direct  bypasses the writer: its own ConvaiFaceFeature, ConvaiFaceApply every
--           frame, the writer skipped for that actor. Pure write-path test (use
--           while she is silent).
-- Poses: smile frown browsup browsdown jaw all sweep ramp-smile ramp-frown
--        ramp-brows custom:<track>=<value>,...
local M = convaiFaceTest or {}
local REQUEST, RESPONSE, LOG = 'runtime/face-test-request.txt', 'runtime/face-test-response.txt', 'runtime/face-test.log'
local EXPRESSION = {'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn',
    'eye_l_brows_raise_in','eye_r_brows_raise_in','eye_l_brows_raise_out','eye_r_brows_raise_out',
    'eye_l_brows_lower','eye_r_brows_lower','eye_l_oculi_squint_outer_lower','eye_r_oculi_squint_outer_lower',
    'eye_l_widen','eye_r_widen',
    -- Extended controls (present only with the new FaceFeature.reds; every access below is guarded).
    'eye_l_brows_lateral','eye_r_brows_lateral','eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper',
    'eye_l_oculi_squint_inner','eye_r_oculi_squint_inner','nose_l_snear','nose_r_snear','lips_chin_raise'}
local policyFamily = {smile='Joy', frown='Sadness', browsup='Surprise', browsdown='Anger', all='Joy'}

M.clock, M.pollAt, M.lastNonce = M.clock or 0, M.pollAt or 0, M.lastNonce
-- A freshly loaded module (a CET reload, a save load) never runs the request file's old content: the nonce already in
-- the file is taken as seen, and only a request that arrives afterwards counts (a stale `face-stage` used to restart
-- on every reload).
if not M.primed then
    M.primed = true
    local seen = io.open(REQUEST, 'rb')
    if seen then
        local raw = seen:read('*a'); seen:close()
        M.lastNonce = tostring(raw):match('^([^\r\n]+)') or M.lastNonce
    end
end
-- Non-expression fields (jaw, ...) ever written into a writer feature, per
-- entity. The writer keeps its idle feature between frames, so these must be
-- zeroed when a step or run ends or they stay on the face (the jaw .5 bug).
M.touched = M.touched or {}
local EXPRESSION_SET = {}
for _, name in ipairs(EXPRESSION) do EXPRESSION_SET[name] = true end

local function encode(value)
    local ok, text = pcall(json.encode, value)
    return ok and text or ('{"encodeError":' .. string.format('%q', tostring(text)) .. '}')
end
local function log(kind, fields)
    fields = fields or {}
    fields.kind, fields.at, fields.wall = kind, math.floor(M.clock * 1000) / 1000, os.time()
    local file = io.open(LOG, 'a')
    if file then file:write(encode(fields), '\n'); file:close() end
end
local function respond(nonce, ok, result)
    local file = io.open(RESPONSE, 'wb')
    if file then file:write(nonce, '\n', encode({ok = ok, result = result})); file:close() end
    log('response', {nonce = nonce, ok = ok, result = result})
end

local function pair(stem, value) return {['lips_l_' .. stem] = value, ['lips_r_' .. stem] = value} end
local function brows(stem, value) return {['eye_l_brows_' .. stem] = value, ['eye_r_brows_' .. stem] = value} end
local function merge(...)
    local out = {}
    for _, part in ipairs({...}) do for k, v in pairs(part) do out[k] = v end end
    return out
end
local base = {
    smile = function(v) return pair('corner_up', v) end,
    frown = function(v) return pair('corner_dn', v) end,
    browsup = function(v) return merge(brows('raise_in', v), brows('raise_out', v)) end,
    browsdown = function(v) return brows('lower', v) end,
    jaw = function(v) return {jaw_mid_open = v * .5} end,
    -- Eye squint alone, and a Duchenne smile (corners + squint) to compare with plain smile.
    squint = function(v) return {eye_l_oculi_squint_outer_lower = v, eye_r_oculi_squint_outer_lower = v} end,
    duchenne = function(v) return merge(pair('corner_up', v * .45), {eye_l_oculi_squint_outer_lower = v * .3, eye_r_oculi_squint_outer_lower = v * .3}) end,
}
local function steps(pose, seconds)
    local out = {}
    local function add(label, tracks, share) out[#out + 1] = {label = label, tracks = tracks, share = share or 1} end
    if base[pose] then add(pose, base[pose](1))
    elseif pose == 'all' then add('all', merge(base.smile(1), base.browsup(1)))
    elseif pose == 'sweep' then
        for _, name in ipairs({'smile', 'frown', 'browsup', 'browsdown', 'jaw'}) do add(name, base[name](1)) end
    elseif pose:sub(1, 5) == 'ramp-' then
        local kind = ({smile = 'smile', frown = 'frown', brows = 'browsup'})[pose:sub(6)]
        if not kind then return nil, 'unknown ramp' end
        for _, level in ipairs({.1, .2, .35, .5, .75, 1}) do add(pose .. '@' .. level, base[kind](level)) end
    elseif pose:sub(1, 7) == 'custom:' then
        local tracks = {}
        for name, value in pose:sub(8):gmatch('([%w_]+)=([%-%d%.]+)') do tracks[name] = tonumber(value) end
        if next(tracks) == nil then return nil, 'custom needs track=value,...' end
        add('custom', tracks)
    else return nil, 'unknown pose' end
    return out
end

local function rowFor(context, who)
    who = who:lower()
    for _, row in ipairs(context.actors or {}) do
        local profile, name = tostring(row.profileKey or ''):lower(), tostring(row.name or ''):lower()
        if who == 'first' or profile:find(who, 1, true) or name:find(who, 1, true) then return row end
    end
end

local commands = {}
commands['face-test'] = function(rest, context)
    local who, pose, seconds, mode = rest:match('^(%S+)%s+(%S+)%s*(%S*)%s*(%S*)$')
    if not who then return false, 'usage: face-test <who> <pose> [seconds] [writer|policy|direct]' end
    seconds, mode = tonumber(seconds) or 6, (mode ~= '' and mode) or 'writer'
    if mode ~= 'writer' and mode ~= 'policy' and mode ~= 'direct' then return false, 'mode must be writer, policy or direct' end
    if pose == 'off' then M.run = nil; return true, 'stopped (probe fields cleared)' end
    local list, problem = steps(pose, seconds)
    if not list then return false, problem end
    local row = rowFor(context, who)
    if not row then return false, 'no owned companion matching ' .. who .. ' in range' end
    seconds = math.max(1, math.min(60, seconds))
    local per = (pose == 'sweep' or pose:sub(1, 5) == 'ramp-') and seconds / #list or seconds
    M.run = {entity = row.entity, name = row.name, profile = row.profileKey, pose = pose, mode = mode,
        steps = list, per = per, duration = per * #list, elapsed = 0, logAt = 0, frames = 0}
    log('start', {who = who, pose = pose, mode = mode, seconds = M.run.duration, entity = row.entity})
    return true, {started = pose, mode = mode, seconds = M.run.duration, companion = row.name or row.profileKey}
end

-- ---------------------------------------------------------------------------
-- say <who> <text>: V's private line to a present character, through the real reply path (mod/init.lua speech.devSay).
-- face-trace on|off|dump [file]: a bounded ring (3600 frames, preallocated) of what the writer WROTE on this entity's
-- face each frame (jaw, lips, phase, speech cursor, request, phrase index), dumped once to runtime/face-trace.json on
-- request (the only file IO). Recording is dev-only and costs a few native reads per written frame while it is on.
commands['say'] = function(rest, context)
    local who, text = rest:match('^(%S+)%s+(.+)$')
    if not who then return false, 'usage: say <who> <text>' end
    local row = rowFor(context, who)
    if not row then return false, 'no owned companion matching ' .. who .. ' in range' end
    local speech, player = convaiSpeech, Game.GetPlayer()
    if not speech or type(speech.devSay) ~= 'function' or not player then return false, 'speech adapter unavailable' end
    local ok, sent, detail = pcall(speech.devSay, player, row.npc, text)
    if not ok then return false, tostring(sent) end
    log('say', {who = who, bytes = #text, sent = sent == true, detail = tostring(detail), entity = row.entity})
    return sent == true, {requestId = sent and detail or nil, problem = (not sent) and detail or nil, entity = row.entity}
end

-- speak-line <who> <file.json>: the character speaks an EXACT prepared line (no model): the file holds {text, audio?, engine?} (see
-- bridge/scripted-line.mjs; scripts/Send-ScriptedLine.ps1 writes it). It goes through the same request path as `say`, flagged so the
-- bridge voices the text (tags move the face and gestures as in a reply) with the prepared WAV, or live through the named engine.
-- Needs Developer mode (the same gate as `say`, and the bridge checks it again). One request file read, once per command.
commands['speak-line'] = function(rest, context)
    local who, path = rest:match('^(%S+)%s+(.+)$')
    if not who then return false, 'usage: speak-line <who> <file.json>' end
    path = path:gsub('^"(.*)"$', '%1')
    if #path > 500 or not path:lower():match('%.json$') then return false, 'the line file must be a .json path' end
    -- CET opens files only inside this mod's folder, by a path relative to it: an absolute path there is made relative.
    local relative = path:gsub('\\', '/'):match('/AiNpcCyberpunkMod/(.+)$')
    local file = io.open(path, 'rb') or (relative and io.open(relative, 'rb'))
    if not file then return false, 'cannot read ' .. path .. ' (it must be inside the mod folder)' end
    local raw = file:read('*a'); file:close()
    local ok, doc = pcall(json.decode, (tostring(raw):gsub('^\239\187\191', '')))
    if not ok or type(doc) ~= 'table' or type(doc.text) ~= 'string' or doc.text:match('^%s*$') then return false, 'the line file needs a "text" string' end
    -- The WAV may be anywhere (CET cannot open it outside the mod folder); the bridge reads and checks it.
    if doc.audio ~= nil and type(doc.audio) ~= 'string' then return false, '"audio" must be a path' end
    if doc.engine ~= nil and doc.engine ~= 'pocket' and doc.engine ~= 'voxtral' and doc.engine ~= 'inworld' then return false, 'engine must be pocket, voxtral or inworld' end
    local row = rowFor(context, who)
    if not row then return false, 'no owned companion matching ' .. who .. ' in range' end
    local speech, player = convaiSpeech, Game.GetPlayer()
    if not speech or type(speech.devSay) ~= 'function' or not player then return false, 'speech adapter unavailable' end
    local called, sent, detail = pcall(speech.devSay, player, row.npc, 'scripted line', {file = path})
    if not called then return false, tostring(sent) end
    log('speak-line', {who = who, file = path, audio = doc.audio ~= nil, engine = doc.engine, sent = sent == true, detail = tostring(detail), entity = row.entity})
    return sent == true, {requestId = sent and detail or nil, problem = (not sent) and detail or nil, entity = row.entity, companion = row.name or row.profileKey}
end

-- face-play <who> <name> [rate]: plays the mapped mouth timeline in runtime/<name>.json ({tracks, frames, duration}, the
-- shape of a reply's face in continuous-face.json, flattened) silently on a present character through the real writer
-- (facial-playback start, sync on the probe's own clock, stop and endExpression, exactly as speech.lua drives it), so one
-- line can be replayed and captured again after a writer change. No audio, no provider, no history. `face-play off` stops.
-- A replay never runs against a real reply: a speech start takes the writer and the replay ends at its next frame.
-- face-reload: re-runs facial-playback.lua (which re-runs this file) onto the same tables, so a changed writer is live
-- without a CET reload. Both are dev-only (this file is not in a player package).
local PLAY_LEAD = .4
local function playStop(play, npc, reason)
    local face = convaiFacialPlayback
    if face and npc and face.requestId == play.requestId then
        pcall(face.stop, npc, reason)
        if face.endExpression then pcall(face.endExpression, play.context, reason == 'finished') end
    end
    M.play = nil
    log('play-' .. reason, {name = play.name, frames = play.frames, position = play.position})
end
-- invite <who> (development only): the character joins exactly as from the Companion Manager (the party queue, no 'joined' notice),
-- and is then an ordinary companion: she walks with V, turns and talks through the mod's own systems. No stage, no hold.
commands['invite'] = function(rest)
    local who = rest:match('^(%S+)')
    if not who then return false, 'usage: invite <who>' end
    local queue = convaiManager and convaiManager.party and convaiManager.party()
    if not queue then return false, 'the party queue is not available' end
    local called, accepted, message = pcall(queue.invite, who, {quiet = true})
    if not called or not accepted then return false, 'invitation refused: ' .. tostring(called and message or accepted) end
    M.spawned[#M.spawned + 1] = who -- so `face-stage dismiss` sends her away again
    return true, {invited = who}
end

-- drive <who> | drive off (development only): the same chauffeur request as the talk action's DRIVE, without a turn. Needs V
-- near the owned car with a map destination selected; the companion takes the driver seat, waits for V, then drives there.
commands['drive'] = function(rest, context)
    local companions = convaiCompanions
    if not companions then return false, 'companions not loaded' end
    if rest == 'off' then return companions.cancelChauffeur('development probe') end
    local row = context and rowFor(context, rest)
    if not row or not row.npc then return false, 'no companion matching ' .. rest .. ' in range' end
    local offer = companions.chauffeurOffer(row.npc)
    if not offer or not offer.available then return false, 'no drive offer: ' .. tostring(offer and offer.reason) end
    local queued, reason = companions.queueChauffeur(offer.actor and offer.actor.serial, offer, row.npc)
    if not queued then return false, 'drive refused: ' .. tostring(reason) end
    return true, {drive = row.name, to = offer.waypoint and offer.waypoint.name, seat = offer.passengerSeat}
end

-- lead <forward> <lateral> | lead off (development only): every companion walks and stops this far ahead of V (metres; lateral
-- negative is V's right, as in companion-space.lua) instead of in its lane. Cleared by a reload.
commands['lead'] = function(rest)
    if not convaiCompanions then return false, 'companion runtime not loaded' end
    if rest == 'off' or rest == '' then
        convaiCompanions.devLead = nil
        if convaiCompanions.devSetFirstSlot then convaiCompanions.devSetFirstSlot(nil, nil) end
        return true, 'lead off'
    end
    local forward, lateral = rest:match('^(%S+)%s*(%S*)$')
    forward, lateral = tonumber(forward), tonumber(lateral) or 0
    if not forward then return false, 'usage: lead <forward> <lateral> | lead off' end
    -- calm: she does not turn to V while V looks at her (the start of a shot); an armed cue releases it once V has walked.
    convaiCompanions.devLead = {forward = forward, lateral = lateral, calm = true}
    if convaiCompanions.devSetFirstSlot then convaiCompanions.devSetFirstSlot(lateral, forward) end
    return true, convaiCompanions.devLead
end

-- cue <who> <file.json> | cue off (development only): speak-line fires by itself once V has stood still for half a second facing
-- that character (within 25 degrees, 6 m) for 1.6 s, long enough for her own turn toward V to finish first. Checked every .1 s while
-- armed; disarmed after it fires. Once V has walked 1.5 m, lead mode's calm ends, so she turns to V as usual when V stops and looks.
commands['cue'] = function(rest)
    if rest == 'off' then M.cue = nil; return true, 'cue off' end
    local who, path = rest:match('^(%S+)%s+(.+)$')
    if not who then return false, 'usage: cue <who> <file.json> | cue off' end
    M.cue = {who = who, path = path, still = 0, at = 0}
    return true, {armed = who}
end

local function cueTick(delta, context)
    local cue = M.cue
    cue.at = cue.at + delta
    if cue.at < .1 then return end
    local elapsed = cue.at; cue.at = 0
    local player = Game.GetPlayer()
    local row = context and rowFor(context, cue.who)
    if not player or not row or not row.npc then cue.still = 0; return end
    local p, n, f = player:GetWorldPosition(), row.npc:GetWorldPosition(), player:GetWorldForward()
    local moved = cue.last and math.sqrt((p.x - cue.last.x) ^ 2 + (p.y - cue.last.y) ^ 2) or 0
    cue.last = {x = p.x, y = p.y}
    cue.from = cue.from or {x = p.x, y = p.y}
    local lead = convaiCompanions and convaiCompanions.devLead
    if lead and lead.calm and math.sqrt((p.x - cue.from.x) ^ 2 + (p.y - cue.from.y) ^ 2) > 1.5 then lead.calm = false end
    if not cue.walked then cue.walked = math.sqrt((p.x - cue.from.x) ^ 2 + (p.y - cue.from.y) ^ 2) > 1.5 end
    if not cue.walked then cue.still = 0; return end
    if moved / elapsed > .3 then cue.still = 0; return end
    local dx, dy = n.x - p.x, n.y - p.y
    local gap = math.sqrt(dx * dx + dy * dy)
    local flen = math.sqrt(f.x * f.x + f.y * f.y)
    if gap < .3 or gap > 6 or flen < .01 then cue.still = 0; return end
    local facing = math.deg(math.acos(math.max(-1, math.min(1, (dx * f.x + dy * f.y) / (gap * flen)))))
    if facing > 25 then cue.still = 0; return end
    cue.still = cue.still + elapsed
    if cue.still < 1.6 then return end
    M.cue = nil
    local ok, result = commands['speak-line'](cue.who .. ' "' .. cue.path .. '"', context)
    log('cue-fired', {who = cue.who, ok = ok, facing = facing, gap = gap, result = type(result) == 'string' and result or nil})
end

commands['face-play'] = function(rest, context)
    local who, name, rate = rest:match('^(%S+)%s*(%S*)%s*(%S*)$')
    if who == 'off' then
        local play = M.play
        if not play then return true, 'no replay' end
        local row
        for _, actor in ipairs(context.actors or {}) do if actor.entity == play.entity then row = actor end end
        playStop(play, row and row.npc, 'stopped')
        return true, 'stopped'
    end
    if not who or not name or not name:match('^[%w_%-]+$') then return false, 'usage: face-play <who> <name> [rate] | off' end
    local face = convaiFacialPlayback
    if not face or type(face.start) ~= 'function' then return false, 'facial playback unavailable' end
    if face.active and (not M.play or face.requestId ~= M.play.requestId) then return false, 'a reply owns the face' end
    local row = rowFor(context, who)
    if not row then return false, 'no owned companion matching ' .. who .. ' in range' end
    local file = io.open('runtime/' .. name .. '.json', 'rb')
    if not file then return false, 'no runtime/' .. name .. '.json' end
    local raw = file:read('*a'); file:close()
    local ok, doc = pcall(json.decode, raw)
    if not ok or type(doc) ~= 'table' or type(doc.tracks) ~= 'table' or type(doc.frames) ~= 'table' then return false, 'bad timeline file' end
    if M.play then playStop(M.play, row.npc, 'replaced') end
    local requestId = 'face-play-' .. tostring(math.floor(M.clock * 1000))
    local play = {name = name, entity = row.entity, requestId = requestId, duration = doc.duration, position = -PLAY_LEAD,
        rate = math.max(.1, math.min(2, tonumber(rate) or 1)), frames = 0,
        context = {requestId = requestId, entity = row.entity, generation = 0}}
    local timeline = {version = 1, requestId = requestId, entity = row.entity, source = 'local-jali', articulation = 'jali-audio-v1',
        tracks = doc.tracks, frames = doc.frames, duration = doc.duration}
    local started, accepted = pcall(face.start, play.context, timeline, row.npc, doc.duration)
    if not started or not accepted then return false, 'writer refused: ' .. tostring(started and face.error or accepted) end
    M.play = play
    log('play', {name = name, entity = row.entity, duration = doc.duration, rate = play.rate})
    return true, {playing = name, seconds = doc.duration, lead = PLAY_LEAD, rate = play.rate, companion = row.name or row.profileKey}
end
local function playTick(delta, context)
    local play = M.play
    local face = convaiFacialPlayback
    local row
    for _, actor in ipairs(context and context.actors or {}) do if actor.entity == play.entity then row = actor end end
    if not row or not face or face.requestId ~= play.requestId then
        M.play = nil
        log('play-lost', {name = play.name, frames = play.frames})
        return
    end
    play.position = play.position + delta * play.rate
    if play.position >= play.duration then playStop(play, row.npc, 'finished')
    elseif play.position >= 0 then
        face.sync(row.npc, play.position, play.requestId)
        play.frames = play.frames + 1
    end
end
commands['face-reload'] = function()
    local ok, result = pcall(dofile, 'facial-playback.lua')
    if not ok then return false, tostring(result) end
    return true, {reloaded = result == convaiFacialPlayback}
end

local TRACE_SIZE = 3600
-- Every mouth control the speech timelines write (one side of each symmetric pair), the expression controls that act on
-- the mouth, and the speech owner.
local TRACE_FIELDS = {'jaw_mid_open', 'lips_together_up', 'lips_together_dn', 'lips_l_funnel', 'lips_l_purse',
    'lips_l_stretch', 'lips_l_corner_stretch', 'lips_l_lower_raise', 'lips_l_upper_raise', 'lips_suck_up', 'lips_suck_dn',
    'lips_puff_up', 'cheek_l_puff', 'tongue_mid_tip_up', 'tongue_mid_fwd', 'lips_l_corner_up', 'lips_l_corner_dn',
    'lips_chin_raise', 'speech_owner'}
local function traceReset(entity)
    local ring = {entity = entity, n = 0, clock = {}, phase = {}, pos = {}, seg = {}, req = {}, state = {}}
    for _, name in ipairs(TRACE_FIELDS) do ring[name] = {} end
    M.trace = ring
end
commands['face-trace'] = function(rest, context)
    local action, who, file = rest:match('^(%S+)%s*(%S*)%s*(%S*)$')
    if action == 'off' then M.trace = nil; return true, 'trace off' end
    if action == 'on' then
        local row = rowFor(context, who ~= '' and who or 'first')
        if not row then return false, 'no owned companion matching ' .. who end
        traceReset(row.entity)
        return true, {tracing = row.entity, size = TRACE_SIZE}
    end
    if action == 'dump' then
        local ring = M.trace
        if not ring then return false, 'no trace' end
        local count = math.min(ring.n, TRACE_SIZE)
        local first = ring.n - count
        local rows = {}
        for i = 1, count do
            local at = (first + i - 1) % TRACE_SIZE + 1
            local row = {math.floor(ring.clock[at] * 1000) / 1000, ring.phase[at], ring.state[at], math.floor((ring.pos[at] or -1) * 1000) / 1000,
                ring.seg[at] or 0, ring.req[at] or ''}
            for _, name in ipairs(TRACE_FIELDS) do row[#row + 1] = math.floor((ring[name][at] or 0) * 1000) / 1000 end
            rows[i] = row
        end
        local name = who ~= '' and who or file
        local path = 'runtime/' .. ((name ~= '' and name:match('^[%w_%-]+$')) and name or 'face-trace') .. '.json'
        local out = io.open(path, 'wb')
        if not out then return false, 'cannot write ' .. path end
        out:write(encode({entity = ring.entity, frames = ring.n, fields = {'t', 'phase', 'state', 'position', 'segment', 'request', table.unpack(TRACE_FIELDS)}, rows = rows}))
        out:close()
        return true, {path = path, rows = count, frames = ring.n}
    end
    return false, 'usage: face-trace on <who> | off | dump [name]'
end
local function traceFrame(entity, feature, phase)
    local ring = M.trace
    if not ring or ring.entity ~= entity then return end
    local at = ring.n % TRACE_SIZE + 1
    ring.n = ring.n + 1
    ring.clock[at], ring.phase[at] = M.clock, phase
    local face = convaiFacialPlayback
    if face then
        ring.pos[at], ring.state[at] = face.position, face.state
        ring.seg[at] = face.segment and face.segment.index or 0
        ring.req[at] = face.requestId and tostring(face.requestId):sub(-12) or ''
    end
    for _, name in ipairs(TRACE_FIELDS) do
        local ok, value = pcall(function() return feature[name] end)
        ring[name][at] = ok and type(value) == 'number' and value or 0
    end
end

-- ---------------------------------------------------------------------------
-- face-stage: put a companion in front of V's camera, facing it, so a capture batch needs no manual framing.
--   face-stage <key> [hold-seconds]   key = a companion definition / profile key (evelyn-parker, panam-palmer, an
--                                     archetype key). An already present copy is reused; otherwise one is invited
--                                     through the party queue (the phone / manager path) and waited for.
--   face-stage status                 {state, name, placed, ...}: clearing | spawning | staged | released | lost | failed
--   face-stage off                    stop holding (her own movement takes over again)
--   face-stage dismiss                dismiss the characters this probe invited (never one that was already there)
-- Dev only (this file is not in a player package). One position check every .1 s for at most the hold (default 60 s,
-- limit 300 s), only while a stage is active, and an AI teleport command only when she is off the spot; nothing
-- otherwise. A visible placement is fine for a probe. Only the CURRENT stage is held (a new stage replaces the old
-- one, and its hold-position command lasts 8 s at most). Starting a stage first dismisses every character this probe
-- invited earlier and waits until each is really gone ('clearing'), so two characters never share a spot; the spot is
-- also moved sideways when another owned companion stands on it, and nobody is ever placed on V (.85 m away).
local STAGE_DISTANCE, STAGE_DEFAULT_HOLD, STAGE_MAX_HOLD, STAGE_SPAWN_WAIT, STAGE_PERIOD, STAGE_RESEND = .85, 60, 300, 75, .1, .25
-- `face-stage distance <metres>` sets how far in front of V the spot is (.7 to 2; .85 by default, reset by a reload). A
-- spot closer than the two bodies' capsules put V under the character's collision: a big body (jackie, pepe) pushed V,
-- the old live-camera hold followed V's new position, and both drifted until V fell through the floor (October 9).
-- So the spot is fixed ONCE at stage time (anchor) and never re-derived; big bodies (man_big, man_fat graphs, or an
-- unreadable graph) are never closer than STAGE_BIG_DISTANCE; and the stage aborts when V moves more than STAGE_MOVE_LIMIT.
local STAGE_MIN_DISTANCE, STAGE_BIG_DISTANCE, STAGE_MOVE_LIMIT, STAGE_LIFT_LIMIT = .7, 1.3, .3, .5
M.stageDistance = M.stageDistance or STAGE_DISTANCE
M.spawned = M.spawned or {}
M.leaving = M.leaving or {}

-- Complete control while a character is staged (development only; nothing persists: convaiCompanions.devQuiet lives in
-- the companion module, so a CET reload or a crash defaults back to off). The companion update then skips that copy
-- entirely (follow, turning, unstick, body animation, gestures, look-at updates); only this probe moves her.
local function setQuiet(stage, on)
    if not stage or not stage.serial then return end
    local companions = convaiCompanions
    if type(companions) ~= 'table' then return end
    if on then
        companions.devQuiet = companions.devQuiet or {}
        companions.devQuiet[stage.serial] = stage.gestures and 'gestures' or true
    elseif companions.devQuiet then
        companions.devQuiet[stage.serial] = nil
        if next(companions.devQuiet) == nil then companions.devQuiet = nil end
    end
    stage.quiet = on == true
end
-- Body still, face live (development only): the vanilla idle sways the head by 20 cm and fidgets, which ruins a face
-- capture. A strong individual time dilation on the staged copy slows her body to a near stop while the facial
-- AnimFeature keeps updating (checked live: smile and brow poses still appear). It is finite (30 s) and refreshed by the
-- stage tick every 15 s, so a CET reload or a crash lets it run out on its own; it is removed on thaw, stage end and dismiss.
local FREEZE_REASON, FREEZE_VALUE, FREEZE_SECONDS, FREEZE_REFRESH = 'ConvaiFaceStage', .02, 30, 15
local function thaw(stage)
    if not stage then return end
    stage.freeze, stage.frozenAt = false, nil
    if stage.frozen and stage.npc then
        pcall(function()
            if stage.npc:HasIndividualTimeDilation(CName.new(FREEZE_REASON)) then stage.npc:UnsetIndividualTimeDilation(CName.new('')) end
        end)
    end
    stage.frozen = false
end
-- A strong look-at on V's eyes for the staged copy (development only): the vanilla idle looks around and down, which
-- turns the face away from the camera. Removed with the stage; a CET reload leaves it on the probe's own copy only,
-- which the next dismissal removes.
local function lookAtV(stage, on)
    if not stage or not stage.npc then return false end
    if on then
        if stage.lookEvent then return true end
        local ok = pcall(function()
            local event = LookAtAddEvent.new()
            event:SetEntityTarget(Game.GetPlayer(), CName.new('pla_default_tgt'), Vector4.new(0, 0, 0, 0))
            event:SetStyle(Enum.new('animLookAtStyle', 'Normal'))
            event.bodyPart = CName.new('Eyes')
            local wide = stage.wide == true -- side by side on a seat: V is about 90 degrees off her forward axis
            event.request.limits.softLimitDegrees = wide and 140 or 90
            event.request.limits.hardLimitDegrees = wide and 170 or 140
            event.request.limits.backLimitDegrees = wide and 170 or 140
            event.request.limits.hardLimitDistance = 5
            local head = LookAtPartRequest.new()
            head.partName, head.weight, head.suppress, head.mode = CName.new('Head'), 1, 1, 0
            event:SetAdditionalPartsArray({head})
            stage.lookEvent = event
            stage.npc:QueueEvent(event)
        end)
        if not ok then stage.lookEvent = nil end
        return ok
    elseif stage.lookEvent then
        local event = stage.lookEvent
        stage.lookEvent = nil
        pcall(function() LookAtRemoveEvent.QueueRemoveLookatEvent(stage.npc, event) end)
    end
    return true
end
-- gaze <who> | gaze off (development only): the same strong look at V's eyes as a staged copy's, for any companion in range
-- (a seated one included). One at a time; `gaze off` removes it.
commands['gaze'] = function(rest, context)
    if M.gazeHold then lookAtV(M.gazeHold, false); M.gazeHold = nil end
    if convaiCompanions then convaiCompanions.devGazeKey = nil end
    if rest == 'off' or rest == '' then return true, 'gaze off' end
    local row = context and rowFor(context, rest)
    if not row or not row.npc then return false, 'no companion matching ' .. rest .. ' in range' end
    M.gazeHold = {npc = row.npc, wide = true}
    -- A seated companion's own glance steps aside while this look is held (companion-seating.lua).
    if convaiCompanions then
        local okKey, key = pcall(function() return tostring(row.npc:GetEntityID().hash) end)
        convaiCompanions.devGazeKey = okKey and key or nil
    end
    return lookAtV(M.gazeHold, true), {gaze = row.name}
end
local function endStage(stage, state)
    if not stage then return end
    thaw(stage)
    lookAtV(stage, false)
    setQuiet(stage, false)
    if state then stage.state = state end
end

local function stageTarget(distance)
    distance = distance or M.stageDistance
    local player = Game.GetPlayer()
    if not player then return nil, 'no player' end
    local ok, _, forward = pcall(function() return Game.GetTargetingSystem():GetCrosshairData(player) end)
    if not ok or not forward then forward = player:GetWorldForward() end
    local length = forward and math.sqrt(forward.x * forward.x + forward.y * forward.y) or 0
    if length < 1e-3 then return nil, 'no camera direction' end
    local fx, fy = forward.x / length, forward.y / length
    local at = player:GetWorldPosition()
    -- Yaw convention: forward = (-sin yaw, cos yaw), so the camera's yaw is atan2(-fx, fy); she turns the other way.
    local atan2 = math.atan2 or math.atan -- LuaJIT (the game) has atan2; Lua 5.3 takes two arguments in atan
    local yaw = math.deg(atan2(-fx, fy)) + 180
    return {x = at.x + fx * distance, y = at.y + fy * distance, z = at.z, yaw = yaw, rx = -fy, ry = fx, vx = at.x, vy = at.y, vz = at.z}
end

-- Probe-invited keys that were dismissed but still have a copy standing: the next stage waits for them to be gone.
local function pendingLeaving(context)
    local pending = 0
    for index = #M.leaving, 1, -1 do
        if rowFor(context, M.leaving[index]) then pending = pending + 1 else table.remove(M.leaving, index) end
    end
    return pending
end

-- Dismisses what this probe invited (through the party queue; the copy goes at the next gameplay flush).
local function dismissSpawned(except)
    local done = {}
    local queue = convaiManager and convaiManager.party and convaiManager.party()
    for index = #M.spawned, 1, -1 do
        local key = M.spawned[index]
        local ok, rows = pcall(function() return queue.list() end)
        for _, member in ipairs(ok and rows or {}) do
            if member.key == key and key ~= except then
                local called, accepted, message = pcall(queue.dismiss, member.id, true) -- quiet: no 'dismissed' notice
                done[#done + 1] = {key = key, id = member.id, ok = called and accepted == true, result = called and message or tostring(accepted)}
            end
        end
        if key ~= except then M.leaving[#M.leaving + 1] = key; table.remove(M.spawned, index) end
    end
    return done
end

-- The first of the straight-ahead spot and two sidesteps that no other owned companion occupies (within .6 m).
local function freeSpot(context, target, current)
    for _, side in ipairs({0, .8, -.8}) do
        local x, y = target.x + target.rx * side, target.y + target.ry * side
        local free = true
        for _, other in ipairs(context and context.actors or {}) do
            if other.entity ~= current.entity and other.npc then
                local ok, at = pcall(function() return other.npc:GetWorldPosition() end)
                if ok and at and math.sqrt((at.x - x) ^ 2 + (at.y - y) ^ 2) < .6 then free = false; break end
            end
        end
        if free then return {x = x, y = y, z = target.z, yaw = target.yaw} end
    end
end

-- A big body's capsule overlaps V's at the usual .85 m. The graph name (ConvaiFaceStatus, 'prepared:man_big_sermo') tells
-- the build; an unreadable graph counts as big, the safe side.
local function bigBody(npc)
    local ok, status = pcall(function() return tostring(npc:ConvaiFaceStatus()) end)
    if not ok or not status or status == '' then return true end
    return status:find('man_big', 1, true) ~= nil or status:find('man_fat', 1, true) ~= nil
end
-- Fixes the spot ONCE: a world position and yaw from V's camera at this moment, plus V's own position to detect that V
-- moved (pushed by a collision, walking, a teleport). Nothing later re-derives it from the live camera.
local function anchorStage(stage, row, context)
    local distance = math.max(M.stageDistance, STAGE_MIN_DISTANCE)
    if bigBody(row.npc) then distance = math.max(distance, STAGE_BIG_DISTANCE) end
    local target, why = stageTarget(distance)
    if not target then return nil, why end
    local spot = freeSpot(context, target, row)
    if not spot then return nil, 'every spot in front of V is taken' end
    stage.anchor = {x = spot.x, y = spot.y, z = spot.z, yaw = spot.yaw}
    stage.origin = {x = target.vx, y = target.vy, z = target.vz}
    stage.distance = distance
    return true
end

-- Reuses a present copy of the character, otherwise invites one through the party queue. Returns ok, error.
local function beginStage(stage, context)
    stage.state, stage.deadline = 'spawning', M.clock + STAGE_SPAWN_WAIT
    if rowFor(context, stage.who) then return true end -- picked up on the next tick; no new copy
    local listed = {}
    local ok, rows = pcall(convaiCompanions.list)
    for _, row in ipairs(ok and rows or {}) do
        if row.key == stage.who or tostring(row.profileKey or '') == stage.who then listed[#listed + 1] = row end
    end
    if #listed == 0 then
        -- The real invitation path (manager-party queue): preparation, then the spawn on the next gameplay flush.
        local queue = convaiManager and convaiManager.party and convaiManager.party()
        if not queue then return false, 'the party queue is not available' end
        local called, accepted, message = pcall(queue.invite, stage.who, {quiet = true}) -- no 'joined' notice for a probe copy
        if not called or not accepted then return false, 'invitation refused: ' .. tostring(called and message or accepted) end
        M.spawned[#M.spawned + 1] = stage.who
        stage.spawnedHere = true
    end
    return true
end

local function stageTick(context)
    local stage = M.stage
    if not stage or stage.state == 'released' or stage.state == 'lost' or stage.state == 'failed' then return end
    if M.clock < stage.nextAt then return end
    stage.nextAt = M.clock + STAGE_PERIOD
    if stage.state == 'clearing' then
        if pendingLeaving(context or {}) == 0 then
            local ok, err = beginStage(stage, context or {})
            if not ok then stage.state, stage.error = 'failed', err end
        elseif M.clock > stage.deadline then stage.state, stage.error = 'failed', 'the previous copy did not leave in time' end
        return
    end
    local row = context and rowFor(context, stage.who)
    if stage.state == 'spawning' then
        if row then
            stage.state, stage.entity, stage.name, stage.until_, stage.startedAt = 'staged', row.entity, row.name, M.clock + stage.hold, M.clock
            -- The probe context rows carry no serial; the companion list does (matched by the profile key, one copy per stage).
            stage.serial = row.serial
            if not stage.serial then
                local lok, listed = pcall(convaiCompanions.list)
                for _, entry in ipairs(lok and listed or {}) do
                    if tostring(entry.profileKey or entry.key) == tostring(row.profileKey or stage.who) then stage.serial = entry.serial end
                end
            end
            local anchored, why = anchorStage(stage, row, context or {})
            if not anchored then stage.state, stage.error = 'failed', why; log('stage-failed', {who = stage.who, why = why}); return end
            setQuiet(stage, true)
        elseif M.clock > stage.deadline then stage.state, stage.error = 'failed', 'the copy did not become ready in time'; return
        else return end
    end
    if M.clock >= stage.until_ then endStage(stage, 'released'); log('stage-released', {who = stage.who, placed = stage.placed}); return end
    local current
    if row and row.entity == stage.entity then current = row
    else for _, other in ipairs(context and context.actors or {}) do if other.entity == stage.entity then current = other end end end
    -- Pinned, she may drop out of the nearby rows while V frames the shot from further away: keep holding the same entity.
    -- IsDefined stays true for a kept handle of a despawned copy, so the copy must also still be attached to the world.
    if not current and M.stagePinned and stage.npc and IsDefined(stage.npc) then
        local attached, yes = pcall(function() return stage.npc:IsAttached() end)
        if attached and yes == true then current = {npc = stage.npc, entity = stage.entity} end
    end
    if not current then endStage(stage, 'lost'); log('stage-lost', {who = stage.who}); return end
    -- V moved (a collision pushed V, V walked or was teleported): stop instead of following V's new position.
    local player = Game.GetPlayer()
    local pat = player and player:GetWorldPosition()
    if not pat then endStage(stage, 'failed'); stage.error = 'no player'; return end
    local origin = stage.origin
    -- 'face-stage pin' keeps her on her spot while V moves (framing a recorded shot); otherwise a move ends the stage.
    if not M.stagePinned and (math.sqrt((pat.x - origin.x) ^ 2 + (pat.y - origin.y) ^ 2) > STAGE_MOVE_LIMIT or math.abs(pat.z - origin.z) > STAGE_LIFT_LIMIT) then
        endStage(stage, 'failed'); stage.error = 'V moved during the stage'
        log('stage-aborted', {who = stage.who, moved = math.sqrt((pat.x - origin.x) ^ 2 + (pat.y - origin.y) ^ 2), lift = pat.z - origin.z})
        return
    end
    local target = stage.anchor
    stage.error = nil
    stage.npc = current.npc
    if stage.freeze and M.clock >= (stage.frozenAt or 0) + FREEZE_REFRESH then
        stage.frozenAt = M.clock
        stage.frozen = pcall(function() current.npc:SetIndividualTimeDilation(CName.new(FREEZE_REASON), FREEZE_VALUE, FREEZE_SECONDS, CName.new(''), CName.new('')) end)
    end
    -- A transform teleport is undone by the copy's own locomotion (seen live: she stayed beside V), so the placement is
    -- an AITeleportCommand through her AI controller, the actuator's own mechanism. It is sent only when she is not
    -- already there (more than .08 m or 6 degrees off), at most every .25 s; once placed she simply stays.
    local ok, err = pcall(function()
        local at = current.npc:GetWorldPosition()
        local off = math.sqrt((at.x - target.x) ^ 2 + (at.y - target.y) ^ 2 + (at.z - target.z) ^ 2)
        local turn = math.abs((current.npc:GetWorldYaw() - target.yaw + 180) % 360 - 180)
        if (off > .08 or turn > 6) and M.clock >= (stage.sendAt or 0) then
            local command = NewObject('AITeleportCommand')
            command.position = Vector4.new(target.x, target.y, target.z, 1)
            command.rotation = target.yaw
            command.doNavTest = false
            current.npc:GetAIControllerComponent():SendCommand(command)
            stage.placed, stage.sendAt = stage.placed + 1, M.clock + STAGE_RESEND
            stage.lastSend = M.clock
        end
        -- A walking companion keeps leaving the spot, so she is also told to hold position (8 s long, re-sent every 4 s so it ends soon after the stage; the
        -- command class is optional: if the game lacks it the stage still works, only less steadily).
        if M.clock >= (stage.holdAt or 0) then
            stage.holdAt = M.clock + 4
            pcall(function()
                local hold = NewObject('AIHoldPositionCommand')
                if hold then
                    hold.duration = 8 -- never longer than the next re-send plus a margin, so it ends with the stage
                    hold.ignoreInCombat = false
                    hold.removeAfterCommandCompletion = true
                    current.npc:GetAIControllerComponent():SendCommand(hold)
                end
            end)
        end
    end)
    if not ok then endStage(stage, 'failed'); stage.error = tostring(err) end
end

commands['face-stage'] = function(rest, context)
    local word, tail = rest:match('^(%S+)%s*(.*)$')
    if not word then return false, 'usage: face-stage <key> [hold-seconds] | status | check | distance <m> | look | freeze | thaw | gestures | nogestures | off | dismiss' end
    if word == 'status' then
        local stage = M.stage
        if not stage then return true, {state = 'none', leaving = pendingLeaving(context)} end
        return true, {state = stage.state, who = stage.who, name = stage.name, placed = stage.placed, error = stage.error,
            spawnedHere = stage.spawnedHere, hold = stage.hold, leaving = pendingLeaving(context)}
    elseif word == 'check' then
        -- On request only: is the staged character where and how she should be? Used by the capture batch to retry a
        -- frame instead of keeping a bad one: distance to the spot, body yaw error against the camera, seconds since the
        -- last placement command (a character still being moved is not steady), and where the real head bone is on
        -- screen (normalised -1..1, from the camera projection) so the crop follows the head, not a fixed height.
        local stage = M.stage
        local row = stage and rowFor(context, stage.who)
        if not stage or not row or stage.state ~= 'staged' then return false, 'no staged character (' .. tostring(stage and stage.state) .. ')' end
        local target = stage.anchor
        if not target then return false, 'the stage has no anchor yet' end
        local out = {distance = stage.distance, name = row.name, quiet = M.clock - (stage.lastSend or stage.startedAt or M.clock)}
        local ok, err = pcall(function()
            local at = row.npc:GetWorldPosition()
            out.off = math.sqrt((at.x - target.x) ^ 2 + (at.y - target.y) ^ 2)
            out.turn = math.abs((row.npc:GetWorldYaw() - target.yaw + 180) % 360 - 180)
            local head = at
            local sok, _, t = pcall(function() local o, tr = row.npc:GetSlotComponent():GetSlotTransform(CName.new('Head')); return o, tr end)
            if sok and t then local pok, v = pcall(function() return t.Position:ToVector4() end); if pok and v then head = v end end
            -- How each local axis of the head bone points against the camera's view direction (dot product, 1 = straight at
            -- the camera): the axis that is near 1 for a frontal head is the face direction, so a head tilted down or turned
            -- aside shows as a low value there.
            if sok and t then
                pcall(function()
                    local q, f = t.Orientation, Game.GetCameraSystem():GetActiveCameraForward()
                    local function rot(x, y, z)
                        local tx, ty, tz = 2 * (q.j * z - q.k * y), 2 * (q.k * x - q.i * z), 2 * (q.i * y - q.j * x)
                        return x + q.r * tx + (q.j * tz - q.k * ty), y + q.r * ty + (q.k * tx - q.i * tz), z + q.r * tz + (q.i * ty - q.j * tx)
                    end
                    local ax, ay, az = rot(1, 0, 0); local bx, by, bz = rot(0, 1, 0); local cx, cy, cz = rot(0, 0, 1)
                    out.faceDot = {-(ax * f.x + ay * f.y + az * f.z), -(bx * f.x + by * f.y + bz * f.z), -(cx * f.x + cy * f.y + cz * f.z)}
                end)
            end
            -- Identity as the game sees it: the record and the appearance this copy wears.
            pcall(function() out.record = tostring(TDBID.ToStringDEBUG(row.npc:GetRecordID())) end)
            pcall(function() out.appearance = NameToString(row.npc:GetCurrentAppearanceName()) end)
            pcall(function() out.display = tostring(row.npc:GetDisplayName()) end)
            pcall(function() out.graph = tostring(row.npc:ConvaiFaceStatus()) end)
            local screen = Game.GetCameraSystem():ProjectPoint(head)
            out.headX, out.headY, out.headZ = screen.x, screen.y, head.z - at.z
        end)
        if not ok then return false, tostring(err) end
        out.silenced = stage.quiet == true
        out.frozen = stage.frozen == true
        out.looking = stage.lookEvent ~= nil
        out.steady = out.quiet >= 3 and out.off < .25 and out.turn < 12
        out.inFrame = out.headX ~= nil and math.abs(out.headX) < .6 and math.abs(out.headY) < .75
        return true, out
    elseif word == 'distance' then
        local metres = tonumber(tail)
        if not metres then return true, {distance = M.stageDistance} end
        M.stageDistance = math.max(STAGE_MIN_DISTANCE, math.min(2, metres))
        return true, {distance = M.stageDistance}
    elseif word == 'gestures' or word == 'nogestures' then
        -- Body gestures while she is staged (a scripted line, speak-line): the quiet mark then leaves her gesture owner running.
        local stage = M.stage
        if not stage then return false, 'no stage' end
        stage.gestures = word == 'gestures'
        if stage.quiet then setQuiet(stage, true) end
        -- The gesture owner's scene guard also refuses in a restricted zone (scene tier above 1: clubs, quest hubs). For a staged
        -- recording that guard is lifted while gestures are on, and put back with nogestures or a reload.
        local owner = convaiGestures
        if owner then
            owner.guardKept = owner.guardKept or owner.allowed
            owner.allowed = stage.gestures and function() return true end or owner.guardKept
        end
        return true, word
    elseif word == 'pin' or word == 'unpin' then
        M.stagePinned = word == 'pin'
        return true, word
    elseif word == 'idle' then
        -- Prefer one idle (a gesture-catalog key such as panam_beer) for every copy; 'idle off' clears it.
        if not convaiGestures or not convaiGestures.preferIdle then return false, 'gesture owner not loaded' end
        local key = tail ~= '' and tail ~= 'off' and tail or nil
        convaiGestures.preferIdle(key)
        return true, {idle = key or 'off'}
    elseif word == 'look' or word == 'unlook' then
        local stage = M.stage
        if not stage or stage.state ~= 'staged' then return false, 'no staged character' end
        return lookAtV(stage, word == 'look'), word
    elseif word == 'freeze' or word == 'thaw' then
        local stage = M.stage
        if not stage or stage.state ~= 'staged' then return false, 'no staged character' end
        if word == 'freeze' then stage.freeze, stage.frozenAt = true, nil else thaw(stage) end
        return true, word == 'freeze' and 'freezing' or 'thawed'
    elseif word == 'off' then
        endStage(M.stage, 'released')
        return true, 'released'
    elseif word == 'dismiss' then
        thaw(M.stage)
        lookAtV(M.stage, false)
        -- Only characters this probe invited (their key was absent at the time): through the party queue's own
        -- dismissal, which removes the copy (or cancels a still pending invitation) at the next gameplay flush.
        local done = dismissSpawned()
        endStage(M.stage, 'released')
        return true, {dismissed = done, leaving = pendingLeaving(context)}
    end
    local hold = math.max(5, math.min(STAGE_MAX_HOLD, tonumber(tail) or STAGE_DEFAULT_HOLD))
    if not convaiCompanions then return false, 'companion runtime not loaded' end
    -- Earlier probe copies go first, and the new character waits until they are really gone ('clearing').
    local stage = {who = word, hold = hold, state = 'clearing', placed = 0, nextAt = 0, deadline = M.clock + 20}
    dismissSpawned(word)
    endStage(M.stage) -- the previous stage no longer holds or silences anyone
    if pendingLeaving(context) == 0 then
        local ok, err = beginStage(stage, context)
        if not ok then return false, err end
    end
    M.stage = stage
    log('stage', {who = word, hold = hold, spawned = stage.spawnedHere == true})
    return true, {staging = word, hold = hold, spawnedHere = stage.spawnedHere == true}
end

-- A world unload (mod/init.lua abandonSession: a load, a detach, a death). The stage's companion handle and its look-at event
-- (aimed at the old V) must not outlive the world, and the stage must not keep sending AI commands to a copy of the old world
-- (18 Oct 13:32 crash: SendCommand on the pinned old Johnny from onUpdate during a load). Only references are dropped here, no
-- native call: the copy is being destroyed with its world, and so are its time dilation and look-at.
function M.abandon(reason)
    local stage = M.stage
    if stage then
        if stage.state ~= 'released' and stage.state ~= 'lost' and stage.state ~= 'failed' then log('stage-abandoned', {who = stage.who, reason = reason}) end
        stage.npc, stage.lookEvent, stage.frozen = nil, nil, false
        stage.state = 'released'
    end
    M.stage, M.play, M.cue, M.run = nil, nil, nil, nil
    local companions = convaiCompanions
    if type(companions) == 'table' then companions.devQuiet = nil end -- keyed by the old copies' serials
end

local function step(run)
    return run.steps[math.min(#run.steps, math.floor(run.elapsed / run.per) + 1)]
end

-- Called once per frame from the facial writer's frame start.
function M.poll(delta, context)
    delta = (type(delta) == 'number' and delta == delta and delta > 0 and delta < .5) and delta or 0
    M.clock = M.clock + delta
    if M.stage then local ok, err = pcall(stageTick, context); if not ok then M.stage.state, M.stage.error = 'failed', tostring(err) end end
    if M.play then local ok, err = pcall(playTick, delta, context); if not ok then log('play-error', {error = tostring(err)}); M.play = nil end end
    if M.cue then local ok, err = pcall(cueTick, delta, context); if not ok then log('cue-error', {error = tostring(err)}); M.cue = nil end end
    local run = M.run
    if run then
        run.elapsed = run.elapsed + delta
        if run.elapsed >= run.duration then
            log('finished', {pose = run.pose, mode = run.mode, frames = run.frames})
            M.run = nil
        elseif context and context.actors then
            local present = false
            for _, row in ipairs(context.actors) do if row.entity == run.entity then present = true end end
            if not present then log('target-lost', {pose = run.pose}); M.run = nil end
        end
    end
    if M.clock < M.pollAt then return end
    -- Developer mailbox: one CET io.open costs 1-2 ms of the game thread, so poll once a second (every 4 s with
    -- Developer mode off; init.lua's convaiDevMailboxPeriod).
    M.pollAt = M.clock + (M.pollPeriod or (convaiDevMailboxPeriod and convaiDevMailboxPeriod()) or 1)
    local file = io.open(REQUEST, 'rb')
    if not file then return end
    local raw = file:read('*a'); file:close()
    local nonce, command = tostring(raw):match('^([^\r\n]+)\r?\n(.*)$')
    if not nonce or nonce == M.lastNonce then return end
    M.lastNonce = nonce
    command = command:gsub('^%s+', ''):gsub('%s+$', '')
    log('request', {nonce = nonce, command = command})
    local name, rest = command:match('^(%S+)%s*(.*)$')
    local handler = name and commands[name]
    if not handler then respond(nonce, false, 'unknown command'); return end
    local ok, success, result = pcall(handler, rest, context or {})
    if not ok then respond(nonce, false, tostring(success)) else respond(nonce, success, result) end
end

local function active(entity, mode)
    local run = M.run
    return run and run.entity == entity and (mode == nil or run.mode == mode) and run or nil
end

-- Before the writer composes expression: policy mode injects a scale-3 feeling.
M.policyTouched = M.policyTouched or {}
function M.pre(entity, slot, clock)
    local run = active(entity, 'policy')
    if not run then
        -- A policy run that ended (off, finished, replaced) must leave no injected
        -- feeling behind: clear it so the writer returns to its real resting state.
        if M.policyTouched[entity] then
            slot.emotion, slot.family, slot.scale, slot.expiry, slot.holdMix, slot.browExpiry = nil, nil, nil, nil, nil, nil
            slot.flick = {}
            M.policyTouched[entity] = nil
        end
        return
    end
    M.policyTouched[entity] = true
    local label = policyFamily[step(run).label:match('^[^@]+')] or ({['ramp-smile']='Joy',['ramp-frown']='Sadness',['ramp-brows']='Surprise'})[run.pose]
    if label then
        slot.emotion, slot.scale, slot.expiry = label, 3, nil
        slot.family = label:lower() == 'joy' and 'joy' or label:lower() == 'sadness' and 'sadness'
            or label:lower() == 'surprise' and 'surprise' or 'anger'
        -- Surprise is a 1 s flick by design (gone by 2 s); a still capture needs its peak, so the probe keeps it fresh.
        if slot.family == 'surprise' and slot.flick then slot.flick.surprise = 0 end
    end
end

local function snapshot(feature, run, tracks)
    local written = {}
    for _, name in ipairs(EXPRESSION) do
        local ok, value = pcall(function() return feature[name] end)
        if ok and type(value) == 'number' and value ~= 0 then written[name] = math.floor(value * 1000) / 1000 end
    end
    for name in pairs(tracks or {}) do
        local ok, value = pcall(function() return feature[name] end)
        written[name] = ok and type(value) == 'number' and math.floor(value * 1000) / 1000 or 'unreadable'
    end
    return written
end

local function trace(run, label, feature, tracks, extra)
    if run.elapsed < run.logAt then return end
    run.logAt = run.elapsed + .5
    local mouth = {}
    for _, name in ipairs({'jaw_mid_open', 'lips_together_up', 'lips_l_funnel', 'lips_l_purse'}) do
        local ok, value = pcall(function() return feature[name] end)
        if ok and type(value) == 'number' and value ~= 0 then mouth[name] = math.floor(value * 1000) / 1000 end
    end
    local record = {pose = run.pose, step = label, mode = run.mode, entity = run.entity, frames = run.frames,
        written = snapshot(feature, run, tracks), mouth = mouth}
    for k, v in pairs(extra or {}) do record[k] = v end
    log('frame', record)
end

-- After the writer composed the feature, before ConvaiFaceApply. Writer mode
-- overwrites only the ten expression fields: no caps, no smoothing, mouth intact.
-- Returns true when the write must be skipped (direct mode owns the actor).
function M.post(entity, feature, phase, blocked)
    if M.trace then pcall(traceFrame, entity, feature, phase) end
    local run = active(entity)
    if not run then
        -- Probe ended (off, finished, replaced): clear every leftover probe field
        -- from this idle feature. A speaking feature is rewritten by speech itself.
        local touched = M.touched[entity]
        if touched and phase ~= 'speaking' then
            for name in pairs(touched) do pcall(function() feature[name] = 0 end) end
            M.touched[entity] = nil
        end
        return false
    end
    if run.mode == 'direct' then return true end
    local current = step(run)
    run.frames = run.frames + 1
    if run.mode == 'writer' then
        for _, name in ipairs(EXPRESSION) do pcall(function() feature[name] = current.tracks[name] or 0 end) end
        -- Extra tracks of a custom pose (for example jaw_mid_open as a control).
        local touched = M.touched[entity] or {}
        M.touched[entity] = touched
        for name in pairs(touched) do
            if current.tracks[name] == nil then pcall(function() feature[name] = 0 end); touched[name] = nil end
        end
        for name, value in pairs(current.tracks) do
            if not EXPRESSION_SET[name] then touched[name] = true end
            pcall(function() feature[name] = value end)
        end
    end
    trace(run, current.label, feature, current.tracks, {phase = phase, blocked = blocked == true})
    return false
end

-- Direct mode: own feature, own apply, every frame, writer bypassed.
function M.direct(rows, createFeature)
    local run = M.run
    if not run or run.mode ~= 'direct' then return end
    for _, row in ipairs(rows or {}) do
        if row.entity == run.entity then
            local current = step(run)
            local feature = createFeature()
            local failed
            for name, value in pairs(current.tracks) do
                local ok = pcall(function() feature[name] = value end)
                if not ok then failed = (failed and failed .. ',' or '') .. name end
            end
            run.frames = run.frames + 1
            local ok, applied = pcall(function() return row.npc:ConvaiFaceApply(feature) end)
            local status
            pcall(function() status = row.npc:ConvaiFaceStatus() end)
            trace(run, current.label, feature, current.tracks,
                {applied = ok and applied or tostring(applied), unwritable = failed, status = status})
            return
        end
    end
end

function M.skips(entity) return active(entity, 'direct') ~= nil end

convaiFaceTest = M
return M
