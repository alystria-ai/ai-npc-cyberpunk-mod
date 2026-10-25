-- The glue between mod/init.lua and immersive invitations (docs/IMMERSIVE_INVITATIONS.md): it builds the controller and the game adapter
-- when Settings > Immersive invitations is On, ticks it, binds it to the save line, hands it the phone hooks, and drops all of it when the
-- setting goes Off. init.lua holds one table of dependencies and four one-line globals; everything that has a rule lives here, where the tests
-- can run it.
--
-- While the setting is Off tick() is one table read and nothing else is loaded: the controller and the adapter are `deps.load`ed on the first On.
local M = {}

-- deps: manager (immersive()), queue() -> the party queue, companions, phoneChat, load(name) -> module, notify(kind, text), log(line),
--       logOnce(key, line), held(), districtOf(), greet(info), persist = {load, store}, wall(), random()
function M.new(deps)
    local S = {controller = nil, state = {acc = 0, key = false}}

    -- A text from a character: a phone turn in her own voice (mod/phone-chat.lua sendEvent), or, when she has no phone contact, a notice.
    function S.text(item)
        if deps.phoneChat.sendEvent and deps.phoneChat.sendEvent(item) then return true end
        deps.notify('text', tostring(item.name) .. ': ' .. tostring(item.fallback))
        return true
    end

    local function unhook()
        local phone = deps.phoneChat
        phone.captureMeetOffer, phone.onMeetAction, phone.onEventDelivered = nil, nil, nil
        deps.companions.onVisitorLost = nil
        rawset(_G, 'convaiCompanionCar', nil)
        rawset(_G, 'convaiCompanionCarIs', nil)
    end

    function S.ensure()
        if S.controller then return S.controller end
        local loaded, module = pcall(deps.load, 'immersive-invitations.lua')
        local worldLoaded, worldModule = pcall(deps.load, 'immersive-world.lua')
        if not loaded or not worldLoaded or type(module) ~= 'table' or type(worldModule) ~= 'table' then
            deps.logOnce('immersive-load', 'Immersive invitations are unavailable: ' .. tostring(loaded and worldModule or module))
            return nil
        end
        local queue = deps.queue()
        if not queue then return nil end
        local companions = deps.companions
        S.controller = module.new({
            settings = deps.manager.immersive, queue = queue, companions = companions,
            world = worldModule.new({companions = companions, held = deps.held, districtOf = deps.districtOf}),
            text = {send = S.text}, notify = deps.notify, greet = deps.greet, persist = deps.persist,
            wall = deps.wall, random = deps.random, log = deps.log})
        companions.onVisitorLost = function(serial, reason)
            if S.controller then S.controller.visitorLost(serial, reason) end
        end
        -- Her car, for a ride in it (docs/IMMERSIVE_INVITATIONS.md): the chauffeur asks for it by profile while the setting is On.
        rawset(_G, 'convaiCompanionCar', function(profileKey)
            local controller = S.controller
            return controller and controller.carEntity(profileKey) or nil
        end)
        rawset(_G, 'convaiCompanionCarIs', function(entity)
            local controller = S.controller
            return controller ~= nil and controller.isHerCar(entity) == true
        end)
        local phone = deps.phoneChat
        phone.captureMeetOffer = function(contact, profileKey)
            local controller = S.controller
            if not controller then return nil end
            local key = companions.phoneContactKey(contact)
            return key and controller.offer(profileKey, key) or nil
        end
        phone.onMeetAction = function(profileKey, action)
            local controller = S.controller
            if controller then controller.accept(profileKey, action) end
        end
        phone.onEventDelivered = function(item, text)
            local line = tostring(text or item.fallback or '')
            if #line > 140 then line = line:sub(1, 137):gsub('[\128-\191]+$', '') .. '...' end
            deps.notify('text', tostring(item.name) .. ': ' .. line)
        end
        S.state = {acc = 0, key = false}
        return S.controller
    end

    -- The controller for the manager's Invite button: nil while the setting is Off (the old instant path applies).
    function S.get()
        if not deps.manager.immersive().enabled then return nil end
        return S.controller or S.ensure()
    end

    -- Every 0.1 s of play time, from the world-ready part of onUpdate.
    function S.tick(delta)
        local options = deps.manager.immersive()
        if not options.enabled then
            if S.controller then
                pcall(S.controller.disable)
                S.controller = nil
                unhook()
            end
            return
        end
        local controller = S.controller or S.ensure()
        if not controller then return end
        local state = S.state
        state.acc = state.acc + delta
        if state.acc >= 2 or state.key == false then
            state.acc = 0
            -- The save line (campaign and branch) when the game names it; otherwise only this session of the world (kept over a CET reload).
            local identity = deps.phoneChat.saveIdentity
            local key, sequence
            if type(identity) == 'table' and identity.status == 'available' and identity.campaignId and identity.branchId then
                key, sequence = tostring(identity.campaignId) .. ':' .. tostring(identity.branchId), identity.ledgerSequence
            elseif deps.phoneChat.world then key = 'session:' .. tostring(deps.phoneChat.world) end
            if key ~= nil then
                state.key = key
                controller.bind(key, sequence)
            end
        end
        if state.key ~= false then controller.update(delta) end
        -- Car arrival keeps a short trail of the roads V has driven (the one place a road is known for certain).
        if options.arrival == 'car' then
            state.trail = (state.trail or 0) + delta
            if state.trail >= 2 then state.trail = 0; controller.sampleTrail() end
        end
    end

    -- A save load or world loss ends what was simulated; a fast travel keeps the appointments (the visitors were deleted before it).
    function S.reset(reason, preserve)
        if preserve == true then return end
        local controller = S.controller
        if controller then pcall(controller.bind, nil, nil) end
        S.state = {acc = 0, key = false}
    end

    -- The note a turn with this character carries (bridge/turn-context.mjs `appointment`): on her way, waiting, stood up, called off.
    -- The snapshot may be shared and cached, so the note goes on a copy.
    function S.appointmentTurn(snapshot, profileKey)
        local controller = S.controller
        if not controller or type(snapshot) ~= 'table' or type(profileKey) ~= 'string' then return snapshot end
        local ok, note = pcall(controller.note, profileKey)
        if not ok or not note then return snapshot end
        local copy = {}
        for key, value in pairs(snapshot) do copy[key] = value end
        copy.appointment = note
        pcall(controller.noted, profileKey)
        return copy
    end

    return S
end

return M
