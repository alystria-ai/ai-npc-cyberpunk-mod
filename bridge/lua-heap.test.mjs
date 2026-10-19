// The on-demand Lua heap report (mod/lua-heap-probe.lua, dispatched by init.lua's developer mailbox; deliverables/perf/LUA_HEAP.md).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const probeSource = read('mod/lua-heap-probe.lua');
const initSource = read('mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The probe as a module, an in-memory disk for runtime/lua-heap.json, a JSON stand-in that keeps the Lua value (encode returns a
// handle, decode gives it back) and a fake collectgarbage that counts its calls.
const fixture = `
  local probe = (function() ${probeSource} end)()
  local disk, stored, gcCalls = {}, {}, {}
  local function open(path, mode)
    if mode:sub(1, 1) == 'r' then
      if not disk[path] then return nil end
      return {read = function() return disk[path] end, close = function() end}
    end
    return {write = function(_, text) disk[path] = text end, close = function() end}
  end
  local function encode(value) stored[#stored + 1] = value; return 'doc' .. #stored end
  local function decode(text) return stored[tonumber(text:match('^doc(%d+)$'))] end
  local heap = 5000
  local function gc(option)
    gcCalls[#gcCalls + 1] = option
    if option == 'collect' then heap = 3000 end
    return heap
  end
  local function report(nonce, extra)
    local env = {nonce = nonce, open = open, encode = encode, decode = decode, collectgarbage = gc, loadedAt = os.time() - 30}
    for key, value in pairs(extra or {}) do env[key] = value end
    return probe.run(env)
  end
`;

test('the walk counts each object once, for the first root that reaches it, and names the big first-level fields', () => run(`${fixture}
  local shared = {text = string.rep('s', 200)}
  local big = {}
  for index = 1, 300 do big[index] = {name = 'row ' .. index, note = string.rep('n', 50)} end
  local first = {big = big, shared = shared, small = {1, 2, 3}}
  local second = {shared = shared, own = {string.rep('o', 1000)}}
  local result = probe.walk({{'first', first}, {'second', second}})
  assert(result.truncated == false and result.nodes >= 300)
  local roots = {}
  for _, row in ipairs(result.roots) do roots[row.name] = row.kb end
  assert(roots.first > roots.second, 'the shared table counts for the first root only')
  local fields = {}
  for _, row in ipairs(result.fields) do fields[row.name] = row.kb end
  assert(fields['first.big'] and fields['first.big'] > 20, 'first.big: ' .. tostring(fields['first.big']))
  assert(fields['first.shared'] and not fields['second.shared'], 'a field already counted is not counted again')
  assert(result.fields[1].name == 'first.big', 'the largest field comes first: ' .. result.fields[1].name)
  assert(result.tables[1].path == 'first.big' and result.tables[1].entries == 300)
  -- Every byte belongs to exactly one root.
  local sum = 0
  for _, row in ipairs(result.roots) do sum = sum + row.kb end
  assert(math.abs(sum * 1024 - result.totalBytes) < 1)
`));

test('a list root shares one bucket, the standard library and json are never walked, and the walk stops at its cap', () => run(`${fixture}
  json = {encode = function() end, big = {}}
  for index = 1, 500 do json.big[index] = string.rep('j', 100) .. index end
  local list = {}
  for index = 1, 40 do list[index] = {key = 'k' .. index, lib = string, codec = json} end
  local result = probe.walk({{'profiles', list}})
  assert(result.fields[1].name == 'profiles[]', result.fields[1].name)
  assert(result.totalBytes < 40 * 1024, 'string, table or json were counted: ' .. result.totalBytes)
  local capped = probe.walk({{'profiles', list}}, {nodeCap = 5})
  assert(capped.truncated == true and capped.nodes <= 6)
`));

test('a closure is walked through its upvalues when the debug library is there', () => run(`${fixture}
  local held = {}
  for index = 1, 200 do held[index] = string.rep('u', 40) .. index end
  local function keeper() return held end
  local result = probe.walk({{'convaiKeeper', keeper}})
  assert(result.upvalues == true)
  assert(result.totalBytes > 200 * 60, 'the upvalue table was not counted: ' .. result.totalBytes)
`));

test("run collects once, reports the heap before and after, this mod's share, and writes runtime/lua-heap.json", () => run(`${fixture}
  convaiCompanions = {records = {}}
  for index = 1, 50 do convaiCompanions.records['model:' .. index] = {name = 'Model ' .. index} end
  local result = report('lua-heap:1', {roots = {{'profiles', {{key = 'judy'}, {key = 'panam'}}}}, environment = {}})
  assert(result.heapBeforeKB == 5000 and result.heapAfterKB == 3000 and result.garbageKB == 2000)
  assert(#gcCalls == 3 and gcCalls[1] == 'count' and gcCalls[2] == 'collect' and gcCalls[3] == 'count', table.concat(gcCalls, ','))
  assert(result.modKB > 0 and math.abs(result.otherKB - (3000 - result.modKB)) < 1e-9)
  local names = {}
  for _, row in ipairs(result.roots) do names[row.name] = true end
  assert(names.profiles and names.convaiCompanions, 'the init.lua roots and the convai* globals are both walked')
  assert(result.secondsSinceLoad >= 30 and result.nonce == 'lua-heap:1')
  local doc = decode(disk['runtime/lua-heap.json'])
  assert(doc.latest == result and #doc.history == 0)
  convaiCompanions = nil
`));

test('the count-only request makes no collect and no walk', () => run(`${fixture}
  local result = report('lua-heap:count:7')
  assert(#gcCalls == 1 and gcCalls[1] == 'count')
  assert(result.heapBeforeKB == 5000 and result.heapAfterKB == nil and result.modKB == nil and result.roots == nil)
  assert(decode(disk['runtime/lua-heap.json']).latest == result)
`));

test('the file keeps the latest report and the eleven before it', () => run(`${fixture}
  for index = 1, 15 do report('lua-heap:count:' .. index) end
  local doc = decode(disk['runtime/lua-heap.json'])
  assert(doc.latest.nonce == 'lua-heap:count:15' and #doc.history == 11, #doc.history)
  assert(doc.history[1].nonce == 'lua-heap:count:4' and doc.history[11].nonce == 'lua-heap:count:14')
  -- A damaged file starts a new history instead of failing the request.
  disk['runtime/lua-heap.json'] = 'not a document'
  report('lua-heap:count:16')
  assert(#decode(disk['runtime/lua-heap.json']).history == 0)
`));

test('every request registers its load once on the string metatable, and loadsAlive counts the loads still held', () => run(`${fixture}
  local firstLoad, secondLoad = {}, {}
  assert(report('lua-heap:a', {sentinel = firstLoad}).loadsAlive == 1)
  assert(report('lua-heap:b', {sentinel = firstLoad}).loadsAlive == 1, 'the same load counted twice')
  -- A reload whose earlier load is still referenced (as here, by the test) shows two.
  assert(report('lua-heap:c', {sentinel = secondLoad}).loadsAlive == 2)
  local registry = rawget(getmetatable(''), '__convaiHeapLoads')
  assert(type(registry) == 'table' and getmetatable(registry).__mode == 'k', 'the registry must hold its loads weakly')
  assert(report('lua-heap:count:d', {sentinel = {}}).loadsAlive == nil, 'a count-only request makes no collect, so it cannot count loads')
`));

test('init.lua puts the perf probe wrappers back when the mod shuts down', () => {
  const shutdown = initSource.indexOf("registerForEvent('onShutdown'");
  assert(shutdown > 0);
  const body = initSource.slice(shutdown);
  const flush = body.indexOf('convaiLogFlush() -- the buffered probe.log lines');
  const restore = body.indexOf('pcall(convaiPerfProbe.uninstall)');
  assert(flush > 0 && restore > flush, 'the wrappers are restored last, after the final log flush');
  assert(restore < body.indexOf('\nend)'), 'inside the onShutdown handler');
});

test('init.lua: the developer mailbox sends lua-heap requests to the report, a global defined outside onUpdate', () => {
  const mailbox = initSource.indexOf("nonce:find('^lua%-heap:')");
  assert(mailbox > 0, 'the mailbox has no lua-heap branch');
  assert.match(initSource.slice(mailbox, mailbox + 120), /pcall\(convaiLuaHeapReport, nonce\)/);
  assert(/elseif nonce:find\('\^notice:'\) then pcall\(speech\.devNotice, nonce\)\s+elseif nonce:find\('\^johnny%-probe:'\) then pcall\(convaiJohnnyProbeRun, nonce\)\s+else captureDiagnostic\(\) end/.test(initSource),
    'notices, the Johnny probes and every other request are dispatched as before');
  const definition = initSource.indexOf('convaiLuaHeapReport = function(nonce)');
  const onUpdate = initSource.indexOf("registerForEvent('onUpdate'");
  assert(definition > 0 && onUpdate > 0 && definition < onUpdate, 'the report must be a file-level global, not an onUpdate upvalue');
  assert.match(initSource.slice(definition, definition + 400), /pcall\(dofile, 'lua-heap-probe\.lua'\)/, 'the probe is loaded on demand');
  // A request already in the file when the mod loads is not replayed (the same rule as every mailbox request).
  assert.match(initSource, /lastDiagnosticRequest = request:read\('\*a'\)/);
});
