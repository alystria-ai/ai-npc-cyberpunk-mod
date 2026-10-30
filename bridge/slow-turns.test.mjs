// Slow-turn error reports (bridge/slow-turns.mjs, kind `slow-turn` in docs/ERROR_REPORTS.md). Temp folders and a fake clock only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KNOWLEDGE_PARTS_MS, KNOWLEDGE_PART_NAMES, SLOW_TURNS, SlowTurnWatch, knowledgeParts} from './slow-turns.mjs';
import {TurnClock} from './turn-clock.mjs';
import {ErrorEvents, cleanSlow, queueRecord, readQueue} from './error-events.mjs';
import {ErrorReporter, buildErrorPayload} from './error-reports.mjs';
import {SIGNING_SECRET} from '../auth-backend/testkit/harness.mjs';

const START = Date.UTC(2026, 9, 20, 10, 0, 0);
const INSTALL = '3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b';

/** A turn whose first sound came `soundMs` after the bridge read the request. */
const turn = (soundMs, details = {}) => ({soundMs, details,
  snapshot: {marks: {received: 0, knowledge: 30, llmSent: 90, firstToken: soundMs - 900, firstPcm: soundMs - 400, published: soundMs - 200, playbackObserved: soundMs},
    ...(details.stalls ? {stalls: [{at: 10, ms: 120}, {at: 40, ms: 260}]} : {})}});

function watchWith(extra = {}) {
  const sent = [];
  let at = START;
  const watch = new SlowTurnWatch({onSlow: data => sent.push(data), now: () => at, turnContext: () => ({provider: 'local', voice: 'pocket'}),
    reportContext: () => ({freeVideoMemoryMiB: 2048.4, background: {warmConnections: 2, connectingConnections: 0, 'bad key!': 5}}), ...extra});
  return {watch, sent, advance: ms => { at += ms; }};
}

test('the defaults are the agreed ones, as constants', () => {
  assert.equal(SLOW_TURNS.slowMs, 10_000);
  assert.equal(SLOW_TURNS.extremeMs, 30_000);
  assert.equal(SLOW_TURNS.windowTurns, 5);
  assert.equal(SLOW_TURNS.slowInWindow, 3);
  assert.throws(() => { SLOW_TURNS.slowMs = 1; });
});

test('three slow turns of the last five send one report; two do not; a fast turn between does not reset a window that still holds three', () => {
  const {watch, sent, advance} = watchWith();
  for (const ms of [2200, 3100, 16_000, 2600, 17_000]) { advance(60_000); watch.observe(turn(ms)); }
  assert.equal(sent.length, 0, 'two slow turns in five is a hiccup');
  advance(60_000);
  watch.observe(turn(21_000));
  assert.equal(sent.length, 1, 'the sixth turn makes three of the last five (16, 17 and 21 s are slow)');
  const [data] = sent;
  assert.equal(data.reason, 'slow-in-window');
  assert.equal(data.turns, 6);
  assert.equal(data.minutes, 6);
  assert.deepEqual(data.recentSoundMs, [2200, 3100, 16_000, 2600, 17_000, 21_000]);
  assert.deepEqual(data.slow.map(item => item.soundMs), [16_000, 17_000, 21_000], 'the slow turns carry their stage timings');
  assert.deepEqual(data.first.map(item => item.soundMs), [2200, 3100], 'the first fast turns of the session are there for the comparison');
  assert.ok(data.slow.every(item => item.marks.received === 0 && item.marks.playbackObserved === item.soundMs));
  assert.equal(data.provider, 'local');
  assert.equal(data.voice, 'pocket');
  assert.equal(data.freeVideoMemoryMiB, 2048);
  assert.deepEqual(data.background, {warmConnections: 2, connectingConnections: 0}, 'only well-formed counts');
  assert.deepEqual(data.thresholds, {windowTurns: 5, slowInWindow: 3, slowMs: 10_000, extremeMs: 30_000});
  for (let index = 0; index < 5; index++) watch.observe(turn(40_000));
  assert.equal(sent.length, 1, 'one report per run, however slow it gets');
});

test('one turn over 30 s sends a report at once; one at 25 s does not', () => {
  const {watch, sent} = watchWith();
  watch.observe(turn(25_000));
  assert.equal(sent.length, 0);
  watch.observe(turn(31_000));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reason, 'one-turn-over-extreme');
});

test('a failed turn, a turn in a paused game and the first turn after the model loaded never count toward the trigger', () => {
  const {watch, sent} = watchWith();
  watch.observe(turn(90_000, {failed: true}));
  watch.observe(turn(90_000, {gamePaused: true}));
  watch.observe(turn(90_000, {cold: true}));
  for (const ms of [20_000, 21_000]) watch.observe(turn(ms));
  assert.equal(sent.length, 0);
  watch.observe(turn(22_000));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].excluded, {failed: 1, paused: 1});
  assert.equal(sent[0].turns, 6, 'every finished turn is counted in the session');
  assert.ok(sent[0].first.some(item => item.cold === true && item.soundMs === 90_000), 'the cold start stays visible in the history');
  assert.ok(!sent[0].slow.some(item => item.cold), 'but it is not one of the slow turns that triggered');
});

test('the report carries provider, voice, model, prompt tokens, stalls and minutes in, per turn', () => {
  const {watch, sent, advance} = watchWith();
  advance(5 * 60_000);
  watch.observe(turn(3000, {provider: 'local', model: 'Qwen3-4B-Q4_K_M.gguf', promptTokens: 322, cachedTokens: 4579}));
  advance(10 * 60_000);
  watch.observe(turn(50_000, {provider: 'local', model: 'Qwen3-4B-Q4_K_M.gguf', promptTokens: 6100, cachedTokens: 0, stalls: true}));
  const [data] = sent;
  assert.deepEqual([data.first[0].n, data.first[0].atMin, data.first[0].promptTokens, data.first[0].cachedTokens, data.first[0].model], [1, 5, 322, 4579, 'Qwen3-4B-Q4_K_M.gguf']);
  const [slow] = data.slow;
  assert.deepEqual([slow.atMin, slow.promptTokens, slow.cachedTokens, slow.stalls], [15, 6100, 0, {count: 2, maxMs: 260}]);
  assert.equal(data.minutes, 15);
});

test('the clock path: a turn is judged once it has made its first sound and its run has ended, in either order, and only once', () => {
  const {watch, sent} = watchWith();
  const run = (order, soundMs) => {
    const clock = new TurnClock({origin: 1000, now: () => 1000 + soundMs});
    clock.mark('received', 1000);
    const ended = watch.track(clock);
    const sound = () => clock.mark('playbackObserved', 1000 + soundMs);
    if (order === 'sound-first') { sound(); ended(); } else { ended(); sound(); }
    ended();
    return clock;
  };
  run('sound-first', 46_000);
  assert.equal(sent.length, 1, 'sound then end');
  const {watch: second, sent: sentTwo} = watchWith();
  const clock = new TurnClock({origin: 0, now: () => 50_000});
  clock.mark('received', 0);
  const ended = second.track(clock);
  ended();
  assert.equal(sentTwo.length, 0, 'ended without a sound: not judged (a turn that never made a sound has no first sound to time)');
  clock.mark('playbackObserved', 50_000);
  assert.equal(sentTwo.length, 1, 'the native path observes the sound after the run has ended');
  clock.remark('playbackObserved', 60_000);
  assert.equal(sentTwo.length, 1);
});

test('a throwing context or sink never fails the turn', () => {
  const watch = new SlowTurnWatch({onSlow: () => { throw new Error('disk full'); }, turnContext: () => { throw new Error('x'); }, reportContext: () => { throw new Error('y'); }});
  assert.doesNotThrow(() => watch.observe(turn(60_000)));
  assert.doesNotThrow(() => watch.observe({soundMs: NaN}));
  assert.doesNotThrow(() => watch.observe());
  assert.doesNotThrow(() => watch.track({on() { throw new Error('z'); }, has: () => false, snapshot: () => ({marks: {}})}));
});

// ------------------------------------------------------------ the record and the report

async function folders() {
  const base = await mkdtemp(join(tmpdir(), 'slow-turns-'));
  const runtime = join(base, 'game', 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime'), state = join(base, 'state'), project = join(base, 'app');
  for (const folder of [runtime, state, project]) await mkdir(folder, {recursive: true});
  await writeFile(join(state, 'convai-install.json'), JSON.stringify({version: 1, installId: INSTALL}));
  return {base, runtime, state, project, game: join(base, 'game'), cleanup: () => rm(base, {recursive: true, force: true})};
}

const sample = () => {
  const {watch, sent} = watchWith();
  for (const ms of [2500, 2900, 3300]) watch.observe(turn(ms, {provider: 'local', model: 'Qwen3-4B-Q4_K_M.gguf', promptTokens: 300, cachedTokens: 4000}));
  for (const ms of [18_000, 25_000, 61_000]) watch.observe(turn(ms, {provider: 'local', model: 'Qwen3-4B-Q4_K_M.gguf', promptTokens: 5000, cachedTokens: 0}));
  return sent[0];
};

test('cleanSlow rebuilds the section from numbers and fixed names only: text cannot ride along', () => {
  const data = sample();
  const hostile = {...data, text: 'what the player said', reply: 'what V said', first: [{...data.first[0], text: 'secret words here', provider: 'hello there friend', model: 'C:\\Users\\Someone\\model.gguf',
    marks: {'say hello to V': 5, knowledge: 'a sentence', llmSent: 12.5}}], slow: 'not a list', background: {warmConnections: 'two'}};
  const clean = cleanSlow(hostile);
  const text = JSON.stringify(clean);
  assert.ok(!/player said|V said|secret words|hello|Someone|sentence/.test(text), text);
  assert.deepEqual(clean.first[0].marks, {llmSent: 13});
  assert.equal(clean.first[0].provider, undefined);
  assert.equal(clean.first[0].model, undefined);
  assert.deepEqual(clean.slow, []);
  assert.equal(cleanSlow(null), null);
  assert.equal(cleanSlow([]), null);
  assert.equal(queueRecord({kind: 'turn-failed', message: 'x y', slow: data}).slow, undefined, 'only a slow-turn record carries the section');
});

test('the recorder writes one slow-turn record, once per run, nothing while the setting is off', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.slowTurns(sample());
    events.slowTurns(sample());
    await new Promise(done => setTimeout(done, 100));
    const queue = await readQueue(f.state, {now: START});
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'slow-turn');
    assert.equal(queue[0].message, 'Replies are slow and stay slow');
    assert.equal(queue[0].slow.provider, 'local');
    assert.equal(queue[0].detail.provider, 'local');
    await rm(join(f.state, 'error-reports'), {recursive: true, force: true});
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false}));
    const off = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    off.slowTurns(sample());
    await new Promise(done => setTimeout(done, 100));
    assert.equal((await readQueue(f.state)).length, 0, 'with reports off nothing is recorded');
  } finally { await f.cleanup(); }
});

test('the payload holds the timings and the usual log tail, no text, and goes to the real handler once a day', async () => {
  const f = await folders();
  const {createErrorWorld} = await import('../auth-backend/testkit/errors-world.mjs');
  const {mockResponse} = await import('../auth-backend/testkit/harness.mjs');
  const world = createErrorWorld();
  try {
    await writeFile(join(f.state, 'bridge.stderr.log'), ['[LocalTurn] ok: first word 346 ms, 50 pieces, prompt 322 new + 4579 cached tokens | model x', 'player said: "turn left at the big red sign now"'].join('\n'));
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({conversationProvider: 'local', voiceProvider: 'pocket', localModel: 'auto', errorReportsNoticed: true}));
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => world.clock.now, defer: fn => fn()});
    events.slowTurns(sample());
    await new Promise(done => setTimeout(done, 100));
    const [record] = await readQueue(f.state, {now: world.clock.now});
    const {payload, body} = await buildErrorPayload({record, game: f.game, runtime: f.runtime, modRoot: join(f.runtime, '..'), stateDirectory: f.state, project: f.project,
      installId: INSTALL, secrets: [], graphics: () => [{name: 'Fake GPU', memoryMiB: 8192}], names: [], now: () => world.clock.now});
    assert.equal(payload.kind, 'slow-turn');
    assert.equal(payload.report.choices.provider, 'local');
    assert.equal(payload.report.choices.voice, 'pocket');
    assert.equal(payload.report.slow.slow.length, 3);
    assert.equal(payload.report.slow.slow[2].soundMs, 61_000);
    assert.equal(payload.report.slow.first[0].promptTokens, 300);
    assert.ok(payload.report.logs.some(item => item.source === 'bridge-stderr'), 'the usual log tail is there');
    assert.ok(!body.includes('turn left at the big red sign'), 'conversation text in a log line is removed');
    assert.ok(Buffer.byteLength(body) < 20_000);

    const fetchImpl = async (url, init) => {
      const response = mockResponse();
      await world.handler({method: init.method, headers: {...init.headers, 'x-vercel-forwarded-for': '198.51.100.24'}, body: init.body}, response);
      return new Response(response.text, {status: response.statusCode});
    };
    const reporter = new ErrorReporter({game: f.game, runtime: f.runtime, modRoot: join(f.runtime, '..'), stateDirectory: f.state, project: f.project, env: {}, fetchImpl,
      now: () => world.clock.now, graphics: () => [], names: [], setTimer: () => null, clearTimer: () => {}, setRepeat: () => null, clearRepeat: () => {},
      target: {url: 'https://backend.invalid/api/errors/report', secret: SIGNING_SECRET}});
    await reporter.flush();
    reporter.close();
    assert.equal((await readQueue(f.state, {now: world.clock.now})).length, 0, 'the unchanged backend accepts the new kind');
    const list = (await world.ask('/api/admin/errors')).json;
    assert.equal(list.signatures[0].kind, 'slow-turn');
    const fetched = (await world.ask(`/api/admin/errors?signature=${list.signatures[0].signature}&id=${list.signatures[0].ids[0]}`)).json;
    assert.equal(fetched.report.report.slow.slow[2].soundMs, 61_000);
    // A second slow-turn record the same day (another bridge run) is not sent again: one report per kind per day.
    const again = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => world.clock.now, defer: fn => fn()});
    again.slowTurns(sample());
    await new Promise(done => setTimeout(done, 100));
    const second = new ErrorReporter({game: f.game, runtime: f.runtime, modRoot: join(f.runtime, '..'), stateDirectory: f.state, project: f.project, env: {}, fetchImpl,
      now: () => world.clock.now, graphics: () => [], names: [], setTimer: () => null, clearTimer: () => {}, setRepeat: () => null, clearRepeat: () => {},
      target: {url: 'https://backend.invalid/api/errors/report', secret: SIGNING_SECRET}});
    await second.flush();
    second.close();
    assert.equal((await world.ask('/api/admin/errors')).json.signatures[0].reports, 1, 'the second one was dropped as the same signature the same day');
    assert.equal((await readFile(join(f.state, 'error-reports', 'sent.json'), 'utf8')).includes('"count":1'), true);
  } finally { await f.cleanup(); }
});

test('the bridge judges every turn from its clock, annotates failed and paused turns, and nothing here runs per frame or per chunk', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const ended = slowTurns\.track\(clock\),\s*silenceEnded = voiceSilence\.track\(clock\);\s*try \{ return await withClock\(clock, \(\) => run\(clock\)\); \} finally \{ ended\(\); silenceEnded\(\); \}/);
  assert.match(bridge, /onPaused: \(\) => turnClocks\.get\(input\.requestId\)\?\.annotate\(\{gamePaused: true\}\)/);
  assert.match(bridge, /turnClocks\.get\(input\?\.requestId\)\?\.annotate\(\{failed: true\}\)/);
  assert.match(bridge, /onSlow: data => errorEvents\.slowTurns\(data\)/);
  const host = await readFile(new URL('./text-provider-host.mjs', import.meta.url), 'utf8');
  assert.match(host, /currentClock\(\)\?\.annotate\(\{provider: route\.name/);
  assert.match(host, /if \(first\) currentClock\(\)\?\.annotate\(\{cold: true\}\)/);
  const speech = await readFile(new URL('./convai-continuous-speech.mjs', import.meta.url), 'utf8');
  assert.match(speech, /if \(value\.paused && !this\.pausedSeen\)/);
});

test('the local model watch (localFacts) rides in the report as numbers and flags only: where the model is, the free memory at the last look, the voice worker', async () => {
  const local = {watching: true, looks: 3, lastFreeMiB: 5200.4, returns: 1, dedicatedMiB: 90, sharedMiB: 4308, voice: {dedicatedMiB: 2400, sharedMiB: 12, spilled: false, at: 'text'}, note: 'free words'};
  const { watch, sent } = watchWith({reportContext: () => ({freeVideoMemoryMiB: 31419, local})});
  for (const ms of [18_000, 25_000, 61_000]) watch.observe(turn(ms, {provider: 'local'}));
  assert.deepEqual(sent[0].local, {watching: true, looks: 3, lastFreeMiB: 5200, returns: 1, dedicatedMiB: 90, sharedMiB: 4308, voice: {dedicatedMiB: 2400, sharedMiB: 12}});
  const clean = cleanSlow({...sent[0], local: {...sent[0].local, extra: 'a sentence', voice: {dedicatedMiB: 1, sharedMiB: 'two', spilled: true, text: 'x'}}});
  assert.deepEqual(clean.local, {watching: true, looks: 3, lastFreeMiB: 5200, returns: 1, dedicatedMiB: 90, sharedMiB: 4308, voice: {dedicatedMiB: 1, spilled: true}});
  assert.equal(cleanSlow({...sent[0], local: 'free words'}).local, undefined);
  const none = watchWith({reportContext: () => ({local: {}})});
  for (const ms of [18_000, 25_000, 61_000]) none.watch.observe(turn(ms));
  assert.equal(none.sent[0].local, undefined, 'nothing known: no group');
});

// Triage 2026-10-30 (installs fe801d, dde45e): a knowledge stage of 3.3 to 3.8 s on every turn. Over a second the turn's record also holds the time of each part.
test('knowledgeParts gives whole milliseconds under fixed names only when the stage is over a second, and nothing else rides along', () => {
  assert.equal(KNOWLEDGE_PARTS_MS, 1000);
  const parts = {totalMs: 3340.6, cancelMicrophoneMs: 2.4, beforePrepareMs: 6.1, prepareMs: 3331.9, setupMs: 1.2, liveMs: 0.3, ledgerMs: 3320.2, receiptsMs: 4.4, resolveMs: 5.5, attachMs: 0.4,
    text: 'what the player said', 'ledger path C:\\Users\\Someone': 9, bad: -5, weird: NaN};
  assert.deepEqual(knowledgeParts(parts), {totalMs: 3341, cancelMicrophoneMs: 2, beforePrepareMs: 6, prepareMs: 3332, setupMs: 1, liveMs: 0, ledgerMs: 3320, receiptsMs: 4, resolveMs: 6, attachMs: 0});
  assert.deepEqual(Object.keys(knowledgeParts(parts)), KNOWLEDGE_PART_NAMES.filter(name => name in parts));
  assert.equal(knowledgeParts({...parts, totalMs: 999}), undefined, 'a fast stage is not described');
  assert.equal(knowledgeParts({...parts, totalMs: 1000}), undefined, 'the limit itself is not over it');
  assert.equal(knowledgeParts({totalMs: 1500, ledgerMs: -1, liveMs: NaN}).ledgerMs, undefined);
  for (const nothing of [undefined, null, 'x', 5, {}, {ledgerMs: 5000}]) assert.equal(knowledgeParts(nothing), undefined);
});

test('a slow turn keeps the parts of its knowledge stage in the report, and a turn without them has no such field', async () => {
  const {watch, sent} = watchWith();
  const knowledgeParts_ = {totalMs: 3340, cancelMicrophoneMs: 2, beforePrepareMs: 6, prepareMs: 3332, ledgerMs: 3320, text: 'secret words', 'x y': 4};
  for (const ms of [12_000, 14_000, 16_000]) watch.observe(turn(ms, {provider: 'local', knowledgeParts: knowledgeParts_}));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slow[0].knowledgeParts, {totalMs: 3340, cancelMicrophoneMs: 2, beforePrepareMs: 6, prepareMs: 3332, ledgerMs: 3320});
  assert.ok(!JSON.stringify(sent[0]).includes('secret words'));
  const clean = cleanSlow(sent[0]);
  assert.deepEqual(clean.slow[0].knowledgeParts, {totalMs: 3340, cancelMicrophoneMs: 2, beforePrepareMs: 6, prepareMs: 3332, ledgerMs: 3320});
  assert.ok(!JSON.stringify(clean).includes('secret words'));
  // Hostile input is rebuilt: other names, text and non-numbers are dropped, numbers are bounded.
  const hostile = cleanSlow({...sent[0], slow: [{...sent[0].slow[0], knowledgeParts: {ledgerMs: 'a sentence', liveMs: 1e12, text: 'secret words', totalMs: 5}}]});
  assert.deepEqual(hostile.slow[0].knowledgeParts, {totalMs: 5, liveMs: 1e7});
  assert.ok(!JSON.stringify(hostile).includes('secret words'));
  const plain = watchWith();
  for (const ms of [12_000, 14_000, 16_000]) plain.watch.observe(turn(ms, {provider: 'local'}));
  assert.equal('knowledgeParts' in plain.sent[0].slow[0], false);
  assert.equal(cleanSlow(plain.sent[0]).slow[0].knowledgeParts, undefined);
});

test('the bridge records the parts only past the limit, from numbers it already measured', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{KNOWLEDGE_PARTS_MS, SlowTurnWatch, knowledgeParts\} from '\.\/slow-turns\.mjs';/);
  assert.match(bridge, /if \(stages\.knowledgePreparedMs > KNOWLEDGE_PARTS_MS\) \{\s*try \{\s*clock\.annotate\(\{knowledgeParts: knowledgeParts\(\{\.\.\.knowledgeTurn\.timings,/);
  const knowledge = await readFile(new URL('./player-knowledge.mjs', import.meta.url), 'utf8');
  assert.match(knowledge, /finishedAt - startedAt > KNOWLEDGE_PARTS_MS\s*\? \{prepareMs:/, 'the parts are put together only for a slow call');
});
