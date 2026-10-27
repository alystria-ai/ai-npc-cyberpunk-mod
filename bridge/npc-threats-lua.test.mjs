import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {strictVector} from './companion-fixture.mjs';

// Threats and commands for ordinary NPCs (docs/NPC_THREATS_COMMANDS.md), the game half: who may be offered what with the switch on, the rails
// (a person in a vehicle, the command cooldown), the switch-off path, and what each kind sends to the game, on a fake game. The bridge half is
// bridge/npc-threats.test.mjs, the screen of V's words bridge/threat-screen.test.mjs.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/npc-reactions.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local M = (function() ${moduleSource} end)()\n${code}`);

// A fake game: every native the threats use, with counters; one person whose facts change between steps.
const service = `
local now = 1000
local calls, logs = {}, {}
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local state = {alive = true, child = false, hostile = false, safe = false, heat = 0, ready = true, refused = nil, quest = false,
  awaiting = false, speaking = false, crowd = true, temper = 'neutral', threats = true, playerMounted = false, mounted = true,
  hand = 'Items.Preset_Unity_Default', failFear = false, failExit = false, released = 0, at = {x = 0, y = 0, z = 0},
  points = {{x = 50, y = 0, z = 0, gap = 40}}}
local npcs = {['44ULL'] = {id = '44ULL'}, ['55ULL'] = {id = '55ULL'}}
local natives = {
  key = function(npc) return npc.id end,
  alive = function() return state.alive end,
  child = function() return state.child end,
  hostile = function() return state.hostileNow or state.hostile end,
  inCombat = function() count('inCombat'); return true end,
  safe = function() return state.safe end,
  heat = function() return state.heat end,
  preventionReady = function() return state.ready end,
  callPolice = function() count('callPolice'); state.heat = 1 end,
  makeHostile = function() count('makeHostile'); state.hostileNow = true end,
  startCombat = function() count('startCombat'); return 'reaction-component' end,
  engage = function() count('engage'); return 'combat start' end,
  awayPoints = function() count('awayPoints'); return state.points end,
  walkTo = function(npc, point, gait) count('walkTo'); state.at = {x = point.x, y = point.y, z = point.z}; return {id = 'walk'} end,
  commandState = function() count('commandState'); return 'Executing' end,
  position = function() return {x = state.at.x, y = state.at.y, z = state.at.z} end,
  crowd = function() count('crowd'); return state.crowd end,
  temper = function() count('temper'); return state.temper end,
  crowdFear = function(npc, player, phase) count('crowdFear'); calls.phase = phase; if state.failFear then error('no crowd event') end
    if phase >= 3 and not state.fearStill then state.at = {x = state.at.x + 9, y = 0, z = 0} end end,
  crowdPanic = function(npc, player, phase) count('crowdPanic'); calls.panicPhase = phase; if state.failPanic then error('no fear stage') end
    if phase >= 3 then state.at = {x = state.at.x + 6, y = 0, z = 0} end end,
  hold = function(npc, seconds) count('hold'); calls.holdSeconds = seconds; return {id = 'hold'} end,
  fists = function() count('fists'); return 'fists asked' end,
  holster = function() count('holster') end,
  hand = function() count('hand'); return state.hand end,
  exitVehicle = function() count('exitVehicle'); if state.failExit then error('no exit event') end; state.mounted = false end,
  mounted = function() count('mounted'); return state.mounted end,
  playerMounted = function() count('playerMounted'); return state.playerMounted end,
}
local seen = {}
local function build(extra)
  local options = {natives = natives, clock = function() return now end,
    log = function(line) logs[#logs + 1] = line end,
    logOnce = function(key, line) if not seen[key] then seen[key] = true; logs[#logs + 1] = line end end,
    player = function() return {name = 'V'} end, npcFor = function(entity) return npcs[entity] end,
    policy = {ours = function() return false end, spawned = function() return false end,
      protected = function() return false end, story = function() return false end},
    storyFlag = function() return state.quest end, refusal = function() return state.refused end,
    release = function() state.released = state.released + 1 end,
    awaiting = function() return state.awaiting end, speaking = function() return state.speaking end,
    threats = function() if state.threats == 'error' then error('manager unreadable') end; return state.threats end}
  for key, value in pairs(extra or {}) do options[key] = value end
  return M.new(options)
end
local function context(base, category, entity)
  return {entity = entity or '44ULL', profileKey = 'npc-' .. base .. '-male', archetype = {base = base, category = category}}
end
local function has(list, kind) for _, value in ipairs(list or {}) do if value == kind then return true end end return false end
local function logged(pattern) for _, line in ipairs(logs) do if line:find(pattern) then return true end end return false end
local function offerFor(S, base, category, entity) local ctx = context(base, category, entity); return S.offer(ctx.entity, ctx) end
-- A reaction handed back and run: the reply goes quiet, the reaction starts 1.5 s later, then its read-backs (and a second one) come due.
local function act(S, offer, kind, entity)
  local ok, why = S.start(kind, offer, entity or '44ULL', 'r1')
  if not ok then return false, why end
  S.update(); now = now + 2; S.update(); now = now + 4; S.update(); now = now + 2; S.update()
  return true
end
`;
const withService = code => withModule(service + code);

// ---------------------------------------------------------------------------------------------------------------------------------
// Who is offered what

test('switch off: every kind of person is offered exactly what it was before the threat reactions', () => {
  const bases = JSON.parse(read('../characters/archetypes.json')).bases;
  const table = Object.entries(bases).map(([base, row]) => `{${JSON.stringify(base)}, ${JSON.stringify(row.category)}}`).join(',');
  withModule(`
    local before = {resident = 'leave,call-police', vendor = 'call-police', police = 'attack', ['corpo-security'] = 'call-police,attack',
      gang = 'leave,attack', faction = 'leave,attack'}
    local byBase = {aldecaldos = 'leave', biotechnica = 'leave,call-police', ['trauma-team'] = 'leave,call-police'}
    for _, row in ipairs({${table}}) do
      local list = table.concat(M.kindsFor({base = row[1], category = row[2]}), ',')
      assert(list == (byBase[row[1]] or before[row[2]]), row[1] .. ': ' .. list)
      assert(table.concat(M.kindsFor({base = row[1], category = row[2]}, false, 'passive'), ',') == list, row[1] .. ': the temper counts only with the switch on')
    end
  `);
});

test('switch on: civilians flee or cower and may obey, fighters fight with fists or a weapon, cops and guards never take orders', () => withModule(`
  local function kinds(base, category, temper) return table.concat(M.kindsFor({base = base, category = category}, true, temper), ',') end
  assert(kinds('street-resident', 'resident') == 'leave,call-police,cower,get-down,stop,exit-vehicle', kinds('street-resident', 'resident'))
  assert(kinds('ripperdoc', 'vendor') == 'call-police,cower,get-down', 'a clerk ducks, never walks off its post or fights')
  assert(kinds('ncpd', 'police') == 'attack,brawl', 'a cop fights and never obeys V')
  assert(kinds('corpo-security', 'corpo-security') == 'call-police,attack,brawl')
  assert(kinds('maelstrom', 'gang') == 'leave,attack,brawl,get-down,stop,exit-vehicle')
  assert(kinds('maelstrom', 'gang', 'passive') == 'leave,attack,cower,brawl,get-down,stop,exit-vehicle', 'a passive ganger may also cower')
  assert(kinds('corpo-security', 'corpo-security', 'passive') == 'call-police,attack,cower,brawl')
  assert(kinds('street-resident', 'resident', 'aggressive') == kinds('street-resident', 'resident'), 'the temper adds cower to fighters only')
  assert(kinds('aldecaldos', 'gang') == 'leave,get-down,stop,exit-vehicle', 'nomads walk off rather than fight')
  assert(kinds('trauma-team', 'faction') == 'leave,call-police,cower,get-down,stop,exit-vehicle')
  -- Never a fight for a civilian or a clerk, never a command for a cop or a guard, never a walk-off for a clerk or a cop.
  for category, list in pairs(M.THREAT_BY_CATEGORY) do
    for _, kind in ipairs(list) do
      if category == 'resident' or category == 'vendor' then assert(kind ~= 'brawl' and kind ~= 'attack', category .. ' ' .. kind) end
      if category == 'police' or category == 'corpo-security' then assert(not M.COMMANDS[kind], category .. ' ' .. kind) end
      if category == 'vendor' or category == 'police' then assert(kind ~= 'leave', category) end
    end
  end
  -- Every kind listed is a known one, in the order of M.KINDS.
  local order = {}; for index, kind in ipairs(M.KINDS) do order[kind] = index end
  for _, base in ipairs({'street-resident', 'maelstrom', 'ncpd'}) do
    local list = M.kindsFor({base = base, category = base == 'ncpd' and 'police' or base == 'maelstrom' and 'gang' or 'resident'}, true, 'passive')
    for index = 2, #list do assert(order[list[index - 1]] < order[list[index]], base) end
  end
`));

test('allowed: a person in a vehicle may only be told to get out, and only while V is on foot; commands have a cooldown; a brawl keeps the attack rails', () => withModule(`
  local NIL = {}
  local function facts(over)
    local f = {ordinary = true, quest = false, reacted = false, child = false, refused = nil, cooldown = false, safe = false, hostile = false,
      heat = 0, preventionReady = true, off = {}, playerMounted = false, commanded = false}
    for key, value in pairs(over or {}) do if value == NIL then f[key] = nil else f[key] = value end end
    return f
  end
  local function kinds(list, over) local out, why = M.allowed(list, facts(over)); return table.concat(out, ','), why end
  local all = {'leave', 'call-police', 'attack', 'cower', 'brawl', 'get-down', 'stop', 'exit-vehicle'}
  assert(kinds(all) == 'leave,call-police,attack,cower,brawl,get-down,stop', 'on foot: everything but the get-out')
  assert(select(2, kinds({'exit-vehicle'})) == 'exit-vehicle:not-in-vehicle')
  assert(kinds(all, {refused = 'vehicle'}) == 'exit-vehicle', 'in a vehicle: only the get-out')
  assert(select(2, kinds({'exit-vehicle'}, {refused = 'vehicle', playerMounted = true})) == 'exit-vehicle:v-in-vehicle')
  assert(select(2, kinds({'exit-vehicle'}, {refused = 'vehicle', playerMounted = NIL})) == 'exit-vehicle:unreadable-v-vehicle')
  assert(select(2, kinds({'leave', 'attack'}, {refused = 'vehicle'})) == 'game-in-charge:vehicle', 'no get-out offered: the ride refuses all')
  for _, why in ipairs({'dialogue', 'combat', 'hub', 'driven', 'hurt', 'unreadable'}) do
    assert(select(2, kinds(all, {refused = why})) == 'game-in-charge:' .. why, why .. ' refuses even the commands')
  end
  assert(kinds(all, {commanded = true}) == 'leave,call-police,attack,cower,brawl', 'a command a moment ago: no other command yet')
  assert(select(2, kinds({'brawl'}, {safe = true})) == 'brawl:safe-zone')
  assert(select(2, kinds({'brawl'}, {cooldown = true})) == 'brawl:cooldown')
  assert(select(2, kinds({'brawl'}, {hostile = true})) == 'brawl:already-hostile')
  assert(select(2, kinds({'brawl'}, {off = {attack = true}})) == 'brawl:attack-switched-off')
  assert(kinds({'cower'}, {off = {fear = true}}) == 'cower', 'a cower without the crowd fear still holds still')
  assert(select(2, kinds({'cower', 'get-down'}, {off = {fear = true, hold = true}})) == 'cower:fear-switched-off,get-down:fear-switched-off')
  assert(select(2, kinds({'stop'}, {off = {hold = true}})) == 'stop:hold-switched-off')
  assert(select(2, kinds({'exit-vehicle'}, {refused = 'vehicle', off = {exit = true}})) == 'exit-vehicle:exit-switched-off')
  -- The rails before them still win: a child, a quest person, one who already reacted, a companion.
  for _, row in ipairs({{{child = true}, 'child'}, {{quest = true}, 'quest-flag'}, {{reacted = true}, 'already-reacted'}, {{ordinary = false}, 'not-ordinary'}}) do
    assert(select(2, kinds(all, row[1])) == row[2], row[2])
  end
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The switch

test('switch off: the offer is the old one (no threats flag, no new kind), a new kind is never started, nothing new is read', () => withService(`
  state.threats = false
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(offer and offer.threats == nil and table.concat(offer.kinds, ',') == 'leave,call-police', table.concat(offer.kinds, ','))
  assert(not logged('threats=on'), 'the offer line is the old one')
  assert(calls.temper == nil, 'the temper is not read with the switch off')
  for _, kind in ipairs({'cower', 'brawl', 'get-down', 'stop', 'exit-vehicle'}) do
    local ok, why = S.start(kind, offer, '44ULL', 'r1'); assert(not ok and why == 'not-offered', kind)
  end
  -- A manager that cannot be read is off; a missing option is off.
  state.threats = 'error'
  assert(offerFor(build(), 'maelstrom', 'gang', '55ULL').threats == nil)
  state.threats = true
  local S2 = build({threats = false})
  assert(offerFor(S2, 'maelstrom', 'gang', '55ULL').threats == nil)
`));

test('switch on: the offer says threats, carries the person\'s kinds and the temper, and logs both', () => withService(`
  local S = build()
  state.temper = 'passive'
  local offer = offerFor(S, 'maelstrom', 'gang')
  -- On foot: no get-out (the person is not in a vehicle).
  assert(offer.threats == true and table.concat(offer.kinds, ',') == 'leave,attack,cower,brawl,get-down,stop', table.concat(offer.kinds, ','))
  assert(logged('NPC reaction offered: kinds=leave,attack,cower,brawl,get%-down,stop type=maelstrom message=1 threats=on temper=passive'))
  -- A ganger in his car: only the get-out.
  state.refused = 'vehicle'
  local inCar = offerFor(build(), 'maelstrom', 'gang', '55ULL')
  assert(inCar and table.concat(inCar.kinds, ',') == 'exit-vehicle', inCar and table.concat(inCar.kinds, ','))
  assert(calls.playerMounted == 1, 'V\\'s own seat is read only for a person in a vehicle')
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// What each kind sends to the game

test('leave: a crowd person gets the crowd\'s own flight, never a move command (the "disappears" report); anyone else still walks', () => withService(`
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(act(S, offer, 'leave'))
  assert(calls.crowdFear == 1 and calls.phase == 3 and calls.walkTo == nil, 'the flight, not the walk')
  assert(state.released == 1, 'the conversation hold is let go first')
  assert(logged("NPC reaction: leave started, the crowd's own flight %(the crowd reaction event, no move command%)"))
  assert(calls.crowdPanic == nil, 'the event moved the person: no second ask')
  assert(logged('NPC reaction check: leave crowd moved=9.0 m in 3 s'), table.concat(logs, '\\n'))
  -- Not a crowd person: the walk, with the metres it covered in the first read-back (and a jump named as one).
  state.crowd, state.at = false, {x = 0, y = 0, z = 0}
  local S2 = build()
  local offer2 = offerFor(S2, 'street-resident', 'resident', '55ULL')
  assert(act(S2, offer2, 'leave', '55ULL'))
  assert(calls.walkTo == 1, 'a walk')
  assert(logged('NPC reaction check: leave command state=Executing moved=50.0 m %(jumped, not walked%)'), table.concat(logs, '\\n'))
`));

test('leave: when the crowd reaction event cannot be made (the live test of 2026-10-26) the person still flees, with the crowd\'s fear stage; never a move command', () => withService(`
  state.failFear = true
  local S = build()
  assert(act(S, offerFor(S, 'street-resident', 'resident'), 'leave'))
  assert(calls.crowdFear == 1 and calls.crowdPanic == 1 and calls.panicPhase == 3 and calls.walkTo == nil, 'the fear stage, not the walk')
  assert(logged("NPC reaction: leave started, the crowd's own flight %(the fear stage, no move command%)"), table.concat(logs, '\\n'))
  assert(logged('NPC reaction check: leave crowd moved=6.0 m in 3 s'), table.concat(logs, '\\n'))
  assert(not logged('the person stays'))
`));

test('leave: an event that reached the person but did not move it is followed once by the fear stage; neither way available: the honest log, still no walk', () => withService(`
  state.fearStill = true
  local S = build()
  assert(act(S, offerFor(S, 'street-resident', 'resident'), 'leave'))
  now = now + 4; S.update()
  assert(calls.crowdFear == 1 and calls.crowdPanic == 1, 'asked once more: ' .. table.concat(logs, ' | '))
  assert(logged('NPC reaction check: leave crowd moved=0.0 m in 3 s'))
  assert(logged('NPC reaction: leave did not move; asked again with the fear stage %(sent%)'))
  assert(logged('NPC reaction check: leave crowd moved=6.0 m in 3 s'), table.concat(logs, '\\n'))
  now = now + 10; S.update()
  assert(calls.crowdPanic == 1, 'only once')
  -- Both ways fail three times: both switched off; the next crowd person is not walked off (it would be put 30 m away at once).
  state.fearStill, state.failFear, state.failPanic = false, true, true
  local S2 = build()
  for index = 1, 3 do
    local entity = tostring(80 + index) .. 'ULL'
    npcs[entity] = {id = entity}
    act(S2, offerFor(S2, 'street-resident', 'resident', entity), 'leave', entity)
  end
  assert(S2.inspect().off.fear == true and S2.inspect().off.panic == true)
  npcs['90ULL'] = {id = '90ULL'}
  act(S2, offerFor(S2, 'street-resident', 'resident', '90ULL'), 'leave', '90ULL')
  assert(calls.walkTo == nil and logged("neither the crowd's reaction event nor its fear stage is available for leave; the person stays"))
`));

test('the game decides: one plan per person for each reading of V\'s words, from its kind and temper, seeded by the person, only allowed kinds', () => withModule(`
  local function plan(base, category, temper, kinds, entity)
    local p = M.plan({base = base, category = category}, temper, kinds, M.seed(entity or '44ULL'))
    if not p then return '-' end
    local parts = {}
    for _, key in ipairs(M.PLAN_KEYS) do if p[key] then parts[#parts + 1] = key .. ':' .. p[key] end end
    return table.concat(parts, ',')
  end
  local gang = {'leave', 'attack', 'brawl', 'get-down', 'stop'}
  -- An aggressive or ordinary ganger: fists for an insult or a threat to hurt, the weapon for a death threat; a command is obeyed.
  assert(plan('maelstrom', 'gang', 'aggressive', gang) == 'kill:attack,hurt:brawl,insult:brawl,get-down:get-down,stop:stop', plan('maelstrom', 'gang', 'aggressive', gang))
  assert(plan('maelstrom', 'gang', 'neutral', gang) == plan('maelstrom', 'gang', 'aggressive', gang))
  -- In a safe zone the fights are not allowed: the ganger walks off instead.
  assert(plan('maelstrom', 'gang', 'aggressive', {'leave', 'get-down', 'stop'}) == 'kill:leave,hurt:leave,insult:leave,get-down:get-down,stop:stop')
  -- A passive ganger hides or backs off.
  local passive = plan('maelstrom', 'gang', 'passive', {'leave', 'attack', 'cower', 'brawl', 'get-down', 'stop'})
  assert(passive:find('kill:cower') or passive:find('kill:leave'), passive)
  assert(passive:find('hurt:leave') and passive:find('insult:leave'), passive)
  -- Cops and guards fight; a guard's police call stands in when the fight is not allowed.
  assert(plan('ncpd', 'police', 'aggressive', {'attack', 'brawl'}) == 'kill:attack,hurt:brawl,insult:brawl')
  assert(plan('corpo-security', 'corpo-security', 'passive', {'call-police'}) == 'kill:call-police,hurt:call-police,insult:call-police')
  -- Nomads walk off.
  assert(plan('aldecaldos', 'gang', 'aggressive', {'leave', 'get-down', 'stop'}) == 'kill:leave,hurt:leave,insult:leave,get-down:get-down,stop:stop')
  -- A clerk calls the police or ducks, never leaves.
  local clerk = plan('ripperdoc', 'vendor', 'neutral', {'call-police', 'cower', 'get-down'})
  assert(not clerk:find('leave') and clerk:find('get%-down:get%-down'), clerk)
  -- Civilians run or cower, sometimes call the police: never a fight, every pick among the allowed kinds, the same for one person every time.
  local civil = {'leave', 'call-police', 'cower', 'get-down', 'stop'}
  local seen = {}
  for n = 1, 400 do
    local entity = tostring(1000000 + n * 7) .. 'ULL'
    local p = M.plan({base = 'street-resident', category = 'resident'}, 'neutral', civil, M.seed(entity))
    assert(plan('street-resident', 'resident', 'neutral', civil, entity) == plan('street-resident', 'resident', 'neutral', civil, entity), 'seeded, not random')
    for _, level in ipairs({'kill', 'hurt', 'insult'}) do
      assert(p[level] == 'leave' or p[level] == 'cower' or p[level] == 'call-police', level .. ' ' .. tostring(p[level]))
      seen[level .. ':' .. p[level]] = (seen[level .. ':' .. p[level]] or 0) + 1
    end
  end
  assert(seen['kill:cower'] > 100 and seen['kill:leave'] > 100 and seen['kill:call-police'] > 40, 'a mix across people')
  assert(seen['insult:cower'] == nil and seen['insult:leave'] > seen['insult:call-police'], 'an insult never makes a civilian cower; police only sometimes')
  -- V wanted already (no police call allowed): the call is never planned.
  for n = 1, 50 do assert(not plan('street-resident', 'resident', 'neutral', {'leave', 'cower'}, tostring(n) .. 'ULL'):find('police')) end
  -- Nothing allowed that a reading could use: no plan.
  assert(plan('street-resident', 'resident', 'neutral', {}) == '-')
  assert(M.seed('44ULL') == M.seed('44ULL') and M.seed('44ULL') ~= M.seed('45ULL'))
`));

test('the game decides: a threats offer carries the person\'s plan and logs it; the switch off never sends one', () => withService(`
  state.temper = 'aggressive'
  local S = build()
  local offer = offerFor(S, 'maelstrom', 'gang')
  assert(offer.plan and offer.plan.kill == 'attack' and offer.plan.hurt == 'brawl' and offer.plan.insult == 'brawl' and offer.plan['get-down'] == 'get-down', 'the plan')
  assert(logged('threats=on temper=aggressive plan=kill:attack,hurt:brawl,insult:brawl,get%-down:get%-down,stop:stop'), table.concat(logs, '\\n'))
  state.threats = false
  assert(offerFor(build(), 'maelstrom', 'gang', '55ULL').plan == nil)
`));

test('cower and get down: the crowd\'s own fear (phase 2) for a crowd person, a hold for anyone else', () => withService(`
  local S = build()
  assert(act(S, offerFor(S, 'street-resident', 'resident'), 'cower'))
  assert(calls.crowdFear == 1 and calls.phase == 2 and calls.hold == nil)
  state.crowd = false
  local S2 = build()
  local offer = offerFor(S2, 'street-resident', 'resident', '55ULL')
  assert(act(S2, offer, 'get-down', '55ULL'))
  assert(calls.hold == 1 and calls.holdSeconds == 20, 'holds still for 20 s')
  assert(logged('NPC reaction check: get%-down hold state=Executing'))
  -- The crowd reaction event and the fear stage both switched off after failures: a crowd person cowers by holding still.
  state.crowd, state.failFear, state.failPanic = true, true, true
  local S3 = build()
  for index = 1, 3 do
    local entity = tostring(60 + index) .. 'ULL'
    npcs[entity] = {id = entity}
    assert(act(S3, offerFor(S3, 'street-resident', 'resident', entity), 'cower', entity))
  end
  assert(S3.inspect().off.fear == true, 'switched off after 3 failures')
  assert(calls.hold == 4, 'every failed fear fell back to the hold')
  assert(S3.inspect().off.panic == true)
  -- Only the event failing: the fear stage (phase 2), no hold.
  state.failPanic = false
  local S4 = build()
  npcs['70ULL'] = {id = '70ULL'}
  assert(act(S4, offerFor(S4, 'street-resident', 'resident', '70ULL'), 'cower', '70ULL'))
  assert(calls.panicPhase == 2 and calls.hold == 4, 'the fear stage, no hold')
`));

test('brawl: hostile, combat and fists; a drawn weapon is put away once; it counts as a fight for the cooldown', () => withService(`
  local S = build()
  local offer = offerFor(S, 'maelstrom', 'gang')
  assert(act(S, offer, 'brawl'))
  assert(calls.makeHostile == 1 and calls.startCombat == 1 and calls.fists == 1)
  assert(logged('NPC reaction: brawl hostile ok, combat start reaction%-component, fists fists asked'))
  assert(logged('NPC reaction check: brawl in_combat=true hostile_to_v=true hand=Items.Preset_Unity_Default'))
  assert(calls.holster == 1 and logged('brawl drew Items.Preset_Unity_Default, asked to put it away %(sent%)'))
  -- The plain attack (a death threat) asks for no fists.
  state.hostileNow = false
  now = now + 500
  local S2 = build()
  assert(act(S2, offerFor(S2, 'maelstrom', 'gang', '55ULL'), 'attack', '55ULL'))
  assert(calls.fists == 1, 'no fists for the weapon fight')
  -- Two fights in one minute: the second is refused by the cooldown.
  local S3 = build()
  npcs['77ULL'] = {id = '77ULL'}; npcs['78ULL'] = {id = '78ULL'}
  state.hostileNow = false
  local first, second = offerFor(S3, 'maelstrom', 'gang', '77ULL'), offerFor(S3, 'maelstrom', 'gang', '78ULL')
  assert(act(S3, first, 'brawl', '77ULL'))
  state.hostileNow = false
  local ok, why = S3.start('brawl', second, '78ULL', 'r2')
  assert(not ok and why == 'brawl:cooldown', tostring(why))
`));

test('stop: a hold that outlasts the conversation, no release (the talk goes on), not the person\'s one reaction, one command per 30 s', () => withService(`
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(act(S, offer, 'stop'))
  assert(calls.hold == 1 and calls.holdSeconds == 30 and state.released == 0, 'held 30 s, the conversation kept')
  assert(logged('NPC reaction: stop started, holds still for 30 s'))
  local again, why = S.start('get-down', offer, '44ULL', 'r2')
  assert(not again and why == 'get-down:command-cooldown', tostring(why))
  -- A threat may still follow the command: the person had no reaction yet.
  assert(act(S, offer, 'leave'), 'a command does not use up the once-only rail')
  now = now + 40
  local afterLeave, whyAfter = S.start('stop', offer, '44ULL', 'r3')
  assert(not afterLeave and whyAfter == 'already-reacted', 'nobody obeys after it ran off')
`));

test('exit-vehicle: the game\'s own exit event, its read-back, and never while V sits in a vehicle', () => withService(`
  state.refused = 'vehicle'
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(table.concat(offer.kinds, ',') == 'exit-vehicle')
  assert(act(S, offer, 'exit-vehicle'))
  assert(calls.exitVehicle == 1 and state.released == 1)
  assert(logged('NPC reaction check: exit%-vehicle out of the vehicle'))
  -- V got into a car between the offer and the reply: refused at the hand-over.
  local S2 = build()
  local offer2 = offerFor(S2, 'street-resident', 'resident', '55ULL')
  state.playerMounted = true
  local ok, why = S2.start('exit-vehicle', offer2, '55ULL', 'r2')
  assert(not ok and why == 'exit-vehicle:v-in-vehicle', tostring(why))
`));

test('nothing runs per frame: with nothing pending the update is one check, and the natives are asked only at offer, start and read-back', () => withService(`
  local S = build()
  for _ = 1, 1000 do S.update() end
  assert(next(calls) == nil, 'no native call without a conversation')
`));

test('the wiring: the switch is read from the manager, off by default, shown on the settings page, and the lease takes the larger offer', () => {
  const init = read('../mod/init.lua'), manager = read('../mod/manager.lua'), ui = read('../mod/manager-ui.lua'), actions = read('../mod/gameplay-actions.lua');
  assert.match(init, /threats = function\(\) return type\(manager\.npcThreats\) == 'function' and manager\.npcThreats\(\) == true end/);
  assert.match(manager, /function M\.npcThreats\(\)\r?\n {4}loadSettings\(\)\r?\n {4}return settings\.npcThreats == true/);
  assert.match(manager, /if type\(settings\.npcThreats\) ~= 'boolean' then settings\.npcThreats, settingsNeedSave = false, true end/);
  assert.match(ui, /setting\('npcThreats', 'NPCs react to threats and commands', 'bool', snapshot\.settings\.npcThreats == true, false,/);
  assert.match(actions, /#reaction\.kinds > 8\) then reaction = nil end/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The natives, on a strict fake game: the exact objects and calls (class names checked against the game's script cache, 2026-10-26)

const fakeGame = `
${strictVector}
local queued, sent, notes = {}, {}, {}
CName = {new = function(name) return 'cname:' .. name end}
TweakDBID = {new = function(name) return 'tdb:' .. name end}
Enum = {new = function(kind, name) return kind .. '.' .. name end}
-- CET's NewObject knows a native class only by its native name and gives nil for any other name (the live test of 2026-10-26: nil for
-- 'StimuliEvent', whose native name is 'senseStimuliEvent'). The script classes are known by their own names.
local CLASSES = {DelayedCrowdReactionEvent = true, AIHoldPositionCommand = true, AIEquipCommand = true, AIUnequipCommand = true, AIEvent = true,
  AnimFeature_CrowdRunningAway = true}
local nativeStimulus = false   -- the test turns the native name on
local function stimulus(class)
  local object = {class = class}
  function object:SetStimType(value) self.stimType = value end
  return object
end
NewObject = function(name)
  if name == 'senseStimuliEvent' and nativeStimulus then return stimulus('StimuliEvent') end
  if not CLASSES[name] then return nil end
  return {class = name}
end
-- The type's own constructor (CET resolves a script name to its native class), present only when a test says so.
local function constructor(on) StimuliEvent = on and {new = function() return stimulus('StimuliEvent') end} or nil end
local wrappers, features, stages, workspot = {}, {}, {}, {inSpot = false, signals = {}}
AnimationControllerComponent = {
  SetAnimWrapperWeightOnOwnerAndItems = function(_, key, value) wrappers[#wrappers + 1] = tostring(key) .. '=' .. tostring(value) end,
  ApplyFeatureToReplicate = function(_, name, feature) features[#features + 1] = {name = name, feature = feature} end}
NPCPuppet = {ChangeHighLevelState = function(_, state) stages[#stages + 1] = 'high:' .. tostring(state) end}
local stimRecord = {id = 'record:Terror'}
local mounted = {}
Game = {
  GetStimuliSystem = function() return {GetStimRecord = function(_, kind) notes[#notes + 1] = 'record ' .. kind; return stimRecord end} end,
  GetMountingFacility = function() return {IsMountedToAnything = function(_, id) return mounted[id] == true end} end,
  GetWorkspotSystem = function() return {IsActorInWorkspot = function() return workspot.inSpot end,
    IsReactionAvailable = function(_, _, name) return name == 'cname:Fear' end,
    SendReactionSignal = function(_, _, name) workspot.signals[#workspot.signals + 1] = 'reaction:' .. name end,
    SendFastExitSignal = function() workspot.signals[#workspot.signals + 1] = 'fast-exit' end} end,
}
local crowdMember = {refuse = false, calls = {}}
function crowdMember:SetThreatLastKnownPosition(position) self.calls[#self.calls + 1] = 'threat'; self.threat = position end
function crowdMember:AllowWorkspotsUsage(allow) self.calls[#self.calls + 1] = 'workspots=' .. tostring(allow) end
function crowdMember:ChangeFearStage(stage, init) self.calls[#self.calls + 1] = 'stage=' .. tostring(stage) .. ' init=' .. tostring(init); return not self.refuse end
ScriptedPuppet = {GetWeaponRight = function(npc) return npc.weapon end}
WeaponObject = {IsFists = function(id) return id == 'fists-id' end}
ItemID = {GetTDBID = function(id) return 'tdb-of:' .. id end}
TDBID = {ToStringDEBUG = function(id) return 'Items.' .. id end}
local player = {id = 'V', GetWorldPosition = function() return Vector4.new(1, 2, 0, 1) end, GetEntityID = function() return 'V-id' end}
local npc = {id = 'N', crowd = true, GetEntityID = function() return 'N-id' end,
  IsCrowd = function(self) return self.crowd end,
  GetWorldPosition = function() return Vector4.new(10, 0, 0, 1) end,
  QueueEvent = function(_, event) queued[#queued + 1] = event end,
  GetStimReactionComponent = function() return {GetReactionPreset = function() return {Type = function() return 'gamedataReactionPresetType : Ganger_Passive (11)' end} end,
    GetRandomFearLocomotionAnimWrapper = function(_, phase) return 'cname:FearLocomotion' .. phase end} end,
  GetCrowdMemberComponent = function() return crowdMember end,
  GetAIControllerComponent = function() return {SendCommand = function(_, command) sent[#sent + 1] = command; return true end} end}
local N = M.nativeAdapter()
`;

test('natives: the stimulus is never asked of NewObject by its script name (nil in the game); without its constructor or native name the event is not sent', () => withModule(fakeGame + `
  -- Neither the type's constructor nor the native name: an error before anything is queued (the service then uses the fear stage).
  local ok, why = pcall(N.crowdFear, npc, player, 3)
  assert(not ok and tostring(why):find('the stimulus event cannot be made from Lua') and #queued == 0, tostring(why))
  -- The native name alone is enough.
  nativeStimulus = true
  N.crowdFear(npc, player, 3)
  assert(queued[1].class == 'DelayedCrowdReactionEvent' and queued[1].stimEvent.class == 'StimuliEvent')
`));

test('natives: the crowd fear stage is the public calls of the game\'s own crowd reaction: V the threat, no workspot, fear, the fear animations, panic or alarmed', () => withModule(fakeGame + `
  N.crowdPanic(npc, player, 3)
  assert(table.concat(crowdMember.calls, ',') == 'threat,workspots=false,stage=gameFearStage.Panic init=true', table.concat(crowdMember.calls, ','))
  assert(isVector4(crowdMember.threat) and crowdMember.threat.x == 1, 'V\\'s position, a real Vector4')
  assert(stages[1] == 'high:gamedataNPCHighLevelState.Fear')
  assert(table.concat(wrappers, ',') == 'cname:panic=1.0,cname:FearLocomotion3=1.0', table.concat(wrappers, ','))
  assert(features[1].name == 'cname:CrowdRunningAway' and features[1].feature.class == 'AnimFeature_CrowdRunningAway' and features[1].feature.isRunningAwayFromPlayersCar == false)
  assert(#sent == 0 and #queued == 0, 'no command, no event')
  -- Phase 2 in a workspot with its own fear reaction: the reaction signal, the alarmed stage, no running-away feature.
  crowdMember.calls, workspot.inSpot = {}, true
  N.crowdPanic(npc, player, 2)
  assert(workspot.signals[1] == 'reaction:cname:Fear' and crowdMember.calls[3] == 'stage=gameFearStage.Alarmed init=true' and #features == 1)
  -- Phase 3 in a workspot: asked out of it first.
  N.crowdPanic(npc, player, 3)
  assert(workspot.signals[2] == 'fast-exit')
  -- A refused stage raises (the service counts it as a failure).
  crowdMember.refuse = true
  assert(not pcall(N.crowdPanic, npc, player, 3))
`));

test('natives: the crowd fear is the game\'s own crowd reaction event with a fixed phase, from V, with the Terror stimulus and its record', () => withModule(fakeGame + `
  constructor(true)
  N.crowdFear(npc, player, 3)
  local event = queued[1]
  assert(event.class == 'DelayedCrowdReactionEvent' and event.vehicleFearPhase == 3, 'the event the game queues to frightened passengers')
  local stim = event.stimEvent
  assert(stim.class == 'StimuliEvent' and stim.sourceObject == player and stim.stimType == 'gamedataStimType.Terror')
  assert(isVector4(stim.sourcePosition) and stim.sourcePosition.x == 1, 'V\\'s position, a real Vector4')
  assert(stim.stimRecord == stimRecord and notes[1] == 'record gamedataStimType.Terror')
  -- A missing stimulus record does not stop the event (the game reads the phase from the event).
  Game.GetStimuliSystem = function() error('not exposed') end
  N.crowdFear(npc, player, 2)
  assert(queued[2].vehicleFearPhase == 2 and queued[2].stimEvent.stimRecord == nil)
  assert(N.crowd(npc) == true); npc.crowd = false; assert(N.crowd(npc) == false)
  assert(N.temper(npc) == 'passive')
`));

test('natives: hold, fists, holster, the hand, the exit event and the mount reads', () => withModule(fakeGame + `
  local command = N.hold(npc, 30)
  assert(command.class == 'AIHoldPositionCommand' and command.duration == 30 and sent[1] == command)
  assert(N.fists(npc) == 'fists asked')
  assert(sent[2].class == 'AIEquipCommand' and sent[2].slotId == 'tdb:AttachmentSlots.WeaponRight' and sent[2].itemId == 'tdb:Items.w_melee_004__fists_a'
    and sent[2].failIfItemNotFound == false, 'the bare-hands item, nothing added to the inventory')
  N.holster(npc)
  assert(sent[3].class == 'AIUnequipCommand' and sent[3].slotId == 'tdb:AttachmentSlots.WeaponRight')
  assert(N.hand(npc) == 'empty')
  npc.weapon = {GetItemID = function() return 'fists-id' end}; assert(N.hand(npc) == 'fists')
  npc.weapon = {GetItemID = function() return 'Preset_Lexington' end}; assert(N.hand(npc) == 'Items.tdb-of:Preset_Lexington')
  N.exitVehicle(npc)
  assert(queued[1].class == 'AIEvent' and queued[1].name == 'cname:ExitVehicle', 'the passenger exit the game itself queues')
  mounted['N-id'] = true
  assert(N.mounted(npc) == true and N.playerMounted(player) == false)
  mounted['V-id'] = true; assert(N.playerMounted(player) == true)
`));
