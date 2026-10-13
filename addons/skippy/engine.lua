-- Skippy's fight engine: pure logic, no game objects. init.lua turns game events into plain records and calls the on* methods;
-- this file keeps the fight's counters, decides which moments deserve a remark, builds the facts (addons/skippy/EVENTS.md) and
-- offers the remark through deps.remark. Nothing here runs per frame: every method is called by one game event.
--
-- deps (all optional functions except remark and now):
--   now() -> seconds (os.clock)                      remark(name, spec) -> ok, reason   (handle:remark for the gun)
--   cancel()                                         drops the remark waiting or playing (handle:cancel)
--   mode() -> 'killer'|'puppy'                       where() -> {district, area, timeOfDay, heat}|nil
--   lookAt() -> {name, kind}|nil                     vanillaBusy() -> bool (the game's own Skippy is speaking)
--   stock(event, spec|nil)                           declares a line to prepare ahead (handle:stock); absent: no stock
--   remember(text)                                   a memory for later fights        log(text)
local Engine = {}
Engine.__index = Engine

-- Priorities follow docs/ADDON_API.md: 5 near death and fight end; 4 first kill, headshot streak, a civilian hit in Pacifist;
-- 3 notable; 1-2 filler. `stock` marks the reflex moments whose line may be written ahead (the bridge's stock); the rest are
-- written fresh with the moment's own facts. ttl: the API drops a remark whose line is not heard within this many seconds of the
-- moment (default 3 s; only the fight end, which feels natural late, asks for more).
-- Refusals that only mean "not yet": the moment is kept for a few seconds and offered again.
local HOLD = {['addon-gap'] = true, ['speaker-cooldown'] = true, ['queue-full'] = true, busy = true}

local EVENTS = {
    ['fight-start']        = {pri = 3, words = 10, cooldown = 45, ttl = 3},
    ['first-kill']         = {pri = 4, words = 10, cooldown = 0,  ttl = 3},
    ['kill']               = {pri = 2, words = 9,  cooldown = 8,  ttl = 3, stock = true},
    ['headshot']           = {pri = 3, words = 8,  cooldown = 10, ttl = 3, stock = true},
    ['headshot-streak']    = {pri = 4, words = 9,  cooldown = 15, ttl = 3, stock = true},
    ['multi-kill']         = {pri = 3, words = 9,  cooldown = 12, ttl = 3, stock = true},
    ['last-enemy']         = {pri = 3, words = 9,  cooldown = 0,  ttl = 3, stock = true},
    ['elite-kill']         = {pri = 4, words = 10, cooldown = 10, ttl = 3},
    ['long-shot']          = {pri = 3, words = 9,  cooldown = 20, ttl = 3},
    ['stealth-kill']       = {pri = 3, words = 9,  cooldown = 20, ttl = 3},
    ['kill-other-way']     = {pri = 2, words = 9,  cooldown = 40, ttl = 3, stock = true},
    ['companion-kill']     = {pri = 2, words = 9,  cooldown = 40, ttl = 3},
    ['enemy-downed']       = {pri = 3, words = 9,  cooldown = 8,  ttl = 3, stock = true},
    ['mercy-streak']       = {pri = 4, words = 10, cooldown = 20, ttl = 3, stock = true},
    ['limb-shot']          = {pri = 3, words = 8,  cooldown = 10, ttl = 3, stock = true},
    ['dismember']          = {pri = 3, words = 8,  cooldown = 15, ttl = 3},
    ['miss-streak']        = {pri = 3, words = 9,  cooldown = 20, ttl = 3, stock = true},
    ['reload']             = {pri = 2, words = 8,  cooldown = 30, ttl = 3, stock = true},
    ['reload-under-fire']  = {pri = 3, words = 9,  cooldown = 25, ttl = 3, stock = true},
    ['v-hurt']             = {pri = 3, words = 9,  cooldown = 25, ttl = 3, stock = true},
    ['big-hit-taken']      = {pri = 3, words = 9,  cooldown = 20, ttl = 3, stock = true},
    ['near-death']         = {pri = 5, words = 9,  cooldown = 20, ttl = 3, stock = true},
    ['v-healed']           = {pri = 2, words = 8,  cooldown = 30, ttl = 3, stock = true},
    ['reinforcements']     = {pri = 3, words = 9,  cooldown = 25, ttl = 3, stock = true},
    ['heat-up']            = {pri = 3, words = 9,  cooldown = 40, ttl = 3},
    ['civilian-hit']       = {pri = 4, words = 10, cooldown = 15, ttl = 3},
    ['civilian-killed']    = {pri = 4, words = 10, cooldown = 15, ttl = 3},
    ['weapon-mode-change'] = {pri = 3, words = 10, cooldown = 0,  ttl = 3},
    ['skippy-drawn']       = {pri = 2, words = 10, cooldown = 120, ttl = 3},
    ['fight-end']          = {pri = 5, words = 14, cooldown = 0,  ttl = 8},
}
Engine.EVENTS = EVENTS

-- Candidate order when one kill could be several events (equal priority: the earlier wins).
local KILL_ORDER = {'first-kill', 'elite-kill', 'headshot-streak', 'multi-kill', 'last-enemy', 'long-shot', 'stealth-kill',
    'headshot', 'kill-other-way', 'kill'}

-- What each stocked event is for, and the slots a prepared line may carry (live numbers filled in when it is used). Declared in
-- this order, so the bridge writes the most useful lines first. A slot is always present in the facts of its event.
local STOCK = {
    {'kill', 2, 'V has just killed another enemy with you, Skippy. Say what you think of that kill; it is one of several this fight.',
        {'fight.kills', 'victim.kind'}},
    {'headshot', 1, 'V has just killed an enemy with a clean headshot.', {'fight.headshots'}},
    {'near-death', 1, 'V is almost dead, badly wounded in the middle of the fight.', {'healthPct'}},
    {'v-hurt', 1, 'V has just been badly hurt in the fight; V is at about half health.', {'healthPct'}},
    {'enemy-downed', 2, 'V has just put an enemy down without killing them.', {'fight.downed'}},
    {'reload-under-fire', 1, 'V is reloading while enemies are still shooting.', {}},
    {'limb-shot', 1, 'V has just hit an enemy in the arm or the leg.', {'fight.limbShots'}},
    {'miss-streak', 1, 'V has just fired a string of shots that all missed.', {'missed'}},
    {'headshot-streak', 1, 'V has just landed several headshot kills in a row.', {'streak'}},
    {'multi-kill', 1, 'V has just killed several enemies in a few seconds.', {'count'}},
    {'last-enemy', 1, 'V has just killed the last enemy standing; the area is quiet again.', {'fight.kills'}},
    {'big-hit-taken', 1, 'V has just taken a heavy hit and lost a big chunk of health.', {'lostPct'}},
    {'mercy-streak', 1, 'V has put down several enemies in a row without killing any.', {'streak'}},
    {'reinforcements', 1, 'More enemies have just joined the fight.', {'to'}},
    {'reload', 1, 'V is reloading in a quiet moment of the fight.', {}},
    {'v-healed', 1, 'V has just patched themselves up in the middle of the fight.', {}},
    {'kill-other-way', 1, 'V has just killed an enemy without using you, Skippy: with fists, a hack or a bomb.', {}},
}
Engine.STOCK = STOCK

local function floor(n) return math.floor(n + 0.5) end

-- Metres from which a kill counts as a long shot, and the only distance the event text and the remark prompt mention.
local LONG_SHOT = 30
Engine.LONG_SHOT = LONG_SHOT

-- ---- Text helpers ---------------------------------------------------------------------------------------------------------

local function who(v)
    if type(v) ~= 'table' then return 'an enemy' end
    local parts = {}
    if v.cyberpsycho then parts[#parts + 1] = 'cyberpsycho'
    elseif v.rarity and v.rarity ~= 'normal' and v.rarity ~= 'trash' and v.rarity ~= 'weak' then parts[#parts + 1] = v.rarity end
    if v.faction then parts[#parts + 1] = v.faction end
    local kind = v.kind
    if kind == nil or kind == 'human' or kind == 'other' then kind = (#parts > 0) and 'fighter' or 'enemy' end
    parts[#parts + 1] = kind
    local text = table.concat(parts, ' ')
    local first = text:sub(1, 1):lower()
    return (first:match('[aeiou]') and 'an ' or 'a ') .. text
end
Engine._who = who

local function bandOf(pct)
    if type(pct) ~= 'number' then return nil end
    if pct >= 60 then return 'healthy' elseif pct >= 30 then return 'hurt' end
    return 'badly-hurt'
end
local BAND_RANK = {healthy = 3, hurt = 2, ['badly-hurt'] = 1}

local function accuracyOf(shots, hits)
    if shots < 6 then return nil end
    local ratio = math.min(1, hits / shots)
    if ratio < 0.25 then return 'poor' elseif ratio < 0.5 then return 'fair' elseif ratio < 0.75 then return 'good' end
    return 'excellent'
end

local function copy(value)
    if type(value) ~= 'table' then return value end
    local out = {}
    for key, item in pairs(value) do out[key] = copy(item) end
    return out
end

-- ---- State ----------------------------------------------------------------------------------------------------------------

function Engine.new(deps)
    local self = setmetatable({deps = deps, tries = {}, cand = nil, lastPoll = -10, modeSeen = nil, heat = 0}, Engine)
    self:reset()
    return self
end

function Engine:now() return self.deps.now() end

-- A new fight (or the quiet state before one): every counter starts again.
function Engine:reset()
    self.f = {active = false, startedAt = 0, kills = 0, skippyKills = 0, headshots = 0, hsStreak = 0, bestHs = 0, downed = 0,
        mercy = 0, limbShots = 0, civilians = 0, shots = 0, hits = 0, reloads = 0, enemies = nil, peak = 0, lastKillAt = nil,
        pct = nil, lowestPct = nil, hurtDone = false, nearArmed = true, stealthOpening = false, inVehicle = false,
        regret = 0, named = 0, killTimes = {}, quick = 0, longestQuick = 0, ways = {}, missRun = 0, lastHitAt = -10,
        hp = {}, civilianIds = {}, lastVictim = nil, companionKills = 0}
    self.cand = nil
end

function Engine:mode()
    local m = self.deps.mode and self.deps.mode() or 'puppy'
    return m == 'killer' and 'killer' or 'puppy'
end

-- ---- Facts ----------------------------------------------------------------------------------------------------------------

function Engine:fightFacts()
    local f, now = self.f, self:now()
    local out = {seconds = f.active and floor(now - f.startedAt) or 0, kills = f.kills, skippyKills = f.skippyKills,
        headshots = f.headshots, headshotStreak = f.hsStreak, bestHeadshotStreak = f.bestHs, downed = f.downed,
        limbShots = f.limbShots, civilians = f.civilians, shots = f.shots, hits = f.hits, reloads = f.reloads,
        peakEnemies = f.peak}
    out.accuracy = accuracyOf(f.shots, f.hits)
    out.enemies = f.enemies
    if f.lastKillAt then out.sinceLastKill = floor(now - f.lastKillAt) end
    out.health = bandOf(f.pct)
    out.lowestHealth = bandOf(f.lowestPct)
    if f.stealthOpening then out.stealthOpening = true end
    if f.inVehicle then out.inVehicle = true end
    return out
end

local function victimFacts(v)
    if type(v) ~= 'table' then return nil end
    local out = {kind = v.kind or 'other', rarity = v.rarity, faction = v.faction, name = v.name, zone = v.zone,
        distance = v.distance, weapon = v.weapon, lethal = v.lethal, headshot = v.headshot, stealth = v.stealth}
    if v.cyberpsycho then out.cyberpsycho = true end
    if v.police then out.police = true end
    if v.civilian then out.civilian = true end
    return out
end

function Engine:whereFacts()
    local w = self.deps.where and self.deps.where() or nil
    if type(w) ~= 'table' then return nil end
    local out = {district = w.district, area = w.area, timeOfDay = w.timeOfDay}
    if type(w.heat) == 'number' and w.heat > 0 then out.heat = w.heat end
    if next(out) == nil then return nil end
    return out
end

-- ---- Offering a remark ------------------------------------------------------------------------------------------------------

-- name: an EVENTS key; o = {extra = {top-level facts}, victim = record, text = sentence, where = bool}
function Engine:offer(name, o)
    local def = EVENTS[name]
    if not def then return false, 'unknown event' end
    local now, deps = self:now(), self.deps
    o = o or {}
    -- A cheap pre-check before any fact is built: the same event is not offered more often than once a second (priority 5: 0.3 s).
    local last = self.tries[name]
    if last and now - last < (def.pri >= 5 and 0.3 or 1) then return false, 'throttled' end
    self.tries[name] = now
    if deps.vanillaBusy and deps.vanillaBusy() then return false, 'vanilla-bark' end
    local facts = {mode = self:mode(), fight = self:fightFacts()}
    if o.victim then facts.victim = victimFacts(o.victim) end
    if o.where then facts.where = self:whereFacts() end
    for key, value in pairs(o.extra or {}) do facts[key] = value end
    local text = o.text
    if not text then text = 'Game event: ' .. name:gsub('%-', ' ') .. '.' end
    local spec = {event = name, text = text, facts = facts, priority = o.priority or def.pri, ttl = def.ttl,
        maxWords = def.words, cooldown = def.cooldown, stock = def.stock == true and self.deps.stock ~= nil or nil}
    local ok, reason = deps.remark(name, spec)
    if ok then
        if self.cand and self.cand.name == name then self.cand = nil end
        return true
    end
    -- Held back only by the gap (or a remark still going): keep the best moment for a few seconds and offer it again at the next
    -- game event. The API drops what cannot start in time, so nothing is ever played late.
    if (HOLD[reason]) and spec.priority >= 3 then
        if not self.cand or spec.priority >= self.cand.spec.priority then
            self.cand = {name = name, spec = spec, o = o, at = now, expires = now + 1.5}
        end
    end
    return false, reason
end

-- Called from cheap game events: tries the held-back moment again (at most twice a second).
function Engine:poll()
    local cand = self.cand
    if not cand then return end
    local now = self:now()
    if now - self.lastPoll < 0.5 or now - cand.at < 0.3 then return end
    self.lastPoll = now
    if now > cand.expires then self.cand = nil; return end
    if self.deps.vanillaBusy and self.deps.vanillaBusy() then return end
    cand.spec.facts.fight = self:fightFacts()
    local ok, reason = self.deps.remark(cand.name, cand.spec)
    if ok or not (HOLD[reason]) then self.cand = nil end
end

-- The game's own Skippy started speaking: nothing of ours may be waiting or playing.
function Engine:vanillaSpoke()
    self.cand = nil
    if self.deps.cancel then self.deps.cancel() end
end

-- ---- Fight life cycle ----------------------------------------------------------------------------------------------------

function Engine:start(info)
    info = info or {}
    local wasStealth, vehicle = info.stealthOpening == true, info.inVehicle == true
    -- The hostile count can arrive just before the combat state does: keep it.
    local enemies, peak = self.f.enemies, self.f.peak
    self:reset()
    local f = self.f
    f.enemies, f.peak = enemies, peak
    f.active, f.startedAt, f.stealthOpening, f.inVehicle = true, self:now(), wasStealth, vehicle
    f.pct = info.healthPct
    f.lowestPct = info.healthPct
    local extra = {}
    local look = self.deps.lookAt and self.deps.lookAt() or nil
    if type(look) == 'table' then extra.lookAt, extra.lookAtKind = look.name, look.kind end
    local text = 'The fight has just started around V.'
    if wasStealth then text = 'The fight has just started: V was unseen and has now been spotted.' end
    if look and look.name then text = text .. ' V is facing ' .. look.name .. '.' end
    self:offer('fight-start', {extra = extra, where = true, text = text})
end

function Engine:stop()
    local f = self.f
    if not f.active then return end
    local now = self:now()
    local outcome = 'clean'
    if f.lowestPct and f.lowestPct < 25 then outcome = 'narrow' elseif f.lowestPct and f.lowestPct < 50 then outcome = 'rough' end
    local extra = {outcome = outcome, longestStreak = f.longestQuick}
    local text = 'The fight is over.'
    if f.kills > 0 then text = text .. ' V killed ' .. f.kills .. (f.kills == 1 and ' enemy.' or ' enemies.') end
    -- The last moment of the fight is the one remark that must not be lost to the gap: ask it at priority 5.
    self:offer('fight-end', {extra = extra, where = true, victim = f.lastVictim, text = text})
    if self.deps.remember and (f.kills >= 6 or outcome == 'narrow' or f.civilians > 0 or f.bestHs >= 4) then
        local parts = {}
        parts[#parts + 1] = 'A ' .. floor(now - f.startedAt) .. ' second fight: ' .. f.kills .. ' kills'
        if f.bestHs >= 3 then parts[#parts + 1] = f.bestHs .. ' headshots in a row' end
        if outcome == 'narrow' then parts[#parts + 1] = 'V nearly died' end
        if f.civilians > 0 then parts[#parts + 1] = f.civilians .. ' bystander' .. (f.civilians == 1 and '' or 's') .. ' got hit' end
        pcall(self.deps.remember, table.concat(parts, '; ') .. '.')
    end
    f.active = false
    self.cand = nil
end

-- ---- Kills and downs --------------------------------------------------------------------------------------------------------

local function isOtherWay(v)
    local w = v.weapon
    return w == 'melee' or w == 'quickhack' or w == 'explosion' or w == 'takedown' or w == 'other'
end

-- v = victim record (init.lua): kind, rarity, faction, name, zone, distance, weapon, headshot, stealth, cyberpsycho, police,
-- civilian; weapon 'companion' means a companion killed it.
function Engine:onKill(v)
    if type(v) ~= 'table' then return end
    if v.civilian then return self:onCivilian(v, true) end
    local f, now = self.f, self:now()
    if v.weapon == 'companion' then
        f.companionKills = f.companionKills + 1
        return self:offer('companion-kill', {victim = v, text = 'A companion killed ' .. who(v) .. '; V did not fire.'})
    end
    f.kills = f.kills + 1
    if v.weapon == 'skippy' then f.skippyKills = f.skippyKills + 1 end
    if v.headshot then
        f.headshots = f.headshots + 1
        f.hsStreak = f.hsStreak + 1
        if f.hsStreak > f.bestHs then f.bestHs = f.hsStreak end
    else f.hsStreak = 0 end
    f.mercy = 0
    if self:mode() == 'puppy' then f.regret = f.regret + 1 end
    -- kills in quick succession (8 s) and the multi-kill window
    if f.lastKillAt and now - f.lastKillAt <= 8 then f.quick = f.quick + 1 else f.quick = 1 end
    if f.quick > f.longestQuick then f.longestQuick = f.quick end
    local times = f.killTimes
    times[#times + 1] = now
    while #times > 0 and now - times[1] > 8 do table.remove(times, 1) end
    f.lastKillAt = now
    if f.named < 3 then f.named = f.named + 1 else v.name = nil end
    f.lastVictim = v
    f.pending = nil
    -- every candidate this kill could be; the highest priority wins, the order above breaks ties
    local cands = {}
    local function add(name, o, pri) cands[name] = {o = o, pri = pri or EVENTS[name].pri} end
    local d = who(v)
    local how = v.headshot and ' with a headshot' or ''
    -- A distance is only worth saying for a long shot (30 m or more): a small model otherwise fixates on metres ("Fourteen meters. Perfect range.").
    local far = (v.distance and v.distance >= LONG_SHOT) and (' from ' .. floor(v.distance) .. ' m') or ''
    if f.kills == 1 then add('first-kill', {victim = v, extra = {firstBlood = true},
        text = 'V killed the first enemy of the fight: ' .. d .. how .. far .. '.'}) end
    if v.cyberpsycho or v.rarity == 'boss' or v.rarity == 'elite' or v.rarity == 'officer' or v.rarity == 'maxtac' then
        add('elite-kill', {victim = v, text = 'V killed ' .. d .. ', a dangerous target' .. how .. '.'}) end
    if v.headshot and f.hsStreak >= 3 and f.hsStreak % 2 == 1 then
        add('headshot-streak', {victim = v, extra = {streak = f.hsStreak},
            text = 'V has landed ' .. f.hsStreak .. ' headshot kills in a row; the last was ' .. d .. far .. '.'}) end
    if #times >= 3 then
        add('multi-kill', {victim = v, extra = {count = #times, window = 8},
            text = 'V killed ' .. #times .. ' enemies within 8 seconds.'}, #times >= 5 and 4 or 3) end
    if f.enemies ~= nil and f.enemies <= 1 and f.peak >= 2 then
        add('last-enemy', {victim = v, extra = {peakEnemies = f.peak}, text = 'V killed the last enemy standing: ' .. d .. '.'}) end
    if v.distance and v.distance >= LONG_SHOT then
        add('long-shot', {victim = v, text = 'V killed ' .. d .. ' from far away, ' .. v.distance .. ' m.'}) end
    if v.stealth or (v.weapon == 'takedown' and not f.active) then
        add('stealth-kill', {victim = v, text = 'V killed ' .. d .. ' silently, unseen.'}) end
    if v.headshot then add('headshot', {victim = v, extra = {headshots = f.headshots}, text = 'V killed ' .. d .. ' with a headshot' .. far .. '.'}) end
    if isOtherWay(v) then
        local ways = f.ways
        ways[#ways + 1] = now
        while #ways > 0 and now - ways[1] > 30 do table.remove(ways, 1) end
        if #ways >= 2 then
            add('kill-other-way', {victim = v, extra = {ways = #ways},
                text = 'V killed ' .. d .. ' without using Skippy (' .. tostring(v.weapon) .. ').'}) end
    end
    -- A kill Skippy did not make is filler, even in puppy mode.
    local pri = (self:mode() == 'puppy' and not isOtherWay(v)) and 3 or 2
    local extra = nil
    if self:mode() == 'puppy' then extra = {regret = f.regret} end
    add('kill', {victim = v, extra = extra, text = 'V killed ' .. d .. how .. far .. '.'}, pri)
    local best, bestName = nil, nil
    for _, name in ipairs(KILL_ORDER) do
        local c = cands[name]
        if c and (not best or c.pri > best.pri) then best, bestName = c, name end
    end
    if best then
        best.o.priority = best.pri
        self:offer(bestName, best.o)
    end
    self:poll()
end

-- An enemy was put down without dying.
function Engine:onDowned(v)
    if type(v) ~= 'table' then return end
    if v.civilian then return self:onCivilian(v, false) end
    local f = self.f
    f.downed = f.downed + 1
    f.mercy = f.mercy + 1
    f.hsStreak = 0
    if f.named < 3 then f.named = f.named + 1 else v.name = nil end
    f.lastVictim = v
    local d = who(v)
    if self:mode() == 'puppy' and (f.mercy == 3 or f.mercy == 5 or f.mercy == 8) then
        return self:offer('mercy-streak', {victim = v, extra = {streak = f.mercy},
            text = 'V has put down ' .. f.mercy .. ' enemies in a row without killing any.'})
    end
    local pri = self:mode() == 'puppy' and 3 or 2
    self:offer('enemy-downed', {victim = v, priority = pri, extra = {downed = f.downed},
        text = 'V put ' .. d .. ' down without killing ' .. 'them.'})
    self:poll()
end

-- A hit by V on a hostile or a civilian. h = {zone, civilian, victim = record, weapon, id}
function Engine:onHit(h)
    local f, now = self.f, self:now()
    if type(h) ~= 'table' then return end
    if h.civilian then
        if h.id and not f.civilianIds[h.id] and f.civilians < 16 then f.civilianIds[h.id] = true; f.civilians = f.civilians + 1 end
        local pri = self:mode() == 'puppy' and 4 or 3
        self:offer('civilian-hit', {victim = h.victim, priority = pri, extra = {civilians = f.civilians},
            text = 'V just shot a bystander, a civilian who was not part of the fight.'})
        return
    end
    f.hits = f.hits + 1
    f.missRun = 0
    f.lastHitAt = now
    if h.zone == 'arm' or h.zone == 'leg' then
        f.limbShots = f.limbShots + 1
        local pri = self:mode() == 'puppy' and 3 or 2
        local victim = h.victim or {}
        victim.zone = h.zone
        self:offer('limb-shot', {victim = victim, priority = pri, extra = {limbShots = f.limbShots},
            text = 'V hit an enemy in the ' .. h.zone .. '.'})
    end
    self:poll()
end

function Engine:onShot()
    local f = self.f
    f.shots = f.shots + 1
    f.missRun = f.missRun + 1
    if f.missRun >= 6 and self:now() - f.lastHitAt >= 4 then
        local missed = f.missRun
        f.missRun = 0
        self:offer('miss-streak', {extra = {missed = missed}, text = 'V fired ' .. missed .. ' shots in a row and hit nothing.'})
    end
    self:poll()
end

function Engine:onReload(info)
    local f = self.f
    f.reloads = f.reloads + 1
    if not f.active then return end
    info = info or {}
    local extra = {empty = info.empty}
    if f.enemies and f.enemies > 0 then
        extra.enemies = f.enemies
        self:offer('reload-under-fire', {extra = extra, text = 'V is reloading with ' .. f.enemies .. ' hostile'
            .. (f.enemies == 1 and '' or 's') .. ' still fighting.'})
    else
        self:offer('reload', {extra = extra, text = 'V is reloading in a quiet moment of the fight.'})
    end
    self:poll()
end

-- ---- V's health ---------------------------------------------------------------------------------------------------------------

-- pct: V's health percent after a loss (init.lua reads it from the stat pool only when health went down).
function Engine:onHealth(pct)
    if type(pct) ~= 'number' then return end
    local f, now = self.f, self:now()
    local win = f.hp
    win[#win + 1] = {t = now, pct = pct}
    while #win > 0 and now - win[1].t > 2 do table.remove(win, 1) end
    local peak = pct
    for _, s in ipairs(win) do if s.pct > peak then peak = s.pct end end
    local lost = floor(peak - pct)
    f.pct = pct
    if not f.lowestPct or pct < f.lowestPct then f.lowestPct = pct end
    if pct > 40 then f.nearArmed = true end
    if not f.active then return end
    local healthPct = floor(pct)
    if pct < 25 and f.nearArmed then
        f.nearArmed = false
        self:offer('near-death', {extra = {healthPct = healthPct, enemies = f.enemies},
            text = 'V is close to dying: about ' .. healthPct .. ' percent health left.'})
    elseif lost >= 20 then
        self:offer('big-hit-taken', {extra = {lostPct = lost, healthPct = healthPct},
            text = 'V just lost about ' .. lost .. ' percent health in a couple of seconds.'})
    elseif pct < 50 and not f.hurtDone then
        f.hurtDone = true
        self:offer('v-hurt', {extra = {healthPct = healthPct}, text = 'V is badly hurt: about ' .. healthPct .. ' percent health.'})
    end
    self:poll()
end

function Engine:onHeal(pct)
    local f = self.f
    if type(pct) == 'number' then f.pct = pct end
    if not f.active then return end
    self:offer('v-healed', {extra = {healthPct = type(pct) == 'number' and floor(pct) or nil},
        text = 'V just healed up in the middle of the fight.'})
end

-- ---- Enemies, bystanders, the world --------------------------------------------------------------------------------------------

function Engine:onCombatants(n)
    if type(n) ~= 'number' then return end
    local f = self.f
    local from = f.enemies
    f.enemies = n
    if n > f.peak then f.peak = n end
    if f.active and from and n - from >= 2 and from >= 1 then
        self:offer('reinforcements', {extra = {from = from, to = n}, text = 'More enemies joined: ' .. from .. ' became ' .. n .. '.'})
    end
end

function Engine:onCivilian(v, killed)
    local f = self.f
    if killed then
        if v.id and not f.civilianIds[v.id] and f.civilians < 16 then f.civilianIds[v.id] = true; f.civilians = f.civilians + 1 end
        self:offer('civilian-killed', {victim = v, extra = {civilians = f.civilians}, priority = 4,
            text = 'V killed a bystander, a civilian who was not part of the fight.'})
    else
        self:onHit({civilian = true, victim = v, id = v.id})
    end
end

function Engine:onDismember(info)
    info = info or {}
    self:offer('dismember', {extra = {bodyPart = info.bodyPart, explosion = info.explosion == true},
        victim = info.victim, text = 'A shot blew off an enemy\'s ' .. (info.bodyPart or 'limb') .. '.'})
    self:poll()
end

function Engine:onHeat(stage)
    if type(stage) ~= 'number' then return end
    local prev = self.heat
    self.heat = stage
    if stage > prev and stage > 0 then
        self:offer('heat-up', {extra = {heat = stage}, text = 'The police heat just went up to level ' .. stage .. '.'})
    end
end

-- ---- Mode, draw ---------------------------------------------------------------------------------------------------------------

-- The game's mode fact differs from the one last seen (read when Skippy is drawn and when a fight starts).
function Engine:checkMode()
    local mode = self:mode()
    local seen = self.modeSeen
    self.modeSeen = mode
    if seen and seen ~= mode then
        self:offer('weapon-mode-change', {extra = {from = seen, to = mode}, where = true,
            text = 'Skippy\'s targeting mode just changed from ' .. seen .. ' to ' .. mode .. '.'})
        return true
    end
    return false
end

function Engine:onDrawn()
    if self.f.active then return end
    self:offer('skippy-drawn', {where = true, text = 'V has picked Skippy up and is holding the gun.'})
end

-- ---- Stock (lines written ahead) -------------------------------------------------------------------------------------------

-- Declares what the bridge should keep ready. The facts are the ones that hold for the whole fight (mode, where), so the lines
-- stay true; live numbers are slots the bridge fills when a line is used. Changing the mode or the place declares them again.
function Engine:declareStock()
    local deps = self.deps
    if not deps.stock then return false end
    local facts = {mode = self:mode(), where = self:whereFacts()}
    local puppy = facts.mode == 'puppy'
    for _, row in ipairs(STOCK) do
        local name, want, text, slots = row[1], row[2], row[3], row[4]
        local skip = (name == 'mercy-streak' and not puppy)
        local def = EVENTS[name]
        if skip then
            deps.stock(name, nil)
        else
            deps.stock(name, {text = 'Game event, prepared in advance and spoken a moment after it happens: ' .. text,
                facts = copy(facts), maxWords = def.words, want = want, ttl = 120, slots = slots})
        end
    end
    return true
end

return Engine
