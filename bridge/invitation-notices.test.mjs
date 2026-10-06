import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const queueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const program = uiLocaleBootstrap + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// A board with a controllable clock and a table of invitation states standing
// in for the party queue.
const fixture = `
  local module = (function() ${queueSource} end)()
  local clock, developer, states = 10000, false, {}
  local board = module.newBoard({
    now = function() return clock end,
    developerMode = function() return developer end,
    feedback = function(id) return states[id] end})
  local function set(id, name, state, revision)
    states[id] = {id = id, name = name, state = state, revision = revision or 1, failed = state == 'error'}
  end
  local function post(world)
    local note = board.take(world == true)
    if note then note.commit(); return note.message end
  end
  local function joined(name, warning)
    board.event({message = name .. ' joined your group.' .. (warning and (' ' .. warning) or ''),
      info = {kind = 'joined', name = name, warning = warning}})
  end
  local function failed(name, reason)
    board.event({message = name .. ' could not join: ' .. reason, failed = true, info = {kind = 'failed', name = name}})
  end
`;

test('a lone invitation keeps its original wording, is never delayed and does not repeat', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    assert(post() == 'Judy: preparing memory...')
    assert(post() == nil, 'an unchanged stage repeated')
    set('a', 'Judy', 'connecting')
    assert(post() == 'Judy: connecting...', 'a lone stage change waited for the coalescing window')
    set('a', 'Judy', 'ready')
    assert(post() == 'Judy is ready to join when you return to the game.')
    -- Gameplay: ready becomes the routine joining step, which is Developer-only.
    assert(post(true) == nil)
    developer = true
    assert(post(true) == 'Judy is joining your party.')
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.')
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
  `);
});

test('invitations in flight together share one notice that is replaced in place', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    assert(post() == 'Judy: preparing memory...')
    clock = clock + 5000
    set('b', 'Johnny', 'memory'); board.track('b', 'manager')
    assert(post() == 'Preparing Judy and Johnny…')
    clock = clock + 5000
    -- One finishes first: the shared verb follows the slowest, so nothing changes.
    set('a', 'Judy', 'connecting')
    assert(post() == nil)
    set('b', 'Johnny', 'connecting')
    assert(post() == 'Connecting Judy and Johnny…')
    clock = clock + 5000
    set('a', 'Judy', 'ready'); set('b', 'Johnny', 'ready')
    assert(post() == 'Judy and Johnny are ready to join when you return to the game.')
    states.a, states.b = nil, nil
    joined('Judy'); joined('Johnny')
    assert(post(true) == 'Judy and Johnny joined your group.')
    assert(post(true) == nil and board.inspect().joined == 0, 'the finished burst was not cleared')
  `);
});

test('near-simultaneous changes merge inside the coalescing window and nothing is lost', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a'); board.track('b')
    assert(post() == 'Preparing Judy and Johnny…')
    clock = clock + 100
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    assert(post() == nil, 'a change inside the window was posted at once')
    clock = clock + 100
    assert(post() == nil)
    clock = clock + 300
    assert(post() == 'Connecting Judy and Johnny…', 'the deferred change was lost')
    -- Two outcomes 50 ms apart arrive as one notice.
    clock = clock + 5000
    set('a', 'Judy', 'ready'); set('b', 'Johnny', 'ready')
    post(); clock = clock + 5000
    -- Johnny is still being created when Judy joins; his join follows 50 ms later.
    states.a = nil; joined('Judy'); assert(post(true) == 'Judy joined your group.')
    clock = clock + 50
    states.b = nil; joined('Johnny'); assert(post(true) == nil)
    clock = clock + 400
    assert(post(true) == 'Judy and Johnny joined your group.', 'the burst summary must name every companion')
  `);
});

test('many names are summarised instead of listed', () => {
  run(`${fixture}
    local names = {'Judy', 'Johnny', 'Panam', 'River', 'Kerry'}
    for index, name in ipairs(names) do set('c' .. index, name, 'memory'); board.track('c' .. index) end
    assert(post() == 'Preparing Judy, Johnny and 3 others…')
    for index in ipairs(names) do states['c' .. index] = nil end
    for _, name in ipairs(names) do joined(name) end
    assert(post(true) == 'Judy, Johnny and 3 others joined your group.')
    -- Up to three names are listed in full.
    set('d1', 'Judy', 'memory'); set('d2', 'Johnny', 'memory'); set('d3', 'Panam', 'memory')
    for _, id in ipairs({'d1', 'd2', 'd3'}) do board.track(id) end
    clock = clock + 5000
    assert(post() == 'Preparing Judy, Johnny and Panam…')
  `);
});

test('a failure for one companion is reported next to the success of the others', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory'); board.track('a'); board.track('b')
    post()
    clock = clock + 5000
    states.b = nil; joined('Johnny')
    set('a', 'Judy', 'error'); failed('Judy', 'Bridge unavailable')
    assert(post(true) == 'Johnny joined your group.\\nJudy could not join: Bridge unavailable')
    assert(post(true) == nil and board.inspect().failures == 0)
    -- A lone failure is posted at once with its original text.
    set('c', 'Panam', 'memory'); board.track('c'); clock = clock + 5000; post()
    set('c', 'Panam', 'error'); failed('Panam', 'No route')
    assert(post(true) == 'Panam could not join: No route')
    -- Many failures stay compact.
    clock = clock + 5000
    for _, name in ipairs({'A', 'B', 'C', 'D'}) do failed(name, 'x') end
    assert(post(true) == 'A could not join: x\\nB could not join: x\\n2 more companions also failed.')
  `);
});

test('a paused menu announces progress once and gameplay announces it once more', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a')
    assert(post(false) == 'Judy: preparing memory...')
    assert(post(false) == nil)
    assert(post(true) == 'Judy: preparing memory...', 'the notice hidden by the menu was not shown in gameplay')
    assert(post(true) == nil and post(false) == nil and post(true) == nil)
    -- A failure first seen while paused is never posted there (the banner owns it).
    set('a', 'Judy', 'error')
    assert(post(false) == nil)
  `);
});

test('a notice that could not be posted is retried, and a new copy is always announced', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a')
    local note = board.take(false)
    assert(note and note.message == 'Judy: preparing memory...')
    -- No commit: the player was unavailable.
    local retry = board.take(false)
    assert(retry and retry.message == note.message)
    retry.commit()
    assert(board.take(false) == nil)
    clock = clock + 5000
    set('b', 'Judy', 'memory'); board.track('b')
    assert(post() == 'Judy: preparing memory...', 'a second copy with the same text was swallowed')
    -- Cancelling a copy does not replay anything.
    states.b = nil
    assert(post() == nil)
    -- A new revision (the profile was chosen again) is announced again.
    set('a', 'Judy', 'memory', 2)
    assert(post() == 'Judy: preparing memory...')
  `);
});

test('a world change discards every entry and pending outcome', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a'); post()
    joined('Johnny')
    board.reset()
    states.a = nil
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
    set('a', 'Judy', 'memory')
    assert(post() == nil, 'an untracked invitation was announced')
  `);
});

test('phone invitations use the phone wording and mix with manager ones in neutral words', () => {
  run(`${fixture}
    set('a', 'Judy', 'ready'); board.track('a', 'phone')
    assert(post() == 'Judy is ready. Close the phone to join.')
    set('b', 'Johnny', 'ready'); board.track('b', 'phone')
    clock = clock + 5000
    assert(post() == 'Judy and Johnny are ready. Close the phone to join.')
    set('c', 'Panam', 'ready'); board.track('c', 'manager')
    clock = clock + 5000
    assert(post() == 'Judy, Johnny and Panam are ready to join when you return to the game.')
  `);
});
