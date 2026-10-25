-- Recent in-game dialogue for mod conversations (docs/GAME_DIALOGUE_CONTEXT.md).
-- Read-only. Observes the game's subtitle line feed and V's chosen dialogue
-- options, keeps a short bounded buffer of plain strings (never a native
-- handle), and hands a snapshot to the next mod turn. The bridge scopes that
-- snapshot to the addressed character; nothing here is written to memory.
local M = {}
M.MAX_AGE, M.MAX_LINES, M.MAX_AMBIENT, M.MAX_TEXT = 180, 40, 10, 600
-- Decision ledger (docs/QUEST_DECISIONS.md section 4.4): ON by default (settings.decisionLedger, true since 2026-10-23), recorded only when options.ledgerEnabled() is true.
M.LEDGER_MAX, M.LEDGER_TEXT, M.LEDGER_LABEL, M.LEDGER_PATH = 40, 120, 80, 'runtime/decision-ledger.json'
local DUPLICATE_WINDOW, PRESENT_RADIUS = 6, 15
-- mod/subtitles.lua shows its own replies as CRUID(0x436F6E760000 + serial).
local OWN_LINE_BASE = 0x436F6E760000
-- Native scnDialogLineType names, and what each means here. Lines whose type
-- is not listed (TV, radio broadcasts, scene comments, narrator, invisible,
-- speakerless cinematic text) are never recorded.
M.TYPES = {'Regular', 'Holocall', 'SceneComment', 'OverHead', 'Radio', 'GlobalTV', 'Invisible',
    'OverHeadAlwaysVisible', 'OwnerlessRegular', 'AlwaysCinematicNoSpeaker', 'GlobalTVAlwaysVisible', 'Narrator'}
local POLICY = {Regular = 'scene', OwnerlessRegular = 'scene', Holocall = 'phone',
    OverHead = 'ambient', OverHeadAlwaysVisible = 'ambient', Radio = 'call-only'}

-- Lines that put a game voice on the air, for the add-on API (mod/addons.lua M.gameLine): a remark that asked to be patient does not start
-- over them. Crowd chatter (OverHead), TV and the rest never hold a remark back. Radio is in because a vehicle's own voice (the Delamain cab)
-- may come as one.
local VOICE_LINES = {Regular = true, OwnerlessRegular = true, Holocall = true, SceneComment = true, Radio = true}
local LINE_MIN, LINE_MAX, WORDS_PER_SECOND = 1.5, 10, 2.5

local function clean(value, limit)
    if type(value) ~= 'string' then return nil end
    local text = value:gsub('<[^>]*>', ''):gsub('%c', ' '):gsub('%s+', ' '):match('^%s*(.-)%s*$')
    if text == '' or text:match('^LocKey#') then return nil end
    if #text > limit then
        -- Cut on a UTF-8 boundary, never inside a character.
        local cut = limit - 3
        while cut > 0 and text:byte(cut + 1) and text:byte(cut + 1) >= 0x80 and text:byte(cut + 1) < 0xC0 do cut = cut - 1 end
        text = text:sub(1, cut) .. '...'
    end
    return text
end
local function profileKey(value)
    if type(value) ~= 'string' or not value:match('^[a-z0-9%-]+$') or #value > 80 then return nil end
    if value:match('^resident%-') then return nil end -- generic crowd profiles are not identities
    return value
end
local function entityId(value)
    value = value ~= nil and tostring(value) or nil
    return value and value:match('^%d+ULL$') and #value <= 23 and value or nil
end

-- Default native adapter. Every call is guarded by the caller; tests replace it.
local function nativeAdapter()
    local N, enums = {}, nil
    local function enum(kind, name)
        local ok, value = pcall(Enum.new, kind, name)
        return ok and value or nil
    end
    function N.player() return Game.GetPlayer() end
    function N.ready(player)
        return player ~= nil and player:IsAttached() and not player:IsDeadNoStatPool()
    end
    function N.entity(object) return tostring(object:GetEntityID().hash) end
    function N.braindance()
        local defs = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(defs.Braindance):GetBool(defs.Braindance.IsActive) == true
    end
    function N.replacer(player) return player:IsReplacer() == true end
    function N.playerCombat(player) return player:IsInCombat() == true end
    function N.npcCombat(object) return object:IsNPC() and NPCPuppet.IsInCombat(object) == true end
    function N.isVehicle(object) return object:IsVehicle() == true end
    function N.call()
        local defs = Game.GetAllBlackboardDefs()
        local call = FromVariant(Game.GetBlackboardSystem():Get(defs.UI_ComDevice):GetVariant(defs.UI_ComDevice.PhoneCallInformation))
        if not call or call.callPhase ~= Enum.new('questPhoneCallPhase', 'StartCall') then return nil end
        local okName, contact = pcall(function() return call.contactName.value end)
        if not okName or type(contact) ~= 'string' then
            okName, contact = pcall(function() return Game.NameToString(call.contactName) end)
        end
        return {active = true, contact = okName and type(contact) == 'string' and contact or nil}
    end
    function N.lineType(value)
        if not enums then
            enums = {}
            for _, name in ipairs(M.TYPES) do enums[name] = enum('scnDialogLineType', name) end
        end
        for _, name in ipairs(M.TYPES) do
            if enums[name] ~= nil and value == enums[name] then return name end
        end
        -- Some CET wrappers compare enum values by number only.
        local ok, number = pcall(EnumInt, value)
        if ok and type(number) == 'number' then
            for _, name in ipairs(M.TYPES) do
                local same, other = pcall(EnumInt, enums[name])
                if same and other == number then return name end
            end
        end
        return 'unknown'
    end
    -- The text the player was shown: a Kiroshi/mother-tongue line shows its translation.
    function N.text(line)
        local tagged = false
        pcall(function()
            tagged = scnDialogLineData.HasKiroshiTag(line) or scnDialogLineData.HasMothertongueTag(line)
        end)
        if tagged then
            local ok, display = pcall(function() return scnDialogLineData.GetDisplayText(line) end)
            if ok and display then
                local translated = display.translation
                if type(translated) == 'string' and translated:find('%S') then return translated end
                if type(display.text) == 'string' and display.text:find('%S') then return display.text end
            end
        end
        return line.text
    end
    function N.speakerName(line)
        if type(line.speakerName) == 'string' and line.speakerName:find('%S') then return line.speakerName end
        if line.speaker then return line.speaker:GetDisplayName() end
        return nil
    end
    function N.lineId(line) return tostring(line.id) end
    -- What spoke a TV line (scnDialogLineData.speaker, a wref<GameObject>): {id = its EntityID when it is a TV (class TV, or a device whose
    -- controller is a TVControllerPS), class = its class name}, or nil when the line has no speaker. Music and TV only (noteHeard).
    function N.tvSource(line)
        local speaker = line.speaker
        if speaker == nil then return nil end
        local named, class = pcall(function() return Game.NameToString(speaker:GetClassName()) end)
        class = named and type(class) == 'string' and class ~= '' and class or '?'
        local isTv = speaker:IsA('TV') == true
        if not isTv then
            local ok, ps = pcall(function() return speaker:GetDevicePS() end)
            isTv = ok and ps ~= nil and ps:IsA('TVControllerPS') == true
        end
        return {id = isTv and speaker:GetEntityID() or nil, class = class}
    end
    function N.lineNumber(line)
        local ok, value = pcall(function() return line.id.hash end)
        local digits = tostring(ok and value ~= nil and value or line.id):match('(%d+)')
        return digits and tonumber(digits) or nil
    end
    function N.fromVariant(value) return FromVariant(value) end
    function N.dialogChoice(value)
        return value.isSuccess == true and value.visualizerType == Enum.new('EVisualizerType', 'Dialog')
    end
    function N.activeHub()
        local defs = Game.GetAllBlackboardDefs()
        return Game.GetBlackboardSystem():Get(defs.UIInteractions):GetInt(defs.UIInteractions.ActiveChoiceHubID)
    end
    function N.localized(text)
        if type(text) == 'string' and text:match('^LocKey#') then return GetLocalizedText(text) end
        return text
    end
    function N.subtitles() return convaiSubtitles end
    -- Add-on lines (docs/ADDON_API.md, "Replacing the game's own lines"). Stops the named Wwise events on the line's own speaker:
    -- the engine pairs Stop with the Play event of the same name (the game's scripts do exactly that), scoped to one entity so
    -- other speakers using the same event are untouched. Returns what was done, for the log, and a function that sends the same
    -- stops again (it holds the entity id value and the event names, never the entity: a scene voice can start a moment after its
    -- subtitle line, and a Stop that came first finds nothing to stop; the add-on host repeats it a few times, see addons.lua).
    function N.stopAudio(line, events)
        if type(events) ~= 'table' or #events == 0 then return 'no-event-known' end
        local speaker = line.speaker
        if not speaker then return 'no-speaker' end
        local id = speaker:GetEntityID()
        local names = {}
        for index, name in ipairs(events) do names[index] = name end
        local function send()
            local system = Game.GetAudioSystem()
            for _, name in ipairs(names) do system:Stop(CName.new(name), id) end
        end
        send()
        return 'stop-sent(' .. table.concat(names, ',') .. ')', send
    end
    -- The fallback when the subtitle override could not be installed: hide the line the HUD has just been given.
    function N.hideLine(line)
        local defs = Game.GetAllBlackboardDefs()
        Game.GetBlackboardSystem():Get(defs.UIGameData):SetVariant(defs.UIGameData.HideDialogLine, ToVariant({line.id}, 'array:CRUID'), true)
        return true
    end
    return N
end

local Instance = {}
Instance.__index = Instance

-- options: now(), enabled(), resolve(speaker) -> profileKey, name;
-- resolveName(name) -> profileKey; contactKey(contact) -> profileKey;
-- present() -> {profileKey}; native (adapter override); observe (hook registrar); log(line) (the first sighting of each hook).
function M.new(options)
    options = options or {}
    local self = setmetatable({options = options, native = options.native or nativeAdapter(), fired = {}}, Instance)
    self:reset('created')
    self.counts = {hooks = {}, types = {}, skipped = {}, muted = {}, recorded = 0}
    return self
end

function Instance:now()
    local value = self.options.now and self.options.now() or os.time()
    return type(value) == 'number' and value or os.time()
end
function Instance:enabled()
    if not self.options.enabled then return true end
    local ok, value = pcall(self.options.enabled)
    return ok and value == true
end
function Instance:count(group, key)
    local bucket = self.counts[group]
    bucket[key] = (bucket[key] or 0) + 1
end
function Instance:skip(reason) self:count('skipped', reason); return false, reason end
local function call(fn, ...)
    if type(fn) ~= 'function' then return nil end
    local ok, a, b = pcall(fn, ...)
    if ok then return a, b end
    return nil
end

function Instance:reset(reason)
    self.lines, self.seen, self.hubs, self.serial = {}, {}, {}, self.serial or 0
    self.noted, self.notedCount = {}, 0
    self.presentAt, self.presentKeys = nil, nil
    -- The TV lines (Music and TV, noteHeard) are not game dialogue and survive the context being switched off; anything else clears them.
    if reason ~= 'disabled' or self.heard == nil then
        self.heard, self.heardIds, self.heardCount, self.heardTvSource, self.heardSpeaker = {}, {}, 0, nil, nil
    end
    self.resetReason = reason
end

function Instance:prune(now)
    local kept, ambient = {}, 0
    for index = #self.lines, 1, -1 do
        local row = self.lines[index]
        if now - row.at <= M.MAX_AGE and #kept < M.MAX_LINES then
            if row.channel ~= 'ambient' or ambient < M.MAX_AMBIENT then
                if row.channel == 'ambient' then ambient = ambient + 1 end
                table.insert(kept, 1, row)
            end
        end
    end
    self.lines = kept
    for id, at in pairs(self.seen) do
        if now - at > M.MAX_AGE then self.seen[id] = nil end
    end
end

function Instance:present(now)
    if self.presentAt == now and self.presentKeys then return self.presentKeys end
    local keys, seen = {}, {}
    for _, key in ipairs(call(self.options.present, PRESENT_RADIUS) or {}) do
        key = profileKey(key)
        if key and not seen[key] and #keys < 6 then seen[key] = true; keys[#keys + 1] = key end
    end
    self.presentAt, self.presentKeys = now, keys
    return keys
end

function Instance:push(row, now)
    -- One speaker repeating the same words within a few seconds is one line
    -- (a re-shown or fast-forwarded line under a new native id).
    for index = #self.lines, 1, -1 do
        local other = self.lines[index]
        if now - other.at > DUPLICATE_WINDOW then break end
        if other.text == row.text and other.speaker == row.speaker and other.entity == row.entity then
            return self:skip('repeated')
        end
    end
    self.serial = self.serial + 1
    row.id, row.at = 'g-' .. tostring(self.serial), now
    self.lines[#self.lines + 1] = row
    self.counts.recorded = self.counts.recorded + 1
    self:prune(now)
    -- A recorded line, for Johnny speaks up (init.lua, docs/JOHNNY_IN_YOUR_HEAD.md): one call per game line, nothing when unset.
    if type(self.options.onRow) == 'function' then pcall(self.options.onRow, row) end
    return true
end

function Instance:ownLine(line)
    local N = self.native
    local subtitles = call(N.subtitles)
    if type(subtitles) ~= 'table' then return false end
    local current = subtitles.line
    if current and call(N.lineId, current) and call(N.lineId, current) == call(N.lineId, line) then return true end
    local number, serial = call(N.lineNumber, line), tonumber(subtitles.serial) or 0
    return number ~= nil and number > OWN_LINE_BASE and number <= OWN_LINE_BASE + serial + 1
end

-- Tells the add-on host that a game voice is speaking (options.onGameLine(seconds, kind)), once per line, for the add-ons that wait for
-- it. Independent of the "game dialogue context" setting; costs one table lookup when no add-on is registered (options.onGameLineWanted).
-- The line's own duration is used when the game gives a sensible one, else it is estimated from the words.
function Instance:noteLine(line)
    local options = self.options
    if type(options.onGameLine) ~= 'function' then return false end
    if type(options.onGameLineWanted) == 'function' and call(options.onGameLineWanted) ~= true then return false end
    local N, now = self.native, self:now()
    local id = call(N.lineId, line)
    if not id or self.noted[id] then return false end
    if self.notedCount >= 64 then self.noted, self.notedCount = {}, 0 end
    self.noted[id], self.notedCount = now, self.notedCount + 1
    if self:ownLine(line) then return false end
    -- A line an add-on declared as its character's (matchLine) goes to ruleLine, whatever its type.
    local rule, muted = self:ruleFor(line)
    if rule then
        local seconds, measured = self:lineSeconds(line)
        return self:ruleLine(line, rule, muted == true, seconds, measured)
    end
    local kind = call(N.lineType, line.type) or 'unknown'
    if not VOICE_LINES[kind] then return false end
    local seconds, measured = self:lineSeconds(line)
    pcall(options.onGameLine, seconds, kind, measured)
    return true
end

-- What a TV nearby has said (Settings > Dynamic info > Music and TV, mod/media-context.lua): the last HEARD_KEEP lines of type GlobalTV or
-- GlobalTVAlwaysVisible, each capped at HEARD_TEXT characters, with the time they were heard. Fed by the same subtitle callbacks as everything
-- above (no hook of its own), only while options.heardWanted() is true (the Music and TV switch; one boolean read per line otherwise), and kept
-- apart from the recorded game dialogue: it is not part of capture(), the policy table, the buffer or what Johnny's remarks and the add-ons hear.
-- A car radio's DJ is a line of type Radio from a vehicle: the policy table skips those and so does this.
M.HEARD_KEEP, M.HEARD_TEXT, M.HEARD_IDS = 3, 160, 8
local HEARD_TYPES = {GlobalTV = true, GlobalTVAlwaysVisible = true}
function Instance:noteHeard(line)
    local wanted = self.options.heardWanted
    if type(wanted) ~= 'function' or call(wanted) ~= true then return false end
    local N = self.native
    local id = call(N.lineId, line)
    if not id or self.heardIds[id] then return false end
    local kind = call(N.lineType, line.type)
    if not HEARD_TYPES[kind] then return false end
    -- The two subtitle hooks show the same line: remembered by its id for a few lines only.
    if self.heardCount >= M.HEARD_IDS then self.heardIds, self.heardCount = {}, 0 end
    self.heardIds[id], self.heardCount = true, self.heardCount + 1
    -- Which TV said it, so mod/media-context.lua can find that TV by its ID (the targeting query does not list TVs). A few reads per TV line.
    local source = call(N.tvSource, line)
    self.heardSpeaker = {class = type(source) == 'table' and source.class or 'none', at = self:now()}
    if type(source) == 'table' and source.id ~= nil then self.heardTvSource = {id = source.id, at = self:now()} end
    local text = clean(call(N.text, line), M.HEARD_TEXT)
    if not text then return false end
    local now = self:now()
    local last = self.heard[#self.heard]
    if last and last.text == text and now - last.at <= DUPLICATE_WINDOW then last.at = now; return false end
    self.heard[#self.heard + 1] = {text = text, at = now}
    while #self.heard > M.HEARD_KEEP do table.remove(self.heard, 1) end
    return true
end

-- The newest TV line heard at most maxAge seconds ago: its text and its age in seconds, or nil.
function Instance:heardMedia(maxAge)
    local now, last = self:now(), self.heard[#self.heard]
    if not last then return nil end
    local age = math.max(0, now - last.at)
    if age > (tonumber(maxAge) or 60) then return nil end
    return last.text, age
end

-- The TV that spoke a TV line at most maxAge seconds ago: its EntityID, the age in seconds, and the class of whatever spoke the newest TV
-- line ('none' for a line without a speaker), for probe.log. nil when no TV spoke (the class is still given when a line was heard).
function Instance:heardTv(maxAge)
    local now, limit = self:now(), tonumber(maxAge) or 60
    local speaker = self.heardSpeaker
    local class = speaker and now - speaker.at <= limit and speaker.class or nil
    local source = self.heardTvSource
    if not source then return nil, nil, class end
    local age = math.max(0, now - source.at)
    if age > limit then return nil, nil, class end
    return source.id, age, class
end

-- How long a game line lasts: its own duration when the game gives a sensible one, else an estimate from its words.
function Instance:lineSeconds(line)
    local N = self.native
    local seconds = nil
    pcall(function() seconds = tonumber(line.duration) end)
    local measured = seconds ~= nil and seconds == seconds and seconds >= 0.3 and seconds <= 30
    if not measured then
        local words = 0
        for _ in tostring(call(N.text, line) or ''):gmatch('%S+') do words = words + 1 end
        seconds = words / WORDS_PER_SECOND + 0.8
    end
    return math.max(LINE_MIN, math.min(LINE_MAX, seconds)), measured
end

-- ---- Lines an add-on replaces (options.matchWanted / matchLine / onMuted; mod/addons.lua handle:replaceGameLines) ------------------
-- matchWanted() is one boolean read: false until an add-on has declared a rule, so nothing below runs for an ordinary game.
-- matchLine(line, context) -> rule, muted: the add-on's own test of "is this its character's game line", and whether the player
-- asked for it to be replaced. context.typeName() resolves the line type on demand.
function Instance:lineContext(line)
    local N, cache = self.native, nil
    return {typeName = function()
        if cache == nil then cache = call(N.lineType, line.type) or 'unknown' end
        return cache
    end}
end

function Instance:ruleFor(line)
    local options = self.options
    if type(options.matchLine) ~= 'function' then return nil end
    if type(options.matchWanted) == 'function' and call(options.matchWanted) ~= true then return nil end
    return call(options.matchLine, line, self:lineContext(line))
end

-- The subtitle HUD asks this before it shows a line (the override of ShouldDisplayLine: one call per line, never per frame).
function Instance:shouldHide(line)
    local options = self.options
    if type(options.matchWanted) ~= 'function' or call(options.matchWanted) ~= true then return false end
    if self:ownLine(line) then return false end
    local rule, muted = self:ruleFor(line)
    return rule ~= nil and muted == true
end

-- Installed on the first rule (never otherwise). True: the HUD asks us before every line. False: the fallback, the line is hidden
-- again right after it was handed to the HUD (see ruleLine).
function Instance:installMute()
    if self.muteInstalled ~= nil then return self.muteInstalled end
    local override = self.options.override or Override
    if type(override) ~= 'function' then self.muteInstalled, self.muteError = false, 'no Override'; return false end
    local ok, err = pcall(override, 'SubtitlesGameController', 'ShouldDisplayLine', function(_, line, wrapped)
        local hide = false
        pcall(function() hide = self:shouldHide(line) end)
        if hide then return false end
        return wrapped(line)
    end)
    self.muteInstalled, self.muteError = ok == true, (not ok) and tostring(err) or nil
    if type(self.options.log) == 'function' then
        pcall(self.options.log, ok and 'Game dialogue: subtitle filter installed (SubtitlesGameController.ShouldDisplayLine)'
            or ('Game dialogue: subtitle filter NOT installed (' .. tostring(err) .. '); muted lines are hidden after they appear'))
    end
    return self.muteInstalled
end

-- The line of a rule was seen (once per line, from the subtitle hooks that already run): silence what can be silenced, tell the host.
function Instance:ruleLine(line, rule, muted, seconds, measured)
    local options, N = self.options, self.native
    if not muted then
        if type(options.onGameLine) == 'function' then pcall(options.onGameLine, seconds, rule.name, measured) end
        return true
    end
    local audio, again = call(N.stopAudio, line, rule.audio)
    audio = audio or 'stop-failed'
    -- The add-on's own way to silence what the Wwise stop cannot reach (rule.silence(line, context) -> text, again): its text joins the
    -- log line and its `again` is repeated with the stop, at the same 0.3, 0.8 and 1.6 s. A failing function changes nothing else.
    if type(rule.silence) == 'function' then
        local text, more = call(rule.silence, line, self:lineContext(line))
        if type(text) == 'string' then audio = audio .. '+' .. text:sub(1, 80) end
        if type(more) == 'function' then
            local first = again
            again = function()
                if first then pcall(first) end
                pcall(more)
            end
        end
    end
    local subtitle = 'filtered'
    if self.muteInstalled ~= true then subtitle = call(N.hideLine, line) and 'hidden-after' or 'hide-failed' end
    self:count('muted', rule.name or '?')
    if type(options.onMuted) == 'function' then
        local number = call(N.lineNumber, line)
        -- What kind of line it is and what plays it, for the log: the Wwise stop is a guess for a scene voice (the Delamain cab's goodbye was heard
        -- through it live, 2026-10-16), and these two say which event family to try next.
        local kind = call(N.lineType, line.type)
        local class = call(function() return tostring(line.speaker:GetClassName()) end)
        pcall(options.onMuted, rule, {seconds = seconds, measured = measured, audio = audio, subtitle = subtitle, kind = kind, speakerClass = class,
            repeatStop = type(again) == 'function' and again or nil,
            id = number and string.format('%06d', number % 1000000) or '?'})
    end
    return true
end

-- One native scnDialogLineData (or a test table with the same fields).
function Instance:line(line, source)
    if source then self:count('hooks', source) end
    if type(line) == 'table' or type(line) == 'userdata' then
        pcall(self.noteLine, self, line)
        pcall(self.noteHeard, self, line)
    end
    if not self:enabled() then return self:skip('disabled') end
    local N, now = self.native, self:now()
    if type(line) ~= 'table' and type(line) ~= 'userdata' then return self:skip('invalid') end
    local id = call(N.lineId, line)
    if not id then return self:skip('invalid') end
    if self.seen[id] then return self:skip('duplicate') end
    if self:ownLine(line) then self.seen[id] = now; return self:skip('mod-reply') end
    local kind = call(N.lineType, line.type) or 'unknown'
    self:count('types', kind)
    local policy = POLICY[kind]
    if not policy then self.seen[id] = now; return self:skip('type') end
    local player = call(N.player)
    if not player or not call(N.ready, player) then return self:skip('no-player') end
    if call(N.braindance) then self.seen[id] = now; return self:skip('braindance') end
    if call(N.replacer, player) then self.seen[id] = now; return self:skip('replacer') end
    local callInfo = call(N.call)
    local speaker = line.speaker
    if policy == 'call-only' then
        -- Radio-styled lines count only during a call, and never from a car radio.
        if not callInfo or (speaker and call(N.isVehicle, speaker)) then self.seen[id] = now; return self:skip('radio') end
        policy = 'phone'
    end
    local channel = policy
    if callInfo and policy == 'scene' then channel = 'phone' end
    local text = clean(call(N.text, line), M.MAX_TEXT)
    if not text then self.seen[id] = now; return self:skip('empty') end
    local row = {kind = 'line', channel = channel, text = text, type = kind}
    local playerEntity = call(N.entity, player)
    local speakerEntity = speaker and call(N.entity, speaker) or nil
    if speakerEntity and speakerEntity == playerEntity then
        row.speaker = 'v'
    else
        row.speaker = 'npc'
        row.entity = entityId(speakerEntity)
        local key, canonical = nil, nil
        if speaker then key, canonical = call(self.options.resolve, speaker) end
        local shown = clean(call(N.speakerName, line), 120)
        if not key and shown then key = call(self.options.resolveName, shown) end
        if not key and channel == 'phone' and callInfo and callInfo.contact then
            key = call(self.options.contactKey, callInfo.contact)
        end
        row.profileKey = profileKey(key)
        row.name = clean(canonical, 120) or shown
        if not row.entity and not row.profileKey and not row.name then self.seen[id] = now; return self:skip('unattributed') end
        if channel == 'ambient' then
            -- Combat barks never count, from anyone.
            if call(N.playerCombat, player) or (speaker and call(N.npcCombat, speaker)) then
                self.seen[id] = now; return self:skip('combat')
            end
        end
    end
    if channel == 'phone' and callInfo and callInfo.contact and callInfo.contact:match('^[%w_%.%-]+$') and #callInfo.contact <= 80 then
        row.contact = callInfo.contact
    end
    if channel == 'scene' then
        local present = self:present(now)
        if #present > 0 then row.present = present end
    end
    self.seen[id] = now
    return self:push(row, now)
end

-- Plain strings from the dialogue choice hubs, so a chosen option can be named.
function Instance:dialogHubs(data)
    self:count('hooks', 'hubs')
    if not self:enabled() or type(data) ~= 'table' and type(data) ~= 'userdata' then return end
    local hubs = {}
    local list = data.choiceHubs or {}
    for index = 1, math.min(#list, 8) do
        local hub = list[index]
        local row = {id = tonumber(hub.id), title = clean(call(self.native.localized, hub.title), 120), choices = {}}
        local choices = hub.choices or {}
        for choice = 1, math.min(#choices, 12) do
            row.choices[choice] = clean(call(self.native.localized, choices[choice].localizedName), M.MAX_TEXT) or false
        end
        hubs[#hubs + 1] = row
    end
    -- An empty update (hub closed) keeps the last options for a choice that is
    -- reported just after the hub disappears.
    if #hubs > 0 then self.hubs = hubs end
end

function Instance:choiceRow(attempted)
    self:count('hooks', 'choice')
    if not self:enabled() then return self:skip('disabled') end
    local N, now = self.native, self:now()
    if type(attempted) ~= 'table' and type(attempted) ~= 'userdata' then return self:skip('invalid') end
    if not call(N.dialogChoice, attempted) then return self:skip('not-dialogue') end
    local player = call(N.player)
    if not player or not call(N.ready, player) then return self:skip('no-player') end
    if call(N.braindance) or call(N.replacer, player) then return self:skip('braindance') end
    local index = tonumber(attempted.choiceIdx)
    local activeId, hub = call(N.activeHub), nil
    for _, candidate in ipairs(self.hubs) do
        if candidate.id ~= nil and candidate.id == activeId then hub = candidate end
    end
    if not hub and #self.hubs == 1 then hub = self.hubs[1] end
    local text = hub and index and hub.choices[index + 1] or nil
    if not text then
        local caption = nil
        pcall(function() caption = attempted.choice.caption end)
        text = clean(call(N.localized, caption), M.MAX_TEXT)
    end
    if not text then return self:skip('empty') end
    local callInfo = call(N.call)
    local row = {kind = 'choice', speaker = 'v', channel = callInfo and 'phone' or 'scene', text = text, type = 'choice'}
    local addressee = hub and hub.title and call(self.options.resolveName, hub.title) or nil
    if not addressee and callInfo and callInfo.contact then addressee = call(self.options.contactKey, callInfo.contact) end
    row.addressee = profileKey(addressee)
    if row.channel == 'scene' then
        local present = self:present(now)
        if #present > 0 then row.present = present end
    end
    local pushed, reason = self:push(row, now)
    self.lastChoice = {index = index, hubId = hub and hub.id or nil, options = hub and #hub.choices or nil,
        channel = row.channel, present = row.present and #row.present or 0, chars = #text}
    if pushed then self:ledgerRecord(row, hub, index, now) end
    return pushed, reason
end

-- A dialogue pick, the hook fired. Wraps choiceRow so that one log line per outcome shows, from a normal play session, what the choice
-- hook really does: the first three picks it recorded (index, hub, option count, channel, who stood by) and the first time each reason
-- it skipped one. A pick that never produces either line did not reach this code (the 'hook choice fired' line says whether the hook
-- itself ran). No option text is logged. Runs per pick, never per frame.
-- What a pick that was not a dialogue choice looked like, for the one proof line: the visualizer enum name (or its text) and isSuccess, each
-- cut to 24 characters. Read in pcall, only when that line is about to be written; never option text.
local function detail(attempted, field)
    local ok, text = pcall(function()
        local value = attempted[field]
        if value == nil then return nil end
        if type(value) == 'table' or type(value) == 'userdata' then
            local inner = value.value
            if inner ~= nil then value = inner end
        end
        return tostring(value)
    end)
    if not ok or type(text) ~= 'string' or text == '' then return '?' end
    return (text:gsub('[%c]', ' '):sub(1, 24))
end

function Instance:choice(attempted)
    self.lastChoice = nil
    local ok, reason = self:choiceRow(attempted)
    self.choiceNotes = self.choiceNotes or {recorded = 0, skipped = {}}
    local notes, log = self.choiceNotes, self.options.log
    if type(log) == 'function' then
        if ok then
            if notes.recorded < 3 then
                notes.recorded = notes.recorded + 1
                local c = self.lastChoice or {}
                pcall(log, string.format('Game dialogue: choice recorded #%d (index=%s hub=%s options=%s channel=%s present=%d chars=%d ledger=%s)',
                    notes.recorded, tostring(c.index), tostring(c.hubId), tostring(c.options), tostring(c.channel), c.present or 0, c.chars or 0,
                    self:ledgerOn() and 'on' or 'off'))
            end
        elseif not notes.skipped[reason or '?'] then
            notes.skipped[reason or '?'] = true
            local extra = ''
            if reason == 'not-dialogue' then
                extra = string.format(' visualizer=%s success=%s', detail(attempted, 'visualizerType'), detail(attempted, 'isSuccess'))
            end
            pcall(log, 'Game dialogue: choice not recorded (' .. tostring(reason) .. extra .. ')')
        end
    end
    return ok, reason
end

-- The decision ledger: V's picked dialogue options, kept in memory (last LEDGER_MAX, newest last) and written to runtime/decision-ledger.json
-- once per pick. Keyed by the world token (a new world or a CET reload starts empty), and an entry stamped later than the game clock is dropped
-- (an earlier save was loaded), so a reload can only forget, never invent. Needs the game clock; without it nothing is recorded.
function Instance:ledgerOn()
    local enabled = self.options.ledgerEnabled
    if type(enabled) ~= 'function' then return false end
    local ok, value = pcall(enabled)
    return ok and value == true
end

function Instance:ledgerRecord(row, hub, index, now)
    if not self:ledgerOn() then return false end
    local token, seconds = call(self.options.worldToken), call(self.options.gameTime)
    if type(token) ~= 'string' or token == '' or type(seconds) ~= 'number' then self:count('skipped', 'ledger-unbound'); return false end
    local ledger = self.ledger
    if not ledger or ledger.worldToken ~= token then ledger = {worldToken = token, entries = {}}; self.ledger = ledger end
    local entries = {}
    for _, other in ipairs(ledger.entries) do
        if other.t <= seconds then entries[#entries + 1] = other end
    end
    local entry = {t = math.floor(seconds), text = clean(row.text, M.LEDGER_TEXT), index = index}
    if not entry.text then return false end
    entry.hub = hub and clean(hub.title, M.LEDGER_LABEL) or nil
    entry.addressee = row.addressee
    local tracked = call(self.options.tracked)
    if type(tracked) == 'table' then
        entry.quest = clean(tracked.title, M.LEDGER_LABEL)
        entry.questId = type(tracked.id) == 'string' and tracked.id:match('^%-?%d+$') and #tracked.id <= 24 and tracked.id or nil
    end
    if row.present then
        entry.present = {}
        for position, key in ipairs(row.present) do entry.present[position] = key end
    end
    entries[#entries + 1] = entry
    while #entries > M.LEDGER_MAX do table.remove(entries, 1) end
    ledger.entries = entries
    local ok, raw = pcall(json.encode, {version = 1, worldToken = token, gameTimeSeconds = math.floor(seconds), entries = entries})
    if not ok or type(raw) ~= 'string' then return false end
    local write = self.options.ledgerWrite
    if type(write) == 'function' then return select(1, pcall(write, M.LEDGER_PATH, raw)) end
    local file = io.open(M.LEDGER_PATH, 'wb')
    if not file then return false end
    file:write(raw); file:close()
    return true
end


-- The snapshot attached to one mod turn, or nil when off or empty.
function Instance:capture()
    if not self:enabled() then self:reset('disabled'); return nil end
    local now = self:now()
    self:prune(now)
    if #self.lines == 0 then return nil end
    local rows = {}
    for _, line in ipairs(self.lines) do
        local row = {id = line.id, age = math.max(0, math.floor(now - line.at)), kind = line.kind,
            channel = line.channel, speaker = line.speaker, text = line.text}
        for _, field in ipairs({'entity', 'profileKey', 'name', 'contact', 'addressee'}) do
            if line[field] ~= nil then row[field] = line[field] end
        end
        if line.present then
            row.present = {}
            for index, key in ipairs(line.present) do row.present[index] = key end
        end
        rows[#rows + 1] = row
    end
    return {version = 1, status = 'ready', lines = rows}
end

function Instance:status()
    local types, skipped, hooks, muted = {}, {}, {}, {}
    for key, value in pairs(self.counts.types) do types[key] = value end
    for key, value in pairs(self.counts.skipped) do skipped[key] = value end
    for key, value in pairs(self.counts.hooks) do hooks[key] = value end
    for key, value in pairs(self.counts.muted) do muted[key] = value end
    return {enabled = self:enabled(), installed = self.installed == true, lines = #self.lines, ledger = self.ledger and #self.ledger.entries or 0,
        recorded = self.counts.recorded, hooks = hooks, types = types, skipped = skipped, muted = muted,
        subtitleFilter = self.muteInstalled,
        resetReason = self.resetReason, lastError = self.lastError}
end

-- Local, read-only probe for the in-game check list: the adapter counters and
-- the lines currently held (they never leave this machine through this file).
function Instance:dump(path)
    path = path or 'runtime/game-dialogue-probe.json'
    local now, lines = self:now(), {}
    for index, line in ipairs(self.lines) do
        lines[index] = {age = now - line.at, kind = line.kind, type = line.type, channel = line.channel,
            speaker = line.speaker, entity = line.entity, profileKey = line.profileKey, name = line.name,
            contact = line.contact, addressee = line.addressee, present = line.present, text = line.text}
    end
    local ok, raw = pcall(json.encode, {status = self:status(), lines = lines, capturedAt = os.time()})
    if not ok then return false end
    local file = io.open(path, 'wb'); if not file then return false end
    file:write(raw); file:close()
    return true
end

-- The first time each of the four hooks fires in a session, one probe.log line (options.log): a normal play session then
-- proves which hooks the game really calls, with no console and no per-frame cost (a callback runs per dialogue line or choice
-- screen, and after the first sighting this is one table lookup). 'fired' survives reset(); a CET reload starts it afresh.
local HOOK_NAMES = {show = 'BaseSubtitlesGameController.ShowDialogLines', event = 'BaseSubtitlesGameController.OnShowDialogLine',
    choice = 'PreventionSystem.OnPlayerChoice', hubs = 'InteractionUIBase.OnDialogsData'}
function Instance:firstSighting(source)
    if self.fired[source] then return end
    self.fired[source] = true
    if type(self.options.log) == 'function' then
        pcall(self.options.log, 'Game dialogue: hook ' .. source .. ' fired (' .. (HOOK_NAMES[source] or source) .. ')')
    end
end

function Instance:guard(source, fn)
    return function(...)
        self:firstSighting(source)
        local ok, err = pcall(fn, ...)
        if not ok then self.lastError = source .. ': ' .. tostring(err) end
    end
end

-- Hooks (CET ObserveAfter). The two subtitle hooks see the same lines; native
-- ids make the second sighting a duplicate. Counters show which ones fire.
function Instance:install()
    if self.installed then return true end
    local observe = self.options.observe or ObserveAfter
    if type(observe) ~= 'function' then return false end
    local N = self.native
    observe('BaseSubtitlesGameController', 'ShowDialogLines', self:guard('show', function(_, lines)
        if type(lines) ~= 'table' then return end
        for _, line in ipairs(lines) do self:line(line, 'show') end
    end))
    observe('BaseSubtitlesGameController', 'OnShowDialogLine', self:guard('event', function(_, value)
        local lines = call(N.fromVariant, value)
        if type(lines) ~= 'table' then return end
        for _, line in ipairs(lines) do self:line(line, 'event') end
    end))
    observe('PreventionSystem', 'OnPlayerChoice', self:guard('choice', function(_, value)
        local attempted = call(N.fromVariant, value)
        if attempted then self:choice(attempted) end
    end))
    observe('InteractionUIBase', 'OnDialogsData', self:guard('hubs', function(_, value)
        local data = call(N.fromVariant, value)
        if data then self:dialogHubs(data) end
    end))
    self.installed = true
    return true
end

return M
