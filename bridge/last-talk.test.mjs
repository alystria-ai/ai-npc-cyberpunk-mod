// Time since V last talked to a character (docs/DYNAMIC_INFO.md, "Time since last talk"): the wording across gaps, one decision and one update per
// turn, a silent second turn, a separate record per memory scope, nothing stored for reactions, strangers and add-ons, the saved file (round trip,
// damage, debounce, atomic write off the turn's path), the cap, and Forget.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LastTalk, describeGap, lastTalk, lastTalkSentence, parseGameTime, MIN_GAME_GAP, REAL_DAY_MS} from './last-talk.mjs';
import {memoryScopes} from './memory-scope.mjs';
import {isAmbientProfile, parseInput} from './protocol.mjs';
import {conversationContextBlocks, conversationContext} from './quest-context.mjs';
import {dynamicInfo} from './dynamic-info.mjs';

const DAY = 86400, HOUR = 3600, MIN = 60_000, REAL_DAY = 86_400_000;
const at = (day, hour = 0, minute = 0) => day * DAY + hour * HOUR + minute * 60;
const MARK = 'You last talked with V';
const TAIL = 'Mention it only if it fits; do not bring it up again.';
const T0 = 1_800_000_000_000;   // the real clock of these tests

// ---- the wording ------------------------------------------------------------------------------------------------------------------------------
const say = (before, now, realGap = 5 * MIN) => describeGap({previous: {gameSeconds: before, realMs: T0}, gameSeconds: now, nowMs: T0 + realGap});

test('nothing is said for a short gap, a first talk or no clock; under about three game hours and thirty real minutes it stays silent', () => {
  assert.equal(describeGap({previous: undefined, gameSeconds: at(40, 12), nowMs: T0}), '', 'a first talk: the character just meets V');
  assert.equal(say(at(40, 12), at(40, 12, 10), 2 * MIN), '');
  assert.equal(say(at(40, 12), at(40, 14, 59), 20 * MIN), '', 'just under three game hours and under thirty real minutes');
  assert.equal(say(at(40, 12), at(40, 12), 0), '');
  assert.equal(describeGap({}), '');
  assert.equal(MIN_GAME_GAP, 3 * HOUR);
});

test('a gap of hours says when in the game, from the day parts of the earlier moment and this one', () => {
  assert.match(say(at(40, 9), at(40, 14), 40 * MIN), /^You last talked with V earlier this morning\./, 'five game hours, the same day');
  assert.match(say(at(40, 15), at(40, 19, 30), 40 * MIN), /earlier this afternoon/);
  assert.match(say(at(40, 22, 30), at(41, 8), 60 * MIN), /^You last talked with V last night\./, 'next morning');
  assert.match(say(at(40, 22, 30), at(41, 1, 30), 25 * MIN), /last night/, 'across midnight, three game hours');
  assert.match(say(at(40, 14), at(41, 9)), /yesterday afternoon/);
  assert.match(say(at(40, 8), at(41, 15)), /yesterday morning/);
  assert.match(say(at(40, 18), at(41, 12)), /yesterday evening/);
  assert.match(say(at(40, 10), at(41, 10, 30)), /around this time yesterday/, 'the same part of the day, a day later');
  assert.match(say(at(40, 22), at(41, 21)), /around this time yesterday/);
  assert.match(say(at(40, 3), at(40, 9)), /in the small hours today/);
});

test('a gap of days or weeks says how many days ago in the game', () => {
  assert.match(say(at(40, 12), at(42, 13)), /^You last talked with V a couple of days ago in the game\./);
  assert.match(say(at(40, 12), at(45, 13)), /five days ago in the game/);
  assert.match(say(at(40, 12), at(49, 13)), /^You last talked with V over a week ago in the game\./, 'nine days');
  assert.match(say(at(40, 12), at(60, 13)), /about three weeks ago in the game/);
  assert.match(say(at(40, 12), at(90, 13)), /over a month ago in the game/);
  assert.match(say(at(40, 12), at(200, 13)), /about five months ago in the game/);
  assert.match(say(at(40, 12), at(900, 13)), /a very long time ago in the game/);
});

test('real days are worded as real time, and matter most when little game time passed', () => {
  assert.match(say(at(40, 12), at(40, 13), 19 * 3600_000), /^You last talked with V a little while ago\./, 'nineteen real hours is not yet a real day');
  assert.match(say(at(40, 12), at(40, 13), 21 * 3600_000), /^You last talked with V about a day ago in real time, though hardly any time has passed in the game since: V has been away from the game\./);
  const away = say(at(40, 12), at(40, 12, 40), 3 * REAL_DAY);
  assert.match(away, /three days ago in real time/); assert.match(away, /hardly any time has passed in the game/);
  assert.match(say(at(40, 12), at(40, 12, 40), 9 * REAL_DAY), /about a week ago in real time/);
  assert.match(say(at(40, 12), at(40, 12, 40), 40 * REAL_DAY), /about a month ago in real time/);
  assert.match(say(at(40, 12), at(40, 12, 40), 400 * REAL_DAY), /over a year ago in real time/);
  // Both clocks: a night in the game and real days say both; days in the game and about as many real days do not repeat themselves.
  assert.match(say(at(40, 22), at(41, 9), 5 * REAL_DAY), /^You last talked with V last night; in real time that was five days ago\./);
  assert.doesNotMatch(say(at(40, 12), at(42, 13), 2 * REAL_DAY), /real time/);
  assert.match(say(at(40, 12), at(43, 13), 4 * REAL_DAY), /three days ago in the game; in real time that was four days ago/);
  // Under three game hours but real time over thirty minutes: a short remark that it was a while ago, nothing invented.
  assert.match(say(at(40, 12), at(40, 13), 50 * MIN), /^You last talked with V a little while ago\./);
});

test('a game clock that went backwards (an older save) says nothing about the game, and the real wording still works', () => {
  assert.equal(say(at(60, 12), at(40, 12), 5 * MIN), '');
  assert.equal(say(at(60, 12), at(40, 12), 10 * REAL_DAY).includes('hardly any time'), false, 'no claim about the game time');
  assert.match(say(at(60, 12), at(40, 12), 10 * REAL_DAY), /^You last talked with V about a week ago in real time\./);
  assert.match(say(at(60, 12), at(40, 12), 45 * MIN), /a little while ago/);
  // The real clock going backwards (a changed system date) counts as no real time.
  assert.equal(describeGap({previous: {gameSeconds: at(40, 12), realMs: T0}, gameSeconds: at(40, 12, 5), nowMs: T0 - 5 * REAL_DAY}), '');
});

test('whatever the two gaps, the sentence is well formed: the marker first, the instruction last, no negative or absurd number', () => {
  const seen = new Set();
  for (const gameHours of [0, 1, 2.9, 3, 4, 9, 14, 20, 24, 30, 47, 48, 60, 150, 200, 400, 700, 1500, 9000, 100000, -1, -30, -5000]) {
    for (const start of [at(10, 0), at(10, 3), at(10, 6, 59), at(10, 11), at(10, 13), at(10, 16, 30), at(10, 19), at(10, 23, 59)]) {
      for (const real of [-REAL_DAY, 0, 10 * MIN, 29 * MIN, 31 * MIN, 5 * 3600_000, 19 * 3600_000, 21 * 3600_000, 3 * REAL_DAY, 6 * REAL_DAY, 13 * REAL_DAY, 20 * REAL_DAY,
        27 * REAL_DAY, 28 * REAL_DAY, 59 * REAL_DAY, 61 * REAL_DAY, 200 * REAL_DAY, 400 * REAL_DAY, 5000 * REAL_DAY]) {
        const text = say(start, Math.max(0, start + Math.round(gameHours * HOUR)), real);
        if (!text) continue;
        seen.add(text);
        assert.ok(text.startsWith(MARK) && text.endsWith(TAIL), text);
        assert.doesNotMatch(text, /NaN|undefined|null|Infinity|-\d|\bzero\b|\d{4,}/, text);
        assert.ok(text.length < 260, text);
      }
    }
  }
  assert.ok(seen.size > 30, 'the sweep exercised many different sentences');
  // Garbage in the entry is never worded.
  for (const previous of [{gameSeconds: NaN, realMs: T0}, {gameSeconds: 1.5, realMs: T0}, {gameSeconds: 'x', realMs: 'y'}, {}, null])
    assert.doesNotMatch(describeGap({previous, gameSeconds: at(50, 1), nowMs: T0 + MIN}), /NaN|undefined|null/);
});

test('parseGameTime keeps whole non-negative seconds only', () => {
  assert.equal(parseGameTime(9361340), 9361340); assert.equal(parseGameTime(0), 0);
  for (const bad of [-1, 1.5, NaN, Infinity, '12', null, undefined, {}, 2 ** 60]) assert.equal(parseGameTime(bad), undefined, String(bad));
});

// ---- the store --------------------------------------------------------------------------------------------------------------------------------
function store(extra = {}) {
  const clock = {ms: T0};
  const timers = {pending: [], set(fn, ms) { const handle = {fn, ms, cleared: false}; timers.pending.push(handle); return handle; }, clear(handle) { handle.cleared = true; }, fire() {
    const due = timers.pending.filter(handle => !handle.cleared); timers.pending = []; for (const handle of due) handle.fn(); }};
  const files = {text: undefined, writes: [], reads: 0};
  const instance = new LastTalk({now: () => clock.ms, timers, read: async () => { files.reads++; if (files.text === undefined) throw Error('ENOENT'); return files.text; },
    write: async (path, text) => { files.writes.push({path, text}); files.text = text; return true; }, ...extra});
  return {instance, clock, timers, files};
}
let serial = 0;
const turn = (profileKey, seconds, extra = {}) => ({requestId: `r-${++serial}`, profileKey, name: 'X', text: 'hi', channel: 'private',
  turnContext: seconds === undefined ? {version: 1, status: 'ready'} : {version: 1, status: 'ready', hour: 12, minute: 0, gameTime: seconds}, ...extra});

test('the first talk says nothing and is recorded; the next turn of the same conversation is silent; the sentence comes back after a real absence', () => {
  const {instance, clock} = store();
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(40, 22, 30))), '');
  assert.deepEqual(instance.peek('judy-alvarez'), {gameSeconds: at(40, 22, 30), realMs: T0});
  clock.ms += 2 * MIN;
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(40, 22, 46))), '', 'a minute or two later: the conversation goes on');
  clock.ms += 50 * MIN;
  const next = instance.sentenceFor(turn('judy-alvarez', at(41, 9)));
  assert.match(next, /^You last talked with V last night\./);
  clock.ms += 3 * MIN;
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(41, 9, 25))), '', 'told once; the turn after it is silent again');
  assert.equal(instance.size, 1);
});

test('a turn is decided once: every build of the same turn gets the same sentence and only the first one updates the entry', () => {
  const {instance, clock} = store();
  instance.record('panam-palmer', at(40, 10), T0 - 10 * REAL_DAY);
  const input = turn('panam-palmer', at(43, 10));
  const first = instance.sentenceFor(input);
  assert.match(first, /three days ago in the game; in real time that was about a week ago/);
  assert.deepEqual(instance.peek('panam-palmer'), {gameSeconds: at(43, 10), realMs: T0});
  clock.ms += 20 * MIN;
  const copy = {...input, turnContext: {...input.turnContext, gameTime: at(43, 11)}};
  for (let i = 0; i < 4; i++) assert.equal(instance.sentenceFor(copy), first, 'the prepared reply, the look-ahead, the turn and the log line agree');
  assert.deepEqual(instance.peek('panam-palmer'), {gameSeconds: at(43, 10), realMs: T0}, 'rebuilding the same turn does not move the entry');
  // A turn with no id cannot be made idempotent: nothing is said and nothing recorded.
  const before = instance.size;
  assert.equal(instance.sentenceFor({...turn('judy-alvarez', at(50, 1)), requestId: undefined}), '');
  assert.equal(instance.sentenceFor({...turn('judy-alvarez', at(50, 1)), requestId: ''}), '');
  assert.equal(instance.size, before);
  // The same turn id for two speakers of a group round: each speaker has its own entry and sentence.
  const a = turn('judy-alvarez', at(60, 12), {requestId: 'round-1', group: {index: 0}}), b = {...a, profileKey: 'river-ward', group: {index: 1}};
  instance.record('river-ward', at(50, 12), T0 - 4 * REAL_DAY);
  assert.equal(instance.sentenceFor(a), '', 'Judy has not met V yet');
  assert.match(instance.sentenceFor(b), /^You last talked with V over a week ago in the game/);
  assert.ok(instance.peek('judy-alvarez') && instance.peek('river-ward').gameSeconds === at(60, 12));
});

test('the previous turns are remembered in a small ring: a late rebuild of an old turn still agrees, an old one eventually leaves', () => {
  const {instance} = store({turns: 3});
  instance.record('judy-alvarez', at(40, 12), T0 - 2 * REAL_DAY);
  const first = turn('judy-alvarez', at(45, 12));
  const sentence = instance.sentenceFor(first);
  assert.notEqual(sentence, '');
  for (let i = 0; i < 2; i++) instance.sentenceFor(turn('judy-alvarez', at(45, 12, 5 + i)));
  assert.equal(instance.sentenceFor(first), sentence, 'still inside the ring');
  for (let i = 0; i < 4; i++) instance.sentenceFor(turn('judy-alvarez', at(45, 13, i)));
  assert.equal(instance.turns.size, 3);
});

test('memory scopes keep separate records: judy-alvarez and judy-alvarez@medieval never share', () => {
  let pack = null;
  const content = {installed: true, version: 1, memoryScope: () => pack, list: () => []};
  const scopes = memoryScopes(content);
  const {instance, clock} = store({keyFor: scopes.keyFor});
  instance.sentenceFor(turn('judy-alvarez', at(40, 12)));
  pack = 'medieval'; content.version++;
  clock.ms += 3 * REAL_DAY;
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(41, 12))), '', 'the pack Judy has never met V');
  assert.deepEqual([...instance.entries.keys()].sort(), ['judy-alvarez', 'judy-alvarez@medieval']);
  pack = null; content.version++;
  assert.match(instance.sentenceFor(turn('judy-alvarez', at(41, 13))), /^You last talked with V around this time yesterday/, 'the normal Judy still has her own record');
  assert.equal(instance.peek('judy-alvarez@medieval').gameSeconds, at(41, 12), 'the pack record was not touched by the normal one');
  // A content pack never changes an add-on speaker or a player-made character's key.
  pack = 'medieval'; content.version++;
  instance.sentenceFor(turn('custom-bob', at(41, 12)));
  assert.ok(instance.peek('custom-bob') && !instance.peek('custom-bob@medieval'));
});

test('nothing is said or stored for reactions, ordinary NPCs, add-on speakers, a turn without the clock, or while the kind is off', () => {
  let on = true;
  const {instance} = store({enabled: () => on});
  instance.record('judy-alvarez', at(10, 12), T0 - 10 * REAL_DAY);
  const size = instance.size, before = JSON.stringify([...instance.entries]);
  const cases = [turn('judy-alvarez', at(50, 12), {reaction: {kind: 'battle'}}), turn('resident-male', at(50, 12)), turn('resident-female', at(50, 12)),
    turn('npc-fixer', at(50, 12)), turn('npc-bartender-1', at(50, 12)), turn('addon-skippy', at(50, 12)), turn('judy-alvarez', undefined),
    turn('judy-alvarez', at(50, 12), {turnContext: undefined}), turn('', at(50, 12)), turn(undefined, at(50, 12)), null, undefined];
  for (const input of cases) assert.equal(instance.sentenceFor(input), '', JSON.stringify(input)?.slice(0, 80));
  assert.equal(instance.size, size); assert.equal(JSON.stringify([...instance.entries]), before, 'nothing was recorded');
  on = false;
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(50, 12))), '');
  assert.equal(JSON.stringify([...instance.entries]), before, 'off: no record');
  on = true;
  assert.match(instance.sentenceFor(turn('judy-alvarez', at(50, 12))), /^You last talked with V/, 'on again: the old entry is still there');
  // Phone chat, a holocall, Johnny in V's head (his own key) and a player-made character all count.
  for (const [key, extra] of [['judy-alvarez', {channel: 'phone'}], ['panam-palmer', {holocall: {mode: 'audio'}}], ['johnny-silverhand', {head: {stage: 'talk'}}], ['custom-ana', {}]]) {
    instance.sentenceFor(turn(key, at(60, 12), extra));
    assert.ok(instance.peek(key), key);
  }
});

test('the ambient-NPC rule here is the one in bridge/protocol.mjs', () => {
  for (const key of ['resident-male', 'resident-female', 'npc-fixer', 'npc-a-b-c', 'judy-alvarez', 'johnny-silverhand', 'custom-npc', 'addon-npc', 'residents', 'npc', 'npc-', 'x-npc-fixer', 'resident-male2']) {
    const {instance} = store();
    instance.record('probe', 1);
    const stranger = instance.sentenceFor(turn(key, at(5, 5))) === '' && !instance.peek(key);
    assert.equal(stranger, isAmbientProfile(key) || key.startsWith('addon-'), key);
  }
});

// ---- the saved file --------------------------------------------------------------------------------------------------------------------------
test('the write is debounced, atomic-style and never on the turn: a turn returns at once, many turns make one write, and shutdown flushes', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const {instance, timers, files} = store({path: '/state/last-talk.json', write: async (path, text) => { files.writes.push({path, text}); await slow; return true; }});
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(40, 12))), '');
  assert.equal(files.writes.length, 0, 'nothing is written inside the turn');
  assert.equal(timers.pending.length, 1);
  for (let i = 0; i < 20; i++) instance.sentenceFor(turn(`char-${i}`, at(40, 12)));
  assert.equal(timers.pending.length, 1, 'one timer for many turns');
  assert.equal(timers.pending[0].ms, instance.debounceMs);
  timers.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(files.writes.length, 1);
  // While the file is being written (and it is slow), turns go on without waiting for it.
  const started = Date.now();
  assert.equal(typeof instance.sentenceFor(turn('judy-alvarez', at(41, 12))), 'string');
  assert.ok(Date.now() - started < 50, 'the turn did not wait for the slow disk');
  release();
  await instance.flush();
  assert.ok(files.writes.length >= 2, 'the entry changed during the write is written by the flush');
  const saved = JSON.parse(files.writes.at(-1).text);
  assert.equal(saved.version, 1);
  assert.equal(saved.entries.length, 21);
  assert.deepEqual(saved.entries.find(row => row[0] === 'judy-alvarez'), ['judy-alvarez', at(41, 12), T0]);
  assert.equal(files.writes.at(-1).path, '/state/last-talk.json');
  // A flush with nothing new writes nothing.
  const count = files.writes.length;
  await instance.flush();
  assert.equal(files.writes.length, count);
});

test('a flush cancels the pending timer and a failed write is kept for the next one', async () => {
  let fail = true;
  const {instance, timers, files} = store({path: '/s/l.json', write: async (path, text) => { if (fail) throw Error('disk full'); files.writes.push({path, text}); return true; }, log: () => {}});
  instance.record('judy-alvarez', at(40, 12));
  const timer = timers.pending[0];
  await instance.flush();
  assert.equal(timer.cleared, true);
  assert.equal(files.writes.length, 0);
  assert.equal(instance.dirty, true, 'the unsaved entry stays marked');
  fail = false;
  await instance.flush();
  assert.equal(files.writes.length, 1);
  const refused = store({path: '/s/l.json', write: async () => false});
  refused.instance.record('judy-alvarez', 5); await refused.instance.flush();
  assert.equal(refused.instance.dirty, true, 'a write that answered false (stale) is retried');
});

test('without a path nothing is read or written', async () => {
  const {instance, timers, files} = store();
  assert.equal(await instance.load(), 0);
  instance.sentenceFor(turn('judy-alvarez', at(40, 12)));
  assert.equal(timers.pending.length, 0); assert.equal(files.reads, 0); await instance.flush(); assert.equal(files.writes.length, 0);
});

test('a saved file round-trips: a new bridge process knows when each character was last talked to', async () => {
  const first = store({path: '/s/last-talk.json'});
  first.instance.sentenceFor(turn('judy-alvarez', at(40, 22, 30)));
  first.instance.sentenceFor(turn('judy-alvarez@medieval', at(40, 22, 30)));
  await first.instance.flush();
  const second = store({path: '/s/last-talk.json'});
  second.files.text = first.files.text;
  second.clock.ms = T0 + 9 * 3600_000;
  assert.equal(await second.instance.configure({}), 2);
  assert.equal(second.files.reads, 1);
  assert.match(second.instance.sentenceFor(turn('judy-alvarez', at(41, 9))), /^You last talked with V last night\./);
  assert.equal(second.instance.size, 2);
});

test('a missing, empty, corrupt or foreign file starts empty and never throws; bad rows are dropped, good rows kept', async () => {
  const good = ['judy-alvarez', at(40, 12), T0], pack = ['panam-palmer@medieval', 5, 7];
  for (const text of [undefined, '', 'not json', '{', '[]', 'null', '{"entries":5}', '{"entries":"x"}', '{"entries":[1,2,3]}', 'x'.repeat(2_100_000)]) {
    const {instance, files} = store({path: '/s/l.json'});
    files.text = text;
    assert.equal(await instance.load(), 0, String(text).slice(0, 20));
    assert.equal(instance.size, 0);
  }
  const mixed = {version: 1, entries: [good, ['../evil', 1, 1], ['UPPER', 1, 1], ['judy', -1, 1], ['judy', 1.5, 1], ['judy', 1, 'x'], ['judy', 1, -5], null, 'x', [], ['a'.repeat(200), 1, 1], pack]};
  const {instance, files} = store({path: '/s/l.json'});
  files.text = JSON.stringify(mixed);
  assert.equal(await instance.load(), 2);
  assert.deepEqual([...instance.entries.keys()], ['judy-alvarez', 'panam-palmer@medieval']);
  // A read that throws (the file is locked) is the same as no file.
  const broken = store({path: '/s/l.json', read: async () => { throw Error('EBUSY'); }});
  assert.equal(await broken.instance.configure({}), 0);
});

test('the file is a small, bounded set: the least recently talked-to characters go first', async () => {
  const {instance, files} = store({path: '/s/l.json', limit: 3});
  for (const [index, key] of ['a-1', 'b-2', 'c-3', 'd-4'].entries()) instance.record(key, index + 1);
  assert.deepEqual([...instance.entries.keys()], ['b-2', 'c-3', 'd-4'], 'the oldest left');
  instance.record('b-2', 9);                                   // talking again makes it the newest
  instance.record('e-5', 10);
  assert.deepEqual([...instance.entries.keys()], ['d-4', 'b-2', 'e-5']);
  await instance.flush();
  files.text = JSON.stringify({version: 1, entries: ['k-1', 'k-2', 'k-3', 'k-4', 'k-5'].map((key, index) => [key, index + 1, 1])});
  const loaded = store({path: '/s/l.json', limit: 3}); loaded.files.text = files.text;
  await loaded.instance.load();
  assert.deepEqual([...loaded.instance.entries.keys()], ['k-3', 'k-4', 'k-5'], 'a longer file is cut to the cap, newest kept');
  assert.equal(new LastTalk().limit, 512, 'the default cap');
});

test('Forget clears the entries it clears in the memory: some characters, all of the normal memory, or all of one pack', async () => {
  const {instance, timers} = store({path: '/s/l.json'});
  for (const key of ['judy-alvarez', 'panam-palmer', 'judy-alvarez@medieval', 'panam-palmer@medieval', 'judy-alvarez@space']) instance.record(key, 100);
  await instance.flush();
  assert.equal(instance.forget({profileKeys: ['judy-alvarez', 'unknown-one']}), 1);
  assert.deepEqual([...instance.entries.keys()].sort(), ['judy-alvarez@medieval', 'judy-alvarez@space', 'panam-palmer', 'panam-palmer@medieval']);
  assert.equal(timers.pending.filter(handle => !handle.cleared).length, 1, 'a change is saved');
  assert.equal(instance.forget({all: true, scope: 'medieval'}), 2);
  assert.deepEqual([...instance.entries.keys()].sort(), ['judy-alvarez@space', 'panam-palmer']);
  assert.equal(instance.forget({all: true, scope: null}), 1, 'the normal memory: the keys with no pack');
  assert.deepEqual([...instance.entries.keys()], ['judy-alvarez@space']);
  assert.equal(instance.forget({}), 0); assert.equal(instance.forget(), 0);
  // After Forget the character meets V "again": nothing is said, as for a first talk.
  instance.record('judy-alvarez', at(1, 1), T0 - 30 * REAL_DAY); instance.forget({profileKeys: ['judy-alvarez']});
  assert.equal(instance.sentenceFor(turn('judy-alvarez', at(100, 1))), '');
});

// ---- the singleton, and a turn's whole context -----------------------------------------------------------------------------------------------
const real = (fields = {}) => parseInput(JSON.stringify({requestId: `${++serial}-1-1ULL`, generation: 1, entity: '1ULL', profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage',
  text: 'Hey.', turnContext: {version: 1, status: 'ready', hour: 9, minute: 0, district: 'Watson', gameTime: at(41, 9), vehicle: false}, ...fields}));

test('the shared instance follows the Dynamic info switch: off, nothing is said and nothing is stored', () => {
  const clock = {ms: T0};
  lastTalk.configure({path: null, now: () => clock.ms, keyFor: key => key});
  lastTalk.entries.clear(); lastTalk.turns.clear();
  const before = dynamicInfo.off;
  try {
    dynamicInfo.off = Object.freeze(new Set(['lastTalk']));
    lastTalk.record('judy-alvarez', at(30, 12), T0 - 6 * REAL_DAY);
    assert.equal(lastTalkSentence(real()), '');
    assert.deepEqual(lastTalk.peek('judy-alvarez'), {gameSeconds: at(30, 12), realMs: T0 - 6 * REAL_DAY}, 'untouched while off');
    assert.equal(conversationContext(real()).includes(MARK), false);
    assert.equal(lastTalk.peek('judy-alvarez').gameSeconds, at(30, 12), 'the context builders store nothing while it is off either');
    dynamicInfo.off = before;
    assert.match(lastTalkSentence(real()), /^You last talked with V/);
  } finally { dynamicInfo.off = before; lastTalk.entries.clear(); lastTalk.turns.clear(); }
});

test('in the turn context the sentence is a Background line, the same on every build of the turn and gone on the next turn', () => {
  lastTalk.configure({path: null, now: () => T0, keyFor: key => key});
  lastTalk.entries.clear(); lastTalk.turns.clear();
  try {
    lastTalk.record('judy-alvarez', at(40, 21), T0 - 40 * MIN);
    const input = real();
    const blocks = conversationContextBlocks(input);
    const background = blocks.filter(block => block.tier === 'volatile').map(block => block.text).find(text => text.includes(MARK));
    assert.ok(background, 'a volatile Background block carries it');
    assert.match(background, /^Background \(mention only if it matters or V asks\):/);
    assert.match(background, /You last talked with V last night\. Mention it only if it fits; do not bring it up again\./);
    assert.equal(blocks.find(block => block.tier === 'now').text.includes(MARK), false, 'never in the situation block the prompt cache keeps');
    for (let i = 0; i < 3; i++) assert.equal(conversationContext(input), conversationContext(input), 'stable across builds');
    assert.match(conversationContext(input), /You last talked with V last night/);
    const second = real({turnContext: {version: 1, status: 'ready', hour: 9, minute: 5, district: 'Watson', gameTime: at(41, 9, 40), vehicle: false}});
    assert.equal(conversationContext(second).includes(MARK), false, 'the next turn of the conversation does not repeat it');
    // A stranger never gets it (a reaction is pinned above, on the store).
    lastTalk.record('npc-fixer', at(30, 1), T0 - 9 * REAL_DAY);
    assert.equal(conversationContext(real({profileKey: 'npc-fixer'})).includes(MARK), false);
  } finally { lastTalk.entries.clear(); lastTalk.turns.clear(); }
});

test('the module ships through the runtime layout and keeps the signatures the turn context wires in', async () => {
  const layout = await import('../packaging/runtime-layout.mjs');
  assert.ok(layout.BRIDGE_MODULES.includes('bridge/last-talk.mjs'));
  assert.equal(typeof parseGameTime, 'function'); assert.equal(typeof lastTalkSentence, 'function');
  assert.equal(REAL_DAY_MS, 20 * 3600_000);
});
