import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/vanilla-reactions.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The module with CET's Override, the clock and every native read replaced by
// fakes. A component is {owner = <entity hash>}; a stimulus is {kind = <name>};
// a bump is {isMounted = <bool>}. hooks[method](self, arg) runs the installed
// override and reports whether the vanilla handler ran.
const fixture = `
  local module = (function() ${source} end)()
  local wall, logs, inCombat, inDialogue, nativeReads = 1000, {}, {}, {}, 0
  local group = nil
  local stimNames = {}
  for _, name in ipairs(module.STIMS) do stimNames[name] = true end
  local function make(overrides)
    local options = {
      clock = function() return wall end,
      entity = function(object) nativeReads = nativeReads + 1; return object end,
      owner = function(component) return component and component.owner end,
      stim = function(event) return stimNames[event.kind] and event.kind or nil end,
      eligible = function(object) return not inCombat[object] and not inDialogue[object] end,
      mounted = function(event) return event.isMounted end,
      round = function() return group end,
      log = function(line) logs[#logs + 1] = line end}
    for key, value in pairs(overrides or {}) do options[key] = value end
    return module.new(options)
  end
  local hooks, registered = {}, {}
  local function override(class, method, handler)
    assert(class == 'ReactionManagerComponent', 'unexpected class ' .. tostring(class))
    registered[#registered + 1] = method
    hooks[method] = handler
  end
  -- true when the vanilla handler ran
  local function fire(method, owner, arg)
    local ran = false
    local component = {owner = owner}
    if method == 'TriggerFacialLookAtReaction' then
      hooks[method](component, true, true, function(forceFear, playVO)
        assert(forceFear == true and playVO == true, 'arguments not passed through'); ran = true end)
    else
      hooks[method](component, arg, function(value) assert(value == arg, 'event not passed through'); ran = true; return true end)
    end
    return ran
  end
  local function count(pattern)
    local n = 0
    for _, line in ipairs(logs) do if line:find(pattern, 1, true) then n = n + 1 end end
    return n
  end
`;

test('the hooks cover the stare, proximity, comfort-zone and bump handlers and are vanilla when nothing is addressed', () => {
  run(`${fixture}
    local quiet = make()
    assert(quiet.install(override) == true)
    assert(table.concat(registered, ',') == 'OnEventReceived,TriggerFacialLookAtReaction,OnAreaEnter,OnDistrurbComfortZoneAggressiveEvent,OnBumpEvent',
      table.concat(registered, ','))
    assert(fire('TriggerFacialLookAtReaction', 'e1'), 'look-at reaction blocked with nothing addressed')
    assert(fire('OnEventReceived', 'e1', {kind = 'Provoke'}), 'provoke blocked with nothing addressed')
    assert(fire('OnAreaEnter', 'e1', {}), 'comfort zone blocked with nothing addressed')
    assert(fire('OnDistrurbComfortZoneAggressiveEvent', 'e1', {}))
    assert(fire('OnBumpEvent', 'e1', {isMounted = false}))
    -- Idle hooks never touch the entity: no per-NPC cost for the rest of the city.
    assert(nativeReads == 0, 'idle hooks read native entities: ' .. nativeReads)
    assert(count('Suppressed') == 0)
  `);
});

test('the focused NPC is quiet, with one probe line per kind, and every other NPC stays vanilla', () => {
  run(`${fixture}
    local quiet = make()
    quiet.install(override)
    assert(quiet.focus('e1', 'gaze'))
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'the greeting/fear look-at bark still played')
    assert(not fire('OnAreaEnter', 'e1', {}), 'the comfort-zone grunt still played')
    assert(not fire('OnDistrurbComfortZoneAggressiveEvent', 'e1', {}), 'the comfort-zone provoke still fired')
    assert(not fire('OnBumpEvent', 'e1', {isMounted = false}), 'the bump bark still played')
    assert(fire('TriggerFacialLookAtReaction', 'e2'), 'another NPC lost its vanilla reaction')
    assert(fire('OnBumpEvent', 'e2', {isMounted = false}))
    assert(logs[#logs] == 'Suppressed vanilla reaction bump for e1', logs[#logs])
    assert(count('Suppressed vanilla reaction lookat for e1') == 1)
    assert(count('Suppressed vanilla reaction comfort-zone for e1') == 1)
    -- Repeats inside a few seconds are counted but not logged again.
    wall = wall + 1
    assert(not fire('TriggerFacialLookAtReaction', 'e1'))
    assert(count('lookat for e1') == 1, 'probe line not throttled')
    wall = wall + 3
    assert(not fire('TriggerFacialLookAtReaction', 'e1'))
    assert(count('lookat for e1') == 2, 'probe line throttled forever')
    local status = quiet.status()
    assert(status.suppressed.lookat == 3 and status.suppressed.bump == 1)
    assert(#status.addressed == 1 and status.addressed[1].entity == 'e1' and status.addressed[1].pinned)
    assert(#status.hooks == 5)
  `);
});

test('only stare, proximity and bump stimuli are dropped; combat and threats pass through', () => {
  run(`${fixture}
    local quiet = make()
    quiet.install(override)
    quiet.focus('e1')
    for _, kind in ipairs({'Provoke', 'CrowdIllegalAction', 'AskToFollowOrder', 'Bump'}) do
      assert(not fire('OnEventReceived', 'e1', {kind = kind}), kind .. ' reached the addressed NPC')
      assert(count('Suppressed vanilla reaction stim:' .. kind .. ' for e1') == 1, kind .. ' not logged')
    end
    for _, kind in ipairs({'Combat', 'Gunshot', 'AimingAt', 'WeaponDisplayed', 'SpreadFear', 'Explosion', 'IllegalAction'}) do
      assert(fire('OnEventReceived', 'e1', {kind = kind}), kind .. ' was filtered')
    end
    assert(fire('OnEventReceived', 'e2', {kind = 'Provoke'}), 'an unaddressed NPC lost its provoke')
  `);
});

test('combat, scene dialogue and vehicle bumps always keep the vanilla behaviour', () => {
  run(`${fixture}
    local quiet = make()
    quiet.install(override)
    quiet.focus('e1')
    assert(fire('OnBumpEvent', 'e1', {isMounted = true}), 'a vehicle bump no longer dodges')
    inCombat.e1 = true
    assert(fire('TriggerFacialLookAtReaction', 'e1'), 'an NPC in combat was quieted')
    assert(fire('OnEventReceived', 'e1', {kind = 'Provoke'}))
    inCombat.e1, inDialogue.e1 = nil, true
    assert(fire('TriggerFacialLookAtReaction', 'e1'), 'an NPC in scene dialogue was quieted')
    inDialogue.e1 = nil
    assert(not fire('TriggerFacialLookAtReaction', 'e1'))
  `);
});

test('a released NPC stays quiet for the grace, then returns to vanilla; clear() ends it at once', () => {
  run(`${fixture}
    local quiet = make()
    quiet.install(override)
    quiet.focus('e1')
    wall = wall + 120
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'a long conversation lost its quiet')
    quiet.release()
    wall = wall + 5
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'no grace after the conversation')
    wall = wall + 1
    assert(fire('TriggerFacialLookAtReaction', 'e1'), 'still quiet after the grace')
    assert(#quiet.status().addressed == 0, 'the expired hold was kept')
    -- A new focus replaces an old one; release covers both.
    quiet.focus('e2'); quiet.focus('e3')
    quiet.release(2)
    wall = wall + 2
    assert(fire('TriggerFacialLookAtReaction', 'e2') and fire('TriggerFacialLookAtReaction', 'e3'))
    -- A load or detach clears every hold immediately.
    quiet.focus('e4')
    quiet.clear()
    assert(fire('TriggerFacialLookAtReaction', 'e4'), 'clear kept the NPC quiet')
    assert(quiet.idle())
  `);
});

test('a timed hold never shortens a longer one, and a missed release expires after maxPinned', () => {
  run(`${fixture}
    local quiet = make({config = {maxPinned = 60}})
    quiet.install(override)
    quiet.hold('e1', 20)
    quiet.hold('e1', 5)
    wall = wall + 10
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'a shorter hold cut the longer one')
    quiet.focus('e2')
    quiet.hold('e2', 1)
    wall = wall + 30
    assert(not fire('TriggerFacialLookAtReaction', 'e2'), 'a timed hold unpinned the focus')
    wall = wall + 31
    assert(fire('TriggerFacialLookAtReaction', 'e2'), 'a stale focus stayed quiet forever')
  `);
});

test('group chat participants are addressed during the round and keep the grace after it', () => {
  run(`${fixture}
    local quiet = make()
    quiet.install(override)
    group = {participants = {{entity = 'g1'}, {entity = 'g2'}}}
    assert(not fire('TriggerFacialLookAtReaction', 'g1'))
    assert(not fire('OnEventReceived', 'g2', {kind = 'CrowdIllegalAction'}))
    assert(fire('TriggerFacialLookAtReaction', 'e9'), 'a bystander was quieted')
    group = nil
    wall = wall + 3
    assert(not fire('TriggerFacialLookAtReaction', 'g1'), 'no grace after the round')
    wall = wall + 4
    assert(fire('TriggerFacialLookAtReaction', 'g1'), 'still quiet after the round grace')
  `);
});

test('a failing check or native read never blocks the vanilla handler', () => {
  run(`${fixture}
    local quiet = make({eligible = function() error('native read failed') end,
      owner = function() error('GetOwner failed') end})
    quiet.install(override)
    quiet.focus('e1')
    assert(fire('TriggerFacialLookAtReaction', 'e1'), 'an error blocked the vanilla reaction')
    assert(fire('OnEventReceived', 'e1', {kind = 'Provoke'}))
    local throwing = make({stim = function() error('GetStimType failed') end})
    hooks = {}
    throwing.install(override)
    throwing.focus('e1')
    assert(fire('OnEventReceived', 'e1', {kind = 'Provoke'}), 'a stim read error dropped the stimulus')
    -- A missing or rejecting Override is reported and leaves the game alone.
    local broken = make()
    assert(broken.install(function() error('no such method') end) == false)
    assert(count('Vanilla reaction hook unavailable: OnBumpEvent') == 1)
    assert(make().install(false) == false)
  `);
});

test('in the game the hooks are registered only when an NPC is first addressed', () => {
  run(`${fixture}
    Override = override
    local lazy = make()
    assert(lazy.install() == true and #registered == 0, 'hooks registered before any NPC was addressed')
    assert(lazy.focus('e1') and #registered == 5)
    assert(lazy.hold('e2', 3) and #registered == 5, 'hooks registered twice')
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'the focused NPC still reacts')
  `);
});

// The adapter wiring: the focus that precedes and carries a conversation pins
// the NPC, ending it starts the grace, and lifecycle teardown clears it. The
// global keeps beginFocus/endFocus and onUpdate free of new upvalues.
test('init.lua pins the focused NPC, releases on endFocus, clears on teardown and installs in onInit', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const between = (start, end) => {
    const from = init.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    const to = init.indexOf(end, from + start.length);
    assert.ok(to > from, `missing ${end} after ${start}`);
    return init.slice(from, to);
  };
  assert.match(init, /pcall\(dofile, 'vanilla-reactions\.lua'\)/);
  assert.match(init, /round = function\(\) return groupChat\.round end/);
  const endFocus = between('local function endFocus(player)', '\nend\n');
  assert.match(endFocus, /pcall\(convaiVanillaReactions\.release\)/);
  const beginFocus = between('local function beginFocus(player, npc)', 'local managed = companions.owns(npc)');
  const native = beginFocus.indexOf('player:ConvaiBeginFocus(npc)');
  const pinned = beginFocus.lastIndexOf("pcall(quiet.focus, npc, 'focus')");
  assert.ok(native > 0 && pinned > native, 'a failed native focus must not pin the NPC');
  assert.match(between("registerForEvent('onInit'", "registerForEvent('onUpdate'"), /pcall\(convaiVanillaReactions\.install\)/);
  assert.match(between("registerForEvent('onShutdown'", "log('Game adapter shut down')"), /pcall\(convaiVanillaReactions\.clear\)/);
  assert.match(between('focusedCrowd, releasedCrowd = nil, nil\n    if convaiVanillaReactions', "log('Session references released: '"), /convaiVanillaReactions\.clear/);
  assert.doesNotMatch(between("registerForEvent('onUpdate'", "registerForEvent('onShutdown'"), /VanillaReactions/);
});
