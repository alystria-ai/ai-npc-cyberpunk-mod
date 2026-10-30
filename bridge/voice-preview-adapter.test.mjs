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
local pending, values = false, {voiceProvider = 7}
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
    assert(key == 'cyberpunk-convai:manager:voiceProvider', 'read a separate quality selector')
    reads = reads + 1
    return values.voiceProvider
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
local function changed(provider, dirty, key)
    if provider ~= nil then values.voiceProvider = provider end
    if dirty ~= nil then pending = dirty end
    nativeCallback = true
    for _, callback in pairs(handlers) do callback({modKey = key or 'cyberpunk-convai:manager'}) end
    nativeCallback = false
end
local function current() return files['runtime/voice-preview.json'] end
`;

// Row entries: 1 Off (prepares nothing), then the list position plus one: 2 Pocket TTS, 3 Mistral cloud voice (Voxtral), 4 Omni 16 short, 5 Omni 16 long, 6 Omni 32 short, 7 Omni 32 long, 8 Convai cloud voice.
test('voice selector immediately publishes a preparation preview without applying settings or callback IO', () => {
  run(`
    update(); assert(#publications == 0)
    changed(2, true)
    assert(#publications == 0 and reads == 0, 'selector callback did work before update')
    update()
    local value = current()
    assert(value.active and value.provider == 'pocket' and value.omniSteps == nil and value.steps == nil)
    assert(value.version == 1 and value.updated == clock)
    assert(value.sequence == 1)
    assert(type(value.owner) == 'string' and #value.owner <= 96 and value.owner:match('^mcm%-'))
    assert(committed.voiceProvider == 'convai' and committed.omniSteps == 32)
    changed(2, true); update()
    assert(current().omniSteps == nil and #publications == 1, 'unchanged selection must not publish another preview')
    changed(5, true); update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 16 and current().sequence == 2)
    changed(7, true); update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 32 and current().sequence == 3)
    changed(8, true); update()
    assert(not current().active and #publications == 4 and current().sequence == 4 and current().omniSteps == 32)
    assert(current().updated == value.updated, 'test must exercise same-timestamp changes')
    assert(committed.omniSteps == 32, 'quality preview persisted before Apply')
  `);
});

test('lease refresh is bounded but a changed selector is not delayed by the heartbeat', () => {
  run(`
    changed(2, true); update()
    local owner = current().owner
    for i = 1, 59 do clock = clock + 10; update() end
    assert(#publications == 1 and reads == 1)
    changed(5, true); update()
    assert(#publications == 2 and current().active and current().provider == 'omni' and current().omniSteps == 16)
    assert(current().updated == clock and current().owner == owner)
    changed(2, true); update()
    clock = clock + 1000; update()
    assert(#publications == 4 and current().updated == clock and current().owner == owner)
  `);
});

test('Revert and returning the voice choice to the committed Omni quality cancel even when other drafts remain', () => {
  run(`
    committed.voiceProvider, committed.omniSteps = 'omni', 16
    changed(7, true); update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 32)
    changed(5, true); update()
    assert(not current().active and current().sequence == 2 and committed.voiceProvider == 'omni')
    changed(2, true); update(); assert(current().active and current().omniSteps == nil)
    changed(5, false); update()
    assert(not current().active and committed.omniSteps == 16)
    local count = #publications
    clock = clock + 1000; update(); update()
    assert(#publications == count, 'inactive previews should not create recurring writes')
  `);
});

test('Apply cancels only the preview while the independently committed selection remains authoritative', () => {
  run(`
    changed(2, true); update()
    committed.voiceProvider, committed.omniSteps = 'pocket', 16
    changed(2, false); update()
    assert(not current().active and committed.voiceProvider == 'pocket' and committed.omniSteps == 16)
    changed(8, true); update()
    assert(current().active and current().provider == 'convai' and current().omniSteps == nil)
    assert(committed.voiceProvider == 'pocket' and committed.omniSteps == 16)
  `);
});

test('menu loss and reset cancel ownership; reopened and replacement menus get distinct leases', () => {
  run(`
    changed(2, true); update()
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
    changed(2, true); update()
    changed(8, true); update(); assert(not current().active)
    changed(2, true); update(); assert(current().active)
    changed(10, true); update(); assert(not current().active, 'an index past the last entry is not a choice')
    changed(2, true); update(); assert(current().active)
    api.getValue = function() error('unavailable') end
    changed(); update(); assert(not current().active)
    preview.bind({}); update()
    assert(not preview.inspect().available and not current().active)
  `);
});

test('unrelated events and unrelated setting drafts never prepare a local model', () => {
  run(`
    update()
    changed(8, true); update(); assert(#publications == 0)
    local before = reads
    changed(nil, nil, 'some-other-mod:settings'); update()
    assert(reads == before and #publications == 0)
    clock = clock + 1000; update()
    assert(#publications == 0)
  `);
});

test('failed writes retry at the heartbeat and failed cancellation leaves only the bounded prior lease', () => {
  run(`
    failWrite = true; changed(7, true); update()
    assert(not current() and attempts == 1 and preview.inspect().error)
    for i = 1, 10 do clock = clock + 10; update() end
    assert(attempts == 1)
    failWrite = false; clock = clock + 1000; update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 32 and not preview.inspect().error)
    failWrite = true; update(false)
    local prior = current().updated
    assert(current().active and preview.inspect().error)
    local count = attempts
    update(false); assert(attempts == count)
    failWrite = false; clock = clock + 1000; update(false)
    assert(not current().active and current().updated > prior and current().omniSteps == 32 and not preview.inspect().error)
  `);
});

test('a saved legacy hybrid choice matches its effective Omni quality without preparing a different model', () => {
  run(`
    committed.voiceProvider, committed.omniSteps = 'hybrid', 16
    changed(5, true); update(); assert(#publications == 0)
    changed(7, true); update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 32)
    changed(5, true); update(); assert(not current().active)
    assert(committed.voiceProvider == 'hybrid' and committed.omniSteps == 16)
  `);
});

test('a staged choice prepares nothing until it has stayed unchanged, and rapid cycling publishes no lease', () => {
  run(`
    preview.reset(); preview = nil
    local settled = (function() ${source} end)().new({settleMs = 2000, now = function() return clock end,
      encode = function(value) encoded[#encoded + 1] = value; return tostring(#encoded) end,
      write = function(path, raw) files[path] = encoded[tonumber(raw)]; publications[#publications + 1] = files[path]; return true end})
    settled.bind(api)
    local function step(provider) changed(provider, true); settled.update(true, 'native-menu-1', function() return committed end) end
    -- Cycle through every choice, one per second: none stays long enough.
    for _, provider in ipairs({2, 5, 7, 2, 5}) do step(provider); clock = clock + 1000 end
    assert(#publications == 0, 'a choice that kept changing prepared a model')
    assert(settled.staged() == 'omni:16:long')
    -- The last choice stays: after two unchanged seconds it is published once.
    step(5); assert(#publications == 0, 'published before the settle time')
    clock = clock + 1000; step(5)
    assert(#publications == 1 and current().active and current().provider == 'omni' and current().omniSteps == 16)
    -- Moving on keeps the earlier lease alive instead of dropping the worker, then replaces it.
    clock = clock + 1000; step(2)
    assert(#publications == 2 and current().provider == 'omni', 'cycling dropped the prepared choice')
    clock = clock + 2000; step(2)
    assert(current().provider == 'pocket')
    -- Back on the saved choice: staging is cancelled.
    committed.voiceProvider = 'omni'; committed.omniSteps = 16
    clock = clock + 1000; step(5)
    assert(not current().active and settled.staged() == nil)
  `);
});

test('the reference length is part of the choice: it is previewed, carried in the lease and matched against the saved one', () => {
  run(`
    local module = (function() ${source} end)()
    assert(#module.CHOICES == 8 and module.CHOICES[1].provider == 'pocket' and module.CHOICES[2].provider == 'voxtral' and module.CHOICES[7].provider == 'convai' and module.CHOICES[8].provider == 'inworld')
    assert(module.indexOf({voiceProvider = 'pocket'}) == 1 and module.indexOf({voiceProvider = 'voxtral'}) == 2 and module.indexOf({voiceProvider = 'convai'}) == 7 and module.indexOf({voiceProvider = 'inworld'}) == 8)
    assert(module.indexOf({voiceProvider = 'omni', omniSteps = 16, omniReference = 'short'}) == 3)
    assert(module.indexOf({voiceProvider = 'omni', omniSteps = 16, omniReference = 'long'}) == 4)
    assert(module.indexOf({voiceProvider = 'omni', omniSteps = 32, omniReference = 'short'}) == 5)
    assert(module.indexOf({voiceProvider = 'hybrid', omniSteps = 32}) == 6, 'a save without a reference means long')
    committed.voiceProvider, committed.omniSteps, committed.omniReference = 'omni', 16, 'long'
    changed(5, true); update(); assert(#publications == 0, 'the saved choice must not prepare a model')
    changed(4, true); update()
    assert(current().active and current().provider == 'omni' and current().omniSteps == 16 and current().omniReference == 'short')
    changed(6, true); update()
    assert(current().active and current().omniSteps == 32 and current().omniReference == 'short')
    changed(7, true); update()
    assert(current().active and current().omniSteps == 32 and current().omniReference == 'long')
    changed(2, true); update()
    assert(current().active and current().provider == 'pocket' and current().omniReference == nil)
    committed.omniReference = 'short'
    changed(4, true); update(); assert(not current().active, 'the saved short choice was previewed')
    -- A cloud voice (Voxtral) prepares no model: its choice carries no OmniVoice steps.
    committed.voiceProvider = 'pocket'
    changed(3, true); update()
    assert(current().active and current().provider == 'voxtral' and current().omniSteps == nil)
  `);
});

test('the default writer replaces voice-preview.json in place: one open, no temporary file, no remove, no rename', () => {
  run(`
    local ops, store = {}, {}
    io.open = function(path, mode)
        ops[#ops + 1] = 'open ' .. mode .. ' ' .. path
        store[path] = ''
        return {write = function(self, raw) store[path] = raw; return self end, close = function() return true end}
    end
    os.remove = function(path) ops[#ops + 1] = 'remove ' .. path; return true end
    os.rename = function(from) ops[#ops + 1] = 'rename ' .. from; return true end
    local second = (function() ${source} end)().new({now = function() return clock end, encode = function() return 'lease' end})
    second.bind(api)
    changed(2, true)
    second.update(true, 'native-menu-2', function() return committed end)
    assert(#ops == 1 and ops[1] == 'open wb runtime/voice-preview.json' and store['runtime/voice-preview.json'] == 'lease', table.concat(ops, ','))
  `);
});

test('the Off entry of the Companion voices row (value 1) prepares nothing and cancels a prepared voice', () => {
  run(`
    changed(2, true); update()
    assert(current().active and current().provider == 'pocket')
    changed(1, true); update()
    assert(not current().active, 'Off kept a voice prepared')
    local count = #publications
    changed(1, true); update(); clock = clock + 1000; update()
    assert(#publications == count, 'Off wrote again')
    changed(2, true); update()
    assert(current().active and current().provider == 'pocket', 'leaving Off prepared nothing')
  `);
});
