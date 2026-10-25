import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CompanionActions, CompanionActionWindow, homeTraceLine} from './companion-actions.mjs';
import {actionMenu} from './text-actions.mjs';
import {HomePicks, HOME_PICK_TTL_MS, HOME_PICK_TURNS, parseHomeOffer, screenHome, homeInstruction} from './home-requests.mjs';
import {lua} from './housemate-fixture.mjs';
import {WORLD} from './housemate-world-fake.mjs';

// The first live run of the housemates (2026-10-25, Convai): V told Blue Moon in the corridor of the Corpo Plaza building "you can stay at my place", she asked
// which (three flats, V in none), V answered with the flat's name, she said yes, and nothing moved: the answer alone did not say she could live there, so the
// rules of the offer kept the action back, and nothing in the logs said so. These tests play that run on every route and check the lines a next run leaves.

const blue = {id: '44ULL', key: 'blue-moon'};
const h10 = {id: 'h10', name: 'Megabuilding H10'}, corpo = {id: 'corpo', name: 'Corpo Plaza'}, glen = {id: 'glen', name: 'Heywood Glen'};
// The offer of the live run (last-input.json): three flats, no `here`, nobody in earshot.
const liveOffer = (extra = {}) => ({available: true, actor: {...blue}, apartments: [{...h10}, {...corpo}, {...glen}], members: [], ...extra});
let request = 14;
function prepared(text, extra = {}, {group} = {}) {
  request += 1;
  const channel = group ? 'group' : 'private';
  return {sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2, remoteConfig: {endUserId: 'fixture-user'},
    route: {channel, transport: channel},
    input: {requestId: `1792929079-${request}-44ULL`, generation: request, entity: '44ULL', profileKey: 'blue-moon', channel, name: 'Blue Moon',
      provider: 'convai', text, homeOffer: liveOffer(), ...(group ? {group} : {}), ...extra}};
}
function broker(clock = {now: 10000}) {
  let sequence = 0; const files = [], lines = [];
  const actions = new CompanionActions({now: () => clock.now, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async packet => { files.push(packet); return true; }, homeLog: line => lines.push(line)});
  return {actions, files, lines, clock, options: {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true}};
}

// ---- In person (Convai and the text routes share the lease) ----------------------------------------------------------------------------

test('the live run: "you can stay at my place", she asks which, V names Corpo Plaza: that answer carries pick and the stay reaches the game', async () => {
  const {actions, files, options} = broker();
  const first = actions.admit(prepared('you can stay at my place'), options);
  assert.equal(first.home.pick, undefined, 'the question turn itself is no answer');
  assert.match(CompanionActionWindow.contextText(first), /If V names none, ask V in your own words which of them it is and request nothing yet/);
  const answer = actions.admit(prepared('the corpo plaza one'), options);
  assert.equal(answer.home.pick, true);
  const text = CompanionActionWindow.contextText(answer);
  assert.match(text, /or answers your question which apartment \(below\)/);
  assert.match(text, /V's new message is the answer, and it is V's go-ahead: when it names or points to one of the listed apartments/);
  assert.match(text, /"Stay At Corpo Plaza drive-0+2"/, 'the action the model must request is named');
  // The Convai page opens its window with this config, and the model's action comes back as the choice.
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(answer), true, 'the window takes a config with pick');
  assert.deepEqual(window.accept({actions: [{name: `Stay At Corpo Plaza ${answer.token}`}]}), {version: 1, token: answer.token, home: {op: 'stay', apartment: 'corpo'}});
  assert.equal(new CompanionActionWindow({now: () => 10000}).open({...answer, home: {...answer.home, pick: 'yes'}}), false, 'pick is true or absent');
  assert.equal(await actions.deliver({version: 1, token: answer.token, home: {op: 'stay', apartment: 'corpo'}}), true);
  const packet = files.find(row => row.action === 'companion-home');
  assert.deepEqual(packet.home, {op: 'stay', apartment: 'corpo'});
  assert.deepEqual(packet.homeOffer, liveOffer(), 'pick is the bridge\'s own memory: the game\'s offer comes back exactly as it was sent');
  // Moved in: the next turn is an ordinary one again.
  assert.equal(actions.admit(prepared('nice'), options).home.pick, undefined);
});

test('pick is only for the character who asked, only after a real "stay at my place", only when she had to ask, and only for a few turns', () => {
  const {actions, clock, options} = broker();
  const pickOf = (text, extra, profile) => actions.admit(prepared(text, extra, profile), options)?.home?.pick === true;
  // V stands in one of the flats: no question, so no answer.
  assert.equal(pickOf('you can stay at my place', {homeOffer: liveOffer({here: 'corpo'})}), false);
  assert.equal(pickOf('glen', {homeOffer: liveOffer({here: 'corpo'})}), false);
  // One flat only: no question either.
  assert.equal(pickOf('you can stay at my place', {homeOffer: liveOffer({apartments: [{...h10}]})}), false);
  assert.equal(pickOf('h10'), false);
  // "Stay for dinner" opens it too (the screen is a stem), and the model's own rules refuse a dinner; a plain remark does not.
  assert.equal(pickOf('nice weather'), false);
  assert.equal(pickOf('nice weather'), false);
  // Three answers at most, then it is over.
  pickOf('you can crash at my place');
  for (let turn = 0; turn < HOME_PICK_TURNS; turn += 1) assert.equal(pickOf('hmm'), true, `turn ${turn + 1}`);
  assert.equal(pickOf('hmm'), false);
  // Ten minutes at most.
  pickOf('you can stay at my place');
  clock.now += HOME_PICK_TTL_MS + 1;
  assert.equal(pickOf('corpo'), false);
  // Another character's turn is not her answer; a move-out line never opens it.
  pickOf('you can stay at my place');
  const other = prepared('corpo'); other.input.profileKey = 'judy-alvarez'; other.input.homeOffer.actor = {id: '44ULL', key: 'judy-alvarez'};
  assert.equal(actions.admit(other, options).home.pick, undefined);
  const picks = new HomePicks({now: () => 0});
  assert.equal(picks.turn('a', "you can't stay here any more, find your own place", [h10, corpo], undefined), false);
  assert.equal(picks.turn('a', 'corpo', [h10, corpo], undefined), false);
});

test('a group round never carries pick (its offer has no apartments to pick from)', () => {
  const {actions, options} = broker();
  actions.admit(prepared('you can stay at my place'), options);
  const group = {id: 'group-1', index: 1, total: 2, audience: ['blue-moon', 'judy-alvarez'], heard: []};
  const config = actions.admit(prepared('corpo', {homeOffer: liveOffer({apartments: [], members: [{serial: 3, ...blue, name: 'Blue Moon'}]})}, {group}),
    {...options, source: 'group-text'});
  assert.equal(config.group, true); assert.equal(config.home.pick, undefined);
});

test('one Housing line per turn says what the reply asked for and whether it reached the game', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {actions, lines, options} = broker();
  const first = prepared('you can stay at my place');
  actions.admit(first, options);
  actions.endTurn(first.input);
  t.mock.timers.tick(10000);
  assert.deepEqual(lines, ['Housing: person=blue-moon apartments=h10,corpo,glen here=- pick=no action=none(no-action-requested) delivered=-']);
  const answer = actions.admit(prepared('corpo plaza'), options);
  assert.equal(await actions.deliver({version: 1, token: answer.token, home: {op: 'stay', apartment: 'h99'}}), false);
  assert.equal(await actions.deliver({version: 1, token: answer.token, home: {op: 'stay', apartment: 'corpo'}}), true);
  actions.endTurn(answer.input);
  t.mock.timers.tick(10000);
  assert.deepEqual(lines.slice(1), [
    'Housing: person=blue-moon apartments=h10,corpo,glen here=- pick=yes action=stay:h99 delivered=no(not-offered)',
    'Housing: person=blue-moon apartments=h10,corpo,glen here=- pick=yes action=stay:corpo delivered=yes']);
  // A turn replaced before its reply ended says so.
  actions.admit(prepared('hello'), options);
  actions.admit(prepared('hello again'), options);
  assert.equal(lines.at(-1), 'Housing: person=blue-moon apartments=h10,corpo,glen here=- pick=no action=none(next-turn) delivered=-');
  assert.equal(homeTraceLine({person: 'x', apartments: [], pick: false}), 'Housing: person=x apartments=- here=- pick=no action=none delivered=-');
});

test('the text routes: with pick a short answer is screened as a stay and the decision is told it is the answer', () => {
  const TOKEN = 'drive-0123456789abcdefghij';
  const offer = home => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false,
    home: {apartments: [h10, corpo, glen], members: [], ...home}});
  const plain = actionMenu(offer({})), picking = actionMenu(offer({pick: true}));
  assert.equal(plain.screen('that one', null).includes('STAY'), false);
  assert.equal(picking.screen('that one', null).includes('STAY'), true);
  assert.equal(picking.screen('corpo plaza', null).includes('STAY'), true);
  assert.match(picking.classifier({text: 'corpo plaza'})[0].content, /she asked which apartment: V naming or pointing to one now .* is STAY with its id/);
  assert.doesNotMatch(plain.classifier({text: 'corpo plaza'})[0].content, /she asked which apartment/);
  assert.deepEqual(picking.message({code: 'STAY', argument: 'corpo'}), {version: 1, token: TOKEN, home: {op: 'stay', apartment: 'corpo'}});
});

// ---- The phone ---------------------------------------------------------------------------------------------------------------------------

test('the phone: the answer to her question gets the go-ahead sentence and counts as a stay', () => {
  const offer = parseHomeOffer({version: 1, token: 'home-0123456789abcdef', apartments: [h10, corpo, glen]});
  const picks = new HomePicks({now: () => 0});
  assert.equal(picks.turn('blue-moon', 'you can stay at my place', offer.apartments, offer.here), false);
  const picking = picks.turn('blue-moon', 'the loft', offer.apartments, offer.here);
  assert.equal(picking, true);
  const plain = screenHome('the loft', offer), screen = screenHome('the loft', offer, picking);
  assert.equal(plain.kind, null, 'without the memory a short answer is nothing');
  assert.equal(screen.kind, 'stay'); assert.equal(screen.pick, true); assert.equal(screen.strong, true);
  assert.match(homeInstruction(offer, screen), /V's new message is the answer, and it is V's go-ahead/);
  assert.doesNotMatch(homeInstruction(offer, screenHome('you can stay at my place', offer)), /go-ahead/);
  picks.done('blue-moon');
  assert.equal(picks.turn('blue-moon', 'corpo', offer.apartments, offer.here), false);
});

// ---- The game side ---------------------------------------------------------------------------------------------------------------------

const PARTY = `
  local function inParty(key)
    local serial = world.nextSerial; world.nextSerial = serial + 1
    world.party[serial] = {serial = serial, profileKey = key, entityID = tostring(serial) .. 'ULL', state = 'ready'}
    return serial, tostring(serial) .. 'ULL'
  end
  local function lines(prefix)
    local out = {}
    for _, line in ipairs(world.logs) do if line:sub(1, #prefix) == prefix then out[#out + 1] = line end end
    return out
  end
`;

test('the game writes one probe line per stage: offer shown, action received, registered, flat entered, spot chosen, body spawned, placed', () => lua(`${WORLD}${PARTY}
  world.place = 'CityCenter_Street'
  local c = control({})
  local serial, entity = inParty('judy-alvarez')
  local offer = c.homeOffer(entity, {profileKey = 'judy-alvarez'})
  assert(offer and offer.here == nil and #offer.apartments == 3, 'offer')
  c.homeOffer(entity, {profileKey = 'judy-alvarez'})
  assert(#lines('Housemates offer-shown') == 1, 'one line per change of the offer, not one per turn')
  assert(lines('Housemates offer-shown')[1] == 'Housemates offer-shown apartments=h10,corpo,glen here=- key=judy-alvarez lives=- members=0', lines('Housemates offer-shown')[1])
  assert(c.queueHome({op = 'stay', apartment = 'corpo'}, offer, entity, 'r1') == true)
  assert(lines('Housemates action-received')[1] == 'Housemates action-received apt=corpo key=judy-alvarez op=stay')
  assert(lines('Housemates registered')[1] == 'Housemates registered apt=corpo here=- key=judy-alvarez party=true')
  world.party[serial] = nil   -- she walked off
  run(c, 10)
  assert(#lines('Housemates flat-entered') == 0, 'entered early')
  world.place = 'CorpoPlaza_Apartment'
  c.wake()
  run(c, 20)
  assert(lines('Housemates flat-entered')[1] == 'Housemates flat-entered apt=corpo residents=1', table.concat(world.logs, ' | '))
  assert(#lines('Housemates spot-chosen id=corpo-') >= 1, table.concat(world.logs, ' | '))
  assert(#lines('Housemates body-spawned key=judy-alvarez') == 1, table.concat(world.logs, ' | '))
  assert(#lines('Housemates placed id=corpo-') == 1, table.concat(world.logs, ' | '))
  assert(snapshot(c)['judy-alvarez'].state == 'at', 'not at')
  run(c, 30)
  assert(#lines('Housemates flat-entered') == 1 and #lines('Housemates placed') == 1, 'never per step')
  world.place = 'CityCenter_Street'
  run(c, 2)
  assert(lines('Housemates flat-left')[1] == 'Housemates flat-left apt=corpo')
`));

test('the game writes why a stage failed: not offered, not owned, the store, the spawn', () => lua(`${WORLD}${PARTY}
  world.place = 'CityCenter_Street'
  local c = control({})
  local offer = c.homeOffer('1ULL', {profileKey = 'judy-alvarez'})
  assert(c.queueHome({op = 'stay', apartment = 'north'}, offer, '1ULL', 'r1') == false)
  assert(lines('Housemates failed:not-offered')[1] == 'Housemates failed:not-offered apt=north key=judy-alvarez')
  world.facts.dlc6_apart_hey_gle_purchased = 0
  assert(c.queueHome({op = 'stay', apartment = 'glen'}, offer, '1ULL', 'r2') == false)
  assert(lines('Housemates failed:not-owned')[1] == 'Housemates failed:not-owned apt=glen key=judy-alvarez')
  store.set = function() error('The quest system is not ready.') end
  assert(c.queueHome({op = 'stay', apartment = 'corpo'}, offer, '1ULL', 'r3') == false)
  assert(lines('Housemates failed:store')[1]:find('quest system is not ready', 1, true))
  store.set = function(n, v) values[n] = v end
  env.bodies.spawn = function() return false, 'no party queue' end
  local d = Housemates.new(env)
  d.setHomes({['judy-alvarez'] = 'corpo'})
  world.place = 'CorpoPlaza_Apartment'
  for _ = 1, 40 do d.update(0.25) end
  assert(lines('Housemates failed:spawn')[1] == 'Housemates failed:spawn key=judy-alvarez why=no party queue', table.concat(world.logs, ' | '))
  assert(#lines('Housemates failed:spawn') == 1, 'one line per try, and the next try waits 30 s')
`));

test('init.lua: the district hook installed in onInit (the one that fires: Settle settle-enter) wakes the housemates too', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(init, /ObserveAfter\('PreventionSystem', 'OnDistrictAreaEntered', function\(\)\n\s+if not worldSuspended and convaiSettleWake then convaiSettleWake\(\) end\n\s+if not worldSuspended and convaiHousemateWake then convaiHousemateWake\(\) end/);
  // Off: the wake is one global read (the housemates-off test calls it with the setting Off and counts nothing).
  assert.match(init, /function convaiHousemateWake\(\)\n\s+local glue = convaiHousemates\n\s+if glue and glue.controller and on\(\) then glue.controller.wake\(\) end/);
});
