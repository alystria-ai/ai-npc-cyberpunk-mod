import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The way into and out of the Companion Manager (mod/nsui-entry.lua): the shortcut walks the pause menu to Native Settings UI's "Mods"
// item with the game's own activation (no simulated keys), and closing the manager hands the player back to the game through the real
// Resume item once the Settings screen has detached. Everything here is a fake of the game's menus; the live behaviour is on the
// live-test checklist.
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
local pause = {
    IsA = function(_, class) return class == 'PauseMenuGameController' end,
    menuListController = {Size = function() return #items end,
        GetItemAt = function(_, index) return {GetController = function() return items[index + 1] end} end},
    OnMenuItemActivated = function(_, index, item) activated[#activated + 1] = index .. ':' .. item.label end,
}
Game = {
    GetPlayer = function() return player end,
    GetSystemRequestsHandler = function() return {IsPreGame = function() return preGame end} end,
    GetAllBlackboardDefs = function() return defs end,
    GetBlackboardSystem = function() return {Get = function(_, def) return boards[def] end, GetLocalInstanced = function() return scene end} end,
    GetInkSystem = function() return {GetLayers = function() return {{GetGameControllers = function() return controllers end}} end} end,
}
local nsPresent, beforeOpens, selects = true, 0, 0
local entry = (function() ${source} end)().new({
    ns = function() return nsPresent and {} or nil end,
    beforeOpen = function() beforeOpens = beforeOpens + 1 end,
    select = function() selects = selects + 1 end,
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
  for (const forbidden of [/\bio\./, /\bos\.execute/, /\bos\.remove/, /Input\w*Event/, /SimulateKey|SendKey|PressKey|keybd|inputhooks/i, /ModConfigurationMenu|\bmcm\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(code, /OnMenuItemActivated/);
  assert.match(code, /OnOpenPauseMenu/);
});
