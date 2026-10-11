import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {battleTrigger, battleContext} from './battle-context.mjs';
import {followUpContext} from './conversation-style.mjs';
import {parseDistraction, distractionTrigger} from './distraction-context.mjs';
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
    name: 'Judy', bodyType: 'Woman', text: 'Distract him, then come back here', tacticOffer: tactic(), ...extra}});
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
  assert.deepEqual(parseTacticOffer(tactic(['distract-rejoin', 'fight'])).kinds, ['fight', 'distract-rejoin']);
  for (const change of [o => o.target.distance = 2.5, o => o.target.id = o.actor.id, o => o.kinds = [],
    o => o.kinds = ['fight', 'fight'], o => o.kinds = ['dance'], o => o.target.name = 'bad\nname',
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
  assert.deepEqual(await Promise.all([actions.deliver({version: 1, token: config.token, tactic: 'distract-return'}),
    actions.deliver({version: 1, token: config.token, tactic: 'fight'})]), [true, false]);
  const packet = files.find(row => row.action === 'companion-tactic');
  assert.equal(packet.tactic, 'distract-return');
  assert.deepEqual(packet.tacticOffer, tactic());
  assert.equal(packet.offer, undefined);
  assert.equal(packet.requestId, '100-4-44ULL');
  assert.equal(packet.expiresAt - packet.createdAt, 5000);
});

test('unoffered kinds, foreign actors and automatic turns cannot arm or choose a tactic', async () => {
  const {actions, options} = broker();
  const limited = actions.admit(prepared({tacticOffer: tactic(['fight'])}), options);
  assert.equal(await actions.deliver({version: 1, token: limited.token, tactic: 'distract-rejoin'}), false);
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
    tactic: {targetName: 'Tyger Claw', hostile: true, distance: 23, kinds: ['fight', 'distract-fight']}};
  assert.equal(window.open({...config, tactic: undefined}), false, 'a tactic-only offer needs its tactic');
  assert.equal(window.open(config), true);
  for (const action of [{name: chauffeurActionName(config)}, {name: tacticActionName(config, 'distract-return')},
    {name: TACTIC_ACTIONS.fight}, {name: tacticActionName(config, 'fight'), target: 'drive-stalestalestalestale'}])
    assert.equal(window.accept({actions: [action]}), null);
  assert.deepEqual(window.accept({actions: [{name: tacticActionName(config, 'distract-fight')}]}),
    {version: 1, token: config.token, tactic: 'distract-fight'});
  assert.equal(window.accept({actions: [{name: tacticActionName(config, 'fight')}]}), null, 'one use');
  window.open(config);
  assert.deepEqual(window.accept({actions: [{name: TACTIC_ACTIONS.fight, target: config.token}]}),
    {version: 1, token: config.token, tactic: 'fight'});
});

test('prompt material lets the character act on clear intent and ask when the choice is missing', async () => {
  const offer = {version: 1, token: 'drive-abcdefghijklmnop', source: 'private-text', expiresAt: 1, drive: false,
    tactic: {targetName: 'Tyger Claw', hostile: true, distance: 23, kinds: [...TACTIC_KINDS]}};
  const text = CompanionActionWindow.contextText(offer);
  assert.doesNotMatch(text, /driving setup/);
  for (const kind of TACTIC_KINDS) assert.ok(text.includes(JSON.stringify(tacticActionName(offer, kind))));
  assert.match(text, /request the matching action right away without asking for confirmation/);
  assert.match(text, /request no action this turn: ask V in your own words which they want/);
  assert.match(text, /come back here, attack them afterwards, or rejoin V/);
  assert.match(text, /that answer authorizes the matching action/);
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

const distraction = (turn, extra = {}) => ({kind: 'distraction', scene: 'distract-12', turn,
  role: turn % 2 ? 'companion' : 'target', ending: 'return', partner: turn % 2 ? 'Tyger Claw' : 'Judy Alvarez',
  lines: Array.from({length: turn - 1}, (_, index) => ({role: index % 2 ? 'target' : 'companion', text: 'Line ' + (index + 1)})),
  expiresAt: 99999, ...extra});

test('distraction turns alternate speakers, carry the heard lines, and never ask V anything', () => {
  for (let turn = 1; turn <= 5; turn++) assert.ok(parseDistraction(distraction(turn)), 'turn ' + turn);
  for (const bad of [distraction(6), distraction(2, {role: 'companion'}), distraction(3, {lines: []}),
    distraction(1, {ending: 'dance'}), distraction(1, {scene: 'battle-1'}), distraction(2, {partner: ''}),
    distraction(3, {lines: [{role: 'target', text: 'x'}, {role: 'companion', text: 'y'}]}), distraction(1, {extra: 1})])
    assert.equal(parseDistraction(bad), null);
  assert.equal(parseDistraction(distraction(1), {batch: 1}), null, 'loot cannot ride along');
  const input = turn => ({profileKey: 'judy', reaction: parseDistraction(distraction(turn))});
  assert.match(distractionTrigger(input(1)), /Start a casual, believable conversation/);
  assert.match(distractionTrigger(input(2)), /someone you do not know/);
  assert.match(distractionTrigger(input(2)), /Judy Alvarez: "Line 1"/);
  assert.match(distractionTrigger(input(4)), /You: "Line 2"/);
  assert.match(distractionTrigger(input(5)), /Wrap up the conversation naturally/);
  assert.match(distractionTrigger({reaction: parseDistraction(distraction(5, {ending: 'fight'}))}), /about to attack them/);
  for (let turn = 1; turn <= 5; turn++) assert.match(distractionTrigger(input(turn)), /not to V/);
  assert.match(followUpContext(input(3)), /not to V/);
  assert.doesNotMatch(followUpContext(input(3)), /Do not ask V a question/);
});

test('a distraction request is a valid automatic turn routed through the existing trigger path', () => {
  const request = {requestId: '100-9-77ULL', generation: 9, entity: '77ULL', name: 'Tyger Claw', bodyType: 'Man',
    profileKey: 'resident-male', text: 'Distraction line', reaction: distraction(2), battle: {version: 1, status: 'none'}};
  const parsed = parseInput(JSON.stringify(request));
  assert.equal(parsed.reaction.kind, 'distraction');
  assert.match(battleTrigger(parsed), /Answer what they just said/);
  assert.equal(battleContext(parsed), '');
  assert.equal(parseInput(JSON.stringify({...request, reaction: distraction(2, {role: 'companion'})})), null);
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
  assert.match(CompanionActionWindow.unavailableText(config), /cannot go after anyone/);
});
