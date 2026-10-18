import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): the story gate, the standing, the busy gate and the service of
// mod/johnny-head.lua, in fengari.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/johnny-head.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local J = (function() ${moduleSource} end)()
  -- Every fact the module knows, at zero, with overrides.
  local function facts(over)
    local f = {[J.START] = 1}
    for _, name in ipairs(J.ENDINGS) do f[name] = 0 end
    for _, row in ipairs(J.MILESTONES) do f[row.fact] = 0 end
    for k, v in pairs(over or {}) do if v == false then f[k] = nil else f[k] = v end end
    return f
  end
  local function list(t) return table.concat(t, ',') end
${code}`);

// ---------------------------------------------------------------------------------------------------------------------
// The story gate.

test('story: in V\'s head after Playing for Time until an ending removes him; an unreadable fact closes the gate', () => withModule(`
  assert(J.START == 'q101_done')
  assert(J.story(facts()) == 'active')
  assert(J.story(facts({q101_done = 0})) == 'before', 'before the story puts him there')
  for _, name in ipairs({'q201_active', 'q201_done', 'q202_active', 'q202_done', 'q203_active', 'q204_active', 'q204_done', 'q307_2079'}) do
    assert(J.story(facts({[name] = 1})) == 'after', name .. ' is an ending that removes him')
  end
  assert(#J.ENDINGS == 8)
  assert(J.story(facts({q101_done = false})) == 'unreadable')
  assert(J.story(facts({q203_active = false})) == 'unreadable', 'an unread ending must not open the gate')
  assert(J.story(facts({q101_done = 0, q203_active = false})) == 'before', 'nothing past the start is needed before it')
  assert(J.story(nil) == 'unreadable' and J.story({}) == 'unreadable')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The standing.

test('stage: wary, grudging, friends and close follow the shared milestones; the milestones are listed in order', () => withModule(`
  local stage, reached = J.stage(facts())
  assert(stage == 'wary' and #reached == 0)
  stage, reached = J.stage(facts({q110_made_contact_with_alt = 1}))
  assert(stage == 'grudging' and list(reached) == 'alt')
  stage, reached = J.stage(facts({sq031_cool_metal_fire_done = 1, sq031_porsche_unlocked = 1}))
  assert(stage == 'grudging' and list(reached) == 'bender,porsche', 'no second chance: grudging however much is shared')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1}))
  assert(stage == 'friends' and list(reached) == 'second-chance')
  stage = J.stage(facts({sq032_johnny_friend = 1, sq031_cool_metal_fire_done = 1, sq031_rogue_date_done = 1}))
  assert(stage == 'friends', 'his night out does not count towards close')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1, sq031_rogue_date_done = 1, sq031_samurai_concert_done = 1}))
  assert(stage == 'close' and list(reached) == 'second-chance,rogue-date,reunion')
  stage, reached = J.stage(facts({sq032_johnny_friend = 1, q110_made_contact_with_alt = 1, sq031_porsche_unlocked = 1, sq031_cool_metal_fire_done = 1}))
  assert(stage == 'close' and list(reached) == 'alt,bender,porsche,second-chance')
  -- A fact counts only above zero; an unread milestone is simply not reached.
  stage = J.stage(facts({sq032_johnny_friend = false, q110_made_contact_with_alt = 1}))
  assert(stage == 'grudging')
  -- Not in V's head: the story state, with nothing reached.
  stage, reached = J.stage(facts({q101_done = 0, sq032_johnny_friend = 1}))
  assert(stage == 'before' and #reached == 0)
  assert(J.stage(facts({q204_done = 1})) == 'after')
  assert(J.stage(facts({q101_done = false})) == 'unreadable')
  -- Every milestone has a fact name, and the ids are what the bridge words (bridge/johnny-head.mjs).
  local ids = {}
  for _, row in ipairs(J.MILESTONES) do assert(type(row.fact) == 'string' and row.fact ~= ''); ids[#ids + 1] = row.id end
  assert(list(ids) == 'alt,bender,porsche,second-chance,rogue-date,reunion')
  local head = J.headField('friends', {'second-chance'})
  assert(head.version == 1 and head.stage == 'friends' and head.milestones[1] == 'second-chance')
  assert(type(J.headField('wary').milestones) == 'table')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The busy gate.

test('busy: the game has the floor in a scene, a call, a quest conversation, a fight, a replacer, or right after a line of his', () => withModule(`
  local function sample(over)
    local s = {available = true, tier = 1, dialogue = false, choices = false, call = false, combat = false, replacer = false, vehicle = false}
    for k, v in pairs(over or {}) do s[k] = v end
    return s
  end
  assert(J.busy(sample()) == nil, 'open gameplay')
  assert(J.busy(sample({vehicle = true})) == nil, 'a drive is fine: he talks in the car')
  assert(J.busy(sample({choices = true})) == nil, 'a choice at tier 1 is the Talk prompt on a vendor, not a conversation')
  assert(J.busy(sample({tier = 2})) == 'scene', 'staged gameplay: the game often stages its own Johnny there')
  assert(J.busy(sample({tier = 3})) == 'scene' and J.busy(sample({tier = 5})) == 'scene')
  assert(J.busy(sample({tier = false, choices = true})) == 'scene', 'a choice with the tier unknown fails closed')
  assert(J.busy(sample({tier = false})) == nil)
  assert(J.busy(sample({dialogue = true})) == 'dialogue')
  assert(J.busy(sample({call = true})) == 'call')
  assert(J.busy(sample({combat = true})) == 'combat')
  assert(J.busy(sample({replacer = true})) == 'replacer', 'the player is someone else (a flashback as Johnny)')
  assert(J.busy(sample(), true) == 'johnny-speaking')
  assert(J.busy(sample({replacer = true, call = true, dialogue = true, tier = 3, combat = true}), true) == 'replacer', 'the first reason wins')
  assert(J.busy(sample({call = true, tier = 3})) == 'call')
  assert(J.busy(nil) == 'unreadable' and J.busy({available = false}) == 'unreadable')
`));

test('recentLine: a game line of his in the last seconds, newest first, never older ones or other speakers', () => withModule(`
  local rows = {{profileKey = 'johnny-silverhand', at = 100}, {profileKey = 'judy-alvarez', at = 195}, {at = 196}}
  assert(J.recentLine(rows, 200, J.KEY, 10) == false, 'his line is 100 s old')
  rows[#rows + 1] = {profileKey = 'johnny-silverhand', at = 192}
  assert(J.recentLine(rows, 200, J.KEY, 10) == true)
  assert(J.recentLine(rows, 203, J.KEY, 10) == false, 'just past the window')
  assert(J.recentLine({}, 200, J.KEY, 10) == false and J.recentLine(nil, 200, J.KEY, 10) == false)
  assert(J.recentLine({{profileKey = 'johnny-silverhand'}}, 200, J.KEY, 10) == false, 'a row without a time is skipped')
  assert(J.LINE_SECONDS == 10)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The service against a fake game.

const service = `
  local t, wall, values, reads = 0, 1000, {}, {}
  for name, value in pairs(facts()) do values[name] = value end
  local readable = true
  local function readFact(name)
    reads[#reads + 1] = name
    if not readable then error('no quests system') end
    return values[name] or 0
  end
  local state = {sample = {available = true, tier = 1, dialogue = false, choices = false, call = false, combat = false, replacer = false}, samples = 0}
  local rows = {}
  local S = J.new({readFact = readFact, clock = function() return t end, now = function() return wall end,
    sample = function(player) state.samples = state.samples + 1; assert(player == 'V'); return state.sample end,
    lines = function() return rows end})
  local player = {GetEntityID = function() return {hash = '4242ULL'} end}
  local function tick(seconds) t = t + seconds; wall = wall + seconds end
`;

test('service: facts held five seconds, nothing past the start read before it, refusals held 0.4 s', () => withModule(`${service}
  values.q101_done = 0
  assert(S:refusal('V') == 'before')
  assert(#reads == 1 and reads[1] == 'q101_done', 'before the story only the start is read')
  assert(state.samples == 0, 'no sample is taken when he is not in V\\'s head')
  values.q101_done = 1
  assert(S:refusal('V') == 'before', 'held 0.4 s')
  tick(0.5)
  assert(S:refusal('V') == 'before', 'the facts are held 5 s')
  tick(5)
  assert(S:refusal('V') == nil, 'in V\\'s head and the game does not have the floor')
  assert(#reads == 1 + 1 + #J.ENDINGS + #J.MILESTONES, 'fifteen reads in all')
  assert(state.samples == 1)
  state.sample.combat = true
  assert(S:refusal('V') == nil, 'held')
  tick(0.5)
  assert(S:refusal('V') == 'combat' and state.samples == 2)
  state.sample.combat = false
  rows[1] = {profileKey = 'johnny-silverhand', at = wall - 3}
  tick(0.5)
  assert(S:refusal('V') == 'johnny-speaking')
  tick(10)
  assert(S:refusal('V') == nil, 'his game line is older than ten seconds now')
  values.q307_2079 = 1
  tick(5)
  assert(S:refusal('V') == 'after')
  readable = false
  S:reset()
  assert(S:refusal('V') == 'unreadable' and S:standing() == 'unknown')
`));

test('service: the partner is V\'s own entity with his profile, voice only and the head field; the standing for the settings page', () => withModule(`${service}
  values.sq032_johnny_friend, values.sq031_rogue_date_done, values.sq031_samurai_concert_done = 1, 1, 1
  local partner = assert(S:partner(player))
  assert(partner.npc == player and partner.entity == '4242ULL','V\\'s entity hash')
  assert(partner.profileKey == 'johnny-silverhand' and partner.name == 'Johnny Silverhand' and partner.voiceOnly == true and partner.bodyType == '')
  assert(partner.holocall == nil, 'not a holocall: his own marker')
  assert(partner.head.version == 1 and partner.head.stage == 'close' and table.concat(partner.head.milestones, ',') == 'second-chance,rogue-date,reunion')
  assert(S:standing() == 'close')
  assert(S:partner({GetEntityID = function() error('gone') end}) == nil)
  values.q101_done = 0
  S:reset()
  assert(S:standing() == 'before')
`));

test('the module is read-only, has no update entry point and never touches the game\'s Johnny', () => {
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|function [A-Za-z.:]*update\b/);
  assert.doesNotMatch(moduleSource, /:Set[A-Z]\w*\(|:Apply\w*\(|:Play\w*\(|:Queue\w*\(|:Send\w*\(|CreateEntity|DeleteEntity|io\.open|os\.remove/);
  assert.doesNotMatch(moduleSource, /Character\.Silverhand|GetLookAtObject|GetTargetParts/, 'no lookup of the game\'s Johnny');
});

// ---------------------------------------------------------------------------------------------------------------------
// The wiring in init.lua, speech and continuous speech.

const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};

test('loader: nothing is loaded while the setting is off; loaded once on first need; a broken module is not retried', () => {
  const loader = between('function convaiJohnnyHeadService()', '-- The one rule for characters the game placed');
  run(`
    local on, loads, broken = false, 0, false
    local manager = {johnnyInHead = function() return on end}
    local battleObserver = {sample = function() return {available = true} end}
    local real = (function() ${moduleSource} end)()
    function dofile(path)
      assert(path == 'johnny-head.lua'); loads = loads + 1
      if broken then error('missing file') end
      return real
    end
    print = function() end
    ${loader}
    assert(convaiJohnnyHeadService() == nil and loads == 0, 'off: not even read from disk')
    assert(convaiJohnnyStanding() == nil and loads == 0)
    on = true
    local service = assert(convaiJohnnyHeadService())
    assert(loads == 1 and service.key == 'johnny-silverhand' and service.name == 'Johnny Silverhand')
    assert(convaiJohnnyHeadService() == service and loads == 1, 'loaded once')
    on = false
    assert(convaiJohnnyHeadService() == nil, 'turned off: the talk keys stop asking it')
    convaiJohnnyHead, broken, on = nil, true, true
    assert(convaiJohnnyHeadService() == nil and loads == 2)
    assert(convaiJohnnyHeadService() == nil and loads == 2, 'a failed load is not retried every key press')
  `);
});

test('talk keys: with nobody in front of V and private talk, Johnny answers, is busy, or the old notice stays', () => {
  const select = between('local function selectConversation(player, groupMode, singleAction, addonHears)', 'local function voiceTargetValid');
  const head = between('-- Johnny in your head (docs/JOHNNY_IN_YOUR_HEAD.md): with nobody in front of V', "if not npc then convaiNotices.send(player, 'talk-no-target'", select);
  // After the crosshair, the add-on voices and the group candidates; before the "face a nearby character" notice; private only.
  assert.ok(select.indexOf('targetAtCrosshair()') < select.indexOf(head) && select.indexOf('convaiAddons.talkCandidates') < select.indexOf(head));
  assert.match(head, /if not npc and not groupMode then/);
  assert.match(head, /local head = convaiJohnnyHeadService\(\)/);
  assert.match(head, /if head and why == nil and supportedProfiles\[head\.key\] and profileEnabled\(player, head\.key\) then/, 'a muted Johnny stays muted');
  assert.match(head, /convaiHeadTalk = \{entity = partner\.entity\}/);
  assert.match(head, /why ~= 'before' and why ~= 'after' and why ~= 'unreadable' then[\s\S]*convaiNotices\.send\(player, 'talk-busy', ui\.t\('\{name\} is busy right now\.', \{name = head\.name\}\)\)\s+return nil/);
  // A holocall still wins: it is asked first.
  assert.ok(select.indexOf('convaiHolocall.partner(player, groupMode)') < select.indexOf(head));
});

test('talk keys: his turn has no face, gaze, actions or add-on blocks, and the recording and reply follow the busy gate', () => {
  assert.match(init, /\(not primary\.voiceOnly or primary\.head\) and autoConnect\.talkNotice\(key, name\)/, 'the typed path says when he is still connecting');
  assert.match(init, /holocall = primary\.holocall, head = primary\.head\}/);
  assert.match(init, /voiceOnly = primary\.voiceOnly, holocall = primary\.holocall, head = primary\.head\}/);
  assert.match(init, /if primary\.head then\s+local head = convaiJohnnyHeadService\(\)\s+return head ~= nil and head:refusal\(Game\.GetPlayer\(\)\) == nil\s+end\s+if primary\.voiceOnly then/);
  assert.match(init, /elseif context\.head then\s+-- Johnny in V's head has no body[^\n]*\s+elseif context\.voiceOnly then/);
  assert.match(init, /if type\(context\.head\) == 'table' then return false end\s+if convaiStory and convaiStory\.entity == context\.entity then return false end\s+return gameplayActions\.capture\(context, context\.group and 'group-voice' or 'private-voice'\)/);
  assert.match(init, /if context\.voiceOnly and not context\.holocall and not context\.head and convaiAddons/);
  // The reply guard: the story guard's hook ends his reply when the game takes the floor.
  const guard = between('speech.storyGuard = function', 'local story = convaiStory');
  assert.match(guard, /context\.entity == headTalk\.entity\s+and \(type\(context\.head\) == 'table' or \(not starting and speech\.head == true\)\)/);
  assert.match(guard, /retirePrivateReply\(context\.entity, 'head-' \.\. why\)/);
  // A session end forgets him.
  assert.match(init, /convaiHeadTalk = nil\s+if convaiJohnnyHead then convaiJohnnyHead:reset\(\) end/);
  // Speech: V's own sound like a holocall, no face, no add-on hooks.
  const speech = read('../mod/speech.lua');
  assert.match(speech, /if not M\.holocall and not M\.head then return false end/);
  assert.match(speech, /M\.head = type\(context\.head\) == 'table'/);
  assert.match(speech, /if M\.voiceOnly and not M\.head and type\(M\.voiceSource\) == 'function' then/);
  assert.match(speech, /if M\.voiceOnly and not M\.head and type\(M\.hideCaption\) == 'function' then/);
  const continuous = read('../mod/continuous-speech.lua');
  assert.match(continuous, /if owner and \(owner\.holocall or owner\.head\) then speakerDistance = 0; return volume or 0, 0 end/);
  assert.match(continuous, /head=type\(context\.head\)=='table' or nil/);
});

test('cost: nothing of his runs per frame, and the module is loaded only through the setting', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiJohnnyHead|convaiHeadTalk|johnny-head|johnnyInHead/, 'onUpdate is untouched');
  const loads = init.match(/dofile, 'johnny-head\.lua'/g) ?? [];
  assert.equal(loads.length, 1, 'one loader');
  assert.match(between('function convaiJohnnyHeadService()', "pcall(dofile, 'johnny-head.lua')"), /if not manager\.johnnyInHead\(\) then return nil end/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The bridge: the head field, the right-now sentence and the head block.

const {parseInput} = await import('./protocol.mjs');
const {parseHead, headContext, headOf, MAX_CHARS} = await import('./johnny-head.mjs');
const {turnContext, turnContextDiagnostic} = await import('./turn-context.mjs');
const {conversationContextBlocks} = await import('./quest-context.mjs');
const {buildMessages} = await import('./mistral-prompt.mjs');

const snapshot = {version: 1, status: 'ready', hour: 22, minute: 5, district: 'Watson', health: 'hurt', money: 'low', heat: 1,
  party: [{key: 'judy-alvarez', name: 'Judy Alvarez', activity: 'following'}]};
const raw = over => JSON.stringify({requestId: '1-2-33ULL', generation: 2, entity: '33ULL', name: 'Johnny Silverhand', bodyType: '',
  profileKey: 'johnny-silverhand', text: 'What should I do next?', turnContext: snapshot,
  head: {version: 1, stage: 'grudging', milestones: ['alt', 'bender']}, ...over});

test('parseHead: a known stage and known milestones only; CET\'s empty list; anything else is dropped', () => {
  assert.deepEqual(parseHead({version: 1, stage: 'wary', milestones: {}}), {stage: 'wary', milestones: []});
  assert.deepEqual(parseHead({version: 1, stage: 'close', milestones: ['second-chance', 'reunion', 'reunion', 'nope', 7]}),
    {stage: 'close', milestones: ['second-chance', 'reunion']});
  for (const bad of [null, [], {stage: 'wary', milestones: []}, {version: 2, stage: 'wary', milestones: []},
    {version: 1, stage: 'lovers', milestones: []}, {version: 1, stage: 'before', milestones: []}, {version: 1, stage: 'wary'},
    {version: 1, stage: 'wary', milestones: {a: 1}}, {version: 1, stage: 'wary', milestones: Array(7).fill('alt')}]) {
    assert.equal(parseHead(bad), null, JSON.stringify(bad));
  }
});

test('parseInput: a private turn keeps the head (never a holocall as well); a group round or a malformed head drops it', () => {
  const input = parseInput(raw({holocall: {version: 1, contact: 'johnny', mode: 'audio'}}));
  assert.deepEqual(input.head, {stage: 'grudging', milestones: ['alt', 'bender']});
  assert.equal(input.holocall, undefined, 'the head wins over a holocall');
  assert.equal(parseInput(raw({head: {version: 1, stage: 'lovers'}})).head, undefined);
  assert.equal(parseInput(raw({head: undefined})).head, undefined);
  assert.ok(parseInput(raw({head: 'x'})), 'a malformed head never loses the message');
});

test('right now: he is in V\'s head with no body, knows what V sees and feels, and never gets a place of his own', () => {
  const input = parseInput(raw());
  const text = turnContext(input);
  assert.ok(text.startsWith("Right now (from the game, this turn only): You are in V's head, the engram on the Relic: you see what V sees and hear what V hears, nobody else sees or hears you, and V talks to you under their breath; V is in Watson."), text);
  assert.match(text, /Also with V: Judy Alvarez\. /, 'he sees who is with V');
  assert.match(text, /V is hurt\. The police are after V\. .*V is short on cash\./);
  assert.match(text, /you have no body here and go wherever V goes/);
  assert.doesNotMatch(text, /with V in person|on a voice call|messaging V|You are indoors|You are outdoors/);
  assert.ok(text.length <= 900);
  assert.match(turnContextDiagnostic(input), new RegExp(`^Turn context: \\d+ facts, ${text.length} chars head=grudging$`));
  // Anyone else with a stray head field, a phone chat or a group round is unchanged.
  const other = parseInput(raw({profileKey: 'judy-alvarez', name: 'Judy Alvarez'}));
  assert.match(turnContext(other), /You are with V in person/);
  assert.match(turnContext({...input, channel: 'phone'}), /messaging V by text/);
  assert.equal(headOf({...input, group: {id: 'g', index: 1}}), null);
  assert.equal(headOf({...input, reaction: {kind: 'battle'}}), null);
});

test('the head block: his stage in his words, what they went through, and "what next" from V\'s open jobs; only for his turn', () => {
  const words = stage => headContext(parseInput(raw({head: {version: 1, stage, milestones: []}})));
  assert.match(words('wary'), /stuck with each other: the Relic put you in V's head and it is killing V\. There is no trust yet/);
  assert.match(words('grudging'), /grudging respect between you, not friendship/);
  assert.match(words('friends'), /At the oil fields V gave you one last chance and you said you would try\. You are friends now/);
  assert.match(words('close'), /You trust V and V trusts you/);
  const text = headContext(parseInput(raw({head: {version: 1, stage: 'close', milestones: ['alt', 'porsche', 'second-chance', 'reunion']}})));
  assert.match(text, /^YOU AND V \(from this save's story, this conversation only\)\n/);
  assert.match(text, /Behind you both: you and V reached Alt beyond the Blackwall, V found your old Porsche and Samurai played the reunion concert\./);
  assert.doesNotMatch(text, /Behind you both:[^\n]*oil fields/, 'the second chance is in the stage sentence, not repeated');
  assert.match(text, /pick one of V's open jobs listed in this context and say which you would do and why/);
  assert.match(text, /Never invent a job\./);
  assert.ok(text.length <= MAX_CHARS);
  assert.doesNotMatch(words('wary'), /Behind you both/);
  assert.equal(headContext(parseInput(raw({profileKey: 'judy-alvarez'}))), '', 'nobody else gets it');
  assert.equal(headContext(parseInput(raw({head: undefined}))), '');
  // In the turn's blocks: right after the now block, never cut (no key), for his named profile.
  const blocks = conversationContextBlocks(parseInput(raw()));
  assert.equal(blocks[0].tier, 'now');
  assert.equal(blocks[1].tier, 'world'); assert.match(blocks[1].text, /^YOU AND V/); assert.equal(blocks[1].key, undefined);
});

test('the text providers say where he is right before V\'s words', () => {
  const now = turnContext(parseInput(raw()));
  const messages = buildMessages({persona: {name: 'Johnny Silverhand', ambient: false, backstory: 'A rockerboy engram.', style: 'Dry.',
    samples: ['V: Hi. Johnny: What.']}, contextParts: {now, notes: '', world: '', volatile: ''}, text: 'hey'});
  const last = messages[messages.length - 1].content;
  assert.match(last, /\[YOU, RIGHT NOW: You are in V's head, the engram on the Relic: [^\]]*V is in Watson\. You have no body; you go where V goes/);
});

test('shipping: the module ships and dev-installs; the setting has its row and help in English and all 15 languages', () => {
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(plan), /"source": "mod\/johnny-head\.lua",\s+"target": "bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/AiNpcCyberpunkMod\/johnny-head\.lua"/, plan);
  }
  assert.match(read('../mod/mcm.lua'), /setting\('johnnyInHead', 'Johnny in your head', 'bool', snapshot\.settings\.johnnyInHead == true, false,/);
  const en = JSON.parse(read('../localization/en.json')).strings;
  const strings = Object.keys(en).filter(key => /Johnny|Grudging respect|Close friends|Not in your head yet|Gone after the ending|^Wary$|^Friends$/.test(key));
  assert.ok(strings.length >= 10, strings.join(' | '));
  for (const locale of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const source = read(`../mod/locales/${locale}.lua`);
    for (const key of strings) assert.ok(source.includes(`["${key.replace(/\n/g, '\\n')}"]`), `${locale}: ${key.slice(0, 40)}`);
  }
});
