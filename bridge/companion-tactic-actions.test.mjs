import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, parseTacticOffer, publishCompanionActionContext,
  TACTIC_ACTIONS, TACTIC_KINDS, tacticActionName, chauffeurActionName, parseTacticUnavailable} from './companion-actions.mjs';

const tactic = (kinds = [...TACTIC_KINDS]) => ({available: true, actor: {serial: 3, id: '44ULL', key: 'judy'},
  target: {id: '77ULL', name: 'Tyger Claw', hostile: true, distance: 23}, kinds});
const driveOffer = () => ({available: true, actor: {serial: 3, id: '44ULL', key: 'judy'},
  car: {id: '55ULL', record: 'Vehicle.fixture', name: 'Fixture car'}, passengerSeat: 'seat_front_right',
  waypoint: {id: '66', name: 'Custom waypoint', position: {x: 100, y: 200, z: 30}}});
const prepared = extra => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy', channel: 'private',
    name: 'Judy', bodyType: 'Woman', text: 'Attack him', tacticOffer: tactic(), ...extra}});
function broker() {
  let sequence = 0; const files = [];
  const actions = new CompanionActions({now: () => 10000, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      files.push(packet); return true;
    }});
  return {actions, files, options: {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true}};
}

test('tactic offers are strict integer snapshots owned by the addressed companion', () => {
  assert.deepEqual(parseTacticOffer(tactic()), tactic());
  assert.deepEqual(TACTIC_KINDS, ['fight'], 'attack is the only tactic');
  for (const change of [o => o.target.distance = 2.5, o => o.target.id = o.actor.id, o => o.kinds = [],
    o => o.kinds = ['fight', 'fight'], o => o.kinds = ['dance'], o => o.kinds = ['fight', 'distract-return'], o => o.kinds = ['distract-rejoin'], o => o.target.name = 'bad\nname',
    o => o.target.hostile = 'yes', o => o.extra = 1, o => o.target.position = {x: 1}]) {
    const bad = tactic(); change(bad); assert.equal(parseTacticOffer(bad), null);
  }
  const parsed = parseInput(JSON.stringify(prepared().input));
  assert.deepEqual(parsed.tacticOffer, tactic());
  const malformed = parseInput(JSON.stringify({...prepared().input, tacticOffer: {available: true}}));
  assert.equal(malformed.tacticOffer, undefined); assert.equal(malformed.requestId, '100-4-44ULL');
});

test('a tactic-only request arms the companion, and each delivery publishes exactly one chosen tactic', async () => {
  const {actions, files, options} = broker(), p = prepared();
  const config = actions.admit(p, options);
  assert.equal(config.drive, false);
  assert.deepEqual(config.tactic, {targetName: 'Tyger Claw', hostile: true, distance: 23, kinds: [...TACTIC_KINDS]});
  assert.equal(await actions.deliver({version: 1, token: config.token}), false, 'no drive offer was made');
  assert.equal(await actions.deliver({version: 1, token: config.token, tactic: 'dance'}), false);
  assert.equal(await actions.deliver({version: 1, token: config.token, action: 'fight'}), false);
  assert.equal(await actions.deliver({version: 1, token: config.token, tactic: 'distract-return'}), false, 'no distraction exists');
  assert.deepEqual(await Promise.all([actions.deliver({version: 1, token: config.token, tactic: 'fight'}),
    actions.deliver({version: 1, token: config.token, tactic: 'fight'})]), [true, false]);
  const packet = files.find(row => row.action === 'companion-tactic');
  assert.equal(packet.tactic, 'fight');
  assert.deepEqual(packet.tacticOffer, tactic());
  assert.equal(packet.offer, undefined);
  assert.equal(packet.requestId, '100-4-44ULL');
  assert.equal(packet.expiresAt - packet.createdAt, 5000);
});

test('unoffered kinds, foreign actors and automatic turns cannot arm or choose a tactic', async () => {
  const {actions, options} = broker();
  const limited = actions.admit(prepared({tacticOffer: tactic(['fight'])}), options);
  assert.equal(await actions.deliver({version: 1, token: limited.token, tactic: 'dance'}), false);
  for (const change of [p => p.input.tacticOffer.actor.id = '99ULL', p => p.input.tacticOffer.actor.key = 'panam',
    p => p.input.reaction = {kind: 'battle'}, p => p.input.group = {id: 'g'}, p => p.route.channel = 'phone']) {
    const fresh = broker(), p = prepared(); change(p);
    assert.equal(fresh.actions.admit(p, fresh.options), null);
  }
});

test('driving and tactics share one capability; the chosen action decides the published packet', async () => {
  const {actions, files, options} = broker();
  const config = actions.admit(prepared({chauffeurOffer: driveOffer()}), options);
  assert.equal(config.carName, 'Fixture car'); assert.equal(config.drive, undefined);
  assert.equal(await actions.deliver({version: 1, token: config.token}), true);
  const packet = files.find(row => row.action === 'drive-to-waypoint');
  assert.deepEqual(packet.offer, driveOffer()); assert.equal(packet.tacticOffer, undefined);
});

test('the browser window accepts only advertised tactic names for its own token', () => {
  let now = 10000;
  const window = new CompanionActionWindow({now: () => now});
  const config = {version: 1, token: 'drive-abcdefghijklmnop', source: 'private-voice', expiresAt: now + 90000, drive: false,
    tactic: {targetName: 'Tyger Claw', hostile: true, distance: 23, kinds: ['fight']}};
  assert.equal(window.open({...config, tactic: undefined}), false, 'a tactic-only offer needs its tactic');
  assert.equal(window.open(config), true);
  for (const action of [{name: chauffeurActionName(config)}, {name: 'Distract Marked Target Then Return'},
    {name: TACTIC_ACTIONS.fight}, {name: tacticActionName(config, 'fight'), target: 'drive-stalestalestalestale'}])
    assert.equal(window.accept({actions: [action]}), null);
  assert.deepEqual(window.accept({actions: [{name: tacticActionName(config, 'fight')}]}),
    {version: 1, token: config.token, tactic: 'fight'});
  assert.equal(window.accept({actions: [{name: tacticActionName(config, 'fight')}]}), null, 'one use');
  window.open(config);
  assert.deepEqual(window.accept({actions: [{name: TACTIC_ACTIONS.fight, target: config.token}]}),
    {version: 1, token: config.token, tactic: 'fight'});
});

test('prompt material lets the character act on clear intent and ask when the intent is missing', async () => {
  const offer = {version: 1, token: 'drive-abcdefghijklmnop', source: 'private-text', expiresAt: 1, drive: false,
    tactic: {targetName: 'Tyger Claw', hostile: true, distance: 23, kinds: [...TACTIC_KINDS]}};
  const text = CompanionActionWindow.contextText(offer);
  assert.doesNotMatch(text, /driving setup/);
  for (const kind of TACTIC_KINDS) assert.ok(text.includes(JSON.stringify(tacticActionName(offer, kind))));
  assert.match(text, /request the matching action right away without asking for confirmation/);
  assert.match(text, /request no action this turn: ask V briefly in your own words/);
  assert.match(text, /that answer authorizes the action/);
  assert.doesNotMatch(text, /distract/i);
  assert.doesNotMatch(CompanionActionWindow.unavailableText(offer), /distract/i);
  assert.match(CompanionActionWindow.unavailableText(offer), /marked target/);
  assert.match(CompanionActionWindow.unavailableText(null), /driving request/);
  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local',
    publishData: async bytes => sent.push(JSON.parse(new TextDecoder().decode(bytes)))}}};
  await publishCompanionActionContext(client, {text: 'context'}, offer);
  assert.deepEqual(sent[0].data.action_config.actions, TACTIC_KINDS.map(kind => tacticActionName(offer, kind)));
  await publishCompanionActionContext(client, {text: 'context'}, {...offer, drive: undefined, carName: 'Car'});
  assert.equal(sent[1].data.action_config.actions[0], chauffeurActionName(offer));
  assert.equal(sent[1].data.action_config.actions.length, 1 + TACTIC_KINDS.length);
});

test('with no valid target the character is told so, can act on nothing, and the code survives the wire', async () => {
  assert.equal(parseTacticUnavailable('no-target'), 'no-target');
  for (const bad of ['dance', '', null, 7, {}]) assert.equal(parseTacticUnavailable(bad), null);
  const wire = parseInput(JSON.stringify({...prepared().input, tacticOffer: undefined, tacticUnavailable: 'no-target'}));
  assert.equal(wire.tacticUnavailable, 'no-target');
  assert.equal(parseInput(JSON.stringify({...prepared().input, tacticOffer: undefined, tacticUnavailable: 'dance'})).tacticUnavailable, undefined);
  const {actions, files, options} = broker();
  const config = actions.admit(prepared({tacticOffer: undefined, tacticUnavailable: 'no-target'}), options);
  assert.equal(config.tacticUnavailable, 'no-target'); assert.equal(config.tactic, undefined);
  for (const kind of TACTIC_KINDS) assert.equal(await actions.deliver({version: 1, token: config.token, tactic: kind}), false);
  assert.equal(files.some(row => row.action === 'companion-tactic'), false);
  assert.equal(actions.admit(prepared({tacticOffer: tactic(), tacticUnavailable: 'no-target'}), broker().options)?.tacticUnavailable, undefined,
    'a real offer wins over the advisory');
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config), true);
  assert.equal(window.open({...config, tacticUnavailable: 'dance'}), false);
  assert.equal(window.open({...config, tactic: {targetName: 'A', hostile: true, distance: 3, kinds: ['fight']}}), false);
  const text = CompanionActionWindow.contextText(config);
  assert.match(text, /cannot go after anyone/); assert.match(text, /do not agree or pretend/);
  assert.match(text, /could attack is tagged/); assert.doesNotMatch(text, /distract/i);
  assert.match(CompanionActionWindow.unavailableText(config), /cannot go after anyone/);
});
