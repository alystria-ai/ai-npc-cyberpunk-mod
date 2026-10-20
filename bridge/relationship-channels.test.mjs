// Relationship profile routing, end to end through the real selection module,
// PlayerKnowledge (private/group/phone/microphone/automatic comment routes) and
// the Lua native capture. Only stubs: the player-memory route (no provider calls)
// and the clock. No test writes quest state or contacts Convai.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {RelationshipRouting, retireRelationshipConnections, relationshipRegistry, parseRelationshipState, selectRelationshipProfile,
  RELATIONSHIP_FACTS, RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {relationshipContext} from './romance-context.mjs';
import {wantsTwin} from './multilingual.mjs';
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
// One Convai profile per character: the ID never depends on the relationship style.
const idFor = key => ordinaryIds[key];
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
const registry = relationshipRegistry(ordinaryIds);
const select = (profileKey, mode, snapshot, extra = {}) => selectRelationshipProfile({profileKey, mode,
  registry, boundary: world, now: NOW, snapshot, ...extra});

test('Auto follows only this character\'s confirmed native receipts for the style; the provider ID is always the one profile', () => {
  for (const profile of PROFILES) {
    const confirmed = select(profile, 'auto', STATES.confirmed(profile));
    assert.equal(confirmed.status, 'ready', profile);
    assert.equal(confirmed.style, 'romantic', profile);
    assert.equal(confirmed.reason, 'verified-current-save', profile);
    assert.equal(confirmed.characterId, idFor(profile));
    assert.equal(confirmed.providerProfileKey, profile);
    assert.equal(confirmed.profileKey, profile);
    assert.equal(confirmed.saveRelationship?.status, 'confirmed');
    for (const name of ['absent', 'explicitUnknown', 'otherCharacters']) {
      const result = select(profile, 'auto', STATES[name](profile));
      assert.equal(result.status, 'ready', profile + ' ' + name);
      assert.equal(result.style, 'ordinary', profile + ' ' + name);
      assert.equal(result.characterId, idFor(profile));
      assert.equal(result.providerProfileKey, profile);
      assert.equal(result.reason, 'auto-unconfirmed');
      assert.equal(result.saveRelationship, undefined);
      assert.equal(result.evidenceRule, undefined);
    }
  }
});

test('Auto without a fresh current-world capture stays ordinary for the turn and never blocks the conversation', () => {
  for (const profile of PROFILES) {
    for (const [name, make] of Object.entries(UNAVAILABLE_STATES)) {
      const result = select(profile, 'auto', make(profile));
      assert.equal(result.status, 'ready', profile + ' ' + name);
      assert.equal(result.style, 'ordinary', profile + ' ' + name);
      assert.equal(result.reason, 'relationship-state-unavailable');
      assert.equal(result.characterId, idFor(profile));
      assert.equal(result.providerProfileKey, profile);
      // Stale or foreign evidence is never used, not even for the factual acknowledgement.
      assert.equal(result.saveRelationship, undefined, profile + ' ' + name);
      assert.equal(result.evidenceRule, undefined, profile + ' ' + name);
    }
  }
});

test('On is always the affectionate style and Off always the ordinary one, on the same profile, whatever the save says', () => {
  const everything = [...Object.values(STATES).map(make => profile => make(profile)),
    ...Object.values(UNAVAILABLE_STATES)];
  for (const profile of PROFILES) {
    for (const make of everything) {
      const on = select(profile, 'on', make(profile)), off = select(profile, 'off', make(profile));
      assert.equal(on.status, 'ready'); assert.equal(off.status, 'ready');
      assert.equal(on.style, 'romantic'); assert.equal(on.characterId, idFor(profile));
      assert.equal(on.providerProfileKey, profile); assert.equal(off.providerProfileKey, profile);
      assert.equal(on.reason, 'explicit-on');
      assert.equal(on.evidenceRule, undefined, 'On must not claim save evidence');
      assert.equal(off.style, 'ordinary'); assert.equal(off.characterId, idFor(profile));
      assert.equal(off.reason, 'explicit-off');
    }
    // Delivery and history are independent: On with no receipt records none,
    // Off with a confirmed receipt keeps it.
    assert.equal(select(profile, 'on', STATES.absent(profile)).saveRelationship, undefined);
    assert.equal(select(profile, 'off', STATES.confirmed(profile)).saveRelationship?.status, 'confirmed');
    assert.equal(select(profile, 'on', STATES.confirmed(profile)).saveRelationship?.status, 'confirmed');
    // The style never moves the provider: every Auto/On/Off outcome names the same character and memory profile.
    const outcomes = ['auto', 'on', 'off'].flatMap(mode => [STATES.confirmed(profile), STATES.absent(profile), null]
      .map(snapshot => select(profile, mode, snapshot)));
    assert.deepEqual([...new Set(outcomes.map(row => row.characterId + '|' + row.providerProfileKey))], [idFor(profile) + '|' + profile]);
    assert.deepEqual([...new Set(outcomes.map(row => row.style))].sort(), ['ordinary', 'romantic']);
  }
});

test('every confirming and contradicting fact is honoured per character, including Judy and Kerry declines', () => {
  const rows = {
    'judy-alvarez': {conflicts: ['sq030_friendship']},
    'kerry-eurodyne': {conflicts: ['sq028_kerry_dislike']},
  };
  for (const profile of PROFILES) {
    for (const conflict of rows[profile]?.conflicts || []) {
      assert.equal(select(profile, 'auto', state({...FACTS[profile], [conflict]: 1})).style, 'ordinary', conflict);
      // An unknown/absent conflict does not assert rejection.
      assert.equal(select(profile, 'auto', state({...FACTS[profile], [conflict]: 'unknown'})).style, 'romantic');
    }
    const decisive = RELATIONSHIP_PROFILES[profile].all || [RELATIONSHIP_PROFILES[profile].positive];
    for (const name of decisive) {
      const partial = {...FACTS[profile]}; delete partial[name];
      assert.equal(select(profile, 'auto', state(partial)).style, 'ordinary', name);
      assert.equal(select(profile, 'auto', state({...partial, [name]: 'unknown'})).style, 'ordinary', name);
    }
  }
  // Judy: the game treats V as her partner from the romance exit (sq030_judy_lover), which can precede
  // sq030_romance by however long V takes to pick up their clothes. Neither the early morning-choice flag
  // nor the late completion flag alone may select the affectionate style.
  assert.equal(select('judy-alvarez', 'auto', state({sq030_judy_lover: 1})).style, 'romantic');
  assert.equal(select('judy-alvarez', 'auto', state({sq030_11_romance: 1, sq030_judy_lover: 1})).style, 'romantic');
  assert.equal(select('judy-alvarez', 'auto', state({sq030_11_romance: 1})).style, 'ordinary');
  assert.equal(select('judy-alvarez', 'auto', state({sq030_romance: 1})).style, 'ordinary');
  assert.equal(select('judy-alvarez', 'auto', state({sq030_11_romance: 1, sq030_romance: 1})).style, 'ordinary');
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
    assert.equal(selection.style, 'romantic', profile);
    // Every other character stays ordinary on this save.
    for (const other of PROFILES.filter(key => key !== profile)) {
      assert.equal(select(other, 'auto', confirmed).style, 'ordinary', other + ' vs ' + profile);
    }
    const empty = parseRelationshipState(capture({}).json);
    assert.equal(select(profile, 'auto', empty).style, 'ordinary', profile + ' empty save');
    assert.equal(select(profile, 'auto', empty).status, 'ready');
  }
  // Kerry's relationship fact is additive (setExactValue 0 in the beach scene), so >1 still counts.
  assert.equal(select('kerry-eurodyne', 'auto', parseRelationshipState(capture({sq028_kerry_relationship: 2}).json)).style, 'romantic');
  // Judy's decisive receipt is exact (the hut writes 1); the late completion flag is only observed.
  assert.equal(select('judy-alvarez', 'auto', parseRelationshipState(capture({...FACTS['judy-alvarez'], sq030_judy_lover: 2}).json)).style, 'ordinary');
  assert.equal(select('judy-alvarez', 'auto', parseRelationshipState(capture({sq030_judy_lover: 1}).json)).style, 'romantic');
  // A native facts read of the wrong game version publishes nothing usable.
  assert.equal(parseRelationshipState(capture(FACTS['judy-alvarez'], {version: '2.32'}).json), null);
});

// ---------------------------------------------------------------------------
// Routing through PlayerKnowledge: private, microphone, group, phone, comments.

const PACK = {version: 1, id: 'relationship-channel-pack', revision: 1, gameVersions: ['2.31'],
  profileKeys: [...PROFILES, 'rogue-amendiares'], sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []};

function harness({modes = {}, facts = ALL_FACTS, now = NOW, twins} = {}) {
  let clock = now;
  const routes = new RelationshipRouting({ordinaryIds, multilingual: twins, now: () => clock});
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
    selectProfile: (profile, binding, turn) => routes.select(profile, binding, {multilingual: wantsTwin({text: turn?.text, reaction: !!turn?.reaction})})});
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

test('private chat, microphone and automatic comments use the one provider ID and carry the selected style for every character', async () => {
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
          assert.equal(prepared.guard.characterId, idFor(profile), label);
          assert.equal(prepared.route.profileKey, profile, label);
          assert.equal(prepared.route.providerProfileKey, profile, label);
          assert.equal(prepared.relationship.style, romantic ? 'romantic' : 'ordinary', label);
          assert.equal(prepared.route.relationshipStyle, romantic ? 'romantic' : 'ordinary', label);
          assert.equal(prepared.relationship.characterId, idFor(profile), label);
          assert.equal(prepared.route.channel, 'private');
          assert.equal(prepared.remoteConfig.endUserId, USER, label);
          assert.equal(await h.router.current(prepared), true);
        }
        assert.equal(h.memoryCalls.every(call => call.profileKey === profile), true);
        // The style is not another conversation: the opposite style continues the same partition and memory profile.
        const other = harness({modes: {[profile]: romantic ? 'off' : 'on'}, facts: confirmed ? FACTS[profile] : {}});
        const alt = await other.router.prepare(input(profile));
        assert.equal(alt.relationship.style, romantic ? 'ordinary' : 'romantic');
        assert.equal(alt.sessionKey, turns.private.sessionKey);
        assert.equal(alt.scope, turns.private.scope);
        assert.equal(alt.guard.characterId, turns.private.guard.characterId);
        assert.equal(other.memoryCalls.every(call => call.profileKey === profile), true);
      }
    }
  }
});

test('Auto without a fresh capture keeps sending in the ordinary style, and follows the save once evidence arrives', async () => {
  const h = harness({facts: FACTS['judy-alvarez']});
  const confirmed = await h.router.prepare(input('judy-alvarez'));
  assert.equal(confirmed.relationship.style, 'romantic');
  h.tick(6000); // Lua stopped publishing; keep the settings poll running
  h.routes.update(h.settings, undefined, {boundary: world});
  const unconfirmed = await h.router.prepare(input('judy-alvarez'));
  assert.equal(unconfirmed.sendAllowed, true, 'a missing capture must not block the conversation');
  assert.equal(unconfirmed.relationship.style, 'ordinary');
  assert.equal(unconfirmed.relationship.reason, 'relationship-state-unavailable');
  assert.equal(unconfirmed.relationship.saveRelationship, undefined);
  assert.notEqual(h.router.configFor('judy-alvarez'), null);
  // Same conversation, only the delivery differs: no relationship note about a save we cannot currently see.
  assert.equal(unconfirmed.sessionKey, confirmed.sessionKey);
  assert.equal(unconfirmed.guard.characterId, confirmed.guard.characterId);
  assert.doesNotMatch(bridgeContext(unconfirmed), /current save does confirm|you and V are together/);
  // Off and On never depend on the capture; characters without a relationship rule are untouched.
  h.set('judy-alvarez', 'off'); h.commit();
  assert.equal((await h.router.prepare(input('judy-alvarez'))).guard.characterId, idFor('judy-alvarez'));
  assert.equal((await h.router.prepare(input('judy-alvarez'))).relationship.style, 'ordinary');
  h.set('judy-alvarez', 'on'); h.commit();
  assert.equal((await h.router.prepare(input('judy-alvarez'))).relationship.style, 'romantic');
  assert.equal((await h.router.prepare(input('rogue-amendiares'))).guard.characterId, 'rogue-amendiares-ord');
  assert.equal((await h.router.prepare(input('rogue-amendiares'))).relationship.style, 'ordinary');
  assert.equal(bridgeContext(await h.router.prepare(input('rogue-amendiares'))), '', 'no relationship block without a rule');
  h.set('judy-alvarez', 'auto'); h.setFacts(FACTS['judy-alvarez']); h.commit();
  const recovered = await h.router.prepare(input('judy-alvarez'));
  assert.equal(recovered.guard.characterId, idFor('judy-alvarez'));
  assert.equal(recovered.relationship.style, 'romantic');
  assert.equal(recovered.sessionKey, confirmed.sessionKey);
});

test('group chat gives every speaker their own profile and style and only their own confirmed receipt', async () => {
  const audience = ['judy-alvarez', 'panam-palmer', 'river-ward'];
  // Judy confirmed (Auto), Panam confirmed but forced Off, River unconfirmed but forced On.
  const h = harness({modes: {'panam-palmer': 'off', 'river-ward': 'on'},
    facts: {...FACTS['judy-alvarez'], ...FACTS['panam-palmer']}});
  const prepared = {};
  for (const profile of audience) prepared[profile] = await h.router.prepare(groupInput(profile, audience));
  for (const profile of audience) assert.equal(prepared[profile].guard.characterId, idFor(profile), profile);
  assert.deepEqual(audience.map(profile => prepared[profile].relationship.style), ['romantic', 'ordinary', 'romantic']);
  for (const profile of audience) {
    assert.equal(prepared[profile].route.channel, 'group');
    assert.deepEqual(prepared[profile].route.audience, [...audience].sort());
    assert.match(prepared[profile].scope, /^group:/);
  }
  const text = Object.fromEntries(audience.map(profile => [profile, bridgeContext(prepared[profile])]));
  assert.match(text['judy-alvarez'], /Current group relationship guidance/);
  assert.match(text['judy-alvarez'], /dry little tease/);
  assert.match(text['panam-palmer'], /Current group relationship guidance/);
  assert.match(text['panam-palmer'], /Keep your ordinary delivery/);
  assert.doesNotMatch(text['panam-palmer'], /direct, playful warmth/, 'Off never gets the affectionate group cue');
  assert.doesNotMatch(text['river-ward'], /Current group relationship guidance/, 'On is not evidence');
  assert.match(text['river-ward'], /does not establish that any quest, kiss or intimate scene happened/);
  for (const profile of audience) {
    for (const other of audience.filter(key => key !== profile)) {
      assert.doesNotMatch(text[profile], new RegExp(other.split('-')[0], 'i'), profile + ' prompt names ' + other);
    }
    assert.doesNotMatch(text[profile], /sq0\d\d|q003|panzer|Basilisk|Laguna/);
  }
  // A group that does not contain the speaker is rejected, never routed anywhere.
  await assert.rejects(h.router.prepare(groupInput('judy-alvarez', ['panam-palmer', 'river-ward'])), /INVALID_ROUTE/);
  // Private chat afterwards carries no group guidance at all.
  const privateTurn = await h.router.prepare(input('judy-alvarez'));
  assert.doesNotMatch(bridgeContext(privateTurn), /group relationship guidance|Keep private/i);
  // The same speaker in a different audience is a different session, so no group leaks into another.
  const other = await h.router.prepare(groupInput('judy-alvarez', ['judy-alvarez', 'kerry-eurodyne']));
  assert.notEqual(other.sessionKey, prepared['judy-alvarez'].sessionKey);
  assert.equal(other.guard.characterId, prepared['judy-alvarez'].guard.characterId);
  // Style, not audience, is the only thing that differs per speaker: every speaker keeps their own provider ID.
  assert.equal(new Set(audience.map(profile => prepared[profile].guard.characterId)).size, audience.length);
});

test('ordinary-delivery speakers never receive affectionate style or another speaker\'s relationship in a group', async () => {
  const audience = ['kerry-eurodyne', 'meredith-stout'];
  const h = harness({modes: {'kerry-eurodyne': 'off'}, facts: {...FACTS['kerry-eurodyne'], ...FACTS['meredith-stout']}});
  const kerry = await h.router.prepare(groupInput('kerry-eurodyne', audience));
  const meredith = await h.router.prepare(groupInput('meredith-stout', audience));
  assert.equal(kerry.guard.characterId, idFor('kerry-eurodyne'));
  assert.equal(meredith.guard.characterId, idFor('meredith-stout'));
  assert.equal(kerry.relationship.style, 'ordinary'); assert.equal(meredith.relationship.style, 'romantic');
  assert.match(bridgeContext(kerry), /Keep your ordinary delivery/);
  assert.match(bridgeContext(kerry), /acknowledge it plainly/, 'a confirmed save still gets a factual acknowledgement');
  assert.doesNotMatch(bridgeContext(kerry), /irreverent wit|vain little teases|Let your affection for V|Meredith|casual intimate/);
  assert.match(bridgeContext(meredith), /without establishing a continuing romance/);
  assert.match(bridgeContext(meredith), /Never claim that you are V.s partner/);
  assert.doesNotMatch(bridgeContext(meredith), /Kerry|you and V are together|acknowledging your own commitment/);
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
        assert.equal(call.characterId, idFor(profile), [profile, mode, confirmed].join('/'));
        assert.equal(call.profileKey, profile);
        assert.equal(call.endUserId, USER);
        assert.match(call.scope, /^phone:/);
      }
      assert.equal(new Set(phone.replies.map(call => call.sessionKey)).size, PROFILES.length);
    }
  }
});

test('phone Chat keeps the same provider ID and conversation session across a style change', async () => {
  const h = harness({facts: FACTS['judy-alvarez']});
  const phone = phoneHarness(h);
  await phone.chat.accept(phoneState('judy', 'world-1-1')); await phone.chat.active?.work;
  const romantic = phone.replies.at(-1);
  assert.equal(romantic.characterId, idFor('judy-alvarez'));
  assert.equal(romantic.sessionId, '-1', 'the first turn starts a new provider session');
  h.set('judy-alvarez', 'off'); h.commit();
  await phone.chat.accept(phoneState('judy', 'world-1-2')); await phone.chat.active?.work;
  const ordinary = phone.replies.at(-1);
  assert.equal(ordinary.characterId, romantic.characterId);
  assert.equal(ordinary.profileKey, romantic.profileKey);
  assert.equal(ordinary.sessionKey, romantic.sessionKey);
  assert.equal(ordinary.scope, romantic.scope);
  // The provider session (and with it Convai's long-term memory of V) continues across the style change.
  assert.equal(ordinary.sessionId, 'session-1');
  h.set('judy-alvarez', 'auto'); h.commit();
  await phone.chat.accept(phoneState('judy', 'world-1-3')); await phone.chat.active?.work;
  const again = phone.replies.at(-1);
  assert.equal(again.characterId, romantic.characterId);
  assert.equal(again.sessionKey, romantic.sessionKey);
  assert.equal(again.sessionId, 'session-2');
  for (const call of phone.replies) assert.match(call.scope, /^phone:/);
});

// ---------------------------------------------------------------------------
// Switching the setting while the game runs.

test('changing Auto/On/Off mid-session changes only the next turn\u2019s style: same provider, session and memory, nothing to retire', async () => {
  const h = harness({facts: ALL_FACTS});
  const admitted = await h.router.prepare(input('judy-alvarez'));
  assert.equal(admitted.guard.characterId, idFor('judy-alvarez'));
  assert.equal(admitted.relationship.style, 'romantic');
  assert.deepEqual(h.routes.consumeRouteChanges(), []);

  // A turn is running: nothing commits, the old style stays in force.
  h.set('judy-alvarez', 'off');
  assert.equal(h.commit({busy: true}), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  assert.equal((await h.router.prepare(input('judy-alvarez'))).relationship.style, 'romantic');

  // Idle again: the style flips, but the provider does not, so nothing is flagged for retirement.
  assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  assert.equal(await h.router.current(admitted), true, 'an admitted turn must survive the switch');
  assert.equal(admitted.relationship.style, 'romantic', 'an admitted turn keeps its frozen style');
  const next = await h.router.prepare(input('judy-alvarez'));
  assert.equal(next.relationship.style, 'ordinary');
  assert.equal(next.guard.characterId, admitted.guard.characterId);
  assert.equal(next.route.providerProfileKey, admitted.route.providerProfileKey);
  assert.equal(next.sessionKey, admitted.sessionKey, 'the same Convai session continues');
  assert.equal(next.scope, admitted.scope);
  assert.equal(next.remoteConfig.endUserId, admitted.remoteConfig.endUserId);
  const other = await h.router.prepare(input('panam-palmer'));
  assert.equal(other.guard.characterId, idFor('panam-palmer'));
  assert.equal(other.relationship.style, 'romantic', 'only the changed character\u2019s style moves');
  // Every memory lookup used the one profile key, before and after the change.
  assert.deepEqual([...new Set(h.memoryCalls.filter(call => call.profileKey.startsWith('judy')).map(call => call.profileKey))], ['judy-alvarez']);

  // Off -> On and On -> Auto with a confirmed save are style changes too: no churn.
  h.set('judy-alvarez', 'on'); assert.equal(h.commit(), false);
  assert.equal((await h.router.prepare(input('judy-alvarez'))).relationship.style, 'romantic');
  h.set('judy-alvarez', 'auto'); assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  assert.equal((await h.router.prepare(input('judy-alvarez'))).relationship.style, 'romantic');

  // Auto follows the save when the facts change: evidence loss returns every relationship character to the ordinary
  // style on the same profile, still without any retirement.
  h.setFacts({}); h.tick(100); assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  const after = await h.router.prepare(input('judy-alvarez'));
  assert.equal(after.relationship.style, 'ordinary');
  assert.equal(after.guard.characterId, admitted.guard.characterId);
  assert.equal(after.sessionKey, admitted.sessionKey);
});

test('a rejected or partial settings file leaves committed routing untouched', () => {
  const h = harness({modes: {'judy-alvarez': 'off'}, facts: FACTS['judy-alvarez']});
  assert.equal(h.routes.select('judy-alvarez', world).style, 'ordinary');
  for (const bad of [{relationshipModes: {'judy-alvarez': 'maybe'}}, {relationshipModes: {nobody: 'on'}},
    {relationshipModes: ['on']}, {relationshipModes: 'on'}]) {
    assert.equal(h.routes.update(bad, h.snapshot, {boundary: world}), false);
    assert.equal(h.routes.select('judy-alvarez', world).style, 'ordinary');
  }
  // A transient unreadable settings file (undefined) keeps the committed modes.
  h.routes.update(undefined, h.snapshot, {boundary: world});
  assert.equal(h.routes.select('judy-alvarez', world).style, 'ordinary');
  // A settings file from before this feature existed means Auto for everyone.
  h.routes.update({}, h.snapshot, {boundary: world});
  assert.equal(h.routes.select('judy-alvarez', world).style, 'romantic');
});

// ---------------------------------------------------------------------------
// Duplicate copies, reassignment and invitation preparation.

test('copies of one character share a selection, and a reassigned copy takes the new profile\'s selection', async () => {
  const h = harness({modes: {'panam-palmer': 'auto'}, facts: FACTS['judy-alvarez']});
  const first = await h.router.prepare(input('judy-alvarez', {entity: '13ULL'}));
  const second = await h.router.prepare(input('judy-alvarez', {entity: '14ULL'}));
  assert.equal(first.guard.characterId, second.guard.characterId);
  assert.equal(first.guard.characterId, idFor('judy-alvarez'));
  // The Judy model reassigned to Panam asks as Panam: Judy's confirmed relationship does not carry over.
  const reassigned = await h.router.prepare(input('panam-palmer', {entity: '13ULL'}));
  assert.equal(reassigned.guard.characterId, idFor('panam-palmer'));
  assert.equal(reassigned.relationship.saveRelationship, undefined);
  assert.doesNotMatch(bridgeContext(reassigned), /Judy|relationship with V/);
  // Reassigning back restores Judy's own selection.
  const back = await h.router.prepare(input('judy-alvarez', {entity: '13ULL'}));
  assert.equal(back.guard.characterId, idFor('judy-alvarez'));
});

test('invitation preparation is bound to the captured provider ID: a style change keeps it authorised, a provider change does not', async () => {
  const memoryStub = h => ({route: key => h.memory.route(key, {channel: 'private'}),
    prepareCharacter: () => {}, connectionRefreshRequired: () => false, acknowledgeConnectionRefresh: () => {}, isCurrent: () => true});
  const h = harness({facts: FACTS['judy-alvarez']});
  const facade = h.routes.invitationMemory(memoryStub(h), () => world);
  const captured = facade.route('judy-alvarez', {channel: 'private'});
  assert.equal(captured.guard.characterId, idFor('judy-alvarez'));
  assert.equal(h.routes.guardSelected('judy-alvarez', captured.guard, world), true);
  h.set('judy-alvarez', 'off'); h.commit();
  assert.equal(h.routes.guardSelected('judy-alvarez', captured.guard, world), true,
    'a pending invitation lane keeps its provider ID when only the style changes');
  assert.equal(h.routes.guardSelected('panam-palmer', captured.guard, world), false);
  // Auto losing its capture is a style fallback only: the invitation keeps its provider ID rather than being dropped.
  const auto = harness({facts: FACTS['judy-alvarez']});
  const guard = auto.routes.select('judy-alvarez', world);
  auto.tick(9000);
  assert.equal(auto.routes.guardSelected('judy-alvarez', {characterId: guard.characterId}, world), true);
  // The twin is chosen per turn from the message, so a lane taken on the original stays authorised when a French turn goes to the twin, and a
  // lane taken on the twin is authorised too; another character's ID never is.
  const ml = harness({facts: FACTS['judy-alvarez'], twins: {'judy-alvarez': 'judy-ml-id'}});
  const lane = ml.routes.invitationMemory(memoryStub(ml), () => world).route('judy-alvarez', {channel: 'private'});
  assert.equal(lane.guard.characterId, idFor('judy-alvarez'));
  assert.equal(ml.commit(), false);
  assert.equal(ml.routes.guardSelected('judy-alvarez', lane.guard, world), true);
  assert.equal(ml.routes.guardSelected('judy-alvarez', {characterId: 'judy-ml-id'}, world), true);
  assert.equal(ml.routes.guardSelected('judy-alvarez', {characterId: idFor('panam-palmer')}, world), false);
});

// ---------------------------------------------------------------------------
// The bridge wires exactly this data into prompts and memory.

test('the bridge sends the admitted turn\'s selected provider key and relationship prompt', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /relationshipContext\(prepared\.relationship, prepared\.route\.channel,\s*\{group: prepared\.input\.group, audience: prepared\.route\.audience,\s*worldToken: prepared\.worldToken, generation: prepared\.generation\}\)/);
  assert.equal([...source.matchAll(/profileKey: prepared\.route\.providerProfileKey \?\? prepared\.route\.profileKey/g)].length >= 3, true);
  assert.match(source, /selectProfile: \(profile, boundary, turn\) => relationshipRoutes\.select\(profile, boundary, \{multilingual: twinForTurn\(turn\)\}\)/);
  assert.match(source, /characterId: routeFor\(input\)\?\.guard\?\.characterId/);
  // One profile per character: nothing reads the retired alternate-profile file, and memory ignores retired provider rows.
  assert.match(source, /retired: providerKey => RETIRED_PROVIDER_KEY\.test\(providerKey\)/);
  assert.match(source, /import \{relationshipContext\} from '\.\/romance-context\.mjs'/);
  assert.doesNotMatch(source, /relationshipVariant|relationship-profiles\.json'/);
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

test('warmed party connections keep their ID across a style change; a French turn prepares the twin on its own scope and retires nothing', async () => {
  const h = harness({facts: {...FACTS['judy-alvarez'], ...FACTS['panam-palmer']}, twins: {'judy-alvarez': 'judy-ml-id'}});
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
  const scopes = () => retained.at(-1).map(config => config.scope).sort();
  assert.deepEqual(ids(), [idFor('judy-alvarez'), idFor('panam-palmer')].sort());
  const warmScopes = scopes();
  // A style change needs no retirement: the warmed page is the very page the next turn will use.
  h.set('judy-alvarez', 'off');
  assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  const turn = await h.router.prepare(input('judy-alvarez'));
  assert.equal(turn.relationship.style, 'ordinary');
  assert.equal(warmScopes.includes(turn.scope), true, 'the warmed page serves the changed-style turn');
  assert.deepEqual(scopes(), warmScopes);
  // The message's language picks the character per turn: a French turn is prepared on the twin and its own scope, an English one on the
  // original, and the warmed pages are neither retired nor replaced (a saved multilingualConversations from an old file is not read).
  h.settings = {...h.settings, multilingualConversations: true};
  assert.equal(h.commit(), false);
  assert.deepEqual(h.routes.consumeRouteChanges(), []);
  const french = await h.router.prepare(input('judy-alvarez', {text: 'Combien de temps encore ?'}));
  assert.equal(french.relationship.multilingual, true);
  assert.equal(french.guard.characterId, 'judy-ml-id');
  assert.equal(warmScopes.includes(french.scope), false, 'the twin has its own conversation page');
  const english = await h.router.prepare(input('judy-alvarez', {text: 'how long until we get there'}));
  assert.equal(english.relationship.multilingual, false);
  assert.equal(english.guard.characterId, idFor('judy-alvarez'));
  assert.equal(warmScopes.includes(english.scope), true);
  // A turn with nothing to judge by ("ok", a recording) stays on the original: only a message in another language moves a conversation.
  assert.equal((await h.router.prepare(input('judy-alvarez', {text: 'ok'}))).relationship.multilingual, false);
  assert.deepEqual(ids(), [idFor('judy-alvarez'), idFor('panam-palmer')].sort());
  // Every retained page carries the one player ID and a scope tied to its own provider ID.
  assert(retained.at(-1).every(config => config.endUserId === USER));
  assert.equal(new Set(retained.at(-1).map(config => config.scope)).size, retained.at(-1).length);
});

test('describe() reports each supported character\'s next route without provider IDs or native values', () => {
  const h = harness({modes: {'river-ward': 'on', 'kerry-eurodyne': 'off'},
    facts: {...FACTS['judy-alvarez'], ...FACTS['kerry-eurodyne']}});
  const rows = Object.fromEntries(h.routes.describe(world).map(row => [row.profileKey, row]));
  assert.deepEqual(Object.keys(rows).sort(), [...PROFILES].sort());
  assert.deepEqual(rows['judy-alvarez'], {profileKey: 'judy-alvarez', mode: 'auto', status: 'ready',
    style: 'romantic', multilingual: false, reason: 'verified-current-save', confirmedInSave: true});
  assert.deepEqual(rows['panam-palmer'], {profileKey: 'panam-palmer', mode: 'auto', status: 'ready',
    style: 'ordinary', multilingual: false, reason: 'auto-unconfirmed', confirmedInSave: false});
  assert.equal(rows['river-ward'].style, 'romantic'); assert.equal(rows['river-ward'].confirmedInSave, false);
  assert.equal(rows['kerry-eurodyne'].style, 'ordinary'); assert.equal(rows['kerry-eurodyne'].confirmedInSave, true);
  assert.doesNotMatch(JSON.stringify(rows), /-ord|-romantic|sq0\d\d|q003/);
  // Evidence loss is visible by its reason; the conversation itself stays available in the ordinary style.
  h.tick(6000); h.routes.update(h.settings, undefined, {boundary: world});
  const stale = h.routes.describe(world).find(row => row.profileKey === 'judy-alvarez');
  assert.deepEqual(stale, {profileKey: 'judy-alvarez', mode: 'auto', status: 'ready', style: 'ordinary', multilingual: false,
    reason: 'relationship-state-unavailable', confirmedInSave: false});
  const noWorld = h.routes.describe(null).filter(row => row.mode === 'auto');
  assert.deepEqual(noWorld.map(row => row.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(noWorld.map(row => row.style), ['ordinary', 'ordinary', 'ordinary']);
  assert.deepEqual(noWorld.map(row => row.reason), Array(3).fill('relationship-state-unavailable'));
  // On and Off need no capture at all.
  const explicit = Object.fromEntries(h.routes.describe(null).filter(row => row.mode !== 'auto').map(row => [row.profileKey, row]));
  assert.deepEqual([explicit['river-ward'].style, explicit['river-ward'].reason], ['romantic', 'explicit-on']);
  assert.deepEqual([explicit['kerry-eurodyne'].style, explicit['kerry-eurodyne'].reason], ['ordinary', 'explicit-off']);
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /relationshipRoutes\.describe\(currentBoundary\(\)\)/);
  assert.match(source, /'relationship-routing\.json'/);
});
