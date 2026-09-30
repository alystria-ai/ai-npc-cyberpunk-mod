import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
const clone = value => structuredClone(value);
const observation = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture',
  evidenceRefs: ['capture:12:observation'], ...fields});
const audience = (channel = 'private', profileKeys = ['judy-alvarez']) => ({channel, profileKeys});

function pack() {
  const base = {revision: 1, questKey: 'the-choice', outcome: 'a', status: 'source-verified', reviewed: true,
    gameVersions: ['2.31'], category: 'decision', priority: 5, stable: true,
    sourceIds: ['native-source'], evidenceRefs: ['native-branch'],
    condition: {type: 'fact', key: 'choice_a', op: 'eq', value: 1}};
  return {version: 1, id: 'test-player-world', revision: 1, gameVersions: ['2.31'],
    profileKeys: ['judy-alvarez', 'panam-palmer', 'resident-female', 'resident-male'],
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source',
      locator: 'branch 123 -> scene 456', gameVersions: ['2.31']}],
    factAllowlist: {choice_a: {evidenceRefs: ['native-branch']}}, journalAllowlist: {}, rules: [
      {...base, id: 'choice.public', topic: 'choice.public', statement: 'V took the verified route.',
        audience: {speakers: 'all', perspective: 'shared-journal', channels: ['private', 'phone', 'group'], recipients: 'all'}},
      {...base, id: 'choice.private', topic: 'choice.private', statement: "Judy's private relationship is established by this fact.",
        audience: {speakers: ['judy-alvarez'], perspective: 'private', channels: ['private', 'phone', 'group'],
          recipients: ['v', 'judy-alvarez']}},
    ]};
}

function snapshot(extra = {}) {
  return {version: 1, status: 'ready', gameVersion: '2.31', generation: 12, worldToken: 'world-a',
    capturedAt: new Date(NOW).toISOString(), identity: {status: 'unknown'}, audience: audience(),
    activeQuestKeys: ['the-choice'], facts: {choice_a: observation(1, {present: true})}, journal: {},
    lifepath: {status: 'unknown'}, ...extra};
}

function journalHistory(extra = {}) {
  const coverage = {status: 'complete', ageSeconds: 0, windowSeconds: 5, observed: 1, omitted: 0, unstable: false, total: 1};
  return {version: 1, status: 'ready', generation: 12, worldToken: 'world-a', capturedAtMs: NOW,
    tracked: {status: 'known', questId: '1', objectiveId: '10'},
    coverage: {active: coverage, history: {...coverage, observed: 0, total: 0, windowSeconds: 180}},
    quests: [{id: '1', nativeId: 'the_choice', title: 'The Choice', state: 'active', lane: 'active', observedAtMs: NOW,
      objectivesComplete: true, objectives: [{id: '10', nativeId: 'meet_judy',
        questRelativePath: ['the_choice', 'meet_judy'], text: 'History collector: meet Judy at the docks.',
        state: 'active', observedAtMs: NOW}]}], ...extra};
}

function fixture(options = {}) {
  let now = NOW;
  const world = {ready: true, generation: 12, worldToken: 'world-a', updatedAt: NOW};
  const ids = {'judy-alvarez': 'judy-provider', 'panam-palmer': 'panam-provider',
    'resident-female': 'resident-female-provider', 'resident-male': 'resident-male-provider'};
  const epochs = {global: 0, character: new Map()};
  const routes = [], forbidden = [];
  const memory = {
    route(profileKey, request) {
      routes.push({profileKey, ...clone(request)});
      if (!ids[profileKey]) throw Object.assign(Error('Unknown'), {code: 'UNKNOWN_CHARACTER'});
      if (options.clearPending) throw Object.assign(Error('Clear pending'), {code: 'MEMORY_CLEAR_PENDING'});
      const guard = Object.freeze({endUserId: USER, characterId: ids[profileKey], resetEpoch: epochs.global,
        characterEpoch: epochs.character.get(ids[profileKey]) ?? 0});
      return Object.freeze({endUserId: USER, guard, scope: 'ignored-core-scope'});
    },
    isCurrent(guard) {
      return guard?.endUserId === USER && Object.values(ids).includes(guard?.characterId)
        && guard.resetEpoch === epochs.global && guard.characterEpoch === (epochs.character.get(guard.characterId) ?? 0);
    },
    beginConversation() { forbidden.push('beginConversation'); throw Error('Cannot enable during routing'); },
    recordActivity() { forbidden.push('recordActivity'); throw Error('No transcript ledger'); },
    addMemory() { forbidden.push('addMemory'); throw Error('No seeding'); },
  };
  const getBoundary = () => world.ready && now >= world.updatedAt - 1000 && now - world.updatedAt <= 5000
    ? {worldToken: world.worldToken, generation: world.generation} : null;
  const isWorldCurrent = binding => {
    const value = getBoundary();
    return !!value && binding.worldToken === value.worldToken && binding.generation === value.generation;
  };
  const router = new PlayerKnowledge({playerMemory: memory, pack: pack(), now: () => now,
    getBoundary, isWorldCurrent: options.isWorldCurrent ?? isWorldCurrent});
  const input = {requestId: '100-9-13ULL', generation: 9, entity: '13ULL', name: 'Judy',
    profileKey: 'judy-alvarez', text: 'What is the current objective?', worldKnowledge: snapshot(),
    journalHistory: journalHistory(), journal: {version: 1, status: 'active', quest: {id: '1', title: 'The Choice',
      objectives: [{id: '10', text: 'Tracked capture: find the current entrance.', tracked: true}]}}};
  return {router, memory, input, routes, forbidden, world, epochs, ids, getBoundary,
    setNow(value) { now = value; },
    resetCharacter(profileKey) { epochs.character.set(ids[profileKey], (epochs.character.get(ids[profileKey]) ?? 0) + 1); },
    resetAll() { epochs.global += 1; }};
}

function forProfile(input, profileKey, channel = 'private', members = [profileKey]) {
  const result = clone(input); result.profileKey = profileKey;
  result.worldKnowledge.audience = audience(channel, members);
  if (channel === 'group') result.group = {id: 'group-1', index: 1, total: members.length,
    audience: [...members], heard: []};
  else if (channel === 'phone') { result.id = 'phone-1'; delete result.requestId; result.channel = 'phone'; }
  return result;
}

test('current world facts and fresh tracked objective attach without repeating older tracked history', async () => {
  const f = fixture(), prepared = await f.router.prepare(f.input);
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.sendAllowed, true); assert.equal(prepared.identified, true);
  assert.deepEqual(prepared.remoteConfig, {endUserId: USER});
  assert.equal(prepared.guard.characterId, 'judy-provider'); assert.equal(await f.router.current(prepared), true);
  const context = conversationContext(prepared.input);
  assert.match(context, /V took the verified route/); assert.match(context, /Judy's private relationship/);
  assert.match(context, /Tracked capture: find the current entrance/);
  assert.doesNotMatch(context, /History collector: meet Judy at the docks/);
  assert.match(context, /current tracked-quest snapshot override older/);
  assert.equal(prepared.input.worldKnowledge.identity.status, 'unknown');
  assert.deepEqual(f.forbidden, []); assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.input), true); assert.equal(Object.isFrozen(prepared.input.worldKnowledge.facts), true);
});

test('one end-user ID crosses channels; microphone shares its private/group session without mixing audiences', async () => {
  const f = fixture(), configurations = [];
  for (const profileKey of ['judy-alvarez', 'panam-palmer']) {
    for (const channel of ['private', 'phone', 'group']) {
      const members = channel === 'group' ? ['panam-palmer', 'judy-alvarez'] : [profileKey];
      const input = forProfile(f.input, profileKey, channel, members);
      const prepared = await f.router.prepare(input, {channel}); configurations.push(prepared);
      const scope = channel === 'group' ? 'group:panam-palmer,judy-alvarez' : channel;
      const warm = f.router.configFor(profileKey, scope);
      assert.equal(warm.scope, prepared.scope); assert.equal(warm.sessionKey, prepared.sessionKey);
      assert.equal(prepared.remoteConfig.endUserId, USER);
    }
  }
  const mic = await f.router.prepare({...f.input, source: 'microphone'});
  configurations.push(mic);
  assert.match(mic.scope, /^private:world:[a-f0-9]{24}$/);
  assert.equal(mic.sessionKey, f.router.configFor('judy-alvarez', 'microphone').sessionKey);
  assert.equal(mic.sessionKey, f.router.configFor('judy-alvarez', 'private').sessionKey);
  assert.equal(mic.route.transport, 'microphone');
  const groupMic = forProfile(f.input, 'judy-alvarez', 'group', ['judy-alvarez', 'panam-palmer']);
  groupMic.source = 'microphone'; const grouped = await f.router.prepare(groupMic); configurations.push(grouped);
  assert.equal(grouped.sessionKey, f.router.configFor('judy-alvarez', 'microphone:group:panam-palmer,judy-alvarez').sessionKey);
  assert.equal(grouped.sessionKey, f.router.configFor('judy-alvarez', 'group:panam-palmer,judy-alvarez').sessionKey);
  assert.equal(grouped.route.channel, 'group'); assert.equal(grouped.route.transport, 'microphone');
  assert.equal(new Set(configurations.map(value => value.sessionKey)).size, configurations.length - 2);
  assert.notEqual(grouped.sessionKey, mic.sessionKey);
  assert.deepEqual(new Set(configurations.map(value => value.remoteConfig.endUserId)), new Set([USER]));
  assert.deepEqual(f.forbidden, []);
});

test('fresh parent world fallback preserves identified routing and independently captured tracked quest', async () => {
  for (const fullCapture of [undefined, {version: 1, status: 'unavailable'}, snapshot({facts: {}})]) {
    const f = fixture(); f.input.worldKnowledge = fullCapture;
    const prepared = await f.router.prepare(f.input, f.getBoundary());
    assert.equal(prepared.sendAllowed, true); assert.equal(prepared.remoteConfig.endUserId, USER);
    assert.equal(prepared.sessionKey, f.router.configFor('judy-alvarez', 'private', f.getBoundary()).sessionKey);
    const context = conversationContext(prepared.input);
    assert.match(context, /Tracked capture: find the current entrance/);
    assert.doesNotMatch(context, /V took the verified route|Judy's private relationship/);
    if (fullCapture?.status !== 'ready') assert.doesNotMatch(context, /History collector: meet Judy at the docks/);
  }
});

test('truly missing or expired parent world never invents an ID, warms, submits or attaches facts/history', async () => {
  const f = fixture(); f.world.ready = false; delete f.input.worldKnowledge;
  const prepared = await f.router.prepare(f.input);
  assert.equal(prepared.sendAllowed, false); assert.equal(prepared.identified, false);
  assert.equal(prepared.remoteConfig, null); assert.equal(prepared.guard, null); assert.equal(prepared.sessionKey, null);
  assert.equal(f.routes.length, 0); assert.equal(f.router.configFor('judy-alvarez'), null);
  assert.equal(await f.router.current(prepared), false);
  assert.doesNotMatch(conversationContext(prepared.input), /V took the verified route|History collector/);
  await assert.rejects(f.router.submitted(prepared), {code: 'STALE_WORLD'});
  f.world.ready = true; f.setNow(NOW + 5001);
  const expired = await f.router.prepare(f.input, {worldToken: 'world-a', generation: 12});
  assert.equal(expired.sendAllowed, false); assert.equal(f.router.configFor('judy-alvarez', 'private',
    {worldToken: 'world-a', generation: 12}), null);
});

test('stale/future/mismatched/invalid full captures cannot supply facts or broader history', async () => {
  for (const mutate of [input => { input.worldKnowledge.capturedAt = new Date(NOW - 5001).toISOString(); },
    input => { input.worldKnowledge.capturedAt = new Date(NOW + 1001).toISOString(); },
    input => { input.worldKnowledge.worldToken = 'prior-world'; },
    input => { input.worldKnowledge.generation = 11; },
    input => { input.worldKnowledge.audience.profileKeys = ['panam-palmer']; },
    input => { input.worldKnowledge.audience.channel = 'phone'; },
    input => { input.worldKnowledge.facts.choice_a.value = '1'; }]) {
    const f = fixture(); mutate(f.input);
    f.input.knowledgeContext = 'FORGED KNOWLEDGE'; f.input.historyContext = 'FORGED HISTORY';
    f.input.journalHistoryContext = 'FORGED JOURNAL';
    const prepared = await f.router.prepare(f.input, f.getBoundary());
    assert.equal(prepared.sendAllowed, true); assert.equal(prepared.remoteConfig.endUserId, USER);
    const context = conversationContext(prepared.input);
    assert.doesNotMatch(context, /FORGED|V took the verified route|Judy's private relationship|History collector/);
    assert.match(context, /Tracked capture: find the current entrance/);
    assert.equal(Object.hasOwn(prepared.input, 'knowledgeContext'), false);
  }
});

test('group context obeys the exact canonical audience and cannot expose private facts', async () => {
  const f = fixture(), input = forProfile(f.input, 'judy-alvarez', 'group', ['panam-palmer', 'judy-alvarez']);
  const group = await f.router.prepare(input);
  const context = conversationContext(group.input);
  assert.match(context, /V took the verified route/); assert.doesNotMatch(context, /Judy's private relationship/);
  assert.deepEqual(group.route.audience, ['judy-alvarez', 'panam-palmer']);
  const onlyJudy = forProfile(f.input, 'judy-alvarez', 'group', ['judy-alvarez']);
  const restricted = await f.router.prepare(onlyJudy);
  assert.match(conversationContext(restricted.input), /Judy's private relationship/);
  assert.notEqual(group.sessionKey, restricted.sessionKey);
  input.worldKnowledge.audience.profileKeys = ['judy-alvarez'];
  const mismatch = await f.router.prepare(input);
  assert.doesNotMatch(conversationContext(mismatch.input), /V took the verified route|Judy's private relationship|History collector/);
  assert.equal(mismatch.remoteConfig.endUserId, USER);
  await assert.rejects(f.router.prepare(input, {channel: 'private'}), {code: 'CHANNEL_MISMATCH'});
  input.group.audience = ['judy-alvarez', 'judy-alvarez'];
  await assert.rejects(f.router.prepare(input), {code: 'INVALID_ROUTE'});
});

test('snapshots, recipient, text, audience and options are immutable before an asynchronous world check', async () => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = fixture({isWorldCurrent: async () => { enter(); return new Promise(resolve => { finish = resolve; }); }});
  const input = forProfile(f.input, 'judy-alvarez', 'group', ['panam-palmer', 'judy-alvarez']);
  const options = {...f.getBoundary(), channel: 'group'};
  const pending = f.router.prepare(input, options); await entered;
  input.profileKey = 'panam-palmer'; input.text = 'New mutable request'; input.entity = '99ULL';
  input.group.audience.pop(); input.worldKnowledge.audience.profileKeys.pop();
  input.worldKnowledge.facts.choice_a.value = 0; input.journal.quest.objectives[0].text = 'MUTATED';
  input.journalHistory.quests[0].objectives[0].text = 'MUTATED'; options.worldToken = 'world-b'; options.generation = 13;
  finish(true); const prepared = await pending;
  assert.equal(prepared.route.profileKey, 'judy-alvarez'); assert.equal(prepared.input.text, 'What is the current objective?');
  assert.deepEqual(prepared.route.audience, ['judy-alvarez', 'panam-palmer']);
  assert.equal(prepared.worldToken, 'world-a'); assert.equal(prepared.generation, 12); assert.equal(prepared.input.entity, '13ULL');
  const context = conversationContext(prepared.input);
  assert.match(context, /V took the verified route|Tracked capture: find the current entrance/);
  assert.doesNotMatch(context, /MUTATED|New mutable request/);
  assert.equal(Object.isFrozen(prepared.input.group.audience), true);
});

test('world or reset changes during awaited preparation cannot bind the old turn to the new world or epoch', async () => {
  for (const change of ['world', 'character', 'all']) {
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; });
    const f = fixture({isWorldCurrent: async () => { enter(); return new Promise(resolve => { finish = resolve; }); }});
    const pending = f.router.prepare(f.input, f.getBoundary()); await entered;
    if (change === 'world') f.world.worldToken = 'world-b';
    else if (change === 'character') f.resetCharacter('judy-alvarez'); else f.resetAll();
    finish(true); const prepared = await pending;
    assert.equal(prepared.sendAllowed, false); assert.equal(prepared.remoteConfig, null);
    assert.equal(await f.router.current(prepared), false);
    assert.doesNotMatch(conversationContext(prepared.input), /V took the verified route|History collector/);
    assert.equal(f.routes.length, 1); assert.deepEqual(f.forbidden, []);
  }
});

test('same-generation world reload and changed generation invalidate turns and session reuse while retaining player ID', async () => {
  const f = fixture(), first = await f.router.prepare(f.input);
  f.world.worldToken = 'world-b';
  assert.equal(await f.router.current(first), false);
  await assert.rejects(f.router.submitted(first), {code: 'STALE_WORLD'});
  const second = await f.router.prepare(f.input, f.getBoundary());
  assert.equal(second.remoteConfig.endUserId, USER); assert.notEqual(second.sessionKey, first.sessionKey);
  assert.notEqual(second.scope, first.scope); assert.doesNotMatch(conversationContext(second.input), /V took the verified route|History collector/);
  f.world.generation = 13;
  assert.equal(await f.router.current(second), false);
  const third = await f.router.prepare(f.input, f.getBoundary());
  assert.equal(third.remoteConfig.endUserId, USER); assert.notEqual(third.sessionKey, second.sessionKey);
});

test('character and player reset epochs partition sessions without rotating UUID or affecting unrelated character reset', async () => {
  const f = fixture(), judy = await f.router.prepare(f.input);
  const panamInput = forProfile(f.input, 'panam-palmer'), panam = await f.router.prepare(panamInput);
  f.resetCharacter('judy-alvarez');
  assert.equal(await f.router.current(judy), false); assert.equal(await f.router.current(panam), true);
  const refreshed = await f.router.prepare(f.input);
  assert.equal(refreshed.remoteConfig.endUserId, USER); assert.notEqual(refreshed.sessionKey, judy.sessionKey);
  assert.equal(f.router.configFor('panam-palmer').sessionKey, panam.sessionKey);
  f.resetAll(); assert.equal(await f.router.current(panam), false); assert.equal(await f.router.current(refreshed), false);
  const reset = await f.router.prepare(f.input);
  assert.equal(reset.remoteConfig.endUserId, USER); assert.notEqual(reset.scope, refreshed.scope);
});

test('mapped ambient actors keep the same player ID with separate physical entity sessions', async () => {
  const f = fixture(), input = forProfile(f.input, 'resident-female');
  const first = await f.router.prepare(input);
  input.entity = '14ULL'; const other = await f.router.prepare(input);
  assert.equal(first.remoteConfig.endUserId, USER); assert.equal(other.remoteConfig.endUserId, USER);
  assert.notEqual(first.sessionKey, other.sessionKey); assert.notEqual(first.scope, other.scope);
  assert.equal(f.router.configFor('resident-female'), null);
  assert.equal(f.router.configFor('resident-female', 'private', {...f.getBoundary(), entity: '14ULL'}).sessionKey, other.sessionKey);
  delete input.entity; const missing = await f.router.prepare(input);
  assert.equal(missing.sendAllowed, false); assert.equal(missing.remoteConfig, null);
  assert.equal(await f.router.current(missing), false); assert.equal(missing.memoryReason, 'ambient-entity-unavailable');
});

test('unknown profiles and pending clears never warm or proceed as anonymous', async () => {
  const f = fixture(), input = clone(f.input); input.profileKey = 'unconfigured-character';
  const unknown = await f.router.prepare(input, f.getBoundary());
  assert.equal(unknown.sendAllowed, false); assert.equal(unknown.remoteConfig, null); assert.equal(unknown.memoryReason, 'unknown-character');
  assert.equal(f.router.configFor('unconfigured-character'), null);
  const clear = fixture({clearPending: true}), prepared = await clear.router.prepare(clear.input);
  assert.equal(prepared.memoryReason, 'memory-clear-pending'); assert.equal(clear.router.configFor('judy-alvarez'), null);
  await assert.rejects(clear.router.submitted(prepared), {code: 'STALE_WORLD'});
});

test('submitted/activity are ownership and cancellation guards with zero provider, ledger or seeding calls', async () => {
  const f = fixture(), prepared = await f.router.prepare(f.input);
  assert.equal((await f.router.submitted(prepared)).sendAllowed, true);
  assert.equal((await f.router.activity(prepared, 'generated-reply', {replyText: 'Never archive this.'})).status, 'current');
  assert.equal((await f.router.activity(prepared, 'delivered-reply', {arbitrary: 'receipt'})).status, 'current');
  assert.deepEqual(f.forbidden, []);
  await assert.rejects(f.router.submitted(prepared), {code: 'DUPLICATE_OR_INVALID_SUBMISSION'});
  assert.equal(await f.router.current({...prepared}), false);
  const other = fixture(); assert.equal(await other.router.current(prepared), false);
  assert.equal((await f.router.activity({...prepared}, 'generated-reply')).reason, 'invalid-activity');
  await f.router.activity(prepared, 'cancelled-turn'); assert.equal(await f.router.current(prepared), false);
  assert.equal((await f.router.activity(prepared, 'delivered-reply')).reason, 'stale-world');
  assert.deepEqual(f.forbidden, []);
});

test('current rechecks world and reset guard after asynchronous parent checks', async () => {
  for (const change of ['world', 'character', 'all', 'cancel']) {
    const f = fixture(), prepared = await f.router.prepare(f.input);
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; });
    f.router.isWorldCurrent = async () => { enter(); return new Promise(resolve => { finish = resolve; }); };
    const pending = f.router.current(prepared); await entered;
    if (change === 'world') f.world.worldToken = 'world-b';
    else if (change === 'character') f.resetCharacter('judy-alvarez');
    else if (change === 'all') f.resetAll(); else await f.router.activity(prepared, 'cancelled-turn');
    finish(true); assert.equal(await pending, false);
  }
});

test('the synchronous publication guard immediately retires clears, world changes and cancelled turns', async () => {
  const f = fixture(), judy = await f.router.prepare(f.input);
  const panam = await f.router.prepare(forProfile(f.input, 'panam-palmer'));
  assert.equal(await f.router.current(judy), true);
  assert.equal(f.router.currentSync(judy), true); assert.equal(f.router.currentSync(panam), true);

  f.resetCharacter('judy-alvarez');
  assert.equal(f.router.currentSync(judy), false, 'a character clear fences its prepared publication in the same call stack');
  assert.equal(f.router.currentSync(panam), true, 'the unrelated character can still publish');
  const refreshed = await f.router.prepare(f.input);
  assert.equal(f.router.currentSync(refreshed), true);

  f.resetAll();
  assert.equal(f.router.currentSync(refreshed), false); assert.equal(f.router.currentSync(panam), false);
  const beforeReload = await f.router.prepare(f.input);
  assert.equal(f.router.currentSync(beforeReload), true);
  f.world.worldToken = 'world-b';
  assert.equal(f.router.currentSync(beforeReload), false, 'a same-generation reload retires the old publication');

  const afterReload = await f.router.prepare(f.input, f.getBoundary());
  assert.equal(f.router.currentSync(afterReload), true);
  const cancelling = f.router.activity(afterReload, 'cancelled-turn');
  assert.equal(f.router.currentSync(afterReload), false, 'cancellation fences publication before its promise is awaited');
  await cancelling;
  assert.deepEqual(f.forbidden, []);
});

test('bad world bindings, routes and packs fail closed without side effects', async () => {
  const f = fixture();
  for (const generation of [0, -1, NaN, '12', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.router.prepare(f.input, {worldToken: 'world-a', generation}), {code: 'INVALID_WORLD_BINDING'});
  }
  for (const worldToken of ['', 'wrong token', '__proto__', 'x'.repeat(161), 12]) {
    assert.throws(() => f.router.configFor('judy-alvarez', 'private', {worldToken, generation: 12}), {code: 'INVALID_WORLD_BINDING'});
  }
  assert.throws(() => new PlayerKnowledge({playerMemory: f.memory, pack: {}, getBoundary: f.getBoundary}), {code: 'INVALID_REVIEWED_PACK'});
  assert.throws(() => new PlayerKnowledge({playerMemory: f.memory, pack: pack()}), {code: 'INVALID_CONFIGURATION'});
  assert.throws(() => f.router.configFor('judy-alvarez', 'group:panam-palmer'), {code: 'INVALID_ROUTE'});
  assert.throws(() => f.router.configFor('judy-alvarez', 'group:judy-alvarez,judy-alvarez'), {code: 'INVALID_ROUTE'});
  assert.deepEqual(f.forbidden, []);
});
