// A fake Native Settings UI (CET mod "nativeSettings", Nexus Mods 3518, version 1.96) for the Lua tests of the Companion Manager host.
// It re-implements the public contract the host relies on: the same data tables, the same path rules (including the pattern use that
// breaks a tab id with magic characters), the same live placement of widgets while a tab is open, and the same hole NSUI leaves in
// its section list when a section is removed from the middle. It records every call and can check, at any time, that the widgets on
// "screen" are exactly what the data says, in the same order. A player is simulated with ns.interact.
//
// Use: put `nativeSettingsFake` in the Lua source of a test; it defines the local `ns`, installs GetMod and the observer fakes, and
// leaves the game fakes (player, blackboards, pause menu) to the test.
export const nativeSettingsFake = String.raw`
  local ns = {data = {}, currentTab = '', fromMods = false, version = 1.96, lastNativeSettingsCategoryIndex = 0,
    settingsMainController = nil, settingsOptionsList = nil, optionCount = 0, calls = {}, interact = {}, screen = nil}
  local observers = {}
  Observe = function(class, method, callback)
    local key = class .. '.' .. method
    observers[key] = observers[key] or {}
    table.insert(observers[key], callback)
  end
  ObserveAfter = Observe
  Override = Observe
  local function fire(key, ...)
    for _, callback in ipairs(observers[key] or {}) do callback(...) end
  end
  local function record(...) ns.calls[#ns.calls + 1] = {...} end
  function ns.callCount(name)
    local count = 0
    for _, call in ipairs(ns.calls) do if call[1] == name then count = count + 1 end end
    return count
  end
  function ns.resetCalls() ns.calls = {} end

  local function getIndex(list, value)
    local found
    for index, item in pairs(list) do if item == value then found = index end end
    return found
  end

  function ns.pathExists(path)
    if path:match('/.*/.*') then
      local tabPath = path:match('/.*/'):gsub('/', '')
      local subPath = path:gsub(tabPath, ''):gsub('/', '')
      if ns.data[tabPath].subcategories[subPath] == nil then return false end
      return true, 0, tabPath, subPath
    elseif path:match('/.*[^/]') then
      local tabPath = path:gsub('/', '')
      if ns.data[tabPath] == nil then return false end
      return true, 1, tabPath
    end
    return false, 2
  end

  -- The widgets on screen while a Mods screen shows a tab: a list of {kind = 'strip' | 'option', name, option}.
  local function spawn(entry, index)
    local list = ns.screen.children
    list[#list + 1] = entry
    if index ~= nil then
      table.remove(list, #list)
      table.insert(list, index + 1, entry)
    end
  end
  local function removeChild(name)
    for index, entry in ipairs(ns.screen.children) do
      if entry.name == name then table.remove(ns.screen.children, index); return true end
    end
    return false
  end
  local function nextName()
    local name = 'option_' .. ns.optionCount
    ns.optionCount = ns.optionCount + 1
    return name
  end
  -- The controller of a spawned row, modelled on NSUI 1.96 spawnButton: the switch ("settingsSelectorBool") has a layout/container with
  -- an offState and an onState, each with a body that holds the button art (button, buttonBorder, txtValue). NSUI hides the parts of
  -- the onState body only (its "off" path points at the onState body too), so the offState body keeps drawing the frame. The two
  -- state bodies of the controller are inkWidgetRef fields: a method call on them fails as it does in the game, only the static
  -- inkWidgetRef.SetVisible(ref, state) reaches the widget.
  local function node(children)
    local self = {visible = true, children = children or {}}
    for name, child in pairs(self.children) do child.name = name end
    function self:SetVisible(state) self.visible = state end
    function self:IsVisible() return self.visible end
    function self:GetName() return self.name or 'root' end
    function self:GetClassName() return 'inkWidget' end
    function self:GetOpacity() return 1.0 end
    local function names() local list = {} for name in pairs(self.children) do list[#list + 1] = name end table.sort(list) return list end
    function self:GetNumChildren() return #names() end
    function self:GetWidgetByIndex(index) return self.children[names()[index + 1]] end
    function self:GetWidgetByPath(path)
      local current = self
      for _, name in ipairs(path.parts) do
        current = current.children[name]
        if not current then return nil end
      end
      return current
    end
    return self
  end
  BuildWidgetPath = function(parts) return {parts = parts} end
  inkWidgetRef = {
    SetVisible = function(ref, state) ref.node:SetVisible(state) end,
    IsVisible = function(ref) return ref.node.visible end,
  }
  function ns.newController(option)
    local controller = {option = option}
    local container = node()
    local function body() return node({button = node(), buttonBorder = node(), txtValue = node()}) end
    container.children.offState = node({body = body()})
    container.children.onState = node({body = body()})
    -- The frame images of the button, under the container itself (bk is the rectangle behind them, already invisible).
    container.children.bk_fill = node(); container.children.bk_fill.name = 'bk_fill'
    container.children.bk_border = node(); container.children.bk_border.name = 'bk_border'
    container.children.bk = node(); container.children.bk.visible = false; container.children.bk.name = 'bk'
    local root = node({layout = node({container = container})})
    function controller:GetRootWidget() if ns.brokenRoot then error('no root widget') end return root end
    controller.offStateBody = {node = container.children.offState.children.body}
    controller.onStateBody = {node = container.children.onState.children.body}
    ns.nsuiHideOnState(container.children.onState.children.body)
    return controller
  end
  -- NSUI's own hiding in spawnButton (the onState body, twice).
  function ns.nsuiHideOnState(body)
    for _, name in ipairs({'button', 'txtValue', 'buttonBorder'}) do body.children[name]:SetVisible(false) end
  end
  -- The parts of the two bodies of a controller, for a test: {off = {button, buttonBorder, txtValue}, on = {...}} as visible flags.
  function ns.parts(controller)
    local container = controller:GetRootWidget():GetWidgetByPath(BuildWidgetPath({'layout', 'container'}))
    local result = {}
    for key, state in pairs({off = 'offState', on = 'onState'}) do
      local body = container:GetWidgetByPath(BuildWidgetPath({state, 'body'}))
      result[key] = {button = body:GetWidgetByPath(BuildWidgetPath({'button'})).visible,
        buttonBorder = body:GetWidgetByPath(BuildWidgetPath({'buttonBorder'})).visible,
        txtValue = body:GetWidgetByPath(BuildWidgetPath({'txtValue'})).visible}
    end
    result.bkFill = container:GetWidgetByPath(BuildWidgetPath({'bk_fill'})).visible
    result.bkBorder = container:GetWidgetByPath(BuildWidgetPath({'bk_border'})).visible
    return result
  end
  local function live(tabPath) return ns.screen ~= nil and ns.currentTab == tabPath end

  function ns.addTab(path, label, closed)
    record('addTab', path, label)
    path = path:gsub('/', '')
    ns.data[path] = {path = path, label = label, closedCallback = closed, options = {}, subcategories = {}, keys = {}}
  end

  function ns.addSubcategory(path, label, optionalIndex)
    record('addSubcategory', path, label)
    local tabPath = path:match('/.*/'):gsub('/', '')
    local subPath = path:gsub(tabPath, ''):gsub('/', '')
    local valid, state = ns.pathExists('/' .. tabPath)
    if not valid or state ~= 1 then return end
    ns.data[tabPath].subcategories[subPath] = {path = subPath, label = label, options = {}}
    local idx = optionalIndex or #ns.data[tabPath].keys + 1
    table.insert(ns.data[tabPath].keys, idx, subPath)
    if live(tabPath) then
      local placement = #ns.data[tabPath].options
      for i, key in pairs(ns.data[tabPath].keys) do
        if idx == i then break end
        placement = placement + #ns.data[tabPath].subcategories[key].options + 1
      end
      spawn({kind = 'strip', name = subPath, label = label}, placement)
    end
  end

  function ns.removeSubcategory(path)
    record('removeSubcategory', path)
    local tabPath = path:match('/.*/'):gsub('/', '')
    local subPath = path:gsub(tabPath, ''):gsub('/', '')
    local valid, state = ns.pathExists('/' .. tabPath)
    if not valid or state ~= 1 then return end
    if ns.data[tabPath].subcategories[subPath] == nil then return end
    if live(tabPath) then
      removeChild(subPath)
      for _, option in pairs(ns.data[tabPath].subcategories[subPath].options) do removeChild(option.widgetName) end
    end
    ns.data[tabPath].subcategories[subPath] = nil
    ns.data[tabPath].keys[getIndex(ns.data[tabPath].keys, subPath)] = nil
  end

  function ns.removeOption(tab)
    record('removeOption', tab.label)
    local _, state, tabPath, subPath = ns.pathExists(tab.fullPath)
    if state == 0 then
      local i = getIndex(ns.data[tabPath].subcategories[subPath].options, tab)
      if not i then return end
      if live(tabPath) then removeChild(ns.data[tabPath].subcategories[subPath].options[i].widgetName) end
      table.remove(ns.data[tabPath].subcategories[subPath].options, i)
    else
      local i = getIndex(ns.data[tabPath].options, tab)
      if not i then return end
      if live(tabPath) then removeChild(ns.data[tabPath].options[i].widgetName) end
      ns.data[tabPath].options[i] = nil
    end
  end

  local function optionOffset(tabPath, subPath, optionalIndex)
    local placement
    if subPath ~= nil then
      local idx = optionalIndex or #ns.data[tabPath].subcategories[subPath].options + 1
      placement = #ns.data[tabPath].options + idx
      for _, key in pairs(ns.data[tabPath].keys) do
        if key == subPath then break end
        placement = placement + #ns.data[tabPath].subcategories[key].options + 1
      end
    else
      placement = optionalIndex or #ns.data[tabPath].options
      placement = math.min(placement, #ns.data[tabPath].options)
    end
    return placement
  end

  local function add(kind, path, fields, optionalIndex)
    local valid, state, tabPath, subPath = ns.pathExists(path)
    local placement = optionOffset(tabPath, subPath, optionalIndex)
    if not valid then return nil end
    fields.type, fields.path, fields.controller, fields.fullPath = kind, path, nil, path
    record('add:' .. kind, path, fields.label)
    if state == 0 then
      fields.path = subPath
      table.insert(ns.data[tabPath].subcategories[subPath].options, optionalIndex or #ns.data[tabPath].subcategories[subPath].options + 1, fields)
    else
      fields.path = tabPath
      table.insert(ns.data[tabPath].options, optionalIndex or #ns.data[tabPath].options + 1, fields)
    end
    if live(tabPath) then
      fields.widgetName = nextName()
      fields.controller = ns.newController(fields)
      spawn({kind = 'option', name = fields.widgetName, option = fields}, placement)
    end
    return fields
  end

  function ns.addSwitch(path, label, desc, state, default, callback, index)
    assert(type(state) == 'boolean', 'a switch needs a boolean')
    return add('switch', path, {label = label, desc = desc, state = state, defaultValue = default, callback = callback}, index)
  end
  function ns.addRangeInt(path, label, desc, min, max, step, value, default, callback, index)
    assert(min <= value and value <= max, 'the slider value is outside its range: ' .. tostring(label))
    return add('rangeInt', path, {label = label, desc = desc, min = min, max = max, step = math.floor(step), currentValue = value,
      defaultValue = default, callback = callback}, index)
  end
  function ns.addSelectorString(path, label, desc, elements, selected, default, callback, index)
    assert(#elements > 0 and selected >= 1 and selected <= #elements, 'the selector position is outside its list: ' .. tostring(label))
    return add('selectorString', path, {label = label, desc = desc, elements = elements, selectedElementIndex = selected,
      defaultValue = default, callback = callback}, index)
  end
  function ns.addButton(path, label, desc, text, size, callback, index)
    return add('button', path, {label = label, desc = desc, buttonText = text, textSize = size, callback = callback}, index)
  end

  function ns.registerRestoreDefaultsCallback(path, override, callback)
    path = path:gsub('/', '')
    ns.data[path].overrideNativeRestoreDefaults = override
    ns.data[path].restoreDefaultsCallback = callback
  end

  local function allOptions()
    local all = {}
    for _, tab in pairs(ns.data) do
      for _, option in pairs(tab.options) do all[#all + 1] = option end
      for _, sub in pairs(tab.subcategories) do for _, option in pairs(sub.options) do all[#all + 1] = option end end
    end
    return all
  end

  function ns.setOption(tab, value)
    record('setOption', tab.label)
    for _, o in pairs(allOptions()) do
      if o == tab then
        if o.type == 'switch' then
          assert(type(value) == 'boolean')
          if o.state == value then return end
          o.state = value; o.callback(o.state)
        elseif o.type == 'rangeInt' then
          assert(type(value) == 'number')
          if o.currentValue == value then return end
          o.currentValue = value; o.callback(o.currentValue)
        elseif o.type == 'selectorString' then
          assert(type(value) == 'number')
          if o.selectedElementIndex == value then return end
          o.selectedElementIndex = value; o.callback(o.selectedElementIndex)
        end
        return
      end
    end
    error('the option table could not be found')
  end

  -- The Mods screen: opening a tab spawns its widgets from the data, in order (tab options, then each section and its options).
  function ns.open(tabPath, controller)
    assert(ns.data[tabPath], 'no such tab: ' .. tostring(tabPath))
    ns.screen = {children = {}, tab = tabPath}
    ns.settingsMainController = controller or {descriptionText = {}, selectorCtrl = {SetToggledIndex = function(_, index) ns.toggledIndex = index end}}
    ns.settingsOptionsList = {widget = {GetNumChildren = function() return #ns.screen.children end,
      GetWidgetByIndex = function(_, index) return ns.screen.children[index + 1].widget end}}
    local tab = ns.data[tabPath]
    for _, option in pairs(tab.options) do
      option.widgetName = nextName(); option.controller = ns.newController(option)
      spawn({kind = 'option', name = option.widgetName, option = option})
    end
    for _, key in pairs(tab.keys) do
      local sub = tab.subcategories[key]
      spawn({kind = 'strip', name = key, label = sub.label})
      for _, option in pairs(sub.options) do
        option.widgetName = nextName(); option.controller = ns.newController(option)
        spawn({kind = 'option', name = option.widgetName, option = option})
      end
    end
    ns.currentTab = tabPath
  end

  -- What NSUI does when the screen closes or another tab is chosen: the tab's closed callback, then the controllers are dropped.
  function ns.leave()
    local tab = ns.data[ns.currentTab]
    if tab and tab.closedCallback then tab.closedCallback() end
    for _, option in pairs(allOptions()) do option.controller = nil end
    ns.currentTab = ''
    ns.screen = nil
  end

  -- Opening the Mods screen the way the game does it: fromMods is set by the menu item, then the Settings screen initializes.
  function ns.openScreen(tabPath)
    ns.fromMods = true
    ns.settingsController = {nativeIdentity = 7001}
    fire('SettingsMainGameController.OnInitialize', ns.settingsController)
    ns.open(tabPath, ns.settingsController)
    ns.settingsController.descriptionText = ns.settingsController.descriptionText or {}
    ns.settingsController.selectorCtrl = {SetToggledIndex = function(_, index) ns.toggledIndex = index end}
    return ns.settingsController
  end
  function ns.closeScreen()
    fire('SettingsMainGameController.RequestClose', ns.settingsController)
    ns.leave()
    fire('SettingsMainGameController.OnUninitialize', ns.settingsController)
    ns.fromMods = false
  end

  -- The widgets on screen must be exactly the data, in order: [tab options, (section strip, its options)...].
  function ns.verify()
    if not ns.screen then return true end
    local tab = ns.data[ns.screen.tab]
    local expected = {}
    for _, option in pairs(tab.options) do expected[#expected + 1] = option.widgetName end
    for _, key in pairs(tab.keys) do
      expected[#expected + 1] = key
      for _, option in pairs(tab.subcategories[key].options) do expected[#expected + 1] = option.widgetName end
    end
    local actual = {}
    for _, entry in ipairs(ns.screen.children) do actual[#actual + 1] = entry.name end
    assert(#expected == #actual, 'the screen has ' .. #actual .. ' widgets, the data has ' .. #expected)
    for index = 1, #expected do assert(expected[index] == actual[index], 'widget ' .. index .. ' is out of place') end
    return true
  end

  -- The list the tab shows now, as text: "strip", then its rows as "label = text" (buttons) or "label".
  function ns.outline(tabPath)
    local tab = ns.data[tabPath or ns.currentTab]
    local lines = {}
    for _, key in pairs(tab.keys) do
      lines[#lines + 1] = '## ' .. tab.subcategories[key].label
      for _, option in pairs(tab.subcategories[key].options) do
        local text = option.label
        if option.type == 'button' and option.buttonText ~= '' then text = text .. ' = ' .. option.buttonText end
        lines[#lines + 1] = text
      end
    end
    return lines
  end
  function ns.sections(tabPath)
    local tab = ns.data[tabPath or ns.currentTab]
    local result = {}
    for _, key in pairs(tab.keys) do
      local sub = tab.subcategories[key]
      result[#result + 1] = {id = key, label = sub.label, options = sub.options}
    end
    return result
  end
  function ns.find(label, tabPath)
    local tab = ns.data[tabPath or ns.currentTab]
    for _, key in pairs(tab.keys) do
      for _, option in pairs(tab.subcategories[key].options) do
        if option.label == label or option.label:sub(1, #label + 1) == label .. ':' then return option end
      end
    end
  end

  -- The player.
  local function shown(option)
    assert(option and option.controller, 'the widget is not on screen: ' .. tostring(option and option.label))
    for _, entry in ipairs(ns.screen.children) do if entry.option == option then return end end
    error('the widget is not on screen: ' .. tostring(option.label))
  end
  function ns.interact.toggle(option)
    shown(option); assert(option.type == 'switch')
    option.state = not option.state
    option.callback(option.state)
  end
  function ns.interact.select(option, index)
    shown(option); assert(option.type == 'selectorString')
    option.selectedElementIndex = index
    option.callback(index)
  end
  function ns.interact.slide(option, value)
    shown(option); assert(option.type == 'rangeInt')
    option.currentValue = value
    option.callback(value)
  end
  function ns.interact.press(option)
    shown(option); assert(option.type == 'button')
    option.callback()
  end
  -- NSUI's own lookup of the option a controller belongs to (nativeSettings.getOptionTable), and the game's hover event of the
  -- Settings screen: the pointer (or the gamepad highlight) moves onto the row of an option.
  function ns.getOptionTable(controller)
    for _, option in pairs(allOptions()) do
      if option.controller ~= nil and option.controller == controller then return option end
    end
    return nil
  end
  function ns.interact.hover(option)
    shown(option)
    local event = {GetCurrentTarget = function() return {GetController = function() return option.controller end} end}
    fire('SettingsMainGameController.OnSettingHoverOver', ns.settingsController, event)
  end
  -- "Restore defaults" as NSUI's override does it: the tab's callback, and when it does not take over, every default.
  function ns.interact.restoreDefaults()
    local tab = ns.data[ns.currentTab]
    if tab.restoreDefaultsCallback then tab.restoreDefaultsCallback() end
    if tab.overrideNativeRestoreDefaults then return end
    for _, option in pairs(allOptions()) do
      if option.defaultValue ~= nil then ns.setOption(option, option.defaultValue) end
    end
  end

  GetMod = function(name)
    if name == 'nativeSettings' then return ns end
    return nil
  end
  ns.fire = fire
`;
