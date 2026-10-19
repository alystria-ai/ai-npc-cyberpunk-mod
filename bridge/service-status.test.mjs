import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/service-status.lua', import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8')).strings;
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// Files hold keys into a decoded-table registry, as other adapter fixtures do.
// Translation is visible (T:) so every message is proven to pass through ui.t.
const fixture = `
local clock, reads, registry, serial = 1800000000.0, {}, {}, 0
files = {}
function put(path, value)
    if value == nil then files[path] = nil; return end
    serial = serial + 1; local key = 'json-' .. serial; registry[key] = value; files[path] = key
end
json = {decode = function(raw)
    if raw == 'malformed' then error('malformed json') end
    return assert(registry[raw], 'unexpected JSON input ' .. tostring(raw))
end}
io = {open = function(path, mode)
    assert(mode == 'rb', 'status reads only'); reads[path] = (reads[path] or 0) + 1
    if files[path] == nil then return nil end
    return {read = function() return files[path] end, close = function() return true end}
end}
os.time = function() return clock end
function advance(seconds) clock = clock + seconds end
function now() return clock end
function ms(offset) return (clock + (offset or 0)) * 1000.0 end
function readsOf(path) return reads[path] or 0 end
convaiUiLocale = {version = 1, t = function(text) return 'T:' .. text end}
dofile = function(path) error('unexpected dependency ' .. path) end
local status = (function() ${source} end)()
`;

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = fixture + body;
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

const messages = {
  starting: 'The conversation service is starting. Try again in a few seconds.',
  restarted: 'The conversation service restarted. Please try again.',
  setup: 'The conversation service needs your Convai API key. Add it, then restart the game.',
  browser: 'The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, then restart the game.',
  failed: 'The conversation service could not start. Restart the game, or see Help in Settings.',
  stopped: 'The conversation service is not running. Restart the game to start it again.',
};
const lua_ = value => JSON.stringify('T:' + value);

test('every service message is a catalogued English UI key', () => {
  for (const text of Object.values(messages)) assert.equal(catalog[text], text, text);
  for (const text of Object.values(messages)) assert(source.includes(`ui.t('${text}')`), `ui.t literal for ${text}`);
});

test('with no evidence at all the adapter stays silent while the game has only just loaded', () => run(`
  assert(status.unavailable() == nil)
  assert(status.blockedMessage() == nil)
  assert(status.lostSince(now() - 10) == nil)
  assert(status.notice() == nil)
  advance(14)
  assert(status.unavailable() == nil, 'still inside the first seconds: a bridge started by hand may be coming up')
`));

test('no trace of this session after the first seconds means the service never started: a request is told so at once, not after its 90 s', () => run(`
  advance(15)
  local message, kind = status.blockedMessage()
  assert(kind == 'failed' and message == ${lua_(messages.failed)}, tostring(kind))
  assert(status.lostSince(now() - 10) == nil, 'only the supervisor status retires a request early')
  assert(status.notice() == nil, 'and there is no proactive notice for a service nobody tried to start')
  -- A bridge that comes up (started by hand, or late) is served again at once.
  advance(1); put('runtime/knowledge-status.json', {version = 1, updated = ms(-1)})
  assert(status.unavailable() == nil)
`));

test('empty status files (the shipped placeholders) are the same as missing ones', () => run(`
  for _, path in ipairs({'runtime/knowledge-status.json', 'runtime/local-voice-state.json', 'runtime/bridge-service.json'}) do
    files[path] = ''
  end
  assert(status.unavailable() == nil, 'an empty file must not read as a stopped service')
  assert(status.blockedMessage() == nil)
  assert(status.notice() == nil)
  advance(15)
  assert(status.unavailable().kind == 'failed', 'and none is a service that never started, as no file is')
`));

test('what an earlier session of the game left behind is not this session: "never", not "restart the game" for a service nobody started', () => run(`
  put('runtime/bridge-service.json', {state = 'stopped', code = 'game-exited', since = ms(-90000), updated = ms(-86400)})
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-86400)})
  assert(status.unavailable().kind == 'stopped', 'inside the first seconds the old behaviour stands')
  advance(15)
  local message, kind = status.blockedMessage()
  assert(kind == 'failed' and message == ${lua_(messages.failed)}, tostring(kind))
  -- A trace written in this session is still "stopped": the service ran and is gone.
  advance(1); put('runtime/bridge-service.json', {state = 'stopped', code = 'game-exited', since = ms(-30), updated = ms(-20)})
  assert(status.unavailable().kind == 'stopped')
`));

test('a fresh bridge heartbeat always allows conversations', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', since = ms(-5), updated = ms()})
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-1)})
  assert(status.unavailable() == nil, 'knowledge heartbeat')
  advance(1)
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-60)})
  put('runtime/local-voice-state.json', {state = 'ready', bridgePid = 7, updated = ms(-6)})
  assert(status.unavailable() == nil, 'voice heartbeat')
  advance(1)
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-1)})
  assert(status.notice() == nil, 'a live bridge supersedes a failure notice')
`));

test('supervisor states map to starting, ready and stopped explanations', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-3600)})
  for _, state in ipairs({'starting', 'restarting', 'stopping'}) do
    advance(1)
    put('runtime/bridge-service.json', {state = state, code = 'x', since = ms(-2), updated = ms(-1)})
    local message, kind = status.blockedMessage()
    assert(kind == 'starting' and message == ${lua_(messages.starting)}, state)
  end
  advance(1)
  put('runtime/bridge-service.json', {state = 'ready', code = 'bridge-ready', since = ms(-30), updated = ms(-2)})
  assert(status.unavailable() == nil, 'the supervisor confirms a running bridge')
  advance(1)
  put('runtime/bridge-service.json', {state = 'stopped', code = 'stop-requested', since = ms(-2), updated = ms(-1)})
  assert(select(2, status.blockedMessage()) == 'stopped')
  advance(1)
  put('runtime/bridge-service.json', {state = 'ready', code = 'bridge-ready', since = ms(-300), updated = ms(-120)})
  local message, kind = status.blockedMessage()
  assert(kind == 'stopped' and message == ${lua_(messages.stopped)}, 'a stale supervisor is not trusted')
`));

test('stale traces without a supervisor mean the service is not running', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-25)})
  local message, kind = status.blockedMessage()
  assert(kind == 'stopped' and message == ${lua_(messages.stopped)})
`));

test('failures distinguish missing setup from other errors, including launcher failures from this session', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', since = ms(-4), updated = ms(-1)})
  local message, kind = status.blockedMessage()
  assert(kind == 'setup' and message == ${lua_(messages.setup)})
  advance(1)
  put('runtime/bridge-service.json', {state = 'failed', code = 'voice-client-build-failed', since = ms(-4), updated = ms(-1)})
  message, kind = status.blockedMessage()
  assert(kind == 'failed' and message == ${lua_(messages.failed)} .. ' (voice-client-build-failed)', 'the status code follows the sentence')
  -- The launcher writes once at game start and has no heartbeat.
  advance(600)
  put('runtime/bridge-service.json', {state = 'failed', code = 'launcher-program-missing', source = 'launcher',
      since = ms(-600 - 60), updated = ms(-600 - 60)})
  assert(select(2, status.blockedMessage()) == 'failed', 'a launcher failure from this game session')
  advance(1)
  put('runtime/bridge-service.json', {state = 'failed', code = 'launcher-program-missing', source = 'launcher',
      since = ms(-7200), updated = ms(-7200)})
  assert(select(2, status.blockedMessage()) == 'failed', 'an old launcher failure is no trace of this session: the service never started')
`));

// A player whose Runtime was a Mod Organizer 2 mod saw only the launcher's "starting", for good: the service process it started never
// wrote another word. The game reported "not running, restart the game" and nothing said the service had been started and then went
// silent, or why. A "starting" that only the launcher or the start script wrote, and that nothing refreshed, is that service.
test('a launcher "starting" that nothing refreshed is first a service coming up, then one that never came up, with its code in the notice', () => run(`
  put('runtime/bridge-service.json', {version = 1, state = 'starting', code = 'launcher-started', source = 'launcher',
      supervisorPid = 12584, error = 0, since = ms(-10), updated = ms(-10)})
  advance(20)
  assert(status.unavailable().kind == 'starting', 'thirty seconds on: a first start can take that long')
  assert(status.blockedMessage() == ${lua_(messages.starting)})
  assert(status.notice() == nil, 'no proactive notice while it may still be coming up')
  advance(59)
  assert(status.unavailable().kind == 'starting', 'one second short of the limit')
  advance(1)
  local down = status.unavailable()
  assert(down.kind == 'failed' and down.code == 'service-silent', tostring(down.kind))
  local words = 'service-silent after launcher-started'
  local message, kind = status.blockedMessage()
  assert(kind == 'failed' and message == ${lua_(messages.failed)} .. ' (' .. words .. ')', message)
  assert(status.failureCode() == 'service-silent' and status.failureDetail() == words)
  assert(status.notice() == ${lua_(messages.failed)} .. ' (' .. words .. ')', 'announced before the player tries to talk')
  advance(5)
  assert(status.notice() == nil, 'once per episode')
  assert(status.lostSince(now() - 100) == nil, 'only the supervisor itself retires a request early')
  -- The service comes up late (or is started by hand): nothing is reported any more.
  advance(1); put('runtime/knowledge-status.json', {version = 1, updated = ms(-1)})
  assert(status.unavailable() == nil and status.blockedMessage() == nil and status.failureDetail() == nil)
`));

test('the "starting" of the start script itself is judged the same way: fresh it is starting, stale it names the stage it stopped in', () => run(`
  put('runtime/bridge-service.json', {version = 1, state = 'starting', code = 'service-starting', source = 'service', stage = 'preparing-state',
      supervisorPid = 4242, since = ms(-2), updated = ms()})
  assert(status.unavailable().kind == 'starting')
  advance(21)
  assert(status.unavailable().kind == 'starting', 'stale, but within the time a first start may take')
  advance(70)
  local message = status.blockedMessage()
  assert(message == ${lua_(messages.failed)} .. ' (service-silent after service-starting at preparing-state)', message)
`));

test('a stale "starting" from an earlier game session is no trace of this one, and a starting from the supervisor is not judged by age alone', () => run(`
  advance(600)
  put('runtime/bridge-service.json', {version = 1, state = 'starting', code = 'launcher-started', source = 'launcher', since = ms(-7200), updated = ms(-7200)})
  advance(15)
  local down = status.unavailable()
  assert(down.kind == 'failed' and down.code == nil and down.detail == nil, 'the service never started in this session: the plain sentence')
  assert(status.blockedMessage() == ${lua_(messages.failed)})
  -- The supervisor's own status has no source and its heartbeat refreshes it: stale means the service stopped, as before.
  advance(1)
  put('runtime/bridge-service.json', {version = 1, state = 'starting', code = 'supervisor-started', since = ms(-300), updated = ms(-200)})
  assert(status.unavailable().kind == 'stopped')
`));

test('a failure names its code, the stage and the short reason the service gave, and cleans whatever else the file holds', () => run(`
  put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', source = 'service', stage = 'loading-modules',
      reason = "ERR_MODULE_NOT_FOUND: Cannot find module 'place-packs.mjs' imported from start-service.mjs", since = ms(-1), updated = ms()})
  local expected = 'install-incomplete at loading-modules: ERR_MODULE_NOT_FOUND: Cannot find module \\'place-packs.mjs\\' imported from start-service.mjs'
  local message, kind = status.blockedMessage()
  assert(kind == 'failed' and message == ${lua_(messages.failed)} .. ' (' .. expected .. ')', message)
  assert(status.notice() == message)
  -- A request in flight is told the same when the supervisor reports the failure afterwards.
  advance(5)
  put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'service-error', stage = 'preparing', reason = 'boom', since = ms(-1), updated = ms()})
  assert(status.lostSince(now() - 3) == ${lua_(messages.failed)} .. ' (service-error at preparing: boom)')
  -- Control characters, a long text and a code that is not a code never reach the screen as they are.
  advance(5)
  put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'bad code!', stage = 'x y', reason = 'a\\1\\2b\\n' .. string.rep('c', 500),
      since = ms(-1), updated = ms()})
  local text = status.failureDetail()
  assert(text:find('^no%-code: a  ?b'), text)
  assert(#text <= 150 and not text:find('%c'), #text)
  -- The setup and browser failures keep their own sentences, with no code appended.
  advance(5)
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', reason = 'ignored', since = ms(-1), updated = ms()})
  assert(status.blockedMessage() == ${lua_(messages.setup)} and status.failureDetail() == nil)
`));

test('a missing browser gets its own explanation, a proactive notice and no confusion with other failures', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'browser-missing', since = ms(-4), updated = ms(-1)})
  local message, kind = status.blockedMessage()
  assert(kind == 'browser' and message == ${lua_(messages.browser)}, tostring(kind))
  assert(status.notice() == ${lua_(messages.browser)}, 'announced in game before the player tries to talk')
  advance(1)
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', since = ms(-4), updated = ms(-1)})
  assert(select(2, status.blockedMessage()) == 'failed')
`));

test('a request is retired early only when the supervisor saw its bridge exit afterwards', () => run(`
  local sent = now()
  advance(3)
  put('runtime/bridge-service.json', {state = 'restarting', code = 'bridge-exited', since = ms(-1), updated = ms()})
  assert(status.lostSince(sent) == ${lua_(messages.starting)})
  advance(1)
  put('runtime/bridge-service.json', {state = 'ready', code = 'bridge-ready', restarts = 1, since = ms(-1), updated = ms()})
  assert(status.lostSince(sent) == ${lua_(messages.restarted)}, 'the replacement never saw the request')
  advance(1)
  put('runtime/bridge-service.json', {state = 'ready', code = 'bridge-ready', restarts = 0, since = ms(-1), updated = ms()})
  assert(status.lostSince(sent) == nil, 'a first start can still process a request written before ready')
  advance(1)
  put('runtime/bridge-service.json', {state = 'restarting', code = 'bridge-exited', since = (sent - 30) * 1000, updated = ms()})
  assert(status.lostSince(sent) == nil, 'a restart that began before the request is not this request')
  advance(1)
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', since = ms(-1), updated = ms()})
  assert(status.lostSince(sent) == ${lua_(messages.setup)})
  advance(1)
  put('runtime/bridge-service.json', {state = 'stopped', code = 'stop-requested', since = ms(-1), updated = ms(-60)})
  assert(status.lostSince(sent) == nil, 'stale supervisor status')
  advance(1)
  put('runtime/bridge-service.json', nil)
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-60)})
  assert(status.lostSince(sent) == nil, 'a heartbeat gap alone never retires a request')
`));

test('a failure is announced once per episode and checks are throttled', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', since = ms(-5), updated = ms()})
  assert(status.notice() == ${lua_(messages.setup)})
  advance(1)
  assert(status.notice() == nil, 'throttled')
  advance(5)
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', since = ms(-11), updated = ms()})
  assert(status.notice() == nil, 'same failure episode')
  advance(5)
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', since = ms(-1), updated = ms()})
  assert(status.notice() == ${lua_(messages.failed)} .. ' (bridge-crashed)', 'a new failure is announced')
  advance(5)
  put('runtime/bridge-service.json', {state = 'starting', code = 'x', since = ms(-1), updated = ms()})
  assert(status.notice() == nil)
`));

test('status files are read at most once a second and malformed files are ignored', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-60)})
  put('runtime/bridge-service.json', {state = 'starting', code = 'x', since = ms(-1), updated = ms()})
  for _ = 1, 5 do status.unavailable() end
  assert(readsOf('runtime/knowledge-status.json') == 1 and readsOf('runtime/bridge-service.json') == 1)
  advance(1)
  status.unavailable()
  assert(readsOf('runtime/bridge-service.json') == 2)
  advance(1)
  files['runtime/bridge-service.json'] = 'malformed'
  files['runtime/knowledge-status.json'] = 'malformed'
  assert(status.unavailable() == nil, 'unreadable evidence is no evidence')
`));

test('the empty placeholders the install ships (bridge-service.json and the heartbeats) are no evidence, like missing files', () => run(`
  for _, name in ipairs({'bridge-service', 'knowledge-status', 'local-voice-state'}) do files['runtime/' .. name .. '.json'] = '' end
  assert(status.unavailable() == nil, 'empty files must not read as a stopped service')
  assert(status.blockedMessage() == nil)
  assert(status.lostSince(now() - 10) == nil)
  assert(status.notice() == nil)
  -- The service then writes over them in place: the same files now carry real status.
  advance(5)
  put('runtime/bridge-service.json', {state = 'failed', code = 'missing-key', since = ms(-1), updated = ms()})
  assert(status.unavailable().kind == 'setup')
`));

test('reach(): live only with a fresh heartbeat or a fresh ready, starting or restarting supervisor; no evidence is a definite "never"', () => run(`
  -- No evidence at all (unlike unavailable(), which stays silent): nothing started in this session.
  assert(status.reach() == 'never' and status.unavailable() == nil)
  for _, name in ipairs({'runtime/knowledge-status.json', 'runtime/local-voice-state.json', 'runtime/bridge-service.json'}) do files[name] = '' end
  advance(1)
  assert(status.reach() == 'never', 'the empty placeholders the install ships are no trace')
  advance(1); files['runtime/bridge-service.json'] = 'malformed'
  assert(status.reach() == 'never', 'an unreadable status file is no trace')
  -- A heartbeat or a fresh supervisor that says the service is up or coming up.
  advance(1); put('runtime/knowledge-status.json', {version = 1, updated = ms(-1)})
  assert(status.reach() == 'live', 'knowledge heartbeat')
  advance(1); put('runtime/knowledge-status.json', nil); put('runtime/local-voice-state.json', {state = 'ready', updated = ms(-6)})
  assert(status.reach() == 'live', 'voice heartbeat')
  put('runtime/local-voice-state.json', nil)
  for _, state in ipairs({'ready', 'starting', 'restarting'}) do
    advance(1); put('runtime/bridge-service.json', {state = state, since = ms(-30), updated = ms(-2)})
    assert(status.reach() == 'live', state)
  end
  -- Fresh but not up: stopped, stopping or failed are traces of this session with nothing answering.
  for _, state in ipairs({'stopped', 'stopping', 'failed'}) do
    advance(1); put('runtime/bridge-service.json', {state = state, code = 'x', since = ms(-30), updated = ms(-2)})
    assert(status.reach() == 'stopped', state)
  end
`));

test('reach(): a stale trace from this session is "stopped", one from before this session started is "never"', () => run(`
  -- The module was loaded at the clock's start: a trace written in the three minutes before that, or since, is this session's.
  advance(600)
  put('runtime/bridge-service.json', {state = 'ready', since = ms(-300), updated = ms(-120)})
  assert(status.reach() == 'stopped', 'a supervisor gone quiet')
  advance(1); put('runtime/bridge-service.json', nil); put('runtime/knowledge-status.json', {version = 1, updated = ms(-25)})
  assert(status.reach() == 'stopped', 'a heartbeat gone quiet')
  advance(1); put('runtime/knowledge-status.json', nil); put('runtime/local-voice-state.json', {state = 'ready', updated = ms(-300)})
  assert(status.reach() == 'stopped', 'a voice heartbeat gone quiet')
  -- Left by an earlier session of the game (older than the start of this one by more than the launcher's head start).
  advance(1); put('runtime/local-voice-state.json', nil)
  put('runtime/bridge-service.json', {state = 'ready', since = ms(-90000), updated = ms(-86400)})
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-86400)})
  assert(status.reach() == 'never', 'yesterday\\'s status says nothing about this session')
  -- A status written just before the module loaded (the launcher starts first) still counts.
  advance(1); put('runtime/knowledge-status.json', nil)
  put('runtime/bridge-service.json', {state = 'failed', code = 'browser-missing', since = ms(-770), updated = ms(-770)})
  assert(status.reach() == 'stopped', 'the launcher failed two and a half minutes before the module loaded')
  -- Cached for the second, like the other readers: no extra file opens.
  local before = readsOf('runtime/bridge-service.json')
  status.reach(); status.reach()
  assert(readsOf('runtime/bridge-service.json') == before)
`));
