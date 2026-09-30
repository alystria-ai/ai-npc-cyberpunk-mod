-- Open MCM through its existing pause-menu entry. MCM owns the settings page,
-- input focus and pause lifecycle; this adapter neither simulates keys nor
-- modifies MCM's files, preferences, menu scenario or global input handlers.
local M = {}

function M.new(modName, isAvailable, log)
    local E = {}
    local stage, deadline = 'idle', 0
    local pauseController, settingsController, selectionAction
    local lastProblem, menuItems = '', {}
    local hooksInstalled = false

    local function name(value)
        if type(value) == 'string' then return value end
        local ok, result = pcall(NameToString, value)
        return ok and result and result ~= '' and result or tostring(value)
    end

    local function abort(reason)
        stage, deadline, pauseController, selectionAction = 'idle', 0, nil, nil
        if reason then lastProblem = reason; log('MCM entry: ' .. reason) end
    end

    local function livePauseController()
        -- A controller observed during OnInitialize can still have no list.
        -- Read the attached instance from Ink after the native host publishes
        -- it, rather than assuming a lifecycle callback makes its widgets ready.
        for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
            for _, controller in ipairs(layer:GetGameControllers()) do
                if controller:IsA('PauseMenuGameController') and controller.menuListController then
                    return controller
                end
            end
        end
    end

    function E.install()
        if hooksInstalled then return end
        hooksInstalled = true
        ObserveAfter('PauseMenuGameController', 'PopulateMenuItemList', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('PauseMenuGameController', 'OnInitialize', function(this)
            if stage == 'pause' then pauseController = this end
        end)
        ObserveAfter('SettingsMainGameController', 'OnInitialize', function(this)
            settingsController = this
        end)
        Observe('SettingsMainGameController', 'OnUninitialize', function()
            settingsController = nil
            abort()
        end)
        Observe('SettingsMainGameController', 'McmUiAddSidebarItem', function(this, id, _, label, _, selected)
            if stage == 'select' and label == modName then
                settingsController = this
                if selected then abort() else selectionAction = id end
            end
        end)
    end

    function E.open()
        if not isAvailable() then return false, 'Install Mod Configuration Menu and its API to open the manager.' end
        if stage ~= 'idle' then return true end
        if settingsController then
            local ok, active = pcall(function() return settingsController:McmUiIsActive() end)
            if ok and active then
                -- RequestClose goes through MCM's pending-settings guard.
                settingsController:RequestClose()
                return true
            end
        end
        local ok, reason = pcall(function()
            local player = Game.GetPlayer()
            if not player or not player:IsAttached() then return 'Load a save first.' end
            if Game.GetSystemRequestsHandler():IsPreGame() then return 'Load a save first.' end
            local defs, boards = Game.GetAllBlackboardDefs(), Game.GetBlackboardSystem()
            if boards:Get(defs.UI_System):GetBool(defs.UI_System.IsInMenu) then
                local attached = livePauseController()
                if attached then
                    pauseController, stage, deadline, lastProblem, menuItems = attached, 'pause', os.time() + 8, '', {}
                    return nil
                end
                return 'Close the current menu first, or choose Mods from the pause menu.'
            end
            if player:ConvaiComposerOpen() then return 'Close the text box first.' end
            local scene = boards:GetLocalInstanced(player:GetEntityID(), defs.PlayerStateMachine)
            if scene:GetInt(defs.PlayerStateMachine.SceneTier) >= 3 then return 'Finish the scene first.' end
            stage, deadline, lastProblem, menuItems = 'pause', os.time() + 8, '', {}
            boards:Get(defs.MenuEventBlackboard):SetName(defs.MenuEventBlackboard.MenuEventToTrigger, 'OnOpenPauseMenu', true)
            return nil
        end)
        if not ok or reason then abort(); return false, tostring(reason) end
        return true
    end

    function E.update()
        if stage == 'idle' then return end
        if os.time() > deadline then
            abort('The shortcut timed out. Choose Companion Manager from the pause menu under Mods.')
            return
        end
        if stage == 'pause' then
            local ok, found = pcall(function()
                if not pauseController or not pauseController.menuListController then
                    pauseController = livePauseController()
                end
                local list = pauseController and pauseController.menuListController
                if not list then return false end
                menuItems = {}
                for index = 0, list:Size() - 1 do
                    local widget = list:GetItemAt(index)
                    local target = widget and widget:GetController()
                    local data = target and target:GetData()
                    menuItems[#menuItems + 1] = {index = index, controller = tostring(target),
                        label = data and tostring(data.label) or '', event = data and name(data.eventName) or ''}
                    -- Runtime-created CNames need not have a reverse string
                    -- entry. Compare the native name/hash, never its debug text.
                    local mcmItem = data and (data.eventName == CName.new('OnSwitchToMCM')
                        or data.eventName == 'OnSwitchToMCM')
                    if mcmItem then
                        stage = 'select'
                        -- Activate the real entry so MCM prepares its providers,
                        -- lifecycle and Settings controller in the correct order.
                        pauseController:OnMenuItemActivated(index, target)
                        pauseController = nil
                        return true
                    end
                end
                return false
            end)
            if not ok then abort('Could not activate the Mods entry: ' .. tostring(found)) end
        elseif stage == 'select' and selectionAction and settingsController then
            local id = selectionAction
            selectionAction, stage = nil, 'selected'
            local ok, err = pcall(function() settingsController:McmUiEmitAction(id) end)
            if not ok then abort('Could not select the manager: ' .. tostring(err)) end
        end
    end

    function E.selected() if stage == 'selected' then abort() end end
    function E.state() return stage end
    function E.inspect() return {stage = stage, problem = lastProblem, items = menuItems, capturedPause = pauseController ~= nil} end
    function E.reset() settingsController = nil; abort() end
    return E
end

return M
