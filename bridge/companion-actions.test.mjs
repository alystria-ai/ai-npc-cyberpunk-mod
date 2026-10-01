import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {installCompanionActionBinding} from './realtime-host.mjs';
import {CompanionActions, CompanionActionWindow, parseChauffeurOffer,
  publishCompanionActionContext, CHAUFFEUR_ACTION} from './companion-actions.mjs';

const offer = () => ({available: true, actor: {serial: 3, id: '44ULL', key: 'judy'},
  car: {id: '55ULL', record: 'Vehicle.fixture', name: 'Fixture car'}, passengerSeat: 'seat_front_right',
  waypoint: {id: '66', name: 'Custom waypoint', position: {x: 100, y: 200, z: 30}}});
const prepared = () => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy', channel: 'private',
    name: 'Judy', bodyType: 'Woman', text: 'Drive me to the waypoint', chauffeurOffer: offer()}});
function fixture() {
  let now = 10000, current = true, sequence = 0;
  const files = [], broker = new CompanionActions({now: () => now,
    createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      if (options?.isCurrentSync && !options.isCurrentSync()) return false;
      files.push(packet); return true;
    }});
  return {broker, files, advance: value => { now += value; }, stale: () => { current = false; },
    options: {source: 'private-text', isCurrent: async () => current, isCurrentSync: () => current}};
}

test('native offer is bounded, detached and never changes normal input ownership', () => {
  const value = offer(), parsed = parseChauffeurOffer(value);
  assert.deepEqual(parsed, value); value.waypoint.position.x = 900;
  assert.equal(parsed.waypoint.position.x, 100);
  for (const change of [o => o.actor.serial = -1, o => o.car.id = 'arbitrary code',
    o => o.waypoint.position.x = Infinity, o => o.passengerSeat = 'seat_front_left',
    o => o.waypoint.name = 'bad\nname', o => o.car.record = 'x'.repeat(257),
    o => o.waypoint.position.w = 1, o => o.car.id = '5'.repeat(33) + 'ULL']) {
    const bad = offer(); change(bad); assert.equal(parseChauffeurOffer(bad), null);
  }
  const input = prepared().input;
  assert.deepEqual(parseInput(JSON.stringify(input)).chauffeurOffer, offer());
  const bad = {...input, chauffeurOffer: {available: true}};
  const conversation = parseInput(JSON.stringify(bad));
  assert.equal(conversation.requestId, input.requestId); assert.equal(conversation.entity, input.entity);
  assert.equal(conversation.chauffeurOffer, undefined);
});

test('optional host binding admits only its current main frame and becomes inert on reset or close', async () => {
  let current = true, closed = false, handler, called = 0;
  const frame = {}, page = {mainFrame: () => frame, isClosed: () => closed,
    exposeBinding: async (name, callback) => { assert.equal(name, '__convaiCompanionAction'); handler = callback; }};
  const source = {page, frame}, message = {version: 1, token: 'drive-abcdefghijklmnop'};
  await installCompanionActionBinding(page, {isCurrent: () => true});
  assert.equal(handler, undefined, 'phone and other hosts expose no gameplay function');
  await installCompanionActionBinding(page, {isCurrent: () => current, onAction: value => {
    assert.equal(value, message); called++; return true;
  }});
  assert.equal(handler({...source, page: {}}, message), false);
  assert.equal(handler({...source, frame: {}}, message), false);
  assert.equal(handler(source, message), true); assert.equal(called, 1);
  current = false; assert.equal(handler(source, message), false);
  current = true; closed = true; assert.equal(handler(source, message), false); assert.equal(called, 1);
});

test('only an identified current manual private actor gets an action target', async () => {
  for (const change of [p => p.route.channel = 'phone', p => p.route.channel = 'group',
    p => p.input.group = {id: 'group'}, p => p.input.reaction = {phase: 'after'},
    p => p.input.channel = 'phone', p => p.remoteConfig = {}, p => p.identified = false,
    p => p.input.chauffeurOffer.actor.id = '99ULL', p => p.input.chauffeurOffer.actor.key = 'panam',
    p => p.input.requestId = '100-7-44ULL', p => p.input.generation = 9,
    p => p.route.transport = 'microphone']) {
    const {broker, options} = fixture(), p = prepared(); change(p);
    assert.equal(broker.admit(p, options), null);
  }
  const {broker, options} = fixture(), p = prepared(); p.route.transport = 'microphone';
  const config = broker.admit(p, {...options, source: 'private-voice'});
  assert.equal(config.source, 'private-voice');
  assert.equal(broker.configFor({...p.input}), undefined, 'cloned/remapped input cannot borrow the offer');
});

test('delivery reconstructs the frozen native snapshot and consumes a target once', async () => {
  const {broker, options, files} = fixture(), p = prepared();
  const config = broker.admit(p, options);
  p.input.chauffeurOffer.car.id = '999ULL'; p.input.chauffeurOffer.waypoint.position.x = 9000;
  const message = {version: 1, token: config.token};
  assert.equal(await broker.deliver({...message, action: 'arbitrary'}), false);
  assert.deepEqual(await Promise.all([broker.deliver(message), broker.deliver(message)]), [true, false]);
  const packets = files.filter(p => p.action === 'drive-to-waypoint');
  assert.equal(packets.length, 1); assert.equal(packets[0].offer.car.id, '55ULL');
  assert.equal(packets[0].offer.waypoint.position.x, 100);
  assert.equal(packets[0].requestId, '100-4-44ULL'); assert.equal(packets[0].worldGeneration, 2);
  assert.equal(packets[0].expiresAt - packets[0].createdAt, 5000);
});

test('next turn, reset, cancellation, stale guard and expiry each reject old delivery', async () => {
  for (const cause of ['next', 'revoke', 'cancel', 'stale', 'expiry']) {
    const f = fixture(), controller = new AbortController();
    const first = f.broker.admit(prepared(), {...f.options, signal: controller.signal});
    if (cause === 'next') f.broker.admit(prepared(), f.options);
    if (cause === 'revoke') await f.broker.revoke();
    if (cause === 'cancel') controller.abort();
    if (cause === 'stale') f.stale();
    if (cause === 'expiry') f.advance(90001);
    assert.equal(await f.broker.deliver({version: 1, token: first.token}), false, cause);
    assert.equal(f.files.some(p => p.action === 'drive-to-waypoint'), false, cause);
  }
});

test('revocation while an asynchronous guard is pending prevents atomic publication', async () => {
  const f = fixture(); let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = f.broker.admit(prepared(), {...f.options, isCurrent: async () => { await blocked; return true; }});
  const delivery = f.broker.deliver({version: 1, token: first.token});
  await f.broker.revoke(); release();
  assert.equal(await delivery, false); assert.equal(f.files.some(p => p.action === 'drive-to-waypoint'), false);
});

test('a deferred admission clear cannot overwrite its delivered action, while explicit revocation still clears it', async () => {
  const delayed = []; let mailbox;
  const broker = new CompanionActions({now: () => 10000, createToken: () => 'drive-abcdefghijklmnop',
    publish: async (packet, options) => {
      const commit = () => {
        if (options?.isCurrentSync && !options.isCurrentSync()) return false;
        mailbox = packet; return true;
      };
      if (packet.action === 'none') return new Promise(resolve => delayed.push(() => resolve(commit())));
      if (options?.isCurrent && !await options.isCurrent()) return false;
      return commit();
    }});
  const config = broker.admit(prepared(), {source: 'private-text',
    isCurrent: async () => true, isCurrentSync: () => true});
  const message = {version: 1, token: config.token};
  assert.equal(await broker.deliver(message), true);
  assert.equal(mailbox.action, 'drive-to-waypoint');
  delayed.shift()(); await Promise.resolve();
  assert.equal(mailbox.action, 'drive-to-waypoint', 'an old admission clear erased the new action');
  const revoked = broker.revoke();
  delayed.shift()(); assert.equal(await revoked, true);
  assert.equal(mailbox.action, 'none');
  assert.equal(await broker.deliver(message), false);
});

test('browser proposal requires one exact declared target and expires after terminal or late window', () => {
  let now = 10000;
  const window = new CompanionActionWindow({now: () => now});
  const config = {version: 1, token: 'drive-abcdefghijklmnop', source: 'private-text', expiresAt: now + 90000};
  const action = {name: CHAUFFEUR_ACTION, target: config.token};
  assert.equal(window.open(config), true);
  for (const actions of [[], [action, action], [{name: CHAUFFEUR_ACTION}], [{...action, kind: 'tool_call'}],
    [{...action, target: 'drive-oldoldoldoldold1'}], [{...action, name: 'Execute code'}]])
    assert.equal(window.accept({actions}), null);
  assert.deepEqual(window.accept({actions: [action]}), {version: 1, token: config.token});
  assert.equal(window.accept({actions: [action]}), null);
  window.open(config); window.observeOwner({response_id: 'current'});
  window.terminal({response_id: 'old'}); assert.ok(window.current());
  window.terminal({response_id: 'current'}); assert.equal(window.current(), null);
  window.open(config); window.finish(); now += 8001;
  assert.equal(window.accept({actions: [action]}), null);
});

test('pinned SDK context adapter emits one reliable silent legacy update, and can clear all affordances', async () => {
  const packageInfo = JSON.parse(readFileSync(new URL('../node_modules/@convai/web-sdk/package.json', import.meta.url)));
  assert.equal(packageInfo.version, '1.7.0', 'Review the version-pinned action transport before upgrading the SDK');
  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local',
    publishData: async (bytes, options) => sent.push({message: JSON.parse(new TextDecoder().decode(bytes)), options})}}};
  const offer = {token: 'drive-abcdefghijklmnop'};
  await publishCompanionActionContext(client, {text: 'Current native context', mode: 'replace', run_llm: 'true'}, offer);
  assert.equal(sent.length, 1); assert.equal(sent[0].message.type, 'context-update');
  assert.deepEqual(sent[0].options, {reliable: true});
  assert.equal(sent[0].message.data.run_llm, 'false');
  assert.equal(sent[0].message.data.participant_sid, 'local');
  assert.deepEqual(sent[0].message.data.action_config.actions, [CHAUFFEUR_ACTION]);
  assert.equal(sent[0].message.data.action_config.objects[0].name, offer.token);
  await publishCompanionActionContext(client, {text: 'Next ordinary request', mode: 'replace'}, null);
  assert.deepEqual(sent[1].message.data.action_config, {actions: [], objects: [], characters: [], current_attention_object: ''});
  await assert.rejects(publishCompanionActionContext({isBotReady: false}, {}, offer), /unavailable/);
});
