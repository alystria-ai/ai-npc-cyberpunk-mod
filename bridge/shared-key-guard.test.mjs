import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DAILY_LIMIT, LimitStore, sanitizeLimit, SharedKeyGuard, TurnLimitError, UsageStore, dayOf,
  limitFromEnvironment, machineId} from './shared-key-guard.mjs';
import {ConvaiKeys, OwnKeyControl, parseKeyFileText} from './convai-key.mjs';
import {QuotaWatch, classifyFailure} from './convai-quota.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {readFileSync} from 'node:fs';

// Fake keys only, never a credential.
const FIXTURE = 'fixture-shared-key-0123456789abcdef';
const clockAt = start => { const clock = {at: start, now: () => clock.at, advance: ms => { clock.at += ms; }}; return clock; };
const noon = Date.UTC(2026, 9, 11, 12, 0, 0); // noon UTC: the day is the sign-in backend's UTC day, whatever time zone the test runs in
const DAY = 24 * 3600 * 1000;

// ---------------------------------------------------------------- the key file
test('a plain api-key file is read; a key a release before 0.2.9 packed there, or anything else, is not a key', () => {
  assert.equal(parseKeyFileText(`api-key = ${FIXTURE}\r\n`), FIXTURE);
  assert.equal(parseKeyFileText(`\uFEFFAPI-KEY=${FIXTURE}`), FIXTURE);
  assert.equal(parseKeyFileText('api-key = two words'), null);
  assert.equal(parseKeyFileText('x'.repeat(5000)), null);
  for (const packed of ['convai-key-v1 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n', FIXTURE, '', null, undefined, 7]) assert.equal(parseKeyFileText(packed), null);
});

// ---------------------------------------------------------------- the daily cap
const guardWith = (clock, options = {}) => new SharedKeyGuard({now: clock.now, limit: 100, ...options});
const drain = (guard, clock, count) => { for (let i = 0; i < count; i++) { clock.advance(5000); guard.admit(); } };

test('the shipped number is the documented one, and nothing but the daily cap is exported as a limit', async () => {
  assert.equal(DAILY_LIMIT, 500);
  const exported = Object.keys(await import('./shared-key-guard.mjs'));
  for (const gone of ['RATE_BURST', 'RATE_PER_MINUTE', 'MIN_SPACING_MS', 'REMARK_SHARE', 'REACTION_SHARE', 'RemarkAllowance', 'remarkCap', 'isRemark', 'isReaction'])
    assert(!exported.includes(gone), `${gone} is gone: the daily cap is the only limit`);
});

test('the counter goes up once per admitted turn and the cap blocks the next one', () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 5});
  assert.deepEqual(guard.snapshot(), {limit: 5, left: 5, blocked: false});
  drain(guard, clock, 4);
  assert.deepEqual(guard.snapshot(), {limit: 5, left: 1, blocked: false});
  clock.advance(5000); guard.check(); // checking never counts
  assert.equal(guard.snapshot().left, 1);
  clock.advance(5000); guard.admit();
  assert.deepEqual(guard.snapshot(), {limit: 5, left: 0, blocked: true});
  clock.advance(5000);
  assert.throws(() => guard.admit(), error => error instanceof TurnLimitError && error.kind === 'daily'
    && /\[convai-quota:daily\]/.test(error.message));
  assert.equal(guard.snapshot().left, 0, 'a refused turn is not counted');
});

test("a player's own key is never counted or capped", () => {
  const clock = clockAt(noon);
  let shared = false;
  const guard = guardWith(clock, {limit: 2, applies: () => shared});
  for (let i = 0; i < 50; i++) guard.admit();
  assert.equal(guard.snapshot(), null);
  shared = true;
  assert.deepEqual(guard.snapshot(), {limit: 2, left: 2, blocked: false}, 'nothing was counted on the own key');
});

test('limit 0 switches the guard off, as the development switch does', () => {
  const guard = guardWith(clockAt(noon), {limit: 0});
  for (let i = 0; i < 500; i++) guard.admit();
  assert.equal(guard.snapshot(), null);
  assert.equal(limitFromEnvironment('off', 100), 0); assert.equal(limitFromEnvironment('0', 100), 0);
  assert.equal(limitFromEnvironment(' 7 ', 100), 7); assert.equal(limitFromEnvironment(undefined, 100), 100);
  assert.equal(limitFromEnvironment('', 0), 0); assert.equal(limitFromEnvironment('lots', 100), 100);
});

test('the allowance comes back at 00:00 UTC, the backend day boundary, and a clock set back does not give it back early', () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 3});
  drain(guard, clock, 3);
  assert.equal(guard.snapshot().blocked, true);
  clock.advance(-3 * DAY); // the clock is moved back
  assert.equal(guard.snapshot().blocked, true, 'still today');
  clock.at = noon + 2 * 3600 * 1000; // two hours later, same day
  assert.equal(guard.snapshot().blocked, true);
  clock.at = Date.UTC(2026, 9, 11, 23, 59, 59); // one second before the UTC midnight (5:29:59 AM on the 12th in India)
  assert.equal(dayOf(clock.at), '2026-10-11');
  assert.equal(guard.snapshot().blocked, true);
  clock.at = Date.UTC(2026, 9, 12, 0, 0, 1); // just after it
  assert.equal(dayOf(clock.at), '2026-10-12');
  assert.deepEqual(guard.snapshot(), {limit: 3, left: 3, blocked: false});
  guard.admit(); assert.equal(guard.snapshot().left, 2);
});

test('the guard and the backend change day at the same instant: the UTC day, not the local one', () => {
  // The backend counts a player's reported turns per UTC day (auth-backend/api/_lib/token-handler.js, isoDay). A local-day guard showed turns left
  // for hours after the backend, whose day began later, had already refused new tokens (east of UTC), so both use one boundary.
  const backendDay = ms => new Date(ms).toISOString().slice(0, 10);
  for (const at of [Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 9, 11, 18, 29, 59), Date.UTC(2026, 9, 11, 18, 30, 0), Date.UTC(2026, 9, 11, 23, 59, 59),
    Date.UTC(2026, 9, 12, 0, 0, 0), Date.UTC(2026, 11, 31, 23, 59, 59)]) assert.equal(dayOf(at), backendDay(at), new Date(at).toISOString());
});

test('a counter an earlier release wrote with the local day moves onto the UTC day it was last used in', async () => {
  const memory = memoryFiles();
  // 29 October 01:00 IST = 28 October 19:30 UTC: the old release named the day 2026-10-29, the backend was still on the 28th.
  const used = Date.UTC(2026, 9, 28, 19, 30, 0);
  await storeOver(memory).save({day: '2026-10-29', count: 3, seen: used});
  const clock = clockAt(used + 60_000);
  const guard = await guardWith(clock, {limit: 3, store: storeOver(memory)}).load();
  assert.deepEqual(guard.snapshot(), {limit: 3, left: 0, blocked: true}, 'still used up at the same moment');
  clock.at = Date.UTC(2026, 9, 29, 0, 0, 1);
  assert.deepEqual(guard.snapshot(), {limit: 3, left: 3, blocked: false}, 'and free at the next UTC day, not a day later');
});

test('turns are never limited by speed: any number at the same instant count one each, up to the cap, and no kind of turn has its own share', () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 1000});
  for (let i = 0; i < 600; i++) guard.admit(); // the clock never moves
  assert.equal(guard.snapshot().left, 400);
  // The speed of a five-person group round, and of speak-up, battle, loot and ride lines among typed turns, is no business of the guard.
  for (const reaction of [{kind: 'head'}, {kind: 'speakup'}, {kind: 'battle'}, {kind: 'loot'}, {kind: 'addon'}, undefined]) { guard.check({reaction}); guard.consume({reaction}); }
  assert.equal(guard.snapshot().left, 394, 'every kind counts once in the one pool');
  const small = guardWith(clock, {limit: 3});
  for (const reaction of [{kind: 'speakup'}, {kind: 'battle'}, {kind: 'head'}]) small.admit({reaction});
  assert.throws(() => small.admit(), error => error.kind === 'daily', 'the cap is the whole day, not a tenth of it for unprompted lines');
});

test('an ordinary evening is never limited: a few turns a minute, and a five-person group round', () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 100});
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 0; i < 4; i++) { clock.advance(10000); guard.admit(); }
    clock.advance(20000);
  }
  for (let i = 0; i < 5; i++) guard.admit();
  assert.equal(guard.snapshot().left, 100 - 45);
});

// ---------------------------------------------------------------- the stored counter
const memoryFiles = () => {
  const files = new Map();
  return {files, read: async path => { if (!files.has(path)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return files.get(path); },
    write: async (path, text) => { files.set(path, text); }};
};
const storeOver = (memory, paths = ['state/usage', 'profile/usage'], machine = 'machine-one') =>
  new UsageStore({paths, machine, read: memory.read, write: memory.write});

test('the count survives a restart and deleting one copy does not reset it', async () => {
  const memory = memoryFiles(), clock = clockAt(noon);
  const first = await guardWith(clock, {limit: 100, store: storeOver(memory)}).load();
  drain(first, clock, 7); await first.flush();
  assert.equal(memory.files.size, 2, 'two copies');
  for (const text of memory.files.values()) assert(!/api|key/i.test(text) && /"mac"/.test(text));
  const restarted = await guardWith(clock, {limit: 100, store: storeOver(memory)}).load();
  assert.equal(restarted.snapshot().left, 93);
  memory.files.delete('state/usage'); // the player deletes the state folder copy
  assert.equal((await guardWith(clock, {limit: 100, store: storeOver(memory)}).load()).snapshot().left, 93);
});

test('an edited, copied or damaged counter is ignored and never blocks the player', async () => {
  const memory = memoryFiles(), clock = clockAt(noon);
  const guard = await guardWith(clock, {limit: 100, store: storeOver(memory)}).load();
  drain(guard, clock, 40); await guard.flush();
  const genuine = memory.files.get('state/usage');
  // Lowering the count by hand breaks the signature; the other copy still holds 40.
  memory.files.set('state/usage', genuine.replace('"count":40', '"count":1'));
  assert.equal((await guardWith(clock, {limit: 100, store: storeOver(memory)}).load()).snapshot().left, 60);
  // Both damaged: count 0 and no crash.
  for (const damaged of ['', '{', 'null', '[]', '{"v":1}', genuine.slice(0, 20), '\u0000\u0000']) {
    memory.files.set('state/usage', damaged); memory.files.set('profile/usage', damaged);
    const fresh = await guardWith(clock, {limit: 100, store: storeOver(memory)}).load();
    assert.deepEqual(fresh.snapshot(), {limit: 100, left: 100, blocked: false}, JSON.stringify(damaged));
    fresh.admit();
    fresh.admit();
    assert.equal(fresh.snapshot().left, 98, 'turns count from zero without a counter');
    await fresh.flush();
    clock.advance(5000);
  }
  // A record copied from another computer does not verify here.
  memory.files.set('state/usage', genuine); memory.files.set('profile/usage', genuine);
  const elsewhere = new UsageStore({paths: ['state/usage', 'profile/usage'], machine: 'machine-two', read: memory.read, write: memory.write});
  assert.equal(await elsewhere.load(), null);
});

test('a counter from an earlier day starts the new day at zero, and a failing write never stops a turn', async () => {
  const memory = memoryFiles(), clock = clockAt(noon);
  const yesterday = await guardWith(clock, {limit: 3, store: storeOver(memory)}).load();
  drain(yesterday, clock, 3); await yesterday.flush();
  clock.at = noon + DAY;
  const today = await guardWith(clock, {limit: 3, store: storeOver(memory)}).load();
  assert.deepEqual(today.snapshot(), {limit: 3, left: 3, blocked: false});
  const failing = new UsageStore({paths: ['a', 'b'], machine: 'm', read: async () => { throw Error('disk'); }, write: async () => { throw Error('disk full'); }});
  const guard = await guardWith(clock, {limit: 3, store: failing}).load();
  guard.admit(); await guard.flush();
  assert.equal(guard.snapshot().left, 2);
});

test('both real copies are written and read back from disk', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    const paths = [join(folder, 'state', 'daily-usage.json'), join(folder, 'profile', 'CyberpunkConvai', 'daily-usage.json')];
    const clock = clockAt(noon);
    const guard = await guardWith(clock, {limit: 100, store: new UsageStore({paths, machine: await machineId()})}).load();
    drain(guard, clock, 3); await guard.flush();
    for (const path of paths) assert.equal(JSON.parse(await readFile(path, 'utf8')).count, 3);
    await rm(paths[0]);
    assert.equal((await guardWith(clock, {limit: 100, store: new UsageStore({paths, machine: await machineId()})}).load()).snapshot().left, 97);
    await writeFile(paths[1], 'not json');
    assert.equal((await new UsageStore({paths, machine: await machineId()}).load()), null);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the machine id falls back to host and user names when the registry cannot be read', async () => {
  const id = await machineId({exec: (command, args, options, done) => done(Error('no registry'), '')});
  assert(id.includes('|'));
  assert.equal(await machineId({exec: (command, args, options, done) => done(null, '    MachineGuid    REG_SZ    ABCD-1234\r\n')}), 'ABCD-1234');
  assert.equal(await machineId({exec: () => { throw Error('spawn failed'); }}) !== '', true);
});

// ---------------------------------------------------------------- where turns are counted
const hostWith = (guard, onFailure) => { const host = new RealtimeHost({guard, onFailure}); host.runOnce = async () => ({text: 'ok'}); return host; };

test('every kind of reply is counted once at the host, and opening a connection is not', async () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 100}), host = hostWith(guard);
  await host.reply({}); clock.advance(1000);
  await host.prepare({}); clock.advance(1000); // a look-ahead turn is a real response
  await host.warm({}); clock.advance(1000);
  assert.equal(guard.snapshot().left, 98, 'a reply and a look-ahead, not the warm-up');
  // Retries inside one turn (concurrency, memory recovery) are the same turn.
  let calls = 0;
  const retrying = new RealtimeHost({guard, exclusive: {enabled: () => true, peers: () => [], retryMs: 1}});
  retrying.runOnce = async () => { if (++calls === 1) throw Error('Concurrency limit reached'); return {text: 'ok'}; };
  await retrying.reply({});
  assert.equal(calls, 2); assert.equal(guard.snapshot().left, 97);
});

test('at the cap the host refuses a turn before any connection is made and the observer sees the marker', async () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 1});
  const seen = [], host = hostWith(guard, error => seen.push(error));
  let opened = 0; host.runOnce = async () => { opened++; return {text: 'ok'}; };
  await host.reply({});
  clock.advance(1000);
  await assert.rejects(host.reply({}), error => error instanceof TurnLimitError && error.kind === 'daily');
  await assert.rejects(host.prepare({}), TurnLimitError);
  assert.equal(opened, 1, 'no connection for a refused turn');
  assert.equal(seen.length, 2);
  assert.equal(classifyFailure(seen[0]), 'daily');
  await host.warm({}); // warming is not a turn and stays possible
  assert.equal(opened, 2);
});

test('a microphone turn is checked when it starts and counted when it is finished', async () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 1}), host = new RealtimeHost({guard});
  const lease = {owner: host, epoch: host.epoch, config: {}, value: {context: () => ({clearPermissions: async () => {}})}, release: async () => {}};
  host.voiceLease = lease;
  host.evaluateSpeech = async () => ({text: 'heard', sessionID: 's1'});
  assert.equal(guard.snapshot().left, 1);
  await host.finishVoice(host, undefined, {});
  assert.equal(guard.snapshot().left, 0, 'counted at the finish');
  clock.advance(1000);
  await assert.rejects(host.beginVoice({characterId: 'c', sessionId: '-1'}), error => error instanceof TurnLimitError && error.kind === 'daily');
  assert.equal(host.voiceLease, null, 'no connection was taken for a refused recording');
});

// ---------------------------------------------------------------- what the game is told
test('the game shows the daily-limit notice only for a turn V asked for, and turns are counted only where a Convai connection is made', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(init, /elseif keyId == 'daily-limit' then\s+if not pending\.reaction then convaiNotices\.send\(player, 'daily-limit', keyText\) end/);
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /quota\.codeFor\(error, \{automatic: !!input\?\.reaction\}\)/);
  // Only RealtimeHost (the Convai connection) counts turns; the guard has no other entry point.
  const callers = ['convai-bridge.mjs', 'phone-chat.mjs', 'microphone-session.mjs'].map(name => readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
  assert(callers.every(source => !/guard\.(consume|admit)\(/.test(source.replace(/turnGuard\.snapshot/g, ''))), 'turns are counted in RealtimeHost only');
});

const keysFor = source => ({source});
test('the daily cap becomes the game notice for a turn V asked for, and silence for an automatic reaction', () => {
  const error = new TurnLimitError('daily');
  const shared = new QuotaWatch({keys: keysFor('shared')});
  assert.equal(shared.codeFor(error), 'daily-limit');
  assert.equal(shared.codeFor(error, {automatic: true}), undefined, 'battle and loot reactions stop quietly');
  assert.equal(new QuotaWatch({keys: keysFor('player')}).codeFor(error), undefined, 'the notice never applies to an own key');
  assert.equal(shared.observe(error), 'daily');
  assert.equal(shared.snapshot(), null, 'the cap is not shown as a used-up Convai plan');
  assert.equal(classifyFailure(Error('Conversation turns are coming too quickly [convai-quota:rate]')), null, 'there is no rate limit any more');
  assert.equal(classifyFailure(Error('Convai usage limit reached [convai-quota:interaction]')), 'quota');
});

test('the settings status file carries the remaining count only while the shared key is in use', async () => {
  const clock = clockAt(noon), guard = guardWith(clock, {limit: 100});
  const keys = await new ConvaiKeys({sharedKey: FIXTURE, playerKeyPath: 'own', readText: async () => { throw Error('none'); }}).load();
  guard.applies = () => keys.source === 'shared';
  const control = new OwnKeyControl({keys, commandPath: 'cmd', publish: async () => {}, daily: guard});
  drain(guard, clock, 37);
  assert.deepEqual(control.status().daily, {limit: 100, left: 63, blocked: false});
  assert(!JSON.stringify(control.status()).includes(FIXTURE));
  assert.equal(new OwnKeyControl({keys, commandPath: 'cmd', publish: async () => {}}).status().daily, undefined);
  keys.applied = {source: 'player', key: 'player-fixture-key-1111111111111111'};
  assert.equal(control.status().daily, undefined, 'an own key has no daily count');
});

// ---------------------------------------------------------------- the limit the sign-in backend sets
test('a backend limit is taken only when it is a whole number in range, and it changes what is enforced and shown', () => {
  for (const bad of [0, -1, 10001, 2.5, '12.5', 'lots', null, undefined, NaN, Infinity, {}, []]) assert.equal(sanitizeLimit(bad), null, String(bad));
  for (const [good, number] of [[1, 1], [150, 150], ['150', 150], [10000, 10000]]) assert.equal(sanitizeLimit(good), number);
  const clock = clockAt(noon); const heard = [];
  const guard = guardWith(clock, {limit: 100, onLimit: value => heard.push(value)});
  drain(guard, clock, 60);
  assert.equal(guard.setLimit(150), true);
  assert.deepEqual(guard.snapshot(), {limit: 150, left: 90, blocked: false});
  drain(guard, clock, 90);
  assert.throws(() => guard.check(), error => error instanceof TurnLimitError && error.kind === 'daily');
  assert.equal(guard.setLimit(200), true, 'raised by the owner: the player can go on'); clock.advance(10 * 60000);
  guard.check();
  assert.equal(guard.setLimit(120), true, 'lowered below what is used: blocked at once');
  assert.throws(() => guard.check(), error => error.kind === 'daily');
  assert.equal(guard.setLimit(120), false, 'the same value changes nothing');
  assert.equal(guard.setLimit('junk'), false); assert.equal(guard.setLimit(0), false); assert.equal(guard.setLimit(99999), false);
  assert.equal(guard.snapshot().limit, 120, 'a bad value keeps the last good one');
  assert.deepEqual(heard, [150, 200, 120]);
});

test('a backend limit is ignored when the guard is off or the developer pinned the limit', () => {
  const clock = clockAt(noon);
  assert.equal(guardWith(clock, {limit: 0}).setLimit(50), false);
  const pinned = guardWith(clock, {limit: 30, pinned: true});
  assert.equal(pinned.setLimit(500), false);
  assert.equal(pinned.snapshot().limit, 30);
});

test('the last backend limit is kept in a signed file; a damaged, edited or foreign file reads as nothing', async () => {
  const files = new Map();
  const make = machine => new LimitStore({path: 'daily-limit.json', machine, read: async path => { if (!files.has(path)) throw Error('missing'); return files.get(path); },
    write: async (path, text) => { files.set(path, text); }});
  const store = make('machine-a');
  assert.equal(await store.load(), null, 'no file: the built-in limit applies');
  await store.save(150);
  assert.equal(await store.load(), 150);
  assert.equal(await make('machine-b').load(), null, 'copied from another computer');
  files.set('daily-limit.json', files.get('daily-limit.json').replace('150', '900'));
  assert.equal(await store.load(), null, 'edited');
  for (const junk of ['', 'nope', '{}', '{"v":1,"limit":150}', '{"v":1,"limit":150,"mac":"short"}']) { files.set('daily-limit.json', junk); assert.equal(await store.load(), null); }
  files.set('daily-limit.json', 'kept');
  await store.save('junk'); await store.save(0);
  assert.equal(files.get('daily-limit.json'), 'kept', 'a bad value is never written');
});

test('a changed backend limit is saved once, in the background, for the next start', async () => {
  const clock = clockAt(noon), files = new Map();
  const limitStore = new LimitStore({path: 'l.json', machine: 'm', read: async path => files.get(path), write: async (path, text) => { files.set(path, text); }});
  const guard = guardWith(clock, {limit: 100, limitStore});
  guard.setLimit(175); guard.setLimit(175);
  await guard.flush();
  assert.equal(await limitStore.load(), 175);
});
