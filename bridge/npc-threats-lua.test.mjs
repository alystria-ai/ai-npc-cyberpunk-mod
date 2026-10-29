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
  points = {{x = 50, y = 0, z = 0, gap = 40}}, workspot = false, speed = nil, jump = false, vGun = false}
-- The order of what the person was sent (walk, hold, fear, panic, release): a crowd person must get its own command before the conversation lets go.
local order = {}
-- A walk: with state.speed the person runs toward the point at that speed (metres a second, on the test clock); with state.jump (or no speed)
-- it is put there at once, as the game does to a crowd person given a move command.
local motion
local function here()
  if not motion then return state.at end
  local m = motion
  local dx, dy, dz = m.to.x - m.from.x, m.to.y - m.from.y, m.to.z - m.from.z
  local d = math.sqrt(dx * dx + dy * dy + dz * dz)
  local t = (state.jump or not state.speed) and d or math.min(d, (now - m.at) * state.speed)
  local share = d > 0 and t / d or 1
  return {x = m.from.x + dx * share, y = m.from.y + dy * share, z = m.from.z + dz * share}
end
local fighters = {}
-- A weapon record's kind, as the adapter reads it from its tags.
local function kindOf(hand)
  if hand == 'fists' or hand == 'empty' then return hand end
  if hand:find('fists') then return 'fists' end
  if hand:find('Strong_Arms') or hand:find('Mantis') then return 'cyberware' end
  if hand:find('Tanto') or hand:find('Knife') or hand:find('Bat') then return 'melee' end
  return 'ranged'
end
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
  walkTo = function(npc, point, gait, continuing) count('walkTo'); order[#order + 1] = 'walk'
    calls.gait, calls.continuing = gait, (calls.continuing or 0) + (continuing and 1 or 0)
    if state.speed and not state.jump then local at = here(); state.at = at; motion = {from = at, to = {x = point.x, y = point.y, z = point.z}, at = now}
    else motion = nil; state.at = {x = point.x, y = point.y, z = point.z} end
    return {id = 'walk' .. calls.walkTo} end,
  workspot = function() count('workspot'); return state.workspot end,
  vArmed = function() count('vArmed'); return state.vGun end,
  -- Our own brawl commands stopped at the escalation (live test 7): the state each was in (state.commandStates[id], else Executing).
  stop = function(npc, command) count('stop'); calls.stopped = (calls.stopped or '') .. (npc.id or '?') .. ':' .. command.id .. ' '
    return (state.commandStates or {})[command.id] or 'Executing' end,
  -- What the person's character record fights with first (npc.record), with its kind; npc.recordError: unreadable.
  primary = function(npc) count('primary'); if npc.recordError then error('no record') end
    if not npc.record then return nil end
    return npc.record, kindOf(npc.record) end,
  cancel = function(npc, command) count('cancel'); calls.cancelled = command end,
  joined = function() count('joined'); return fighters, {squad = #fighters, nearby = 0} end,
  scared = function(npc, on) count('scared'); order[#order + 1] = on and 'pose' or 'calm'; calls.posed = on end,
  commandState = function() count('commandState'); return 'Executing' end,
  position = function() local at = here(); return {x = at.x, y = at.y, z = at.z} end,
  crowd = function() count('crowd'); return state.crowd end,
  temper = function() count('temper'); return state.temper end,
  crowdFear = function(npc, player, phase) count('crowdFear'); order[#order + 1] = 'fear'; calls.phase = phase; if state.failFear then error('no crowd event') end
    if phase >= 3 and not state.fearStill then state.at = {x = state.at.x + 9, y = 0, z = 0} end end,
  crowdPanic = function(npc, player, phase) count('crowdPanic'); order[#order + 1] = 'panic'; calls.panicPhase = phase; if state.failPanic then error('no fear stage') end
    if phase >= 3 then state.at = {x = state.at.x + 6, y = 0, z = 0} end end,
  hold = function(npc, seconds) count('hold'); order[#order + 1] = 'hold'; calls.holdSeconds = seconds; return {id = 'hold'} end,
  fists = function() count('fists'); return 'fists asked', {id = 'fists'} end,
  holster = function() count('holster'); return {id = 'holster'} end,
  hand = function(npc) count('hand'); local hand = npc.hand or state.hand; return hand, kindOf(hand) end,
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
    release = function() state.released = state.released + 1; order[#order + 1] = 'release' end,
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
-- Time passing in small steps (a crowd person's run is read back leg by leg).
local function run(S, seconds) for _ = 1, math.floor(seconds * 10 + 0.5) do now = now + 0.1; S.update() end end
local function sequence() return table.concat(order, ',') end
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

test('switch off: the offer has the old kinds (no threats flag, no new kind) and the game\'s plan of them; a new kind is never started', () => withService(`
  state.threats = false
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(offer and offer.threats == nil and table.concat(offer.kinds, ',') == 'leave,call-police', table.concat(offer.kinds, ','))
  assert(not logged('threats=on'), 'no threats flag on the line')
  -- The game decides on both sides of the switch (live test 3, 2026-10-27: the switch was off and nothing fired): a plan of the old kinds.
  assert(offer.plan and (offer.plan.kill == 'leave' or offer.plan.kill == 'call-police') and offer.plan.insult and offer.plan.stop == nil, 'a plan of the old kinds')
  assert(logged('NPC reaction offered: kinds=leave,call%-police type=street%-resident message=1 temper=neutral plan=kill:'), table.concat(logs, '\\n'))
  assert(calls.temper == 1, 'the temper is read once for the plan')
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

// Live test 2 (2026-10-27): a WALKING crowd person given the crowd reaction event after the conversation had let go kept walking (`moved=1.5 m in
// 3 s`): the crowd's traffic had it back. The conversation's own focus hold is what stops such a person (Engagement.reds ConvaiBeginFocus), so the
// person gets its own command while that hold still runs, and only then is it let go.
test('leave: a walking crowd person gets its own run before the conversation lets go, in legs read back one by one, and goes back to the crowd at the end', () => withService(`
  state.speed, state.fearStill = 5.5, true
  local S = build()
  assert(S.start('leave', offerFor(S, 'street-resident', 'resident'), '44ULL', 'r1'))
  run(S, 1.8)
  assert(sequence() == 'fear,walk,release', 'the fright for the people around, the run, then the conversation lets go: ' .. sequence())
  assert(calls.gait == 'Run' and calls.walkTo == 1)
  assert(logged("NPC reaction: leave started, taken from the crowd and run away in legs %(40 m from V; the conversation's hold let go after the first leg was sent%)"), table.concat(logs, '\\n'))
  run(S, 12)
  assert(logged('NPC reaction check: leave first leg moved=%d%.%d m in 0%.%d s %(running%)'), table.concat(logs, '\\n'))
  assert(calls.walkTo >= 5 and calls.continuing == calls.walkTo - 1, 'later legs run on, no start animation: ' .. tostring(calls.walkTo))
  assert(logged('NPC reaction check: leave ran %d+%.%d m in %d+ leg%(s%); back to the crowd'), table.concat(logs, '\\n'))
  assert(not logged('jumped') and calls.crowdPanic == nil)
  local legs = calls.walkTo
  run(S, 10)
  assert(calls.walkTo == legs, 'nothing more once it arrived')
`));

test('leave: a crowd run the game turns into a jump stops after that one leg (the crowd\'s fear instead); a person that does not run gets the fear too', () => withService(`
  state.jump, state.fearStill = true, true
  local S = build()
  assert(S.start('leave', offerFor(S, 'street-resident', 'resident'), '44ULL', 'r1'))
  run(S, 6)
  assert(logged("NPC reaction check: leave leg 1 moved=4%.0 m in 0%.%d s %(jumped, not run%); no more moves, the crowd's fear instead"), table.concat(logs, '\\n'))
  assert(calls.walkTo == 1 and calls.crowdPanic == 1, 'one leg at most, then the fear stage')
  -- Standing still after the first leg was sent, twice in a row: the fear instead, no more legs.
  state.jump, state.speed, state.at = false, 0, {x = 0, y = 0, z = 0}
  local S2 = build()
  assert(S2.start('leave', offerFor(S2, 'street-resident', 'resident', '55ULL'), '55ULL', 'r2'))
  run(S2, 6)
  assert(logged("NPC reaction check: leave did not run %(leg 1 moved=0%.0 m, command state=Executing%); the crowd's fear instead"), table.concat(logs, '\\n'))
  assert(calls.walkTo == 2 and calls.crowdPanic == 2)
`));

test('leave: a seated crowd person (a bench, a counter) never gets a move command: the crowd\'s own flight; anyone not in the crowd still walks', () => withService(`
  state.workspot = true
  local S = build()
  assert(act(S, offerFor(S, 'street-resident', 'resident'), 'leave'))
  assert(calls.crowdFear == 1 and calls.phase == 3 and calls.walkTo == nil, 'the flight, not the walk')
  assert(sequence() == 'release,fear', sequence())
  assert(logged("NPC reaction: leave started, the crowd's own flight %(the crowd reaction event, no move command%)"))
  assert(logged('NPC reaction check: leave crowd moved=9.0 m in 3 s'), table.concat(logs, '\\n'))
  -- Not a crowd person: the walk, with the metres it covered in the first read-back (and a jump named as one).
  state.crowd, state.at = false, {x = 0, y = 0, z = 0}
  local S2 = build()
  local offer2 = offerFor(S2, 'street-resident', 'resident', '55ULL')
  assert(act(S2, offer2, 'leave', '55ULL'))
  assert(calls.walkTo == 1, 'a walk')
  assert(logged('NPC reaction check: leave command state=Executing moved=50.0 m %(jumped, not walked%)'), table.concat(logs, '\\n'))
  -- A workspot that cannot be read counts as seated: never a move command for a person who might be put somewhere at once.
  state.crowd, state.at = true, {x = 0, y = 0, z = 0}
  natives.workspot = function() error('unreadable') end
  local S3 = build()
  npcs['56ULL'] = {id = '56ULL'}
  assert(act(S3, offerFor(S3, 'street-resident', 'resident', '56ULL'), 'leave', '56ULL'))
  assert(calls.walkTo == 1, 'still only the earlier walk')
`));

test('leave, seated: when the crowd reaction event cannot be made (the live test of 2026-10-26) the person still flees, with the crowd\'s fear stage; never a move command', () => withService(`
  state.failFear, state.workspot = true, true
  local S = build()
  assert(act(S, offerFor(S, 'street-resident', 'resident'), 'leave'))
  assert(calls.crowdFear == 1 and calls.crowdPanic == 1 and calls.panicPhase == 3 and calls.walkTo == nil, 'the fear stage, not the walk')
  assert(logged("NPC reaction: leave started, the crowd's own flight %(the fear stage, no move command%)"), table.concat(logs, '\\n'))
  assert(logged('NPC reaction check: leave crowd moved=6.0 m in 3 s'), table.concat(logs, '\\n'))
  assert(not logged('the person stays'))
`));

test('leave, seated: an event that reached the person but did not move it is followed once by the fear stage; neither way available: the honest log, still no walk', () => withService(`
  state.fearStill, state.workspot = true, true
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

test('the game decides: a threats offer carries the person\'s plan and logs it; the switch off sends a plan of the old kinds', () => withService(`
  state.temper = 'aggressive'
  local S = build()
  local offer = offerFor(S, 'maelstrom', 'gang')
  assert(offer.plan and offer.plan.kill == 'attack' and offer.plan.hurt == 'brawl' and offer.plan.insult == 'brawl' and offer.plan['get-down'] == 'get-down', 'the plan')
  assert(logged('threats=on temper=aggressive plan=kill:attack,hurt:brawl,insult:brawl,get%-down:get%-down,stop:stop'), table.concat(logs, '\\n'))
  -- The live test 3 people (2026-10-27, the switch off): a Tyger Claw, a joytoy, the homeless, a nightlife resident; each gets a plan.
  state.threats = false
  local off = offerFor(build(), 'tyger-claws', 'gang', '55ULL')
  assert(table.concat(off.kinds, ',') == 'leave,attack' and off.threats == nil, table.concat(off.kinds, ','))
  assert(off.plan.kill == 'attack' and off.plan.hurt == 'attack' and off.plan.insult == 'leave' and off.plan.stop == nil, 'fists stand in as the weapon; an insult: walks off')
  assert(logged('NPC reaction offered: kinds=leave,attack type=tyger%-claws message=1 temper=aggressive plan=kill:attack,hurt:attack,insult:leave$'), table.concat(logs, '\\n'))
  for index, base in ipairs({'joytoy', 'homeless', 'nightlife-resident'}) do
    local category = base == 'joytoy' and 'faction' or 'resident'
    local entity = tostring(60 + index) .. 'ULL'
    npcs[entity] = {id = entity}
    local person = offerFor(build(), base, category, entity)
    assert(person and person.plan and person.plan.kill, base .. ' has a plan')
  end
`));

// Live test 4 (2026-10-27, game 2.31): "get down on the ground!" to a walking homeless man: `get-down hold state=Enqueued moved=0.3 m`, then
// `hold over, back to the crowd (moved=39.2 m in the hold)`. The crowd's phase 2 is its Surrender reaction (a second's cower), then its alarmed
// stage walked him off and our hold never ran. Now: held, the scared pose, no crowd fear; a hold not running is sent again.
// Live tests 4 to 6 (2026-10-27): a hold of our own never ran on a walking crowd person (`Enqueued` every read-back; the homeless man ran
// 103 m in the hold); the conversation's own hold does. Now the conversation is not let go for the 20 s; read back every 2 s; a drift or a
// hold not running switches to short moves back to the person's spot every second (the leave legs prove move commands run).
// Live tests 4 to 7 (2026-10-27): neither a hold of our own nor move commands stopped a walking crowd person; the conversation's focus does.
// The fake focus (mod/init.lua options): on one person at a time, `age` seconds old; refocus begins it again (age 0) for that person.
test('cower and get down: a walking crowd person is held by the conversation\'s own focus, kept from the acceptance, begun again when it ran out or let go, and let go at the end', () => withService(`
  local focus = {on = {}, age = 7, hold = {id = 'focus-hold'}}
  local function focusOf(npc) if focus.on[npc.id] then return {age = focus.age, hold = focus.hold} end return nil end
  local function keepFocus(npc, seconds) if not focus.on[npc.id] then return false end; count('keepFocus'); focus.kept = seconds; return true end
  local function refocus(player, npc, seconds) count('refocus'); order[#order + 1] = 'focus'
    if focus.fail then return false, 'story character: voice and face only' end
    focus.on, focus.age, focus.kept = {[npc.id] = true}, 0, seconds; return true, 'begun' end
  local function release() state.released = state.released + 1; order[#order + 1] = 'release'; focus.on = {} end
  local options = {focusOf = focusOf, keepFocus = keepFocus, refocus = refocus, release = release}
  -- The focus is on the person and young: pinned from the acceptance, kept to the end (no release, no hold of our own, no move).
  focus.on = {['44ULL'] = true}
  local S = build(options)
  assert(S.start('get-down', offerFor(S, 'street-resident', 'resident'), '44ULL', 'r1'))
  assert(focus.kept == 30 and logged("NPC reaction accepted: get%-down, starts when the reply has been heard %(the conversation's focus kept on it%)$"), table.concat(logs, '\\n'))
  run(S, 1.8)
  assert(sequence() == 'pose', 'no release, no hold of our own, no crowd fear: ' .. sequence())
  assert(calls.hold == nil and calls.crowdFear == nil and calls.walkTo == nil and calls.refocus == nil and focus.kept == 21)
  assert(logged("NPC reaction: get%-down started, holds still for 20 s, kept by the conversation's own focus %(begun 7 s ago, its hold runs to the end%), in the scared pose %(no crowd fear%)"), table.concat(logs, '\\n'))
  run(S, 1)
  assert(logged("NPC reaction check: get%-down hold state=Executing moved=0%.0 m %(the conversation's focus%)$"), table.concat(logs, '\\n'))
  run(S, 10)
  assert(logged("NPC reaction check: get%-down hold state=Executing moved=0%.0 m %(half way%) %(the conversation's focus%)"), table.concat(logs, '\\n'))
  run(S, 10)
  assert(state.released == 1 and logged('NPC reaction check: get%-down hold over, back to the crowd %(moved=0%.0 m in the hold, scared pose off, the conversation let go%)'), table.concat(logs, '\\n'))
  assert(calls.walkTo == nil and calls.refocus == nil, 'never a move, never begun again')
  -- Live test 7: the focus is 30 s old (its 40 s hold would end inside the 20 s): let go, begun again half a second later; then the person
  -- drifts 3 m: begun again a second time; drifting again: the moves back to its spot.
  order = {}
  focus.on, focus.age = {['71ULL'] = true}, 30
  npcs['71ULL'] = {id = '71ULL'}
  state.at = {x = 0, y = 0, z = 0}
  local S1 = build(options)
  assert(S1.start('cower', offerFor(S1, 'street-resident', 'resident', '71ULL'), '71ULL', 'r2'))
  run(S1, 2.3)
  assert(logged("NPC reaction: cower started, holds still for 20 s, the conversation's focus %(begun 30 s ago, its hold would run out%) let go, begun again in 0%.5 s, in the scared pose"), table.concat(logs, '\\n'))
  assert(logged('NPC reaction: cower focus begun again for it %(1 of 2, moved=0%.0 m%)'), table.concat(logs, '\\n'))
  assert(sequence() == 'pose,release,focus' and calls.refocus == 1 and focus.on['71ULL'], sequence())
  run(S1, 0.5)
  state.at = {x = 3, y = 0, z = 0}
  run(S1, 1.5)
  assert(logged("NPC reaction check: cower hold state=Executing moved=3%.0 m %(the conversation's focus%)"), table.concat(logs, '\\n'))
  assert(logged("NPC reaction: cower the focus did not keep it %(state=Executing, moved=3%.0 m%): begun again in 0%.5 s %(2 of 2%)"), table.concat(logs, '\\n'))
  run(S1, 1)
  assert(calls.refocus == 2 and logged('NPC reaction: cower focus begun again for it %(2 of 2, moved=3%.0 m%)'), table.concat(logs, '\\n'))
  state.at = {x = 6, y = 0, z = 0}
  run(S1, 2)
  assert(logged("NPC reaction: cower the focus did not keep it %(state=Executing, moved=3%.0 m, begun again 2 times%): back to its spot every 1 s"), table.concat(logs, '\\n'))
  assert(logged('NPC reaction: cower first move back to its spot sent'), table.concat(logs, '\\n'))
  assert(calls.gait == 'Walk' and state.at.x == 0, 'walked back to where it stood')
  run(S1, 20)
  assert(calls.refocus == 2, 'begun again at most twice')
  -- The focus already let go when the reaction starts (live test 7: 10 s after the acceptance): begun again at once for the person.
  order = {}
  focus.on = {}
  npcs['73ULL'] = {id = '73ULL'}
  state.at = {x = 0, y = 0, z = 0}
  local S3 = build(options)
  assert(S3.start('get-down', offerFor(S3, 'street-resident', 'resident', '73ULL'), '73ULL', 'r4'))
  assert(logged('NPC reaction accepted: get%-down, starts when the reply has been heard$'), 'nothing to keep at the acceptance')
  run(S3, 1.8)
  assert(logged('NPC reaction: get%-down started, holds still for 20 s, the conversation had let go: its focus begun again for it, in the scared pose'), table.concat(logs, '\\n'))
  assert(sequence() == 'pose,focus', sequence())
  -- A hold that is not running (or a focus gone): begun again.
  natives.commandState = function() count('commandState'); return 'Enqueued' end
  run(S3, 1.5)
  assert(logged("NPC reaction: get%-down the focus did not keep it %(state=Enqueued, moved=0%.0 m%): begun again in 0%.5 s %(2 of 2%)"), table.concat(logs, '\\n'))
  natives.commandState = function() count('commandState'); return 'Executing' end
  -- The focus cannot begin (a story character, say): the moves back to its spot; at the end nobody else's focus is let go.
  focus.on, focus.fail = {}, true
  local released = state.released
  npcs['75ULL'] = {id = '75ULL'}
  local S5c = build(options)
  assert(S5c.start('get-down', offerFor(S5c, 'street-resident', 'resident', '75ULL'), '75ULL', 'r6'))
  run(S5c, 1.8)
  assert(logged('NPC reaction: get%-down started, holds still for 20 s, the conversation had let go and its focus could not begin %(story character: voice and face only%): moves back to its spot'), table.concat(logs, '\\n'))
  run(S5c, 21)
  assert(state.released == released and logged('the conversation had already let go%)'), table.concat(logs, '\\n'))
  focus.fail = false
  -- A seated crowd person: the seat's own fear (the event, phase 2), no hold and no pose.
  state.workspot = true
  local S4 = build(options)
  npcs['74ULL'] = {id = '74ULL'}
  local holds, poses = calls.hold or 0, calls.scared
  assert(act(S4, offerFor(S4, 'street-resident', 'resident', '74ULL'), 'cower', '74ULL'))
  assert((calls.hold or 0) == holds and calls.phase == 2 and calls.scared == poses, tostring(calls.hold) .. ' ' .. tostring(calls.phase))
  -- Not a crowd person: its own hold of 20 s in the scared pose, as before (a stuck one cancelled and sent again).
  state.crowd, state.workspot = false, false
  local S5 = build()
  assert(act(S5, offerFor(S5, 'street-resident', 'resident', '55ULL'), 'get-down', '55ULL'))
  assert(calls.hold == holds + 1 and calls.holdSeconds == 20, 'holds still for 20 s')
  assert(logged('NPC reaction: get%-down started, holds still for 20 s %(not a crowd person%), in the scared pose'))
  assert(logged('NPC reaction check: get%-down hold state=Executing$'))
  natives.commandState = function() count('commandState'); return 'Enqueued' end
  local S6 = build()
  npcs['56ULL'] = {id = '56ULL'}
  assert(S6.start('cower', offerFor(S6, 'street-resident', 'resident', '56ULL'), '56ULL', 'r5'))
  run(S6, 4)
  assert(logged('NPC reaction: cower hold was Enqueued, cancelled and sent again for 1[89] s %(sent%)') and calls.cancel == 1, table.concat(logs, '\\n'))
  natives.commandState = function() count('commandState'); return 'Executing' end
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

// Live test 2 (2026-10-27): the ganger's friends joined his brawl, one with a gun from the start; and the owner's rule: when V draws a gun, the
// brawl escalates. Live test 4: the friends came in after the first search. Live tests 4 to 7: no gun put in a hand by command stayed there
// (the combat AI arms a person from its character record); so the escalation ends the brawl (our fists and put-away commands stopped) and
// starts an ordinary fight, and the read-backs say each person's hand and what its record fights with.
test('brawl: the friends are searched three times (squad and nearby) and get fists (a drawn gun put away); V draws: the brawl ends, our commands stopped, an ordinary fight for everyone, read back by person at +1.5 s and +5 s', () => withService(`
  local S = build({policy = {ours = function() return false end, spawned = function() return false end,
    protected = function() return false end, story = function(npc) return npc.story == true end}})
  npcs['44ULL'].record = 'Items.Preset_Tanto_Default'
  assert(S.start('brawl', offerFor(S, 'maelstrom', 'gang'), '44ULL', 'r1'))
  run(S, 3)
  -- Nobody yet at the first search (the gang has not come in).
  assert(logged('NPC reaction: brawl joined by 0 more %(search 1 of 3: squad 0, nearby 0%)$'), table.concat(logs, '\\n'))
  fighters[1] = {id = 'B1', hand = 'Items.Preset_Lexington', record = 'Items.Preset_Lexington'}
  fighters[2] = {id = 'B2', hand = 'fists', record = 'Items.w_melee_004__fists_a'}
  fighters[3] = {id = 'B3', hand = 'empty', story = true}
  run(S, 6)
  assert(calls.joined == 3, 'three searches: ' .. tostring(calls.joined))
  assert(logged('NPC reaction: brawl joined by 2 more %(search [23] of 3: squad 3, nearby 0%), asked for fists %(1 had a weapon out, asked to put it away%)'), table.concat(logs, '\\n'))
  assert(calls.fists == 3 and calls.holster == 2, 'the brawler and two friends; the story character is left alone')
  assert(calls.stop == nil and calls.vArmed >= 2, 'V empty-handed: checked once a second, no escalation')
  -- V draws: every brawler's fists and put-away commands stopped, then hostile and the combat start, as the plain attack; nothing equipped.
  local hostiles, combats, fists, holsters = calls.makeHostile, calls.startCombat, calls.fists, calls.holster
  state.commandStates = {holster = 'Success'}
  state.vGun = 'Items.Preset_Unity_Default'
  run(S, 1.2)
  assert(logged('NPC reaction: V drew Items.Preset_Unity_Default; the brawl escalates: the brawl ended, an ordinary fight for 3 of 3 %(1: 1 brawl command stopped, hostile ok, combat start reaction%-component, its record fights with Items.Preset_Tanto_Default %(melee%); 2: 1 brawl command stopped, hostile ok, combat start reaction%-component, its record fights with Items.Preset_Lexington %(gun%); 3: 1 brawl command stopped, hostile ok, combat start reaction%-component, its record fights with Items.w_melee_004__fists_a %(fists%)%)$'), table.concat(logs, '\\n'))
  assert(calls.stopped == '44ULL:fists 44ULL:holster B1:holster B1:fists B2:fists ', tostring(calls.stopped))
  assert(calls.makeHostile == hostiles + 3 and calls.startCombat == combats + 3 and calls.fists == fists and calls.holster == holsters)
  -- The combat AI arms them by their records: the gun for the ranged one, the knife and the fists for the melee ones.
  npcs['44ULL'].hand = 'Items.Preset_Tanto_Default'
  run(S, 2)
  assert(logged('NPC reaction check: brawl escalated %+1%.5 s, 1 of 3 hold a gun %(1: Items.Preset_Tanto_Default %(melee%), its record: Items.Preset_Tanto_Default %(melee%) first; 2: Items.Preset_Lexington %(gun%); 3: fists, its record: Items.w_melee_004__fists_a %(fists%) first%)$'), table.concat(logs, '\\n'))
  run(S, 4)
  assert(logged('NPC reaction check: brawl escalated %+5 s, 1 of 3 hold a gun'), table.concat(logs, '\\n'))
  assert(calls.fists == fists and calls.holster == holsters and calls.makeHostile == hostiles + 3, 'nothing asked after the escalation')
  -- V puts it away: nobody goes back to fists, and V's hand is not read any more.
  local reads = calls.vArmed
  state.vGun = false
  run(S, 10)
  assert(calls.vArmed == reads and calls.holster == holsters)
  state.commandStates = nil
  -- The watch ends by itself: a brawl V never escalates is read for escalateWatch seconds, then never again.
  local S2 = build({config = {escalateWatch = 5}})
  npcs['66ULL'] = {id = '66ULL'}
  now = now + 500
  state.hostileNow = false
  local before = calls.vArmed
  assert(act(S2, offerFor(S2, 'maelstrom', 'gang', '66ULL'), 'brawl', '66ULL'))
  run(S2, 20)
  assert(calls.vArmed - before <= 6, 'about once a second for 5 s: ' .. tostring(calls.vArmed - before))
`));

// Live test 7 (2026-10-27): gorilla arms and knives stayed whatever was equipped. V's gun out from the start: the brawl ends at the first watch,
// before anything is put away; friends who come in later are in an ordinary fight at once; a record that cannot be read is said so.
test('brawl, live test 7: V armed from the start, gorilla arms and a record that cannot be read; friends after the escalation get an ordinary fight; no weapon is ever equipped or taken', () => withService(`
  state.vGun = 'Items.Preset_Kyubi_Default'
  state.hand = 'Items.NPC_Strong_Arms'
  state.commandStates = {fists = 'Success'}
  npcs['44ULL'].record = 'Items.NPC_Strong_Arms'
  local S = build()
  assert(S.start('brawl', offerFor(S, 'tyger-claws', 'gang'), '44ULL', 'r1'))
  run(S, 6)
  assert(logged('the brawl escalates: the brawl ended, an ordinary fight for 1 of 1 %(1: hostile ok, combat start reaction%-component, its record fights with Items.NPC_Strong_Arms %(cyberware arms%)%)$'), table.concat(logs, '\\n'))
  assert(calls.holster == nil, 'never de-escalated: nothing put away')
  assert(logged('NPC reaction check: brawl escalated %+1%.5 s, 0 of 1 hold a gun %(1: Items.NPC_Strong_Arms %(cyberware arms%), its record: Items.NPC_Strong_Arms %(cyberware arms%) first%)$'), table.concat(logs, '\\n'))
  -- The friends come in after the escalation: an ordinary fight at once (no fists), one with an unreadable record.
  local fists = calls.fists
  fighters[1] = {id = 'G1', hand = 'Items.Preset_Overture_Default', record = 'Items.Preset_Overture_Default'}
  fighters[2] = {id = 'G2', hand = 'fists', recordError = true}
  run(S, 4)
  assert(logged('brawl joined by 2 more %(search 3 of 3: squad 2, nearby 0%), in an ordinary fight %(V has a gun out%)'), table.concat(logs, '\\n'))
  assert(calls.fists == fists, 'no fists for a friend after the escalation')
  assert(logged('NPC reaction check: brawl escalated joined, 1 of 3 hold a gun %(1: Items.NPC_Strong_Arms %(cyberware arms%), its record: Items.NPC_Strong_Arms %(cyberware arms%) first; 2: Items.Preset_Overture_Default %(gun%); 3: fists%)$'), table.concat(logs, '\\n'))
  run(S, 30)
  for _, line in ipairs(logs) do assert(not line:find('equip') and not line:find('took') and not line:find('kept on guns'), line) end
  state.commandStates = nil
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
local CLASSES = {DelayedCrowdReactionEvent = true, AIHoldPositionCommand = true, AISwitchToPrimaryWeaponCommand = true, AIEquipCommand = true, AIUnequipCommand = true, AIEvent = true,
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
  local how, asked = N.fists(npc)
  assert(how == 'fists asked' and asked == sent[2], 'the fists command is returned (stopped at the escalation)')
  assert(sent[2].class == 'AIEquipCommand' and sent[2].slotId == 'tdb:AttachmentSlots.WeaponRight' and sent[2].itemId == 'tdb:Items.w_melee_004__fists_a'
    and sent[2].failIfItemNotFound == false, 'the bare-hands item, nothing added to the inventory')
  assert(N.holster(npc) == sent[3])
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

test('natives: the workspot read, V\'s gun, the weapon switch, the friends who joined, the snapped leg and a continuing leg', () => withModule(fakeGame + `
  Game.GetWorkspotSystem = function() return {IsActorInWorkspot = function(_, who) return who.seated == true end} end
  assert(N.workspot(npc) == false); npc.seated = true; assert(N.workspot(npc) == true)
  -- V's gun: a ranged weapon in the right hand, by its record; fists, a blade or nothing: false.
  WeaponObject.IsRanged = function(id) return id == 'gun-id' end
  assert(N.vArmed(player) == false)
  player.weapon = {GetItemID = function() return 'blade-id' end}
  ScriptedPuppet.GetWeaponRight = function(who) return who.weapon end
  assert(N.vArmed(player) == false)
  player.weapon = {GetItemID = function() return 'gun-id' end}
  assert(N.vArmed(player) == 'Items.tdb-of:gun-id')
  -- A weapon's kind by its record's tags (the read-backs say it).
  local tagsOf = {['gun-id'] = 'ranged', ['gun2-id'] = 'ranged', ['blade-id'] = 'melee', ['fists-id'] = 'fists', ['arms-id'] = 'cyberware'}
  WeaponObject.IsRanged = function(id) return tagsOf[id] == 'ranged' end
  WeaponObject.IsMelee = function(id) return tagsOf[id] == 'melee' end
  WeaponObject.IsCyberwareWeapon = function(id) return tagsOf[id] == 'cyberware' end
  assert(N.weaponKind('gun-id') == 'ranged' and N.weaponKind('blade-id') == 'melee' and N.weaponKind('fists-id') == 'fists' and N.weaponKind('arms-id') == 'cyberware'
    and N.weaponKind('jacket-id') == 'other')
  assert(N.weapons == nil, 'no gun is equipped by command any more (live test 7)')
  -- What the person's own record fights with first (live test 7: a gang melee record keeps its melee weapon while V can be reached): the
  -- first item of its primary equipment group, through AIActionTransactionSystem.CalculateEquipmentItems (CET's out list), with its kind.
  local character = {PrimaryEquipment = function() return 'primary-group' end}
  TweakDBInterface = {GetCharacterRecord = function(id) assert(id == 'record-of-N'); return character end}
  npc.GetRecordID = function() return 'record-of-N' end
  local function entry(name) return {Item = function() return {GetID = function() return name end} end} end
  local primary = {entry('blade-id'), entry('gun-id')}
  AIActionTransactionSystem = {CalculateEquipmentItems = function(who, group, level)
    assert(who == npc and group == 'primary-group' and level == -1); return true, primary end}
  local toString = TDBID.ToStringDEBUG
  TDBID.ToStringDEBUG = function(id) return 'Items.' .. id end
  ItemID.FromTDBID = function(id) return id end
  local record, kind = N.primary(npc)
  assert(record == 'Items.blade-id' and kind == 'melee', tostring(record) .. ' ' .. tostring(kind))
  primary = {entry('arms-id')}
  record, kind = N.primary(npc)
  assert(record == 'Items.arms-id' and kind == 'cyberware')
  primary = {}
  assert(N.primary(npc) == nil, 'a record with no primary weapon')
  TweakDBInterface = nil
  assert(not pcall(N.primary, npc), 'an unreadable record raises (the guard logs it)')
  TDBID.ToStringDEBUG = toString
  -- Our own command stopped the way the conversation stops its hold (Engagement.reds ConvaiEndFocus): running -> StopExecutingCommand,
  -- waiting -> CancelCommand, a finished one left alone.
  local states, stopped, cancelledNow = {}, {}, {}
  local controller = {SendCommand = function(_, command) sent[#sent + 1] = command; return true end,
    GetCommandState = function(_, command) return states[command] end,
    StopExecutingCommand = function(_, command, force) assert(force == true); stopped[#stopped + 1] = command end,
    CancelCommand = function(_, command) cancelledNow[#cancelledNow + 1] = command; return true end}
  npc.GetAIControllerComponent = function() return controller end
  local running, waiting, done = {id = 'r'}, {id = 'w'}, {id = 'd'}
  states[running], states[waiting], states[done] = 'AICommandState : Executing (1)', 'AICommandState : Enqueued (0)', 'AICommandState : Success (3)'
  assert(N.stop(npc, running) == 'Executing' and N.stop(npc, waiting) == 'Enqueued' and N.stop(npc, done) == 'Success')
  assert(#stopped == 1 and stopped[1] == running and #cancelledNow == 1 and cancelledNow[1] == waiting)
  -- The hand with its kind.
  npc.weapon = {GetItemID = function() return 'arms-id' end}
  local held, heldKind = N.hand(npc)
  assert(held == 'Items.tdb-of:arms-id' and heldKind == 'cyberware')
  npc.weapon = nil
  -- A stuck command taken back.
  local cancelled
  npc.GetAIControllerComponent = function() return {SendCommand = function(_, command) sent[#sent + 1] = command; return true end,
    CancelCommand = function(_, command) cancelled = command; return true end} end
  assert(N.cancel(npc, {id = 'stuck'}) == true and cancelled.id == 'stuck' and N.cancel(npc, nil) == false)
  -- The scared pose: the crowd's phase-2 fear animation set and the crouch stance's, on and off.
  N.scared(npc, true); N.scared(npc, false)
  assert(table.concat(wrappers, ',', #wrappers - 3) == 'cname:fear=1.0,cname:inCrouch=1.0,cname:fear=0.0,cname:inCrouch=0.0', table.concat(wrappers, ','))
  -- The friends: the brawler's squad and one targeting search, each person once, in combat or hostile to V, within the radius of V,
  -- never the brawler itself.
  player.GetAttitudeAgent = function() return {} end
  local function agent(hostile) return {GetAttitudeTowards = function() return hostile and 'EAIAttitude : AIA_Hostile (2)' or 'EAIAttitude : AIA_Neutral (1)' end} end
  local function person(id, fighting, hostile, x)
    return {id = id, fighting = fighting, IsNPC = function() return true end, GetEntityID = function() return {hash = id} end,
      GetAttitudeAgent = function() return agent(hostile) end, GetWorldPosition = function() return Vector4.new(x or 5, 2, 0, 1) end}
  end
  -- friend: hostile and fighting; watcher: hostile, not fighting yet; calm: neither; bystander: fighting someone else (not hostile to V).
  local friend, watcher, calm, bystander = person('F1', true, true), person('F4', false, true), person('F2', false, false), person('F3', true, false)
  local squadFighter, squadWaiting, squadFar = person('S1', true, true), person('S2', false, true), person('S3', true, true, 60)
  local self = person('N-hash', true, true)
  npc.GetEntityID = function() return {hash = 'N-hash'} end
  NPCPuppet.IsInCombat = function(who) return who.fighting == true end
  local byId = {['id:S1'] = squadFighter, ['id:S2'] = squadWaiting, ['id:S3'] = squadFar, ['id:F1'] = friend}
  Game.FindEntityByID = function(id) return byId[id] end
  AISquadHelper = {GetSquadmatesID = function(who) assert(who == npc); return true, {'id:S1', 'id:S2', 'id:S3', 'id:F1'} end}
  TargetSearchQuery = {new = function() return {} end}
  Game['TSF_NPC;'] = function() return 'npc-filter' end
  local query
  Game.GetTargetingSystem = function() return {GetTargetParts = function(_, _, q) query = q
    local parts = {}
    for _, who in ipairs({friend, watcher, calm, bystander, self, friend}) do parts[#parts + 1] = {entity = who} end
    return true, parts end} end
  TS_TargetPartInfo = {GetComponent = function(part) return {GetEntity = function() return part.entity end} end}
  local found, counts = N.joined(player, npc, 20)
  assert(#found == 4 and found[1] == squadFighter and found[2] == squadWaiting and found[3] == friend and found[4] == watcher,
    'the squad first (fighting or hostile, near V), then the hostile ones of the search: ' .. #found)
  assert(counts.squad == 3 and counts.nearby == 1, tostring(counts.squad) .. ' ' .. tostring(counts.nearby))
  assert(query.maxDistance == 20 and query.testedSet == 'TargetingSet.Complete' and query.searchFilter == 'npc-filter')
  -- No squad helper (or no squad): the targeting search alone, hostile to V only.
  AISquadHelper = nil
  local alone, only = N.joined(player, npc, 20)
  assert(#alone == 2 and alone[1] == friend and alone[2] == watcher and only.squad == 0 and only.nearby == 2)
  -- The snapped leg point, and nil off the navmesh.
  Game.GetAINavigationSystem = function() return {FindPointInSphereForCharacter = function(_, at, radius)
    if at.x > 100 then return {status = 'worldNavigationRequestStatus.Failed'} end
    return {status = 'worldNavigationRequestStatus.OK', point = Vector4.new(at.x, at.y + 0.5, at.z, 1)} end} end
  local snapped = N.snap(npc, {x = 4, y = 0, z = 0}, 3)
  assert(snapped.x == 4 and snapped.y == 0.5)
  assert(N.snap(npc, {x = 200, y = 0, z = 0}, 3) == nil)
  -- A later leg of a run has no start animation.
  WorldPosition = {new = function() return {SetVector4 = function(self, v) self.v = v end} end}
  AIPositionSpec = {new = function() return {SetWorldPosition = function(self, w) self.w = w end} end}
  CLASSES.AIMoveToCommand = true
  local first = N.walkTo(npc, {x = 1, y = 0, z = 0}, 'Run')
  local later = N.walkTo(npc, {x = 2, y = 0, z = 0}, 'Run', true)
  assert(first.useStart == true and later.useStart == false and later.movementType == 'moveMovementType.Run')
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The outcome sink of the bond quests (options.onOutcome(kind, entityKey)): the threat and command kinds, raw (the quest maps a command to obey)

test('outcome sink: brawl, cower and the three commands are each reported once where the reaction starts, as the raw kind', () => withService(`
  local function startedKind(kind, base, category, setup)
    local seen = {}
    if setup then setup() end
    local S = build({onOutcome = function(k, key) seen[#seen + 1] = k .. '@' .. tostring(key) end})
    assert(S.start(kind, offerFor(S, base, category), '44ULL', 'r' .. kind), kind)
    assert(#seen == 0, 'accepted is not started')
    run(S, 4)
    return seen
  end
  local brawl = startedKind('brawl', 'maelstrom', 'gang'); assert(#brawl == 1 and brawl[1] == 'brawl@44ULL', table.concat(brawl, ','))
  local cower = startedKind('cower', 'street-resident', 'resident'); assert(#cower == 1 and cower[1] == 'cower@44ULL', table.concat(cower, ','))
  local down = startedKind('get-down', 'street-resident', 'resident'); assert(#down == 1 and down[1] == 'get-down@44ULL', table.concat(down, ','))
  local stop = startedKind('stop', 'street-resident', 'resident'); assert(#stop == 1 and stop[1] == 'stop@44ULL', table.concat(stop, ','))
  local out = startedKind('exit-vehicle', 'street-resident', 'resident', function() state.refused = 'vehicle' end); assert(#out == 1 and out[1] == 'exit-vehicle@44ULL', table.concat(out, ','))
`));
