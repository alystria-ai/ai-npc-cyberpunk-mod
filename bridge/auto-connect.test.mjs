import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/auto-connect.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// The policy module with its world, bridge and clock replaced by fakes.
const fixture = `
  local module = (function() ${source} end)()
  local setting, nearby, published, readyKeys, party, wall = true, {}, {}, {}, {}, 1000
  local scans, logs = 0, {}
  local function make(overrides)
    local options = {
      enabled = function() return setting end,
      scan = function() scans = scans + 1; local rows = {}; for _, row in ipairs(nearby) do rows[#rows + 1] = row end; return rows end,
      publish = function(list) published[#published + 1] = table.concat(list, ',') end,
      ready = function(key) return readyKeys[key] == true end,
      party = function(key) return party[key] == true end,
      wall = function() return wall end,
      log = function(line) logs[#logs + 1] = line end}
    for key, value in pairs(overrides or {}) do options[key] = value end
    return module.new(options)
  end
  local open = {worldReady = true, blocked = false}
  local function step(auto, seconds, context)
    -- 0.1 s polls, like the adapter; wall time advances with them.
    for _ = 1, math.floor(seconds * 10 + 0.5) do
      wall = wall + 0.1
      auto.update(0.1, context or open)
    end
  end
  local function last() return published[#published] end
`;

test('with the setting off nothing is prepared and the short wait notice never mentions the setting', () => {
  run(`${fixture}
    setting = false
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local auto = make()
    for _ = 1, 20 do auto.look('judy-alvarez', 'e1', 'Judy', 0.2) end
    step(auto, 5)
    assert(scans == 0 and #published == 0 and #auto.active() == 0, 'the setting off still warmed a character')
    for _ = 1, 4 do assert(auto.talkNotice('judy-alvarez', 'Judy') == 'Preparing connection to Judy…', 'no hint about the setting') end
    assert(auto.talkNotice('panam', 'Panam') == 'Preparing connection to Panam…')
    readyKeys['judy-alvarez'] = true
    assert(auto.talkNotice('judy-alvarez', 'Judy') == nil, 'a connected character still showed the wait notice')
  `);
});

test('with the setting on a wait is silent: no notice before or after the warm-up finishes', () => {
  run(`${fixture}
    local auto = make()
    assert(auto.talkNotice('judy-alvarez', 'Judy') == nil, 'a warm-up announced itself')
    readyKeys['judy-alvarez'] = true
    assert(auto.talkNotice('judy-alvarez', 'Judy') == nil)
  `);
});

test('looking at a character for a moment warms it; a glance does not', () => {
  run(`${fixture}
    local auto = make()
    for _ = 1, 2 do auto.look('judy-alvarez', 'e1', 'Judy', 0.2) end
    step(auto, 0.3)
    assert(#auto.active() == 0, 'a glance warmed a character')
    auto.look('judy-alvarez', 'e1', 'Judy', 0.2)
    step(auto, 0.1)
    assert(auto.active()[1] == 'judy-alvarez' and last() == 'judy-alvarez')
    -- Looking at somebody else restarts the dwell.
    auto.look('panam', 'e2', 'Panam', 0.2); step(auto, 0.1)
    assert(#auto.active() == 1)
    -- A gaze sample that stops arriving expires and never counts again.
    local other = make()
    other.look('river', 'e3', 'River', 0.4); step(other, 2)
    other.look('river', 'e3', 'River', 0.2); step(other, 0.1)
    assert(#other.active() == 0, 'an expired gaze sample counted')
  `);
});

test('standing near characters warms at most two, staggered, nearest first', () => {
  run(`${fixture}
    nearby = {{key = 'far', name = 'Far', distance = 4.5}, {key = 'close', name = 'Close', distance = 1.5},
      {key = 'mid', name = 'Mid', distance = 3}}
    local auto = make()
    step(auto, 0.1)
    assert(table.concat(auto.active(), ',') == 'close', 'only the nearest starts first')
    step(auto, 1)
    assert(#auto.active() == 1, 'two starts inside the stagger window')
    step(auto, 2.5)
    assert(table.concat(auto.active(), ',') == 'close,mid')
    step(auto, 10)
    assert(#auto.active() == 2, 'a third character was warmed')
    assert(last() == 'close,mid')
  `);
});

test('no new character is warmed in combat or a scene, and the world is not scanned', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local auto = make()
    step(auto, 5, {worldReady = true, blocked = true})
    assert(scans == 0 and #auto.active() == 0)
    for _ = 1, 4 do auto.look('judy-alvarez', 'e1', 'Judy', 0.2) end
    step(auto, 0.1, {worldReady = true, blocked = true})
    assert(#auto.active() == 0, 'a gaze warmed a character during combat')
    step(auto, 5, {worldReady = false, blocked = false})
    assert(#auto.active() == 0 and scans == 0, 'a paused game warmed a character')
    step(auto, 0.2)
    assert(auto.active()[1] == 'judy-alvarez')
  `);
});

test('an unused character is released after the hold, then waits out a cooldown', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local auto = make()
    step(auto, 0.2)
    assert(#auto.active() == 1)
    nearby = {}
    step(auto, 39)
    assert(#auto.active() == 1, 'released before the hold ended')
    step(auto, 2)
    assert(#auto.active() == 0 and last() == '', 'an idle character stayed warm')
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    step(auto, 10)
    assert(#auto.active() == 0, 'a released character was warmed again at once')
    step(auto, 12)
    assert(#auto.active() == 1, 'the cooldown never ended')
  `);
});

test('a character is released after ten minutes without a conversation but not while talking to it', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local auto = make()
    step(auto, 0.2)
    step(auto, 590)
    assert(#auto.active() == 1)
    step(auto, 20)
    assert(#auto.active() == 0, 'a character stayed warm past the age limit')
    step(auto, 100)
    assert(#auto.active() == 0, 'it was warmed again inside the long cooldown')
    step(auto, 90)
    assert(#auto.active() == 1)
    -- A conversation in progress keeps it warm and restarts its age.
    step(auto, 580)
    step(auto, 40, {worldReady = true, blocked = false, talking = 'judy-alvarez'})
    assert(#auto.active() == 1, 'a conversation did not keep the connection')
  `);
});

test('a looked-at character takes the place of the idlest unwanted one when two are warm', () => {
  run(`${fixture}
    nearby = {{key = 'a', name = 'A', distance = 1}, {key = 'b', name = 'B', distance = 2}}
    local auto = make()
    step(auto, 4)
    assert(table.concat(auto.active(), ',') == 'a,b')
    nearby = {}
    step(auto, 5)
    for _ = 1, 4 do auto.look('c', 'e3', 'C', 0.2) end
    step(auto, 0.1)
    local list = auto.active()
    assert(#list == 2 and list[1] ~= nil and (list[1] == 'c' or list[2] == 'c'), 'the looked-at character was not warmed')
  `);
});

test('party members are never warmed here, and turning the setting off releases everything once', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}, {key = 'johnny-silverhand', name = 'Johnny', distance = 3}}
    party['judy-alvarez'] = true
    local auto = make()
    step(auto, 0.2)
    assert(table.concat(auto.active(), ',') == 'johnny-silverhand')
    local before = #published
    setting = false
    step(auto, 0.1)
    assert(#auto.active() == 0 and last() == '' and #published == before + 1)
    step(auto, 5); auto.heartbeat()
    assert(#published == before + 1, 'an empty list kept being republished')
  `);
});

test('the heartbeat keeps a non-empty list fresh for the bridge and a reset publishes an empty one', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local auto = make()
    step(auto, 0.2)
    local count = #published
    wall = wall + 1; auto.heartbeat()
    assert(#published == count, 'republished inside the heartbeat interval')
    wall = wall + 1.5; auto.heartbeat()
    assert(#published == count + 1 and last() == 'judy-alvarez')
    auto.reset()
    assert(last() == '' and #auto.active() == 0)
    -- A failing scan or publisher never breaks the update.
    local broken = make({scan = function() error('native failure') end, publish = function() error('disk full') end})
    step(broken, 2)
  `);
});
