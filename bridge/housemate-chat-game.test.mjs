import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lua} from './housemate-fixture.mjs';

// The game side of the pair chat's spoken lines (mod/init.lua, from "The spoken lines" to convaiHouseTick), against fake game globals and the real pair chat
// module: the next line is written and published while the one in the air is said, sent as it is when that line has been heard, after a short beat, and
// withdrawn whenever the chat stops. mod/init.lua is too large to run in a test, so the block is cut out of it.
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const from = init.indexOf("    -- The spoken lines (a chat line, a greeting): one automatic reaction of kind 'house' at a time");
const to = init.indexOf('\nend\n\n-- ---- Companions settle in V');
assert.ok(from > 0 && to > from, 'markers of the house speech block');
const block = 'do\n' + init.slice(from, to) + '\nend\n';

const PRELUDE = `
  clockNow = 100.0
  os.clock = function() return clockNow end
  -- fengari's integers have 32 bits: the game's (os.time() + 90) * 1000 would wrap, so the clock is a float here (as in the game's LuaJIT, where every number is)
  local realTime = os.time
  os.time = function() return realTime() + 0.0 end
  generation = 0
  automatic, pending = nil, nil
  speech = {requestId = nil}
  subtitles = {ownsUtterance = function() return false end}
  questContext = {capture = function() return {quest = 'journal'} end}
  battleObserver = {canSpeak = function() return true end}
  companions = {residentNpc = function(serial) return {npc = serial} end}
  convaiMeetGreetingWaiting, convaiMeetGreetingCurrent = nil, nil
  convaiHouseWaiting, convaiHouseCurrent, convaiHouseResult, convaiHouseText, convaiHousePrepared = nil, nil, nil, nil, nil
  logged, sent, published, released, cancelled = {}, {}, {}, {}, {}
  log = function(line) logged[#logged + 1] = line end
  captureReactionGuard = function() end
  reactionLease = function() return true end
  sendRequest = function(context) sent[#sent + 1] = context; pending = context; return true end
  convaiSpeakUpPublish = function(command) published[#published + 1] = command or false; return true end
  cancelAutomatic = function(reason) cancelled[#cancelled + 1] = reason; automatic = nil; pending = nil end
  ${block}
  -- the pair chat, the real one, wired as mod/housemate-service.lua wires it
  Chat = dofile('housemate-chat.lua')
  function person(key, x) return {key = key, name = key:upper(), serial = 1, entity = key .. 'ULL', x = x, y = 0, z = 0} end
  people = {person('a', 2), person('b', 4)}
  ended = {}
  chatEnv = {
    random = function() return 0.5 end, level = function() return 'often' end, mayStart = function() return automatic == nil and pending == nil and speech.requestId == nil end,
    vPos = function() return {x = 0, y = 0, z = 0} end, people = function() return people end,
    speak = convaiHouseSpeak, status = convaiHouseSpeakStatus, cancelSpeak = convaiHouseSpeakCancel,
    prepare = PREPARE and convaiHouseSpeakPrepare or nil, unprepare = PREPARE and convaiHouseSpeakUnprepare or nil,
    ended = function(reason) ended[#ended + 1] = reason end, log = function() end}
  chat = Chat.new(chatEnv)
  convaiHousemates = {controller = {chatPoke = function() chat.poke() end, placeName = function() return 'Corpo Plaza apartment' end}}
  outputs = {enabled = true}
  function tick() return convaiHouseTick(nil, 1000, true, outputs, false) end
  -- the reply of the line in the air arrives: its text is known and it is said
  function said(text)
    local context = sent[#sent]
    pending = nil; speech.requestId = context.requestId
    automatic.shown = true
    convaiHouseReplyText(context, text)
  end
  function heard() speech.requestId = nil end
`;

const run = (code, {prepare = true} = {}) => lua(code, {prelude: `PREPARE = ${prepare}\n${PRELUDE}`});

test('the next line is published while the line in the air is said, and sent as published after a short beat once it has been heard', () => run(`
  chat.update(1)
  tick()
  assert(#sent == 1 and sent[1].reaction.n == 1 and sent[1].reaction.event == 'chat' and sent[1].reaction.topic, 'line 1 was sent')
  assert(convaiHouseSpeakStatus() == 'busy')
  said('Hello there')
  assert(select(2, convaiHouseSpeakStatus()) == 'Hello there', 'the text of the line in the air is known to the chat')
  chat.update(1)
  local command = published[#published]
  assert(command and command.kind == 'ahead' and command.input.reaction.n == 2, 'line 2 was published')
  assert(command.input.reaction.lines[1].text == 'Hello there' and command.input.reaction.lines[1].speaker == sent[1].name)
  assert(command.input.journal and command.input.reaction.event == 'chat' and command.input.profileKey ~= sent[1].profileKey)
  assert(command.input.reaction.expiresAt > 1000 * 1000 + 60000, 'its deadline outlives the line before it')
  assert(#sent == 1, 'not sent yet')
  -- the line is heard to its end: the chat asks for the next one at once, but it waits out its beat
  heard()
  tick()
  assert(#cancelled == 1 and cancelled[1] == 'completed')
  assert(#sent == 1 and convaiHouseSpeakStatus() == 'waiting')
  clockNow = 100.1; tick()
  assert(#sent == 1, 'still in its beat')
  clockNow = 100.6; tick()
  assert(#sent == 2, 'sent after the beat')
  assert(rawequal(sent[2], command.input), 'the very table that was published is the one sent')
  assert(convaiHouseSpeakStatus() == 'busy')
  assert(logged[#logged]:find('written ahead', 1, true), logged[#logged])
`));

test('without a preparation the next line is requested and sent at the end of the one before, with no pause of the game side\'s own', () => run(`
  chat.update(1)
  tick()
  said('Hello there')
  chat.update(1)
  assert(#published == 0, 'nothing was published')
  heard()
  tick()
  assert(#sent == 1 and convaiHouseSpeakStatus() == 'waiting')
  tick()
  assert(#sent == 2 and sent[2].reaction.n == 2 and sent[2].reaction.lines[1].text == 'Hello there', 'sent on the very next tick')
  assert(not logged[#logged]:find('written ahead', 1, true))
`, {prepare: false}));

test('a published line that is not the one the chat asks for is withdrawn and the line is made fresh', () => run(`
  people = {person('a', 2), person('b', 4), person('c', 6)}
  chatEnv.groupSize = function() return 3 end
  chat = Chat.new(chatEnv)
  chat.update(1)
  tick()
  said('Hello there')
  chat.update(1)
  local command = published[#published]
  assert(command.kind == 'ahead')
  -- the housemate who was to speak next left meanwhile
  local rest = {}
  for _, p in ipairs(people) do if p.key ~= command.input.profileKey then rest[#rest + 1] = p end end
  people = rest
  heard()
  tick()
  assert(published[#published] == false, 'the bridge was told to drop the held line')
  assert(convaiHousePrepared == nil)
  tick()
  assert(#sent == 2 and not rawequal(sent[2], command.input) and sent[2].profileKey ~= command.input.profileKey, 'a fresh request was sent')
`));

test('V talks, the chat stops or the housemates are switched off while a line is published: it is withdrawn once', () => {
  run(`
    chat.update(1); tick(); said('Hello there'); chat.update(1)
    assert(convaiHousePrepared and published[#published].kind == 'ahead')
    convaiHouseSpeakUnprepare()
    assert(convaiHousePrepared == nil and published[#published] == false)
    local count = #published
    convaiHouseSpeakUnprepare()
    assert(#published == count, 'nothing to withdraw the second time')
  `);
  run(`
    chat.update(1); tick(); said('Hello there'); chat.update(1)
    chat.interrupt('left', true)
    assert(chat.active() == false and published[#published] == false and convaiHousePrepared == nil)
  `);
  run(`
    chat.update(1); tick(); said('Hello there'); chat.update(1)
    chat.interrupt('talk', false)
    heard(); tick()
    assert(chat.active() == false and ended[1] == 'talk' and published[#published] == false and #sent == 1)
  `);
});

test('the prepared line waits for its beat and V talks: the chat ends at once and the bridge is told to drop the held line', () => run(`
  chat.update(1); tick(); said('Hello there'); chat.update(1)
  heard(); tick()
  assert(convaiHouseSpeakStatus() == 'waiting' and convaiHousePrepared == nil)
  local count = #published
  chat.interrupt('talk', false)
  assert(chat.active() == false and ended[1] == 'talk')
  assert(#published == count + 1 and published[#published] == false, 'withdrawn')
  assert(convaiHouseWaiting == nil and #sent == 1)
`));

test('only a chat line of a house reaction is prepared: not a greeting, not while no line is in the air, not twice', () => run(`
  assert(convaiHouseSpeakPrepare({n = 2}) == false, 'nothing in the air')
  assert(convaiHouseGreeting({key = 'a', name = 'A', serial = 1, entity = 'aULL', place = 'Corpo', awayHours = 30, others = {}}) == true)
  tick()
  assert(#sent == 1 and sent[1].reaction.event == 'welcome')
  assert(convaiHouseSpeakPrepare({speaker = people[1], partner = people[2], n = 2, of = 7, lines = {}, others = {}}) == false, 'a greeting has no next line')
  assert(#published == 0)
`));
