-- MCM owns its drafts. This short-lived request only prepares local voices;
-- it never persists a setting or changes an in-flight conversation's route.
local M = {}
local MOD_KEY = 'cyberpunk-convai:manager'
local INTERVAL = 1000
-- A staged choice only prepares a model once it has stayed unchanged this long,
-- so cycling through the voices never loads or unloads a worker per step.
local DEFAULT_SETTLE = 0

-- The Companion voices list in menu order; the select's value is the index here. Pocket TTS is the default.
-- OmniVoice has two step counts and two reference lengths (short up to 10 s, long up to 18 s). The Mistral cloud voice
-- (Voxtral) needs a Mistral key and the Inworld cloud voice an Inworld key; in the bridge both use only Pocket's route and audio
-- format and load no local voice model (a reply they cannot deliver is asked again once, then shown as written text).
-- The Inworld voice is the last entry because it is listed only in developer mode (Settings > Development): without it the menu is
-- the first seven entries, so an index means the same thing in both.
M.CHOICES = {
    {provider = 'pocket'},
    {provider = 'omni', steps = 16, reference = 'short'},
    {provider = 'omni', steps = 16, reference = 'long'},
    {provider = 'omni', steps = 32, reference = 'short'},
    {provider = 'omni', steps = 32, reference = 'long'},
    {provider = 'voxtral'},
    {provider = 'convai'},
    {provider = 'inworld'},
}

-- The select index of a saved choice ({voiceProvider, omniSteps, omniReference}).
function M.indexOf(saved)
    saved = type(saved) == 'table' and saved or {}
    if saved.voiceProvider == 'convai' or saved.voiceProvider == 'voxtral' or saved.voiceProvider == 'inworld' then
        for index, choice in ipairs(M.CHOICES) do
            if choice.provider == saved.voiceProvider then return index end
        end
    end
    if saved.voiceProvider == 'pocket' then return 1 end
    local steps = saved.omniSteps == 32 and 32 or 16
    local reference = saved.omniReference == 'short' and 'short' or 'long'
    for index, choice in ipairs(M.CHOICES) do
        if choice.provider == 'omni' and choice.steps == steps and choice.reference == reference then return index end
    end
    return 1
end

local function writeFile(path, raw)
    local temporary = path .. '.tmp'
    local file = io.open(temporary, 'wb')
    if not file then return false end
    local called, written = pcall(file.write, file, raw)
    local closed, result = pcall(file.close, file)
    if not called or not written or not closed or not result then
        pcall(os.remove, temporary)
        return false
    end
    local moved, renamed = pcall(os.rename, temporary, path)
    if not moved or not renamed then
        -- Windows rename cannot replace a destination. Readers retain a valid
        -- lease through the brief replacement gap, bounded by its expiry.
        pcall(os.remove, path)
        moved, renamed = pcall(os.rename, temporary, path)
    end
    if not moved or not renamed then pcall(os.remove, temporary); return false end
    return true
end

function M.new(options)
    options = options or {}
    local P = {}
    local api, subscription, scope, leaseOwner
    local dirty, sequence, publicationSequence, nextPoll, nextAttempt = true, 0, 0, 0, 0
    local current, attempted, failure = nil, nil, nil
    local settleMs = tonumber(options.settleMs) or DEFAULT_SETTLE
    local staged, stagedSince = nil, 0
    local now = options.now or function() return os.time() * 1000.0 end
    local write = options.write or writeFile
    local encode = options.encode or function(value) return json.encode(value) end
    local path = (options.runtimeDir or 'runtime'):gsub('[/\\]+$', '') .. '/voice-preview.json'
    -- This token is scoped to a Lua instance/menu opening. It contains no
    -- player, companion, API-session or conversation identity.
    local seed = 'mcm-' .. tostring(os.time()) .. '-' .. tostring({}):gsub('[^A-Za-z0-9]', ''):sub(1, 32)

    local function publish(value, stamp)
        local signature = table.concat({value.owner, tostring(value.active), value.provider, tostring(value.omniSteps or ''),
            tostring(value.omniReference or '')}, ':')
        if attempted == signature and stamp < nextAttempt then return false end
        attempted, nextAttempt = signature, stamp + INTERVAL
        -- os.time has one-second resolution. Sequence disambiguates rapid
        -- selector changes and cancellation even when their timestamps match.
        if publicationSequence >= 2147483647 then
            failure = 'Reopen the voice service after reloading mods.'
            return false
        end
        publicationSequence = publicationSequence + 1
        value.version, value.updated, value.sequence = 1, stamp, publicationSequence
        local encoded, raw = pcall(encode, value)
        local ok, saved = false, false
        if encoded and type(raw) == 'string' and #raw <= 1024 then ok, saved = pcall(write, path, raw) end
        if not ok or saved ~= true then failure = 'Could not prepare the selected voice service.'; return false end
        current, failure = value, nil
        return true
    end

    local function cancel(stamp)
        if current and current.active then
            publish({owner = current.owner, active = false, provider = current.provider, omniSteps = current.omniSteps,
                omniReference = current.omniReference}, stamp)
        end
    end

    function P.bind(nextApi)
        if api == nextApi then return end
        P.reset()
        if api and subscription and type(api.unsubscribe) == 'function' then pcall(api.unsubscribe, subscription) end
        api, subscription, dirty = nextApi, nil, true
        if api and type(api.subscribe) == 'function' and type(api.getValue) == 'function'
            and type(api.hasDrafts) == 'function' then
            local ok, token = pcall(api.subscribe, 'drafts.changed', function(event)
                -- This callback can run deep inside a native UI action. Do not
                -- query widgets, inspect settings or touch the filesystem here.
                if type(event) == 'table' and event.modKey == MOD_KEY then dirty = true end
            end)
            if ok then subscription = token end
        end
    end

    function P.update(visible, controllerKey, readCommitted)
        local stamp = now()
        if not visible or not controllerKey or not api or not subscription then
            cancel(stamp)
            scope, leaseOwner, dirty, nextPoll, staged = nil, nil, true, 0, nil
            return
        end
        if scope ~= controllerKey then
            cancel(stamp)
            scope, sequence, dirty, nextPoll = controllerKey, sequence + 1, true, 0
            leaseOwner = seed .. '-' .. sequence
        end
        if not dirty and stamp < nextPoll then return end
        dirty, nextPoll = false, stamp + INTERVAL
        local pendingOk, pending = pcall(api.hasDrafts, MOD_KEY)
        if not pendingOk or not pending then staged = nil; cancel(stamp); return end
        local providerOk, provider, providerError = pcall(api.getValue, MOD_KEY .. ':voiceProvider')
        local savedOk, saved = pcall(readCommitted)
        local choice = providerOk and not providerError and M.CHOICES[provider] or nil
        if not choice
            or not savedOk or type(saved) ~= 'table'
            or (saved.voiceProvider ~= 'pocket' and saved.voiceProvider ~= 'omni' and saved.voiceProvider ~= 'voxtral' and saved.voiceProvider ~= 'inworld'
                and saved.voiceProvider ~= 'hybrid' and saved.voiceProvider ~= 'convai') then
            staged = nil
            cancel(stamp)
            return
        end
        -- Select order: M.CHOICES (Pocket TTS, OmniVoice 16/32 steps with a short/long reference, Mistral cloud voice, Inworld cloud voice, Convai).
        local omniSteps, omniReference = choice.steps, choice.reference
        provider = choice.provider
        local savedProvider = saved.voiceProvider == 'hybrid' and 'omni' or saved.voiceProvider
        local savedSteps = saved.omniSteps == 32 and 32 or 16
        local savedReference = saved.omniReference == 'short' and 'short' or 'long'
        if provider == savedProvider and (provider ~= 'omni' or (omniSteps == savedSteps and omniReference == savedReference)) then
            staged = nil
            cancel(stamp); return
        end
        local stagedChoice = provider .. ':' .. tostring(omniSteps or '') .. ':' .. tostring(omniReference or '')
        if staged ~= stagedChoice then staged, stagedSince = stagedChoice, stamp end
        if stamp - stagedSince < settleMs then
            -- Still being changed. Keep an earlier lease alive and start none; the next
            -- poll notices the choice once it has settled.
            if current and current.active then
                publish({owner = leaseOwner, active = true, provider = current.provider, omniSteps = current.omniSteps,
                    omniReference = current.omniReference}, stamp)
            end
            return
        end
        publish({owner = leaseOwner, active = true, provider = provider, omniSteps = omniSteps,
            omniReference = omniReference}, stamp)
    end

    function P.reset()
        cancel(now())
        scope, leaseOwner, dirty, nextPoll, staged = nil, nil, true, 0, nil
    end

    function P.shutdown() P.bind(nil) end

    -- The staged choice that differs from the saved one, or nil. Lua data only.
    function P.staged() return staged end

    function P.inspect()
        return {available = subscription ~= nil, active = current and current.active or false,
            provider = current and current.provider or nil, omniSteps = current and current.omniSteps or nil,
            omniReference = current and current.omniReference or nil, error = failure}
    end

    return P
end

return M
