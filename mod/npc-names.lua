-- Names for nameless ordinary NPCs (docs/NPC_NAMES.md): a passer-by or a shopkeeper the game gives no name gets a
-- Night City name made from what they are, shown in the scanner and told to the conversation ("Your name is ...").
--
-- One source of truth, here: the scanner and the talk path both call nameFor(), so the same NPC has the same name in both.
--   * Deterministic: the name is a pure function of (entity id, character record), plus the traits. The same ped keeps
--     their name for the session. A one-shop vendor (a stable record, character-catalog memoryKey) is seeded by that record
--     and kept in a small file (npc-names.json, 128 names at most), so the shopkeeper keeps the name across sessions too.
--   * Trait-driven: gender from the body, the archetype kind the catalog resolved (gang, police, corporate, vendor kind,
--     resident kind), the affiliation (corporate employer), and tokens of the appearance and record names.
--   * Curated pools (mod/npc-name-pools.lua, generated from characters/npc-name-pools.json), loaded once on first need.
--   * Realistic first and last names; a mild street handle on a share of them ("Rico 'Chrome' Alvarez"). Never the name of
--     a named game character (the pools' blocked list is re-rolled).
--
-- Cost: nothing runs per frame. The only game hook is ObserveAfter(NPCPuppet.CompileScannerChunks), which the game runs when
-- the scanner asks for that NPC; the answer is cached per entity. Story and named characters, the mod's own companions and
-- NPCs in combat never get a scanner name (the gate is init.lua's `inspect`).
local M = {version = 1}

-- ---------------------------------------------------------------------------------------------------------------------
-- Culture mixes: weights per culture pool (characters/npc-name-pools.json). A mix is who lives in that corner of the city.
local MIXES = {
    broad = {latino = 14, ['african-american'] = 13, japanese = 8, chinese = 8, slavic = 7, ['irish-working'] = 6, ['corpo-anglo'] = 6,
        ['south-asian'] = 6, filipino = 5, ['nomad-american'] = 5, korean = 4, arabic = 4, ['west-african'] = 4, haitian = 3,
        ['german-nordic'] = 3, french = 3},
    street = {latino = 18, ['african-american'] = 16, slavic = 8, ['irish-working'] = 8, ['nomad-american'] = 8, japanese = 6,
        chinese = 6, filipino = 6, ['south-asian'] = 5, ['west-african'] = 5, arabic = 4, haitian = 4, korean = 3,
        ['german-nordic'] = 2, french = 1},
    corpo = {['corpo-anglo'] = 30, japanese = 14, ['south-asian'] = 10, chinese = 9, korean = 8, ['german-nordic'] = 8,
        ['african-american'] = 8, french = 6, latino = 5, arabic = 2},
    nomad = {['nomad-american'] = 62, latino = 14, ['irish-working'] = 8, ['african-american'] = 6, slavic = 5, ['german-nordic'] = 5},
    maelstrom = {slavic = 25, ['german-nordic'] = 18, ['irish-working'] = 15, ['african-american'] = 12, ['nomad-american'] = 10,
        ['corpo-anglo'] = 5, french = 5, latino = 5, chinese = 3, japanese = 2},
    tyger = {japanese = 85, chinese = 8, korean = 7},
    valentinos = {latino = 100},
    voodoo = {haitian = 94, ['west-african'] = 3, ['african-american'] = 3},
    sixth = {['irish-working'] = 20, ['nomad-american'] = 20, ['african-american'] = 20, ['german-nordic'] = 15, ['corpo-anglo'] = 15,
        latino = 10},
    animals = {['african-american'] = 38, latino = 22, ['irish-working'] = 12, slavic = 10, ['west-african'] = 8, haitian = 5,
        ['german-nordic'] = 5},
    scavengers = {slavic = 20, ['nomad-american'] = 20, ['german-nordic'] = 14, ['irish-working'] = 14, ['african-american'] = 12,
        latino = 12, ['south-asian'] = 4, arabic = 4},
    wraiths = {['nomad-american'] = 32, arabic = 18, ['south-asian'] = 12, slavic = 12, latino = 12, ['african-american'] = 8,
        ['irish-working'] = 6},
    aldecaldos = {['nomad-american'] = 40, latino = 28, ['african-american'] = 10, ['irish-working'] = 8, arabic = 5, french = 5,
        ['west-african'] = 4},
    barghest = {['german-nordic'] = 20, ['corpo-anglo'] = 20, slavic = 18, ['irish-working'] = 14, ['african-american'] = 10,
        latino = 10, french = 8},
    mox = {['african-american'] = 16, french = 14, ['irish-working'] = 14, latino = 14, ['corpo-anglo'] = 10, japanese = 8,
        slavic = 8, korean = 6, filipino = 6, ['south-asian'] = 4},
    police = {['african-american'] = 18, latino = 18, ['corpo-anglo'] = 14, ['irish-working'] = 14, filipino = 8, slavic = 8,
        korean = 6, ['south-asian'] = 5, ['german-nordic'] = 5, japanese = 4},
    arasaka = {japanese = 62, ['corpo-anglo'] = 14, korean = 8, chinese = 8, filipino = 8},
    militech = {['corpo-anglo'] = 30, ['german-nordic'] = 18, slavic = 14, ['african-american'] = 14, latino = 14, ['irish-working'] = 10},
    kangtao = {chinese = 82, korean = 10, japanese = 8},
    biotechnica = {['corpo-anglo'] = 24, french = 14, ['german-nordic'] = 14, ['south-asian'] = 14, ['african-american'] = 14,
        arabic = 10, latino = 10},
    medical = {['corpo-anglo'] = 20, ['african-american'] = 16, latino = 16, filipino = 12, ['south-asian'] = 12, korean = 8, french = 8,
        ['german-nordic'] = 8},
    clinic = {japanese = 14, latino = 14, chinese = 12, ['african-american'] = 12, ['south-asian'] = 12, slavic = 10, ['corpo-anglo'] = 10,
        arabic = 8, korean = 8},
    netrunner = {korean = 14, chinese = 14, ['south-asian'] = 14, slavic = 14, japanese = 12, ['african-american'] = 8, latino = 8,
        ['corpo-anglo'] = 8, filipino = 8},
    melee = {japanese = 25, latino = 14, ['african-american'] = 14, chinese = 10, slavic = 10, filipino = 10, ['irish-working'] = 7,
        korean = 5, ['nomad-american'] = 5},
    dogtown = {['african-american'] = 16, latino = 16, slavic = 14, arabic = 14, ['irish-working'] = 8, ['nomad-american'] = 8,
        ['german-nordic'] = 6, ['south-asian'] = 6, haitian = 6, ['west-african'] = 6},
}

-- Profiles: {mix, style (the handle pool; nil = the culture's own), handle (the chance of a street handle)}.
-- Keyed by the archetype base of characters/archetypes.json (a test checks every base has one).
local function P(mix, style, handle) return {mix = mix, style = style, handle = handle} end
local PROFILES = {
    ['maelstrom'] = P('maelstrom', 'maelstrom', .28), ['tyger-claws'] = P('tyger', 'tyger-claws', .28),
    ['valentinos'] = P('valentinos', 'valentinos', .28), ['sixth-street'] = P('sixth', '6th-street', .26),
    ['animals'] = P('animals', 'animals', .28), ['voodoo-boys'] = P('voodoo', 'voodoo-boys', .28),
    ['scavengers'] = P('scavengers', 'scavengers', .28), ['wraiths'] = P('wraiths', 'nomad', .26),
    ['mox'] = P('mox', 'moxes', .28), ['aldecaldos'] = P('aldecaldos', 'nomad', .2), ['barghest'] = P('barghest', 'street-generic', .1),
    ['ncpd'] = P('police', nil, 0),
    ['corpo-security'] = P('corpo', nil, .03), ['militech'] = P('militech', nil, .05), ['kang-tao'] = P('kangtao', nil, .05),
    ['netwatch'] = P('corpo', nil, .08), ['trauma-team'] = P('medical', nil, .04), ['biotechnica'] = P('biotechnica', nil, .03),
    ['merc'] = P('street', 'street-generic', .3), ['street-goon'] = P('street', 'street-generic', .24),
    ['ripperdoc'] = P('clinic', 'street-generic', .2), ['medic-vendor'] = P('clinic', 'street-generic', .18),
    ['weapons-dealer'] = P('street', 'nomad', .24), ['melee-vendor'] = P('melee', 'street-generic', .24),
    ['netrunner-vendor'] = P('netrunner', 'street-generic', .3), ['junk-dealer'] = P('street', 'street-generic', .26),
    ['food-vendor'] = P('broad', nil, .14), ['bartender'] = P('broad', 'street-generic', .2), ['market-stall'] = P('broad', nil, .12),
    ['clothing-vendor'] = P('broad', nil, .1),
    ['corpo-resident'] = P('corpo', nil, .03), ['street-resident'] = P('street', 'street-generic', .14),
    ['nomad-resident'] = P('nomad', 'nomad', .18), ['homeless'] = P('street', 'street-generic', .2),
    ['nightlife-resident'] = P('broad', 'street-generic', .22), ['worker-resident'] = P('broad', nil, .1),
    ['dogtown-resident'] = P('dogtown', 'street-generic', .2),
}
local DEFAULT_PROFILE = P('broad', 'street-generic', .12)
M.PROFILES, M.MIXES, M.DEFAULT_PROFILE = PROFILES, MIXES, DEFAULT_PROFILE

-- A corporate guard's employer decides the mix (docs/NPC_ARCHETYPES.md: the employer comes from the affiliation).
local EMPLOYERS = {Arasaka = 'arasaka', KangTao = 'kangtao', Militech = 'militech', Biotechnica = 'biotechnica'}

-- Tokens of "<appearance name> <record name>" (lower case) that name a faction or a station, for a resident or an NPC the
-- catalog could not place. The first match wins; the pairs are {token, base}. Appearance names look like
-- "gang__valentinos_wa__..." and "corporat_wa_corporat_wa_06"; record names like "Character.HomelessMan".
local TOKENS = {
    {'valentino', 'valentinos'}, {'tyger', 'tyger-claws'}, {'voodoo', 'voodoo-boys'}, {'maelstrom', 'maelstrom'},
    {'sixthstreet', 'sixth-street'}, {'6th_street', 'sixth-street'}, {'6thstreet', 'sixth-street'}, {'gang__animals', 'animals'},
    {'_animals', 'animals'}, {'moxes', 'mox'}, {'_mox', 'mox'}, {'scav', 'scavengers'}, {'aldecaldo', 'aldecaldos'},
    {'wraith', 'wraiths'}, {'barghest', 'barghest'}, {'kangtao', 'kang-tao'}, {'kang_tao', 'kang-tao'}, {'arasaka', 'corpo-security'},
    {'militech', 'militech'}, {'biotechnica', 'biotechnica'}, {'netwatch', 'netwatch'}, {'trauma', 'trauma-team'},
    {'medtech', 'trauma-team'}, {'ncpd', 'ncpd'}, {'police', 'ncpd'}, {'_cop_', 'ncpd'}, {'homeless', 'homeless'}, {'hobo', 'homeless'},
    {'corpo', 'corpo-resident'}, {'nomad', 'nomad-resident'}, {'nightlife', 'nightlife-resident'}, {'lowlife', 'street-resident'},
}
M.TOKENS = TOKENS
-- Categories whose catalog placement is trusted over the tokens (the affiliation or vendor type already said what they are).
local TRUSTED = {gang = true, police = true, ['corpo-security'] = true, faction = true, vendor = true}

local function lower(value) return type(value) == 'string' and value:lower() or '' end

-- The profile for these traits: {mix, style, handle, base}. traits = {base, category, affiliation, appearance, recordName}.
function M.profile(traits)
    traits = traits or {}
    local base = traits.base
    if not (base and TRUSTED[traits.category or ''] and PROFILES[base]) then
        local haystack = lower(traits.appearance) .. ' ' .. lower(traits.recordName)
        local found
        for _, token in ipairs(TOKENS) do
            if haystack:find(token[1], 1, true) then found = token[2]; break end
        end
        -- A resident the catalog placed keeps its resident kind unless a token names a faction or a station more exactly.
        base = found or base
    end
    local profile = base and PROFILES[base] or DEFAULT_PROFILE
    local mix = profile.mix
    if base == 'corpo-security' then mix = EMPLOYERS[traits.affiliation or ''] or mix end
    return {mix = mix, style = profile.style, handle = profile.handle, base = base}
end

-- ---------------------------------------------------------------------------------------------------------------------
-- A deterministic generator from a string seed. Only exact arithmetic below 2^53 (LuaJIT and Lua 5.3 agree):
-- a djb2-style hash, then an iterated quadratic map x -> x*x + c modulo the prime 2^31 - 1 (nonlinear, so neighbouring
-- entity ids do not give neighbouring names).
local MOD = 2147483647
local function mulmod(a, b)
    local high, low = math.floor(b / 65536), b % 65536
    return (((a * high) % MOD) * 65536 + a * low) % MOD
end
local function seedFrom(text)
    local h = 5381
    for index = 1, #text do h = (h * 33 + text:byte(index)) % 4294967291 end
    h = h % MOD
    if h == 0 then h = 1 end
    for _ = 1, 3 do h = (mulmod(h, h) + 12345) % MOD end
    return h
end
local function newRandom(text)
    local state = seedFrom(text)
    -- draw(n): an integer in 1..n
    return function(n)
        state = (mulmod(state, state) + 12345) % MOD
        return state % n + 1
    end
end
M.seedFrom = seedFrom

-- Slavic surnames are the masculine form in the pool; a woman gets the feminine form where the language has one.
local CZECH_Y = {Novotny = true, Cerny = true, Vesely = true, Pokorny = true, Kopecky = true, Konecny = true, Stastny = true,
    Tichy = true, Hruby = true, Maly = true}
function M.feminine(culture, surname)
    if culture ~= 'slavic' then return surname end
    if CZECH_Y[surname] then return surname:sub(1, -2) .. 'a' end
    if surname:find('sky$') then return surname:sub(1, -2) .. 'aya' end
    if surname:find('oy$') then return surname:sub(1, -3) .. 'aya' end
    if surname:find('[sc]ki$') or surname:find('zki$') then return surname:sub(1, -2) .. 'a' end
    if surname:find('ov$') or surname:find('ev$') or surname:find('in$') then return surname .. 'a' end
    return surname
end

local FEMALE_ONLY = {Nena = true, Chica = true, Morena = true, Estrella = true, Paloma = true, Marisol = true, Lucero = true,
    Miel = true, ['Cariño'] = true, Reina = true, Mambo = true, Ezili = true, Erzulie = true, ['Sirèn'] = true, ['Ti-Fi'] = true,
    Hana = true, Sakura = true, Rosette = true, Pinup = true}
local MALE_ONLY = {Papi = true, Mijo = true, Gordo = true, Flaco = true, Chavo = true, Vato = true, Tio = true, Abuelo = true,
    Jefe = true, Compadre = true, Carnal = true, Primo = true, Tonton = true, Papa = true, Bokor = true, Baron = true, Legba = true,
    Cowboy = true, Gunslinger = true, Doughboy = true, Gentleman = true}
-- False for a handle that is plainly the other gender's: "La ..." / "El ..." articles and a few words (docs/NPC_NAMES.md).
function M.handleFits(handle, gender)
    if gender == 'MALE' then return not (handle:find('^La ') or FEMALE_ONLY[handle]) end
    if gender == 'FEMALE' then return not (handle:find('^El ') or MALE_ONLY[handle]) end
    return true
end

local function pickWeighted(mix, draw)
    local keys, total = {}, 0
    for culture, weight in pairs(mix) do keys[#keys + 1] = culture; total = total + weight end
    table.sort(keys)
    local roll = draw(total)
    for _, culture in ipairs(keys) do
        roll = roll - mix[culture]
        if roll <= 0 then return culture end
    end
    return keys[#keys]
end

local function blockedName(pools, name)
    local blocked = pools.blocked
    return blocked ~= nil and blocked[name:lower()] == true
end

-- One name: {name, first, last, handle, culture, gender} for these traits and this seed text. salt re-rolls a clash.
function M.generate(pools, traits, seed, salt)
    local profile = M.profile(traits)
    local mix = MIXES[profile.mix] or MIXES.broad
    local name
    for attempt = 0, 6 do
        local draw = newRandom(seed .. '#' .. tostring((salt or 0) + attempt))
        local culture = pickWeighted(mix, draw)
        local pool = pools.cultures[culture] or pools.cultures['corpo-anglo']
        local gender = traits.gender
        if gender ~= 'MALE' and gender ~= 'FEMALE' then gender = draw(2) == 1 and 'MALE' or 'FEMALE' end
        local firsts = gender == 'FEMALE' and pool.female or pool.male
        local first = firsts[draw(#firsts)]
        local last = pool.surnames[draw(#pool.surnames)]
        if gender == 'FEMALE' then last = M.feminine(culture, last) end
        local handle
        local chance = profile.handle or 0
        local roll, kind, pick = draw(1000), draw(2), draw(1000000)
        if roll <= chance * 1000 then
            local list = profile.style and pools.styles[profile.style]
            if not list or (kind == 1 and (profile.style == 'street-generic' or profile.style == 'nomad')) then list = pool.handles end
            -- A handle that is plainly the other gender's ("La Reina" on a man) is skipped for the next one in the list.
            for step = 0, 5 do
                handle = list[(pick + step * 7) % #list + 1]
                if M.handleFits(handle, gender) then break end
                handle = nil
            end
            if handle and (handle:lower() == first:lower() or handle:lower() == last:lower()) then handle = nil end
        end
        name = {first = first, last = last, handle = handle, culture = culture, gender = gender,
            name = handle and (first .. " '" .. handle .. "' " .. last) or (first .. ' ' .. last)}
        if not blockedName(pools, first .. ' ' .. last) then break end
    end
    name.mix, name.style, name.base = profile.mix, profile.style, profile.base
    return name
end

-- ---------------------------------------------------------------------------------------------------------------------
-- The gate: who counts as a nameless ordinary NPC. The same rule as the talk path (docs/WORLD_COMPANIONS.md, "The mod never
-- touches game characters"): not a copy the mod spawned, not a named / quest-bound / story character of the game, a resolved
-- ordinary profile (an archetype or the two residents), an adult human. deps (plain functions, supplied by init.lua):
--   ours(npc) protected(npc)                 convaiWorldPolicy
--   identify(npc) -> key, archetype, facts   the catalog's resolution of the NPC (archetype description and TweakDB facts)
--   ordinaryKey(key) -> bool                 an archetype key, or resident-male / resident-female
--   gender(facts), appearance(npc)           optional trait readers
-- Returns the traits for the generator, or nil and the reason it refused.
function M.ordinary(deps, npc)
    if deps.ours(npc) then return nil, 'ours' end
    if deps.protected(npc) then return nil, 'protected' end
    local key, archetype, facts = deps.identify(npc)
    if not key or not deps.ordinaryKey(key) then return nil, 'no-profile' end
    facts = facts or {}
    if facts.children == true or facts.human == false then return nil, 'not-adult-human' end
    archetype = archetype or {}
    return {gender = deps.gender and deps.gender(facts) or nil, base = archetype.base, category = archetype.category,
        affiliation = facts.affiliation, recordName = facts.recordName or facts.recordId,
        appearance = deps.appearance and deps.appearance(npc) or nil, memoryKey = archetype.memoryKey}
end

-- ---------------------------------------------------------------------------------------------------------------------
-- The service: caches, the vendor file, the scanner hook.
--   options.entity(npc)         the stable id string of the NPC (nil: no name)
--   options.inspect(npc, mode)  traits of an ORDINARY NPC, or nil and a reason; mode is 'scan' or 'talk'.
--                               traits = {gender, base, category, affiliation, appearance, recordName, memoryKey}
--   options.inCombat(npc)       true when the NPC is fighting (the scanner leaves them alone)
--   options.apply(npc, name)    puts the name into the scanner chunk (redscript NPCPuppet.ConvaiApplyScannerName)
--   options.pools / options.loadPools   the pools, or how to load them (default dofile('npc-name-pools.lua'))
--   options.log, options.json, options.io, options.storePath (default runtime/npc-names.json), options.legacyPath (where the file used to
--   be, next to init.lua; read until runtime/ has one), options.waiting() (true while the service may still be restoring the file)
M.STORE_CAP = 128
M.CACHE_CAP = 512

function M.new(options)
    options = options or {}
    local N = {stats = {scans = 0, applied = 0, talks = 0, refused = {}}}
    local pools = options.pools
    local byEntity, cached = {}, 0
    local refused, refusedCount = {}, 0
    local store
    local jsonLib = options.json or json
    local ioLib = options.io or io
    local storePath = options.storePath or 'runtime/npc-names.json'
    -- The file lives with the other player state in runtime/ (the service keeps a copy outside the game folder, bridge/game-state.mjs); a
    -- store an earlier version saved next to init.lua is read until one exists there.
    local legacyPath = options.legacyPath
    if legacyPath == nil and options.storePath == nil then legacyPath = 'npc-names.json' end
    local function waiting()
        if options.waiting then return options.waiting() == true end
        local restore = convaiStateRestore
        return restore ~= nil and restore.waiting() == true
    end
    local function log(line) if options.log then pcall(options.log, line) end end

    local function loadPools()
        if pools then return pools end
        local loader = options.loadPools or function() return dofile('npc-name-pools.lua') end
        local ok, loaded = pcall(loader)
        if ok and type(loaded) == 'table' and type(loaded.cultures) == 'table' then pools = loaded end
        return pools
    end
    local function readText(path)
        local file = ioLib.open(path, 'rb')
        if not file then return nil end
        local text = file:read('*a'); file:close()
        return text
    end
    local function readStore()
        if store then return store end
        local text = readText(storePath)
        if (text == nil or text == '') and legacyPath then text = readText(legacyPath) end
        local kept = {names = {}, order = {}}
        if text == nil or text == '' then
            -- Missing or empty while the service may still be restoring its copy (mod/state-restore.lua): this name is made but not kept,
            -- and the file is looked at again for the next vendor.
            if waiting() then kept.transient = true; return kept end
        else
            local ok, decoded = pcall(jsonLib.decode, text)
            if ok and type(decoded) == 'table' and type(decoded.names) == 'table' then
                for _, key in ipairs(decoded.order or {}) do
                    if type(key) == 'string' and type(decoded.names[key]) == 'string' then
                        kept.names[key] = decoded.names[key]; kept.order[#kept.order + 1] = key
                    end
                end
            end
        end
        store = kept
        return store
    end
    local function writeStore(kept)
        if kept.transient then return false end
        local file = ioLib.open(storePath, 'wb')
        if not file then return false end
        local ok, text = pcall(jsonLib.encode, {version = 1, names = kept.names, order = kept.order})
        if ok then file:write(text) end
        file:close()
        return ok
    end
    -- A shopkeeper's name: kept in the file; a new one is generated (never one already kept for another shop) and stored.
    local function vendorName(traits)
        local kept = readStore()
        local key = traits.memoryKey
        if kept.names[key] then return {name = kept.names[key], kept = true} end
        local taken = {}
        for _, value in pairs(kept.names) do taken[value] = true end
        local result
        for salt = 0, 5 do
            result = M.generate(pools, traits, 'vendor|' .. key, salt * 7)
            if not taken[result.name] then break end
        end
        kept.names[key] = result.name
        kept.order[#kept.order + 1] = key
        while #kept.order > M.STORE_CAP do
            local oldest = table.remove(kept.order, 1)
            kept.names[oldest] = nil
        end
        writeStore(kept)
        return result
    end

    -- The generated name for an ordinary NPC, or nil and a reason. mode: 'scan' or 'talk'.
    function N.nameFor(npc, mode)
        if not npc then return nil, 'no-npc' end
        local entity = options.entity(npc)
        if type(entity) ~= 'string' or entity == '' then return nil, 'no-entity' end
        if refused[entity] then return nil, refused[entity] end
        if mode == 'scan' and options.inCombat and options.inCombat(npc) == true then return nil, 'combat' end
        local hit = byEntity[entity]
        if hit then return hit.name, hit end
        local traits, reason = options.inspect(npc, mode)
        if not traits then
            reason = reason or 'not-ordinary'
            if refusedCount >= 256 then refused, refusedCount = {}, 0 end
            -- 'combat' and other momentary reasons are never kept; only a permanent refusal is.
            if reason ~= 'combat' then refused[entity], refusedCount = reason, refusedCount + 1 end
            N.stats.refused[reason] = (N.stats.refused[reason] or 0) + 1
            return nil, reason
        end
        if not loadPools() then return nil, 'no-pools' end
        local result
        if type(traits.memoryKey) == 'string' and traits.memoryKey ~= '' then
            result = vendorName(traits)
            result.base = traits.base
        else
            result = M.generate(pools, traits, entity .. '|' .. lower(traits.recordName))
        end
        if cached >= M.CACHE_CAP then byEntity, cached = {}, 0 end
        byEntity[entity], cached = result, cached + 1
        log(string.format('NPC name: entity=%s base=%s mix=%s culture=%s gender=%s appearance=%s name=%s%s', entity,
            tostring(traits.base), tostring(result.mix), tostring(result.culture), tostring(traits.gender),
            tostring(traits.appearance), result.name, result.kept and ' (kept)' or ''))
        return result.name, result
    end

    -- The scanner asked for this NPC (ObserveAfter NPCPuppet.CompileScannerChunks).
    function N.onScan(npc)
        local ok, err = pcall(function()
            N.stats.scans = N.stats.scans + 1
            local name = N.nameFor(npc, 'scan')
            if not name then return end
            local applied = options.apply and options.apply(npc, name)
            if applied == true then N.stats.applied = N.stats.applied + 1
            elseif not N.applyLogged then
                N.applyLogged = true
                log('NPC name: the scanner chunk was not changed (NPCPuppet.ConvaiApplyScannerName answered ' .. tostring(applied) .. ')')
            end
        end)
        if not ok and N.lastError ~= tostring(err) then
            N.lastError = tostring(err)
            log('NPC name: scanner hook error: ' .. N.lastError)
        end
    end

    function N.install(observeAfter)
        if N.installed then return end
        observeAfter('NPCPuppet', 'CompileScannerChunks', function(npc) N.onScan(npc) end)
        N.installed = true
    end
    return N
end

return M
