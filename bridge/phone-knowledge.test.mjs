import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeRouter} from './conversation-knowledge.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {PhoneKnowledge} from './phone-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const clone = value => structuredClone(value);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function fixture({identifiedEnabled = true, native = true, maxPending, maxAgeMs} = {}) {
  let clock = NOW;
  const owner = {status: 'verified', authoritative: true, userId: 'user-1', campaignId: 'a'.repeat(32),
    playthroughId: 'a'.repeat(32), branchId: 'b'.repeat(32), activationId: 'c'.repeat(32),
    generation: 4, worldGeneration: 7, worldToken: '4:activation:branch', remoteGeneration: 'memory-generation-1'};
  if (!native) { owner.status = 'unavailable'; owner.authoritative = false; }
  const saveIdentity = {version: 1, status: 'available', authoritative: true, confidence: 'native-live',
    localUserId: owner.userId, campaignId: owner.campaignId, branchId: owner.branchId,
    activationId: owner.activationId, branchEpoch: 1, ledgerSequence: 0, generation: owner.worldGeneration};
  let boundary = {worldToken: owner.worldToken, generation: owner.worldGeneration};
  const guard = {epoch: 1, generation: owner.generation, worldGeneration: owner.worldGeneration,
    activationId: owner.activationId, branchId: owner.branchId, userId: owner.userId};
  const projects = [], memories = [], prepared = [], activities = [];
  const remote = profile => ({endUserId: `remote-${profile}`, endUserMetadata: {channel: 'phone'}});
  const service = {
    get saveIdentity() { return clone(owner); },
    isCurrent: value => owner.status === 'verified' && owner.authoritative === true && JSON.stringify(value) === JSON.stringify(guard),
    async current(value) { return this.isCurrent(value); },
    async project(value) {
      projects.push(value);
      return value.snapshot?.status === 'ready'
        ? {saveIdentity: clone(owner), guard: this.isCurrent(guard) ? clone(guard) : null,
          remoteConfig: this.isCurrent(guard) ? remote(value.profileKey) : null,
          knowledgeContext: 'A verified current-save detail.'}
        : {knowledgeContext: '', memoryReason: 'capture-unavailable'};
    },
    ledger: {contextFor(value) {
      memories.push(clone(value));
      return {status: 'available', identity: clone(owner), characterKey: value.characterKey, channel: value.channel,
        endUserId: remote(value.characterKey).endUserId, episodes: []};
    }},
    async recordActivity(value) {
      activities.push(clone(value));
      return this.isCurrent(value.guard) ? {status: 'recorded', sendAllowed: value.kind === 'submitted-input',
        guard: clone(guard), ...(value.kind === 'generated-reply' ? {replyHash: 'd'.repeat(64)} : {})}
        : {status: 'unavailable', sendAllowed: false};
    },
  };
  const router = new KnowledgeRouter({service, identifiedEnabled, now: () => clock,
    isWorldCurrent: value => value.worldToken === boundary.worldToken && value.generation === boundary.generation});
  const prepare = router.prepare.bind(router);
  router.prepare = async (...args) => { const value = await prepare(...args); prepared.push(value); return value; };
  const knowledge = new PhoneKnowledge({router, service, getBoundary: () => boundary, now: () => clock, maxPending, maxAgeMs});
  const input = {id: 'phone-world-1', contact: 'judy', profileKey: 'judy-alvarez', channel: 'phone', text: 'What is our objective?',
    saveIdentity: clone(saveIdentity), worldKnowledge: {version: 1, status: 'ready', gameVersion: '2.31',
      generation: boundary.generation, worldToken: boundary.worldToken, capturedAt: new Date(clock).toISOString(),
      identity: {status: 'unknown'}, audience: {channel: 'phone', profileKeys: ['judy-alvarez']}, facts: {}, journal: {}}};
  return {knowledge, router, service, input, saveIdentity, projects, memories, prepared, activities, owner,
    options: () => ({input: clone(input), saveIdentity: clone(saveIdentity)}),
    setBoundary: value => { boundary = value; },
    advance: value => { clock += value; }};
}

test('one prepared identified route controls both phone session selection and the eventual trusted input', async () => {
  const f = fixture(), options = f.options();
  const context = await f.knowledge.prepareContext(options);
  assert.equal(context.status, 'available');
  assert.equal(context.endUserId, 'remote-judy-alvarez');
  const prepared = await f.knowledge.preparedFor(options);
  assert.equal(prepared, f.prepared[0]);
  assert.equal(prepared.identified, true);
  assert.equal(prepared.remoteConfig.endUserId, context.endUserId);
  assert.match(conversationContext(prepared.input), /verified current-save detail/);
  assert.equal(Object.isFrozen(prepared.input), true);
  assert.equal(f.projects.length, 1);
  await assert.rejects(f.knowledge.preparedFor(options), {code: 'REQUEST_NOT_PREPARED'});
});

test('real PhoneChat sends valid text anonymously when optional capture is unavailable or malformed', async t => {
  for (const capture of [undefined, {version: 1, status: 'unavailable'}, {version: 1, status: 'ready', generation: 'bad'}]) {
    await t.test(String(capture?.status ?? 'absent'), async () => {
      const f = fixture(), output = [], calls = [];
      const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'},
        now: () => NOW, publish: async value => output.push(value),
        contextFor: options => f.knowledge.prepareContext(options),
        reply: async options => {
          const prepared = await f.knowledge.preparedFor(options);
          assert.equal(options.endUserId, undefined);
          assert.equal(prepared.remoteConfig, null);
          assert.equal(prepared.identified, false);
          assert.equal(options.sessionId, '-1');
          assert.equal(prepared.input.text, 'What is our objective?');
          calls.push(prepared); return {text: 'We can check the journal.', sessionID: 'anonymous-session'};
        }});
      await chat.accept({version: 2, world: 'phone-world', updated: NOW, active: true, saveIdentity: f.saveIdentity,
        request: {id: f.input.id, contact: 'judy', text: f.input.text, saveIdentity: f.saveIdentity, worldKnowledge: capture}});
      await chat.active?.work;
      assert.equal(output.at(-1).state, 'reply');
      assert.equal(calls.length, 1); assert.equal(f.projects.length, 1);
      assert.equal(f.memories.length, 0, 'an unavailable capture must not read persistent local history');
    });
  }
});

test('a mismatched optional phone audience is downgraded before the single route is selected', async () => {
  const f = fixture(), output = [], routes = [];
  const input = clone(f.input); input.worldKnowledge.audience.profileKeys = ['panam-palmer'];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'},
    now: () => NOW, publish: async value => output.push(value), contextFor: options => f.knowledge.prepareContext(options),
    reply: async options => { routes.push(await f.knowledge.preparedFor(options)); return {text: 'Hey V.', sessionID: 'anonymous'}; }});
  await chat.accept({version: 2, world: 'phone-world', updated: NOW, active: true, saveIdentity: f.saveIdentity, request: input});
  await chat.active?.work;
  assert.equal(output.at(-1).state, 'reply');
  assert.equal(routes[0].identified, false); assert.equal(f.projects.length, 1); assert.equal(f.memories.length, 0);
});

test('provider-disabled phone transport retains only its verified scoped local history and activity', async () => {
  const f = fixture({identifiedEnabled: false}), options = f.options();
  const contextFor = f.service.ledger.contextFor;
  f.service.ledger.contextFor = value => ({...contextFor(value), endUserId: 'cp2077-local-phone-scope',
    episodes: [{text: `Local phone history for ${value.characterKey}.`, authority: 'player-claim',
      witnessed: false, checkpointed: true}]});
  const selection = await f.knowledge.prepareContext(options);
  assert.equal(selection.status, 'unavailable'); assert.equal(selection.endUserId, undefined);
  const prepared = await f.knowledge.preparedFor(options);
  assert.equal(prepared.remoteConfig, null); assert.equal(prepared.identified, false); assert.equal(prepared.localEligible, true);
  assert.equal(f.memories.length, 1);
  assert.deepEqual(f.memories[0], {characterKey: 'judy-alvarez', channel: 'phone',
    audience: ['judy-alvarez'], limit: 8, maxChars: 2400});
  assert.match(conversationContext(prepared.input), /Local phone history for judy-alvarez/);
  assert.doesNotMatch(conversationContext(prepared.input), /panam|cp2077-local-phone-scope/);
  assert.equal((await f.router.submitted(prepared)).sendAllowed, true);
  await f.router.activity(prepared, 'generated-reply', {replyText: 'Remember what we talked about?'});
  await f.router.activity(prepared, 'delivered-reply', {source: 'phone-ui', state: 'accepted', requestId: options.input.id});
  assert.deepEqual(f.activities.map(row => row.kind), ['submitted-input', 'generated-reply', 'delivered-reply']);
  for (const activity of f.activities) {
    assert.equal(activity.profileKey, 'judy-alvarez'); assert.equal(activity.channel, 'phone');
    assert.deepEqual(activity.audience, ['judy-alvarez']); assert.deepEqual(activity.guard, prepared.guard);
    assert.equal(activity.requestId, options.input.id);
  }
  assert.equal(f.activities[0].userText, options.input.text);
  assert.equal(f.activities[2].delivery.replyHash, 'd'.repeat(64));
});

test('missing or unverified native identity cannot read phone history or create local activity', async t => {
  for (const state of ['unavailable', 'unverified']) await t.test(state, async () => {
    const f = fixture({native: false}), options = f.options();
    f.owner.status = state;
    options.saveIdentity = {version: 1, status: 'unavailable'};
    options.input.saveIdentity = clone(options.saveIdentity);
    const selection = await f.knowledge.prepareContext(options);
    const prepared = await f.knowledge.preparedFor(options);
    assert.equal(selection.status, 'unavailable'); assert.equal(selection.endUserId, undefined);
    assert.equal(prepared.remoteConfig, null); assert.equal(prepared.guard, null);
    assert.equal(prepared.localEligible, false); assert.equal(prepared.identified, false);
    assert.match(conversationContext(prepared.input), /verified current-save detail/);
    assert.doesNotMatch(conversationContext(prepared.input), /Historical records attributed/);
    assert.equal((await f.router.submitted(prepared)).sendAllowed, true);
    await f.router.activity(prepared, 'generated-reply', {replyText: 'A current reply.'});
    await f.router.activity(prepared, 'delivered-reply', {source: 'phone-ui', state: 'accepted', requestId: options.input.id});
    assert.equal(f.memories.length, 0); assert.equal(f.activities.length, 0);
  });
});

test('changed text, recipient, context, request ID or save binding cannot borrow a prepared route', async t => {
  for (const [name, mutate] of [
    ['text', value => { value.input.text = 'A different question'; }],
    ['profile', value => { value.input.profileKey = 'panam-palmer'; }],
    ['contact', value => { value.input.contact = 'panam'; }],
    ['ID', value => { value.input.id = 'other-phone-world-1'; }],
    ['context', value => { value.input.worldKnowledge.facts = {different: {value: 1}}; }],
    ['user', value => { value.saveIdentity.localUserId = 'user-2'; value.input.saveIdentity = clone(value.saveIdentity); }],
    ['branch', value => { value.saveIdentity.branchId = 'd'.repeat(32); value.input.saveIdentity = clone(value.saveIdentity); }],
    ['activation', value => { value.saveIdentity.activationId = 'e'.repeat(32); value.input.saveIdentity = clone(value.saveIdentity); }],
  ]) await t.test(name, async () => {
    const f = fixture(), original = f.options(); await f.knowledge.prepareContext(original);
    const changed = clone(original); mutate(changed);
    await assert.rejects(f.knowledge.preparedFor(changed), {code: 'REQUEST_NOT_PREPARED'});
    assert.equal(await f.knowledge.preparedFor(original), f.prepared[0]);
  });
});

test('caller mutation while projection awaits cannot change the prepared route or question', async () => {
  const f = fixture(), gate = defer(), entered = defer(), original = f.service.project;
  f.service.project = async value => { entered.resolve(); await gate.promise; return original(value); };
  const options = f.options(), untouched = clone(options), pending = f.knowledge.prepareContext(options);
  await entered.promise;
  options.input.text = 'Mutated'; options.input.profileKey = 'panam-palmer'; options.saveIdentity.localUserId = 'user-2';
  gate.resolve(); await pending;
  const route = await f.knowledge.preparedFor(untouched);
  assert.equal(route.input.text, untouched.input.text); assert.equal(route.input.profileKey, 'judy-alvarez');
});

test('world changes during projection, after selection, or during the final guard check reject the old request', async t => {
  await t.test('projection', async () => {
    const f = fixture(), gate = defer(), entered = defer(), original = f.service.project;
    f.service.project = async value => { entered.resolve(); await gate.promise; return original(value); };
    const options = f.options(), pending = f.knowledge.prepareContext(options);
    await entered.promise; f.setBoundary({worldToken: 'new-world', generation: 8}); gate.resolve();
    await assert.rejects(pending, {code: 'WORLD_CHANGED'});
    await assert.rejects(f.knowledge.preparedFor(options), {code: 'REQUEST_NOT_PREPARED'});
  });
  await t.test('selected', async () => {
    const f = fixture(), options = f.options(); await f.knowledge.prepareContext(options);
    f.setBoundary({worldToken: f.owner.worldToken, generation: 8});
    await assert.rejects(f.knowledge.preparedFor(options), {code: 'WORLD_CHANGED'});
  });
  await t.test('awaiting guard', async () => {
    const f = fixture(), options = f.options(); await f.knowledge.prepareContext(options);
    f.router.current = async () => { f.setBoundary({worldToken: 'next-world', generation: 7}); return true; };
    await assert.rejects(f.knowledge.preparedFor(options), {code: 'WORLD_CHANGED'});
  });
});

test('cancellation during projection or a later signal cannot adopt the phone receipt', async () => {
  const f = fixture(), gate = defer(), entered = defer(), original = f.service.project;
  f.service.project = async value => { entered.resolve(); await gate.promise; return original(value); };
  const controller = new AbortController(), options = {...f.options(), signal: controller.signal};
  const pending = f.knowledge.prepareContext(options); await entered.promise;
  controller.abort(); gate.resolve(); await assert.rejects(pending, {name: 'AbortError'});
  const other = fixture(), one = new AbortController(), two = new AbortController();
  const selected = {...other.options(), signal: one.signal}; await other.knowledge.prepareContext(selected);
  await assert.rejects(other.knowledge.preparedFor({...selected, signal: two.signal}), {code: 'REQUEST_NOT_PREPARED'});
  one.abort(); await assert.rejects(other.knowledge.preparedFor(selected), {name: 'AbortError'});
});

test('an identified route cannot expose a different ledger user, profile or namespace', async t => {
  for (const [name, mutate] of [
    ['user', value => { value.identity.userId = 'another-user'; }],
    ['profile', value => { value.characterKey = 'panam-palmer'; }],
    ['namespace', value => { value.endUserId = 'other-end-user'; }],
  ]) await t.test(name, async () => {
    const f = fixture(), original = f.service.ledger.contextFor;
    f.service.ledger.contextFor = value => { const context = original(value); mutate(context); return context; };
    await assert.rejects(f.knowledge.prepareContext(f.options()), {code: 'MEMORY_ROUTE_CHANGED'});
  });
});

test('pending preparations are bounded, expire, and can be consumed only once even concurrently', async () => {
  const f = fixture({maxPending: 2, maxAgeMs: 100}), first = f.options(), second = f.options(), third = f.options();
  second.input.id = 'phone-world-2'; third.input.id = 'phone-world-3';
  await f.knowledge.prepareContext(first); await f.knowledge.prepareContext(second); await f.knowledge.prepareContext(third);
  await assert.rejects(f.knowledge.preparedFor(first), {code: 'REQUEST_NOT_PREPARED'});
  const attempts = await Promise.allSettled([f.knowledge.preparedFor(second), f.knowledge.preparedFor(second)]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  f.advance(101); await assert.rejects(f.knowledge.preparedFor(third), {code: 'REQUEST_NOT_PREPARED'});
  const fourth = f.options(); fourth.input.id = 'phone-world-4'; await f.knowledge.prepareContext(fourth);
  f.knowledge.clear(); await assert.rejects(f.knowledge.preparedFor(fourth), {code: 'REQUEST_NOT_PREPARED'});
});
