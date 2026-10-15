-- Settings > Conversation provider > Convai paid tier (docs/CONVAI_PAID_TIER.md). The plans Convai made for this mod, paid on
-- Convai's own Stripe page in the player's browser, with the player's own Convai API key; conversations then use that key through the
-- existing "Convai API key" entry of the Conversation provider.
--
-- The conversation service does the work (bridge/convai-paid-tier.mjs): this file writes one small command file when the player chooses
-- something and reads the status file the service answers in. The key never reaches either file. Nothing runs per frame: the status is
-- read at most every 1.5 s while the page asks for it, and after a purchase every 2 s until Convai confirms the plan or the service
-- stops looking (five minutes at most); with no purchase running, update() returns at once.
local M = {version = 1}

local COMMAND, STATE = 'runtime/paid-tier-command.json', 'runtime/paid-tier-state.json'
local READ_EVERY, WATCH_EVERY, WATCH_MAX = 1.5, 2, 420

local function readJSON(path)
    local file = io.open(path, 'rb')
    if not file then return nil end
    local raw = file:read('*a'); file:close()
    local ok, value = pcall(json.decode, raw)
    return ok and type(value) == 'table' and value or nil
end

local function text(value, limit)
    if type(value) ~= 'string' or value == '' then return nil end
    return value:sub(1, limit or 64)
end

local function whole(value, max)
    return type(value) == 'number' and value == math.floor(value) and value > 0 and value <= max and value or nil
end

-- The plans as the service published them, kept only when well formed (the price ids stay in the service).
local function cleanPlans(value)
    local plans = {}
    if type(value) ~= 'table' then return plans end
    for _, plan in ipairs(value) do
        if type(plan) == 'table' and text(plan.id, 40) and text(plan.name, 32) and text(plan.price, 16)
            and (plan.period == 'monthly' or plan.period == 'yearly') then
            plans[#plans + 1] = {id = plan.id, name = plan.name, price = plan.price, period = plan.period,
                interactions = whole(plan.interactions, 10000000), concurrency = whole(plan.concurrency, 1000)}
        end
        if #plans == 8 then break end
    end
    return plans
end

function M.new(options)
    options = options or {}
    local ui = options.ui
    local clock = options.clock or function() return os.clock() end
    local self = {}
    local counter, raw, readAt = 0, {}, nil
    -- The latest command this page sent ({id, action}) and the purchase or check being followed ({id, action, since, readAt}).
    local sent, following = nil, nil

    local function refresh(force)
        local now = clock()
        if not force and readAt and now - readAt < READ_EVERY and now >= readAt then return end
        readAt = now
        local value = readJSON(STATE)
        raw = type(value) == 'table' and value or {}
    end

    local function write(payload)
        local ok = pcall(function()
            local encoded = json.encode(payload)
            local temporary = COMMAND .. '.tmp'
            local file = io.open(temporary, 'wb')
            if not file then error('no file') end
            local wrote = file:write(encoded); file:close()
            if not wrote then error('write failed') end
            os.remove(COMMAND)
            if not os.rename(temporary, COMMAND) then error('rename failed') end
        end)
        return ok
    end

    -- What the page shows. `result` is the outcome of this page's latest command only.
    function self.state(force)
        refresh(force)
        local result = type(raw.result) == 'table' and sent and raw.result.id == sent.id and text(raw.result.state, 24) or nil
        local plan = type(raw.plan) == 'table' and {name = text(raw.plan.name, 64), paid = raw.plan.paid == true} or nil
        local watch = type(raw.watch) == 'table' and {state = text(raw.watch.state, 16), plan = text(raw.watch.plan, 40)} or nil
        return {available = raw.version == 1, keySaved = raw.keySaved == true, plans = cleanPlans(raw.plans), plan = plan,
            watch = watch, result = result, action = sent and sent.action or nil}
    end

    -- One line for the settings page's redraw check.
    function self.signature()
        local state = self.state()
        return table.concat({tostring(state.available), tostring(state.keySaved), #state.plans,
            state.plan and (tostring(state.plan.name) .. '/' .. tostring(state.plan.paid)) or '',
            state.watch and tostring(state.watch.state) or '', state.result or ''}, '|')
    end

    -- Sends one command: 'refresh' (the page opened), 'buy' (with a plan id), 'check', 'manage' or 'key-page'. Returns ok, message.
    function self.request(action, plan)
        counter = counter + 1
        local id = 'p' .. tostring(os.time()) .. '-' .. tostring(counter)
        local payload = {version = 1, id = id, action = action, issuedAt = os.time() * 1000.0}
        if action == 'buy' then payload.plan = plan end
        if not write(payload) then return false, ui.t('The request could not be sent. Try again.') end
        sent = {id = id, action = action}
        if action == 'buy' or action == 'check' then following = {id = id, action = action, since = clock(), readAt = clock()}
        elseif following and not following.opened then following = nil end
        readAt = nil
        if action == 'buy' then return true, ui.t('Asking Convai for the payment page…') end
        if action == 'check' then return true, ui.t('Checking your plan…') end
        if action == 'refresh' then return true end
        return true, ui.t('Opening the page in your browser…')
    end

    -- The sentence for the latest result, or nil.
    function self.message(state)
        local result, action = state.result, state.action
        if not result then return nil end
        if result == 'working' then return ui.t('Contacting Convai…') end
        if result == 'opened' and action == 'buy' then
            return ui.t('Convai’s payment page is open in your browser. Your plan is active about 15 seconds after you pay.')
        end
        if result == 'opened' then return ui.t('Opened in your browser.') end
        if result == 'no-key' then return ui.t('Add your Convai API key first: copy it, then choose Paste on the Convai API key row.') end
        if result == 'invalid-key' then return ui.t('Convai did not accept your API key.') end
        if result == 'unavailable' or result == 'unreachable' then return ui.t('Convai’s payment service did not answer. Try again in a moment.') end
        if result == 'open-failed' then return ui.t('Your browser could not be opened.') end
        if result == 'active' then return ui.t('Your Convai plan is active.') end
        if result == 'not-yet' then return ui.t('Convai does not show a paid plan for your key yet.') end
        if result == 'unknown' then return ui.t('Your plan could not be read right now. Try again in a moment.') end
        -- 'saved': a Convai sign-in (when one exists) saved the key; the key row shows it.
        if result == 'ready' or result == 'saved' then return nil end
        return ui.t('Convai could not start the payment. Try again later.')
    end

    -- Called by the settings module's slow tick. Returns 'active' once Convai confirms the plan after a purchase or a check, 'timeout'
    -- when the service stopped looking without a confirmation, else nil. Free while nothing is being followed.
    function self.update()
        if not following then return nil end
        local now = clock()
        if now < following.since or now - following.since > WATCH_MAX then following = nil; return nil end
        if now - following.readAt < WATCH_EVERY then return nil end
        following.readAt = now
        local state = self.state(true)
        if not state.available then return nil end
        -- The answer to the followed command itself (a later command, such as reopening the page, does not end a purchase that is open).
        if not following.opened then
            local result = type(raw.result) == 'table' and raw.result.id == following.id and text(raw.result.state, 24) or nil
            if not result or result == 'working' then return nil end
            if following.action == 'check' then
                following = nil
                return result == 'active' and 'active' or nil
            end
            if result ~= 'opened' then following = nil; return nil end
            following.opened = true
        end
        local watch = state.watch
        if watch and watch.state == 'active' then following = nil; return 'active' end
        if watch and watch.state == 'timeout' then following = nil; return 'timeout' end
        return nil
    end

    function self.following() return following ~= nil end

    return self
end

return M
