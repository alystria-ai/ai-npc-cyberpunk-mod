-- The glue between mod/init.lua and the housemates (docs/HOUSEMATES.md). init.lua holds one table of dependencies and a handful of one-line
-- globals; everything that has a rule lives here, where the tests can run it.
--
-- This file is small and is loaded when the first world is ready. The bigger modules (the controller, the game adapter, the chat scheduler,
-- the spot data) are loaded the first time something needs them: a conversation offer, or a housemate in the registry. The registry is read
-- once per world: one saved quest fact per known profile key (mod/housemate-registry.lua).
--
-- deps: load(name) -> module (dofile), companions, queue() -> the party queue, catalog() -> the gesture catalogue, seating() -> the seating
--       module (for its native layer), fact(name), place(), hours(), held(), vpos(), knownKeys(), eligible(key), profileName(key),
--       notify(text), t(text, vars), log(line), devLog(kind, fields), talking(), random(),
--       speak(request) / speakStatus() / speakCancel() / speakPrepare(request) / speakUnprepare() (the automatic spoken lines; the last two are optional: the next chat line written while one plays), greet(info), level(), mayChat(), limiter,
--       outfits() -> {setHome}, leave(serial, entity, key, name) -> a departure, persist = {load, store} (the seats V sat on),
--       reserved(apt) -> the places party companions hold in that flat, hookDistrict(fn), storeMode(), chatOn() -> boolean (nil: the pair chat is on; Settings > Housemates > Housemates talk to each other)
local M = {}

function M.new(d)
    local S = {controller = nil, state = {acc = 0, read = false, homes = nil}}
    local registry = d.load('housemate-registry.lua')
    -- `ui.t('literal')` so that scripts/Extract-UiCatalog.mjs finds every text of this file.
    local ui = {t = function(text, vars) if d.t then return d.t(text, vars) end return text end}

    local function store()
        if d.storeMode and d.storeMode() == 'file' then
            S.fileStore = S.fileStore or registry.fileStore()
            return S.fileStore
        end
        S.factStore = S.factStore or registry.factStore()
        return S.factStore
    end

    -- The pair chat module exists only while "Housemates talk to each other" is On: it is loaded when it is wanted and dropped when it is not.
    local function syncChat(controller)
        local wanted = not d.chatOn or d.chatOn() ~= false
        if not wanted then
            if S.chat then controller.setChat(nil); S.chat = nil end
            return
        end
        if S.chat then return end
        local chatLoaded, Chat = pcall(d.load, 'housemate-chat.lua')
        if not chatLoaded or type(Chat) ~= 'table' then return end
        S.chat = Chat.new({
            random = d.random, level = d.level, mayStart = d.mayChat, vPos = d.vpos, limiter = d.limiter,
            cooldown = d.chatCooldown, groupSize = d.chatSize,
            people = function() return controller.people() end,
            speak = d.speak, status = d.speakStatus, cancelSpeak = d.speakCancel, prepare = d.speakPrepare, unprepare = d.speakUnprepare, log = d.log})
        controller.setChat(S.chat)
    end

    local function ensure()
        if S.controller then return S.controller end
        local loaded, Housemates = pcall(d.load, 'housemates.lua')
        local worldLoaded, World = pcall(d.load, 'housemate-world.lua')
        if not loaded or not worldLoaded or type(Housemates) ~= 'table' or type(World) ~= 'table' then
            if d.log then d.log('Housemates are unavailable: ' .. tostring(loaded and World or Housemates)) end
            return nil
        end
        local world = World.new({seating = d.seating and d.seating(), catalog = d.catalog and d.catalog() or {}, companions = d.companions,
            queue = d.queue, vpos = d.vpos, log = d.devLog})
        S.world = world
        local outfits = {setHome = function(key, on) local api = d.outfits and d.outfits(); if api then return api.setHome(key, on) end end}
        local controller
        local env = {
            data = function() return d.load('housemate-spots-data.lua') end,
            place = d.place, hours = d.hours, ready = function() return true end, held = d.held, fact = d.fact, vpos = d.vpos,
            eligible = d.eligible, profileName = d.profileName, store = store(), random = d.random, talking = d.talking,
            twin = world.twin, rig = world.rig, proc = world.proc,
            ours = function(entity)
                if d.companions.partyMember(entity) then return true end
                for _, row in ipairs(d.companions.visitors()) do if row.entityID == entity then return true end end
                return false
            end,
            notify = d.notify, log = d.log, t = d.t,
            bodies = world.bodies, seats = world.seats, reserved = d.reserved,
            companions = {
                join = function(serial) return d.companions.joinVisitor(serial) end,
                releaseToHome = function(serial, apt) return d.companions.releaseToHome(serial, apt) end,
                partyMember = function(key) return d.companions.partyMemberOf(key) end,
                leave = function(serial)
                    for _, row in ipairs(d.companions.list()) do
                        if row.serial == serial then return d.leave(serial, row.entityID, row.profileKey, row.profileName or row.name) end
                    end
                end},
            outfits = outfits,
            greet = d.greet, moveIn = d.moveIn,
        }
        controller = Housemates.new(env)
        S.controller = controller
        syncChat(controller)
        controller.setHomes(S.state.homes or {})
        if d.persist then
            local ok, file = pcall(d.persist.load)
            if ok and type(file) == 'table' and type(file.seats) == 'table' then controller.setLearned(file.seats) end
            env.learnedStore = function(list) pcall(d.persist.store, {version = 1, seats = list}) end
        end
        d.companions.onResidentLost = function(serial, reason) if S.controller then S.controller.lost(serial, reason) end end
        if d.hookDistrict then d.hookDistrict(function() if S.controller then S.controller.wake() end end) end
        return controller
    end

    S.ensure = ensure

    -- Every 0.1 s of play time, from the world-ready part of the 10 Hz poll.
    function S.tick(delta)
        local state = S.state
        if not state.read then
            state.read = true
            local keys = d.knownKeys and d.knownKeys() or {}
            state.homes = registry.read(store(), keys)
            if S.controller then S.controller.setHomes(state.homes)
            elseif next(state.homes) ~= nil then ensure() end
            return
        end
        if S.controller then
            syncChat(S.controller)
            S.controller.update(delta)
        end
    end

    -- Settings > Housemates went Off: the controller removes the bodies quietly and goes, the world adapter lets go of its seats, and the glue forgets
    -- what it read. The saved flats stay: a new glue reads them when the setting is On again. (onResidentLost stays as it is: it does nothing without a
    -- controller, and a body that is lost must not be handed to the immersive visitors.)
    function S.disable()
        local controller = S.controller
        if controller and controller.shutdown then pcall(controller.shutdown) end
        S.controller, S.chat = nil, nil
        if S.world and S.world.abandon then pcall(S.world.abandon, false) end
        S.world = nil
        S.state = {acc = 0, read = false, homes = nil}
    end

    -- A world ended (preserve == false) or V fast travelled (preserve == true).
    function S.reset(reason, preserve)
        if S.controller then pcall(S.controller.reset, reason, preserve) end
        if S.world and S.world.abandon then pcall(S.world.abandon, preserve ~= true) end
        if preserve ~= true then S.state = {acc = 0, read = false, homes = nil} end
    end

    -- ---- conversation offers ----------------------------------------------------------------------------------------------------------
    function S.homeOffer(entity, context)
        local controller = S.controller or ensure()
        return controller and controller.homeOffer(entity, context) or nil
    end
    function S.groupHomeOffer(entity, context)
        local controller = S.controller or ensure()
        return controller and controller.groupOffer(entity, context) or nil
    end
    function S.queueHome(home, offer, entity, requestId, groupId)
        -- The offer this choice answers built the controller; without one (it could not be loaded) the choice is refused, and written down.
        local controller = S.controller or ensure()
        if not controller then
            if d.log then d.log('Housemates failed:no-controller') end
            return false, ui.t('That action is not available.')
        end
        return controller.queueHome(home, offer, entity, requestId)
    end
    function S.decorateLeave(offer)
        local controller = S.controller
        if controller and next(controller.homes()) ~= nil then return controller.decorateLeave(offer) end
        return offer
    end
    -- A leave packet: the housemates at home are released into their routine, the others leave as before (adoptionQueue).
    function S.queueLeave(target, offer, entity, requestId, groupId, adoptionQueue)
        local controller = S.controller
        if not controller or next(controller.homes()) == nil then return adoptionQueue(target, offer, entity, requestId, groupId) end
        local split = controller.splitLeave(target, offer)
        local names = {}
        for _, member in ipairs(split.rest) do
            local ok = controller.restHere(member.serial, member.key)
            if ok then names[#names + 1] = member.name end
        end
        if #names > 0 then d.notify(ui.t('{name} is back at home.', {name = table.concat(names, ', ')})) end
        local departing = {available = true, actor = offer.actor, members = split.depart}
        local accepted, message
        if #split.depart > 0 then accepted, message = adoptionQueue('all', departing, entity, requestId, groupId) end
        if #split.rest == 0 and #split.depart == 0 then return false, '' end
        return (#names > 0) or accepted == true, message
    end

    -- ---- phone ------------------------------------------------------------------------------------------------------------------------
    function S.phoneOffer(contactKey, profileKey)
        local controller = S.controller or ensure()
        return controller and controller.phoneOffer(profileKey) or nil
    end
    function S.phoneAction(profileKey, action)
        local controller = S.controller
        if controller then return controller.phoneAction(profileKey, action) end
        return false
    end

    -- ---- turns, talk, manager ------------------------------------------------------------------------------------------------------------
    -- The note a turn with this character carries (bridge/turn-context.mjs `housemate`); the snapshot may be shared, so the note goes on a copy.
    function S.turn(snapshot, profileKey)
        local controller = S.controller
        if not controller or type(snapshot) ~= 'table' or type(profileKey) ~= 'string' then return snapshot end
        local ok, note = pcall(controller.note, profileKey)
        if not ok or not note then return snapshot end
        local copy = {}
        for key, value in pairs(snapshot) do copy[key] = value end
        copy.housemate = note
        pcall(controller.noted, profileKey)
        return copy
    end
    function S.talkStarted(entity) if S.controller then S.controller.talkStarted(entity) end end
    function S.learnV(anchor, forward, kind) if S.controller then S.controller.learnV(anchor, forward, kind) end end
    function S.rows() return S.controller and S.controller.rows() or {} end
    function S.moveOut(key)
        local controller = S.controller
        if not controller then return false end
        return controller.moveOut(key)
    end
    function S.ownedApartments()
        local controller = S.controller
        return controller and controller.ownedApartments() or {}
    end
    function S.evictAll()
        local controller = S.controller
        if not controller then return 0 end
        return controller.evictAll()
    end
    function S.snapshot() return S.controller and S.controller.snapshot() or nil end

    return S
end

return M
