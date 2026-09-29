local M = {}

local function command(action, context)
    local f = io.open('runtime/microphone-command.json', 'wb')
    if not f then return false end
    f:write(json.encode({nonce = tostring(os.time()) .. ':' .. tostring(os.clock()), action = action, input = context}))
    f:close()
    return true
end

function M.cancel()
    if M.context then command('cancel', M.context) end
    M.context, M.state, M.started = nil, nil, nil
end

function M.begin(context)
    M.cancel()
    context.journal = M.captureJournal and M.captureJournal()
    context.battle = M.captureBattle and M.captureBattle()
    if not command('start', context) then return false end
    M.context, M.state, M.started = context, 'starting', os.time()
    return true
end

function M.finish()
    if not M.context then return nil end
    command('finish', M.context)
    M.state = 'reply'
    return M.context
end

function M.update(player)
    if not M.context then return nil end
    if not player then M.cancel(); return nil end
    local defs = Game.GetAllBlackboardDefs()
    if Game.GetBlackboardSystem():Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
        M.cancel(); return nil
    end
    local f = io.open('runtime/microphone-state.json', 'rb')
    if f then
        local ok, value = pcall(json.decode, f:read('*a')); f:close()
        if ok and value.requestId == M.context.requestId then
            if value.state == 'recording' and M.state == 'starting' then
                M.state = 'recording'; M.started = os.time()
                player:ConvaiPhoneFeedback('Listening - press F7 again to finish')
            elseif value.state == 'error' then
                player:ConvaiPhoneFeedback('Microphone unavailable. Check your Windows input device.')
                M.context, M.state = nil, nil
            end
        end
    end
    if M.context and M.state == 'recording' and os.time() - M.started >= 30 then return M.finish() end
    if M.context and M.state == 'starting' and os.time() - M.started >= 35 then
        M.cancel(); player:ConvaiPhoneFeedback('Microphone connection timed out. Please try again.')
    end
    return nil
end

return M
