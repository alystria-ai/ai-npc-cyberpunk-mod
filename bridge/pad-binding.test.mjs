import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The Controller talk button (docs/CONTROLLER_BINDING.md): mod/pad-binding.lua (the decision half, under fengari with stand-ins for the player and the
// talk key), its wiring in mod/init.lua, and the shape of r6/scripts/CyberpunkConvai/PadTalk.reds (the listener half, read as text: redscript has no
// runner here; its compile is checked with scripts/Compile-Redscript.ps1).
//
// Combos (LB+RB, L3+R3) are NOT offered. The game's own mappings give both a meaning (r6/config/inputUserMappings.xml: LB+RB is the
// IconicCyberware button group, L3+R3 the TogglePhotoMode group), and D-pad down is the phone (a 0.5 s hold). So the binding is one hold, L3, and the
// guards below are what keeps it out of menus, scenes, dialogue choices, calls, combat and vehicles.
const moduleSource = readFileSync(new URL('../mod/pad-binding.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const redsSource = readFileSync(new URL('../r6/scripts/CyberpunkConvai/PadTalk.reds', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .replace(/^\s*\/\/.*$/gm, ''); // comments are not code
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

// One player with the methods PadTalk.reds adds, a talk key that records its edges, and a game that is open for talking until a flag says otherwise.
const fixture = `
local clock = 100
local pad = (function() ${moduleSource} end)()
pad.clock = function() return clock end
local flags = {enabled = true, menu = false, observerFails = false, observable = true}
local sample = {available = true, combat = false, vehicle = false, dialogue = false, choices = false, call = false, replacer = false, tier = 1}
local edges, logs, observer, sampled = {}, {}, nil, 0
local player = {queue = {}, on = false, held = false, calls = {}, absent = false, configures = {}}
local function called(name) player.calls[name] = (player.calls[name] or 0) + 1 end
function player:ConvaiPadIsOn() called('IsOn'); if self.absent then error('no such method') end return self.on end
function player:ConvaiPadConfigure(on) called('Configure'); self.on = on; self.configures[#self.configures + 1] = on; return on end
function player:ConvaiPadTake() called('Take'); if #self.queue == 0 then return -1 end return table.remove(self.queue, 1) end
function player:ConvaiPadObservable() called('Observable'); if flags.noObservableMethod then error('no such method') end return flags.observable end
function player:ConvaiPadHeld() called('Held'); return self.held end
-- What the redscript does when the hold elapses / the click comes up, and tells the observer.
function player:push(value) self.queue[#self.queue + 1] = value; if value == 1 then self.held = true else self.held = false end
  if observer then observer(self) end end
pad.deps = {
  enabled = function() return flags.enabled end,
  menu = function() return flags.menu end,
  sample = function() sampled = sampled + 1; return sample end,
  press = function() edges[#edges + 1] = 'down' end,
  release = function() edges[#edges + 1] = 'up' end,
  observe = function(fn) if flags.observerFails then error('no such function') end observer = fn end,
  log = function(line) logs[#logs + 1] = line end,
}
local function tick(seconds, ready)
  clock = clock + (seconds or 0.1)
  pad.tick(player, ready ~= false)
end
local function logged(text) for _, line in ipairs(logs) do if line:find(text, 1, true) then return true end end return false end
local function edgeList() return table.concat(edges, ',') end
`;

test('refusal: only open gameplay on foot is allowed, and anything unreadable counts as busy', () => run(fixture + `
  local function reason(change) local s = {} for k, v in pairs(sample) do s[k] = v end for k, v in pairs(change) do s[k] = v end return pad.refusal(s) end
  assert(pad.refusal(nil) == 'unreadable' and pad.refusal({available = false}) == 'unreadable')
  assert(reason({}) == nil, 'open gameplay')
  assert(reason({combat = true}) == 'combat')
  assert(reason({vehicle = true}) == 'vehicle', 'driving, or any vehicle: the pad is busy there')
  assert(reason({dialogue = true}) == 'dialogue' and reason({choices = true}) == 'dialogue', 'the game own dialogue and its choices')
  assert(reason({call = true}) == 'call')
  assert(reason({replacer = true}) == 'replacer')
  assert(reason({tier = 3}) == 'scene' and reason({tier = 4}) == 'scene', 'a scripted scene')
  assert(reason({tier = 2, sitting = true}) == nil, 'V seated in an ordinary seat has the seat tier, which is not a cutscene')
  assert(reason({tier = 3, sitting = true}) == nil)
`));

test('press, hold and release: one down when the hold is reported, one up when it comes back, nothing in between', () => run(fixture + `
  tick()
  assert(player.on and #player.configures == 1 and player.configures[1] == true, 'switched on once')
  assert(observer ~= nil and pad.observed() == true, 'the observer is installed once')
  assert(edgeList() == '', 'no click: no edge')
  player:push(1)
  assert(edgeList() == 'down' and pad.talking(), 'the observer handles the hold at the moment it begins')
  for i = 1, 6 do tick(0.1) end
  assert(edgeList() == 'down', 'a long hold stays one down')
  player:push(0)
  assert(edgeList() == 'down,up' and not pad.talking(), 'the release ends the turn at once')
  assert(pad.firstSource() == 'observer')
  tick(); tick()
  assert(edgeList() == 'down,up' and #player.configures == 1, 'nothing repeats, nothing is configured again')
`));

test('without the observer the 10 Hz tick reads the same queue', () => run(fixture + `
  flags.observerFails = true
  tick()
  assert(pad.observed() == false and logged('not installed'), 'a failed observer is noted once')
  player.queue[1] = 1; player.held = true
  tick(); assert(edgeList() == 'down' and pad.firstSource() == 'tick')
  player.queue[1] = 0; player.held = false
  tick(); assert(edgeList() == 'down,up')
  tick(); tick(); assert(not logged('installed') or #logs < 10)
`));

test('the redscript says no Lua inside a game event (today): no observer is installed, the tick takes every edge', () => run(fixture + `
  flags.observable = false
  tick()
  assert(observer == nil and pad.observed() == false, 'Observe on the notifier is never installed')
  assert(logged('no Lua runs inside'), 'said once in the log')
  player:push(1)
  assert(edgeList() == '', 'nothing is handled inside the game event')
  tick(); assert(edgeList() == 'down' and pad.firstSource() == 'tick')
  player:push(0)
  assert(edgeList() == 'down', 'the release too waits for the tick')
  tick(); assert(edgeList() == 'down,up' and not pad.talking())
`));

test('a redscript without ConvaiPadObservable (an older build) is read on the tick too', () => run(fixture + `
  flags.noObservableMethod = true
  tick()
  assert(observer == nil and pad.observed() == false)
  player.queue[1] = 1; player.held = true
  tick(); assert(edgeList() == 'down')
`));

test('handling is never entered from inside itself: edges raised while one is handled wait for the loop already running, which is bounded', () => run(fixture + `
  tick()
  local presses, depth, deepest = 0, 0, 0
  pad.deps.press = function()
    presses = presses + 1
    depth = depth + 1
    if depth > deepest then deepest = depth end
    if presses < 1000 then player:push(0); player:push(1) end   -- the talk path raising more edges, as a loop through the game events would
    depth = depth - 1
  end
  player:push(1)
  assert(deepest == 1, 'press was entered from inside itself: depth ' .. deepest)
  assert(presses <= 8, 'bounded per call: ' .. presses)
`));

test('a run of hold starts is capped: a ninth within five seconds is ignored, and the log says so once', () => run(fixture + `
  tick()
  for i = 1, 8 do player:push(1); player:push(0) end
  assert(#edges == 16, 'eight holds go through: ' .. #edges)
  player:push(1); player:push(0); player:push(1); player:push(0)
  assert(#edges == 16, 'the ninth and tenth are ignored')
  local count = 0
  for _, line in ipairs(logs) do if line:find('more than 8 in 5 s', 1, true) then count = count + 1 end end
  assert(count == 1, 'said once, not per edge: ' .. count)
  clock = clock + 6
  player:push(1)
  assert(edgeList():sub(-4) == 'down', 'after the run, holds work again')
`));

test('a repeated hold report while talking is one down, and a release that follows a refused hold ends nothing', () => run(fixture + `
  tick()
  player:push(1); player:push(1)
  assert(edgeList() == 'down', 'one down')
  player:push(0); player:push(0)
  assert(edgeList() == 'down,up', 'one up')
  flags.menu = true
  player:push(1); player:push(0)
  assert(edgeList() == 'down,up', 'refused: no down, so the matching up does nothing either')
`));

test('the guards: a hold in a menu, scene, dialogue choice, call, combat or vehicle never presses the talk key', () => run(fixture + `
  tick()
  local cases = {
    {'menu', function() flags.menu = true end, function() flags.menu = false end},
    {'combat', function() sample.combat = true end, function() sample.combat = false end},
    {'vehicle', function() sample.vehicle = true end, function() sample.vehicle = false end},
    {'dialogue', function() sample.choices = true end, function() sample.choices = false end},
    {'call', function() sample.call = true end, function() sample.call = false end},
    {'scene', function() sample.tier = 4 end, function() sample.tier = 1 end},
    {'unreadable', function() sample.available = false end, function() sample.available = true end},
  }
  for _, case in ipairs(cases) do
    case[2]()
    player:push(1); player:push(0)
    assert(edgeList() == '', case[1] .. ': the talk key was pressed')
    assert(logged('hold ignored (' .. case[1] .. ')'), case[1] .. ': the refusal is logged')
    case[3]()
  end
  player:push(1); player:push(0)
  assert(edgeList() == 'down,up', 'back in open gameplay it works again')
`));

test('a menu that opens under a held click ends the turn within a quarter of a second, and so does a lost release', () => run(fixture + `
  tick()
  player:push(1); assert(edgeList() == 'down')
  local before = sampled
  tick(0.1); tick(0.1)
  assert(sampled - before <= 1, 'the game is asked at most every 0.25 s while a hold lasts')
  flags.menu = true
  tick(0.1); tick(0.1); tick(0.1)
  assert(edgeList() == 'down,up' and not pad.talking(), 'the menu ended the turn')
  assert(logged('ended (menu)'))
  flags.menu = false
  tick(); player:push(1); assert(edgeList() == 'down,up,down')
  player.held = false -- the redscript lost the release
  tick(0.3)
  assert(edgeList() == 'down,up,down,up' and logged('release not seen'), 'the redscript says it is no longer held: the turn ends')
  tick(0.3); assert(edgeList() == 'down,up,down,up', 'once')
`));

test('combat starting while the click is held ends the turn the same way', () => run(fixture + `
  tick(); player:push(1)
  sample.combat = true
  tick(0.3)
  assert(edgeList() == 'down,up' and logged('ended (combat)'))
`));

test('turning the setting off ends a hold, stops the listener once, and then costs nothing', () => run(fixture + `
  tick(); player:push(1)
  flags.enabled = false
  tick()
  assert(edgeList() == 'down,up', 'the hold ended')
  assert(#player.configures == 2 and player.configures[2] == false, 'the listener was stopped, once')
  local touched = 0 for _, n in pairs(player.calls) do touched = touched + n end
  for i = 1, 20 do tick() end
  local after = 0 for _, n in pairs(player.calls) do after = after + n end
  assert(after == touched, 'off: the player is not asked anything')
  flags.enabled = true; tick()
  assert(#player.configures == 3 and player.configures[3] == true, 'switched on again')
`));

test('a setting that was never on touches nothing: no player call, no observer', () => run(fixture + `
  flags.enabled = false
  for i = 1, 30 do tick() end
  assert(next(player.calls) == nil and observer == nil, 'off from the start')
`));

test('a new player after a load is configured again, and a world that is not ready ends a hold', () => run(fixture + `
  tick(); player:push(1); assert(edgeList() == 'down')
  tick(0.1, false)
  assert(edgeList() == 'down,up', 'loading screen: the hold ends')
  player.on = false -- the new player of the loaded save
  tick(); tick()
  assert(#player.configures == 2 and player.configures[2] == true, 'configured again for the new player')
`));

test('a game whose scripts lack the pad methods is asked again only every 30 s and the problem is logged once', () => run(fixture + `
  player.absent = true
  for i = 1, 50 do tick(0.1) end
  assert(player.calls.IsOn == 1, 'asked once in five seconds')
  local count = 0 for _, line in ipairs(logs) do if line:find('redscript half is not loaded', 1, true) then count = count + 1 end end
  assert(count == 1, 'logged once')
  clock = clock + 31; player.absent = false
  tick(); assert(player.on and #player.configures == 1, 'later the scripts are there: it switches on')
`));

test('stop() with no player (the world is gone) only ends a hold', () => run(fixture + `
  tick(); player:push(1)
  pad.stop(nil)
  assert(edgeList() == 'down,up' and #player.configures == 1)
`));

// ---- the wiring in init.lua ---------------------------------------------------------------------------------------------------------------
function wiring() {
  const start = initSource.indexOf('function convaiPadBindingModule()');
  assert.ok(start > 0, 'init.lua has the module loader');
  const tick = initSource.indexOf('function convaiPadBindingTick(', start);
  return initSource.slice(start, initSource.indexOf('\nend\n', tick) + 5);
}

test('init.lua: with the setting off the module is never loaded; on, it loads once and is ticked; off again, it is ticked once more to stop', () => run(`
  local on, loaded, ticks = false, 0, {}
  manager = {padTalk = function() return on end}
  function gameplayCanAcquire() return true end
  battleObserver = {sample = function() return {} end}
  function voiceKeyEdge() end
  function log() end
  Observe = function() end
  dofile = function(name) assert(name == 'pad-binding.lua'); loaded = loaded + 1
    return {tick = function(p, ready) ticks[#ticks + 1] = ready end} end
  ${wiring()}
  local player = {}
  convaiPadBindingTick(player, true); convaiPadBindingTick(player, true)
  assert(loaded == 0 and #ticks == 0, 'off from the start: nothing loaded')
  on = true
  convaiPadBindingTick(player, true); convaiPadBindingTick(player, false)
  assert(loaded == 1 and #ticks == 2 and ticks[2] == false, 'on: loaded once, ticked each time')
  on = false
  convaiPadBindingTick(player, true)
  assert(#ticks == 3, 'off again: the module is told once through its own tick')
`));

test('init.lua: the controller hold presses the talk key under its own id, the observer hooks the redscript notifier, and the menu test is the key own', () => {
  const code = wiring();
  assert.match(code, /voiceKeyEdge\('pad_voice', false, true\)/);
  assert.match(code, /voiceKeyEdge\('pad_voice', false, false\)/);
  assert.match(code, /Observe\('PlayerPuppet', 'ConvaiPadNotify'/);
  assert.match(code, /menu = function\(who\) return not gameplayCanAcquire\(who\) end/);
  assert.match(code, /sample = function\(who\) return battleObserver\.sample\(who\) end/);
  assert.match(initSource, /pcall\(convaiPadBindingTick, player, worldReady\)/, 'ticked from the 10 Hz tick, not from onUpdate');
  assert.match(initSource, /if convaiPadBinding then pcall\(convaiPadBinding\.stop,/, 'stopped at shutdown');
});

test('a controller hold and a keyboard hold never end each other: separate key ids, and only the press that began a recording ends it', () => {
  const start = initSource.indexOf('local HOLD_S = 0.2');
  const end = initSource.indexOf("registerInput('cyberpunk_convai_voice'");
  assert.ok(start > 0 && end > start);
  run(`
    local clock = 10
    os.clock = function() return clock end
    local released, toggles, nextHold = {}, {}, 0
    microphone = {context = nil, state = nil,
      newHoldId = function() nextHold = nextHold + 1; return 'hold' .. nextHold end,
      releaseKey = function(id) released[#released + 1] = id end}
    function toggleVoice(group, source, holdId)
      toggles[#toggles + 1] = source
      if source == 'press' and not microphone.context then microphone.context = {}; microphone.state = 'starting' end
      if source == 'release' then microphone.context = nil end
    end
    function cancelVoice() microphone.context = nil end
    function log() end
    ${initSource.slice(start, end)}
    voiceKeyEdge('voice', false, true)      -- the keyboard key begins a recording
    clock = clock + 1
    voiceKeyEdge('pad_voice', false, true)  -- a controller hold during it: does nothing to it
    clock = clock + 1
    voiceKeyEdge('pad_voice', false, false)
    assert(microphone.context ~= nil, 'the controller let go: the keyboard recording goes on')
    for _, source in ipairs(toggles) do assert(source ~= 'release', 'no release was sent for the controller hold') end
    clock = clock + 1
    voiceKeyEdge('voice', false, false)
    assert(microphone.context == nil, 'the keyboard key ends its own recording')
  `);
});

// ---- the redscript half, read as text ------------------------------------------------------------------------------------------------------
test('PadTalk.reds: one listener on the game walking action for the stick click, registered only while the setting is on, never consuming, nothing per frame', () => {
  assert.equal([...redsSource.matchAll(/RegisterInputListener\(/g)].length, 1, 'a single registration');
  assert.match(redsSource, /RegisterInputListener\(this\.m_convaiPadListener, n"ToggleSprint"\)/);
  const configure = redsSource.slice(redsSource.indexOf('func ConvaiPadConfigure('), redsSource.indexOf('func ConvaiPadStop('));
  assert.match(configure, /if on \{[\s\S]*RegisterInputListener/, 'registered inside the on branch');
  assert.match(redsSource, /UnregisterInputListener\(this\.m_convaiPadListener\)/);
  assert.ok(!/ListenerActionConsumer\.Consume/.test(redsSource), 'the game keeps its own handling of the click');
  assert.ok(!/OnUpdate|OnTick|Tick\(|GetTimeSystem|while /.test(redsSource), 'no per-frame work, no loops');
  assert.match(redsSource, /PlayerLastUsedPad\(\)/, 'a keyboard sprint key is the same action: only the controller counts');
  assert.match(redsSource, /ConvaiMoveHeld\(\)/, 'a click made to sprint, with the stick pushed, is not a hold');
  assert.match(redsSource, /DelayCallback\(step, 0\.3, false\)/, 'the 0.3 s hold is a one-shot delay, not a poll');
  assert.match(redsSource, /generation != this\.m_convaiPadGeneration/, 'a timer of an earlier click never counts for a later one');
  assert.match(redsSource, /wrapMethod\(PlayerPuppet\)\s*protected cb func OnDetach\(\) -> Bool \{\s*this\.ConvaiPadStop\(\);\s*return wrappedMethod\(\);/);
});

test('PadTalk.reds never calls into Lua inside a game event (the freeze on the first hold after a load) and is never entered from inside itself', () => {
  assert.match(redsSource, /public func ConvaiPadNotifyInEvent\(\) -> Bool \{\s*return false;/);
  assert.match(redsSource, /ArrayPush\(this\.m_convaiPadEvents, value\);\s*if ConvaiPadNotifyInEvent\(\) && !this\.m_convaiPadBusy \{/);
  assert.match(redsSource, /public final func ConvaiPadObservable\(\) -> Bool \{\s*return ConvaiPadNotifyInEvent\(\);/);
  assert.equal([...redsSource.matchAll(/this\.ConvaiPadNotify\(\)/g)].length, 1, 'the notifier has one caller, behind the switch');
  assert.match(redsSource, /if down && this\.m_convaiPadBusy \{ return; \};/);
  assert.match(redsSource, /\|\| this\.m_convaiPadBusy \{ return; \};/);
  // The turn-to-face heading wrap is bounded (the other loop of the talk path in the redscript).
  const engagement = readFileSync(new URL('../r6/scripts/CyberpunkConvai/Engagement.reds', import.meta.url), 'utf8');
  assert.match(engagement, /while difference > 180\.0 && wrapGuard < 4/);
  assert.match(engagement, /while difference < -180\.0 && wrapGuard < 8/);
});

test('PadTalk.reds does not need Codeware, so a missing requirement cannot stop the compile', () => {
  assert.ok(!/ModuleExists|Codeware|import /.test(redsSource));
});

test('the shipped file lists carry both new files', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /"source": "mod\/pad-binding\.lua"/, file);
    assert.match(text, /"source": "r6\/scripts\/CyberpunkConvai\/PadTalk\.reds"/, file);
  }
});
