import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseInput} from './protocol.mjs';
import {battleTrigger, battleContext} from './battle-context.mjs';
import {parseHeadReaction, headTrigger} from './johnny-head.mjs';
import {REMARK_SHARE, RemarkAllowance, SharedKeyGuard, TurnLimitError, remarkCap} from './shared-key-guard.mjs';

// Johnny speaks up (docs/JOHNNY_IN_YOUR_HEAD.md, phase 2): the remark policy of mod/johnny-remarks.lua, the collectors that hand events
// over, the automatic-turn wiring in init.lua, the bridge's trigger and the shared key's remark share.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/johnny-remarks.lua');
const init = read('../mod/init.lua');
const between = (from, to, source = init) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return source.slice(start, end);
};

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
const withModule = code => run(`local R = (function() ${moduleSource} end)()
  local level = 'normal'
  local S = R.new({level = function() return level end})
${code}`);

// ---------------------------------------------------------------------------------------------------------------------
// The events.

test('events: a named character heard in person, a finished main or side job, a romance fact; nothing else', () => withModule(`
  local subject, facts = R.personEvent({channel = 'scene', speaker = 'npc', profileKey = 'rogue-amendiares', name = 'Rogue'})
  assert(subject == 'person:rogue-amendiares' and facts.name == 'Rogue' and facts.profileKey == 'rogue-amendiares')
  assert(R.personEvent({channel = 'phone', speaker = 'npc', profileKey = 'judy-alvarez', name = 'Judy'}) == nil, 'a call is not a meeting')
  assert(R.personEvent({channel = 'ambient', speaker = 'npc', profileKey = 'judy-alvarez', name = 'Judy'}) == nil)
  assert(R.personEvent({channel = 'scene', speaker = 'v', name = 'V'}) == nil, 'V herself')
  assert(R.personEvent({channel = 'scene', speaker = 'npc', profileKey = 'johnny-silverhand', name = 'Johnny'}) == nil, 'never himself')
  assert(R.personEvent({channel = 'scene', speaker = 'npc', profileKey = 'npc-tyger-claws', name = 'Ganger'}) == nil, 'an archetype')
  assert(R.personEvent({channel = 'scene', speaker = 'npc', name = 'Somebody'}) == nil, 'not on the roster')
  assert(R.personEvent({channel = 'scene', speaker = 'npc', profileKey = 'judy-alvarez'}) == nil, 'no name')
  subject, facts = R.questEvent({id = '77', title = 'Chippin\\' In', state = 'succeeded', questType = 'SideQuest',
    nativePath = 'quests/side_quest/sq031_cyberpsycho/x'})
  assert(subject == 'quest:77' and facts.title == 'Chippin\\' In' and facts.outcome == 'succeeded' and facts.mine == true)
  subject, facts = R.questEvent({id = '8', title = 'The Pickup', state = 'failed', questType = 'MainQuest', nativePath = 'quests/main_quest/q003'})
  assert(facts.outcome == 'failed' and facts.mine == false)
  assert(R.questEvent({id = '9', title = 'A gig', state = 'succeeded', questType = 'StreetStory'}) == nil, 'no gigs')
  assert(R.questEvent({id = '9', title = 'Hustle', state = 'succeeded', questType = 'Contract'}) == nil, 'no NCPD hustles')
  assert(R.questEvent({id = '9', title = 'Open', state = 'active', questType = 'MainQuest'}) == nil)
  assert(R.questEvent({id = '9', title = 'LocKey#123', state = 'succeeded', questType = 'MainQuest'}) == nil)
  subject, facts = R.romanceEvent('sq030_judy_lover')
  assert(subject == 'romance:judy-alvarez' and facts.name == 'Judy' and facts.what == 'together')
  assert(select(2, R.romanceEvent('sq028_kerry_dislike')).what == 'declined')
  assert(select(2, R.romanceEvent('sq030_friendship')).what == 'friends')
  assert(R.romanceEvent('sq030_romance') == nil, 'a fact that is only observed, not the decision')
  assert(R.romanceEvent('nope') == nil)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The policy: when a remark may be spoken, and how often.

test('policy: an event waits 10 s past its last line, then the rate decides: Normal 5 min apart and 6 an hour, Rare 15 min and 2', () => withModule(`
  assert(R.LEVELS.normal.gap == 300 and R.LEVELS.normal.hour == 6 and R.LEVELS.rare.gap == 900 and R.LEVELS.rare.hour == 2)
  assert(S:pending() == false and S:offer(0) == nil)
  assert(S:note('person', 'person:rogue', {name = 'Rogue'}, 100))
  assert(S:pending())
  assert(S:offer(105) == nil, 'the scene may still be going on')
  assert(S:note('person', 'person:rogue', {name = 'Rogue'}, 108), 'her next line refreshes the event')
  assert(S:offer(115) == nil)
  local entry = assert(S:offer(118))
  assert(entry.subject == 'person:rogue')
  assert(S:claim(entry, 118) and not S:pending())
  assert(S:note('person', 'person:rogue', {name = 'Rogue'}, 200) == false, 'the same person is not remarked on again within the hour')
  assert(S:note('quest', 'quest:1', {title = 'A'}, 200))
  assert(S:offer(300) == nil, 'five minutes since the last remark')
  assert(S:offer(418) ~= nil)
  -- Six in an hour at most.
  local t = 418
  for i = 1, 5 do
    local e = S:offer(t); assert(e, 'remark ' .. i); S:claim(e, t)
    t = t + 300
    S:note('quest', 'quest:x' .. i, {title = 'B'}, t - 20)
  end
  assert(#S.said == 6)
  assert(S:offer(t) == nil, 'the hour holds six')
  -- Rare.
  level = 'rare'
  local Q = R.new({level = function() return level end})
  Q:note('romance', 'romance:judy', {name = 'Judy'}, 0)
  local first = assert(Q:offer(20)); Q:claim(first, 20)
  Q:note('quest', 'quest:2', {title = 'C'}, 580)
  assert(Q:offer(600) == nil, 'fifteen minutes apart')
  Q:note('quest', 'quest:2', {title = 'C'}, 900)
  local second = assert(Q:offer(920)); Q:claim(second, 920)
  Q:note('quest', 'quest:3', {title = 'D'}, 1830)
  assert(Q:offer(1840) == nil, 'two an hour')
  Q:note('quest', 'quest:3', {title = 'D'}, 3600)
  assert(Q:offer(3621) ~= nil, 'the first one is an hour old now')
`));

test('policy: Off keeps nothing; events expire; the queue is bounded; a remark nobody heard gives its slot back; a load forgets the queue', () => withModule(`
  level = 'off'
  assert(S:note('person', 'person:judy', {name = 'Judy'}, 0) == false and not S:pending())
  level = 'normal'
  assert(S:note('person', 'person:judy', {name = 'Judy'}, 0))
  assert(S:offer(R.TTL.person + 1) == nil and not S:pending(), 'too late: dropped')
  for i = 1, R.MAX_QUEUE + 2 do S:note('quest', 'quest:' .. i, {title = 'Q'}, 1000) end
  assert(#S.queue == R.MAX_QUEUE and S.queue[1].subject == 'quest:3', 'the oldest go first')
  local entry = assert(S:offer(1010)); S:claim(entry, 1010)
  assert(S.current == entry and #S.said == 1)
  S:release(entry, false)
  assert(#S.said == 0 and S.current == nil, 'not heard: the slot is back')
  assert(S:note('quest', entry.subject, {title = 'Q'}, 1020) == false, 'but its subject stays cooled down')
  local other = assert(S:offer(1020)); S:claim(other, 1020); S:release(other, true)
  assert(#S.said == 1, 'heard: it counts')
  S:reset()
  assert(not S:pending() and #S.said == 1)
  assert(S:note('nope', 's', {}, 0) == false and S:note('quest', nil, {}, 0) == false)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The collectors: each calls its optional callback only for a real change, never on the first capture of a world.

test('relationship receipts: a fact newly set calls onFact once; the first capture of a world is a baseline', () => {
  run(`
    local R = (function() ${read('../mod/relationship-state.lua').replace('local function write(value)', 'local function unusedWrite(value)')} end)()
    local frame = {status = 'ready', worldToken = 'w1', generation = 1}
    local values, now, seen = {}, 0, {}
    local C = R.new({currentWorld = function() return frame end, readFact = function(name) return values[name] or 0 end,
      readVersion = function() return '2.31' end, clock = function() return now end, publish = function() return true end})
    C.onFact = function(name) seen[#seen + 1] = name end
    values.sq030_judy_lover = 1
    assert(C:update(frame))
    assert(#seen == 0, 'baseline: a romance already in the save is not news')
    now = 3000; values.sq027_panam_lover = 1
    assert(C:update(frame))
    assert(#seen == 1 and seen[1] == 'sq027_panam_lover')
    now = 6000
    assert(C:update(frame)); assert(#seen == 1, 'no change, no call')
    frame = {status = 'ready', worldToken = 'w2', generation = 1}; now = 9000; values.sq029_river_lover = 1
    assert(C:update(frame)); assert(#seen == 1, 'a new world is a new baseline')
  `);
});

test('game dialogue and journal history: one optional callback each, nothing when unset', () => {
  const dialogue = read('../mod/game-dialogue.lua');
  assert.match(dialogue, /self:prune\(now\)\s+-- A recorded line, for Johnny speaks up[^\n]*\s+if type\(self\.options\.onRow\) == 'function' then pcall\(self\.options\.onRow, row\) end\s+return true/);
  const history = read('../mod/journal-history.lua');
  const block = between("if lane=='history' and type(self.onFinished)=='function' and target.cache then", 'target.cache=job;', history);
  assert.match(block, /\(quest\.state=='succeeded' or quest\.state=='failed'\) and \(not old or old\.state~=quest\.state\)/);
  assert.match(block, /if #done>0 and #done<=4 then pcall\(self\.onFinished,done\) end/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The wiring in init.lua.

test('loader: nothing is loaded unless both settings are on; events reach the queue through the module\'s pure readers', () => {
  const loader = between('function convaiJohnnyRemarksService()', '-- The one rule for characters the game placed');
  run(`
    local inHead, level, loads, logged = false, 'off', 0, {}
    local manager = {johnnyInHead = function() return inHead end, johnnyRemarks = function() return level end}
    local real = (function() ${moduleSource} end)()
    function dofile(path) assert(path == 'johnny-remarks.lua'); loads = loads + 1; return real end
    convaiLogLine = function(line) logged[#logged + 1] = line end
    print = function() end
    ${loader}
    convaiJohnnyRemarkNote('romance', 'sq030_judy_lover')
    assert(loads == 0 and convaiJohnnyRemarksService() == nil, 'both off')
    level = 'normal'
    assert(convaiJohnnyRemarksService() == nil and loads == 0, 'Johnny in your head off')
    inHead, level = true, 'off'
    assert(convaiJohnnyRemarksService() == nil and loads == 0, 'speaks up off')
    level = 'rare'
    convaiJohnnyRemarkNote('romance', 'sq030_judy_lover')
    assert(loads == 1 and convaiJohnnyRemarks:pending() and logged[1] == 'Johnny speaks up: noted romance:judy-alvarez')
    convaiJohnnyRemarkNote('person', {channel = 'scene', speaker = 'npc', profileKey = 'rogue-amendiares', name = 'Rogue'})
    convaiJohnnyRemarkNote('quest', {id = '1', title = 'Ghost Town', state = 'succeeded', questType = 'MainQuest'})
    assert(#convaiJohnnyRemarks.queue == 3 and loads == 1)
  `);
  // The collectors hand events to it.
  assert.match(init, /onRow = function\(row\)\s+if convaiJohnnyRemarkNote then convaiJohnnyRemarkNote\('person', row\) end\s+--[^\n]*\s+if convaiSpeakUpScene then convaiSpeakUpScene\(row\) end/);
  assert.match(init, /journalHistory\.onFinished = function\(quests\)\s+if not convaiJohnnyRemarkNote then return end\s+for _, quest in ipairs\(quests\) do convaiJohnnyRemarkNote\('quest', quest\) end/);
  assert.match(init, /relationshipState\.onFact = function\(fact\) if convaiJohnnyRemarkNote then convaiJohnnyRemarkNote\('romance', fact\) end end/);
});

test('automatic turn: battle and loot first, then a waiting remark on the 0.1 s tick; its own validity, delivery check and release', () => {
  const battles = between('local function updateBattles(player, elapsed, worldReady)', '-- The bridge adds errorCode');
  assert.match(battles, /if automatic and automatic\.reaction\.kind == 'head' then\s+convaiJohnnyRemarkTick\(player, now, worldReady, outputs, manual\)\s+elseif automatic and automatic\.reaction\.kind == 'speakup' then\s+convaiSpeakUpManage\(player, now, worldReady, outputs, manual\)\s+elseif automatic then/);
  assert.match(battles, /if not event then\s+if speakUpOn then convaiSpeakUpOffer\(player, now, worldReady, outputs, manual, busy or \(convaiUnpromptedBusy ~= nil and convaiUnpromptedBusy\(\)\), mayFollow\) end\s+return\s+end/);
  // The scheduler (mod/speak-up.lua) decides who starts: Johnny's remark competes with the companions' candidate, one length check while nothing waits.
  const tick = between('function convaiJohnnyRemarkTick(', '-- Companions and Johnny speak up on their own');
  assert.match(tick, /cancelAutomatic\('head-' \.\. reason\)/);
  assert.doesNotMatch(tick, /sendRequest/, 'starting a remark is the scheduler\'s job');
  const offer = between('function convaiSpeakUpOffer(', 'function convaiSpeakUpManage(');
  assert.match(offer, /if remarks and remarks:pending\(\) then/, 'one length check while nothing waits');
  assert.match(offer, /if head and not head:refusal\(player\) then entry = remarks:offer\(now\) end/, 'the busy and story gates of phase 1');
  assert.match(offer, /sched:pick\(\{companion = person ~= nil, johnny = entry ~= nil\}\)/);
  const start = between('function convaiSpeakUpStartJohnny(', 'function convaiSpeakUpOffer(');
  assert.match(start, /reaction = \{kind = 'head', event = entry\.kind, facts = entry\.facts,/);
  assert.match(start, /profileKey = partner\.profileKey, voiceOnly = true, head = partner\.head/);
  assert.match(start, /convaiJohnnyRemarks:claim\(entry, now\)/);
  assert.match(between('function convaiSpeakUpSubmit(', 'function convaiSpeakUpStartJohnny('), /if reactionLease\(true\) and sendRequest\(context\) then/);
  assert.match(init, /if context\.reaction\.kind == 'head' then\s+local head = convaiJohnnyHeadService\(\)\s+local why = head == nil and 'off' or head:refusal\(player\)\s+if why then cancelAutomatic\('head-' \.\. why\); return false end/);
  assert.match(init, /if automatic\.reaction\.kind == 'head' and convaiJohnnyRemarks then\s+pcall\(convaiJohnnyRemarks\.release, convaiJohnnyRemarks, convaiJohnnyRemarks\.current, automatic\.playbackAt ~= nil\)/);
  assert.match(init, /context\.reaction and \(context\.reaction\.kind == 'loot' or context\.reaction\.kind == 'head' or speakUp\) then context\.battle = nil/);
  assert.match(init, /if convaiJohnnyRemarks then convaiJohnnyRemarks:reset\(\) end/);
  // Never per frame: onUpdate does not mention it, and the module has no update entry point.
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiJohnnyRemark|johnny-remarks|johnnyRemarks/);
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|Observe|Override|Game\./, 'pure: no native call, no hook');
});

// ---------------------------------------------------------------------------------------------------------------------
// The bridge.

const base = {requestId: '1-2-33ULL', generation: 2, entity: '33ULL', name: 'Johnny Silverhand', bodyType: '', profileKey: 'johnny-silverhand',
  text: 'Johnny speaks up unprompted. Give one brief in-character remark.', head: {version: 1, stage: 'grudging', milestones: ['alt']}};
const remark = (reaction, over = {}) => parseInput(JSON.stringify({...base, ...over,
  reaction: {kind: 'head', expiresAt: Date.now() + 60000, ...reaction}}));

test('bridge: a remark is a head reaction on his profile with his head field; facts are validated and the line is bounded', () => {
  const person = remark({event: 'person', facts: {name: 'Rogue Amendiares'}});
  assert.deepEqual(person.reaction.facts, {name: 'Rogue Amendiares'});
  assert.equal(person.reaction.maxWords, 25);
  const quest = remark({event: 'quest', facts: {title: "Chippin' In", outcome: 'succeeded', mine: true}});
  assert.deepEqual(quest.reaction.facts, {title: "Chippin' In", outcome: 'succeeded', mine: true});
  assert.equal(remark({event: 'romance', facts: {name: 'Judy', what: 'together'}}).reaction.facts.what, 'together');
  for (const bad of [{event: 'combat', facts: {}}, {event: 'person', facts: {}}, {event: 'quest', facts: {title: 'X', outcome: 'maybe'}},
    {event: 'romance', facts: {name: 'Judy', what: 'married'}}, {event: 'person', facts: {name: 'A'}, expiresAt: 0}]) {
    assert.equal(remark(bad), null, JSON.stringify(bad));
  }
  assert.equal(remark({event: 'person', facts: {name: 'A'}}, {profileKey: 'judy-alvarez'}), null, 'only his profile');
  assert.equal(remark({event: 'person', facts: {name: 'A'}}, {head: undefined}), null, 'only with his head field');
  assert.equal(parseHeadReaction({kind: 'head', event: 'person', facts: {name: 'A'}, expiresAt: 1}, null, 'johnny-silverhand'), null);
});

test('bridge: the trigger says where he is, what happened (quoted), his standing, and the limits; no battle block', () => {
  const quest = remark({event: 'quest', facts: {title: 'Ghost Town', outcome: 'failed'}});
  const text = battleTrigger(quest);
  assert.equal(text, headTrigger(quest));
  assert.match(text, /^You are Johnny Silverhand, the engram in V's head; nobody but V hears you\. This event was not spoken by V\. V has just failed the job "Ghost Town"\./);
  assert.match(text, /Where you and V stand: You and V have been through a few things since the Relic/);
  assert.match(text, /no more than 25 words/);
  assert.match(text, /Do not ask any question/);
  assert.match(battleTrigger(remark({event: 'quest', facts: {title: "Chippin' In", outcome: 'succeeded', mine: true}})), /finished the job "Chippin' In", one of your own\./);
  assert.match(battleTrigger(remark({event: 'person', facts: {name: 'Rogue'}})), /V has just been talking with "Rogue" in person \(that scene is over now\)\./);
  assert.match(battleTrigger(remark({event: 'romance', facts: {name: 'Kerry', what: 'declined'}})), /V has just turned "Kerry" down\./);
  assert.equal(battleContext(quest), '');
});

// ---------------------------------------------------------------------------------------------------------------------
// The shared key: remarks are turns, and at most a tenth of the day's.

test('shared key: remarks count as turns and may use at most REMARK_SHARE of the day (10 of 100); other turns and other keys are untouched', () => {
  assert.equal(REMARK_SHARE, 0.1);
  assert.equal(remarkCap(100), 10); assert.equal(remarkCap(5), 1); assert.equal(remarkCap(250), 25);
  let now = new Date(2026, 9, 19, 12).getTime(), shared = true;
  const guard = new SharedKeyGuard({limit: 100, now: () => now, applies: () => shared, spacingMs: 0, burst: 1000, perMinute: 100000});
  const remarks = new RemarkAllowance({guard});
  const head = {reaction: {kind: 'head'}}, battle = {reaction: {kind: 'battle'}}, talk = {};
  const admit = config => { guard.check(); remarks.check(config); guard.consume(); remarks.consume(config); };
  for (let i = 0; i < 10; i++) admit(head);
  assert.equal(guard.count, 10, 'each remark is one of the day\'s turns');
  assert.throws(() => admit(head), TurnLimitError, 'the eleventh remark of the day is refused');
  assert.equal(guard.count, 10);
  admit(talk); admit(battle);
  assert.equal(guard.count, 12, 'V\'s own turns and battle reactions go on');
  guard.setLimit(200);
  assert.doesNotThrow(() => admit(head), 'the share follows the backend\'s limit');
  shared = false; remarks.count = 999;
  assert.doesNotThrow(() => admit(head), 'a player\'s own key is never limited');
  shared = true; now += 24 * 3600 * 1000;
  assert.doesNotThrow(() => admit(head), 'a new day');
  assert.equal(remarks.count, 1);
  // Wired where a turn reaches Convai, with the turn's config.
  assert.match(read('./realtime-host.mjs'), /this\.guard\.check\(config\); this\.guard\.consume\(config\);/);
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /const remarkAllowance = await new RemarkAllowance\(\{guard: turnGuard,/);
  assert.match(bridge, /check: config => \{ turnGuard\.check\(\); remarkAllowance\.check\(config\); if \(tokenSource\) keys\.assertAllowed\(\); \}/);
  assert.match(bridge, /consume: config => \{ turnGuard\.consume\(\); remarkAllowance\.consume\(config\); \}/);
  assert.match(bridge, /'remark-usage\.json'/);
});

test('shipping: the module ships and dev-installs; the one select row (Johnny in your head, five options) has its texts in all languages; the separate row is gone', () => {
  for (const plan of ['../packaging/release-plan.json', '../scripts/development-files.json']) {
    assert.match(read(plan), /"source": "mod\/johnny-remarks\.lua",\s+"target": "bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/AiNpcCyberpunkMod\/johnny-remarks\.lua"/, plan);
  }
  const managerUiSource = read('../mod/manager-ui.lua');
  assert.doesNotMatch(managerUiSource, /setting\('johnnyRemarks'/);
  assert.match(managerUiSource, /setting\('johnnyInHead', 'Johnny in your head', 'select',[^]*?\{'Off', 'On', 'Speaks up rarely', 'Speaks up normally', 'Speaks up often'\}\)/);
  const en = JSON.parse(read('../localization/en.json')).strings;
  const keys = Object.keys(en).filter(key => /^Speaks up rarely$|^Speaks up normally$|^Speaks up often$|^Choose how often Johnny speaks up\.$|^Johnny in your head$/.test(key));
  assert.equal(keys.length, 5);
  for (const locale of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const source = read(`../mod/locales/${locale}.lua`);
    for (const key of keys) assert.ok(source.includes(`["${key.replace(/\n/g, '\\n')}"]`), `${locale}: ${key.slice(0, 40)}`);
  }
});
