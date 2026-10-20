import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {battleTrigger} from './battle-context.mjs';
import {PLACES} from './johnny-head.mjs';

// Johnny speaks up, step 2 (docs/JOHNNY_IN_YOUR_HEAD.md, "Places"): the place table, arrivals and per-place cooldowns of
// mod/johnny-remarks.lua, the district sample in init.lua (every PLACE_SECONDS on the 0.5 s battle sample, both settings on, the record
// resolved only when the district changes) and the bridge's words for an arrival.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/johnny-remarks.lua');
const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local R = (function() ${moduleSource} end)()
  local level = 'normal'
  local S = R.new({level = function() return level end})
${code}`);
// M.PLACES as plain data, serialised inside Lua (the module is the one source of the table).
function luaPlaces() {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const code = `local R = (function() ${moduleSource} end)()
    local function encode(value)
      if type(value) == 'table' then
        if #value > 0 then local out = {}; for _, item in ipairs(value) do out[#out + 1] = encode(item) end; return '[' .. table.concat(out, ',') .. ']' end
        local keys = {}; for key in pairs(value) do keys[#keys + 1] = key end; table.sort(keys)
        local out = {}; for _, key in ipairs(keys) do out[#out + 1] = string.format('%q:%s', key, encode(value[key])) end
        return '{' .. table.concat(out, ',') .. '}'
      end
      if type(value) == 'string' then return string.format('%q', value) end
      return tostring(value)
    end
    return encode(R.PLACES)`;
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const text = to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, text);
  return JSON.parse(text);
}
const research = JSON.parse(read('../research/cyberpunk/native-reviews/johnny-places-20261019.json'));

test('places: the most specific place on V\'s chain wins; an event carries only the key and the place\'s own cooldown', () => withModule(`
  assert(R.PLACE_SECONDS >= 5 and R.PLACE_SECONDS <= 10, 'every 5 to 10 s')
  assert(R.placeOf({'LittleChina_Afterlife', 'LittleChina', 'Watson'}).key == 'afterlife')
  assert(R.placeOf({'Coastview', 'Pacifica'}).key == 'pacifica', 'a district: any record under it')
  assert(R.placeOf({'Badlands_NorthSunriseOilField', 'Badlands'}).key == 'oil-field', 'the venue under a district wins over the district')
  assert(R.placeOf({'Badlands_RockyRidge', 'Badlands'}).key == 'badlands' and R.placeOf({'NorthBadlands'}).key == 'badlands' and R.placeOf({'SouthBadlands_Farm', 'SouthBadlands'}).key == 'badlands', 'the Badlands are three records')
  assert(R.placeOf({'Dogtown_Brooklyn'}).key == 'dogtown' and R.placeOf({'Dogtown_Akebono', 'Dogtown'}).key == 'dogtown', 'Dogtown is its own record, and so is Brooklyn')
  assert(R.placeOf({'CorpoPlaza_ArasakaTowerAtrium', 'CorpoPlaza', 'CityCenter'}).key == 'arasaka-tower' and R.placeOf({'CityCenter'}) == nil)
  assert(R.placeOf({'LittleChina', 'Watson'}) == nil and R.placeOf({}) == nil and R.placeOf(nil) == nil)
  local row = R.placeOf({'LittleChina_Afterlife', 'LittleChina', 'Watson'})
  local subject, facts, cooldown = R.placeEvent(row)
  assert(subject == 'place:afterlife' and facts.place == 'afterlife' and cooldown == row.cooldown and cooldown >= 3600)
  local n = 0; for _ in pairs(facts) do n = n + 1 end
  assert(n == 1, 'nothing but the key travels')
  assert(R.placeEvent({key = 'afterlife', districts = {'Somewhere'}}) == nil, 'only a row of the table')
  assert(R.placeEvent(nil) == nil)
  for _, place in ipairs(R.PLACES) do
    assert(place.key:match('^[a-z-]+$') and #place.districts > 0 and place.cooldown >= 3 * 3600 and place.cooldown <= 8 * 3600, place.key)
    assert(type(place.vehicle) == 'boolean', place.key .. ' says whether driving in counts')
  end
`));

test('arrivals: the first reading of a world is a baseline, a place counts after two readings in a row, leaving and coming back counts again', () => withModule(`
  local T = R.placeTracker()
  local afterlife, street, pacifica = {'LittleChina_Afterlife', 'LittleChina', 'Watson'}, {'LittleChina', 'Watson'}, {'Coastview', 'Pacifica'}
  assert(T:observe(afterlife) == nil, 'V was already there when the world loaded')
  assert(T:observe(afterlife) == nil)
  assert(T:observe(street) == nil and T:observe(street) == nil, 'leaving is not an arrival')
  assert(T:observe(pacifica) == nil, 'one reading is a district edge crossed for a moment')
  assert(T:observe(street) == nil, 'and it was')
  assert(T:observe(pacifica) == nil)
  local row = T:observe(pacifica)
  assert(row and row.key == 'pacifica', 'two readings in a row')
  assert(T:observe(pacifica) == nil, 'once per arrival')
  T:observe(street); T:observe(street)
  T:observe(afterlife)
  assert(T:observe(afterlife).key == 'afterlife', 'back again: the cooldown, not the tracker, decides')
  T:reset()
  assert(T:observe(pacifica) == nil and T:observe(pacifica) == nil, 'a save load: a new baseline')
`));

test('arrivals: an estate or an interior does not count while V is in a vehicle; the first reading on foot is the arrival; open districts count either way', () => withModule(`
  local T = R.placeTracker()
  local kerry, street, pacifica = {'NorthOaks_Kerry_Estate', 'NorthOaks', 'Westbrook'}, {'Westbrook'}, {'Coastview', 'Pacifica'}
  assert(T:observe(street, true) == nil)
  assert(T:observe(kerry, true) == nil and T:observe(kerry, true) == nil and T:observe(kerry, true) == nil, 'driving past the gate is not arriving')
  assert(T:observe(kerry, false) == nil, 'one reading on foot')
  assert(T:observe(kerry, false).key == 'kerry-estate', 'two on foot: arrived')
  assert(T:observe(kerry, true) == nil and T:observe(kerry, true) == nil, 'getting into a car there is leaving')
  assert(T:observe(street, true) == nil and T:observe(street, false) == nil)
  assert(T:observe(pacifica, true) == nil, 'one reading')
  assert(T:observe(pacifica, true).key == 'pacifica', 'a district V drives into counts')
`));

test('alt: the second note needs every fact set and every journal entry succeeded; a failed or missing read is not met', () => withModule(`
  local function place(key) for _, row in ipairs(R.PLACES) do if row.key == key then return row end end end
  local facts, journal = {}, {}
  local function readFact(name) return facts[name] end
  local function readJournal(path, class) assert(type(path) == 'string' and class:match('^gameJournal')); return journal[path] end
  local afterlife, tower, kerry = place('afterlife'), place('arasaka-tower'), place('kerry-estate')
  assert(R.altMet(afterlife, readFact, readJournal) == false, 'nothing set')
  facts.q103_rogue_paid_up = 1
  assert(R.altMet(afterlife, readFact, readJournal) == false, 'both facts are needed')
  facts.q103_rogue_done = 1
  assert(R.altMet(afterlife, readFact, readJournal) == true)
  facts.q101_rogue_moved_to_heli = 1
  assert(R.altMet(tower, readFact, readJournal) == false, 'a fact is not enough where the rule also needs the journal')
  journal['quests/main_quest/act_01/q101_01_firestorm'] = 'other'
  assert(R.altMet(tower, readFact, readJournal) == false, 'an entry that is not succeeded')
  journal['quests/main_quest/act_01/q101_01_firestorm'] = 'succeeded'
  assert(R.altMet(tower, readFact, readJournal) == true)
  journal['quests/side_quest/sq011_kerry'] = 'succeeded'
  assert(R.altMet(kerry, readFact, readJournal) == true, 'a journal-only gate')
  assert(R.altMet(place('pacifica'), readFact, readJournal) == false and R.altMet(nil, readFact, readJournal) == false, 'a row without alt: never')
  assert(R.altMet(afterlife, function() error('no answer') end, readJournal) == false, 'a read that throws is not met')
  assert(R.altMet(afterlife, function() return 0/0 end, readJournal) == false and R.altMet(afterlife, function() return '1' end, readJournal) == false)
  assert(R.altMet(kerry, readFact, function() error('no answer') end) == false)
`));

test('cooldowns: a place keeps its own (hours), other subjects keep the hour; a place nobody heard stays cooled down', () => withModule(`
  local row = R.placeOf({'Coastview', 'Pacifica'})
  local subject, facts, cooldown = R.placeEvent(row)
  assert(S:note('place', subject, facts, 1000, cooldown))
  local entry = assert(S:offer(1010), 'ten seconds after the arrival')
  S:claim(entry, 1010)
  assert(S:note('place', subject, facts, 1010 + 3601, cooldown) == false, 'an hour is not enough for a place')
  assert(S:note('place', subject, facts, 1010 + cooldown + 1, cooldown), 'its own cooldown is')
  assert(S:offer(1010 + cooldown + 1 + R.TTL.place + 1) == nil and not S:pending(), 'an arrival waits at most TTL.place')
  assert(S:note('quest', 'quest:1', {title = 'Q'}, 5000))
  local quest = S:offer(5010); S:claim(quest, 5010)
  assert(S:note('quest', 'quest:1', {title = 'Q'}, 5010 + 3601), 'a job keeps the hour')
`));

test('district sample: nothing while either setting is off; every PLACE_SECONDS one id read; the record resolved only on a change', () => {
  const block = between('function convaiJohnnyRemarksService()', '-- The one rule for characters the game placed');
  run(`
    local inHead, level, clock, reads, records, noted = false, 'off', 0, 0, 0, {}
    local district = {hash = 1, length = 20}
    local names = {[1] = {'LittleChina_Afterlife', 'LittleChina', 'Watson'}, [2] = {'LittleChina', 'Watson'}, [3] = {'Coastview', 'Pacifica'}}
    manager = {johnnyInHead = function() return inHead end, johnnyRemarks = function() return level end}
    os.clock = function() return clock end
    local real = (function() ${moduleSource} end)()
    local watch = {enable = function() end, disable = function() end, reset = function() end}
    function dofile(path) if path == 'johnny-relic.lua' then return {new = function() return watch end} end return real end
    print = function() end
    convaiLogLine = function(line) noted[#noted + 1] = line end
    local function nameString(value) return value end
    Game = {GetScriptableSystemsContainer = function() return {Get = function(_, name)
      assert(name == 'PreventionSystem')
      return {GetCurrentDistrict = function() reads = reads + 1; return {GetDistrictID = function() return district end} end}
    end} end}
    local function record(chain, index)
      if not chain[index] then return nil end
      return {EnumName = function() return chain[index] end, ParentDistrict = function() return record(chain, index + 1) end}
    end
    TweakDBInterface = {GetDistrictRecord = function(id) records = records + 1; return record(names[id.hash], 1) end}
    ${block}
    local function step(seconds) clock = clock + seconds; convaiJohnnyPlaceSample(true) end
    step(0.5); step(10)
    assert(reads == 0 and records == 0 and convaiJohnnyRemarks == nil, 'off: no native call, nothing loaded')
    inHead, level = true, 'normal'
    step(0.5)
    assert(reads == 0, 'the settings too are looked at only every PLACE_SECONDS')
    step(real.PLACE_SECONDS)
    assert(reads == 1 and records == 1, 'the first reading')
    step(0.5); step(0.5)
    assert(reads == 1, 'not again before PLACE_SECONDS')
    step(real.PLACE_SECONDS)
    assert(reads == 2 and records == 1, 'the same district: no record walk')
    district = {hash = 3, length = 20}
    step(real.PLACE_SECONDS); step(real.PLACE_SECONDS)
    assert(reads == 4 and records == 2, 'a change: one record walk')
    assert(#convaiJohnnyRemarks.queue == 1 and convaiJohnnyRemarks.queue[1].subject == 'place:pacifica')
    assert(noted[1] == 'Johnny speaks up: noted place:pacifica')
    convaiJohnnyPlaceSample(false); clock = clock + 100; convaiJohnnyPlaceSample(false)
    assert(reads == 4, 'nothing while the world is not ready')
    convaiJohnnyPlaceReset()
    district = {hash = 1, length = 20}
    step(real.PLACE_SECONDS); step(real.PLACE_SECONDS); step(real.PLACE_SECONDS)
    assert(#convaiJohnnyRemarks.queue == 1, 'after a load the first reading is a baseline')
    level = 'off'
    step(real.PLACE_SECONDS)
    assert(reads == 7, 'switched off: no read')
  `);
});

test('noting a place: alt is set only when the game answers yes to every fact and journal entry of the row', () => {
  const block = between('function convaiJohnnyRemarksService()', '-- Places (Johnny speaks up, step 2)');
  run(`
    local inHead, level, facts, journal, asked = true, 'normal', {}, {}, {facts = 0, journal = 0}
    manager = {johnnyInHead = function() return inHead end, johnnyRemarks = function() return level end}
    local real = (function() ${moduleSource} end)()
    function dofile(path) return real end
    print = function() end
    convaiLogLine = function() end
    Enum = {new = function(kind, name) return kind .. ':' .. name end}
    Game = {
      GetQuestsSystem = function() return {GetFactStr = function(_, name) asked.facts = asked.facts + 1; return facts[name] end} end,
      GetJournalManager = function() return {
        GetEntryByString = function(_, path, class) asked.journal = asked.journal + 1; return journal[path] and {state = journal[path], IsA = function(_, c) return c == class end} or nil end,
        GetEntryState = function(_, entry) return entry.state end}
      end}
    ${block}
    local function row(key) for _, r in ipairs(real.PLACES) do if r.key == key then return r end end end
    local function noted(key)
      convaiJohnnyRemarksService(); convaiJohnnyRemarks.queue = {}; convaiJohnnyRemarks.subjects = {}
      convaiJohnnyRemarkNote('place', row(key))
      return convaiJohnnyRemarks.queue[1]
    end
    local entry = noted('totentanz')
    assert(entry and entry.facts.place == 'totentanz' and entry.facts.alt == nil, 'nothing succeeded: the plain event')
    journal['quests/side_quest/sq011_johnny/04_nancy'] = 'Active'
    assert(noted('totentanz').facts.alt == nil, 'active is not succeeded')
    journal['quests/side_quest/sq011_johnny/04_nancy'] = Enum.new('gameJournalEntryState', 'Succeeded')
    assert(noted('totentanz').facts.alt == true, 'succeeded')
    assert(noted('totentanz').cooldown == row('totentanz').cooldown)
    asked.facts, asked.journal = 0, 0
    assert(noted('pacifica').facts.alt == nil and asked.facts == 0 and asked.journal == 0, 'a place with no second note reads nothing')
    facts.q103_rogue_paid_up = 1
    assert(noted('afterlife').facts.alt == nil, 'one fact of two')
    facts.q103_rogue_done = 1
    assert(noted('afterlife').facts.alt == true)
    local n = 0; for _ in pairs(noted('afterlife').facts) do n = n + 1 end
    assert(n == 2, 'the key and alt')
    Game.GetQuestsSystem = function() error('the game cannot answer') end
    assert(noted('afterlife').facts.alt == nil, 'a read that fails: the plain event, the remark still happens')
    level = 'off'
    convaiJohnnyRemarks.queue = {}
    convaiJohnnyRemarkNote('place', row('afterlife'))
    assert(#convaiJohnnyRemarks.queue == 0, 'off: nothing noted')
  `);
});

test('guard: a fault in an optional Johnny feature on the battle sample is logged once and never reaches updateBattles', () => {
  const block = between('function convaiJohnnyGuarded(', '-- One event from a collector');
  run(`
    local logged = {}
    convaiLogLine = function(line) logged[#logged + 1] = line end
    ${block}
    local seen = {}
    convaiJohnnyGuarded('place sample', function(a, b) seen[#seen + 1] = a .. b end, 'x', 'y')
    assert(seen[1] == 'xy' and #logged == 0, 'arguments are passed through, nothing logged on success')
    convaiJohnnyGuarded('place sample', function() error('boom') end)
    convaiJohnnyGuarded('place sample', function() error('boom again') end)
    assert(#logged == 1 and logged[1]:find('Johnny place sample failed', 1, true) and logged[1]:find('boom', 1, true), 'logged once per feature')
    convaiJohnnyGuarded('fight watch', function() error('other') end)
    assert(#logged == 2 and not logged[1]:find('update failed', 1, true) and not logged[1]:find('observation skipped', 1, true))
    convaiLogLine = nil
    convaiJohnnyGuarded('relic', function() error('no logger') end)
  `);
  const battles = between('local function updateBattles(player, elapsed, worldReady)', 'local now = os.time()');
  for (const call of ['convaiJohnnyPlaceSample', 'convaiJohnnyFightSample']) {
    assert.ok(new RegExp(`convaiJohnnyGuarded\\('[a-z ]+', ${call},`).test(battles), `${call} runs guarded`);
  }
  assert.doesNotMatch(battles, /(?<!convaiJohnnyGuarded\('[a-z ]+', )convaiJohnnyPlaceSample\(|convaiJohnnyFightSample\(/);
});

test('wiring: the sample rides the 0.5 s battle sample, a load resets it, and the Johnny functions above log use convaiLogLine', () => {
  const battles = between('local function updateBattles(player, elapsed, worldReady)', 'local now = os.time()');
  assert.match(battles, /if not battleSample or battlePoll >= 0\.5 then[\s\S]*if convaiJohnnyPlaceSample then convaiJohnnyGuarded\('place sample', convaiJohnnyPlaceSample, worldReady, battleSample\.vehicle == true\) end/);
  assert.match(init, /if convaiJohnnyRemarks then convaiJohnnyRemarks:reset\(\) end\s+if convaiJohnnyPlaceReset then convaiJohnnyPlaceReset\(\) end/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiJohnnyPlace|GetCurrentDistrict/);
  // A bare log above `local function log` is an undefined global in CET: it threw after every note in step 1.
  const above = init.slice(init.indexOf('function convaiJohnnyHeadService()'), init.indexOf('local function log(line)'));
  assert.doesNotMatch(above.replace(/convaiLogLine\(/g, ''), /(?<![\w.:])log\(/);
  assert.match(init, /microphone\.log = log\s+-- [^\n]*\s+convaiLogLine = log/);
});

test('the Lua table, the bridge table and the research file say the same about every place', () => {
  const lua = luaPlaces();
  assert.equal(lua.length, research.places.length);
  assert.deepEqual(lua.map(p => p.key), research.places.map(p => p.key), 'same places, same order');
  assert.deepEqual(Object.keys(PLACES).sort(), lua.map(p => p.key).sort());
  for (const row of lua) {
    const file = research.places.find(p => p.key === row.key), bridge = PLACES[row.key];
    assert.deepEqual(row.districts, file.districts, `${row.key}: districts`);
    assert.equal(row.cooldown, file.cooldownSeconds, `${row.key}: cooldown`);
    assert.equal(row.vehicle, file.vehicle, `${row.key}: vehicle`);
    assert.equal(bridge.phrase, file.phrase, `${row.key}: phrase`);
    assert.equal(bridge.note, file.note, `${row.key}: note`);
    assert.equal(bridge.gate, file.gate === 'none' ? null : file.gate, `${row.key}: gate`);
    assert.equal(bridge.altNote, file.altNote, `${row.key}: altNote`);
    // The second note exists exactly where the Lua reads something for it, and reads exactly what the research lists.
    assert.equal(Boolean(row.alt), Boolean(file.altNote), `${row.key}: alt gate and altNote go together`);
    if (row.alt) {
      assert.deepEqual(row.alt.facts ?? [], (file.altGate.facts ?? []).map(f => f.name), `${row.key}: alt facts`);
      assert.deepEqual((row.alt.journal ?? []).map(j => [j.path, j.class]), (file.altGate.journal ?? []).map(j => [j.path, j.class]), `${row.key}: alt journal`);
      for (const fact of file.altGate.facts ?? []) assert.match(fact.test, /^(>= 1|== 1)$/, `${row.key}: the Lua reads >= 1`);
      for (const entry of file.altGate.journal ?? []) assert.equal(entry.state, 'succeeded');
    }
    assert.match(bridge.phrase, /^[A-Za-z][\w ,.'-]{2,80}$/, row.key);
    for (const text of [bridge.note, bridge.altNote].filter(Boolean)) {
      assert.ok(text.length <= 260 && !/[<>{}\n]/.test(text), `${row.key}: a plain sentence or two`);
    }
    assert.ok(bridge.gate === null || ['alt', 'bender', 'porsche', 'second-chance', 'rogue-date', 'reunion'].includes(bridge.gate), row.key);
    assert.ok(row.districts.every(name => /^[A-Za-z0-9_]+$/.test(name)));
  }
  const names = lua.flatMap(p => p.districts);
  assert.equal(new Set(names).size, names.length, 'a district record belongs to one place');
});

const base = {requestId: '1-2-33ULL', generation: 2, entity: '33ULL', name: 'Johnny Silverhand', bodyType: '', profileKey: 'johnny-silverhand',
  text: 'Johnny speaks up unprompted. Give one brief in-character remark.', head: {version: 1, stage: 'grudging', milestones: []}};
const remark = (facts, over = {}) => parseInput(JSON.stringify({...base, ...over,
  reaction: {kind: 'head', event: 'place', facts, expiresAt: Date.now() + 60000}}));

test('bridge: an arrival carries a known place key (and alt only where a second note exists); the trigger names the place and adds the note its gate and alt allow', () => {
  const key = Object.keys(PLACES)[0];
  assert.deepEqual(remark({place: key}).reaction.facts, {place: key});
  for (const bad of [{}, {place: 'nowhere'}, {place: 7}, {place: '__proto__'}, {place: null}]) assert.equal(remark(bad), null, JSON.stringify(bad));
  const text = battleTrigger(remark({place: key}));
  assert.ok(text.includes(`V has just arrived in ${PLACES[key].phrase}.`), text);
  assert.match(text, /no more than 25 words/);
  assert.match(text, /do not invent/);
  // Every place gets only its own words: the name, the note when the gate is met, the second note when alt is set.
  const eventOf = trigger => trigger.slice(trigger.indexOf('V has just arrived'), Math.min(...[' Where you and V stand', ' Speak up on your own'].map(m => trigger.indexOf(m)).filter(i => i > 0)));
  for (const [pkey, place] of Object.entries(PLACES)) {
    const plain = battleTrigger(remark({place: pkey}));
    const gated = battleTrigger(remark({place: pkey}, {head: {...base.head, milestones: place.gate ? [place.gate] : []}}));
    assert.ok(plain.includes(`V has just arrived in ${place.phrase}.`), pkey);
    if (place.note && !place.gate) assert.ok(plain.includes(place.note), `${pkey}: an open note is always said`);
    if (place.note && place.gate) {
      assert.ok(!plain.includes(place.note), `${pkey}: gate not met, no note`);
      assert.ok(gated.includes(place.note), `${pkey}: gate met`);
    }
    if (!place.note) assert.ok(eventOf(plain).startsWith(`V has just arrived in ${place.phrase}.`) && !eventOf(plain).includes('You '), `${pkey}: the name alone`);
    const alt = remark({place: pkey, alt: true});
    if (place.altNote) {
      assert.deepEqual(alt.reaction.facts, {place: pkey, alt: true});
      const said = battleTrigger(alt);
      assert.ok(said.includes(place.altNote), `${pkey}: the second note`);
      if (place.note) assert.ok(!said.includes(place.note), `${pkey}: instead of the first`);
    } else {
      assert.deepEqual(alt.reaction.facts, {place: pkey}, `${pkey}: no second note, so alt is dropped`);
    }
    for (const junk of [1, 'true', {}, null]) assert.deepEqual(remark({place: pkey, alt: junk}).reaction.facts, {place: pkey}, `${pkey}: alt must be the boolean true`);
  }
});
