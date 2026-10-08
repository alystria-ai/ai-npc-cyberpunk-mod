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
  -- Routine progress (preparing, connecting) shows once an invitation is a second old.
  local function settle() clock = clock + 1000 end
  -- A posted notice stays up at least 3 s; a change arriving sooner is held.
  local function dwell() clock = clock + 3000 end
  local function failed(name, reason)
    board.event({message = name .. ' could not join: ' .. reason, failed = true, info = {kind = 'failed', name = name}})
  end
`;

test('a lone invitation keeps its original wording, shows progress after the delay and does not repeat', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    assert(post() == nil, 'progress showed before the delay')
    settle()
    assert(post() == 'Preparing Judy…')
    assert(post() == nil, 'an unchanged stage repeated')
    set('a', 'Judy', 'connecting')
    assert(post() == nil, 'a notice was replaced before it had been up for 1.5 s')
    dwell()
    assert(post() == 'Connecting Judy…', 'the held change was lost')
    set('a', 'Judy', 'ready'); dwell()
    assert(post() == 'Judy is ready to join when you return to the game.')
    -- Gameplay: ready becomes the routine joining step, which is Developer-only.
    dwell()
    assert(post(true) == nil)
    developer = true
    assert(post(true) == 'Judy is joining your party.')
    states.a = nil; joined('Judy'); dwell()
    assert(post(true) == 'Judy joined your group.')
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
  `);
});

test('invitations in flight together share one notice that is replaced in place', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    settle()
    assert(post() == 'Preparing Judy…')
    clock = clock + 5000
    set('b', 'Johnny', 'memory'); board.track('b', 'manager')
    assert(post() == nil, 'the second invitation was named before its delay')
    settle()
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
    assert(post() == nil)
    settle()
    assert(post() == 'Preparing Judy and Johnny…')
    clock = clock + 100
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    assert(post() == nil, 'a change inside the minimum show time was posted at once')
    clock = clock + 100
    assert(post() == nil)
    clock = clock + 2800
    assert(post() == 'Connecting Judy and Johnny…', 'the deferred change was lost')
    -- Two outcomes 50 ms apart arrive as one notice.
    clock = clock + 5000
    set('a', 'Judy', 'ready'); set('b', 'Johnny', 'ready')
    post(); clock = clock + 5000
    -- Johnny is still being created when Judy joins; his join follows 50 ms later.
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'a partial joined notice was posted while the other was still being created')
    clock = clock + 50
    states.b = nil; joined('Johnny')
    assert(post(true) == 'Judy and Johnny joined your group.', 'the burst summary must name every companion')
  `);
});

test('many names are summarised instead of listed', () => {
  run(`${fixture}
    local names = {'Judy', 'Johnny', 'Panam', 'River', 'Kerry'}
    for index, name in ipairs(names) do set('c' .. index, name, 'memory'); board.track('c' .. index) end
    settle()
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
    settle(); post()
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
    set('a', 'Judy', 'memory'); board.track('a'); settle()
    assert(post(false) == 'Preparing Judy…')
    assert(post(false) == nil)
    assert(post(true) == 'Preparing Judy…', 'the notice hidden by the menu was not shown in gameplay')
    assert(post(true) == nil and post(false) == nil and post(true) == nil)
    -- A failure first seen while paused is never posted there (the banner owns it).
    set('a', 'Judy', 'error')
    assert(post(false) == nil)
  `);
});

test('a notice that could not be posted is retried, and a new copy is always announced', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a'); settle()
    local note = board.take(false)
    assert(note and note.message == 'Preparing Judy…')
    -- No commit: the player was unavailable.
    local retry = board.take(false)
    assert(retry and retry.message == note.message)
    retry.commit()
    assert(board.take(false) == nil)
    clock = clock + 5000
    set('b', 'Judy', 'memory'); board.track('b')
    assert(post() == nil, 'the second copy showed progress inside its delay')
    settle()
    assert(post() == 'Preparing Judy…', 'a second copy with the same text was swallowed')
    -- Cancelling a copy does not replay anything.
    states.b = nil
    assert(post() == nil)
    -- A new revision (the profile was chosen again) is announced again.
    set('a', 'Judy', 'memory', 2)
    dwell()
    assert(post() == 'Preparing Judy…')
  `);
});

test('a world change discards every entry and pending outcome', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a'); settle(); assert(post() == 'Preparing Judy…')
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

test('a quick invitation shows nothing to a player: no progress and no joined notice; a developer still sees joined', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    assert(post() == nil)
    clock = clock + 400
    set('a', 'Judy', 'connecting')
    assert(post() == nil, 'connecting showed inside the delay')
    clock = clock + 400
    set('a', 'Judy', 'ready')
    -- Gameplay: ready is already the routine joining step, which is Developer-only.
    assert(post(true) == nil, 'the joining step showed with Developer mode off')
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'a player was told about a summon they never waited for')
    assert(post(true) == nil and #board.inspect().entries == 0 and board.inspect().joined == 0)
    -- A developer still sees it.
    developer = true; clock = clock + 5000
    set('d', 'River', 'memory'); board.track('d', 'manager')
    states.d = nil; joined('River')
    assert(post(true) == 'River joined your group.', 'a developer did not see the joined notice')
    -- A joined notice that carries a warning is never hidden.
    developer = false; clock = clock + 5000
    set('w', 'Rogue', 'memory'); board.track('w', 'manager')
    states.w = nil; joined('Rogue', 'Her profile could not be set.')
    assert(post(true) == 'Rogue joined your group. Her profile could not be set.', 'a warning was hidden')
    clock = clock + 5000
    -- Just under a second still hides progress; a second shows it.
    clock = clock + 5000
    set('b', 'Panam', 'memory'); board.track('b', 'manager')
    clock = clock + 999
    assert(post() == nil)
    clock = clock + 1
    assert(post() == 'Preparing Panam…')
  `);
});

test('the show delay hides only routine progress: ready lines and the Developer joining step are immediate', () => {
  run(`${fixture}
    set('a', 'Judy', 'ready'); board.track('a', 'phone')
    assert(post() == 'Judy is ready. Close the phone to join.', 'the instruction to close the phone was delayed')
    board.reset(); states.a = nil
    developer = true
    set('c', 'River', 'ready'); board.track('c', 'manager')
    assert(post(true) == 'River is joining your party.', 'the Developer joining step was delayed')
  `);
});

test('one quick and one slow invitation made together: only the slow one is named, progress and outcome', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a', 'manager'); board.track('b', 'manager')
    assert(post() == nil)
    clock = clock + 300
    -- Judy is quick: she joins before anything was shown. Her joined line waits for Johnny.
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'the quick one was announced beside a hidden, still-preparing one')
    clock = clock + 700
    local line = post(true)
    assert(line == 'Preparing Johnny…', line)
    clock = clock + 1500
    assert(post(true) == nil)
    -- Johnny is still going after the hold. Judy joined without a visible wait, so she is never named.
    clock = clock + 2500
    assert(post(true) == nil, 'the quick one was named beside the slow one')
    set('b', 'Johnny', 'connecting'); dwell()
    assert(post(true) == 'Connecting Johnny…')
    states.b = nil; joined('Johnny'); dwell()
    assert(post(true) == 'Johnny joined your group.', 'only the companion the player waited for is announced')
    assert(post(true) == nil and board.inspect().joined == 0)
  `);
});

test('two quick invitations announce nothing to a player', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a', 'manager'); board.track('b', 'manager')
    clock = clock + 300
    states.a = nil; joined('Judy')
    assert(post(true) == nil, 'the first joined was posted alone')
    clock = clock + 100
    states.b = nil; joined('Johnny')
    assert(post(true) == nil, 'players were told about summons they never waited for')
    developer = true; dwell()
    set('c', 'Panam', 'memory'); board.track('c', 'manager'); states.c = nil; joined('Panam')
    assert(post(true) == 'Panam joined your group.', 'a developer sees the joined notice')
    assert(post(true) == nil)
  `);
});

test('a joined companion waits for the others in its burst, so the usual result is one merged notice', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    board.track('a', 'manager'); board.track('b', 'manager'); settle()
    assert(post(true) == 'Preparing Judy and Johnny…')
    dwell()
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    assert(post(true) == 'Connecting Judy and Johnny…')
    dwell()
    -- Judy joins; Johnny is still connecting. The notice on screen keeps naming both.
    states.a = nil; joined('Judy'); set('b', 'Johnny', 'connecting')
    for _ = 1, 6 do clock = clock + 500; assert(post(true) == nil, 'a partial notice appeared inside the hold') end
    clock = clock + 500
    states.b = nil; joined('Johnny')
    assert(post(true) == 'Judy and Johnny joined your group.')
    assert(post(true) == nil and board.inspect().joined == 0)
    -- The hold is bounded: Johnny is still going 4 s after Judy joined.
    clock = clock + 6000
    set('c', 'Judy', 'connecting'); set('d', 'Johnny', 'connecting')
    board.track('c', 'manager'); board.track('d', 'manager'); settle()
    assert(post(true) == 'Connecting Judy and Johnny…')
    dwell()
    states.c = nil; joined('Judy')
    clock = clock + 3900
    assert(post(true) == nil)
    clock = clock + 200
    assert(post(true) == 'Judy joined your group.\\nConnecting Johnny…', 'the hold never ended')
    states.d = nil; joined('Johnny'); dwell()
    assert(post(true) == 'Judy and Johnny joined your group.')
  `);
});

test('a final joined notice stays up its full time before anything replaces it', () => {
  run(`${fixture}
    set('a', 'Judy', 'memory'); board.track('a', 'manager'); settle()
    assert(post(true) == 'Preparing Judy…')
    dwell()
    states.a = nil; joined('Judy')
    assert(post(true) == 'Judy joined your group.')
    -- The next invitation's progress is held until the joined notice has had its 5 s.
    set('b', 'Johnny', 'memory'); board.track('b', 'manager')
    clock = clock + 1200
    assert(post(true) == nil, 'the joined notice was replaced after 1.2 s')
    clock = clock + 3500
    assert(post(true) == nil, 'the joined notice was replaced after 4.7 s')
    clock = clock + 400
    assert(post(true) == 'Preparing Johnny…')
  `);
});

test('a failure is never delayed, even while other invitations are still hidden', () => {
  run(`${fixture}
    -- A lone invitation failing at once.
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    clock = clock + 50
    set('a', 'Judy', 'error'); failed('Judy', 'Bridge unavailable')
    assert(post(true) == 'Judy could not join: Bridge unavailable', 'a lone early failure was delayed')
    assert(post(true) == nil and board.inspect().failures == 0)
    -- One fails and one is still preparing (hidden): the failure shows alone, now,
    -- even though the previous notice was posted a moment ago.
    clock = clock + 5000
    set('b', 'Johnny', 'memory'); set('c', 'Panam', 'memory')
    board.track('b', 'manager'); board.track('c', 'manager')
    clock = clock + 100
    set('b', 'Johnny', 'error'); failed('Johnny', 'No route')
    assert(post(true) == 'Johnny could not join: No route', 'a failure waited for the progress delay')
    -- The remaining invitation is named once its own delay and the minimum show time have passed.
    clock = clock + 900
    assert(post(true) == nil, 'the failure notice was replaced before it had been up for 3 s')
    clock = clock + 2200
    assert(post(true) == 'Johnny could not join: No route\\nPreparing Panam…')
  `);
});

test('a notice is never replaced inside 3 s: a blink is skipped, a stage regression is ignored, a failure still shows at once', () => {
  run(`${fixture}
    -- Judy was invited a moment before Johnny; the one-name text is not left up for a blink.
    set('a', 'Judy', 'memory'); board.track('a', 'manager')
    clock = clock + 700
    set('b', 'Johnny', 'memory'); board.track('b', 'manager')
    clock = clock + 300
    assert(post() == 'Preparing Judy…')
    clock = clock + 800
    assert(post() == nil, 'Johnny joined the notice 0.8 s after it appeared')
    clock = clock + 2300
    assert(post() == 'Preparing Judy and Johnny…')
    -- A stale receipt reads "memory" again for a moment: nothing flashes.
    clock = clock + 5000
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    assert(post() == 'Connecting Judy and Johnny…')
    clock = clock + 3100
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory')
    assert(post() == nil, 'a regression to an earlier stage was shown')
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    clock = clock + 3000
    assert(post() == nil, 'the same text was posted again')
    -- The next outcome is held until the notice has been up long enough.
    set('a', 'Judy', 'ready'); set('b', 'Johnny', 'ready')
    assert(post() == 'Judy and Johnny are ready to join when you return to the game.')
    clock = clock + 400
    states.a, states.b = nil, nil
    joined('Judy'); joined('Johnny')
    assert(post() == nil, 'the joined notice replaced the ready line after 0.4 s')
    clock = clock + 2700
    assert(post() == 'Judy and Johnny joined your group.')
    -- A new failure is exempt.
    clock = clock + 5000
    set('c', 'Panam', 'memory'); board.track('c', 'manager'); settle()
    assert(post() == 'Preparing Panam…')
    clock = clock + 100
    set('c', 'Panam', 'error'); failed('Panam', 'No route')
    assert(post() == 'Panam could not join: No route')
  `);
});

test('the board logs each posted notice with the stage of every invitation, and each ignored regression', () => {
  run(`${fixture}
    local lines = {}
    board = module.newBoard({now = function() return clock end, developerMode = function() return developer end,
      feedback = function(id) return states[id] end, log = function(line) lines[#lines + 1] = line end})
    set('a', 'Judy', 'memory'); set('b', 'Johnny', 'memory'); board.track('a'); board.track('b'); settle()
    assert(post() == 'Preparing Judy and Johnny…')
    assert(#lines == 1 and lines[1]:find('Preparing Judy and Johnny…', 1, true) and lines[1]:find('Judy=memory', 1, true)
      and lines[1]:find('first', 1, true), lines[1])
    dwell()
    set('a', 'Judy', 'connecting'); set('b', 'Johnny', 'connecting')
    post()
    assert(#lines == 2 and lines[2]:find('3000 ms after the previous', 1, true), lines[2])
    set('a', 'Judy', 'memory'); post()
    assert(#lines == 3 and lines[3]:find('Judy reported memory after connecting', 1, true), lines[3])
    post(); assert(#lines == 3, 'the same regression was logged twice')
  `);
});

test('the board runs without _G, as CET module environments do, and still logs through the init global', () => {
  run(`${fixture}
    assert(_G == nil, 'the test sandbox has a _G that CET does not')
    local lines = {}
    convaiNoticeLog = function(line) lines[#lines + 1] = line end
    set('a', 'Judy', 'memory'); board.track('a'); settle()
    assert(post() == 'Preparing Judy…')
    assert(#lines == 1 and lines[1]:find('Preparing Judy…', 1, true), tostring(lines[1]))
  `);
});
