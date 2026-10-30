// The scene half of the scripted line player (mod/quest-lines.lua): the pose of a talk gap (an idle, a seat kind or a situation, asked once through the idle hook and
// stepped once a second while it starts) and the holdWhile hook that the dead zone of the remote voice uses (mod/quest-prims-scene.lua dead-zone, mod/quest-prims-drive.lua
// remote). Run on a fake game; nothing here starts the game.
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {run, load, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local M = ${load('quest-lines.lua')}
${base}
local game = {now = 0, gameClock = 100000, busy = false, nextId = 1, started = {}, events = {}, idle = {}, stepper = nil, idleFails = false, steps = 0, stepResults = {}}
local lines = M.new({
  clock = function() return game.now end,
  gameTime = function() return game.gameClock end,
  busy = function() return game.busy end,
  start = function(entry)
    local id = 'r' .. game.nextId; game.nextId = game.nextId + 1
    game.started[#game.started + 1] = {entry = entry, id = id}
    return id
  end,
  alive = function() return true end,
  subtitle = function() end, phone = function() return true end,
  emit = function(pack, name) game.events[#game.events + 1] = pack .. '|' .. name end,
  idle = function(key, idleKey, on, situation)
    game.idle[#game.idle + 1] = tostring(key) .. ':' .. tostring(idleKey) .. ':' .. tostring(on) .. ':' .. tostring(situation)
    if game.idleFails then error('the hook broke') end
    if on and game.stepper then return game.stepper end
    return nil
  end,
  onChange = function() end,
  log = log,
})
lines.setPack('pk', {character = 'panam-palmer', serial = 3,
  lines = {
    ['P1.a'] = {kind = 'say', text = 'Hello.', channel = 'own'},
    ['R.1'] = {kind = 'say', text = 'Left at the fork.', channel = 'remote'},
    ['R.2'] = {kind = 'say', bark = true, text = 'Clear.', channel = 'remote'},
    ['O.1'] = {kind = 'say', text = 'Own voice.', channel = 'own'},
  },
  gaps = {
    seat = {idle = 'couch'}, idle = {idle = 'panam_beer', resumeAfterSeconds = 600},
    angry = {situation = 'angry'}, nervous = {situation = 'nervous'}, relaxed = {situation = 'relaxed'}, working = {situation = 'working'},
    both = {idle = 'generic_hips', situation = 'grieving'}, grieving = {situation = 'grieving'}, celebrating = {situation = 'celebrating'},
    odd = {situation = 'bored'}, plain = {}, text = {idle = 5, situation = 5}}})
local function advance(seconds) for _ = 1, math.floor(seconds * 10 + 0.5) do game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1; lines.update(0.1) end end
`;
const withGame = code => run(`${harness}\n${code}`);

test('a gap that names an idle asks the hook once at its start and once at its end, nothing in between however long it lasts', () => withGame(`
assert(lines.openGap('pk', 'idle'))
assert(#game.idle == 1 and game.idle[1] == 'panam-palmer:panam_beer:true:nil', game.idle[1])
advance(120)
assert(#game.idle == 1, 'not per frame, not per second')
assert(lines.closeGap('pk', 'idle', true))
assert(#game.idle == 2 and game.idle[2] == 'panam-palmer:panam_beer:false:nil')
assert(not lines.closeGap('pk', 'idle', true) and #game.idle == 2, 'a second close is nothing')
`));

test('a seat kind is passed as the idle key, a gap with neither idle nor situation never calls the hook, an unknown situation and a non string are ignored', () => withGame(`
lines.openGap('pk', 'seat'); assert(game.idle[1] == 'panam-palmer:couch:true:nil'); lines.closeGap('pk', 'seat', false)
game.idle = {}
lines.openGap('pk', 'plain'); lines.closeGap('pk', 'plain', false)
lines.openGap('pk', 'odd'); lines.closeGap('pk', 'odd', false)
lines.openGap('pk', 'text'); lines.closeGap('pk', 'text', false)
lines.openGap('pk', 'nowhere'); lines.closeGap('pk', 'nowhere', false)
assert(#game.idle == 0, table.concat(game.idle, ' '))
`));

test('a situation stands for an idle when the gap names none, and the hook hears the situation; nervous and relaxed have no pose of their own but are still told', () => withGame(`
local function open(id) game.idle = {}; lines.openGap('pk', id); local first = game.idle[1]; lines.closeGap('pk', id, false); return first, game.idle[2] end
local open1, close1 = open('angry')
assert(open1 == 'panam-palmer:generic_arms_crossed:true:angry' and close1 == 'panam-palmer:generic_arms_crossed:false:angry', open1 .. ' / ' .. close1)
assert(open('grieving') == 'panam-palmer:generic_front:true:grieving')
assert(open('celebrating') == 'panam-palmer:panam_beer:true:celebrating')
assert(open('working') == 'panam-palmer:judy_coffee:true:working')
local nervous, nervousEnd = open('nervous')
assert(nervous == 'panam-palmer:nil:true:nervous' and nervousEnd == 'panam-palmer:nil:false:nervous')
assert(open('relaxed') == 'panam-palmer:nil:true:relaxed')
assert(open('both') == 'panam-palmer:generic_hips:true:grieving', 'the idle the gap names wins over the one its situation stands for')
`));

test('every idle a situation stands for is an idle workspot of the gesture archive source', () => {
  const gestures = JSON.parse(readFileSync(new URL('../assets/gestures/gestures.json', import.meta.url), 'utf8'));
  for (const key of ['panam_beer', 'generic_front', 'generic_arms_crossed', 'judy_coffee']) assert.ok(gestures.idleWorkspots[key], key + ' is an idle workspot');
  run(harness + `
local wanted = {panam_beer = true, generic_front = true, generic_arms_crossed = true, judy_coffee = true}
local n = 0
for situation, key in pairs(M.SITUATIONS) do if key then assert(wanted[key], situation .. ' stands for ' .. key); n = n + 1 end end
assert(n == 4)`);
});

test('the hook may hand back a step function: it is called once a second until it says done, never after the gap closes, and a failing step is dropped', () => withGame(`
local calls = 0
game.stepper = function() calls = calls + 1; return calls >= 3 end
lines.openGap('pk', 'idle')
advance(0.8); assert(calls == 0, 'not before a second')
advance(0.8); assert(calls == 1)
advance(5); assert(calls == 3, 'done on the third, never asked again: ' .. calls)
lines.closeGap('pk', 'idle', false)
-- A pose still starting when the gap closes is not stepped any more.
calls = 0; game.stepper = function() calls = calls + 1; return false end
lines.openGap('pk', 'idle'); advance(3.2); local before = calls; assert(before == 2 or before == 3, 'about one a second: ' .. before)
lines.closeGap('pk', 'idle', false); advance(10); assert(calls == before)
-- A step that raises is dropped, silently.
calls = 0; game.stepper = function() calls = calls + 1; error('no device') end
lines.openGap('pk', 'idle'); advance(10); assert(calls == 1)
lines.closeGap('pk', 'idle', false)
-- A hook that raises is silent too: the gap opens anyway.
game.stepper = nil; game.idleFails = true
assert(lines.openGap('pk', 'idle') and lines.gapOpen())
assert(lines.closeGap('pk', 'idle', true) and not lines.gapOpen())
`));

test('a gap opened over another closes the first pose before the second, a restored gap starts its pose again, dropPack ends it, reset forgets it without a word', () => withGame(`
lines.openGap('pk', 'idle'); lines.openGap('pk', 'angry')
assert(game.idle[1] == 'panam-palmer:panam_beer:true:nil' and game.idle[2] == 'panam-palmer:panam_beer:false:nil' and game.idle[3] == 'panam-palmer:generic_arms_crossed:true:angry', table.concat(game.idle, ' '))
game.idle = {}
lines.dropPack('pk')
assert(#game.idle == 1 and game.idle[1] == 'panam-palmer:generic_arms_crossed:false:angry')
game.idle = {}
local opened = 0 for _, e in ipairs(game.events) do if e == 'pk|gap:idle:open' then opened = opened + 1 end end
lines.restoreGap('pk', 'idle', 50)
local after = 0 for _, e in ipairs(game.events) do if e == 'pk|gap:idle:open' then after = after + 1 end end
assert(#game.idle == 1 and game.idle[1] == 'panam-palmer:panam_beer:true:nil' and after == opened, 'a restored gap starts its pose again and does not report open again')
game.idle = {}
lines.reset()
assert(#game.idle == 0 and not lines.gapOpen(), 'the world changed: nothing is asked of it')
`));

test('a gap that ends by its own timer ends its pose too, and the pose of a gap needs no hook at all', () => withGame(`
lines.openGap('pk', 'idle')
advance(601)
assert(not lines.gapOpen() and game.idle[#game.idle] == 'panam-palmer:panam_beer:false:nil')
local bare = M.new({clock = function() return game.now end, gameTime = function() return 1 end, busy = function() return false end, start = function() return 'r' end, log = log})
bare.setPack('pk', {character = 'panam-palmer', gaps = {a = {idle = 'couch', situation = 'angry'}}})
assert(bare.openGap('pk', 'a') and bare.closeGap('pk', 'a', false))
`));

// ---- holdWhile ---------------------------------------------------------------------------------------------------------------------------------------

test('holdWhile: a line of the held channel waits while the predicate is true, plays when it turns false, and other channels are never held', () => withGame(`
local silent = true
local release = lines.holdWhile('remote', function() return silent end)
lines.say('pk', 'R.1', {})
assert(#game.started == 0, 'held')
lines.say('pk', 'O.1', {})
assert(#game.started == 1 and game.started[1].entry.id == 'O.1', 'another channel plays')
lines.stopped('r1', 'finished'); advance(3)
assert(#game.started == 1, 'still held')
silent = false; advance(1.2)
assert(#game.started == 2 and game.started[2].entry.id == 'R.1' and game.started[2].entry.channel == 'remote')
lines.stopped('r2', 'finished'); advance(2)
silent = true
lines.say('pk', 'R.1', {}); assert(#game.started == 2, 'held again')
release(); advance(1.2); assert(#game.started == 3, 'released: it plays')
release()
`));

test('holdWhile: a held bark does not age (it is not dropped while the hold lasts, then it keeps the 4 s rule), a held plot line is not shown as a subtitle', () => withGame(`
local silent = true
lines.holdWhile('remote', function() return silent end)
lines.say('pk', 'R.2', {bark = true})
advance(30)
assert(#game.started == 0 and not logged('dropped'), 'held for thirty seconds and still waiting')
silent = false
game.busy = true; advance(5)
assert(#game.started == 0 and logged('bark R.2 dropped'), 'out of the zone but the talk is busy: the normal 4 s rule drops the bark')
silent = true
local shown = {}
local lines2 = M.new({clock = function() return game.now end, gameTime = function() return 1 end, busy = function() return false end, start = function() return 'r' end,
  subtitle = function(k, text) shown[#shown + 1] = text end, log = log})
lines2.setPack('pk', {character = 'panam-palmer', lines = {['R.1'] = {kind = 'say', text = 'Left at the fork.', channel = 'remote'}}})
lines2.holdWhile('remote', function() return true end)
lines2.say('pk', 'R.1', {})
for _ = 1, 600 do game.now = game.now + 0.1; lines2.update(0.1) end
assert(#shown == 0, 'a plot line of a silenced voice is not shown')
`));

test('holdWhile: a predicate that raises holds nothing, a bad call is a no-op, and a reset drops the holds', () => withGame(`
lines.holdWhile('remote', function() error('broken') end)
lines.say('pk', 'R.1', {}); assert(#game.started == 1, 'a broken hold never keeps a line from playing')
lines.stopped('r1', 'finished'); advance(2)
local noop = lines.holdWhile(5, 'x'); assert(type(noop) == 'function'); noop()
lines.holdWhile('remote', function() return true end)
lines.reset()
lines.say('pk', 'R.1', {}); advance(0.2); assert(#game.started == 2, 'reset dropped the holds')
`));

test('dead-zone and the remote voice: a remote line waits while V is inside the dead zone and plays once V is out (the real line player, the real dead-zone primitive)', () => run(`
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Scene = ${load('quest-prims-scene.lua')}
local Lines = ${load('quest-lines.lua')}
${base}
${fakeCtx}
local game = {now = 0, tick = 0, vpos = {x = 0, y = 0, z = 0}, started = {}}
local lines = Lines.new({clock = function() return game.now end, busy = function() return false end,
  start = function(entry) game.started[#game.started + 1] = entry.id; return 'r' .. #game.started end, log = log})
lines.setPack('pk', {character = 'panam-palmer', lines = {['R.1'] = {kind = 'say', text = 'Count of twenty.', channel = 'remote'}}})
local world = {playerPosition = function() return game.vpos end, remoteHold = function(fn) return lines.holdWhile('remote', fn) end}
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, log = log})
prims.env.sceneNatives = {}
assert(prims.extend(Scene))
local ctx = newCtx('pk', 'panam-palmer')
ctx.places = {shield = {x = 100, y = 200, z = 10, radius = 25}}
function ctx:untrack() end
local def = prims.get('dead-zone')
local state = def.arm(ctx, {p = 'dead-zone', id = 'shield', at = 'shield'}, prims.env)
local function tick(seconds) for _ = 1, seconds do game.now = game.now + 1; lines.update(1); def.tick(ctx, {}, state, prims.env) end end
game.vpos = {x = 100, y = 200, z = 10}
tick(2)
assert(ctx:count('dead-zone:shield:entered') == 1)
lines.say('pk', 'R.1', {})
tick(5); assert(#game.started == 0, 'silenced inside the zone')
game.vpos = {x = 100, y = 500, z = 10}
tick(3)
assert(ctx:count('dead-zone:shield:left') == 1 and #game.started == 1 and game.started[1] == 'R.1', 'delivered once V is out')
ctx:reap()
`));

// ---- the glue in mod/init.lua --------------------------------------------------------------------------------------------------------------------------

test('glue: the line player gets the idle hook, the scene extension is loaded with the copies of the mod on its env, and convaiQuestIdle asks the scene world and never raises', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(init, /idle = function\(profileKey, idleKey, on, situation\) return convaiQuestIdle\(profileKey, idleKey, on, situation\) end,/);
  assert.match(init, /'quest-prims-scene\.lua'/);
  assert.match(init, /if type\(prims\.env\) == 'table' then prims\.env\.companions = companions end/);
  const start = init.indexOf('    function convaiQuestIdle(profileKey, idleKey, on, situation)');
  const end = init.indexOf('\n    end\n', start) + '\n    end\n'.length;
  const code = init.slice(start, end);
  assert.ok(start > 0 && code.length < 700);
  run(`
${code}
local asked = {}
convaiQuestWorld = nil
assert(convaiQuestIdle('panam-palmer', 'panam_beer', true, nil) == nil, 'no world: nothing')
convaiQuestWorld = {}
assert(convaiQuestIdle('panam-palmer', 'panam_beer', true, nil) == nil, 'a world with no gap idle: nothing')
local stepper = function() return true end
convaiQuestWorld = {gapIdle = function(key, idle, on, situation) asked[#asked + 1] = key .. ':' .. tostring(idle) .. ':' .. tostring(on) .. ':' .. tostring(situation); return on and stepper or nil end}
assert(convaiQuestIdle('panam-palmer', 'panam_beer', true, 'angry') == stepper)
assert(convaiQuestIdle('panam-palmer', 'panam_beer', false, 'angry') == nil)
assert(convaiQuestIdle('panam-palmer', 'panam_beer', 'yes', nil) == nil, 'only a true on starts a pose')
assert(asked[1] == 'panam-palmer:panam_beer:true:angry' and asked[2] == 'panam-palmer:panam_beer:false:angry' and asked[3] == 'panam-palmer:panam_beer:false:nil', table.concat(asked, ' '))
convaiQuestWorld = {gapIdle = function() error('native refused') end}
assert(convaiQuestIdle('panam-palmer', 'panam_beer', true, nil) == nil, 'a raising world is silent')
convaiQuestWorld = {gapIdle = function() return 'not a function' end}
assert(convaiQuestIdle('panam-palmer', 'panam_beer', true, nil) == nil)
  `);
});

test('remote with a deadZone (the drive primitive) silences the remote lines through the same hook: held inside, delivered once out, barks still dropped by their 4 s rule', () => run(`
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Drive = ${load('quest-prims-drive.lua')}
local Lines = ${load('quest-lines.lua')}
${base}
${fakeCtx}
local game = {now = 0, vpos = {x = 100, y = 200, z = 10}, started = {}}
local lines = Lines.new({clock = function() return game.now end, busy = function() return false end,
  start = function(entry) game.started[#game.started + 1] = entry.id; return 'r' .. #game.started end, log = log})
lines.setPack('pk', {character = 'panam-palmer', lines = {['R.1'] = {kind = 'say', text = 'Count of twenty.', channel = 'remote'}, ['R.2'] = {kind = 'say', bark = true, text = 'Clear.', channel = 'remote'}}})
local world = {playerPosition = function() return game.vpos end, remoteHold = function(fn) return lines.holdWhile('remote', fn) end, rideRead = function() return nil end}
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, log = log})
assert(prims.extend(Drive))
local ctx = newCtx('pk', 'panam-palmer')
ctx.places = {shield = {x = 100, y = 200, z = 10, radius = 25}}
local def = prims.get('remote')
local state = def.arm(ctx, {p = 'remote', deadZone = 'shield'}, prims.env)
local function tick(seconds) for _ = 1, seconds do game.now = game.now + 1; lines.update(1); def.tick(ctx, {}, state, prims.env) end end
tick(2)
assert(ctx:count('remote:silenced') == 1)
lines.say('pk', 'R.1', {})
lines.say('pk', 'R.2', {bark = true})
tick(10)
assert(#game.started == 0, 'silenced inside the zone, the bark was not dropped by the wait')
game.vpos = {x = 100, y = 600, z = 10}
tick(3)
assert(ctx:count('remote:resumed') == 1 and game.started[1] == 'R.1', 'the plot line comes out')
ctx:reap()
`));
