import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, parseHomeOffer, parseLeaveOffer, homeActions, leaveActions, publishCompanionActionContext,
  HOME_JOIN_ACTION, HOME_JOIN_ALL_ACTION, HOME_MOVE_OUT_ACTION, LEAVE_ACTION, MEMBERS_MAX} from './companion-actions.mjs';

// Housemates, the conversation side (docs/HOUSEMATES.md "Moving in", "Party transitions", "Group chat"): the home offer is a strict game snapshot, the
// character's choice becomes a packet the game validates against exactly what it offered, and a group round's first speaker may carry it.

const actor = {id: '44ULL', key: 'judy-alvarez'};
const judy = {serial: 3, id: '44ULL', key: 'judy-alvarez', name: 'Judy Alvarez'};
const panam = {serial: 4, id: '55ULL', key: 'panam-palmer', name: 'Panam Palmer'};
const corpo = {id: 'corpo', name: 'Corpo Plaza'}, glen = {id: 'glen', name: 'Heywood Glen'}, h10 = {id: 'h10', name: 'Megabuilding H10'};
const home = (extra = {}) => ({available: true, actor: {...actor}, apartments: [{...corpo}, {...glen}], members: [{...judy}], ...extra});
const leave = (members = [judy]) => ({available: true, actor: {...actor}, members: members.map(member => ({...member}))});
const groupOf = (index = 1) => ({id: 'group-1', index, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []});
function prepared(extra = {}, {group, source = group ? 'group-text' : 'private-text'} = {}) {
  const channel = group ? 'group' : 'private';
  return {sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2, remoteConfig: {endUserId: 'fixture-user'},
    route: {channel, transport: source.endsWith('-voice') ? 'microphone' : channel},
    input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy-alvarez', channel, name: 'Judy', bodyType: 'Woman',
      text: 'You can stay at my place', ...(group ? {group} : {}), ...extra}};
}
function broker() {
  let sequence = 0; const files = [];
  const actions = new CompanionActions({now: () => 10000, createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => { if (options?.isCurrent && !await options.isCurrent()) return false; files.push(packet); return true; }});
  return {actions, files, options: source => ({source, isCurrent: async () => true, isCurrentSync: () => true})};
}
const many = count => Array.from({length: count}, (_value, index) => ({serial: index + 1, id: `${100 + index}ULL`, key: `person-${index}`, name: `Person ${index}`}));

// ---- The offers --------------------------------------------------------------------------------------------------------------------

test('a home offer is a strict game snapshot: unknown keys, bad ids and empty offers are dropped', () => {
  assert.deepEqual(parseHomeOffer(home()), home());
  const full = home({here: 'corpo', lives: {id: 'glen', name: 'Heywood Glen'}, moveOut: true, asked: {from: 'glen', here: 'corpo'}});
  assert.deepEqual(parseHomeOffer(full), full, 'the exact offer comes back: the game compares the packet byte for byte');
  for (const change of [o => o.extra = 1, o => o.available = false, o => delete o.members, o => delete o.apartments, o => o.actor.serial = 3,
    o => o.apartments[0].id = 'penthouse', o => o.apartments[0].extra = 1, o => o.apartments[0].name = '', o => o.apartments[0].name = 'x'.repeat(61),
    o => o.apartments[1].id = 'corpo', o => o.apartments = [{...corpo}, {...glen}, {...h10}, {id: 'japan', name: 'Japantown'}, {id: 'north', name: 'Northside'}, {id: 'h10', name: 'again'}],
    o => o.here = 'penthouse', o => o.lives = {id: 'glen'}, o => o.lives = {id: 'nowhere', name: 'x'}, o => o.moveOut = 'yes',
    o => o.asked = {from: 'glen'}, o => o.asked = {from: 'glen', here: 'x'}, o => o.asked = {from: 'glen', here: 'corpo', extra: 1},
    o => o.members[0].extra = true, o => o.members[0].away = true, o => o.members[0].serial = 0, o => o.members.push({...judy}),
    o => o.members.push({...panam, serial: 3}), o => o.actor.id = 'judy']) {
    const bad = home(); change(bad); assert.equal(parseHomeOffer(bad), null, String(change));
  }
  for (const empty of [home({apartments: [], members: []}), home({apartments: [], members: [], moveOut: false})])
    assert.equal(parseHomeOffer(empty), null, 'nothing to choose is no offer');
  assert.ok(parseHomeOffer(home({apartments: [], members: [], moveOut: true})), 'a move-out alone is an offer');
  assert.ok(parseHomeOffer(home({apartments: []})), 'members alone are an offer');
  assert.ok(parseHomeOffer(home({members: []})), 'apartments alone are an offer');
  for (const value of [null, 7, 'x', [], {}]) assert.equal(parseHomeOffer(value), null);
});

test('a home offer lists up to five apartments and twelve members, and a malformed one never breaks the request', () => {
  assert.equal(parseHomeOffer(home({members: many(MEMBERS_MAX)})).members.length, 12);
  assert.equal(parseHomeOffer(home({members: many(MEMBERS_MAX + 1)})), null);
  const five = [corpo, glen, h10, {id: 'japan', name: 'Westbrook Japantown'}, {id: 'north', name: 'Watson Northside'}];
  assert.equal(parseHomeOffer(home({apartments: five})).apartments.length, 5);
  const parsed = parseInput(JSON.stringify(prepared({homeOffer: home(), leaveOffer: leave()}).input));
  assert.deepEqual(parsed.homeOffer, home()); assert.deepEqual(parsed.leaveOffer, leave());
  const malformed = parseInput(JSON.stringify(prepared({homeOffer: {available: true, actor, apartments: [{id: 'x', name: 'y'}], members: []}}).input));
  assert.equal(malformed.requestId, '100-4-44ULL'); assert.equal(malformed.homeOffer, undefined);
  // A person with a home offer is a companion: an NPC reaction offer is not read as well.
  const kinds = {available: true, actor, kinds: ['leave']};
  assert.equal(parseInput(JSON.stringify(prepared({homeOffer: home(), reactionOffer: kinds}).input)).reactionOffer, undefined);
  assert.equal(parseInput(JSON.stringify(prepared({reactionOffer: kinds}).input)).reactionOffer?.kinds[0], 'leave');
});

test('the leave offer accepts the away fields, still strictly, and lists up to twelve', () => {
  const away = {...judy, away: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen', confirmed: true};
  assert.deepEqual(parseLeaveOffer(leave([away])), leave([away]));
  assert.deepEqual(parseLeaveOffer(leave([{...judy, away: true}])), leave([{...judy, away: true}]));
  for (const bad of [{...judy, away: 'yes'}, {...judy, confirmed: 1}, {...judy, homeName: ''}, {...judy, hereName: 5}, {...judy, homeName: 'x'.repeat(121)},
    {...judy, other: true}]) assert.equal(parseLeaveOffer(leave([bad])), null, JSON.stringify(bad));
  assert.equal(parseLeaveOffer(leave(many(12))).members.length, 12);
  assert.equal(parseLeaveOffer(leave(many(13))), null);
  assert.equal(parseLeaveOffer(leave([])), null);
  assert.equal(parseLeaveOffer(leave([judy, panam, ...many(3).map((m, i) => ({...m, serial: 10 + i, id: `${900 + i}ULL`}))])).members.length, 5, 'the old cap of three is gone');
});

// ---- The actions -------------------------------------------------------------------------------------------------------------------

const TOKEN = 'drive-abcdefghijklmnop';
const config = (extra = {}) => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false,
  home: {apartments: [{...corpo}, {...glen}], members: [{name: 'Judy Alvarez', self: true}], ...extra}});

test('the actions are one Stay At per apartment, Move Out, her own Join, each other member and Everyone', () => {
  const rows = homeActions(config({moveOut: true, members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}));
  assert.deepEqual(rows.map(row => row.base), ['Stay At Corpo Plaza', 'Stay At Heywood Glen', HOME_MOVE_OUT_ACTION, HOME_JOIN_ACTION,
    "Panam Palmer Joins V's Party", HOME_JOIN_ALL_ACTION]);
  assert.deepEqual(rows.map(row => row.name), rows.map(row => `${row.base} ${TOKEN}`));
  assert.deepEqual(rows.map(row => row.op), ['stay', 'stay', 'move-out', 'join', 'join', 'join']);
  assert.deepEqual(rows.map(row => row.target ?? row.apartment), ['corpo', 'glen', undefined, 1, 2, 'all']);
  assert.deepEqual(homeActions(config()).map(row => row.base), ['Stay At Corpo Plaza', 'Stay At Heywood Glen', HOME_JOIN_ACTION], 'no Move Out unless offered, no Everyone for one');
  assert.deepEqual(homeActions(config({apartments: [], members: []})), []);
  assert.deepEqual(homeActions({...config(), token: 'bad'}), []);
  // The speaker is not always a member: nobody gets the plain Join.
  const others = homeActions(config({members: [{name: 'Panam Palmer', self: false}]}));
  assert.deepEqual(others.filter(row => row.op === 'join').map(row => row.base), ["Panam Palmer Joins V's Party"]);
  // Duplicate names get their number, as leaveActions does.
  const same = homeActions(config({apartments: [], members: [{name: 'Jackie', self: false}, {name: 'Judy Alvarez', self: true}, {name: 'Jackie', self: false}]}));
  assert.deepEqual(same.map(row => row.base), ["Jackie 1 Leaves V's Party".replace('Leaves', 'Joins'), HOME_JOIN_ACTION, "Jackie 3 Joins V's Party", HOME_JOIN_ALL_ACTION]);
  const leaving = leaveActions({token: TOKEN, leave: {members: [{name: 'Jackie', self: false}, {name: 'Jackie', self: false}]}});
  assert.deepEqual(leaving.map(row => row.base), ["Jackie 1 Leaves V's Party", "Jackie 2 Leaves V's Party", "Everyone Leaves V's Party"]);
});

test('a home offer arms the addressed speaker and one delivery publishes the exact choice, checked against the offer', async () => {
  const {actions, files, options} = broker();
  const armed = actions.admit(prepared({homeOffer: home({here: 'glen', moveOut: true, members: [judy, panam]})}), options('private-text'));
  assert.equal(armed.drive, false); assert.equal(armed.leave, undefined);
  assert.deepEqual(armed.home, {apartments: [corpo, glen], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}],
    moveOut: true, here: 'glen'}, 'names and fixed ids only; no entity reaches the page');
  const refused = [{op: 'stay', apartment: 'h10'}, {op: 'stay'}, {op: 'stay', apartment: 'corpo', extra: 1}, {op: 'move-out', extra: 1}, {op: 'join', target: 0},
    {op: 'join', target: 3}, {op: 'join', target: '2'}, {op: 'join', target: 1.5}, {op: 'join', target: 'everyone'}, {op: 'rest'}, {op: 7}, 'stay', null, [], {}];
  for (const choice of refused) assert.equal(await actions.deliver({version: 1, token: armed.token, home: choice}), false, JSON.stringify(choice));
  for (const message of [{version: 1, token: armed.token}, {version: 1, token: armed.token, leave: 1}, {version: 1, token: 'drive-stalestalestalestale', home: {op: 'move-out'}},
    {version: 1, token: armed.token, home: {op: 'move-out'}, extra: 1}]) assert.equal(await actions.deliver(message), false);
  assert.deepEqual(await Promise.all([actions.deliver({version: 1, token: armed.token, home: {op: 'stay', apartment: 'corpo'}}),
    actions.deliver({version: 1, token: armed.token, home: {op: 'stay', apartment: 'glen'}})]), [true, false], 'one use');
  const packet = files.find(row => row.action === 'companion-home');
  assert.deepEqual(packet.home, {op: 'stay', apartment: 'corpo'});
  assert.deepEqual(packet.homeOffer, home({here: 'glen', moveOut: true, members: [judy, panam]}));
  assert.equal(packet.entity, '44ULL'); assert.equal(packet.profileKey, 'judy-alvarez'); assert.equal(packet.source, 'private-text');
  assert.equal(packet.requestId, '100-4-44ULL'); assert.equal(packet.generation, 4); assert.equal(packet.worldToken, 'world-fixture');
  assert.equal(packet.expiresAt - packet.createdAt, 5000); assert.match(packet.actionId, /^drive-/);
  assert.equal(packet.offer, undefined); assert.equal(packet.leaveOffer, undefined);
  for (const key of ['version', 'actionId', 'requestId', 'generation', 'entity', 'profileKey', 'worldToken', 'worldGeneration', 'source', 'createdAt', 'expiresAt'])
    assert.ok(Object.hasOwn(packet, key), key);
});

test('move-out and join choices resolve to the packet: a member number becomes the game\'s own id', async () => {
  const offer = home({moveOut: true, members: [judy, panam]});
  for (const [choice, expected] of [[{op: 'move-out'}, {op: 'move-out'}], [{op: 'join', target: 1}, {op: 'join', target: '44ULL'}],
    [{op: 'join', target: 2}, {op: 'join', target: '55ULL'}], [{op: 'join', target: 'all'}, {op: 'join', target: 'all'}]]) {
    const {actions, files, options} = broker();
    const armed = actions.admit(prepared({homeOffer: offer}), options('private-text'));
    assert.equal(await actions.deliver({version: 1, token: armed.token, home: choice}), true, JSON.stringify(choice));
    assert.deepEqual(files.find(row => row.action === 'companion-home').home, expected);
  }
  // Not offered: no move-out for a non-housemate, no "all" for one member, nothing for an offer without apartments.
  const single = broker(), one = single.actions.admit(prepared({homeOffer: home()}), single.options('private-text'));
  for (const choice of [{op: 'move-out'}, {op: 'join', target: 'all'}, {op: 'join', target: 2}]) assert.equal(await single.actions.deliver({version: 1, token: one.token, home: choice}), false);
  const members = broker(), noFlats = members.actions.admit(prepared({homeOffer: home({apartments: []})}), members.options('private-text'));
  assert.equal(await members.actions.deliver({version: 1, token: noFlats.token, home: {op: 'stay', apartment: 'corpo'}}), false);
});

test('a leave and a home offer can ride the same private turn; the choice picks the packet', async () => {
  const {actions, files, options} = broker();
  const armed = actions.admit(prepared({leaveOffer: leave(), homeOffer: home()}), options('private-text'));
  assert.ok(armed.leave && armed.home);
  assert.equal(await actions.deliver({version: 1, token: armed.token, leave: 1}), true);
  assert.equal(files.at(-1).action, 'companion-leave');
  const next = broker(), again = next.actions.admit(prepared({leaveOffer: leave(), homeOffer: home()}), next.options('private-text'));
  assert.equal(await next.actions.deliver({version: 1, token: again.token, home: {op: 'stay', apartment: 'glen'}}), true);
  assert.equal(next.files.at(-1).action, 'companion-home');
  const wrong = broker(), mismatch = prepared({homeOffer: home({})}); mismatch.input.homeOffer.actor = {id: '55ULL', key: 'panam-palmer'};
  assert.equal(wrong.actions.admit(mismatch, wrong.options('private-text')), null, 'the offer belongs to the speaker');
  const voice = broker();
  assert.equal(voice.actions.admit(prepared({homeOffer: home()}), voice.options('private-voice')), null, 'a voice source needs the microphone route');
  assert.ok(voice.actions.admit(prepared({homeOffer: home()}, {source: 'private-voice'}), voice.options('private-voice')));
});

// ---- A group round -----------------------------------------------------------------------------------------------------------------

test('the first speaker of a manual group round may carry a leave or a home offer, nothing else', async () => {
  const {actions, files, options} = broker();
  const offer = home({apartments: [], moveOut: false, members: [judy, panam]});
  const config = actions.admit(prepared({homeOffer: offer}, {group: groupOf()}), options('group-text'));
  assert.equal(config.group, true); assert.equal(config.drive, false);
  assert.deepEqual(config.home.members, [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]);
  assert.equal(config.home.moveOut, undefined, 'moveOut=false is not an offer of moving out');
  assert.equal(await actions.deliver({version: 1, token: config.token, home: {op: 'join', target: 'all'}}), true);
  const packet = files.find(row => row.action === 'companion-home');
  assert.deepEqual(packet.home, {op: 'join', target: 'all'}); assert.equal(packet.source, 'group-text');
  assert.deepEqual(packet.homeOffer, offer, 'the moveOut=false the game sent is echoed as it came');
  const accepted = [
    [prepared({homeOffer: offer}, {group: groupOf(), source: 'group-voice'}), 'group-voice'],
    [prepared({leaveOffer: leave(), homeOffer: offer}, {group: groupOf()}), 'group-text'],
    [prepared({leaveOffer: leave()}, {group: groupOf()}), 'group-text'],
  ];
  for (const [p, source] of accepted) { const fresh = broker(); assert.ok(fresh.actions.admit(p, fresh.options(source)), source); }
  const rejected = [
    [prepared({homeOffer: offer}, {group: groupOf(2)}), 'group-text'],
    [prepared({homeOffer: offer}, {group: groupOf()}), 'private-text'],
    [prepared({homeOffer: offer}), 'group-text'],
    [prepared({homeOffer: offer, followOffer: {available: true, actor, name: 'Judy Alvarez'}}, {group: groupOf()}), 'group-text'],
    [prepared({homeOffer: offer, followUnavailable: 'quest'}, {group: groupOf()}), 'group-text'],
    [prepared({homeOffer: offer}, {group: groupOf(), source: 'group-text'}), 'group-voice'],
    [prepared({}, {group: groupOf()}), 'group-text'],
  ];
  for (const [p, source] of rejected) { const fresh = broker(); assert.equal(fresh.actions.admit(p, fresh.options(source)), null, source); }
});

// ---- The Convai window --------------------------------------------------------------------------------------------------------------

test('the window accepts only advertised home action names for its own token, and hands back the choice', () => {
  const now = 10000, window = new CompanionActionWindow({now: () => now});
  const offer = {...config({moveOut: true, members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}), expiresAt: now + 90000};
  assert.equal(window.open(offer), true);
  const rows = homeActions(offer);
  for (const action of [{name: 'Stay At Penthouse'}, {name: `Stay At Penthouse ${TOKEN}`}, {name: `${LEAVE_ACTION} ${TOKEN}`}, {name: 'Stay At Corpo Plaza'},
    {name: 'Stay At Corpo Plaza', target: 'drive-stalestalestalestale'}, {name: `Stay At Corpo Plaza ${TOKEN}`, target: 'drive-stalestalestalestale'}])
    assert.equal(window.accept({actions: [action]}), null, JSON.stringify(action));
  assert.equal(window.accept({actions: [{name: rows[0].name}, {name: rows[1].name}]}), null, 'one action per answer');
  const expected = new Map([['Stay At Corpo Plaza', {op: 'stay', apartment: 'corpo'}], ['Stay At Heywood Glen', {op: 'stay', apartment: 'glen'}],
    ['Move Out', {op: 'move-out'}], ["Join V's Party", {op: 'join', target: 1}], ["Panam Palmer Joins V's Party", {op: 'join', target: 2}],
    ["Everyone Joins V's Party", {op: 'join', target: 'all'}]]);
  for (const row of rows) {
    window.open(offer);
    assert.deepEqual(window.accept({actions: [{name: row.name}]}), {version: 1, token: TOKEN, home: expected.get(row.base)}, row.base);
    assert.equal(window.accept({actions: [{name: row.name}]}), null, 'one use');
    window.open(offer);
    assert.deepEqual(window.accept({actions: [{name: row.base, target: TOKEN}]}), {version: 1, token: TOKEN, home: expected.get(row.base)}, row.base);
  }
});

test('the window refuses a malformed or mixed home offer', () => {
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config()), true);
  for (const change of [o => o.home.apartments[0].id = 'penthouse', o => o.home.members = [{name: 'A', self: true}, {name: 'B', self: true}],
    o => o.home.moveOut = false, o => o.home.extra = 1, o => o.home.lives = '', o => o.home.here = 'x', o => o.home.asked = {from: 'corpo'},
    o => { o.home.apartments = []; o.home.members = []; }, o => o.reaction = {kinds: ['leave']}, o => { o.group = true; }]) {
    const bad = config(); change(bad);
    assert.equal(window.open(bad), false, String(change));
  }
  assert.equal(window.open({...config(), follow: {name: 'Judy'}}), true, 'a follow and a home offer may share a private turn');
  assert.equal(window.open({...config({members: many(12).map(member => ({name: member.name, self: false}))})}), true);
  assert.equal(window.open({...config({members: many(13).map(member => ({name: member.name, self: false}))})}), false);
  const group = {...config({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}), source: 'group-text', group: true};
  assert.equal(window.open(group), true, 'a group window may carry a home offer');
  assert.equal(window.open({...group, source: 'private-text'}), false);
  assert.equal(window.open({...group, home: undefined}), false, 'a group window carries a leave or a home offer');
});

// ---- What the character is told -----------------------------------------------------------------------------------------------------

test('the home prompt names only what the offer carries, with the examples and the non-examples', () => {
  const text = CompanionActionWindow.contextText(config({here: 'glen', lives: 'Corpo Plaza', moveOut: true}));
  assert.match(text, /"Stay At Corpo Plaza/); assert.match(text, /"Stay At Heywood Glen/);
  assert.match(text, /you can stay at my place/); assert.match(text, /move in with me/); assert.match(text, /you can crash at my place/);
  assert.match(text, /stay for dinner/); assert.match(text, /stay here a sec/); assert.match(text, /stay away/);
  assert.match(text, /you live at V's place, in "Corpo Plaza"/);
  assert.match(text, /If V names none, it is "Heywood Glen" \(where V is now\)/);
  assert.match(text, /Never request an apartment that is not listed/);
  assert.match(text, /Move Out/); assert.match(text, /no longer live at V's place/);
  assert.match(text, /One action per answer/);
  assert.match(text, /protocol fields; never say them aloud/);
  assert.ok(text.includes(TOKEN));
  // Only one apartment: that one. Several and V elsewhere: ask which, request nothing.
  assert.match(CompanionActionWindow.contextText(config({apartments: [{...corpo}]})), /If V names none, it is "Corpo Plaza", the only one V has/);
  const ask = CompanionActionWindow.contextText(config());
  assert.match(ask, /ask V in your own words which of them it is and request nothing yet/);
  assert.doesNotMatch(ask, /Move Out/, 'a character who is no housemate is not told about moving out');
  // Members: the speaker alone, or several named.
  assert.match(ask, /"Join V's Party /); assert.match(ask, /come with me/);
  const group = CompanionActionWindow.contextText(config({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}));
  assert.match(group, /"Judy Alvarez" \(you\), "Panam Palmer"/);
  assert.match(group, /only for the people V addressed/); assert.match(group, /"Everyone Joins V's Party /);
  assert.doesNotMatch(group, /Stay At/); assert.doesNotMatch(group, /Move Out/);
  // No members: no joining at all.
  assert.doesNotMatch(CompanionActionWindow.contextText(config({members: []})), /Join V's Party/);
  // The answer to her own question.
  const asked = CompanionActionWindow.contextText(config({here: 'corpo', asked: {from: 'glen', here: 'corpo'}}));
  assert.match(asked, /You asked V in your last reply whether you should stay in "Corpo Plaza" or go back to "Heywood Glen"/);
  assert.match(asked, /request "Stay At Corpo Plaza/);
  assert.equal(CompanionActionWindow.contextText({...config(), home: undefined}), '');
  assert.match(CompanionActionWindow.unavailableText(config()), /live at V's place/);
});

test('a leave member who lives in another flat is not sent away on the first word; once asked, the answer counts', () => {
  const leaveConfig = members => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false, leave: {members}});
  const asking = CompanionActionWindow.contextText(leaveConfig([{name: 'Judy Alvarez', self: true, away: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}]));
  assert.match(asking, /you live in "Corpo Plaza" while V is in "Heywood Glen"/);
  assert.match(asking, /do NOT request leaving yet/);
  assert.match(asking, /stay here \(then you live here from now on\) or go back to "Corpo Plaza"/);
  assert.match(asking, /nothing is requested in this reply/);
  assert.match(asking, /"Leave V's Party /, 'the normal rules are still there');
  const answered = CompanionActionWindow.contextText(leaveConfig([{name: 'Judy Alvarez', self: true, away: true, confirmed: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}]));
  assert.doesNotMatch(answered, /do NOT request leaving yet/);
  assert.match(answered, /asked V last turn whether to stay here or go back to "Corpo Plaza"/);
  assert.match(answered, /going back, going home, leaving or resting, it is a clear request/);
  const plain = CompanionActionWindow.contextText(leaveConfig([{name: 'Judy Alvarez', self: true}]));
  assert.doesNotMatch(plain, /do NOT request leaving yet/); assert.doesNotMatch(plain, /asked V last turn/);
  const group = CompanionActionWindow.contextText({...leaveConfig([{name: 'Judy Alvarez', self: true, away: true, homeName: 'A', hereName: 'B'}, {name: 'Panam Palmer', self: false}]), group: true, source: 'group-text'});
  assert.match(group, /"Judy Alvarez" \(you\) lives in "A" while V is in "B"/); assert.match(group, /not requested while any of them is in this situation/);
  // The flags survive the wire and the lease into the window.
  const {actions, options} = broker();
  const wire = actions.admit(prepared({leaveOffer: leave([{...judy, away: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}])}), options('private-text'));
  assert.deepEqual(wire.leave.members, [{name: 'Judy Alvarez', self: true, away: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}]);
  assert.equal(new CompanionActionWindow({now: () => 10000}).open(wire), true);
  assert.equal(new CompanionActionWindow({now: () => 10000}).open(leaveConfig([{name: 'J', self: true, away: false}])), false);
});

test('the transport advertises exactly the home action names of the offer', async () => {
  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local', publishData: async bytes => sent.push(JSON.parse(new TextDecoder().decode(bytes)))}}};
  await publishCompanionActionContext(client, {text: 'context'}, config({moveOut: true}));
  assert.deepEqual(sent[0].data.action_config.actions, ['Stay At Corpo Plaza', 'Stay At Heywood Glen', 'Move Out', "Join V's Party"].map(name => `${name} ${TOKEN}`));
  assert.match(sent[0].data.action_config.objects[0].description, /^Where you may live and who may join V's party, bound/);
  const group = {...config({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}), source: 'group-text', group: true};
  await publishCompanionActionContext(client, {text: 'context'}, group);
  assert.deepEqual(sent[1].data.action_config.actions, [`Join V's Party ${TOKEN}`, `Panam Palmer Joins V's Party ${TOKEN}`, `Everyone Joins V's Party ${TOKEN}`]);
});

// ---- Move-in apartment (Settings > Housemates): the flat V chose for "move in" when V names none ------------------------------------------

test('the offer may carry the chosen flat, only one of its own apartments, and the window and the prompt follow', () => {
  const chosen = home({fallback: 'glen'});
  assert.deepEqual(parseHomeOffer(chosen), chosen);
  assert.equal(parseHomeOffer(home({fallback: 'h10'})).fallback, undefined, 'a flat the offer does not list is dropped, the offer stays');
  assert.equal(parseHomeOffer(home({fallback: 'penthouse'})), null);
  assert.equal(parseHomeOffer(home({fallback: 3})), null);
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config({fallback: 'glen'})), true);
  assert.equal(window.open(config({fallback: 'h10'})), false);
  assert.equal(window.open(config({fallback: 'nowhere'})), false);
  const text = CompanionActionWindow.contextText(config({fallback: 'glen'}));
  assert.match(text, /If V names none, it is "Heywood Glen" \(the apartment V chose in the settings for this\): do not ask which one\./);
  assert.doesNotMatch(text, /ask V in your own words which of them it is/);
  // Where V stands comes first, then the chosen flat, then the only one.
  assert.match(CompanionActionWindow.contextText(config({fallback: 'glen', here: 'corpo'})), /If V names none, it is "Corpo Plaza" \(where V is now\)/);
  assert.match(CompanionActionWindow.contextText(config()), /ask V in your own words which of them it is/);
});

test('with a chosen flat she does not ask, so V\'s next message is not an answer to a question that was never asked', () => {
  const {actions, options} = broker();
  const turn = (text, extra) => actions.admit(prepared({text, homeOffer: home(extra)}), options('private-text'))?.home;
  assert.equal(turn('you can stay at my place', {here: undefined})?.pick, undefined);
  assert.equal(turn('hmm', {here: undefined})?.pick, true, 'without a choice she asked, and the next message is the answer');
  actions.homePicks.done('judy-alvarez');
  assert.equal(turn('you can stay at my place', {fallback: 'glen'})?.fallback, 'glen', 'the choice reaches the window');
  assert.equal(turn('hmm', {fallback: 'glen'})?.pick, undefined, 'with a choice there was no question');
});
