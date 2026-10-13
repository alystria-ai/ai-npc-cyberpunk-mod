-- Example add-on for Cyberpunk Convai (docs/ADDON_API.md). "Echo", a voice in V's earpiece: it answers the talk key while
-- V is on foot, says a short line at the start and end of a fight, has two personalities and remembers how fights went.
-- Copy this folder to start a new add-on.
--
-- Installed as its own CET mod: bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvaiExample/ (packaging/build-addon.mjs).
-- Without Cyberpunk Convai, or with one that is too old, it prints one line and does nothing else.
-- Echo's text comes from Mistral or the local AI only (convai-addon.json "providers"); with neither set up the main mod says so once.
local Example = {handle = nil, speaker = nil, fight = nil}

local MODES = {'dry', 'cheerful'}   -- the ids of the modes in convai-addon.json, in the order of the setting's elements

registerForEvent('onInit', function()
    local main = GetMod('CyberpunkConvai')
    local api = type(main) == 'table' and main.addons or nil
    if not api then
        print('[Echo] Cyberpunk Convai is not installed (or is older than the add-on API); Echo stays off.')
        return
    end
    -- `requires` is the add-on API version this add-on was written for. A main mod that cannot serve it tells the player.
    local handle, reason = api.register({id = 'example', name = 'Example Voice', version = '1.0.0', requires = '1.0'})
    if not handle then
        print('[Echo] Not registered: ' .. tostring(reason))
        return
    end
    Example.handle = handle

    -- The speaker id and name match convai-addon.json. 'player' anchors the voice on V (heard as V's own earpiece).
    Example.speaker = handle:speaker({id = 'voice', name = 'Echo', anchor = 'player',
        available = function(player)
            if handle:setting('enabled') == false then return false end
            return player ~= nil and player:GetMountedVehicle() == nil
        end})

    -- The main mod adds a "Remarks" setting (Rare / Low / Normal) above these for every add-on with a speaker.
    handle:settings({title = 'Echo (example add-on)', description = 'A voice in V\'s earpiece.', items = {
        {id = 'enabled', label = 'Echo', kind = 'bool', default = true,
            description = 'Echo answers the talk key while you are on foot and no character is in front of you.'},
        {id = 'personality', label = 'Personality', kind = 'select', default = 1, elements = {'Dry', 'Cheerful'},
            description = 'How Echo talks.'},
    }})
    handle:setMode('voice', MODES[handle:setting('personality')] or 'dry')
    handle:on('settingChanged', function(change)
        if change.id == 'personality' then handle:setMode('voice', MODES[change.value] or 'dry') end
    end)

    -- Few remarks, at the best moments: a fight starting (priority 3) and ending (priority 5, kept for the budget's last slot).
    handle:on('combatStarted', function()
        if handle:setting('enabled') == false then return end
        Example.fight = {started = os.time()}
        handle:prepare('voice')
        handle:remark('voice', {event = 'combat-start', text = 'A fight has just started around V.',
            facts = {where = 'nearby'}, priority = 3, ttl = 4, maxWords = 10, cooldown = 60})
    end)
    handle:on('combatEnded', function()
        if handle:setting('enabled') == false or not Example.fight then return end
        local seconds = os.time() - Example.fight.started
        Example.fight = nil
        handle:remark('voice', {event = 'fight-end', text = 'The fight around V is over.', facts = {seconds = seconds},
            priority = 5, ttl = 6, maxWords = 12})
        -- A memory Echo can call back to in a later fight.
        if seconds >= 60 then handle:remember('voice', 'A long fight (' .. math.floor(seconds / 60) .. ' minutes) that V walked away from.') end
    end)
end)

return Example
