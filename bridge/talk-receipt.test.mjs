// A typed line with no reply and no trace of where it stopped (game 2.31, 25 Oct: facing nobody, the line went to the first party member, the game
// wrote the request and the bridge never said a word about it). The bridge now writes a 'received' status naming the request the moment it takes it,
// and logs one line; the game reads that status once 2 s after a typed line was sent (and once more at 6 s) and writes one probe.log line saying
// whether the service took it (mod/service-status.lua receipt, init.lua convaiTalkReceiptTick). A line that went to the first party member because
// V faced nobody also says so when it is handed over.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const initSource = read('../mod/init.lua');
const bridgeSource = read('./convai-bridge.mjs');

function run(program) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

// mod/service-status.lua over files from a table (decoded by a registry), a clock the test sets, reads only.
const serviceFixture = `
local registry, serial = {}, 0
files = {}
local reads = 0
function put(path, value)
    if value == nil then files[path] = nil; return end
    serial = serial + 1; local key = 'json-' .. serial; registry[key] = value; files[path] = key
end
json = {decode = function(raw) return assert(registry[raw], 'unexpected JSON input ' .. tostring(raw)) end}
local now = 1792927200
local realOs = os
os = setmetatable({time = function() return now end}, {__index = realOs})
io = {open = function(path, mode)
    assert(mode == 'rb', 'status reads only')
    reads = reads + 1
    if files[path] == nil then return nil end
    return {read = function() return files[path] end, close = function() return true end}
end}
convaiUiLocale = {version = 1, t = function(text) return text end}
dofile = function(path) error('unexpected dependency ' .. path) end
local status = (function() ${read('../mod/service-status.lua')} end)()
`;

test('service-status receipt: received when the bridge status names the request, with the state and how old the status and the heartbeat are', () => run(serviceFixture + `
  put('runtime/bridge-status.json', {state = 'received', requestId = '1792927188-2-11144448ULL', updated = now * 1000.0 - 1000})
  put('runtime/bridge-service.json', {state = 'ready', updated = now * 1000.0 - 3000})
  local received, state, statusAge, serviceAge = status.receipt('1792927188-2-11144448ULL')
  assert(received == true and state == 'received' and statusAge == 1 and serviceAge == 3, tostring(received) .. tostring(state) .. tostring(statusAge) .. tostring(serviceAge))
  -- The live case: the status still names the turn before (the greeting) and nothing has been written for 24 s, the heartbeat for 13 s.
  put('runtime/bridge-status.json', {state = 'thinking', requestId = '1792927164-1-11144448ULL', updated = now * 1000.0 - 24000})
  put('runtime/bridge-service.json', {state = 'ready', updated = now * 1000.0 - 13000})
  received, state, statusAge, serviceAge = status.receipt('1792927188-2-11144448ULL')
  assert(received == false and state == 'thinking' and statusAge == 24 and serviceAge == 13)
  -- No files, or a request id that is not one: not received, nothing known.
  put('runtime/bridge-status.json', nil); put('runtime/bridge-service.json', nil)
  received, state, statusAge, serviceAge = status.receipt('1792927188-2-11144448ULL')
  assert(received == false and state == nil and statusAge == nil and serviceAge == nil)
  put('runtime/bridge-status.json', {state = 'ready'})
  assert(status.receipt('') == false and status.receipt(nil) == false)
`));

// init.lua convaiTalkReceiptTick, run as it is with a clock, a log and a stand-in for the service status.
function receiptTick() {
  const start = initSource.indexOf('function convaiTalkReceiptTick()');
  assert.ok(start > 0, 'init.lua has the receipt tick');
  return initSource.slice(start, initSource.indexOf('\nend\n', start) + 5);
}
const tickFixture = `
local clock, logs, asked = 0, {}, 0
local answer = {false, 'thinking', 24, 13}
os.clock = function() return clock end
local function log(line) logs[#logs + 1] = line end
convaiServiceStatus = {receipt = function(requestId) asked = asked + 1; assert(requestId == '1792927188-2-11144448ULL')
  return answer[1], answer[2], answer[3], answer[4] end}
${receiptTick()}
local function tickFor(seconds) local target = clock + seconds; while clock < target - 1e-9 do clock = clock + 0.1; if convaiTalkReceipt then convaiTalkReceiptTick() end end end
local function send() convaiTalkReceipt = {requestId = '1792927188-2-11144448ULL', generation = 2, at = clock} end
`;

test('the receipt tick: one look at 2 s; a request the service took is one line, and the watch ends', () => run(tickFixture + `
  answer = {true, 'received', 0, 1}
  send()
  tickFor(1.9); assert(asked == 0 and #logs == 0, 'nothing is read in the first 2 s')
  tickFor(0.2); assert(asked == 1 and convaiTalkReceipt == nil)
  assert(#logs == 1 and logs[1] == 'Talk request received by the service: generation=2 state=received', logs[1])
  tickFor(10); assert(asked == 1 and #logs == 1, 'and nothing after')
`));

test('the receipt tick: not taken at 2 s, looked at again at 6 s; never taken says what the service last wrote and when (codes only)', () => run(tickFixture + `
  send()
  tickFor(2.1); assert(asked == 1 and #logs == 0 and convaiTalkReceipt ~= nil, 'one more look later')
  tickFor(3.8); assert(asked == 1)
  tickFor(0.2); assert(asked == 2 and convaiTalkReceipt == nil and #logs == 1)
  assert(logs[1] == 'Talk request not received by the service within 6 s: generation=2 service=thinking written=24s heartbeat=13s', logs[1])
  -- Taken late: said so.
  logs = {}; asked = 0; send()
  tickFor(2.1); answer = {true, 'thinking', 1, 2}; tickFor(4)
  assert(asked == 2 and logs[1] == 'Talk request received by the service: generation=2 state=thinking (after 2 s)', logs[1])
  -- Without the service-status module the watch just ends.
  logs = {}; convaiServiceStatus = nil; send(); tickFor(3)
  assert(convaiTalkReceipt == nil and #logs == 0)
`));

test('init.lua: the receipt is set only for a request that was written, the tick reads it with one nil check, and the fallback hand-off is one line', () => {
  assert.match(initSource, /sent = sendRequest\(context\)\n\s*if sent then\n[^\n]*\n\s*convaiTalkReceipt = \{requestId = context\.requestId, generation = context\.generation, at = os\.clock\(\)\}/);
  assert.match(initSource, /if convaiTalkFallbackGeneration == context\.generation then\n\s*log\('Talk fallback: request handed to the service: generation=' \.\. context\.generation\)/);
  assert.match(initSource, /if convaiTalkReceipt then pcall\(convaiTalkReceiptTick\) end/);
  // The fallback is marked on the conversation it chose, and on the composer's generation only for a private line (not in the request itself).
  assert.match(initSource, /npc, fallback = member\.npc, true\n\s*log\('Talk fallback: first party member '/);
  assert.match(initSource, /spawned = convaiWorldPolicy ~= nil and convaiWorldPolicy\.spawned\(npc\) or nil, fallback = fallback\}/);
  assert.match(initSource, /convaiTalkFallbackGeneration = primary\.fallback and not participants and generation or nil/);
  const active = /active = \{generation = generation,[\s\S]*?\}\n/.exec(initSource)[0];
  assert.ok(!/fallback/.test(active), 'the request the bridge reads is the same for both routes');
  assert.ok(!/onUpdate|OnUpdate/.test(receiptTick()), 'nothing per frame');
});

test('bridge: a submitted request is marked received in its status as its turn starts (not awaited, not for a turn prepared ahead) and logged once', () => {
  const start = bridgeSource.indexOf('async function processInput(request, prepared) {');
  const body = bridgeSource.slice(start, bridgeSource.indexOf('\n}\n', start));
  assert.match(body, /if \(!request\.lookahead && input\) \{\s*endTitle\('a turn arrived'\);[^\n]*\n\s*void status\('received', '', \{requestId: input\.requestId, provider: input\.provider\}\)\.catch\(\(\) => \{\}\);/);
  assert.match(body, /console\.error\(`\[Turn\] received \$\{String\(input\.requestId\)\.slice\(0, 80\)\} generation=\$\{input\.generation\}/);
  assert.ok(body.indexOf("status('received'") < body.indexOf('withTurnClock('), 'before the turn runs');
  assert.ok(!/await status\('received'/.test(bridgeSource), 'the turn never waits for the receipt');
  const tickStart = bridgeSource.indexOf('async function tick() {');
  const tick = bridgeSource.slice(tickStart, bridgeSource.indexOf('\n}\n', tickStart));
  assert.match(tick, /void processInput\(request\);/, 'every submitted turn the poll accepts goes through processInput');
});
