-- Developer probe for Johnny's glitching hologram (docs/JOHNNY_IN_YOUR_HEAD.md, phase 3; mod/johnny-hologram.lua), run through
-- mod/johnny-probe.lua as "johnny-probe:hologram:<action>:<stamp>" in Developer mode only. The offline work cannot say which look reads
-- as the game's own glitch at standing distance, or whether Johnny's phantom controller hides the whole copy: this puts one of OUR copies
-- (never the game's Johnny) in front of V with one of the candidate looks, reports what the game made of it, and removes it again.
--   spawn:<A-E>   one copy in front of V with that look (mod/johnny-hologram.lua M.LOOKS), shown for SHOW_SECONDS and then deleted
--   despawn       delete the copy now
--   sweep         delete every copy of ours by tag (anything left by a reload)
--   status        the copy's state and the last report, and the service the settings drive (read only)
--   looks         the candidate looks and what each one does (read only)
-- The copy is built by the service's own native layer (the same record, tag, spot search, look and delete), so what this shows is what
-- the setting would show. It touches only an entity that carries the hologram tag, never the game's Johnny, and keeps no handle: the
-- copy is found again by its entity ID on each step. Bounded: one copy at a time, SHOW_SECONDS, at most MAX_COMPONENTS rows.
local M = convaiJohnnyHologramProbe or {}
convaiJohnnyHologramProbe = M
M.SHOW_SECONDS, M.SPAWN_SECONDS, M.MAX_COMPONENTS = 25, 6, 40
local unavailable = 'unavailable'

local function hologram()
    if not M.module then
        local ok, module = pcall(dofile, 'johnny-hologram.lua')
        M.module = ok and type(module) == 'table' and type(module.native) == 'table' and module or false
    end
    return M.module or nil
end

local function read(fn, ...)
    local ok, value = pcall(fn, ...)
    if ok then return value end
    return nil
end

local function plainName(value)
    if value == nil then return nil end
    local text = read(function() return Game.NameToString(value) end)
    if type(text) ~= 'string' or text == '' or text == 'None' then text = read(tostring, value) end
    return type(text) == 'string' and text:sub(1, 60) or nil
end

local function number(value)
    return type(value) == 'number' and value == value and math.abs(value) < math.huge and value or unavailable
end

-- What the game made of the copy: appearance, components (the phantom controller above all), distance to V. All reads guarded.
local function describe(npc, player, requested)
    local report = {appearanceRequested = requested}
    report.appearance = plainName(read(function() return npc:GetCurrentAppearanceName() end)) or unavailable
    report.attached = read(function() return npc:IsAttached() end)
    report.visible = read(function() return npc:IsVisible() end)
    report.dead = read(function() return npc:IsDeadNoStatPool() end)
    local mine, theirs = read(function() return player:GetWorldPosition() end), read(function() return npc:GetWorldPosition() end)
    if mine and theirs then
        report.distance = number(math.sqrt((mine.x - theirs.x) ^ 2 + (mine.y - theirs.y) ^ 2 + (mine.z - theirs.z) ^ 2))
    end
    local components = read(function() return npc:GetComponents() end)
    report.components, report.phantoms = {}, 0
    for _, component in ipairs(type(components) == 'table' and components or {}) do
        local class = plainName(read(function() return component:GetClassName() end))
        local phantom = read(function() return component:IsA('gamePhantomEntityComponent') end) == true
        if phantom then report.phantoms = report.phantoms + 1 end
        if #report.components < M.MAX_COMPONENTS and (phantom or #report.components < 12) then
            report.components[#report.components + 1] = {class = class or unavailable, name = plainName(read(function() return component.name end)) or unavailable,
                phantom = phantom or nil}
        end
    end
    report.componentCount = type(components) == 'table' and #components or unavailable
    return report
end

-- The live service the settings drive: nil (not created yet), false (its file did not load) or the service.
local function service()
    return convaiJohnnyHologram
end

local function summary()
    local lines = {}
    local visit = M.visit
    if not visit then
        lines[#lines + 1] = 'No copy yet: send spawn:<look> (looks lists them), with a world loaded and V standing in the open.'
    else
        lines[#lines + 1] = string.format('Look %s: %s (%.0f s ago).', visit.look, visit.state, os.clock() - visit.at)
        if visit.spotTried then
            lines[#lines + 1] = 'Spot search: ' .. table.concat(visit.spotTried, ', ') .. '.'
        end
        if visit.report then
            local r = visit.report
            lines[#lines + 1] = string.format('Seen by the game: appearance %s (asked for %s), visible=%s, %s m from V, %d phantom controller(s), look applied: %s.',
                tostring(r.appearance), tostring(r.appearanceRequested), tostring(r.visible), tostring(r.distance and number(r.distance) ~= unavailable
                    and string.format('%.1f', r.distance) or '?'), r.phantoms or 0, visit.applied and string.format('phantom off=%d, effects=%d, flicker=%d',
                    visit.applied.phantom or 0, visit.applied.effects or 0, visit.applied.flicker or 0) or 'not yet')
        end
        if visit.problem then lines[#lines + 1] = 'Problem: ' .. tostring(visit.problem) end
    end
    return lines
end

local function plainLooks(module)
    local out = {}
    for key, look in pairs(module.LOOKS) do
        local effects = {}
        for _, name in ipairs(look.effects or {}) do effects[#effects + 1] = name end
        out[key] = {appearance = look.appearance, phantom = look.phantom, effects = effects, flicker = look.flicker == true}
    end
    return out
end

function M.report()
    local module = hologram()
    local live = service()
    return {version = 1, probe = 'johnny-hologram', run = M.runId, at = os.time(),
        visit = M.visit and {look = M.visit.look, state = M.visit.state, ageSeconds = os.clock() - M.visit.at, report = M.visit.report,
            applied = M.visit.applied, spotTried = M.visit.spotTried, problem = M.visit.problem, stoppedReason = M.visit.stoppedReason} or nil,
        defaultLook = module and module.DEFAULT_LOOK or nil, looks = module and plainLooks(module) or nil,
        service = live and read(live.status, live) or (live == false and 'failed to load' or 'not created (both settings on, then sit down)'),
        settings = {johnnyInHead = read(manager.johnnyInHead), johnnyHologram = read(manager.johnnyHologram)},
        summary = summary(),
        read = 'visit.report is what the game made of the copy (appearance, components, phantom controllers, distance); judge the look by eye: '
            .. 'does it read as the game\'s own glitch at standing distance, is he visible at all, does the flicker play. '
            .. 'service is the live setting\'s own state (cooldown, a waiting sit, a visit).'}
end

local function finish(reason)
    local visit = M.visit
    if not visit or visit.state == 'gone' then return false end
    local module = hologram()
    if module and visit.id ~= nil then pcall(module.native.delete, visit.id) end
    visit.state, visit.stoppedReason = 'gone', reason
    if visit.screen and module then pcall(module.native.screen, false); visit.screen = nil end
    return true
end

-- The copy's life, on the existing 0.5 s battle sample while the probe asks for it (mod/johnny-probe.lua): attached, look applied,
-- then deleted after SHOW_SECONDS. false once there is nothing left to do.
function M.tick(env)
    local visit = M.visit
    local module = hologram()
    if not visit or not module or visit.state == 'gone' then return false end
    local clock = os.clock()
    local player = env and env.player or Game.GetPlayer()
    visit.steps = (visit.steps or 0) + 1
    if visit.state == 'spawning' then
        local npc = read(module.native.entity, visit.id)
        if npc then
            local applied, problem = nil, nil
            local ok, a, b = pcall(module.native.look, npc, visit.id, module.LOOKS[visit.look])
            if ok then applied = a else problem = tostring(a) end
            visit.applied, visit.problem = applied, problem or b
            visit.state, visit.shownAt = 'visible', clock
            visit.report = describe(npc, player, module.LOOKS[visit.look].appearance)
        elseif clock - visit.at > M.SPAWN_SECONDS then
            visit.problem = 'the copy was not in the world after ' .. M.SPAWN_SECONDS .. ' s'
            finish('not-attached')
            return false
        end
        return true
    end
    if visit.state == 'visible' then
        if clock - visit.shownAt < 1.2 and not visit.second then
            return true
        end
        if not visit.second then
            -- A second look a moment later: the phantom controller may have hidden him after the first read.
            local npc = read(module.native.entity, visit.id)
            visit.second = npc and describe(npc, player, module.LOOKS[visit.look].appearance) or false
            if visit.report and visit.second then visit.report.later = {visible = visit.second.visible, appearance = visit.second.appearance, phantoms = visit.second.phantoms} end
        end
        if clock - visit.shownAt >= M.SHOW_SECONDS then finish('done'); return false end
        return true
    end
    return false
end

-- spawn:<look>: one copy in front of V. Everything but the spot search happens on the next ticks.
local function spawn(look, env)
    local module = hologram()
    if not module then error('johnny-hologram.lua unavailable') end
    if not module.LOOKS[look] then
        local keys = {}
        for key in pairs(module.LOOKS) do keys[#keys + 1] = key end
        table.sort(keys)
        error('unknown look ' .. tostring(look) .. ' (' .. table.concat(keys, ', ') .. ')')
    end
    if M.visit and M.visit.state ~= 'gone' then finish('replaced') end
    local player = env and env.player
    if not player then error('no player') end
    local origin, forward = module.native.position(player)
    local tried, chosen = {}, nil
    for _, candidate in ipairs(module.candidates(origin, forward)) do
        local spot, why = module.native.spot(origin, candidate)
        tried[#tried + 1] = string.format('%d deg %.1f m: %s', candidate.angle, candidate.distance, spot and 'ok' or tostring(why))
        if spot then spot.angle, spot.distance, chosen = candidate.angle, candidate.distance, spot; break end
    end
    M.serial = (M.serial or 0) + 1
    M.runId = tostring(os.time()) .. '-' .. M.serial
    M.visit = {look = look, state = 'no-spot', at = os.clock(), spotTried = tried}
    if not chosen then
        M.visit.problem = 'no standing spot round V within three metres (see the spot search)'
        return M.report()
    end
    local record = module.native.record()
    local id = module.native.spawn({record = record, appearance = module.LOOKS[look].appearance, x = chosen.x, y = chosen.y, z = chosen.z, yaw = chosen.yaw})
    M.visit.id, M.visit.state = id, 'spawning'
    return M.report()
end

function M.run(action, env)
    local verb, rest = tostring(action):match('^(%a+):?([%w_]*)$')
    if verb == 'spawn' then return spawn(rest, env) end
    if verb == 'despawn' then finish('despawned'); return M.report() end
    if verb == 'sweep' then
        local module = hologram()
        local count = module and read(module.native.sweep) or unavailable
        if M.visit then M.visit.state = 'gone' end
        local report = M.report()
        report.swept = count
        return report
    end
    if verb == 'status' or verb == 'looks' then return M.report() end
    error('unknown action ' .. tostring(action) .. ' (spawn:<A-E>, despawn, sweep, status, looks)')
end

return M
