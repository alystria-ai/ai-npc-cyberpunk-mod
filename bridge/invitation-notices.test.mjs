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

// A board with a controllable clock and a table of invitation states standing in for the
// party queue. The board posts only "joined" and failures: no progress text (preparing,
// connecting, ready, joining) in any mode, so the states below never reach the screen.
const fixture = `
  local module = (function() ${queueSource} end)()
  local clock, states = 10000, {}
  local board = module.newBoard({now = function() return clock end, feedback = function(id) return states[id] end})
  local function realBoard()
    board = module.newBoard({now = function() return clock end, feedback = function(id) return states[id] end})
  end
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
  -- A posted notice stays up at least 3 s; a change arriving sooner is held.
  local function dwell() clock = clock + 3000 end
  local function failed(name, reason)
    board.event({message = name .. ' could not join: ' .. reason, failed = true, info = {kind = 'failed', name = name}})
  end
`;

test('no progress is posted for a lone invitation at any stage, and its joined line is posted alone', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    assert(post() == nil, 'preparing showed')
    clock = clock + 5000
    set('a', 'Judy', 'connecting')
    assert(post() == nil, 'connecting showed')
    clock = clock + 5000
    set('a', 'Judy', 'ready')
    assert(post(true) == nil, 'the ready or joining step showed in gameplay')
    clock = clock + 5000
    assert(post(true) == nil, 'a routine step showed after a long wait')
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.', 'joined did not show')
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
  `);
});

test('a phone invitation shows no ready line, only its joined line', () => {
  run(`${fixture}
    set('a', 'Judy', 'ready'); board.track('a', 'phone')
    clock = clock + 60000
    assert(post(true) == nil, 'the phone ready line showed')
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.')
  `);
});

test('invitations in one burst share one joined notice, held until the last one arrives', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a', 'manager'); board.track('b', 'manager')
    assert(post() == nil)
    clock = clock + 5000
    set('a', 'Judy', 'ready'); set('b', 'Johnny', 'ready')
    assert(post(true) == nil, 'the ready line showed')
    -- Johnny is still being created when Judy joins; his join follows 50 ms later.
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'a partial joined notice was posted while the other was still being created')
    clock = clock + 50
    states.b = nil; joined('Johnny')
    assert(post(true) == 'Judy and Johnny joined your group.', 'the burst summary must name every companion')
    assert(post(true) == nil and board.inspect().joined == 0, 'the finished burst was not cleared')
  `);
});

test('many names are summarised instead of listed', () => {
  run(`${fixture}
    local names = {'Judy', 'Johnny', 'Panam', 'River', 'Kerry'}
    for index, name in ipairs(names) do set('c' .. index, name, 'memory'); board.track('c' .. index) end
    for index in ipairs(names) do states['c' .. index] = nil end
    for _, name in ipairs(names) do joined(name) end
    assert(post(true) == 'Judy, Johnny and 3 others joined your group.')
    -- Up to three names are listed in full.
    set('d1', 'Judy', 'memory'); set('d2', 'Johnny', 'memory'); set('d3', 'Panam', 'memory')
    for _, id in ipairs({'d1', 'd2', 'd3'}) do board.track(id) end
    clock = clock + 5000
    assert(post() == nil)
    for _, id in ipairs({'d1', 'd2', 'd3'}) do states[id] = nil end
    joined('Judy'); joined('Johnny'); joined('Panam')
    clock = clock + 5000
    assert(post(true) == 'Judy, Johnny and Panam joined your group.')
  `);
});

test('a failure for one companion is reported next to the success of the others', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory'); board.track('a'); board.track('b')
    assert(post() == nil)
    clock = clock + 5000
    states.b = nil; joined('Johnny')
    set('a', 'Judy', 'error'); failed('Judy', 'Bridge unavailable')
    assert(post(true) == 'Johnny joined your group.\\nJudy could not join: Bridge unavailable')
    assert(post(true) == nil and board.inspect().failures == 0)
    -- A lone failure is posted at once with its original text.
    set('c', 'Panam', 'memory'); board.track('c'); assert(post() == nil); clock = clock + 5000
    set('c', 'Panam', 'error'); failed('Panam', 'No route')
    assert(post(true) == 'Panam could not join: No route')
    -- Many failures stay compact.
    clock = clock + 5000
    for _, name in ipairs({'A', 'B', 'C', 'D'}) do failed(name, 'x') end
    assert(post(true) == 'A could not join: x\\nB could not join: x\\n2 more companions also failed.')
  `);
});

test('a notice that could not be posted is retried, and a second copy of the same companion is announced', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a')
    states.a = nil; joined('Judy')
    local note = board.take(false)
    assert(note and note.message == 'Judy joined your group.')
    -- No commit: the player was unavailable.
    local retry = board.take(false)
    assert(retry and retry.message == note.message)
    retry.commit()
    assert(board.take(false) == nil)
    -- A second copy of the same character, five seconds later, is announced again.
    clock = clock + 5000
    set('b', 'Judy', 'memory'); board.track('b')
    states.b = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.', 'a second copy with the same text was swallowed')
  `);
});

test('a world change discards every entry and pending outcome', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a')
    joined('Johnny')
    board.reset()
    states.a = nil
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
    set('a', 'Judy', 'memory')
    assert(post() == nil, 'an untracked invitation was announced')
  `);
});

test('one quick and one slow invitation: the quick joined line waits up to 4 s for the slow one, then shows alone', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a', 'manager'); board.track('b', 'manager')
    assert(post() == nil)
    clock = clock + 300
    -- Judy is quick: she joins while Johnny is still preparing.
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'the quick one was announced beside a hidden, still-preparing one')
    clock = clock + 3900
    assert(post(true) == nil, 'the joined line showed inside its hold')
    clock = clock + 200
    assert(post(true) == 'Judy joined your group.', 'the hold never ended')
    -- Johnny joins later: the burst is summarised, as one notice.
    states.b = nil; joined('Johnny')
    clock = clock + 3000
    assert(post(true) == 'Judy and Johnny joined your group.', 'the burst was not summarised')
    assert(post(true) == nil and board.inspect().joined == 0)
  `);
});

test('a joined notice stays up its full time before the next one replaces it', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.')
    -- The next companion's joined line waits until the first one has had its 5 s.
    set('b', 'Johnny', 'memory'); board.track('b', 'manager')
    states.b = nil; clock = clock + 1200; joined('Johnny')
    assert(post(true) == nil, 'the joined notice was replaced after 1.2 s')
    clock = clock + 3500
    assert(post(true) == nil, 'the joined notice was replaced after 4.7 s')
    clock = clock + 400
    assert(post(true) == 'Johnny joined your group.')
  `);
});

test('a failure is never delayed, even while another invitation is still going', () => {
  run(`${fixture}
    -- A lone invitation failing at once.
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    clock = clock + 50
    set('a', 'Judy', 'error'); failed('Judy', 'Bridge unavailable')
    assert(post(true) == 'Judy could not join: Bridge unavailable', 'a lone early failure was delayed')
    assert(post(true) == nil and board.inspect().failures == 0)
    -- One fails while another is still preparing: the failure shows alone, now.
    clock = clock + 5000
    set('b', 'Johnny', 'memory'); set('c', 'Panam', 'memory')
    board.track('b', 'manager'); board.track('c', 'manager')
    clock = clock + 100
    set('b', 'Johnny', 'error'); failed('Johnny', 'No route')
    assert(post(true) == 'Johnny could not join: No route', 'a failure waited for the other invitation')
    -- The failure stays up its 3 s, and the remaining invitation shows nothing when it arrives.
    clock = clock + 900
    assert(post(true) == nil, 'the failure notice was replaced before it had been up for 3 s')
    set('c', 'Panam', 'ready')
    clock = clock + 2200
    assert(post(true) == nil, 'progress showed for Panam')
    states.c = nil; joined('Panam')
    assert(post(true) == 'Panam joined your group.\\nJohnny could not join: No route', 'the burst lost its failure')
  `);
});

test('the board logs each posted notice with the stage of every invitation, and each ignored regression', () => {
  run(`${fixture}
    local lines = {}
    board = module.newBoard({now = function() return clock end, feedback = function(id) return states[id] end,
      log = function(line) lines[#lines + 1] = line end})
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory'); board.track('a'); board.track('b')
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'a joined line showed inside its hold')
    assert(#lines == 0, 'a held notice was logged as posted')
    clock = clock + 4000
    assert(post(true) == 'Judy joined your group.')
    assert(#lines == 1 and lines[1]:find('Judy joined your group.', 1, true)
      and lines[1]:find('Johnny=memory', 1, true) and lines[1]:find('first', 1, true), lines[1])
    -- A stale receipt reads an earlier stage again: it is ignored and logged once.
    set('b', 'Johnny', 'connecting'); post(true)
    set('b', 'Johnny', 'memory'); post(true); post(true)
    assert(#lines == 2 and lines[2]:find('Johnny reported memory after connecting; kept connecting', 1, true), lines[2])
  `);
});

test('the board runs without _G, as CET module environments do, and still logs through the init global', () => {
  run(`${fixture}
    assert(_G == nil, 'the test sandbox has a _G that CET does not')
    local lines = {}
    convaiNoticeLog = function(line) lines[#lines + 1] = line end
    set('a', 'Judy', 'memory'); board.track('a')
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.')
    assert(#lines == 1 and lines[1]:find('Judy joined your group.', 1, true), tostring(lines[1]))
  `);
});

test('a joined companion shows to a player after a long wait, and a failure sits beside it', () => {
  run(`${fixture}
    realBoard()
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory'); board.track('a', 'manager'); board.track('b', 'manager')
    clock = clock + 600000
    assert(post() == nil, 'progress showed after a long wait')
    states.b = nil; joined('Johnny')
    set('a', 'Judy', 'error'); failed('Judy', 'Bridge unavailable')
    assert(post(true) == 'Johnny joined your group.\\nJudy could not join: Bridge unavailable', 'the failure or the joined line was lost')
    assert(post(true) == nil and board.inspect().failures == 0)
  `);
});
