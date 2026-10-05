// Relationship profile routing, end to end through the real selection module,
// PlayerKnowledge (private/group/phone/microphone/automatic comment routes) and
// the Lua native capture. Only stubs: the player-memory route (no provider calls)
// and the clock. No test writes quest state or contacts Convai.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {RelationshipRouting, retireRelationshipConnections, relationshipRegistry, parseRelationshipState, selectRelationshipProfile,
  relationshipContext, RELATIONSHIP_FACTS, RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PlayerPhoneKnowledge} from './player-phone-knowledge.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {PartyConnections} from './party-connections.mjs';
import {parseWorldSnapshot, resolveKnowledge} from './world-knowledge.mjs';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
const world = {worldToken: 'world-a', generation: 7};
const PROFILES = Object.keys(RELATIONSHIP_PROFILES);
const FACTS = {
  'judy-alvarez': {sq030_11_romance: 1, sq030_judy_lover: 1, sq030_romance: 1},
  'panam-palmer': {sq027_panzer_sex: 1, sq027_panam_lover: 1},
  'river-ward': {sq029_river_lover: 1, sq029_done: 1},
  'kerry-eurodyne': {sq028_kerry_relationship: 1},
  'meredith-stout': {q003_stout_sex_done: 1},
};
const ALL_FACTS = Object.assign({}, ...Object.values(FACTS));
const ordinaryIds = Object.fromEntries([...PROFILES, 'rogue-amendiares'].map(key => [key, key + '-ord']));
const variants = {version: 1, characters: Object.fromEntries(PROFILES.map(key => [key,
  {ordinaryCharacterId: ordinaryIds[key], romanticCharacterId: key + '-rom'}]))};
const idFor = (key, romantic) => key + (romantic ? '-rom' : '-ord');
const known = value => ({status: 'known', value, present: true, sourceId: 'native-quests-system',
  evidenceRefs: ['native.rule']});
const state = (facts, extra = {}) => ({version: 1, status: 'ready', gameVersion: '2.31', ...world,
  capturedAt: NOW, facts: Object.fromEntries(Object.entries(facts).map(([name, value]) =>
    [name, value === 'unknown' ? {status: 'unknown'} : known(value)])), ...extra});
const clone = value => structuredClone(value);

// ---------------------------------------------------------------------------
// Auto / On / Off decision matrix for every supported character.

const STATES = {
  confirmed: profile => state(FACTS[profile]),
  absent: () => state({}),
  explicitUnknown: profile => state(Object.fromEntries(Object.keys(ALL_FACTS).map(name => [name, 'unknown']))),
  // Someone else's receipts never decide this character.
  otherCharacters: profile => state(Object.fromEntries(Object.entries(ALL_FACTS)
    .filter(([name]) => !Object.keys(FACTS[profile]).includes(name)))),
};
const UNAVAILABLE_STATES = {
  none: () => null,
  stale: profile => state(FACTS[profile], {capturedAt: NOW - 5001}),
  future: profile => state(FACTS[profile], {capturedAt: NOW + 1001}),
  otherWorld: profile => state(FACTS[profile], {worldToken: 'world-b'}),
  otherGeneration: profile => state(FACTS[profile], {generation: 6}),
};
const registry = relationshipRegistry(ordinaryIds, variants);
const select = (profileKey, mode, snapshot, extra = {}) => selectRelationshipProfile({profileKey, mode,
  registry, boundary: world, now: NOW, snapshot, ...extra});

test('Auto follows only this character\'s confirmed native receipts and resolves to the exact provider IDs', () => {
  for (const profile of PROFILES) {
    const confirmed = select(profile, 'auto', STATES.confirmed(profile));
    assert.equal(confirmed.status, 'ready', profile);
    assert.equal(confirmed.variant, 'romantic', profile);
    assert.equal(confirmed.characterId, idFor(profile, true));
    assert.equal(confirmed.providerProfileKey, profile + '-romantic');
    assert.equal(confirmed.profileKey, profile);
    assert.equal(confirmed.saveRelationship?.status, 'confirmed');
    for (const name of ['absent', 'explicitUnknown', 'otherCharacters']) {
      const result = select(profile, 'auto', STATES[name](profile));
      assert.equal(result.status, 'ready', profile + ' ' + name);
      assert.equal(result.variant, 'ordinary', profile + ' ' + name);
      assert.equal(result.characterId, idFor(profile, false));
      assert.equal(result.providerProfileKey, profile);
      assert.equal(result.reason, 'auto-unconfirmed');
      assert.equal(result.saveRelationship, undefined);
    }
  }
});

test('Auto refuses to guess without a fresh current-world capture', () => {
  for (const profile of PROFILES) {
    for (const [name, make] of Object.entries(UNAVAILABLE_STATES)) {
      const result = select(profile, 'auto', make(profile));
      assert.equal(result.status, 'unavailable', profile + ' ' + name);
      assert.equal(result.reason, 'relationship-state-unavailable');
      assert.equal(result.characterId, undefined);
    }
  }
});

test('On is always the alternate profile and Off always the ordinary one, whatever the save says', () => {
  const everything = [...Object.values(STATES).map(make => profile => make(profile)),
    ...Object.values(UNAVAILABLE_STATES)];
  for (const profile of PROFILES) {
    for (const make of everything) {
      const on = select(profile, 'on', make(profile)), off = select(profile, 'off', make(profile));
      assert.equal(on.status, 'ready'); assert.equal(off.status, 'ready');
      assert.equal(on.variant, 'romantic'); assert.equal(on.characterId, idFor(profile, true));
      assert.equal(on.reason, 'explicit-on');
      assert.equal(on.evidenceRule, undefined, 'On must not claim save evidence');
      assert.equal(off.variant, 'ordinary'); assert.equal(off.characterId, idFor(profile, false));
      assert.equal(off.reason, 'explicit-off');
    }
    // Delivery and history are independent: On with no receipt records none,
    // Off with a confirmed receipt keeps it.
    assert.equal(select(profile, 'on', STATES.absent(profile)).saveRelationship, undefined);
    assert.equal(select(profile, 'off', STATES.confirmed(profile)).saveRelationship?.status, 'confirmed');
    assert.equal(select(profile, 'on', STATES.confirmed(profile)).saveRelationship?.status, 'confirmed');
  }
});

test('every confirming and contradicting fact is honoured per character, including Judy and Kerry declines', () => {
  const rows = {
    'judy-alvarez': {conflicts: ['sq030_friendship']},
    'kerry-eurodyne': {conflicts: ['sq028_kerry_dislike']},
  };
  for (const profile of PROFILES) {
    for (const conflict of rows[profile]?.conflicts || []) {
      assert.equal(select(profile, 'auto', state({...FACTS[profile], [conflict]: 1})).variant, 'ordinary', conflict);
      // An unknown/absent conflict does not assert rejection.
      assert.equal(select(profile, 'auto', state({...FACTS[profile], [conflict]: 'unknown'})).variant, 'romantic');
    }
    for (const name of Object.keys(FACTS[profile])) {
      const partial = {...FACTS[profile]}; delete partial[name];
      if (Object.keys(FACTS[profile]).length > 1) assert.equal(select(profile, 'auto', state(partial)).variant, 'ordinary', name);
    }
  }
  assert.equal(RELATIONSHIP_FACTS.length, 11);
  assert.deepEqual([...RELATIONSHIP_FACTS].sort(), [...new Set([...Object.keys(ALL_FACTS),
    'sq030_friendship', 'sq028_kerry_dislike'])].sort());
});

// ---------------------------------------------------------------------------
// The Lua capture feeds this exact module: every allowlisted fact is read, only
// positive values are exported as known, and the published table survives a
// JSON round trip into the bridge parser.

const luaSource = readFileSync(new URL('../mod/relationship-state.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function capture(values, {version = '2.31', frame = {status: 'ready', worldToken: world.worldToken, generation: world.generation}} = {}) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const names = Object.keys(values).map(name => `[${JSON.stringify(name)}]=${values[name]}`).join(',');
  const code = `
local module=(function() ${luaSource} end)()
local function enc(v)
  local t=type(v)
  if t=='table' then
    if #v>0 then local p={} for i,x in ipairs(v) do p[i]=enc(x) end return '['..table.concat(p,',')..']' end
    local p={} for k,x in pairs(v) do p[#p+1]=string.format('%q',k)..':'..enc(x) end return '{'..table.concat(p,',')..'}'
  elseif t=='string' then return string.format('%q',v) else return tostring(v) end
end
local values={${names}}
local reads={}
local frame={status=${JSON.stringify(frame.status)},worldToken=${JSON.stringify(frame.worldToken)},generation=${frame.generation}}
local out
local collector=module.new({currentWorld=function()return frame end,clock=function() return ${NOW} end,
  readVersion=function() return ${JSON.stringify(version)} end,
  readFact=function(key)reads[#reads+1]=key return values[key] or 0 end,
  publish=function(v)out=enc(v)return true end})
collector:update(frame)
return out, table.concat(reads,',')`;
  try {
    const status = lauxlib.luaL_dostring(L, to_luastring(code));
    assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    return {json: to_jsstring(lua.lua_tostring(L, -2)), reads: to_jsstring(lua.lua_tostring(L, -1)).split(',')};
  } finally { lua.lua_close(L); }
}

test('Lua capture reads exactly the bridge allowlist and its output selects the right profile for each character', () => {
  const sample = capture({});
  assert.deepEqual([...sample.reads].sort(), [...RELATIONSHIP_FACTS].sort(),
    'Lua FACTS and RELATIONSHIP_FACTS must stay identical');
  for (const profile of PROFILES) {
    const confirmed = parseRelationshipState(capture(FACTS[profile]).json);
    assert(confirmed, profile + ' published state must parse');
    const selection = select(profile, 'auto', confirmed);
    assert.equal(selection.variant, 'romantic', profile);
    // Every other character stays ordinary on this save.
    for (const other of PROFILES.filter(key => key !== profile)) {
      assert.equal(select(other, 'auto', confirmed).variant, 'ordinary', other + ' vs ' + profile);
    }
    const empty = parseRelationshipState(capture({}).json);
    assert.equal(select(profile, 'auto', empty).variant, 'ordinary', profile + ' empty save');
    assert.equal(select(profile, 'auto', empty).status, 'ready');
  }
  // Kerry's relationship fact is additive (setExactValue 0 in the beach scene), so >1 still counts.
  assert.equal(select('kerry-eurodyne', 'auto', parseRelationshipState(capture({sq028_kerry_relationship: 2}).json)).variant, 'romantic');
  // Judy's three exact receipts must each be exactly 1.
  assert.equal(select('judy-alvarez', 'auto', parseRelationshipState(capture({...FACTS['judy-alvarez'], sq030_romance: 2}).json)).variant, 'ordinary');
  // A native facts read of the wrong game version publishes nothing usable.
  assert.equal(parseRelationshipState(capture(FACTS['judy-alvarez'], {version: '2.32'}).json), null);
});

// ---------------------------------------------------------------------------
// Routing through PlayerKnowledge: private, microphone, group, phone, comments.

const PACK = {version: 1, id: 'relationship-channel-pack', revision: 1, gameVersions: ['2.31'],
  profileKeys: [...PROFILES, 'rogue-amendiares'], sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []};

function harness({modes = {}, facts = ALL_FACTS, now = NOW} = {}) {
  let clock = now;
  const routes = new RelationshipRouting({ordinaryIds, variants, now: () => clock});
  const worldState = {ready: true, updatedAt: now};
  const boundary = () => worldState.ready ? {...world} : null;
  const epochs = {global: 0, characters: new Map()};
  const memoryCalls = [];
  const memory = {
    route(profileKey, request) {
      memoryCalls.push({profileKey, ...clone(request)});
      const characterId = routes.providerIds[profileKey];
      if (!characterId) throw Object.assign(Error('unknown'), {code: 'UNKNOWN_CHARACTER'});
      const guard = Object.freeze({endUserId: USER, characterId, resetEpoch: epochs.global,
        characterEpoch: epochs.characters.get(characterId) ?? 0});
      return Object.freeze({endUserId: USER, guard});
    },
    isCurrent: guard => guard?.endUserId === USER && guard.resetEpoch === epochs.global,
  };
  const router = new PlayerKnowledge({playerMemory: memory, pack: PACK, now: () => clock, getBoundary: boundary,
    isWorldCurrent: binding => binding.worldToken === world.worldToken && binding.generation === world.generation,
    selectProfile: (profile, binding) => routes.select(profile, binding)});
  const api = {routes, router, memoryCalls, memory, epochs,
    settings: {relationshipModes: {...modes}},
    snapshot: state(facts, {capturedAt: now}),
    tick(ms) { clock += ms; api.snapshot = {...api.snapshot, capturedAt: clock}; },
    commit(options = {}) { return routes.update(api.settings, api.snapshot, {boundary: boundary(), ...options}); },
    set(profile, mode) { api.settings = {relationshipModes: {...api.settings.relationshipModes, [profile]: mode}}; },
    setFacts(next) { api.snapshot = state(next, {capturedAt: clock}); }};
  api.commit();
  return api;
}

const input = (profileKey, extra = {}) => ({requestId: `req-${profileKey}-${Math.random().toString(16).slice(2)}`,
  generation: 7, entity: '13ULL', name: profileKey, profileKey, text: 'Hey.', ...extra});
const groupInput = (profileKey, audience, extra = {}) => input(profileKey, {group: {id: 'round-1',
  index: audience.indexOf(profileKey) + 1, total: audience.length, audience: [...audience], heard: []}, ...extra});
const bridgeContext = prepared => relationshipContext(prepared.relationship, prepared.route.channel,
  {group: prepared.input.group, audience: prepared.route.audience, worldToken: prepared.worldToken, generation: prepared.generation});

test('private chat, microphone and automatic comments use the selected provider ID for every character', async () => {
  for (const mode of ['auto', 'on', 'off']) {
    for (const confirmed of [true, false]) {
      for (const profile of PROFILES) {
        const h = harness({modes: {[profile]: mode}, facts: confirmed ? FACTS[profile] : {}});
        const romantic = mode === 'on' || (mode === 'auto' && confirmed);
        const turns = {
          private: await h.router.prepare(input(profile)),
          microphone: await h.router.prepare(input(profile, {source: 'microphone'}), {channel: 'microphone'}),
          comment: await h.router.prepare(input(profile, {reaction: {phase: 'combat', kind: 'battle'}})),
        };
        for (const [channel, prepared] of Object.entries(turns)) {
          const label = [profile, mode, confirmed, channel].join('/');
          assert.equal(prepared.sendAllowed, true, label);
          assert.equal(prepared.guard.characterId, idFor(profile, romantic), label);
          assert.equal(prepared.route.profileKey, profile, label);
          assert.equal(prepared.route.providerProfileKey, profile + (romantic ? '-romantic' : ''), label);
          assert.equal(prepared.relationship.variant, romantic ? 'romantic' : 'ordinary', label);
          assert.equal(prepared.route.channel, 'private');
          assert.equal(prepared.remoteConfig.endUserId, USER, label);
          assert.equal(await h.router.current(prepared), true);
        }
        assert.equal(h.memoryCalls.every(call => call.profileKey === profile + (romantic ? '-romantic' : '')), true);
        // Each provider ID gets its own conversation partition; the other never sees it.
        const other = harness({modes: {[profile]: romantic ? 'off' : 'on'}, facts: confirmed ? FACTS[profile] : {}});
        const alt = await other.router.prepare(input(profile));
        assert.notEqual(alt.sessionKey, turns.private.sessionKey);
        assert.notEqual(alt.scope, turns.private.scope);
      }
    }
  }
});

test('Auto without a fresh capture blocks sending instead of guessing, and recovers when evidence arrives', async () => {
  const h = harness({facts: FACTS['judy-alvarez']});
  h.tick(6000); // Lua stopped publishing; keep the settings poll running
  h.routes.update(h.settings, undefined, {boundary: world});
  const blocked = await h.router.prepare(input('judy-alvarez'));
  assert.equal(blocked.sendAllowed, false);
  assert.equal(h.router.configFor('judy-alvarez'), null);
  // Off and On never depend on the capture; characters without a profile pair are untouched.
  h.set('judy-alvarez', 'off'); h.commit();
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez', false));
  assert.equal((await h.router.prepare(input('rogue-amendiares'))).guard.characterId, 'rogue-amendiares-ord');
  h.set('judy-alvarez', 'auto'); h.setFacts(FACTS['judy-alvarez']); h.commit();
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez', true));
});

test('group chat gives every speaker their own provider ID and only their own confirmed receipt', async () => {
  const audience = ['judy-alvarez', 'panam-palmer', 'river-ward'];
  // Judy confirmed (Auto), Panam confirmed but forced Off, River unconfirmed but forced On.
  const h = harness({modes: {'panam-palmer': 'off', 'river-ward': 'on'},
    facts: {...FACTS['judy-alvarez'], ...FACTS['panam-palmer']}});
  const prepared = {};
  for (const profile of audience) prepared[profile] = await h.router.prepare(groupInput(profile, audience));
  assert.equal(prepared['judy-alvarez'].guard.characterId, idFor('judy-alvarez', true));
  assert.equal(prepared['panam-palmer'].guard.characterId, idFor('panam-palmer', false));
  assert.equal(prepared['river-ward'].guard.characterId, idFor('river-ward', true));
  for (const profile of audience) {
    assert.equal(prepared[profile].route.channel, 'group');
    assert.deepEqual(prepared[profile].route.audience, [...audience].sort());
    assert.match(prepared[profile].scope, /^group:/);
  }
  const text = Object.fromEntries(audience.map(profile => [profile, bridgeContext(prepared[profile])]));
  assert.match(text['judy-alvarez'], /Current group relationship guidance/);
  assert.match(text['judy-alvarez'], /dry little tease/);
  assert.match(text['panam-palmer'], /Current group relationship guidance/);
  assert.match(text['panam-palmer'], /Keep the selected ordinary delivery/);
  assert.doesNotMatch(text['river-ward'], /Current group relationship guidance/, 'On is not evidence');
  assert.match(text['river-ward'], /does not establish that any game quest/);
  for (const profile of audience) {
    for (const other of audience.filter(key => key !== profile)) {
      assert.doesNotMatch(text[profile], new RegExp(other.split('-')[0], 'i'), profile + ' prompt names ' + other);
    }
    assert.doesNotMatch(text[profile], /sq0\d\d|q003|panzer|Basilisk|Laguna/);
  }
  // A group that does not contain the speaker is rejected, never routed to the alternate profile.
  await assert.rejects(h.router.prepare(groupInput('judy-alvarez', ['panam-palmer', 'river-ward'])), /INVALID_ROUTE/);
  // Private chat afterwards carries no group guidance at all.
  const privateTurn = await h.router.prepare(input('judy-alvarez'));
  assert.doesNotMatch(bridgeContext(privateTurn), /group relationship guidance|Keep private/i);
  // The same speaker in a different audience is a different session, so no group leaks into another.
  const other = await h.router.prepare(groupInput('judy-alvarez', ['judy-alvarez', 'kerry-eurodyne']));
  assert.notEqual(other.sessionKey, prepared['judy-alvarez'].sessionKey);
  assert.equal(other.guard.characterId, prepared['judy-alvarez'].guard.characterId);
});

test('ordinary-delivery speakers never receive affectionate style or another speaker\'s relationship in a group', async () => {
  const audience = ['kerry-eurodyne', 'meredith-stout'];
  const h = harness({modes: {'kerry-eurodyne': 'off'}, facts: {...FACTS['kerry-eurodyne'], ...FACTS['meredith-stout']}});
  const kerry = await h.router.prepare(groupInput('kerry-eurodyne', audience));
  const meredith = await h.router.prepare(groupInput('meredith-stout', audience));
  assert.equal(kerry.guard.characterId, idFor('kerry-eurodyne', false));
  assert.equal(meredith.guard.characterId, idFor('meredith-stout', true));
  assert.doesNotMatch(bridgeContext(kerry), /irreverent wit|Meredith|casual intimate/);
  assert.match(bridgeContext(meredith), /without establishing a continuing romance/);
  assert.doesNotMatch(bridgeContext(meredith), /Kerry|committed commitment|acknowledging your own commitment/);
});

function phoneHarness(h) {
  const phoneKnowledge = new PlayerPhoneKnowledge({router: h.router, getBoundary: () => world, now: () => NOW});
  const replies = [];
  const chat = new PhoneChat({
    contacts: PROFILES.map(key => ({contact: key.split('-')[0], key})),
    ids: Object.fromEntries(PROFILES.map(key => [key, ordinaryIds[key]])), now: () => NOW,
    contextFor: options => phoneKnowledge.prepareContext(options),
    contextCurrent: context => phoneKnowledge.current(context),
    contextCurrentSync: context => phoneKnowledge.currentSync(context),
    reply: async options => { replies.push(options); return {text: 'ok', sessionID: 'session-' + replies.length}; },
    publish: async () => {}});
  return {chat, replies, phoneKnowledge};
}
const saveIdentity = {version: 1, status: 'unavailable', generation: 7};
const phoneState = (contact, id, text = 'Hello') => ({version: 2, world: 'world-1', updated: NOW, active: true, saveIdentity,
  request: {id, contact, text, saveIdentity}});

test('phone Chat resolves the selected provider ID before session lookup for every character and mode', async () => {
  for (const mode of ['auto', 'on', 'off']) {
    for (const confirmed of [true, false]) {
      const h = harness({modes: Object.fromEntries(PROFILES.map(key => [key, mode])), facts: confirmed ? ALL_FACTS : {}});
      const phone = phoneHarness(h);
      let n = 0;
      for (const profile of PROFILES) {
        const romantic = mode === 'on' || (mode === 'auto' && confirmed);
        await phone.chat.accept(phoneState(profile.split('-')[0], `world-1-${++n}`));
        await phone.chat.active?.work;
        const call = phone.replies.at(-1);
        assert.equal(call.characterId, idFor(profile, romantic), [profile, mode, confirmed].join('/'));
        assert.equal(call.profileKey, profile);
        assert.equal(call.endUserId, USER);
        assert.match(call.scope, /^phone:/);
      }
      assert.equal(new Set(phone.replies.map(call => call.sessionKey)).size, PROFILES.length);
    }
  }
});

test('phone Chat never receives group guidance and keeps the two provider IDs on separate sessions', async () => {
  const h = harness({facts: FACTS['judy-alvarez']});
  const phone = phoneHarness(h);
  await phone.chat.accept(phoneState('judy', 'world-1-1')); await phone.chat.active?.work;
  const romantic = phone.replies.at(-1);
  assert.equal(romantic.characterId, idFor('judy-alvarez', true));
  h.set('judy-alvarez', 'off'); h.commit();
  await phone.chat.accept(phoneState('judy', 'world-1-2')); await phone.chat.active?.work;
  const ordinary = phone.replies.at(-1);
  assert.equal(ordinary.characterId, idFor('judy-alvarez', false));
  assert.notEqual(ordinary.sessionKey, romantic.sessionKey);
  // The provider session stored for the romantic ID must not be resumed under the ordinary ID.
  assert.equal(ordinary.sessionId, '-1');
  h.set('judy-alvarez', 'auto'); h.commit();
  await phone.chat.accept(phoneState('judy', 'world-1-3')); await phone.chat.active?.work;
  const again = phone.replies.at(-1);
  assert.equal(again.characterId, idFor('judy-alvarez', true));
  assert.equal(again.sessionKey, romantic.sessionKey);
});

// ---------------------------------------------------------------------------
// Switching the setting while the game runs.

test('changing Auto/On/Off mid-session reroutes the next turn only, retires only that profile, and never touches an admitted turn', async () => {
  const h = harness({facts: ALL_FACTS});
  const admitted = await h.router.prepare(input('judy-alvarez'));
  assert.equal(admitted.guard.characterId, idFor('judy-alvarez', true));
  assert.deepEqual(h.routes.consumeRouteChanges(), []);

  // A turn is running: nothing commits, nothing is flagged, the old route stays valid.
  h.set('judy-alvarez', 'off');
  assert.equal(h.commit({busy: true}), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez', true));

  // Idle again: exactly Judy changes.
  assert.equal(h.commit(), true);
  assert.deepEqual(h.routes.consumeRouteChanges(), ['judy-alvarez']);
  assert.equal(await h.router.current(admitted), true, 'an admitted turn must survive the switch');
  const next = await h.router.prepare(input('judy-alvarez'));
  assert.equal(next.guard.characterId, idFor('judy-alvarez', false));
  assert.notEqual(next.sessionKey, admitted.sessionKey);
  assert.equal(next.remoteConfig.endUserId, admitted.remoteConfig.endUserId);
  assert.equal((await h.router.prepare(input('panam-palmer'))).guard.characterId, idFor('panam-palmer', true));

  // Off -> On flips the provider; On -> Auto with a confirmed save keeps it (no churn).
  h.set('judy-alvarez', 'on'); assert.equal(h.commit(), true);
  assert.deepEqual(h.routes.consumeRouteChanges(), ['judy-alvarez']);
  h.set('judy-alvarez', 'auto'); assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez', true));

  // Auto follows the save when the facts change (new save loaded in the same world number is impossible,
  // but evidence loss must not leave a stale romantic route).
  h.setFacts({}); h.tick(100); assert.equal(h.commit(), true);
  assert.deepEqual(h.routes.consumeRouteChanges().sort(), PROFILES.filter(key => key !== 'rogue-amendiares').sort());
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez', false));
});

test('a rejected or partial settings file leaves committed routing untouched', () => {
  const h = harness({modes: {'judy-alvarez': 'off'}, facts: FACTS['judy-alvarez']});
  assert.equal(h.routes.select('judy-alvarez', world).variant, 'ordinary');
  for (const bad of [{relationshipModes: {'judy-alvarez': 'maybe'}}, {relationshipModes: {nobody: 'on'}},
    {relationshipModes: ['on']}, {relationshipModes: 'on'}]) {
    assert.equal(h.routes.update(bad, h.snapshot, {boundary: world}), false);
    assert.equal(h.routes.select('judy-alvarez', world).variant, 'ordinary');
  }
  // A transient unreadable settings file (undefined) keeps the committed modes.
  h.routes.update(undefined, h.snapshot, {boundary: world});
  assert.equal(h.routes.select('judy-alvarez', world).variant, 'ordinary');
  // A settings file from before this feature existed means Auto for everyone.
  h.routes.update({}, h.snapshot, {boundary: world});
  assert.equal(h.routes.select('judy-alvarez', world).variant, 'romantic');
});

// ---------------------------------------------------------------------------
// Duplicate copies, reassignment and invitation preparation.

test('copies of one character share a selection, and a reassigned copy takes the new profile\'s selection', async () => {
  const h = harness({modes: {'panam-palmer': 'auto'}, facts: FACTS['judy-alvarez']});
  const first = await h.router.prepare(input('judy-alvarez', {entity: '13ULL'}));
  const second = await h.router.prepare(input('judy-alvarez', {entity: '14ULL'}));
  assert.equal(first.guard.characterId, second.guard.characterId);
  assert.equal(first.guard.characterId, idFor('judy-alvarez', true));
  // The Judy model reassigned to Panam asks as Panam: Judy's confirmed relationship does not carry over.
  const reassigned = await h.router.prepare(input('panam-palmer', {entity: '13ULL'}));
  assert.equal(reassigned.guard.characterId, idFor('panam-palmer', false));
  assert.equal(reassigned.relationship.saveRelationship, undefined);
  assert.doesNotMatch(bridgeContext(reassigned), /Judy|relationship with V/);
  // Reassigning back restores Judy's own selection.
  const back = await h.router.prepare(input('judy-alvarez', {entity: '13ULL'}));
  assert.equal(back.guard.characterId, idFor('judy-alvarez', true));
});

test('invitation preparation is bound to the captured provider ID and a setting change invalidates its route check', () => {
  const h = harness({facts: FACTS['judy-alvarez']});
  const facade = h.routes.invitationMemory({route: (key) => h.memory.route(key, {channel: 'private'}),
    prepareCharacter: () => {}, connectionRefreshRequired: () => false, acknowledgeConnectionRefresh: () => {},
    isCurrent: () => true}, () => world);
  const captured = facade.route('judy-alvarez', {channel: 'private'});
  assert.equal(captured.guard.characterId, idFor('judy-alvarez', true));
  assert.equal(h.routes.guardSelected('judy-alvarez', captured.guard, world), true);
  h.set('judy-alvarez', 'off'); h.commit();
  assert.equal(h.routes.guardSelected('judy-alvarez', captured.guard, world), false,
    'a stale pending invitation lane must not stay authorised after the switch');
  assert.equal(h.routes.guardSelected('panam-palmer', captured.guard, world), false);
  // Auto losing its capture also blocks, rather than falling back to a guess.
  const auto = harness({facts: FACTS['judy-alvarez']});
  const guard = auto.routes.select('judy-alvarez', world);
  auto.tick(9000);
  assert.equal(auto.routes.guardSelected('judy-alvarez', {characterId: guard.characterId}, world), false);
});

// ---------------------------------------------------------------------------
// The bridge wires exactly this data into prompts and memory.

test('the bridge sends the admitted turn\'s selected provider key and relationship prompt', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /relationshipContext\(prepared\.relationship, prepared\.route\.channel,\s*\{group: prepared\.input\.group, audience: prepared\.route\.audience,\s*worldToken: prepared\.worldToken, generation: prepared\.generation\}\)/);
  assert.equal([...source.matchAll(/profileKey: prepared\.route\.providerProfileKey \?\? prepared\.route\.profileKey/g)].length >= 3, true);
  assert.match(source, /selectProfile: \(profile, boundary\) => relationshipRoutes\.select\(profile, boundary\)/);
  assert.match(source, /characterId: routeFor\(input\)\?\.guard\?\.characterId/);
});

// The reviewed knowledge pack keeps each relationship statement private to the
// speaker's own private/phone conversation; group and automatic-comment
// audiences never receive it (group acknowledgement is the separate, own-receipt
// prompt above).
test('reviewed relationship statements reach private and phone chat but never a group audience', () => {
  const pack = JSON.parse(readFileSync(new URL('../characters/world-knowledge.json', import.meta.url), 'utf8'));
  const facts = Object.fromEntries(Object.entries(ALL_FACTS).map(([name, value]) => [name,
    {status: 'known', value, present: true, sourceId: 'native-quests-system',
      evidenceRefs: pack.factAllowlist[name].evidenceRefs}]));
  const context = (profileKey, channel, profileKeys) => {
    const snapshot = parseWorldSnapshot({version: 1, status: 'ready', gameVersion: '2.31', generation: 7,
      worldToken: world.worldToken, capturedAt: new Date(NOW).toISOString(), facts, journal: {}, activeQuestKeys: [],
      audience: {channel, profileKeys}});
    const result = resolveKnowledge({pack, snapshot: {...snapshot, identity: {status: 'unknown'}}, profileKey,
      query: 'Are we together? Tell me about us.', maxChars: 8000});
    assert.equal(result.diagnostics.status, 'ready', profileKey + ' ' + channel);
    return result.context;
  };
  for (const [profile, spec] of Object.entries(RELATIONSHIP_PROFILES)) {
    const rule = pack.rules.find(row => row.id === spec.rule);
    for (const channel of ['private', 'phone']) {
      assert.ok(context(profile, channel, [profile]).includes(rule.statement), profile + ' ' + channel + ' loses its own statement');
    }
    const audience = [profile, profile === 'judy-alvarez' ? 'panam-palmer' : 'judy-alvarez'];
    assert.ok(!context(profile, 'group', audience).includes(rule.statement), profile + ' statement leaked to a group');
  }
});

test('warmed party connections follow the selection: the old provider ID is retired, other characters keep theirs', async () => {
  const h = harness({facts: {...FACTS['judy-alvarez'], ...FACTS['panam-palmer']}});
  const retained = [];
  const connections = new PartyConnections({host: {retain: async configs => { retained.push(configs); }},
    isKnown: profile => !!h.router.configFor(profile, 'private', world),
    configFor: (profile, scope) => {
      const route = h.router.configFor(profile, scope, world);
      if (!route) throw Error('No current world for conversation warmup');
      return {key: 'provider-key', characterId: route.guard.characterId, scope: route.scope, ...route.remoteConfig};
    }, canWarm: () => false});
  connections.ingest({updated: Date.now(), profiles: ['judy-alvarez', 'panam-palmer']});
  await connections.reconcile();
  const ids = () => [...new Set(retained.at(-1).map(config => config.characterId))].sort();
  assert.deepEqual(ids(), [idFor('judy-alvarez', true), idFor('panam-palmer', true)].sort());
  h.set('judy-alvarez', 'off');
  assert.equal(h.commit(), true);
  const changed = h.routes.consumeRouteChanges();
  assert.deepEqual(changed, ['judy-alvarez']);
  await retireRelationshipConnections(connections, changed);
  assert.deepEqual(ids(), [idFor('judy-alvarez', false), idFor('panam-palmer', true)].sort());
  // Every retained page carries the one player ID and a scope tied to its own provider ID.
  assert(retained.at(-1).every(config => config.endUserId === USER));
  assert.equal(new Set(retained.at(-1).map(config => config.scope)).size, retained.at(-1).length);
});
