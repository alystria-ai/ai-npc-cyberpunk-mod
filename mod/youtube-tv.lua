-- YouTube on V's TV (docs/YOUTUBE_TV.md): the game side.
--
-- r6/scripts/CyberpunkConvai/YouTubeTv.reds adds the TV choices in V's homes and calls PlayerPuppet:ConvaiYouTubeTvChoice(choice);
-- this module observes that call (event-driven), writes one small command file (runtime/youtube-tv-command.json) and the bridge
-- (bridge/youtube-tv-host.mjs) opens the TV window, plays the video and answers in runtime/youtube-tv-state.json.
--
-- Cost: nothing runs per frame. With no video open, M.update returns at its first comparison and M.sync pushes the setting to the
-- player at most every 2 s (one script call, only when it changed or the player object is new). While a video is open: a menu check
-- (one blackboard read) four times a second, and the state file and V's place once a second.
local M = {version = 1, active = false}

local COMMAND, STATE = 'runtime/youtube-tv-command.json', 'runtime/youtube-tv-state.json'
-- V's homes: the district the game reports inside each apartment (gamedataDistrict; the same list is in YouTubeTv.reds).
M.HOMES = {LittleChina_VApartment = true, Northside_Apartment = true, JapanTown_Apartment = true, Glen_Apartment = true,
    CorpoPlaza_Apartment = true}
local env = {}
local counter, lastMode, lastPlayer, syncAt = 0, nil, nil, -1000
local menuAt, stateAt, hidden, openedAt, openedWall, lastState = 0, 0, false, 0, 0, nil

local function log(text) if env.log then pcall(env.log, '[YouTubeTv] ' .. text) end end
-- The mod's dictionaries (mod/ui-locale.lua, given by init.lua). Written as ui.t('...') so scripts/Extract-UiCatalog.mjs finds every text.
local ui = {t = function(text, values) return env.ui and env.ui.t and env.ui.t(text, values) or text end}

-- The TV page's sentences in the order of bridge/youtube-tv-page.mjs PAGE_STRINGS (a test keeps them equal), each with its translation.
local function pageStrings()
    local strings = {}
    local function put(text, translated) strings[text] = translated end
    put('YouTube on the TV', ui.t('YouTube on the TV'))
    put('Paste a YouTube link or video id', ui.t('Paste a YouTube link or video id'))
    put('Play', ui.t('Play'))
    put('Search YouTube', ui.t('Search YouTube'))
    put('Search', ui.t('Search'))
    put('Recently watched', ui.t('Recently watched'))
    put('Close', ui.t('Close'))
    put('That is not a YouTube link or video id.', ui.t('That is not a YouTube link or video id.'))
    put('This video cannot be played here. Choose another one.', ui.t('This video cannot be played here. Choose another one.'))
    put('Loading…', ui.t('Loading…'))
    put('Pick a video, then click back into the game. Use the TV to pause or stop it.',
        ui.t('Pick a video, then click back into the game. Use the TV to pause or stop it.'))
    return strings
end
local function clock() return env.clock and env.clock() or os.clock() end
local function enabled()
    if not env.enabled then return false end
    local ok, value = pcall(env.enabled)
    return ok and value == true
end
local function notice(player, text)
    if convaiNotices and player then pcall(function() convaiNotices.send(player, 'youtube-tv', text) end) end
end

-- The place V is in (init.lua's currentDistrict): true inside one of V's homes.
function M.atHome()
    if not env.place then return false end
    local ok, place = pcall(env.place)
    return ok and type(place) == 'table' and M.HOMES[place.area or ''] == true, ok and type(place) == 'table' and place.area or nil
end

local function write(command)
    counter = counter + 1
    command.version, command.id, command.issuedAt = 1, 'y' .. os.time() .. '-' .. counter, os.time() * 1000.0
    local ok = pcall(function()
        local text = json.encode(command)
        local file = io.open(COMMAND, 'wb')
        if not file then error('no file') end
        local wrote = file:write(text); file:close()
        if not wrote then error('write failed') end
    end)
    if not ok then log('command not written: ' .. tostring(command.action)) end
    return ok
end

-- The setting and the session as the TV choices see them: 0 off, 1 on, 2 a video is open. Labels once per player object.
function M.sync(player, force)
    if not player then return end
    local now = clock()
    if not force and now - syncAt < 2 then return end
    syncAt = now
    local mode = enabled() and (M.active and 2 or 1) or 0
    if mode == lastMode and player == lastPlayer and not force then return end
    local ok = pcall(function()
        if player ~= lastPlayer then player:ConvaiYouTubeTvSetLabels(ui.t('YouTube'), ui.t('YouTube: pause or play'), ui.t('YouTube: stop')) end
        player:ConvaiYouTubeTvSetMode(mode)
    end)
    if ok then lastMode, lastPlayer = mode, player end
end

function M.open(player, how)
    if not enabled() then return false end
    local home, area = M.atHome()
    if not home then log('open refused: not in V\'s home (' .. tostring(area) .. ')'); return false end
    local language = env.ui and env.ui.current and env.ui.current() or 'en'
    if not write({action = 'open', language = language, strings = pageStrings(), place = area}) then
        notice(player, ui.t('YouTube could not open on the TV. Try again.'))
        return false
    end
    M.active, hidden, openedAt, stateAt, lastState = true, false, clock(), clock(), nil
    openedWall = os.time() * 1000
    log('open (' .. tostring(how) .. ') place=' .. tostring(area))
    M.sync(player, true)
    return true
end

function M.command(action, reason)
    if not M.active then return false end
    return write({action = action, reason = reason})
end

-- The TV choice (YouTubeTv.reds): "open", "toggle" or "stop".
function M.choice(player, choice)
    if choice == 'open' then return M.open(player, 'tv') end
    if choice == 'toggle' then return M.command('toggle') end
    if choice == 'stop' then
        local sent = M.command('stop', 'player')
        M.finish(player, 'stopped')
        return sent
    end
    return false
end

-- The key binding "YouTube on the TV": on the couch the game shows the apartment's own scene choices, not the TV's device choices,
-- so the same thing is offered on a key. With no video open it opens the picker; with one open it pauses or plays.
function M.hotkey()
    local player = Game.GetPlayer()
    if not player then return end
    if not enabled() then return end
    if env.inMenu then local ok, inMenu = pcall(env.inMenu); if ok and inMenu then return end end
    if M.active then M.command('toggle') else
        if not M.open(player, 'key') then notice(player, ui.t("YouTube on the TV works in V's apartments.")) end
    end
end

function M.finish(player, why)
    if not M.active then return end
    M.active, hidden, lastState = false, false, nil
    log('finished (' .. tostring(why) .. ')')
    M.sync(player, true)
end

local function readState()
    local ok, value = pcall(function()
        local file = io.open(STATE, 'rb')
        if not file then return nil end
        local text = file:read('*a'); file:close()
        return text and #text < 4096 and json.decode(text) or nil
    end)
    return ok and type(value) == 'table' and value or nil
end

-- While a video session is open: hide the TV window under menus, end it when V leaves home or the bridge closed it.
function M.update(player, worldReady)
    if not M.active then return end
    local now = clock()
    if now - menuAt >= 0.25 then
        menuAt = now
        local menu = not worldReady
        if env.inMenu and not menu then local ok, inMenu = pcall(env.inMenu); menu = ok and inMenu == true end
        if menu ~= hidden then hidden = menu; M.command(menu and 'hide' or 'show', menu and 'game-menu' or nil) end
    end
    if now - stateAt < 1 then return end
    stateAt = now
    if worldReady and not M.atHome() then
        M.command('stop', 'left-home'); M.finish(player, 'left-home'); return
    end
    local state = readState()
    if not state or type(state.updated) ~= 'number' then return end
    -- Only an answer written after this session opened counts.
    if state.updated < openedWall - 1000 then return end
    if state.state ~= lastState then
        lastState = state.state
        if state.state == 'error' then
            notice(player, state.reason == 'disabled' and ui.t('YouTube on the TV is turned off in the settings.')
                or ui.t('YouTube could not open on the TV. Use Windowed Borderless or Windowed mode and try again.'))
            M.finish(player, 'error:' .. tostring(state.reason))
        elseif state.state == 'closed' and now - openedAt > 1 then
            M.finish(player, 'closed:' .. tostring(state.reason))
        end
    end
end

-- Called once from init.lua's onInit. options: log, ui, enabled(), place(), inMenu(), clock().
function M.install(options)
    env = options or {}
    local ok, problem = pcall(function()
        ObserveAfter('PlayerPuppet', 'ConvaiYouTubeTvChoice', function(player, choice)
            local done, failure = pcall(M.choice, player, choice)
            if not done then log('choice failed: ' .. tostring(failure)) end
        end)
    end)
    if not ok then log('install failed: ' .. tostring(problem)) end
    return ok
end

-- A load, death or detach: the session belongs to the old world. The bridge is told to stop; the player object is new.
function M.reset(reason)
    if M.active then M.command('stop', reason or 'world') end
    M.active, hidden, lastState, lastMode, lastPlayer, syncAt = false, false, nil, nil, nil, -1000
end

return M
