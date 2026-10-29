import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Companions and Johnny speak up (docs/COMPANION_SPEAK_UP.md), the game side: the block of mod/init.lua that decides who may speak, builds and sends
// the request, prepares Johnny's follow-on ahead and gives the floor back. The block is cut out of init.lua and run in fengari with fakes for
// everything it uses from the rest of the file; the scheduler is the real mod/speak-up.lua.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const init = read('../mod/init.lua');
const schedulerSource = read('../mod/speak-up.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};
const block = between('-- Companions and Johnny speak up on their own (docs/COMPANION_SPEAK_UP.md)', 'local function updateBattles(');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring('convaiPlayer = function() return Game.GetPlayer() end ' + code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// The world around the block: a settings table, one companion, a fake clock and request machinery that records what the game would do.
const prelude = `
local scheduler = (function() ${schedulerSource} end)()
clock = 1000.0
os.time = function() return math.floor(clock) end
os.clock = function() return clock end
local randomValue = 0.5
math.random = function(n) if n then return 1 end return randomValue end
local loads = 0
function dofile(path) assert(path == 'speak-up.lua', path); loads = loads + 1; return scheduler end
print = function() end
files, encoded = {}, {}
io.open = function(path)
  return {write = function(self, text) files[path] = text end, close = function() end}
end
json = {encode = function(value) encoded[#encoded + 1] = value; return 'J' .. #encoded end}
local function tableOf(text) return type(text) == 'string' and tonumber(text:match('^J(%d+)$')) and encoded[tonumber(text:match('^J(%d+)$'))] or nil end
local function withdrawn() local command = tableOf(files['runtime/group-prefetch.json']); return files['runtime/group-prefetch.json'] == '{}' end
Game = {GetPlayer = function() return {} end}
logs = {}
function log(line) logs[#logs + 1] = line end
convaiLogLine = log
settings = {companion = 'normal', head = false, remarks = 'off'}
manager = {companionSpeakUp = function() return settings.companion end, johnnyInHead = function() return settings.head end,
  johnnyRemarks = function() return settings.remarks end, dynamicInfo = function() return true end}
battleSample = {available = true, blocked = false, combat = false}
battleSampleAt = 1
person = {entity = '11ULL', profileKey = 'judy-alvarez', name = 'Judy', npc = {}, available = true, voiceBusy = false, bodyType = 'WomanAverage'}
battlePeople = {person}
automatic, pending, lastAutomatic = nil, nil, nil
speech = {requestId = nil, context = nil, transcript = function() return nil end}
subtitles = {ownsUtterance = function() return false end}
battles = {fighting = function() return false end}
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
-- The contract of cancelAutomatic that the block depends on: the unprompted line's floor goes back to the scheduler, heard when it played.
function cancelAutomatic(reason, abandoning)
  if not automatic then return end
  cancels[#cancels + 1] = reason
  local hold = convaiSpeakUpState and convaiSpeakUpState.hold
  if hold and hold.requestId == automatic.requestId then
    convaiSpeakUpState.hold = nil
    if convaiSpeakUp then convaiSpeakUp:release(hold.who, automatic.playbackAt ~= nil) end
  end
  automatic = nil
end
head = {refusal = function() return nil end,
  partner = function() return {entity = '1ULL', name = 'Johnny Silverhand', profileKey = 'johnny-silverhand', head = {stage = 'friends'}} end}
function convaiJohnnyHeadService() if settings.head then return head end return nil end
convaiJohnnyRemarks = nil
convaiJohnnyRemarksModule = {SEND_SECONDS = 60}
${block}
local outputs = {enabled = true}
local function mayFollow() return true end
-- One 0.1 s game tick, in the order of updateBattles: the clock, a prepared line, a follow-on decision, a line in progress, an offer.
-- flags.play: a started speak-up line is heard to its end at once (the speech side is not under test there).
local function tick(seconds, flags)
  flags = flags or {}
  local steps = math.floor(seconds * 10 + 0.5)
  for _ = 1, steps do
    clock = clock + 0.1
    local now = os.time()
    local on = convaiSpeakUpAdvance(now, 0.1, true, flags.manual == true, outputs)
    if convaiSpeakUpState.plan then convaiSpeakUpPlanTick({}, now, true, outputs, flags.manual == true) end
    if on and not convaiSpeakUpState.plan then convaiSpeakUpPlanFollow({}, now) end
    if automatic and automatic.reaction.kind == 'speakup' then
      if flags.play then
        local id = automatic.requestId
        automatic.playbackAt = now; pending = nil
        speech.onStopped(id, 'finished')
      else convaiSpeakUpManage({}, now, true, outputs, flags.manual == true) end
    elseif on and not (automatic or pending or speech.requestId) then
      convaiSpeakUpOffer({}, now, true, outputs, flags.manual == true, false, mayFollow)
    end
  end
end
-- Tick until the first request has been sent (the line is then in progress: nothing plays it).
local function untilSent(maxSeconds)
  for _ = 1, math.floor(maxSeconds * 10) do
    if #sent > 0 then return true end
    tick(0.1)
  end
  return #sent > 0
end
`;

const withWorld = code => run(prelude + code);

test('calm: a companion speaks up after calm eligible time, once, with the tracked quest and the right-now facts and no fight', () => withWorld(`
  tick(300)
  assert(#sent == 0, 'not before the first target gap (Normally 6 an hour: 600 s on average)')
  assert(untilSent(600), 'a line within the next ten minutes')
  assert(#sent == 1, 'one line, got ' .. #sent)
  local request = sent[1]
  assert(request.reaction.kind == 'speakup' and request.reaction.event == 'calm' and type(request.reaction.facts) == 'table')
  assert(request.profileKey == 'judy-alvarez' and request.entity == '11ULL' and request.journal and request.turnContext)
  assert(request.gameDialogue == nil and request.battle == nil and request.head == nil and request.group == nil)
  assert(request.reaction.expiresAt > os.time() * 1000)
  assert(convaiSpeakUp:holder() == 'companion' and convaiSpeakUpState.hold.requestId == request.requestId)
  assert(lastAutomatic.kind == 'speakup' and speech.target == person.npc)
  tick(30)
  assert(#sent == 1, 'nobody speaks while the line is on')
`));

test('rate: Rarely is about two an hour of calm play, and time spent in a fight is not counted', () => withWorld(`
  settings.companion = 'rare'
  tick(3600 * 10, {play = true})
  assert(#sent >= 14 and #sent <= 26, 'lines in ten hours: ' .. #sent)
  -- an hour of combat does not build up a burst afterwards
  battleSample.combat = true
  tick(3600)
  battleSample.combat = false
  local before = #sent
  tick(120, {play = true})
  assert(#sent - before <= 1, 'no burst after an hour of fight: ' .. (#sent - before))
`));

test('arbiter: whoever holds the floor holds it alone; the other cannot even be picked', () => withWorld(`
  settings.head, settings.remarks = true, 'normal'
  local waiting = {subject = 'person:rogue', kind = 'person', facts = {name = 'Rogue', profileKey = 'rogue-amendiares'}}
  convaiJohnnyRemarks = {pending = function() return true end, offer = function() return waiting end, claim = function() end}
  assert(untilSent(1500))
  local count = #sent
  local holder = convaiSpeakUp:holder()
  assert(holder == 'companion' or holder == 'johnny', tostring(holder))
  automatic, pending = nil, nil   -- pretend the game side is idle: the arbiter alone must refuse
  convaiSpeakUpOffer({}, os.time(), true, outputs, false, false, mayFollow)
  assert(#sent == count, 'the floor is held: no second speaker')
  assert(convaiSpeakUp:pick({companion = true, johnny = true}) == nil)
`));

test('Johnny follows a companion\'s line: prepared while she speaks, submitted unchanged the moment she has been heard', () => withWorld(`
  settings.head, settings.remarks = true, 'normal'
  randomValue = 0.1            -- the follow-on dice say yes
  assert(untilSent(1500) and sent[1].reaction.kind == 'speakup', 'the companion spoke first')
  local source = sent[1]
  -- her line is playing, its whole text is known
  speech.requestId, speech.context = source.requestId, {generation = source.generation, entity = source.entity}
  speech.transcript = function() return {textComplete = true, text = 'The city looks almost quiet tonight.'} end
  tick(0.3)
  local plan = convaiSpeakUpState.plan
  assert(plan and plan.kind == 'follow' and plan.sourceRequestId == source.requestId, 'a follow-on was prepared')
  local command = tableOf(files['runtime/group-prefetch.json'])
  assert(command and command.kind == 'follow' and command.sourceRequestId == source.requestId and command.input == plan.context)
  local reaction = command.input.reaction
  assert(reaction.kind == 'head' and reaction.event == 'follow' and reaction.facts.who == 'Judy'
    and reaction.facts.line == 'The city looks almost quiet tonight.' and reaction.facts.via == 'companion')
  assert(command.input.profileKey == 'johnny-silverhand' and command.input.generation > source.generation and command.input.requestId ~= source.requestId)
  assert(#sent == 1, 'nothing is sent before she has been heard')
  assert(convaiSpeakUp:holder() == 'companion')
  -- she has been heard to the end: his turn is the very table that was prepared, and she let go of the floor first
  automatic.playbackAt = os.time()
  speech.requestId = nil
  pending = nil               -- her reply was delivered long ago
  speech.onStopped(source.requestId, 'finished')
  assert(#sent == 2 and sent[2] == command.input, 'the identical request is submitted')
  assert(cancels[#cancels] == 'finished' and convaiSpeakUp:holder() == 'johnny' and convaiSpeakUpState.hold.who == 'johnny')
  assert(convaiSpeakUpState.plan == nil and automatic == command.input and convaiHeadTalk and convaiHeadTalk.entity == '1ULL')
`));

test('a follow-on is dropped when V talks, when the source is cut off, when the game takes the floor, and when Johnny leaves V\'s head', () => {
  const setup = `
    settings.head, settings.remarks = true, 'normal'
    randomValue = 0.1
    assert(untilSent(1500))
    local source = sent[1]
    speech.requestId, speech.context = source.requestId, {generation = source.generation, entity = source.entity}
    speech.transcript = function() return {textComplete = true, text = 'Quiet tonight, V.'} end
    tick(0.3)
    assert(convaiSpeakUpState.plan and convaiSpeakUpState.plan.kind == 'follow')
  `;
  withWorld(setup + `
    tick(0.2, {manual = true})
    assert(convaiSpeakUpState.plan == nil and withdrawn(), 'withdrawn when V takes the floor')
    speech.requestId = nil; speech.onStopped(source.requestId, 'finished')
    assert(#sent == 1, 'and nothing follows')
  `);
  withWorld(setup + `
    speech.requestId = nil; speech.onStopped(source.requestId, 'combat')
    assert(convaiSpeakUpState.plan == nil and withdrawn() and #sent == 1)
  `);
  withWorld(setup + `
    convaiSpeakUpManualSent({requestId = 'x', profileKey = 'judy-alvarez', name = 'Judy'})
    assert(convaiSpeakUpState.plan == nil and withdrawn())
  `);
  withWorld(setup + `
    head.refusal = function() return 'scene' end
    tick(0.2)
    assert(convaiSpeakUpState.plan == nil and withdrawn(), 'the game has the floor')
  `);
  withWorld(setup + `
    settings.head, settings.remarks = false, 'off'
    tick(0.2)
    assert(convaiSpeakUpState.plan == nil and withdrawn())
  `);
});

test('Johnny follows a reply V had in a conversation, never an ordinary person\'s, a group round\'s, a call\'s or his own', () => {
  const setup = `
    settings.head, settings.remarks = true, 'rare'
    settings.companion = 'off'
    randomValue = 0.1
    tick(2000)
    local function reply(context, text)
      convaiSpeakUpManualSent(context)
      speech.requestId, speech.context = context.requestId, {generation = 3, entity = '11ULL'}
      speech.transcript = function() return {textComplete = true, text = text} end
    end
  `;
  withWorld(setup + `
    reply({requestId = 'r1', profileKey = 'judy-alvarez', name = 'Judy', generation = 3, entity = '11ULL'}, 'Sure, V. Let us go.')
    tick(0.3)
    local plan = convaiSpeakUpState.plan
    assert(plan and plan.via == 'talk' and plan.context.reaction.facts.via == 'talk', 'prepared during her reply')
    speech.requestId = nil; pending = nil; speech.onStopped('r1', 'finished')
    assert(#sent == 1 and sent[1].reaction.event == 'follow' and convaiSpeakUp:holder() == 'johnny', 'sent after the reply finished')
  `);
  const bads = [`{requestId = 'r2', profileKey = 'resident-male', name = 'Man'}`, `{requestId = 'r2', profileKey = 'judy-alvarez', name = 'Judy', group = {id = 'g'}}`,
    `{requestId = 'r2', profileKey = 'judy-alvarez', name = 'Judy', holocall = {}}`, `{requestId = 'r2', profileKey = 'johnny-silverhand', name = 'Johnny', head = {}}`];
  for (const bad of bads) {
    withWorld(setup + `
      reply(${bad}, 'Something long enough to follow.')
      tick(0.3)
      assert(convaiSpeakUpState.plan == nil, 'no follow-on for this one')
    `);
  }
  // an unfinished text is not followed; a long one is not either (the bridge compares the whole text)
  withWorld(setup + `
    reply({requestId = 'r3', profileKey = 'judy-alvarez', name = 'Judy'}, 'Half')
    speech.transcript = function() return {textComplete = false, text = 'Half a sent'} end
    tick(0.3)
    assert(convaiSpeakUpState.plan == nil)
    speech.transcript = function() return {textComplete = true, text = string.rep('x', 501)} end
    tick(0.3)
    assert(convaiSpeakUpState.plan == nil, 'too long')
  `);
});

test('Johnny is not asked at all while his list is Off or plain On: no plan, no follow-on', () => withWorld(`
  settings.head, settings.remarks = true, 'off'
  randomValue = 0.1
  assert(untilSent(1500))
  local source = sent[1]
  speech.requestId, speech.context = source.requestId, {generation = source.generation, entity = source.entity}
  speech.transcript = function() return {textComplete = true, text = 'Nothing much happening.'} end
  tick(1)
  assert(convaiSpeakUpState.plan == nil)
  speech.requestId = nil; speech.onStopped(source.requestId, 'finished')
  assert(#sent == 1)
`));

test('scene: her comment is prepared while the last line plays, said once the scene is over, and dropped when the scene goes on', () => {
  // The companion is out of reach while the first target gap passes (the clock runs), so only the scene candidate can start her afterwards.
  const ready = `
    person.available = false
    tick(900)
    local function line(present) convaiSpeakUpScene({channel = 'scene', speaker = 'npc', profileKey = 'rogue-amendiares', present = present or {'judy-alvarez'}, text = 'x'}) end
  `;
  withWorld(ready + `
    line(); line(); line()
    tick(2.6)
    person.available = true
    tick(0.1)
    local plan = convaiSpeakUpState.plan
    assert(plan and plan.kind == 'ahead' and plan.context.reaction.event == 'scene', 'prepared once the scene had been quiet 2.5 s')
    assert(plan.context.gameDialogue and plan.context.journal, 'with the scene lines and the quest')
    local command = tableOf(files['runtime/group-prefetch.json'])
    assert(command.kind == 'ahead' and command.input == plan.context and command.sourceRequestId == nil)
    assert(#sent == 0 and convaiSpeakUp:holder() == 'companion', 'held, not said')
    tick(4)
    assert(#sent == 1 and sent[1] == plan.context and convaiSpeakUpState.plan == nil and convaiSpeakUpState.scene == nil, 'said once the scene is over')
  `);
  withWorld(ready + `
    line(); line(); line()
    tick(2.6)
    person.available = true
    tick(0.1)
    assert(convaiSpeakUpState.plan and convaiSpeakUpState.plan.kind == 'ahead')
    line()                       -- the scene goes on
    tick(0.2)
    assert(convaiSpeakUpState.plan == nil and #sent == 0, 'dropped when another line comes')
    assert(convaiSpeakUp:holder() == nil, 'the floor is given back')
    assert(withdrawn(), 'withdrawn from the bridge')
    tick(8)
    for _, request in ipairs(sent) do assert(request.reaction.event ~= 'scene', 'one try per scene') end
  `);
  withWorld(ready + `
    for _ = 1, 3 do line({'panam-palmer'}) end    -- a companion who was not there does not comment
    tick(2.6)
    person.available = true
    tick(8)
    assert(convaiSpeakUpState.plan == nil)
    for _, request in ipairs(sent) do assert(request.reaction.event ~= 'scene') end
  `);
  withWorld(ready + `
    line()                                       -- one line is not a scene
    tick(2.6)
    person.available = true
    tick(0.5)
    assert(convaiSpeakUpState.plan == nil)
  `);
});

test('a line cut off before a word gives the floor back and does not count; a heard one does', () => withWorld(`
  assert(untilSent(1000))
  assert(convaiSpeakUp:holder() == 'companion')
  cancelAutomatic('speaker-unavailable')     -- nobody heard it (automatic.playbackAt is nil)
  assert(convaiSpeakUp:holder() == nil and convaiSpeakUp:lastSpeaker() == nil)
`));

test('eligibility: no clock and no line while V is in a fight or a scene or the observation is gone; Off means silence and unloads', () => withWorld(`
  local function silent(setup, teardown)
    setup(); tick(2400); teardown()
    assert(#sent == 0, 'a line during the blocked time')
  end
  silent(function() battleSample.combat = true end, function() battleSample.combat = false end)
  silent(function() battleSample.blocked = true end, function() battleSample.blocked = false end)
  silent(function() battleSample.available = false end, function() battleSample.available = true end)
  settings.companion = 'off'
  tick(100)
  assert(#sent == 0, 'Off means silence')
  assert(not convaiSpeakUp, 'and the scheduler is unloaded')
`));

test('V\'s own talk: nothing is said for a while after V sent a line, nor while V types; afterwards it resumes', () => withWorld(`
  person.available = false
  tick(700)                    -- her timer is due; only V's talk holds her back now
  convaiSpeakUpManualSent({requestId = 'v1', profileKey = 'judy-alvarez', name = 'Judy'})
  person.available = true
  tick(40)
  assert(#sent == 0, 'not within the quiet time after V spoke')
  tick(60, {manual = true})
  assert(#sent == 0, 'not while V types')
  tick(80)
  assert(#sent == 1, 'and then she may')
`));

test('load and unload: nothing is loaded while both lists are Off; the scheduler goes with the last list', () => withWorld(`
  settings.companion = 'off'
  assert(convaiSpeakUpService() == nil and loads == 0, 'Off: nothing loaded')
  settings.companion = 'rare'
  local first = convaiSpeakUpService()
  assert(first and loads == 1 and convaiSpeakUpService() == first and loads == 1)
  settings.companion = 'off'
  assert(convaiSpeakUpService() == nil and convaiSpeakUp == nil, 'unloaded')
  settings.head, settings.remarks = true, 'medium'
  assert(convaiSpeakUpService() and loads == 2, 'Johnny alone also runs it')
  settings.remarks = 'off'
  assert(convaiSpeakUpService() == nil, 'plain On (answers only) is Off here')
`));

test('convaiProactive: the housemates ask before a proactive exchange and note it; with both lists Off everything is allowed', () => withWorld(`
  assert(type(convaiProactive.allow) == 'function' and type(convaiProactive.note) == 'function')
  settings.companion = 'off'
  assert(convaiProactive.allow('house', 4) == true)
  convaiProactive.note('house', 4)           -- nothing to merge with: no error
  settings.companion = 'rare'
  tick(10)
  assert(convaiProactive.allow('house', 4) == true, 'a fresh scheduler has no previous line')
  convaiProactive.note('house', 4)
  assert(convaiProactive.allow('house', 4) == false, 'the exchange counts: the gap applies')
  assert(convaiSpeakUp:pick({companion = true}) == nil)
  tick(200)
  assert(convaiProactive.allow('house', 4) == true)
  assert(pcall(convaiProactive.allow, nil, nil) and pcall(convaiProactive.note, 7, 'x'), 'bad arguments never raise')
`));

test('wiring: the hooks that feed the block exist in init.lua and speech.lua, and nothing in onUpdate mentions it', () => {
  const speech = read('../mod/speech.lua');
  assert.match(speech, /pcall\(convaiVanillaReactions\.speechEnded\) end\s+local stoppedId = M\.requestId/);
  assert.match(speech, /if stoppedId and M\.onStopped then pcall\(M\.onStopped, stoppedId, reason or 'idle'\) end/);
  assert.match(init, /if sent and not context\.reaction and convaiSpeakUpManualSent then pcall\(convaiSpeakUpManualSent, context\) end/);
  assert.match(init, /if hold and hold\.requestId == automatic\.requestId then\s+convaiSpeakUpState\.hold = nil\s+if convaiSpeakUp then pcall\(convaiSpeakUp\.release, convaiSpeakUp, hold\.who, automatic\.playbackAt ~= nil\) end/);
  assert.match(init, /claimPrivateReply\(context, 'voice'\)\s+--[^\n]*\s+if convaiSpeakUpManualSent then pcall\(convaiSpeakUpManualSent, context\) end/, 'a spoken line is V talking too');
  assert.match(init, /local speakUpOn = convaiSpeakUpAdvance\(now, elapsed, worldReady, manual, outputs\)/);
  assert.match(init, /if convaiSpeakUpReset then pcall\(convaiSpeakUpReset, 'world-change'\) end/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiSpeakUp/, 'nothing per frame in onUpdate: the block runs on the 0.1 s tick and on events');
  assert.doesNotMatch(block, /registerForEvent|Observe\(|Override\(/, 'no new hook');
  assert.doesNotMatch(read('../mod/speak-up.lua'), /Game\./, 'the scheduler is pure');
});

test('one unprompted speaker at a time: a housemate line or chat, or an arrival greeting (convaiUnpromptedBusy), keeps the speak-up clock and offer quiet', () => withWorld(`
  local housesBusy = true
  function convaiUnpromptedBusy() return housesBusy end
  tick(3600 * 2)
  assert(#sent == 0, 'nothing is offered while a housemate chat or a greeting holds the floor: ' .. #sent)
  assert(convaiSpeakUpState.calmFor == 0, 'and the calm time does not build up meanwhile')
  housesBusy = false
  assert(untilSent(1500), 'it speaks up again once they are done')
`));

test('the init.lua tick hands the speak-up offer and the eligibility the housemate and greeting busy test, and housemates expose a pair-chat flag', () => {
  assert.match(init, /function convaiUnpromptedBusy\(\)\s+if convaiPartyState and convaiPartyState\.chat then return true end\s+if convaiHouseWaiting or convaiHouseCurrent or convaiMeetGreetingWaiting or convaiMeetGreetingCurrent then return true end/);
  assert.match(init, /if convaiUnpromptedBusy and convaiUnpromptedBusy\(\) then return false end/);
  assert.match(init, /convaiSpeakUpOffer\(player, now, worldReady, outputs, manual, busy or \(convaiUnpromptedBusy ~= nil and convaiUnpromptedBusy\(\)\), mayFollow\)/);
  assert.match(read('../mod/housemates.lua'), /function C\.chatActive\(\) return chat ~= nil and chat\.active ~= nil and chat\.active\(\) == true end/);
});
