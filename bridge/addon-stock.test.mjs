import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {AddonStock, STOCK_PACING, fillSlots, slotsIn} from './addon-stock.mjs';
import {AddonHost, ADDON_LIMITS, parseAddonInput, parseAddonState, validateManifest} from './addons.mjs';

// The bridge's prepared lines (bridge/addon-stock.mjs): scheduling, validation and take, with an injected model and clock.
const GUN = 'addon-skippy-gun', CAB = 'addon-cab-voice';
const entry = (key, extra = {}) => ({speaker: 'gun', key, text: `V is about to ${key}`, maxWords: 8, want: 2, ttl: 90, slots: ['fight.kills'], rev: 1, blocks: [], ...extra});

function setup({recent = [], mode = 'killer'} = {}) {
  let now = 1_000_000;
  const stock = new AddonStock({now: () => now, recent: () => recent});
  const clock = {get now() { return now; }, advance: ms => { now += ms; }};
  // A scripted model: each call takes the next reply (a string, or an Error to throw), and the calls are recorded.
  const calls = [], replies = [];
  const generate = async call => {
    calls.push(call);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  };
  const pump = (options = {}) => stock.pump({generate, now: () => now, ...options});
  // Writes lines until the pacing stops it, moving the clock past the minimum gap each time.
  const fill = async (lines, options) => {
    const results = [];
    for (const line of lines) {
      replies.push(line);
      results.push(await pump(options));
      clock.advance(STOCK_PACING.minGapMs + 1);
    }
    return results;
  };
  return {stock, clock, calls, replies, generate, pump, fill, recent, mode};
}

test('slots: found in a line, and filled from facts by dot path (numbers and strings only)', () => {
  assert.deepEqual(slotsIn('{fight.kills} down, {fight.headshots} to go'), ['fight.kills', 'fight.headshots']);
  assert.deepEqual(slotsIn('no slots here'), []);
  assert.equal(fillSlots('{fight.kills} down', {fight: {kills: 3}}), '3 down');
  assert.equal(fillSlots('{n} and {name}', {n: 2.456, name: '  Maelstrom  grunt '}), '2.46 and Maelstrom grunt');
  assert.equal(fillSlots('{fight.kills} down', {fight: {kills: 'three'}}), 'three down');
  for (const facts of [{}, {fight: {}}, {fight: {kills: null}}, {fight: {kills: true}}, {fight: {kills: {n: 1}}}, {fight: {kills: [1]}}, {fight: {kills: NaN}},
    {fight: {kills: ''}}, {fight: 3}, null, undefined, {fight: [1]}]) {
    assert.equal(fillSlots('{fight.kills} down', facts), null, JSON.stringify(facts));
  }
  assert.equal(fillSlots('{__proto__.x}', {}), null);
  assert.equal(fillSlots('{constructor.name}', {}), null, 'inherited properties are not facts');
  assert.equal(fillSlots('{a}', {a: '{b}'}), 'b', 'braces in a fact never become a slot');
  assert.equal(fillSlots('plain', {}), 'plain');
});

test('pump: writes one line for the entry that needs one, and take pops it filled', async () => {
  const {stock, pump, replies, calls, recent} = setup();
  assert.equal(stock.configure(GUN, [entry('kill')], {mode: 'killer'}), true);
  assert.equal(stock.configure(GUN, [entry('kill')], {mode: 'killer'}), false, 'the same rows again change nothing');
  assert.equal(stock.size, 1);
  replies.push('{fight.kills} down, boss.');
  const result = await pump({route: () => 'mistral'});
  assert.deepEqual({status: result.status, key: result.key}, {status: 'stocked', key: 'kill'});
  assert.equal(calls.length, 1);
  assert.deepEqual({profileKey: calls[0].profileKey, mode: calls[0].mode, route: calls[0].route, key: calls[0].entry.key, avoid: calls[0].avoid},
    {profileKey: GUN, mode: 'killer', route: 'mistral', key: 'kill', avoid: []});
  assert.equal(stock.take(GUN, 'kill', {facts: {fight: {kills: 4}}}), '4 down, boss.');
  assert.equal(stock.take(GUN, 'kill', {facts: {fight: {kills: 4}}}), null, 'a taken line is never used twice');
  assert.equal(stock.take(GUN, 'other', {}), null);
  assert.equal(stock.take('addon-nobody-x', 'kill', {}), null);
  assert.equal(stock.status().taken, 1);
  assert.deepEqual(recent, []);
});

test('deficits: most needed first, round robin between equal entries, full entries are not listed', async () => {
  const {stock, clock, replies, pump} = setup();
  stock.configure(GUN, [entry('a', {want: 1}), entry('b', {want: 3}), entry('c', {want: 3})], {mode: 'killer'});
  stock.configure(CAB, [entry('d', {speaker: 'voice', want: 2})], {mode: null});
  assert.deepEqual(stock.deficits().map(row => `${row.profileKey}/${row.key}:${row.need}`), [`${GUN}/b:3`, `${GUN}/c:3`, `${CAB}/d:2`, `${GUN}/a:1`]);
  assert.equal(stock.next().key, 'b');
  assert.equal(stock.wants(), true);
  // The most needed first (b, then c); once needs are equal the entry served longest ago goes first (d before b, a before the rest).
  const order = [];
  for (const line of ['alpha one two', 'bravo three four', 'charlie five six', 'delta seven eight', 'echo nine ten', 'foxtrot eleven twelve', 'golf thirteen fourteen', 'hotel fifteen sixteen', 'india seventeen eighteen']) {
    replies.push(line);
    const result = await pump({});
    order.push(`${result.profileKey === GUN ? 'g' : 'c'}/${result.key}`);
    clock.advance(STOCK_PACING.minGapMs + 1);
  }
  assert.deepEqual(order, ['g/b', 'g/c', 'c/d', 'g/b', 'g/c', 'g/a', 'c/d', 'g/b', 'g/c']);
  // Every entry reached `want` and nothing more was asked for.
  assert.equal(stock.next(), null);
  assert.equal(stock.wants(), false);
  assert.equal(stock.status().entries.every(row => row.ready === row.want), true);
  // Three entries with the same need are each served once before any is served twice.
  const second = setup();
  second.stock.configure(GUN, [entry('x'), entry('y'), entry('z')], {mode: null});
  const served = [];
  for (const line of ['one zero', 'two alpha', 'three beta']) {
    second.replies.push(line);
    served.push((await second.pump()).key);
    second.clock.advance(STOCK_PACING.minGapMs + 1);
  }
  assert.deepEqual(served, ['x', 'y', 'z'], 'round robin, not the first entry three times');
});

test('configure: a changed rev, a removed entry and a changed purpose discard the lines; want, ttl and blocks do not', async () => {
  const {stock, fill} = setup();
  stock.configure(GUN, [entry('kill'), entry('end', {text: 'The fight is over'})], {mode: 'killer'});
  await fill(['first kill line', 'second kill line', 'wrapping up now', 'fight over, finally']);
  assert.deepEqual(stock.status().entries.map(row => row.ready), [2, 2]);
  // A bigger want, a new ttl and new blocks keep the lines.
  stock.configure(GUN, [entry('kill', {want: 4, ttl: 200, blocks: [{key: 'k', text: 't', tier: 'world'}]}), entry('end', {text: 'The fight is over'})], {mode: 'killer'});
  assert.deepEqual(stock.status().entries.map(row => row.ready), [2, 2]);
  assert.equal(stock.deficits()[0].key, 'kill', 'it now wants four');
  // A new rev drops that entry's lines only.
  assert.equal(stock.configure(GUN, [entry('kill', {rev: 2, want: 4}), entry('end', {text: 'The fight is over'})], {mode: 'killer'}), true);
  assert.deepEqual(stock.status().entries.map(row => [row.key, row.ready]), [['kill', 0], ['end', 2]]);
  // The same rev with other facts (a restarted game counter) is also a different moment.
  await stock.pump({generate: async () => 'a new kill line', now: () => 1_000_000 + 10_000});
  assert.equal(stock.status().entries[0].ready, 1);
  stock.configure(GUN, [entry('kill', {rev: 2, want: 4, facts: {enemies: 3}}), entry('end', {text: 'The fight is over'})], {mode: 'killer'});
  assert.equal(stock.status().entries[0].ready, 0);
  // A removed entry is gone with its lines; an empty list removes the speaker.
  stock.configure(GUN, [entry('kill', {rev: 2, want: 4, facts: {enemies: 3}})], {mode: 'killer'});
  assert.deepEqual(stock.status().entries.map(row => row.key), ['kill']);
  assert.equal(stock.configure(GUN, [], {mode: 'killer'}), true);
  assert.equal(stock.size, 0);
  assert.equal(stock.configure(GUN, [], {mode: 'killer'}), false);
  assert.ok(stock.status().discarded >= 5);
});

test('mode: lines written for another mode are discarded, and take refuses a different mode', async () => {
  const {stock, fill, clock} = setup();
  stock.configure(GUN, [entry('kill', {want: 1})], {mode: 'killer'});
  await fill(['cold and clinical']);
  assert.equal(stock.take(GUN, 'kill', {mode: 'puppy', facts: {fight: {kills: 1}}}), null, 'the caller is in another mode');
  assert.equal(stock.status().entries[0].ready, 1, 'the line is kept for the mode it was written for');
  assert.equal(stock.configure(GUN, [entry('kill', {want: 1})], {mode: 'puppy'}), true);
  assert.equal(stock.status().entries[0].ready, 0, 'the mode changed');
  assert.equal(stock.take(GUN, 'kill', {mode: 'killer'}), null);
  // A line still being written when the mode switches is thrown away instead of stocked.
  const result = await stock.pump({now: () => clock.now, generate: async () => { stock.configure(GUN, [entry('kill', {want: 1})], {mode: 'killer'}); return 'for the old mode'; }});
  assert.equal(result.status, 'discarded');
  assert.equal(stock.status().entries[0].ready, 0);
  // The same for an entry whose rev changed while the model wrote.
  clock.advance(5000);
  const raced = await stock.pump({now: () => clock.now, generate: async () => { stock.configure(GUN, [entry('kill', {want: 1, rev: 9})], {mode: 'killer'}); return 'for the old rev'; }});
  assert.equal(raced.status, 'discarded');
  // With the mode given by the entry's speaker: a take without a mode uses the speaker's.
  clock.advance(5000);
  await stock.pump({now: () => clock.now, generate: async () => 'killer line now'});
  assert.equal(stock.take(GUN, 'kill', {facts: {}}), 'killer line now');
});

test('ttl: a stale line is dropped when looked at, counted, and the entry wants a new one', async () => {
  const {stock, fill, clock} = setup();
  stock.configure(GUN, [entry('kill', {want: 1, ttl: 30, slots: []})], {mode: null});
  await fill(['quick kill coming']);
  assert.equal(stock.deficits().length, 0);
  clock.advance(27_000);
  assert.equal(stock.deficits().length, 0, 'still fresh (the line is 28 s old)');
  clock.advance(3_000);
  assert.equal(stock.deficits().length, 1, 'older than 30 s: stale, so a line is wanted again');
  assert.equal(stock.status().stale, 1);
  assert.equal(stock.take(GUN, 'kill', {}), null);
  // take looks too.
  await fill(['another quick kill']);
  clock.advance(31_000);
  assert.equal(stock.take(GUN, 'kill', {}), null);
  assert.equal(stock.status().stale, 2);
  assert.equal(stock.status().taken, 0);
});

test('take: slots are filled from the facts, the oldest usable line goes first, and an unfillable line is discarded', async () => {
  const {stock, fill, clock} = setup();
  stock.configure(GUN, [entry('kill', {want: 3, slots: ['fight.kills', 'fight.headshots']})], {mode: null});
  await fill(['Number {fight.headshots} headshots, boss.', 'Plain line with no number at all.', '{fight.kills} down, more to go.']);
  const facts = {fight: {kills: 5}};
  assert.equal(stock.take(GUN, 'kill', {facts}), 'Plain line with no number at all.', 'the first line cannot be filled (no headshots fact): discarded, the next is used');
  assert.equal(stock.status().discarded, 1);
  assert.equal(stock.take(GUN, 'kill', {facts}), '5 down, more to go.');
  assert.equal(stock.take(GUN, 'kill', {facts}), null);
  // Without any fact the slotless line still works.
  stock.configure(GUN, [entry('kill', {want: 1, slots: []})], {mode: null});
  await fill(['No slots needed here']);
  assert.equal(stock.take(GUN, 'kill', {}), 'No slots needed here');
  assert.equal(clock.now > 0, true);
});

test('validation: an empty line, an unknown slot, a stray brace and a near-duplicate are rejected and counted', async () => {
  const {stock, fill, recent} = setup({recent: ['Two down, boss, plenty more where that came from.']});
  stock.configure(GUN, [entry('kill', {want: 3, slots: ['fight.kills']})], {mode: null});
  const results = await fill(['', '   ', 'Only {fight.deaths} left.', 'Mind the {brace', 'brace } here', '{fight.kills} down, boss, plenty more where that came from',
    'A different line entirely, {fight.kills} so far.']);
  assert.deepEqual(results.map(result => result.reason ?? result.status), ['empty', 'empty', 'slot', 'slot', 'slot', 'duplicate', 'stocked']);
  assert.equal(stock.status().rejected, 6);
  assert.deepEqual(stock.status().rejects, {empty: 2, slot: 3, duplicate: 1, surplus: 0, total: 6});
  assert.equal(stock.status().generated, 1);
  // Against other lines stocked for the same speaker, also under another key.
  stock.configure(GUN, [entry('kill', {want: 3, slots: ['fight.kills']}), entry('end', {want: 2, slots: ['fight.kills']})], {mode: null});
  const more = await fill(['A different line entirely, {fight.kills} so far, again.', 'The fight is done, quiet at last.', 'The fight is done, quiet at last.']);
  assert.deepEqual(more.map(result => result.reason ?? result.status), ['duplicate', 'stocked', 'duplicate']);
  assert.notEqual(more[0].key, more[1].key, 'the duplicate was caught across keys');
  assert.deepEqual(recent.length, 1);
  // An object with text works as a reply, anything else is empty.
  const objectReply = await stock.pump({now: () => 1_000_000 + 600_000, generate: async () => ({text: 'Fresh words here for a change.'})});
  assert.equal(objectReply.status, 'stocked');
  const none = await stock.pump({now: () => 1_000_000 + 700_000, generate: async () => null});
  assert.equal(none.reason, 'empty');
});

test('avoid: the generator is shown every unused prepared line of that speaker, across keys', async () => {
  const {stock, fill, calls} = setup();
  stock.configure(GUN, [entry('a', {slots: []}), entry('b', {slots: []})], {mode: null});
  stock.configure(CAB, [entry('c', {speaker: 'voice', slots: []})], {mode: null});
  const lines = ['alpha line here', 'bravo different words', 'charlie something else', 'delta other text', 'echo yet more'];
  const results = await fill(lines);
  const stocked = {};
  results.forEach((result, index) => {
    assert.equal(result.status, 'stocked');
    assert.deepEqual([...calls[index].avoid].sort(), [...(stocked[result.profileKey] ?? [])].sort(), `call ${index}: what its speaker already had ready`);
    (stocked[result.profileKey] ??= []).push(lines[index]);
  });
  assert.equal(Object.keys(stocked).length, 2, 'both speakers were served');
});

test('pacing: never while busy, not twice within 1.2 s, 20 a minute at most, and 20 s of back-off after a failure', async () => {
  const {stock, clock, replies, generate, calls} = setup();
  const line = index => `generated line number ${index} about topic${index}`;
  stock.configure(GUN, [entry('a', {want: 4, slots: []}), entry('b', {want: 4, slots: []}), entry('c', {want: 4, slots: []}), entry('d', {want: 4, slots: []}), entry('e', {want: 4, slots: []})], {mode: null});
  // Busy: nothing starts, nothing is asked.
  assert.equal((await stock.pump({generate, now: () => clock.now, busy: () => true})).reason, 'busy');
  assert.equal(calls.length, 0);
  // The minimum gap between two generations.
  replies.push(line(1), line(2));
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'stocked');
  clock.advance(1000);
  assert.equal((await stock.pump({generate, now: () => clock.now})).reason, 'gap');
  clock.advance(250);
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'stocked');
  assert.equal(calls.length, 2);
  // A failure backs off for 20 s, whatever else is wanted.
  clock.advance(2000);
  replies.push(new Error('503'));
  const failed = await stock.pump({generate, now: () => clock.now});
  assert.deepEqual({status: failed.status, reason: failed.reason}, {status: 'failed', reason: '503'});
  clock.advance(19_000);
  assert.equal((await stock.pump({generate, now: () => clock.now})).reason, 'backoff');
  clock.advance(1_100);
  replies.push(line(3));
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'stocked');
  assert.equal(stock.status().failed, 1);
  // An aborted generation (a turn needed the machine) is not a fault: no back-off.
  clock.advance(2000);
  const abort = Object.assign(Error('cancelled'), {name: 'AbortError'});
  replies.push(abort);
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'aborted');
  clock.advance(1300);
  replies.push(line(4));
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'stocked');
  assert.equal(stock.status().aborted, 1);
});

test('pacing: at most 20 generations a minute, then it resumes', async () => {
  const {stock, clock, replies, generate} = setup();
  stock.configure(GUN, Array.from({length: 12}, (_, index) => entry(`key${index}`, {want: 4, slots: []})), {mode: null});
  let made = 0, capped = 0;
  // One attempt every 1.3 s for 40 s asks for about 30 lines; the cap lets 20 through inside any minute.
  for (let second = 0; second < 40; second += 1.3) {
    replies.push(`unique sentence ${made} topic${made}x about subject${made}y`);
    const result = await stock.pump({generate, now: () => clock.now});
    if (result.status === 'stocked') made++;
    if (result.reason === 'rate') { capped++; replies.pop(); }
    clock.advance(1300);
  }
  assert.equal(made, 20);
  assert.ok(capped > 0, 'the cap stopped some attempts');
  clock.advance(60_000);
  replies.push('after the minute, fresh words again');
  assert.equal((await stock.pump({generate, now: () => clock.now})).status, 'stocked');
});

test('pump: no route passes that speaker over, an unwanted state does nothing, and a missing generator is harmless', async () => {
  const {stock, clock, replies, generate, calls} = setup();
  assert.equal((await stock.pump({generate, now: () => clock.now})).reason, 'idle');
  assert.equal(calls.length, 0);
  stock.configure(GUN, [entry('a', {slots: []})], {mode: null});
  stock.configure(CAB, [entry('b', {speaker: 'voice', slots: []})], {mode: null});
  replies.push('only the cab speaks now');
  const result = await stock.pump({generate, now: () => clock.now, route: profileKey => profileKey === CAB ? 'mistral' : null});
  assert.equal(result.profileKey, CAB);
  clock.advance(2000);
  assert.equal((await stock.pump({generate, now: () => clock.now, route: () => null})).reason, 'nothing-to-write');
  assert.equal((await stock.pump({now: () => clock.now})).reason, 'no-generator');
  // One generation at a time.
  clock.advance(2000);
  let release;
  replies.push(() => new Promise(resolve => { release = resolve; }));
  const first = stock.pump({generate: call => generate(call).then(value => value), now: () => clock.now});
  assert.equal((await stock.pump({generate, now: () => clock.now})).reason, 'in-flight');
  release('a long awaited line here');
  assert.equal((await first).status, 'stocked');
});

test('surplus: a line that arrives when the entry already has want lines is rejected', async () => {
  const {stock, clock} = setup();
  stock.configure(GUN, [entry('a', {want: 1, slots: []})], {mode: null});
  const result = await stock.pump({now: () => clock.now, generate: async () => {
    // A second writer stocks the entry while this model call is out.
    stock.speakers.get(GUN).entries.get('a').lines.push({text: 'someone else was quicker', at: clock.now, mode: null, rev: 1});
    return 'too late to matter';
  }});
  assert.equal(result.reason, 'surplus');
  assert.equal(stock.status().entries[0].ready, 1);
});

test('the clock and the recent lines are injectable, and now may be a number', async () => {
  let wall = 5000;
  const stock = new AddonStock({now: () => wall, recent: () => ['The same joke again, and again.']});
  stock.configure(GUN, [entry('a', {want: 1, ttl: 10, slots: []})], {mode: null});
  const result = await stock.pump({generate: async () => 'The same joke again, and again!', now: 5000});
  assert.equal(result.reason, 'duplicate', 'recent lines come from the injected source');
  const ok = await stock.pump({generate: async () => 'A new joke at last, finally.', now: 7000});
  assert.equal(ok.status, 'stocked');
  assert.equal(stock.take(GUN, 'a', {now: 7000 + 11_000}), null, 'ttl measured on the given time');
  assert.equal(wall, 5000);
});

// ---- The host: parsing the state file, configure from observeState, no timers without stock ---------------------------------------

const manifest = () => validateManifest({schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'},
  speakers: [{id: 'gun', name: 'Skippy', persona: {backstory: 'A smart pistol.'}, defaultMode: 'puppy',
    modes: {killer: {name: 'Killer', style: 'Cold.'}, puppy: {name: 'Puppy', style: 'Sweet.'}}}]}, tmpdir());
const row = (extra = {}) => ({speaker: 'gun', key: 'kill', text: 'V is about to kill another enemy', facts: {enemies: 4}, maxWords: 8, want: 3, ttl: 60,
  slots: ['fight.kills'], rev: 4, blocks: [{key: 'mode', text: 'Puppy mode.', tier: 'world'}], ...extra});
const stateFile = (stock, extra = {}) => JSON.stringify({version: 1, updated: 10, addons: {skippy: {stock, ...extra}}});

test('parseAddonState keeps a validated stock array and drops bad rows', () => {
  const parsed = parseAddonState(stateFile([row()])).addons.skippy.stock;
  assert.deepEqual(parsed, [row({facts: {enemies: 4}})]);
  assert.deepEqual(parseAddonState(stateFile(undefined)).addons.skippy.stock, []);
  const bad = [
    row({speaker: 'Not Valid'}), row({speaker: 7}), row({key: 'bad key'}), row({key: ''}), row({key: 'k'.repeat(49)}),
    row({text: ''}), row({text: '   '}), row({text: 42}), row({rev: 'x'}), row({rev: -1}), row({rev: 1.5}), row({rev: undefined}),
    row({facts: 'nope'}), row({facts: {blob: 'x'.repeat(200), more: Array.from({length: 24}, () => 'y'.repeat(240))}}),
    row({slots: ['fight kills']}), row({slots: [3]}), row({slots: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']}), row({slots: 'fight.kills'}), row({slots: {a: 'b'}}),
    row({slots: ['x'.repeat(49)]}), null, 'row', [],
  ];
  assert.deepEqual(parseAddonState(stateFile(bad)).addons.skippy.stock, []);
  // Numbers are clamped, defaults fill in, a long text is cut, blocks follow the 4 / 3000 limits, duplicates are dropped.
  const [clamped] = parseAddonState(stateFile([row({maxWords: 2, want: 99, ttl: 1, text: 'x'.repeat(700), slots: ['a', 'a'], facts: undefined,
    blocks: [1, 2, 3, 4, 5].map(index => ({key: `b${index}`, text: 't'.repeat(900), tier: 'bogus'}))})])).addons.skippy.stock;
  assert.deepEqual([clamped.maxWords, clamped.want, clamped.ttl, clamped.text.length], [3, 4, 10, 600]);
  assert.deepEqual(clamped.slots, ['a']);
  assert.equal(clamped.facts, undefined);
  assert.deepEqual(clamped.blocks.map(block => block.key), ['b1', 'b2', 'b3'], '3000 characters allow three blocks of 900');
  assert.equal(clamped.blocks[0].tier, 'world');
  const [defaults] = parseAddonState(stateFile([{speaker: 'gun', key: 'kill', text: 'x', rev: 0, slots: {}}])).addons.skippy.stock;
  assert.deepEqual([defaults.maxWords, defaults.want, defaults.ttl, defaults.slots, defaults.blocks], [10, 2, 90, [], []]);
  const dup = parseAddonState(stateFile([row(), row({text: 'other', rev: 9})])).addons.skippy.stock;
  assert.equal(dup.length, 1);
  assert.equal(dup[0].rev, 4, 'the first row of a key wins');
  const many = Array.from({length: 20}, (_, index) => row({key: `k${index}`}));
  assert.equal(parseAddonState(stateFile(many)).addons.skippy.stock.length, ADDON_LIMITS.stockKeys, 'at most 12 keys per speaker');
});

test('parseAddonInput keeps stock: true only', () => {
  const base = {id: 'skippy', speaker: 'gun', event: 'kill'};
  assert.equal(parseAddonInput({...base, stock: true}).stock, true);
  for (const stock of [false, 1, 'true', null, {}]) assert.equal('stock' in parseAddonInput({...base, stock}), false, JSON.stringify(stock));
  assert.equal('stock' in parseAddonInput(base), false);
  // The block rules are unchanged by sharing the cleaner.
  const blocks = parseAddonInput({...base, blocks: [{key: 'a', text: 'one', tier: 'volatile'}, {key: 'bad key', text: 'x'}, {key: 'b', text: ''}]}).blocks;
  assert.deepEqual(blocks, [{key: 'a', text: 'one', tier: 'volatile'}]);
});

test('observeState configures the stock of each speaker with its current mode, then tells the bridge', () => {
  const host = new AddonHost({addons: [manifest()], startedAt: 0});
  assert.ok(host.stock instanceof AddonStock);
  const calls = [];
  host.onStock = () => calls.push(host.stock.size);
  host.observeState(stateFile([row(), row({key: 'end', text: 'The fight is over', rev: 1})], {modes: {gun: 'killer'}}));
  assert.deepEqual(calls, [2]);
  assert.deepEqual(host.stock.status().entries.map(item => [item.profileKey, item.key, item.rev]), [[GUN, 'kill', 4], [GUN, 'end', 1]]);
  assert.equal(host.stock.speakers.get(GUN).mode, 'killer');
  // Read again unchanged: still told (the bridge decides), nothing is discarded or duplicated.
  host.observeState(stateFile([row(), row({key: 'end', text: 'The fight is over', rev: 1})], {modes: {gun: 'killer'}}));
  assert.equal(host.stock.size, 2);
  // A mode switch in the state file empties the prepared lines; a lost row removes its entry.
  host.stock.speakers.get(GUN).entries.get('kill').lines.push({text: 'a prepared line', at: Date.now(), mode: 'killer', rev: 4});
  host.observeState(stateFile([row()], {modes: {gun: 'puppy'}}));
  assert.equal(host.stock.speakers.get(GUN).mode, 'puppy');
  assert.deepEqual(host.stock.status().entries.map(item => [item.key, item.ready]), [['kill', 0]]);
  // The file without the add-on (the game reset) clears everything and tells the bridge once more, then goes quiet.
  calls.length = 0;
  host.observeState(JSON.stringify({version: 1, updated: 10, addons: {}}));
  assert.equal(host.stock.size, 0);
  assert.deepEqual(calls, [0]);
  host.observeState(JSON.stringify({version: 1, updated: 10, addons: {}}));
  assert.deepEqual(calls, [0], 'no stock, no callback');
  // A file from an earlier session is not this session's stock.
  const late = new AddonHost({addons: [manifest()], startedAt: 1_000_000});
  late.observeState(stateFile([row()]));
  assert.equal(late.stock.size, 0);
});

test('stocked lines enter the speaker recent lines like any other, and the host passes them to the duplicate check', async () => {
  const host = new AddonHost({addons: [manifest()], startedAt: 0});
  host.observeState(stateFile([row({slots: []})]));
  const input = {profileKey: GUN, reaction: {kind: 'addon'}, addon: {id: 'skippy', speaker: 'gun', event: 'kill', stock: true}};
  host.afterReply(input, 'One down, boss. Many to go.');
  const result = await host.stock.pump({now: () => Date.now(), generate: async () => 'One down, boss. Many to go!'});
  assert.equal(result.reason, 'duplicate', 'AddonHost.recentLines feeds the stock');
});

test('without stock entries the host creates no objects and no timers; without add-ons there is no stock at all', () => {
  assert.equal(new AddonHost().stock, null);
  assert.equal(new AddonHost({addons: []}).stock, null);
  const timers = [];
  const real = {setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout};
  globalThis.setInterval = (...args) => { timers.push('interval'); return real.setInterval(...args); };
  globalThis.setTimeout = (...args) => { timers.push('timeout'); return real.setTimeout(...args); };
  try {
    const host = new AddonHost({addons: [manifest()], startedAt: 0});
    let told = 0;
    host.onStock = () => { told++; };
    host.observeState(JSON.stringify({version: 1, updated: 10, addons: {skippy: {modes: {gun: 'killer'}, companionContext: []}}}));
    host.observeState('');
    host.observeState(stateFile([]));
    assert.equal(host.stock.size, 0);
    assert.equal(host.stock.speakers.size, 0, 'no per-speaker objects');
    assert.equal(told, 0, 'the bridge is never called back');
    assert.deepEqual(timers, [], 'no timer of any kind');
    assert.equal(host.stock.status().entries.length, 0);
  } finally {
    globalThis.setInterval = real.setInterval;
    globalThis.setTimeout = real.setTimeout;
  }
});

test('the stock pump in the bridge is wired behind the add-on host and the busy check, and never on the local AI', async () => {
  const {readFileSync} = await import('node:fs');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const addonStock = addonHost\.stock;/);
  assert.match(bridge, /if \(addonStock\) addonHost\.onStock = stockWake;/);
  assert.match(bridge, /busy: \(\) => stopped \|\| voiceBoundaryBusy\(\)/);
  assert.match(bridge, /return route === 'mistral' \? route : null;/);
  assert.match(bridge, /model: 'stock', finishReason: 'stop', transport: 'realtime'/);
  assert.match(bridge, /clock\.mark\('stock'\)/);
  // The take comes before the model call, and the duplicate review and the voice still follow it.
  const turn = bridge.slice(bridge.indexOf('async function runAddonTurn'), bridge.indexOf('async function runInput'));
  assert.ok(turn.indexOf('addonStock.take(') < turn.indexOf('host.reply(config'));
  assert.ok(turn.indexOf('host.reply(config') < turn.indexOf('addonHost.review(input, reply.text)'));
  assert.ok(turn.indexOf('addonHost.review(input, reply.text)') < turn.indexOf('synthesizeReply(input, reply'));
  assert.match(turn, /addonHost\.afterReply\(input, result\.text\)/);
});
