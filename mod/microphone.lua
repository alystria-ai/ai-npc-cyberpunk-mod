local M = {}

local function sameOwner(a, b)
    return a and b and a.session == b.session and a.generation == b.generation and a.worldToken == b.worldToken
end

local function capture(context, prior)
    if not M.captureKnowledge then return true end
    local ok, value, reason = pcall(M.captureKnowledge, context)
    if ok and not value and reason == 'save-in-progress' then return false, reason end
    if not ok or type(value) ~= 'table' or type(value.owner) ~= 'table'
        or (prior and not sameOwner(prior, value.owner)) then return false end
    context.worldKnowledge, context.journalHistory = value.worldKnowledge, value.journalHistory
    M.knowledgeOwner = value.owner
    return true
end

local function currentOwner()
    if not M.currentKnowledgeOwner then return true end
    local ok, value = pcall(M.currentKnowledgeOwner)
    if not ok or not sameOwner(M.knowledgeOwner, value) then return false, 'world-changed' end
    if value.paused then return false, 'save-in-progress' end
    return true
end

local function command(action, context)
    local f = io.open('runtime/microphone-command.json', 'wb')
    if not f then return false end
    f:write(json.encode({nonce = tostring(os.time()) .. ':' .. tostring(os.clock()), action = action, input = context}))
    f:close()
    return true
end

local function clear()
    M.context, M.state, M.started, M.knowledgeOwner, M.finishPending = nil, nil, nil, nil, nil
    M.targetValid = nil
end

function M.cancel(reason)
    local context = M.context
    if context then command('cancel', context) end
    clear()
    if context and type(M.onCancelled) == 'function' then M.onCancelled(context, reason or 'cancelled') end
end

function M.received(requestId)
    if not M.context or M.context.requestId ~= requestId or M.state ~= 'reply' then return false end
    clear()
    return true
end

function M.begin(context, targetValid)
    M.cancel('replaced')
    if not capture(context) then return false end
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    if context.followUpQuestions == nil then
        context.followUpQuestions = type(M.captureFollowUpQuestions) == 'function' and M.captureFollowUpQuestions() == true
    end
    if not currentOwner() then M.knowledgeOwner = nil; return false end
    if not command('start', context) then M.knowledgeOwner = nil; return false end
    M.context, M.state, M.started = context, 'starting', os.time()
    M.targetValid = targetValid
    return true
end

function M.finish(mode)
    local context = M.context
    if not context or M.state == 'reply' or (mode and mode ~= (context.group and 'group' or 'private')) then return nil end
    local captured, reason = capture(context, M.knowledgeOwner)
    if not captured then
        if reason == 'save-in-progress' then M.finishPending = true else M.cancel() end
        return nil
    end
    M.finishPending = nil
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    if M.context ~= context then return nil end
    local current, problem = currentOwner()
    if not current then
        if problem == 'save-in-progress' then M.finishPending = true else M.cancel() end
        return nil
    end
    if not command('finish', context) then M.cancel('finish-write-failed'); return nil end
    M.state = 'reply'
    return context
end

function M.update(player)
    if not M.context then return nil end
    if not player then M.cancel(); return nil end
    if M.currentKnowledgeOwner then
        local ok, current = pcall(M.currentKnowledgeOwner)
        if not ok or not sameOwner(M.knowledgeOwner, current) then M.cancel(); return nil end
    end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
        M.cancel('menu'); return nil
    end
    if type(M.targetValid) == 'function' then
        local ok, valid = pcall(M.targetValid, M.context)
        if not ok or not valid then M.cancel('target-lost'); return nil end
    end
    local f = io.open('runtime/microphone-state.json', 'rb')
    if f then
        local ok, value = pcall(json.decode, f:read('*a')); f:close()
        if ok and value.requestId == M.context.requestId then
            if value.state == 'recording' and M.state == 'starting' then
                M.state = 'recording'; M.started = os.time()
                player:ConvaiPhoneFeedback('Listening - press ' .. (M.context.group and 'F9' or 'F7') .. ' again to finish')
            elseif value.state == 'error' then
                player:ConvaiPhoneFeedback('Microphone unavailable. Check your Windows input device.')
                M.cancel('microphone-error')
            end
        end
    end
    if M.context and M.finishPending then return M.finish() end
    if M.context and M.state == 'recording' and os.time() - M.started >= 30 then return M.finish() end
    if M.context and M.state == 'starting' and os.time() - M.started >= 35 then
        M.cancel(); player:ConvaiPhoneFeedback('Microphone connection timed out. Please try again.')
    end
    return nil
end

return M
