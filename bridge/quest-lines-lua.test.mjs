// The scripted line player of the bond quests, the game half (mod/quest-lines.lua, docs/QUEST_PRIMITIVES.md section 5, BOND_QUESTS.md 14.4 and 14.5): one voice at a
// time, barks and plot lines, the talk gap, and the Phone Chat text rows. Run on a fake game (a clock, a busy flag, the request the game would send); nothing here
// starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base} from './quest-lua-fixture.mjs';

const harness = `
local M = ${load('quest-lines.lua')}
${base}
local game = {now = 0, gameClock = 100000, busy = false, nextId = 1, started = {}, startFail = nil, alive = {}, subtitles = {}, phones = {}, phoneOk = true,
  events = {}, idle = {}, changes = 0, busyAsks = 0}
local lines = M.new({
  clock = function() return game.now end,
  gameTime = function() return game.gameClock end,
  busy = function() game.busyAsks = game.busyAsks + 1; return game.busy end,
  start = function(entry)
    if game.startFail then return nil, game.startFail end
    local id = 'r' .. game.nextId; game.nextId = game.nextId + 1
    game.started[#game.started + 1] = {entry = entry, id = id}
    return id
  end,
  alive = function(id) return game.alive[id] ~= false end,
  subtitle = function(key, text) game.subtitles[#game.subtitles + 1] = key .. ': ' .. text end,
  phone = function(key, text, image) if not game.phoneOk then return false end game.phones[#game.phones + 1] = {key = key, text = text, image = image}; return true end,
  emit = function(pack, name) game.events[#game.events + 1] = pack .. '|' .. name end,
  idle = function(key, idle, on) game.idle[#game.idle + 1] = key .. ':' .. idle .. ':' .. tostring(on) end,
  onChange = function() game.changes = game.changes + 1 end,
  log = log,
})
local image = {atlas = 'cyberpunk_convai\\\\phone_images\\\\sunset.inkatlas', part = 'sunset', width = 100, height = 50}
lines.setPack('pk', {character = 'panam-palmer', serial = 3,
  lines = {
    ['P1.a'] = {kind = 'say', text = 'You actually came.', channel = 'own'},
    ['P1.b'] = {kind = 'say', text = 'Sit, then.', channel = 'own'},
    ['P1.c'] = {kind = 'say', text = 'Third.', channel = 'own'},
    ['B.1'] = {kind = 'say', bark = true, text = 'Lookout up ahead.'},
    ['B.2'] = {kind = 'say', bark = true, text = 'Nearly there.'},
    ['J.1'] = {kind = 'say', speaker = 'judy-alvarez', text = 'Hey, V.'},
    ['T.1'] = {kind = 'text', text = 'Look at this sky.', image = 'sunset'},
    ['T.2'] = {kind = 'text', text = 'No picture.', image = 'missing'},
  },
  gaps = {g1 = {idle = 'seat', resumeAfterSeconds = 600, resumeOn = {'together:sunrise:done'}}, g2 = {}},
  images = {sunset = image}})
local function advance(seconds) for _ = 1, math.floor(seconds * 10 + 0.5) do game.now = game.now + 0.1; lines.update(0.1) end end
local function eventCount(text) local n = 0 for _, e in ipairs(game.events) do if e == text then n = n + 1 end end return n end
`;
const withGame = code => run(`${harness}\n${code}`);

test('a line starts at once when nothing is going on, as a private turn of its speaker, and only one plays at a time', () => withGame(`
assert(lines.say('pk', 'P1.a', {}))
assert(#game.started == 1 and game.started[1].entry.id == 'P1.a' and game.started[1].entry.profileKey == 'panam-palmer' and game.started[1].entry.channel == 'own')
assert(lines.busy() and lines.active().requestId == 'r1' and lines.active().id == 'P1.a')
lines.say('pk', 'P1.b', {}); lines.say('pk', 'P1.c', {})
advance(30); assert(#game.started == 1, 'never two at once')
-- It ends heard to its end: done is reported, the next starts after a short pause.
assert(lines.stopped('r1', 'finished'))
assert(eventCount('pk|line:P1.a:done') == 1)
assert(#game.started == 1)
advance(0.5); assert(#game.started == 1, 'a breath between lines')
advance(1); assert(#game.started == 2 and game.started[2].entry.id == 'P1.b')
assert(not lines.stopped('r1', 'finished'), 'an old request is nothing')
`));

test('a speaker of the line other than the pack character, a bad line and an unknown pack', () => withGame(`
assert(lines.say('pk', 'J.1', {}) and game.started[1].entry.profileKey == 'judy-alvarez')
assert(not lines.say('pk', 'nope', {}) and logged('unknown line'))
assert(not lines.say('nope', 'P1.a', {}))
assert(not lines.setPack('Bad Pack', {}) and not lines.setPack('pk', 'x'))
`));

test('never starts while busy: V talking, a reply, an automatic remark, a scene (the game says busy), and starts when it is free', () => withGame(`
game.busy = true
lines.say('pk', 'P1.a', {})
advance(10); assert(#game.started == 0 and game.busyAsks > 0)
game.busy = false; advance(1); assert(#game.started == 1)
`));

test('a bark waits at most 4 s and is then dropped, a plot line waits and is shown as a subtitle after 20 s, played at the next silence', () => withGame(`
game.busy = true
lines.say('pk', 'B.1', {}); lines.say('pk', 'P1.a', {})
advance(3.5); assert(lines.status().waiting[1] ~= nil and #lines.status().waiting == 2)
advance(1.5); assert(#lines.status().waiting == 1 and lines.status().waiting[1].id == 'P1.a' and logged('bark B.1 dropped'), 'the bark is gone')
game.busy = false; advance(0);
game.busy = true
advance(14); assert(#game.subtitles == 0, 'not yet')
advance(2); assert(#game.subtitles == 1 and game.subtitles[1] == 'panam-palmer: You actually came.', game.subtitles[1])
advance(30); assert(#game.subtitles == 1, 'shown once')
assert(#game.started == 0 and #lines.status().waiting == 1, 'still waiting')
game.busy = false; advance(1); assert(#game.started == 1 and game.started[1].entry.id == 'P1.a', 'played at the next silence')
`));

test('barks: a newer bark replaces a waiting one, and none waits behind a plot line of the same speaker', () => withGame(`
game.busy = true
lines.say('pk', 'B.1', {}); lines.say('pk', 'B.2', {})
assert(#lines.status().waiting == 1 and lines.status().waiting[1].id == 'B.2')
lines.say('pk', 'P1.a', {})
assert(not lines.say('pk', 'B.1', {}), 'a bark behind a plot line is dropped')
assert(#lines.status().waiting == 2)
-- Plot first, then the bark.
game.busy = false; advance(0.6)
assert(game.started[1].entry.id == 'P1.a')
-- Another speaker's bark is its own slot.
game.busy = true
lines.say('pk', 'J.1', {}); lines.say('pk', 'B.1', {bark = true})
local n = 0 for _, w in ipairs(lines.status().waiting) do n = n + 1 end
assert(n == 2, 'the plot line of another speaker and the bark of this one: ' .. n)
`));

test('the plot queue holds four per speaker and drops the fifth', () => withGame(`
game.busy = true
for i = 1, 4 do assert(lines.say('pk', i % 2 == 0 and 'P1.a' or 'P1.b', {})) end
assert(not lines.say('pk', 'P1.c', {}) and logged('queue is full'))
`));

test('a plot line that was cut waits to be played again twice, then it is shown and the script moves on; a bark that was cut is dropped', () => withGame(`
lines.say('pk', 'P1.a', {})
lines.stopped('r1', 'manual-priority'); assert(eventCount('pk|line:P1.a:done') == 0)
advance(1.6); assert(#game.started == 2)
lines.stopped('r2', 'scripted-expired'); advance(1.6); assert(#game.started == 3)
lines.stopped('r3', 'lost'); assert(eventCount('pk|line:P1.a:done') == 1 and game.subtitles[1] == 'panam-palmer: You actually came.')
advance(3); assert(#game.started == 3)
lines.say('pk', 'B.1', {}); advance(1.6); local id = lines.active().requestId
lines.stopped(id, 'manual-priority'); advance(3)
assert(#game.started == 4 and lines.active() == nil and eventCount('pk|line:B.1:done') == 0, 'a bark is not played again and says nothing')
`));

test('a speaker that is not there: a bark is dropped, a plot line is shown after 20 s, and given up as a text after ten minutes', () => withGame(`
game.startFail = 'no-speaker'
lines.say('pk', 'B.1', {}); lines.say('pk', 'P1.a', {})
advance(5); assert(#lines.status().waiting == 1 and lines.status().waiting[1].why == 'no-speaker')
advance(16); assert(#game.subtitles == 1)
advance(590); assert(#lines.status().waiting == 0 and #game.phones == 1 and game.phones[1].text == 'You actually came.')
assert(eventCount('pk|line:P1.a:done') == 1)
`));

test('a line whose request vanished without a word is lost after three looks', () => withGame(`
lines.say('pk', 'P1.a', {})
game.alive['r1'] = false
advance(1); assert(lines.active() ~= nil, 'two looks')
advance(1); assert(lines.active() == nil, 'three looks, it is lost and waits to be played again')
advance(2); assert(#game.started == 2)
`));

test('a text row goes to the phone with the picture the pack names, a missing picture is a plain text, a phone that is not ready is tried again', () => withGame(`
assert(lines.text('pk', 'T.1', nil))
assert(#game.phones == 1 and game.phones[1].key == 'panam-palmer' and game.phones[1].text == 'Look at this sky.' and game.phones[1].image.part == 'sunset')
assert(eventCount('pk|line:T.1:done') == 1)
lines.text('pk', 'T.2', nil); assert(game.phones[2].text == 'No picture.' and game.phones[2].image == nil)
lines.text('pk', 'T.2', 'sunset'); assert(game.phones[3].image.part == 'sunset', 'the row names the picture')
game.phoneOk = false
lines.text('pk', 'T.1', nil); assert(#game.phones == 3 and lines.pending())
advance(2.5); assert(#game.phones == 3)
game.phoneOk = true; advance(2); assert(#game.phones == 4 and eventCount('pk|line:T.1:done') == 2 and not lines.pending())
-- Never delivered: given up after ten tries, the script still moves on.
game.phoneOk = false
lines.text('pk', 'T.2', nil); advance(30)
assert(not lines.pending() and logged('could not be delivered') and eventCount('pk|line:T.2:done') == 3)
assert(not lines.text('pk', 'nope', nil))
`));

test('the gap: open reports gap:<id>:open, starts the idle, holds the floor for the others, ends by its timer in game seconds', () => withGame(`
assert(lines.openGap('pk', 'g1'))
assert(eventCount('pk|gap:g1:open') == 1 and lines.busy() and lines.gapOpen() and lines.gap('pk').id == 'g1')
assert(game.idle[1] == 'panam-palmer:seat:true')
game.gameClock = game.gameClock + 599; advance(1); assert(lines.gapOpen(), 'not yet')
game.gameClock = game.gameClock + 2; advance(1)
assert(not lines.gapOpen() and not lines.busy() and eventCount('pk|gap:g1:resume') == 1 and game.idle[2] == 'panam-palmer:seat:false')
advance(10); assert(eventCount('pk|gap:g1:resume') == 1, 'once')
`));

test('the gap ends by a resumeOn event, by a gap:<id>:<tag> event from the bridge (no echo), by a command, and a gap with no timer never stalls the others', () => withGame(`
lines.openGap('pk', 'g1'); lines.onEvent('pk', 'something:else'); assert(lines.gapOpen())
lines.onEvent('pk', 'gap:g1:open'); assert(lines.gapOpen(), 'its own open event does not end it')
lines.onEvent('pk', 'together:sunrise:done')
assert(not lines.gapOpen() and eventCount('pk|gap:g1:resume') == 1)
lines.openGap('pk', 'g1'); lines.onEvent('pk', 'gap:g1:shared')
assert(not lines.gapOpen() and eventCount('pk|gap:g1:resume') == 1, 'the bridge already said it: no second resume')
lines.openGap('pk', 'g2'); lines.onEvent('pk', 'gap:g1:shared'); assert(lines.gapOpen(), 'another gap id is not this gap')
assert(lines.closeGap('pk', 'g2', true) and eventCount('pk|gap:g2:resume') == 1)
assert(not lines.closeGap('pk', 'g2', true), 'closing twice')
-- No game clock: the real clock counts.
game.gameClock = nil
lines.openGap('pk', 'g1'); advance(601); assert(not lines.gapOpen(), 'a gap never stalls')
`));

test('a gap restored after a load opens silently from its stamp, a stage change closes it silently, a line plays inside a gap', () => withGame(`
lines.restoreGap('pk', 'g1', game.gameClock - 590)
assert(lines.gapOpen() and eventCount('pk|gap:g1:open') == 0)
game.gameClock = game.gameClock + 15; advance(1); assert(not lines.gapOpen(), 'its time ran from the stamp')
local resumes = eventCount('pk|gap:g1:resume')
lines.openGap('pk', 'g1'); lines.say('pk', 'P1.a', {}); assert(#game.started == 1, 'the busy test is the game, an open gap does not stop its own quest')
lines.dropPack('pk')
assert(not lines.gapOpen() and eventCount('pk|gap:g1:resume') == resumes, 'closed without a word')
assert(lines.active() ~= nil, 'a plot line in the air goes on')
`));

test('dropPack takes the barks of a stage away and keeps its plot lines; reset forgets everything', () => withGame(`
game.busy = true
lines.say('pk', 'B.1', {}); lines.say('pk', 'P1.a', {}); lines.say('pk', 'J.1', {bark = true})
lines.dropPack('pk')
assert(#lines.status().waiting == 1 and lines.status().waiting[1].id == 'P1.a')
lines.openGap('pk', 'g1')
lines.reset(); assert(not lines.pending() and not lines.busy() and not lines.gapOpen())
`));

test('idle costs a nil check: nothing waiting, playing or open asks the game anything', () => withGame(`
advance(60)
assert(game.busyAsks == 0 and game.changes == 0 and not lines.pending())
`));

test('the module is plain Lua 5.1 with no semicolon in a comment', () => {
  const text = source('quest-lines.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
});
