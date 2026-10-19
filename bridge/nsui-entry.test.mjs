import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The way into and out of the Companion Manager (mod/nsui-entry.lua): the shortcut walks the pause menu to Native Settings UI's "Mods"
// item with the game's own activation (no simulated keys), and closing the manager hands the player back to the game through the real
// Resume item once the Settings screen has detached. With Mod Configuration Menu (MCM) beside it, which hides NSUI's item and adds its
// own (data labelled "Mods", event OnSwitchToMCM), the walk activates MCM's item instead, stops when MCM's Settings screen is up and asks
// for a notice (MCM's public API cannot choose a mod in its screen), and closing that screen returns to the game too. Everything here is
// a fake of the game's menus; the live behaviour is on the live-test checklist.
const source = readFileSync(new URL('../mod/nsui-entry.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(`${fixture}\n${body}`));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const fixture = `
local callbacks, clock, logs = {}, 100, {}
Observe = function(class, method, callback) callbacks[class .. '.' .. method] = callback end
ObserveAfter = Observe
local function fire(class, method, ...)
    local callback = callbacks[class .. '.' .. method]
    if callback then callback(...) end
end
local function emit(method, ...) fire('SettingsMainGameController', method, ...) end
os.time = function() return clock end
NameToString = function(value) return value end
CName = {new = function(value) return value end}
local nativeIds, nextNativeId = {}, 100
CalcSeed = function(value)
    if value.failIdentity then error('unavailable identity') end
    if value.nilIdentity then return nil end
    if value.nativeId then return value.nativeId end
    if not nativeIds[value] then nextNativeId = nextNativeId + 1; nativeIds[value] = nextNativeId end
    return nativeIds[value]
end
local inMenu, attached, preGame, composerOpen, sceneTier = false, true, false, false, 0
local menuWrites = {}
local player = {IsAttached = function() return attached end, GetEntityID = function() return 'player' end,
    ConvaiComposerOpen = function() return composerOpen end}
local defs = {UI_System = {IsInMenu = 'isInMenu'}, PlayerStateMachine = {SceneTier = 'tier'},
    MenuEventBlackboard = {MenuEventToTrigger = 'trigger'}}
local boards = {
    [defs.UI_System] = {GetBool = function() return inMenu end},
    [defs.MenuEventBlackboard] = {SetName = function(_, field, value) menuWrites[#menuWrites + 1] = field .. '=' .. tostring(value) end},
}
local scene = {GetInt = function() return sceneTier end}
local controllers, activated = {}, {}
local function target(label, event) return {GetData = function() return {label = label, eventName = event} end, label = label, event = event} end
-- The pause menu as Native Settings UI leaves it: the game's own Settings item and NSUI's Mods item share an event; only the label differs.
local items = {target('Save', 'OnSwitchToSaveGame'), target('Settings', 'OnSwitchToSettings'), target('Mods', 'OnSwitchToSettings'),
    target('Resume', 'OnClosePauseMenu')}
-- An item's widget says whether it is on screen: MCM hides NSUI's item with SetVisible(false) (item.hidden); a game that does not say
-- (item.noVisibility) has a widget without the method.
local pause = {
    IsA = function(_, class) return class == 'PauseMenuGameController' end,
    menuListController = {Size = function() return #items end,
        GetItemAt = function(_, index)
            local item = items[index + 1]
            local widget = {GetController = function() return item end}
            if not item.noVisibility then widget.IsVisible = function() return item.hidden ~= true end end
            return widget
        end},
    OnMenuItemActivated = function(_, index, item) activated[#activated + 1] = index .. ':' .. item.label end,
}
-- Mod Configuration Menu beside NSUI: its own item (data labelled "Mods", event OnSwitchToMCM) sits before Resume. By default MCM hides
-- NSUI's item, which stays in the list; with its "redirect" setting off NSUI's item stays on screen and opens NSUI.
local function installMcm(options)
    options = options or {}
    local item = target('Mods', options.event or 'OnSwitchToMCM')
    table.insert(items, #items, item)
    if options.redirect ~= false then items[3].hidden = true end
    return item
end
local function indexOfLabel(label)
    for index, item in ipairs(items) do if item.label == label then return index - 1 end end
end
Game = {
    GetPlayer = function() return player end,
    GetSystemRequestsHandler = function() return {IsPreGame = function() return preGame end} end,
    GetAllBlackboardDefs = function() return defs end,
    GetBlackboardSystem = function() return {Get = function(_, def) return boards[def] end, GetLocalInstanced = function() return scene end} end,
    GetInkSystem = function() return {GetLayers = function() return {{GetGameControllers = function() return controllers end}} end} end,
}
local nsPresent, beforeOpens, selects = true, 0, 0
local notices, noticeRaises = {}, false
local entry = (function() ${source} end)().new({
    ns = function() return nsPresent and {} or nil end,
    beforeOpen = function() beforeOpens = beforeOpens + 1 end,
    select = function() selects = selects + 1 end,
    notify = function(kind) if noticeRaises then error('notice unavailable') end notices[#notices + 1] = kind end,
    log = function(message) logs[#logs + 1] = message end,
})
entry.install()
local settings = {}
emit('OnInitialize', settings)
-- The host says which Settings instance shows the tab; closing and detaching are the game's events.
local function render() entry.shown(settings) end
local function closeAndDetach() emit('RequestClose', settings); emit('OnUninitialize', settings) end
local function resumeCount() local count = 0; for _, entry in ipairs(activated) do if entry:find(':Resume', 1, true) then count = count + 1 end end; return count end
local function otherCount() return #activated - resumeCount() end
`;

test('the shortcut in gameplay opens the pause menu, then activates the Mods item (not the game\'s own Settings item) and is done when the tab shows', () => {
  run(`
    local ok, reason = entry.open()
    assert(ok == true and reason == nil and entry.state() == 'pause' and beforeOpens == 1)
    assert(#menuWrites == 1 and menuWrites[1] == 'trigger=OnOpenPauseMenu', 'the pause menu is opened by the game\\'s own event: ' .. table.concat(menuWrites, ','))
    -- The pause menu is not up yet: nothing happens, nothing is activated.
    entry.update(); entry.update()
    assert(entry.state() == 'pause' and #activated == 0)
    -- It appears (the game calls the observed method); the next frame activates the Mods item.
    inMenu = true; controllers = {pause}
    fire('PauseMenuGameController', 'PopulateMenuItemList', pause)
    entry.update()
    assert(entry.state() == 'settings' and #activated == 1 and activated[1] == '2:Mods', table.concat(activated, ','))
    -- The Settings screen builds, NSUI shows our tab: the walk is over.
    emit('OnInitialize', settings); render()
    assert(entry.state() == 'idle' and entry.inspect().problem == '' and entry.inspect().shown)
    entry.update(); assert(#activated == 1, 'one activation only')
  `);
});

test('the shortcut from the pause menu does not write to the menu blackboard and starts at the Mods item', () => run(`
  inMenu = true; controllers = {pause}
  local ok = entry.open()
  assert(ok == true and #menuWrites == 0 and beforeOpens == 1 and entry.state() == 'pause')
  entry.update()
  assert(activated[1] == '2:Mods' and entry.state() == 'settings')
`));

test('the shortcut says why it cannot start and leaves everything alone: no Native Settings UI, no save, a text box, a scene, another menu', () => run(`
  nsPresent = false
  local ok, reason = entry.open()
  assert(ok == false and reason == 'The Companion Manager needs Native Settings UI (Nexus Mods)', tostring(reason))
  nsPresent = true
  attached = false
  ok, reason = entry.open(); assert(ok == false and reason == 'Load a save first.', tostring(reason)); attached = true
  preGame = true
  ok, reason = entry.open(); assert(ok == false and reason == 'Load a save first.', tostring(reason)); preGame = false
  composerOpen = true
  ok, reason = entry.open(); assert(ok == false and reason == 'Close the text box first.', tostring(reason)); composerOpen = false
  sceneTier = 3
  ok, reason = entry.open(); assert(ok == false and reason == 'Finish the scene first.', tostring(reason)); sceneTier = 0
  inMenu = true; controllers = {}
  ok, reason = entry.open()
  assert(ok == false and reason == 'Close the current menu first, or choose Mods from the pause menu.', tostring(reason))
  assert(beforeOpens == 0 and #menuWrites == 0 and #activated == 0 and entry.state() == 'idle', 'nothing was started')
  -- A failure in a native call is an answer, not an error.
  Game.GetPlayer = function() error('no player') end
  inMenu = false
  ok, reason = entry.open(); assert(ok == false and tostring(reason):find('no player', 1, true) and entry.state() == 'idle')
`));

test('pressing the shortcut again while the walk is under way changes nothing; while the manager is open it closes it', () => run(`
  entry.open(); assert(entry.state() == 'pause')
  local again = entry.open()
  assert(again == true and #menuWrites == 1 and beforeOpens == 1, 'a second press does not start a second walk')
  entry.reset()
  -- The manager is open on this Settings screen: the shortcut closes it, as Esc does.
  local closes = 0
  settings.RequestClose = function() closes = closes + 1 end
  emit('OnInitialize', settings); render()
  assert(entry.open() == true and closes == 1 and #menuWrites == 1 and beforeOpens == 1)
`));

test('the walk gives up after eight seconds with a sentence naming the way by hand, without activating anything else', () => run(`
  entry.open(); controllers = {}
  clock = clock + 5; entry.update(); assert(entry.state() == 'pause')
  clock = clock + 4; entry.update()
  assert(entry.state() == 'idle' and #activated == 0)
  assert(entry.inspect().problem == 'The shortcut timed out. Choose AI NPC Cyberpunk Mod from the pause menu under Mods.', entry.inspect().problem)
  assert(#logs == 1 and logs[1]:find('Manager entry:', 1, true) == 1)
  -- Without the Mods item (Native Settings UI did not add it) the same: the game's own Settings item is never used in its place.
  entry.reset(); logs = {}; clock = clock + 1
  items[3] = target('Photo mode', 'OnSwitchToPhotoMode')
  inMenu = true; controllers = {pause}
  entry.open(); entry.update(); entry.update()
  assert(entry.state() == 'pause' and #activated == 0, 'no Mods item: nothing is activated')
  clock = clock + 9; entry.update()
  assert(entry.state() == 'idle' and #activated == 0 and #logs == 1)
`));

test('an activation that raises ends the walk with the reason, once', () => run(`
  inMenu = true; controllers = {pause}
  pause.OnMenuItemActivated = function() error('unavailable') end
  entry.open(); entry.update()
  assert(entry.state() == 'idle' and #logs == 1 and entry.inspect().problem:find('Could not activate the Mods entry', 1, true) == 1, entry.inspect().problem)
  entry.update(); assert(#logs == 1)
`));

test('when the Settings screen opens on another tab, the tab is selected once after two seconds', () => run(`
  inMenu = true; controllers = {pause}
  entry.open(); entry.update(); assert(entry.state() == 'settings')
  emit('OnInitialize', settings)
  clock = clock + 1; entry.update(); assert(selects == 0, 'not before two seconds')
  clock = clock + 1; entry.update(); assert(selects == 1)
  clock = clock + 3; entry.update(); assert(selects == 1, 'one attempt only')
  -- When the tab is shown on its own, nothing needs selecting.
  entry.reset(); selects = 0
  entry.open(); entry.update(); render(); clock = clock + 5; entry.update()
  assert(selects == 0 and entry.state() == 'idle')
`));

test('accepted manager close activates the genuine Resume item only after Settings detaches', () => run(`
  -- Includes manually opening Companion Manager from Esc > Mods; the shortcut is not required.
  render()
  emit('RequestClose', settings)
  assert(entry.inspect().returnToGame)
  inMenu = true; controllers = {pause}
  entry.update()
  assert(resumeCount() == 0, 'resume must wait for Settings disposal')
  emit('OnUninitialize', settings)
  entry.update()
  assert(resumeCount() == 1 and otherCount() == 0 and activated[1] == '3:Resume', table.concat(activated, ','))
  assert(not entry.inspect().returnToGame)
  entry.update()
  assert(resumeCount() == 1, 'must not resume a later pause menu twice')
`));

test('the host saying the tab is no longer shown between the close and the detach does not lose an accepted exit', () => run(`
  render()
  emit('RequestClose', settings)
  entry.shown(nil)
  emit('OnUninitialize', settings)
  inMenu = true; entry.update()
  assert(resumeCount() == 0 and entry.inspect().returnToGame)
  controllers = {pause}
  entry.update()
  assert(resumeCount() == 1)
`));

test('fresh CET wrappers for one native Settings instance still match show, close and detach', () => run(`
  -- Distinct Lua objects model the WeakReference wrappers CET constructs for each callback. Native identity stays fixed while wrapper
  -- equality fails.
  local created, shown, closing, detached = {nativeId = 701}, {nativeId = 701}, {nativeId = 701}, {nativeId = 701}
  assert(created ~= shown and shown ~= closing and closing ~= detached)
  emit('OnInitialize', created)
  entry.shown(shown)
  assert(entry.inspect().shown)
  emit('RequestClose', closing)
  assert(entry.inspect().returnToGame)
  emit('OnUninitialize', detached)
  assert(entry.inspect().settingsDetached and not entry.inspect().shown)
  assert(not entry.inspect().capturedSettings)
  inMenu = true; controllers = {pause}; entry.update()
  local events = entry.inspect().exitEvents
  assert(resumeCount() == 1 and events.matchedCloses == 1 and events.matchedDetachments == 1 and events.resumes == 1)
  assert(events.identityFailures == 0)
`));

test('another native Settings instance cannot close or detach the shown tab', () => run(`
  settings.nativeId = 901; emit('OnInitialize', settings); render()
  emit('RequestClose', {nativeId = 902})
  emit('OnUninitialize', {nativeId = 902})
  assert(entry.inspect().shown and entry.inspect().capturedSettings)
  assert(not entry.inspect().returnToGame and entry.inspect().exitEvents.matchedCloses == 0)
  emit('RequestClose', {nativeId = 901})
  emit('OnUninitialize', {nativeId = 902})
  inMenu = true; controllers = {pause}; entry.update(); assert(resumeCount() == 0)
  emit('OnUninitialize', {nativeId = 901}); entry.update(); assert(resumeCount() == 1)
`));

test('missing native identity fails closed instead of trusting wrapper strings or nil equality', () => run(`
  local bad = {nilIdentity = true}
  emit('OnInitialize', bad)
  entry.shown(bad)
  emit('RequestClose', bad); emit('OnUninitialize', bad)
  inMenu = true; controllers = {pause}; entry.update()
  assert(not entry.inspect().shown and not entry.inspect().returnToGame and resumeCount() == 0)
  assert(entry.inspect().exitEvents.identityFailures == 4, tostring(entry.inspect().exitEvents.identityFailures))
  local broken = {failIdentity = true}
  entry.shown(broken); emit('RequestClose', broken)
  assert(not entry.inspect().returnToGame and entry.inspect().exitEvents.identityFailures == 6)
`));

test('the game\'s own Settings screen, another tab and a screen the tab never showed on never resume', () => run(`
  inMenu = true; controllers = {pause}
  -- The tab is not shown (another tab, or the game's own Settings): closing the screen is the player's own business.
  closeAndDetach(); entry.update()
  assert(resumeCount() == 0)
  emit('OnInitialize', settings); render(); entry.shown(nil); closeAndDetach(); entry.update()
  assert(resumeCount() == 0, 'the tab was left before the screen closed')
  -- Shown on one instance, closed on another.
  local other = {nativeId = 555}
  emit('OnInitialize', settings); render(); emit('RequestClose', other); emit('OnUninitialize', other); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
`));

test('a new Settings screen opened after a close cancels the pending resume, and so does a reset', () => run(`
  inMenu = true; controllers = {pause}
  render(); closeAndDetach(); emit('OnInitialize', {}); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  emit('OnInitialize', settings); render(); closeAndDetach(); entry.reset(); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
`));

test('teardown, a save reload, pre-game and leaving the menu without an accepted close cannot auto-resume', () => run(`
  inMenu = true; controllers = {pause}
  render(); emit('OnUninitialize', settings); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  emit('OnInitialize', settings); render(); closeAndDetach(); attached = false
  entry.update(); attached = true; entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  emit('OnInitialize', settings); render(); closeAndDetach(); preGame = true; entry.update(); preGame = false
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  emit('OnInitialize', settings); render(); closeAndDetach(); inMenu = false; entry.update(); inMenu = true
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
`));

test('an absent native Resume times out without selecting a different action; a failing activation is consumed once', () => {
  run(`
    inMenu = true; controllers = {pause}
    render(); closeAndDetach()
    items[4] = target('Load', 'OnSwitchToLoadGame')
    entry.update(); assert(resumeCount() == 0 and otherCount() == 0 and entry.inspect().returnToGame)
    clock = clock + 4; entry.update()
    assert(not entry.inspect().returnToGame and #logs == 1)
    assert(entry.inspect().problem == 'Could not find the native Resume action after closing the manager.')
    assert(resumeCount() == 0 and otherCount() == 0)
  `);
  run(`
    inMenu = true; controllers = {pause}
    render(); closeAndDetach()
    local attempted = 0
    pause.OnMenuItemActivated = function() attempted = attempted + 1; error('unavailable') end
    entry.update(); entry.update()
    assert(attempted == 1 and #logs == 1 and not entry.inspect().returnToGame)
  `);
});

test('with nothing to do the entry costs one comparison per frame: no game call while idle', () => run(`
  local calls = 0
  Game.GetPlayer = function() calls = calls + 1; return player end
  Game.GetInkSystem = function() calls = calls + 1; return {GetLayers = function() return {} end} end
  for _ = 1, 500 do entry.update() end
  assert(calls == 0, 'idle frames called into the game ' .. calls .. ' times')
  render()
  for _ = 1, 500 do entry.update() end
  assert(calls == 0, 'a shown tab with no exit under way calls nothing')
`));

test('the entry never simulates input and never touches another mod\'s files or handlers', () => {
  const code = source.replace(/--[^\n]*/g, '');
  for (const forbidden of [/\bio\./, /\bos\.execute/, /\bos\.remove/, /Input\w*Event/, /SimulateKey|SendKey|PressKey|keybd|inputhooks/i,
    // Mod Configuration Menu: its screen functions (McmUi*), its mods and its API are never called or hooked; its pause-menu item is only
    // recognised by the event it carries, and activated like any other item.
    /ModConfigurationMenu|McmUi|NativeSettingsLifecycle|\bGetMod\b|\bOverride\b|\bhookBefore\b|\bhookAfter\b/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(code, /OnMenuItemActivated/);
  assert.match(code, /OnOpenPauseMenu/);
  assert.match(code, /OnSwitchToMCM/);
  // The only game classes it observes are the pause menu and the Settings screen, by the methods the walk needs.
  const observed = [...code.matchAll(/Observe(?:After)?\('(\w+)', '(\w+)'/g)].map(match => `${match[1]}.${match[2]}`).sort();
  assert.deepEqual([...new Set(observed)], ['PauseMenuGameController.OnInitialize', 'PauseMenuGameController.PopulateMenuItemList',
    'SettingsMainGameController.OnInitialize', 'SettingsMainGameController.OnUninitialize', 'SettingsMainGameController.RequestClose']);
});

test('a player without this mod\'s scripts (no text-box method) can still start the walk', () => run(`
  player.ConvaiComposerOpen = nil
  local ok = entry.open()
  assert(ok == true and entry.state() == 'pause' and beforeOpens == 1)
`));

// ---- Mod Configuration Menu beside Native Settings UI -------------------------------------------------------------------------------------

test('without Mod Configuration Menu nothing changes: NSUI\'s item is the one activated, by the plain walk, and no notice is asked for', () => run(`
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(activated[1] == '2:Mods' and entry.state() == 'settings' and entry.inspect().route == 'nsui', table.concat(activated, ','))
  emit('OnInitialize', settings); render()
  assert(entry.state() == 'idle' and entry.inspect().shown and #notices == 0 and entry.inspect().notice == nil and entry.inspect().problem == '')
  assert(not entry.inspect().mcmScreen)
`));

test('with MCM (NSUI\'s item hidden) the shortcut activates MCM\'s own Mods item, stops when MCM\'s screen has opened and asks for the notice once', () => run(`
  local item = installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); assert(entry.state() == 'pause' and beforeOpens == 1)
  entry.update()
  -- MCM's item is index 3 (before Resume); NSUI's hidden item at index 2 is not touched.
  assert(entry.state() == 'mcm' and entry.inspect().route == 'mcm' and #activated == 1 and activated[1] == '3:Mods', table.concat(activated, ','))
  assert(items[4] == item and items[3].hidden == true)
  -- MCM builds its screen: nothing is selected on NSUI's side, and no notice before the screen is up.
  clock = clock + 3; entry.update()
  assert(selects == 0 and #notices == 0 and entry.state() == 'mcm', 'the tab is not selected behind the screen of MCM')
  local screen = {nativeId = 801}
  emit('OnInitialize', screen)
  assert(#notices == 0, 'the notice is asked for from the update, not inside a callback of the game')
  entry.update()
  assert(entry.state() == 'idle' and entry.inspect().problem == '' and entry.inspect().notice == 'mcm-list' and #notices == 1 and notices[1] == 'mcm-list')
  assert(entry.inspect().mcmScreen and not entry.inspect().shown, 'the screen of MCM is the one a close is matched against')
  assert(#logs == 1 and logs[1]:find('Manager entry:', 1, true) == 1 and logs[1]:find('Mod Configuration Menu', 1, true))
  -- Done: later frames neither activate nor notify again.
  for _ = 1, 3 do clock = clock + 5; entry.update() end
  assert(#activated == 1 and #notices == 1)
`));

test('with MCM, from gameplay, the pause menu is opened by the game\'s own event and the same item is activated once it is up', () => run(`
  installMcm()
  local ok = entry.open()
  assert(ok == true and #menuWrites == 1 and menuWrites[1] == 'trigger=OnOpenPauseMenu' and beforeOpens == 1)
  entry.update(); entry.update(); assert(#activated == 0)
  inMenu = true; controllers = {pause}
  fire('PauseMenuGameController', 'PopulateMenuItemList', pause)
  entry.update()
  assert(entry.state() == 'mcm' and activated[1] == '3:Mods', table.concat(activated, ','))
  emit('OnInitialize', {nativeId = 802}); entry.update()
  assert(entry.state() == 'idle' and #notices == 1)
`));

test('with MCM and its redirect setting off NSUI\'s item stays visible: the plain walk, the tab is shown, no notice', () => run(`
  installMcm({redirect = false})
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(entry.state() == 'settings' and entry.inspect().route == 'nsui' and activated[1] == '2:Mods', table.concat(activated, ','))
  emit('OnInitialize', settings); render()
  assert(entry.state() == 'idle' and entry.inspect().shown and #notices == 0 and entry.inspect().problem == '')
  -- NSUI opened on another tab of its memory: the tab is selected once, as without MCM.
  entry.reset(); selects = 0; activated = {}
  entry.open(); entry.update(); emit('OnInitialize', {nativeId = 803}); clock = clock + 2; entry.update()
  assert(selects == 1 and #notices == 0)
`));

test('with MCM, a walk that cannot tell whether NSUI\'s item is on screen takes MCM\'s; MCM\'s item alone is taken too', () => run(`
  installMcm()
  for _, item in ipairs(items) do item.noVisibility = true end
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(entry.state() == 'mcm' and activated[1] == '3:Mods', table.concat(activated, ','))
  entry.reset(); activated = {}
  -- NSUI's item is gone from the list altogether (a later MCM may remove it): MCM's item is the way.
  table.remove(items, 3)
  entry.open(); entry.update()
  assert(entry.state() == 'mcm' and activated[1] == '2:Mods' and items[3].event == 'OnSwitchToMCM', table.concat(activated, ','))
`));

test('a later MCM that renames its event is still found by its visible Mods label; the other frameworks\' items and Resume are never taken for it', () => run(`
  installMcm({event = 'OnSwitchToMcmScreen'})
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(entry.state() == 'mcm' and activated[1] == '3:Mods', table.concat(activated, ','))
  -- Mod Settings and RCF label their items Mods too (events OnSwitchToModSettings, OnSwitchToRCFSettings): with no NSUI item and no
  -- MCM item nothing is activated, and the walk gives up.
  entry.reset(); activated = {}
  items = {target('Save', 'OnSwitchToSaveGame'), target('Settings', 'OnSwitchToSettings'), target('Mods', 'OnSwitchToModSettings'),
    target('Mods', 'OnSwitchToRCFSettings'), target('Resume', 'OnClosePauseMenu')}
  entry.open(); entry.update(); entry.update()
  assert(entry.state() == 'pause' and #activated == 0, table.concat(activated, ','))
  clock = clock + 9; entry.update()
  assert(entry.state() == 'idle' and #activated == 0 and #notices == 0)
  -- NSUI\'s item is on screen beside them: it is the one activated.
  entry.reset(); activated = {}
  items = {target('Save', 'OnSwitchToSaveGame'), target('Mods', 'OnSwitchToModSettings'), target('Mods', 'OnSwitchToSettings'),
    target('Resume', 'OnClosePauseMenu')}
  items[2].hidden = true
  entry.open(); entry.update()
  assert(entry.state() == 'settings' and activated[1] == '2:Mods' and entry.inspect().route == 'nsui', table.concat(activated, ','))
`));

test('when NSUI\'s item is hidden and no MCM item can be told, NSUI\'s item is still the one activated, as before the change', () => run(`
  items[3].hidden = true
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(entry.state() == 'settings' and entry.inspect().route == 'nsui' and activated[1] == '2:Mods', table.concat(activated, ','))
  clock = clock + 9; entry.update()
  assert(entry.state() == 'idle' and entry.inspect().problem:find('timed out', 1, true) and #notices == 0)
`));

test('with MCM, a walk whose Settings screen never opens gives up after eight seconds with the same sentence and asks for no notice', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  assert(entry.state() == 'mcm' and #activated == 1)
  clock = clock + 7; entry.update(); assert(entry.state() == 'mcm')
  clock = clock + 2; entry.update()
  assert(entry.state() == 'idle' and #activated == 1 and #notices == 0)
  assert(entry.inspect().problem == 'The shortcut timed out. Choose AI NPC Cyberpunk Mod from the pause menu under Mods.', entry.inspect().problem)
  assert(#logs == 1 and logs[1]:find('Manager entry:', 1, true) == 1)
  -- A screen that opens after the give-up is nobody\'s: no notice, and closing it resumes nothing.
  local late = {nativeId = 811}
  emit('OnInitialize', late); entry.update(); emit('RequestClose', late); emit('OnUninitialize', late); entry.update()
  assert(#notices == 0 and resumeCount() == 0 and not entry.inspect().returnToGame and not entry.inspect().mcmScreen)
  -- The pause menu shows neither MCM's item nor NSUI's: nothing is activated, the same sentence after eight seconds.
  entry.reset(); logs = {}; activated = {}
  items = {target('Save', 'OnSwitchToSaveGame'), target('Settings', 'OnSwitchToSettings'), target('Resume', 'OnClosePauseMenu')}
  entry.open(); entry.update(); entry.update()
  assert(entry.state() == 'pause' and #activated == 0)
  clock = clock + 9; entry.update()
  assert(entry.state() == 'idle' and #activated == 0 and #notices == 0 and #logs == 1 and entry.inspect().problem:find('timed out', 1, true))
`));

test('with MCM, an activation that raises ends the walk with the reason, once, and asks for no notice', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  pause.OnMenuItemActivated = function() error('unavailable') end
  entry.open(); entry.update()
  assert(entry.state() == 'idle' and #logs == 1 and #notices == 0 and entry.inspect().problem:find('Could not activate the Mods entry', 1, true) == 1, entry.inspect().problem)
  entry.update(); assert(#logs == 1)
`));

test('a notice that cannot be shown does not break the walk or the way back to the game', () => run(`
  installMcm(); noticeRaises = true
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local screen = {nativeId = 821}
  emit('OnInitialize', screen); entry.update()
  assert(entry.state() == 'idle' and entry.inspect().problem == '' and #notices == 0 and entry.inspect().mcmScreen)
  emit('RequestClose', screen); emit('OnUninitialize', screen); entry.update()
  assert(resumeCount() == 1)
`));

test('closing MCM\'s screen that the shortcut opened activates the genuine Resume item once, after the screen has detached', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local screen = {nativeId = 831}
  emit('OnInitialize', screen); entry.update()
  assert(entry.inspect().mcmScreen and not entry.inspect().returnToGame)
  -- The player closes MCM (after its own draft dialog, if any): the close is accepted, the resume waits for the detach.
  emit('RequestClose', screen)
  assert(entry.inspect().returnToGame and entry.inspect().exitEvents.matchedCloses == 1)
  entry.update(); assert(resumeCount() == 0, 'resume must wait for the screen to be disposed')
  emit('OnUninitialize', screen)
  assert(entry.inspect().settingsDetached and not entry.inspect().mcmScreen)
  entry.update()
  assert(resumeCount() == 1 and otherCount() == 1 and activated[#activated] == '4:Resume', table.concat(activated, ','))
  entry.update(); entry.update(); assert(resumeCount() == 1, 'once')
`));

test('with MCM, another Settings screen, a screen opened by hand and a reset never resume', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local screen = {nativeId = 841}
  emit('OnInitialize', screen); entry.update()
  -- Another Settings instance closes or detaches: the screen of the shortcut is untouched.
  emit('RequestClose', {nativeId = 842}); emit('OnUninitialize', {nativeId = 842}); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame and entry.inspect().mcmScreen)
  -- A screen the player opens later by hand supersedes it: neither its close nor the old screen\'s resumes anything.
  local hand = {nativeId = 843}
  emit('OnInitialize', hand)
  assert(not entry.inspect().mcmScreen)
  emit('RequestClose', hand); emit('OnUninitialize', hand); emit('RequestClose', screen); emit('OnUninitialize', screen); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  -- A reset (a save reload) between an accepted close and the detach cancels the exit.
  entry.reset(); activated = {}
  entry.open(); entry.update()
  local again = {nativeId = 844}
  emit('OnInitialize', again); entry.update(); emit('RequestClose', again)
  assert(entry.inspect().returnToGame)
  entry.reset(); emit('OnUninitialize', again); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
  -- Leaving the menu before the detach (an accepted close that did not end in the pause menu) cancels it as well.
  entry.open(); entry.update()
  local third = {nativeId = 845}
  emit('OnInitialize', third); entry.update(); emit('RequestClose', third); inMenu = false; entry.update(); inMenu = true
  emit('OnUninitialize', third); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
`));

test('the shortcut pressed while MCM\'s screen that it opened is up closes it, the way Esc does, and starts no second walk', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local screen, closes = {nativeId = 846}, 0
  screen.RequestClose = function() closes = closes + 1 end
  emit('OnInitialize', screen); entry.update()
  local walks, writes = beforeOpens, #menuWrites
  assert(entry.open() == true and closes == 1 and entry.state() == 'idle' and beforeOpens == walks and #menuWrites == writes and #activated == 1)
  -- A screen that was not opened by the shortcut is not closed by it (after a reset the walk starts over from the pause menu).
  entry.reset(); emit('OnInitialize', screen)
  assert(entry.open() == true and closes == 1 and entry.state() == 'pause')
`));

test('a missing native identity on MCM\'s screen fails closed: the walk ends with the notice, closing resumes nothing', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local bad = {nilIdentity = true}
  emit('OnInitialize', bad); entry.update()
  assert(entry.state() == 'idle' and #notices == 1 and not entry.inspect().mcmScreen)
  emit('RequestClose', bad); emit('OnUninitialize', bad); entry.update()
  assert(resumeCount() == 0 and not entry.inspect().returnToGame)
`));

test('the walk through MCM costs nothing once it is over: no game call while idle, with the screen of the shortcut still up', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  emit('OnInitialize', {nativeId = 851}); entry.update()
  assert(entry.inspect().mcmScreen and entry.state() == 'idle')
  local calls = 0
  Game.GetPlayer = function() calls = calls + 1; return player end
  Game.GetInkSystem = function() calls = calls + 1; return {GetLayers = function() return {} end} end
  for _ = 1, 500 do clock = clock + 0.01; entry.update() end
  assert(calls == 0, 'idle frames called into the game ' .. calls .. ' times')
`));

test('the list the walk saw is kept for the report: each item with its label, event and whether it was on screen', () => run(`
  installMcm()
  inMenu = true; controllers = {pause}
  entry.open(); entry.update()
  local seen = entry.inspect().items
  assert(#seen == 5, #seen)
  local expected = {{'Save', 'OnSwitchToSaveGame', true}, {'Settings', 'OnSwitchToSettings', true}, {'Mods', 'OnSwitchToSettings', false},
    {'Mods', 'OnSwitchToMCM', true}, {'Resume', 'OnClosePauseMenu', true}}
  for index, item in ipairs(expected) do
    assert(seen[index].label == item[1] and seen[index].event == item[2] and seen[index].visible == item[3], index .. ': ' .. seen[index].label .. ' ' .. seen[index].event)
  end
`));
