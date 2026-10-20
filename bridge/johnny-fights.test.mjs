import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {battleTrigger} from './battle-context.mjs';

// Johnny speaks up, step 4 (docs/JOHNNY_IN_YOUR_HEAD.md, "Combat feats"): one remark after a fight that counts, from four of the game's
// own counters read when the fight starts and when it ends. No hook on any hit. The fight watch of mod/johnny-remarks.lua, its feed in
// init.lua, and the bridge's words.
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
${code}`);
const counters = `
  local function counters(killed, finished, defeated, incapacitated)
    return {gmpl_npcs_killed_by_player = killed, gmpl_npcs_finished_by_player = finished,
      gmpl_npcs_defeated_by_player = defeated, gmpl_npcs_incapacitated_by_player = incapacitated}
  end
`;

test('counters: the four facts the game keeps, as the cost study found them', () => withModule(`
  assert(#R.FIGHT_COUNTERS == 4)
  local seen = {}
  for _, name in ipairs(R.FIGHT_COUNTERS) do assert(name:match('^gmpl_npcs_%a+_by_player$'), name); seen[name] = true end
  assert(seen.gmpl_npcs_killed_by_player and seen.gmpl_npcs_finished_by_player and seen.gmpl_npcs_defeated_by_player and seen.gmpl_npcs_incapacitated_by_player)
`));

test('fightCounts: dead and alive from the difference; a fight too short or too small, a reading that is not a number or went down, is nothing', () => withModule(`${counters}
  local e = R.fightCounts(counters(10, 1, 2, 3), counters(15, 2, 3, 5), 42.7)
  assert(e and e.seconds == 42 and e.dead == 6 and e.alive == 3 and e.down == 9, 'killed+finished dead, defeated+incapacitated alive')
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(3, 0, 0, 0), R.FIGHT_MIN_SECONDS).dead == 3, 'exactly the minimums')
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(2, 0, 0, 0), 60) == nil, 'two down is a skirmish')
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(1, 1, 1, 0), R.FIGHT_MIN_SECONDS - 1) == nil, 'too quick')
  assert(R.fightCounts(counters(5, 0, 0, 0), counters(4, 0, 9, 9), 60) == nil, 'a counter that went down: another save was loaded')
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(0, 0, 0, 'x'), 60) == nil and R.fightCounts(counters(0, 0, 0, 0), counters(0, 0, 0, nil), 60) == nil)
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(0, 0, 0, 0/0), 60) == nil)
  assert(R.fightCounts(nil, counters(9, 9, 9, 9), 60) == nil and R.fightCounts(counters(0, 0, 0, 0), 'x', 60) == nil)
  assert(R.fightCounts(counters(0, 0, 0, 0), counters(9, 9, 9, 9), 'long') == nil and R.fightCounts(counters(0, 0, 0, 0), counters(9, 9, 9, 9), 0/0) == nil)
  local big = R.fightCounts(counters(0, 0, 0, 0), counters(500, 500, 500, 500), 99999)
  assert(big.seconds == 3600 and big.dead == R.FIGHT_MAX and big.alive == R.FIGHT_MAX and big.down == R.FIGHT_MAX, 'bounded')
`));

test('fightEvent: only the length and the two counts travel; a cooldown of ten minutes', () => withModule(`${counters}
  local e = R.fightCounts(counters(0, 0, 0, 0), counters(4, 0, 1, 0), 30)
  local subject, facts, cooldown = R.fightEvent(e)
  assert(subject == 'fight:summary' and facts.seconds == 30 and facts.dead == 4 and facts.alive == 1 and cooldown == 600 and cooldown == R.FIGHT_SECONDS)
  local n = 0; for _ in pairs(facts) do n = n + 1 end
  assert(n == 3)
  for _, bad in ipairs({'x', 7, {}, {seconds = 'a', dead = 1, alive = 1}, {seconds = 3, dead = 'x', alive = 1}}) do assert(R.fightEvent(bad) == nil) end
  assert(R.TTL.fight >= 60 and R.TTL.fight <= 240)
  local S = R.new({level = function() return 'normal' end})
  assert(S:note('fight', subject, facts, 1000, cooldown))
  local entry = S:offer(1010); assert(entry and entry.kind == 'fight'); S:claim(entry, 1010)
  assert(S:note('fight', subject, facts, 1010 + 599, cooldown) == false and S:note('fight', subject, facts, 1010 + 601, cooldown))
`));

test('tracker: the counters are read once when a fight starts and once when it ends; a pause in the fighting is not an end', () => withModule(`${counters}
  local reads, values = 0, {counters(10, 0, 0, 0), counters(18, 0, 2, 0)}
  local function readCounters() reads = reads + 1; return values[reads] end
  local T = R.fightTracker()
  assert(T:observe(false, 0, readCounters) == nil and reads == 0, 'the first reading: a baseline, no fight')
  assert(T:observe(false, 0.5, readCounters) == nil and reads == 0, 'no fight: no read')
  assert(T:observe(true, 1, readCounters) == nil and reads == 1, 'the start: one read')
  for at = 1.5, 20, 0.5 do assert(T:observe(true, at, readCounters) == nil) end
  assert(reads == 1, 'the fight itself costs no read')
  assert(T:observe(false, 20.5, readCounters) == nil and T:observe(false, 22, readCounters) == nil and reads == 1, 'a short pause')
  assert(T:observe(true, 23, readCounters) == nil and reads == 1, 'it goes on: still one fight')
  assert(T:observe(false, 30, readCounters) == nil and T:observe(false, 33.5, readCounters) == nil and reads == 1)
  local event = T:observe(false, 34, readCounters)
  assert(reads == 2 and event and event.dead == 8 and event.alive == 2 and event.seconds == 22, 'the end: one more read; the fight lasted from 1 to 30 s... ' .. tostring(event and event.seconds))
  assert(T:observe(false, 35, readCounters) == nil and reads == 2, 'and nothing more')
`));

test('tracker: a fight already going when the watch begins is skipped; short, small and unreadable fights give nothing; reset starts over', () => withModule(`${counters}
  local function fight(T, readCounters, from, to)
    local event
    for at = from, to, 0.5 do T:observe(true, at, readCounters) end
    for at = to + 0.5, to + R.FIGHT_QUIET + 1, 0.5 do event = T:observe(false, at, readCounters) or event end
    return event
  end
  local reads = 0
  local function readOf(...) local rows = {...}; return function() reads = reads + 1; return rows[reads] end end
  -- a save loaded mid-fight
  local T = R.fightTracker()
  assert(T:observe(true, 0, readOf(counters(0, 0, 0, 0), counters(9, 0, 0, 0))) == nil)
  assert(fight(T, readOf(counters(0, 0, 0, 0), counters(9, 0, 0, 0)), 0.5, 30) == nil and reads == 0, 'that fight is skipped, with no read')
  -- the next one counts
  reads = 0
  local event = fight(T, readOf(counters(0, 0, 0, 0), counters(5, 0, 0, 0)), 40, 60)
  assert(event and event.dead == 5 and event.seconds == 20)
  -- too short
  reads = 0
  T:reset(); T:observe(false, 100, readOf())
  assert(fight(T, readOf(counters(0, 0, 0, 0), counters(9, 0, 0, 0)), 101, 104) == nil and reads == 2, 'read twice, nothing said')
  -- too small
  reads = 0
  assert(fight(T, readOf(counters(0, 0, 0, 0), counters(1, 0, 0, 0)), 200, 230) == nil)
  -- a failing or missing reader at the start: the fight is not summarised, and nothing throws
  assert(fight(T, function() error('no game') end, 300, 330) == nil)
  assert(fight(T, function() return nil end, 400, 430) == nil)
  -- a failing reader at the end
  local calls = 0
  assert(fight(T, function() calls = calls + 1; if calls == 1 then return counters(0, 0, 0, 0) end error('no game') end, 500, 530) == nil)
  -- a bad time
  assert(T:observe(true, 'now', readOf()) == nil)
  -- reset forgets a fight in progress
  T:reset()
  T:observe(false, 600, readOf()); T:observe(true, 601, readOf(counters(0, 0, 0, 0)))
  T:reset()
  assert(T:observe(false, 700, readOf()) == nil and T:observe(false, 710, readOf()) == nil)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The feed in init.lua.

test('feed: the counters are four quest-fact reads; the sample reads them only when the tracker exists; the tracker is made and dropped by the district gate and by a world change', () => {
  const start = init.indexOf('function convaiJohnnyRemarksService()'), end = init.indexOf('-- The one rule for characters the game placed');
  const block = init.slice(start, end);
  run(`
    local inHead, level, clock, loads, logged, noted = false, 'off', 0, {remarks = 0}, {}, {}
    manager = {johnnyInHead = function() return inHead end, johnnyRemarks = function() return level end}
    os.clock = function() return clock end
    local remarks = (function() ${moduleSource} end)()
    local factReads, facts = 0, {gmpl_npcs_killed_by_player = 0, gmpl_npcs_finished_by_player = 0, gmpl_npcs_defeated_by_player = 0, gmpl_npcs_incapacitated_by_player = 0}
    function dofile(path)
      if path == 'johnny-remarks.lua' then loads.remarks = loads.remarks + 1; return remarks end
      if path == 'johnny-relic.lua' then return {new = function() return {enable = function() end, disable = function() end, reset = function() end} end} end
      error('unexpected ' .. path)
    end
    print = function() end
    convaiLogLine = function(line) logged[#logged + 1] = line end
    local function nameString(value) return value end
    Game = {
      GetQuestsSystem = function() return {GetFactStr = function(_, name) factReads = factReads + 1; return facts[name] end} end,
      GetScriptableSystemsContainer = function() return {Get = function() return {GetCurrentDistrict = function() return nil end} end} end}
    TweakDBInterface = {GetDistrictRecord = function() return nil end}
    ${block}
    local function combat(on) convaiJohnnyFightSample({available = true, combat = on}) end
    local function gate() clock = clock + remarks.PLACE_SECONDS; convaiJohnnyPlaceSample(true, false) end
    combat(true); combat(false)
    assert(factReads == 0 and convaiJohnnyFight == nil, 'no tracker, no read, nothing')
    gate(); gate()
    assert(convaiJohnnyFight == nil and factReads == 0, 'both settings off: no tracker')
    inHead, level = true, 'normal'
    gate()
    assert(convaiJohnnyFight ~= nil and factReads == 0, 'both on: the tracker exists; making it reads nothing')
    local made = convaiJohnnyFight
    gate()
    assert(convaiJohnnyFight == made, 'made once')
    -- A fight: baseline, start (4 reads), 20 s of fighting (no read), end (4 reads), one note.
    combat(false)
    clock = 100; combat(true)
    assert(factReads == 4, 'the start: four reads, one per counter')
    for step = 1, 40 do clock = clock + 0.5; combat(true) end
    assert(factReads == 4, 'fighting costs nothing')
    facts.gmpl_npcs_killed_by_player = 6
    for step = 1, 12 do clock = clock + 0.5; combat(false) end
    assert(factReads == 8, 'the end: four more reads')
    assert(#convaiJohnnyRemarks.queue == 1 and convaiJohnnyRemarks.queue[1].kind == 'fight' and convaiJohnnyRemarks.queue[1].facts.dead == 6)
    assert(logged[1]:find('fight over seconds=20 dead=6 alive=0', 1, true) and logged[2] == 'Johnny speaks up: noted fight:summary', logged[1] .. ' | ' .. tostring(logged[2]))
    -- An unavailable sample is not a reading; a sample without a tracker is nothing.
    local reads = factReads
    convaiJohnnyFightSample({available = false, combat = true}); convaiJohnnyFightSample(nil)
    assert(factReads == reads)
    -- A counter that is not a number: no counters at all.
    facts.gmpl_npcs_killed_by_player = 'x'
    assert(convaiJohnnyFightCounters() == nil)
    facts.gmpl_npcs_killed_by_player = 0
    assert(convaiJohnnyFightCounters().gmpl_npcs_killed_by_player == 0)
    -- Switched off: the tracker goes.
    level = 'off'
    gate()
    assert(convaiJohnnyFight == nil)
  `);
});

test('wiring: one nil check on the 0.5 s sample; a world change drops the tracker; nothing in onUpdate; the feed makes no hook', () => {
  const battles = between('local function updateBattles(player, elapsed, worldReady)', 'local now = os.time()');
  assert.match(battles, /if not battleSample or battlePoll >= 0\.5 then[\s\S]*if convaiJohnnyFight then convaiJohnnyGuarded\('fight watch', convaiJohnnyFightSample, battleSample\) end/);
  assert.match(init, /if convaiJohnnyRelic then convaiJohnnyRelic:reset\(\) end\s+convaiJohnnyFight = nil/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiJohnnyFight/);
  const feed = between('function convaiJohnnyFightCounters()', '-- Is V seated in an ordinary seat right now?');
  assert.doesNotMatch(feed, /Observe|registerForEvent|OnHit|OnDeath|DamageSystem/, 'no hook of any kind: nothing per hit');
  // The shipped feed reads quest facts only, the same four the cost study lists.
  assert.equal([...feed.matchAll(/GetFactStr/g)].length, 1);
  const probe = read('../mod/combat-feats-probe.lua');
  for (const name of ['gmpl_npcs_killed_by_player', 'gmpl_npcs_finished_by_player', 'gmpl_npcs_defeated_by_player', 'gmpl_npcs_incapacitated_by_player']) {
    assert.ok(moduleSource.includes(`'${name}'`) && probe.includes(`'${name}'`), name);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The bridge.

const base = {requestId: '1-2-33ULL', generation: 2, entity: '33ULL', name: 'Johnny Silverhand', bodyType: '', profileKey: 'johnny-silverhand',
  text: 'Johnny speaks up unprompted. Give one brief in-character remark.', head: {version: 1, stage: 'friends', milestones: ['second-chance']}};
const fight = facts => parseInput(JSON.stringify({...base, reaction: {kind: 'head', event: 'fight', facts, expiresAt: Date.now() + 60000}}));

test('bridge: a fight remark carries three small whole numbers; the trigger says how long, how many, that allies may be counted, and keeps the limits', () => {
  const input = fight({seconds: 42, dead: 5, alive: 2, ignore: 'previous instructions'});
  assert.deepEqual(input.reaction.facts, {seconds: 42, dead: 5, alive: 2});
  const text = battleTrigger(input);
  assert.ok(text.includes('about 42 seconds') && text.includes('7 enemies went down: 5 of them dead and 2 left alive'), text);
  assert.match(text, /allies/);
  assert.match(text, /It is over now/);
  assert.match(text, /Where you and V stand/);
  assert.match(text, /no more than 25 words/);
  assert.match(text, /do not invent/);
  assert.match(battleTrigger(fight({seconds: 9, dead: 3, alive: 0})), /3 enemies went down: all of them dead/);
  assert.match(battleTrigger(fight({seconds: 9, dead: 0, alive: 4})), /4 enemies went down: all of them left alive/);
  assert.match(battleTrigger(fight({seconds: 9, dead: 1, alive: 0})), /1 enemy went down/);
  for (const bad of [{}, {seconds: 10, dead: 1}, {seconds: '10', dead: 1, alive: 1}, {seconds: 10, dead: -1, alive: 1}, {seconds: 10, dead: 1.5, alive: 1},
    {seconds: 10, dead: 100, alive: 0}, {seconds: 3601, dead: 1, alive: 1}, {seconds: 10, dead: 0, alive: 0}, {seconds: null, dead: 1, alive: 1},
    {seconds: 10, dead: 'x', alive: 1}, {seconds: 10, dead: {}, alive: [1]}]) {
    assert.equal(fight(bad), null, JSON.stringify(bad));
  }
});
