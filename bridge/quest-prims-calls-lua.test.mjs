// The call primitives of the bond quests, the game half (mod/quest-prims-calls.lua and mod/quest-world-calls.lua, docs/QUEST_PRIMITIVES.md section 10.6): call-in (the character rings
// V, the steps play when V picks up, a text and the call-script behaviour when V does not) and call-script (the steps play when V calls her). Run on a fake game: a clock, a
// phone that rings and connects when the test says so, and the real places, line player, primitives and quest module behind it. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';
import {PRIMITIVES, BUILT, raisable} from './quest-primitives.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Lines = ${load('quest-lines.lua')}
local Calls = ${load('quest-prims-calls.lua')}
local Play = ${load('quest-play.lua')}
${base}
local game = {now = 0, gameClock = 100000, tick = 0, files = {}, started = {}, phones = {}, subtitles = {}, nextRequest = 1, busy = false, linesBusy = false,
  call = nil, last = nil, serials = 0, ringCalls = 0, ringFails = false, hook = nil, hookSets = 0, unhooks = 0, ends = {}, flag = false, flags = {}, rings = {}}
local function fresh(t) return t end
local world = {
  playerPosition = function() return {x = 0, y = 0, z = 0} end,
  -- the fake phone: the same answers as mod/quest-world-calls.lua gives from holocall.lua
  callBusy = function() return game.busy or (game.call ~= nil and not game.flag) end,
  callRing = function(key, opts)
    game.ringCalls = game.ringCalls + 1
    game.rings[#game.rings + 1] = {key = key, voice = opts and opts.voice}
    if game.ringFails then return false, 'no incoming ring' end
    if game.call ~= nil then return false, 'a call is open' end
    game.serials = game.serials + 1
    game.call = {serial = game.serials, key = key, state = 'ringing', quest = true}
    return game.call.serial
  end,
  callState = function(serial)
    if game.call and game.call.serial == serial then return game.call.state end
    return 'ended', (game.last and game.last.serial == serial) and game.last.reason or nil
  end,
  callOpen = function() if game.call and game.call.state == 'connected' then return {serial = game.call.serial, key = game.call.key, quest = game.call.quest} end return nil end,
  callEnd = function(serial, reason)
    if game.call and game.call.serial == serial then game.ends[#game.ends + 1] = serial .. ':' .. tostring(reason); game.last = {serial = serial, reason = reason}; game.call = nil; return true end
    return false
  end,
  callLines = function(on) game.flag = on == true; game.flags[#game.flags + 1] = on == true end,
  callHook = function(fn)
    game.hook = fn; game.hookSets = game.hookSets + 1
    return function() if game.hook == fn then game.hook = nil end game.unhooks = game.unhooks + 1 end
  end,
}
local clock = function() return game.now end
local places = Places.new({world = world, clock = clock, log = log})
local prims = Prims.new({places = places, world = world, clock = clock, gameTime = function() return game.gameClock end, log = log})
prims.env.callNatives = {}
local play
local lines = Lines.new({clock = clock, gameTime = function() return game.gameClock end, log = log,
  busy = function() return game.linesBusy end,
  start = function(entry) local id = 'r' .. game.nextRequest; game.nextRequest = game.nextRequest + 1; game.started[#game.started + 1] = entry; game.lastRequest = id; return id end,
  subtitle = function(key, text) game.subtitles[#game.subtitles + 1] = text end,
  phone = function(key, text, image) game.phones[#game.phones + 1] = {key = key, text = text}; return true end,
  emit = function(pack, name) play.emitPack(pack, name) end,
  onChange = function() play.rearm() end})
prims.env.lines = lines
assert(prims.extend(Calls))
play = Play.new({
  enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) return game.files[path] end,
  write = function(path, text) game.files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 'sess1', log = log})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1; game.tick = game.tick + 1
    play.update('V', 0.1)
  end
end
local function file(quests) game.files[Play.PLAY] = serialize({version = 1, revision = 1, quests = quests}) end
local function events() return decode(game.files[Play.EVENTS]) end
local function count(name) local n = 0 for _, e in ipairs(game.files[Play.EVENTS] and events().events or {}) do if e.name == name then n = n + 1 end end return n end
local function names() local list = {} for _, e in ipairs(game.files[Play.EVENTS] and events().events or {}) do list[#list + 1] = e.name end return table.concat(list, ' ') end
local function lineIds() local list = {} for _, e in ipairs(game.started) do list[#list + 1] = e.id end return table.concat(list, ',') end
local holo = {kind = 'say', channel = 'holocall'}
local function callQuest(fields)
  local q = {pack = 'panam-sunset-coffee', character = 'panam-palmer', stage = 'call', serial = 1, since = 99990, places = {}, script = {},
    ['do'] = {{p = 'call-in', id = 'ring', call = 'c1', ringSeconds = 10}},
    calls = {c1 = {caller = 'self', picture = 'live', text = 'T.1', onHangUp = 'ring-failed',
      steps = {{say = 'C.1'}, {gap = 'g1'}, {event = 'mid'}, {say = 'C.2'}, {hangup = true}}}},
    lines = {['C.1'] = {kind = 'say', channel = 'holocall', text = 'Hello V.'}, ['C.2'] = {kind = 'say', channel = 'holocall', text = 'See you.'},
      ['T.1'] = {kind = 'say', channel = 'holocall', text = 'Pick up. Call me.'}},
    gaps = {g1 = {resumeAfterSeconds = 60}}}
  for k, v in pairs(fields or {}) do q[k] = v end
  return q
end
local function pickUp() game.call.state = 'connected' end
-- V calls her (the call connects): holocall.lua tells the hook.
local function vCalls(key)
  game.serials = game.serials + 1
  game.call = {serial = game.serials, key = key or 'panam-palmer', state = 'connected'}
  if game.hook then game.hook(game.call.key, game.call) end
  return game.call.serial
end
local function hangUp(reason) if game.call then game.last = {serial = game.call.serial, reason = reason or 'hangup'}; game.call = nil end end
local function lineDone() assert(lines.stopped(game.lastRequest, 'finished'), 'no line in the air') end
`;
const withGame = code => run(`${harness}\n${code}`);

test('registry: call-in and call-script are played and their events are the registry events', () => {
  for (const name of ['call-in', 'call-script']) { assert.ok(PRIMITIVES[name], name); assert.ok(BUILT.has(name), name); }
  const entries = [{p: 'call-in', id: 'ring', call: 'c1'}];
  for (const event of ['ringing', 'answered', 'done', 'hung-up', 'missed', 'texted']) assert.ok(raisable(`call:ring:${event}`, entries), event);
  assert.ok(raisable('call:cs:answered', [{p: 'call-script', id: 'cs', call: 'c1'}]));
});

test('the call tables reach the stage: the ctx holds the packs calls, and a primitive can be armed from the play file', () => withGame(`
file({callQuest()}); assert(play.restore())
assert(game.ringCalls == 0)
step(1.2)
assert(game.ringCalls == 1, 'rang once the first tick ran')
local s = play.status().quests[1]
assert(s.prims == 1, 'one primitive armed')
`));

test('call-in waits for a calm moment: a game call, a scene, a fight or V talking keep it from ringing, nothing is sent while it waits', () => withGame(`
game.busy = true
file({callQuest()}); play.restore()
step(120)
assert(game.ringCalls == 0 and #game.phones == 0 and count('call:ring:ringing') == 0, 'never rang while busy')
game.busy = false
step(2.2)
assert(game.ringCalls == 1 and count('call:ring:ringing') == 1)
assert(game.rings[1].key == 'panam-palmer' and game.rings[1].voice == false)
`));

test('a call during V own call never starts: an open call of the player counts as busy', () => withGame(`
game.call = {serial = 99, key = 'judy-alvarez', state = 'connected'}
file({callQuest()}); play.restore()
step(60); assert(game.ringCalls == 0)
hangUp(); step(1.2); assert(game.ringCalls == 1)
`));

test('picked up: answered, the call flag is on, the steps play (a line, a gap that waits, an event, a line), the hang-up step ends the call, done follows', () => withGame(`
file({callQuest()}); play.restore(); step(1.2)
assert(game.call.state == 'ringing' and game.flag == false)
pickUp(); step(1.2)
assert(count('call:ring:answered') == 1 and game.flag == true)
-- The first word comes after a short pause, as a line of the holocall channel spoken by the character.
assert(#game.started == 0)
step(1.2)
assert(lineIds() == 'C.1' and game.started[1].channel == 'holocall' and game.started[1].profileKey == 'panam-palmer', lineIds())
step(30); assert(lineIds() == 'C.1', 'nothing moves until the line is heard')
lineDone()
assert(count('line:C.1:done') == 1 and count('gap:g1:open') == 1, names())
assert(lines.gap('panam-sunset-coffee').id == 'g1', 'the call waits in the gap')
step(30); assert(count('mid') == 0 and lineIds() == 'C.1')
step(32); assert(count('gap:g1:resume') == 1 and count('mid') == 1, names())
step(1.5); assert(lineIds() == 'C.1,C.2', lineIds())
assert(game.call ~= nil and count('call:ring:done') == 0)
lineDone()
assert(count('call:ring:done') == 1, names())
assert(game.call == nil and game.ends[1] == '1:scripted', 'the hang-up step ends the call at once')
assert(game.flag == false and count('call:ring:hung-up') == 0)
step(10); assert(game.ringCalls == 1 and #game.phones == 0)
`));

test('a gap that ends by a tag from V words (no resume event) lets the call go on', () => withGame(`
file({callQuest()}); play.restore(); step(1.2); pickUp(); step(2.4); lineDone()
assert(lines.gap('panam-sunset-coffee') ~= nil)
-- the bridge reads a tag: gap:g1:shared closes the gap without a resume event of the game
play.emitPack('panam-sunset-coffee', 'gap:g1:shared', {report = false})
assert(lines.gap('panam-sunset-coffee') == nil)
step(1.2)
assert(count('mid') == 1, names())
`));

test('the last step ends the call after her last word when there is no hang-up step, with done first', () => withGame(`
file({callQuest({calls = {c1 = {caller = 'self', picture = 'voice', text = 'T.1', steps = {{say = 'C.1'}}}}})}); play.restore(); step(1.2)
assert(game.rings[1].voice == true, 'a voice picture is a voice call')
pickUp(); step(2.4); lineDone()
assert(count('call:ring:done') == 1 and game.call ~= nil, 'done, the call is still up for a breath')
step(3.2); assert(game.call == nil and game.ends[1] == '1:scripted')
assert(game.flag == false)
`));

test('V hangs up early: hung-up, the call onHangUp event, the waiting lines are dropped, and no done', () => withGame(`
file({callQuest()}); play.restore(); step(1.2); pickUp(); step(2.4)
assert(lineIds() == 'C.1')
local request = game.lastRequest
hangUp('hangup')
step(1.2)
assert(count('call:ring:hung-up') == 1 and count('ring-failed') == 1 and count('call:ring:done') == 0, names())
assert(game.flag == false)
-- The line in the air ends with the call: it is not played again.
lines.stopped(request, 'speaker-gone')
step(10); assert(lineIds() == 'C.1' and not lines.pending(), lineIds())
-- And nothing rings again by itself.
assert(game.ringCalls == 1)
`));

test('any other end of the call while it plays (combat, a game call) is also hung-up', () => withGame(`
file({callQuest()}); play.restore(); step(1.2); pickUp(); step(2.4)
hangUp('quest-call'); step(1.2)
assert(count('call:ring:hung-up') == 1 and logged('quest-call'))
`));

test('not picked up in ringSeconds: the ring is ended, missed, the text goes out with the pack own words, texted, and the call plays when V calls', () => withGame(`
file({callQuest()}); play.restore(); step(1.2)
step(7); assert(count('call:ring:missed') == 0 and game.call ~= nil, 'still ringing at 9 s')
step(5.2)
assert(count('call:ring:missed') == 1 and game.call == nil and game.ends[1] == '1:scripted', names())
assert(#game.phones == 1 and game.phones[1].key == 'panam-palmer' and game.phones[1].text == 'Pick up. Call me.', 'the call text, as the pack wrote it')
assert(count('call:ring:texted') == 1 and game.hook ~= nil and game.hookSets == 1)
step(30); assert(game.ringCalls == 1 and #game.phones == 1, 'one ring, one text')
-- V calls her: the same steps play (call-script behaviour).
vCalls(); step(0.1)
assert(count('call:ring:answered') == 1 and game.flag == true and game.hook == nil, 'the hook is taken away once the call is on')
step(2.4); assert(lineIds() == 'C.1')
lineDone(); step(62); step(2.5); lineDone()
assert(count('call:ring:done') == 1, names())
step(3.2); assert(game.call == nil)
`));

test('the game cannot start a call: the text goes out at once (no missed), and the call plays when V calls', () => withGame(`
game.ringFails = true
file({callQuest()}); play.restore(); step(1.2)
assert(count('call:ring:ringing') == 0 and count('call:ring:missed') == 0 and count('call:ring:texted') == 1)
assert(#game.phones == 1 and game.phones[1].text == 'Pick up. Call me.')
assert(logged('cannot ring'))
step(10); assert(game.ringCalls == 1, 'not tried again')
vCalls(); step(2.4); assert(lineIds() == 'C.1')
`));

test('the text is the first line of the call when the call names none, and text = false sends none', () => withGame(`
game.ringFails = true
local steps = {{say = 'C.2'}, {say = 'C.1'}}
file({callQuest({calls = {c1 = {caller = 'self', steps = steps}}})}); play.restore(); step(1.2)
assert(#game.phones == 1 and game.phones[1].text == 'See you.')
assert(count('call:ring:texted') == 1)
`));
test('text = false: no message, no texted event, but the call still plays when V calls', () => withGame(`
game.ringFails = true
file({callQuest({['do'] = {{p = 'call-in', id = 'ring', call = 'c1', text = false}}})}); play.restore(); step(1.2)
assert(#game.phones == 0 and count('call:ring:texted') == 0 and game.hook ~= nil)
vCalls(); step(0.1); assert(count('call:ring:answered') == 1)
`));

test('a ring the game cut (a game call took the window) is missed too', () => withGame(`
file({callQuest()}); play.restore(); step(1.2)
hangUp('quest-call'); step(1.2)
assert(count('call:ring:missed') == 1 and count('call:ring:texted') == 1)
`));

test('call-script: nothing happens until V calls the character, then the steps play and the call ends after the last', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore()
step(30); assert(game.ringCalls == 0 and #game.started == 0 and game.hook ~= nil and game.hookSets == 1)
-- A call to another character is not hers.
vCalls('judy-alvarez'); step(3); assert(#game.started == 0 and count('call:cs:answered') == 0)
hangUp()
local serial = vCalls('panam-palmer')
step(0.1); assert(count('call:cs:answered') == 1 and game.flag == true)
step(2.4); assert(lineIds() == 'C.1' and game.started[1].channel == 'holocall')
lineDone(); step(62); step(2.5); lineDone()
assert(count('call:cs:done') == 1 and game.call == nil and game.ends[#game.ends] == serial .. ':scripted', names())
assert(game.flag == false)
-- It plays once.
vCalls('panam-palmer'); step(5); assert(count('call:cs:answered') == 1)
`));

test('call-script: V hangs up mid-call is hung-up, and a quest call (a ring of the quest itself) is not taken for V call', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
game.hook('panam-palmer', {serial = 5, quest = true}); step(2); assert(count('call:cs:answered') == 0, 'a quest call does not start a call-script')
vCalls(); step(2.4); hangUp(); step(1.2)
assert(count('call:cs:hung-up') == 1 and count('ring-failed') == 1 and count('call:cs:done') == 0, names())
`));

test('the lines wait while V talks, and the call goes on afterwards', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
vCalls(); game.linesBusy = true; step(15)
assert(#game.started == 0, 'V is talking: nothing is said')
game.linesBusy = false; step(1.2); assert(lineIds() == 'C.1')
`));

test('a call line that is cut is played again, twice, then counts as heard so the call goes on', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
vCalls(); step(2.4); assert(lineIds() == 'C.1')
lines.stopped(game.lastRequest, 'manual-priority'); step(2); assert(lineIds() == 'C.1,C.1', lineIds())
lines.stopped(game.lastRequest, 'manual-priority'); step(2); assert(lineIds() == 'C.1,C.1,C.1')
lines.stopped(game.lastRequest, 'manual-priority'); step(0.1)
assert(count('line:C.1:done') == 1 and lines.gap('panam-sunset-coffee') ~= nil, 'heard enough: the gap step follows')
`));

test('one call at a time: a second call-in (another pack) waits until the first call is over', () => withGame(`
local other = callQuest({pack = 'judy-pack', character = 'judy-alvarez', lines = {['J.1'] = {kind = 'say', channel = 'holocall', text = 'Hi.'}},
  calls = {c2 = {steps = {{say = 'J.1'}}}}, ['do'] = {{p = 'call-in', id = 'jring', call = 'c2'}}})
file({callQuest(), other}); play.restore(); step(1.2)
assert(game.ringCalls == 1 and game.rings[1].key == 'panam-palmer' or game.rings[1].key == 'judy-alvarez')
local first = game.rings[1].key
step(5); assert(game.ringCalls == 1, 'the second waits while the first rings')
-- the first is picked up, plays, ends
game.call.state = 'connected'; step(3)
assert(game.ringCalls == 1, 'and while it plays')
hangUp(); step(3.2)
assert(game.ringCalls == 2 and game.rings[2].key ~= first, 'the second rings after the first is over')
`));

test('the end of the stage while it rings hangs the ring up and takes everything back', () => withGame(`
file({callQuest()}); play.restore(); step(1.2); assert(game.call ~= nil)
file({}); play.onPlayRevision()
assert(game.call == nil and game.ends[1] == '1:scripted' and game.flag == false)
local status = prims.calls.status()
assert(status.running == nil and #status.watchers == 0)
step(30); assert(game.ringCalls == 1)
`));

test('the end of the stage while the call plays hangs it up, drops what waits, and raises nothing more', () => withGame(`
file({callQuest()}); play.restore(); step(1.2); pickUp(); step(2.4)
assert(lineIds() == 'C.1' and game.flag == true)
file({}); play.onPlayRevision()
assert(game.call == nil and game.ends[1] == '1:scripted' and game.flag == false)
assert(prims.calls.status().running == nil)
local before = names()
step(10); assert(names() == before)
`));

test('a new stage (a new serial) reaps the old one call-script without hanging up V own call', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
vCalls(); step(2.4); assert(lineIds() == 'C.1')
local open = game.call
file({callQuest({serial = 2, stage = 'other', ['do'] = {}})}); play.onPlayRevision()
assert(game.call == open and #game.ends == 0, 'V\\'s call is left alone')
assert(game.flag == false and prims.calls.status().running == nil and game.hook == nil)
`));

test('the hook is held only while something waits for V call: reaping the last watcher takes it away', () => withGame(`
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
assert(game.hook ~= nil and game.hookSets == 1)
file({}); play.onPlayRevision()
assert(game.hook == nil and game.unhooks == 1)
`));

test('nothing runs per frame: neither primitive ticks faster than once a second, and an idle call-script does nothing at its tick', () => withGame(`
assert(prims.get('call-in').interval == 1 and prims.get('call-script').interval == 1)
file({callQuest({['do'] = {{p = 'call-script', id = 'cs', call = 'c1'}}})}); play.restore(); step(1)
local reads = game.ringCalls
step(60)
assert(game.ringCalls == reads and game.hookSets == 1)
`));

test('a call that names a missing call or no line player arms nothing and says so', () => withGame(`
file({callQuest({['do'] = {{p = 'call-in', id = 'ring', call = 'nope'}}})}); play.restore(); step(3)
assert(game.ringCalls == 0 and logged('is not in the stage'))
`));

test('the natives: a fake holocall module answers the world calls (ring, state, open, end, flag, hook), guarded', () => run(`
local W = ${load('quest-world-calls.lua')}
${base}
local finished = {}
local module = {catalog = {judy = {key = 'judy-alvarez'}}, call = nil}
function module.start(player, contact, sample, waited, opts)
  module.started = {contact = contact, opts = opts}
  module.call = {serial = 4, key = 'x', state = 'dialing', incoming = opts.incoming}
  return true
end
function module.finish(player, reason) finished[#finished + 1] = reason; module.lastEnd = {serial = module.call.serial, reason = reason}; module.call = nil; return true end
convaiHolocall = module
Game = {GetPlayer = function() return {} end}
local world = W.new({log = log})
-- a rule that cannot be read is busy
assert(world.callBusy() == true)
convaiQuestLineBusy = function() return false end
assert(world.callBusy() == false)
convaiQuestLineBusy = function() error('x') end
assert(world.callBusy() == true)
-- ring: the catalogue contact for a shipped character, the profile key for a Chat row
assert(world.callRing('judy-alvarez', {voice = true}) == 4)
assert(module.started.contact == 'judy' and module.started.opts.incoming == true and module.started.opts.quiet == true and module.started.opts.quest == true and module.started.opts.voice == true)
assert(world.callRing('rita', nil) == false, 'a call is open')
assert(world.callState(4) == 'ringing')
module.call.state = 'connected'
assert(world.callState(4) == 'connected')
local open = world.callOpen()
assert(open.serial == 4 and open.key == 'x' and open.quest == false)
assert(world.callEnd(5, 'scripted') == false and #finished == 0, 'another serial is not ours')
assert(world.callEnd(4, 'scripted') and finished[1] == 'scripted')
local state, why = world.callState(4); assert(state == 'ended' and why == 'scripted')
assert(world.callOpen() == nil)
module.start = function(...) module.call = nil; return false end
assert(world.callRing('rita') == false)
world.callLines(true); assert(convaiQuestCallLines == true)
world.callLines(false); assert(convaiQuestCallLines == nil)
local called = 0
local release = world.callHook(function() called = called + 1 end)
module.onCallStarted('a', {}); assert(called == 1)
release(); assert(module.onCallStarted == nil)
-- no holocall module: nothing, and nothing raises
convaiHolocall = nil
assert(world.callRing('x') == false and world.callState(1) == 'ended' and world.callOpen() == nil and world.callEnd(1) == false and world.callHook(function() end) == nil)
`));
