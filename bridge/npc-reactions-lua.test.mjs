import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// What a conversation can do to an ordinary world NPC (docs/NPC_REACTIONS.md), the game half: who may be offered what, every rail, the natives
// and how they are guarded, and how the mod wires it. Run on a fake game; nothing here starts the game or reaches a provider. The bridge half is
// bridge/npc-reactions.test.mjs.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/npc-reactions.lua');
const actionsSource = read('../mod/gameplay-actions.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local M = (function() ${moduleSource} end)()\n${code}`);

// A fake game for the service: natives with counters, a clock, one person who can be changed between steps.
const service = `
local now = 1000
local calls, logs = {}, {}
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local state = {alive = true, child = false, hostile = false, safe = false, heat = 0, ready = true, refused = nil, quest = false,
  awaiting = false, speaking = false, ours = false, spawned = false, protected = false, story = false,
  points = {{x = 50, y = 0, z = 0, gap = 40}, {x = 40, y = 20, z = 0, gap = 38}}, failWalk = false, failCall = false,
  failCombat = false, failHostile = false, failSafe = false, cmd = 'Executing', combat = true, hostileNow = false, released = 0}
local npcs = {['44ULL'] = {id = '44ULL'}, ['55ULL'] = {id = '55ULL'}}
local natives = {
  key = function(npc) return npc.id end,
  alive = function() count('alive'); return state.alive end,
  child = function() count('child'); return state.child end,
  hostile = function() count('hostile'); return state.hostileNow or state.hostile end,
  inCombat = function() count('inCombat'); return state.combat end,
  safe = function() count('safe'); if state.failSafe then error('zone read failed') end; return state.safe end,
  heat = function() count('heat'); return state.heat end,
  preventionReady = function() count('ready'); return state.ready end,
  callPolice = function() count('callPolice'); if state.failCall then error('PreventionSystem is not exposed') end; state.heat = 1 end,
  makeHostile = function() count('makeHostile'); if state.failHostile then error('attitude refused') end; state.hostileNow = true end,
  startCombat = function() count('startCombat'); if state.failCombat then error('no combat') end; return 'reaction-component' end,
  engage = function() count('engage'); return 'combat start combat state' end,
  awayPoints = function() count('awayPoints'); return state.points end,
  walkTo = function(npc, point, gait) count('walkTo'); calls.lastWalk = {point = point, gait = gait}; if state.failWalk then error('the game refused the walk command') end; return {id = 'cmd'} end,
  commandState = function() count('commandState'); return state.cmd end,
}
local seen = {}
local function build(extra)
  local options = {natives = natives, clock = function() return now end,
    log = function(line) logs[#logs + 1] = line end,
    -- Like convaiLogOnce in mod/init.lua: the first line of a key only.
    logOnce = function(key, line) if not seen[key] then seen[key] = true; logs[#logs + 1] = line end end,
    player = function() return {name = 'V'} end, npcFor = function(entity) return npcs[entity] end,
    policy = {ours = function() return state.ours end, spawned = function() return state.spawned end,
      protected = function() return state.protected end, story = function() return state.story end},
    storyFlag = function() return state.quest end, refusal = function() return state.refused end,
    release = function() state.released = state.released + 1 end,
    awaiting = function() return state.awaiting end, speaking = function() return state.speaking end}
  for key, value in pairs(extra or {}) do options[key] = value end
  return M.new(options)
end
local function context(base, category, entity)
  return {entity = entity or '44ULL', profileKey = 'npc-' .. base .. '-male', archetype = {base = base, category = category}}
end
local function has(list, kind) for _, value in ipairs(list or {}) do if value == kind then return true end end return false end
local function logged(pattern) for _, line in ipairs(logs) do if line:find(pattern) then return true end end return false end
-- The second message of a conversation, which is the first that may earn an offer.
local function offerFor(S, base, category, entity)
  local ctx = context(base, category, entity)
  S.offer(ctx.entity, ctx)
  return S.offer(ctx.entity, ctx)
end
`;
const withService = code => withModule(service + code);

// ---------------------------------------------------------------------------------------------------------------------------------
// Who is offered what

test('the kinds fit the person: civilians leave or report, gangers leave or attack, clerks report, cops attack, guards report or attack', () => withModule(`
  local function kinds(base, category)
    local list = M.kindsFor({base = base, category = category}); return list and table.concat(list, ',') or nil
  end
  for _, base in ipairs({'corpo-resident', 'street-resident', 'nomad-resident', 'homeless', 'nightlife-resident', 'worker-resident', 'dogtown-resident'}) do
    assert(kinds(base, 'resident') == 'leave,call-police', base)
  end
  assert(kinds(nil, 'resident') == 'leave,call-police', 'the generic resident fallback has no base')
  for _, base in ipairs({'maelstrom', 'tyger-claws', 'valentinos', 'sixth-street', 'animals', 'voodoo-boys', 'scavengers', 'wraiths', 'mox', 'barghest'}) do
    assert(kinds(base, 'gang') == 'leave,attack', base)
  end
  for _, base in ipairs({'militech', 'kang-tao', 'netwatch', 'merc', 'street-goon'}) do assert(kinds(base, 'faction') == 'leave,attack', base) end
  for _, base in ipairs({'ripperdoc', 'weapons-dealer', 'food-vendor', 'bartender', 'clothing-vendor', 'medic-vendor', 'junk-dealer', 'melee-vendor', 'netrunner-vendor', 'market-stall'}) do
    assert(kinds(base, 'vendor') == 'call-police', base .. ' only reports: a shop the player needs is never abandoned or turned hostile')
  end
  assert(kinds('ncpd', 'police') == 'attack', 'a cop never leaves and never calmly: a threatened cop turns on V')
  assert(kinds('corpo-security', 'corpo-security') == 'call-police,attack')
  assert(kinds('aldecaldos', 'gang') == 'leave', 'nomads walk off, they do not take V on')
  assert(kinds('biotechnica', 'faction') == 'leave,call-police' and kinds('trauma-team', 'faction') == 'leave,call-police')
  -- Nobody else: a named character has no archetype, an unknown category nothing.
  assert(M.kindsFor(nil) == nil and M.kindsFor({}) == nil and M.kindsFor({category = 'story'}) == nil and M.kindsFor('judy') == nil)
  -- The answer is a copy: changing it changes nothing.
  local list = M.kindsFor({category = 'resident'}); list[1] = 'attack'
  assert(M.kindsFor({category = 'resident'})[1] == 'leave')
  -- No civilian can ever be offered an attack, and no ganger the police, whatever the base says.
  for category, allowed in pairs(M.BY_CATEGORY) do
    if category == 'resident' or category == 'vendor' then for _, kind in ipairs(allowed) do assert(kind ~= 'attack', category) end end
    if category == 'gang' or category == 'faction' or category == 'police' then for _, kind in ipairs(allowed) do assert(kind ~= 'call-police', category) end end
    if category == 'police' or category == 'vendor' then for _, kind in ipairs(allowed) do assert(kind ~= 'leave', category) end end
  end
`));

test('the archetype catalogue and the kinds agree: every base of characters/archetypes.json has a kind, and no base is missed', () => {
  const bases = JSON.parse(read('../characters/archetypes.json')).bases;
  const table = Object.entries(bases).map(([base, row]) => `{${JSON.stringify(base)}, ${JSON.stringify(row.category)}}`).join(',');
  withModule(`
    for _, row in ipairs({${table}}) do
      local list = M.kindsFor({base = row[1], category = row[2]})
      assert(list and #list >= 1, row[1] .. ' (' .. row[2] .. ') has no reaction kind')
    end
  `);
});

test('allowed: every rail, in order, and a fact that could not be read refuses', () => withModule(`
  local NIL = {}
  local function facts(over)
    local f = {ordinary = true, quest = false, first = false, reacted = false, child = false, refused = nil, cooldown = false,
      safe = false, hostile = false, heat = 0, preventionReady = true, off = {}}
    for key, value in pairs(over or {}) do if value == NIL then f[key] = nil else f[key] = value end end
    return f
  end
  local function kinds(list, over) local out, why = M.allowed(list, facts(over)); return table.concat(out, ','), why end
  assert(kinds({'leave', 'call-police', 'attack'}) == 'leave,call-police,attack')
  -- Who: only ordinary people.
  for _, name in ipairs({'ordinary'}) do assert(select(2, kinds({'leave'}, {ordinary = false})) == 'not-ordinary') end
  assert(select(2, kinds({'leave'}, {quest = true})) == 'quest-flag')
  assert(select(2, kinds({'leave'}, {quest = NIL})) == 'unreadable-quest')
  assert(select(2, kinds({'leave'}, {child = true})) == 'child')
  assert(select(2, kinds({'leave'}, {child = NIL})) == 'unreadable-child')
  -- When: not the first message, once, and not while the game is in charge.
  assert(select(2, kinds({'leave'}, {first = true})) == 'first-message')
  assert(select(2, kinds({'leave'}, {reacted = true})) == 'already-reacted')
  for _, reason in ipairs({'hub', 'dialogue', 'driven', 'combat', 'hurt', 'vehicle', 'gone', 'unreadable'}) do
    assert(select(2, kinds({'leave', 'attack'}, {refused = reason})) == 'game-in-charge:' .. reason, reason)
  end
  -- The hostile kinds: never in a safe zone, never on a recent cooldown, never when it could not be read.
  assert(kinds({'leave', 'call-police', 'attack'}, {safe = true}) == 'leave', 'a safe zone leaves only the walk away')
  assert(kinds({'leave', 'call-police', 'attack'}, {safe = NIL}) == 'leave', 'a zone that could not be read refuses the hostile kinds')
  assert(kinds({'leave', 'call-police', 'attack'}, {cooldown = true}) == 'leave')
  assert(kinds({'call-police', 'attack'}, {cooldown = true}) == '' and select(2, kinds({'call-police', 'attack'}, {cooldown = true})) == 'call-police:cooldown,attack:cooldown')
  -- An attack needs a person who is not hostile yet; a police call needs V not wanted and the game's prevention system ready.
  assert(kinds({'attack'}, {hostile = true}) == '' and select(2, kinds({'attack'}, {hostile = true})) == 'attack:already-hostile')
  assert(select(2, kinds({'attack'}, {hostile = NIL})) == 'attack:unreadable-attitude')
  assert(kinds({'call-police'}, {heat = 1}) == '' and select(2, kinds({'call-police'}, {heat = 1})) == 'call-police:already-wanted')
  assert(select(2, kinds({'call-police'}, {heat = NIL})) == 'call-police:unreadable-heat')
  assert(select(2, kinds({'call-police'}, {preventionReady = false})) == 'call-police:prevention-would-not-react')
  assert(select(2, kinds({'call-police'}, {preventionReady = NIL})) == 'call-police:prevention-would-not-react')
  assert(kinds({'leave', 'attack'}, {heat = 3}) == 'leave,attack', 'being wanted does not stop a fight')
  -- Switched-off natives.
  assert(kinds({'leave', 'call-police', 'attack'}, {off = {walk = true}}) == 'call-police,attack')
  assert(kinds({'leave', 'call-police', 'attack'}, {off = {call = true}}) == 'leave,attack')
  assert(kinds({'leave', 'call-police', 'attack'}, {off = {attack = true}}) == 'leave,call-police')
  -- Nothing, nothing readable, nothing known.
  assert(select(2, M.allowed({}, facts())) == 'no-kind' and select(2, M.allowed(nil, facts())) == 'no-kind')
  assert(select(2, M.allowed({'leave'}, nil)) == 'unreadable' and select(2, M.allowed({'leave'}, {})) == 'not-ordinary')
  assert(select(2, M.allowed({'fireball'}, facts())) == 'fireball:unknown-kind')
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The offer

test('the first message of a conversation never earns an offer; the second does, for the kinds that fit', () => withService(`
  local S = build()
  local ctx = context('street-resident', 'resident')
  assert(S.offer('44ULL', ctx) == nil, 'the first line')
  local offer = S.offer('44ULL', ctx)
  assert(offer and offer.available == true and offer.actor.id == '44ULL' and offer.actor.key == 'npc-street-resident-male')
  assert(#offer.kinds == 2 and offer.kinds[1] == 'leave' and offer.kinds[2] == 'call-police')
  local gang = offerFor(S, 'maelstrom', 'gang', '55ULL')
  assert(gang and #gang.kinds == 2 and gang.kinds[1] == 'leave' and gang.kinds[2] == 'attack')
  -- A person V has not spoken to for ten minutes is a new conversation.
  now = now + 700
  assert(S.offer('44ULL', ctx) == nil, 'the count starts again')
  assert(S.offer('44ULL', ctx) ~= nil)
`));

test('nobody who is not an ordinary NPC is ever offered anything: companions, spawned and story characters, quest actors, children', () => withService(`
  for _, flag in ipairs({'ours', 'spawned', 'protected', 'story', 'quest', 'child'}) do
    local S = build()
    state[flag] = true
    assert(offerFor(S, 'street-resident', 'resident') == nil, flag)
    state[flag] = false
  end
  -- A character with no archetype (a named one, a companion) is never even asked about.
  calls = {}
  local S = build()
  for _, context in ipairs({{entity = '44ULL', profileKey = 'judy-alvarez'}, {entity = '44ULL', profileKey = 'judy-alvarez', archetype = {}},
    {entity = '44ULL', profileKey = 'x', archetype = {category = 'story'}}}) do
    assert(S.offer('44ULL', context) == nil and S.offer('44ULL', context) == nil)
  end
  assert((calls.alive or 0) == 0, 'no native was asked')
  -- An unreadable policy, flag or refusal refuses.
  local broken = build({policy = {ours = function() error('x') end, spawned = function() return false end, protected = function() return false end, story = function() return false end}})
  assert(offerFor(broken, 'street-resident', 'resident') == nil)
  local noFlag = build({storyFlag = function() error('record unreadable') end})
  assert(offerFor(noFlag, 'street-resident', 'resident') == nil)
  local noRefusal = build({refusal = function() error('x') end})
  assert(offerFor(noRefusal, 'street-resident', 'resident') == nil)
`));

test('the game in charge, a safe zone, being wanted, an enemy already hostile and the cooldown each take away what they must and no more', () => withService(`
  -- A scene, a quest dialogue, a call, a fight, an injury, a vehicle: nothing.
  for _, reason in ipairs({'hub', 'dialogue', 'driven', 'combat', 'hurt', 'vehicle', 'gone', 'unreadable'}) do
    local S = build(); state.refused = reason
    assert(offerFor(S, 'maelstrom', 'gang') == nil, reason)
  end
  state.refused = nil
  -- A safe zone: the person may still walk off, nothing hostile (combat is disabled there).
  local S = build(); state.safe = true
  local safe = offerFor(S, 'maelstrom', 'gang'); assert(safe and #safe.kinds == 1 and safe.kinds[1] == 'leave')
  state.safe = nil
  local unreadable = offerFor(build(), 'maelstrom', 'gang'); assert(unreadable and #unreadable.kinds == 1 and unreadable.kinds[1] == 'leave')
  state.safe = false
  -- A clerk in a safe zone: nothing at all (a clerk only reports).
  state.safe = true; assert(offerFor(build(), 'ripperdoc', 'vendor') == nil); state.safe = false
  -- V already wanted: no police call; the walk away stays.
  state.heat = 2
  local wanted = offerFor(build(), 'street-resident', 'resident'); assert(wanted and #wanted.kinds == 1 and wanted.kinds[1] == 'leave')
  assert(offerFor(build(), 'ripperdoc', 'vendor') == nil)
  state.heat = 0
  -- The prevention system would not react (a scene, a lock): no police call.
  state.ready = false
  assert(#offerFor(build(), 'street-resident', 'resident').kinds == 1); state.ready = true
  -- Already hostile: no attack.
  state.hostile = true
  local hostile = offerFor(build(), 'maelstrom', 'gang'); assert(hostile and #hostile.kinds == 1 and hostile.kinds[1] == 'leave')
  assert(offerFor(build(), 'ncpd', 'police') == nil, 'a cop who is already hostile has nothing left to be offered')
  state.hostile = false
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// Starting a reaction: once, after the reply, with a cooldown

test('a reaction is accepted once per person, only for an offered kind, and starts only after the reply has been heard', () => withService(`
  local S = build()
  local offer = offerFor(S, 'street-resident', 'resident')
  assert(S.start('attack', offer, '44ULL', 'r1') == false, 'not offered')
  local ok, why = S.start('attack', offer, '44ULL', 'r1'); assert(ok == false and why == 'not-offered')
  assert(S.start('leave', nil, '44ULL', 'r1') == false and S.start(nil, offer, '44ULL', 'r1') == false)
  assert(S.start('leave', offer, '44ULL', 'r1') == true)
  local again, reason = S.start('leave', offer, '44ULL', 'r1'); assert(again == false and reason == 'already-reacted', 'one reaction per person')
  -- Nothing happens while the reply is on its way or being spoken, nor in the settling second after.
  state.awaiting = true; S.update(); now = now + 5; S.update(); assert((calls.walkTo or 0) == 0 and state.released == 0)
  state.awaiting = false; state.speaking = true; now = now + 20; S.update(); assert((calls.walkTo or 0) == 0, 'still speaking')
  state.speaking = false; S.update(); assert((calls.walkTo or 0) == 0, 'the reply has just ended')
  now = now + 1.0; S.update(); assert((calls.walkTo or 0) == 0, 'not yet settled')
  now = now + 0.6; S.update()
  assert(calls.walkTo == 1 and state.released == 1, 'one walk, after the hold was let go')
  assert(calls.lastWalk.gait == 'Run', 'a civilian runs')
  S.update(); now = now + 100; S.update(); assert(calls.walkTo == 1, 'once')
`));

test('a person who never seemed to finish speaking is not left waiting for ever', () => withService(`
  local S = build()
  assert(S.start('leave', offerFor(S, 'street-resident', 'resident'), '44ULL', 'r1'))
  state.speaking = true
  now = now + 60; S.update(); assert((calls.walkTo or 0) == 0)
  now = now + 61; S.update(); assert(calls.walkTo == 1)
`));

test('attack: the hold is let go, the person turns hostile to V and starts its own combat; a gait of its own is not chosen', () => withService(`
  local S = build()
  local offer = offerFor(S, 'maelstrom', 'gang')
  assert(S.start('attack', offer, '44ULL', 'r1'))
  S.update(); now = now + 2; S.update()
  assert(state.released == 1 and calls.makeHostile == 1 and calls.startCombat == 1)
  assert((calls.walkTo or 0) == 0 and (calls.callPolice or 0) == 0, 'an attack only attacks')
  assert(logged('attack hostile ok, combat start reaction%-component'))
  now = now + 2; S.update()
  assert(logged('check: attack in_combat=true hostile_to_v='), 'one read-back is logged')
  assert((calls.hostile or 0) >= 1)
`));

test('attack: a person who is hostile but not fighting a second later is asked once more, and then left to the game', () => withService(`
  state.combat = false
  local S = build()
  assert(S.start('attack', offerFor(S, 'maelstrom', 'gang'), '44ULL', 'r1'))
  S.update(); now = now + 2; S.update()
  assert((calls.engage or 0) == 0)
  now = now + 2; S.update()
  assert(calls.engage == 1 and logged('not in combat yet, asked again'))
  now = now + 2; S.update(); now = now + 2; S.update()
  assert(calls.engage == 1, 'only once')
  -- A person already fighting is left alone.
  calls = {}; state.combat = true; state.hostileNow = false
  local T = build()
  assert(T.start('attack', offerFor(T, 'maelstrom', 'gang', '55ULL'), '55ULL', 'r2'))
  T.update(); now = now + 2; T.update(); now = now + 2; T.update()
  assert((calls.engage or 0) == 0)
`));

test("call-police: the game's own crime report is sent once; a civilian then runs, a clerk and a guard stay where they stand", () => withService(`
  for _, row in ipairs({{'street-resident', 'resident', true}, {'ripperdoc', 'vendor', false}, {'corpo-security', 'corpo-security', false}, {'biotechnica', 'faction', true}}) do
    calls, state.heat = {}, 0
    local S = build()
    local offer = offerFor(S, row[1], row[2])
    assert(offer and has(offer.kinds, 'call-police'), row[1])
    assert(S.start('call-police', offer, '44ULL', 'r1'), row[1])
    S.update(); now = now + 2; S.update()
    assert(calls.callPolice == 1, row[1])
    assert(((calls.walkTo or 0) == 1) == row[3], row[1] .. ' walks off: ' .. tostring(row[3]))
    now = now + 2; S.update()
    assert(logged('police stage 0 %-> 1'), 'the read-back says what the stage became')
    S.reset(); now = now + 1000
  end
`));

test('the cooldown: after one attack or call another person gets no attack and no call, but may still walk off, and later gets them again', () => withService(`
  local S = build()
  local first = offerFor(S, 'maelstrom', 'gang', '44ULL')
  assert(S.start('attack', first, '44ULL', 'r1'))
  S.update(); now = now + 2; S.update()
  state.hostileNow = false
  local second = offerFor(S, 'maelstrom', 'gang', '55ULL')
  assert(second and #second.kinds == 1 and second.kinds[1] == 'leave', 'cooling down')
  assert(S.start('attack', first and {kinds = {'attack'}}, '55ULL', 'r2') == false)
  now = now + 125
  local third = offerFor(S, 'maelstrom', 'gang', '55ULL')
  assert(third and #third.kinds == 2 and third.kinds[2] == 'attack', 'after two minutes')
  -- Walking off starts no cooldown.
  local T = build()
  assert(T.start('leave', offerFor(T, 'street-resident', 'resident', '44ULL'), '44ULL', 'r1'))
  local other = offerFor(T, 'maelstrom', 'gang', '55ULL'); assert(other and #other.kinds == 2)
`));

test('the rails are checked again when the reaction starts: a person who is gone, a safe zone, a new scene or a wanted V stop it', () => withService(`
  local function started(change, kind, base, category)
    calls, logs = {}, {}
    local S = build()
    local offer = offerFor(S, base or 'maelstrom', category or 'gang')
    assert(S.start(kind, offer, '44ULL', 'r1'))
    change()
    S.update(); now = now + 2; S.update()
    return S
  end
  local function restore() state.alive, state.safe, state.refused, state.heat, state.hostileNow, state.ready = true, false, nil, 0, false, true end
  started(function() state.alive = false end, 'attack'); assert((calls.makeHostile or 0) == 0 and logged('person is gone')); restore()
  started(function() state.safe = true end, 'attack'); assert((calls.makeHostile or 0) == 0 and logged('safe%-zone')); restore()
  started(function() state.refused = 'dialogue' end, 'leave'); assert((calls.walkTo or 0) == 0 and logged('game%-in%-charge:dialogue')); restore()
  started(function() state.hostileNow = true end, 'attack'); assert((calls.makeHostile or 0) == 0); restore()
  -- A police call that is no longer possible (V got wanted meanwhile): a civilian still runs, a clerk does nothing.
  started(function() state.heat = 2 end, 'call-police', 'street-resident', 'resident')
  assert((calls.callPolice or 0) == 0 and calls.walkTo == 1 and logged('no police call possible')); restore()
  started(function() state.heat = 2 end, 'call-police', 'ripperdoc', 'vendor')
  assert((calls.callPolice or 0) == 0 and (calls.walkTo or 0) == 0); restore()
  -- ...but not when the game took charge: no fallback walk either.
  started(function() state.heat = 2; state.refused = 'hub' end, 'call-police', 'street-resident', 'resident')
  assert((calls.walkTo or 0) == 0); restore()
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// Natives: guarded, logged once, switched off

test('a native that keeps failing is logged once, switched off after three failures, and never breaks talking', () => withService(`
  local S = build()
  state.failCall = true
  for round = 1, 3 do
    local offer = offerFor(S, 'ripperdoc', 'vendor', '44ULL')
    if round == 1 then assert(offer and has(offer.kinds, 'call-police')) end
    S.reset()
    local ctx = context('ripperdoc', 'vendor')
    offer = offerFor(S, 'ripperdoc', 'vendor')
    assert(S.start('call-police', offer, '44ULL', 'r' .. round))
    S.update(); now = now + 2; S.update()
  end
  assert(calls.callPolice == 3)
  local failureLines = 0
  for _, line in ipairs(logs) do if line:find('^NPC reaction: call failed:') then failureLines = failureLines + 1 end end
  assert(failureLines == 1, 'three failures are one line (convaiLogOnce shows the first): ' .. failureLines)
  assert(logged('call switched off for this session after 3 failures'))
  assert(S.inspect().off.call == true)
  -- Switched off: no more offers of it, and an earlier one is refused.
  local later = offerFor(S, 'street-resident', 'resident', '55ULL')
  assert(later and #later.kinds == 1 and later.kinds[1] == 'leave', 'a civilian can still walk off')
  assert((function() local ok, why = S.start('call-police', {kinds = {'call-police'}}, '55ULL', 'x'); return ok end)() == false)
  -- The calls were never asked again after the switch.
  assert(calls.callPolice == 3)
  -- A reload keeps the switch: a native that does not work does not start working with the save.
  S.reset(); assert(S.inspect().off.call == true)
`));

test('a failing read refuses what depends on it, logs once, and is not asked again once it keeps failing', () => withService(`
  local S = build()
  state.failSafe = true
  for _ = 1, 5 do
    local offer = offerFor(S, 'maelstrom', 'gang')
    assert(offer and #offer.kinds == 1 and offer.kinds[1] == 'leave', 'the zone could not be read: no hostile kind')
    S.reset()
  end
  assert(calls.safe == 3, 'switched off after three failures: ' .. tostring(calls.safe))
  assert(logged('read%-zone switched off'))
  -- A failing walk: nothing moves, the log says so, the conversation goes on.
  local W = build()
  state.failSafe = false; state.failWalk = true
  assert(W.start('leave', offerFor(W, 'street-resident', 'resident', '55ULL'), '55ULL', 'r1'))
  W.update(); now = now + 2; W.update()
  assert(logged('walk failed'))
`));

test('a walk the game did not take is tried once more at the next point, and a person with no walkable point stays', () => withService(`
  local S = build()
  assert(S.start('leave', offerFor(S, 'maelstrom', 'gang'), '44ULL', 'r1'))
  S.update(); now = now + 2; S.update()
  assert(calls.walkTo == 1 and calls.lastWalk.gait == 'Walk', 'a ganger walks off')
  state.cmd = 'Failure'
  now = now + 2; S.update()
  assert(calls.walkTo == 2 and calls.lastWalk.point.x == 40, 'the next point')
  assert(logged('first walk was not taken'))
  local B = build(); calls = {}; state.cmd = 'Executing'; state.points = {}
  assert(B.start('leave', offerFor(B, 'street-resident', 'resident', '55ULL'), '55ULL', 'r1'))
  B.update(); now = now + 2; B.update()
  assert((calls.walkTo or 0) == 0 and logged('no walkable point'))
`));

test('nothing runs while nothing waits: update and an unrelated message touch no native', () => withService(`
  local S = build()
  for _ = 1, 1000 do S.update() end
  assert(next(calls) == nil)
  -- A message to a person with no kind (a named character) touches nothing either.
  S.offer('44ULL', {entity = '44ULL', profileKey = 'judy-alvarez'})
  assert(next(calls) == nil)
  local inspect = S.inspect()
  assert(inspect.pending == nil and inspect.reacted == 0)
`));

test('a new world forgets a waiting reaction, the people reacted to and the cooldown', () => withService(`
  local S = build()
  assert(S.start('attack', offerFor(S, 'maelstrom', 'gang'), '44ULL', 'r1'))
  S.reset()
  now = now + 5; S.update()
  assert((calls.makeHostile or 0) == 0, 'nothing waits any more')
  local fresh = offerFor(S, 'maelstrom', 'gang')
  assert(fresh and #fresh.kinds == 2, 'no cooldown, nobody reacted')
  S.cancel(); S.cancel('44ULL')
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The native adapter, on a fake game: every call it makes on the game, exactly

const fakeGame = `
local log = {}
local function note(...) log[#log + 1] = table.concat({...}, ' ') end
local zones = {value = 1, throws = false}
local areaSafe, noCombat, areaThrows = false, false, false
local heatStage, heatThrows, preventionPresent = 0, false, true
local enums = {}
Enum = {new = function(kind, name) return kind .. '.' .. name end}
EnumInt = function(value) if value == 'gamePSMZones.Safe' then return 2 end return tonumber(value) end
CName = {new = function(name) return 'cname:' .. name end}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
WorldPosition = {new = function() local w = {}; function w:SetVector4(v) self.vector = v end; return w end}
AIPositionSpec = {new = function() local s = {}; function s:SetWorldPosition(w) self.world = w end; return s end}
NewObject = function(name) return {class = name} end
ScriptedPuppet = {IsDefeated = function() return false end}
NPCPuppet = {IsInCombat = function() return true end, ChangeHighLevelState = function(_, state) note('highlevel', state) end}
StatusEffectSystem = {ObjectHasStatusEffectWithTag = function(_, tag) note('tag', tag); return noCombat end}
local prevention = {}
function prevention:GetHeatStageAsInt() if heatThrows then error('no such method') end return heatStage end
function prevention:GetHeatStage() return heatStage end
Game = {
  GetAllBlackboardDefs = function() return {PlayerStateMachine = {Zones = 'Zones'}} end,
  GetSafeAreaManager = function() if areaThrows then error('not exposed') end return {IsPointInSafeArea = function(_, p) note('area', p.x); return areaSafe end} end,
  GetScriptableSystemsContainer = function() return {Get = function(_, name) note('system', name); return preventionPresent and prevention or nil end} end,
  GetAINavigationSystem = function() return {FindPointInSphereForCharacter = function(_, v, radius, who)
    note('find', math.floor(v.x), math.floor(v.y), radius, who.id)
    if v.x < 0 then return {status = 'worldNavigationRequestStatus.Fail'} end
    return {status = 'worldNavigationRequestStatus.OK', point = {x = v.x, y = v.y, z = v.z}}
  end} end,
}
PreventionSystem = {
  CanPreventionReact = function(game) note('can', game); return true end,
  ShouldReactionBeAgressive = function(game) note('aggressive', game); return true end,
  CrimeWitnessRequestToPreventionSystem = function(game, position) note('crime', game, position.x, position.y) end,
}
AIActionHelper = {TryStartCombatWithTarget = function(a, b) note('helper'); return true end}
local attitude = {value = 'EAIAttitude.AIA_Neutral'}
local function agent(owner)
  return {GetAttitudeTowards = function() return attitude.value end,
    SetAttitudeTowards = function(_, other, value) note('attitude', value); attitude.value = value end}
end
local sent = {}
local reaction = {TriggerCombat = function(_, target) note('trigger'); end, throws = false}
local player = {id = 'V', GetGame = function() return 'GAME' end, GetWorldPosition = function() return {x = 0, y = 0, z = 0} end,
  GetAttitudeAgent = function() return agent() end,
  GetPlayerStateMachineBlackboard = function() return {GetInt = function(_, id) if zones.throws then error('blackboard') end return zones.value end} end}
local npc = {id = 'N', IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
  IsCharacterChildren = function() return false end, GetAttitudeAgent = function() return agent() end,
  GetEntityID = function() return {hash = 44} end, GetWorldPosition = function() return {x = 10, y = 0, z = 0} end,
  GetStimReactionComponent = function() if reaction.throws then error('no reaction component') end return reaction end,
  GetAIControllerComponent = function() return {SendCommand = function(_, command) sent[#sent + 1] = command; return not sent.refuse end,
    GetCommandState = function() return 'AICommandState : Executing (1)' end} end}
local N = M.nativeAdapter()
`;
const withNatives = code => withModule(fakeGame + code);

test('natives: the police call is the request the game\'s own CallPolice task sends, behind the game\'s own two readiness checks', () => withNatives(`
  assert(N.preventionReady(player) == true)
  assert(log[1] == 'can GAME' and log[2] == 'aggressive GAME', 'the static functions get the game instance')
  N.callPolice(player)
  assert(log[#log] == 'crime GAME 0 0', log[#log])
  -- The wanted stage: the integer getter, else the enum.
  heatStage = 2; assert(N.heat() == 2)
  heatThrows = true; assert(N.heat() == 2, 'falls back to GetHeatStage')
  preventionPresent = false; assert(not pcall(N.heat), 'no prevention system raises')
  preventionPresent = true; heatThrows = false
  -- A missing static function raises (the service guards and counts it).
  PreventionSystem.CrimeWitnessRequestToPreventionSystem = nil
  assert(not pcall(N.callPolice, player))
`));

test('natives: the safe-zone read says true on any of the three signals, false only when the zone was read, nil when it could not be', () => withNatives(`
  zones.value = 1; assert(N.safe(player) == false)
  zones.value = 2; assert(N.safe(player) == true, 'PlayerStateMachine.Zones == Safe')
  zones.value = 1; areaSafe = true; assert(N.safe(player) == true, 'the safe-area volume'); areaSafe = false
  noCombat = true; assert(N.safe(player) == true, 'a NoCombat status'); noCombat = false
  zones.throws = true; assert(N.safe(player) == nil, 'zone unreadable: nobody may be attacked or reported on a guess')
  areaSafe = true; assert(N.safe(player) == true, 'but a signal that says safe still says so'); areaSafe = false
  zones.throws = false
`));

test("natives: attack is hostile at the agent level and the person's own combat start, with the combat helper as the second way", () => withNatives(`
  N.makeHostile(npc, player)
  assert(log[#log] == 'attitude EAIAttitude.AIA_Hostile')
  assert(N.hostile(npc, player) == true)
  assert(N.startCombat(npc, player) == 'reaction-component' and log[#log] == 'trigger')
  reaction.throws = true
  assert(N.startCombat(npc, player) == 'combat-helper' and log[#log] == 'helper')
  AIActionHelper.TryStartCombatWithTarget = function() return false end
  local ok, message = pcall(N.startCombat, npc, player)
  assert(not ok and message:find('no reaction component') and message:find('refused combat'), message)
  reaction.throws = false
  local engaged = N.engage(npc, player); assert(engaged:find('combat start') and engaged:find('combat state'), engaged)
  assert(log[#log] == 'highlevel gamedataNPCHighLevelState.Combat', log[#log])
  reaction.throws = true; NPCPuppet.ChangeHighLevelState = function() error('no') end
  assert(not pcall(N.engage, npc, player), 'neither accepted raises')
  -- A hostility that does not read back raises.
  attitude.value = 'EAIAttitude.AIA_Neutral'
  local broken = {GetAttitudeAgent = function() return {SetAttitudeTowards = function() end, GetAttitudeTowards = function() return 'EAIAttitude.AIA_Neutral' end} end}
  assert(not pcall(N.makeHostile, broken, player))
`));

test('natives: the walk away goes to walkable ground away from V, then one AIMoveToCommand with the gait, and the state reads back', () => withNatives(`
  local cfg = M.DEFAULTS
  local points = N.awayPoints(npc, player, cfg)
  assert(#points >= 1 and points[1].x > 30 and math.abs(points[1].y) < 1, 'straight away from V first')
  for _, p in ipairs(points) do assert(p.gap >= cfg.awayMin and p.x > 10, 'farther from V than the person stands') end
  local asked = 0; for _, line in ipairs(log) do if line:find('^find') then asked = asked + 1 end end
  assert(asked >= 1 and log[1]:find('^find 40 0 3 N'), log[1])
  local command = N.walkTo(npc, points[1], 'Run')
  assert(command.class == 'AIMoveToCommand' and command.movementType == 'moveMovementType.Run')
  assert(command.finishWhenDestinationReached == true and command.ignoreNavigation == false and command.useStart == true and command.useStop == false)
  assert(command.rotateEntityTowardsFacingTarget == false and command.desiredDistanceFromTarget == 1.0)
  assert(command.movementTarget.world.vector.x == points[1].x and command.movementTarget.world.vector.w == 1)
  assert(sent[1] == command)
  assert(N.commandState(npc, command) == 'Executing')
  sent.refuse = true
  assert(not pcall(N.walkTo, npc, points[1], 'Walk'), 'a refused command raises')
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The lease: the same one-use capability as every companion action

const leaseFixture = `
local now, raw, sequence = 100000, nil, 0
local packets, started = {}, {}
local world = {ready = true, worldToken = 'world-a', generation = 1}
local reactionOffer = {available = true, actor = {id = '44ULL', key = 'npc-street-resident-male'}, kinds = {'leave', 'call-police'}}
local function clone(value)
  if type(value) ~= 'table' then return value end
  local result = {}; for k, v in pairs(value) do result[k] = clone(v) end; return result
end
local function context(id) return {requestId = id or 'request-1', generation = 7, entity = '44ULL', profileKey = 'npc-street-resident-male'} end
local function packet(input, kind)
  return {version = 1, action = 'npc-reaction', actionId = 'action-' .. (sequence + 1), requestId = input.requestId, generation = input.generation,
    entity = input.entity, profileKey = input.profileKey, source = 'private-text', worldToken = 'world-a', worldGeneration = 1,
    createdAt = now, expiresAt = now + 5000, reaction = kind, reactionOffer = clone(input.reactionOffer)}
end
local function publish(value) sequence = sequence + 1; raw = tostring(sequence); packets[raw] = value end
local feedback = {}
local Q = (function() ${actionsSource} end)().new({
  world = function() return world end, clock = function() return now end, normalizeOffer = clone,
  reactionOffer = function(entity, ctx) assert(entity == '44ULL'); return clone(reactionOffer) end,
  queueReaction = function(kind, offer, entity, requestId) started[#started + 1] = {kind = kind, offer = offer, entity = entity, requestId = requestId}; return true end,
  read = function() return raw end, decode = function(value) return assert(packets[value]) end,
  feedback = function(state, reason) feedback[#feedback + 1] = {state = state, reason = reason} end})
`;
const withLease = code => run(leaseFixture + code);

test('lease: a private manual turn captures the offer, a matching packet starts the reaction once, and every mismatch is refused', () => withLease(`
  for _, source in ipairs({'phone', 'reaction', 'prefetch'}) do assert(not Q.capture(context(), source)) end
  local group = context(); group.group = {index = 1, id = 'g'}; assert(not Q.capture(group, 'group-text'), 'a group round carries no reaction')
  local input = context(); assert(Q.capture(input, 'private-text'))
  assert(input.reactionOffer.actor.id == '44ULL' and #input.reactionOffer.kinds == 2 and input.chauffeurOffer == nil)
  assert(Q.inspect().reaction == true)
  local valid = packet(input, 'call-police')
  for key, value in pairs({requestId = 'stale', generation = 9, entity = '99ULL', profileKey = 'panam', source = 'phone', worldToken = 'old',
    worldGeneration = 9, version = 2, action = 'companion-leave', reaction = 'attack'}) do
    local bad = clone(valid); bad[key] = value; publish(bad); Q.update(true); assert(#started == 0, key)
  end
  local bad = clone(valid); bad.reactionOffer.kinds = {'leave', 'call-police', 'attack'}; publish(bad); Q.update(true); assert(#started == 0, 'a changed offer')
  bad = clone(valid); bad.expiresAt = now; publish(bad); Q.update(true); assert(#started == 0)
  bad = clone(valid); bad.createdAt = now + 6000; publish(bad); Q.update(true); assert(#started == 0)
  publish(valid); Q.update(true)
  assert(#started == 1 and started[1].kind == 'call-police' and started[1].entity == '44ULL' and started[1].requestId == 'request-1')
  assert(#started[1].offer.kinds == 2)
  publish(clone(valid)); Q.update(true); assert(#started == 1, 'the lease is consumed')
  assert(#feedback == 0, 'a reaction says nothing on screen')
  assert(Q.inspect().state == 'queued')
`));

test('lease: a refused reaction is quiet, an expired world or lease takes the offer away, and an offer of nothing leases nothing', () => withLease(`
  local input = context(); Q.capture(input, 'private-text')
  world.worldToken = 'other'; publish(packet(input, 'leave')); Q.update(true); assert(#started == 0 and Q.inspect().pending == false)
  world.worldToken = 'world-a'
  reactionOffer = nil
  local none = context('request-2'); assert(not Q.capture(none, 'private-text') and none.reactionOffer == nil)
  reactionOffer = {available = true, actor = {id = '44ULL', key = 'npc-street-resident-male'}, kinds = {}}
  assert(not Q.capture(context('request-3'), 'private-text'), 'an empty list')
  reactionOffer = {available = true, actor = {id = '99ULL', key = 'npc-street-resident-male'}, kinds = {'leave'}}
  assert(not Q.capture(context('request-4'), 'private-text'), 'an offer for another person')
  reactionOffer = {available = true, actor = {id = '44ULL', key = 'npc-street-resident-male'}, kinds = {'leave'}}
  local ok = context('request-5'); assert(Q.capture(ok, 'private-text'))
  now = now + 200000; Q.update(true); assert(Q.inspect().pending == false, 'the lease expired')
  assert(#feedback == 0)
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The wiring in the mod

const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};

test('wiring: a global service, built from the module; the offer and the start go through the one lease; companions, story and head turns never reach it', () => {
  const block = between("local loaded, module = pcall(dofile, 'npc-reactions.lua')", '-- Johnny in your head');
  assert.match(block, /convaiNpcReactions = service/);
  for (const needed of ['player = function()', 'npcFor = function(entity) return conversationNpc(entity) end', 'convaiWorldPolicy.ours(npc)', 'convaiWorldPolicy.spawned(npc)',
    'convaiWorldPolicy.protected(npc)', 'convaiWorldPolicy.story(npc)', 'convaiWorldTalk:refusal(npc, player, entity)', 'storyFlag', 'awaiting', 'speaking']) {
    assert.ok(block.includes(needed), needed);
  }
  const options = between('reactionOffer = function(entity, context)', 'developerMode = manager.developerMode');
  assert.match(options, /convaiNpcReactions\.offer\(entity, context\)/);
  assert.match(options, /convaiNpcReactions\.start\(kind, offer, entity, requestId\)/);
  // The capture that reaches the lease is the one that already skips a holocall, Johnny's head, an add-on voice and a story character.
  const capture = between('if context.holocall then', "-- In place over the shipped placeholder");
  assert.match(capture, /context\.head then/); assert.match(capture, /context\.voiceOnly then/); assert.match(capture, /convaiStory and convaiStory\.entity == context\.entity/);
  assert.match(init, /if convaiStory and convaiStory\.entity == context\.entity then return false end\s+return gameplayActions\.capture\(context, context\.group and 'group-voice' or 'private-voice'\)/);
  // A group round never carries a reaction (the lease takes the first speaker's leave offer only).
  assert.match(actionsSource, /if private and not drive and not tactic and not follow and not leave then\s+reaction = capturedOffer/);
});

test('wiring: nothing per frame beyond one nil check; the release, the log, the reset and the packaging are in place', () => {
  const update = between('gameplayActions.update(worldReady)', "local ok, ready = pcall(convaiInvoke, player, 'ConvaiHasSubmission')");
  assert.match(update, /if convaiNpcReactions then convaiNpcReactions\.update\(\) end/);
  assert.match(init, /convaiNpcReactions\.options\.release = function\(player\) endFocus\(player\) end/);
  assert.match(init, /convaiNpcReactions\.options\.log, convaiNpcReactions\.options\.logOnce = log, convaiLogOnce/);
  assert.match(init, /if convaiNpcReactions then convaiNpcReactions\.reset\(\) end/);
  // The module itself has no per-frame hook, no event observer, no timer: its only entry points are the offer, the start and the update.
  assert.doesNotMatch(moduleSource, /registerForEvent|Observe\(|ObserveAfter|Override\(|NewProxy|Cron\.|onUpdate/);
  const idle = moduleSource.slice(moduleSource.indexOf('function S.update()'), moduleSource.indexOf('if pending then', moduleSource.indexOf('function S.update()')));
  assert.match(idle, /if pending == nil and checks\[1\] == nil then return end/);
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) {
    assert.ok(read(file).includes('"mod/npc-reactions.lua"'), file);
    assert.ok(read(file).includes('AiNpcCyberpunkMod/npc-reactions.lua'), file);
  }
});

test('wiring: the files parse, and everything the service block reads is declared above it', () => {
  for (const [name, text] of [['npc-reactions.lua', moduleSource], ['gameplay-actions.lua', actionsSource], ['init.lua', init]]) {
    const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
    const status = lauxlib.luaL_loadstring(state, to_luastring(text));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_close(state); assert.equal(status, lua.LUA_OK, `${name}: ${error}`);
  }
  const block = init.indexOf("pcall(dofile, 'npc-reactions.lua')");
  for (const declaration of ['local function conversationNpc(entity)', 'local pending = nil', 'local function archetypeFacts(npc, entity, body)',
    "local speech = dofile('speech.lua')", 'convaiWorldPolicy = {']) {
    const at = init.indexOf(declaration);
    assert.ok(at >= 0, declaration);
    // A global (the policy) is read when called, so it may come later; a local must be declared before the block.
    if (declaration.startsWith('local')) assert.ok(at < block, `${declaration} comes before the block that uses it`);
  }
});

test("wiring: no setting, no notice, no settings row: the feature is the NPC's own decision and uses the game's own rules", () => {
  assert.doesNotMatch(moduleSource, /manager\./);
  assert.doesNotMatch(read('../mod/manager.lua'), /npcReaction|NpcReaction/);
  assert.doesNotMatch(moduleSource, /convaiNotices|ui\.t\(/);
});
