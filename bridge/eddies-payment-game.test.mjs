import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Paying a character in eddies (docs/EDDIES_PAYMENT.md), the game half: the offer, every check made again before any eddies are taken, the lease that matches the
// bridge's packet to the offer, and how the mod wires the setting. Run on a fake game with strict fakes for the natives; nothing here starts the game.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/eddies-payment.lua');
const actionsSource = read('../mod/gameplay-actions.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// A fake wallet: reads and removals are counted, a removal can fail, do nothing or throw.
const service = `
local M = (function() ${moduleSource} end)()
local state = {enabled = true, ours = true, balance = 3000, removeMode = 'ok', reads = 0, removes = 0, player = {name = 'V'}, readFails = false, logs = {}}
local function build()
  return M.new({
    enabled = function() return state.enabled end,
    payable = function(entity, key) return state.ours and entity == '100ULL' and key == 'judy-alvarez' end,
    player = function() return state.player end,
    balance = function(who) assert(who == state.player); state.reads = state.reads + 1; if state.readFails then error('GetItemQuantity failed') end; return state.balance end,
    remove = function(who, amount)
      assert(who == state.player)
      state.removes = state.removes + 1
      if state.removeMode == 'throw' then error('RemoveItem failed') end
      if state.removeMode == 'ok' then state.balance = state.balance - amount; return true end
      if state.removeMode == 'extra' then state.balance = state.balance - amount - 1; return true end
      return false
    end,
    log = function(line) state.logs[#state.logs + 1] = line end})
end
local function context(extra)
  local c = {requestId = 'r1', generation = 1, entity = '100ULL', profileKey = 'judy-alvarez'}
  for k, v in pairs(extra or {}) do c[k] = v end
  return c
end
local function offerFor() return {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 3000, max = 3000} end
`;
const withService = code => run(service + code);

test('the offer carries the balance and the most V may pay, and only for one of our copies on a typed private line', () => withService(`
  local pay = build()
  local offer = pay.offer('100ULL', context())
  assert(offer and offer.available == true and offer.actor.id == '100ULL' and offer.actor.key == 'judy-alvarez' and offer.balance == 3000 and offer.max == 3000)
  state.balance = 900000
  assert(pay.offer('100ULL', context()).max == 100000 and pay.offer('100ULL', context()).balance == 900000)
  state.balance = 1; assert(pay.offer('100ULL', context()).max == 1)
  state.balance = 0; assert(pay.offer('100ULL', context()) == nil, 'nothing to pay with')
  state.balance = 3000
  state.ours = false; assert(pay.offer('100ULL', context()) == nil, 'a character the game placed')
  state.ours = true
  assert(pay.offer('200ULL', context()) == nil, 'another entity')
  assert(pay.offer('100ULL', context({group = {index = 1}})) == nil)
  assert(pay.offer('100ULL', context({holocall = {mode = 'voice'}})) == nil)
  assert(pay.offer('100ULL', context({reaction = {kind = 'loot'}})) == nil)
  assert(pay.offer('100ULL', context({head = {}})) == nil)
  assert(pay.offer('100ULL', context({voiceOnly = true})) == nil)
  assert(pay.offer(100, context()) == nil and pay.offer('100ULL', nil) == nil and pay.offer('100ULL', {requestId = 'r'}) == nil)
  state.readFails = true; assert(pay.offer('100ULL', context()) == nil, 'an unreadable balance is no offer')
`));

test('with the setting Off nothing is read and nothing is offered or paid', () => withService(`
  local pay = build()
  state.enabled = false
  assert(pay.offer('100ULL', context()) == nil)
  assert(state.reads == 0 and state.removes == 0, 'not even the balance is read')
  local ok, code = pay.pay(500, offerFor(), '100ULL', 'r1')
  assert(ok == false and code == 'off' and state.removes == 0 and state.balance == 3000)
`));

test('a payment takes exactly the amount, reads the balance back, and logs it', () => withService(`
  local pay = build()
  local ok, code = pay.pay(500, offerFor(), '100ULL', 'r1')
  assert(ok == true and code == nil and state.balance == 2500 and state.removes == 1)
  assert(state.reads == 2, 'one read before and one after')
  assert(state.logs[#state.logs]:find('person=judy-alvarez amount=500 paid=yes', 1, true))
  ok = pay.pay(2500, {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 2500, max = 2500}, '100ULL', 'r2')
  assert(ok == true and state.balance == 0, 'the whole balance may be paid')
`));

test('every check is made again before any eddies are taken', () => withService(`
  local pay = build()
  local function refused(amount, offer, entity, expected)
    local before, removes = state.balance, state.removes
    local ok, code = pay.pay(amount, offer, entity or '100ULL', 'r1')
    assert(ok == false and code == expected, tostring(amount) .. ' ' .. tostring(code) .. ' wanted ' .. expected)
    assert(state.balance == before and state.removes == removes, 'no eddies moved for ' .. tostring(amount))
  end
  refused(0, offerFor(), nil, 'amount'); refused(-5, offerFor(), nil, 'amount'); refused(1.5, offerFor(), nil, 'amount'); refused('500', offerFor(), nil, 'amount')
  refused(0/0, offerFor(), nil, 'amount'); refused(math.huge, offerFor(), nil, 'amount'); refused(nil, offerFor(), nil, 'amount')
  refused(3001, offerFor(), nil, 'amount')   -- above the offered maximum
  refused(100001, {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 900000, max = 900000}, nil, 'amount')   -- above the hard cap even if the offer lied
  refused(500, nil, nil, 'offer'); refused(500, {}, nil, 'offer'); refused(500, {available = false, actor = {id = '100ULL', key = 'judy-alvarez'}, max = 3000}, nil, 'offer')
  refused(500, offerFor(), '200ULL', 'offer')   -- the offer was made to another entity
  refused(500, {available = true, actor = {id = '100ULL'}, balance = 3000, max = 3000}, nil, 'offer')
  refused(500, {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 3000}, nil, 'amount')   -- no maximum
  state.ours = false; refused(500, offerFor(), nil, 'not-ours'); state.ours = true
  state.balance = 400; refused(500, offerFor(), nil, 'balance')   -- V spent eddies since the offer
  state.balance = 3000
  state.readFails = true; refused(500, offerFor(), nil, 'unreadable'); state.readFails = false
  state.player = nil
  local ok, code = pay.pay(500, offerFor(), '100ULL', 'r1'); assert(ok == false and code == 'no-player')
  state.player = {name = 'V'}
`));

test('a removal that throws, does nothing or moves another amount is not a payment', () => withService(`
  local pay = build()
  state.removeMode = 'throw'
  local ok, code = pay.pay(500, offerFor(), '100ULL', 'r1')
  assert(ok == false and code == 'error' and state.balance == 3000)
  state.removeMode = 'nothing'
  ok, code = pay.pay(500, offerFor(), '100ULL', 'r1')
  assert(ok == false and code == 'unconfirmed' and state.balance == 3000)
  assert(state.logs[#state.logs]:find('unconfirmed', 1, true))
  state.removeMode = 'extra'
  ok, code = pay.pay(500, offerFor(), '100ULL', 'r1')
  assert(ok == false and code == 'unconfirmed')
`));

// The lease of mod/gameplay-actions.lua: the real module over a fake game.
const lease = `
local now, raw, sequence = 100000, nil, 0
local packets, queued, feedback, logs = {}, {}, {}, {}
local world = {ready = true, worldToken = 'world-a', generation = 1}
local function clone(value)
  if type(value) ~= 'table' then return value end
  local result = {}; for k, v in pairs(value) do result[k] = clone(v) end; return result
end
local payOffer = {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 3000, max = 3000}
local driveOffer = {available = true, actor = {id = '100ULL', key = 'judy-alvarez', serial = 7}, car = {name = 'Quadra'}, waypoint = {name = 'Pier'}}
local useDrive, payReply = false, true
local function context(extra)
  local c = {requestId = 'request-1', generation = 7, entity = '100ULL', profileKey = 'judy-alvarez'}
  for k, v in pairs(extra or {}) do c[k] = v end
  return c
end
local function packet(input, amount, extra)
  sequence = sequence + 1
  local p = {version = 1, action = 'companion-pay', actionId = 'pay-' .. sequence, requestId = input.requestId, generation = input.generation,
    entity = input.entity, profileKey = input.profileKey, source = 'private-text', worldToken = 'world-a', worldGeneration = 1,
    createdAt = now, expiresAt = now + 5000, pay = {amount = amount}, payOffer = clone(input.payOffer)}
  for k, v in pairs(extra or {}) do p[k] = v end
  raw = tostring(sequence); packets[raw] = p
  return p
end
local q = (function() ${actionsSource} end)().new({
  world = function() return world end, clock = function() return now end,
  normalizeOffer = function(value) return clone(value) end,
  payOffer = function() return clone(payOffer) end,
  offer = function() if useDrive then return clone(driveOffer) end end,
  queue = function(serial, offer, entity) queued[#queued + 1] = {kind = 'drive', serial = serial, entity = entity}; return true end,
  queuePay = function(amount, offer, entity, requestId)
    queued[#queued + 1] = {kind = 'pay', amount = amount, offer = offer, entity = entity, requestId = requestId}
    if payReply == true then return true end
    return false, payReply
  end,
  read = function() return raw end, decode = function(value) return assert(packets[value]) end,
  developerMode = function() return false end,
  feedback = function(state, reason) feedback[#feedback + 1] = {state = state, reason = reason} end,
  log = function(line) logs[#logs + 1] = line end})
`;
const withLease = code => run(lease + code);

test('a typed private line leases the pay offer and a matching packet is spent once', () => withLease(`
  local input = context(); assert(q.capture(input, 'private-text'))
  assert(input.payOffer and input.payOffer.balance == 3000 and input.payOffer.max == 3000 and input.payOffer.actor.id == '100ULL')
  assert(q.inspect().pay == true)
  packet(input, 500); q.update(true)
  assert(#queued == 1 and queued[1].kind == 'pay' and queued[1].amount == 500 and queued[1].entity == '100ULL' and queued[1].requestId == 'request-1')
  assert(queued[1].offer.max == 3000 and q.inspect().pay == false and q.inspect().pending == false, 'one payment per line, and an empty lease is dropped')
  q.update(true); assert(#queued == 1, 'replayed')
  packet(input, 500); q.update(true); assert(#queued == 1, 'a second payment of the same line')
  assert(#feedback == 0, 'a payment says nothing of its own: the game shows its pop-up')
`));

test('a spoken line, a group round, a call and a turn with no offer never lease a payment', () => withLease(`
  local voice = context(); q.capture(voice, 'private-voice'); assert(voice.payOffer == nil)
  local group = context({group = {index = 1, id = 'group-1'}}); q.capture(group, 'group-text'); assert(group.payOffer == nil)
  local call = context({holocall = {mode = 'voice'}}); q.capture(call, 'private-text'); assert(call.payOffer == nil)
  payOffer = nil
  local none = context({requestId = 'request-2'}); assert(q.capture(none, 'private-text') == false and none.payOffer == nil)
  payOffer = {available = true, actor = {id = '999ULL', key = 'someone'}, balance = 3000, max = 3000}
  local other = context({requestId = 'request-3'}); q.capture(other, 'private-text'); assert(other.payOffer == nil, 'an offer for another entity')
  payOffer = {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 100, max = 3000}
  local lying = context({requestId = 'request-4'}); q.capture(lying, 'private-text'); assert(lying.payOffer == nil, 'a maximum above the balance')
  payOffer = {available = true, actor = {id = '100ULL', key = 'judy-alvarez'}, balance = 100, max = 0}
  local empty = context({requestId = 'request-5'}); q.capture(empty, 'private-text'); assert(empty.payOffer == nil)
`));

test('a payment the offer did not allow, a changed offer, another line, person or world and a late packet are refused', () => withLease(`
  local input = context(); q.capture(input, 'private-text')
  for _, amount in ipairs({0, -1, 3001, 1.5}) do packet(input, amount); q.update(true); assert(#queued == 0, tostring(amount)) end
  packet(input, 'many'); q.update(true); assert(#queued == 0)
  local p = packet(input, 500); p.pay = nil; q.update(true); assert(#queued == 0, 'no amount')
  p = packet(input, 500); p.payOffer.max = 99999; q.update(true); assert(#queued == 0, 'an offer that differs from the leased one')
  p = packet(input, 500); p.payOffer.balance = 99999; q.update(true); assert(#queued == 0)
  p = packet(input, 500, {requestId = 'other'}); q.update(true); assert(#queued == 0, 'another request')
  p = packet(input, 500, {entity = '200ULL'}); q.update(true); assert(#queued == 0, 'another person')
  p = packet(input, 500, {profileKey = 'panam-palmer'}); q.update(true); assert(#queued == 0)
  p = packet(input, 500, {worldToken = 'world-b'}); q.update(true); assert(#queued == 0, 'another world')
  p = packet(input, 500, {source = 'private-voice'}); q.update(true); assert(#queued == 0, 'another source')
  p = packet(input, 500, {version = 2}); q.update(true); assert(#queued == 0)
  p = packet(input, 500, {action = 'companion-follow'}); q.update(true); assert(#queued == 0, 'a payment is only a companion-pay packet')
  p = packet(input, 500, {expiresAt = now - 1}); q.update(true); assert(#queued == 0, 'expired')
  p = packet(input, 500, {createdAt = now - 200000}); q.update(true); assert(#queued == 0, 'too old')
  p = packet(input, 500, {actionId = ''}); q.update(true); assert(#queued == 0)
  assert(#logs > 0 and logs[#logs]:find('Eddies payment packet refused', 1, true))
  packet(input, 500); q.update(true); assert(#queued == 1, 'the lease is still there for the right packet')
`));

test('a lease that ended pays nothing', () => withLease(`
  local input = context(); q.capture(input, 'private-text')
  packet(input, 500)
  now = now + 130000; q.update(true); assert(#queued == 0)
  local again = context({requestId = 'request-9'}); q.capture(again, 'private-text')
  packet(again, 500); world.generation = 2; q.update(true); assert(#queued == 0, 'a changed world')
  world.generation = 1
  local third = context({requestId = 'request-10'}); q.capture(third, 'private-text')
  packet(third, 500); q.update(false); assert(#queued == 0, 'gameplay not ready')
  q.capture(context({requestId = 'request-11'}), 'private-text')
  packet(third, 500); q.update(true); assert(#queued == 0, 'a newer line replaced the lease')
`));

test('a payment leaves the other offers of the same line in place', () => withLease(`
  useDrive = true
  local input = context(); assert(q.capture(input, 'private-text'))
  assert(input.payOffer ~= nil and input.chauffeurOffer ~= nil)
  packet(input, 500); q.update(true)
  assert(#queued == 1 and queued[1].kind == 'pay' and q.inspect().pending == true and q.inspect().drive == true and q.inspect().pay == false)
  sequence = sequence + 1
  local drive = {version = 1, action = 'drive-to-waypoint', actionId = 'drive-1', requestId = input.requestId, generation = input.generation, entity = input.entity,
    profileKey = input.profileKey, source = 'private-text', worldToken = 'world-a', worldGeneration = 1, createdAt = now, expiresAt = now + 5000, offer = clone(input.chauffeurOffer)}
  raw = 'drive'; packets[raw] = drive; q.update(true)
  assert(#queued == 2 and queued[2].kind == 'drive', 'the ride is still asked for after the payment')
`));

test('a payment the game refuses says why on screen, once', () => withLease(`
  payReply = 'You do not have enough eddies for that.'
  local input = context(); q.capture(input, 'private-text')
  packet(input, 500); q.update(true)
  assert(#queued == 1 and #feedback == 1 and feedback[1].state == 'rejected' and feedback[1].reason == 'You do not have enough eddies for that.')
  payReply = false
  local second = context({requestId = 'request-2'}); q.capture(second, 'private-text')
  packet(second, 500); q.update(true)
  assert(#feedback == 2 and feedback[2].reason == 'The payment could not be made.')
`));

test('without a payment function the lease refuses the packet quietly', () => run(`
  local clone = function(v) if type(v) ~= 'table' then return v end local r = {}; for k, x in pairs(v) do r[k] = x end return r end
  local raw, p
  local feedback = {}
  local q = (function() ${actionsSource} end)().new({world = function() return {ready = true, worldToken = 'w', generation = 1} end, clock = function() return 1000 end,
    normalizeOffer = function(v) return v end,
    payOffer = function() return {available = true, actor = {id = '1ULL', key = 'a'}, balance = 10, max = 10} end,
    read = function() return raw end, decode = function() return p end, feedback = function(s, r) feedback[#feedback + 1] = r end})
  local input = {requestId = 'r', generation = 1, entity = '1ULL', profileKey = 'a'}; assert(q.capture(input, 'private-text'))
  p = {version = 1, action = 'companion-pay', actionId = 'x', requestId = 'r', generation = 1, entity = '1ULL', profileKey = 'a', source = 'private-text', worldToken = 'w',
    worldGeneration = 1, createdAt = 1000, expiresAt = 2000, pay = {amount = 5}, payOffer = input.payOffer}
  raw = 'one'; q.update(true)
  assert(#feedback == 1 and feedback[1] == 'The payment could not be made.')
`));

test('the mod wires the setting: Off by default, one boolean read, no per-frame work, the game\'s own transaction call', () => {
  const manager = read('../mod/manager.lua');
  assert.match(manager, /if type\(settings\.payCharacters\) ~= 'boolean' then settings\.payCharacters, settingsNeedSave = false, true end/);
  assert.match(manager, /function M\.payCharacters\(\)\s+loadSettings\(\)\s+return settings\.payCharacters == true\s+end/);
  assert.match(manager, /payCharacters = settings\.payCharacters == true,/);
  assert.match(manager, /elseif key == 'payCharacters' then\s+if type\(value\) ~= 'boolean' then return false, 'This setting must be on or off\.' end\s+nextSettings\.payCharacters = value/);
  const ui = read('../mod/manager-ui.lua');
  assert.match(ui, /setting\('payCharacters', 'Pay characters in eddies', 'bool', snapshot\.settings\.payCharacters == true, false,/);
  assert.match(ui, /elseif key == 'payCharacters' then values\.payCharacters = change\.value/);
  assert.match(init, /local loaded, module = pcall\(dofile, 'eddies-payment\.lua'\)/);
  assert.match(init, /enabled = function\(\) return manager\.payCharacters\(\) end/);
  assert.match(init, /payable = function\(entity, profileKey\) return companions\.payable\(entity, profileKey\) end/);
  assert.match(init, /payOffer = function\(entity, context\)\s+return convaiEddies and convaiEddies\.offer\(entity, context\) or nil\s+end/);
  assert.match(init, /queuePay = function\(amount, offer, entity, requestId\)/);
  // Nothing in the module or its callers runs per frame, and it takes the eddies with the transaction system's own call (the vendors' and the taxi's).
  assert.ok(!/onUpdate|registerForEvent|Cron\.|\bwhile\b/.test(moduleSource.replace(/--.*$/gm, '')));
  assert.match(moduleSource, /Game\.GetTransactionSystem\(\):RemoveItem\(player, money\(\), amount\)/);
  assert.match(moduleSource, /ItemID\.FromTDBID\(TweakDBID\.new\('Items\.money'\)\)/);
  assert.ok(!moduleSource.includes('_G'));
  for (const file of ['packaging/release-plan.json', 'scripts/development-files.json']) {
    assert.ok(read('../' + file).includes('"mod/eddies-payment.lua"'), file);
    assert.ok(read('../' + file).includes('AiNpcCyberpunkMod/eddies-payment.lua'), file);
  }
  assert.ok(read('../packaging/runtime-layout.mjs').includes("'bridge/eddies-payment.mjs'"));
});

test('only our own copies can be paid: the entity must be a party member, a visitor or a housemate', () => {
  const companions = read('../mod/companions.lua');
  const body = companions.slice(companions.indexOf('function M.payable'), companions.indexOf('function M.identity'));
  assert.match(body, /entry\.state=='ready' or entry\.state=='visiting'/);
  assert.match(body, /entry\.profileKey==profileKey/);
  assert.match(body, /tostring\(entry\.entityID\.hash\)==entity/);
  assert.ok(!/\bGame\b/.test(body), 'no native read: the entries are the mod\'s own list');
});
