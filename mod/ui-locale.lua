-- Interface strings only. Call update(delta) once from the top-level CET
-- update, including while menus are open. Native callbacks may call configure,
-- t and the selectors below: none of them reads native state or the filesystem.
-- Repeated dofile calls in this mod share one resolved language/dictionary.
if type(convaiUiLocale) == 'table' and convaiUiLocale.version == 1 then return convaiUiLocale end

local M = {version = 1}
local INTERVAL = 2
local languages = {
    {value = 'en', label = 'English'},
    {value = 'zh-cn', label = '简体中文'},
    {value = 'zh-tw', label = '繁體中文'},
    {value = 'es', label = 'Español'},
    {value = 'pt-br', label = 'Português (Brasil)'},
    {value = 'fr', label = 'Français'},
    {value = 'de', label = 'Deutsch'},
    {value = 'it', label = 'Italiano'},
    {value = 'pl', label = 'Polski'},
    {value = 'cs', label = 'Čeština'},
    {value = 'hu', label = 'Magyar'},
    {value = 'tr', label = 'Türkçe'},
    {value = 'ru', label = 'Русский'},
    {value = 'uk', label = 'Українська'},
    {value = 'ja', label = '日本語'},
    {value = 'ko', label = '한국어'},
}
local supported = {}
for _, language in ipairs(languages) do supported[language.value] = true end

local aliases = {
    ['en-us'] = 'en', ['en-gb'] = 'en',
    ['zh'] = 'zh-cn', ['zh-hans'] = 'zh-cn', ['zh-hans-cn'] = 'zh-cn', ['zh-sg'] = 'zh-cn',
    ['zh-hant'] = 'zh-tw', ['zh-hant-tw'] = 'zh-tw', ['zh-hk'] = 'zh-tw',
    ['es-es'] = 'es', ['es-mx'] = 'es', ['es-419'] = 'es',
    ['pt'] = 'pt-br', ['pt-pt'] = 'pt-br',
    ['fr-fr'] = 'fr', ['fr-ca'] = 'fr', ['de-de'] = 'de', ['ru-ru'] = 'ru',
    ['ja-jp'] = 'ja', ['jp'] = 'ja', ['jp-jp'] = 'ja',
    ['ko-kr'] = 'ko', ['kr'] = 'ko', ['kr-kr'] = 'ko',
    -- Cyberpunk's own codes are it-it, pl-pl, cz-cz, hu-hu, tr-tr and ua-ua.
    ['it-it'] = 'it', ['it-ch'] = 'it', ['pl-pl'] = 'pl',
    ['cz'] = 'cs', ['cz-cz'] = 'cs', ['cs-cz'] = 'cs', ['hu-hu'] = 'hu', ['tr-tr'] = 'tr',
    ['ua'] = 'uk', ['ua-ua'] = 'uk', ['uk-ua'] = 'uk',
}
local selected, detected, resolved, generation = 'auto', 'en', 'en', 0
local dictionary, dictionaries, catalogAvailable = {}, {}, true
local poll, previousClock, pending = 0, nil, true
local deltaClock, wallClock = 0, 0

local function normalize(value)
    if type(value) ~= 'string' or #value > 40 then return nil end
    value = value:lower():match('^%s*(.-)%s*$'):gsub('_', '-')
    if value == '' or value:find('[^a-z0-9%-]') then return nil end
    if supported[value] then return value end
    return aliases[value] or 'en'
end

local function gameLanguage()
    -- Installed Codeware.Localization.LocalizationSystem.UpdateLocale uses
    -- exactly /language, OnScreen (ConfigVarListName.GetValue). Subtitles and
    -- VoiceOver are separate settings and must never select this UI language.
    -- Primary reference: https://github.com/psiberx/cp2077-codeware/blob/main/scripts/Localization/LocalizationSystem.reds
    local settings = Game.GetSettingsSystem()
    if not settings then return nil end
    local variable = settings:GetVar(CName.new('/language'), CName.new('OnScreen'))
    if not variable then return nil end
    local value = variable:GetValue()
    if type(value) == 'string' then return value end
    if value == nil then return nil end
    if type(NameToString) == 'function' then return NameToString(value) end
    -- CET exposes CName.value as well; keep this conversion inside update.
    return value.value
end

local function tokens(value)
    local result = {}
    for key in value:gmatch('{([A-Za-z_][A-Za-z0-9_]*)}') do result[key] = true end
    return result
end

local function sameTokens(source, translated)
    local a, b = tokens(source), tokens(translated)
    for key in pairs(a) do if not b[key] then return false end end
    for key in pairs(b) do if not a[key] then return false end end
    return true
end

local function loadDictionary(code)
    if code == 'en' then return {}, true end
    local cached = dictionaries[code]
    if cached then return cached.values, cached.available end
    -- The path is chosen solely from the fixed supported-language table.
    -- Catalogs are authored Lua data, never conversation or network content.
    local ok, values = pcall(dofile, 'locales/' .. code .. '.lua')
    local accepted, count = {}, 0
    local available = ok and type(values) == 'table'
    if available then
        for source, translated in next, values do
            count = count + 1
            if count > 4096 then accepted, available = {}, false; break end
            if type(source) == 'string' and #source > 0 and #source <= 4096
                and type(translated) == 'string' and #translated > 0 and #translated <= 8192
                and not source:find('%z') and not translated:find('%z')
                and sameTokens(source, translated) then
                accepted[source] = translated
            end
        end
    end
    dictionaries[code] = {values = accepted, available = available}
    return accepted, available
end

-- Queues a supported saved/manual choice. Actual loading and any native
-- language detection are deferred to update; a bad value leaves it unchanged.
function M.configure(value)
    if value ~= 'auto' and not supported[value] then return false end
    if selected ~= value then
        selected, pending = value, true
        if value == 'auto' then poll = 0 end
    end
    return true
end

function M.update(delta)
    -- Menu frames can have zero simulation delta. Accumulate both clocks and
    -- use their maximum, not their sum, so paused menus still detect changes
    -- without double-counting wall ticks during ordinary gameplay.
    local clock = os.time()
    if previousClock then wallClock = wallClock + math.max(0, clock-previousClock) end
    if type(delta) == 'number' and delta == delta and delta >= 0 and delta < math.huge then
        deltaClock = deltaClock + math.min(delta, INTERVAL)
    end
    previousClock = clock
    local elapsed = math.max(deltaClock,wallClock)
    if selected == 'auto' and elapsed >= poll then
        poll = elapsed + INTERVAL
        local ok, value = pcall(gameLanguage)
        local language = ok and normalize(value) or nil
        -- A temporary missing settings service does not flash an already
        -- translated menu back to English. Unsupported real locales use en.
        if language then detected = language end
    end
    local wanted = selected == 'auto' and detected or selected
    if not pending and wanted == resolved then return false end
    pending = false
    if wanted == resolved then return false end
    dictionary, catalogAvailable = loadDictionary(wanted)
    resolved, generation = wanted, generation + 1
    return true
end

function M.t(source, args)
    if type(source) ~= 'string' then return source end
    local translated = dictionary[source] or source
    if type(args) ~= 'table' then return translated end
    -- Function replacement treats %, braces, and UTF-8 names as literal text;
    -- it never recursively translates/interpolates user or character content.
    return (translated:gsub('{([A-Za-z_][A-Za-z0-9_]*)}', function(key)
        local value = rawget(args, key)
        if type(value) == 'string' or type(value) == 'number' or type(value) == 'boolean' then return tostring(value) end
        return '{' .. key .. '}'
    end))
end

-- A time of day for a sentence ("It resets at 5:30 AM."): English reads a 12-hour clock with AM or PM, every other language the 24-hour "05:30".
-- `hhmm` is "HH:MM" (what os.date and the bridge's reset times give); anything else comes back unchanged.
function M.clockText(hhmm)
    local hour, minute = tostring(hhmm):match('^(%d%d):(%d%d)$')
    if not hour or resolved ~= 'en' then return hhmm end
    hour = tonumber(hour)
    local suffix = hour < 12 and 'AM' or 'PM'
    hour = hour % 12
    if hour == 0 then hour = 12 end
    return hour .. ':' .. minute .. ' ' .. suffix
end

-- The end of the shared Convai key's day as the sign-in backend last said it (allowance.resetAt, epoch seconds), held for the messages that
-- say when the turns come back. mod/manager.lua ownKey() hands it over whenever it reads the bridge's status file; nothing else sets it.
local dailyResetAt
function M.noteDailyReset(at)
    if type(at) == 'number' and at == at and at > 0 and at < 32503680000 then dailyResetAt = at else dailyResetAt = nil end
end

-- When the shared Convai key's daily turns come back, as a time of day on this computer's clock (clockText: "5:30 AM" in English, "05:30" in the
-- other languages): the backend's own reset instant when it has told us one that is still ahead (and within two days), else the next 00:00 UTC
-- after `now` (default: the real clock, in seconds), because the sign-in backend and bridge/shared-key-guard.mjs count per UTC day. The instant is
-- plain arithmetic on the epoch (no os.time(table), whose broken-down time would be read in the local zone and break on DST days); os.date turns
-- that one instant into local time, so half-hour zones and DST come out right. Called only when a message is shown, never per frame. nil when the
-- clock cannot be read.
function M.dailyResetClock(now)
    if now == nil then
        local read, value = pcall(os.time)
        now = read and value or nil
    end
    if type(now) ~= 'number' or now ~= now or now < 0 or now > 32503680000 then return nil end
    local at = (math.floor(now / 86400) + 1) * 86400
    if dailyResetAt and dailyResetAt > now and dailyResetAt - now <= 172800 then at = dailyResetAt end
    local read, clock = pcall(os.date, '%H:%M', at)
    if read and type(clock) == 'string' and clock:match('^%d%d:%d%d$') then return M.clockText(clock) end
    return nil
end

function M.selection() return selected end

-- CET scopes these functions to our mod. Read on demand: bindings can change
-- while the overlay is open and are not initialized during top-level loading.
function M.boundKey(action)
    if type(IsBound) ~= 'function' or type(GetBind) ~= 'function' then return nil end
    local ok, value = pcall(function()
        if not IsBound(action) then return nil end
        return GetBind(action)
    end)
    if ok and type(value) == 'string' and #value > 0 and #value <= 100
        and value ~= 'Unbound' and not value:find('%c') then return value end
    return nil
end

function M.current() return resolved end
function M.revision() return generation end

function M.supported()
    local result = {}
    for i, language in ipairs(languages) do result[i] = language.value end
    return result
end

function M.choices()
    local result = {{value = 'auto', label = M.t('Automatic (game interface language)')}}
    for _, language in ipairs(languages) do
        result[#result + 1] = {value = language.value, label = language.label}
    end
    return result
end

function M.inspect()
    return {selection = selected, current = resolved, detected = detected,
        revision = generation, catalogAvailable = catalogAvailable}
end

convaiUiLocale = M
return M
