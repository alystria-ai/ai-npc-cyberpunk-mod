import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {companionEngine} from './companion-fixture.mjs';
import {run} from './startup-lua-fixture.mjs';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PaymentActions} from './eddies-payment.mjs';

// The owner's live test of 2026-10-26 ("I pay you 500 eddies" to Judy in the party: no pop-up), end to end with the REAL modules and nothing faked between them:
// the real companions.lua (a spawned party copy, a housemate), the real eddies-payment.lua over a strict fake of the game's transaction system (it only answers
// the Items.money item id), the real gameplay-actions.lua lease with CET's no-_G environment and a JSON codec, the real request parser and knowledge preparation of
// the bridge, the screen, the packet, and back into the lease. Phase one writes the request, the bridge decides, phase two replays the same game state and hands the
// packet to the lease (the clock and the ids are fixed, so both phases build the same lease).
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const paymentSource = read('../mod/eddies-payment.lua');
const actionsSource = read('../mod/gameplay-actions.lua');

const game = (body, {packet = null, enabled = true, text, kind = 'party'}) => `
  ${companionEngine}
  local BALANCE = 1200436
  local logs, queued, feedback, removed = {}, {}, {}, {}
  ItemID = {FromTDBID = function(id) return {tdb = id} end}
  local wallet = {
    GetItemQuantity = function(_, who, id)
      assert(who == Game.GetPlayer(), 'the balance is read for V')
      assert(type(id) == 'table' and id.tdb == 'Items.money', 'only the Items.money id')
      return BALANCE
    end,
    RemoveItem = function(_, who, id, amount)
      assert(who == Game.GetPlayer() and type(id) == 'table' and id.tdb == 'Items.money' and type(amount) == 'number')
      removed[#removed + 1] = amount; BALANCE = BALANCE - amount; return true
    end}
  local previous = Game.GetTransactionSystem
  Game.GetTransactionSystem = function() return wallet end
  -- A copy of Judy: a party member (state ready) or a housemate's visiting body, spawned by the real module.
  local serial
  if ${JSON.stringify(kind)} == 'party' then serial = companions.spawn('judy-alvarez'); tick(3)
  elseif ${JSON.stringify(kind)} == 'housemate' then
    serial = companions.spawn('judy-alvarez', {profileKey = 'judy-alvarez', profileName = 'Judy', appointment = {id = 'hm:judy', position = Vector4.new(10, 10, 0),
      facing = {x = 0, y = 1}, owner = 'housemates', home = 'corpo'}}); tick()
  end
  local entity = ${JSON.stringify(kind)} == 'game' and '77777ULL' or tostring(entities[sequence].id.hash) .. 'ULL'
  local switch = ${enabled ? 'true' : 'false'}
  local pay = (function() ${paymentSource} end)().new({
    enabled = function() return switch end,
    -- The game's entity strings end in ULL (a 64-bit hash); the fixture's entity hashes are plain numbers, so the suffix is taken off here only.
    payable = function(e, key) return companions.payable((e:gsub('ULL$', '')), key) end,
    player = function() return Game.GetPlayer() end,
    log = function(line) logs[#logs + 1] = line end})
  local now = 1792967548000
  local world = {ready = true, worldToken = 'world-a', generation = 2}
  local packetRaw = ${packet === null ? 'nil' : `[==[${packet}]==]`}
  local actions = (function() ${actionsSource} end)().new({
    world = function() return world end, clock = function() return now end,
    payOffer = function(e, context) return pay.offer(e, context) end,
    queuePay = function(amount, offer, e, requestId)
      local paid, code = pay.pay(amount, offer, e, requestId)
      queued[#queued + 1] = {amount = amount, paid = paid, code = code}
      return paid == true, code
    end,
    read = function() return packetRaw end,
    developerMode = function() return false end,
    feedback = function(state, reason) feedback[#feedback + 1] = state .. ':' .. tostring(reason) end,
    log = function(line) logs[#logs + 1] = line end})
  local context = {requestId = '1792967548-2-' .. entity, generation = 2, entity = entity, name = 'Judy Alvarez', bodyType = 'WomanAverage',
    profileKey = 'judy-alvarez', text = ${JSON.stringify(text)}}
  local leased = actions.capture(context, 'private-text')
  ${body}
`;

// The request exactly as the game writes it, and what the bridge makes of it.
async function bridgeDecision(requestJson, {publishTo}) {
  const parsed = parseInput(requestJson);
  assert.ok(parsed, 'the bridge accepts the request');
  const boundary = {worldToken: 'world-a', generation: 2};
  const guard = {endUserId: 'u', characterId: 'c', resetEpoch: 0, characterEpoch: 0};
  const router = new PlayerKnowledge({
    playerMemory: {route: () => ({endUserId: guard.endUserId, guard}), isCurrent: value => JSON.stringify(value) === JSON.stringify(guard)},
    pack: {version: 1, id: 'live', revision: 1, gameVersions: ['2.5'], profileKeys: ['judy-alvarez'], sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    getBoundary: () => boundary, isWorldCurrent: () => true});
  const prepared = await router.prepare(parsed, boundary);
  const lines = [];
  const payments = new PaymentActions({createToken: () => 'pay-live', now: () => 1792967549000, log: line => lines.push(line),
    publish: async packet => { publishTo.push(packet); return true; }});
  const result = await payments.admit(prepared, {source: 'private-text', signal: new AbortController().signal, after: Promise.resolve(),
    isCurrent: async () => true, isCurrentSync: () => true});
  return {parsed, result, lines};
}

async function journey(text, options = {}) {
  const request = run(game(`report('request', json.encode(context)); report('leased', leased); report('gameLogs', logs)`, {text, ...options}), {locale: false});
  const published = [];
  const bridge = await bridgeDecision(request.request, {publishTo: published});
  let after = null;
  if (published.length) {
    after = run(game(`
      actions.update(true)
      report('queued', queued); report('removed', removed); report('balance', BALANCE); report('logs', logs); report('feedback', feedback)`,
    {text, packet: JSON.stringify(published[0]), ...options}), {locale: false});
  }
  return {request, bridge, published, after};
}

for (const text of ['I pay you 500 eddies', 'i pay you 500 eddies', 'here, take 500 eddies']) {
  test(`"${text}" to a party copy of Judy takes 500 eddies through the real game and bridge modules`, async () => {
    const {request, bridge, published, after} = await journey(text);
    assert.equal(request.leased, true, 'the game leased a pay offer');
    const sent = JSON.parse(request.request);
    assert.deepEqual(Object.keys(sent.payOffer).sort(), ['actor', 'available', 'balance', 'max']);
    assert.equal(sent.payOffer.balance, 1200436); assert.equal(sent.payOffer.max, 100000);
    assert.ok(bridge.parsed.payOffer, 'the bridge parser keeps the offer');
    assert.equal(bridge.result.paid, true, JSON.stringify(bridge.lines));
    assert.equal(published.length, 1); assert.equal(published[0].pay.amount, 500);
    assert.deepEqual(after.removed, [500]); assert.equal(after.balance, 1200436 - 500);
    assert.deepEqual(after.queued, [{amount: 500, paid: true}]);
    assert.ok(after.logs.some(line => line.includes('Eddies payment: person=judy-alvarez amount=500 paid=yes')), JSON.stringify(after.logs));
    assert.deepEqual(after.feedback, []);
  });
}

test('with the switch Off the request carries no offer and nothing is taken', async () => {
  const {request, bridge, published} = await journey('I pay you 500 eddies', {enabled: false});
  assert.equal(request.leased, false);
  assert.equal(JSON.parse(request.request).payOffer, undefined);
  assert.equal(bridge.result.paid, false); assert.equal(published.length, 0);
  // The two probe lines that name the stop: the game's reason (the switch) and the bridge's (no offer arrived).
  assert.deepEqual(request.gameLogs, ['Eddies payment: offer=no(switch-off) person=judy-alvarez']);
  assert.equal(bridge.lines.length, 1); assert.match(bridge.lines[0], /^Eddies payment: person=judy-alvarez paid=no\(no-offer: /);
});

test('a housemate standing in the world can be paid the same way', async () => {
  const {request, published, after} = await journey('I pay you 500 eddies', {kind: 'housemate'});
  assert.equal(request.leased, true); assert.equal(published.length, 1);
  assert.deepEqual(after.removed, [500]);
});

test('a character the game placed gets no offer', async () => {
  const {request, bridge, published} = await journey('I pay you 500 eddies', {kind: 'game'});
  assert.equal(request.leased, false); assert.equal(JSON.parse(request.request).payOffer, undefined);
  assert.equal(bridge.result.paid, false); assert.equal(published.length, 0);
  assert.deepEqual(request.gameLogs, ['Eddies payment: offer=no(not-ours) person=judy-alvarez']);
});

test('the offer made and the amount V cannot pay each leave one probe line', async () => {
  const made = await journey('I pay you 500 eddies');
  assert.deepEqual(made.request.gameLogs, ['Eddies payment: offer=yes balance=1200436 max=100000 person=judy-alvarez']);
  const over = await journey('I pay you 5000000 eddies');
  assert.equal(over.published.length, 0); assert.equal(over.bridge.result.paid, false);
  assert.deepEqual(over.bridge.lines, ['Eddies payment: person=judy-alvarez paid=no(refused:cap amount=5000000)']);
  const talk = await journey('I might pay you 500 eddies tomorrow');
  assert.deepEqual(talk.bridge.lines, ['Eddies payment: person=judy-alvarez paid=no(refused:conditional-or-negated amount=500)']);
  const chat = await journey('hello there, how are you?');
  assert.deepEqual(chat.request.gameLogs, []); assert.deepEqual(chat.bridge.lines, [], 'a line that is not about money leaves no line at all');
});
