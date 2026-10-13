-- Skippy, the talking smart pistol: an add-on for Cyberpunk Convai (docs/ADDON_API.md, addons/skippy/EVENTS.md).
-- While V holds Skippy (Items.mq007_skippy, the game's own talking gun) it comments on the fight with fresh AI remarks built from
-- what is happening: kills, headshots, limb shots, misses, reloads, V's health, bystanders, enemies, the weapon mode.
--
-- FPS rule: nothing here runs per frame and nothing polls. Every game signal is an Observe/ObserveAfter hook on an event the
-- game already fires. Each handler returns at once unless V holds Skippy, then does a few table writes (and a handful of
-- native reads for a hit or a death) and passes a plain record to engine.lua. Handler time is metered and logged at the end of
-- each fight, so the cost is visible. Latency rule: the remark is offered in the same callback that saw the moment.
--
-- The main mod never depends on this add-on; without the main mod (or with one too old) this prints one line and stays off.
local Skippy = {handle = nil, engine = nil, hooks = {}, S = {}}

local MODES = {'killer', 'puppy'}
local ITEMS = {'Items.mq007_skippy', 'Items.mq007_skippy_post_quest'}   -- the quest gun; the plain gun Regina hands back
local OWN_LINE_BASE = 0x436F6E760000                                    -- subtitle ids of the main mod's own replies
local OWN_LINE_SPAN = 0x100000

-- ---- Small native helpers (each one guarded; a missing function is a missing fact, never an error) ------------------------

local function safe(fn, ...)
    local ok, value = pcall(fn, ...)
    if ok then return value end
    return nil
end

-- A game enum as its name ('Headshot', 'Human'), or nil.
local function enumName(value)
    if value == nil then return nil end
    if type(value) == 'string' then return value end
    local text = safe(function() return value.value end)
    if type(text) == 'string' and text ~= '' then return text end
    text = safe(tostring, value)
    if type(text) ~= 'string' then return nil end
    return text:match('[:%.]([%w_]+)[>%)]?$') or text:match('([%w_]+)$')
end

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    value = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if value == '' or value:match('^LocKey#') then return nil end
    return value:sub(1, limit or 60)
end

local function entityKey(object)
    return safe(function() return tostring(object:GetEntityID().hash) end)
end

local function words(camel)
    if type(camel) ~= 'string' then return nil end
    camel = camel:gsub('Affiliation$', ''):gsub('([a-z])([A-Z])', '%1 %2'):gsub('_', ' ')
    camel = camel:match('^%s*(.-)%s*$')
    if camel == '' or camel == 'NoAffiliation' or camel == 'No' or camel:lower() == 'unknown' then return nil end
    return camel
end

local KINDS = {Human = 'human', Android = 'android', Drone = 'drone', Mech = 'mech', Cerberus = 'cerberus',
    Chimera = 'chimera', Spiderbot = 'spiderbot'}
local RARITIES = {Trash = 'trash', Weak = 'weak', Normal = 'normal', Rare = 'rare', Officer = 'officer', Elite = 'elite',
    Boss = 'boss', MaxTac = 'maxtac'}

-- ---- State ---------------------------------------------------------------------------------------------------------------------

local S = Skippy.S
S.holding = false          -- V holds Skippy (the active weapon), refreshed on events
S.combat = false
S.vanillaUntil = -10       -- the game's own Skippy is speaking until this os.clock()
S.vanillaSeen = false
S.hits = {}                -- entity key -> the last hit V made on it {t, weapon, head, zone, stealth}
S.hitCount = 0
S.stealthSeenAt = nil
S.lastHeldAt = nil         -- when V last held Skippy
S.modeRead = {at = -10, value = 'puppy'}
S.lastMode = nil
S.whereCache = {at = -100}
S.lastDistrict = nil
S.lastHealthAt = -10
S.meter = {}               -- hook name -> {calls, seconds}

local function now() return os.clock() end

-- ---- Reading the game --------------------------------------------------------------------------------------------------------

local function itemIds()
    if Skippy.itemIds then return Skippy.itemIds end
    local ids = {}
    for _, name in ipairs(ITEMS) do
        local id = safe(function() return TweakDBID.new(name) end)
        if id ~= nil then ids[#ids + 1] = {name = name, id = id} end
    end
    Skippy.itemIds = ids
    return ids
end

-- Is Skippy the weapon in V's hands? One read, on an event (a weapon swap, a fight starting), never on a timer.
local function readHolding()
    local handle = Skippy.handle
    local held = safe(function()
        local player = Game.GetPlayer()
        if not player then return false end
        local weapon = ScriptedPuppet.GetActiveWeapon(player)
        if not weapon then return false end
        local tdbid = ItemID.GetTDBID(weapon:GetItemID())
        for _, item in ipairs(itemIds()) do
            if item.name ~= ITEMS[1] and handle and handle:setting('postQuest') == false then
            elseif tdbid == item.id then return true end
        end
        return false
    end)
    return held == true
end

local function gameMode()
    local t = now()
    if t - S.modeRead.at < 3 then return S.modeRead.value end
    local head = safe(function() return Game.GetQuestsSystem():GetFactStr('mq007_skippy_aim_at_head') end)
    S.modeRead = {at = t, value = (type(head) == 'number' and head >= 1) and 'killer' or 'puppy'}
    return S.modeRead.value
end

local function currentMode()
    local handle = Skippy.handle
    local choice = handle and handle:setting('personality')
    local mode
    if choice == 2 then mode = 'killer' elseif choice == 3 then mode = 'puppy' else mode = gameMode() end
    if mode ~= S.lastMode then
        S.lastMode = mode
        if handle then handle:setMode('gun', mode) end
    end
    return mode
end

local function healthPercent()
    return safe(function()
        local player = Game.GetPlayer()
        local value = Game.GetStatPoolsSystem():GetStatPoolValue(player:GetEntityID(), Enum.new('gamedataStatPoolType', 'Health'), true)
        return type(value) == 'number' and value or nil
    end)
end

local function timeOfDay()
    local hour = safe(function() return GameTime.Hours(Game.GetTimeSystem():GetGameTime()) end)
    if type(hour) ~= 'number' then return nil end
    if hour < 5 then return 'night' elseif hour < 8 then return 'dawn' elseif hour < 12 then return 'morning'
    elseif hour < 17 then return 'afternoon' elseif hour < 21 then return 'evening' end
    return 'night'
end

local function heatStage()
    local stage = safe(function() return Game.GetScriptableSystemsContainer():Get('PreventionSystem'):GetHeatStageAsInt() end)
    return type(stage) == 'number' and stage or nil
end

-- District, area, time of day and heat: read on demand (a fight starting, a remark), cached for 20 s.
local function whereNow()
    local t = now()
    if t - S.whereCache.at < 20 then return S.whereCache.value end
    local info = {timeOfDay = timeOfDay(), heat = heatStage()}
    local top, area = safe(function()
        local system = Game.GetScriptableSystemsContainer():Get('PreventionSystem')
        local district = system and system:GetCurrentDistrict()
        local record = district and TweakDBInterface.GetDistrictRecord(district:GetDistrictID())
        if not record then return nil end
        local specific = enumName(record:EnumName()) or tostring(record:EnumName())
        local root, guard = record, 0
        while root and root:ParentDistrict() and guard < 6 do root, guard = root:ParentDistrict(), guard + 1 end
        return tostring(root:EnumName()), tostring(specific)
    end)
    if type(top) == 'string' then
        info.district = words(top) or top
        if area ~= top then info.area = words(area) or area end
    end
    S.whereCache = {at = t, value = info}
    return info
end

-- The hostile V is facing, for the opening line (one read when a fight starts).
local function lookAtNow()
    return safe(function()
        local player = Game.GetPlayer()
        local npc = Game.GetTargetingSystem():GetLookAtObject(player, true, true)
        if not npc or not npc:IsNPC() or not npc:IsAttached() or npc:IsDeadNoStatPool() then return nil end
        if npc:GetAttitudeAgent():GetAttitudeTowards(player:GetAttitudeAgent()) ~= Enum.new('EAIAttitude', 'AIA_Hostile') then return nil end
        local name = clean(npc:GetTweakDBFullDisplayName(true), 60)
        local kind = KINDS[enumName(safe(function() return npc:GetNPCType() end)) or '']
        if not name and not kind then return nil end
        return {name = name, kind = kind}
    end)
end

local function isCivilian(npc)
    local civilian = safe(function() return npc:IsCrowd() == true or npc:IsCharacterCivilian() == true end)
    if not civilian then return false end
    if safe(function() return npc:IsCharacterPolice() == true or npc:IsPrevention() == true or npc:IsCharacterGanger() == true end) then
        return false
    end
    return true
end

-- A plain record of a victim (everything guarded). `weapon` is filled in by the caller.
local function victimRecord(npc, wantName)
    local v = {}
    v.id = entityKey(npc)
    v.kind = KINDS[enumName(safe(function() return npc:GetNPCType() end)) or ''] or 'other'
    v.rarity = RARITIES[enumName(safe(function() return npc:GetNPCRarity() end)) or '']
    local faction = safe(function() return enumName(npc:GetAffiliation()) end)
    if not faction then faction = safe(function() return enumName(npc:GetRecord():Affiliation():Type()) end) end
    v.faction = words(faction)
    if wantName then v.name = clean(safe(function() return npc:GetTweakDBFullDisplayName(true) end), 60) end
    v.cyberpsycho = safe(function() return npc:IsCharacterCyberpsycho() == true end) or nil
    v.police = safe(function() return npc:IsCharacterPolice() == true or npc:IsPrevention() == true end) or nil
    v.civilian = isCivilian(npc) or nil
    v.distance = safe(function()
        local a, b = Game.GetPlayer():GetWorldPosition(), npc:GetWorldPosition()
        return math.floor(math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 + (a.z - b.z) ^ 2) + 0.5)
    end)
    return v
end

-- Hit zone from the hit event. The game's hit shapes name the zone; anything that cannot be read leaves it unknown.
local function zoneOf(evt)
    local text = safe(function()
        local shape = evt.hitRepresentationResult.hitShapes[1]
        local data = shape and shape.userData
        if not data then return nil end
        if safe(function() return data:IsHead() == true end) then return 'head' end
        local zone = safe(function() return data:GetHitReactionZone() end)
        return zone ~= nil and (enumName(zone) or tostring(zone)) or nil
    end)
    if type(text) ~= 'string' then return nil end
    text = text:lower()
    if text:find('head') then return 'head' elseif text:find('leg') then return 'leg' elseif text:find('arm') then return 'arm'
    elseif text:find('torso') or text:find('chest') or text:find('body') then return 'torso' end
    return nil
end

local function hitFlag(attack, name)
    return safe(function() return attack:HasFlag(Enum.new('hitFlag', name)) == true end) == true
end

-- What did the damage: skippy (V's gun while holding it), melee, quickhack, explosion, other.
local function weaponOf(attack)
    if hitFlag(attack, 'QuickHack') then return 'quickhack' end
    local kind = enumName(safe(function() return attack:GetAttackType() end))
    if kind == 'Ranged' or kind == 'Direct' then return 'skippy' end
    if kind == 'Melee' or kind == 'QuickMelee' or kind == 'StrongMelee' or kind == 'WhipAttack' then return 'melee' end
    if kind == 'Hack' then return 'quickhack' end
    if kind == 'Explosion' then return 'explosion' end
    return 'other'
end

-- ---- Metering --------------------------------------------------------------------------------------------------------------

-- Every hook goes through here: it returns at once unless V holds Skippy, never throws, and records its own time.
local function hook(name, gate, fn)
    return function(...)
        if gate == 'holding' then
            if not S.holding then return end
        -- An ungated hook (a weapon swap, a crosshair start) reads the player and the weapon: never while the main mod has
        -- released its session (a load or detach), when those objects are being destroyed. 'sessionStarted' reads it afresh.
        elseif not (Skippy.handle and Skippy.handle:live()) then return end
        local t0 = os.clock()
        local ok, err = pcall(fn, ...)
        local m = S.meter[name]
        if not m then m = {calls = 0, seconds = 0, errors = 0}; S.meter[name] = m end
        m.calls, m.seconds = m.calls + 1, m.seconds + (os.clock() - t0)
        if not ok then
            m.errors = m.errors + 1
            if m.errors <= 2 and Skippy.handle then Skippy.handle:log('hook ' .. name .. ' failed: ' .. tostring(err)) end
        end
    end
end

local function logMeter()
    local handle = Skippy.handle
    if not handle then return end
    local parts = {}
    for name, m in pairs(S.meter) do
        parts[#parts + 1] = string.format('%s %d calls %.1f ms', name, m.calls, m.seconds * 1000)
    end
    table.sort(parts)
    if #parts > 0 then handle:log('hook cost this fight: ' .. table.concat(parts, '; ')) end
    S.meter = {}
end

-- ---- Observers -------------------------------------------------------------------------------------------------------------

local function observe(name, after, class, method, fn)
    local register = after and ObserveAfter or Observe
    local ok, err = pcall(register, class, method, fn)
    Skippy.hooks[name] = ok
    if not ok and Skippy.handle then Skippy.handle:log('could not hook ' .. class .. '.' .. method .. ': ' .. tostring(err)) end
end

-- Which signal tells the game's own Skippy is talking: a subtitle line with Skippy as the speaker (the main mod's own replies
-- carry ids in its range and are skipped), or an Invisible dialogue line while V holds Skippy.
local function vanillaLine(line)
    local number = safe(function()
        local hash = line.id.hash
        local digits = tostring(hash):match('(%d+)')
        return digits and tonumber(digits) or nil
    end)
    if number and number >= OWN_LINE_BASE and number < OWN_LINE_BASE + OWN_LINE_SPAN then return end
    local name = safe(function()
        if type(line.speakerName) == 'string' and line.speakerName:find('%S') then return line.speakerName end
        if line.speaker then return line.speaker:GetDisplayName() end
        return nil
    end)
    local invisible = enumName(safe(function() return line.type end)) == 'Invisible'
    local skippy = type(name) == 'string' and name:lower():find('skippy', 1, true) ~= nil
    if not (skippy or (invisible and S.holding)) then return end
    local duration = safe(function() return tonumber(line.duration) end)
    if type(duration) ~= 'number' or duration <= 0 or duration > 20 then duration = 5 end
    S.vanillaUntil = now() + duration + 0.4
    if not S.vanillaSeen then
        S.vanillaSeen = true
        if Skippy.handle then Skippy.handle:log('the game\'s own Skippy line seen (speaker ' .. tostring(name) .. ', type ' .. tostring(invisible and 'Invisible' or '?')
            .. ', ' .. string.format('%.1f', duration) .. ' s); remarks wait for it') end
    end
    if Skippy.engine then Skippy.engine:vanillaSpoke() end
end

local function installHooks()
    local engine = Skippy.engine

    -- Weapon swap: the one place the active weapon is read again (rare; a draw, a holster, a swap).
    local function weaponChanged()
        Skippy.refreshHolding('weapon-swap')
    end
    observe('weapon-swap', true, 'gameuiCrosshairContainerController', 'OnWeaponSwap', hook('weapon-swap', nil, weaponChanged))
    observe('crosshair-init', true, 'gameuiCrosshairContainerController', 'OnInitialize', hook('crosshair-init', nil, weaponChanged))

    -- Stealth: remembered so the next fight can say it began from stealth.
    observe('combat-state', true, 'PlayerPuppet', 'OnCombatStateChanged', hook('combat-state', nil, function(_, state)
        if tonumber(state) == 3 then S.stealthSeenAt = now() end
    end))

    -- A death: V's kill, a companion's kill or a bystander. One call per NPC death.
    observe('death', false, 'NPCPuppet', 'OnDeath', hook('death', 'holding', function(npc, evt)
        local killer = evt and evt.instigator
        if not killer then return end
        local byV = safe(function() return killer:IsPlayer() == true end)
        local companion = false
        if not byV then companion = safe(function() return ScriptedPuppet.IsPlayerCompanion(killer) == true end) == true end
        if not byV and not companion then return end
        local key = entityKey(npc)
        local rec = key and S.hits[key] or nil
        if rec and now() - rec.t > 4 then rec = nil end
        local v = victimRecord(npc, engine.f.named < 3)
        if v.civilian and companion then return end
        if companion then v.weapon = 'companion'
        elseif rec then v.weapon, v.zone, v.headshot, v.stealth = rec.weapon, rec.zone, rec.head or nil, rec.stealth or nil
        else v.weapon = 'takedown'; v.stealth = (not S.combat) or nil end
        v.lethal = true
        if key then S.hits[key] = nil end
        engine:onKill(v)
    end))

    -- A hit by V on an NPC: counts shots that landed, finds the zone and bystanders. At most a few reads, and only for V's hits.
    observe('hit', true, 'NPCPuppet', 'OnHit', hook('hit', 'holding', function(npc, evt)
        local attack = evt and evt.attackData
        if not attack then return end
        local instigator = safe(function() return attack:GetInstigator() end)
        if not instigator or not safe(function() return instigator:IsPlayer() == true end) then return end
        if hitFlag(attack, 'DamageOverTime') then return end
        local weapon = weaponOf(attack)
        local civilian = isCivilian(npc)
        local zone = zoneOf(evt)
        local key = entityKey(npc)
        if key then
            if S.hitCount >= 24 then S.hits, S.hitCount = {}, 0 end
            if not S.hits[key] then S.hitCount = S.hitCount + 1 end
            S.hits[key] = {t = now(), weapon = weapon, zone = zone, head = hitFlag(attack, 'Headshot'),
                stealth = hitFlag(attack, 'StealthHit') or hitFlag(attack, 'SilentKillModifier')}
        end
        if civilian then
            engine:onHit({civilian = true, id = key, victim = victimRecord(npc, false)})
        elseif weapon == 'skippy' then
            engine:onHit({zone = zone, id = key, weapon = weapon, victim = (zone == 'arm' or zone == 'leg') and victimRecord(npc, false) or nil})
        end
    end))

    -- Put down without dying (defeated, unconscious). V's neutralisations only.
    observe('neutralized', false, 'PlayerPuppet', 'OnTargetNeutraliziedEvent', hook('neutralized', 'holding', function(_, evt)
        local kind = enumName(evt and evt.type)
        if kind ~= 'Defeated' and kind ~= 'Unconscious' then return end
        local npc = safe(function() return Game.FindEntityByID(evt.targetID) end)
        if not npc then return end
        local v = victimRecord(npc, engine.f.named < 3)
        v.lethal, v.weapon = false, 'skippy'
        engine:onDowned(v)
    end))

    -- Shots and reloads: counters only.
    observe('shot', true, 'ShootEvents', 'OnEnter', hook('shot', 'holding', function() engine:onShot() end))
    observe('reload', true, 'ReloadEvents', 'OnEnter', hook('reload', 'holding', function()
        local empty = safe(function() return WeaponObject.IsMagazineEmpty(ScriptedPuppet.GetActiveWeapon(Game.GetPlayer())) == true end)
        engine:onReload({empty = empty})
    end))

    -- V's health: only a loss is looked at (regeneration ticks return at once), at most 6 reads a second.
    observe('health', true, 'PlayerPuppet', 'OnHealthUpdateEvent', hook('health', 'holding', function(_, evt)
        local diff = evt and evt.healthDifference
        if type(diff) ~= 'number' or diff >= 0 then return end
        local t = now()
        if t - S.lastHealthAt < 0.15 then return end
        S.lastHealthAt = t
        engine:onHealth(healthPercent())
    end))
    observe('heal', true, 'PlayerPuppet', 'OnStatusEffectUsedHealingItemOrCyberwareApplied', hook('heal', 'holding', function()
        engine:onHeal(healthPercent())
    end))

    -- Enemies, gore, police heat.
    observe('combatants', true, 'PlayerPuppet', 'OnNumberOfCombatantsChanged', hook('combatants', 'holding', function(_, value)
        engine:onCombatants(tonumber(value))
    end))
    observe('dismember', true, 'PlayerPuppet', 'OnDismembermentInstigated', hook('dismember', 'holding', function(_, evt)
        local part = enumName(evt and evt.bodyPart)
        engine:onDismember({bodyPart = part and part:lower() or nil, explosion = evt and evt.attackIsExplosion == true})
    end))
    observe('heat', true, 'PreventionSystem', 'OnHeatChanged', hook('heat', 'holding', function(system)
        local stage = safe(function() return system:GetHeatStageAsInt() end)
        engine:onHeat(tonumber(stage))
    end))

    -- The game's own Skippy lines (the same two subtitle hooks the main mod's dialogue reader uses).
    -- Gated on holding like every other hook: while V does not hold Skippy the call returns at once on one boolean check (no clock read,
    -- no meter entry, no line inspected), because the game shows many subtitle lines and Skippy says nothing then anyway.
    observe('subtitles-a', true, 'BaseSubtitlesGameController', 'ShowDialogLines', hook('subtitles-a', 'holding', function(_, lines)
        if type(lines) ~= 'table' then return end
        for _, line in ipairs(lines) do vanillaLine(line) end
    end))
    observe('subtitles-b', true, 'BaseSubtitlesGameController', 'OnShowDialogLine', hook('subtitles-b', 'holding', function(_, value)
        local lines = safe(function() return FromVariant(value) end)
        if type(lines) ~= 'table' then return end
        for _, line in ipairs(lines) do vanillaLine(line) end
    end))
end

-- ---- Holding Skippy ------------------------------------------------------------------------------------------------------------

-- Re-reads whether V holds Skippy. Called on a weapon swap, a session start and a fight start only.
function Skippy.refreshHolding(why)
    local handle, engine = Skippy.handle, Skippy.engine
    if not handle then return false end
    local was = S.holding
    local held = handle:setting('enabled') ~= false and readHolding()
    S.holding = held
    if held and not was then
        local t = now()
        -- Starting the game with Skippy in hand is not a draw; the greeting is for picking him up.
        local away = why ~= 'session' and (not S.lastHeldAt or t - S.lastHeldAt > 60)
        S.lastHeldAt = t
        local changed = engine:checkMode()
        -- The place is read now so the prepared lines (stock) are for where V is.
        local where = whereNow()
        local district = where and where.district or nil
        engine:declareStock()
        S.lastDistrict = district
        handle:prepare('gun')
        if away and not changed and not S.combat then engine:onDrawn() end
    elseif was and not held then
        S.lastHeldAt = now()
        handle:cancel('gun')
        engine.cand = nil
    end
    return held
end

-- ---- Registration ----------------------------------------------------------------------------------------------------------------

local function loadSibling(name)
    local ok, module = pcall(dofile, name)
    if ok and type(module) == 'table' then return module end
    ok, module = pcall(dofile, 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvaiSkippy/' .. name)
    if ok and type(module) == 'table' then return module end
    return nil
end

registerForEvent('onInit', function()
    local main = GetMod('CyberpunkConvai')
    local api = type(main) == 'table' and main.addons or nil
    if not api then
        print('[Skippy] Cyberpunk Convai is not installed (or is older than the add-on API); Skippy stays off.')
        return
    end
    local handle, reason = api.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'})
    if not handle then
        print('[Skippy] Not registered: ' .. tostring(reason))
        return
    end
    Skippy.handle = handle
    local Engine = loadSibling('engine.lua')
    if not Engine then
        print('[Skippy] engine.lua is missing; Skippy stays off.')
        return
    end

    -- minGap 2: the main mod's Remarks setting decides how often Skippy speaks; the speaker adds no gap of its own.
    handle:speaker({id = 'gun', name = 'Skippy', anchor = 'player', minGap = 2,
        available = function() return S.holding == true end})

    handle:settings({title = 'Skippy', description = 'The talking smart pistol comments on the fight while you hold it.', items = {
        {id = 'enabled', label = 'Skippy remarks', kind = 'bool', default = true,
            description = 'Skippy speaks about the fight while you hold him. Needs a free Mistral key or the Local AI pack.'},
        {id = 'personality', label = 'Personality', kind = 'select', default = 1,
            elements = {'From the game', 'Stone Cold Killer', 'Puppy-Loving Pacifist'},
            description = 'From the game follows the choice you made in the quest (and changes when the game changes it).'},
        {id = 'postQuest', label = 'After-quest Skippy', kind = 'bool', default = true,
            description = 'Also talk when you hold the plain gun Regina hands back after the quest.'},
    }})

    Skippy.engine = Engine.new({
        now = now,
        remark = function(name, spec) return handle:remark('gun', spec) end,
        cancel = function() handle:cancel('gun') end,
        mode = currentMode,
        where = whereNow,
        lookAt = lookAtNow,
        vanillaBusy = function() return now() < S.vanillaUntil end,
        stock = type(handle.stock) == 'function' and function(event, spec) return handle:stock('gun', event, spec) end or nil,
        remember = function(text) handle:remember('gun', text) end,
        log = function(text) handle:log(text) end,
    })
    handle:setMode('gun', currentMode())

    handle:on('sessionStarted', function() Skippy.refreshHolding('session') end)
    handle:on('sessionEnded', function()
        S.holding, S.combat, S.hits, S.hitCount = false, false, {}, 0
        Skippy.engine:reset()
    end)
    handle:on('combatStarted', function()
        S.combat = true
        Skippy.refreshHolding('fight')
        if not S.holding then return end
        local engine = Skippy.engine
        engine:checkMode()
        local where = whereNow()
        if where and where.district ~= S.lastDistrict then S.lastDistrict = where.district; engine:declareStock() end
        local seen = S.stealthSeenAt
        engine:start({stealthOpening = seen ~= nil and now() - seen < 30, healthPct = healthPercent(),
            inVehicle = handle:state().vehicle == true})
        handle:prepare('gun')
    end)
    handle:on('combatEnded', function()
        S.combat = false
        if S.holding then Skippy.engine:stop() end
        S.hits, S.hitCount = {}, 0
        logMeter()
    end)
    handle:on('settingChanged', function(change)
        if change.id == 'personality' then
            local before = S.lastMode
            S.modeRead.at = -10
            local after = currentMode()
            if S.holding and before and before ~= after then Skippy.engine:declareStock() end
        elseif change.id == 'enabled' or change.id == 'postQuest' then
            Skippy.refreshHolding('setting')
        end
    end)

    installHooks()
    handle:log('Skippy ready; hooks installed: ' .. (function()
        local names = {}
        for name, ok in pairs(Skippy.hooks) do names[#names + 1] = name .. (ok and '' or '(failed)') end
        table.sort(names)
        return table.concat(names, ', ')
    end)())
end)

return Skippy
