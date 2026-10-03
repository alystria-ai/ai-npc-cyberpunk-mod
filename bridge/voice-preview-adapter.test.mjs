import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/voice-preview.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function run(body) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(`${fixture}\n${body}`));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const fixture = `
local clock, nativeCallback, reads, attempts, failWrite = 100000, false, 0, 0, false
local files, publications, encoded, handlers = {}, {}, {}, {}
local pending, values = false, {voiceProvider = 2, omniSteps = 2}
local committed = {voiceProvider = 'convai', omniSteps = 32}
local api = {}
local nextToken = 0
function api.subscribe(name, callback)
    assert(name == 'drafts.changed')
    nextToken = nextToken + 1; handlers[nextToken] = callback; return nextToken
end
function api.unsubscribe(token) handlers[token] = nil; return true end
function api.hasDrafts(key)
    assert(not nativeCallback, 'read settings inside the native callback')
    assert(key == 'cyberpunk-convai:manager'); return pending
end
function api.getValue(key)
    assert(not nativeCallback, 'read values inside the native callback')
    reads = reads + 1
    return values[key:match(':([^:]+)$')]
end
local preview = (function() ${source} end)().new({
    now = function() return clock end,
    encode = function(value)
        assert(not nativeCallback, 'encoded inside the native callback')
        encoded[#encoded + 1] = value; return tostring(#encoded)
    end,
    write = function(path, raw)
        assert(not nativeCallback, 'wrote inside the native callback')
        assert(path == 'runtime/voice-preview.json', 'preview wrote a persistent settings file')
        attempts = attempts + 1
        if failWrite then return false end
        files[path] = encoded[tonumber(raw)]
        publications[#publications + 1] = files[path]
        return true
    end,
})
preview.bind(api)
local function update(visible, controller)
    preview.update(visible ~= false, controller or 'native-menu-1', function() return committed end)
end
local function changed(provider, steps, dirty, key)
    if provider ~= nil then values.voiceProvider = provider end
    if steps ~= nil then values.omniSteps = steps end
    if dirty ~= nil then pending = dirty end
    nativeCallback = true
    for _, callback in pairs(handlers) do callback({modKey = key or 'cyberpunk-convai:manager'}) end
    nativeCallback = false
end
local function current() return files['runtime/voice-preview.json'] end
`;

test('voice selector immediately publishes a preparation preview without applying settings or callback IO', () => {
  run(`
    update(); assert(#publications == 0)
    changed(1, 2, true)
    assert(#publications == 0 and reads == 0, 'selector callback did work before update')
    update()
    local value = current()
    assert(value.active and value.provider == 'pocket' and value.steps == nil)
    assert(value.version == 1 and value.updated == clock)
    assert(value.sequence == 1)
    assert(type(value.owner) == 'string' and #value.owner <= 96 and value.owner:match('^mcm%-'))
    assert(committed.voiceProvider == 'convai' and committed.omniSteps == 32)
    changed(1, 1, true); update()
    assert(current().steps == nil and #publications == 1, 'obsolete quality must not publish another preview')
    changed(2, 1, true); update()
    assert(not current().active and #publications == 2 and current().sequence == 2)
    assert(current().updated == value.updated, 'test must exercise same-timestamp changes')
    assert(committed.omniSteps == 32, 'quality preview persisted before Apply')
  `);
});

test('lease refresh is bounded but a changed selector is not delayed by the heartbeat', () => {
  run(`
    changed(1, 2, true); update()
    local owner = current().owner
    for i = 1, 59 do clock = clock + 10; update() end
    assert(#publications == 1 and reads == 1)
    changed(2, 1, true); update()
    assert(#publications == 2 and not current().active and current().updated == clock and current().owner == owner)
    changed(1, 1, true); update()
    clock = clock + 1000; update()
    assert(#publications == 4 and current().updated == clock and current().owner == owner)
  `);
});

test('Revert and returning both selectors to committed values cancel even when other drafts remain', () => {
  run(`
    changed(1, 2, true); update()
    changed(2, 2, true); update()
    assert(not current().active and current().sequence == 2 and committed.voiceProvider == 'convai')
    changed(1, 1, true); update(); assert(current().active)
    changed(2, 2, false); update()
    assert(not current().active and committed.omniSteps == 32)
    local count = #publications
    clock = clock + 1000; update(); update()
    assert(#publications == count, 'inactive previews should not create recurring writes')
  `);
});

test('Apply cancels only the preview while the independently committed selection remains authoritative', () => {
  run(`
    changed(1, 1, true); update()
    committed.voiceProvider, committed.omniSteps = 'pocket', 16
    changed(1, 1, false); update()
    assert(not current().active and committed.voiceProvider == 'pocket' and committed.omniSteps == 16)
    changed(2, 2, true); update()
    assert(current().active and current().provider == 'convai')
    assert(committed.voiceProvider == 'pocket' and committed.omniSteps == 16)
  `);
});

test('menu loss and reset cancel ownership; reopened and replacement menus get distinct leases', () => {
  run(`
    changed(1, 2, true); update()
    local first = current().owner
    update(false); assert(not current().active and current().owner == first)
    clock = clock + 10; update(); assert(current().active and current().owner ~= first)
    local second = current().owner
    update(true, 'native-menu-2')
    assert(current().active and current().owner ~= second)
    assert(publications[#publications - 1].active == false)
    preview.reset(); assert(not current().active)
    update(); assert(current().active)
    preview.shutdown(); assert(not current().active and next(handlers) == nil)
    assert(not preview.inspect().available)
  `);
});

test('invalid or unavailable draft values cancel and unsupported APIs do not publish', () => {
  run(`
    changed(1, 2, true); update()
    changed(3, 2, true); update(); assert(not current().active)
    changed(1, 2, true); update(); assert(current().active)
    api.getValue = function() error('unavailable') end
    changed(); update(); assert(not current().active)
    preview.bind({}); update()
    assert(not preview.inspect().available and not current().active)
  `);
});

test('unrelated events and unrelated setting drafts never prepare Pocket', () => {
  run(`
    update()
    changed(2, 2, true); update(); assert(#publications == 0)
    local before = reads
    changed(nil, nil, nil, 'some-other-mod:settings'); update()
    assert(reads == before and #publications == 0)
    clock = clock + 1000; update()
    assert(#publications == 0)
  `);
});

test('failed writes retry at the heartbeat and failed cancellation leaves only the bounded prior lease', () => {
  run(`
    failWrite = true; changed(1, 2, true); update()
    assert(not current() and attempts == 1 and preview.inspect().error)
    for i = 1, 10 do clock = clock + 10; update() end
    assert(attempts == 1)
    failWrite = false; clock = clock + 1000; update()
    assert(current().active and not preview.inspect().error)
    failWrite = true; update(false)
    local prior = current().updated
    assert(current().active and preview.inspect().error)
    local count = attempts
    update(false); assert(attempts == count)
    failWrite = false; clock = clock + 1000; update(false)
    assert(not current().active and current().updated > prior and not preview.inspect().error)
  `);
});
