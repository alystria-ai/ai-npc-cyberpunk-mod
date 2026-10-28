import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Eddies with characters (docs/EDDIES.md), the game half: the block a turn carries, the ledger and its rollback guard, the proposal the bridge
// writes, the Yes/No pop-up and the transfer with every re-check. Run on a fake game (a wallet, a clock, files in memory); nothing here starts the
// game. The bridge half is bridge/eddies.test.mjs.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('../mod/eddies.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// The fake game: V's wallet, the clocks, the files, the pop-up. `serialize` stands in for json (a Lua table literal).
const harness = `
local M = (function() ${moduleSource} end)()
local function serialize(value)
  if type(value) == 'table' then
    local parts = {}
    for k, v in pairs(value) do parts[#parts + 1] = '[' .. serialize(k) .. ']=' .. serialize(v) end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif type(value) == 'string' then return string.format('%q', value)
  else return tostring(value) end
end
local files, writes, notices, logs, asked = {}, 0, {}, {}, {}
local state = {on = true, copy = 'party', balance = 1000, now = 1800000000, clock = 100, game = 50000, busy = false, answer = nil, open = false,
  giveFails = false, moved = 0}
local options = {
  enabled = function() return state.on end,
  ownCopy = function(entity, key) return state.copy end,
  player = function() return {} end,
  now = function() return state.now end,
  clock = function() return state.clock end,
  gameTime = function() return state.game end,
  read = function(path) return files[path] end,
  write = function(path, text) files[path] = text; writes = writes + 1; return true end,
  encode = serialize,
  decode = function(text) return load('return ' .. text)() end,
  random = function(n) return 0 end,
  balance = function() return state.balance end,
  give = function(player, amount) if state.giveFails then error('no money item') end; state.balance = state.balance + amount; state.moved = state.moved + amount end,
  remove = function(player, amount) state.balance = state.balance - amount; state.moved = state.moved - amount end,
  ask = function(player, title, message) asked[#asked + 1] = message; state.open = true; return true end,
  answer = function() if state.answer then local a = state.answer; state.answer = nil; state.open = false; return a end; return nil end,
  busy = function() return state.busy end,
  notice = function(player, text) notices[#notices + 1] = text end,
  log = function(line) logs[#logs + 1] = line end,
}
local E = M.new(options)
local function context(id) return {requestId = id or 'req-1', entity = '42', profileKey = 'judy-alvarez', name = 'Judy'} end
local function propose(fields)
  local p = {version = 1, id = 'ed-1', requestId = 'req-1', entity = '42', profileKey = 'judy-alvarez', name = 'Judy', flow = 'loanToV', amount = 300, origin = 'offered'}
  for k, v in pairs(fields or {}) do p[k] = v end
  files[M.OFFER] = serialize(p)
end
-- The tick, as init.lua runs it: only while something is pending, the clock moving on.
local function tick(times) for _ = 1, times or 1 do state.clock = state.clock + 0.6; if E.pending() then E.update({}) end end end
local function ledger() return load('return ' .. files[M.LEDGER])() end
`;
const withGame = code => run(`${harness}\n${code}`);

test('off: no block, nothing read or written, nothing pending', () => withGame(`
  state.on = false
  assert(E.block(context()) == nil)
  assert(writes == 0 and not E.pending())
`));

test("one of V's own copies: the balance, the copy, a ledger row made once; a game-placed character gets the row only and nothing is armed", () => withGame(`
  local block = E.block(context())
  assert(block.version == 1 and block.on and block.own == true and block.copy == 'party' and block.balance == 1000 and block.now == state.now)
  assert(block.row and block.row.seed == 0 and block.row.met == state.now and block.row.totals.loanToV == 0)
  assert(writes == 1 and E.pending())
  E.block(context('req-2'))
  assert(writes == 1, 'the row is made once')
  local fresh = M.new(options)
  state.copy = nil
  local placed = fresh.block({requestId = 'req-3', entity = '77', profileKey = 'judy-alvarez'})
  assert(placed.own == false and placed.balance == nil and placed.copy == nil and placed.row.met == state.now)
  assert(not fresh.pending(), 'a game-placed character arms no watch')
  -- Not for a group round, a reaction, a call or Johnny in V's head.
  for _, extra in ipairs({{group = {}}, {reaction = {}}, {holocall = {}}, {head = {}}}) do
    local c = context(); for k, v in pairs(extra) do c[k] = v end
    assert(fresh.block(c) == nil)
  end
`));

test('a loan V takes: the pop-up waits for the reply and V, opens once, and only Yes moves the eddies, read back from the balance', () => withGame(`
  E.block(context())
  propose()
  state.busy = true
  tick(5)
  assert(#asked == 0, 'busy: the pop-up waits')
  state.busy = false
  tick(2)
  assert(#asked == 1 and asked[1] == 'Judy offers to lend you 300 eddies. Take the loan?', tostring(asked[1]))
  tick(3)
  assert(#asked == 1 and state.balance == 1000, 'open: no second box, nothing moved')
  state.answer = 'yes'
  tick()
  assert(state.balance == 1300 and state.moved == 300)
  assert(not E.pending())
  local row = ledger().characters['judy-alvarez']
  assert(#row.entries == 1 and row.entries[1].f == 'loanToV' and row.entries[1].n == 300 and row.entries[1].r == 'done' and row.entries[1].g == 50000)
  local block = E.block(context('req-2'))
  assert(block.row.totals.loanToV == 300 and block.row.last.result == 'done' and block.row.flow < 0, 'the next turn knows V owes 300')
  assert(block.balance == 1300)
  -- The same proposal file again is not a second transfer.
  tick(5)
  assert(state.balance == 1300 and #asked == 1)
`));

test('No, a proposal for another turn, and a proposal nobody answered move nothing', () => withGame(`
  E.block(context())
  propose({requestId = 'req-other'})
  tick(3)
  assert(#asked == 0, 'another turn: ignored')
  propose({id = 'ed-2', flow = 'giftFromV', amount = 200})
  tick(3)
  assert(#asked == 1 and asked[1] == 'Give Judy 200 eddies?')
  state.answer = 'no'
  tick()
  assert(state.balance == 1000)
  assert(ledger().characters['judy-alvarez'].entries[1].r == 'declined')
  -- A proposal that waits too long (V busy for 45 s) is missed.
  E.block(context('req-3'))
  propose({id = 'ed-3', requestId = 'req-3', flow = 'giftFromV', amount = 100})
  state.busy = true
  tick(100)
  assert(#asked == 1 and not E.pending())
  local entries = ledger().characters['judy-alvarez'].entries
  assert(entries[#entries].r == 'missed')
`));

test('every re-check after Yes: the balance, the debt a payback settles, the character still with V, the setting, a give that fails', () => withGame(`
  local function attempt(id, fields, setup)
    E.block(context(id))
    fields.requestId, fields.id = id, 'ed-' .. id
    propose(fields)
    tick(3)
    if setup then setup() end
    state.answer = 'yes'
    tick()
  end
  attempt('a', {flow = 'giftFromV', amount = 5000})
  assert(state.balance == 1000 and notices[#notices] == 'You do not have enough eddies for that.')
  attempt('b', {flow = 'repayByV', amount = 100})
  assert(state.balance == 1000 and notices[#notices] == 'The eddies could not be moved.', 'V owes nothing to pay back')
  attempt('c', {flow = 'loanToV', amount = 100}, function() state.copy = nil end)
  assert(state.balance == 1000 and notices[#notices] == 'Judy is no longer with you, so no eddies moved.')
  state.copy = 'party'
  attempt('d', {flow = 'loanToV', amount = 100}, function() state.giveFails = true end)
  assert(state.balance == 1000 and notices[#notices] == 'The eddies could not be moved.')
  state.giveFails = false
  attempt('e', {flow = 'loanToV', amount = 100}, function() state.on = false end)
  assert(state.balance == 1000)
  state.on = true
  -- Out of range proposals never even wait: a sum above the cap, a fraction, an unknown flow.
  for i, fields in ipairs({{amount = 100001}, {amount = 12.5}, {flow = 'steal'}, {amount = 0}}) do
    E.block(context('bad' .. i)); fields.requestId = 'bad' .. i; propose(fields); tick(3)
  end
  local opened = #asked
  assert(opened == 5, 'five attempts opened the box, no bad proposal did: ' .. opened)
  local entries = ledger().characters['judy-alvarez'].entries
  for _, entry in ipairs(entries) do assert(entry.r ~= 'done', 'nothing was done') end
`));

test('paying back settles the debt both ways, never more than it', () => withGame(`
  E.block(context('a')); propose({requestId = 'a', flow = 'loanFromV', amount = 400}); tick(3); state.answer = 'yes'; tick()
  assert(state.balance == 600)
  E.block(context('b')); propose({requestId = 'b', id = 'b', flow = 'repayToV', amount = 400}); tick(3); state.answer = 'yes'; tick()
  assert(state.balance == 1000)
  local block = E.block(context('c'))
  assert(block.row.totals.loanFromV == 400 and block.row.totals.repayToV == 400)
  local vOwes, owesV = M.debts(block.row)
  assert(vOwes == 0 and owesV == 0)
`));

test('the rollback guard: a load of an earlier save forgets the entries made after it, for good', () => withGame(`
  E.block(context('a')); propose({requestId = 'a', flow = 'loanToV', amount = 300}); tick(3); state.answer = 'yes'; tick()
  assert(ledger().characters['judy-alvarez'].entries[1].g == 50000)
  state.game = 40000          -- an earlier save of this playthrough
  local block = E.block(context('b'))
  assert(block.row.totals.loanToV == 0 and block.row.last == nil, 'forgotten')
  assert(#ledger().characters['judy-alvarez'].entries == 0, 'and saved')
  state.game = 60000          -- played on past the old stamp: it does not come back
  assert(E.block(context('c')).row.totals.loanToV == 0)
  -- Within the slack of a clock read: kept.
  state.game = 70000
  E.block(context('d')); propose({requestId = 'd', id = 'd', flow = 'loanToV', amount = 100}); tick(3); state.answer = 'yes'; tick()
  state.game = 69950
  assert(E.block(context('e')).row.totals.loanToV == 100)
`));

test('the ledger survives a reload and drops what is malformed', () => withGame(`
  E.block(context('a')); propose({requestId = 'a', flow = 'loanToV', amount = 300}); tick(3); state.answer = 'yes'; tick()
  local again = M.new(options)
  assert(again.block(context('b')).row.totals.loanToV == 300)
  files[M.LEDGER] = serialize({version = 2, characters = {['judy-alvarez'] = {seed = 3, met = 5, entries = {{f = 'loanToV', n = -5, at = 1, r = 'done'},
    {f = 'loanToV', n = 50, at = 1, r = 'done'}, {f = 'rob', n = 50, at = 1, r = 'done'}}}, ['Bad Key'] = {seed = 1}}})
  local third = M.new(options)
  local row = third.block(context('c')).row
  assert(row.seed == 3 and row.totals.loanToV == 50)
  assert(third.row('Bad Key') == nil)
  files[M.LEDGER] = 'not a table at all ('
  assert(M.new(options).block(context('d')).row.totals.loanToV == 0)
`));

test('init.lua wires it once per private turn with one boolean while off, and the tick with one nil check', () => {
  assert.match(init, /microphone\.captureActions = function\(context\)\n[^\n]*\n\s*if not context\.reaction and not context\.group then convaiEddiesAttach\(context\) end/);
  assert.match(init, /if not context\.reaction and not context\.group then convaiEddiesAttach\(context\) end\n\s*local encodedOk, encoded = pcall\(json\.encode, context\)/);
  assert.match(init, /function convaiEddiesAttach\(context\)\n\s*if type\(context\) ~= 'table' or type\(manager\.characterEddies\) ~= 'function' or not manager\.characterEddies\(\) then return end/);
  assert.match(init, /if convaiEddies and worldReady then convaiEddiesTick\(player\) end/);
  assert.match(init, /gameTime = function\(\) return worldKnowledgeModule\.nativeGameTime/);
  assert.match(init, /convaiNotices\.send\(player, 'eddies-transfer', text\)/);
  const reds = read('../r6/scripts/CyberpunkConvai/Eddies.reds');
  assert.match(reds, /GenericMessageNotification\.Show\(controller, title, message, GenericMessageNotificationType\.YesNo\)/);
  assert.doesNotMatch(reds, /GiveItem|RemoveItem/, 'no eddies move in redscript');
});
