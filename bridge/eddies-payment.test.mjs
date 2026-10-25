import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenPayment, paymentDecision, parsePayOffer, paymentNote, paidNote, REFUSED_NOTE, NO_PAYMENT_NOTE, PaymentActions, PAY_CAP} from './eddies-payment.mjs';

const NAME = 'Judy Alvarez';
const pays = (text, amount) => assert.deepEqual(screenPayment(text, {name: NAME}), {status: 'pay', amount}, text);
const refuses = text => assert.notEqual(screenPayment(text, {name: NAME}).status, 'pay', text);

// What V may say to pay: a plain payment made now, in each of the 15 menu languages (en de fr es it pt pl ru uk tr cs hu ja ko zh).
const PAYS = [
  ['I paid you 500 eddies', 500], ["I'm paying you 1,200 eddies for the job", 1200], ['Here, take 500 eddies', 500], ["Here's 250 eddies", 250],
  ['I gave Judy 300 eddies', 300], ['I hand you 750 creds', 750], ['take 2k eddies', 2000], ['I just sent you €$500', 500], ['500 eddies for you', 500],
  ['I pay you 40 ed', 40], ['Okay, I transferred 1 000 euro-dollars to you', 1000], ['Have 5.000 eddies, you earned it', 5000], ['i gave you 90 eddies', 90],
  ['Ich zahle dir 500 Eddies', 500], ['Hier, nimm 500 Eddies', 500], ['Ich habe dir 1.000 Eddies gegeben', 1000],
  ['Je te paie 500 eddies', 500], ['Tiens, prends 500 eddies', 500], ["Je t'ai donné 300 eddies", 300],
  ['Te pago 500 eddies', 500], ['Toma 500 eddies', 500], ['Te di 300 eurodólares', 300],
  ['Ti pago 500 eddies', 500], ['Tieni 500 eddies', 500], ['Ti ho dato 300 eddies', 300],
  ['Eu te dei 300 eddies', 300], ['Pega 500 eddies', 500], ['Te pago 200 eurodólares', 200],
  ['Płacę ci 500 eddies', 500], ['Weź 500 eddies', 500], ['Zapłaciłem ci 300 eddies', 300],
  ['Я плачу тебе 500 эдди', 500], ['Держи 500 эдди', 500], ['Вот 300 эдди', 300],
  ['Я плачу тобі 500 едді', 500], ['Тримай 500 едді', 500], ['Ось 300 едді', 300],
  ['Sana 500 eddie ödüyorum', 500], ['Al 500 eddie', 500], ['Sana 300 eddie verdim', 300],
  ['Platím ti 500 eddies', 500], ['Tady máš 500 eddies', 500], ['Zaplatil jsem ti 300 eddies', 300],
  ['Fizetek neked 500 eddie-t', 500], ['Tessék, 500 eddie', 500], ['Adtam neked 300 eddie-t', 300],
  ['お前に500エディ渡す', 500], ['500エディ払うよ', 500], ['はい、500エディ', null],
  ['너한테 500에디 줄게', 500], ['여기 500에디 받아', 500],
  ['我给你500欧元', 500], ['我付你300欧元', 300], ['拿着500欧元', 500], ['给你1000欧元', 1000],
].filter(([, amount]) => amount !== null);

test('V\'s plain payments are read as an amount, in every language', () => {
  for (const [text, amount] of PAYS) pays(text, amount);
});

test('numbers: thousands separators, k, full-width digits and the € $ symbol', () => {
  pays('I paid you 1,000 eddies', 1000); pays('I paid you 1.000 eddies', 1000); pays("I paid you 1'000 eddies", 1000); pays('I paid you 1 000 eddies', 1000);
  pays('I paid you 5k eddies', 5000); pays('I paid you 2.5k eddies', 2500); pays('I paid you ５００ eddies', 500); pays('I paid you €$ 500', 500);
  pays('I paid you $500', 500); pays('I paid you 500€$', 500);
});

// What is never read as a payment, however it sounds.
const REFUSED = [
  // not now: a promise, a condition, a wish, a question
  'I will pay you 500 eddies', "I'll pay you 500 eddies when it is done", 'if I gave you 500 eddies', 'what if I paid you 500 eddies', 'Should I give you 500 eddies?',
  'I would pay you 500 eddies', 'I am going to pay you 500 eddies', 'Maybe I could give you 500 eddies', 'I want to pay you 500 eddies', 'I need to give you 500 eddies',
  'Do you want 500 eddies?', 'how much do I owe you? 500 eddies?', 'How much do I owe you for 500 eddies', 'I owe you 500 eddies', 'Can I pay you 500 eddies', 'I paid you 500 eddies?',
  'I promise to give you 500 eddies', 'I offer you 500 eddies', 'tomorrow I pay you 500 eddies', 'I paid you 500 eddies yesterday', 'I already paid you 500 eddies', 'I gave you 500 eddies last week',
  'I will give you 500 eddies after the job', 'imagine I paid you 500 eddies', 'pretend I gave you 500 eddies', 'I was joking, I paid you 500 eddies',
  // negated or not an amount
  'I did not pay you 500 eddies', "I didn't give you 500 eddies", "I won't pay you 500 eddies", 'I never paid you 500 eddies', 'no, I do not give you 500 eddies', 'I paid you nothing',
  'I paid you 0 eddies', 'I paid you -500 eddies', 'I paid you −500 eddies', 'I paid you 0.5 eddies', 'I paid you 12.50 eddies', 'I paid you 1,5 eddies', 'I paid you 0,500 eddies', 'I paid you 2.55k eddies',
  'I paid you 500', 'I paid you', 'I paid you five hundred eddies', 'I paid you half of my eddies', 'I have 500 eddies', 'This costs 500 eddies', 'a drink is 20 eddies',
  // somebody else pays or is paid, the other way round
  'he paid you 500 eddies', 'she gave you 500 eddies', 'you paid me 500 eddies', 'give me 500 eddies', 'Pay me 500 eddies', 'lend me 500 eddies', 'I paid him 500 eddies', 'I gave them 500 eddies',
  'I paid him 500 eddies, you saw it', 'I paid you 500 eddies and he paid you 300 eddies',
  // two amounts, or taking eddies from somewhere
  'I paid you 500 eddies and 300 eddies', '300 eddies now and 200 eddies later, I pay you', 'take 500 eddies from the safe', 'take 500 eddies out of the stash', 'I robbed 500 eddies from him',
  // other languages
  'Ich zahle dir nicht 500 Eddies', 'Wenn ich dir 500 Eddies zahle', 'Ich werde dir 500 Eddies zahlen', 'Du hast mir 500 Eddies gegeben', 'Er hat dir 500 Eddies gegeben', 'Wie viel? 500 Eddies?',
  'Ich zahle dir morgen 500 Eddies', 'Ich habe dir gestern 500 Eddies gegeben', 'Ich zahle dir 0,5 Eddies',
  'Je ne te paie pas 500 eddies', 'Si je te donne 500 eddies', 'Je vais te payer 500 eddies', 'Il te paie 500 eddies', 'Je te paierai 500 eddies demain', 'Tu me dois 500 eddies', 'Combien ? 500 eddies ?',
  'No te pago 500 eddies', 'Si te pagara 500 eddies', 'Te voy a pagar 500 eddies', 'Él te ha pagado 500 eddies', 'Mañana te pago 500 eddies', 'Te pago 0,5 eddies', 'Dame 500 eddies',
  'Non ti pago 500 eddies', 'Se ti pagassi 500 eddies', 'Ti pagherò 500 eddies', 'Lui ti ha pagato 500 eddies', 'Ti pago domani 500 eddies',
  'Não te pago 500 eddies', 'Se eu te pagasse 500 eddies', 'Vou te pagar 500 eddies', 'Ele te pagou 500 eddies', 'Pago-te amanhã 500 eddies',
  'Nie płacę ci 500 eddies', 'Jeśli zapłacę ci 500 eddies', 'Zapłacę ci 500 eddies', 'Zapłacę ci jutro 500 eddies', 'Ile? 500 eddies?',
  'Я не плачу тебе 500 эдди', 'Если я заплачу тебе 500 эдди', 'Я заплачу тебе 500 эдди', 'Он заплатил тебе 500 эдди', 'Сколько? 500 эдди?', 'Я заплачу завтра 500 эдди',
  'Я не плачу тобі 500 едді', 'Якщо я заплачу тобі 500 едді', 'Я заплачу тобі 500 едді', 'Він заплатив тобі 500 едді',
  'Sana 500 eddie ödemiyorum', 'Sana 500 eddie ödeyeceğim', 'Eğer sana 500 eddie ödersem', 'Sana yarın 500 eddie veririm',
  'Neplatím ti 500 eddies', 'Pokud ti zaplatím 500 eddies', 'On ti zaplatil 500 eddies', 'Zaplatím ti zítra 500 eddies',
  'Nem fizetek neked 500 eddie-t', 'Ha fizetek neked 500 eddie-t', 'Holnap fizetek neked 500 eddie-t', 'Ő fizetett neked 500 eddie-t',
  'お前が500エディ払った', 'もし500エディ払うなら', '明日500エディ払う', '500エディ払わない', '500エディ払う?',
  '네가 500에디 줬어', '내일 500에디 줄게', '500에디 안 줄게', '500에디 줄까?',
  '你给了我500欧元', '如果我给你500欧元', '我不给你500欧元', '我明天给你500欧元', '我给你500欧元吗',
];

test('everything that is not a plain payment made now is refused', () => {
  for (const text of REFUSED) refuses(text);
});

test('a refusal names its reason where it matters', () => {
  assert.equal(screenPayment('I paid you 0 eddies').reason, 'not-positive');
  assert.equal(screenPayment('I paid you -500 eddies').reason, 'negative');
  assert.equal(screenPayment('I paid you 0.5 eddies').reason, 'fraction');
  assert.equal(screenPayment('how much do I owe you? 500 eddies?').reason, 'question');
  assert.equal(screenPayment('I paid you 500 eddies and 300 eddies').reason, 'several-amounts');
  assert.equal(screenPayment('I paid you 500 eddies', {name: 'Judy'}).status, 'pay');
  assert.deepEqual(screenPayment('How are you?'), {status: 'none'});
  assert.deepEqual(screenPayment('Where is the money?'), {status: 'none'});
  assert.deepEqual(screenPayment(''), {status: 'none'});
  assert.deepEqual(screenPayment(undefined), {status: 'none'});
});

test('a huge or odd number never becomes an amount', () => {
  assert.equal(screenPayment('I paid you 99999999999999999999 eddies').status, 'refused');
  assert.equal(screenPayment('I paid you 1e5 eddies').status, 'none');
  assert.equal(screenPayment('x'.repeat(5000) + ' I paid you 500 eddies').status, 'none');
});

const OFFER = {available: true, actor: {id: '100ULL', key: 'judy-alvarez'}, balance: 3000, max: 3000};
const input = (text, extra = {}) => ({requestId: '10-1-100ULL', generation: 1, entity: '100ULL', profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private',
  text, payOffer: OFFER, ...extra});

test('the pay offer is parsed strictly', () => {
  assert.deepEqual(parsePayOffer(OFFER), OFFER);
  assert.deepEqual(parsePayOffer({available: true, actor: {id: '1ULL', key: 'a'}, balance: 500000, max: PAY_CAP}), {available: true, actor: {id: '1ULL', key: 'a'}, balance: 500000, max: PAY_CAP});
  for (const bad of [null, [], {}, {...OFFER, available: false}, {...OFFER, extra: 1}, {...OFFER, balance: 0}, {...OFFER, balance: 1.5}, {...OFFER, balance: '3000'},
    {...OFFER, max: 3001}, {...OFFER, max: 2000}, {available: true, actor: {id: '1ULL', key: 'a'}, balance: 500000, max: 500000}, {...OFFER, actor: {id: 'x', key: 'judy'}},
    {...OFFER, actor: {id: '100ULL', key: 'Judy'}}, {...OFFER, actor: {id: '100ULL', key: 'judy', more: 1}}]) assert.equal(parsePayOffer(bad), null, JSON.stringify(bad));
});

test('the decision follows the offer: a whole number from 1 to the balance, never above the cap', () => {
  assert.deepEqual(paymentDecision(input('I paid you 500 eddies')), {status: 'pay', amount: 500, offer: OFFER});
  assert.deepEqual(paymentDecision(input('I paid you 3000 eddies')).amount, 3000);
  assert.deepEqual(paymentDecision(input('I paid you 3001 eddies')), {status: 'refused', reason: 'balance', amount: 3001});
  const rich = {available: true, actor: OFFER.actor, balance: 900000, max: PAY_CAP};
  assert.equal(paymentDecision(input('I paid you 100000 eddies', {payOffer: rich})).status, 'pay');
  assert.deepEqual(paymentDecision(input('I paid you 100001 eddies', {payOffer: rich})), {status: 'refused', reason: 'cap', amount: 100001});
  assert.equal(paymentDecision(input('I paid you 500 eddies', {payOffer: undefined})).status, 'none');
  assert.equal(paymentDecision(input('I paid you 500 eddies', {payOffer: {...OFFER, available: false}})).status, 'none');
});

test('no payment without the game\'s offer for this very character, in person, on a private manual turn', () => {
  const pay = 'I paid you 500 eddies';
  assert.equal(paymentDecision(input(pay, {entity: '200ULL'})).status, 'none');
  assert.equal(paymentDecision(input(pay, {profileKey: 'panam-palmer'})).status, 'none');
  assert.equal(paymentDecision(input(pay, {reaction: {kind: 'loot'}})).status, 'none');
  assert.equal(paymentDecision(input(pay, {group: {index: 1}})).status, 'none');
  assert.equal(paymentDecision(input(pay, {channel: 'phone'})).status, 'none');
  assert.equal(paymentDecision(null).status, 'none');
});

test('what the character is told', () => {
  assert.equal(paymentNote(input('I paid you 500 eddies'), true), paidNote(500));
  assert.match(paidNote(500), /V just paid you 500 eddies/);
  assert.match(paidNote(500), /Do not ask for the eddies again/);
  assert.equal(paymentNote(input('I paid you 3500 eddies'), true), REFUSED_NOTE(3500));
  assert.match(REFUSED_NOTE(3500), /took none of it/);
  assert.equal(paymentNote(input('I will pay you 500 eddies'), true), NO_PAYMENT_NOTE);
  assert.equal(paymentNote(input('I paid you 0.5 eddies'), true), NO_PAYMENT_NOTE);
  assert.match(NO_PAYMENT_NOTE, /no eddies changed hands/);
  // a line that is not about money adds nothing; no offer leaves the words-only note to the caller
  assert.equal(paymentNote(input('How are you?'), false), '');
  assert.equal(paymentNote(input('I paid you 500 eddies', {payOffer: undefined}), true), '');
});

const prepared = (text, extra = {}) => ({input: input(text, extra.input), route: {channel: 'private', transport: 'text'}, sendAllowed: true, worldToken: 'world-a', generation: 3});
function host(overrides = {}) {
  const packets = [], logs = [];
  const actions = new PaymentActions({publish: async (packet, options) => { packets.push({packet, options}); return overrides.published ?? true; }, createToken: () => 'pay-token-1',
    now: () => 1000, log: line => logs.push(line)});
  return {actions, packets, logs, args: (extra = {}) => ({source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true, ...extra})};
}

test('a plain payment becomes one packet that echoes the offer, and nothing else does', async () => {
  const {actions, packets, logs, args} = host();
  const result = await actions.admit(prepared('I paid you 500 eddies'), args());
  assert.deepEqual(result, {paid: true, amount: 500});
  assert.equal(packets.length, 1);
  const {packet} = packets[0];
  assert.deepEqual(packet, {version: 1, action: 'companion-pay', actionId: 'pay-token-1', requestId: '10-1-100ULL', generation: 1, entity: '100ULL', profileKey: 'judy-alvarez',
    worldToken: 'world-a', worldGeneration: 3, source: 'private-text', createdAt: 1000, expiresAt: 6000, pay: {amount: 500}, payOffer: OFFER});
  assert.match(logs.at(-1), /amount=500 handed-over=yes/);
  // the same request never pays twice
  assert.equal((await actions.admit(prepared('I paid you 500 eddies'), args())).paid, false);
  assert.equal(packets.length, 1);
});

test('the packet waits for the mailbox clearing of the new turn', async () => {
  const order = [];
  const {actions, packets, args} = host();
  const clearing = new Promise(done => setTimeout(() => { order.push('cleared'); done(); }, 10));
  const result = actions.admit(prepared('I paid you 500 eddies'), args({after: clearing}));
  assert.equal(packets.length, 0);
  await result; order.push('published');
  assert.deepEqual(order, ['cleared', 'published']);
});

test('refused talk, a spoken line, a group round, an old or aborted turn pays nothing', async () => {
  for (const text of ['I will pay you 500 eddies', 'I paid you 5000 eddies', 'how much do I owe you? 500 eddies?', 'Hello']) {
    const {actions, packets, args} = host();
    assert.equal((await actions.admit(prepared(text), args())).paid, false, text);
    assert.equal(packets.length, 0);
  }
  const cases = [
    [{source: 'private-voice'}, null], [{source: 'group-text'}, null], [{source: undefined}, null], [{isCurrentSync: () => false}, null], [{isCurrent: undefined}, null],
    [{signal: AbortSignal.abort()}, null], [{}, {route: {channel: 'phone', transport: 'text'}}], [{}, {route: {channel: 'private', transport: 'microphone'}}],
    [{}, {sendAllowed: false}], [{}, {worldToken: ''}], [{}, {generation: 0}], [{}, {input: {reaction: {kind: 'loot'}}}], [{}, {input: {group: {index: 1}}}], [{}, {input: {requestId: 'x'}}],
    [{}, {input: {channel: 'phone'}}], [{}, {input: {payOffer: undefined}}],
  ];
  for (const [argOverride, preparedOverride] of cases) {
    const {actions, packets, args} = host();
    const turn = {...prepared('I paid you 500 eddies', preparedOverride ?? {}), ...(preparedOverride ?? {})};
    if (preparedOverride?.input) turn.input = input('I paid you 500 eddies', preparedOverride.input);
    assert.equal((await actions.admit(turn, args(argOverride))).paid, false, JSON.stringify([argOverride, preparedOverride]));
    assert.equal(packets.length, 0, JSON.stringify([argOverride, preparedOverride]));
  }
});

test('a mailbox write that did not happen is reported as not paid', async () => {
  const {actions, logs, args} = host({published: false});
  assert.deepEqual(await actions.admit(prepared('I paid you 500 eddies'), args()), {paid: false, why: 'not-published'});
  assert.match(logs.at(-1), /handed-over=no\(not-published\)/);
});

// The whole turn on the bridge: the game's request, what the character is told, and the words-only note that stays for a turn without an offer.
const {parseInput} = await import('./protocol.mjs');
const {conversationContext} = await import('./quest-context.mjs');
const {MONEY_NOTE} = await import('./turn-context.mjs');
const request = (text, extra = {}) => parseInput(JSON.stringify({requestId: '100-1-100ULL', generation: 1, entity: '100ULL', profileKey: 'judy-alvarez', name: 'Judy Alvarez',
  bodyType: 'WomanAverage', channel: 'private', text, payOffer: OFFER, ...extra}));

test('the request carries the offer through the parser, and not on a group round or an automatic reaction', () => {
  assert.deepEqual(request('I paid you 500 eddies').payOffer, OFFER);
  assert.equal(request('I paid you 500 eddies', {payOffer: {...OFFER, max: 9}}).payOffer, undefined);
  assert.equal(request('I paid you 500 eddies', {payOffer: undefined}).payOffer, undefined);
  assert.equal(request('I paid you 500 eddies', {group: {id: 'g1', index: 1, count: 2, participants: [{entity: '100ULL', profileKey: 'judy-alvarez', name: 'Judy'}]}})?.payOffer, undefined);
});

test('the character is told what really happened, in the prompt of every provider', () => {
  assert.ok(conversationContext(request('I paid you 500 eddies')).includes(paidNote(500)));
  assert.ok(!conversationContext(request('I paid you 500 eddies')).includes(MONEY_NOTE), 'the words-only note is replaced');
  assert.ok(conversationContext(request('I paid you 5000 eddies')).includes(REFUSED_NOTE(5000)));
  assert.ok(conversationContext(request('I will pay you 500 eddies')).includes(NO_PAYMENT_NOTE));
  assert.ok(conversationContext(request('I paid you 0.5 eddies')).includes(NO_PAYMENT_NOTE));
  assert.ok(conversationContext(request('here is some cash for you')).includes(NO_PAYMENT_NOTE));
  assert.ok(!conversationContext(request('So what now?')).includes('Money:'));
  // no offer (the setting Off, a game-placed character, a spoken line): the words-only note, exactly as before
  const plain = conversationContext(request('I gave you 500 eddies', {payOffer: undefined}));
  assert.ok(plain.includes(MONEY_NOTE) && !plain.includes('just paid you'));
});
