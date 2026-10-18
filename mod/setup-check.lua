-- Setup check (docs/MANAGER_UI.md, "Setup check"): what the game can see of this mod's installation, and what the conversation
-- service found (runtime/setup-check.json, written by bridge/setup-check.mjs), as one line per check with a one-line fix.
-- Shown first on the Help page (mod/mcm.lua), as one notice at the first load when something critical is wrong, and, without Mod
-- Configuration Menu (so without the Help page), as one line in the CET console and probe.log plus that notice.
--
-- Game side (works with no service): the mod's own data files, the game and Cyber Engine Tweaks versions, RED4ext, redscript (this
-- mod's scripts), Codeware, TweakXL, Audioware, Mod Configuration Menu, and the service's status (service-status.lua).
-- Service side (only an answer of this game session is shown): the Scripts and Runtime versions, optional packs and packs one folder
-- too deep, the browser, Local AI and why it is down, whether the chosen provider's server can be reached, the graphics card and a
-- mod manager.
--
-- Cost: run() opens five small files and asks CET whether a few classes exist, a few milliseconds. It runs once FIRST_DELAY_S after
-- the first world is ready and once each time the Help page opens, never per frame. tick() is called from mcm.lua's quarter-second
-- slow update: a few comparisons, plus one small read a second for at most FOLLOW_S while the Help page waits for the service.
-- Nothing here touches native game state beyond read-only getters.
if type(convaiSetupCheck) == 'table' and convaiSetupCheck.version == 1 then return convaiSetupCheck end
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}

local TESTED_GAME = '2.31'
local RESULT, REQUEST, PROBE_LOG = 'runtime/setup-check.json', 'runtime/setup-check-request.json', 'runtime/probe.log'
local SESSION_WINDOW_S = 180   -- a service answer written this long before the mod loaded still counts as this session's (service-status.lua)
local FIRST_DELAY_S = 12       -- the first-load check waits this long after the first world is ready: the service has said something by then
local FOLLOW_S = 15            -- how long the Help page follows the request it wrote
local CATALOGS = {'world-knowledge.json', 'manager-characters.json', 'conversation-characters.json', 'phone-contacts.json'}
local LOCALE_COUNT = 15
-- bridge-service.json codes that mean the Runtime's files are missing or incomplete (bridge/bridge-supervisor.mjs,
-- packaging/runtime/start-service.mjs, native/autostart/CyberpunkConvaiLauncher.c).
local INCOMPLETE = {['install-incomplete'] = true, ['bridge-missing'] = true, ['missing-character-ids'] = true,
    ['launcher-not-configured'] = true, ['launcher-program-missing'] = true, ['launcher-directory-missing'] = true}
-- The order of the game-side lines on the page and in the notice's choice (the first critical problem is the one announced).
local CRITICAL = {'red4ext', 'codeware', 'redscript', 'audioware', 'tweakxl', 'mcm', 'files', 'service', 'versions', 'packs', 'internet'}
local MCM_CONSOLE = 'AI NPC Cyberpunk Mod: Mod Configuration Menu is missing or too old, so the Companion Manager cannot open. '
    .. 'Install Mod Configuration Menu 0.10.3 or newer from Nexus Mods, then restart the game.'

local loadedAt = os.time()
local game                -- the last game-side result: {checks = {id -> check}, at}
local bridge              -- the service's answer of this session (decoded runtime/setup-check.json), or nil
local pending             -- {id, untilAt, nextAt} while the Help page waits for the service's answer
local refreshDue = false
local firstDue, firstDone = nil, false
local counter, content = 0, ''

------------------------------------------------------------------ helpers

local function try(fn)
    local ok, value = pcall(fn)
    if ok then return value end
    return nil
end

local function text(value, size)
    if type(value) ~= 'string' or value == '' then return nil end
    return value:gsub('[%c]', ' '):sub(1, size or 60)
end

local function readJson(path)
    local raw = try(function()
        local file = io.open(path, 'rb')
        if not file then return nil end
        local data = file:read(262144); file:close()
        return data
    end)
    if type(raw) ~= 'string' or raw == '' then return nil end
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function exists(path)
    return try(function()
        local file = io.open(path, 'rb')
        if not file then return false end
        file:close()
        return true
    end) == true
end

local function appendLog(line)
    pcall(function()
        local file = io.open(PROBE_LOG, 'a')
        if file then file:write(os.date('!%Y-%m-%dT%H:%M:%SZ'), ' ', line, '\n'); file:close() end
    end)
end

local function gigabytes(mib)
    if type(mib) ~= 'number' or mib <= 0 then return nil end
    local value = string.format('%.1f', mib / 1024)
    return (value:gsub('%.0$', ''))
end

------------------------------------------------------------------ game side

-- Each probe is read-only and pcall-wrapped: a framework that is absent leaves its class (and its static Version()) undefined.
local function frameworks()
    local found = {}
    found.cet = text(try(function() return GetVersion() end), 40)
    found.codewareVersion = text(try(function() return Codeware.Version() end), 40)
    found.codeware = found.codewareVersion ~= nil or try(function() return Codeware ~= nil end) == true
    found.tweakxlVersion = text(try(function() return TweakXL.Version() end), 40)
    found.tweakxl = found.tweakxlVersion ~= nil or try(function() return TweakXL ~= nil end) == true
    found.audiowareVersion = text(try(function() return Game.GetAudioSystemExt():Version() end), 40)
    found.audioware = found.audiowareVersion ~= nil or try(function() return AudioSystemExt ~= nil end) == true
        or try(function() return Game.GetScriptableSystemsContainer():Get('Audioware.AudiowareSystem') ~= nil end) == true
    -- This mod's own scripts (r6/scripts/CyberpunkConvai): a getter they add to the player. nil while there is no player to ask.
    local player = try(function() return Game.GetPlayer() end)
    if player then found.redscript = try(function() return type(player:ConvaiPhoneIsOpen()) == 'boolean' end) == true end
    found.native = try(function() return type(convaiNative) == 'table' and convaiNative.present == true end) == true
    local api = try(function() return GetMod('ModConfigurationMenuAPI') end)
    found.mcmPresent = api ~= nil
    found.mcm = type(api) == 'table' and api.apiVersion == 2 and api.providers ~= nil
    return found
end

local function serviceCheck(now)
    local status = convaiServiceStatus
    if type(status) ~= 'table' then return {state = 'unknown', code = 'unknown'} end
    local reach = try(function() return status.reach(now) end)
    local down = try(function() return status.unavailable(now) end)
    if reach == 'never' then return {state = 'problem', code = 'never'} end
    if type(down) == 'table' then
        if down.kind == 'starting' then return {state = 'ok', code = 'starting'} end
        if down.kind == 'browser' then return {state = 'problem', code = 'browser-missing'} end
        if down.kind == 'setup' then return {state = 'problem', code = 'missing-key'} end
        if down.kind == 'failed' then
            local code = try(function() return status.failureCode(now) end)
            return {state = 'problem', code = INCOMPLETE[code] and 'incomplete' or 'failed', detail = code}
        end
        return {state = 'problem', code = 'stopped'}
    end
    if reach == 'live' then return {state = 'ok', code = 'running'} end
    return {state = 'unknown', code = 'unknown'}
end

local function filesCheck()
    local missing = {}
    for _, name in ipairs(CATALOGS) do if not exists(name) then missing[#missing + 1] = name end end
    local locales = try(function()
        local count = 0
        for _, entry in ipairs(dir('locales')) do
            if type(entry) == 'table' and type(entry.name) == 'string' and entry.name:match('%.lua$') then count = count + 1 end
        end
        return count
    end)
    if type(locales) ~= 'number' or locales == 0 then
        if not exists('locales/de.lua') then missing[#missing + 1] = 'locales' end
    elseif locales < LOCALE_COUNT then
        missing[#missing + 1] = 'locales'
    end
    local release = readJson('release.json')
    local scripts = release and text(release.version, 30) or nil
    if #missing > 0 then return {state = 'problem', code = 'missing', detail = table.concat(missing, ', '), version = scripts} end
    return {state = 'ok', code = 'found', version = scripts}
end

-- Every game-side check, by id. Cheap enough to run on demand; never called per frame.
function M.run(now)
    now = now or os.time()
    local found = frameworks()
    local checks = {}
    checks.service = serviceCheck(now)
    checks.files = filesCheck()
    local version = text(try(function() return Game.GetSystemRequestsHandler():GetGameVersion() end), 30)
    if not version then checks.game = {state = 'unknown', code = 'unknown'}
    elseif version == TESTED_GAME or version:sub(1, #TESTED_GAME + 1) == TESTED_GAME .. ' ' or version:sub(1, #TESTED_GAME + 1) == TESTED_GAME .. '.' then
        checks.game = {state = 'ok', code = 'tested', version = version}
    else checks.game = {state = 'note', code = 'untested', version = version} end
    checks.cet = {state = found.cet and 'ok' or 'unknown', code = found.cet and 'found' or 'unknown', version = found.cet}
    -- This mod's scripts import Codeware and Audioware, so scripts that loaded prove both are there (their own probe may not be).
    local scripts = found.redscript
    local function framework(present, version)
        if present then return {state = 'ok', code = 'found', version = version} end
        if scripts == true then return {state = 'ok', code = 'implied'} end
        return {state = 'problem', code = 'missing'}
    end
    checks.codeware = framework(found.codeware, found.codewareVersion)
    checks.audioware = framework(found.audioware, found.audiowareVersion)
    checks.tweakxl = found.tweakxl and {state = 'ok', code = 'found', version = found.tweakxlVersion} or {state = 'problem', code = 'missing'}
    if scripts == true then checks.redscript = {state = 'ok', code = 'loaded'}
    elseif scripts == false then checks.redscript = {state = 'problem', code = 'missing'}
    else checks.redscript = {state = 'unknown', code = 'unknown'} end
    -- RED4ext loads Codeware, TweakXL, Audioware and this mod's native plugin; any one of them that answers proves it.
    local red4ext = found.native or found.codeware or found.tweakxl or found.audioware or scripts == true
    checks.red4ext = red4ext and {state = 'ok', code = 'loaded'} or {state = 'problem', code = 'missing'}
    if found.mcm then checks.mcm = {state = 'ok', code = 'found'}
    else checks.mcm = {state = 'problem', code = found.mcmPresent and 'old' or 'missing'} end
    game = {checks = checks, at = now}
    -- The service's answer, when it is of this game session.
    local answer = readJson(RESULT)
    if type(answer) == 'table' and answer.version == 1 and type(answer.checks) == 'table' and type(answer.updated) == 'number'
        and answer.updated >= (loadedAt - SESSION_WINDOW_S) * 1000.0 then
        bridge = answer
    end
    return checks
end

------------------------------------------------------------------ service side

local function bridgeCheck(id)
    if type(bridge) ~= 'table' then return nil end
    for _, check in ipairs(bridge.checks) do
        if type(check) == 'table' and check.id == id then return check end
    end
    return nil
end

local function names(list, field, limit)
    local out = {}
    if type(list) ~= 'table' then return out end
    for _, item in ipairs(list) do
        local value = type(item) == 'table' and field and item[field] or item
        value = text(value, 80)
        if value then out[#out + 1] = value end
        if #out >= (limit or 6) then break end
    end
    return out
end

------------------------------------------------------------------ lines

local VALUE = {ok = 'OK', problem = 'Problem', note = 'Note', unknown = 'Unknown'}

-- One line: id, label (already translated, or a product name), state, description (already translated).
local function line(id, label, state, description, value)
    return {id = id, label = label, state = state, value = value or ui.t(VALUE[state] or 'Unknown'), description = description or ''}
end

local function versionText(check)
    if check.version then return ui.t('Version {version}.', {version = check.version}) end
    return ui.t('Found.')
end

-- The conversation service line, for the Help page's existing Conversation service row: nil when its own label and help say it
-- (running, starting, stopped, no browser, no key); otherwise {value, description} for a service that never started or failed.
function M.serviceLine()
    local check = game and game.checks.service
    if not check then return nil end
    if check.code == 'never' then
        return {value = ui.t('Not running'), description = ui.t('No sign of the conversation service in this session: the Runtime is missing or did not load. Extract the Runtime zip straight into the Cyberpunk 2077 folder (not into a new folder), check that red4ext/plugins/AiNpcCyberpunkMod is there, then restart the game.')}
    end
    if check.code == 'incomplete' then
        return {value = ui.t('Not running'), description = ui.t('The Runtime is incomplete ({code}). Download it again and extract it into the Cyberpunk 2077 folder, then restart the game.', {code = check.detail or '?'})}
    end
    if check.code == 'failed' then
        return {value = ui.t('Not running'), description = ui.t('The conversation service could not start ({code}). Restart the game. If it happens again, generate a report below and send it.', {code = check.detail or '?'})}
    end
    return nil
end

local GAME_ORDER = {'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'tweakxl', 'audioware', 'mcm'}
local PRODUCT = {cet = 'Cyber Engine Tweaks', red4ext = 'RED4ext', redscript = 'redscript', codeware = 'Codeware', tweakxl = 'TweakXL',
    audioware = 'Audioware', mcm = 'Mod Configuration Menu'}

local function gameLine(id, check)
    local label = PRODUCT[id]
    if id == 'files' then
        label = ui.t('Mod files')
        if check.state == 'problem' then
            return line(id, label, 'problem', ui.t('Missing: {files}. Extract the Scripts zip into the Cyberpunk 2077 folder again and let it replace the files.', {files = check.detail or '?'}))
        end
        return line(id, label, 'ok', ui.t('All files found.'))
    end
    if id == 'game' then
        label = ui.t('Game version')
        if check.state == 'ok' then return line(id, label, 'ok', ui.t('Version {version}.', {version = check.version})) end
        if check.state == 'note' then
            return line(id, label, 'note', ui.t('Version {version}. The mod is tested on 2.31 only, so some things may not work.', {version = check.version}))
        end
        return line(id, label, 'unknown', ui.t('The game version could not be read.'))
    end
    if check.state == 'ok' then
        if id == 'red4ext' or id == 'redscript' then return line(id, label, 'ok', ui.t('Loaded.')) end
        return line(id, label, 'ok', versionText(check))
    end
    if check.state == 'unknown' then return line(id, label, 'unknown', '') end
    if id == 'red4ext' then
        return line(id, label, 'problem', ui.t('RED4ext is not loaded. Install it from Nexus Mods, then restart the game. It also starts the conversation service.'))
    end
    if id == 'redscript' then
        return line(id, label, 'problem', ui.t('This mod’s scripts did not load. Install redscript from Nexus Mods. If it is installed, its log redscript_rCURRENT.log in the r6/logs folder names the error.'))
    end
    return line(id, label, 'problem', ui.t('{name} is missing. Install it from Nexus Mods, then restart the game.', {name = label}))
end

local function bridgeLines(out)
    local versions = bridgeCheck('versions')
    if versions and (versions.code == 'match' or versions.code == 'mismatch') then
        local values = {scripts = text(versions.scripts, 30) or '?', runtime = text(versions.runtime, 30) or '?'}
        out[#out + 1] = versions.code == 'mismatch'
            and line('versions', ui.t('Scripts and Runtime'), 'problem', ui.t('Scripts {scripts} and Runtime {runtime} do not match. Download both for the same version and extract them into the Cyberpunk 2077 folder.', values))
            or line('versions', ui.t('Scripts and Runtime'), 'ok', ui.t('Scripts {scripts} and Runtime {runtime}.', values))
    end
    local packs = bridgeCheck('packs')
    if packs then
        local label = ui.t('Optional packs')
        local found = names(packs.found)
        local moved = names(packs.moved, 'pack')
        if packs.code == 'nested' and type(packs.nested) == 'table' and type(packs.nested[1]) == 'table' then
            local first = packs.nested[1]
            out[#out + 1] = line('packs', label, 'problem', ui.t('{packs} is one folder too deep, in {folder}. Move the red4ext folder inside it into the Cyberpunk 2077 folder, then restart the game.',
                {packs = text(first.pack, 40) or '?', folder = text(first.folder, 120) or '?'}))
        elseif packs.code == 'conflict' then
            out[#out + 1] = line('packs', label, 'problem', ui.t('Some pack files could not be moved into place because different files are already there. Extract the pack into the Cyberpunk 2077 folder again and let it replace the files.'))
        else
            local description = #found > 0 and ui.t('Found: {list}.', {list = table.concat(found, ', ')}) or ui.t('None installed. They are optional.')
            if #moved > 0 and type(packs.moved[1]) == 'table' then
                description = description .. '\n' .. ui.t('Moved into place from {folder}: {packs}.', {folder = text(packs.moved[1].from, 120) or '?', packs = table.concat(moved, ', ')})
            end
            out[#out + 1] = line('packs', label, 'ok', description)
        end
    end
    local browser = bridgeCheck('browser')
    if browser and browser.code == 'found' then
        out[#out + 1] = line('browser', ui.t('Browser'), 'ok', ui.t('Found: {list}.', {list = text(browser.name, 60) or '?'}))
    elseif browser and browser.code == 'missing' then
        out[#out + 1] = line('browser', ui.t('Browser'), 'problem', ui.t('The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, then restart the game.'))
    end
    local localAi = bridgeCheck('local-ai')
    if localAi and type(localAi.code) == 'string' then
        local label, code = ui.t('Local AI'), localAi.code
        if code == 'not-used' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Not your conversation provider. Choose it in Settings > Conversation provider.'), ui.t('Not used'))
        elseif code == 'ready' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Local AI is ready.'))
        elseif code == 'warming' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Local AI is warming up…'))
        elseif code == 'not-installed' then out[#out + 1] = line('local-ai', label, 'problem', ui.t('No Local AI pack found. Download one from the mod’s Hugging Face page and extract it into the Cyberpunk 2077 folder, or choose another conversation provider.'))
        elseif code == 'no-memory' then out[#out + 1] = line('local-ai', label, 'problem', ui.t('Not enough graphics memory for Local AI. A cloud provider is used instead.'))
        elseif code == 'mature-off' then out[#out + 1] = line('local-ai', label, 'problem', ui.t('Only Mature models found. Turn on Mature content to use them.'))
        elseif code == 'no-gpu' then out[#out + 1] = line('local-ai', label, 'problem', ui.t('Local AI found no graphics card it can use. It needs an NVIDIA or AMD card with a current driver. Update the driver, or choose another conversation provider.'))
        else out[#out + 1] = line('local-ai', label, 'problem', ui.t('Local AI could not start. Generate a report below and send it, or choose another conversation provider.')) end
    end
    local internet = bridgeCheck('internet')
    if internet and type(internet.code) == 'string' and internet.code ~= 'unknown' then
        local label, host = ui.t('Internet'), text(internet.host, 80) or '?'
        if internet.code == 'not-needed' then out[#out + 1] = line('internet', label, 'ok', ui.t('Not needed: Local AI and the voice run on this PC.'))
        elseif internet.code == 'reachable' then out[#out + 1] = line('internet', label, 'ok', ui.t('Reached {host}.', {host = host}))
        elseif internet.code == 'no-dns' then out[#out + 1] = line('internet', label, 'problem', ui.t('This PC cannot look up {host}. Check your internet connection, then restart the game.', {host = host}))
        else out[#out + 1] = line('internet', label, 'problem', ui.t('The conversation service cannot reach {host}. Allow Node.js through your firewall or antivirus (Windows asks once; choose Allow), check your internet, then restart the game.', {host = host})) end
    end
    local gpu = bridgeCheck('gpu')
    if gpu and gpu.code == 'found' and text(gpu.name, 80) then
        local size = gigabytes(gpu.memoryMiB)
        out[#out + 1] = line('gpu', ui.t('Graphics card'), 'ok', size and ui.t('{name}, {memory} GB of video memory.', {name = text(gpu.name, 80), memory = size})
            or ui.t('Found: {list}.', {list = text(gpu.name, 80)}))
    end
    local manager = bridgeCheck('mod-manager')
    if manager and type(manager.code) == 'string' then
        local label = ui.t('Mod manager')
        if manager.code == 'mo2' then out[#out + 1] = line('mod-manager', label, 'note', ui.t('Mod Organizer 2. Files the mod creates go to its Overwrite folder; leave them there. Mention Mod Organizer 2 when you send a report.'))
        elseif manager.code == 'vortex' then out[#out + 1] = line('mod-manager', label, 'note', ui.t('Vortex. Install the Runtime and the optional packs by hand into the Cyberpunk 2077 folder, as the install steps say.'))
        else out[#out + 1] = line('mod-manager', label, 'ok', ui.t('None found: installed by hand.')) end
    end
end

-- The Help page's setup lines after the Conversation service row (which mod/mcm.lua builds): {id, label, value, description, state}.
-- From the last results only; the first call of a session runs the game-side checks.
function M.lines()
    if not game then M.run() end
    local out = {}
    -- The versions line belongs next to the service: it is the commonest Runtime mistake after a missing one.
    local service = {}
    bridgeLines(service)
    if service[1] and service[1].id == 'versions' then out[#out + 1] = table.remove(service, 1) end
    for _, id in ipairs(GAME_ORDER) do
        local check = game.checks[id]
        if check then out[#out + 1] = gameLine(id, check) end
    end
    for _, item in ipairs(service) do out[#out + 1] = item end
    return out
end

-- How many lines say Problem (the service line included), for the section's description.
function M.problemCount()
    if not game then M.run() end
    local count = game.checks.service and game.checks.service.state == 'problem' and 1 or 0
    for _, item in ipairs(M.lines()) do if item.state == 'problem' then count = count + 1 end end
    return count
end

-- Changes when what the page shows changes (the game-side results or a new service answer).
function M.signature() return content end

local function contentOf()
    local parts = {}
    if game then
        for _, id in ipairs(CRITICAL) do
            local check = game.checks[id]
            if check then parts[#parts + 1] = id .. '=' .. tostring(check.state) .. ':' .. tostring(check.code) end
        end
    end
    parts[#parts + 1] = 'bridge=' .. tostring(bridge and bridge.updated or '')
    return table.concat(parts, '|')
end

------------------------------------------------------------------ the request

local function serviceLive()
    local status = convaiServiceStatus
    return type(status) == 'table' and try(function() return status.reach(os.time()) end) == 'live'
end

-- The Help page opened: run the game-side checks on the next tick and ask a running service to check again (the internet check is
-- only meaningful now). The request file is shipped empty and rewritten in place (Mod Organizer 2, docs/PACKAGING.md).
function M.refresh() refreshDue = true end

local function request(now)
    if not serviceLive() then return false end
    counter = counter + 1
    local id = 's' .. now .. '-' .. counter
    local written = try(function()
        local file = io.open(REQUEST, 'wb')
        if not file then return false end
        local ok = file:write(json.encode({version = 1, id = id, issuedAt = now * 1000}))
        file:close()
        return ok ~= nil and ok ~= false
    end)
    if written then pending = {id = id, untilAt = now + FOLLOW_S, nextAt = now + 1} end
    return written == true
end

local function follow(now)
    if not pending then return end
    if now > pending.untilAt then pending = nil; return end
    if now < pending.nextAt then return end
    pending.nextAt = now + 1
    local answer = readJson(RESULT)
    if type(answer) == 'table' and answer.version == 1 and answer.request == pending.id and type(answer.checks) == 'table' then
        bridge, pending = answer, nil
    end
end

------------------------------------------------------------------ first load

local function shortText(id)
    if id == 'red4ext' then return ui.t('RED4ext is not loaded, so this mod cannot start. Install RED4ext, then restart the game.') end
    if id == 'redscript' then return ui.t('This mod’s scripts did not load. Install redscript, then restart the game.') end
    if id == 'mcm' then return ui.t('Install Mod Configuration Menu from Nexus Mods to open the Companion Manager.') end
    if id == 'files' then return ui.t('Some of this mod’s files are missing. Extract the Scripts zip again. See Help in Settings.') end
    if id == 'service' then return ui.t('The conversation service did not start. Is the Runtime installed? See Help in Settings.') end
    if id == 'versions' then return ui.t('The Scripts and Runtime versions do not match. Install the same version of both.') end
    if id == 'packs' then return ui.t('A pack is one folder too deep. See Help in Settings.') end
    if id == 'internet' then return ui.t('The conversation service cannot reach the internet. See Help in Settings.') end
    return ui.t('{name} is missing. Install it from Nexus Mods, then restart the game.', {name = PRODUCT[id] or id})
end

-- The critical problems, most fundamental first, as ids. A service that failed has its own notice (service-status.lua notice(),
-- 'service-down'), so only one that never started counts here; Local AI has its own fallback notices.
function M.problems()
    if not game then M.run() end
    local list = {}
    for _, id in ipairs(CRITICAL) do
        local check = game.checks[id]
        if check and check.state == 'problem' and (id ~= 'service' or check.code == 'never') then list[#list + 1] = id end
        if not check then
            local answer = bridgeCheck(id)
            if answer and answer.state == 'problem' then list[#list + 1] = id end
        end
    end
    return list
end

-- The notice of the first load, once per game session: the first critical problem, and Mod Configuration Menu's on a second line
-- when it is missing too (without it the Help page cannot open at all). nil when nothing critical is wrong.
local function firstLoad()
    local problems = M.problems()
    if #problems == 0 then
        appendLog('Setup check: no critical problem')
        return nil
    end
    appendLog('Setup check: problems: ' .. table.concat(problems, ', '))
    local mcmMissing = false
    for _, id in ipairs(problems) do if id == 'mcm' then mcmMissing = true end end
    if mcmMissing then
        -- The Help page cannot show this, so the CET console and probe.log say it too, in English for the report.
        print('[AiNpcCyberpunkMod] ' .. MCM_CONSOLE)
        appendLog(MCM_CONSOLE)
    end
    local text = shortText(problems[1])
    if mcmMissing and problems[1] ~= 'mcm' then text = text .. '\n' .. shortText('mcm') end
    return text
end

-- Gameplay on screen, asked without this mod's scripts (init.lua's worldReady needs one of their methods, so it is never true when
-- they did not load). Read only on that path, once per tick while the notice waits.
local function playable()
    return try(function()
        local requests = Game.GetSystemRequestsHandler()
        if requests:IsPreGame() or requests:IsGamePaused() then return false end
        local defs = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) ~= true
    end) == true
end

local held   -- the first-load notice, computed when due and kept until gameplay can show it

-- Call from mcm.lua's slow update (every quarter second, with or without Mod Configuration Menu). inSession: V is in a loaded game
-- (the caller's player). Returns the first-load notice once, in gameplay, else nil.
function M.tick(worldReady, inSession)
    local now = os.time()
    if refreshDue then
        refreshDue = false
        M.run(now)
        request(now)
    end
    follow(now)
    local notice
    if not firstDone and (worldReady or inSession) then
        if not firstDue then firstDue = now + FIRST_DELAY_S
        elseif now >= firstDue then
            firstDone = true
            M.run(now)
            held = firstLoad()
        end
    end
    if held and (worldReady or (game and game.checks.redscript.state == 'problem' and playable())) then
        notice, held = held, nil
    end
    content = contentOf()
    return notice
end

------------------------------------------------------------------ reports

-- Plain lines for the short report (support-report.lua): ids and codes, no translation.
function M.reportLines()
    if not game then M.run() end
    local out = {}
    for _, id in ipairs({'service', 'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'tweakxl', 'audioware', 'mcm'}) do
        local check = game.checks[id]
        if check then
            out[#out + 1] = string.format('%s: %s %s%s%s', id, tostring(check.state), tostring(check.code),
                check.version and (' ' .. check.version) or '', check.detail and (' (' .. check.detail .. ')') or '')
        end
    end
    if type(bridge) == 'table' then
        for _, check in ipairs(bridge.checks) do
            if type(check) == 'table' and type(check.id) == 'string' then
                local extra = {}
                for _, field in ipairs({'scripts', 'runtime', 'name', 'host', 'service'}) do
                    if text(check[field], 80) then extra[#extra + 1] = field .. '=' .. text(check[field], 80) end
                end
                if type(check.memoryMiB) == 'number' then extra[#extra + 1] = 'memoryMiB=' .. math.floor(check.memoryMiB) end
                local found = names(check.found)
                if #found > 0 then extra[#extra + 1] = 'found=' .. table.concat(found, '+') end
                local nested = names(check.nested, 'folder')
                if #nested > 0 then extra[#extra + 1] = 'nested=' .. table.concat(nested, '+') end
                local managers = names(check.managers)
                if #managers > 0 then extra[#extra + 1] = 'managers=' .. table.concat(managers, '+') end
                out[#out + 1] = string.format('service %s: %s %s%s', check.id, tostring(check.state), tostring(check.code),
                    #extra > 0 and (' ' .. table.concat(extra, ' ')) or '')
            end
        end
    else
        out[#out + 1] = 'service checks: none from this game session'
    end
    return out
end

-- The game-side results for the full report's request (bridge/support-report.mjs copies at most 24 rows).
function M.summary()
    if not game then M.run() end
    local rows = {}
    for _, id in ipairs({'service', 'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'tweakxl', 'audioware', 'mcm'}) do
        local check = game.checks[id]
        if check then rows[#rows + 1] = {id = id, state = check.state, code = check.code, version = check.version or check.detail} end
    end
    return rows
end

-- Tests only.
function M.inspect() return {game = game, bridge = bridge, pending = pending, firstDue = firstDue, firstDone = firstDone, held = held} end

convaiSetupCheck = M
return M
