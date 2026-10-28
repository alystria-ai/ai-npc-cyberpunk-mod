import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {installCompanionActionBinding} from './realtime-host.mjs';
import {CompanionActions, CompanionActionWindow, parseChauffeurOffer,
  publishCompanionActionContext, CHAUFFEUR_ACTION, chauffeurActionName} from './companion-actions.mjs';

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

test('real parsed game input gains its private channel through knowledge preparation before action admission', async () => {
  const nativeInput = structuredClone(prepared().input); delete nativeInput.channel;
  const parsed = parseInput(JSON.stringify(nativeInput));
  assert.equal(parsed.channel, undefined, 'the native request should not fabricate the derived channel');
  const boundary = {worldToken: 'world-fixture', generation: 2};
  const guard = {endUserId: 'fixture-user', characterId: 'fixture-character', resetEpoch: 0, characterEpoch: 0};
  const router = new PlayerKnowledge({
    playerMemory: {route: () => ({endUserId: guard.endUserId, guard}), isCurrent: value => JSON.stringify(value) === JSON.stringify(guard)},
    pack: {version: 1, id: 'actions-routing-fixture', revision: 1, gameVersions: ['2.31'], profileKeys: ['judy'],
      sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    getBoundary: () => boundary, isWorldCurrent: () => true,
  });
  const actual = await router.prepare(parsed, boundary);
  assert.equal(actual.input.channel, 'private'); assert.equal(actual.route.channel, 'private');
  assert.equal(actual.route.transport, 'private'); assert.equal(actual.identified, true);
  assert.deepEqual(actual.input.chauffeurOffer, nativeInput.chauffeurOffer);
  const {broker} = fixture();
  const admitted = broker.admit(actual, {source: 'private-text',
    isCurrent: () => router.current(actual), isCurrentSync: () => router.currentSync(actual)});
  assert.ok(admitted); assert.ok(broker.configFor(actual.input));
});

test('delivery reconstructs the frozen native snapshot and consumes a target once', async () => {
  const {broker, options, files} = fixture(), p = prepared();
  const config = broker.admit(p, options);
  p.input.chauffeurOffer.car.id = '999ULL'; p.input.chauffeurOffer.waypoint.position.x = 9000;
  p.input.chauffeurOffer.car.name = 'Changed car'; p.input.chauffeurOffer.waypoint.name = 'Changed route';
  assert.equal(broker.configFor(p.input).carName, 'Fixture car');
  assert.equal(broker.configFor(p.input).destinationName, 'Custom waypoint');
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

test('browser proposal requires one exact request capability and expires after terminal or late window', () => {
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

test('targetless legacy actions are accepted only when their advertised name carries the current one-use token', () => {
  let now = 10000;
  const window = new CompanionActionWindow({now: () => now});
  const current = {version: 1, token: 'drive-abcdefghijklmnop', source: 'private-text', expiresAt: now + 90000};
  const old = {...current, token: 'drive-stalestalestalestale'};
  window.open(current);
  for (const action of [{name: CHAUFFEUR_ACTION}, {name: chauffeurActionName(old)},
    {name: chauffeurActionName(current), target: old.token},
    {name: chauffeurActionName(current), kind: 'tool_call'},
    {name: chauffeurActionName(current), arguments: {} }])
    assert.equal(window.accept({actions: [action]}), null);
  assert.deepEqual(window.accept({actions: [{name: chauffeurActionName(current)}]}), {version: 1, token: current.token});
  assert.equal(window.accept({actions: [{name: chauffeurActionName(current)}]}), null);
  for (const target of [null, '', current.token]) {
    window.open(current);
    assert.deepEqual(window.accept({actions: [{name: chauffeurActionName(current), target}]}), {version: 1, token: current.token});
  }
  window.open(current); now += 90001;
  assert.equal(window.accept({actions: [{name: chauffeurActionName(current)}]}), null);
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
  assert.deepEqual(sent[0].message.data.action_config.actions, [chauffeurActionName(offer)]);
  assert.equal(sent[0].message.data.action_config.objects[0].name, offer.token);
  await publishCompanionActionContext(client, {text: 'Next ordinary request', mode: 'replace'}, null);
  assert.deepEqual(sent[1].message.data.action_config, {actions: [], objects: [], characters: [], current_attention_object: ''});
  await assert.rejects(publishCompanionActionContext({isBotReady: false}, {}, offer), /unavailable/);
});

// ---- Why a ride is not possible, told to a Convai character ----------------------------------------------------------------------
// Convai gets no action the game did not offer, so a character asked to take the wheel played along ("I'm already sitting down") while nothing happened.

test('driveLimitNote: the reason is told when V may be asking for a ride, and ordinary talk pays nothing', async () => {
  const {driveLimitNote, DRIVE_UNAVAILABLE_CODES, DRIVE_LIMIT} = await import('./companion-actions.mjs');
  for (const code of DRIVE_UNAVAILABLE_CODES) {
    const note = driveLimitNote(code, 'get behind the wheel');
    assert.ok(DRIVE_LIMIT[code], code);
    assert.ok(note.includes(DRIVE_LIMIT[code]), code);
    assert.match(note, /already sitting in the car or driving/);
    assert.ok(note.length < 600, 'a short note: Convai\'s dynamic info is long already');
  }
  assert.match(driveLimitNote('no-waypoint', 'drive me there'), /no destination is marked on the map/);
  assert.match(driveLimitNote('no-car', 'give me a ride'), /own car is not standing close by/);
  assert.match(driveLimitNote('car-moving', 'take the wheel'), /car has to stand still/);
  // A spoken turn is not known yet (the placeholder): it always carries the note.
  assert.match(driveLimitNote('no-waypoint', '[Microphone]'), /cannot drive V anywhere/);
  assert.match(driveLimitNote('no-waypoint', ''), /cannot drive V anywhere/);
  assert.match(driveLimitNote('no-waypoint', undefined), /cannot drive V anywhere/);
  // Typed talk that cannot be about a ride, in a few of the 15 menu languages: no text, no cost.
  for (const line of ['How are you today?', 'Tell me about your day', 'Wie geht es dir?', 'Comment vas-tu ?', 'Как дела?', 'お元気ですか', '你好吗']) {
    assert.equal(driveLimitNote('no-waypoint', line), '', line);
  }
  // Rides asked for in other languages are screened in.
  for (const line of ['Fahr mich zum Wegpunkt', 'Conduis-moi là-bas', 'Llévame en coche', 'Отвези меня', 'Zawieź mnie tam', '運転して', '운전해줘', '开车送我']) {
    assert.match(driveLimitNote('no-waypoint', line), /cannot drive V anywhere/, line);
  }
  // Nothing known, nothing said.
  for (const bad of [undefined, null, '', 'dance', 7, {}]) assert.equal(driveLimitNote(bad, 'take the wheel'), '');
});

// ---- The ride promise (2026-10-28 report): the facts a character gets, and the false yes ----------------------------------------------

test('no waypoint: the character is told to ask V to set one on the map, and a person who is not a party companion is told to decline', async () => {
  const {driveLimitNote, DRIVE_LIMIT, DRIVE_HONEST, DRIVE_UNAVAILABLE_CODES} = await import('./companion-actions.mjs');
  assert.match(driveLimitNote('no-waypoint', 'drive me there'), /ask V to open the map and set one, then ask again/);
  assert.match(driveLimitNote('not-driver', 'you drive'), /not one of V's party companions[\s\S]*decline briefly in character/);
  assert.doesNotMatch(driveLimitNote('not-driver', 'you drive'), /what is needed first/);
  for (const code of DRIVE_UNAVAILABLE_CODES) assert.ok(DRIVE_HONEST[code] && DRIVE_LIMIT[code], 'every code has its honest line: ' + code);
  assert.match(DRIVE_HONEST['no-waypoint'], /waypoint/);
});

test('driveAdvisoryFor: not-driver is sent for a typed line about a ride, for a named character on a spoken turn, and never for small talk or a crowd person on a spoken turn', async () => {
  const {driveAdvisoryFor} = await import('./companion-actions.mjs');
  assert.equal(driveAdvisoryFor('not-driver', 'you drive', {ambient: false}), 'not-driver');
  assert.equal(driveAdvisoryFor('not-driver', 'you drive', {ambient: true}), 'not-driver', 'a typed ride request counts for a crowd person too');
  assert.equal(driveAdvisoryFor('not-driver', 'How are you?', {ambient: false}), null);
  assert.equal(driveAdvisoryFor('not-driver', '[Microphone]', {ambient: false}), 'not-driver');
  assert.equal(driveAdvisoryFor('not-driver', '[Microphone]', {ambient: true}), null);
  assert.equal(driveAdvisoryFor('no-waypoint', 'How are you?', {ambient: true}), 'no-waypoint', 'every other code is as the game wrote it');
  assert.equal(driveAdvisoryFor('dance', 'you drive'), null);
});

test('claimsToDrive: a yes to a ride is found, an honest reply or plain talk is not', async () => {
  const {claimsToDrive} = await import('./companion-actions.mjs');
  for (const yes of ["Yeah, bro, I'll drive.", 'Sure thing, hop in.', "I'll take the wheel, V.", 'Alright, get in. Buckle up.', 'You got it, I will drive us there.', "Okay, let me drive."]) {
    assert.equal(claimsToDrive(yes), true, yes);
  }
  for (const no of ["I can't drive you yet, V. Set a waypoint on the map first.", 'Where to, choom? Mark a spot on the map and I will drive.', "I'm not one of your crew, V. Can't take the wheel for you.",
    'Your car is not close enough. Stand next to it first.', 'I used to drive a delivery van, back in the day.', 'Nice day, huh?', '', undefined]) {
    assert.equal(claimsToDrive(no), false, String(no));
  }
});

test('the Convai drive context tells the character to let it take the wheel before V gets in, not when V already sits in the car', async () => {
  const {CompanionActionWindow} = await import('./companion-actions.mjs');
  const base = {token: 'drive-0123456789abcdefghij', carName: 'Quadra', destinationName: 'Afterlife'};
  assert.match(CompanionActionWindow.contextText(base), /V lets you get behind the wheel first and then gets in on the passenger side/);
  assert.doesNotMatch(CompanionActionWindow.contextText({...base, seated: 'passenger'}), /gets in on the passenger side/);
});
