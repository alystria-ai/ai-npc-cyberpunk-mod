-- Content packs (add-on API 1.1, docs/ADDON_API.md "Content packs"), the game's half of the names: a pack may give a named character a new
-- name (content.characters[<profile key>].name) and replace the name pools of the nameless pedestrians (content.namePools). The bridge applies
-- them to its own roster rows (prompt, editor) and publishes two files at its start (bridge/addon-content.mjs publish):
--   runtime/content-names.json       {version = 1, packs = {{id, names = {profileKey = name}, summaries = {profileKey = text}}}}   every installed pack that
--                                    renames or rewrites (summaries, optional: the short description the Companion Manager and the details panels show)
--   runtime/content-name-pools.json  {version = 1, packs = {{id, pools = {cultures, handleStyles, blockedFullNames}}}}
-- Empty or missing without a pack. This module is the one place the game reads them; the player's switch of each pack is
-- convaiAddons.contentEnabledFor(id) (mod/addons.lua), on by default, so only an enabled pack applies and a later pack wins per key.
--
-- WHEN IT APPLIES: the catalogs are loaded once, at game start, and the new names are laid over their rows right there (applyRows, called from
-- the few load sites: init.lua's roster, companions.lua's phone contacts, holocall.lua's contacts, manager.lua's manager-characters.json). Every
-- consumer after that sees the new name, so a switch flipped in Settings counts from the next game start or save load, not live. The shipped
-- name stays on the row as `shippedName` and in `aliases`, and the shipped description as `shippedSummary` (row.summary is the pack's, same timing), so the old name still finds the character everywhere a name is recognised
-- (character-catalog build() indexes name + aliases; the Companion Manager's search reads aliases too). Idempotent and cheap: one table
-- lookup per row, nothing per frame and nothing per tick; with no pack the files are read once (a missing or empty one is "no packs") and
-- the rows come back untouched.
--
-- NAME POOLS: mod/npc-names.lua asks pools() on its first need (it loads the shipped pools lazily). The pools of the last enabled pack that
-- has any replace the shipped ones, converted here to the shape of mod/npc-name-pools.lua (scripts/Build-NpcNamePools.mjs luaSource). A
-- one-shop vendor that already has a saved name (runtime/npc-names.json) keeps it; the pack's pools apply to names made after. Names are a
-- pure function of the entity id and traits, so a switch changes new names only.
--
-- Damaged JSON, a wrong shape or a bad entry is ignored (no pack), never an error.
if type(convaiContentNames) == 'table' and convaiContentNames.isContentNames == true then return convaiContentNames end
local M = {version = 1, isContentNames = true}

local NAMES_FILE, POOLS_FILE = 'runtime/content-names.json', 'runtime/content-name-pools.json'
local MAX_PACKS, MAX_NAME, MAX_LIST, MAX_SUMMARY = 16, 400, 5000, 2000

local function normalized(value)
    return (tostring(value or ''):lower():gsub('%s+', ' '):gsub('^ ', ''):gsub(' $', ''))
end

-- Letters with a diacritic fold to the plain letter, as scripts/Build-NpcNamePools.mjs fold does (NFD, marks removed, ASCII lower case).
-- Letters that do not decompose (o with a stroke, l with a stroke, sharp s) stay as they are, as there.
local FOLD = {}
for base, letters in pairs({
    a = 'àáâãäåāăąÀÁÂÃÄÅĀĂĄǎǍ', c = 'çćĉċčÇĆĈĊČ', d = 'ďĎ', e = 'èéêëēĕėęěÈÉÊËĒĔĖĘĚ', g = 'ĝğġģĜĞĠĢ', h = 'ĥĤ',
    i = 'ìíîïĩīĭįıÌÍÎÏĨĪĬĮİ', j = 'ĵĴ', k = 'ķĶ', l = 'ĺļľĹĻĽ', n = 'ñńņňÑŃŅŇ', o = 'òóôõöōŏőÒÓÔÕÖŌŎŐ', r = 'ŕŗřŔŖŘ',
    s = 'śŝşšșŚŜŞŠȘ', t = 'ţťțŢŤȚ', u = 'ùúûüũūŭůűųÙÚÛÜŨŪŬŮŰŲ', w = 'ŵŴ', y = 'ýÿŷÝŸŶ', z = 'źżžŹŻŽ',
}) do
    for char in letters:gmatch('[\1-\127\194-\244][\128-\191]*') do FOLD[char] = base end
end
local function asciiLower(text) return (text:gsub('[A-Z]', string.lower)) end
local function fold(text)
    text = text:gsub('\204[\128-\191]', ''):gsub('\205[\128-\175]', '')        -- combining marks U+0300 to U+036F
    return asciiLower((text:gsub('[\194-\244][\128-\191]*', FOLD)))
end
M.fold = fold

--- options (all optional, for tests): json, io, enabled(packId) -> bool, namesPath, poolsPath.
function M.new(options)
    options = options or {}
    local N = {}
    local names, merged, mergedSummaries, poolsValue, poolsLoaded

    local function readJson(path)
        local jsonLib = options.json or json
        local file = (options.io or io).open(path, 'rb')
        if not file then return nil end
        local text = file:read('*a'); file:close()
        if type(text) ~= 'string' then return nil end
        if text:sub(1, 3) == '\239\187\191' then text = text:sub(4) end
        if text == '' or type(jsonLib) ~= 'table' or type(jsonLib.decode) ~= 'function' then return nil end
        local ok, value = pcall(jsonLib.decode, text)
        return ok and type(value) == 'table' and value or nil
    end
    -- The player's switch (Settings > Content packs). The add-on module can be absent: a pack is then on, as it is by default.
    local function enabled(id)
        if options.enabled then return options.enabled(id) ~= false end
        local addons = convaiAddons
        if type(addons) ~= 'table' or type(addons.contentEnabledFor) ~= 'function' then return true end
        local ok, value = pcall(addons.contentEnabledFor, id)
        return not ok or value ~= false
    end
    local function packsOf(path)
        local doc = readJson(path)
        if not doc or doc.version ~= 1 or type(doc.packs) ~= 'table' then return {} end
        local list = {}
        for _, pack in ipairs(doc.packs) do
            if type(pack) == 'table' and type(pack.id) == 'string' and #list < MAX_PACKS then list[#list + 1] = pack end
        end
        return list
    end

    -- {profileKey = new name} of the packs that are on, a later pack winning. Made once (the switch is read once: the catalogs load once).
    local function active()
        if merged then return merged, mergedSummaries end
        merged, mergedSummaries = {}, {}
        for _, pack in ipairs(packsOf(options.namesPath or NAMES_FILE)) do
            if enabled(pack.id) then
                if type(pack.names) == 'table' then
                    for key, name in pairs(pack.names) do
                        if type(key) == 'string' and type(name) == 'string' then
                            name = name:gsub('[%c]', ' '):gsub('^%s+', ''):gsub('%s+$', '')
                            if name ~= '' and #name <= MAX_NAME then merged[key] = name end
                        end
                    end
                end
                -- The short descriptions (a line break stays: the shipped ones have two paragraphs); a later pack wins per key.
                if type(pack.summaries) == 'table' then
                    for key, text in pairs(pack.summaries) do
                        if type(key) == 'string' and type(text) == 'string' then
                            text = text:gsub('[\1-\8\11\12\14-\31\127]', ' '):gsub('^%s+', ''):gsub('%s+$', '')
                            if text ~= '' and #text <= MAX_SUMMARY then mergedSummaries[key] = text end
                        end
                    end
                end
            end
        end
        return merged, mergedSummaries
    end

    --- Forgets what was read (the next call reads the files and the switches again). The rows already changed are changed again by applyRows.
    function N.reset() merged, mergedSummaries, poolsValue, poolsLoaded = nil, nil, nil, false end

    --- The pack's short description for a profile key, or nil.
    function N.summaryFor(key) if type(key) ~= 'string' then return nil end; local _, summaries = active(); return summaries[key] end

    --- The pack's name for a profile key, or nil.
    function N.nameFor(key) return type(key) == 'string' and active()[key] or nil end

    --- A label that follows the pack: the pack's name for this key when it has one, else `fallback` (the archetype labels).
    function N.label(key, fallback) return N.nameFor(key) or fallback end

    --- Lays the packs' names over catalog rows in place ({key | profileKey, name, aliases}): row.name is the new name, row.shippedName the one
    --- it shipped with, and the shipped name is kept in row.aliases (no duplicate). A row no enabled pack names goes back to its shipped
    --- name. Returns rows and the number changed. Idempotent: a second call changes nothing.
    function N.applyRows(rows)
        if type(rows) ~= 'table' then return rows, 0 end
        local map, summaries = active()
        local changed = 0
        for _, row in ipairs(rows) do
            if type(row) == 'table' and row.kind ~= 'addon' and row.kind ~= 'custom' then
                local key = row.profileKey or row.key
                local new = type(key) == 'string' and map[key] or nil
                -- The short description: the pack's text, the shipped one kept in shippedSummary (false: the row had none) and put back when no pack is on.
                local text = type(key) == 'string' and summaries[key] or nil
                if text then
                    if row.shippedSummary == nil then row.shippedSummary = row.summary or false end
                    if row.summary ~= text then row.summary = text; changed = changed + 1 end
                elseif row.shippedSummary ~= nil then
                    row.summary, row.shippedSummary = row.shippedSummary or nil, nil
                    changed = changed + 1
                end
                if new and type(row.name) == 'string' and row.name ~= '' then
                    local shipped = row.shippedName or row.name
                    if shipped ~= new then
                        if row.name ~= new then changed = changed + 1 end
                        row.shippedName, row.name = shipped, new
                        local aliases = type(row.aliases) == 'table' and row.aliases or {}
                        local seen = false
                        for _, alias in ipairs(aliases) do
                            if normalized(alias) == normalized(shipped) then seen = true; break end
                        end
                        if not seen then aliases[#aliases + 1] = shipped end
                        row.aliases = aliases
                    end
                elseif row.shippedName then
                    row.name, row.shippedName = row.shippedName, nil
                    changed = changed + 1
                end
            end
        end
        return rows, changed
    end

    -- A list of names, kept when it holds at least one text.
    local function list(value)
        if type(value) ~= 'table' then return nil end
        local out = {}
        for _, entry in ipairs(value) do
            if type(entry) == 'string' and entry ~= '' and #out < MAX_LIST then out[#out + 1] = entry end
        end
        return #out > 0 and out or nil
    end
    -- The JSON of a pack's pools as the Lua table of mod/npc-name-pools.lua: cultures[culture] = {male, female, surnames, handles},
    -- styles[style] = handles, blocked[ascii-lowered name and its accent-folded form] = true. nil when it cannot serve (no corpo-anglo
    -- culture: the generator falls back to it).
    local function convert(data)
        if type(data) ~= 'table' or type(data.cultures) ~= 'table' then return nil end
        local cultures, styles, blocked = {}, {}, {}
        for culture, entry in pairs(data.cultures) do
            if type(culture) == 'string' and type(entry) == 'table' then
                local male, female, surnames, handles = list(entry.male), list(entry.female), list(entry.surnames), list(entry.handles)
                if male and female and surnames and handles then cultures[culture] = {male = male, female = female, surnames = surnames, handles = handles} end
            end
        end
        if not cultures['corpo-anglo'] then return nil end
        if type(data.handleStyles) == 'table' then
            for style, handles in pairs(data.handleStyles) do
                if type(style) == 'string' and list(handles) then styles[style] = list(handles) end
            end
        end
        for _, name in ipairs(type(data.blockedFullNames) == 'table' and data.blockedFullNames or {}) do
            if type(name) == 'string' then blocked[asciiLower(name)] = true; blocked[fold(name)] = true end
        end
        return {version = tonumber(data.version) or 1, source = 'content-pack', cultures = cultures, styles = styles, blocked = blocked}
    end

    --- The name pools of the last enabled pack that has some, as the Lua table mod/npc-names.lua uses, or nil (use the shipped ones). Read once.
    function N.pools()
        if poolsLoaded then return poolsValue end
        poolsLoaded = true
        for _, pack in ipairs(packsOf(options.poolsPath or POOLS_FILE)) do
            if enabled(pack.id) then poolsValue = convert(pack.pools) or poolsValue end
        end
        return poolsValue
    end

    return N
end

-- The shared instance every load site uses: M.applyRows(rows), M.nameFor(key), M.label(key, fallback), M.pools(), M.reset().
local shared
for _, name in ipairs({'applyRows', 'nameFor', 'summaryFor', 'label', 'pools', 'reset'}) do
    M[name] = function(...)
        shared = shared or M.new()
        return shared[name](...)
    end
end
convaiContentNames = M
return M
