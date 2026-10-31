// The wiring of the bond quest modules into the game's Lua (docs/QUEST_PRIMITIVES.md): the bonds status file's playRevision, the Phone Chat row of a scripted text,
// the developer probe, the glue block of mod/init.lua (run over stand-ins for the locals it uses) and the few lines elsewhere in init.lua that call it. Nothing here
// starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, read, base} from './quest-lua-fixture.mjs';

const init = read('../mod/init.lua');
const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};

// ---- bonds.lua: the optional playRevision of the status file -------------------------------------------------------------------------------------------
const bondsHarness = `
local M = ${load('bonds.lua')}
${base}
local game = {now = 100, files = {}, revisions = 0, throw = false}
local function setStatus(value) game.files[M.STATUS] = serialize(value) end
local options = {
  enabled = function() return true end, clock = function() return game.now end, gameTime = function() return 50000 end,
  read = function(path) return game.files[path] end, write = function() return true end, encode = serialize, decode = decode,
  notice = function() end, log = log, t = function(text) return text end,
  onPlayRevision = function() game.revisions = game.revisions + 1; if game.throw then error('quest module broke') end end,
}
local bonds = M.new(options)
local function tick(seconds) for _ = 1, seconds * 10 do game.now = game.now + 0.1; bonds.update('V') end end
`;
test('bonds: a new playRevision in the status file calls onPlayRevision once, an unchanged or missing one does not, a raising callback is guarded', () => run(`${bondsHarness}
setStatus({version = 1, revision = 1, changes = {}})
bonds.attach({entity = '7', profileKey = 'judy-alvarez'}); tick(2)
assert(game.revisions == 0, 'no playRevision: nothing')
setStatus({version = 1, revision = 2, playRevision = 4, changes = {}}); tick(2); assert(game.revisions == 1)
setStatus({version = 1, revision = 3, playRevision = 4, changes = {}}); tick(2); assert(game.revisions == 1, 'same revision')
setStatus({version = 1, revision = 4, playRevision = 5, changes = {}}); tick(2); assert(game.revisions == 2)
game.throw = true
setStatus({version = 1, revision = 5, playRevision = 6, changes = {}}); tick(2); assert(game.revisions == 3 and logged('play revision failed'))
for _, bad in ipairs({'x', -1, 1.5, {}}) do setStatus({version = 1, revision = 6, playRevision = bad, changes = {}}); tick(2) end
assert(game.revisions == 3, 'a malformed revision is nothing')
-- No callback at all: a plain status file works as before.
options.onPlayRevision = nil
local other = M.new(options); other.attach({entity = '7', profileKey = 'judy-alvarez'})
setStatus({version = 1, revision = 7, playRevision = 9, changes = {}}); for _ = 1, 20 do game.now = game.now + 0.1; other.update('V') end
`));

// ---- phone-chat.lua: a scripted text -------------------------------------------------------------------------------------------------------------------
const chatSource = source('phone-chat.lua');
const chatHarness = `
json = {decode = function(raw) return raw end, encode = function(v) return v end}
io.open = function() return nil end
NewObject = function() return {} end
os.time = function() return 100 end
local chat = (function() ${chatSource} end)()
local F = chat.IMAGE_FOLDER
`;
test('phone chat: deliverScripted adds a received row (with a picture the folder can hold, or plain), and refuses before the chats are bound, for no contact and for a switched off character', () => run(`${chatHarness}
chat.catalog = {judy = 'judy-alvarez'}
assert(chat.deliverScripted('judy-alvarez', 'hello', nil) == false, 'the saved chats are not bound yet')
chat.bucket = {}
local ok, contact = chat.deliverScripted('judy-alvarez', 'look at this', {atlas = F .. 'card_wide.inkatlas', part = 'card_wide', width = 1024, height = 576})
assert(ok == true and contact == 'judy')
local row = chat.history.judy[1]
assert(row.text == 'look at this' and row.sent == false and row.image.part == 'card_wide' and chat.dirty == true)
assert(chat.deliverScripted('judy-alvarez', 'plain', nil) == true and chat.history.judy[2].image == nil)
assert(chat.deliverScripted('judy-alvarez', 'bad picture', {atlas = 'base\\\\x.inkatlas', part = 'x', width = 1, height = 1}) == true and chat.history.judy[3].image == nil, 'a picture outside the folder is a plain text')
assert(chat.deliverScripted('nobody', 'x', nil) == false and chat.deliverScripted('judy-alvarez', '', nil) == false and chat.deliverScripted('judy-alvarez', string.rep('x', 6001), nil) == false)
assert(#chat.history.judy == 3)
chat.manager = {profileEnabled = function() return false end}
assert(chat.deliverScripted('judy-alvarez', 'off', nil) == false and #chat.history.judy == 3)
`));

// ---- the developer probe -------------------------------------------------------------------------------------------------------------------------------
const probeHarness = `
local M = ${load('quest-probe.lua')}
${base}
local files = {}
json = {encode = serialize, decode = decode}
io.open = function(path, mode)
  if mode == 'rb' then
    if files[path] == nil then return nil end
    return {read = function() return files[path] end, close = function() end}
  end
  return {write = function(_, text) files[path] = text end, close = function() end}
end
local interior = false
Game = {IsEntityInInteriorArea = function() return interior end}
local at = {x = 10.123, y = 20.456, z = 3.14159}
local env = {player = {GetWorldPosition = function() return at end}}
local calls = {}
convaiQuestWorld = {district = function() return {district = 'Badlands', area = 'RockyRidge'} end}
convaiQuestPlay = {status = function() return {armed = true} end, inject = function(name) calls[#calls + 1] = 'inject ' .. name; return 2 end,
  reapAll = function(why) calls[#calls + 1] = 'reap ' .. tostring(why) end}
convaiQuestLines = {playNow = function(pack, id) calls[#calls + 1] = 'line ' .. pack .. ' ' .. id; return true end, status = function() return {waiting = {}} end}
`;
test('probe: status, capture merges a place under its id for a pack, event and line and reap reach the quest module', () => run(`${probeHarness}
local r = M.run('status', env); assert(r.loaded == true and r.status.armed == true and r.world == true)
r = M.run('capture:lookout', env)
assert(r.captured == 'lookout' and r.place.x == 10.12 and r.place.y == 20.46 and r.place.z == 3.14 and r.place.radius == 25 and r.place.district == 'Badlands' and r.place.area == 'RockyRidge' and r.place.captured == true)
interior = true; at = {x = 1, y = 2, z = 3}
r = M.run('capture:flat', env); assert(r.place.radius == 8 and r.interior == true)
local saved = decode(files['runtime/quest-place-capture.json'])
assert(saved.version == 1 and saved.places.lookout.x == 10.12 and saved.places.flat.radius == 8, 'both captures are kept')
at = {x = 7, y = 7, z = 7}; interior = false; M.run('capture:lookout', env)
assert(decode(files['runtime/quest-place-capture.json']).places.lookout.x == 7, 'a capture again replaces the place of that id')
assert(not pcall(M.run, 'capture:Bad Id', env) and not pcall(M.run, 'capture:', env))
r = M.run('event:place:lookout:arrived', env); assert(r.quests == 2 and calls[1] == 'inject place:lookout:arrived')
r = M.run('line:panam-sunset-coffee:P1.walk.02', env); assert(r.queued == true and calls[2] == 'line panam-sunset-coffee P1.walk.02')
M.run('reap', env); assert(calls[3] == 'reap probe')
assert(not pcall(M.run, 'nonsense', env) and not pcall(M.run, 'event:Bad Name!', env) and not pcall(M.run, 'line:onlyone', env))
convaiQuestPlay = nil
assert(M.run('status', env).loaded == false)
assert(not pcall(M.run, 'event:x', env) and not pcall(M.run, 'reap', env))
`));

test('the probe is a feature of the developer mailbox and its ids may carry dots', () => {
  const probe = source('johnny-probe.lua');
  assert.match(probe, /quest = 'quest-probe\.lua'/);
  assert.match(probe, /action:match\('\^\[%w%-:_%.\]\+\$'\)/);
  run(`
    local P = (function() ${probe} end)()
    local feature, action = P.parse('johnny-probe:quest:line:panam-sunset-coffee:P1.walk.02:20261029120000000')
    assert(feature == 'quest' and action == 'line:panam-sunset-coffee:P1.walk.02', tostring(action))
    assert(P.parse('johnny-probe:relic:st art:1') == nil)
  `.replace(/^/, `manager = {developerMode = function() return true end}\n`));
});

// ---- the glue block of init.lua ----------------------------------------------------------------------------------------------------------------------
const block = between('-- ---- Bond quests (docs/QUEST_PRIMITIVES.md, mod/quest-play.lua)', "-- A story pack can take a character's own car away for a while");
const glueHarness = `
${base}
local game = {on = true, loads = {}, failLoad = nil, updates = {}, restores = 0, sweeps = 0, abandons = 0, requests = {}, canceled = {}, notices = {}, subtitles = {}, phones = {}, throwUpdate = false,
  built = {}, reachBlocks = {}, reachUpdates = 0, reachResets = {}, reachEvents = {}}
local loggedOnce = {}
convaiLogOnce = function(key, line) loggedOnce[key] = (loggedOnce[key] or 0) + 1 end
local manager = {characterBonds = function() return game.on end, storyPacks = function() return game.on end, reachOuts = function() return game.reach ~= false end}
local worldKnowledgeModule = {nativeGameTime = function() return 100000 end}
local currentDistrict = function() return {district = 'Badlands'} end
local convaiSeating = nil
local managerUi = {party = function() return {} end}
local companions = {
  conversationCandidates = function(player, radius)
    if game.noSpeaker then return {} end
    return {{profileKey = 'panam-palmer', entity = '55', name = 'Panam', bodyType = 'Female', npc = {IsAttached = function() return true end, IsDeadNoStatPool = function() return false end}}}
  end,
  definition = function(key) return {name = 'Panam Palmer'} end}
local active, pending, automatic, lastAutomatic = nil, nil, nil, nil
local groupChat, phoneChat, microphone = {round = nil}, {pending = nil}, {context = nil, state = nil}
local speech, subtitles = {requestId = nil}, {ownsUtterance = function() return false end}
local battleSample, battleOutputs = {available = true, tier = 1}, nil
local battles = {fighting = function() return false end}
local generation = 0
local function reactionOutputs(player) return {enabled = true} end
local function captureReactionGuard() end
local function reactionLease(valid) return true end
local function sendRequest(context) game.requests[#game.requests + 1] = context; return not game.sendFails end
local function cancelAutomatic(reason, abandoning) game.canceled[#game.canceled + 1] = reason .. (abandoning and '+' or ''); if automatic then local rid = automatic.requestId; local c = automatic; automatic = nil; if convaiQuestLineEnded then convaiQuestLineEnded(c, reason) end end end
local convaiNotices = {send = function(player, kind, text) game.notices[#game.notices + 1] = kind .. ':' .. text end}
subtitles.showAnyway = function(speaker, text) game.subtitles[#game.subtitles + 1] = speaker .. ': ' .. text; return true end
phoneChat.deliverScripted = function(key, text, image) game.phones[#game.phones + 1] = key .. ': ' .. text; return not game.phoneFails, 'contact' end
local Game = {GetPlayer = function() return {ConvaiComposerOpen = function() return game.composer == true end} end}
local convaiPlayer = function() return Game.GetPlayer() end
function convaiJohnnyHeadService() if game.noHead then return nil end return {name = 'Johnny Silverhand', refusal = function() return game.headRefusal end} end
local function log(line) end
local function fakeModule(name, extra)
  return {new = function(options)
    game.built[name] = options
    local object = extra or {}
    return object
  end}
end
local modules = {
  ['quest-world.lua'] = fakeModule('world', {sweep = function() game.sweeps = game.sweeps + 1; return 0 end}),
  ['quest-places.lua'] = fakeModule('places'), ['quest-prims.lua'] = fakeModule('prims'),
  ['quest-lines.lua'] = fakeModule('lines', {busy = function() return game.linesBusy == true end, stopped = function(id, reason) game.stopped = id .. ':' .. reason end}),
  ['quest-play.lua'] = fakeModule('play', {restore = function() game.restores = game.restores + 1 end, update = function(player, delta) if game.throwUpdate then error('update broke') end game.updates[#game.updates + 1] = delta end,
    abandon = function() game.abandons = game.abandons + 1 end, onPlayRevision = function() game.revisions = (game.revisions or 0) + 1 end, emitPack = function() end, rearm = function() end,
    emitReach = function(id) game.reachEvents[#game.reachEvents + 1] = id; return true end, refresh = function() game.refreshes = (game.refreshes or 0) + 1 end,
    settingOff = function() game.settingOffs = (game.settingOffs or 0) + 1 end}),
  ['quest-journal.lua'] = {new = function(options) game.built.journal = options; return {apply = function() end} end, gameWorld = function(getPlayer) return {getPlayer = getPlayer} end},
  ['quest-reach.lua'] = fakeModule('reach', {setBlock = function(block) game.reachBlocks[#game.reachBlocks + 1] = block or false end, update = function() game.reachUpdates = game.reachUpdates + 1 end,
    reset = function(why) game.reachResets[#game.reachResets + 1] = why end, districtChanged = function() end, sample = function() end}),
}
local function dofile(name)
  game.loads[#game.loads + 1] = name
  if game.failLoad == name then error('cannot compile ' .. name) end
  return modules[name]
end
${block}
`;
const withGlue = code => run(`${glueHarness}\n${code}`);

test('glue: nothing is loaded with the setting off, the world is checked once, and a tick is a nil check afterwards', () => withGlue(`
game.on = false
assert(convaiQuestDue == true and convaiQuestPlay == nil)
convaiQuestTick('V', 0.1)
assert(convaiQuestDue == false and #game.loads == 0 and convaiQuestPlay == nil, 'the setting is off: nothing is built')
convaiQuestTick('V', 0.1); assert(#game.loads == 0)
convaiQuestPlayRevision(); assert(#game.loads == 0, 'a play revision with the setting off builds nothing')
`));

test('glue: with the setting on the five modules are built once, the stage is read once (after a sweep), and each tick passes its delta to update', () => withGlue(`
convaiQuestTick('V', 0.1)
assert(table.concat(game.loads, ',') == 'quest-world.lua,quest-places.lua,quest-prims.lua,quest-lines.lua,quest-play.lua,quest-prims-action.lua,quest-prims-drive.lua,quest-prims-race.lua,quest-prims-scene.lua,quest-prims-systems.lua,quest-prims-calls.lua,quest-audio.lua,quest-journal.lua,quest-reach.lua', table.concat(game.loads, ','))
assert(game.sweeps == 1 and game.restores == 1 and convaiQuestPlay ~= nil and convaiQuestLines ~= nil and convaiQuestWorld ~= nil)
convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.2)
assert(#game.loads == 14 and game.restores == 1 and #game.updates == 3 and game.updates[3] == 0.2)
local options = game.built.play
assert(options.enabled() == true and options.places and options.lines and options.prims)
-- The real quests (mod/quest-journal.lua): built with the quest module and handed to the executor, the game world reaching the player through convaiPlayer.
assert(options.journal ~= nil and convaiQuestJournal == options.journal and game.built.journal.world.getPlayer ~= nil)
-- Settings > Companions turning Story packs off clears them at once; back on, the stage is read again.
game.on = false; convaiQuestSettingChanged(); assert(game.settingOffs == 1)
convaiQuestPlayRevision(); assert(game.settingOffs == 2, 'a play revision with the setting off clears too')
game.on = true; convaiQuestSettingChanged(); assert(game.restores == 2)
game.on = false; assert(options.enabled() == false, 'the setting is read each time')
-- The bridge's play revision reads the file now.
game.on = true; convaiQuestPlayRevision(); assert(game.revisions == 1)
-- A raising update is guarded and logged once per key.
game.throwUpdate = true; convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.1); assert(loggedOnce['quest-tick'] == 2)
`));

test('glue: a module that cannot be loaded latches (no read and compile on every tick), and the setting coming on later with the world known builds it once', () => withGlue(`
game.failLoad = 'quest-prims.lua'
convaiQuestTick('V', 0.1)
assert(convaiQuestPlay == nil and loggedOnce['quest-load'] == 1)
local loads = #game.loads
convaiQuestPlayRevision(); convaiQuestPlayRevision(); convaiQuestTick('V', 0.1)
assert(#game.loads == loads, 'not retried: ' .. #game.loads .. ' vs ' .. loads)
`));

test('glue: a world change forgets the quests without a native call and asks the next world to read the stage again', () => withGlue(`
convaiQuestTick('V', 0.1); assert(game.restores == 1 and convaiQuestDue == false)
convaiQuestReset('world unavailable')
assert(game.abandons == 1 and convaiQuestDue == true)
convaiQuestTick('V', 0.1); assert(game.restores == 2 and game.sweeps == 2, 'swept and restored in the new world')
convaiQuestPlay = nil; convaiQuestReset('again'); assert(convaiQuestDue == true)
`));

test('glue: busy for the speak-up scheduler is a gap or a line in progress, nothing else', () => withGlue(`
assert(not convaiQuestBusy())
convaiQuestTick('V', 0.1)
assert(not convaiQuestBusy()); game.linesBusy = true; assert(convaiQuestBusy())
`));

test('glue: a line may not start while V talks, a reply is made or heard, a remark plays, a scene or fight runs, a call is open or the outputs are off', () => withGlue(`
convaiQuestTick('V', 0.1)
assert(convaiQuestLineBusy() == false, 'all clear')
local function busyWith(setup, undo) setup(); local busy = convaiQuestLineBusy(); undo(); return busy end
assert(busyWith(function() active = {} end, function() active = nil end), 'a typed turn')
assert(busyWith(function() groupChat.round = {} end, function() groupChat.round = nil end), 'a group round')
assert(busyWith(function() phoneChat.pending = {} end, function() phoneChat.pending = nil end), 'a phone message')
assert(busyWith(function() microphone.context = {}; microphone.state = 'listening' end, function() microphone.context = nil end), 'the talk key')
assert(not busyWith(function() microphone.context = {}; microphone.state = 'reply' end, function() microphone.context = nil end), 'a spoken turn whose reply is coming is the reply, not V talking')
assert(busyWith(function() pending = {} end, function() pending = nil end), 'a reply on its way')
assert(busyWith(function() speech.requestId = 'x' end, function() speech.requestId = nil end), 'a reply heard')
assert(busyWith(function() automatic = {} end, function() automatic = nil end), 'an automatic remark')
assert(busyWith(function() game.composer = true end, function() game.composer = false end), 'the composer open')
assert(busyWith(function() battleSample.combat = true end, function() battleSample.combat = nil end), 'combat')
assert(busyWith(function() battleSample.blocked = true end, function() battleSample.blocked = nil end), 'a scene')
assert(busyWith(function() battleSample.dialogue = true end, function() battleSample.dialogue = nil end), 'a dialogue')
assert(busyWith(function() battleSample.tier = 3 end, function() battleSample.tier = 1 end), 'a scene tier')
assert(busyWith(function() battleSample = nil end, function() battleSample = {available = true, tier = 1} end), 'unknown is busy')
assert(busyWith(function() battles.fighting = function() return true end end, function() battles.fighting = function() return false end end), 'a fight')
assert(busyWith(function() convaiHolocall = {call = {}} end, function() convaiHolocall = nil end), 'a call')
assert(busyWith(function() convaiPartyState = {chat = {}} end, function() convaiPartyState = nil end), 'a party chat')
assert(busyWith(function() convaiHouseCurrent = {} end, function() convaiHouseCurrent = nil end), 'a housemate line')
`));

test('glue: the request of a scripted line is a private automatic turn of the speaking copy with the reaction the bridge reads, no model text, and a missing speaker is a refusal', () => withGlue(`
convaiQuestTick('V', 0.1)
local rid, why = convaiQuestLineStart({pack = 'panam-sunset-coffee', id = 'P1.walk.02', profileKey = 'panam-palmer', channel = 'own'})
assert(rid and why == nil)
local context = game.requests[1]
assert(context.requestId == rid and automatic == context and context.profileKey == 'panam-palmer' and context.entity == '55' and context.name == 'Panam')
local reaction = context.reaction
assert(reaction.kind == 'scripted' and reaction.pack == 'panam-sunset-coffee' and reaction.line == 'P1.walk.02' and reaction.channel == 'own' and reaction.expiresAt > os.time() * 1000)
assert(context.text:find('scripted') and lastAutomatic.kind == 'scripted' and lastAutomatic.requestId == rid and convaiQuestSpeaker.requestId == rid and speech.target ~= nil)
assert(convaiQuestSpeakerHere(rid) and not convaiQuestSpeakerHere('other'))
-- No speaker near: refused without a request.
automatic = nil; game.noSpeaker = true; game.requests = {}
local none, reason = convaiQuestLineStart({pack = 'p', id = 'x', profileKey = 'panam-palmer', channel = 'own'})
assert(none == nil and reason == 'no-speaker' and #game.requests == 0)
-- The request could not be written.
game.noSpeaker = false; game.sendFails = true
local failed, why2 = convaiQuestLineStart({pack = 'p', id = 'x', profileKey = 'panam-palmer', channel = 'own'})
assert(failed == nil and why2 == 'request-write-failed' and game.canceled[#game.canceled] == 'request-write-failed' and automatic == nil)
`));

test('glue: how a line ended: heard to its end is finished, a cut or expired line is not, and the speech callback finishes it at once', () => withGlue(`
convaiQuestTick('V', 0.1)
local function ended(reason, playbackAt)
  game.stopped = nil
  convaiQuestSpeaker = {requestId = 'r', npc = {}}
  convaiQuestLineEnded({requestId = 'r', playbackAt = playbackAt}, reason)
  assert(convaiQuestSpeaker == nil)
  return game.stopped
end
assert(ended('finished') == 'r:finished')
assert(ended('completed', 100) == 'r:finished', 'nothing left to play after the audio began')
assert(ended('completed', nil) == 'r:completed', 'completed with no audio at all is not heard')
assert(ended('scripted-manual-priority', 100) == 'r:scripted-manual-priority')
assert(ended('scripted-expired') == 'r:scripted-expired')
-- The speech ended: the line player hears it at once, and the automatic turn is released without stopping the speech again.
automatic = {requestId = 'r2', reaction = {kind = 'scripted'}}
game.canceled = {}; convaiQuestStopped('r2', 'finished')
assert(game.stopped == 'r2:finished' and game.canceled[1] == 'finished+', table.concat(game.canceled, ','))
game.stopped, game.canceled = nil, {}
automatic = {requestId = 'r3', reaction = {kind = 'scripted'}}
convaiQuestStopped('r3', 'manual-priority'); assert(game.stopped == nil and #game.canceled == 0, 'only a line heard to its end is handled here, cancelAutomatic tells the rest')
automatic = {requestId = 'r4', reaction = {kind = 'speakup'}}
convaiQuestStopped('r4', 'finished'); assert(#game.canceled == 0, 'not a scripted line')
`));

test('glue: the 0.1 s manage of a line in the air ends it when V or the world needs the channel, when it is late or its speaker is gone, and keeps the lease otherwise', () => withGlue(`
convaiQuestTick('V', 0.1)
local rid = convaiQuestLineStart({pack = 'p', id = 'x', profileKey = 'panam-palmer', channel = 'own'})
local now = os.time()
local outputs = {enabled = true}
pending = {requestId = rid}
convaiQuestLineTick('V', now, true, outputs, false); assert(#game.canceled == 0, 'in the air')
convaiQuestLineTick('V', now, false, outputs, false); assert(game.canceled[#game.canceled] == 'scripted-world-not-ready')
local function again() automatic = nil; game.canceled = {}; convaiQuestLineStart({pack = 'p', id = 'x', profileKey = 'panam-palmer', channel = 'own'}) end
again(); convaiQuestLineTick('V', now, true, outputs, true); assert(game.canceled[1] == 'scripted-manual-priority')
again(); convaiQuestLineTick('V', now, true, {enabled = false}, false); assert(game.canceled[1] == 'scripted-outputs-disabled')
again(); convaiQuestLineTick('V', now + 120, true, outputs, false); assert(game.canceled[1] == 'scripted-expired')
again(); automatic.playbackAt = now; convaiQuestLineTick('V', now + 120, true, outputs, false); assert(#game.canceled == 0, 'late is fine once the audio began')
again(); convaiQuestSpeaker.npc = {IsAttached = function() return false end, IsDeadNoStatPool = function() return false end}
convaiQuestLineTick('V', now, true, outputs, false); assert(game.canceled[1] == 'scripted-speaker-gone')
again(); pending = nil; convaiQuestLineTick('V', now, true, outputs, false); assert(game.canceled[1] == 'completed', 'nothing in the air any more')
`));

test('glue: a subtitle and a phone text go through the game, the text with the notice the appointment texts have', () => withGlue(`
convaiQuestTick('V', 0.1)
convaiQuestSubtitle('panam-palmer', 'Words.'); assert(game.subtitles[1] == 'Panam Palmer: Words.')
assert(convaiQuestPhone('panam-palmer', 'Look at this sky.', nil) == true)
assert(game.phones[1] == 'panam-palmer: Look at this sky.' and game.notices[1] == 'immersive-text:Panam Palmer: Look at this sky.')
game.phoneFails = true; assert(convaiQuestPhone('panam-palmer', 'x', nil) == false and #game.notices == 1, 'no notice for a text that was not delivered')
game.phoneFails = false
convaiQuestPhone('panam-palmer', string.rep('a', 200), nil); assert(game.notices[2]:find('%.%.%.$') and #game.notices[2] < 170)
`));

// ---- Characters text first: the glue ---------------------------------------------------------------------------------------------------------------------------
test('glue reach: the module is built with the quest module, the play file hands its block over, the 0.1 s tick drives its update, a world change resets it', () => withGlue(`
convaiQuestTick('V', 0.1)
assert(convaiReach ~= nil and game.reachUpdates == 1, 'built once and updated by the tick')
convaiQuestTick('V', 0.1); assert(game.reachUpdates == 2)
local play = game.built.play
play.onReach({enabled = true, items = {{id = 'a'}}}); play.onReach(nil)
assert(#game.reachBlocks == 2 and game.reachBlocks[1].items[1].id == 'a' and game.reachBlocks[2] == false)
convaiQuestReset('world'); assert(game.reachResets[1] == 'world')
`));

test('glue reach: the options are the setting, the clock, the busy test of the line player, the Phone Chat path, the call system when it is there, the caption of Johnny, the event and the refresh', () => withGlue(`
convaiQuestTick('V', 0.1)
local o = game.built.reach
assert(o.enabled() == true and o.gameTime() == 100000 and o.clock == os.clock)
game.reach = false; assert(o.enabled() == false, 'the Characters text first setting'); game.reach = true
game.on = false; assert(o.enabled() == false, 'Story packs and Character bonds'); game.on = true
assert(o.busy() == false); battleSample.combat = true; assert(o.busy() == true, 'the same test the line player uses'); battleSample.combat = nil
assert(o.text('panam-palmer', 'Hey.', nil) == true and game.phones[#game.phones] == 'panam-palmer: Hey.' and game.notices[#game.notices] == 'immersive-text:Panam Palmer: Hey.')
assert(o.call({character = 'panam-palmer', text = 'x', id = 'a'}) == nil, 'no call system: nil, the text goes instead')
local asked
convaiQuestCallIn = function(key, text, id) asked = key .. '|' .. text .. '|' .. id; return true end
assert(o.call({character = 'panam-palmer', text = 'x', id = 'a'}) == true and asked == 'panam-palmer|x|a')
convaiQuestCallIn = function() error('boom') end; assert(o.call({character = 'panam-palmer', text = 'x', id = 'a'}) == false)
convaiQuestCallIn = nil
assert(o.voice({text = 'Hey, V.'}) == true and game.subtitles[#game.subtitles] == 'Johnny Silverhand: Hey, V.')
game.headRefusal = 'combat'; assert(o.voice({text = 'x'}) == false, 'his route is not free'); game.headRefusal = nil
game.noHead = true; assert(o.voice({text = 'x'}) == false, 'Johnny in your head is off'); game.noHead = nil
assert(o.emit('a') == true and game.reachEvents[1] == 'a')
o.refresh(); assert(game.refreshes == 1)
`));

test('glue reach: a reply that carries missingAudio for a scripted quest line adds the Phone Chat line once, and only then', () => withGlue(`
convaiQuestTick('V', 0.1)
local pendingLine = {requestId = 'r1', profileKey = 'panam-palmer', reaction = {kind = 'scripted'}}
assert(convaiQuestMissingAudio(pendingLine, {text = 'You came.', missingAudio = true}) == true)
assert(game.phones[#game.phones] == 'panam-palmer: You came.' and game.notices[#game.notices] == 'immersive-text:Panam Palmer: You came.')
local phones = #game.phones
assert(convaiQuestMissingAudio(pendingLine, {text = 'You came.', missingAudio = true}) == false and #game.phones == phones, 'once per line')
assert(convaiQuestMissingAudio({requestId = 'r2', profileKey = 'panam-palmer', reaction = {kind = 'scripted'}}, {text = 'x'}) == false, 'no flag')
assert(convaiQuestMissingAudio({requestId = 'r3', profileKey = 'panam-palmer', reaction = {kind = 'battle'}}, {text = 'x', missingAudio = true}) == false, 'not a quest line')
assert(convaiQuestMissingAudio({requestId = 'r4', profileKey = 'panam-palmer'}, {text = 'x', missingAudio = true}) == false, 'an ordinary reply')
assert(convaiQuestMissingAudio(pendingLine, {text = '', missingAudio = true}) == false)
game.phoneFails = true
assert(convaiQuestMissingAudio({requestId = 'r5', profileKey = 'panam-palmer', reaction = {kind = 'scripted'}}, {text = 'Late.', missingAudio = true}) == false)
`));

test('init.lua: the reach moments are wired: the district hook, the fight sample, the missing audio line, the bonds reach option, no tick of its own', () => {
  assert.match(init, /if not worldSuspended and convaiReach then pcall\(convaiReach\.districtChanged\) end/);
  assert.match(init, /if convaiReach then pcall\(convaiReach\.sample, battleSample\.combat == true or battles\.fighting\(\)\) end/);
  assert.match(init, /speech\.start\(pending, reply\)\s+-- [^\n]*\s+if reply\.missingAudio == true and convaiQuestMissingAudio then pcall\(convaiQuestMissingAudio, pending, reply\) end/);
  assert.match(init, /reach = function\(\) return type\(manager\.reachOuts\) == 'function' and manager\.reachOuts\(\) end,/);
  assert.match(init, /local reach = convaiReach\s+if reach ~= nil then\s+local okReach, problemReach = pcall\(reach\.update\)/);
  // The module is loaded on its own, so a failure there never takes the quests down.
  assert.match(block, /pcall\(dofile, 'quest-reach\.lua'\)/);
  assert.doesNotMatch(source('quest-reach.lua'), /registerForEvent|onUpdate|Observe\(|Cron\.|Game\./, 'the module itself touches no native and no hook');
});

test('quest-reach.lua keeps to plain Lua 5.1, names no other mod and has no semicolon in a comment', () => {
  const text = source('quest-reach.lua');
  assert.ok(!/\bgoto\b|table\.unpack|bit32/.test(text));
  for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
  assert.doesNotMatch(text, /AMM/);
});

// ---- the few lines elsewhere in init.lua ---------------------------------------------------------------------------------------------------------------
test('init.lua: the tick, the scripted branch, the delivery check, the end of a line, the speech callback, the world change, the busy test and the bonds option are wired', () => {
  assert.match(init, /if \(convaiQuestPlay or convaiQuestDue\) and worldReady then convaiQuestTick\(player, elapsedPoll\) end/);
  assert.match(init, /elseif automatic and automatic\.reaction\.kind == 'scripted' then\s+convaiQuestLineTick\(player, now, worldReady, outputs, manual\)/);
  assert.match(init, /if context\.reaction\.kind == 'scripted' then\s+if convaiQuestSpeakerHere\(context\.requestId\) then return true end\s+cancelAutomatic\('scripted-speaker-missing'\)/);
  assert.match(init, /if automatic\.reaction\.kind == 'scripted' and convaiQuestLineEnded then pcall\(convaiQuestLineEnded, automatic, reason\) end\s+-- A line of a party round/);
  assert.match(init, /if convaiQuestLines then pcall\(convaiQuestStopped, requestId, reason\) end\s+end/);
  assert.match(init, /if convaiQuestReset then pcall\(convaiQuestReset, reason\) end/);
  assert.match(init, /controller\.chatActive\(\) == true then return true end\s+return convaiQuestLines ~= nil and convaiQuestBusy\(\)/);
  assert.match(init, /onPlayRevision = function\(\) if convaiQuestPlayRevision then convaiQuestPlayRevision\(\) end end/);
  assert.match(init, /if context\.reaction and context\.reaction\.kind == 'scripted' then context\.battle = nil end/);
  // The speak-up scheduler asks the one busy test every tick and the quest is in it.
  assert.match(between('function convaiSpeakUpEligible', 'return now - convaiSpeakUpState.lastManualAt'), /convaiUnpromptedBusy/);
});

test('init.lua: the quest glue adds no per-frame work (no onUpdate, no os.clock polling of its own) and names no other mod', () => {
  assert.doesNotMatch(block, /registerForEvent|onUpdate|Cron\./);
  for (const line of block.split('\n')) assert.ok(!/--.*;/.test(line), 'no semicolon in a comment: ' + line);
  for (const name of ['quest-world', 'quest-places', 'quest-prims', 'quest-lines', 'quest-play', 'quest-probe']) {
    for (const line of source(name + '.lua').split('\n')) assert.ok(!/--.*;/.test(line), `${name}: no semicolon in a comment: ${line}`);
  }
});

test('the seating controller answers the phase of a copy for the seated-together watch', () => {
  const seating = source('companion-seating.lua');
  assert.match(seating, /function self\.phaseOf\(serial\)\s+local s = self\.states\[serial\]\s+return s ~= nil and s\.phase ~= 'off' and s\.phase or nil\s+end/);
});

// ---- round 2: the facts reader and the pay stage's turn field ----------------------------------------------------------------------------------------------
test('glue: with no fact wanted the reader is never loaded, a wanted fact loads it once and feeds it the delta, a failing load latches, a world change resets it', () => withGlue(`
local reader = {updates = {}, resets = 0}
modules['quest-facts.lua'] = {new = function(options) game.built.facts = options; return {update = function(delta) reader.updates[#reader.updates + 1] = delta end, reset = function() reader.resets = reader.resets + 1 end} end}
convaiQuestTick('V', 0.1)
convaiQuestPlay.factsWanted = function() return game.wanted end
convaiQuestTick('V', 0.1)
local loads = #game.loads
for _, name in ipairs(game.loads) do assert(name ~= 'quest-facts.lua', 'not loaded while nothing is wanted') end
game.wanted = {{id = 'a', names = {'x'}, kind = 'bool'}}
convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.2)
assert(game.loads[#game.loads] == 'quest-facts.lua' and #game.loads == loads + 1, 'loaded once')
assert(#reader.updates == 2 and reader.updates[2] == 0.2)
local options = game.built.facts
assert(options.enabled() == true and options.wanted() == game.wanted and options.clock == os.clock, 'the options of the reader')
game.on = false; assert(options.enabled() == false, 'the setting is read each time'); game.on = true
convaiQuestReset('load'); assert(reader.resets == 1 and convaiQuestDue == true)
game.wanted = nil; convaiQuestTick('V', 0.1); local seen = #reader.updates; convaiQuestTick('V', 0.1)
assert(#reader.updates == seen, 'nothing wanted again: not called')
`));

test('glue: a reader that cannot be built latches and is logged once, and one that raises is guarded', () => withGlue(`
modules['quest-facts.lua'] = {new = function() error('no reader') end}
convaiQuestTick('V', 0.1)
convaiQuestPlay.factsWanted = function() return {{id = 'a', names = {'x'}, kind = 'bool'}} end
local loads = #game.loads
convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.1)
assert(loggedOnce['quest-facts'] == 1 and #game.loads == loads + 1 and convaiQuestFacts == nil, 'loaded and logged once')
convaiQuestFactsFailed = false
modules['quest-facts.lua'] = {new = function() return {update = function() error('read broke') end, reset = function() end} end}
convaiQuestTick('V', 0.1); convaiQuestTick('V', 0.1)
assert(loggedOnce['quest-facts-tick'] == 2)
`));

test('glue: a turn to the cast member of a pay stage carries quest = {pack, cast}, any other turn, a missing registry, a raising lookup or no pay stage leaves it out', () => withGlue(`
convaiQuestTick('V', 0.1)
local asked = {}
convaiQuestPrims.payTargetFor = function(entity, key) asked[#asked + 1] = tostring(entity) .. '/' .. tostring(key); if entity == '55' then return {pack = 'toll-road', cast = 'guard', extra = 'x'} end return nil end
local context = {entity = '55', profileKey = 'nobody'}
convaiQuestAttach(context)
assert(context.quest and context.quest.pack == 'toll-road' and context.quest.cast == 'guard' and context.quest.extra == nil and asked[1] == '55/nobody')
local other = {entity = '77'}; convaiQuestAttach(other); assert(other.quest == nil)
local bare = {}; convaiQuestAttach(bare); assert(bare.quest == nil and #asked == 2, 'no entity: not asked')
convaiQuestPrims.payTargetFor = function() error('lookup broke') end
local raised = {entity = '55'}; convaiQuestAttach(raised); assert(raised.quest == nil)
convaiQuestPrims.payTargetFor = nil
local none = {entity = '55'}; convaiQuestAttach(none); assert(none.quest == nil)
convaiQuestPrims = nil
convaiQuestAttach({entity = '55'})
convaiQuestAttach(nil)
`));

test('init.lua: both private turn paths (spoken and typed) call the pay stage hook right after the Eddies block, never for a reaction, a group round or Johnny in V\'s head', () => {
  const calls = init.match(/if not context\.reaction and not context\.group and not context\.head and convaiQuestAttach then convaiQuestAttach\(context\) end/g) || [];
  assert.equal(calls.length, 2);
  assert.equal([...init.matchAll(/convaiEddiesAttach\(context\) end\s+(?:--[^\n]*\n\s+)+if not context\.reaction and not context\.group and not context\.head and convaiQuestAttach then convaiQuestAttach\(context\) end/g)].length, 2);
});

test('the developer probe checks the gift allowlist against the game and writes the check file; it needs no quest module', () => run(`
${base}
local files = {}
local missing = {['Items.Gone'] = true}
TweakDB = {GetRecord = function(_, id) if missing[id] then return nil end return {} end}
json = {encode = serialize, decode = decode}
local real_open = io.open
io.open = function(path, mode)
  if mode == 'rb' then
    if not files[path] then return nil end
    return {read = function() return files[path] end, close = function() end}
  end
  return {write = function(self, text) files[path] = text end, close = function() end}
end
local M = (function() ${source('quest-probe.lua')} end)()
assert(M.ACTIONS.gifts == true and M.ALLOWLIST == 'runtime/quest-gift-allowlist.json' and M.GIFT_CHECK == 'runtime/quest-gift-check.json')
local lines = {}
local env = {log = function(line) lines[#lines + 1] = line end}
assert(not pcall(M.run, 'gifts', env), 'no allowlist file yet')
files[M.ALLOWLIST] = serialize({version = 1, ids = {'Items.Beer', 'Items.Gone', 'Items.Gun', 'bad id!', 42, 'Items.Gone2'}})
missing['Items.Gone2'] = true
local report = M.run('gifts', env)
assert(report.checked == 4 and #report.missing == 2 and report.okCount == 2 and report.file == M.GIFT_CHECK, 'checked ' .. report.checked)
local written = decode(files[M.GIFT_CHECK])
assert(written.version == 1 and written.checked == 4 and #written.missing == 2 and written.missing[1] == 'Items.Gone' and written.missing[2] == 'Items.Gone2' and #written.ok == 2)
assert(#lines == 2 and lines[1]:find('Items.Gone', 1, true) and lines[2]:find('Items.Gone2', 1, true), 'one log line per missing id')
files[M.ALLOWLIST] = serialize({version = 2, ids = {}})
assert(not pcall(M.run, 'gifts', env), 'a wrong version is refused')
files[M.ALLOWLIST] = serialize({version = 1, ids = {}})
assert(M.run('gifts', env).checked == 0)
-- A TweakDB that raises counts the id as missing.
TweakDB = {GetRecord = function() error('no db') end}
files[M.ALLOWLIST] = serialize({version = 1, ids = {'Items.Beer'}})
assert(#M.run('gifts', env).missing == 1)
io.open = real_open
`));
