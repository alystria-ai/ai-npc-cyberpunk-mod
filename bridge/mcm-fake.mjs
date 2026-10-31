// A fake Mod Configuration Menu (CET mod "ModConfigurationMenuAPI", Nexus Mods 31640, version 0.10.5, and with options.version 0.10.6 or newer its UI additions) for the Lua tests of the Companion
// Manager's MCM host (mod/mcm-host.lua). It re-implements the public contract the host relies on, with the rules of MCM's own modules
// (modules/core.lua, catalog.lua, drafts.lua, transactions.lua, values.lua, ui_extensions.lua of 0.10.5):
//   * ids: a setting is addressed as "<provider>:<mod>:<id>"; a provider needs id, registrationKey, apiVersion 2, listMods and loadMod;
//   * a schema needs dense arrays; values are normalized the way values.lua does; a draft equal to the saved value is dropped;
//   * an action is refused while drafts are pending, and a reload is too; Apply hands the drafts to applyBatch as {id = <source id>,
//     value}, requires appliedIds to be EXACTLY the ids asked for, loads the schema again and fails if a draft did not keep its value;
//   * layout() says how MCM 0.10.5 DRAWS each row (and says whether MCM's own Defaults button and Modified counter are there), from the rules of its renderer (mcm_native_render.lua addSettingRow, mcm_native_render.lua
//     bottomActions with Extensions.footer, MCMPanelContent.reds McmUiAddManagedLabel / McmUiAddActionSetting / McmUiAddReadonly,
//     MCMPanelActions.reds McmUiCreateAction, MCMLayout.reds ContentTextFontSize and MCMColors): that is what decides how a page looks;
//   * the list's scroll position is a fraction of its height, which the player moves, which MCM resets to the top for a new page id, and
//     which api.ui.getScrollPosition / setScrollPosition read and set (mcm.jumpOnLoad = 0.6 makes every page load jump there, the way the
//     live check showed after Apply);
//   * api.ui answers only for a mod the catalog knows ("Unknown mod" before the provider is indexed), validates what it is given the way
//     ui_extensions.lua does, and returns true, or nil and the reason, never raising; ui.open needs an attached renderer.
//   * MCM 0.10.6 (options.version >= 0.10.6; api.ui.apiVersion stays 1): api.ui.close (queued, taken by update; a pending draft keeps the
//     screen open and sets F.closePrompt, the way MCM asks first), api.ui.setActionVisibility (favorite, defaults, modifiedFilter; hide, show,
//     inherit; each call replaces the map), and the presentation options labelIndent (0-120), highlightModifiedValues and rowFontSize for
//     every row; 0.10.5 refuses an option it does not know, the whole call, as the real one does. layout() follows them: setting labels at
//     labelIndent, no purple with highlightModifiedValues false, no Add to favorites / Defaults / Modified when hidden, and footer labels
//     that wrap (footerWraps) instead of being cut.
// A player is simulated with the helpers of the returned object (open the screen, set a draft, press, apply ...). Use:
// put `mcmFake` in the Lua source of a test, then `local mcm = newMcm({version = '0.10.5'})`; `mcm.api` is what GetMod answers.
export const mcmFake = String.raw`
  local function mcmCopy(value)
    if type(value) ~= 'table' then return value end
    local out = {}
    for key, item in pairs(value) do out[key] = mcmCopy(item) end
    return out
  end
  local function mcmDense(tab, label)
    local count, highest = 0, 0
    for key in pairs(tab) do
      if type(key) == 'number' and key >= 1 and math.floor(key) == key then count = count + 1; if key > highest then highest = key end end
    end
    if highest ~= count then return false, label .. ' must be a dense array without nil gaps.' end
    return true
  end
  local function mcmNormalize(setting, value)
    if setting.type == 'bool' then
      if type(value) ~= 'boolean' then return nil, 'Boolean setting requires true or false.' end
      return value
    end
    if setting.type == 'int' or setting.type == 'select' then
      local number = tonumber(value)
      if number == nil then return nil, 'Integer setting requires a number.' end
      number = math.floor(number)
      if setting.type == 'select' then
        if #setting.elements > 0 and (number < 1 or number > #setting.elements) then return nil, 'Selection index is outside the available values.' end
      else
        if setting.min ~= nil then number = math.max(number, math.ceil(setting.min)) end
        if setting.max ~= nil then number = math.min(number, math.floor(setting.max)) end
        local step = tonumber(setting.step)
        if step and step > 0 then
          local origin = tonumber(setting.min) or 0
          number = math.floor(origin + math.floor((number - origin) / step + 0.5) * step)
        end
      end
      return number
    end
    if setting.type == 'string' then return value == nil and '' or tostring(value) end
    return value
  end

  local function newMcm(options)
    options = options or {}
    local F = {version = options.version or '0.10.5', calls = {}, errors = {}, loads = 0, refuseProvider = options.refuseProvider}
    local providers, providerOrder, catalog, drafts, config = {}, {}, {}, {}, {}
    local active, context, renderer, openRequest = nil, {open = false}, options.renderer ~= false, nil
    local scroll, scrollRequests, lastPage = 0, {}, nil
    -- The Search settings box: its text (kept from page to page and from one visit to the next, as MCM does) and a request made by api.ui.setSearch.
    local searchText, searchRequest = '', nil
    local coreStatus = ''
    local listeners, nextToken = {}, 0
    local api = {version = F.version, apiVersion = 2}
    local function versionAtLeast(wanted)
      local found = {}
      for part in tostring(F.version):gmatch('%d+') do found[#found + 1] = tonumber(part) end
      for index = 1, 3 do
        local have, want = found[index] or 0, wanted[index]
        if have ~= want then return have > want end
      end
      return true
    end
    local newer = versionAtLeast({0, 10, 6})
    local closeRequest
    F.closes, F.closePrompt = 0, false

    local function note(name) F.calls[#F.calls + 1] = name end
    local function emit(name, payload) for _, callback in pairs(listeners[name] or {}) do pcall(callback, payload, name) end end
    local function modOf(key) return catalog[tostring(key or '')] end
    local function hasDrafts(key)
      for _, draft in pairs(drafts) do if draft.modKey == key then return true end end
      return false
    end
    local function countDrafts(key)
      local count = 0
      for _, draft in pairs(drafts) do if draft.modKey == key then count = count + 1 end end
      return count
    end
    local function clearDrafts(key) for id, draft in pairs(drafts) do if draft.modKey == key then drafts[id] = nil end end end

    -- providers -------------------------------------------------------------------------------------------------------------------
    api.providers = {apiVersion = 2}
    function api.providers.registerProvider(provider)
      note('registerProvider')
      if F.refuseProvider then return false, 'The registry is not ready.' end
      if type(provider) ~= 'table' then return false, 'Provider descriptor must be a table.' end
      if type(provider.id) ~= 'string' or provider.id == '' then return false, 'Provider ID must be a non-empty string.' end
      if type(provider.registrationKey) ~= 'string' or provider.registrationKey == '' then return false, 'Provider registrationKey must be a non-empty string.' end
      if tonumber(provider.apiVersion) ~= 2 then return false, 'Provider requires API version 2.' end
      if type(provider.listMods) ~= 'function' then return false, 'Provider does not implement listMods.' end
      if type(provider.loadMod) ~= 'function' then return false, 'Provider does not implement loadMod.' end
      local existing = providers[provider.id]
      if existing and existing.registrationKey ~= provider.registrationKey then return false, 'Provider ID is already owned.' end
      if not existing then providerOrder[#providerOrder + 1] = provider.id end
      providers[provider.id] = provider
      return true, existing and 'replaced' or 'registered'
    end
    function api.providers.unregisterProvider(id, key)
      note('unregisterProvider')
      local existing = providers[id]
      if not existing then return false, 'Provider is not registered.' end
      if key ~= nil and key ~= existing.registrationKey then return false, 'Provider registration key does not match.' end
      providers[id] = nil
      for index, other in ipairs(providerOrder) do if other == id then table.remove(providerOrder, index); break end end
      for key2, mod in pairs(catalog) do if mod.provider == id then catalog[key2] = nil end end
      return true
    end

    function api.refreshProvider(id)
      note('refreshProvider')
      local provider = providers[id]
      if not provider then return nil, 'Unknown provider: ' .. tostring(id) end
      local ok, snapshot = pcall(provider.listMods, {apiVersion = 2})
      if not ok or type(snapshot) ~= 'table' or type(snapshot.mods) ~= 'table' then
        F.errors[#F.errors + 1] = 'listMods: ' .. tostring(snapshot)
        return nil, 'Provider returned no mod index.'
      end
      local good, why = mcmDense(snapshot.mods, 'Provider index mods')
      if not good then return nil, why end
      for _, incoming in ipairs(snapshot.mods) do
        local key = id .. ':' .. tostring(incoming.id)
        local mod = catalog[key] or {key = key, provider = id, sourceId = tostring(incoming.id), categories = {}, settingById = {}, loaded = false}
        mod.name, mod.description = tostring(incoming.name or incoming.id), tostring(incoming.description or '')
        catalog[key] = mod
      end
      return {id = id}, nil
    end

    -- schemas ---------------------------------------------------------------------------------------------------------------------
    local function attach(mod, schema)
      if type(schema) ~= 'table' then return false, 'Provider schema must be a table.' end
      local categories = schema.categories or schema
      local good, why = mcmDense(categories, 'Provider schema categories')
      if not good then return false, why end
      local nextCategories, byId, seen = {}, {}, {}
      for ci, incoming in ipairs(categories) do
        local settings = incoming.settings or {}
        good, why = mcmDense(settings, 'Provider schema category ' .. ci .. ' settings')
        if not good then return false, why end
        local category = {id = tostring(incoming.id or ('category_' .. ci)), name = tostring(incoming.name or ''), description = tostring(incoming.description or ''), settings = {}}
        for si, row in ipairs(settings) do
          if row.elements ~= nil then
            good, why = mcmDense(row.elements, 'Provider schema setting ' .. si .. ' elements')
            if not good then return false, why end
          end
          local base = tostring(row.id or (category.id .. ':setting_' .. si))
          seen[base] = (seen[base] or 0) + 1
          local sourceId = seen[base] == 1 and base or (base .. ':duplicate:' .. seen[base])
          local setting = {id = mod.key .. ':' .. sourceId, sourceId = sourceId, key = sourceId, modKey = mod.key,
            label = tostring(row.label or sourceId), description = tostring(row.description or ''), type = tostring(row.type or 'custom'),
            value = row.value, defaultValue = row.defaultValue, min = row.min, max = row.max, step = row.step,
            elements = mcmCopy(row.elements or {}), capabilities = mcmCopy(row.capabilities or {}),
            disabled = row.disabled == true, supported = row.supported ~= false and row.disabled ~= true}
          local capabilities = setting.capabilities
          local canRead = capabilities.canReadDefault
          if canRead == nil then canRead = setting.defaultValue ~= nil and capabilities.reset ~= false end
          if not setting.supported then canRead = false end
          if canRead and setting.defaultValue ~= nil then
            local normalized, problem = mcmNormalize(setting, setting.defaultValue)
            if problem then canRead, setting.defaultValue = false, nil else setting.defaultValue = normalized end
          else canRead, setting.defaultValue = false, nil end
          capabilities.canReadDefault = canRead
          capabilities.canResetToDefault = canRead and capabilities.reset ~= false and capabilities.write ~= false and capabilities.draft ~= false
          category.settings[#category.settings + 1] = setting
          byId[setting.id] = setting
        end
        nextCategories[#nextCategories + 1] = category
      end
      mod.categories, mod.settingById, mod.loaded = nextCategories, byId, true
      if schema.name ~= nil and tostring(schema.name) ~= '' then mod.name = tostring(schema.name) end
      -- catalog.lua keeps the description of every schema: it is the text of the description panel while no row is hovered.
      if schema.description ~= nil then mod.description = tostring(schema.description) end
      -- Drafts that equal the loaded value are dropped (drafts.lua reconcileMod).
      for id, draft in pairs(drafts) do
        if draft.modKey == mod.key then
          local setting = byId[id]
          if not setting or mcmNormalize(setting, setting.value) == draft.value then drafts[id] = nil end
        end
      end
      return true
    end
    local loading
    local function load(mod)
      if loading then return nil, 'Another mod is already loading: ' .. loading end
      local provider = providers[mod.provider]
      if not provider then return nil, 'Provider is not registered.' end
      loading = mod.key
      local ok, schema, message = pcall(provider.loadMod, mod.sourceId, {apiVersion = 2})
      loading = nil
      F.loads = F.loads + 1
      if F.jumpOnLoad and F.loads > 1 then scroll = F.jumpOnLoad end
      if not ok or type(schema) ~= 'table' then
        local problem = tostring(not ok and schema or message or 'Provider returned no schema.')
        F.errors[#F.errors + 1] = 'loadMod: ' .. problem
        return nil, problem
      end
      local attached, problem = attach(mod, schema)
      if not attached then F.errors[#F.errors + 1] = 'schema: ' .. tostring(problem); return nil, problem end
      return mod
    end

    -- the public calls --------------------------------------------------------------------------------------------------------------
    local function find(settingId)
      for _, mod in pairs(catalog) do if mod.settingById[settingId] then return mod.settingById[settingId], mod end end
    end
    function api.getValue(settingId)
      local setting = find(settingId)
      if not setting then return nil, 'Unknown setting: ' .. tostring(settingId) end
      local draft = drafts[setting.id]
      if draft then return draft.value end
      return setting.value
    end
    function api.setDraft(settingId, value)
      note('setDraft')
      local setting, mod = find(settingId)
      if not setting then return false, 'Unknown setting: ' .. tostring(settingId) end
      local choice = ((((config[mod.key] or {}).choices or {})[setting.key] or {}).states or {})[value]
      if setting.type == 'select' and choice and choice.enabled == false then return false, choice.reason or 'This choice is unavailable.' end
      if setting.disabled or setting.supported == false then return false, 'Setting is read-only.' end
      if setting.capabilities.draft == false or setting.capabilities.write == false then return false, 'Setting does not support drafts.' end
      local normalized, problem = mcmNormalize(setting, value)
      if problem then return false, problem end
      if mcmNormalize(setting, setting.value) == normalized then drafts[setting.id] = nil
      else drafts[setting.id] = {modKey = mod.key, value = normalized} end
      emit('drafts.changed', {modKey = mod.key, count = countDrafts(mod.key)})
      return true
    end
    function api.hasDrafts(key) return hasDrafts(key or active), nil end
    function api.revert(key)
      note('revert')
      clearDrafts(key or active)
      emit('drafts.changed', {modKey = key or active, count = 0})
      return true
    end
    function api.reloadMod(key)
      note('reloadMod')
      local mod = modOf(key or active)
      if not mod then return nil, 'No mod selected.' end
      if hasDrafts(mod.key) then return nil, 'Apply or revert pending changes before reloading this mod.' end
      local loaded, problem = load(mod)
      if not loaded then return nil, problem end
      return {key = mod.key}, nil
    end
    function api.invokeAction(settingId)
      note('invokeAction')
      local setting, mod = find(settingId)
      if not setting then return false, 'Unknown setting: ' .. tostring(settingId) end
      if setting.type ~= 'action' or setting.capabilities.action ~= true then return false, 'Setting is not an executable action.' end
      if hasDrafts(mod.key) then return false, 'Apply or revert pending changes before running this action.' end
      local provider = providers[mod.provider]
      local ok, result = pcall(provider.invokeAction, mod.sourceId, setting.sourceId, {apiVersion = 2})
      if not ok then return false, tostring(result) end
      if type(result) ~= 'table' or result.ok == false then return false, tostring(type(result) == 'table' and result.error or 'Action failed.') end
      if result.schemaChanged == true then
        local loaded, problem = load(mod)
        if not loaded then return false, 'Action completed, but the updated settings could not be loaded: ' .. tostring(problem) end
      end
      coreStatus = 'Completed: ' .. setting.label
      return true, nil, result
    end
    function api.apply(key)
      note('apply')
      local mod = modOf(key or active)
      if not mod then return false, 'No mod selected.' end
      local changes, expected = {}, {}
      for _, category in ipairs(mod.categories) do
        for _, setting in ipairs(category.settings) do
          local draft = drafts[setting.id]
          if draft then
            changes[#changes + 1] = {id = setting.sourceId, value = draft.value, previousValue = setting.value, type = setting.type}
            expected[setting.sourceId] = true
          end
        end
      end
      if #changes == 0 then return true end
      local provider = providers[mod.provider]
      if type(provider.applyBatch) ~= 'function' then return false, 'Provider does not support writable transactions.' end
      local ok, result = pcall(provider.applyBatch, mod.sourceId, changes, {apiVersion = 2})
      if not ok then return false, tostring(result) end
      if type(result) ~= 'table' then return false, 'Provider returned no transaction result.' end
      if result.ok ~= true then return false, tostring(result.error or 'Provider rejected the transaction.') end
      if result.partial == true then return false, 'Provider reported a partial transaction as successful.' end
      if type(result.appliedIds) ~= 'table' then return false, 'Provider transaction result has no appliedIds array.' end
      local applied = {}
      for _, id in ipairs(result.appliedIds) do
        if not expected[tostring(id)] then return false, 'Provider transaction reported an unknown applied setting: ' .. tostring(id) end
        applied[tostring(id)] = true
      end
      for id in pairs(expected) do
        if not applied[id] then return false, 'Provider transaction did not confirm setting: ' .. id end
      end
      local loaded, problem = load(mod)
      if not loaded then clearDrafts(mod.key); return false, 'Applied, but the schema could not be verified: ' .. tostring(problem) end
      local remaining = countDrafts(mod.key)
      if remaining > 0 then
        return false, 'The provider accepted the transaction, but ' .. remaining .. ' setting(s) did not keep the requested value.'
      end
      coreStatus = 'Applied ' .. #changes .. ' change(s) for ' .. mod.name .. '.'
      emit('drafts.changed', {modKey = mod.key, count = 0})
      return true
    end
    function api.subscribe(name, callback)
      nextToken = nextToken + 1
      listeners[name] = listeners[name] or {}
      listeners[name][nextToken] = callback
      return nextToken
    end
    function api.unsubscribe(token)
      for _, byToken in pairs(listeners) do byToken[token] = nil end
      return true
    end

    -- api.ui (MCM 0.10.5, ui_extensions.lua) -----------------------------------------------------------------------------------------
    if not options.noUi then
      local ui = {apiVersion = 1}
      local function known(key)
        assert(type(key) == 'string' and modOf(key), 'Unknown mod')
        return key
      end
      local function checked(name, fn)
        return function(...)
          note('ui.' .. name)
          local ok, result, detail = pcall(fn, ...)
          if not ok then return nil, (tostring(result):gsub('^.-:%d+: ', '')) end
          return result, detail
        end
      end
      local function set(key, field, value)
        known(key)
        config[key] = config[key] or {}
        config[key][field] = mcmCopy(value)
        return true
      end
      function ui.getContext() return mcmCopy(context) end
      function ui.getConfig(key) known(key); return mcmCopy(config[key] or {}) end
      ui.open = checked('open', function(key, opts)
        known(key)
        assert(renderer, 'No UI renderer is available')
        openRequest = key
        return 1
      end)
      ui.getScrollPosition = checked('getScrollPosition', function(key, region)
        known(key)
        assert(region == nil or region == 'content' or region == 'sidebar', 'Unknown scroll region')
        if context.modKey ~= key then return nil, 'Mod is not displayed' end
        return (context.scroll or {})[region or 'content'] or 0
      end)
      ui.setScrollPosition = checked('setScrollPosition', function(key, region, position)
        known(key)
        assert(region == 'content' or region == 'sidebar', 'Unknown scroll region')
        assert(type(position) == 'number' and position >= 0 and position <= 1, 'Scroll position must be between 0 and 1')
        assert(context.open and context.modKey == key, 'Mod is not displayed')
        scrollRequests[#scrollRequests + 1] = {region = region, position = position}
        return #scrollRequests
      end)
      ui.setSearch = checked('setSearch', function(key, text)
        known(key)
        assert(type(text) == 'string', 'Search must be text')
        assert(context.open and context.modKey == key, 'Mod is not displayed')
        searchRequest = text
        return 1
      end)
      ui.setNavigation = checked('setNavigation', function(key, value)
        assert(type(value) == 'table' and type(value.pageId) == 'string', 'Navigation needs a pageId')
        for name in pairs(value) do
          assert(({pageId = true, backActionId = true, escapeBack = true, searchMode = true})[name], 'Unsupported navigation option')
        end
        assert(value.backActionId == nil or type(value.backActionId) == 'string', 'Invalid parent action')
        assert(value.searchMode == nil or value.searchMode == 'filter' or value.searchMode == 'provider', 'Invalid search mode')
        return set(key, 'navigation', {pageId = value.pageId, backActionId = value.backActionId, escapeBack = value.escapeBack ~= false,
          searchMode = value.searchMode or 'filter'})
      end)
      ui.setFooterActions = checked('setFooterActions', function(key, value)
        assert(type(value) == 'table' and #value <= 8, 'At most eight footer actions are allowed')
        for _, id in ipairs(value) do assert(type(id) == 'string', 'Footer entries must reference provider action IDs') end
        return set(key, 'footerActions', value)
      end)
      ui.setApplyPolicy = checked('setApplyPolicy', function(key, policy)
        assert(policy == 'explicit' or policy == 'inherit', 'Apply policy must be explicit or inherit')
        return set(key, 'applyPolicy', policy)
      end)
      ui.setPresentation = checked('setPresentation', function(key, value)
        assert(type(value) == 'table', 'Invalid presentation')
        local allowed = {locale = true, descriptionFontSize = true, rowFontSize = true, labelWidthFraction = true, statusPlacement = true, quietActions = true}
        if newer then allowed.labelIndent, allowed.highlightModifiedValues = true, true end
        for name in pairs(value) do assert(allowed[name], 'Unsupported presentation option: ' .. tostring(name)) end
        for _, name in ipairs({'descriptionFontSize', 'rowFontSize'}) do
          assert(value[name] == nil or (type(value[name]) == 'number' and value[name] >= 12 and value[name] <= 32 and value[name] % 1 == 0), 'Invalid font size')
        end
        assert(value.locale == nil or (type(value.locale) == 'string' and #value.locale <= 16), 'Invalid locale')
        assert(value.labelWidthFraction == nil or (type(value.labelWidthFraction) == 'number' and value.labelWidthFraction >= 0.3 and value.labelWidthFraction <= 0.8), 'Invalid label width')
        assert(value.statusPlacement == nil or value.statusPlacement == 'footer' or value.statusPlacement == 'header', 'Invalid status placement')
        assert(value.labelIndent == nil or (type(value.labelIndent) == 'number' and value.labelIndent >= 0 and value.labelIndent <= 120), 'Invalid label indent')
        assert(value.highlightModifiedValues == nil or type(value.highlightModifiedValues) == 'boolean', 'Invalid modified highlighting flag')
        return set(key, 'presentation', value)
      end)
      if newer then
        ui.close = checked('close', function(key)
          known(key)
          assert(renderer, 'No UI renderer is available')
          assert(context.open and context.modKey == key, 'Mod is not displayed')
          closeRequest = key
          return 1
        end)
        ui.setActionVisibility = checked('setActionVisibility', function(key, value)
          assert(type(value) == 'table', 'Expected action visibility map')
          for name, policy in pairs(value) do
            assert(({favorite = true, defaults = true, modifiedFilter = true})[name], 'Unsupported action visibility option')
            assert(policy == 'inherit' or policy == 'hide' or policy == 'show', 'Invalid visibility policy')
          end
          return set(key, 'actionVisibility', value)
        end)
      end
      ui.setStatus = checked('setStatus', function(key, value)
        assert(value == nil or (type(value) == 'table' and type(value.text) == 'string'), 'Status needs text')
        assert(value == nil or value.kind == nil or value.kind == 'info' or value.kind == 'success' or value.kind == 'error', 'Invalid status kind')
        return set(key, 'status', value)
      end)
      ui.setReadOnlyValues = checked('setReadOnlyValues', function(key, values) return set(key, 'readOnlyValues', values) end)
      ui.setChoiceStates = checked('setChoiceStates', function(key, settingKey, value, opts)
        known(key)
        assert(type(settingKey) == 'string' and type(value) == 'table', 'Invalid choice states')
        for index, entry in pairs(value) do
          assert(type(index) == 'number' and index >= 1 and index % 1 == 0 and type(entry) == 'table', 'Invalid choice index')
          assert(type(entry.enabled) == 'boolean', 'Choice needs enabled flag')
          assert(entry.reason == nil or type(entry.reason) == 'string', 'Choice reason must be text')
        end
        local choices = mcmCopy((config[key] or {}).choices or {})
        choices[settingKey] = {states = mcmCopy(value), wrap = opts == nil or opts.wrap ~= false}
        return set(key, 'choices', choices)
      end)
      ui.clear = checked('clear', function(key) known(key); config[key] = nil; return true end)
      api.ui = ui
    end

    -- the player and the screen --------------------------------------------------------------------------------------------------------
    F.api, F.config = api, function(key) return config[key or 'cyberpunk-convai:manager'] or {} end
    F.drafts = function() local list = {}; for id, draft in pairs(drafts) do list[id] = draft.value end; return list end
    F.mod = function(key) return modOf(key or 'cyberpunk-convai:manager') end

    function F.openMod(key)
      local mod = modOf(key)
      assert(mod, 'unknown mod ' .. tostring(key))
      local loaded, problem = load(mod)
      assert(loaded, 'the page did not load: ' .. tostring(problem))
      active = key
      context = {open = true, modKey = key, pageId = (config[key] or {}).navigation and config[key].navigation.pageId or nil,
        search = searchText, scroll = {content = 0, sidebar = 0}}
      scroll, lastPage = 0, context.pageId
    end
    -- The screen opens on the mod (a request made by api.ui.open or the player's own choice in the list).
    function F.openScreen(key)
      key = key or 'cyberpunk-convai:manager'
      for _, id in ipairs(providerOrder) do api.refreshProvider(id) end
      F.openMod(key)
    end
    function F.closeScreen()
      local mod = modOf(active)
      if mod then
        local provider = providers[mod.provider]
        if provider and type(provider.closeMod) == 'function' then pcall(provider.closeMod, mod.sourceId, {apiVersion = 2}) end
        clearDrafts(mod.key)
      end
      active, context = nil, {open = false}
      scroll, scrollRequests = 0, {}
    end
    -- MCM's own update: it takes the requests made through api.ui.open and publishes the context.
    function F.update()
      if closeRequest then
        local key = closeRequest
        closeRequest = nil
        if active == key then
          if hasDrafts(key) then F.closePrompt = true else F.closes = F.closes + 1; F.closeScreen() end
        end
      end
      if openRequest then
        local key = openRequest
        openRequest = nil
        if not active then F.openScreen(key) end
      end
      if active then
        if searchRequest ~= nil then searchText, searchRequest = searchRequest, nil end
        context.search = searchText
        context.pageId = (config[active] or {}).navigation and config[active].navigation.pageId or nil
        -- A new page id starts at the top (MCM keeps a position per page id); a request to set the position is taken after that.
        if context.pageId ~= lastPage then lastPage, scroll = context.pageId, 0 end
        for _, request in ipairs(scrollRequests) do if request.region == 'content' then scroll = request.position end end
        scrollRequests = {}
        context.scroll = {content = scroll, sidebar = 0}
      end
    end
    -- The player types in the Search settings box (MCM publishes the text on its next update, after its few frames of settling).
    function F.search(text) searchText = text end
    function F.searchText() return searchText end
    -- MCM's own filter (mcm_model.lua flattenSettings): a row stays when the text is in its label, name, key or description, or in the
    -- name of its category, case folded. The provider search mode switches it off (the provider does the filtering).
    local function searchShows(category, setting)
      local navigation = (config[active] or {}).navigation or {}
      if navigation.searchMode == 'provider' or searchText == '' then return true end
      for _, id in ipairs((config[active] or {}).footerActions or {}) do if id == setting.sourceId then return true end end
      local query = searchText:lower()
      local haystack = table.concat({tostring(setting.label or ''), tostring(setting.name or ''), tostring(setting.sourceId or ''), tostring(setting.description or '')}, ' '):lower()
      return (tostring(category.name or '') .. ' ' .. tostring(category.id or '')):lower():find(query, 1, true) ~= nil or haystack:find(query, 1, true) ~= nil
    end
    -- The player drags the list.
    function F.scrollTo(position) scroll = position; if active then context.scroll = {content = scroll, sidebar = 0} end end
    function F.scroll() return scroll end
    function F.rows()
      local rows = {}
      local mod = modOf(active)
      if not mod then return rows end
      for _, category in ipairs(mod.categories) do
        for _, setting in ipairs(category.settings) do
          local draft = drafts[setting.id]
          if searchShows(category, setting) then rows[#rows + 1] = {category = category.name, id = setting.sourceId, label = setting.label, type = setting.type, description = setting.description,
            value = draft and draft.value or setting.value, saved = setting.value, draft = draft ~= nil, elements = setting.elements,
            default = setting.defaultValue, disabled = setting.disabled, capabilities = setting.capabilities, min = setting.min, max = setting.max, step = setting.step} end
        end
      end
      return rows
    end
    -- How the page is drawn: one entry per heading and row of the list, in order, and the footer buttons (left to right).
    --   setting  (bool, select, int and their kin): label in the marker column (x 48), size 22, red, or purple when the value differs from
    --            the default the provider gave (MCM's "changed" mark; it needs a default; the player may choose an asterisk instead);
    --   action   (supported, with the action capability): label flush left (x 20), size 22, red, a button with the value as its text;
    --   readonly (a string, or anything unsupported or disabled, such as a disabled action): size 26, value in muted blue, the label at x 36:
    --            MCM draws it as a surface at x 20 with its text inset by 16 (MCMLayout.reds ListRowTextLeftInset, 4 with text-only list
    --            selection), so it starts further right than the label of an action under it (x 20), whatever labelIndent says.
    -- The x of a setting (48) is MCMLayout.reds contentLabelX = markerX 20 + marker width 20 + gap 8, a constant; the presentation options
    -- (rowFontSize, labelWidthFraction ...) do not move it, and neither does any property of a row.
    -- A footer action is not in the list; it is a footer button labelled by its value.
    function F.layout()
      local out = {rows = {}, footer = {}}
      local mod = modOf(active)
      if not mod then return out end
      local cfg = config[active] or {}
      local presentation = newer and cfg.presentation or {}
      local visibility = newer and cfg.actionVisibility or {}
      local rowSize = presentation.rowFontSize
      local inFooter = {}
      for _, id in ipairs(cfg.footerActions or {}) do inFooter[id] = true end
      for _, category in ipairs(mod.categories) do
        local visible = {}
        for _, setting in ipairs(category.settings) do
          if not inFooter[setting.sourceId] and searchShows(category, setting) then visible[#visible + 1] = setting end
        end
        if #visible > 0 then
          out.rows[#out.rows + 1] = {kind = 'heading', label = category.name, description = category.description}
          for _, setting in ipairs(visible) do
            local draft = drafts[setting.id]
            local value = draft and draft.value or setting.value
            local entry = {id = setting.sourceId, label = setting.label, type = setting.type}
            local drawn = setting.supported and (setting.type == 'bool' or setting.type == 'select' or setting.type == 'int'
              or setting.type == 'float' or setting.type == 'key')
            if drawn then
              entry.kind, entry.x, entry.size, entry.button = 'setting', presentation.labelIndent or 48, rowSize or 22, false
              entry.color = (presentation.highlightModifiedValues ~= false and setting.defaultValue ~= nil and mcmNormalize(setting, value) ~= setting.defaultValue) and 'modified' or 'red'
            elseif setting.supported and setting.type == 'action' then
              entry.kind, entry.x, entry.size, entry.color, entry.button, entry.buttonText = 'action', 20, rowSize or 22, 'red', true, setting.value
            else
              entry.kind, entry.x, entry.size, entry.color, entry.button = 'readonly', 36, rowSize or 26, 'red', false
            end
            out.rows[#out.rows + 1] = entry
          end
        end
      end
      for _, id in ipairs(cfg.footerActions or {}) do
        local setting = mod.settingById[mod.key .. ':' .. id]
        if setting and setting.type == 'action' and setting.capabilities.action == true then
          out.footer[#out.footer + 1] = {id = id, label = setting.value or setting.label}
        end
      end
      -- MCM's own bottom buttons (mcm_native_render.lua bottomActions): Defaults when a setting with a readable default is off it, and
      -- the Modified (n) counter when any setting has a default (mcm_model.lua modifiedSettingCount). A mod that gives no defaults has neither.
      local modified, comparable = 0, 0
      for _, category in ipairs(mod.categories) do
        for _, setting in ipairs(category.settings) do
          if setting.defaultValue ~= nil then
            comparable = comparable + 1
            local draft = drafts[setting.id]
            local value = draft and draft.value or setting.value
            if mcmNormalize(setting, value) ~= setting.defaultValue then modified = modified + 1 end
          end
        end
      end
      out.mcmDefaultsButton, out.modified, out.comparable = modified > 0 and visibility.defaults ~= 'hide', modified, comparable
      -- The whole footer row, left to right, as MCM's bottomActions builds it: Revert and Apply while drafts are pending, its own Defaults,
      -- Add to favorites (a setting of the PLAYER in MCM, favoriteUxMode "button" or "both", the default; the public API has no way for a
      -- mod to hide it), the Modified counter, then the provider's footer buttons. renderActionRows gives every button the same share
      -- of the row (the row's width minus the gaps, divided by the number of buttons) and cuts a label that is wider, ending it with an
      -- ellipsis. footerShare is that share in the units of optionUnits(); the 55 is calibrated on a screenshot of five buttons, where
      -- "Restore defaults" (13.7) lost its end after about 11 units (the exact pixels are native, so this is an estimate).
      local row = {}
      if next(drafts) then
        row[#row + 1] = {label = 'REVERT', mcm = true}
        row[#row + 1] = {label = 'APPLY', mcm = true}
      end
      if out.mcmDefaultsButton then row[#row + 1] = {label = 'DEFAULTS', mcm = true} end
      -- Add to favorites is shown by the player's own MCM setting; a mod can hide it from 0.10.6 (favorite = 'hide').
      if visibility.favorite ~= 'hide' then row[#row + 1] = {label = 'ADD TO FAVORITES', mcm = true} end
      if comparable > 0 and visibility.modifiedFilter ~= 'hide' then row[#row + 1] = {label = 'MODIFIED (' .. modified .. ')', mcm = true} end
      for _, button in ipairs(out.footer) do row[#row + 1] = {label = button.label, id = button.id} end
      out.footerRow, out.footerShare = row, 55 / math.max(1, #row)
      -- 0.10.6: a label that does not fit wraps onto another line instead of being cut.
      out.footerWraps = newer
      return out
    end
    -- The description of the mod as the last schema gave it (what MCM's description panel says while no row is hovered).
    function F.description()
      local mod = modOf(active)
      return mod and mod.description or ''
    end
    function F.row(label)
      for _, row in ipairs(F.rows()) do if row.label == label or row.id == label then return row end end
    end
    function F.categories()
      local names = {}
      local mod = modOf(active)
      for _, category in ipairs(mod and mod.categories or {}) do names[#names + 1] = category.name end
      return names
    end
    local function settingId(label)
      local row = assert(F.row(label), 'no row: ' .. tostring(label))
      return active .. ':' .. row.id
    end
    function F.set(label, value) return api.setDraft(settingId(label), value) end
    function F.press(label) return api.invokeAction(settingId(label)) end
    function F.apply() return api.apply(active) end
    function F.revert() return api.revert(active) end
    function F.status()
      local status = (config[active] or {}).status
      return status and status.text or ''
    end
    function F.coreStatus() return coreStatus end
    return F
  end
`;
