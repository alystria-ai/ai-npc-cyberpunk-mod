-- Setup check (docs/MANAGER_UI.md, "Setup check"): what the game can see of this mod's installation, and what the conversation
-- service found (runtime/setup-check.json, written by bridge/setup-check.mjs), as one line per check with a one-line fix.
-- Shown first on the Help page (mod/manager-ui.lua), as one notice at the first load when something critical is wrong, and, without
-- Native Settings UI (so without the Help page), as one line in the CET console and probe.log plus that notice.
--
-- Game side (works with no service): the mod's own data files, the game and Cyber Engine Tweaks versions, RED4ext, redscript (this
-- mod's scripts), Codeware, Native Settings UI, and the service's status (service-status.lua). Audioware and TweakXL are not
-- requirements any more (the mod plays every voice through its own audio path and uses no tweaks): they are never probed, never named
-- and never a notice, whether the player has them or not.
-- This mod's scripts compile without Codeware (a compile error would disable every redscript mod), so loaded scripts
-- no longer prove it: PlayerPuppet:ConvaiRequirements (Requirements.reds) names what they were compiled with, and a player
-- without that method has scripts that did not compile or older scripts (told apart by ConvaiPhoneIsOpen, which they have).
-- Service side (only an answer of this game session is shown): the Scripts and Runtime versions, optional packs and packs one folder
-- too deep, the browser, Local AI and why it is down, whether the chosen provider's server can be reached, the graphics card and a
-- mod manager.
--
-- Cost: run() opens five small files and asks CET whether a few classes exist, a few milliseconds. It runs once FIRST_DELAY_S after
-- the first world is ready and once each time the Help page opens, never per frame. tick() is called from manager-ui.lua's quarter-second
-- slow update: a few comparisons, plus one small read a second for at most FOLLOW_S while a request waits for the service.
-- Nothing here touches native game state beyond read-only getters.
if type(convaiSetupCheck) == 'table' and convaiSetupCheck.version == 1 then return convaiSetupCheck end
local ui = (convaiUiLocale or dofile('ui-locale.lua'))
local M = {version = 1}

-- The game versions this mod is built for (docs/GAME_VERSIONS.md): one build per game, made from this source tree. The build's own game is the
-- `game` field of the Scripts' release.json (written by packaging/build-release.mjs --game); a release.json without it (every build before the
-- 2.5 one) and a development checkout are the 2.31 build. nsui is the Native Settings UI version the build was made against.
local BUILDS = {['2.31'] = {nsui = '1.96'}, ['2.5'] = {nsui = '1.97'}}
local DEFAULT_BUILD = '2.31'
local RESULT, REQUEST, PROBE_LOG = 'runtime/setup-check.json', 'runtime/setup-check-request.json', 'runtime/probe.log'
local SESSION_WINDOW_S = 180   -- a service answer written this long before the mod loaded still counts as this session's (service-status.lua)
local FIRST_DELAY_S = 12       -- the first-load check waits this long after the first world is ready: the service has said something by then
local FOLLOW_S = 15            -- how long the Help page follows the request it wrote
local CATALOGS = {'world-knowledge.json', 'manager-characters.json', 'conversation-characters.json', 'phone-contacts.json'}
local LOCALE_COUNT = 15
-- bridge-service.json codes that mean the Runtime's files are missing or incomplete (bridge/bridge-supervisor.mjs, the launcher's
-- start-service.mjs in the packaging folder, native/autostart/CyberpunkConvaiLauncher.c).
local INCOMPLETE = {['install-incomplete'] = true, ['bridge-missing'] = true, ['missing-character-ids'] = true,
    ['launcher-not-configured'] = true, ['launcher-program-missing'] = true, ['launcher-directory-missing'] = true}
-- The order of the game-side lines on the page and in the notice's choice (the first critical problem is the one announced). RED4ext
-- comes first: it is a Problem only when nothing it loads answers (this mod's native plugin, which does not depend on the script
-- compile, and the probe of Codeware), and without it Codeware's scripts never reach the compile. This mod's scripts come next: when they did not load (a compile error anywhere disables every
-- redscript mod), nothing below can be judged from them and the log, not a missing framework, is the thing to read.
local CRITICAL = {'red4ext', 'redscript', 'codeware', 'nsui', 'files', 'service', 'versions', 'packs', 'internet'}
-- The requirements one first-load notice names together (Native Settings UI has its own notice: its name is long and the notice
-- fits two lines), and at most this many names in one notice.
local REQUIREMENT_IDS = {red4ext = true, codeware = true}
local MAX_NAMES = 4
-- Every game-side check, in the order the reports list them.
local GAME_IDS = {'service', 'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'nsui'}
-- The Companion Manager lives in Mod Configuration Menu 0.10.5 or newer (the default) or in Native Settings UI (the alternative): the
-- check keeps its id, 'nsui', and is met by either.
local function nsuiConsole(build)
    return 'AI NPC Cyberpunk Mod: the Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI ' .. build.nsui .. ' or newer, '
        .. 'and neither was found. Install Mod Configuration Menu (https://www.nexusmods.com/cyberpunk2077/mods/31640) or Native Settings UI '
        .. '(https://www.nexusmods.com/cyberpunk2077/mods/3518) from Nexus Mods, then restart the game.'
end
local MCM_OLD_CONSOLE = 'AI NPC Cyberpunk Mod: Mod Configuration Menu is older than 0.10.5, so the Companion Manager cannot open in it. '
    .. 'Update Mod Configuration Menu to 0.10.5 or newer (https://www.nexusmods.com/cyberpunk2077/mods/31640), or install Native Settings UI '
    .. '(https://www.nexusmods.com/cyberpunk2077/mods/3518), then restart the game. The manager works with either.'
local MCM_MIN = {0, 10, 5}
-- The first-load lines for the CET console and probe.log, in English like the one above (a report is read in English).
local function scriptsConsole(build)
    return 'AI NPC Cyberpunk Mod: this mod\'s scripts did not load. Open r6/logs/redscript_rCURRENT.log. '
        .. 'If the error names another mod, that mod is the problem. '
        .. 'Missing or old Codeware or redscript, or a game version other than ' .. build.game .. ', can also cause it.'
end
local COMPILER_CONSOLE = 'AI NPC Cyberpunk Mod: redscript is missing. Install it from Nexus Mods, then restart the game.'
local OLD_CONSOLE = 'AI NPC Cyberpunk Mod: Codeware is too old (it lacks the text input this mod needs). '
    .. 'Update Codeware from Nexus Mods, then restart the game.'
-- The words ConvaiRequirements answers with (r6/scripts/CyberpunkConvai/Requirements.reds).
local TEXT_INPUT, UI = 'codeware-textinput', 'codeware-ui'

local loadedAt = os.time()
local game                -- the last game-side result: {checks = {id -> check}, at}
local bridge              -- the service's answer of this session (decoded runtime/setup-check.json), or nil
local pending             -- {id, untilAt, nextAt} while the Help page waits for the service's answer
local refreshDue = false
local firstDue, firstAsked, firstDone = nil, false, false
local counter, content = 0, ''
local requirementSet      -- what ConvaiRequirements answered: a set of words, false when it did not answer, nil before it was asked
local silent              -- a running service gave no answer to the setup request and has none from this session: it has no setup check
                          -- (a Runtime older than these Scripts); cleared when an answer of this session is read

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

-- The game version as the build table names it: '2.31', and CD Projekt's two-digit minor 2.50 as '2.5' (RED4ext reports 2.5 as 2.5.0). Nil when
-- the text does not start with major.minor.
local function canonicalGame(version)
    local major, minor = tostring(version or ''):match('^%s*(%d+)%.(%d+)')
    if not major then return nil end
    if #minor == 2 and minor:sub(2) == '0' then minor = minor:sub(1, 1) end
    return major .. '.' .. minor
end

-- {game, nsui}: the build these Scripts are (see BUILDS). Read from the files on disk each time it is asked, never per frame.
local function buildOf()
    local release = readJson('release.json')
    local named = release and canonicalGame(text(release.game, 10)) or nil
    local game = named and BUILDS[named] and named or DEFAULT_BUILD
    return {game = game, nsui = BUILDS[game].nsui}
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

-- The page's signature: every game-side result and the service answer's time.
local function contentOf()
    local parts = {}
    if game then
        for _, id in ipairs(GAME_IDS) do
            local check = game.checks[id]
            if check then parts[#parts + 1] = id .. '=' .. tostring(check.state) .. ':' .. tostring(check.code) end
        end
    end
    parts[#parts + 1] = 'bridge=' .. tostring(bridge and bridge.updated or '')
    parts[#parts + 1] = 'silent=' .. tostring(silent == true)
    return table.concat(parts, '|')
end

-- One check of the service's answer by id, or nil (no answer of this session, or no such check).
local function bridgeCheck(id)
    if type(bridge) ~= 'table' then return nil end
    for _, check in ipairs(bridge.checks) do
        if type(check) == 'table' and check.id == id then return check end
    end
    return nil
end

------------------------------------------------------------------ game side


-- ConvaiRequirements (Requirements.reds) as a set of words, or false when the player does not have it: this mod's scripts are
-- absent (they did not compile) or older than the scripts that compile without the frameworks. One short call, never per frame.
local function readRequirements(player)
    local ok, value = pcall(function() return player:ConvaiRequirements() end)
    if not ok or type(value) ~= 'string' then return false end
    local set = {}
    for word in value:lower():gmatch('%S+') do set[word] = true end
    return set
end

-- Each probe is read-only and pcall-wrapped: a framework that is absent leaves its class (and its static Version()) undefined.
local function frameworks()
    local found = {}
    found.cet = text(try(function() return GetVersion() end), 40)
    found.codewareVersion = text(try(function() return Codeware.Version() end), 40)
    found.codeware = found.codewareVersion ~= nil or try(function() return Codeware ~= nil end) == true
    -- This mod's own scripts (r6/scripts/CyberpunkConvai): ConvaiRequirements says they loaded and which frameworks they were
    -- compiled with; scripts of 0.2.1 and older only have ConvaiPhoneIsOpen, which proves they loaded. nil while there is no player
    -- to ask. found.requirements stays nil for old scripts and for none.
    local player = try(function() return Game.GetPlayer() end)
    if player then
        local set = readRequirements(player)
        requirementSet = set
        if set then
            found.requirements, found.redscript = set, true
        else
            found.redscript = try(function() return type(player:ConvaiPhoneIsOpen()) == 'boolean' end) == true
        end
    end
    found.native = try(function() return type(convaiNative) == 'table' and convaiNative.present == true end) == true
    -- Mod Configuration Menu (CET mod "ModConfigurationMenuAPI"), the default host of the Companion Manager: version 0.10.5 or newer,
    -- which has the public UI extension (api.ui, v1) the page is drawn with (mod/mcm-host.lua).
    local mcm = try(function() return GetMod('ModConfigurationMenuAPI') end)
    found.mcmPresent = type(mcm) == 'table'
    found.mcmVersion = found.mcmPresent and text(try(function() return tostring(mcm.version) end), 20) or nil
    if found.mcmPresent then
        local major, minor, patch = tostring(found.mcmVersion or ''):match('^%s*v?(%d+)%.(%d+)%.?(%d*)')
        local numbers = {tonumber(major), tonumber(minor), tonumber(patch) or 0}
        local newEnough = numbers[1] ~= nil
        if newEnough then
            for index = 1, 3 do
                if numbers[index] ~= MCM_MIN[index] then newEnough = numbers[index] > MCM_MIN[index]; break end
            end
        end
        found.mcm = newEnough and type(mcm.providers) == 'table' and type(mcm.ui) == 'table' and mcm.ui.apiVersion == 1
    end
    -- Native Settings UI (CET mod "nativeSettings"), the alternative host: the Companion Manager is a tab of its Mods screen.
    local nsui = try(function() return GetMod('nativeSettings') or GetMod('NativeSettings') end)
    found.nsuiPresent = type(nsui) == 'table'
    found.nsui = found.nsuiPresent and type(nsui.data) == 'table'
    if found.nsui then
        for _, name in ipairs({'addTab', 'addSubcategory', 'removeSubcategory', 'removeOption', 'addSwitch', 'addRangeInt',
            'addSelectorString', 'addButton', 'setOption', 'registerRestoreDefaultsCallback'}) do
            if type(nsui[name]) ~= 'function' then found.nsui = false end
        end
    end
    found.nsuiVersion = found.nsuiPresent and text(try(function() return tostring(nsui.version) end), 20) or nil
    return found
end

-- The service status module (mod/service-status.lua), which init.lua loads first; loaded here when it was not.
local function statusModule()
    local ok, status = pcall(function() return convaiServiceStatus or dofile('service-status.lua') end)
    return ok and type(status) == 'table' and status or nil
end

-- Why nothing in this session started the service, for the report row's detail (2026-10-24 triage: six installs of 0.2.9 reported "service never"
-- and every one had this mod's RED4ext plugin not loaded, so the Runtime was missing or not yet in place). 'plugin-not-loaded': the native plugin,
-- which holds the launcher, did not bind (convaiNative says so, native-core.lua; "Native core: ... (plugin not loaded)" in probe.log). 'no-launcher-trace':
-- the plugin is loaded and still no status file of this session exists, which would be a launcher or supervisor fault. Two reads of a table, no file.
local function neverDetail()
    local native = try(function() return convaiNative end)
    if type(native) == 'table' and native.present == true then return 'no-launcher-trace' end
    return 'plugin-not-loaded'
end

local function serviceCheck(now)
    local status = statusModule()
    if not status then return {state = 'unknown', code = 'unknown'} end
    local reach = try(function() return status.reach(now) end)
    local down = try(function() return status.unavailable(now) end)
    if reach == 'never' then return {state = 'problem', code = 'never', detail = neverDetail()} end
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
    -- The service's answer, when it is of this game session. Read first: the redscript check below uses it.
    local answer = readJson(RESULT)
    if type(answer) == 'table' and answer.version == 1 and type(answer.checks) == 'table' and type(answer.updated) == 'number'
        and answer.updated >= (loadedAt - SESSION_WINDOW_S) * 1000.0 then
        bridge, silent = answer, false
    end
    local checks = {}
    checks.service = serviceCheck(now)
    checks.files = filesCheck()
    local version = text(try(function() return Game.GetSystemRequestsHandler():GetGameVersion() end), 30)
    if not version then checks.game = {state = 'unknown', code = 'unknown'}
    else
        -- Tested: the game is the one this build is made for. Another game version this mod has a build for: the wrong build is installed.
        local build, running = buildOf(), canonicalGame(version)
        if running == build.game then checks.game = {state = 'ok', code = 'tested', version = version}
        elseif running and BUILDS[running] then checks.game = {state = 'problem', code = 'wrong-build', version = version, build = build.game, forGame = running}
        else checks.game = {state = 'note', code = 'untested', version = version, build = build.game} end
    end
    checks.cet = {state = found.cet and 'ok' or 'unknown', code = found.cet and 'found' or 'unknown', version = found.cet}
    local scripts, words = found.redscript, found.requirements
    -- Codeware, the one framework this mod's own scripts are compiled against.
    --   scripts with ConvaiRequirements: the words are the answer (the scripts compile without a missing framework, so loading
    --     no longer proves it). Codeware without its UI or text input parts is too old for this mod.
    --   scripts of 0.2.1 and older (ConvaiPhoneIsOpen only): they imported Codeware, so loading proves it.
    --   scripts that did not load: nothing is known from them, so Codeware is OK when its own probe finds it and Unknown
    --     otherwise (the probes have not been confirmed in a game whose compile failed, and which mod broke the compile is the
    --     redscript log's to say). RED4ext below is the exception: this mod's own native plugin also answers for it.
    --   no player yet: its own probe alone.
    local function framework(id, present, version)
        if words then
            if not words[id] then return {state = 'problem', code = 'missing'} end
            if id == 'codeware' and not (words[UI] and words[TEXT_INPUT]) then
                return {state = 'problem', code = 'old', version = version}
            end
            return {state = 'ok', code = 'found', version = version}
        end
        if present then return {state = 'ok', code = 'found', version = version} end
        if scripts == true and id == 'codeware' then return {state = 'ok', code = 'implied'} end
        if scripts == false then return {state = 'unknown', code = 'unknown'} end
        return {state = 'problem', code = 'missing'}
    end
    checks.codeware = framework('codeware', found.codeware, found.codewareVersion)
    if scripts == true then checks.redscript = {state = 'ok', code = 'loaded'}
    elseif scripts == false then
        -- Scripts that did not load. When the service saw that the compiler's file is not there (bridge/setup-check.mjs, 'compiler') there is no
        -- compile log to read: redscript itself is missing.
        local compiler = bridgeCheck('compiler')
        checks.redscript = {state = 'problem', code = compiler and compiler.code == 'missing' and 'no-compiler' or 'missing'}
    else checks.redscript = {state = 'unknown', code = 'unknown'} end
    -- RED4ext loads Codeware and this mod's native plugin; either one answering proves it, and so do the scripts of 0.2.1 (they
    -- could not load without it) and scripts that were compiled against Codeware. When none answers it is not loaded, also when this
    -- mod's scripts did not load: this mod's native plugin does not depend on the script compile, and a game without RED4ext cannot
    -- compile Codeware's scripts, so RED4ext is then the cause to name, not a mod the redscript log lists.
    local red4ext = found.native or found.codeware
        or (words ~= nil and words.codeware == true) or (scripts == true and words == nil)
    if red4ext then checks.red4ext = {state = 'ok', code = 'loaded'}
    else checks.red4ext = {state = 'problem', code = 'missing'} end
    -- The manager's host: Mod Configuration Menu 0.10.5 or newer first, otherwise Native Settings UI. An older Mod Configuration Menu
    -- with no usable Native Settings UI is its own problem (update it); an old Native Settings UI counts as none.
    if found.mcm then checks.nsui = {state = 'ok', code = 'mcm', version = found.mcmVersion}
    elseif found.nsui then checks.nsui = {state = 'ok', code = 'found', version = found.nsuiVersion}
    elseif found.mcmPresent then checks.nsui = {state = 'problem', code = 'mcm-old', version = found.mcmVersion}
    else checks.nsui = {state = 'problem', code = found.nsuiPresent and 'old' or 'missing'} end
    game = {checks = checks, at = now}
    content = contentOf()
    return checks
end

------------------------------------------------------------------ service side

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

-- The names the setup check sends for the language packs ("Multilingual pack (fr)", bridge/setup-check.mjs) in the menu language; every other pack name is a
-- product name and stays as it is.
local function packName(value)
    if type(value) ~= 'string' then return value end
    local code = value:match('^Multilingual pack %(([%w-]+)%)$')
    if code then return ui.t('Multilingual pack ({code})', {code = code}) end
    code = value:match('^PocketTTS model %(([%w-]+)%)$')
    if code then return ui.t('PocketTTS model ({code})', {code = code}) end
    return value
end

------------------------------------------------------------------ lines

-- Literal ui.t calls, so the catalogue (scripts/Extract-UiCatalog.mjs) lists every state word.
local function stateWord(state)
    if state == 'ok' then return ui.t('OK') end
    if state == 'problem' then return ui.t('Problem') end
    if state == 'note' then return ui.t('Note') end
    return ui.t('Unknown')
end

-- One line: id, label (already translated, or a product name), state, description (already translated).
local function line(id, label, state, description, value)
    return {id = id, label = label, state = state, value = value or stateWord(state), description = description or ''}
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
        return {value = ui.t('Not running'), description = ui.t('No sign of the conversation service in this session: the Runtime is missing or did not load. Extract the Runtime zip straight into the Cyberpunk 2077 folder (not into a new folder), check that red4ext/plugins/AiNpcCyberpunkMod is there, then restart the game. The Runtime is a separate download from the mod’s Hugging Face page; the Nexus page links to it.')}
    end
    -- The launcher found no launcher.ini beside its DLL (a 0.2.3 Vortex report; the launcher from 0.2.4 on starts without it, so this is an
    -- older launcher): the generic sentence below would say "download it again" without saying which file or why.
    if check.code == 'incomplete' and check.detail == 'launcher-not-configured' then
        return {value = ui.t('Not running'), description = ui.t('The settings file of the launcher, launcher.ini, is missing from red4ext/plugins/AiNpcCyberpunkMod, so the game cannot start the conversation service. Extract the Runtime zip straight into the Cyberpunk 2077 folder again (by hand, also with Vortex) and let it replace the files, then restart the game.')}
    end
    if check.code == 'incomplete' then
        return {value = ui.t('Not running'), description = ui.t('The Runtime is incomplete ({code}). Download it again and extract it into the Cyberpunk 2077 folder (or apply the Runtime update zips in order), then restart the game.', {code = check.detail or '?'})}
    end
    if check.code == 'failed' then
        return {value = ui.t('Not running'), description = ui.t('The conversation service could not start ({code}). Restart the game. If it happens again, generate a report below and send it.', {code = check.detail or '?'})}
    end
    return nil
end

local GAME_ORDER = {'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'nsui'}
local PRODUCT = {cet = 'Cyber Engine Tweaks', red4ext = 'RED4ext', redscript = 'redscript', codeware = 'Codeware', nsui = 'Native Settings UI'}

local function gameLine(id, check)
    local label = PRODUCT[id]
    if id == 'nsui' and (check.code == 'mcm' or check.code == 'mcm-old') then label = 'Mod Configuration Menu' end
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
            return line(id, label, 'note', ui.t('Version {version}. The mod is tested on {game} only, so some things may not work.', {version = check.version, game = check.build or DEFAULT_BUILD}))
        end
        if check.state == 'problem' then
            -- The other game's build is installed: the mod names the build to get (the Nexus page and the Hugging Face folder carry both).
            return line(id, label, 'problem', ui.t('Version {version}. These files are the mod build for game {build}. Install the build made for game {game} from the mod’s Nexus Mods page (Scripts) and Hugging Face page (Runtime), then restart the game.', {version = check.version, build = check.build or '?', game = check.forGame or '?'}))
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
    if id == 'redscript' and check.code == 'no-compiler' then
        return line(id, label, 'problem', ui.t('{name} is missing. Install it from Nexus Mods, then restart the game.', {name = label}))
    end
    if id == 'redscript' then
        return line(id, label, 'problem', ui.t('This mod’s scripts did not load. Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem. Missing or old Codeware or redscript, or a game version other than {game}, can also cause it.', {game = buildOf().game}))
    end
    if id == 'nsui' and check.code == 'mcm-old' then
        return line(id, label, 'problem', ui.t('Mod Configuration Menu is too old. Update it to 0.10.5 or newer, or install Native Settings UI, then restart the game.'))
    end
    if id == 'nsui' then
        -- Missing, or a Native Settings UI that is too old: Mod Configuration Menu first, Native Settings UI as the alternative.
        return line(id, label, 'problem', ui.t('The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI {nsui} or newer. Either one is enough. Install one from Nexus Mods, then restart the game.', {nsui = buildOf().nsui}))
    end
    if id == 'codeware' and check.code == 'old' then return line(id, label, 'problem', ui.t('Codeware is too old. Update it from Nexus Mods, then restart the game.')) end
    return line(id, label, 'problem', ui.t('{name} is missing. Install it from Nexus Mods, then restart the game.', {name = label}))
end

-- Which of the two is older when the setup check says they differ: true (the Runtime), false (the Scripts), nil (cannot tell: a version that does not read as numbers). A running
-- service that never answered has no setup check at all (0.2.1 and older), so its Runtime is the older one. The Runtime updates exist from 0.2.3 on, so the page sends a
-- Runtime that is older to its update zips (one by one) or the full Runtime, and a Scripts that is older to Nexus Mods.
local function versionParts(value)
    local parts = {}
    for number in tostring(value or ''):gmatch('%d+') do parts[#parts + 1] = tonumber(number) end
    return #parts > 0 and parts or nil
end

local function runtimeIsOlder(versions)
    if not versions then return silent == true and true or nil end
    local scripts, runtime = versionParts(versions.scripts), versionParts(versions.runtime)
    if not scripts or not runtime then return nil end
    for index = 1, math.max(#scripts, #runtime) do
        local a, b = scripts[index] or 0, runtime[index] or 0
        if b < a then return true end
        if b > a then return false end
    end
    return nil
end

-- Mod Organizer 2 runs the service from the real folder of the Runtime's own mod, so a Runtime update zip (or a multilingual pack) installed as a
-- separate mod is never read: the lines about versions and update steps then say where the files go (docs/PACKAGING.md, "Mod Organizer 2").
local function mo2Hint()
    local manager = bridgeCheck('mod-manager')
    if manager and manager.code == 'mo2' then return '\n' .. ui.t('Mod Organizer 2: extract update zips into the Runtime’s own mod folder, not as new mods.') end
    return ''
end

local function bridgeLines(out)
    local versions = bridgeCheck('versions')
    if versions and versions.code == 'game-mismatch' then
        -- Same version, built for different games: the Runtime is replaced by the one made for the Scripts' game.
        out[#out + 1] = line('versions', ui.t('Scripts and Runtime'), 'problem', ui.t('The Scripts are the build for game {scripts} but the Runtime is the build for game {runtime}. Install the Runtime made for game {scripts} from the mod’s Hugging Face page, then restart the game.', {scripts = text(versions.scriptsGame, 10) or '?', runtime = text(versions.runtimeGame, 10) or '?'}))
    elseif versions and (versions.code == 'match' or versions.code == 'mismatch') then
        local values = {scripts = text(versions.scripts, 30) or '?', runtime = text(versions.runtime, 30) or '?'}
        local older = versions.code == 'mismatch' and runtimeIsOlder(versions)
        out[#out + 1] = versions.code == 'mismatch'
            and line('versions', ui.t('Scripts and Runtime'), 'problem', older
                and ui.t('Scripts {scripts} and Runtime {runtime} do not match: the Runtime is out of date. Apply the Runtime update zips from the updates folder on the mod’s Hugging Face page one by one, starting from your version, or download the full Runtime. Extract each into the Cyberpunk 2077 folder, then restart the game.', values)
                or ui.t('Scripts {scripts} and Runtime {runtime} do not match. Update whichever is older: the Scripts from Nexus Mods, or the Runtime from the mod’s Hugging Face page (its update zips one by one, or the full Runtime). Extract into the Cyberpunk 2077 folder, then restart the game.', values))
            or line('versions', ui.t('Scripts and Runtime'), 'ok', ui.t('Scripts {scripts} and Runtime {runtime}.', values))
    elseif versions and (versions.code == 'chain-gap' or versions.code == 'chain-order') then
        -- The versions agree, but an update step in between was never applied (bridge/runtime-steps.mjs): the files are a mix of releases.
        out[#out + 1] = line('versions', ui.t('Scripts and Runtime'), 'problem', versions.code == 'chain-gap'
            and ui.t('The Runtime update from {from} to {to} was never applied, so some Runtime files are old. Apply the Runtime update zips from the updates folder on the mod’s Hugging Face page one by one, starting from your version. Extract each into the Cyberpunk 2077 folder, then restart the game.', {from = text(versions.from, 30) or '?', to = text(versions.to, 30) or '?'})
            or ui.t('Some Runtime files are from a newer update than this Runtime says. Apply the Runtime update zips from the updates folder on the mod’s Hugging Face page one by one, in order, starting from your version, or extract the full Runtime again. Then restart the game.'))
    elseif not versions and silent then
        -- A running service that never answered: a Runtime from before the setup check existed (0.2.1 and older) cannot say its version.
        out[#out + 1] = line('versions', ui.t('Scripts and Runtime'), 'problem', ui.t('The conversation service did not answer the setup check, so its Runtime is probably older than these Scripts. Download the full Runtime from the mod’s Hugging Face page and extract it into the Cyberpunk 2077 folder, then restart the game.'))
    end
    -- Under Mod Organizer 2 a problem with the versions or the update steps says where update zips go.
    local hint = mo2Hint()
    local last = out[#out]
    if hint ~= '' and last and last.id == 'versions' and last.state == 'problem' then last.description = last.description .. hint end
    local packs = bridgeCheck('packs')
    if packs then
        local label = ui.t('Optional packs')
        local found = names(packs.found)
        local moved = names(packs.moved, 'pack')
        for index, name in ipairs(moved) do moved[index] = packName(name) end
        if packs.code == 'nested' and type(packs.nested) == 'table' and type(packs.nested[1]) == 'table' then
            local first = packs.nested[1]
            out[#out + 1] = line('packs', label, 'problem', ui.t('{packs} is one folder too deep, in {folder}. Restart the game and the mod moves it into place. If it is still there afterwards, move the red4ext folder inside it into the Cyberpunk 2077 folder.',
                {packs = packName(text(first.pack, 40)) or '?', folder = text(first.folder, 120) or '?'}))
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
        out[#out + 1] = line('browser', ui.t('Browser'), 'problem', ui.t('The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file next to launcher.ini, then restart the game.'))
    end
    -- The Pocket voice failed to start (two 0.2.2 players had no voice from V and no way to tell why). Only a failure has a line: a voice that works
    -- needs none. Pocket ships inside the Runtime, so the line says nothing needs installing.
    local voice = bridgeCheck('voice')
    if voice and voice.code == 'pocket-failed' and voice.cause == 'virtual-memory' then
        -- Windows ran out of memory it can promise (error 1455, the paging file is too small): restarting changes nothing, a larger paging file or fewer programs does.
        out[#out + 1] = line('voice', ui.t('Pocket voice'), 'problem', ui.t('Windows ran out of memory for the voice. A larger paging file or closing other apps helps.'))
    elseif voice and voice.code == 'pocket-failed' and voice.cause == 'blocked' then
        -- Windows refused to load a file of the voice (Smart App Control, or an Application Control policy of a company or school): restarting changes nothing.
        out[#out + 1] = line('voice', ui.t('Pocket voice'), 'problem', ui.t('Windows blocked a file that the Pocket voice needs (Smart App Control or an Application Control policy), so Pocket cannot run on this PC. Choose another voice in Settings, such as OmniVoice or a cloud voice.'))
    elseif voice and voice.code == 'pocket-failed' then
        out[#out + 1] = line('voice', ui.t('Pocket voice'), 'problem', ui.t('The Pocket voice (V’s voice, and a companion’s when you chose Pocket) could not start, so it stays silent. Pocket is part of the Runtime: nothing else needs installing. Restart the game. If it happens again, generate a report below and send it.'))
    end
    -- A Local AI or Mature pack that is one folder too deep is "not installed" to Local AI until the launcher moves it. The packs line above says
    -- where it is, so a second line telling the player to download a pack they already have is left out.
    local nestedLocalAi = false
    if packs and packs.code == 'nested' and type(packs.nested) == 'table' then
        for _, item in ipairs(packs.nested) do
            local pack = type(item) == 'table' and text(item.pack, 40) or ''
            if pack:match('^Local AI') or pack:match('^Mature') then nestedLocalAi = true end
        end
    end
    local localAi = bridgeCheck('local-ai')
    if localAi and type(localAi.code) == 'string' then
        local label, code = ui.t('Local AI'), localAi.code
        if code == 'not-used' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Not your conversation provider. Choose it in Settings > Conversation provider.'), ui.t('Not used'))
        elseif code == 'ready' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Local AI is ready.'))
        elseif code == 'warming' then out[#out + 1] = line('local-ai', label, 'ok', ui.t('Local AI is warming up…'))
        elseif code == 'not-installed' then
            if not nestedLocalAi then
                out[#out + 1] = line('local-ai', label, 'problem', ui.t('No Local AI pack found. Download one from the mod’s Hugging Face page and extract it into the Cyberpunk 2077 folder, or choose another conversation provider.'))
            end
        elseif code == 'no-memory' then out[#out + 1] = line('local-ai', label, 'problem', ui.t('Not enough free graphics memory to start Local AI. Try a smaller model in Settings.'))
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
        if manager.code == 'mo2' then out[#out + 1] = line('mod-manager', label, 'note', ui.t('Mod Organizer 2. Files the mod creates go to its Overwrite folder; leave them there. Extract Runtime update zips and multilingual packs into the Runtime’s own mod folder, not as new mods. Mention Mod Organizer 2 when you send a report.'))
        elseif manager.code == 'vortex' then out[#out + 1] = line('mod-manager', label, 'note', ui.t('Vortex. Install the Runtime and the optional packs by hand into the Cyberpunk 2077 folder, as the install steps say.'))
        else out[#out + 1] = line('mod-manager', label, 'ok', ui.t('None found: installed by hand.')) end
    end
end

-- The Help page's setup lines after the Conversation service row (which mod/manager-ui.lua builds): {id, label, value, description, state}.
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

-- Changes when what the page shows changes (the game-side results or a new service answer). Built when a result arrives, never in tick().
function M.signature() return content end

------------------------------------------------------------------ the request

local function serviceLive()
    local status = statusModule()
    return status ~= nil and try(function() return status.reach(os.time()) end) == 'live'
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
    if now > pending.untilAt then
        -- Asked of a running service, no answer, and none earlier this session: it has no setup check (a Runtime older than these
        -- Scripts). Not claimed when the service has stopped since: that has its own notice.
        if not bridge and serviceLive() then silent = true; content = contentOf() end
        pending = nil
        return
    end
    if now < pending.nextAt then return end
    pending.nextAt = now + 1
    local answer = readJson(RESULT)
    if type(answer) == 'table' and answer.version == 1 and answer.request == pending.id and type(answer.checks) == 'table' then
        bridge, pending, silent = answer, nil, false
        content = contentOf()
    end
end

------------------------------------------------------------------ first load

-- Every sentence of the first-load notice is in this one function (bridge/setup-notice-fit.test.mjs measures each against the warning
-- line). id 'redscript': this mod's scripts did not load. id 'requirements': names is the list of two or more requirement names
-- (old: one of them is installed but too old). id 'codeware-old': Codeware
-- without the parts this mod needs. Any other id: one check,
-- named by PRODUCT or, for an id that has no entry, by `names`.
local function shortText(id, names, old)
    if id == 'redscript' then return ui.t('Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.') end
    if id == 'requirements' then
        if old then return ui.t('Install or update: {names}. Then restart the game.', {names = names}) end
        return ui.t('Missing: {names}. Install them and restart the game.', {names = names})
    end
    if id == 'codeware-old' then return ui.t('Codeware is too old. Update it from Nexus Mods, then restart the game.') end
    if id == 'nsui' then return ui.t('The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI') end
    if id == 'mcm-old' then return ui.t('Update Mod Configuration Menu to 0.10.5 or newer, or install Native Settings UI') end
    if id == 'files' then return ui.t('Some mod files are missing. Extract the Scripts zip again. See Help in Settings.') end
    if id == 'service' then return ui.t('The conversation service did not start. Is the Runtime installed? See Help in Settings.') end
    if id == 'versions-old' then return ui.t('The Runtime is out of date. Apply its update zips one by one, or get the full Runtime.') end
    if id == 'versions-steps' then return ui.t('A Runtime update step is missing. Apply its update zips one by one from the updates folder.') end
    if id == 'versions' then return ui.t('The Scripts and Runtime do not match. Update whichever is older. See Help in Settings.') end
    if id == 'packs' then return ui.t('A pack is one folder too deep. See Help in Settings.') end
    if id == 'internet' then return ui.t('The conversation service cannot reach the internet. See Help in Settings.') end
    return ui.t('{name} is missing. Install it from Nexus Mods, then restart the game.', {name = PRODUCT[id] or names or id})
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
            if answer and answer.state == 'problem' then list[#list + 1] = id
            elseif id == 'versions' and not answer and silent then list[#list + 1] = id end
        end
    end
    return list
end

-- One line to the CET console and probe.log.
local function say(text)
    print('[AiNpcCyberpunkMod] ' .. text)
    appendLog(text)
end

-- The notice of the first load, once per game session: the first critical problem, one short text of at most two lines (the warning
-- line's frame, docs/NOTIFICATIONS.md); the others are in the log and on the Help page. nil when nothing critical is wrong. The order
-- of CRITICAL puts everything that stops the mod, and Native Settings UI, before the checks that need the Help page, so the text
-- never sends the player to a page they cannot open.
-- RED4ext that is not loaded comes first (it is also why scripts that need Codeware cannot compile). Otherwise scripts that did not load
-- come first and alone: no framework is blamed while the compile error is unread. Missing requirements (RED4ext, Codeware)
-- are one notice naming them all, up to MAX_NAMES; Native Settings UI has its own.
local function firstLoad()
    local problems = M.problems()
    -- The automatic error reports (mod/error-reports.lua): the game-side versions and the problems the game found, once per session.
    if convaiErrorReports then pcall(convaiErrorReports.noteSetup, problems, game and game.checks) end
    if #problems == 0 then
        appendLog('Setup check: no critical problem')
        return nil
    end
    appendLog('Setup check: problems: ' .. table.concat(problems, ', '))
    -- The Help page cannot show these (or the scripts that build it did not load), so the CET console and probe.log say them too,
    -- in English for the report, one line each.
    for _, id in ipairs(problems) do
        local check = game.checks[id]
        if id == 'redscript' then say(check and check.code == 'no-compiler' and COMPILER_CONSOLE or scriptsConsole(buildOf()))
        elseif id == 'nsui' then say(check and check.code == 'mcm-old' and MCM_OLD_CONSOLE or nsuiConsole(buildOf()))
        elseif id == 'codeware' and check and check.code == 'old' then say(OLD_CONSOLE)
        elseif REQUIREMENT_IDS[id] then
            say('AI NPC Cyberpunk Mod: ' .. (PRODUCT[id] or id) .. ' is missing. Install it from Nexus Mods, then restart the game.')
        end
    end
    local first = problems[1]
    if REQUIREMENT_IDS[first] then
        local named, old = {}, false
        for _, id in ipairs(problems) do
            if REQUIREMENT_IDS[id] and #named < MAX_NAMES then
                named[#named + 1] = PRODUCT[id] or id
                if id == 'codeware' and game.checks[id].code == 'old' then old = true end
            end
        end
        if #named > 1 then return shortText('requirements', table.concat(named, ', '), old) end
        if first == 'codeware' and game.checks.codeware.code == 'old' then return shortText('codeware-old') end
    end
    -- redscript itself is missing: the sentence of any missing requirement, with its name (there is no compile log to open)
    if first == 'redscript' and game.checks.redscript.code == 'no-compiler' then return shortText('compiler', PRODUCT.redscript) end
    if first == 'nsui' and game.checks.nsui.code == 'mcm-old' then return shortText('mcm-old') end
    -- Scripts and Runtime of different versions: a Runtime that is the older one (nearly every report) is told to apply its update zips or take the full Runtime. A Runtime that never
    -- answered (0.2.1 and older: no update zips exist for it) has no versions to compare: it gets the generic notice, and the Help line tells it to get the full Runtime.
    local versions = bridgeCheck('versions')
    if first == 'versions' and versions ~= nil and runtimeIsOlder(versions) == true then return shortText('versions-old') end
    -- The versions agree but an update step was skipped (bridge/runtime-steps.mjs).
    if first == 'versions' and versions ~= nil and (versions.code == 'chain-gap' or versions.code == 'chain-order') then return shortText('versions-steps') end
    return shortText(first)
end

-- Whether a requirement was in place when this mod's scripts compiled (Requirements.reds): true or false, or nil when that is not
-- known (no player yet, or scripts of 0.2.1 and older). Other modules ask it before a feature that needs Codeware and
-- on a refused action, never per frame: the answer is read once and kept (it cannot change before the next game start).
-- word: 'codeware', 'codeware-ui' or 'codeware-textinput'. player: the caller's, when it has one.
function M.requirement(word, player)
    if requirementSet == nil then
        player = player or try(function() return Game.GetPlayer() end)
        if not player then return nil end
        requirementSet = readRequirements(player)
    end
    if requirementSet == false then return nil end
    return requirementSet[word] == true
end

-- The sentence for a player whose action needs Codeware and cannot have it (the text box, the Chat tab): the missing or old
-- Codeware, from what the scripts were compiled with; nil when that is known to be fine or not known.
function M.codewareNotice()
    if M.requirement('codeware') == false then return shortText('codeware') end
    if M.requirement(TEXT_INPUT) == false or M.requirement(UI) == false then return shortText('codeware-old') end
    return nil
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

-- Call from manager-ui.lua's slow update (every quarter second, with or without Native Settings UI). inSession: V is in a loaded game
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
            if not firstAsked then
                -- Once per session: the game-side checks, and the service's full answer (it holds the internet test, which the
                -- service does not run on its own). Nothing is asked of a service that is not running.
                firstAsked = true
                M.run(now)
                request(now)
            end
            -- The notice is decided when that answer has come, or after FOLLOW_S without one.
            if not pending then
                firstDone = true
                M.run(now)
                held = firstLoad()
            end
        end
    end
    if held and (worldReady or (game and game.checks.redscript.state == 'problem' and playable())) then
        notice, held = held, nil
    end
    return notice
end

------------------------------------------------------------------ reports

-- Plain lines for the short report (support-report.lua): ids and codes, no translation.
function M.reportLines()
    if not game then M.run() end
    local out = {}
    for _, id in ipairs(GAME_IDS) do
        local check = game.checks[id]
        if check then
            out[#out + 1] = string.format('%s: %s %s%s%s', id, tostring(check.state), tostring(check.code),
                check.version and (' ' .. check.version) or '', check.detail and (' (' .. check.detail .. ')') or '')
        end
    end
    -- What the scripts were compiled with (Requirements.reds): the words, or none of them.
    if type(requirementSet) == 'table' then
        local words = {}
        for word in pairs(requirementSet) do words[#words + 1] = word end
        table.sort(words)
        out[#out + 1] = 'scripts compiled with: ' .. (#words > 0 and table.concat(words, ' ') or 'no Codeware')
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
        out[#out + 1] = silent and 'service checks: none, and the running service did not answer the request (a Runtime older than these Scripts?)'
            or 'service checks: none from this game session'
    end
    return out
end

-- The game-side results for the full report's request (bridge/support-report.mjs copies at most 24 rows).
function M.summary()
    if not game then M.run() end
    local rows = {}
    for _, id in ipairs(GAME_IDS) do
        local check = game.checks[id]
        if check then rows[#rows + 1] = {id = id, state = check.state, code = check.code, version = check.version or check.detail} end
    end
    return rows
end

-- Tests only.
function M.inspect() return {game = game, bridge = bridge, pending = pending, firstDue = firstDue, firstDone = firstDone, held = held} end

convaiSetupCheck = M
return M
