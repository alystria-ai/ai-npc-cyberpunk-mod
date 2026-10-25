import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseTurnContext, describeTurnContext, turnContext, turnContextDiagnostic, timeOfDay, sceneryFor, MAX_CHARS, STRANGER_NOTE}
  from './turn-context.mjs';
import {SceneryMemory, sceneryMemory} from './scenery-memory.mjs';
import {parseInput, isAmbientProfile, archetypeContext} from './protocol.mjs';
import * as quest from './quest-context.mjs';
import {conversationContext, voiceConversationBlocks, turnContextOptions} from './quest-context.mjs';
import {visibleGearContext} from './player-gear.mjs';
import {buildMessages, capContext} from './mistral-prompt.mjs';
import {turnKey} from './group-lookahead.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/turn-context.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const microphoneSource = readFileSync(new URL('../mod/microphone.lua', import.meta.url), 'utf8');
const phoneSource = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');

// ---------------------------------------------------------------- bridge side
const scene = (extra = {}) => ({version: 1, status: 'ready', hour: 2, minute: 10, district: 'Watson', area: 'Kabuki',
  gender: 'female', lifepath: 'streetkid', vehicle: true,
  party: [{key: 'judy-alvarez', name: 'Judy'}, {key: 'panam-palmer', name: 'Panam'}], ...extra});
const turn = (extra = {}) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez',
  name: 'Judy', bodyType: 'WomanAverage', text: 'So what now?', ...extra});
const journal = {version: 1, status: 'active', quest: {id: '123', title: 'The Heist', objectives: [{id: '1', text: 'Reach the vault door', tracked: true}]}};
const gear = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'legs', name: 'Cargo Pants'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}],
  cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}, {slot: 'eyes', name: 'Kiroshi Optics'}]};

test('the block words the clock, the place, the company, the vehicle and V for a character with V', () => {
  const text = turnContext(parseInput(JSON.stringify(turn({profileKey: 'judy-alvarez', turnContext: scene()}))));
  assert.equal(text, 'Right now (from the game, this turn only): You are with V in person. You are somewhere in Kabuki, Watson; exactly where is not given. It is late night, about 2 AM. '
    + 'Also with V: Panam. V is in a vehicle. V is a woman (she/her), lifepath Street Kid. '
    + 'Treat this as fact: never claim to be anywhere else, or to have just been doing something, unless this says so (what you would like to do or will do is fine).'
    + ' Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them.'
    + ' Do not recite it, and mention a place or the time only if it matters to what V says.');
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length} characters`);
  assert.equal(MAX_CHARS, 900);
});

test('the part of the day and the nearest hour', () => {
  const at = (hour, minute = 0) => timeOfDay(hour, minute);
  assert.equal(at(0), 'late night, about midnight');
  assert.equal(at(2, 10), 'late night, about 2 AM');
  assert.equal(at(2, 40), 'late night, about 3 AM');
  assert.equal(at(5, 15), 'early morning, about 5 AM');
  assert.equal(at(8, 22), 'morning, about 8 AM');
  assert.equal(at(12, 5), 'midday, about noon');
  assert.equal(at(15, 45), 'afternoon, about 4 PM');
  assert.equal(at(18, 0), 'evening, about 6 PM');
  assert.equal(at(21, 30), 'night, about 10 PM');
  assert.equal(at(23, 40), 'night, about midnight');
});

test('every field is optional: a missing or unreadable one is simply absent', () => {
  const only = fields => turnContext(turn({turnContext: {version: 1, status: 'ready', ...fields}}));
  assert.match(only({district: 'SantoDomingo'}), /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Santo Domingo; exactly where is not given\. Treat this as fact/);
  assert.match(only({hour: 14, minute: 0}), /It is afternoon, about 2 PM\. Treat this as fact/);
  assert.match(only({vehicle: false}), /^Right now \(from the game, this turn only\): You are with V in person\. Treat this/, 'not in a vehicle adds nothing but the in-person line');
  assert.match(only({gender: 'male'}), /V is a man \(he\/him\)\./);
  assert.match(only({lifepath: 'nomad'}), /V is lifepath Nomad\./);
  // A district with a distinct area names both, a district alone just itself.
  assert.match(only({district: 'Watson', area: 'Watson'}), /You are somewhere in Watson; exactly where is not given\./);
  // Bad fields are dropped one by one, not the whole snapshot.
  const parsed = parseTurnContext({version: 1, status: 'ready', hour: 25, minute: 0, district: 'Watson', gender: 'robot', lifepath: 'x',
    vehicle: 'yes', party: [{key: 'Bad Key', name: 'X'}, {key: 'judy-alvarez', name: ''}, {key: 'panam-palmer', name: '<b>Panam</b>\n'}, null]});
  assert.deepEqual(parsed, {version: 1, status: 'ready', district: 'Watson', party: [{key: 'panam-palmer', name: 'Panam'}]});
});

test('no snapshot, unavailable, malformed and automatic reactions add nothing', () => {
  assert.equal(turnContext({}), '');
  assert.equal(turnContext(null), '');
  assert.equal(turnContext(turn({turnContext: {version: 1, status: 'unavailable'}})), '');
  assert.equal(turnContext({...turn(), turnContext: scene(), reaction: {kind: 'battle'}}), '', 'a bark has its own single subject');
  for (const bad of [null, 'x', [], {}, {version: 2, status: 'ready', hour: 1, minute: 1}, {version: 1, status: 'ready'},
    {version: 1, status: 'ready', party: 'Judy'}, {version: 1, status: 'ready', hour: 1}]) {
    assert.equal(parseTurnContext(bad).status, 'unavailable', JSON.stringify(bad));
    assert.equal(turnContext(turn({turnContext: bad})), '');
  }
  assert.equal(parseTurnContext(undefined), undefined);
  // CET writes an empty Lua list as an empty object.
  assert.deepEqual(parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 5, party: {}}), {version: 1, status: 'ready', hour: 3, minute: 5});
});

test('the addressed character is not listed among the people with V, and the block never exceeds its cap', () => {
  const text = turnContext(turn({profileKey: 'panam-palmer', turnContext: scene()}));
  assert.match(text, /Also with V: Judy\./);
  assert.doesNotMatch(text, /Panam/);
  const alone = turnContext(turn({profileKey: 'judy-alvarez', turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy'}]})}));
  assert.doesNotMatch(alone, /Also with V/);
  const many = Array.from({length: 6}, (_, index) => ({key: `person-${index}`, name: `Person ${index} `.padEnd(60, 'x')}));
  const long = turnContext(turn({turnContext: scene({party: many})}));
  assert.ok(long.length <= MAX_CHARS, `${long.length} characters`);
  assert.match(long, /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Kabuki, Watson; exactly where is not given\. It is late night, about 2 AM\./, 'where she is and the clock are the last to go');
  assert.ok(long.endsWith('if it matters to what V says.'), 'the framing is never cut');
  for (const [, run] of long.matchAll(/(x{20,})/g)) assert.equal(run.length >= 20, true);
});

test('a phone message says it is a text chat, the time, where V is and what V does, and that she is elsewhere with her own place not given', () => {
  const text = turnContext(turn({channel: 'phone', turnContext: scene({party: [], vehicle: false, motion: 'walking'})}));
  assert.equal(text, 'Right now (from the game, this turn only): You are messaging V by text on the phone, not talking to V in person. '
    + 'You are somewhere else; where you are and what you are doing are not given. V is somewhere in Kabuki, Watson; exactly where is not given. It is late night, about 2 AM. V is walking. V is a woman (she/her), lifepath Street Kid. '
    + "Treat this as fact: you are not with V and cannot see V's surroundings, and you do not know how near or far you are, so never say you are there, close or nearby. "
    + 'Never name a place you are at or a task you are doing right now or have just done; if asked, stay vague in your own way (your usual life is fine; plans and wishes are fine). Do not recite it, and mention a place or the time only if it matters to what V says.');
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length} characters`);
  assert.doesNotMatch(text, /phone call|with V in person in|never claim to be anywhere else/);
  // V driving, and no district: each part stands alone.
  assert.match(turnContext(turn({channel: 'phone', turnContext: scene({district: undefined, area: undefined, driving: true})})), /not talking to V in person\. You are somewhere else;[^]*V is driving\./);
  // She is not told who stands next to V: a person on the other end of a text cannot know.
  assert.doesNotMatch(turnContext(turn({channel: 'phone', turnContext: scene({vehicle: false})})), /Also with V|Panam/);
});

test('the block is the very first thing in the conversation context, before the world knowledge and the journal', () => {
  const input = parseInput(JSON.stringify(turn({turnContext: scene(), journal, gear})));
  sceneryMemory.clear();
  const text = conversationContext(input);
  // The clock is scenery: not in the block but in a Background line of its own, after the situation facts (bridge/scenery-memory.mjs).
  assert.ok(text.startsWith('Right now (from the game, this turn only): You are with V in person. You are somewhere in Kabuki, Watson; exactly where is not given. Also with V: Panam.'), text.slice(0, 160));
  assert.match(text, /\n\nBackground \(mention only if it matters or V asks\): It is late night, about 2 AM\.\n\n/);
  assert.ok(text.indexOf('Right now') < text.indexOf('journal'));
  assert.ok(text.indexOf('Right now') < text.indexOf("V's current gear"));
  assert.ok(!text.includes('Right now', 5), 'once');
  assert.ok(!conversationContext(parseInput(JSON.stringify(turn()))).includes('Right now'), 'older adapters send none');
});

test('Mistral keeps the block however long the rest of the context is', () => {
  const block = turnContext(turn({turnContext: scene()}));
  const huge = `${block}\n\n${'World fact. '.repeat(4000)}\n\nReminder for this reply: say I.`;
  assert.ok(huge.length > 40000);
  const capped = capContext(huge);
  assert.ok(capped.startsWith(block), 'the head is kept whole');
  assert.ok(capped.length <= 20000);
  const persona = {name: 'Judy', backstory: 'A braindance editor.', style: '', samples: [], ambient: false, known: true};
  const messages = buildMessages({persona, context: huge, text: 'Hi'});
  assert.ok(messages.at(-1).content.includes(block));
});

test('parseInput carries the snapshot, and a malformed one keeps the message', () => {
  const parsed = parseInput(JSON.stringify(turn({turnContext: scene()})));
  assert.equal(parsed.turnContext.status, 'ready');
  assert.equal(parsed.turnContext.district, 'Watson');
  assert.equal(parseInput(JSON.stringify(turn())).turnContext, undefined, 'older adapters send none');
  const broken = parseInput(JSON.stringify(turn({turnContext: 'nonsense'})));
  assert.equal(broken.text, 'So what now?');
  assert.equal(broken.turnContext.status, 'unavailable');
  assert.equal(turnContext(broken), '');
});

test('a recaptured snapshot never changes which group turn is which', () => {
  const a = parseInput(JSON.stringify(turn({turnContext: scene()}))), b = parseInput(JSON.stringify(turn({turnContext: scene({hour: 3})})));
  assert.equal(turnKey(a), turnKey(b));
});

test('the per-turn diagnostic says whether the block was in the context, or why not', () => {
  const input = turn({turnContext: scene()});
  assert.equal(turnContextDiagnostic(input), `Turn context: 6 facts, ${turnContext(input).length} chars`);
  assert.equal(turnContextDiagnostic({}), 'Turn context: none (the game sent none)');
  assert.equal(turnContextDiagnostic(turn({turnContext: {version: 1, status: 'unavailable'}})), 'Turn context: none (unavailable or malformed)');
  assert.equal(turnContextDiagnostic({...input, reaction: {kind: 'loot'}}), 'Turn context: none (automatic reaction)');
  assert.equal(turnContextDiagnostic(undefined), 'Turn context: none (no input)');
  assert.doesNotMatch(turnContextDiagnostic(input), /Judy|Watson/, 'counts only');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{turnContextDiagnostic\} from '\.\/turn-context\.mjs'/);
  assert.match(bridge, /console\.error\(`\[TurnContext\] profile=\$\{input\.profileKey\} \$\{turnContextDiagnostic\(input, voice \? \{ambient: isAmbientProfile\(input\.profileKey\), voice, off: dynamicInfo\.off\} : turnContextOptions\(input, isAmbientProfile\(input\.profileKey\)\)\)\}`\)/);
});

// ---------------------------------------------------------------- ordinary NPCs are strangers
const resident = (extra = {}) => turn({profileKey: 'resident-male', name: 'Pedestrian', entity: '55ULL', requestId: '100-1-55ULL',
  archetype: {title: 'Kabuki resident', district: 'Kabuki'}, journal, gear,
  worldKnowledge: {version: 1, status: 'unavailable'}, journalHistory: {version: 1, status: 'unavailable'}, ...extra});

test('an ordinary NPC gets no journal, no jobs, no history and no gear list; only what a stranger could see', () => {
  for (const profileKey of ['resident-male', 'resident-female', 'npc-ripperdoc', 'npc-food-vendor']) {
    assert.ok(isAmbientProfile(profileKey));
    sceneryMemory.clear();
    const text = conversationContext(parseInput(JSON.stringify(resident({profileKey, turnContext: scene()}))));
    assert.doesNotMatch(text, /journal|objective|The Heist|vault door|shared with you|world knowledge|journal history|Current verified save facts/i, profileKey);
    assert.doesNotMatch(text, /V's current gear|weapons equipped|Mantis|Kiroshi|Malorian|operating system/, profileKey);
    // V's visible situation and the framing as a stranger; the time is the Background line after the block.
    assert.ok(text.startsWith('Right now (from the game, this turn only): V has 2 other people with them.'), profileKey);
    assert.match(text, /\n\nBackground \(mention only if it matters or V asks\): It is late night, about 2 AM\.\n\n/, profileKey);
    assert.match(text, /V is in a vehicle\./);
    assert.match(text, /V has 2 other people with them\./);
    assert.match(text, /V looks like a woman \(she\/her\)\./);
    assert.match(text, /You have never met V and do not know who V is/); assert.match(text, /Never call them V or by any name/);
    assert.doesNotMatch(text, /Street Kid|lifepath|Judy|Panam/, 'a stranger knows neither the lifepath nor the party');
    // What a bystander can see of V: the clothing and the weapon in hand.
    assert.match(text, /What you can see of V right now - wearing: outer torso: Samurai Jacket, legs: Cargo Pants; weapon in hand: Kyubi\./);
    assert.match(text, /Speak only your own dialogue/, 'the spoken-output rule stays');
    assert.ok(text.length < 1800, `${text.length} characters`);
  }
});

test('an ordinary NPC is told where it is once: by its own district block, else by the right-now block', () => {
  const withDistrict = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene()}))));
  assert.doesNotMatch(withDistrict, /You are somewhere in Kabuki/, 'the archetype block already says it');
  const bare = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene(), archetype: undefined}))));
  assert.match(bare, /You are somewhere in Kabuki, Watson; exactly where is not given\./);
});

test('named characters keep their journal, world facts and gear list', () => {
  const text = conversationContext(parseInput(JSON.stringify(turn({turnContext: scene(), journal, gear}))));
  assert.match(text, /verified current-save journal is shared with you/);
  assert.match(text, /Reach the vault door/);
  assert.match(text, /V's current gear/);
  assert.match(text, /Thermal Mantis Blades/);
  assert.match(text, /lifepath Street Kid/);
});

test('an ordinary NPC still gets scoped battle and loot reactions and the follow-up rules', () => {
  const battle = {version: 1, status: 'ended', secondsSince: 20, duration: 10, observed: []};
  const text = conversationContext(parseInput(JSON.stringify(resident({battle, turnContext: scene()}))));
  assert.match(text, /^Right now/);
  // A bark gets neither the block nor the gear.
  const bark = conversationContext({...parseInput(JSON.stringify(resident({turnContext: scene()}))), reaction: {kind: 'battle'}});
  assert.doesNotMatch(bark, /Right now|What you can see of V/);
});

test('the visible-gear line is bounded, skips holstered weapons and cyberware, and is empty without clothing or a weapon in hand', () => {
  const text = visibleGearContext({gear});
  assert.doesNotMatch(text, /Malorian|Mantis|Kiroshi|slot/);
  assert.ok(text.length <= 420);
  assert.equal(visibleGearContext({gear: {version: 1, status: 'ready', cyberware: [{slot: 'arms', name: 'Mantis Blades'}]}}), '');
  assert.equal(visibleGearContext({gear: {version: 1, status: 'ready', weapons: [{slot: 'slot1', name: 'Erebus'}]}}), '');
  assert.equal(visibleGearContext({gear, reaction: {kind: 'loot'}}), '');
  assert.equal(visibleGearContext({}), '');
  assert.equal(visibleGearContext(null), '');
  const long = name => name.padEnd(80, 'x');
  const big = visibleGearContext({gear: {version: 1, status: 'ready',
    clothing: ['head', 'face', 'outerTorso', 'innerTorso', 'legs', 'feet', 'outfit'].map(slot => ({slot, name: long(slot + ' ')})),
    weapons: [{slot: 'hand', name: long('hand ')}]}});
  assert.ok(big.length <= 420, `${big.length}`);
});

// ---------------------------------------------------------------- Lua adapter
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + code.split('\n')[line - 1] : ''));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    return lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : null;
  } finally { lua.lua_close(vm); }
}
const adapter = `
local api = (function() ${source} end)()
local now, reads, lifepathReads, partyArgs = 100, 0, 0, nil
local player = {id = 'v'}
local state = {ready = true, hour = 2, minute = 10, gender = 'Female', lifepath = 'streetkid', vehicle = false, failures = {},
  place = {district = 'Watson', area = 'Kabuki'},
  party = {{profileKey = 'judy-alvarez', name = 'Judy'}, {profileKey = 'panam-palmer', name = 'Panam'}}}
local function guard(name) if state.failures[name] then error('no ' .. name) end end
local N = {
  player = function() return player end,
  ready = function() return state.ready end,
  clock = function() reads = reads + 1; guard('clock'); return state.hour, state.minute, 'native' end,
  gender = function() guard('gender'); return state.gender end,
  lifepath = function() lifepathReads = lifepathReads + 1; guard('lifepath'); return state.lifepath end,
  vehicle = function() guard('vehicle'); return state.vehicle end}
local ctx = api.new({native = N, now = function() return now end,
  place = function() guard('place'); return state.place end,
  party = function(p, radius) guard('party'); partyArgs = {p, radius}; return state.party end})
local function names(snap) local out = {}; for _, row in ipairs(snap.party or {}) do out[#out + 1] = row.key .. '=' .. row.name end; return table.concat(out, ',') end
`;
const lua$ = body => runLua(adapter + '\n' + body);

test('the adapter reads the clock, the district, V, the vehicle and the people beside V', () => lua$(`
  local snap = ctx:capture()
  assert(snap and snap.version == 1 and snap.status == 'ready')
  assert(snap.hour == 2 and snap.minute == 10)
  assert(snap.district == 'Watson' and snap.area == 'Kabuki')
  assert(snap.gender == 'female' and snap.lifepath == 'streetkid' and snap.vehicle == false)
  assert(names(snap) == 'judy-alvarez=Judy,panam-palmer=Panam', names(snap))
  assert(partyArgs[1] == player and partyArgs[2] == api.PARTY_RADIUS and api.PARTY_RADIUS == 15)
  state.gender = 'Male'; state.vehicle = true; ctx:reset('test')
  snap = ctx:capture()
  assert(snap.gender == 'male' and snap.vehicle == true)
`));

test('a snapshot cached while the volume was not wanted is read again once V’s voice becomes active, so the first line after switching voices has the level', () => lua$(`
  local wanted, reads = false, 0
  local ctx3 = api.new({native = setmetatable({volume = function() reads = reads + 1; return 0.6 end}, {__index = N}), now = function() return now end,
    place = function() return state.place end, party = function() return {} end, wantVolume = function() return wanted end})
  ctx3:reset('test')
  assert(ctx3:capture().dialogueVolume == nil and reads == 0)
  assert(ctx3:capture().dialogueVolume == nil and reads == 0, 'still cached while not wanted')
  wanted = true
  assert(ctx3:capture().dialogueVolume == 0.6 and reads == 1, 'wanted now: read again at once')
  assert(ctx3:capture().dialogueVolume == 0.6 and reads == 1, 'then cached again')
  wanted = false
  assert(ctx3:capture().dialogueVolume == 0.6 and reads == 1, 'no extra read when it stops being wanted')
`));

test('the adapter reads the game’s dialogue volume only while V’s voice for typed lines asks for it, and never counts it as something read', () => lua$(`
  local wanted, level = false, 0.8123
  local ctx2 = api.new({native = setmetatable({volume = function() return level end}, {__index = N}), now = function() return now end,
    place = function() return state.place end, party = function() return {} end, wantVolume = function() return wanted end})
  assert(ctx2:capture().dialogueVolume == nil, 'not asked for: not read')
  ctx2:reset('test'); wanted = true
  assert(ctx2:capture().dialogueVolume == 0.81)
  for _, bad in ipairs({-0.2, 1.4, 'loud'}) do level = bad; ctx2:reset('test'); assert(ctx2:capture().dialogueVolume == nil, tostring(bad)) end
  -- A failing read drops only the volume, is tried a few times and then left alone until a reset.
  local reads = 0
  ctx2.native.volume = function() reads = reads + 1; error('no settings system') end
  ctx2:reset('x')
  for _ = 1, 5 do now = now + 10; local snap = ctx2:capture(); assert(snap and snap.dialogueVolume == nil and snap.hour == 2) end
  assert(reads == 3, reads)
  -- With nothing else readable the volume alone is no snapshot.
  state.failures = {clock = true, place = true, gender = true, lifepath = true, party = true, vehicle = true}
  level = 0.5; ctx2.native.volume = function() return level end; ctx2.failures = {}; ctx2:reset('test')
  local lone = api.new({native = setmetatable({volume = function() return 0.5 end}, {__index = N}), now = function() return now end,
    place = function() guard('place'); return state.place end, party = function() guard('party') end, wantVolume = function() return true end})
  assert(lone:capture() == nil)
`));

test('a failing native call drops that field only; nothing readable drops the snapshot and is not cached', () => lua$(`
  state.failures = {clock = true, place = true, gender = true, lifepath = true, party = true}
  local snap = ctx:capture()
  assert(snap and snap.hour == nil and snap.district == nil and snap.gender == nil and snap.lifepath == nil and snap.party == nil)
  assert(snap.vehicle == false, 'the one readable field is kept')
  state.failures = {clock = true, place = true, gender = true, lifepath = true, party = true, vehicle = true}
  ctx:reset('test')
  assert(ctx:capture() == nil)
  state.failures = {}
  assert(ctx:capture() ~= nil, 'the next turn tries again')
  -- Impossible values are dropped, not trusted.
  state.hour, state.minute = 24, 0; state.gender = 'unknown'; state.place = {district = 'bad<>name'}; ctx:reset('test')
  snap = ctx:capture()
  assert(snap.hour == nil and snap.gender == nil and snap.district == nil)
  state.hour, state.minute = 2.5, 0; ctx:reset('test'); assert(ctx:capture().hour == nil)
`));

test('the people beside V are bounded, deduplicated and cleaned', () => lua$(`
  state.party = {}
  for i = 1, 8 do state.party[#state.party + 1] = {profileKey = 'person-' .. i, name = 'Person ' .. i} end
  state.party[#state.party + 1] = {profileKey = 'person-1', name = 'Again'}
  table.insert(state.party, 1, {profileKey = 'Bad Key', name = 'Nope'})
  table.insert(state.party, 1, {profileKey = 'blank', name = '   '})
  table.insert(state.party, 1, {profileKey = 'tagged', name = '<b>Tag</b>\\n  Name'})
  local snap = ctx:capture()
  assert(#snap.party == api.MAX_PARTY and api.MAX_PARTY == 4, #snap.party)
  assert(snap.party[1].name == 'Tag Name' and snap.party[2].key == 'person-1', names(snap))
  state.party = {{profileKey = 'long', name = string.rep('a', 57) .. 'ééé'}}; ctx:reset('test')
  local name = ctx:capture().party[1].name
  assert(#name <= api.MAX_NAME and name:sub(-3) == '...' and not name:find('\\195%.%.%.$'), name)
  state.party = {}; ctx:reset('test'); assert(ctx:capture().party == nil, 'nobody beside V sends nothing')
`));

test('the snapshot is read once per window, never per call, and refreshed after it', () => lua$(`
  for i = 1, 25 do assert(ctx:capture()) end
  assert(reads == 1, 'a burst of turns reads the game once')
  now = now + api.MAX_AGE - 1; ctx:capture(); assert(reads == 1)
  now = now + 1; ctx:capture(); assert(reads == 2, 'refreshed after the window')
  now = now - 50; ctx:capture(); assert(reads == 3, 'a clock that went backwards is not trusted')
  state.hour = 3; now = now + api.MAX_AGE
  assert(ctx:capture().hour == 3, 'a new hour shows after the window')
  ctx:reset('load'); ctx:capture(); assert(reads == 5, 'a reset (load, death) drops the cache')
`));

test('the lifepath is read once per save and again only while unknown', () => lua$(`
  ctx:capture(); now = now + 10; ctx:capture(); now = now + 10; ctx:capture()
  assert(lifepathReads == 1, lifepathReads)
  state.lifepath = nil; ctx:reset('new save'); lifepathReads = 0
  assert(ctx:capture().lifepath == nil)
  now = now + 10; ctx:capture(); assert(lifepathReads == 2, 'unknown is retried on the next turn')
  state.lifepath = 'corpo'; now = now + 10
  assert(ctx:capture().lifepath == 'corpo' and lifepathReads == 3)
  now = now + 10; ctx:capture(); assert(lifepathReads == 3)
`));

test('each real read logs one line; a cached turn logs nothing; a log failure is contained', () => lua$(`
  local lines = {}
  ctx.options.log = function(line) lines[#lines + 1] = line end
  ctx:capture(); ctx:capture(); ctx:capture()
  assert(#lines == 1 and lines[1] == 'Turn context: 02:10(native) Watson/Kabuki female streetkid vehicle=false party=2', lines[1])
  state.ready = false; ctx:reset('test'); ctx:capture()
  assert(lines[2]:find('^Turn context: none %(V is not ready'), lines[2])
  state.ready = true; state.failures = {clock = true, place = true, gender = true, lifepath = true, party = true, vehicle = true}
  ctx:reset('test'); ctx:capture()
  assert(lines[3] == 'Turn context: none (nothing could be read)', lines[3])
  state.failures = {clock = true}; ctx:reset('test'); ctx:capture()
  assert(lines[4]:find('no%-clock Watson/Kabuki female streetkid vehicle=false party=2'), lines[4])
  ctx.options.log = function() error('a log failure is contained') end
  state.failures = {}; ctx:reset('test')
  assert(ctx:capture() ~= nil)
`));

test('not ready (loading, dead, flashback) reads nothing', () => lua$(`
  state.ready = false
  assert(ctx:capture() == nil and reads == 0)
  state.ready = true
  assert(ctx:capture() ~= nil)
`));

// The default adapter, against a fake game.
const fakeGame = `
local seconds = 9361340 + 0  -- day 108, 08:22:20
local failing = {}
Game = {
  GetPlayer = function() return {IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
    IsReplacer = function() return false end,
    GetResolvedGenderName = function() return {cname = 'Female'} end,
    GetMountedVehicle = function() return failing.mounted and {} or nil end} end,
  NameToString = function(value) return type(value) == 'table' and value.cname or tostring(value) end,
  GetTimeSystem = function() return {GetGameTime = function() return {seconds = seconds} end} end,
  GetScriptableSystemsContainer = function() return {Get = function() return {GetLifePath = function() return 'StreetKid' end} end} end}
GameTime = {Hours = function(stamp) if failing.native then error('no native') end return math.floor(stamp.seconds % 86400 / 3600) end,
  Minutes = function(stamp) return math.floor(stamp.seconds % 3600 / 60) end,
  GetSeconds = function(stamp) return stamp.seconds end}
Enum = {new = function(kind, name) return name end}
local api = (function() ${source} end)()
`;

test('the default adapter reads the clock natively, falls back to the seconds count, and reads V from the game', () => runLua(`${fakeGame}
  local ctx = api.new({place = function() return {district = 'Watson'} end})
  local snap = ctx:capture()
  assert(snap.hour == 8 and snap.minute == 22, snap.hour .. ':' .. snap.minute)
  assert(snap.gender == 'female' and snap.lifepath == 'streetkid' and snap.vehicle == false and snap.district == 'Watson')
  failing.native = true; failing.mounted = true; ctx:reset('test')
  snap = ctx:capture()
  assert(snap.hour == 8 and snap.minute == 22, 'the seconds count gives the same clock')
  assert(snap.vehicle == true)
  seconds = 86400 * 3 + 23 * 3600 + 59 * 60 + 59; ctx:reset('test')
  snap = ctx:capture()
  assert(snap.hour == 23 and snap.minute == 59)
  local lines = {}
  ctx.options.log = function(line) lines[#lines + 1] = line end
  ctx:reset('test'); ctx:capture()
  assert(lines[1]:find('^Turn context: 23:59%(seconds%) Watson'), lines[1])
`));

test('the game time for "time since last talk" is read the proven way: two readings that must agree, the timestamp as the last resort, only while the kind is on', () => runLua(`${fakeGame}
  local function place() return {district = 'Watson'} end
  local ctx = api.new({place = place})
  local snap = ctx:capture()
  assert(snap.gameTime == 9361340, tostring(snap.gameTime))
  assert(math.type == nil or math.type(snap.gameTime) == 'integer', 'whole seconds')
  -- The switch off: not read and not sent.
  local reads = 0
  local counting = Game.GetTimeSystem
  Game.GetTimeSystem = function() reads = reads + 1; return counting() end
  local off = api.new({enabled = function(kind) return kind ~= 'lastTalk' end, place = place})
  local quiet = off:capture()
  assert(quiet.gameTime == nil and quiet.hour == 8, 'the clock itself is another kind')
  local withOff = reads
  Game.GetTimeSystem = counting
  -- The two readings disagree: no time rather than a wrong one (the same refusal as mod/world-knowledge.lua).
  local total = GameTime.GetSeconds
  GameTime.GetSeconds = function() return 5 end
  ctx:reset('test'); snap = ctx:capture()
  assert(snap.gameTime == nil and snap.hour == 8, tostring(snap.gameTime))
  -- The struct field fails and the accessor works, and the other way round.
  local broken = setmetatable({}, {__index = function() error('no field') end})
  Game.GetTimeSystem = function() return {GetGameTime = function() return broken end} end
  GameTime.GetSeconds = function() return 777 end
  ctx:reset('test'); snap = ctx:capture()
  assert(snap.gameTime == 777, tostring(snap.gameTime))
  Game.GetTimeSystem = counting
  GameTime.GetSeconds = function() error('no accessor') end
  ctx:reset('test'); snap = ctx:capture()
  assert(snap.gameTime == 9361340, 'the field alone is accepted')
  -- Neither works: the time system's own timestamp.
  Game.GetTimeSystem = function() return {GetGameTime = function() return broken end, GetGameTimeStamp = function() return 4242.7 end} end
  ctx:reset('test'); snap = ctx:capture()
  assert(snap.gameTime == 4242 and snap.hour == nil, 'the timestamp is a float: whole seconds ' .. tostring(snap.gameTime))
  -- Nothing readable, or nothing sensible: no field, and the turn is still built from the rest.
  for _, bad in ipairs({-5, 12.5, 0/0, 1e12, 'x'}) do
    Game.GetTimeSystem = function() return {GetGameTime = function() return {seconds = bad} end, GetGameTimeStamp = function() return bad ~= 12.5 and bad or nil end} end
    GameTime.GetSeconds = function() return bad end
    ctx:reset('test'); snap = ctx:capture()
    assert(snap.gameTime == nil and snap.gender == 'female', tostring(bad))
  end
  Game.GetTimeSystem = function() return nil end
  ctx:reset('test'); snap = ctx:capture()
  assert(snap.gameTime == nil)
`));

test('the module is on demand only: no frame hook, no observer, no file, no timer, and nothing is sent unless asked', () => {
  assert.doesNotMatch(source, /registerForEvent|onUpdate|Observe\(|ObserveAfter|Override\(|io\.open|os\.execute|json\./);
  assert.match(source, /^local M = \{\}/m);
  assert.match(source, /pcall\(self\.read, self\)/);
  // Weather, health, heat and money are read only inside the adapter's four functions, each through the guarded `optional`.
  const code = source.split(/\r?\n/).map(row => row.replace(/--.*$/, '')).join('\n');
  assert.equal((code.match(/Game\.GetWeatherSystem|Game\.GetStatPoolsSystem|'PreventionSystem'\)|Game\.GetTransactionSystem/g) ?? []).length, 4);
  for (const kind of ['weather', 'health', 'heat', 'money']) assert.match(code, new RegExp(`self:optional\\('${kind}'`));
});

test('every manual send path captures the block (in person, microphone and phone); reactions never do', () => {
  const send = initSource.slice(initSource.indexOf('local function sendRequest(context)'), initSource.indexOf('-- A managed copy can be reassigned'));
  assert.match(send, /if \(not context\.reaction or speakUp or houseWelcome\) and convaiTurnContext then context\.turnContext = context\.turnContext or convaiTurnContext:capture\(\) end/);
  // The wrapper takes the speaker's profile key so a pending appointment note (immersive invitations) can ride on a copy of the snapshot.
  assert.match(initSource, /microphone\.captureTurnContext = function\(profileKey\)\s+local snapshot = convaiTurnContext and convaiTurnContext:capture\(\) or nil/);
  assert.match(initSource, /pcall\(dofile, 'turn-context\.lua'\)/);
  assert.match(initSource, /place = function\(\) return currentDistrict\(\) end/);
  assert.match(initSource, /companions\.conversationCandidates\(player, radius\)/);
  assert.match(initSource, /if convaiTurnContext then convaiTurnContext:reset\(reason\) end/);
  assert.match(initSource, /if convaiTurnContext then convaiTurnContext\.options\.log = log end/);
  assert.equal(microphoneSource.match(/context\.turnContext = M\.captureTurnContext and M\.captureTurnContext\(context\.profileKey\)/g).length, 2);
  // The phone reads it once, when a message is sent, through the same wrapper the microphone uses.
  assert.match(phoneSource, /local turnContext = capture\(M\.captureTurnContext, key\)/);
  assert.equal(phoneSource.match(/captureTurnContext/g).length, 2, 'two reads: the send path and the start of a text she sends herself (immersive invitations)');
  assert.match(initSource, /phoneChat\.captureTurnContext = microphone\.captureTurnContext/);
  // The only readers are those turn paths.
  assert.equal((initSource.match(/convaiTurnContext:capture\(\)/g) || []).length, 3, 'the send path, the microphone wrapper and the speak-up request (captured when it is built, so a line prepared ahead is the one sent)');
});

test('the new files ship: the development install list, the release plan and the bridge layout', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /"source": "mod\/turn-context\.lua"/, file);
    assert.match(text, /AiNpcCyberpunkMod\/turn-context\.lua"/, file);
  }
  assert.match(readFileSync(new URL('../packaging/release-plan.json', import.meta.url), 'utf8'), /"bridge\/turn-context\.mjs"/);
  assert.match(readFileSync(new URL('../packaging/runtime-layout.mjs', import.meta.url), 'utf8'), /'bridge\/turn-context\.mjs'/);
});

// ---------------------------------------------------------------- what she is doing (the invented-activity fix)
const doing = (activity, extra = {}, input = {}) => turnContext(turn({turnContext: scene({vehicle: false, gender: undefined, lifepath: undefined,
  party: [{key: 'judy-alvarez', name: 'Judy', activity}], ...extra}), ...input}));

test('a companion is told, first and plainly, that she is with V in person and what she is doing', () => {
  assert.match(doing('following', {motion: 'walking'}), /^Right now \(from the game, this turn only\): You are with V in person, on foot, following V\. You are somewhere in Kabuki, Watson; exactly where is not given\. It is late night, about 2 AM\. V is walking\. Treat this as fact: never claim to be anywhere else, or to have just been doing something, unless this says so \(what you would like to do or will do is fine\)\. Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them\. Do not recite it, and mention a place or the time only if it matters to what V says\.$/);
  const says = {standing: /standing near V\. You are somewhere in Kabuki/, combat: /in a fight alongside V\. You are somewhere in Kabuki/, 'to-seat': /walking over to sit down beside V/,
    seated: /sitting beside V\. You are somewhere in Kabuki/, 'getting-up': /getting up from your seat/, passenger: /riding along in V's vehicle\. You are somewhere in Kabuki/,
    driving: /driving V's vehicle\. You are somewhere in Kabuki/, boarding: /getting into V's vehicle/, 'leaving-car': /getting out of V's vehicle/,
    attacking: /going after a target V picked/};
  for (const [activity, pattern] of Object.entries(says)) {
    assert.match(doing(activity), pattern, activity);
    assert.doesNotMatch(doing(activity), /(?:near V|beside V|alongside V|vehicle|V) (?:in|through) Kabuki/, `${activity}: the activity carries no place`);
  }
  // No activity known: still in person, nothing else claimed.
  assert.match(doing(undefined), /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Kabuki, Watson; exactly where is not given\. It is/);
  // Another character's row is not hers.
  assert.match(doing('seated', {}, {profileKey: 'panam-palmer'}), /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Kabuki, Watson; exactly where is not given\. /);
  // Unknown words from the game are dropped, never worded.
  assert.equal(parseTurnContext(scene({party: [{key: 'judy-alvarez', name: 'Judy', activity: 'cleaning-gun'}]})).party[0].activity, undefined);
});

test('V is described as driving or moving only when the game said so; the cap still holds with everything set', () => {
  assert.match(doing('passenger', {vehicle: true, driving: true}), /V is driving\./);
  assert.match(doing('passenger', {vehicle: true, driving: false}), /V is in a vehicle\./);
  assert.match(doing('standing', {motion: 'still'}), /V is standing still\./);
  assert.match(doing('following', {motion: 'running'}), /V is running\./);
  assert.doesNotMatch(doing('following', {motion: 'flying'}), /V is flying/);
  assert.equal(parseTurnContext(scene({vehicle: true, motion: 'walking'})).motion, undefined, 'a car is not walking');
  assert.equal(parseTurnContext(scene({vehicle: false, driving: true})).driving, undefined);
  const full = turnContext(turn({turnContext: scene({vehicle: false, motion: 'walking', party: [{key: 'judy-alvarez', name: 'Judy', activity: 'to-seat'},
    ...Array.from({length: 4}, (_, i) => ({key: `person-${i}`, name: `Person ${i} `.padEnd(60, 'x')}))]})}));
  assert.ok(full.length <= MAX_CHARS, `${full.length}`);
  assert.match(full, /^Right now \(from the game, this turn only\): You are with V in person, walking over to sit down beside V\. You are somewhere in Kabuki, Watson; exactly where is not given\./);
  assert.ok(full.endsWith('if it matters to what V says.'));
});

test('a stranger is told nothing about what it does; a phone contact is told the call says nothing of her place', () => {
  const stranger = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene({party: [{key: 'resident-male', name: 'X', activity: 'seated'}]})}))));
  assert.doesNotMatch(stranger, /in person|sitting beside|Treat this as fact/);
  assert.match(stranger, /You have never met V and do not know who V is/);
  const phone = turnContext(turn({channel: 'phone', turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy', activity: 'following'}]})}));
  assert.doesNotMatch(phone, /on foot|following V|in person in/);
  assert.match(phone, /You are somewhere else; where you are and what you are doing are not given/);
});

test('a companion in other clothes than her appearance text describes is told so, in person only; a word the game did not mean is dropped', () => {
  const withOutfit = outfit => turnContext(turn({turnContext: scene({vehicle: false, gender: undefined, lifepath: undefined,
    party: [{key: 'judy-alvarez', name: 'Judy', activity: 'following', outfit}]})}));
  assert.match(withOutfit('home'), /You are in casual clothes for home, not the outfit your appearance notes describe\. Your hair, face, tattoos and cyberware are the same\./);
  assert.match(withOutfit('changed'), /You have changed clothes: you are not wearing the outfit your appearance notes describe\./);
  // In her own base look nothing is said.
  assert.doesNotMatch(withOutfit(undefined), /appearance notes/);
  // It follows the place sentence (the first sentence stays where she is and what she does).
  assert.match(withOutfit('home'), /^Right now \(from the game, this turn only\): You are with V in person, on foot, following V\. You are somewhere in Kabuki, Watson; exactly where is not given\. You are in casual clothes/);
  // The words are a closed set: anything else is dropped at the parse.
  assert.equal(parseTurnContext(scene({party: [{key: 'judy-alvarez', name: 'Judy', outfit: 'naked'}]})).party[0].outfit, undefined);
  assert.equal(parseTurnContext(scene({party: [{key: 'judy-alvarez', name: 'Judy', outfit: 'home'}]})).party[0].outfit, 'home');
  assert.equal(parseTurnContext(scene({party: [{key: 'judy-alvarez', name: 'Judy', outfit: {home: true}}]})).party[0].outfit, undefined);
  // On the phone, in a call and for a stranger her clothes are nobody's business.
  const phone = turnContext(turn({channel: 'phone', turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy', activity: 'following', outfit: 'home'}]})}));
  assert.doesNotMatch(phone, /appearance notes/);
  const stranger = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene({party: [{key: 'resident-male', name: 'X', outfit: 'changed'}]})}))));
  assert.doesNotMatch(stranger, /appearance notes/);
  // The Company and vehicle switch takes the party row, and her clothes with it.
  assert.doesNotMatch(turnContext(turn({turnContext: scene({vehicle: false, party: [{key: 'judy-alvarez', name: 'Judy', outfit: 'home'}]})}), {off: new Set(['company'])}), /appearance notes/);
  // The cap holds with the longest wording.
  const full = turnContext(turn({turnContext: scene({vehicle: false, motion: 'walking', party: [{key: 'judy-alvarez', name: 'Judy', activity: 'to-seat', outfit: 'home'},
    ...Array.from({length: 4}, (_, i) => ({key: `person-${i}`, name: `Person ${i} `.padEnd(60, 'x')}))]})}));
  assert.ok(full.length <= MAX_CHARS, `${full.length}`);
});

test('the Mistral and Local prompt carries the context line and one rule that outranks her own earlier lines', () => {
  const persona = {name: 'Judy', backstory: 'A braindance editor.', style: '', samples: [], ambient: false, known: true};
  const now = turnContext(turn({turnContext: scene({vehicle: false, party: [{key: 'judy-alvarez', name: 'Judy', activity: 'following'}]})}));
  const messages = buildMessages({persona, contextParts: {now, notes: '', world: '', volatile: ''}, history: [{v: 'hey there', r: 'I was just in the basement.'}], text: 'how is work?'});
  const system = messages[0].content;
  assert.ok(messages.at(-1).content.startsWith('[YOU, RIGHT NOW: You are with V in person, on foot, following V. '
    + 'That is all you are doing; never claim to be anywhere else.]\n\nV says: how is work?'), messages.at(-1).content.slice(0, 200));
  assert.doesNotMatch(messages.at(-1).content.split('\n\n')[0], /Kabuki|somewhere in/, 'the place is not repeated before the words of V');
  assert.doesNotMatch(buildMessages({persona, contextParts: {now: 'It is night.', notes: '', world: '', volatile: ''}, text: 'hi'}).at(-1).content, /YOU, RIGHT NOW/, 'no line without the sentence');
  assert.ok(system.includes('You are with V in person, on foot, following V. You are somewhere in Kabuki, Watson; exactly where is not given.'));
  assert.match(system, /The "Right now" section at the end of this message is the plain truth about where you are and what you are doing[^]*If V asks what you are up to, answer from it\. Never claim to be somewhere else[^.]*or to have just been doing something unless it says so, even if an earlier line of yours did/);
  assert.ok(system.trimEnd().endsWith('if it matters to what V says.'), 'the block is the last thing before the turns');
  assert.equal(system.split('\n').filter(line => /^\d+\. /.test(line)).length, 9, 'still nine rules');
});

test('the Mistral and Local prompt repeats the phone sentence before the words of V and keeps the phone rule beside rule 7', () => {
  const persona = {name: 'Judy', backstory: 'A braindance editor.', style: '', samples: [], ambient: false, known: true};
  const now = turnContext(turn({channel: 'phone', turnContext: scene({vehicle: false, party: []})}));
  const messages = buildMessages({persona, contextParts: {now, notes: '', world: '', volatile: ''}, history: [], text: 'what are you up to?'});
  const last = messages.at(-1).content;
  assert.ok(last.startsWith('[YOU, RIGHT NOW: You are messaging V by text on the phone, not talking to V in person. You are somewhere else; where you are and what you are doing are not given. '
    + 'You are not with V and cannot see V; never say you are there, close or nearby, and name no place or task of your own right now.]\n\nV says: what are you up to?'), last.slice(0, 400));
  assert.doesNotMatch(last, /Kabuki|somewhere in/, 'V\'s place is not repeated before the words of V');
  assert.doesNotMatch(last, /That is all you are doing/);
  assert.match(messages[0].content, /If it says you are messaging V by text, you are somewhere else, with no view of V's surroundings[^.]*: stay with your own known life/);
  assert.ok(messages[0].content.includes('You are messaging V by text on the phone'), 'the block is in the system message');
  assert.ok(messages[0].content.trimEnd().endsWith('if it matters to what V says.'));
  assert.equal(messages[0].content.split('\n').filter(line => /^\d+\. /.test(line)).length, 9, 'still nine rules');
});

const activityLua = `
local api = (function() ${source} end)()
local function is(a, b) assert(a == b, tostring(a) .. ' ~= ' .. tostring(b)) end
`;

test('Lua: the activity of a companion comes from the states the companion modules already keep', () => runLua(`${activityLua}
  local c = api.classify
  is(c({behavior = 'alongside'}), 'following'); is(c({behavior = 'catch_up'}), 'following'); is(c({}), 'following'); is(c(nil), 'following')
  is(c({behavior = 'settled'}), 'standing'); is(c({behavior = 'attend'}), 'standing'); is(c({behavior = 'waiting'}), 'standing')
  is(c({behavior = 'combat'}), 'combat')
  is(c({seating = 'approach', behavior = 'alongside'}), 'to-seat'); is(c({seating = 'seated'}), 'seated'); is(c({seating = 'entering'}), 'seated')
  is(c({seating = 'standing'}), 'getting-up'); is(c({seating = 'closing', behavior = 'alongside'}), 'following')
  is(c({transport = {owned = true, phase = 'riding', mountedSeat = 'seat_back_left'}}), 'passenger')
  is(c({transport = {owned = true, phase = 'riding', seat = 'seat_front_left'}}), 'driving')
  is(c({transport = {owned = true, phase = 'riding', seat = 'seat_front_right', mountedSeat = 'seat_front_left'}}), 'driving')
  is(c({transport = {owned = true, phase = 'boarding'}}), 'boarding'); is(c({transport = {owned = true, phase = 'unmounting'}}), 'leaving-car')
  is(c({transport = {owned = false, phase = 'on-foot'}, behavior = 'alongside'}), 'following')
  is(c({tactic = {kind = 'fight', phase = 'fighting'}}), 'attacking')
  is(c({tactic = {kind = 'unknown', phase = 'talk'}, behavior = 'alongside'}), 'following')
  is(c({transport = {owned = true, phase = 'riding'}, seating = 'seated', behavior = 'combat'}), 'passenger')
`));

test('Lua: the snapshot carries each companion\'s activity, V\'s driving and motion; failures drop only that field', () => lua$(`
  local calls = 0
  ctx.options.activity = function()
    calls = calls + 1
    return {rows = {['judy-alvarez'] = {behavior = 'alongside'}, ['panam-palmer'] = {seating = 'seated'}}, motion = 'walking'}
  end
  N.driving = function() return true end
  local snap = ctx:capture()
  local byKey = {}; for _, row in ipairs(snap.party) do byKey[row.key] = row.activity end
  assert(byKey['judy-alvarez'] == 'following' and byKey['panam-palmer'] == 'seated')
  assert(snap.motion == 'walking' and snap.driving == nil, 'not in a vehicle: no driving, motion kept')
  state.vehicle = true; ctx:reset('test'); snap = ctx:capture()
  assert(snap.driving == true and snap.motion == nil, 'in a car: driving read, walking dropped')
  N.driving = function() error('no seat') end; ctx:reset('test'); snap = ctx:capture()
  assert(snap.vehicle == true and snap.driving == nil)
  ctx.options.activity = function() error('companions failed') end; ctx:reset('test'); snap = ctx:capture()
  assert(snap.party[1].activity == nil and snap.motion == nil and #snap.party == 2, 'a failed read adds nothing and keeps the turn')
  ctx.options.activity = function() return {rows = {['judy-alvarez'] = {behavior = 'alongside'}}, motion = 'flying'} end; ctx:reset('test')
  state.vehicle = false
  assert(ctx:capture().motion == nil)
`));

test('Lua: the outfit word of a companion travels with her row, only home or changed, and only from her own inputs', () => lua$(`
  ctx.options.activity = function()
    return {rows = {['judy-alvarez'] = {behavior = 'alongside', outfit = 'home'}, ['panam-palmer'] = {behavior = 'alongside', outfit = 'naked'}}}
  end
  local snap = ctx:capture()
  local byKey = {}; for _, row in ipairs(snap.party) do byKey[row.key] = row end
  assert(byKey['judy-alvarez'].outfit == 'home' and byKey['judy-alvarez'].activity == 'following')
  assert(byKey['panam-palmer'].outfit == nil and byKey['panam-palmer'].activity == 'following', 'a word the game side does not use is dropped')
  ctx.options.activity = function() return {rows = {['judy-alvarez'] = {outfit = 'changed'}}} end; ctx:reset('test')
  local again = ctx:capture()
  assert(again.party[1].outfit == 'changed' and again.party[2].outfit == nil)
`));

test('Lua: the init wiring and the companions hook exist and read nothing from the game', () => {
  assert.match(initSource, /activity = function\(\)[\s\S]{0,400}companions\.activityInputs\(seats\)/);
  const companions = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
  const hook = companions.slice(companions.indexOf('function M.activityInputs'), companions.indexOf('-- The per-frame face writer'));
  assert.ok(hook.length > 200);
  assert.doesNotMatch(hook, /registerForEvent|onUpdate|GetWorldPosition|Observe\(/, 'only the modules\' own state, nothing from the game');
});

// ---------------------------------------------------------------- weather, health, heat and money (2026-10-14)
const hasSentence = (text, sentence) => text.includes(` ${sentence} `);
const body = extra => turn({turnContext: scene({vehicle: false, party: [{key: 'judy-alvarez', name: 'Judy', activity: 'following'}], ...extra})});
const full = {weather: 'rain', health: 'badly-hurt', heat: 4, money: 'broke'};

test('a companion in person is told the weather, V\'s condition, the police heat and a rough money band', () => {
  const text = turnContext(body(full));
  assert.equal(text, 'Right now (from the game, this turn only): You are with V in person, on foot, following V. You are somewhere in Kabuki, Watson; exactly where is not given. It is late night, about 2 AM. '
    + 'It is raining. V is badly hurt. V has a serious police chase on them. V is a woman (she/her), lifepath Street Kid. V is nearly broke. '
    + 'Treat this as fact: never claim to be anywhere else, or to have just been doing something, unless this says so (what you would like to do or will do is fine).'
    + ' Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them. ' + 'Do not recite it, and mention a place or the time only if it matters to what V says.');
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length}`);
});

test('every weather kind, health band, heat stage and money band has its own short wording; healthy, no heat and ok money say nothing', () => {
  const say = extra => turnContext(body(extra));
  for (const [kind, words] of Object.entries({clear: 'The sky is clear.', cloudy: 'The sky is overcast.', rain: 'It is raining.', 'heavy-rain': 'It is pouring rain.',
    'toxic-rain': 'Toxic rain is falling.', fog: 'It is foggy.', smog: 'The air is thick with smog.', sandstorm: 'A sandstorm is blowing.'})) {
    assert.ok(hasSentence(say({weather: kind}), words), kind);
  }
  assert.ok(hasSentence(say({health: 'hurt'}), 'V is hurt.') && hasSentence(say({health: 'badly-hurt'}), 'V is badly hurt.'));
  assert.doesNotMatch(say({health: 'healthy', heat: 0, money: 'ok'}), /hurt|police|MaxTac|broke|cash|eddies|rich/);
  assert.ok(hasSentence(say({heat: 1}), 'The police are after V.') && hasSentence(say({heat: 2}), 'The police are after V.'));
  assert.ok(hasSentence(say({heat: 3}), 'V has a serious police chase on them.') && hasSentence(say({heat: 4}), 'V has a serious police chase on them.'));
  assert.ok(hasSentence(say({heat: 5}), 'V is wanted at the highest level; MaxTac is after V.'));
  assert.ok(hasSentence(say({money: 'low'}), 'V is short on cash.') && hasSentence(say({money: 'comfortable'}), 'V has plenty of eddies.'));
  assert.ok(say({money: 'rich'}).includes('V is rich. Treat this') && say({money: 'broke'}).includes('V is nearly broke. Treat this'));
});

test('a stranger may know the weather and see an injury, never the heat or the money; a phone contact knows only the weather', () => {
  const stranger = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene({party: [], ...full})}))));
  assert.match(stranger, /It is raining\./);
  assert.match(stranger, /V looks badly hurt\./);
  assert.doesNotMatch(stranger, /police|MaxTac|broke|cash|eddies|rich|V is badly hurt/);
  assert.match(conversationContext(parseInput(JSON.stringify(resident({turnContext: scene({party: [], health: 'hurt'})})))), /V looks hurt\./);
  const phone = turnContext(turn({channel: 'phone', turnContext: scene({party: [], vehicle: false, ...full})}));
  assert.match(phone, /It is raining\./);
  assert.doesNotMatch(phone, /hurt|police|MaxTac|broke|cash|eddies|rich/);
  assert.match(phone, /^Right now \(from the game, this turn only\): You are messaging V by text on the phone/);
  assert.ok(phone.length <= MAX_CHARS, `${phone.length}`);
  // The same snapshot reaches the phone path of the bridge (bridge/phone-chat.mjs parses it with the same function).
  assert.equal(parseTurnContext(scene(full)).money, 'broke');
});

test('weather, health, heat and money are validated: unknown words and out-of-range numbers are dropped one by one', () => {
  const parsed = parseTurnContext(scene({weather: 'meteors', health: 'dead', heat: 6, money: 'a million'}));
  assert.equal(parsed.weather, undefined); assert.equal(parsed.health, undefined); assert.equal(parsed.heat, undefined); assert.equal(parsed.money, undefined);
  assert.equal(parseTurnContext(scene({heat: 2.5})).heat, undefined);
  assert.equal(parseTurnContext(scene({heat: '3'})).heat, undefined);
  assert.equal(parseTurnContext(scene({heat: 0})).heat, 0);
  assert.equal(parseTurnContext(scene({weather: 'toxic-rain', health: 'hurt', heat: 5, money: 'rich'})).weather, 'toxic-rain');
  // Words that are inherited object keys are not accepted.
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(parseTurnContext(scene({weather: key, health: key, money: key})).weather, undefined);
  // A snapshot with only the new fields still counts as ready.
  assert.equal(parseTurnContext({version: 1, status: 'ready', weather: 'fog'}).status, 'ready');
});

test('the whole block stays inside the cap with every fact set, and money is the first to be cut', () => {
  const crowded = scene({vehicle: true, driving: false, motion: undefined, ...full,
    party: [{key: 'judy-alvarez', name: 'Judy', activity: 'passenger'},
      ...Array.from({length: 5}, (_, i) => ({key: `person-${i}`, name: `Person ${i} `.padEnd(34, 'x')}))]});
  const text = turnContext(turn({turnContext: crowded}));
  assert.ok(text.length <= MAX_CHARS, `${text.length}`);
  assert.ok(text.endsWith('if it matters to what V says.'));
  assert.doesNotMatch(text, /nearly broke/, 'a long block drops money before anything else');
  assert.match(text, /V is badly hurt\. V has a serious police chase on them\. V is a woman \(she\/her\), lifepath Street Kid\. Treat this as fact/);
  const phone = turnContext(turn({channel: 'phone', turnContext: crowded}));
  assert.ok(phone.length <= MAX_CHARS, `${phone.length}`);
  const diagnostic = turnContextDiagnostic(turn({turnContext: scene(full)}));
  assert.match(diagnostic, /^Turn context: \d+ facts, \d+ chars$/);
});

test('the right-now block still sits where it did: first in the Convai context and in the Mistral live context', () => {
  sceneryMemory.clear();
  const input = parseInput(JSON.stringify(turn({turnContext: scene(full)})));
  const text = conversationContext(input);
  assert.ok(text.startsWith('Right now (from the game, this turn only): You are with V in person'), text.slice(0, 120));
  const scenery = text.indexOf('late night, about 2 AM.');
  assert.ok(scenery > 0 && scenery < 1500, `the first turn carries the part of the day near the front (the weather is not told on a first turn): ${scenery}`);
  assert.ok(!text.includes('It is raining.'), 'no weather on the first turn');
});

// ---- the Lua side
const fresh = `
state.weather = {'24h_weather_light_rain', 'LightRain', 'GetWeatherState+GetRainIntensityType'}
state.health = {82, 'GetStatPoolValue(percent)'}
state.heat = {2, 'GetHeatStageAsInt'}
state.money = {12340}
state.optionalCalls = {}
N.weather = function() state.optionalCalls.weather = (state.optionalCalls.weather or 0) + 1; guard('weather'); return table.unpack(state.weather) end
N.health = function(p) assert(p == player); state.optionalCalls.health = (state.optionalCalls.health or 0) + 1; guard('health'); return table.unpack(state.health) end
N.heat = function() state.optionalCalls.heat = (state.optionalCalls.heat or 0) + 1; guard('heat'); return table.unpack(state.heat) end
N.money = function(p) assert(p == player); state.optionalCalls.money = (state.optionalCalls.money or 0) + 1; guard('money'); return table.unpack(state.money) end
local lines = {}
ctx.options.log = function(line) lines[#lines + 1] = line end
`;

test('Lua: the snapshot carries the weather kind, the health band, the heat stage and the money band, and the log line shows each raw reading', () => lua$(`${fresh}
  local snap = ctx:capture()
  assert(snap.weather == 'rain' and snap.health == 'healthy' and snap.heat == 2 and snap.money == 'ok', snap.weather .. snap.health .. snap.heat .. snap.money)
  assert(#lines == 1, #lines)
  assert(lines[1] == 'Turn context: 02:10(native) Watson/Kabuki female streetkid vehicle=false party=2 '
    .. 'weather=rain(24h_weather_light_rain|LightRain|GetWeatherState+GetRainIntensityType) health=healthy(82%|GetStatPoolValue(percent)) heat=2(GetHeatStageAsInt) money=ok(12340)', lines[1])
  -- The exact eddies never enter the snapshot, only the band.
  for key, value in pairs(snap) do assert(value ~= 12340 and value ~= 82, key) end
  for i = 1, 20 do ctx:capture() end
  assert(state.optionalCalls.weather == 1 and state.optionalCalls.health == 1 and state.optionalCalls.heat == 1 and state.optionalCalls.money == 1,
    'a burst of turns reads each once (the 5 s window), never per call')
  now = now + api.MAX_AGE; ctx:capture()
  assert(state.optionalCalls.weather == 2 and state.optionalCalls.money == 2, 'refreshed after the window')
`));

test('Lua: the classifiers map the weather, the health percent, the heat stage and the money', () => runLua(`
  local api = (function() ${source} end)()
  local function is(a, b) assert(a == b, tostring(a) .. ' ~= ' .. tostring(b)) end
  local w = api.weatherKind
  is(w('24h_weather_sunny'), 'clear'); is(w('24h_weather_light_clouds'), 'cloudy'); is(w('24h_weather_heavy_clouds'), 'cloudy')
  is(w('24h_weather_rain'), 'rain'); is(w('24h_weather_light_rain'), 'rain'); is(w('24h_weather_heavy_rain'), 'heavy-rain')
  is(w('24h_weather_toxic_rain'), 'toxic-rain'); is(w('24h_weather_fog'), 'fog'); is(w('24h_weather_pollution'), 'smog')
  is(w('24h_weather_sandstorm'), 'sandstorm'); is(w('24h_weather_rain', 'HeavyRain'), 'heavy-rain'); is(w('24h_weather_rain', 0.9), 'heavy-rain')
  is(w(nil, 'HeavyRain'), 'heavy-rain'); is(w(nil, 'LightRain'), 'rain'); is(w(nil, 0.3), 'rain')
  is(w(nil, 'NoRain'), nil); is(w(nil, 0), nil); is(w(nil, nil), nil); is(w('mystery_preset', 'NoRain'), nil); is(w(42, {}), nil)
  local h = api.healthBand
  is(h(100), 'healthy'); is(h(60), 'healthy'); is(h(59.9), 'hurt'); is(h(30), 'hurt'); is(h(29.9), 'badly-hurt'); is(h(0), 'badly-hurt')
  is(h(140), 'healthy'); is(h(-1), nil); is(h(nil), nil); is(h('x'), nil); is(h(0/0), nil)
  local s = api.heatStage
  is(s(0), 0); is(s(5), 5); is(s(6), nil); is(s(-1), nil); is(s(2.5), nil); is(s('Heat_3'), 3); is(s('bogus'), nil); is(s(nil), nil)
  EnumInt = function(value) if type(value) == 'table' then return value.n end error('not an enum') end
  is(s({n = 4}), 4); is(s({n = 9}), nil)
  local m = api.moneyBand
  is(m(0), 'broke'); is(m(249), 'broke'); is(m(250), 'low'); is(m(2499), 'low'); is(m(2500), 'ok'); is(m(49999), 'ok')
  is(m(50000), 'comfortable'); is(m(249999), 'comfortable'); is(m(250000), 'rich'); is(m(5e6), 'rich'); is(m(-5), nil); is(m(nil), nil)
`));

test('Lua: a failing or empty weather, health, heat or money read drops that field, logs once per failure kind, and stops after three errors', () => lua$(`${fresh}
  state.failures = {weather = true, health = true}
  local snap = ctx:capture()
  assert(snap.weather == nil and snap.health == nil and snap.heat == 2 and snap.money == 'ok', 'the other fields are kept')
  assert(snap.hour == 2 and snap.district == 'Watson', 'the rest of the block is unaffected')
  local function count(pattern) local n = 0; for _, line in ipairs(lines) do if line:find(pattern) then n = n + 1 end end; return n end
  assert(count('weather read failed %(.-no weather%)') == 1 and count('health read failed %(.-no health%)') == 1, table.concat(lines, ' | '))
  for i = 1, 6 do now = now + api.MAX_AGE; ctx:capture() end
  assert(count('weather read failed') == 1, 'the same failure kind is logged once, not on every read')
  assert(state.optionalCalls.weather == api.MAX_FAILURES and api.MAX_FAILURES == 3, 'after three straight errors the read is skipped: ' .. state.optionalCalls.weather)
  -- A reset gives it another chance, and it is not logged a second time.
  state.failures = {}; ctx:reset('new save')
  snap = ctx:capture()
  assert(snap.weather == 'rain' and snap.health == 'healthy' and count('weather read failed') == 1)
  -- An answer of nothing is its own kind; so is a value that cannot be used.
  state.heat = {}; state.health = {'banana'}; state.weather = {nil, nil}; state.money = {-4}; ctx:reset('test'); now = now + api.MAX_AGE
  snap = ctx:capture()
  assert(snap.heat == nil and snap.health == nil and snap.weather == nil and snap.money == nil)
  assert(count('heat read answered nothing') == 1 and count('weather read answered nothing') == 1, table.concat(lines, ' | '))
  assert(count('health value not usable %(banana%)') == 1 and count('money value not usable') == 1)
  state.weather = {'strange_state', 'NoRain', 'GetWeatherState'}; ctx:reset('test'); now = now + api.MAX_AGE
  assert(ctx:capture().weather == nil and count('weather not recognised %(state=strange_state rain=NoRain%)') == 1)
  -- The cache is not kept for a snapshot with nothing in it, as before.
  state.failures = {clock = true, place = true, gender = true, lifepath = true, party = true, vehicle = true, weather = true, health = true, heat = true, money = true}
  ctx:reset('test'); assert(ctx:capture() == nil)
`));

test('Lua: the new reads are optional: an adapter without them (an older one) still answers', () => lua$(`
  local snap = ctx:capture()
  assert(snap and snap.weather == nil and snap.health == nil and snap.heat == nil and snap.money == nil and snap.hour == 2)
`));

// The default adapter against a fake game: each unconfirmed call is tried by name, the working name is remembered, and the
// result is plain text or a number.
const weatherGame = `${fakeGame}
local calls = {}
local fake = {state = 'getWeatherState', stateValue = {name = '24h_weather_toxic_rain'}, rainType = 'HeavyRain', rain = 0.8,
  heat = 3, heatName = 'GetHeatStageAsInt', percent = 41, eddies = 78000, noPercent = false, interior = true}
local function counted(name, fn) return function(...) calls[name] = (calls[name] or 0) + 1; return fn(...) end end
local player = Game.GetPlayer()
Game.GetPlayer = function() return {IsAttached = function() return true end, IsDeadNoStatPool = function() return false end,
  IsReplacer = function() return false end, GetResolvedGenderName = function() return {cname = 'Female'} end,
  GetMountedVehicle = function() return nil end, GetEntityID = function() return 'v-id' end} end
Game.GetWeatherSystem = function()
  local system = {}
  if fake.state then system[fake.state:gsub('^%l', string.upper)] = counted('weatherState', function() return fake.stateValue end) end
  system.GetRainIntensityType = counted('rainType', function() return fake.rainType end)
  system.GetRainIntensity = counted('rain', function() return fake.rain end)
  return system
end
Game.GetStatPoolsSystem = function() return {
  GetStatPoolValue = counted('pool', function(self, id, kind, percent)
    assert(id == 'v-id' and kind == 'Health')
    if percent then if fake.noPercent then error('no percent form') end return fake.percent end
    return fake.percent * 2
  end),
  GetStatPoolMaxPointValue = counted('poolMax', function() return 200 end)} end
local container = Game.GetScriptableSystemsContainer()
Game.GetScriptableSystemsContainer = function() return {Get = function(self, name)
  if name == 'PreventionSystem' then
    return {[fake.heatName] = counted('heat', function() return fake.heat end)}
  end
  return container:Get(name)
end} end
Game.GetTransactionSystem = function() return {GetItemQuantity = counted('money', function(self, who, id)
  assert(id == 'item:Items.money', tostring(id)); return fake.eddies end)} end
-- A global script function (REDmod scripts core/entity/gameEntity.script: import function IsEntityInInteriorArea( entity : weak< Entity > ) : Bool),
-- exposed by CET as Game.IsEntityInInteriorArea(entity). It takes the entity, never an id; the game would raise on anything else.
Game.IsEntityInInteriorArea = counted('interior', function(who)
  assert(type(who) == 'table' and who.GetEntityID() == 'v-id', 'the entity is the argument')
  return fake.interior end)
ItemID = {FromTDBID = function(id) return 'item:' .. id end}
TweakDBID = {new = function(name) return name end}
`;

test('the default adapter reads the weather, health, heat and money from the game, remembers the getter that worked, and calls nothing without a turn', () => runLua(`${weatherGame}
  local ctx = api.new({place = function() return {district = 'Watson'} end})
  assert(next(calls) == nil, 'creating the module reads nothing')
  local lines = {}
  ctx.options.log = function(line) lines[#lines + 1] = line end
  local snap = ctx:capture()
  assert(snap.weather == 'toxic-rain' and snap.health == 'hurt' and snap.heat == 3 and snap.money == 'comfortable',
    tostring(snap.weather) .. tostring(snap.health) .. tostring(snap.heat) .. tostring(snap.money))
  assert(#lines == 1, #lines)
  assert(lines[1]:find('health=hurt%(41%%|GetStatPoolValue%(percent%)%)') and lines[1]:find('heat=3%(GetHeatStageAsInt%)') and lines[1]:find('money=comfortable%(78000%)'), lines[1])
  assert(lines[1]:find('weather=toxic%-rain%(') and lines[1]:find('GetWeatherState%+GetRainIntensityType'), lines[1])
  assert(calls.pool == 1 and calls.heat == 1 and calls.money == 1 and calls.rainType == 1 and calls.weatherState == 1)
  -- The indoor flag: one call of the global function with V's entity, and the log says which read answered.
  assert(snap.indoors == true and calls.interior == 1 and lines[1]:find('indoors=true%(IsEntityInInteriorArea%)'), tostring(snap.indoors) .. tostring(calls.interior))
  for i = 1, 10 do ctx:capture() end
  assert(calls.pool == 1 and calls.money == 1, 'cached for the window')
  -- The remembered getter is called directly on the next read; the other names are not tried again.
  local before = calls.weatherState
  ctx:reset('test'); ctx:capture()
  assert(calls.weatherState == before + 1 and calls.heat == 2)
  assert(calls.interior == 2, 'one call per real read: ' .. calls.interior)
`));

test('the default adapter falls back: another state getter name, the value over the maximum, the second heat name, rain-only weather, an enum heat', () => runLua(`${weatherGame}
  fake.state = 'GetActiveWeatherState'; fake.stateValue = '24h_weather_fog'
  fake.noPercent = true; fake.percent = 20
  fake.heatName = 'GetHeatStage'; fake.heat = 'Heat_5'
  local ctx = api.new({place = function() return {district = 'Watson'} end})
  local snap = ctx:capture()
  assert(snap.weather == 'fog' and snap.health == 'badly-hurt' and snap.heat == 5, tostring(snap.weather) .. tostring(snap.health) .. tostring(snap.heat))
  assert(calls.poolMax == 1, 'the percent form failed, so the value and the maximum were read')
  -- No state getter at all: the rain intensity still gives rain.
  fake.state = nil; ctx:reset('test'); snap = ctx:capture()
  assert(snap.weather == 'heavy-rain', tostring(snap.weather))
  fake.rainType = 'NoRain'; ctx:reset('test'); snap = ctx:capture()
  assert(snap.weather == nil, 'no rain and no state says nothing')
`));

test('the default adapter survives a game with none of the calls: every field absent, the clock and place intact, one line per failure kind', () => runLua(`${weatherGame}
  Game.GetWeatherSystem = function() return {} end
  Game.GetStatPoolsSystem = function() error('no stat pools') end
  Game.GetScriptableSystemsContainer = function() return {Get = function() error('no container') end} end
  Game.GetTransactionSystem = function() error('no transactions') end
  local ctx = api.new({place = function() return {district = 'Watson'} end})
  local lines = {}
  ctx.options.log = function(line) lines[#lines + 1] = line end
  for i = 1, 8 do local snap = ctx:capture(); assert(snap.hour == 8 and snap.district == 'Watson'); ctx:reset('again') end
  local failed = {}
  for _, line in ipairs(lines) do
    local kind = line:match('^Turn context: (%a+) read failed')
    if kind then failed[kind] = (failed[kind] or 0) + 1 end
  end
  assert(failed.weather == 1 and failed.health == 1 and failed.heat == 1 and failed.money == 1, 'each kind once: ' .. table.concat(lines, ' | '))
`));

test('init and phone chat pass the same snapshot on, so the phone gets the weather with no change of its own', () => {
  assert.match(initSource, /phoneChat\.captureTurnContext = microphone\.captureTurnContext/);
  assert.match(phoneSource, /capture\(M\.captureTurnContext, key\)/);
  const bridgePhone = readFileSync(new URL('./phone-chat.mjs', import.meta.url), 'utf8');
  assert.match(bridgePhone, /parseTurnContext\(state\.request\.turnContext\)/);
});

test("V's voice tone passes through on its own and never reaches the model's words", () => {
  const parsed = parseTurnContext({version: 1, status: 'ready', gender: 'female', voice: 'male'});
  assert.equal(parsed.voice, 'male');
  assert.equal(parsed.gender, 'female');
  assert.equal(parseTurnContext({version: 1, status: 'ready', voice: 'robot'}).voice, undefined);
  assert.equal(describeTurnContext(parseTurnContext({version: 1, status: 'ready', voice: 'male'})).text, '');
});

// ---------------------------------------------------------------- an add-on voice with no body (persona.voiceContext)
const CAB = 'addon-delamain-cab-delamain';
const cabTurn = (extra = {}) => parseInput(JSON.stringify(turn({profileKey: CAB, name: 'Delamain', text: 'Where are we?', gear, journal,
  turnContext: scene({money: 'rich', heat: 3, health: 'hurt', weather: 'rain'}), ...extra})));

test('an add-on voice is not told it is with V in person, and learns no party names, lifepath, wallet, heat or health outside a group round', () => {
  // Nothing at all outside a group round: not the clock, not the weather (a small model recited them on every turn), not the party.
  assert.equal(turnContext(cabTurn(), {voice: true}), '');
  assert.equal(describeTurnContext(cabTurn(), {voice: true}).parts, 0);
  assert.match(turnContext(cabTurn(), {}), /You are with V in person[^]*Also with V: Judy and Panam/, 'the person form is what everyone else still gets');
});

test('an add-on voice hears who is with V only in a group round, and the block never reaches a reaction', () => {
  const group = {id: 'g-1', index: 1, total: 2, audience: [CAB, 'judy-alvarez'], heard: []};
  const grouped = turnContext(cabTurn({group}), {voice: true});
  assert.match(grouped, /Also with V: Judy and Panam\./);
  assert.doesNotMatch(grouped, /raining|late night|vehicle|in person|woman|Street Kid|rich|police|hurt/);
  assert.equal(turnContext(cabTurn({reaction: {kind: 'addon'}}), {voice: true}), '');
  assert.match(turnContextDiagnostic(cabTurn({group}), {voice: true}), /^Turn context: 1 facts, \d+ chars$/);
  assert.equal(turnContext(cabTurn({turnContext: {version: 1, status: 'ready', gender: 'male', lifepath: 'nomad'}}), {voice: true}), '', 'nothing a voice may use');
});

test('the voice form of the context carries no journal, no gear and none of the first-person notes written for a person V looks at', () => {
  const blocks = voiceConversationBlocks(cabTurn());
  const text = blocks.map(block => block.text).join('\n');
  assert.doesNotMatch(text, /Samurai Jacket|Kyubi|The Heist|journal|V is looking at you|Reply only as yourself|Right now/);
  assert.match(voiceConversationBlocks(cabTurn({group: {id: 'g-1', index: 1, total: 2, audience: [CAB, 'judy-alvarez'], heard: []}}))[0].text, /Right now \(from the game/);
  assert.deepEqual(blocks.map(block => block.tier), ['now', 'world', 'volatile', 'volatile']);
  // The ordinary form for the same input still has all of it.
  assert.match(conversationContext(cabTurn()), /Samurai Jacket/);
});

// ---------------------------------------------------------------- where V is (2026-10-15)
// Live 2026-10-15: Alex stood next to V in the street in Arroyo, and answered "Either you're here to buy a drink or you're here to leave". The
// block said only "standing near V in Arroyo, Santo Domingo": no street, no building, nothing that said her bar (the Moth, in her profile) was
// elsewhere, so the model filled the gap with her bar. The block now says whether V is indoors or out when the game can say, that the exact
// spot is not given when it cannot, a named place only from the game's own record, and that her usual haunts are not here.
const street = (extra = {}, input = {}) => turn({profileKey: 'alex', name: 'Alex', text: 'Hey', turnContext: scene({district: 'SantoDomingo', area: 'Arroyo',
  vehicle: false, motion: 'still', gender: undefined, lifepath: undefined, party: [{key: 'alex', name: 'Alex', activity: 'standing'}], ...extra}), ...input});

test('Alex in Arroyo: the block names the neighbourhood, does not claim a street or a building when the game cannot say, and says her haunts are not here', () => {
  const text = turnContext(street());
  assert.match(text, /You are with V in person, standing near V\. You are somewhere in Arroyo, Santo Domingo; exactly where is not given\./);
  assert.match(text, /Your usual workplace, home and hangouts are not here unless this says so: never greet or serve V as if V had come to them\./);
  assert.doesNotMatch(text, /indoors|outdoors|\bbar\b|Moth/);
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length}`);
});

test('the game\'s indoor reading says "outdoors, not inside a building" or "indoors"; an interior record says indoors with the named place', () => {
  assert.match(turnContext(street({indoors: false})), /standing near V\. You are outdoors in Arroyo, Santo Domingo, in the open air, not inside a building\. It is late night/);
  assert.doesNotMatch(turnContext(street({indoors: false})), /not given/);
  assert.match(turnContext(street({indoors: true})), /standing near V\. You are indoors, in a building in Arroyo, Santo Domingo; which building is not given\. It is late night/);
  const bar = turnContext(street({district: 'Watson', area: 'Kabuki_LizziesBar'}));
  assert.match(bar, /standing near V\. You are inside Lizzie's Bar, Watson\./);
  assert.match(turnContext(street({district: 'Watson', area: 'LittleChina_VApartment'})), /You are inside V's apartment in Megabuilding H10\./);
  assert.match(turnContext(street({district: 'Badlands', area: 'Badlands_RockyRidge'})), /You are outdoors in Rocky Ridge, Badlands, out in open country\./);
});

test('a named place is never invented: no record, no name; a bad indoor value is dropped; a vehicle claims no building either way', () => {
  assert.doesNotMatch(turnContext(street({district: 'Watson', area: 'Kabuki'})), /Lizzie|Afterlife|Moth/);
  assert.equal(parseTurnContext(scene({indoors: 'maybe'})).indoors, undefined);
  assert.equal(parseTurnContext(scene({indoors: false})).indoors, false);
  assert.equal(parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 5, indoors: true}).indoors, undefined, 'nothing to be indoors in without a district');
  const inCar = turnContext(street({vehicle: true, motion: undefined}));
  assert.match(inCar, /You are somewhere in Arroyo, Santo Domingo; exactly where is not given\./, 'no reading, no claim of indoors or outdoors');
  assert.doesNotMatch(inCar, /indoors|outdoors|in a building/);
  // A phone chat or a holocall says it about V and nothing of her own place: she is somewhere else, with her place not given.
  for (const input of [{channel: 'phone'}, {holocall: {mode: 'audio'}}]) {
    const text = turnContext(street({indoors: false}, input));
    assert.match(text, /You are somewhere else; where you are and what you are doing are not given\. V is outdoors in Arroyo, Santo Domingo, in the open air, not inside a building\./, JSON.stringify(input));
    assert.doesNotMatch(text, /You are (?:outdoors|indoors|inside|somewhere in)|usual workplace/, JSON.stringify(input));
  }
  // A stranger is told about its own place, in the same words, and never her haunts.
  const stranger = turnContext(street({indoors: false}), {ambient: true});
  assert.match(stranger, /You are outdoors in Arroyo, Santo Domingo, in the open air, not inside a building\./);
  assert.doesNotMatch(stranger, /usual workplace/);
});

test('with everything set the block still holds its cap, keeps the place and haunts lines', () => {
  const crowded = street({indoors: false, vehicle: false, gender: 'female', lifepath: 'streetkid', weather: 'rain', health: 'badly-hurt', heat: 4, money: 'broke',
    party: [{key: 'alex', name: 'Alex', activity: 'following'}, ...Array.from({length: 4}, (_, i) => ({key: `person-${i}`, name: `Person ${i} `.padEnd(40, 'x')}))]});
  const text = turnContext(crowded);
  assert.ok(text.length <= MAX_CHARS, `${text.length}`);
  assert.match(text, /not inside a building\./);
  assert.match(text, /usual workplace, home and hangouts are not here/);
});

test('the diagnostic and the prompt carry the new sentences like the old ones', () => {
  const input = parseInput(JSON.stringify(street({indoors: false})));
  assert.match(conversationContext(input), /^Right now \(from the game, this turn only\): You are with V in person, standing near V\. You are outdoors in Arroyo, Santo Domingo, in the open air, not inside a building\./);
  assert.match(turnContextDiagnostic(input), /^Turn context: \d+ facts, \d+ chars$/);
});

test('Lua: the indoor reading is optional, guarded, logged with its source and never counted as something read', () => lua$(`${fresh}
  state.interior = {false, 'IsEntityInInteriorArea(entity)'}
  N.interior = function(p) assert(p == player); state.optionalCalls.interior = (state.optionalCalls.interior or 0) + 1; guard('interior'); return table.unpack(state.interior) end
  local snap = ctx:capture()
  assert(snap.indoors == false, tostring(snap.indoors))
  assert(lines[1]:find(' indoors=false%(IsEntityInInteriorArea%(entity%)%)'), lines[1])
  state.interior = {true, 'IsEntityInInteriorArea(id)'}; now = now + api.MAX_AGE
  assert(ctx:capture().indoors == true)
  -- A failing read drops only that field, is logged once, and the Turn context line says the value is unknown.
  state.failures = {interior = true}; now = now + api.MAX_AGE
  local failed = ctx:capture()
  assert(failed.indoors == nil and failed.weather == 'rain' and failed.district == 'Watson', 'the rest of the block is kept')
  assert(lines[#lines]:find(' indoors=unknown'), lines[#lines])
  local logged = 0; for _, line in ipairs(lines) do if line:find('interior read failed') then logged = logged + 1 end end
  assert(logged == 1, logged)
  for i = 1, 5 do now = now + api.MAX_AGE; ctx:capture() end
  assert(state.optionalCalls.interior == 2 + api.MAX_FAILURES, 'skipped after three straight errors: ' .. state.optionalCalls.interior)
  state.failures = {}; ctx:reset('new save'); state.interior = {'yes'}; now = now + api.MAX_AGE
  assert(ctx:capture().indoors == nil, 'only a boolean counts')
  -- No district, no indoor reading.
  state.place = nil; state.interior = {true, 'x'}; now = now + api.MAX_AGE
  assert(ctx:capture().indoors == nil)
`));

test('Lua: the native adapter reads the indoor flag through the global script function, not the scene system, on demand only', () => {
  const code = source.split(/\r?\n/).map(row => row.replace(/--.*$/, '')).join('\n');
  assert.match(code, /Game\.IsEntityInInteriorArea\(who\)/);
  assert.doesNotMatch(code, /GetSceneSystem|GetScriptInterface|:IsEntityInInteriorArea/, 'SceneSystemInterface has no such method (it failed live 2026-10-15)');
  assert.match(code, /self:optional\('interior', player\)/);
  assert.doesNotMatch(code, /registerForEvent|onUpdate|Observe\(/);
});

test('Lua: the indoor flag falls back to a bare global, says so when CET exposes neither, and refuses anything but a boolean', () => lua$(`${weatherGame}
  local lines = {}
  local function line() return lines[#lines] end
  local ctx = api.new({place = function() return {district = 'Watson'} end})
  ctx.options.log = function(text) lines[#lines + 1] = text end
  -- Neither a Game function nor a bare global: not given, logged once, the rest of the block kept.
  Game.IsEntityInInteriorArea = nil
  local snap = ctx:capture()
  assert(snap.indoors == nil and snap.weather == 'toxic-rain' and snap.district == 'Watson')
  assert(line():find(' indoors=unknown', 1, true))
  local n = 0; for _, text in ipairs(lines) do if text:find('interior read failed (IsEntityInInteriorArea is not exposed by this CET build)', 1, true) then n = n + 1 end end
  assert(n == 1, table.concat(lines, ' | '))
  -- A bare global works when Game has none.
  ctx:reset('test'); _G.IsEntityInInteriorArea = function(who) assert(who.GetEntityID() == 'v-id'); return false end
  snap = ctx:capture()
  assert(snap.indoors == false and line():find('indoors=false(IsEntityInInteriorArea)', 1, true), tostring(snap.indoors))
  -- Anything that is not a boolean is an error, never indoors or outdoors.
  _G.IsEntityInInteriorArea = nil; Game.IsEntityInInteriorArea = function() return 1 end
  ctx = api.new({place = function() return {district = 'Watson'} end}); ctx.options.log = function(text) lines[#lines + 1] = text end
  snap = ctx:capture()
  assert(snap.indoors == nil and line():find(' indoors=unknown', 1, true))
`));

// ---------------------------------------------------------------- less weather talk (2026-10-21)
// A player report: "the NPCs always mention the weather". "It is raining." on every turn made the weather the topic of every answer, so the
// weather and the part of the day are Background, stated only when new to a conversation (first turn, a change, after a long silence, or when V
// asks), in a line of their own in the volatile tail; health, heat and money stay in the block. Who gets what is unchanged.
const BACKGROUND_LEAD = 'Background (mention only if it matters or V asks):';
let turnNumber = 100;
// One more turn of the same conversation (a new request id each time), built the way the bridge builds it.
const nextTurn = (extra = {}, snapshot = {}) => parseInput(JSON.stringify(turn({requestId: `${++turnNumber}-1-11ULL`, turnContext: scene({weather: 'rain', ...snapshot}), ...extra})));
const nextResident = (extra = {}, snapshot = {}) => parseInput(JSON.stringify(resident({requestId: `${++turnNumber}-1-55ULL`, turnContext: scene({party: [], weather: 'rain', ...snapshot}), ...extra})));
const backgroundOf = text => text.split('\n\n').find(part => part.startsWith('Background')) ?? '';

test('the weather is not told on the first turn (the part of the day is), nor on a repeat with the same weather, and is told on a change', () => {
  sceneryMemory.clear();
  const first = conversationContext(nextTurn());
  assert.equal(backgroundOf(first), `${BACKGROUND_LEAD} It is late night, about 2 AM.`, 'the rain is not announced on a first turn (response audit 2026-10-22: strangers then mentioned it in 11 replies of 12)');
  assert.doesNotMatch(first.split('\n\n')[0], /raining|late night/, 'not in the right-now block itself');
  const again = conversationContext(nextTurn());
  assert.equal(backgroundOf(again), '', 'nothing new: no background line at all');
  assert.doesNotMatch(again, /raining|late night|Background/);
  assert.doesNotMatch(conversationContext(nextTurn()), /raining/, 'and the turn after that');
  // A change: the weather clears, then the part of the day moves on.
  assert.equal(backgroundOf(conversationContext(nextTurn({}, {weather: 'clear'}))), `${BACKGROUND_LEAD} The sky is clear.`);
  assert.equal(backgroundOf(conversationContext(nextTurn({}, {weather: 'clear', hour: 6}))), `${BACKGROUND_LEAD} It is early morning, about 6 AM.`);
  assert.equal(backgroundOf(conversationContext(nextTurn({}, {weather: 'clear', hour: 6, minute: 40}))), '', 'the hour rolling over within a part of the day is not news');
  assert.equal(backgroundOf(conversationContext(nextTurn({}, {weather: 'fog', hour: 6, minute: 50}))), `${BACKGROUND_LEAD} It is foggy.`);
});

test('the weather is told again when V asks about it, and the clock when V asks the time; ordinary words do not count', () => {
  sceneryMemory.clear();
  conversationContext(nextTurn());
  for (const text of ['Is it always raining here?', 'what a storm', 'Nice weather.', 'Look at that sky', 'Is that fog or smog?', 'it is sunny today', 'bring an umbrella']) {
    assert.match(backgroundOf(conversationContext(nextTurn({text}))), /It is raining\./, text);
  }
  for (const text of ['So what now?', 'I am in training', 'Where is the mistake?', 'See you on Sunday', 'My brain is fried', 'the train is slow']) {
    assert.doesNotMatch(conversationContext(nextTurn({text})), /raining/, text);
  }
  const timeAsked = conversationContext(nextTurn({text: 'what time is it?'}));
  assert.match(backgroundOf(timeAsked), /It is late night, about 2 AM\./);
  assert.doesNotMatch(backgroundOf(timeAsked), /raining/, 'asking the time does not bring the weather');
  assert.doesNotMatch(conversationContext(nextTurn({text: 'what a mess'})), /Background/);
});

test('one context serves every provider (decision of 2026-10-22): Convai gets the same blocks as the text providers, so a first turn has no weather and an archetype is not told to announce its place', () => {
  sceneryMemory.clear();
  // conversationContext is the string Convai is sent (bridge/convai-bridge.mjs joins the same blocks the text providers lay out).
  const convai = conversationContext(nextResident());
  assert.doesNotMatch(convai, /It is raining\./, 'no weather on the first turn, for Convai too');
  assert.match(convai, /Background \(mention only if it matters or V asks\): It is late night, about 2 AM\./);
  const input = parseInput(JSON.stringify({...resident({requestId: '71-1-55ULL'}), archetype: {base: 'food-vendor', category: 'vendor', title: 'food vendor', district: 'Watson', area: 'Kabuki'}}));
  const place = archetypeContext(input);
  assert.match(place, /never announce the place name or tell V where they are unless V asks/, 'the archetype place sentence is the one every provider reads');
  assert.doesNotMatch(convai, /Let the place flavor what you say/);
});

test('a weather question on the FIRST turn brings the weather, in English and in the languages of the game menus', () => {
  // The first turn does not announce the weather, so a question about it must be recognised or the model is left to guess (review of 2026-10-22).
  sceneryMemory.clear();
  assert.match(backgroundOf(conversationContext(nextTurn({text: 'Is it always raining here?'}))), /It is raining\./, 'English, first turn');
  const asks = ['is it cold out?', 'gonna get wet?', 'bring an umbrella', 'Nice weather.', 'Look at that sky', 'is it snowing?',          // en
    '¿Está lloviendo?', '¿Hace frío o calor?', 'Chove aí?', 'Está um dia de chuva', 'Il pleut ?', 'Quel temps de chien, il fait froid', // es pt fr
    'Regnet es?', 'Ist es kalt draußen?', 'Piove?', 'Che freddo, vero?', 'Pada deszcz?', 'Jaka pogoda?', 'Prší?', 'Je venku zima?',     // de it pl cs
    'Esik az eső?', 'Hideg van odakint?', 'Дождь?', 'Какая погода?', 'Чи йде дощ?', 'Яка погода?', 'Yağmur yağıyor mu?', 'Hava nasıl?', // hu ru uk tr
    '今日は雨？', '外は寒いね', '下雨了吗？', '天氣好冷', '날씨 어때?', '비 와요?'];                                                 // ja zh ko
  for (const text of asks) {
    sceneryMemory.clear();
    const memory = new SceneryMemory();
    assert.equal(memory.decide({key: 'k', id: '1', weather: 'rain', part: 'night', text}).weather, true, text);
  }
  const talk = ['Hey.', 'Hola, ¿cómo estás?', 'Wie geht es dir?', 'Quoi de neuf ?', 'Что делаешь?', '今日は元気？', '你好吗？', 'Tudo bem?', 'Come stai?', 'So what now?', 'See you on Sunday'];
  for (const text of talk) assert.equal(new SceneryMemory().decide({key: 'k', id: '1', weather: 'rain', part: 'night', text}).weather, false, text);
});

test('each conversation is told on its own: another character, another stranger, a phone contact; and again after a long silence', () => {
  sceneryMemory.clear();
  assert.match(conversationContext(nextTurn()), /late night, about 2 AM\./);
  assert.match(conversationContext(nextTurn({profileKey: 'panam-palmer', name: 'Panam', entity: '12ULL', requestId: `${++turnNumber}-1-12ULL`})), /late night, about 2 AM\./, 'another character');
  assert.doesNotMatch(conversationContext(nextTurn()), /late night, about 2 AM/, 'Judy has heard it');
  // Two strangers: each hears it once.
  assert.match(conversationContext(nextResident()), /late night, about 2 AM\./);
  assert.doesNotMatch(conversationContext(nextResident()), /late night, about 2 AM/);
  assert.match(conversationContext(nextResident({entity: '56ULL', requestId: `${++turnNumber}-1-56ULL`})), /late night, about 2 AM\./, 'another NPC');
  // A phone chat with Judy is its own conversation.
  const text = conversationContext(turn({requestId: `${++turnNumber}-1-11ULL`, channel: 'phone', turnContext: scene({weather: 'rain', party: [], vehicle: false})}));
  assert.match(backgroundOf(text), /late night, about 2 AM\./);
  // After a long silence, with a clock we control.
  let at = 1_000_000; const memory = new SceneryMemory({now: () => at});
  const ask = id => memory.decide({key: 'k', id, weather: 'rain', part: 'night', text: 'hi'});
  assert.deepEqual(ask('a'), {weather: false, time: true}, 'the first turn: the part of the day, not the weather');
  at += 60_000; assert.deepEqual(ask('b'), {weather: false, time: false});
  at += 21 * 60_000; assert.deepEqual(ask('c'), {weather: false, time: true}, 'a conversation silent for 20 minutes hears the part of the day again');
  at += 1000; assert.deepEqual(ask('d'), {weather: false, time: false});
  // A turn on which the game could not read the weather keeps what the conversation was told.
  assert.deepEqual(memory.decide({key: 'k', id: 'e', weather: undefined, part: 'night', text: ''}), {weather: false, time: false});
  assert.deepEqual(memory.decide({key: 'k', id: 'f', weather: 'rain', part: 'night', text: ''}), {weather: false, time: false});
  // The memory is bounded.
  const small = new SceneryMemory({limit: 2});
  for (const key of ['a', 'b', 'c']) small.decide({key, id: '1', weather: 'rain', part: 'night'});
  assert.equal(small.conversations.size, 2);
});

test('one turn built several times (the prepared reply, the look-ahead, the turn itself, the log line) always gets the same scenery', () => {
  sceneryMemory.clear();
  conversationContext(nextTurn());
  const input = nextTurn({}, {weather: 'fog'});
  const first = conversationContext(input);
  assert.match(backgroundOf(first), /It is foggy\./);
  for (let i = 0; i < 3; i++) assert.equal(conversationContext(input), first);
  assert.equal(conversationContext(parseInput(JSON.stringify({...input}))), first, 'a copy of the same request too');
  const quiet = nextTurn({}, {weather: 'fog'});
  const second = conversationContext(quiet);
  assert.doesNotMatch(second, /foggy/);
  for (let i = 0; i < 3; i++) assert.equal(conversationContext(quiet), second, 'a prepared reply and the turn that uses it agree');
  // A turn with no id, no snapshot or a reaction is never gated.
  const snapshot = scene({weather: 'rain'}), everything = {weather: true, time: true};
  assert.deepEqual(sceneryFor(turn({requestId: undefined, id: undefined, turnContext: snapshot})), everything);
  assert.deepEqual(sceneryFor(turn({reaction: {kind: 'loot'}, turnContext: snapshot})), everything);
  assert.deepEqual(sceneryFor(turn({turnContext: undefined})), everything);
  assert.deepEqual(sceneryFor(turn({turnContext: {version: 1, status: 'unavailable'}})), everything);
  assert.deepEqual(sceneryFor(undefined), everything);
});

test('the right-now block is the same whether or not the scenery is told, so the prompt cache keeps its prefix; the scenery is in the volatile tail', () => {
  sceneryMemory.clear();
  const a = quest.conversationContextBlocks(nextTurn()), b = quest.conversationContextBlocks(nextTurn());
  assert.equal(a[0].tier, 'now'); assert.equal(a[0].text, b[0].text);
  const scenery = blocks => blocks.filter(block => block.text?.startsWith('Background'));
  assert.equal(scenery(a).length, 1); assert.equal(scenery(a)[0].tier, 'volatile', 'told: in the volatile tail');
  assert.equal(scenery(b).length, 0, 'not told: no block at all');
  // A stranger the same way.
  const c = quest.conversationContextBlocks(nextResident()), d = quest.conversationContextBlocks(nextResident());
  assert.equal(c[0].text, d[0].text);
  assert.equal(scenery(c)[0].tier, 'volatile'); assert.equal(scenery(d).length, 0);
  // The lead-in is short: every token of it is latency.
  assert.ok(BACKGROUND_LEAD.length < 60);
});

test('who gets what is unchanged: a companion keeps health, heat and money in the block on every turn; a stranger never gets heat or money; a phone contact only the weather', () => {
  sceneryMemory.clear();
  const snapshot = {vehicle: false, ...full};
  const companion = [conversationContext(nextTurn({}, snapshot)), conversationContext(nextTurn({}, snapshot)), conversationContext(nextTurn({}, snapshot))];
  for (const [index, text] of companion.entries()) {
    assert.match(text, /V is badly hurt\. V has a serious police chase on them\. V is a woman \(she\/her\), lifepath Street Kid\. V is nearly broke\./, `turn ${index + 1}`);
    assert.doesNotMatch(text, /raining/, `no weather on the first turn nor while it stays the same (${index + 1})`);
  }
  assert.doesNotMatch(companion[0].split('\n\n')[0], /raining|late night/, 'the block itself carries neither');
  const strangers = [conversationContext(nextResident({}, snapshot)), conversationContext(nextResident({}, snapshot))];
  for (const [index, text] of strangers.entries()) {
    assert.match(text, /V looks badly hurt\./);
    assert.doesNotMatch(text, /police|MaxTac|broke|cash|eddies|rich|V is badly hurt|lifepath/, `stranger, turn ${index + 1}`);
    assert.doesNotMatch(text, /It is raining/, `stranger, turn ${index + 1}`);
  }
  const phone = () => conversationContext(turn({requestId: `${++turnNumber}-1-11ULL`, profileKey: 'panam-palmer', channel: 'phone',
    turnContext: scene({party: [], ...snapshot})}));
  const first = phone(), second = phone();
  assert.match(backgroundOf(first), /late night, about 2 AM\./);
  assert.doesNotMatch(first + second, /hurt|police|MaxTac|broke|cash|eddies|rich|Also with V|Panam\./);
  assert.doesNotMatch(second, /raining/);
});

test('describeTurnContext: `split` moves the weather and the time to `background`, `fresh` leaves out what was told, and the default is unchanged', () => {
  const input = body(full);
  const all = describeTurnContext(input);
  assert.equal(all.background, '', 'the default form keeps everything inline');
  assert.match(all.text, /It is late night, about 2 AM\. It is raining\. V is badly hurt\./);
  const split = describeTurnContext(input, {split: true});
  assert.doesNotMatch(split.text, /late night|raining/);
  assert.match(split.text, /You are somewhere in Kabuki, Watson; exactly where is not given\. V is badly hurt\./);
  assert.equal(split.background, `${BACKGROUND_LEAD} It is late night, about 2 AM. It is raining.`);
  assert.equal(split.parts, all.parts, 'the same facts, counted');
  assert.equal(describeTurnContext(input, {split: true, fresh: {weather: false, time: true}}).background, `${BACKGROUND_LEAD} It is late night, about 2 AM.`);
  assert.equal(describeTurnContext(input, {split: true, fresh: {weather: true, time: false}}).background, `${BACKGROUND_LEAD} It is raining.`);
  assert.equal(describeTurnContext(input, {split: true, fresh: {weather: false, time: false}}).background, '');
  assert.doesNotMatch(describeTurnContext(input, {fresh: {weather: false, time: true}}).text, /raining/, 'the inline form honours `fresh` too');
  // A stranger whose only facts are the scenery still gets them; an add-on voice never does.
  const lonely = turn({profileKey: 'resident-male', turnContext: {version: 1, status: 'ready', hour: 9, minute: 5, weather: 'smog'}});
  const quiet = describeTurnContext(lonely, {ambient: true, split: true});
  assert.equal(quiet.text, STRANGER_NOTE, 'a stranger always hears that it does not know V'); assert.equal(quiet.background, `${BACKGROUND_LEAD} It is morning, about 9 AM. The air is thick with smog.`);
  assert.equal(quiet.reason, '');
  assert.equal(describeTurnContext(lonely, {ambient: true, split: true, fresh: {weather: false, time: false}}).text, STRANGER_NOTE, 'nothing else to say: the stranger note alone');
  assert.equal(describeTurnContext(body(full), {voice: true, split: true}).background, '');
});

test('the per-turn diagnostic says whether the background line went along', () => {
  sceneryMemory.clear();
  const first = nextTurn(), second = nextTurn();
  const options = input => turnContextOptions(input, false);
  assert.match(turnContextDiagnostic(first, options(first)), /^Turn context: \d+ facts, \d+ chars background=\d+$/);
  assert.match(turnContextDiagnostic(second, options(second)), /^Turn context: \d+ facts, \d+ chars background=none$/);
  assert.doesNotMatch(turnContextDiagnostic(second, options(second)), /raining|Judy|Watson/, 'counts only');
});
