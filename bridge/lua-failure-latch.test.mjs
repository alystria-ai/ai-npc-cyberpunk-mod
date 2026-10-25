// A failed load or build must not be retried on every 0.1 s tick. Live 2026-10-25: the housemate service threw on each tick, so init.lua read and compiled
// housemate-service.lua ten times a second (probe.log "repeated 10000 times"). This pins the same rule for the other lazy modules of the tick: key bindings,
// companion outfits (on by default), the immersive-invitation glue and its controller and car module, and the speak-up offer, which builds nothing while
// nobody is due. Run in fengari over the real code.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};

function run(program) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

test('key bindings: a module that fails to load is read once, not on every tick', () => run(`
  local loads, once = 0, {}
  manager = {keyBindings = function() return {voice = 'IK_F8'} end}
  function convaiLogOnce(key, line) once[#once + 1] = key end
  dofile = function(name) assert(name == 'key-bindings.lua'); loads = loads + 1; error('syntax error near x') end
  ${between('function convaiKeyBindsModule()', '\nend\n', init.slice(init.indexOf('function convaiKeyBindsModule()'))) }
end
  ${between('function convaiKeyBindsTick(', '\nend\n', init.slice(init.indexOf('function convaiKeyBindsTick('))) }
end
  for i = 1, 60 do assert(pcall(convaiKeyBindsTick, {}, true)) end
  assert(loads == 1, 'loaded ' .. loads .. ' times')
  assert(#once == 1 and once[1] == 'key-bindings-load')
  assert(convaiKeyBindsModule() == nil, 'callers get nil, not an error')
`));

test('companion outfits (on by default): a module that fails to load is read once, and every caller copes with no module', () => run(`
  local loads = 0
  manager = {companionOutfits = function() return true end}
  companions = {}
  function convaiLogOnce() end
  dofile = function(name) assert(name == 'companion-outfits.lua'); loads = loads + 1; error('cannot open') end
  ${between('function convaiOutfitModule()', 'convaiOutfitApi = {', init)}
  ${between('convaiOutfitApi = {', '\n}\n', init)}
}
  for i = 1, 60 do assert(pcall(convaiOutfitTick, {}, 0.1, true)) end
  assert(companions.spawnOutfit('Character.Judy', 'judy-alvarez') == nil)
  assert(convaiOutfitApi.setHome('judy-alvarez', true) == false and convaiOutfitApi.isHome('judy-alvarez') == nil and convaiOutfitApi.hasHomeOutfit('x') == false)
  assert(loads == 1, 'loaded ' .. loads .. ' times')
`));

test('outfits: an answer of false from the module is still false (isHome)', () => run(`
  manager = {companionOutfits = function() return true end}
  companions = {}
  function convaiLogOnce() end
  dofile = function() return {isHome = function() return false end, setHome = function() return true end, hasHomeOutfit = function() return true end} end
  ${between('function convaiOutfitModule()', 'convaiOutfitApi = {', init)}
  ${between('convaiOutfitApi = {', '\n}\n', init)}
}
  assert(convaiOutfitApi.isHome('x') == false and convaiOutfitApi.setHome('x', true) == true and convaiOutfitApi.hasHomeOutfit('x') == true)
`));

// ---- immersive invitations: the glue in init.lua, then the controller build inside it ---------------------------------------------------------
const immersiveBlock = between('convaiImmersiveService = nil', 'function convaiMeetGreeting(info)');

test('immersive invitations: a glue module that fails to load or build is tried once per load, not on every tick', () => {
  for (const failure of ['load', 'build']) run(`
    local loads, once = 0, {}
    manager = {immersive = function() return {enabled = true} end}
    managerUi, companions, phoneChat, ui = {}, {}, {}, {t = function(text) return text end}
    battleSample, automatic = nil, nil
    function log() end
    function currentDistrict() end
    function convaiLogOnce(key) once[#once + 1] = key end
    convaiNotices = {send = function() end}
    Game = {GetPlayer = function() end}
    dofile = function(name) assert(name == 'immersive-service.lua', name); loads = loads + 1
      if '${failure}' == 'load' then error('syntax error') end
      return {new = function() error('boom') end} end
    ${immersiveBlock}
    end
    for i = 1, 60 do assert(pcall(convaiImmersiveTick, 0.1)) end
    assert(loads == 1, '${failure}: loaded ' .. loads .. ' times')
    assert(#once == 1 and once[1] == 'immersive-service', table.concat(once, ','))
    assert(convaiImmersiveGet() == nil)
    assert(loads == 1)
  `);
});

const serviceSource = read('../mod/immersive-service.lua');
const serviceFixture = failure => `
  local Module = (function() ${serviceSource} end)()
  local options = {enabled = true}
  local loads, builds, once = {}, 0, {}
  local controller = {update = function() end, bind = function() end, disable = function() end}
  local modules = {
    ['immersive-invitations.lua'] = {new = function() builds = builds + 1; if '${failure}' == 'build' then error('boom') end return controller end},
    ['immersive-world.lua'] = {new = function() return {} end}}
  local queue = {}
  local queueReady = true
  convaiCompanionCar = nil
  local glue = Module.new({
    manager = {immersive = function() return options end}, queue = function() return queueReady and queue or nil end, companions = {}, phoneChat = {},
    load = function(name) loads[#loads + 1] = name
      if '${failure}' == 'load' and name == 'immersive-world.lua' then error('syntax error') end
      return modules[name] end,
    notify = function() end, log = function() end, logOnce = function(key) once[#once + 1] = key end, held = function() end,
    districtOf = function() end, greet = function() end, persist = {}, wall = function() return 0 end, random = function() return 0.5 end})
`;

test('immersive service: a failed load or build is not repeated every tick, and turning the setting Off and On tries again', () => {
  for (const failure of ['load', 'build']) run(`${serviceFixture(failure)}
    for i = 1, 60 do glue.tick(0.1) end
    local expectedLoads = '${failure}' == 'load' and 2 or 2
    assert(#loads == expectedLoads, '${failure}: ' .. #loads .. ' loads')
    assert(builds == ('${failure}' == 'build' and 1 or 0), '${failure}: ' .. builds .. ' builds')
    assert(#once == 1 and once[1] == 'immersive-load')
    options = {enabled = false}; glue.tick(0.1)
    options = {enabled = true}; glue.tick(0.1)
    assert(#loads > expectedLoads or builds > ('${failure}' == 'build' and 1 or 0), 'a new On tries again')
  `);
});

test('immersive service: the modules are read once even while the party queue is not ready, and the controller is built when it is', () => run(`${serviceFixture('none')}
  queueReady = false
  for i = 1, 30 do glue.tick(0.1) end
  assert(#loads == 2 and builds == 0, #loads .. ' loads, ' .. builds .. ' builds')
  queueReady = true
  glue.tick(0.1)
  assert(#loads == 2 and builds == 1, 'built once the queue is there, without reading the files again')
`));

test('immersive world: a car module that fails to load is read once', () => {
  const world = read('../mod/immersive-world.lua');
  const start = world.indexOf('local carsFailed = false');
  assert.ok(start > 0);
  assert.match(world.slice(start, start + 600), /if carsFailed then return nil end[\s\S]*carsFailed = true; return nil/);
});

// ---- speak-up: nothing is built on a tick when nobody is due -------------------------------------------------------------------------------------
test('speak-up offer: with nobody due the tick builds no candidate list and asks the scheduler nothing more', () => run(`
  local picks, searched, readyAsked = 0, 0, 0
  convaiSpeakUp = {ready = function(self, who) readyAsked = readyAsked + 1; return false end,
    pick = function() picks = picks + 1 end}
  convaiSpeakUpState = {plan = nil}
  convaiJohnnyRemarks = nil
  function convaiSpeakUpCompanion() searched = searched + 1 end
  ${between('function convaiSpeakUpOffer(', '\nend\n', init.slice(init.indexOf('function convaiSpeakUpOffer('))) }
end
  for i = 1, 100 do convaiSpeakUpOffer({}, 1000 + i, true, {enabled = true}, false, false, function() return true end) end
  assert(picks == 0 and searched == 0, 'pick ' .. picks .. ', search ' .. searched)
  -- Due: the companion list is searched and the scheduler is asked.
  convaiSpeakUp.ready = function() return true end
  convaiSpeakUpOffer({}, 2000, true, {enabled = true}, false, false, function() return true end)
  assert(searched == 1 and picks == 1)
`));

test('speak-up eligibility asks battles.fighting() (a boolean), not status() (a table of eleven fields every 0.1 s)', () => {
  const eligible = between('function convaiSpeakUpEligible(', '\nend\n', init.slice(init.indexOf('function convaiSpeakUpEligible(')));
  assert.match(eligible, /battles\.fighting\(\)/);
  assert.doesNotMatch(eligible, /battles\.status\(\)/);
  assert.match(read('../mod/battle-reactions.lua'), /function self\.fighting\(\) return current ~= nil and current\.state == 'fighting' end/);
});
