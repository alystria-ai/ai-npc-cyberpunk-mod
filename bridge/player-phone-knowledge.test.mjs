import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PlayerPhoneKnowledge, playerPhoneGeneration} from './player-phone-knowledge.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture({maxPending, maxAgeMs} = {}) {
  let clock = NOW, world = {worldToken: 'loaded-world-1', generation: 1}, resetEpoch = 0;
  const characterEpochs = {'judy-alvarez': 0, 'panam-palmer': 0};
  const ids = {'judy-alvarez': 'judy-id', 'panam-palmer': 'panam-id'};
  const endUserId = 'a6dc0e84-35a8-43c7-bc42-fb5dc776fe39', prepared = [], admitted = new WeakSet();
  const router = {
    getBoundary: () => world && clone(world),
    async prepare(input, boundary) {
      assert.equal(Object.isFrozen(input), true); assert.equal(Object.isFrozen(input.saveIdentity), true);
      assert.equal(boundary.channel, 'phone');
      const guard = {endUserId, characterId: ids[input.profileKey], resetEpoch, characterEpoch: characterEpochs[input.profileKey]};
      const partition = [world, guard, input.profileKey, 'phone'];
      const value = freeze({status: 'ready', sendAllowed: true, input: clone(input),
        route: {profileKey: input.profileKey, channel: 'phone', audience: [input.profileKey]},
        remoteConfig: {endUserId}, guard, scope: `phone:world:${hash(partition).slice(0, 24)}`,
        sessionKey: hash([partition, 'session']), identified: true, localEligible: true,
        worldToken: boundary.worldToken, generation: boundary.generation});
      prepared.push(value); admitted.add(value); return value;
    },
    currentSync(value) {
      return admitted.has(value) && !!world && value.worldToken === world.worldToken && value.generation === world.generation
        && value.guard.resetEpoch === resetEpoch && value.guard.characterEpoch === characterEpochs[value.route.profileKey];
    },
    async current(value) { return this.currentSync(value); },
    beginConversation() { throw Error('Preparing phone context must not enable memory'); },
  };
  const knowledge = new PlayerPhoneKnowledge({router, now: () => clock, maxPending, maxAgeMs});
  const input = {id: 'phone-world-1', contact: 'judy', profileKey: 'judy-alvarez', channel: 'phone',
    text: 'What is our objective?', saveIdentity: {version: 1, status: 'unavailable', authoritative: false, generation: 1},
    worldKnowledge: {version: 1, status: 'unavailable'}};
  return {knowledge, router, input, prepared, endUserId, ids,
    options: () => ({input: clone(input), saveIdentity: clone(input.saveIdentity)}),
    resetCharacter: key => { characterEpochs[key]++; }, resetAll: () => { resetEpoch++; },
    setWorld: value => { world = value; }, advance: value => { clock += value; }};
}

test('the exact player phone route works without native save identity and is consumed once', async () => {
  const f = fixture(), options = f.options(), context = await f.knowledge.prepareContext(options);
  assert.equal(context.status, 'player'); assert.equal(context.endUserId, f.endUserId);
  assert.equal(context.scope, f.prepared[0].scope); assert.equal(context.sessionKey, f.prepared[0].sessionKey);
  assert.equal(context.remoteGeneration, playerPhoneGeneration(f.prepared[0].guard));
  assert.equal(Object.isFrozen(context), true); assert.equal(Object.isFrozen(f.prepared[0].input), true);
  assert.equal(await f.knowledge.current(context), true);
  assert.equal(await f.knowledge.current({...context}), false, 'a copied context cannot inherit the route proof');
  const prepared = await f.knowledge.preparedFor({...options, ...context});
  assert.equal(prepared, f.prepared[0]); assert.equal(prepared.remoteConfig.endUserId, context.endUserId);
  assert.equal(await f.knowledge.current(context), true, 'the final delivery guard survives consumption');
  await assert.rejects(f.knowledge.preparedFor(options), {code: 'REQUEST_NOT_PREPARED'});
  await assert.rejects(f.knowledge.prepareContext(options), {code: 'REQUEST_ALREADY_PREPARED'});
});

test('player ID is constant across contacts, worlds and resets while phone sessions are partitioned', async () => {
  const f = fixture(), one = f.options(), judy = await f.knowledge.prepareContext(one);
  const two = f.options(); two.input.id = 'phone-world-2'; two.input.profileKey = 'panam-palmer'; two.input.contact = 'panam';
  const panam = await f.knowledge.prepareContext(two);
  assert.equal(judy.endUserId, panam.endUserId); assert.notEqual(judy.sessionKey, panam.sessionKey);
  f.resetCharacter('judy-alvarez');
  assert.equal(await f.knowledge.current(judy), false); assert.equal(await f.knowledge.current(panam), true);
  const three = f.options(); three.input.id = 'phone-world-3';
  const forgotten = await f.knowledge.prepareContext(three);
  assert.equal(forgotten.endUserId, judy.endUserId); assert.notEqual(forgotten.remoteGeneration, judy.remoteGeneration);
  assert.notEqual(forgotten.scope, judy.scope); assert.notEqual(forgotten.sessionKey, judy.sessionKey);
  f.setWorld({worldToken: 'loaded-world-2', generation: 2});
  const four = f.options(); four.input.id = 'phone-world-4'; four.input.saveIdentity.generation = 2; four.saveIdentity.generation = 2;
  const reloaded = await f.knowledge.prepareContext(four);
  assert.equal(reloaded.endUserId, forgotten.endUserId); assert.notEqual(reloaded.scope, forgotten.scope);
  f.resetAll(); assert.equal(await f.knowledge.current(reloaded), false); assert.equal(await f.knowledge.current(panam), false);
});

test('changed request data or routing fields cannot borrow another prepared route', async t => {
  for (const [name, mutate] of [
    ['text', value => { value.input.text = 'A different question'; }],
    ['profile', value => { value.input.profileKey = 'panam-palmer'; }],
    ['contact', value => { value.input.contact = 'panam'; }],
    ['ID', value => { value.input.id = 'phone-world-2'; }],
    ['context', value => { value.input.worldKnowledge.reason = 'changed'; }],
    ['binding', value => { value.input.saveIdentity.generation = 2; value.saveIdentity.generation = 2; }],
    ['player', value => { value.endUserId = 'another-player'; }],
    ['scope', value => { value.scope = `phone:world:${'b'.repeat(24)}`; }],
    ['session', value => { value.sessionKey = 'e'.repeat(64); }],
    ['reset epoch', value => { value.remoteGeneration = 'f'.repeat(64); }],
  ]) await t.test(name, async () => {
    const f = fixture(), options = f.options(), context = await f.knowledge.prepareContext(options), changed = {...clone(options), ...context};
    mutate(changed);
    await assert.rejects(f.knowledge.preparedFor(changed), {code: 'REQUEST_NOT_PREPARED'});
    assert.equal(await f.knowledge.preparedFor({...options, ...context}), f.prepared[0]);
  });
});

test('caller mutation while projection awaits cannot change the frozen request or binding', async () => {
  const f = fixture(), gate = defer(), entered = defer(), prepare = f.router.prepare;
  f.router.prepare = async (...args) => { entered.resolve(); await gate.promise; return prepare(...args); };
  const options = f.options(), untouched = clone(options), pending = f.knowledge.prepareContext(options);
  await entered.promise;
  options.input.text = 'Mutated'; options.input.profileKey = 'panam-palmer'; options.input.saveIdentity.generation = 99;
  options.saveIdentity.generation = 99; options.input.worldKnowledge.reason = 'mutated';
  gate.resolve(); const context = await pending;
  const prepared = await f.knowledge.preparedFor({...untouched, ...context});
  assert.equal(prepared.input.text, untouched.input.text); assert.equal(prepared.input.profileKey, 'judy-alvarez');
  assert.deepEqual(prepared.input.saveIdentity, untouched.saveIdentity);
  assert.equal(prepared.input.worldKnowledge.reason, undefined);
});

test('world or reset changes during preparation and final claim invalidate the old route', async t => {
  await t.test('world changes during preparation', async () => {
    const f = fixture(), gate = defer(), entered = defer(), prepare = f.router.prepare;
    f.router.prepare = async (...args) => { const value = await prepare(...args); entered.resolve(); await gate.promise; return value; };
    const options = f.options(), pending = f.knowledge.prepareContext(options); await entered.promise;
    f.setWorld({worldToken: 'another-world', generation: 2}); gate.resolve();
    await assert.rejects(pending, {code: 'WORLD_CHANGED'});
    await assert.rejects(f.knowledge.preparedFor(options), {code: 'REQUEST_NOT_PREPARED'});
  });
  await t.test('reset changes during preparation', async () => {
    const f = fixture(), gate = defer(), entered = defer(), prepare = f.router.prepare;
    f.router.prepare = async (...args) => { const value = await prepare(...args); entered.resolve(); await gate.promise; return value; };
    const options = f.options(), pending = f.knowledge.prepareContext(options); await entered.promise;
    f.resetAll(); gate.resolve(); await assert.rejects(pending, {code: 'MEMORY_ROUTE_CHANGED'});
  });
  await t.test('reset after route selection', async () => {
    const f = fixture(), options = f.options(); await f.knowledge.prepareContext(options);
    f.resetCharacter('judy-alvarez'); await assert.rejects(f.knowledge.preparedFor(options), {code: 'MEMORY_ROUTE_CHANGED'});
  });
  await t.test('world changes while awaiting final guard', async () => {
    const f = fixture(), options = f.options(); await f.knowledge.prepareContext(options);
    f.router.current = async () => { f.setWorld({worldToken: 'new-world', generation: 1}); return true; };
    await assert.rejects(f.knowledge.preparedFor(options), {code: 'WORLD_CHANGED'});
  });
});

test('unavailable or mismatched live boundary prevents a route, independently of native identity', async () => {
  const f = fixture(); f.setWorld(null);
  await assert.rejects(f.knowledge.prepareContext(f.options()), {code: 'WORLD_UNAVAILABLE'});
  assert.equal(f.prepared.length, 0);
  const other = fixture(), options = other.options(); options.input.saveIdentity.generation = 2; options.saveIdentity.generation = 2;
  await assert.rejects(other.knowledge.prepareContext(options), {code: 'WORLD_CHANGED'}); assert.equal(other.prepared.length, 0);
});

test('route profile, channel, input, player, scope and boundary must match the selected request', async t => {
  for (const [name, mutate] of [
    ['profile', value => { value.route.profileKey = 'panam-palmer'; }],
    ['audience', value => { value.route.audience = ['judy-alvarez', 'panam-palmer']; }],
    ['channel', value => { value.route.channel = 'private'; }],
    ['text', value => { value.input.text = 'Other input'; }],
    ['player', value => { value.remoteConfig.endUserId = 'another-player'; }],
    ['scope', value => { value.scope = `private:world:${'a'.repeat(24)}`; }],
    ['session', value => { value.sessionKey = 'bad'; }],
    ['boundary', value => { value.worldToken = 'another-world'; }],
    ['unavailable route', value => { value.status = 'unavailable'; value.sendAllowed = false; }],
  ]) await t.test(name, async () => {
    const f = fixture(), prepare = f.router.prepare;
    f.router.prepare = async (...args) => { const value = clone(await prepare(...args)); mutate(value); return freeze(value); };
    f.router.current = async () => true;
    await assert.rejects(f.knowledge.prepareContext(f.options()), {code: 'MEMORY_ROUTE_CHANGED'});
  });
});

test('cancellation, bounded pending routes and concurrent claims preserve one ownership proof', async () => {
  const f = fixture({maxPending: 2, maxAgeMs: 100}), controller = new AbortController();
  const one = {...f.options(), signal: controller.signal}, context = await f.knowledge.prepareContext(one);
  await assert.rejects(f.knowledge.preparedFor({...one, signal: new AbortController().signal}), {code: 'REQUEST_NOT_PREPARED'});
  controller.abort(); assert.equal(await f.knowledge.current(context), false);
  await assert.rejects(f.knowledge.preparedFor(one), {name: 'AbortError'});
  const two = f.options(); two.input.id = 'phone-world-2'; const three = f.options(); three.input.id = 'phone-world-3';
  const four = f.options(); four.input.id = 'phone-world-4';
  await f.knowledge.prepareContext(two); await f.knowledge.prepareContext(three); await f.knowledge.prepareContext(four);
  await assert.rejects(f.knowledge.preparedFor(two), {code: 'REQUEST_NOT_PREPARED'});
  const attempts = await Promise.allSettled([f.knowledge.preparedFor(three), f.knowledge.preparedFor(three)]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  f.advance(101); await assert.rejects(f.knowledge.preparedFor(four), {code: 'REQUEST_NOT_PREPARED'});
  const five = f.options(); five.input.id = 'phone-world-5'; const final = await f.knowledge.prepareContext(five);
  await f.knowledge.preparedFor(five); f.knowledge.clear(); assert.equal(await f.knowledge.current(final), false);
});

test('real PhoneChat uses one exact player route and keeps per-contact phone sessions transient', async () => {
  const f = fixture(), calls = [], output = [], writes = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}, {contact: 'panam', key: 'panam-palmer'}], ids: f.ids,
    now: () => NOW, publish: async value => output.push(value), saveSessions: async value => writes.push(value),
    contextFor: options => f.knowledge.prepareContext(options), contextCurrent: context => f.knowledge.current(context),
    contextCurrentSync: context => f.knowledge.currentSync(context),
    reply: async options => {
      const prepared = await f.knowledge.preparedFor(options); calls.push(options);
      assert.equal(options.endUserId, prepared.remoteConfig.endUserId); assert.equal(options.scope, prepared.scope);
      assert.equal(options.sessionKey, prepared.sessionKey); assert.equal(options.remoteGeneration, playerPhoneGeneration(prepared.guard));
      return {text: 'Hey V.', sessionID: `phone-session-${calls.length}`};
    }});
  async function send(id, contact = 'judy', generation = 1, world = 'phone-world') {
    const saveIdentity = {version: 1, status: 'unavailable', generation};
    await chat.accept({version: 2, world, updated: NOW, active: true, saveIdentity,
      request: {id: `${world}-${id}`, contact, text: 'Hello', saveIdentity}});
    await chat.active?.work;
  }
  await send(1); await send(2, 'panam'); await send(3);
  assert.deepEqual(calls.map(value => value.sessionId), ['-1', '-1', 'phone-session-1']);
  assert.equal(new Set(calls.map(value => value.endUserId)).size, 1); assert.equal(writes.length, 0);
  f.resetCharacter('judy-alvarez'); await send(4); await send(5, 'panam');
  assert.equal(calls[3].sessionId, '-1'); assert.equal(calls[4].sessionId, 'phone-session-2');
  f.setWorld({worldToken: 'loaded-world-2', generation: 2}); await send(1, 'judy', 2, 'phone-world-new');
  assert.equal(calls[5].sessionId, '-1'); assert.equal(calls[5].endUserId, calls[0].endUserId);
  assert.equal(output.filter(value => value.state === 'reply').length, 6);
});

test('forgetting after consumption blocks a late phone reply from the contact history and session cache', async () => {
  const f = fixture(), entered = defer(), result = defer(), output = [], calls = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: f.ids, now: () => NOW,
    publish: async value => output.push(value), contextFor: options => f.knowledge.prepareContext(options),
    contextCurrent: context => f.knowledge.current(context), contextCurrentSync: context => f.knowledge.currentSync(context), reply: async options => {
      await f.knowledge.preparedFor(options); calls.push(options); entered.resolve(); return result.promise;
    }});
  const saveIdentity = {version: 1, status: 'unavailable', generation: 1};
  await chat.accept({version: 2, world: 'phone-world', updated: NOW, active: true, saveIdentity,
    request: {id: 'phone-world-1', contact: 'judy', text: 'Hello', saveIdentity}});
  const work = chat.active.work; await entered.promise;
  f.resetCharacter('judy-alvarez'); result.resolve({text: 'Obsolete memory reply', sessionID: 'obsolete'}); await work;
  assert.equal(calls.length, 1); assert.equal(output.filter(value => value.state === 'reply').length, 0);
  assert.equal(chat.transientSessions.size, 0);
});

test('real PhoneChat passes a synchronous publication fence that blocks changes after the async guard succeeds', async () => {
  for (const change of ['none', 'character', 'all', 'world', 'cancel']) {
    const f = fixture(), entered = defer(), commit = defer(), output = [], blocked = [];
    let context, publication;
    const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: f.ids, now: () => NOW,
      contextFor: async options => { context = await f.knowledge.prepareContext(options); return context; },
      contextCurrent: value => f.knowledge.current(value), contextCurrentSync: value => f.knowledge.currentSync(value),
      reply: async options => {
        await f.knowledge.preparedFor(options);
        return {text: 'Prepared phone reply', sessionID: 'prepared-phone-session'};
      },
      publish: async (value, options) => {
        assert.equal(typeof options.isCurrentSync, 'function');
        if (value.state === 'reply') {
          assert.equal(await options.isCurrent(), true);
          assert.equal(options.isCurrentSync(), true);
          publication = options; entered.resolve();
          await commit.promise; // The file write completed; its commit must recheck synchronously.
        }
        if (options.isCurrentSync()) output.push(value);
        else blocked.push(value);
      }});
    const saveIdentity = {version: 1, status: 'unavailable', generation: 1};
    await chat.accept({version: 2, world: 'phone-world', updated: NOW, active: true, saveIdentity,
      request: {id: 'phone-world-1', contact: 'judy', text: 'Hello', saveIdentity}});
    const work = chat.active.work; await entered.promise;
    assert.equal(f.knowledge.currentSync(context), true, 'a consumed route keeps its delivery guard');
    if (change === 'character') f.resetCharacter('judy-alvarez');
    else if (change === 'all') f.resetAll();
    else if (change === 'world') f.setWorld({worldToken: 'loaded-world-2', generation: 1});
    else if (change === 'cancel') chat.close();
    assert.equal(f.knowledge.currentSync(context), change === 'none', change + ' must immediately fence the route');
    assert.equal(publication.isCurrentSync(), change === 'none', change + ' must immediately fence the final commit');
    commit.resolve(); await work;
    assert.equal(output.filter(value => value.state === 'reply').length, change === 'none' ? 1 : 0, change);
    assert.equal(blocked.filter(value => value.state === 'reply').length, change === 'none' ? 0 : 1, change);
  }
});

test('real PlayerKnowledge supplies current phone facts with unknown native identity and no memory writes', async () => {
  const endUserId = '6e9e4d35-2cc1-4093-89b1-65970e9d9dbd', forbidden = [];
  let characterEpoch = 0;
  const playerMemory = {
    route(profileKey, options) {
      assert.equal(profileKey, 'judy-alvarez'); assert.equal(options.channel, 'phone');
      assert.deepEqual(options.audience, ['judy-alvarez']);
      return {endUserId, guard: {endUserId, characterId: 'judy-id', resetEpoch: 0, characterEpoch}};
    },
    isCurrent: guard => guard.endUserId === endUserId && guard.characterEpoch === characterEpoch,
    beginConversation() { forbidden.push('enable'); }, addMemory() { forbidden.push('seed'); },
    recordActivity() { forbidden.push('ledger'); },
  };
  const pack = {version: 1, id: 'phone-current-world', revision: 1, gameVersions: ['2.31'], profileKeys: ['judy-alvarez'],
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source',
      locator: 'branch 123 -> scene 456', gameVersions: ['2.31']}],
    factAllowlist: {choice_a: {evidenceRefs: ['native-branch']}}, journalAllowlist: {}, rules: [{
      id: 'choice.public', topic: 'choice.public', statement: 'V took the verified route.', revision: 1,
      questKey: 'the-choice', outcome: 'a', status: 'source-verified', reviewed: true, gameVersions: ['2.31'],
      category: 'decision', priority: 5, stable: true, sourceIds: ['native-source'], evidenceRefs: ['native-branch'],
      condition: {type: 'fact', key: 'choice_a', op: 'eq', value: 1},
      audience: {speakers: 'all', perspective: 'shared-journal', channels: ['phone'], recipients: 'all'},
    }]};
  const router = new PlayerKnowledge({playerMemory, pack, now: () => NOW,
    getBoundary: () => ({worldToken: 'loaded-world-1', generation: 1})});
  const knowledge = new PlayerPhoneKnowledge({router, now: () => NOW}), saveIdentity = {version: 1, status: 'unavailable', generation: 1};
  const options = {saveIdentity, input: {id: 'phone-world-1', contact: 'judy', profileKey: 'judy-alvarez', channel: 'phone',
    text: 'Which route did I take?', saveIdentity: clone(saveIdentity), worldKnowledge: {version: 1, status: 'ready',
      gameVersion: '2.31', generation: 1, worldToken: 'loaded-world-1', capturedAt: new Date(NOW).toISOString(),
      identity: {status: 'unknown'}, audience: {channel: 'phone', profileKeys: ['judy-alvarez']},
      activeQuestKeys: ['the-choice'], facts: {choice_a: {status: 'known', present: true, value: 1,
        sourceId: 'native-capture', evidenceRefs: ['capture:1:observation']}}, journal: {}}}};
  const context = await knowledge.prepareContext(options), prepared = await knowledge.preparedFor({...options, ...context});
  assert.equal(context.endUserId, endUserId); assert.match(conversationContext(prepared.input), /V took the verified route/);
  assert.equal(knowledge.currentSync(context), true);
  assert.equal(Object.isFrozen(prepared.guard), true); assert.deepEqual(forbidden, []);
  await router.submitted(prepared); await router.activity(prepared, 'generated-reply');
  assert.deepEqual(forbidden, [], 'guard-only wrappers do not enable, seed or record memory');
  characterEpoch++; assert.equal(knowledge.currentSync(context), false); assert.equal(await knowledge.current(context), false);
});
