// Housemates on the text routes (Mistral, Local AI, Custom): the decision step knows stay / move-out / join, the screen keeps ordinary messages free, and the
// game gets the same message the Convai client would send (docs/HOUSEMATES.md). Offline: a fake model server, no game, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {actionMenu, HOME_CODES, ACTION_CODES} from './text-actions.mjs';
import {mentions, mentionsLiving, screenWords} from './text-action-words.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const TOKEN = 'drive-0123456789abcdefghij';
const corpo = {id: 'corpo', name: 'Corpo Plaza'}, glen = {id: 'glen', name: 'Heywood Glen'};
const offerOf = (home, extra = {}) => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false,
  home: {apartments: [corpo, glen], members: [{name: 'Judy Alvarez', self: true}], ...home}, ...extra});
const message = home => ({version: 1, token: TOKEN, home});

test('the offered home actions become rows, and the old action codes are unchanged', () => {
  assert.deepEqual(ACTION_CODES, ['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE']);
  assert.deepEqual(HOME_CODES, ['STAY', 'MOVEOUT', 'JOIN']);
  assert.deepEqual(actionMenu(offerOf({})).codes, ['STAY', 'JOIN']);
  assert.deepEqual(actionMenu(offerOf({moveOut: true})).codes, ['STAY', 'MOVEOUT', 'JOIN']);
  assert.deepEqual(actionMenu(offerOf({apartments: [], members: []})), null, 'nothing offered, nothing said');
  assert.deepEqual(actionMenu(offerOf({members: []})).codes, ['STAY']);
  assert.deepEqual(actionMenu(offerOf({apartments: []})).codes, ['JOIN']);
  assert.deepEqual(actionMenu({...offerOf({}), home: {apartments: [{id: 1}], members: 'x'}}), null, 'a malformed home is no offer');
  const both = actionMenu(offerOf({}, {leave: {members: [{name: 'Judy Alvarez', self: true}]}}));
  assert.deepEqual(both.codes, ['LEAVE', 'STAY', 'JOIN']);
});

test('stay resolves the apartment V named, else the answer to her question, the flat V is in, or the only one; an invented one is nothing', () => {
  const menu = actionMenu(offerOf({}));
  assert.deepEqual(menu.message({code: 'STAY', argument: 'glen'}), message({op: 'stay', apartment: 'glen'}));
  assert.deepEqual(menu.message({code: 'STAY', argument: 'Heywood Glen'}), message({op: 'stay', apartment: 'glen'}));
  assert.deepEqual(menu.message({code: 'STAY', argument: 'corpo plaza'}), message({op: 'stay', apartment: 'corpo'}));
  assert.deepEqual(menu.message({code: 'STAY', argument: 'Corpo'}), message({op: 'stay', apartment: 'corpo'}));
  assert.equal(menu.message({code: 'STAY', argument: 'h10'}), null, 'not an apartment of the offer');
  assert.equal(menu.message({code: 'STAY', argument: 'the penthouse'}), null);
  assert.equal(menu.message({code: 'STAY', argument: ''}), null, 'two apartments, none named, V elsewhere: she asks');
  assert.equal(menu.message({code: 'MOVEOUT', argument: ''}), null, 'not offered');
  assert.deepEqual(actionMenu(offerOf({here: 'glen'})).message({code: 'STAY', argument: ''}), message({op: 'stay', apartment: 'glen'}));
  assert.deepEqual(actionMenu(offerOf({apartments: [corpo]})).message({code: 'STAY', argument: ''}), message({op: 'stay', apartment: 'corpo'}));
  const asked = actionMenu(offerOf({here: 'corpo', asked: {from: 'glen', here: 'corpo'}}));
  assert.deepEqual(asked.message({code: 'STAY', argument: ''}), message({op: 'stay', apartment: 'corpo'}));
  assert.match(asked.classifier({text: 'stay here'})[0].content, /asked whether she stays in "Corpo Plaza" or goes back to "Heywood Glen"/);
});

test('move-out and join resolve against the offer; a group join must name somebody', () => {
  const menu = actionMenu(offerOf({moveOut: true, members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}));
  assert.deepEqual(menu.message({code: 'MOVEOUT', argument: ''}), message({op: 'move-out'}));
  assert.deepEqual(menu.message({code: 'JOIN', argument: ''}), message({op: 'join', target: 1}), 'a private chat: V speaks to her');
  assert.deepEqual(menu.message({code: 'JOIN', argument: 'Panam'}), message({op: 'join', target: 2}));
  assert.deepEqual(menu.message({code: 'JOIN', argument: 'panam palmer'}), message({op: 'join', target: 2}));
  assert.deepEqual(menu.message({code: 'JOIN', argument: 'ALL'}), message({op: 'join', target: 'all'}));
  assert.equal(menu.message({code: 'JOIN', argument: 'Rogue'}), null);
  const group = actionMenu(offerOf({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}, {group: true, source: 'group-text'}));
  assert.equal(group.message({code: 'JOIN', argument: ''}), null, 'a group join must name somebody');
  assert.deepEqual(group.message({code: 'JOIN', argument: 'Panam'}), message({op: 'join', target: 2}));
  assert.deepEqual(actionMenu(offerOf({apartments: []})).message({code: 'JOIN', argument: 'all'}), message({op: 'join', target: 1}), 'ALL of one is that one');
});

test('the decision request lists the offered home codes and the answer is read for them only', () => {
  const menu = actionMenu(offerOf({moveOut: true}, {leave: {members: [{name: 'Judy Alvarez', self: true}]}}));
  const [system, user] = menu.classifier({text: 'you can stay at my place', last: {v: 'hi', r: 'Hey V.'}});
  assert.match(system.content, /STAY:[\s\S]*MOVEOUT:[\s\S]*JOIN:/);
  assert.match(system.content, /corpo = "Corpo Plaza", glen = "Heywood Glen"/);
  assert.match(system.content, /you can stay at my place/); assert.match(system.content, /stay for dinner/i);
  assert.match(system.content, /Answer with one word only: DISMISSED, STAY, MOVEOUT, JOIN, NONE \(STAY must be followed by the apartment id\) \(JOIN may be followed by a name or ALL\)/);
  assert.match(system.content, /STAY must be followed by the apartment id/);
  assert.doesNotMatch(JSON.stringify(system), new RegExp(TOKEN));
  assert.match(user.content, /V's new message: "you can stay at my place"$/);
  assert.deepEqual(menu.decide('STAY glen'), {code: 'STAY', argument: 'glen'});
  assert.deepEqual(menu.decide('stay: corpo.'), {code: 'STAY', argument: 'corpo'});
  assert.deepEqual(menu.decide('STAY'), {code: 'STAY', argument: ''});
  assert.deepEqual(menu.decide('MOVEOUT'), {code: 'MOVEOUT', argument: ''});
  assert.deepEqual(menu.decide('Move out'), {code: 'MOVEOUT', argument: ''});
  assert.deepEqual(menu.decide('move-out.'), {code: 'MOVEOUT', argument: ''});
  assert.equal(menu.decide('MOVEOUT now'), null, 'only a stay, a join or a leave may carry a word');
  assert.deepEqual(menu.decide('JOIN ALL'), {code: 'JOIN', argument: 'ALL'});
  assert.deepEqual(menu.decide('JOIN Panam'), {code: 'JOIN', argument: 'Panam'});
  assert.equal(menu.decide('NONE'), null);
  assert.equal(menu.decide('DRIVE'), null);
  const only = actionMenu(offerOf({apartments: []}));
  assert.equal(only.decide('STAY glen'), null, 'not offered this turn');
  assert.doesNotMatch(only.classifier({text: 'x'})[0].content, /STAY|MOVEOUT/);
});

test('the reply is told what happened, and what to do when V did not say which apartment', () => {
  const menu = actionMenu(offerOf({lives: 'Heywood Glen'}));
  assert.match(menu.notes('STAY'), /GAME ACTIONS: V is telling you that you may live at V's place \("Corpo Plaza", "Heywood Glen"\)/);
  assert.match(menu.notes('STAY'), /agree in your own words/);
  assert.match(menu.notes(null), /You live at V's place, in "Heywood Glen"/);
  assert.match(menu.notes(null), /without saying which of V's apartments .*ask V in your own words which one: nothing happens until V answers/);
  assert.doesNotMatch(menu.notes(null), /stay behind/, 'stay is a game word now; waiting on a spot is still refused');
  assert.match(menu.notes(null), /cannot wait on a spot, sit on command/);
  assert.doesNotMatch(actionMenu(offerOf({here: 'glen'})).notes(null), /ask V in your own words which one/);
  assert.doesNotMatch(actionMenu(offerOf({apartments: [corpo]})).notes(null), /ask V in your own words which one/);
  assert.doesNotMatch(JSON.stringify([menu.notes('STAY'), menu.classifier({text: 'x'})]), /\[[A-Z]/, 'the character never sees a code');
  // Without a home offer nothing about staying is said, and the old sentence is as it was.
  assert.match(actionMenu({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false, follow: {name: 'Judy'}}).notes(null), /cannot wait on a spot, stay behind, sit on command/);
});

test('a companion who lives in another flat is not sent home on the first word; once asked, the answer is an ordinary leave', () => {
  const leave = member => offerOf({apartments: [], members: []}, {home: undefined, leave: {members: [{name: 'Judy Alvarez', self: true, ...member}]}});
  const asking = actionMenu(leave({away: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}));
  assert.deepEqual(asking.codes, [], 'no leave this turn');
  assert.deepEqual(asking.screen('go home, you can go', undefined), []);
  assert.match(asking.notes(null), /You live in "Corpo Plaza" and V is in "Heywood Glen" now/);
  assert.match(asking.notes(null), /nobody leaves yet: you ask V in your own words whether you should stay here \(then you live here from now on\) or go back to "Corpo Plaza"/);
  assert.equal(asking.classifier({text: 'go home'}), null);
  assert.match(asking.notes(null), /not asking you to do anything the game can carry out/);
  const answered = actionMenu(leave({away: true, confirmed: true, homeName: 'Corpo Plaza', hereName: 'Heywood Glen'}));
  assert.deepEqual(answered.codes, ['LEAVE']);
  assert.deepEqual(answered.message({code: 'LEAVE', argument: ''}), {version: 1, token: TOKEN, leave: 1});
  assert.doesNotMatch(answered.notes('LEAVE'), /nobody leaves yet/);
  // Several: only the ones who may leave can be named; "all" is refused while one still has to be asked.
  const group = actionMenu(offerOf({}, {home: undefined, group: true, leave: {members: [{name: 'Judy Alvarez', self: true, away: true},
    {name: 'Panam Palmer', self: false}, {name: 'Jackie Welles', self: false}]}}));
  assert.deepEqual(group.codes, ['LEAVE']);
  assert.match(group.classifier({text: 'go home'})[0].content, /"Panam Palmer", "Jackie Welles" away/);
  assert.doesNotMatch(group.classifier({text: 'go home'})[0].content, /"Judy Alvarez"/);
  assert.deepEqual(group.message({code: 'LEAVE', argument: 'Panam'}), {version: 1, token: TOKEN, leave: 2});
  assert.equal(group.message({code: 'LEAVE', argument: 'Judy'}), null);
  assert.equal(group.message({code: 'LEAVE', argument: 'ALL'}), null);
  // More than three companions may leave now.
  const six = actionMenu(offerOf({}, {home: undefined, group: true, leave: {members: Array.from({length: 6}, (_v, i) => ({name: `Person ${i}`, self: i === 0}))}}));
  assert.deepEqual(six.message({code: 'LEAVE', argument: 'ALL'}), {version: 1, token: TOKEN, leave: 'all'});
});

// ---- The screen -----------------------------------------------------------------------------------------------------------------------

test('ordinary messages pay nothing; real requests in the menu languages pass the screen', () => {
  const menu = actionMenu(offerOf({moveOut: true, members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}));
  for (const text of ['how was your day', 'what do you think about the new job?', 'I got a new gun', 'that was a crazy night', 'thanks Judy', 'Hello', 'tell me about Evelyn'])
    assert.deepEqual(menu.screen(text, undefined), [], text);
  const yes = [['you can stay at my place', 'STAY'], ['move in with me', 'STAY'], ['you can crash at my place', 'STAY'], ['live with me', 'STAY'],
    ['du kannst bei mir wohnen', 'STAY'], ['tu peux rester chez moi', 'STAY'], ['puedes quedarte en mi casa', 'STAY'], ['puoi restare da me', 'STAY'],
    ['pode ficar na minha casa', 'STAY'], ['możesz u mnie zamieszkać', 'STAY'], ['можешь остаться у меня', 'STAY'], ['можеш залишитись у мене', 'STAY'],
    ['evimde kalabilirsin', 'STAY'], ['můžeš zůstat u mě', 'STAY'], ['maradhatsz nálam', 'STAY'], ['うちに住んでいいよ', 'STAY'], ['우리 집에서 지내도 돼', 'STAY'], ['你可以住我家', 'STAY'],
    ['time to find your own place', 'MOVEOUT'], ['you have to move out', 'MOVEOUT'], ['such dir eine eigene wohnung', 'MOVEOUT'], ['ya no puedes quedarte aquí', 'MOVEOUT'],
    ['come with me', 'JOIN'], ['join us', 'JOIN'], ["everyone, let's go", 'JOIN'], ['tag along', 'JOIN'], ['komm mit', 'JOIN'], ['viens avec moi', 'JOIN'],
    ['пойдем со мной', 'JOIN'], ['一緒に来て', 'JOIN'], ['跟我来', 'JOIN']];
  for (const [text, code] of yes) assert.ok(menu.screen(text, undefined).includes(code), `${text} -> ${code}: ${menu.screen(text, undefined)}`);
  // Words of a code that is not offered this turn do not count.
  assert.deepEqual(actionMenu(offerOf({apartments: []})).screen('you can stay at my place', undefined), []);
  assert.ok(mentionsLiving('you can stay at my place') && !mentionsLiving('come to my place'), 'a place word alone is not living there');
  assert.ok(mentions('STAY', 'stay') && !mentions('STAY', 'stray'));
  assert.deepEqual(screenWords('you can stay at my place', {codes: ['FIGHT']}), []);
  assert.deepEqual(screenWords('you can stay at my place', {codes: ['STAY', 'JOIN']}), ['STAY']);
});

test('a short answer to her own question, or one of V\'s apartments named, goes to the decision', () => {
  const menu = actionMenu(offerOf({here: 'corpo', asked: {from: 'glen', here: 'corpo'}}, {leave: {members: [{name: 'Judy Alvarez', self: true, away: true, confirmed: true, homeName: 'Heywood Glen', hereName: 'Corpo Plaza'}]}}));
  assert.deepEqual(menu.codes.sort(), ['JOIN', 'LEAVE', 'STAY']);
  for (const text of ['here', 'yeah stay here', 'no go back', 'the corpo one', 'ok'])
    assert.ok(menu.screen(text, undefined).includes('STAY') && menu.screen(text, undefined).includes('LEAVE'), text);
  assert.deepEqual(menu.screen('please tell me a very long story about the old days in the city of dreams', undefined).includes('STAY'), false);
  const plain = actionMenu(offerOf({}));
  assert.deepEqual(plain.screen('the Glen one', undefined), ['STAY']);
  assert.deepEqual(plain.screen('corpo', undefined), ['STAY']);
  assert.deepEqual(plain.screen('ok', undefined), []);
  // After her own question the screen reads her last line: a short "yes" belongs to the action she asked about.
  assert.deepEqual(plain.screen('yes', {v: 'hi', r: 'Which place should I stay at, V?'}), ['STAY']);
});

test('a move-in with nobody to fall back on is not written as agreed before the decision', () => {
  const menu = actionMenu(offerOf({}));
  assert.equal(menu.guess('you can stay at my place', ['STAY']), null, 'the reply waits: she has to ask which');
  assert.equal(menu.guess('you can stay at my place in Glen', ['STAY']), 'STAY');
  assert.equal(actionMenu(offerOf({here: 'glen'})).guess('you can stay at my place', ['STAY']), 'STAY');
  assert.equal(menu.guess('do you know anyone who could stay at my place?', ['STAY']), 'NONE');
  assert.equal(actionMenu(offerOf({moveOut: true})).guess('move out', ['MOVEOUT']), 'MOVEOUT');
  assert.equal(menu.settle('come with me', ['JOIN']), null, 'a home action is always the model\'s to decide');
  assert.equal(menu.explicit('come with me'), null, 'the plain-words safety net never starts a housing action');
});

// ---- The host: the fake provider -----------------------------------------------------------------------------------------------------

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
async function fakeServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      const answer = script(body, requests.length);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of String(answer).match(/.{1,5}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
async function harness(script) {
  const server = await fakeServer(script);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const delivered = [], logs = [];
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, log: line => logs.push(line),
    routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, cacheScope: 'scope1'})},
    deliverAction: async value => { delivered.push(value); return true; }});
  return {server, host, delivered, logs, close: async () => { host.close(); await server.close(); }};
}
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON', sessionId: 'session-1',
  contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'Quest: Heist.', volatile: 'Whether you ask V anything is your own call.'},
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});
const settle = () => new Promise(done => setTimeout(done, 10));
const isDecision = body => /^You read one message from V/.test(body.messages[0].content);
const script = (decide, reply) => body => isDecision(body) ? decide(body.messages.at(-1).content) : (typeof reply === 'function' ? reply(body) : reply);

test('Mistral: "you can stay at my place" is decided as a stay, the game gets the message and the reply is told', async () => {
  const {server, host, delivered, close} = await harness(script(() => 'STAY glen', 'Really? Okay, I will take it.'));
  try {
    const result = await host.reply(turn('You can stay at my place in Glen, Judy.', {companionAction: offerOf({})}));
    await settle();
    assert.deepEqual(delivered, [message({op: 'stay', apartment: 'glen'})]);
    assert.equal(result.text, 'Really? Okay, I will take it.');
    const decision = server.requests.find(isDecision), replyBody = server.requests.find(body => !isDecision(body));
    assert.equal(decision.max_tokens, 12);
    assert.match(decision.messages[0].content, /corpo = "Corpo Plaza", glen = "Heywood Glen"/);
    assert.match(replyBody.messages.at(-1).content, /GAME ACTIONS: V is telling you that you may live at V's place/);
  } finally { await close(); }
});

test('Mistral: ordinary talk sends no decision; look-alikes, an unoffered apartment and an unclear answer deliver nothing', async () => {
  const {server, host, delivered, close} = await harness(script(text => /dinner/.test(text) ? 'NONE' : /Atlantis/.test(text) ? 'STAY atlantis' : 'maybe?', 'Fine.'));
  try {
    await host.reply(turn('how was your day, Judy?', {companionAction: offerOf({})}));
    assert.equal(server.requests.filter(isDecision).length, 0, 'nothing in the line a request could use');
    await host.reply(turn('stay for dinner, Judy?', {companionAction: offerOf({})}));
    await host.reply(turn('you can stay at my place in Atlantis', {companionAction: offerOf({})}));
    await host.reply(turn('move in with me', {companionAction: offerOf({})}));
    await settle();
    assert.deepEqual(delivered, []);
    assert.equal(server.requests.filter(isDecision).length, 3);
  } finally { await close(); }
});

test('Mistral: move out, join and a named group join are delivered as the offered choices', async () => {
  const cases = [
    ['MOVEOUT', 'time to find your own place, Judy', offerOf({moveOut: true}), message({op: 'move-out'})],
    ['JOIN', 'come with me, Judy', offerOf({}), message({op: 'join', target: 1})],
    ['JOIN Panam', 'Panam, come along', offerOf({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}, {group: true, source: 'group-text'}),
      message({op: 'join', target: 2})],
    ['JOIN ALL', 'everyone, come with me', offerOf({apartments: [], members: [{name: 'Judy Alvarez', self: true}, {name: 'Panam Palmer', self: false}]}, {group: true, source: 'group-text'}),
      message({op: 'join', target: 'all'})],
  ];
  for (const [answer, text, offer, expected] of cases) {
    const {host, delivered, close} = await harness(script(() => answer, 'On it.'));
    try {
      await host.reply(turn(text, {companionAction: offer}));
      await settle();
      assert.deepEqual(delivered, [expected], answer);
    } finally { await close(); }
  }
});
