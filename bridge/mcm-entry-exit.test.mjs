import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/mcm-entry.lua', import.meta.url), 'utf8');
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
local function emit(method, ...)
    local callback = callbacks['SettingsMainGameController.' .. method]
    if callback then callback(...) end
end
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
local inMenu, attached, preGame, ownPage = true, true, false, true
local player = {IsAttached = function() return attached end}
local controllers, resumed, otherActivated = {}, 0, 0
local resumeTarget = {GetData = function() return {eventName = 'OnClosePauseMenu'} end}
local otherTarget = {GetData = function() return {eventName = 'OnSwitchToSaveGame'} end}
local pause = {
    IsA = function(_, class) return class == 'PauseMenuGameController' end,
    menuListController = {Size = function() return 2 end,
        GetItemAt = function(_, index) return {GetController = function()
            return index == 0 and otherTarget or resumeTarget
        end} end},
    OnMenuItemActivated = function(_, index, target)
        if index == 1 and target == resumeTarget then resumed = resumed + 1
        else otherActivated = otherActivated + 1 end
    end,
}
Game = {
    GetPlayer = function() return player end,
    GetSystemRequestsHandler = function() return {IsPreGame = function() return preGame end} end,
    GetAllBlackboardDefs = function() return {UI_System = {IsInMenu = 'isInMenu'}} end,
    GetBlackboardSystem = function() return {Get = function() return {
        GetBool = function() return inMenu end,
    } end} end,
    GetInkSystem = function() return {GetLayers = function() return {
        {GetGameControllers = function() return controllers end}
    } end} end,
}
local entry = (function() ${source} end)().new('Companion Manager', function() return true end,
    function(message) logs[#logs + 1] = message end, function() return ownPage end)
entry.install()
local settings = {}
emit('OnInitialize', settings)
local function render(title)
    emit('McmUiBegin', settings, 'MCM', '', 'Mods', 'Select a mod')
    emit('McmUiSetContentTitle', settings, title or 'Companion Manager')
end
local function closeAndDetach()
    emit('RequestClose', settings)
    emit('OnUninitialize', settings)
end
`;

test('accepted manager close activates the genuine Resume item only after Settings detaches', () => {
  run(`
    -- Includes manually opening Companion Manager; the shortcut is not required.
    render()
    emit('RequestClose', settings)
    assert(entry.inspect().returnToGame)
    controllers = {pause}
    entry.update()
    assert(resumed == 0, 'resume must wait for Settings disposal')
    emit('OnUninitialize', settings)
    entry.update()
    assert(resumed == 1 and otherActivated == 0)
    assert(not entry.inspect().returnToGame)
    entry.update()
    assert(resumed == 1, 'must not resume a later pause menu twice')
  `);
});

test('MCM cleanup clearing API ownership does not lose an accepted manager exit', () => {
  run(`
    render()
    ownPage = false -- MCM Screen.close may run before our RequestClose observer.
    closeAndDetach()
    entry.update()
    assert(resumed == 0 and entry.inspect().returnToGame)
    controllers = {pause}
    entry.update()
    assert(resumed == 1)
  `);
});

test('fresh CET wrappers for one native Settings instance still match render, close and detach', () => {
  run(`
    -- Distinct Lua objects model the WeakReference wrappers CET constructs for
    -- each callback. Native identity stays fixed while wrapper equality fails.
    local created = {nativeId = 701}
    local rendered = {nativeId = 701}
    local closing = {nativeId = 701}
    local detached = {nativeId = 701}
    assert(created ~= rendered and rendered ~= closing and closing ~= detached)
    emit('OnInitialize', created)
    emit('McmUiBegin', rendered, 'MCM', '', 'Mods', 'Select a mod')
    emit('McmUiSetContentTitle', rendered, 'Companion Manager')
    assert(entry.inspect().ownedPage)
    emit('RequestClose', closing)
    assert(entry.inspect().returnToGame)
    emit('OnUninitialize', detached)
    assert(entry.inspect().settingsDetached and not entry.inspect().ownedPage)
    assert(not entry.inspect().capturedSettings)
    controllers = {pause}; entry.update()
    local events = entry.inspect().exitEvents
    assert(resumed == 1 and events.matchedCloses == 1 and events.matchedDetachments == 1 and events.resumes == 1)
    assert(events.identityFailures == 0)
  `);
});

test('another native Settings instance cannot close or detach an owned page', () => {
  run(`
    settings.nativeId = 901; emit('OnInitialize', settings); render()
    emit('RequestClose', {nativeId = 902})
    emit('OnUninitialize', {nativeId = 902})
    assert(entry.inspect().ownedPage and entry.inspect().capturedSettings)
    assert(not entry.inspect().returnToGame and entry.inspect().exitEvents.matchedCloses == 0)
    emit('RequestClose', {nativeId = 901})
    emit('OnUninitialize', {nativeId = 902})
    controllers = {pause}; entry.update(); assert(resumed == 0)
    emit('OnUninitialize', {nativeId = 901}); entry.update(); assert(resumed == 1)
  `);
});

test('missing native identity fails closed instead of trusting wrapper strings or nil equality', () => {
  run(`
    local bad = {nilIdentity = true}
    emit('OnInitialize', bad)
    emit('McmUiSetContentTitle', bad, 'Companion Manager')
    emit('RequestClose', bad); emit('OnUninitialize', bad)
    controllers = {pause}; entry.update()
    assert(not entry.inspect().ownedPage and not entry.inspect().returnToGame and resumed == 0)
    assert(entry.inspect().exitEvents.identityFailures == 4)
    local broken = {failIdentity = true}
    emit('McmUiSetContentTitle', broken, 'Companion Manager'); emit('RequestClose', broken)
    assert(not entry.inspect().returnToGame and entry.inspect().exitEvents.identityFailures == 6)
  `);
});

test('another mod, same display name from another provider, or native Settings never resumes', () => {
  run(`
    controllers = {pause}
    render(); render('Another mod'); closeAndDetach(); entry.update()
    assert(resumed == 0)
    emit('OnInitialize', settings); ownPage = false; render(); closeAndDetach(); entry.update()
    assert(resumed == 0, 'title alone cannot claim another provider')
    emit('OnInitialize', settings); ownPage = true; closeAndDetach(); entry.update()
    assert(resumed == 0, 'native Settings never rendered our provider')
  `);
});

test('provisional MCM titles cannot own exit and every new render clears previous ownership', () => {
  run(`
    controllers = {pause}
    emit('McmUiBegin', settings, 'MCM', '', 'Mods', 'Companion Manager')
    closeAndDetach(); entry.update(); assert(resumed == 0)
    emit('OnInitialize', settings); render()
    emit('McmUiBegin', settings, 'MCM', '', 'Settings', 'General')
    -- A partial/global render still carrying activeModKey cannot resume gameplay.
    closeAndDetach(); entry.update(); assert(resumed == 0)
    emit('OnInitialize', settings); render(); emit('RequestClose', settings)
    -- A new render after a close request means that Settings is still in use.
    emit('McmUiBegin', settings, 'MCM', '', 'Settings', 'General')
    emit('OnUninitialize', settings); entry.update(); assert(resumed == 0)
  `);
});

test('Escape in search or a pending-change modal does not count as closing Settings', () => {
  run(`
    render(); controllers = {pause}
    emit('McmUiEmitClosing', settings)
    entry.update()
    assert(resumed == 0 and not entry.inspect().returnToGame)
    -- Canceling the pending-change modal keeps Settings active. Applying or
    -- discarding invokes the actual RequestClose, then native uninitialization.
    render(); entry.update(); assert(resumed == 0)
    closeAndDetach(); entry.update(); assert(resumed == 1)
  `);
});

test('teardown or save reload without an accepted close cannot auto-resume', () => {
  run(`
    render(); emit('OnUninitialize', settings); controllers = {pause}; entry.update()
    assert(resumed == 0 and not entry.inspect().returnToGame)
    emit('OnInitialize', settings); render(); closeAndDetach(); attached = false
    entry.update(); attached = true; entry.update()
    assert(resumed == 0 and not entry.inspect().returnToGame)
  `);
});

test('pre-game, direct MCM gameplay exit, reset and another Settings screen cancel pending resume', () => {
  run(`
    controllers = {pause}
    render(); closeAndDetach(); preGame = true; entry.update(); preGame = false
    assert(resumed == 0 and not entry.inspect().returnToGame)
    emit('OnInitialize', settings); render(); closeAndDetach(); inMenu = false; entry.update(); inMenu = true
    assert(resumed == 0 and not entry.inspect().returnToGame)
    emit('OnInitialize', settings); render(); closeAndDetach(); entry.reset(); entry.update()
    assert(resumed == 0 and not entry.inspect().returnToGame)
    emit('OnInitialize', settings); render(); closeAndDetach(); emit('OnInitialize', {}); entry.update()
    assert(resumed == 0 and not entry.inspect().returnToGame)
  `);
});

test('absent native Resume times out without selecting a different action', () => {
  run(`
    render(); closeAndDetach(); controllers = {pause}
    resumeTarget.GetData = function() return {eventName = 'OnSwitchToLoadGame'} end
    entry.update(); assert(resumed == 0 and otherActivated == 0 and entry.inspect().returnToGame)
    clock = clock + 4; entry.update()
    assert(not entry.inspect().returnToGame and #logs == 1)
    assert(resumed == 0 and otherActivated == 0)
  `);
});

test('a native activation failure is consumed once and does not retry on later pauses', () => {
  run(`
    render(); closeAndDetach(); controllers = {pause}
    local attempted = 0
    pause.OnMenuItemActivated = function() attempted = attempted + 1; error('unavailable') end
    entry.update(); entry.update()
    assert(attempted == 1 and #logs == 1 and not entry.inspect().returnToGame)
  `);
});
