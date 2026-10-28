// Battle and loot reactions are on by default. On the shared Convai key they are ordinary turns of the one daily cap: no share of their own
// (the old tenth for remarks and fifth for reactions are gone), and a refused one just stops.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {SharedKeyGuard, TurnLimitError} from './shared-key-guard.mjs';
import {QuotaWatch} from './convai-quota.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');

test('shared key: every kind of line, reactions included, counts once in the one daily cap; a refused reaction is silent; other keys are untouched', () => {
  let now = new Date(2026, 9, 28, 12).getTime(), shared = true;
  const guard = new SharedKeyGuard({limit: 100, now: () => now, applies: () => shared});
  const admit = config => { guard.check(config); guard.consume(config); };
  const battle = {reaction: {kind: 'battle'}}, loot = {reaction: {kind: 'loot'}}, head = {reaction: {kind: 'head'}}, speak = {reaction: {kind: 'speakup'}}, talk = {};
  for (let i = 0; i < 40; i++) admit(battle);
  for (let i = 0; i < 30; i++) admit(loot);
  for (let i = 0; i < 10; i++) admit(i % 2 ? head : speak);
  assert.equal(guard.count, 80, 'no kind has a share of its own: 40 battle comments and 30 pickups pass');
  for (let i = 0; i < 20; i++) admit(talk);
  assert.equal(guard.count, 100);
  // The refusal is the daily kind, which an automatic reaction shows no notice for.
  try { admit(battle); assert.fail('expected a refusal'); } catch (error) {
    assert.ok(error instanceof TurnLimitError);
    assert.equal(error.kind, 'daily');
    assert.equal(new QuotaWatch().codeFor(error, {automatic: true}), undefined);
  }
  assert.equal(guard.count, 100, 'a refused turn costs nothing');
  guard.setLimit(200);
  assert.doesNotThrow(() => admit(battle), "the cap follows the backend's limit");
  shared = false;
  for (let i = 0; i < 500; i++) assert.doesNotThrow(() => admit(battle), "a player's own key is never limited");
  shared = true; now += 24 * 3600 * 1000;
  assert.doesNotThrow(() => admit(battle), 'a new day');
  assert.equal(guard.count, 1);
});

test('the bridge wires one guard where a turn reaches Convai and no pools or counter files besides the daily one', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /const hostGuard = \{check: \(\) => \{ turnGuard\.check\(\); if \(tokenSource\) keys\.assertAllowed\(\); \},/);
  assert.match(bridge, /consume: \(\) => \{ turnGuard\.consume\(\); \}\};/);
  assert.match(read('./realtime-host.mjs'), /this\.guard\.check\(config\); this\.guard\.consume\(config\);/);
  assert.doesNotMatch(bridge, /RemarkAllowance|remarkAllowance|reactionAllowance|remark-usage|reaction-usage|REACTION_SHARE/);
  assert.match(bridge, /'daily-usage\.json'/);
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
