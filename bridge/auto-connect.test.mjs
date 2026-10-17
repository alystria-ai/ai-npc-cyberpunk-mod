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
  local scans, logs, publishedPartners = 0, {}, {}
  local function make(overrides)
    local options = {
      enabled = function() return setting end,
      scan = function() scans = scans + 1; local rows = {}; for _, row in ipairs(nearby) do rows[#rows + 1] = row end; return rows end,
      publish = function(list, partners)
        published[#published + 1] = table.concat(list, ',')
        publishedPartners[#publishedPartners + 1] = table.concat(partners or {}, ',')
      end,
      ready = function(key) return readyKeys[key] == true end,
      party = function(key) return party[key] == true end,
      wall = function() return wall end,
      mono = function() return wall end,
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

test('looking at a character and warming her announces nothing; the notice comes only from a talk start', () => {
  run(`${fixture}
    setting = true; nearby = {}
    local auto = make()
    assert(auto.takeNotices == nil, 'a queued gaze notice still exists')
    for _ = 1, 40 do auto.look('judy-alvarez', 'e1', 'Judy', 0.2) end
    step(auto, 5)
    assert(#auto.active() == 1 and auto.active()[1] == 'judy-alvarez', 'the gaze did not warm her')
    assert(auto.talkNotice('judy-alvarez', 'Judy') == 'Preparing connection to Judy…', 'a talk before she was ready showed nothing')
    readyKeys['judy-alvarez'] = true
    step(auto, 1)
    assert(auto.talkNotice('judy-alvarez', 'Judy') == nil, 'a ready character showed the notice')
  `);
});

test('with the setting on the wait notice still shows until the character is connected', () => {
  run(`${fixture}
    setting = true
    local auto = make()
    assert(auto.talkNotice('judy-alvarez', 'Judy') == 'Preparing connection to Judy…', 'the wait with the setting on was silent')
    assert(auto.talkNotice('panam', 'Panam') == 'Preparing connection to Panam…')
    readyKeys['judy-alvarez'] = true
    assert(auto.talkNotice('judy-alvarez', 'Judy') == nil, 'a connected character still showed the wait notice')
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
    -- A conversation moves it to the partner role: it keeps its connection, outside the two slots.
    step(auto, 580)
    step(auto, 40, {worldReady = true, blocked = false, talking = 'judy-alvarez'})
    assert(#auto.active() == 0 and auto.partners()[1] == 'judy-alvarez', 'a conversation did not keep the connection')
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

test('the per-frame heartbeat looks at the list only every 0.25 s, retries a refused slot next frame, and still publishes on time', () => {
  run(`${fixture}
    nearby = {{key = 'judy-alvarez', name = 'Judy', distance = 2}}
    local looks = 0
    local auto = make({heartbeatLook = 0.25, wall = function() looks = looks + 1; return wall end})
    step(auto, 0.2)
    local count = #published
    -- 90 frames of 1/30 s (3 s): the unchanged list is looked at about every 0.25 s, never every frame, and the
    -- heartbeat still reaches the bridge once inside the 2 s interval plus one look.
    looks = 0
    local original = convaiHeartbeatSlot
    convaiHeartbeatSlot = function() return true end
    for _ = 1, 90 do wall = wall + 1 / 30; auto.heartbeat() end
    assert(looks >= 10 and looks <= 13, 'the heartbeat looked ' .. looks .. ' times in 90 frames')
    assert(#published == count + 1, 'the heartbeat did not publish once in three seconds: ' .. (#published - count))
    -- A slot another heartbeat took this frame: the next frame asks again, not a quarter second later.
    wall = wall + 2.1
    local taken = true
    convaiHeartbeatSlot = function() if taken then taken = false; return false end return true end
    local before = #published
    auto.heartbeat(); assert(#published == before, 'published in a refused slot')
    auto.heartbeat(); assert(#published == before + 1, 'did not retry on the next frame')
    convaiHeartbeatSlot = original
  `);
});

// ---- Prominence: tier-1 named, then other named, then generic, before distance -------------------------------
test('nearby characters rank by prominence before distance; a looked-at generic still beats a nearby named one', () => {
  run(`${fixture}
    local tiers = {['judy-alvarez'] = 1, ['bartender-dex'] = 2, ['resident-male'] = 3, ['archetype-fixer'] = 3}
    local prominence = function(key) return tiers[key] end
    nearby = {{key = 'resident-male', name = 'Resident', distance = 1}, {key = 'bartender-dex', name = 'Named', distance = 2},
      {key = 'judy-alvarez', name = 'Judy', distance = 4.5}}
    local auto = make({prominence = prominence})
    step(auto, 0.1)
    assert(table.concat(auto.active(), ',') == 'judy-alvarez', 'tier-1 first, though farthest: ' .. table.concat(auto.active(), ','))
    step(auto, 3.1)
    assert(table.concat(auto.active(), ',') == 'judy-alvarez,bartender-dex', 'then the other named character')
    -- Same prominence: distance decides.
    local same = make({prominence = function() return 3 end})
    nearby = {{key = 'resident-male', name = 'R', distance = 3}, {key = 'archetype-fixer', name = 'F', distance = 1}}
    step(same, 0.1)
    assert(same.active()[1] == 'archetype-fixer')
    -- Looking is intent: a looked-at generic takes a slot from the idlest unwanted named one.
    nearby = {}
    step(auto, 5)
    for _ = 1, 4 do auto.look('resident-male', 'e9', 'Resident', 0.2) end
    nearby = {{key = 'bartender-dex', name = 'Named', distance = 2}}
    step(auto, 0.1)
    local list = table.concat(auto.active(), ',')
    assert(list:find('resident-male', 1, true), 'the looked-at generic was not warmed: ' .. list)
    -- Without a prominence source every row is named (2): distance alone, as before.
    local plain = make()
    nearby = {{key = 'resident-male', name = 'R', distance = 1}, {key = 'judy-alvarez', name = 'J', distance = 4}}
    step(plain, 0.1)
    assert(plain.active()[1] == 'resident-male')
  `);
});

test('catalogue prominence: tier-1 named, other named, generic residents and archetypes', () => {
  run(`
    local module = (function() ${source} end)()
    assert(module.prominence({key = 'judy-alvarez', kind = 'named'}) == 1)
    assert(module.prominence({key = 'alt-cunningham', kind = 'named'}) == 1, 'Alt is tier 1')
    assert(module.prominence({key = 'dakota-smith', kind = 'named'}) == 2)
    assert(module.prominence({key = 'resident-male', kind = 'ambient'}) == 3)
    assert(module.prominence({key = 'fixer-generic', kind = 'archetype'}) == 3)
    assert(module.prominence({key = 'someone', kind = 'named', tier = 1}) == 1)
    assert(module.prominence({key = 'judy-alvarez', kind = 'named', prominence = 2}) == 2, 'an explicit field wins')
    assert(module.prominence(nil) == 2)
  `);
});

// ---- Conversation partner: a talked-to world character keeps its connection outside the two slots -----------
const partnerFixture = `
  local distances = {}
  local function locate(partner) return distances[partner.key] end
  local function talk(auto, key, seconds) step(auto, seconds or 0.1, {worldReady = true, blocked = false, talking = key}) end
  local function partners(auto) return table.concat(auto.partners(), ',') end
`;

test('a talked-to character stays warm for a follow-up without using a slot, and is published as a partner', () => {
  run(`${fixture}${partnerFixture}
    nearby = {{key = 'a', name = 'A', distance = 1}, {key = 'b', name = 'B', distance = 2}}
    local auto = make({locate = locate})
    distances['dex'] = 3
    step(auto, 4)
    assert(table.concat(auto.active(), ',') == 'a,b')
    -- Talking to a world character who was not prepared: adopted at once, without the stagger, outside the cap.
    talk(auto, 'dex', 0.1)
    assert(partners(auto) == 'dex' and #auto.active() == 2, 'the two slots stay for prepared characters')
    assert(publishedPartners[#publishedPartners] == 'dex' and last() == 'a,b')
    -- The chat ends; V stays nearby: still warm two minutes later for a follow-up.
    step(auto, 120)
    assert(partners(auto) == 'dex', 'released before a follow-up')
    -- Talking to a prepared character moves it from its slot into the partner role (one connection, one owner).
    talk(auto, 'a', 0.1)
    assert(not table.concat(auto.active(), ','):find('a', 1, true), 'a partner kept its slot too')
    assert(partners(auto) == 'a,dex')
  `);
});

test('a partner is released when they part: distance for 20 s, three minutes without an exchange, despawn or a scene', () => {
  run(`${fixture}${partnerFixture}
    local auto = make({locate = locate})
    -- Distance: more than 15 m for 20 s; coming back in time resets it.
    distances['dex'] = 4; talk(auto, 'dex'); step(auto, 1)
    distances['dex'] = 20; step(auto, 15)
    distances['dex'] = 10; step(auto, 1)
    distances['dex'] = 20; step(auto, 19)
    assert(partners(auto) == 'dex', 'released before 20 s away')
    step(auto, 2)
    assert(partners(auto) == '', 'kept after parting ways')
    -- Idle: three minutes without an exchange, even close by.
    distances['dex'] = 2; talk(auto, 'dex'); step(auto, 179)
    assert(partners(auto) == 'dex')
    step(auto, 2)
    assert(partners(auto) == '', 'kept after three idle minutes')
    -- Despawn: the character is gone.
    distances['eve'] = 2; talk(auto, 'eve'); step(auto, 1)
    distances['eve'] = nil; step(auto, 0.1)
    assert(partners(auto) == '', 'kept after it despawned')
    -- A scene starts.
    distances['fay'] = 2; talk(auto, 'fay'); step(auto, 1)
    step(auto, 0.1, {worldReady = true, blocked = true, scene = true})
    assert(partners(auto) == '', 'kept during a scene')
    -- An unknown position (false) never releases on distance.
    local unknown = make({locate = function() return false end})
    talk(unknown, 'gus'); step(unknown, 60)
    assert(table.concat(unknown.partners(), ',') == 'gus')
  `);
});

test('talking to someone else makes them the partner; the previous one gets a 30 s grace; at most two at once', () => {
  run(`${fixture}${partnerFixture}
    local auto = make({locate = locate})
    for _, key in ipairs({'dex', 'eve', 'fay'}) do distances[key] = 2 end
    talk(auto, 'dex'); step(auto, 1)
    talk(auto, 'eve')
    assert(partners(auto) == 'eve,dex')
    step(auto, 29)
    assert(partners(auto) == 'eve,dex', 'the grace ended early')
    step(auto, 2)
    assert(partners(auto) == 'eve', 'the previous partner outlived its grace')
    -- A group chat alternating between two keeps both; a third replaces the oldest at once (cap 2).
    talk(auto, 'dex'); talk(auto, 'eve'); talk(auto, 'dex')
    assert(partners(auto) == 'dex,eve')
    talk(auto, 'fay')
    assert(#auto.partners() == 2 and partners(auto) == 'fay,dex', partners(auto))
    for _ = 1, 50 do talk(auto, ({'dex', 'eve', 'fay', 'gus'})[math.random(4)]) end
    assert(#auto.partners() <= 2 and #auto.active() <= 2, 'the total is bounded')
  `);
});

test('party members never become partners, a promoted partner leaves the role, and the setting off releases partners', () => {
  run(`${fixture}${partnerFixture}
    local auto = make({locate = locate})
    party['judy-alvarez'] = true
    talk(auto, 'judy-alvarez')
    assert(partners(auto) == '', 'a party member became a partner')
    distances['dex'] = 2; talk(auto, 'dex'); step(auto, 1)
    assert(auto.promote('dex') == true and partners(auto) == '' and publishedPartners[#publishedPartners] == '')
    assert(auto.promote('dex') == false)
    -- Joining the party by any route also ends the role.
    talk(auto, 'eve'); step(auto, 1); party['eve'] = true; step(auto, 0.1)
    assert(partners(auto) == '')
    party['eve'] = nil
    talk(auto, 'eve'); step(auto, 1)
    setting = false; step(auto, 0.1)
    assert(partners(auto) == '' and publishedPartners[#publishedPartners] == '')
    -- A reset (load, death) clears partners too.
    setting = true; talk(auto, 'eve'); auto.reset()
    assert(partners(auto) == '')
  `);
});

test('the entity of each warmed or partnered character is published, so a resident\'s own connection can open', () => {
  run(`${fixture}${partnerFixture}
    local ids = {}
    local auto = make({locate = locate, publish = function(list, partnerList, entities)
      published[#published + 1] = table.concat(list, ',')
      publishedPartners[#publishedPartners + 1] = table.concat(partnerList or {}, ',')
      ids[#ids + 1] = entities or {}
    end})
    nearby = {{key = 'resident-male', name = 'Resident', distance = 2, entity = '11ULL'}}
    step(auto, 2)
    assert(last() == 'resident-male' and ids[#ids]['resident-male'] == '11ULL', 'the nearby body is published')
    -- Looking at another resident (same key, another body) moves the slot to that body.
    for _ = 1, 5 do auto.look('resident-male', '22ULL', 'Resident', 0.2) end
    step(auto, 0.5)
    assert(ids[#ids]['resident-male'] == '22ULL', 'the looked-at body wins: ' .. tostring(ids[#ids]['resident-male']))
    -- The talked-to body becomes the partner and its ID follows the conversation.
    distances['resident-female'] = 2
    step(auto, 0.1, {worldReady = true, blocked = false, talking = 'resident-female', talkingId = '33ULL'})
    assert(publishedPartners[#publishedPartners] == 'resident-female' and ids[#ids]['resident-female'] == '33ULL')
  `);
});

test('the default publisher writes the entity map beside the slots and partners', () => {
  assert.match(source, /"entities":\{' \.\. table\.concat\(ids, ','\) \.\. '\}\}'/);
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  // The talk keys hand the addressed NPC's entity to the composer hint, and the partner its ID.
  assert.match(init, /warmConversation\(participants, key, identity\)/);
  assert.match(init, /warmConversation\(participants, key, entity\)/);
  assert.match(init, /entity = participants == nil and type\(entity\) == 'string' and entity or nil/);
  assert.match(init, /talkingId = \(active and active\.entity\)/);
});

// ---- Spawned roster characters: a lane of their own beside the two slots (docs/SPAWNED_CHARACTERS.md) ----------
const spawnedFixture = `
  local spawnedLists = {}
  local function makeSpawned(extra)
    local options = {publish = function(list, partnerList, ids, spawnedList)
      published[#published + 1] = table.concat(list, ',')
      publishedPartners[#publishedPartners + 1] = table.concat(partnerList or {}, ',')
      spawnedLists[#spawnedLists + 1] = table.concat(spawnedList or {}, ',')
    end}
    for key, value in pairs(extra or {}) do options[key] = value end
    return make(options)
  end
  local function lastSpawned() return spawnedLists[#spawnedLists] end
`;

test('a spawned character is wanted on the first scan, takes no slot, and is published in its own list', () => {
  run(`${fixture}${spawnedFixture}
    nearby = {{key = 'judy', name = 'Judy', distance = 4, spawned = true}, {key = 'a', name = 'A', distance = 1}, {key = 'b', name = 'B', distance = 2}}
    local auto = makeSpawned()
    step(auto, 1.2)
    -- Spawned: at once, no stagger; the nearby ones keep their two slots and their stagger.
    assert(table.concat(auto.spawned(), ',') == 'judy', 'the spawned character was not wanted on the first scan')
    assert(table.concat(auto.active(), ',') == 'a', 'a slot was spent on the spawned one or the stagger was skipped')
    step(auto, 3.2)
    assert(table.concat(auto.active(), ',') == 'a,b' and lastSpawned() == 'judy' and last() == 'a,b', 'the lists differ: ' .. last() .. ' / ' .. lastSpawned())
    local seen = false
    for _, line in ipairs(logs) do if line == 'Auto-connect warming judy (spawned)' then seen = true end end
    assert(seen, 'the spawned start was not logged')
    local flagged = 0
    for _, row in ipairs(auto.inspect().active) do if row.spawned then flagged = flagged + 1 end end
    assert(flagged == 1)
  `);
});

test('at most three spawned characters at a time, and they leave with the same hold and cooldown rules (no age limit while wanted)', () => {
  run(`${fixture}${spawnedFixture}
    nearby = {}
    for _, key in ipairs({'s1', 's2', 's3', 's4'}) do nearby[#nearby + 1] = {key = key, name = key, distance = 2, spawned = true} end
    local auto = makeSpawned()
    step(auto, 3)
    assert(#auto.spawned() == 3 and #auto.active() == 0, 'the lane holds three, no slot')
    local first = table.concat(auto.spawned(), ',')
    step(auto, 30)
    assert(table.concat(auto.spawned(), ',') == first, 'a fourth replaced one that is still wanted')
    -- Three walk away: held 40 s, then released. The fourth, now wanted, takes a place once the cooldown allows.
    nearby = {{key = 's4', name = 's4', distance = 2, spawned = true}}
    step(auto, 38)
    assert(#auto.spawned() == 3, 'released before the hold ended')
    step(auto, 4)
    assert(table.concat(auto.spawned(), ',') == 's4', 'unwanted ones stayed warm or the fourth was not admitted: ' .. table.concat(auto.spawned(), ','))
    assert(lastSpawned() == 's4', 'published ' .. tostring(lastSpawned()))
    nearby = {}
    step(auto, 45)
    assert(#auto.spawned() == 0 and lastSpawned() == '' and last() == '')
  `);
  run(`${fixture}${spawnedFixture}
    nearby = {{key = 'old', name = 'Old', distance = 2, spawned = true}}
    local auto = makeSpawned()
    step(auto, 2)
    assert(#auto.spawned() == 1)
    -- No age limit while it is still wanted: the age release would close the connection (and make V wait) while the character
    -- still stands beside V. The lane is bounded by its cap of three and by the bridge's plan.
    step(auto, 700)
    assert(#auto.spawned() == 1 and auto.spawned()[1] == 'old', 'a spawned character that is still near was released for age')
    nearby = {}
    step(auto, 45)
    assert(#auto.spawned() == 0, 'it is still released once nobody wants it')
  `);
});

test('a talked-to spawned character leaves the lane for the partner role; a profile shared with the party is still listed', () => {
  run(`${fixture}${partnerFixture}${spawnedFixture}
    nearby = {{key = 'judy', name = 'Judy', distance = 2, spawned = true}, {key = 'panam', name = 'Panam', distance = 3, spawned = true}}
    local auto = makeSpawned({locate = locate})
    distances.judy = 2
    step(auto, 2)
    assert(table.concat(auto.spawned(), ',') == 'judy,panam')
    talk(auto, 'judy', 0.1)
    assert(partners(auto) == 'judy' and table.concat(auto.spawned(), ',') == 'panam', 'one owner per connection')
    assert(publishedPartners[#publishedPartners] == 'judy' and lastSpawned() == 'panam')
    -- A party member who is also spawned: nothing is skipped for the party (one page per profile on the bridge).
    party['kerry'] = true
    nearby = {{key = 'panam', name = 'Panam', distance = 3, spawned = true}, {key = 'kerry', name = 'Kerry', distance = 3, spawned = true}}
    step(auto, 3)
    assert(lastSpawned():find('kerry', 1, true), 'a party profile that is also spawned was not published: ' .. lastSpawned())
    -- Turning the setting off releases the lane and publishes it empty.
    setting = false
    step(auto, 2)
    assert(#auto.spawned() == 0 and lastSpawned() == '')
  `);
});

test('a looked-at spawned character is not double-counted and an ordinary nearby one never uses the lane', () => {
  run(`${fixture}${spawnedFixture}
    nearby = {{key = 'judy', name = 'Judy', distance = 2, spawned = true}, {key = 'a', name = 'A', distance = 1}}
    local auto = makeSpawned()
    for _ = 1, 5 do auto.look('judy', 'e1', 'Judy', 0.2) end
    step(auto, 2)
    local count = 0
    for _, key in ipairs(auto.active()) do if key == 'judy' then count = count + 1 end end
    for _, key in ipairs(auto.spawned()) do if key == 'judy' then count = count + 1 end end
    assert(count == 1, 'the same character was warmed twice: ' .. count)
    assert(not table.concat(auto.spawned(), ','):find('a', 1, true), 'an ordinary character took a spawned place')
  `);
});

test('the default publisher writes the spawned list and the scan marks spawned roster characters', () => {
  assert.match(source, /"spawned":\[' \.\. encode\(spawned\) \.\. '\]/);
  assert.match(source, /maxSpawned = 3/);
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  // The row carries the flag from the cached spawned-character policy: no new per-frame or per-entity work.
  assert.match(init, /convaiSpawnedPeople\.named\(key\)/);
  assert.match(init, /convaiWorldPolicy\.spawned\(entity\) == true/);
  assert.match(init, /spawned = spawned or nil/);
});

// ---- A released partner that is still a spawned character near V goes back to the spawned lane (2026-10-17 live bug) ----
// Live: Judy was warmed as spawned, V talked to her (partner), 180 s without an exchange released the partner role while she still
// stood beside V, and her connection closed; the next F6 had to prepare it again. Now she returns to the lane in the same write.
const lanePublications = `
  local everyPublication = {}
  local function makeLane(extra)
    local options = {publish = function(list, partnerList, ids, spawnedList)
      published[#published + 1] = table.concat(list, ',')
      publishedPartners[#publishedPartners + 1] = table.concat(partnerList or {}, ',')
      spawnedLists[#spawnedLists + 1] = table.concat(spawnedList or {}, ',')
      everyPublication[#everyPublication + 1] = {partners = partnerList or {}, spawned = spawnedList or {}}
    end}
    for key, value in pairs(extra or {}) do options[key] = value end
    return make(options)
  end
  -- Every publication since index 'from' lists the profile under partners or spawned (its connection is never dropped).
  local function alwaysListed(key, from)
    for index = from, #everyPublication do
      local row, found = everyPublication[index], false
      for _, list in ipairs({row.partners, row.spawned}) do for _, k in ipairs(list) do if k == key then found = true end end end
      if not found then return false, index end
    end
    return true
  end
`;

test('a partner released for no exchange goes back to the spawned lane with its connection open, never dropped from the lists', () => {
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    nearby = {{key = 'judy', name = 'Judy', distance = 1.7, spawned = true}}
    local auto = makeLane({locate = locate})
    distances.judy = 1.7
    step(auto, 2)
    assert(table.concat(auto.spawned(), ',') == 'judy')
    -- V talks to her: the partner role takes the place of the lane entry (one connection, one owner).
    talk(auto, 'judy', 0.1)
    assert(partners(auto) == 'judy' and #auto.spawned() == 0)
    local from = #everyPublication
    -- The talk ends; she keeps standing beside V and is still reported (the scan, or the remembered ID behind V).
    step(auto, 185)
    assert(partners(auto) == '' and table.concat(auto.spawned(), ',') == 'judy', 'she went back to the lane: ' .. partners(auto) .. '/' .. table.concat(auto.spawned(), ','))
    local ok, at = alwaysListed('judy', from + 1)
    assert(ok, 'the connection was dropped from both lists in publication ' .. tostring(at))
    assert(lastSpawned() == 'judy' and publishedPartners[#publishedPartners] == '')
    local seen, released = false, false
    for _, line in ipairs(logs) do
      if line == 'Auto-connect partner judy back to the spawned lane (no exchange)' then seen = true end
      if line:find('partner released judy', 1, true) then released = true end
    end
    assert(seen and not released, 'logged as a return, not a release')
    -- No cooldown: nothing was released, so she is not blocked from the lane, and she stays for as long as she is near.
    step(auto, 700)
    assert(table.concat(auto.spawned(), ',') == 'judy', 'she must not age out beside V')
    -- Talking to her again takes the partner role again, and a second return works the same way.
    talk(auto, 'judy', 0.1)
    assert(partners(auto) == 'judy')
    step(auto, 185)
    assert(table.concat(auto.spawned(), ',') == 'judy' and partners(auto) == '')
  `);
});

test('a partner that came from outside the lane (flagged by the adapter) returns too; one that is far, not spawned or without room is released as before', () => {
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    local spawnedKeys = {judy = true}
    local auto = makeLane({locate = locate, spawned = function(partner) return spawnedKeys[partner.key] == true end})
    nearby = {}
    -- Judy was never in the lane (the setting or the cap kept her out): V talks to her, she is a spawned partner.
    distances.judy = 3
    talk(auto, 'judy', 0.1)
    assert(partners(auto) == 'judy' and #auto.spawned() == 0)
    nearby = {{key = 'judy', name = 'Judy', distance = 3, spawned = true}}
    step(auto, 185)
    assert(partners(auto) == '' and table.concat(auto.spawned(), ',') == 'judy', 'the adapter said she is spawned: back to the lane')
    -- Far from V when the role ends: released, with the cooldown.
    distances.judy = 12
    talk(auto, 'judy', 0.1)
    step(auto, 185)
    assert(partners(auto) == '' and not table.concat(auto.spawned(), ','):find('judy', 1, true), 'too far from V: released, with the cooldown')
    -- A character that is not spawned never goes to the lane.
    distances.dex = 2
    talk(auto, 'dex', 0.1)
    step(auto, 185)
    assert(partners(auto) == '' and not table.concat(auto.spawned(), ','):find('dex', 1, true), 'an ordinary partner took a spawned place')
  `);
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    local auto = makeLane({locate = locate, spawned = function() return true end})
    nearby = {}
    for _, key in ipairs({'s1', 's2', 's3'}) do nearby[#nearby + 1] = {key = key, name = key, distance = 2, spawned = true}; distances[key] = 2 end
    step(auto, 2)
    assert(#auto.spawned() == 3)
    -- A fourth spawned character V talks to becomes a partner; with the lane full it cannot return and is released.
    distances.s4 = 2
    talk(auto, 's4', 0.1)
    assert(partners(auto) == 's4' and #auto.spawned() == 3)
    step(auto, 185)
    assert(partners(auto) == '' and #auto.spawned() == 3 and not table.concat(auto.spawned(), ','):find('s4', 1, true), 'the lane is capped at three')
    local released = false
    for _, line in ipairs(logs) do if line == 'Auto-connect partner released s4 (no exchange)' then released = true end end
    assert(released)
  `);
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    local auto = makeLane({locate = locate, spawned = function() return true end})
    nearby = {{key = 'judy', name = 'Judy', distance = 2, spawned = true}, {key = 'panam', name = 'Panam', distance = 3, spawned = true}}
    distances.judy, distances.panam = 2, 3
    step(auto, 2)
    local from = #everyPublication
    talk(auto, 'judy', 0.1)
    step(auto, 20)
    -- V talks to Panam: Judy has 30 s of grace, then she is "another partner" and returns to the lane.
    talk(auto, 'panam', 0.1)
    assert(partners(auto) == 'panam,judy')
    step(auto, 31)
    assert(partners(auto) == 'panam' and table.concat(auto.spawned(), ',') == 'judy', 'another partner: ' .. partners(auto) .. '/' .. table.concat(auto.spawned(), ','))
    assert(alwaysListed('judy', from + 1) and alwaysListed('panam', from + 1))
  `);
});

test('a character in the running group round has an exchange even when V addressed someone else', () => {
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    local round = nil
    local auto = makeLane({locate = locate, roundKeys = function() return round end})
    party.alex = true
    nearby = {{key = 'judy', name = 'Judy', distance = 2, spawned = true}}
    distances.judy = 2
    step(auto, 2)
    talk(auto, 'judy', 0.1)
    assert(partners(auto) == 'judy')
    -- A round addressed to Alex (a party member: never a partner) with Judy as another speaker, for five minutes.
    round = {'alex', 'judy'}
    for _ = 1, 300 do step(auto, 1, {worldReady = true, blocked = false, talking = 'alex'}) end
    assert(partners(auto) == 'judy', 'a group turn did not count as an exchange')
    -- The round ends: three minutes later the partner role ends and she goes back to the lane.
    round = nil
    step(auto, 185)
    assert(partners(auto) == '' and table.concat(auto.spawned(), ',') == 'judy')
  `);
  // Without the round keys the same five minutes release the partner (the old behaviour: only the addressed one counted).
  run(`${fixture}${partnerFixture}${spawnedFixture}${lanePublications}
    local auto = makeLane({locate = locate})
    party.alex = true
    distances.judy = 2
    talk(auto, 'judy', 0.1)
    for _ = 1, 200 do step(auto, 1, {worldReady = true, blocked = false, talking = 'alex'}) end
    assert(partners(auto) == '', 'without round keys only the addressed character counts')
  `);
});

test('wiring: the scan remembers spawned characters and adds the remembered ones within group range; round keys and the partner check are passed in', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(init, /convaiSpawnedRange = 8/);
  assert.match(init, /spawnedSeen\[#spawnedSeen \+ 1\] = \{id = entity:GetEntityID\(\), entity = id, key = key, name = name\}/);
  assert.match(init, /pcall\(service\.recall, service, player, convaiSpawnedRange, seen, function\(entry\)/);
  assert.match(init, /roundKeys = function\(\) return convaiRoundKeys\(\) end/);
  assert.match(init, /service\.knownBy\[partner\.id\] ~= nil/);
  // The scan is the once-a-second one: the new lookups sit inside scanNearbyCharacters, not in a per-frame callback.
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onUpdate'") + 400);
  assert.doesNotMatch(update, /recall|remember/);
  assert.match(source, /spawnedRadius = 8/);
  assert.match(source, /if entry\.spawned then age = 0 end/);
});
