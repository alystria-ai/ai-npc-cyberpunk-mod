import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Companions speak up together (docs/COMPANION_SPEAK_UP.md, "Group speak-up"), the game side: when a calm speak-up is due and two or more party companions are
// near, most of the time it becomes a short round among up to three of them. The block of mod/init.lua is cut out and run in fengari with fakes for what it
// uses from the rest of the file; the scheduler (mod/speak-up.lua) and the chat engine (mod/housemate-chat.lua) are the real modules.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const init = read('../mod/init.lua');
const schedulerSource = read('../mod/speak-up.lua');
const engineSource = read('../mod/housemate-chat.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};
const block = between('-- Companions and Johnny speak up on their own (docs/COMPANION_SPEAK_UP.md)', 'local function updateBattles(');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const prelude = `
local scheduler = (function() ${schedulerSource} end)()
local engine = (function() ${engineSource} end)()
clock = 1000.0
os.time = function() return math.floor(clock) end
os.clock = function() return clock end
randomValue = 0.5
math.random = function(n) if n then return 1 end return randomValue end
function dofile(path)
  if path == 'speak-up.lua' then return scheduler end
  if path == 'housemate-chat.lua' then return engine end
  error('unexpected dofile ' .. tostring(path))
end
print = function() end
files, encoded = {}, {}
io.open = function(path) return {write = function(self, text) files[path] = text end, close = function() end} end
json = {encode = function(value) encoded[#encoded + 1] = value; return 'J' .. #encoded end}
-- The command last written to runtime/group-prefetch.json: a table, or the string '{}' once withdrawn, or nil.
function prefetch()
  local text = files['runtime/group-prefetch.json']
  if text == '{}' then return '{}' end
  return text and encoded[tonumber(text:match('^J(%d+)$'))] or nil
end
Game = {GetPlayer = function() return {} end}
logs = {}
function log(line) logs[#logs + 1] = line end
convaiLogLine = log
settings = {companion = 'normal'}
manager = {companionSpeakUp = function() return settings.companion end, johnnyInHead = function() return false end,
  johnnyRemarks = function() return 'off' end, dynamicInfo = function() return true end}
battleSample = {available = true, blocked = false, combat = false}
battleSampleAt = 1
local function member(entity, key, name, distance, party)
  return {entity = entity, profileKey = key, name = name, npc = {}, available = true, voiceBusy = false, bodyType = 'WomanAverage', distance = distance,
    party = party ~= false}
end
judy, panam, river = member('11ULL', 'judy-alvarez', 'Judy', 3), member('12ULL', 'panam-palmer', 'Panam', 5), member('13ULL', 'river-ward', 'River', 8)
function setPeople(list) battlePeople = list; battleSampleAt = battleSampleAt + 1 end
setPeople({judy, panam, river})
automatic, pending, lastAutomatic = nil, nil, nil
speech = {requestId = nil, context = nil, transcript = function() return nil end}
subtitles = {ownsUtterance = function() return false end}
fighting = false
battles = {fighting = function() return fighting end}
generation = 10
questContext = {capture = function() return {journal = true} end}
convaiGameDialogue = {capture = function() return {dialogue = true} end}
convaiTurnContext = {capture = function() return {turnContext = true} end}
function attachKnowledge() return true end
function captureReactionGuard() end
function reactionLease() return true end
function reactionSpeakerWait() return false end
function reactionOutputs() return {enabled = true} end
sent = {}
function sendRequest(context) sent[#sent + 1] = context; pending = context; return true end
cancels = {}
-- The contract of cancelAutomatic that the block depends on (mod/init.lua): the line's floor goes back to the scheduler, a party line tells its round.
function cancelAutomatic(reason, abandoning)
  if not automatic then return end
  cancels[#cancels + 1] = reason
  local hold = convaiSpeakUpState and convaiSpeakUpState.hold
  if hold and hold.requestId == automatic.requestId then
    convaiSpeakUpState.hold = nil
    if convaiSpeakUp then convaiSpeakUp:release(hold.who, automatic.playbackAt ~= nil) end
  end
  if automatic.party and convaiPartyLineEnded then pcall(convaiPartyLineEnded, automatic, reason) end
  automatic = nil
end
convaiJohnnyRemarks = nil
function convaiJohnnyHeadService() return nil end
-- The housemates' side of the one-floor rule (mod/init.lua convaiUnpromptedBusy): a round counts as the floor being held.
function convaiUnpromptedBusy() return convaiPartyState ~= nil and convaiPartyState.chat ~= nil end
${block}
local outputs = {enabled = true}
local function mayFollow() return true end
manual = false
-- One 0.1 s game tick, in the order of updateBattles.
function tick(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    clock = clock + 0.1
    local now = os.time()
    local on = convaiSpeakUpAdvance(now, 0.1, true, manual, outputs)
    if convaiSpeakUpState.plan then convaiSpeakUpPlanTick({}, now, true, outputs, manual) end
    if convaiPartyState.chat then convaiPartyTick({}, now, true, outputs, manual, 0.1) end
    if automatic and automatic.reaction.kind == 'speakup' then
      convaiSpeakUpManage({}, now, true, outputs, manual)
    elseif on and not (automatic or pending or speech.requestId) then
      convaiSpeakUpOffer({}, now, true, outputs, manual, convaiUnpromptedBusy(), mayFollow)
    end
  end
end
function untilSent(count, maxSeconds)
  for _ = 1, math.floor(maxSeconds * 10) do
    if #sent >= count then return true end
    tick(0.1)
  end
  return #sent >= count
end
-- The reply text of the line in the air is known (it is still being said).
function know(text) pending = nil; speech.requestId = automatic.requestId; convaiPartyReplyText(automatic, text) end
-- The line in the air has been heard to its end.
function finish() local id = automatic.requestId; automatic.shown = true; automatic.playbackAt = os.time(); pending = nil; speech.requestId = nil; speech.onStopped(id, 'finished') end
function hear(text) know(text); finish() end
`;

const withWorld = code => run(prelude + code);

test('a calm speak-up with three party companions near is a round: three people, four lines, one at a time, then the floor is free', () => withWorld(`
  assert(untilSent(1, 900), 'the first line within the next 15 minutes')
  local first = sent[1]
  assert(first.reaction.kind == 'speakup' and first.reaction.event == 'party', 'a party line, not a calm one: ' .. tostring(first.reaction.event))
  assert(first.profileKey == 'judy-alvarez' and first.reaction.n == 1 and first.reaction.of == 4 and #first.reaction.lines == 0)
  assert(first.reaction.partner == 'Panam' and first.reaction.partnerKey == 'panam-palmer' and #first.reaction.others == 1 and first.reaction.others[1] == 'River')
  assert(first.journal and first.turnContext and first.battle == nil and first.head == nil and first.group == nil)
  assert(first.reaction.expiresAt > os.time() * 1000)
  assert(convaiSpeakUp:holder() == 'companion' and convaiPartyState.chat ~= nil, 'the round holds the floor')
  assert(convaiSpeakUpState.hold == nil, 'not the line')
  tick(20)
  assert(#sent == 1, 'nobody else speaks while the line is on')
  hear('Quiet tonight.')
  tick(1)
  assert(#sent == 2, 'the next line right after the first was heard')
  local second = sent[2]
  assert(second.profileKey == 'panam-palmer' and second.reaction.n == 2 and second.reaction.partner == 'Judy' and second.reaction.others[1] == 'River' and #second.reaction.lines == 1)
  assert(second.reaction.lines[1].speaker == 'Judy' and second.reaction.lines[1].text == 'Quiet tonight.')
  hear('Too quiet.')
  tick(1)
  local third = sent[3]
  assert(third.profileKey == 'river-ward' and third.reaction.n == 3 and third.reaction.partner == 'Panam' and #third.reaction.lines == 2)
  hear('I like it.')
  tick(1)
  local fourth = sent[4]
  assert(fourth.profileKey == 'judy-alvarez' and fourth.reaction.n == 4 and #fourth.reaction.lines == 3, 'back to the first speaker for the closing line')
  hear('Well, then.')
  tick(2)
  assert(#sent == 4, 'four lines in all, no fifth')
  assert(convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil, 'the round is over and the floor is back')
  assert(convaiSpeakUp:lastSpeaker() == 'companion')
  tick(60)
  assert(#sent == 4, 'quiet until the next speak-up')
  local ended
  for _, line in ipairs(logs) do if line:find('party round ended') then ended = line end end
  assert(ended and ended:find('done') and ended:find('lines=4'), tostring(ended))
`));

test('two near: a round of three or four lines between the two', () => withWorld(`
  setPeople({judy, panam})
  assert(untilSent(1, 900))
  assert(sent[1].reaction.event == 'party' and sent[1].reaction.of == 3 and #(sent[1].reaction.others or {}) == 0)
  hear('One.'); tick(1)
  assert(sent[2].profileKey == 'panam-palmer' and sent[2].reaction.partner == 'Judy')
  hear('Two.'); tick(1)
  assert(sent[3].profileKey == 'judy-alvarez' and sent[3].reaction.n == 3)
  hear('Three.'); tick(2)
  assert(#sent == 3 and convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil)
`));

test('only one party companion near, or one that is not a party copy: the single calm line as before', () => withWorld(`
  setPeople({judy, member('12ULL', 'panam-palmer', 'Panam', 5, false)})
  assert(untilSent(1, 900))
  assert(sent[1].reaction.event == 'calm' and convaiPartyState.chat == nil and convaiSpeakUpState.hold ~= nil, 'a single line holds the floor by itself')
`));

test('a companion too far to join does not make a round', () => withWorld(`
  setPeople({judy, member('12ULL', 'panam-palmer', 'Panam', 18)})
  assert(untilSent(1, 900))
  assert(sent[1].reaction.event == 'calm', 'beyond 15 m she does not join')
`));

test('the dice: most of the time a round, sometimes the single line', () => withWorld(`
  randomValue = 0.9
  assert(untilSent(1, 3000))
  assert(sent[1].reaction.event == 'calm', 'a draw above 0.75 keeps the single line')
`));

test('only the calm moment can become a round: the offer asks for one for no other event', () => {
  assert.ok(init.includes("if event == 'calm' and convaiPartyStart(person) then return end"));
  assert.equal(init.split('convaiPartyStart(').length - 1, 2, 'one definition and one call');
  // The floor of the housemates and of the other unprompted speakers also treats a round as held, and a manual line or a reset ends it.
  assert.ok(init.includes('if convaiPartyState and convaiPartyState.chat then return true end'));
  assert.ok(init.includes("if convaiPartyState.chat then convaiPartyAbort('talk') end"));
  assert.ok(init.includes("if convaiPartyState.chat then convaiPartyTick(player, now, worldReady, outputs, manual, elapsed) end"));
});

test('V talks: the round gives way at once, the line in the air is cut, nothing is prepared or sent after, and the floor is back', () => withWorld(`
  assert(untilSent(1, 900))
  hear('First.'); tick(1)
  assert(#sent == 2 and automatic ~= nil)
  manual = true
  tick(0.2)
  assert(convaiPartyState.chat == nil and automatic == nil, 'ended on the first tick of V talking')
  assert(convaiSpeakUp:holder() == nil)
  manual = false
  tick(30)
  assert(#sent == 2, 'no further line')
  assert(prefetch() == '{}' or prefetch() == nil or prefetch().kind ~= 'ahead', 'nothing stays prepared')
`));

test('V sends a line of his own: the sent request ends the round too', () => withWorld(`
  assert(untilSent(1, 900))
  hear('First.')
  convaiSpeakUpManualSent({requestId = 'v-1', name = 'Judy', profileKey = 'judy-alvarez'})
  assert(convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil)
  tick(30)
  assert(#sent == 1)
`));

test('combat, a scene, a call and a vehicle end the round between two lines and in the middle of one', () => {
  for (const [name, setup] of [['combat', 'battleSample.combat = true'], ['a scene', 'battleSample.blocked = true'], ['fighting', 'fighting = true']]) {
    withWorld(`
      assert(untilSent(1, 900), '${name}')
      hear('First.')
      ${setup}
      tick(1)
      assert(#sent == 1 and convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil, '${name}: no second line')
    `);
    withWorld(`
      assert(untilSent(1, 900), '${name}')
      ${setup}
      tick(1)
      assert(automatic == nil and convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil, '${name}: the line in the air is cut')
    `);
  }
});

test('the next line is written while the current one plays, held by the bridge, and sent as it is after a short beat', () => withWorld(`
  assert(untilSent(1, 900))
  know('Quiet tonight.')
  tick(0.5)
  local command = prefetch()
  assert(type(command) == 'table' and command.kind == 'ahead', 'the next line is published once the text is known')
  local next = command.input
  assert(next.reaction.event == 'party' and next.reaction.n == 2 and next.profileKey == 'panam-palmer' and next.journal and next.turnContext)
  assert(next.reaction.lines[1].text == 'Quiet tonight.')
  assert(next.reaction.expiresAt > (os.time() + 60) * 1000, 'the deadline covers the wait')
  assert(#sent == 1)
  finish()
  tick(0.1)
  assert(#sent == 1, 'a beat first')
  tick(1)
  assert(#sent == 2 and sent[2] == next, 'the very table that was published')
`));

test('a prepared line is withdrawn when the round stops', () => withWorld(`
  assert(untilSent(1, 900))
  know('Quiet tonight.')
  tick(0.5)
  assert(type(prefetch()) == 'table')
  manual = true
  tick(0.2)
  assert(prefetch() == '{}', 'the bridge is told to drop the held line')
`));

test('a line that never plays ends the round as failed and gives the timer back', () => withWorld(`
  assert(untilSent(1, 900))
  -- the reply failed: the line ends unheard
  automatic.shown = false
  cancelAutomatic('completed')
  tick(1)
  assert(convaiPartyState.chat == nil and convaiSpeakUp:holder() == nil and #sent == 1)
  local ended
  for _, line in ipairs(logs) do if line:find('party round ended') then ended = line end end
  assert(ended and ended:find('failed') and ended:find('lines=0'), tostring(ended))
`));

test('turning companions speak up Off ends a round; nothing is loaded while no round is on', () => withWorld(`
  assert(convaiPartyState.chat == nil and convaiPartyModule == nil, 'nothing is loaded before a round')
  assert(untilSent(1, 900))
  settings.companion = 'off'
  tick(0.3)
  assert(convaiPartyState.chat == nil)
`));

test('the group starts only from the calm line and never takes the single path in the same tick', () => withWorld(`
  assert(untilSent(1, 900))
  assert(#sent == 1, 'one request, not a round and a single line')
  local count = 0
  for _, line in ipairs(logs) do if line:find('Speak up: companion') then count = count + 1 end end
  assert(count == 2, 'the round start and its first line: ' .. count)
`));
