// A phone chat or a holocall with a character standing beside V (the party row says `near`): she is told V is texting or calling her while standing right next to her.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseTurnContext, describeTurnContext, MAX_CHARS} from './turn-context.mjs';
import {parseInput} from './protocol.mjs';
import {buildMessages, PersonaBook} from './mistral-prompt.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const luaSource = readFileSync(new URL('../mod/turn-context.lua', import.meta.url), 'utf8');
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scene = party => ({version: 1, status: 'ready', hour: 10, minute: 27, district: 'Watson', area: 'LittleChina', gender: 'male', lifepath: 'corpo', vehicle: false, motion: 'still', heat: 2, money: 'rich', party});
const input = (extra = {}, party = [{key: 'panam-palmer', name: 'Panam Palmer', activity: 'standing', near: true}]) => ({...parseInput(JSON.stringify({requestId: '100-1-11ULL', generation: 1, entity: '11ULL',
  profileKey: 'panam-palmer', name: 'Panam Palmer', bodyType: 'WomanAverage', text: 'hey', turnContext: scene(party)})), ...extra});
const block = (extra, party, options = {split: true}) => describeTurnContext(input(extra, party), options).text;

test('the parser keeps `near` only when it is true', () => {
  const parsed = parseTurnContext(scene([{key: 'panam-palmer', name: 'Panam', near: true}, {key: 'judy-alvarez', name: 'Judy', near: 'yes'}, {key: 'river-ward', name: 'River', near: false}]));
  assert.deepEqual(parsed.party, [{key: 'panam-palmer', name: 'Panam', near: true}, {key: 'judy-alvarez', name: 'Judy'}, {key: 'river-ward', name: 'River'}]);
});

test('a phone chat with a character beside V says so, in the in-person form: no "somewhere else", no cannot-see, V\'s condition known', () => {
  const text = block({channel: 'phone'});
  assert.match(text, /^Right now \(from the game, this turn only\): You are with V in person, right next to V, even though V is texting you on the phone instead of talking out loud\./);
  assert.match(text, /never ask V to come over or come here, never say you miss V or talk as if V were far away/);
  assert.doesNotMatch(text, /somewhere else|messaging V by text|not with V|cannot see V's surroundings/);
  assert.match(text, /The police are after V|V is rich/, 'she sees V, so V\'s condition counts as in person');
  assert.match(text, /Your usual workplace, home and hangouts are not here/);
  assert.ok(text.length <= 900 + 400, `${text.length} characters`);
  assert.ok(MAX_CHARS >= 900);
});

test('the same phone chat with her far away (or not listed as near) keeps the remote form', () => {
  for (const party of [[{key: 'panam-palmer', name: 'Panam Palmer', activity: 'standing'}], [], [{key: 'judy-alvarez', name: 'Judy', near: true}]]) {
    const text = block({channel: 'phone'}, party);
    assert.match(text, /You are messaging V by text on the phone, not talking to V in person\. You are somewhere else/);
    assert.match(text, /never say you are there, close or nearby/);
    assert.doesNotMatch(text, /right next to V/);
  }
});

test('a holocall or a voice call with a character beside V says so too; far away it stays a call', () => {
  for (const [mode, how] of [['audio', /voice call on the phone instead of just talking/], ['holo', /holocall on the phone instead of just talking/]]) {
    const near = block({holocall: {contact: 'panam-palmer', mode}});
    assert.match(near, /You are with V in person, right next to V, even though V has you on a/);
    assert.match(near, how);
    assert.doesNotMatch(near, /somewhere else|you are on a call, not with V/);
    const far = block({holocall: {contact: 'panam-palmer', mode}}, [{key: 'panam-palmer', name: 'Panam Palmer'}]);
    assert.match(far, /you are not with V in person|not talking to V in person/);
    assert.match(far, /you are on a call, not with V/);
  }
});

test('an ordinary in-person turn and an ambient stranger are unchanged by the flag', () => {
  assert.doesNotMatch(block({}), /right next to V|texting/);
  assert.match(block({}), /^Right now \(from the game, this turn only\): You are with V in person\./);
  const stranger = describeTurnContext(input({channel: 'phone', profileKey: 'resident-male'}), {ambient: true, split: true}).text;
  assert.doesNotMatch(stranger, /right next to V/);
});

test('the first sentence is what is said again right before V\'s words, and it does not tell her she is somewhere else', () => {
  const now = block({channel: 'phone'});
  const persona = new PersonaBook([{key: 'panam-palmer', name: 'Panam Palmer', backstory: 'A nomad.', speakingStyleDescription: 'Blunt.', speakingStyleSampleDialogues: ''}]).persona('panam-palmer');
  const messages = buildMessages({persona, contextParts: {now, notes: '', world: '', volatile: ''}, text: 'hey'});
  const last = messages.at(-1).content;
  assert.match(last, /YOU, RIGHT NOW: You are with V in person, right next to V, even though V is texting you on the phone instead of talking out loud\. That is all you are doing; never claim to be anywhere else\./);
  assert.doesNotMatch(last, /cannot see V/);
});

test('the Dynamic info company switch drops the party, and the flag with it', async () => {
  const {stripSnapshot} = await import('./dynamic-info.mjs');
  const stripped = stripSnapshot(parseTurnContext(scene([{key: 'panam-palmer', name: 'Panam', near: true}])), new Set(['company']));
  assert.equal(stripped.party, undefined);
});

// ---- the game side ------------------------------------------------------------------------------------------------------------------------------
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    assert.equal(status, lua.LUA_OK, error);
  } finally { lua.lua_close(vm); }
}

test('the party row is near within 10 m of V (the distance the companion list carries), and a row without a distance is with V by how it was found', () => {
  runLua(`
local api = (function() ${luaSource} end)()
assert(api.NEAR_RADIUS == 10 and api.PARTY_RADIUS == 15)
local player = {}
local N = {player = function() return player end, ready = function() return true end, clock = function() return 2, 10, 'native' end, gender = function() return 'Female' end,
  voice = function() return 'Female' end, lifepath = function() return 'streetkid' end, vehicle = function() return false end, driving = function() return false end,
  weather = function() return nil end, health = function() return nil end, heat = function() return nil end, money = function() return nil end, interior = function() return nil end}
local rows = {{profileKey = 'panam-palmer', name = 'Panam', distance = 3.2}, {profileKey = 'judy-alvarez', name = 'Judy', distance = 12.5}, {profileKey = 'river-ward', name = 'River', distance = 10},
  {profileKey = 'kerry-eurodyne', name = 'Kerry'}}
local instance = api.new({native = N, now = function() return 100 end, place = function() return {district = 'Watson', area = 'Kabuki'} end,
  party = function() return rows end, activity = function() return {rows = {}} end, enabled = function() return true end})
local snap = instance:capture()
local byKey = {}
for _, row in ipairs(snap.party) do byKey[row.key] = row end
assert(byKey['panam-palmer'].near == true, 'panam at 3.2 m')
assert(byKey['judy-alvarez'].near == nil, 'judy at 12.5 m is listed but not near')
assert(byKey['river-ward'].near == true, 'river at exactly 10 m')
assert(byKey['kerry-eurodyne'].near == true, 'a row with no distance')
`);
});

test('the game wires it: phone chat and a holocall line add a character found by the spawned-characters query, on a copy, never per frame', () => {
  assert.match(initSource, /function convaiNearbyTurn\(snapshot, profileKey\)/);
  assert.match(initSource, /pcall\(convaiSpawnedPeople\.nearby, player, 10, \{\}\)/);
  assert.match(initSource, /phoneChat\.captureTurnContext = function\(profileKey\)\n\s+local snapshot = microphone\.captureTurnContext\(profileKey\)\n\s+local ok, nearby = pcall\(convaiNearbyTurn, snapshot, profileKey\)/);
  assert.match(initSource, /if context\.holocall and context\.turnContext and convaiNearbyTurn then\n\s+local ok, nearby = pcall\(convaiNearbyTurn, context\.turnContext, context\.profileKey\)/);
  const body = initSource.slice(initSource.indexOf('function convaiNearbyTurn'), initSource.indexOf('-- A phone chat reads it once per message too'));
  assert.match(body, /manager\.dynamicInfo\('company'\)/, 'nothing is read while the company switch is off');
  assert.match(body, /local copy, party = \{\}, \{\}/, 'the cached snapshot is copied, not changed');
  assert.doesNotMatch(body, /onUpdate|registerForEvent|Cron|Observe\(/, 'no per-frame hook');
});
