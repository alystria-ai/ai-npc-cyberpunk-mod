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

test('once every hold has run out the hooks are idle again: no stimulus read or owner lookup for anyone, until the next focus', () => {
  run(`${fixture}
    local stimReads = 0
    local quiet = make({stim = function(event) stimReads = stimReads + 1; return stimNames[event.kind] and event.kind or nil end})
    quiet.install(override)
    -- One conversation with e1, who then streams out and is never checked again.
    quiet.focus('e1')
    wall = wall + 30
    quiet.release()
    wall = wall + 5
    assert(not fire('TriggerFacialLookAtReaction', 'e1'), 'no grace after the conversation')
    assert(not quiet.idle())
    wall = wall + 2
    nativeReads, stimReads = 0, 0
    assert(fire('TriggerFacialLookAtReaction', 'e2'))
    assert(fire('OnEventReceived', 'e2', {kind = 'Gunshot'}))
    assert(fire('OnEventReceived', 'e3', {kind = 'Provoke'}))
    assert(fire('OnAreaEnter', 'e3', {}) and fire('OnBumpEvent', 'e2', {isMounted = false}))
    assert(nativeReads == 0 and stimReads == 0, 'a finished conversation kept per-NPC work on: reads=' .. nativeReads .. ' stims=' .. stimReads)
    assert(quiet.idle() and #quiet.status().addressed == 0)
    -- A new focus quiets as before, and a stale pin still runs out after maxPinned.
    quiet.focus('e5')
    assert(not fire('TriggerFacialLookAtReaction', 'e5') and fire('TriggerFacialLookAtReaction', 'e6'))
    wall = wall + 901
    nativeReads = 0
    assert(fire('TriggerFacialLookAtReaction', 'e5') and nativeReads == 0, 'a missed release stayed quiet past maxPinned')
    -- Many NPCs talked to and left behind: idle again once the last grace ends; a longer timed hold keeps its NPC quiet to its end.
    for index = 1, 20 do quiet.focus('n' .. index) end
    quiet.release()
    quiet.hold('h1', 20)
    wall = wall + 7
    nativeReads = 0
    assert(not fire('TriggerFacialLookAtReaction', 'h1') and fire('TriggerFacialLookAtReaction', 'n3'))
    assert(nativeReads > 0, 'the longer hold is still checked')
    wall = wall + 14
    nativeReads = 0
    assert(fire('TriggerFacialLookAtReaction', 'h1') and fire('OnEventReceived', 'n4', {kind = 'Provoke'}) and nativeReads == 0)
    -- A group round is addressed through its participants whatever the holds say.
    group = {participants = {{entity = 'g1'}}}
    assert(not fire('TriggerFacialLookAtReaction', 'g1'))
  `);
});

test('with nothing addressed a hook is one idle test and straight back to vanilla, and a failing clock never blocks it', () => {
  run(`${fixture}
    local rounds = 0
    local quiet = make({round = function() rounds = rounds + 1; return group end})
    quiet.install(override)
    nativeReads = 0
    for _ = 1, 50 do
      assert(fire('OnEventReceived', 'e1', {kind = 'Provoke'}) and fire('TriggerFacialLookAtReaction', 'e1')
        and fire('OnAreaEnter', 'e1', {}) and fire('OnDistrurbComfortZoneAggressiveEvent', 'e1', {}) and fire('OnBumpEvent', 'e1', {isMounted = false}))
    end
    assert(nativeReads == 0 and rounds == 250, 'one idle test per event: reads=' .. nativeReads .. ' rounds=' .. rounds)
    quiet.focus('e2')
    assert(not fire('OnEventReceived', 'e2', {kind = 'Provoke'}), 'a focused NPC is quiet at once')
    local failing = false
    local broken = make({clock = function() if failing then error('no clock') end return wall end})
    hooks = {}
    broken.install(override)
    broken.focus('e3')
    failing = true
    assert(fire('OnEventReceived', 'e3', {kind = 'Provoke'}) and fire('OnBumpEvent', 'e3', {isMounted = false}), 'a failing clock blocked vanilla')
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

// The ambient-bark window (2026-10-23): the game's own greeting, grunt and bump lines of the NPCs around V are dropped by the
// redscript wrap of GameObject.PlayVoiceOver while this window is open. Lua only opens and closes it on conversation events.
const barkFixture = `${fixture}
  local calls = {}
  local gate = {
    hold = function(seconds) calls[#calls + 1] = 'hold:' .. seconds end,
    release = function(seconds) calls[#calls + 1] = 'release:' .. seconds end}
  local function opened(overrides)
    local options = {barkGate = gate}
    for key, value in pairs(overrides or {}) do options[key] = value end
    return make(options)
  end
  local function last() return calls[#calls] end
`;

test('the talk key opens the bark window with one native call, and a repeat inside it costs none', () => {
  run(`${barkFixture}
    local R = opened()
    assert(R.talkPressed() == true)
    assert(#calls == 1 and calls[1] == 'hold:120', table.concat(calls, ','))
    assert(count('Ambient barks held for 120 s (talk key)') == 1)
    -- Nothing longer is asked inside the window: no native call, no log line.
    assert(R.talkPressed() == true)
    wall = wall + 10
    assert(R.requestSent() == true)
    assert(#calls == 1, 'repeat events called the game: ' .. table.concat(calls, ','))
    -- Another talk key press later in the window asks for more time than is left, so it extends.
    wall = wall + 10
    assert(R.talkPressed() == true and #calls == 2 and calls[2] == 'hold:120')
    calls[2] = nil
    assert(count('Ambient barks held') == 1)
    -- A longer ask extends it (never shortens), still without a second log line while it is open.
    assert(R.barkHold(300, 'x') and #calls == 2 and calls[2] == 'hold:300', table.concat(calls, ','))
    assert(count('Ambient barks held') == 1)
    -- After it ran out the next event opens it again.
    wall = wall + 400
    assert(R.talkPressed() and #calls == 3 and count('Ambient barks held') == 2)
    local status = R.status().bark
    assert(status.open == true and status.unavailable == false)
  `);
});

test('an AI line holds the window until it ends, then the quiet tail; a stop with no line playing changes nothing', () => {
  run(`${barkFixture}
    local R = opened()
    assert(R.speechEnded() == false and #calls == 0, 'a stop with no line released the window')
    assert(R.talkPressed())
    wall = wall + 40
    assert(R.speechStarted() and last() == 'hold:90', tostring(last()))
    wall = wall + 7
    assert(R.speechEnded() == true and last() == 'release:25', tostring(last()))
    assert(count('Ambient barks released in 25 s (line ended)') == 1)
    -- The same end twice is one release; a second stop is not a line.
    assert(R.speechEnded() == false)
    local n = #calls
    -- A group's next speaker starts inside the tail: the window is held again.
    wall = wall + 1
    assert(R.speechStarted() and #calls == n + 1 and last() == 'hold:90')
    -- The conversation ends: the grace, only while a window is open.
    assert(R.barkRelease(nil, 'closed') == true and last() == 'release:3')
    assert(count('Ambient barks released in 3 s (closed)') == 1)
    wall = wall + 5
    local m = #calls
    assert(R.barkRelease() == false and #calls == m, 'released a window that was already closed')
    assert(R.status().bark.open == false)
  `);
});

test('the gap after a line is covered: the window stays open for the quiet tail and a new turn refreshes it', () => {
  run(`${barkFixture}
    local R = opened()
    assert(R.talkPressed() and R.requestSent())
    assert(R.speechStarted())
    wall = wall + 8
    assert(R.speechEnded() and last() == 'release:25')
    -- 20 s into the gap (V is reading or composing) the window is still open, and the next talk key refreshes it.
    wall = wall + 20
    assert(R.status().bark.open == true, 'the window closed inside the gap')
    assert(R.talkPressed() and last() == 'hold:120')
    -- The focus ran out by itself after the line: the same tail; a window already closed stays closed and silent.
    assert(R.barkIdle() == true and last() == 'release:25')
    assert(count('Ambient barks released in 25 s (quiet)') == 1)
    wall = wall + 30
    local n = #calls
    assert(R.barkIdle() == false and #calls == n)
    assert(R.status().bark.open == false)
  `);
});

test('clear() closes the window; a game without the redscript part is told once and never again, and nothing else breaks', () => {
  run(`${barkFixture}
    local R = opened()
    assert(R.talkPressed())
    R.clear()
    assert(last() == 'release:0' and R.status().bark.open == false, tostring(last()))
    local missing = make({barkGate = {
      hold = function() error('no such method: ConvaiBarkHold') end,
      release = function() error('no such method') end}})
    assert(missing.talkPressed() == false)
    assert(missing.requestSent() == false and missing.speechStarted() == false and missing.barkRelease() == false)
    assert(count('Ambient bark window unavailable') == 1, 'the missing redscript was logged more than once')
    assert(missing.status().bark.unavailable == true)
    -- A failing clock never throws into the caller.
    local broken = opened({clock = function() error('clock') end})
    assert(broken.talkPressed() == false)
    -- The reaction hooks are unaffected by the window.
    assert(R.install(override) and R.focus('e1') and not fire('TriggerFacialLookAtReaction', 'e1'))
  `);
});

test('the bark window is opened by the talk key, the sent line and every AI line, and closed by their ends', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const speech = readFileSync(new URL('../mod/speech.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The talk key, text and voice: after the focus is begun (a focus change must not cut the window).
  const text = init.slice(init.indexOf('local function beginTextNow'), init.indexOf('local function beginText(groupMode)'));
  assert.ok(text.indexOf('convaiVanillaReactions.talkPressed') > text.indexOf('beginFocus(player, npc)'), 'text path: the window opens after the focus');
  assert.match(init, /focusMode, focusEntity, focusUntil = 'chat', entity, os\.time\(\) \+ 120\n\s+if convaiVanillaReactions then pcall\(convaiVanillaReactions\.talkPressed\) end/);
  assert.match(init, /pcall\(convaiVanillaReactions\.requestSent\)/);
  // The conversation's end goes through one global; onUpdate gains no upvalue and still names no module.
  assert.match(init, /convaiBarkEnd = function\(quiet\)\n\s+if convaiVanillaReactions and not \(convaiSpeech and convaiSpeech\.requestId\) then\n\s+if quiet then pcall\(convaiVanillaReactions\.barkIdle\) else pcall\(convaiVanillaReactions\.barkRelease, nil, 'closed'\) end/);
  const expiry = init.slice(init.indexOf('if focusUntil and not active and not pending'), init.indexOf('if focusedCrowd and not focusedCrowd.checked'));
  assert.match(expiry, /endFocus\(player\)\n\s+if convaiBarkEnd then convaiBarkEnd\(true\) end/);
  // speech.lua: one call when a line starts, one when it ends, none per frame.
  assert.match(speech, /function M\.stop\(reason\)\n[^\n]*\n\s+if M\.requestId and convaiVanillaReactions then pcall\(convaiVanillaReactions\.speechEnded\) end/);
  assert.match(speech, /pcall\(convaiVanillaReactions\.speechStarted\) end\n\s+publish\(\); return true/);
  const update = speech.slice(speech.indexOf('local function updateSpeech'));
  assert.doesNotMatch(update, /convaiVanillaReactions/, 'the per-frame speech update must not touch the bark window');
});

// What the wrap decides, from the redscript source: the four ambient contexts and nothing else, the window first and the
// radius second, never in combat, and everything else passes to the game's own function with every argument.
test('Engagement.reds drops only the four ambient contexts, only inside the window and the radius, never in combat', () => {
  const reds = readFileSync(new URL('../r6/scripts/CyberpunkConvai/Engagement.reds', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const wrap = reds.slice(reds.indexOf('@wrapMethod(GameObject)'));
  // The game's own signature, DelayID return included (a wrapper declared -> Void broke other mods that wrap it: a8aae256, bridge/redscript-compat.test.mjs).
  assert.match(wrap, /^@wrapMethod\(GameObject\)\npublic final static func PlayVoiceOver\(self: ref<GameObject>, voName: CName, debugInitialContext: CName, opt delay: Float, opt answeringEntityID: EntityID, opt canPlayInVehicle: Bool\) -> DelayID \{/);
  assert.match(wrap, /if ConvaiBarkGate\.Ambient\(voName\) && ConvaiBarkGate\.Muted\(self\) \{\n\s+let dropped: DelayID;\n\s+return dropped;\n\s+\};\n\s+return wrappedMethod\(self, voName, debugInitialContext, delay, answeringEntityID, canPlayInVehicle\);/);
  const ambient = reds.slice(reds.indexOf('public static func Ambient'), reds.indexOf('public static func Muted'));
  const names = [...ambient.matchAll(/n"([a-z_]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(names, ['bump', 'fear_foll', 'greeting', 'stlh_curious_grunt']);
  const muted = reds.slice(reds.indexOf('public static func Muted'), reds.indexOf('@wrapMethod(GameObject)'));
  const at = pattern => { const i = muted.search(pattern); assert.ok(i >= 0, `missing ${pattern}`); return i; };
  assert.ok(at(/ConvaiBarkOpen\(\)/) < at(/DistanceSquared/), 'the window is tested before the distance');
  assert.ok(at(/DistanceSquared/) < at(/GetCurrentCombatState/), 'the distance is tested before the combat state');
  assert.match(muted, /Vector4\.DistanceSquared\(npc\.GetWorldPosition\(\), player\.GetWorldPosition\(\)\) > ConvaiBarkGate\.Radius\(\) \* ConvaiBarkGate\.Radius\(\)/);
  assert.match(reds, /public static func Radius\(\) -> Float \{\n\s+return 15\.0;/);
  assert.match(muted, /gamePSMCombat\.InCombat/);
  assert.match(muted, /NPCPuppet\.IsInCombat\(puppet\)/);
  // The window is simulation time (it stops with the game's pause).
  assert.equal((reds.match(/GameInstance\.GetSimTime/g) || []).length, 3);
  // Combat, pain, death and dialogue contexts are never named in the gate.
  for (const context of ['start_combat', 'combat_ended', 'danger', 'enemy_warning', 'stlh_death', 'start_dead', 'pedestrian_hit', 'fear_run', 'fear_beg', 'crowd_combat', 'vehicle_bump']) {
    assert.ok(!reds.includes(`n"${context}"`), `${context} must not be muted`);
  }
});
