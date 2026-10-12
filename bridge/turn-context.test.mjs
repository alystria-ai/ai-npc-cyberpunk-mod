import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseTurnContext, describeTurnContext, turnContext, turnContextDiagnostic, timeOfDay, MAX_CHARS}
  from './turn-context.mjs';
import {parseInput, isAmbientProfile} from './protocol.mjs';
import {conversationContext} from './quest-context.mjs';
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
  assert.equal(text, 'Right now (from the game, this turn only): It is late night, about 2 AM. You and V are in Kabuki, Watson. '
    + 'Also with V: Panam. V is in a vehicle. V is a woman (she/her), lifepath Street Kid. '
    + 'Background only; bring it up only when it fits, and never announce it.');
  assert.ok(text.length <= MAX_CHARS && !text.includes('\n'), `${text.length} characters`);
  assert.equal(MAX_CHARS, 450);
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
  assert.match(only({district: 'SantoDomingo'}), /^Right now \(from the game, this turn only\): You and V are in Santo Domingo\. Background only/);
  assert.match(only({hour: 14, minute: 0}), /It is afternoon, about 2 PM\. Background/);
  assert.match(only({vehicle: false}) || 'none', /^none$/, 'not in a vehicle says nothing');
  assert.match(only({gender: 'male'}), /V is a man \(he\/him\)\./);
  assert.match(only({lifepath: 'nomad'}), /V is lifepath Nomad\./);
  // A district with a distinct area names both, a district alone just itself.
  assert.match(only({district: 'Watson', area: 'Watson'}), /in Watson\./);
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
  assert.match(long, /It is late night, about 2 AM\. You and V are in Kabuki, Watson\./, 'the clock and the place are the last to go');
  assert.ok(long.endsWith('never announce it.'), 'the framing is never cut');
  for (const [, run] of long.matchAll(/(x{20,})/g)) assert.equal(run.length >= 20, true);
});

test('a phone message says where V is, not where the contact is', () => {
  assert.match(turnContext(turn({channel: 'phone', turnContext: scene({party: []})})), /V is in Kabuki, Watson\./);
});

test('the block is the very first thing in the conversation context, before the world knowledge and the journal', () => {
  const input = parseInput(JSON.stringify(turn({turnContext: scene(), journal, gear})));
  const text = conversationContext(input);
  assert.ok(text.startsWith('Right now (from the game, this turn only): It is late night'), text.slice(0, 80));
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
  assert.equal(turnContextDiagnostic(input), `Turn context: 5 facts, ${turnContext(input).length} chars`);
  assert.equal(turnContextDiagnostic({}), 'Turn context: none (the game sent none)');
  assert.equal(turnContextDiagnostic(turn({turnContext: {version: 1, status: 'unavailable'}})), 'Turn context: none (unavailable or malformed)');
  assert.equal(turnContextDiagnostic({...input, reaction: {kind: 'loot'}}), 'Turn context: none (automatic reaction)');
  assert.equal(turnContextDiagnostic(undefined), 'Turn context: none (no input)');
  assert.doesNotMatch(turnContextDiagnostic(input), /Judy|Watson/, 'counts only');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{turnContextDiagnostic\} from '\.\/turn-context\.mjs'/);
  assert.match(bridge, /console\.error\(`\[TurnContext\] profile=\$\{input\.profileKey\} \$\{turnContextDiagnostic\(input, \{ambient: isAmbientProfile\(input\.profileKey\)\}\)\}`\)/);
});

// ---------------------------------------------------------------- ordinary NPCs are strangers
const resident = (extra = {}) => turn({profileKey: 'resident-male', name: 'Pedestrian', entity: '55ULL', requestId: '100-1-55ULL',
  archetype: {title: 'Kabuki resident', district: 'Kabuki'}, journal, gear,
  worldKnowledge: {version: 1, status: 'unavailable'}, journalHistory: {version: 1, status: 'unavailable'}, ...extra});

test('an ordinary NPC gets no journal, no jobs, no history and no gear list; only what a stranger could see', () => {
  for (const profileKey of ['resident-male', 'resident-female', 'npc-ripperdoc', 'npc-food-vendor']) {
    assert.ok(isAmbientProfile(profileKey));
    const text = conversationContext(parseInput(JSON.stringify(resident({profileKey, turnContext: scene()}))));
    assert.doesNotMatch(text, /journal|objective|The Heist|vault door|shared with you|world knowledge|journal history|Current verified save facts/i, profileKey);
    assert.doesNotMatch(text, /V's current gear|weapons equipped|Mantis|Kiroshi|Malorian|operating system/, profileKey);
    // Time, V's visible situation and the framing as a stranger.
    assert.ok(text.startsWith('Right now (from the game, this turn only): It is late night, about 2 AM.'), profileKey);
    assert.match(text, /V is in a vehicle\./);
    assert.match(text, /V has 2 other people with them\./);
    assert.match(text, /V looks like a woman \(she\/her\)\./);
    assert.match(text, /You are a stranger to V and know only what you can see and hear\./);
    assert.doesNotMatch(text, /Street Kid|lifepath|Judy|Panam/, 'a stranger knows neither the lifepath nor the party');
    // What a bystander can see of V: the clothing and the weapon in hand.
    assert.match(text, /What you can see of V right now - wearing: outer torso: Samurai Jacket, legs: Cargo Pants; weapon in hand: Kyubi\./);
    assert.match(text, /Speak only your own dialogue/, 'the spoken-output rule stays');
    assert.ok(text.length < 1800, `${text.length} characters`);
  }
});

test('an ordinary NPC is told where it is once: by its own district block, else by the right-now block', () => {
  const withDistrict = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene()}))));
  assert.doesNotMatch(withDistrict, /You are in Kabuki/, 'the archetype block already says it');
  const bare = conversationContext(parseInput(JSON.stringify(resident({turnContext: scene(), archetype: undefined}))));
  assert.match(bare, /You are in Kabuki, Watson\./);
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

test('the module is on demand only: no frame hook, no observer, no file, no timer, and nothing is sent unless asked', () => {
  assert.doesNotMatch(source, /registerForEvent|onUpdate|Observe\(|ObserveAfter|Override\(|io\.open|os\.execute|json\./);
  assert.match(source, /^local M = \{\}/m);
  assert.match(source, /pcall\(self\.read, self\)/);
  // Weather, health and heat are not read: their CET calls are unconfirmed.
  assert.doesNotMatch(source.split(/\r?\n/).map(row => row.replace(/--.*$/, '')).join('\n'), /Weather|StatPoolsSystem|GetStatPool|HeatStage/);
});

test('every manual in-person send path captures the block; reactions never do, and the phone does not yet', () => {
  const send = initSource.slice(initSource.indexOf('local function sendRequest(context)'), initSource.indexOf('-- A managed copy can be reassigned'));
  assert.match(send, /if not context\.reaction and convaiTurnContext then context\.turnContext = context\.turnContext or convaiTurnContext:capture\(\) end/);
  assert.match(initSource, /microphone\.captureTurnContext = function\(\) return convaiTurnContext and convaiTurnContext:capture\(\) or nil end/);
  assert.match(initSource, /pcall\(dofile, 'turn-context\.lua'\)/);
  assert.match(initSource, /place = function\(\) return currentDistrict\(\) end/);
  assert.match(initSource, /companions\.conversationCandidates\(player, radius\)/);
  assert.match(initSource, /if convaiTurnContext then convaiTurnContext:reset\(reason\) end/);
  assert.match(initSource, /if convaiTurnContext then convaiTurnContext\.options\.log = log end/);
  assert.equal(microphoneSource.match(/context\.turnContext = M\.captureTurnContext and M\.captureTurnContext\(\)/g).length, 2);
  assert.doesNotMatch(phoneSource, /captureTurnContext|\.turnContext\b/);
  // The only readers are those turn paths.
  assert.equal((initSource.match(/convaiTurnContext:capture\(\)/g) || []).length, 2, 'the send path and the microphone wrapper');
});

test('the new files ship: the development install list, the release plan and the bridge layout', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /"source": "mod\/turn-context\.lua"/, file);
    assert.match(text, /CyberpunkConvai\/turn-context\.lua"/, file);
  }
  assert.match(readFileSync(new URL('../packaging/release-plan.json', import.meta.url), 'utf8'), /"bridge\/turn-context\.mjs"/);
  assert.match(readFileSync(new URL('../packaging/runtime-layout.mjs', import.meta.url), 'utf8'), /'bridge\/turn-context\.mjs'/);
});
