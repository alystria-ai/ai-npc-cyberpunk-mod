// Battle and loot reactions are on by default. On the shared Convai key they have their own share of the day (REACTION_SHARE, 20 of 100),
// apart from the remarks' tenth, and a refused one just stops.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {REACTION_KINDS, REACTION_SHARE, REMARK_SHARE, RemarkAllowance, SharedKeyGuard, TurnLimitError, isReaction, isRemark, remarkCap} from './shared-key-guard.mjs';
import {QuotaWatch} from './convai-quota.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');

test('the reaction kinds are exactly battle and loot, and none of them is a remark', () => {
  assert.deepEqual([...REACTION_KINDS], ['battle', 'loot']);
  for (const kind of ['battle', 'loot']) { assert.equal(isReaction({reaction: {kind}}), true, kind); assert.equal(isRemark({reaction: {kind}}), false, kind); }
  for (const config of [undefined, null, {}, {reaction: {kind: 'head'}}, {reaction: {kind: 'speakup'}}, {reaction: {kind: 'meet'}}, {reaction: {kind: 'house'}}, {reaction: {kind: 'Battle'}}, {reaction: 'loot'}]) {
    assert.equal(isReaction(config), false, JSON.stringify(config));
  }
  assert.equal(REACTION_SHARE, 0.2); assert.equal(remarkCap(100, REACTION_SHARE), 20); assert.equal(remarkCap(100), 10); assert.equal(remarkCap(3, REACTION_SHARE), 1);
});

test('shared key: reactions may use 20 of 100 a day, apart from the remarks; talking and other keys are untouched; a refused reaction is silent', () => {
  let now = new Date(2026, 9, 26, 12).getTime(), shared = true;
  const guard = new SharedKeyGuard({limit: 100, now: () => now, applies: () => shared, spacingMs: 0, burst: 1000, perMinute: 100000});
  const remarks = new RemarkAllowance({guard});
  const reactions = new RemarkAllowance({guard, applies: isReaction, share: REACTION_SHARE});
  const admit = config => { guard.check(); remarks.check(config); reactions.check(config); guard.consume(); remarks.consume(config); reactions.consume(config); };
  const battle = {reaction: {kind: 'battle'}}, loot = {reaction: {kind: 'loot'}}, head = {reaction: {kind: 'head'}}, talk = {};
  for (let i = 0; i < 12; i++) admit(battle);
  for (let i = 0; i < 8; i++) admit(loot);
  assert.equal(guard.count, 20);
  assert.throws(() => admit(loot), TurnLimitError, 'the 21st reaction of the day is refused');
  assert.throws(() => admit(battle), TurnLimitError);
  assert.equal(guard.count, 20, 'a refused reaction costs no turn');
  for (let i = 0; i < 10; i++) admit(head);
  admit(talk);
  assert.equal(guard.count, 31, 'the remarks and V\'s own turns are not held back by the reactions');
  assert.equal(remarks.count, 10); assert.equal(reactions.count, 20);
  // The refusal is the daily kind, which an automatic reaction shows no notice for.
  try { admit(battle); assert.fail('expected a refusal'); } catch (error) {
    assert.equal(error.kind, 'daily');
    assert.equal(new QuotaWatch().codeFor(error, {automatic: true}), undefined);
  }
  guard.setLimit(200);
  assert.doesNotThrow(() => admit(battle), 'the share follows the backend\'s limit');
  shared = false; reactions.count = 9999;
  assert.doesNotThrow(() => admit(battle), 'a player\'s own key is never limited');
  shared = true; now += 24 * 3600 * 1000;
  assert.doesNotThrow(() => admit(battle), 'a new day');
  assert.equal(reactions.count, 1);
});

test('the bridge wires the pool where a turn reaches Convai, with its own signed files', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /const reactionAllowance = await new RemarkAllowance\(\{guard: turnGuard, applies: isReaction, share: REACTION_SHARE,/);
  assert.match(bridge, /'reaction-usage\.json'/);
  assert.match(bridge, /reactionAllowance\.check\(config\)/);
  assert.match(bridge, /reactionAllowance\.consume\(config\)/);
});

// The game-side rules that keep a reaction from clashing with the other systems (mod/init.lua). The main chunk cannot be loaded without the game,
// so these pin the lines that carry the rules.
const init = read('../mod/init.lua').replace(/\r\n/g, '\n');

test('a fight or pickup comment waits for an open holocall, a housemate chat and a waiting greeting, as the speak-up does', () => {
  assert.match(init, /local busy = not worldReady or manual or not outputs\.enabled[^\n]*automatic ~= nil\n\s+or \(convaiHolocall ~= nil and convaiHolocall\.call ~= nil\) or \(convaiUnpromptedBusy ~= nil and convaiUnpromptedBusy\(\)\)/);
  assert.match(init, /if convaiUnpromptedBusy and convaiUnpromptedBusy\(\) then return false end\n\s+if convaiHolocall ~= nil and convaiHolocall\.call ~= nil then return false end/);
  // battles.offer and loot.offer take that busy flag.
  assert.match(init, /battles\.offer\(busy, battlePeople, now,/);
  assert.match(init, /loot\.offer\(busy, battlePeople, now\)/);
});

test('an automatic reaction that the plan or the key refused just stops: the generic limit notice is for a turn V asked for', () => {
  assert.match(init, /elseif keyId then\n\s+if not pending\.reaction then convaiNotices\.send\(player, 'quota-exhausted', keyText\) end/);
  assert.match(init, /if not pending\.reaction then convaiNotices\.send\(player, 'daily-limit', keyText\) end/);
});
