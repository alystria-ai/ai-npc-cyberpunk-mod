import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeRouter} from './conversation-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';
import {WORLD_SNAPSHOT_MAX_AGE_MS} from './world-knowledge.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const clone = value => structuredClone(value);
function fixture({identifiedEnabled = false, native = true, remoteEnabled = true, isWorldCurrent, serviceChanges = {}} = {}) {
  const identity = {status: 'verified', authoritative: true, userId: 'user-1', campaignId: 'campaign-1',
    playthroughId: 'campaign-1', branchId: 'branch-1', worldGeneration: 7, generation: 4,
    activationId: 'activation-1', worldToken: '4:activation-1:branch-1'};
  const originalGuard = {epoch: 1, userId: identity.userId, branchId: identity.branchId,
    worldGeneration: 7, generation: 4, activationId: identity.activationId, remoteGeneration: 1};
  let guard = clone(originalGuard), state = native ? identity : {status: 'unavailable'};
  const projects = [], activities = [], memories = [];
  const remote = (channel, audience) => ({endUserId: `provider-slot-${{private: 1, phone: 2, group: 3}[channel]}`,
    endUserMetadata: {channel, audience: [...audience]}});
  const service = {
    get saveIdentity() { return clone(state); },
    guard: () => state.status === 'verified' ? clone(guard) : null,
    isCurrent: value => state.status === 'verified' && JSON.stringify(value) === JSON.stringify(guard),
    async current(value) { return this.isCurrent(value); },
    configFor(profile, channel, audience) { return remoteEnabled && state.status === 'verified' ? remote(channel, audience) : null; },
    async project(value) {
      projects.push(value);
      return {knowledgeContext: 'Reviewed current-save fact.', saveIdentity: clone(state),
        guard: this.guard(), remoteConfig: this.configFor(value.profileKey, value.channel, value.audience)};
    },
    ledger: {contextFor(value) {
      memories.push(value);
      return {status: 'available', identity: clone(state), characterKey: value.characterKey, channel: value.channel,
        endUserId: `cp2077-local-${state.branchId}-${value.channel}-${value.audience.join(',')}`,
        episodes: [{text: 'V previously told Judy a personal story.', authority: 'player-claim', witnessed: false, checkpointed: true}]};
    }},
    async recordActivity(value) {
      activities.push(clone(value));
      if (!this.isCurrent(value.guard)) return {status: 'unavailable', sendAllowed: false};
      return {status: 'recorded', sendAllowed: value.kind === 'submitted-input', guard: clone(guard),
        ...(value.kind === 'generated-reply' ? {replyHash: 'a'.repeat(64)} : {})};
    },
    ...serviceChanges,
  };
  const router = new KnowledgeRouter({service, now: () => NOW, identifiedEnabled, isWorldCurrent});
  const input = {requestId: '100-9-13ULL', generation: 9, entity: '13ULL', profileKey: 'judy-alvarez',
    name: 'Judy', text: 'What happened before?',
    worldKnowledge: {version: 1, status: 'ready', gameVersion: '2.31', generation: 7,
      worldToken: identity.worldToken, capturedAt: new Date(NOW).toISOString(), identity: {status: 'unknown'},
      audience: {channel: 'private', profileKeys: ['judy-alvarez']}, facts: {}, journal: {}}};
  return {router, service, input, identity, originalGuard, projects, activities, memories,
    change(fields) { state = {...state, ...fields}; guard = {...guard, ...fields}; },
    unbind() { state = {status: 'unavailable'}; }};
}

test('provider qualification defaults to anonymous transport while verified local history stays available', async () => {
  const f = fixture(), prepared = await f.router.prepare(f.input);
  assert.equal(prepared.identified, false); assert.equal(prepared.remoteConfig, null);
  assert.equal(prepared.localEligible, true); assert.deepEqual(prepared.guard, f.originalGuard);
  assert.equal(f.memories.length, 1); assert.equal(f.projects[0].generation, 7);
  assert.notEqual(f.projects[0].generation, f.input.generation);
  assert.match(conversationContext(prepared.input), /Reviewed current-save fact/);
  assert.match(conversationContext(prepared.input), /Historical records attributed/);
  assert.equal(prepared.memoryReason, 'local-history-only');
  const submitted = await f.router.submitted(prepared);
  assert.equal(submitted.sendAllowed, true); assert.equal(f.activities.length, 1);
  assert.equal(submitted.remoteConfig, null);
  await assert.rejects(f.router.submitted(prepared), {code: 'DUPLICATE_OR_INVALID_SUBMISSION'});
});

test('qualified exact route attaches bounded attributed history and uses the same warm key', async () => {
  const f = fixture({identifiedEnabled: true});
  const warm = f.router.configFor('judy-alvarez', 'private', {worldToken: f.input.worldKnowledge.worldToken});
  const prepared = await f.router.prepare(f.input);
  assert.equal(prepared.identified, true); assert.equal(prepared.scope, 'private');
  assert.equal(prepared.sessionKey, warm.sessionKey); assert.deepEqual(prepared.remoteConfig, warm.remoteConfig);
  const context = conversationContext(prepared.input);
  assert.match(context, /Historical records attributed/); assert.match(context, /witnessedByThisCharacter":false/);
  assert.match(context, /Current verified save facts.*override older records/);
  assert.equal(f.memories[0].maxChars, 2400);
  assert.equal(Object.isFrozen(prepared.route.audience), true); assert.equal(Object.isFrozen(prepared.input.worldKnowledge), true);
});

test('caller mutations during projection cannot change the recipient, question, group or captured world', async () => {
  let finish, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = fixture({identifiedEnabled: true});
  const original = f.service.project;
  f.service.project = async function(value) {
    const result = await original.call(this, value); entered();
    await new Promise(resolve => { finish = resolve; }); return result;
  };
  const pending = f.router.prepare(f.input); await enteredPromise;
  f.input.profileKey = 'panam-palmer'; f.input.text = 'Changed question';
  f.input.worldKnowledge.worldToken = 'wrong-load'; f.input.worldKnowledge.audience.profileKeys[0] = 'panam-palmer';
  finish(); const prepared = await pending;
  assert.equal(prepared.route.profileKey, 'judy-alvarez'); assert.equal(prepared.input.text, 'What happened before?');
  assert.equal(prepared.identified, true); assert.match(conversationContext(prepared.input), /Reviewed current-save fact/);
});

test('same-generation activation or branch changes reject prepared submissions and do not rebind the old request', async () => {
  const f = fixture({identifiedEnabled: true}), prepared = await f.router.prepare(f.input);
  f.change({activationId: 'activation-2', worldToken: '4:activation-2:branch-1'});
  assert.equal(await f.router.current(prepared), false);
  await assert.rejects(f.router.submitted(prepared), {code: 'STALE_WORLD'});
  assert.equal(f.activities.length, 0); assert.deepEqual(prepared.guard, f.originalGuard);
});

test('a world switch during the asynchronous parent heartbeat check cannot attach old context', async () => {
  let finish, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = fixture({identifiedEnabled: true, isWorldCurrent: async () => {
    enter(); return new Promise(resolve => { finish = resolve; });
  }});
  const pending = f.router.prepare(f.input); await entered;
  f.change({activationId: 'activation-2', worldToken: '4:activation-2:branch-1'});
  finish(true); const prepared = await pending;
  assert.equal(prepared.identified, false);
  assert.doesNotMatch(conversationContext(prepared.input), /Reviewed current-save fact|personal story/);
});

test('anonymous sessions are world-token scoped and warm exactly matches real requests', async () => {
  const f = fixture({native: false}), token = f.input.worldKnowledge.worldToken;
  const first = await f.router.prepare(f.input);
  const warm = f.router.configFor('judy-alvarez', 'private', {worldToken: token});
  assert.equal(first.scope, warm.scope); assert.equal(first.sessionKey, warm.sessionKey);
  const other = clone(f.input); other.worldKnowledge.worldToken = 'next-local-world';
  const second = await f.router.prepare(other);
  assert.notEqual(first.sessionKey, second.sessionKey); assert.notEqual(first.scope, second.scope);
  assert.equal(second.remoteConfig, null); assert.match(conversationContext(second.input), /Reviewed current-save fact/);
});

test('ambient actors always stay anonymous and never share a resident-sex connection', async () => {
  const f = fixture({identifiedEnabled: true});
  f.input.profileKey = 'resident-female'; f.input.worldKnowledge.audience.profileKeys = ['resident-female'];
  const a = await f.router.prepare(f.input);
  f.input.entity = '14ULL'; f.input.requestId = '100-9-14ULL';
  const b = await f.router.prepare(f.input);
  assert.equal(a.identified, false); assert.equal(b.remoteConfig, null); assert.equal(f.memories.length, 0);
  assert.notEqual(a.sessionKey, b.sessionKey); assert.notEqual(a.scope, b.scope);
  assert.equal(f.router.configFor('resident-female', 'private', {worldToken: a.worldToken}), null);
  const warm = f.router.configFor('resident-female', 'private', {worldToken: b.worldToken, entity: '14ULL'});
  assert.equal(warm.sessionKey, b.sessionKey);
});

test('unknown native identity uses the injected exact local-world guard without fabricating identity', async () => {
  let live = true;
  const f = fixture({native: false, identifiedEnabled: true, isWorldCurrent: binding => live && binding.generation === 7});
  const prepared = await f.router.prepare(f.input);
  assert.equal(prepared.remoteConfig, null); assert.equal(prepared.localEligible, false);
  assert.equal(prepared.guard, null); assert.equal(f.memories.length, 0);
  assert.equal(await f.router.current(prepared), true);
  live = false; assert.equal(await f.router.current(prepared), false);
  await assert.rejects(f.router.submitted(prepared), {code: 'STALE_WORLD'});
  assert.equal(f.activities.length, 0);
});

test('unavailable captures can reuse only an explicit local-world scope; missing worlds cannot be warmed', async () => {
  const f = fixture({native: false}); delete f.input.worldKnowledge;
  assert.equal(f.router.configFor('judy-alvarez'), null);
  const a = await f.router.prepare(f.input), b = await f.router.prepare(f.input);
  assert.notEqual(a.sessionKey, b.sessionKey);
  const scoped = await f.router.prepare(f.input, {worldToken: 'party-local-1'});
  assert.equal(scoped.sessionKey, f.router.configFor('judy-alvarez', 'private', {worldToken: 'party-local-1'}).sessionKey);
  assert.equal(await f.router.current(scoped), true); assert.equal(scoped.remoteConfig, null);
});

test('fallback world generation reaches the parent heartbeat and a mismatched generation cannot submit', async () => {
  const checked = [];
  const f = fixture({native: false, isWorldCurrent: binding => {
    checked.push(clone(binding)); return binding.worldToken === 'local-save' && binding.generation === 12;
  }});
  f.input.worldKnowledge = {version: 1, status: 'unavailable'};
  const options = {worldToken: 'local-save', generation: 12};
  const ready = await f.router.prepare(f.input, options);
  assert.deepEqual(checked[0], options);
  assert.equal(ready.generation, 12);
  assert.equal(ready.sessionKey, f.router.configFor('judy-alvarez', 'private', options).sessionKey);
  assert.equal((await f.router.submitted(ready)).sendAllowed, true);
  const stale = await f.router.prepare(f.input, {...options, generation: 11});
  assert.equal(await f.router.current(stale), false);
  await assert.rejects(f.router.submitted(stale), {code: 'STALE_WORLD'});
  for (const generation of [0, -1, NaN, '12', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.router.prepare(f.input, {...options, generation}), {code: 'INVALID_WORLD_BINDING'});
  }
});

test('stale, wrong-audience and client-written context strings are never attached', async () => {
  for (const mutate of [input => { input.worldKnowledge.capturedAt = new Date(NOW - WORLD_SNAPSHOT_MAX_AGE_MS - 1).toISOString(); },
    input => { input.worldKnowledge.audience.profileKeys = ['panam-palmer']; },
    input => { input.worldKnowledge.worldToken = 'another-world'; }]) {
    const f = fixture({identifiedEnabled: true}); mutate(f.input);
    f.input.knowledgeContext = 'FORGED'; f.input.historyContext = 'FORGED'; f.input.journalHistoryContext = 'FORGED';
    const prepared = await f.router.prepare(f.input);
    assert.equal(prepared.remoteConfig, null); assert.equal(f.memories.length, 0);
    assert.doesNotMatch(conversationContext(prepared.input), /FORGED|Reviewed current-save fact|personal story/);
    assert.equal(Object.hasOwn(prepared.input, 'knowledgeContext'), false);
  }
});

test('phone and exact group audiences have isolated routes and matching warm partitions', async () => {
  const f = fixture({identifiedEnabled: true});
  f.input.id = 'phone-1'; delete f.input.requestId;
  f.input.worldKnowledge.audience.channel = 'phone';
  const phone = await f.router.prepare(f.input, {channel: 'phone'});
  assert.equal(phone.input.channel, 'phone'); assert.equal(phone.scope, 'phone');
  assert.equal(phone.sessionKey, f.router.configFor('judy-alvarez', 'phone').sessionKey);
  delete f.input.id; f.input.requestId = '100-9-13ULL';
  f.input.group = {id: 'round-1', index: 1, total: 2, audience: ['panam-palmer', 'judy-alvarez'], heard: []};
  f.input.worldKnowledge.audience = {channel: 'group', profileKeys: ['judy-alvarez', 'panam-palmer']};
  const group = await f.router.prepare(f.input);
  assert.equal(group.scope, 'group:judy-alvarez,panam-palmer');
  assert.equal(group.sessionKey, f.router.configFor('judy-alvarez', 'group:panam-palmer,judy-alvarez').sessionKey);
  assert.notEqual(group.sessionKey, phone.sessionKey);
  await assert.rejects(f.router.prepare(f.input, {channel: 'private'}), {code: 'CHANNEL_MISMATCH'});
});

test('local-only phone and group history uses exact ledger audiences without exposing local scope IDs', async () => {
  for (const channel of ['phone', 'group']) {
    const f = fixture({identifiedEnabled: true, remoteEnabled: false});
    const audience = channel === 'group' ? ['panam-palmer', 'judy-alvarez'] : ['judy-alvarez'];
    f.input.worldKnowledge.audience = {channel, profileKeys: audience};
    if (channel === 'phone') { f.input.id = 'phone-1'; delete f.input.requestId; }
    else f.input.group = {id: 'group-1', index: 1, total: 2, audience, heard: []};
    const prepared = await f.router.prepare(f.input, {channel});
    assert.equal(prepared.localEligible, true); assert.equal(prepared.identified, false);
    assert.equal(prepared.remoteConfig, null);
    assert.deepEqual(f.memories[0].audience, [...audience].sort());
    assert.equal(f.memories[0].channel, channel);
    assert.match(conversationContext(prepared.input), /Historical records attributed/);
    assert.doesNotMatch(JSON.stringify(prepared), /cp2077-local-/);
    const submitted = await f.router.submitted(prepared);
    assert.equal(submitted.sendAllowed, true); assert.equal(submitted.remoteConfig, null);
    assert.deepEqual(f.activities[0].audience, [...audience].sort());
    assert.equal(f.activities[0].channel, channel);
    f.change({branchId: 'another-branch', worldToken: '4:activation-1:another-branch'});
    assert.equal(await f.router.current(prepared), false);
    const stale = await f.router.activity(prepared, 'generated-reply', {replyText: 'Obsolete'});
    assert.equal(stale.status, 'unavailable');
    assert.deepEqual(f.activities[1].guard, f.originalGuard);
  }
});

test('local-only history rejects another owner, character or channel and never substitutes a provider ID', async () => {
  const f = fixture({remoteEnabled: false}), original = f.service.ledger.contextFor;
  for (const change of [row => { row.identity.userId = 'another-user'; },
    row => { row.characterKey = 'panam-palmer'; }, row => { row.channel = 'group'; }]) {
    f.service.ledger.contextFor = value => { const row = original(value); change(row); return row; };
    const prepared = await f.router.prepare(f.input);
    assert.equal(prepared.localEligible, true); assert.equal(prepared.remoteConfig, null);
    assert.doesNotMatch(conversationContext(prepared.input), /Historical records attributed/);
    assert.match(conversationContext(prepared.input), /Reviewed current-save fact/);
  }
  const activity = f.service.recordActivity;
  f.service.recordActivity = async function(value) {
    return {...await activity.call(this, value), remoteConfig: {endUserId: 'cp2077-obsolete-local-scope'}};
  };
  const prepared = await f.router.prepare(f.input);
  assert.equal((await f.router.submitted(prepared)).remoteConfig, null);
  assert.equal((await f.router.activity(prepared, 'generated-reply', {replyText: 'A reply.'})).remoteConfig, null);
});

test('submitted/generated/delivered stages keep the original guard, text and actual delivery receipt', async () => {
  const f = fixture({identifiedEnabled: true, remoteEnabled: false}), prepared = await f.router.prepare(f.input);
  assert.equal(prepared.identified, false); assert.equal(prepared.remoteConfig, null); assert.equal(prepared.localEligible, true);
  await f.router.submitted(prepared);
  assert.equal(f.activities[0].userText, 'What happened before?');
  await f.router.activity(prepared, 'generated-reply', {replyText: 'Here is what happened.'});
  assert.equal(f.activities[1].replyText, 'Here is what happened.'); assert.equal(f.activities[1].delivery, undefined);
  const receipt = {source: 'native-playback', state: 'completed', requestId: f.input.requestId,
    completedChunks: 2, totalChunks: 2, witnessedBy: ['judy-alvarez']};
  await f.router.activity(prepared, 'delivered-reply', receipt);
  assert.deepEqual(f.activities[2].delivery, {...receipt, replyHash: 'a'.repeat(64)});
  assert.equal(receipt.replyHash, undefined); assert.deepEqual(f.activities[2].guard, f.originalGuard);
  const mismatch = await f.router.activity(prepared, 'delivered-reply', {...receipt, replyHash: 'wrong'});
  assert.equal(mismatch.status, 'unavailable'); assert.equal(f.activities.length, 3);
});

test('automatic reactions are never recorded as words spoken by V', async () => {
  const f = fixture({identifiedEnabled: true});
  f.input.reaction = {kind: 'loot', batch: 'batch-1', expiresAt: NOW + 30000};
  const prepared = await f.router.prepare(f.input); await f.router.submitted(prepared);
  assert.equal(Object.hasOwn(f.activities[0], 'userText'), false);
});

test('microphone placeholder text is never staged as an actual player utterance', async () => {
  const f = fixture({identifiedEnabled: true});
  f.input.source = 'microphone'; f.input.text = 'voice message';
  const prepared = await f.router.prepare(f.input); await f.router.submitted(prepared);
  assert.equal(Object.hasOwn(f.activities[0], 'userText'), false);
  assert.equal(f.activities[0].kind, 'submitted-input');
});

test('a refused durable submission throws and cannot silently fall back to anonymous sending', async () => {
  const f = fixture({remoteEnabled: false, serviceChanges: {
    async recordActivity() { return {status: 'unavailable', sendAllowed: false}; },
  }});
  const prepared = await f.router.prepare(f.input);
  await assert.rejects(f.router.submitted(prepared), {code: 'SUBMISSION_NOT_ACKNOWLEDGED'});
  assert.equal(prepared.identified, false); assert.equal(prepared.localEligible, true);
  await f.router.activity(prepared, 'cancelled-turn'); assert.equal(await f.router.current(prepared), false);
  assert.equal(await f.router.current({...prepared}), false);
});

test('historical context is omitted on identity mismatch and bounded without cutting quoted records', async () => {
  const f = fixture({identifiedEnabled: true}), original = f.service.ledger.contextFor;
  f.service.ledger.contextFor = value => ({...original(value), identity: {...f.identity, branchId: 'old-branch'}});
  let prepared = await f.router.prepare(f.input);
  assert.doesNotMatch(conversationContext(prepared.input), /Historical records attributed/);
  f.service.ledger.contextFor = value => ({...original(value), episodes: Array.from({length: 100}, () => ({
    text: 'x'.repeat(1400), authority: 'player-claim', witnessed: false, checkpointed: true,
    evidence: ['not-prompt-material'.repeat(1000)],
  }))});
  prepared = await f.router.prepare(f.input);
  const context = conversationContext(prepared.input);
  assert.match(context, /Historical records attributed/); assert.doesNotMatch(context, /not-prompt-material/);
  assert.ok(context.length < 4200);
});
