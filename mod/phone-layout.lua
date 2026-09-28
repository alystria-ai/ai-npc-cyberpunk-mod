-- Small layout adjustment on our native phone widgets. No input interception.
local M = convaiPhoneLayout or {patched = 0}
local width, reserve = 132, 264
local positions = {88, 80, 83, 109, 115.5}

function M.apply(controller)
    M.seen = (M.seen or 0) + 1
    local root = controller:GetRootWidget()
    local actions, label = {}, nil
    M.detail = {root = NameToString(root:GetName()), nodes = 0}
    local function find(widget, depth)
        if not widget or depth > 6 then return end
        local name = NameToString(widget:GetName())
        if name == 'contactLabel' then label = widget end
        M.detail.nodes = M.detail.nodes + 1
        if name == 'convaiJoin' or name == 'convaiLeave' then actions[#actions + 1] = widget; return end
        local compound, count = pcall(function() return widget:GetNumChildren() end)
        if compound and count then
            for i = 0, count - 1 do find(widget:GetWidgetByIndex(i), depth + 1) end
        end
    end
    find(root, 0)
    M.detail.actions = #actions
    if #actions == 0 then return end
    -- Guard the native artwork version before assigning absolute positions.
    for _, action in ipairs(actions) do
        local count = action:GetNumChildren()
        M.detail.children = count
        M.detail.firstClass = NameToString(action:GetWidgetByIndex(0):GetClassName())
        if (count ~= 5 and count ~= 6) or M.detail.firstClass ~= 'inkImageWidget' then return end
    end
    local visible = false
    M.detail.geometry = {}
    for _, action in ipairs(actions) do
        visible = visible or action:IsVisible()
        if action:GetWidth() ~= width then action:SetWidth(width) end
        for i = 1, action:GetNumChildren() - 1 do
            local child = action:GetWidgetByIndex(i)
            local margin = child:GetMargin()
            if margin.left ~= positions[i] then
                margin.left = positions[i]
                child:SetMargin(margin)
            end
        end
        M.detail.geometry[#M.detail.geometry + 1] = {
            name = NameToString(action:GetName()), width = action:GetWidth(), visible = action:IsVisible(),
            keyRight = action:GetWidgetByIndex(0):GetWidth(),
            iconLeft = action:GetWidgetByIndex(2):GetMargin().left,
        }
    end
    -- This native row's label is 600 units; the redscript adapter reserves
    -- 224 units for the old artwork. Private script fields aren't exposed by
    -- these ink wrappers, so use the named label and only recognized widths.
    if label and (label:GetWidth() == 600 or label:GetWidth() == 376 or label:GetWidth() == 336) then
        local wanted = visible and (600 - reserve) or 600
        if label:GetWidth() ~= wanted then label:SetWidth(wanted) end
    end
    M.detail.labelWidth = label and label:GetWidth() or nil
    if visible then M.selected = M.detail end
    M.patched, M.lastError = M.patched + 1, nil
end

local function apply(controller)
    local ok, err = pcall(M.apply, controller)
    if not ok then M.lastError = tostring(err) end
end

function M.refresh(force)
    local player = Game.GetPlayer()
    if not player or not player:ConvaiPhoneIsOpen() then M.wasOpen = false; return end
    -- Row callbacks handle selection/recycling. Scan just once on opening to
    -- cover a phone that was already visible when the module was installed.
    if not force and M.wasOpen then return end
    M.wasOpen, M.selected, M.lastError = true, nil, nil
    M.scan = {rows = 0, nodes = 0}
    for _, layer in ipairs(Game.GetInkSystem():GetLayers()) do
        for _, controller in ipairs(layer:GetGameControllers()) do
            local class = NameToString(controller:GetClassName())
            if class == 'NewHudPhoneGameController' then
                -- The base ink controller returned by GetGameControllers may
                -- not expose private script fields. Its widget tree still
                -- contains the live virtual row controllers.
                local root = controller:GetRootWidget()
                local nodes, rows = 0, 0
                local function visit(widget, depth)
                    if not widget or depth > 18 or nodes >= 2500 then return end
                    nodes = nodes + 1
                    local row = widget:GetController()
                    if row and NameToString(row:GetClassName()) == 'PhoneContactItemVirtualController' then
                        apply(row); rows = rows + 1; return
                    end
                    local compound, count = pcall(function() return widget:GetNumChildren() end)
                    if compound and count then
                        for i = 0, count - 1 do visit(widget:GetWidgetByIndex(i), depth + 1) end
                    end
                end
                visit(root, 0)
                M.scan.root, M.scan.nodes, M.scan.rows = NameToString(root:GetName()), nodes, rows
                if rows > 0 then return end
            end
        end
    end
end

function M.install(live)
    if not M.installed then
        for _, method in ipairs({'OnDataChanged', 'OnSelected', 'OnDeselected'}) do
            ObserveAfter('PhoneContactItemVirtualController', method, apply)
        end
        M.installed = true
    end
    if live and M.updateOwner ~= convaiManager then
        local owner = convaiManager
        local original = owner.update
        owner.update = function(player, worldReady)
            local result = original(player, worldReady)
            -- Virtual rows can already exist when this Lua adapter is installed
            -- live. Use their current controller; never retain a widget handle.
            if player and player:ConvaiPhoneIsOpen() then
                local ok, err = pcall(M.refresh)
                if not ok then M.lastError = tostring(err) end
            end
            return result
        end
        M.updateOwner = owner
    end
end

convaiPhoneLayout = M
return M
