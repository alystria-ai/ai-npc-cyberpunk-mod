// The second Lua performance round (docs/PERFORMANCE_NATIVE_PLAN.md, section 9): the per-frame paths of invitations, the invitation
// notice board, the phone style, auto-connect and the probe log do no work while idle, and buffered log lines are never lost.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = (name) => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const initSource = read('init.lua');
const readinessSource = read('invitation-readiness.lua');
const partySource = read('manager-party.lua');
const styleSource = read('phone-chat-style.lua');
const fontsSource = read('ui-fonts.lua');
const autoConnectSource = read('auto-connect.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The probe.log buffer, taken from init.lua as written (the block from its state table to the end of log()).
function logBlock() {
  const start = initSource.indexOf('convaiLog = {lines = {}');
  const marker = "print('[CyberpunkConvai] ' .. line)\nend";
  const end = initSource.indexOf(marker, start);
  assert.ok(start > 0 && end > start, 'the log block was not found in init.lua');
  return initSource.slice(start, end + marker.length);
}

const logFixture = `
  local opens, writes, printed, clock, clockReads, stamp = 0, {}, {}, 100, 0, 0
  io = {open = function(path, mode)
    assert(path == 'runtime/probe.log' and mode == 'a', 'unexpected open ' .. tostring(path))
    opens = opens + 1
    return {write = function(_, text) writes[#writes + 1] = text; return true end, close = function() return true end}
  end}
  os.clock = function() clockReads = clockReads + 1; return clock end
  os.date = function() stamp = stamp + 1; return 'T' .. string.format('%03d', stamp) end
  print = function(text) printed[#printed + 1] = text end
  local function logOf()
    ${logBlock()}
    return log
  end
  local log = logOf()
  local function disk() return table.concat(writes) end
`;

test('log lines wait for one write: nothing opens the file until a second has passed, then every line goes out in order', () => run(`${logFixture}
  log('first'); log('second'); log('third')
  assert(opens == 0 and #printed == 3 and printed[1] == '[CyberpunkConvai] first', 'the console print stays immediate')
  clock = 100.5; convaiLogTick(); assert(opens == 0, 'flushed before a second')
  clock = 101; convaiLogTick()
  assert(opens == 1 and #writes == 1)
  assert(disk() == 'T001 first\\nT002 second\\nT003 third\\n', disk())
  -- Empty again: a tick reads no clock and opens nothing; a flush of nothing opens nothing.
  local reads = clockReads
  for _ = 1, 50 do convaiLogTick() end
  convaiLogFlush()
  assert(opens == 1 and clockReads == reads, 'an idle tick must not touch the clock or the file')
  -- The next line starts its own second.
  clock = 200; log('later'); clock = 200.9; convaiLogTick(); assert(opens == 1)
  clock = 201; convaiLogTick(); assert(opens == 2 and disk():sub(-11) == 'T004 later\\n', disk())
`));

test('the buffer flushes at 64 lines or 8 KB, and at once for failure, error, abandon, shutdown and crash lines with everything before them', () => run(`${logFixture}
  for index = 1, 63 do log('line ' .. index) end
  assert(opens == 0)
  log('line 64'); assert(opens == 1 and select(2, disk():gsub('\\n', '')) == 64, 'the 64th line did not flush')
  log(string.rep('x', 4000)); assert(opens == 1)
  log(string.rep('y', 4300)); assert(opens == 2, 'more than 8 KB waiting did not flush')
  for _, urgent in ipairs({'Speech failed: x', 'Update Error: y', 'Session abandoned', 'Game adapter shut down', 'crash report', 'Interrupted driver cleanup capture failed: z'}) do
    local before = opens
    log('quiet before'); assert(opens == before, 'an ordinary line flushed')
    log(urgent); assert(opens == before + 1, urgent .. ' did not flush')
    assert(disk():sub(-#urgent - 1) == urgent .. '\\n' and disk():find('quiet before\\nT%d+ ' .. urgent:gsub('%p', '%%%0'), 1))
  end
  assert(convaiLog.n == 0 and convaiLog.bytes == 0)
`));

test('probe.log lines are flushed before a world is abandoned and at shutdown, and a frame with nothing waiting reads one field', () => {
  assert.match(initSource, /local function abandonSession\(reason,preserveTransit\)[^\n]*\n(?:[^\n]*\n){0,4}?\s*if convaiLogFlush then convaiLogFlush\(\) end\n\s*invalidateKnowledge\(reason\)/);
  assert.match(initSource, /log\('Game adapter shut down'\)\n\s*convaiLogFlush\(\)/);
  assert.match(initSource, /convaiHeartbeat\.frame = convaiHeartbeat\.frame \+ 1\n\s*-- [^\n]*\n\s*if convaiLog\.n > 0 then convaiLogTick\(\) end/);
  // No other writer in init.lua appends to probe.log behind the buffer's back.
  assert.equal([...initSource.matchAll(/io\.open\('runtime\/probe\.log'/g)].length, 1);
});

const readinessFixture = `${uiLocaleBootstrap}
  local factory = (function() ${readinessSource} end)()
  local matches, ms = 0, 100000.0
  local realMatch = string.match
  string.match = function(...) matches = matches + 1; return realMatch(...) end
  local frame = {status = 'ready', worldToken = 'lua-world-launch-a-1', generation = 1}
  local worldCalls = 0
  local readiness = factory.new({
    world = function() worldCalls = worldCalls + 1; return frame end,
    isKnown = function() return true end, now = function() return ms end,
    encode = function() return '{}' end, write = function() return true end, read = function() return nil end,
    decode = function() return {} end, readInterval = 0})
`;

test('invitations: with the same world every frame the world answer is validated once, not matched and copied per frame', () => run(`${readinessFixture}
  assert(readiness.bind(frame) == true)
  matches = 0
  for _ = 1, 200 do readiness.update() end
  assert(worldCalls >= 200, 'the world is still asked for each frame')
  assert(matches == 0, 'the world token was pattern-matched ' .. matches .. ' times while the world was unchanged')
  -- A new world is validated in full again, and a malformed answer is refused as before.
  frame = {status = 'ready', worldToken = 'lua-world-launch-a-2', generation = 2}
  assert(readiness.bind(frame) == true and matches > 0, 'a new world skipped validation')
  frame = {status = 'ready', worldToken = 'bad token!', generation = 3}
  readiness.update()
  local id, reason = readiness.newId(1)
  assert(id == nil and reason == 'Load a save before inviting a companion.', tostring(reason))
  frame = {status = 'ready', worldToken = 'lua-world-launch-a-2', generation = 2}
  readiness.update()
  assert(readiness.newId(1) ~= nil, 'the earlier world answer was forgotten wrongly')
`));

test('invitations: the init.lua world answer is the held frame, not a table built every frame', () => {
  assert.match(initSource, /invitations = dofile\('invitation-readiness\.lua'\)\.new\(\{\n\s*world = function\(\)\n[^\n]*\n[^\n]*\n\s*return knowledgeFrame\n\s*end,/);
});

const partyFixture = `${uiLocaleBootstrap}
  local module = (function() ${partySource} end)()
  local clockReads, feedbackCalls, states = 0, 0, {}
  local realClock = os.clock
  os.clock = function() clockReads = clockReads + 1; return realClock() end
  local board = module.newBoard({feedback = function(id) feedbackCalls = feedbackCalls + 1; return states[id] end})
`;

test('notice board: with nothing followed, joined or failed the per-frame take reads no clock and asks no one', () => run(`${partyFixture}
  clockReads, feedbackCalls = 0, 0
  for _ = 1, 300 do assert(board.take(false) == nil and board.take(true) == nil) end
  assert(clockReads == 0 and feedbackCalls == 0, 'the idle board did work: clock ' .. clockReads .. ' feedback ' .. feedbackCalls)
`));

test('notice board: an invitation, its joined notice and a failure still come through, and the board goes quiet and idle again afterwards', () => run(`${partyFixture}
  states.a = {id = 'a', name = 'Judy', state = 'memory', revision = 1}
  board.track('a', 'manager')
  assert(board.take(false) == nil)
  assert(feedbackCalls == 1, 'a followed invitation is sampled')
  board.event({message = 'Judy joined your group.', info = {kind = 'joined', name = 'Judy'}})
  states.a = nil
  local note = board.take(true)
  assert(note and note.message == 'Judy joined your group.', tostring(note and note.message))
  note.commit()
  assert(board.take(true) == nil)
  -- The burst is over: idle again, and the next failure is a fresh notice.
  clockReads, feedbackCalls = 0, 0
  for _ = 1, 50 do assert(board.take(true) == nil) end
  assert(clockReads == 0 and feedbackCalls == 0)
  board.event({message = 'Johnny could not join: x', failed = true, info = {kind = 'failed', name = 'Johnny'}})
  local failure = board.take(true)
  assert(failure and failure.message == 'Johnny could not join: x', tostring(failure and failure.message))
`));

test('phone style: a closed phone clears the message-font scope only when it holds records', () => run(`
  local names = {}
  CName = {new = function(s) if not names[s] then names[s] = {} end; return names[s] end}
  NameToString = function() return '' end
  -- The font library the game loads first (ui-fonts.lua publishes convaiUiFonts); the style module takes its scopes from it.
  local library = (function() ${fontsSource} end)()
  local m = (function() ${styleSource} end)()
  local scope = m.messageScope
  assert(scope ~= nil, 'the message-font scope was not built')
  local clears, held = 0, 0
  local realClear = scope.clear
  scope.clear = function() clears = clears + 1; held = 0; return realClear() end
  scope.count = function() return held end
  for _ = 1, 100 do m.refresh(false, {}, false) end
  assert(clears == 0, 'an empty scope was cleared ' .. clears .. ' times')
  held = 3
  m.refresh(false, {}, false)
  assert(clears == 1 and held == 0, 'a scope with records was not cleared when the phone closed')
  m.refresh(false, {}, false)
  assert(clears == 1)
`));

test('auto-connect: a gaze or an update with the setting off keeps its empty look table instead of building a new one', () => run(`${uiLocaleBootstrap}
  local module = (function() ${autoConnectSource} end)()
  local on, published = false, 0
  local connect = module.new({enabled = function() return on end, publish = function() published = published + 1 end,
    scan = function() return {} end, party = function() return false end, mono = function() return 0 end})
  local first = connect.inspect()
  assert(first.look == nil)
  for _ = 1, 20 do connect.look(nil, nil, nil, 0.2); connect.update(0.1, {worldReady = true}) end
  assert(published == 0 and connect.inspect().look == nil)
  -- A gaze while the setting is off is wiped by the next update, as before; turned on, it dwells and warms.
  connect.look('judy-alvarez', 'entity', 'Judy', 0.2)
  assert(connect.inspect().look == 'judy-alvarez')
  connect.update(0.1, {worldReady = true})
  assert(connect.inspect().look == nil, 'the off setting kept a gaze')
  on = true
  connect.look('judy-alvarez', 'entity', 'Judy', 0.7)
  connect.update(0.1, {worldReady = true, blocked = false})
  assert(connect.active()[1] == 'judy-alvarez', 'a looked-at character was not warmed')
  connect.look(nil)
  assert(connect.inspect().look == nil)
`));
