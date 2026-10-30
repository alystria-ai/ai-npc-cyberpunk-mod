-- Companions change outfits (Settings > Gameplay > Companions change outfits, on by default; docs/COMPANION_OUTFITS.md).
--
-- A party copy of a curated character (mod/companion-outfits-data.lua) changes into another look of its own entity template: by the game's time of day
-- (a day look, a night look), now and then for variety, into casual clothes while V is at home and into formal clothes while V is in a club, a fancy bar or a
-- Corpo district. Each situation holds a list of looks that rotate: a new copy and a new in-game day pick another look than the last one worn in that situation
-- (kept in runtime/outfit-rotation.json, so it survives a reload). Only our own spawned copies are touched. A character the
-- game placed is never given a new look. A change happens only while nobody is looking: when the game's own frustum test says the copy is outside V's view
-- (IsInCameraFrustum with the margins the game itself uses for "could be seen"), and never during a fight, a scene, a call, a ride, on a seat or while a command runs.
--
-- Cost. Nothing runs per frame. The 10 Hz tick of init.lua calls M.tick, which subtracts the elapsed time from one counter and returns; every CHECK_S
-- seconds it reads the party (a list of the curated copies, usually none or two), the game clock (one native read) and, when someone wants to change, the
-- world and the copy's view. A change itself is two native calls on one copy (prefetch the appearance, then schedule it a second later, still unseen) and a
-- read-back a few seconds after. Off, the tick is not called into this module at all and nothing is loaded (init.lua convaiOutfitTick).
-- No handle of a game object is kept between checks: a member remembers a serial, a name and numbers.
local M = {}

-- deps (set by init.lua; every call is guarded here):
--   enabled()              the setting
--   rows()                 the curated copies that are ready: {serial, key, record, npc}; the module keeps no npc beyond the call
--   current(row)           the appearance name the copy wears now, or nil
--   prefetch(row, name)    ask the game to load the appearance (no visible change)
--   apply(row, name)       schedule the change and remember it for a recreated copy
--   remember(row, name)    forget a change that did not take (the name a recreated copy should use)
--   sitAgain(row, delay)   the change of a copy that stood up for it is over or given up: the flat may give her a place again in `delay` seconds
--   gameHours()            the game clock as absolute hours (days * 24 + hour + minutes / 60), or nil
--   place()                the game's district record name where V is (the specific one, e.g. 'LittleChina_VApartment'), or nil
--   load()                 the saved last picks, {key = {out = name, home = name, formal = name, day = n}}, or nil (optional, read once, on first use)
--   save(picks)            write them (optional, called when a pick changed: a few times per game day at most)
--   world()                nil when ordinary gameplay is open, else a reason (combat, scene, call, vehicle, menu)
--   busy(row)              nil when the copy is walking or standing with V, else a reason (a fight, a seat, a car, a lift, a command)
--   frustum(npc)           the game's own test: true when the copy may be seen by the camera, false when not, nil when it cannot say
--   angle(npc, player)     degrees between the camera's direction and the copy, or nil
--   random()               a number in [0, 1) (optional: the module's own generator is used without it)
--   pinned(key)            the look the player chose for a profile key in the character editor (docs/CHARACTER_EDITOR.md, "Look and moves"), or nil (optional)
--   anyPinned()            true while any character has such a look (optional); the module then runs even with the setting off, for those characters only
--   log(line)
M.deps = nil
M.data = nil

local CHECK_S = 20          -- real seconds between looks at the party
local UNSEEN_S = 5         -- real seconds a copy must stay out of view before a change starts (a glance back starts the count again)
local LOOK_S = 5            -- real seconds between looks at a copy that waits for the camera to look away (one view read per waiting copy)
local WANT_S = 600          -- a variety change that waited this long for the camera to look away is dropped
local STAGE_S = 1.0         -- real seconds between the prefetch and the change, and between read-backs
local STAND_HOLD_S = 90     -- real seconds a copy that stood up for a change takes no place of the flat at most (stand, stay unseen UNSEEN_S, load, change); the end of the change lifts it
local SIT_AGAIN_S = 3       -- real seconds after the change (or its giving up) before the flat gives her a place again
local GIVE_UP_S = 20.0     -- a change that never shows is given up, and that look is not tried again this session
local MIN_DWELL_H = 4       -- game hours between two changes made for variety (a new in-game day is a change of its own, see 'daily')
local VARIETY_CHANCE = 0.3  -- per hour change, once the dwell has passed
local NIGHT_FROM, NIGHT_TO = 19, 6
local OUT_OF_VIEW_DEG = 75  -- the fallback when the frustum test is unavailable: a copy this far off the camera's direction is not on screen
local FAR_OFF_DEG = 85      -- a copy this far off the camera's direction is out of view even when the frustum test (its margins are wider than the screen) says it may be seen

-- The district records the game reports for V's apartments (the same five bridge/place-names.mjs HOME_PLACES lists; checked in final.redscripts 2026-10-14).
M.HOME_PLACES = {LittleChina_VApartment = true, Northside_Apartment = true, JapanTown_Apartment = true, Glen_Apartment = true, CorpoPlaza_Apartment = true}

-- Where V's companions dress up: named clubs and bars from the same district records bridge/place-names.mjs INTERIORS lists (bridge/companion-outfits.test.mjs checks that
-- every name here is one of them), and the Corpo districts by prefix (Corpo Plaza with the Arasaka Tower floors, and Downtown). A flat of V's is home, never formal.
M.FORMAL_PLACES = {LittleChina_Afterlife = true, LittleChina_RiotClub = true, Kabuki_LizziesBar = true, JapanTown_Clouds = true, JapanTown_DarkMatter = true,
    Northside_Totentaz = true, Glen_Embers = true}
M.FORMAL_PREFIXES = {'CorpoPlaza', 'Downtown'}

local state = {members = {}, home = {}, wait = 0, lastHour = nil, memory = nil}
local kindOf   -- defined below, with the list helpers

-- The module's own small generator (a Lehmer sequence): the game's shared math.random is never seeded or consumed here. Seeded from the clocks when the module loads.
local seed = (os.time() + math.floor(os.clock() * 1000)) % 2147483646 + 1
function M.random()
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
end

local function say(line)
    local deps = M.deps
    if deps and deps.log then pcall(deps.log, line) end
end

local function wanted()
    local deps = M.deps
    if not deps or type(deps.enabled) ~= 'function' then return false end
    local ok, on = pcall(deps.enabled)
    return ok and on == true
end

-- The player's own pick for a character (mod/character-options.lua), when it is one of that character's looks in the curated list; nil otherwise.
local function pinnedLook(key, record)
    local deps = M.deps
    if not deps or type(deps.pinned) ~= 'function' or key == nil then return nil end
    local ok, name = pcall(deps.pinned, key)
    if not ok or type(name) ~= 'string' or name == '' then return nil end
    local character = M.character(record)
    if character and kindOf(character, name) ~= nil then return name end
    return nil
end

-- True while some character has a look chosen by the player. A page of choices may call this at any time; it is a boolean from a table.
local function anyPinned()
    local deps = M.deps
    if not deps or type(deps.anyPinned) ~= 'function' then return false end
    local ok, any = pcall(deps.anyPinned)
    return ok and any == true
end
M.anyPinned = anyPinned

local function data()
    if M.data == nil then
        local ok, loaded = pcall(dofile, 'companion-outfits-data.lua')
        M.data = ok and type(loaded) == 'table' and loaded or false
        if not M.data then say('Companion outfits: the outfit list could not be loaded') end
    end
    return M.data or nil
end

-- The curated entry of a model record, or nil.
function M.character(record)
    local all = data()
    return all and all.characters and type(record) == 'string' and all.characters[record] or nil
end

function M.known(record) return M.character(record) ~= nil end

function kindOf(character, name)
    for _, row in ipairs(character.outfits) do
        if row[1] == name then return row[2] end
    end
    return nil
end
M.kindOf = function(record, name)
    local character = M.character(record)
    return character and kindOf(character, name) or nil
end

local function hasKind(character, kind)
    for _, row in ipairs(character.outfits) do
        if row[2] == kind then return true end
    end
    return false
end
function M.hasHomeOutfit(record)
    local character = M.character(record)
    return character ~= nil and hasKind(character, 'home')
end
function M.hasFormalOutfit(record)
    local character = M.character(record)
    return character ~= nil and hasKind(character, 'formal')
end

-- 'night' from 19:00 to 05:59 game time, 'day' otherwise.
function M.period(hour)
    hour = tonumber(hour) or 12
    return (hour >= NIGHT_FROM or hour < NIGHT_TO) and 'night' or 'day'
end

-- The situation a character is dressed for: 'home' (V's flat, when the character has home clothes), 'formal' (a club, a fancy bar, a Corpo district, when the
-- character has formal clothes), else 'out' (the ordinary looks of the hour). A character without clothes for a situation keeps its ordinary rotation there.
local function situationFor(character, home, formal)
    if home == true and hasKind(character, 'home') then return 'home' end
    if formal == true and hasKind(character, 'formal') then return 'formal' end
    return 'out'
end
local function situationOfKind(kind)
    return (kind == 'home' or kind == 'formal') and kind or 'out'
end

-- May this kind of outfit be worn now? At home only the home outfits. In a formal place the formal outfits, and at night also the night outfits (the evening looks:
-- a date, a club, a suit). Away from home and from formal places never a home or formal outfit.
local function allowed(kind, period, situation)
    if situation == 'home' then return kind == 'home' end
    if situation == 'formal' then return kind == 'formal' or (kind == 'night' and period == 'night') end
    if kind == 'home' or kind == 'formal' then return false end
    return kind == 'any' or kind == period
end

local function pick(list, random)
    if #list == 0 then return nil end
    local r = tonumber(random and random()) or 0
    local index = math.floor(r * #list) + 1
    if index > #list then index = #list end
    if index < 1 then index = 1 end
    return list[index]
end

-- The next look of a rotation: never the one named in `avoid` (the last pick of this situation) while another exists.
local function rotate(list, avoid, random)
    if avoid == nil then return pick(list, random) end
    local fresh = {}
    for _, name in ipairs(list) do
        if name ~= avoid then fresh[#fresh + 1] = name end
    end
    if #fresh == 0 then fresh = list end
    return pick(fresh, random)
end

-- The looks that may be worn in a situation, in list order, without the ones that failed to show.
local function candidatesFor(character, period, situation, bad)
    local out = {}
    for _, row in ipairs(character.outfits) do
        if allowed(row[2], period, situation) and not (bad and bad[row[1]]) then out[#out + 1] = row[1] end
    end
    return out
end

-- ---------------------------------------------------------------------------------------------------------------------
-- The last pick per character and situation, kept in a file (deps.load / deps.save) so a reload does not start the rotation over. Read once, on first use.

local function memory()
    if state.memory == nil then
        state.memory = {}
        local deps = M.deps
        local ok, saved = pcall(deps and deps.load or function() return nil end)
        if ok and type(saved) == 'table' then
            for key, row in pairs(saved) do
                if type(key) == 'string' and type(row) == 'table' then
                    local clean = {}
                    for _, field in ipairs({'out', 'home', 'formal'}) do
                        if type(row[field]) == 'string' then clean[field] = row[field] end
                    end
                    if type(row.day) == 'number' then clean.day = row.day end
                    state.memory[key] = clean
                end
            end
        end
    end
    return state.memory
end

-- What a character last put on in each situation, and the game day of the last pick (a copy of the saved row, or nil).
function M.recall(key)
    local row = type(key) == 'string' and memory()[key] or nil
    return row and {out = row.out, home = row.home, formal = row.formal, day = row.day} or nil
end

-- A look was put on (a change that showed, or a copy created in it): it is the last pick of its situation. The file is written only when that changes something.
local function noteLook(key, character, name, hours)
    if type(key) ~= 'string' or type(name) ~= 'string' then return end
    local kind = kindOf(character, name)
    if kind == nil then return end
    local situation = situationOfKind(kind)
    local all = memory()
    local row = all[key]
    if not row then row = {}; all[key] = row end
    if row[situation] == name and row.day ~= nil then return end
    row[situation] = name
    row.day = type(hours) == 'number' and math.floor(hours / 24) or row.day
    local deps = M.deps
    if deps and type(deps.save) == 'function' then pcall(deps.save, all) end
end

-- The decision, a pure function. ctx = {period, home, formal, hours, changedAt, hourChanged, bad = {name = true}, random, last = {out, home, formal}, day, pickDay}.
-- Returns the name to change into and why ('required': the look worn is not allowed now, 'daily': a new in-game day, the morning look, 'variety'), or nil.
-- A pick is never the look worn, and never the last look picked for that situation while another exists (ctx.last).
function M.choose(character, current, ctx)
    if type(character) ~= 'table' or type(current) ~= 'string' then return nil end
    -- A look the player chose in the character editor is worn all the time: no time of day, no variety, no home clothes. (A look that did not show once is not tried again.)
    if ctx.pinned ~= nil then
        if current == ctx.pinned or (ctx.bad and ctx.bad[ctx.pinned]) then return nil end
        return ctx.pinned, 'chosen'
    end
    -- A look the list does not hold (a world character's copy in the clothes the original wore, a look another mod set) is left alone.
    if kindOf(character, current) == nil then return nil end
    local situation = situationFor(character, ctx.home, ctx.formal)
    local candidates = candidatesFor(character, ctx.period, situation, ctx.bad)
    if #candidates == 0 then return nil end
    local avoid = ctx.last and ctx.last[situation] or nil
    local others = {}
    local worn = false
    for _, name in ipairs(candidates) do
        if name == current then worn = true else others[#others + 1] = name end
    end
    if not worn then return rotate(others, avoid, ctx.random), 'required' end
    if #others == 0 or not ctx.hourChanged then return nil end
    -- A new in-game day brings another look of the same situation, in the morning (the first hour change of the day period after the day of the last pick).
    if ctx.period == 'day' and ctx.day ~= nil and ctx.pickDay ~= nil and ctx.day ~= ctx.pickDay then return rotate(others, avoid, ctx.random), 'daily' end
    if ctx.changedAt and ctx.hours and ctx.hours - ctx.changedAt < MIN_DWELL_H then return nil end
    local roll = tonumber(ctx.random and ctx.random()) or 1
    if roll >= VARIETY_CHANCE then return nil end
    return rotate(others, avoid, ctx.random), 'variety'
end

-- The look a new copy is created in (an invitation): the rotation of the situation, never the last look picked there while another exists. Returns the name or nil.
-- ctx = {period, home, formal, bad, random, last}.
function M.chooseSpawn(character, ctx)
    if type(character) ~= 'table' then return nil end
    local situation = situationFor(character, ctx.home, ctx.formal)
    local candidates = candidatesFor(character, ctx.period, situation, ctx.bad)
    if #candidates == 0 then return nil end
    return rotate(candidates, ctx.last and ctx.last[situation] or nil, ctx.random)
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Home: V's apartment, found by the game's district or set by name by another feature (docs/COMPANION_OUTFITS.md "Home outfit API").

-- key: a profile key ('judy-alvarez') or a model record ('Character.Judy'). on: true wears home clothes, false never, nil follows V's whereabouts.
function M.setHome(key, on)
    if type(key) ~= 'string' or key == '' then return false end
    if on ~= nil and type(on) ~= 'boolean' then return false end
    state.home[key] = on
    -- A decision is owed at the next look, not at the next hour change.
    state.wait = math.min(state.wait, STAGE_S)
    return true
end

-- 'home' for one of V's apartments, 'formal' for a club, a fancy bar or a Corpo district (never an apartment), else nil. A pure function of the district record name.
function M.placeClass(place)
    if type(place) ~= 'string' then return nil end
    if M.HOME_PLACES[place] then return 'home' end
    if place:find('Apartment$') then return nil end
    if M.FORMAL_PLACES[place] then return 'formal' end
    for _, prefix in ipairs(M.FORMAL_PREFIXES) do
        if place:sub(1, #prefix) == prefix then return 'formal' end
    end
    return nil
end

-- Where V is, read from the game once per call: 'home', 'formal', false (somewhere else) or nil when the game cannot say.
function M.currentPlaceClass()
    local deps = M.deps
    if not deps or type(deps.place) ~= 'function' then return nil end
    local ok, place = pcall(deps.place)
    if not ok or type(place) ~= 'string' then return nil end
    return M.placeClass(place) or false
end

-- true when V stands in one of V's apartments, false when elsewhere, nil when the game cannot say.
function M.vAtHome()
    local class = M.currentPlaceClass()
    if class == nil then return nil end
    return class == 'home'
end

function M.isHome(key, record)
    local explicit = state.home[key]
    if explicit == nil and record ~= nil then explicit = state.home[record] end
    return explicit
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Members: what the module knows about one copy (by serial).

local function member(row, current)
    local m = state.members[row.serial]
    if not m then
        m = {serial = row.serial, bad = {}}
        state.members[row.serial] = m
    end
    m.key, m.record = row.key, row.record
    if current then m.current = current end
    return m
end

-- 'home' when the copy wears its home clothes, 'changed' when it wears another look than its own base look, nil otherwise.
-- Read when a conversation turn is built (companions.activityInputs), never per frame; a copy this module never saw is nil.
function M.status(serial)
    local m = state.members[serial]
    if not m or not m.current then return nil end
    local character = M.character(m.record)
    if not character then return nil end
    if m.current == character.base then return nil end
    local kind = kindOf(character, m.current)
    if kind == nil then return nil end
    return kind == 'home' and 'home' or 'changed'   -- (a formal look is a change of clothes)
end

-- ---------------------------------------------------------------------------------------------------------------------
-- Not while V looks.

-- true: the copy may be on screen (or nobody can tell); false: it is out of view. The second value says why ('frustum', 'clear', 'angle', 'unreadable').
function M.inView(row, player)
    local deps = M.deps
    local ok, seen = pcall(deps.frustum, row.npc)
    if ok and type(seen) == 'boolean' then
        if seen and deps.angle then
            -- The frustum test is inflated (margins 2.0 and 0.75): in a small flat it can say "may be seen" for a copy far to the side of or behind V.
            -- Clearly off the camera's direction counts as out of view.
            local okAngle, angle = pcall(deps.angle, row.npc, player)
            if okAngle and type(angle) == 'number' and angle >= FAR_OFF_DEG then return false, 'angle' end
        end
        if seen and deps.hidden then
            -- The frustum is a cone with no walls: a copy in the next room is inside it. A wall between V's eyes and her hides her.
            local okHidden, hidden = pcall(deps.hidden, row.npc)
            if okHidden and hidden == true then return false, 'wall' end
        end
        return seen, seen and 'frustum' or 'clear'
    end
    if not state.frustumLogged then
        state.frustumLogged = true
        say('Companion outfits: the frustum test of the game gave ' .. (ok and tostring(seen) or ('an error (' .. tostring(seen):sub(1, 100) .. ')')) .. ', the camera angle decides')
    end
    if deps.angle then
        local okAngle, angle = pcall(deps.angle, row.npc, player)
        if okAngle and type(angle) == 'number' then return angle < OUT_OF_VIEW_DEG, 'angle' end
    end
    return true, 'unreadable'
end

local function currentName(row)
    local ok, name = pcall(M.deps.current, row)
    return ok and type(name) == 'string' and name ~= '' and name or nil
end

local function describe(m) return tostring(m.key or m.record or m.serial) end

-- A copy that stood up for a change is let back to the flat's places: the change is over, given up, or no longer wanted.
local function sitAgain(m, row, why)
    if not m.stood then return end
    m.stood = nil
    local deps = M.deps
    if not deps.sitAgain then return end
    local ok, result = pcall(deps.sitAgain, row, SIT_AGAIN_S)
    say('Companion outfits: ' .. describe(m) .. ' may sit again (' .. why .. ')' .. (ok and result == false and ', no hold on her' or ''))
end

-- One copy, one look: read back a started change, schedule a prefetched one, or begin one that is due.
local function step(row, player, ctx)
    local deps = M.deps
    local character = M.character(row.record)
    if not character then return end
    local now = ctx.now
    local live = currentName(row)
    local m = member(row, nil)

    if m.pending then
        local p = m.pending
        if live == p.name then
            m.current, m.changedAt, m.pending = p.name, ctx.hours, nil
            noteLook(m.key or m.record, character, p.name, ctx.hours)
            say('Companion outfits: ' .. describe(m) .. ' now wears ' .. p.name .. ' (' .. p.why .. ')')
            sitAgain(m, row, 'changed')
        elseif now - p.at >= GIVE_UP_S then
            m.bad[p.name], m.pending = true, nil
            pcall(deps.remember, row, p.from)
            say('Companion outfits: ' .. describe(m) .. ' did not change into ' .. p.name .. ' (still ' .. tostring(live) .. '); that look is not tried again')
            sitAgain(m, row, 'given up')
        end
        return
    end

    -- What the copy wears is whatever the game says.
    if live then m.current = live end
    if not m.current then return end

    if m.stage then
        -- The look has been loading for at least STAGE_S: schedule it if it is still unseen and still safe, otherwise start over at the next look.
        local stage = m.stage
        if now - stage.at < STAGE_S then return end
        m.stage = nil
        if ctx.world() or (deps.busy and deps.busy(row)) or M.inView(row, player) then m.unseenSince = nil; return end
        local ok, err = pcall(deps.apply, row, stage.name)
        if not ok then
            m.bad[stage.name] = true
            say('Companion outfits: ' .. describe(m) .. ' could not be changed into ' .. stage.name .. ' (' .. tostring(err):sub(1, 120) .. ')')
            sitAgain(m, row, 'failed')
            return
        end
        m.pending = {name = stage.name, why = stage.why, at = now, from = m.current}
        return
    end

    local home = M.isHome(m.key, m.record)
    local formal = false
    if home == nil then home = ctx.atHome == true; formal = ctx.atFormal == true end
    local pin = pinnedLook(m.key, m.record)
    local target, why
    -- With the setting off only a look the player chose is ever put on.
    if pin or wanted() then
        local last = memory()[m.key or m.record or '']
        target, why = M.choose(character, m.current, {
            period = ctx.period, home = home, formal = formal, hours = ctx.hours, changedAt = m.changedAt,
            hourChanged = ctx.hourChanged, bad = m.bad, random = deps.random or M.random, pinned = pin,
            last = last, day = ctx.day, pickDay = last and last.day or nil})
    end
    -- A variety look is rolled once, at the hour change: it stays wanted while she waits for the camera to look away.
    if not target and not pin and m.wanted and m.wanted.from == m.current and now - m.wanted.at < WANT_S then target, why = m.wanted.name, m.wanted.why end
    if not target then
        m.waiting, m.wanted, m.unseenSince, m.seenWhy = nil, nil, nil, nil
        sitAgain(m, row, 'no change wanted')
        return
    end
    if not (m.wanted and m.wanted.name == target) then m.wanted = {name = target, why = why, from = m.current, at = now} end
    -- A blocker is said once per change of reason, as a code: combat, scene, call, vehicle, v-seated (V's world), seated, command, vehicle (hers).
    local function blockedBy(code)
        m.unseenSince = nil
        local said = target .. ':' .. tostring(code)
        if m.waiting ~= said then m.waiting = said; say('Companion outfits: ' .. describe(m) .. ' wants ' .. target .. ' (' .. why .. '), waiting: ' .. tostring(code)) end
    end
    local blocked = ctx.world()
    if blocked then blockedBy(blocked); return end
    local busy = deps.busy and deps.busy(row)
    -- On a place of V's flat she may be changed once she stands (below); a seat that is not the flat's own (V's) stays a blocker.
    local seated = busy == 'seated' and deps.standUp ~= nil
    if busy and not seated then blockedBy(busy); return end
    local seen, seenWhy = M.inView(row, player)
    if seen then
        if m.seenWhy ~= seenWhy then m.seenWhy = seenWhy; say('Companion outfits: outfit-seen ' .. seenWhy) end
        m.unseenSince = nil
        ctx.looking = true
        if m.waiting ~= target .. ':seen' then m.waiting = target .. ':seen'; say('Companion outfits: ' .. describe(m) .. ' wants ' .. target .. ' (' .. why .. '), waiting until nobody is looking') end
        return
    end
    -- Out of view: she must stay out of it for UNSEEN_S before the change starts (a glance back starts the count again).
    if not m.unseenSince then
        m.unseenSince, m.seenWhy = now, nil
        say('Companion outfits: outfit-unseen 0')
    end
    if now - m.unseenSince < UNSEEN_S then ctx.looking = true; return end
    say('Companion outfits: outfit-unseen ' .. math.floor(now - m.unseenSince))
    if seated then
        -- Out of view on her place: she stands up first and takes no place for STAND_HOLD_S (the flat gives her one again afterwards); the change
        -- itself starts at a later look, once she stands and is still unseen for UNSEEN_S.
        local okStand, result = pcall(deps.standUp, row, STAND_HOLD_S)
        m.unseenSince = nil
        if okStand and (result == 'released' or result == 'waiting') then
            m.stood = true
            if result == 'released' then say('Companion outfits: ' .. describe(m) .. ' stands up from her place to change into ' .. target) end
            ctx.looking = true
            return
        end
        blockedBy('seated')
        return
    end
    m.unseenSince, m.waiting, m.wanted = nil, nil, nil
    say('Companion outfits: outfit-change-start ' .. target)
    local ok, err = pcall(deps.prefetch, row, target)
    if not ok then
        m.bad[target] = true
        say('Companion outfits: ' .. describe(m) .. ' could not prepare ' .. target .. ' (' .. tostring(err):sub(1, 120) .. ')')
        sitAgain(m, row, 'failed')
        return
    end
    m.stage = {name = target, why = why, at = now}
end

-- Called on the game's 10 Hz tick. elapsed: seconds since the previous call. ready: ordinary gameplay (a world, V attached).
function M.tick(player, elapsed, ready)
    if ready ~= true or not (wanted() or anyPinned()) then return end
    state.wait = state.wait - (tonumber(elapsed) or 0)
    if state.wait > 0 then return end
    local deps = M.deps
    state.wait = CHECK_S

    local okRows, rows = pcall(deps.rows)
    if not okRows or type(rows) ~= 'table' or #rows == 0 then return end
    local okHours, hours = pcall(deps.gameHours)
    if not okHours or type(hours) ~= 'number' then return end
    local hour = math.floor(hours) % 24
    local ctx = {hours = hours, hour = hour, day = math.floor(hours / 24), period = M.period(hour), hourChanged = state.lastHour ~= nil and state.lastHour ~= hour,
        now = (M.clock or os.clock)()}
    state.lastHour = hour
    -- V's whereabouts only matter when a copy has a home or a formal look: one district read per check.
    for _, row in ipairs(rows) do
        if M.hasHomeOutfit(row.record) or M.hasFormalOutfit(row.record) then
            local class = M.currentPlaceClass()
            ctx.atHome, ctx.atFormal = class == 'home', class == 'formal'
            break
        end
    end
    -- The world is asked once, and only when a copy wants to change (or has a change to finish).
    local asked, reason
    function ctx.world()
        if not asked then
            asked = true
            local okWorld, blocked = pcall(deps.world)
            reason = (not okWorld) and 'unreadable' or blocked
        end
        return reason
    end
    local follow = false
    local all = wanted()
    for _, row in ipairs(rows) do
        -- With the setting off only the copies of characters with a chosen look (and a change already under way) are looked at.
        local held = state.members[row.serial]
        if all or pinnedLook(row.key, row.record) or (held and (held.stage or held.pending)) then
            local ok, err = pcall(step, row, player, ctx)
            if not ok then say('Companion outfits: ' .. tostring(err):sub(1, 160)) end
            local m = state.members[row.serial]
            if m and (m.stage or m.pending) then follow = true end
        end
    end
    -- A started change is followed up quickly; a copy that waits for the camera to look away is looked at again in LOOK_S.
    if follow then state.wait = STAGE_S elseif ctx.looking then state.wait = LOOK_S end
end

-- A new copy, at creation (key: its profile key, for a home setting made by name): the appearance to create it with, or nil to leave it as the game and companion-records.lua make it. The copy appears in
-- front of V, so nothing is changed in view: it simply comes in the right clothes (casual at home, the night look at night).
function M.spawnAppearance(record, key)
    -- A look the player chose in the character editor is the look a new copy is made in, whatever the setting says.
    local pin = pinnedLook(key, record)
    if pin then return pin end
    if not wanted() then return nil end
    local character = M.character(record)
    if not character then return nil end
    local deps = M.deps
    local okHours, hours = pcall(deps.gameHours)
    if not okHours or type(hours) ~= 'number' then return character.explicit and character.base or nil end
    local home, formal = M.isHome(key, record), false
    if home == nil then
        local class = (hasKind(character, 'home') or hasKind(character, 'formal')) and M.currentPlaceClass() or nil
        home, formal = class == 'home', class == 'formal'
    end
    local target = M.chooseSpawn(character, {
        period = M.period(math.floor(hours) % 24), home = home, formal = formal, bad = {}, random = deps.random or M.random,
        last = memory()[key or record or '']})
    if target and target ~= character.base then return target end
    if character.explicit then return character.base end
    return nil
end

-- A copy created with this appearance wears it from the start: the member begins with it (no change to make, no change to flag).
function M.created(serial, key, record, name)
    if not serial then return end
    local m = state.members[serial] or {serial = serial, bad = {}}
    state.members[serial] = m
    -- A copy made without a named look wears its base look (the next check reads the live name either way).
    m.key, m.record, m.current = key, record, name
    -- It wears its look from the start: that look is the last pick of its situation (the rotation of the next invitation goes on from it).
    local character = M.character(record)
    local deps = M.deps
    if character and wanted() then
        local okHours, hours = pcall(deps.gameHours)
        noteLook(key or record, character, name or character.base, okHours and hours or nil)
    end
end

function M.forget(serial) state.members[serial] = nil end

-- A choice was saved in the character editor: the next look at the party is soon, not at the next 20 s check.
function M.nudge() state.wait = math.min(state.wait, STAGE_S) end

-- A new session (a load, a death, the main menu): nothing carries over. Fast travel keeps the members (init.lua abandonSession).
function M.reset()
    -- (The saved picks stay: they are the rotation's memory across sessions.)
    state.members, state.home, state.wait, state.lastHour, state.frustumLogged = {}, {}, 0, nil, nil
end

-- For the tests and the support report: what the module holds.
function M.snapshot()
    local out = {}
    for serial, m in pairs(state.members) do
        out[#out + 1] = {serial = serial, key = m.key, record = m.record, current = m.current, waiting = m.waiting,
            staged = m.stage and m.stage.name or nil, pending = m.pending and m.pending.name or nil}
    end
    table.sort(out, function(a, b) return tostring(a.serial) < tostring(b.serial) end)
    return out
end

return M
