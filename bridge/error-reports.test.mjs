// Automatic error reports (bridge/error-events.mjs records, bridge/error-reports.mjs sends; docs/ERROR_REPORTS.md). Every test uses temp
// folders and a fake fetch: nothing here reaches the network or a real backend.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {PLANTED, plantedInstall, fakeInstall} from './support-report-fixture.mjs';
import {MistralError, newTrace} from './mistral-client.mjs';
import {ErrorEvents, authCauseDetail, emptyAnswerDetail, errorReportStatus, errorReportsEnabled, errorReportsEnabledSync, errorReportsMaySend, errorReportsSetting, errorSignature, eventFromError, frameKey, normaliseMessage, parseGameEvents, queueDirectory,
  readQueue, recordErrorEvent, recordErrorEventSync, reportableTurnFailure, stackFrames, QUEUE_MAX} from './error-events.mjs';
import {DAILY_LIMIT, ErrorReporter, MAX_BODY_BYTES, MAX_LOG_LINES, buildErrorPayload, hashInstall, luaErrorsIn, reportCleaner, reportTarget,
  withoutConversation} from './error-reports.mjs';
import {readBackendAddress} from './convai-credential.mjs';
import {CODE_LIST, codeListText, hashBytes, resetRuntimeIntegrityCache} from './runtime-integrity.mjs';
import {collectReport} from './support-report.mjs';
import {checkSignature} from '../auth-backend/api/_lib/crypto.js';
import {SIGNING_SECRET} from '../auth-backend/testkit/harness.mjs';

const INSTALL = '3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b';
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 19, 10, 0, 0);

async function folders() {
  const base = await mkdtemp(join(tmpdir(), 'error-reports-'));
  const game = join(base, 'game'), modRoot = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod');
  const runtime = join(modRoot, 'runtime'), state = join(base, 'state'), project = join(base, 'app');
  for (const folder of [runtime, state, project]) await mkdir(folder, {recursive: true});
  await writeFile(join(state, 'convai-install.json'), JSON.stringify({version: 1, installId: INSTALL}));
  // The in-game notice was shown (the game sets this flag in settings.json): nothing is sent before it. The tests of that gate change the file.
  await writeFile(join(runtime, 'settings.json'), JSON.stringify({errorReportsNoticed: true}));
  return {base, game, modRoot, runtime, state, project, cleanup: () => rm(base, {recursive: true, force: true})};
}

/** A fake backend: answers each request with the next status (default 200 stored) and checks the signature like the real one. */
function fakeBackend({statuses = [], clock} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body;
    const verdict = checkSignature({secret: SIGNING_SECRET, timestamp: init.headers['x-convai-timestamp'], signature: init.headers['x-convai-signature'],
      body, nowMs: clock ? clock.now : Date.now()});
    calls.push({url, body: JSON.parse(body), raw: body, verdict});
    const next = statuses.length ? statuses.shift() : 200;
    if (typeof next === 'function') return next(init);
    const answers = {200: {ok: true, stored: true, id: 'x'}, 404: {error: 'not_found'}, 429: {error: 'rate', retryAfterSeconds: 60},
      400: {error: 'bad_request'}, 401: {error: 'unauthorized'}, 503: {error: 'unavailable'}};
    return new Response(JSON.stringify(answers[next] ?? {}), {status: next});
  };
  return {calls, fetchImpl};
}

function reporterFor(f, backend, clock, extra = {}) {
  return new ErrorReporter({game: f.game, runtime: f.runtime, modRoot: f.modRoot, stateDirectory: f.state, project: f.project, env: {},
    fetchImpl: backend.fetchImpl, now: () => clock.now, graphics: () => [{name: 'Fake GPU 9000', memoryMiB: 8192}], names: ['PlantedPlayerName'],
    target: {url: 'https://backend.invalid/api/errors/report', secret: SIGNING_SECRET}, setTimer: () => null, clearTimer: () => {},
    setRepeat: () => null, clearRepeat: () => {}, ...extra});
}

// A distinct label for the n-th fault: the signature ignores digits, so letters (two of them past 26).
const faultLabel = index => `${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(index / 26)]}`;
const event = (message, kind = 'turn-failed') => ({kind, message, frame: 'realtime-client.mjs:120 connect'});

// ------------------------------------------------------------------ signatures

test('the same fault gives the same signature whatever paths, numbers, ids and spacing it carries; another kind or frame does not', () => {
  const a = errorSignature({kind: 'bridge-exception', message: "ENOENT: no such file, open 'C:\\Users\\Alice\\AppData\\x\\knowledge-42.json' after 1200 ms",
    frame: 'knowledge-service.mjs:88 KnowledgeService.load'});
  const b = errorSignature({kind: 'bridge-exception', message: "ENOENT:  no such file, open 'D:\\Games\\y\\knowledge-7.json' after 15 ms",
    frame: 'knowledge-service.mjs:91 KnowledgeService.load'});
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, errorSignature({kind: 'turn-failed', message: "ENOENT: no such file, open 'x.json' after 1 ms", frame: 'knowledge-service.mjs:88 KnowledgeService.load'}));
  assert.notEqual(a, errorSignature({kind: 'bridge-exception', message: "ENOENT: no such file, open 'x.json' after 1 ms", frame: 'other.mjs:1 run'}));
  assert.equal(normaliseMessage(`session ${PLANTED.userId} at 0xDEADBEEF01`), 'session <id> at <hex>');
  assert.equal(frameKey('init.lua:150'), 'init.lua');
  assert.equal(frameKey('exit code 3221225477'), 'exit code 3221225477', 'an exit code is part of a crash signature');
});

test('stack frames keep file names and functions only: no folders, no Node internals', () => {
  const error = new Error('boom');
  error.stack = ['Error: boom', '    at TokenSource.post (file:///C:/Users/PlantedPlayerName/app/bridge/convai-credential.mjs:197:28)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)', '    at C:\\Users\\PlantedPlayerName\\app\\bridge\\x.mjs:3:1'].join('\n');
  const built = eventFromError(error, 'bridge-exception');
  assert.deepEqual(built.stack, ['convai-credential.mjs:197 TokenSource.post', 'x.mjs:3']);
  assert.equal(built.frame, 'convai-credential.mjs:197 TokenSource.post');
  assert.ok(!JSON.stringify(built).includes('PlantedPlayerName'));
  assert.deepEqual(stackFrames('not a stack'), []);
});

// ------------------------------------------------------------------ the queue

test('a record per signature: repeats raise its count, the queue holds at most twenty, expired records are dropped', async () => {
  const f = await folders();
  try {
    for (let index = 0; index < 3; index++) await recordErrorEvent(f.state, event('Convai timed out after 30000 ms'), {now: START + index});
    let queue = await readQueue(f.state, {now: START + 10});
    assert.equal(queue.length, 1);
    assert.equal(queue[0].count, 3);
    assert.equal(queue[0].firstAt, START);
    for (let index = 0; index < QUEUE_MAX + 5; index++) await recordErrorEvent(f.state, event(`distinct fault ${faultLabel(index)}`), {now: START});
    assert.equal((await readQueue(f.state, {now: START})).length, QUEUE_MAX);
    recordErrorEventSync(f.state, event('one more after the cap'), {now: START});
    assert.equal((await readQueue(f.state, {now: START})).length, QUEUE_MAX);
    queue = await readQueue(f.state, {now: START + 8 * DAY});
    assert.equal(queue.length, 0, 'a week-old record is dropped');
    assert.deepEqual((await readdir(queueDirectory(f.state))).filter(name => name.endsWith('.json')), []);
  } finally { await f.cleanup(); }
});

test('an uncaught exception and an unhandled rejection are recorded as the process ends, and it still ends as before', async () => {
  const f = await folders();
  try {
    const module = new URL('./error-events.mjs', import.meta.url).href;
    for (const [kind, line] of [['bridge-exception', "setTimeout(() => { throw new Error('planted crash at startup'); }, 1);"],
      ['bridge-rejection', "Promise.reject(new TypeError('planted rejection'));"]]) {
      const script = `import {installCrashCapture} from ${JSON.stringify(module)};
installCrashCapture({stateDirectory: ${JSON.stringify(f.state)}, runtime: ${JSON.stringify(f.runtime)}});
${line}`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20000});
      assert.notEqual(result.status, 0, 'the process still ends with a failure');
      const queue = await readQueue(f.state);
      const record = queue.find(item => item.kind === kind);
      assert.ok(record, `${kind} recorded: ${JSON.stringify(queue)}`);
      assert.match(record.message, /planted (?:crash at startup|rejection)/);
    }
    // With the setting off nothing is written.
    await rm(queueDirectory(f.state), {recursive: true, force: true});
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false}));
    const script = `import {installCrashCapture} from ${JSON.stringify(module)};
installCrashCapture({stateDirectory: ${JSON.stringify(f.state)}, runtime: ${JSON.stringify(f.runtime)}});
throw new Error('not recorded');`;
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20000});
    assert.equal((await readQueue(f.state)).length, 0);
  } finally { await f.cleanup(); }
});

test('a failed turn is reported only when it is not the player\'s own doing', () => {
  const timeout = new Error('Convai did not answer: timed out after 30 s');
  assert.equal(reportableTurnFailure(timeout), true);
  assert.equal(reportableTurnFailure(new Error('Local AI server stopped [local:network]'), {errorCode: 'local-failed'}), true);
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-fallback', localReason: 'start-failed'}), true, 'a Local AI server that never answers');
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-unavailable', localReason: 'start-failed'}), true, 'the code a start that failed carries now: no hand-over to a cloud provider');
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-unavailable', localReason: 'crashed'}), true);
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-no-memory', localReason: 'low-memory'}), false, 'not enough graphics memory is the player\'s setup');
  for (const errorCode of ['mistral-key', 'custom-credits', 'quota-own', 'quota-shared', 'daily-limit', 'key-rejected', 'custom-unreachable']) {
    assert.equal(reportableTurnFailure(new Error('x'), {errorCode}), false, errorCode);
  }
  for (const localReason of ['not-installed', 'low-memory', 'mature-off', 'no-gpu']) {
    assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-fallback', localReason}), false, localReason);
    assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-unavailable', localReason}), false, localReason);
  }
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-no-memory'}), false);
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'browser-failed'}), false, 'a browser that would not start is the player\'s own setup');
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-unavailable', localReason: 'crashed'}), true, 'a Local AI server that crashed');
  assert.equal(reportableTurnFailure(Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})), false);
  // The Convai connection closed while a turn was being set up (realtime-client.mjs cancelledTurn): cancelled, with or without the error's name surviving the trip from the page.
  assert.equal(reportableTurnFailure(Object.assign(new Error('Conversation cancelled'), {name: 'AbortError'})), false);
  assert.equal(reportableTurnFailure(new Error('Conversation cancelled')), false, 'the words alone say it');
  assert.equal(reportableTurnFailure(new Error('Conversation context update cancelled')), false);
  assert.equal(reportableTurnFailure(Object.assign(new Error('Daily conversation limit reached'), {name: 'TurnLimitError'})), false);
  assert.equal(reportableTurnFailure(new Error('Microphone device unavailable'), {microphone: true}), false);
  assert.equal(reportableTurnFailure(Object.assign(new Error('silent'), {code: 'MIC_SILENT'}), {microphone: true}), false);
  assert.equal(reportableTurnFailure(new Error('Convai connection closed'), {microphone: true}), true);
});

test('the game ending a talk is not a fault: V interrupting or the game pausing or loading is never reported', () => {
  // 2026-10-19 reports: "Continuous speech was stopped by the game" and "Continuous speech game lease expired" were 4 of the first 16.
  for (const message of ['Continuous speech was stopped by the game', 'Continuous speech game lease expired', 'Continuous speech owner changed']) {
    assert.equal(reportableTurnFailure(new Error(message)), false, message);
    assert.equal(reportableTurnFailure(new Error(message), {errorCode: 'local-failed'}), false, message + ' on the local AI');
    assert.equal(reportableTurnFailure(new Error(message), {microphone: true}), false, message + ' by voice');
  }
  // Other continuous speech failures are still faults.
  assert.equal(reportableTurnFailure(new Error('Continuous speech renderer failed')), true);
  assert.equal(reportableTurnFailure(new Error('Invalid continuous speech state')), true);
});

// The recorder's writes are asynchronous files: wait until the queue holds `count` records (a fixed sleep lost the race on a loaded machine).
async function untilQueued(f, count, limitMs = 10000) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) { if ((await readQueue(f.state, {now: START})).length >= count) return; await new Promise(done => setTimeout(done, 20)); }
}

test('an empty answer of a custom server carries how it ended (numbers and one short word), and nothing else is added to another failure', () => {
  const trace = {...newTrace(), headersMs: 20, events: 3, pieces: 0, reasoning: 0, finishReason: 'stop', completionTokens: 0, elapsedMs: 127.4};
  const empty = new MistralError('empty', 'answered with no text', {provider: 'custom', trace});
  assert.deepEqual(emptyAnswerDetail(empty), {emptyFinish: 'stop', emptyEvents: 3, emptyPieces: 0, emptyThinking: 0, emptyTokens: 0, emptyMs: 127});
  // A word that is not a short end-of-answer reason is dropped, and so is anything that is not a count.
  assert.deepEqual(emptyAnswerDetail(new MistralError('empty', 'answered with no text', {provider: 'custom', trace: {...trace, finishReason: 'Some text of the reply!', completionTokens: null, events: 'x'}})), {emptyPieces: 0, emptyThinking: 0, emptyMs: 127});
  assert.deepEqual(emptyAnswerDetail(new MistralError('empty', 'answered with no text', {provider: 'mistral', trace})), {});
  assert.deepEqual(emptyAnswerDetail(new MistralError('network', 'went away', {provider: 'custom', trace})), {});
  assert.deepEqual(emptyAnswerDetail(new Error('x')), {});
});

test('the bridge recorder writes after the fact, once per signature, and nothing while the setting is off', async () => {
  const f = await folders();
  try {
    const deferred = [];
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => deferred.push(fn)});
    events.turnFailed(new Error('Convai did not answer: timed out'), {provider: 'convai'});
    events.turnFailed(new Error('Convai did not answer: timed out'), {provider: 'convai'});
    events.turnFailed(new Error('bad key'), {provider: 'mistral', errorCode: 'mistral-key'});
    events.setupChecked({checks: [{id: 'versions', state: 'problem', code: 'mismatch', scripts: '0.2.1', runtime: '0.2.2'}, {id: 'gpu', state: 'ok', code: 'found'}]});
    assert.equal((await readQueue(f.state)).length, 0, 'nothing is written inside the call');
    assert.equal(deferred.length, 2, 'one deferred write per new signature');
    for (const run of deferred) run();
    await untilQueued(f, 2);
    const queue = await readQueue(f.state, {now: START});
    assert.deepEqual(queue.map(record => record.kind).sort(), ['setup-problem', 'turn-failed']);
    assert.match(queue.find(record => record.kind === 'turn-failed').message, /^convai: /);
    assert.equal(queue.find(record => record.kind === 'setup-problem').message, 'versions mismatch');

    await rm(queueDirectory(f.state), {recursive: true, force: true});
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false}));
    const off = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    off.turnFailed(new Error('Convai did not answer: timed out'));
    await new Promise(done => setTimeout(done, 100));
    assert.equal((await readQueue(f.state)).length, 0);
  } finally { await f.cleanup(); }
});

test('a voice that could not start is recorded with its engine and reason, once per reason, and its signature does not change with the folder', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'pocket', reason: 'Pocket student runtime is unavailable (ValueError: Pocket source differs from the pinned official revision)'});
    events.voiceFailed({engine: 'pocket', reason: 'Pocket student runtime is unavailable (ValueError: Pocket source differs from the pinned official revision)'});
    events.voiceFailed({engine: 'v-helper', reason: 'Pocket student runtime is unavailable (FileNotFoundError: C:\\Games\\one\\model.safetensors)'});
    events.voiceFailed({engine: 'v-helper', reason: 'Pocket student runtime is unavailable (FileNotFoundError: D:\\Other\\place\\model.safetensors)'});
    events.voiceFailed({reason: 'a\nsecond line'});
    await untilQueued(f, 3);
    const queue = await readQueue(f.state, {now: START});
    assert.deepEqual(queue.map(record => record.kind), Array(3).fill('voice-failed'), 'the same reason is one report, and a folder is not a different reason');
    assert.deepEqual(queue.map(record => record.message).sort(), ['pocket: Pocket student runtime is unavailable (ValueError: Pocket source differs from the pinned official revision)',
      'v-helper: Pocket student runtime is unavailable (FileNotFoundError: C:\\Games\\one\\model.safetensors)', 'voice: a'].sort());
  } finally { await f.cleanup(); }
});

test('a voice that ran out of time carries its worker graphics memory as two numbers and nothing else of the reading', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'omni', reason: 'Local voice generation timed out', gpu: {dedicatedMiB: 2100.4, sharedMiB: 1650, adapter: 'C:\\secret', extra: 'x'}});
    events.voiceFailed({engine: 'omni', reason: 'Local voice preparation timed out', gpu: {dedicatedMiB: 'many', sharedMiB: 5}});
    await untilQueued(f, 2);
    const queue = await readQueue(f.state, {now: START});
    const byMessage = Object.fromEntries(queue.map(record => [record.message, record.detail]));
    assert.deepEqual(byMessage['omni: Local voice generation timed out'], {engine: 'omni', gpuDedicatedMiB: 2100, gpuSharedMiB: 1650});
    assert.deepEqual(byMessage['omni: Local voice preparation timed out'], {engine: 'omni'}, 'an unreadable reading adds nothing');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ the payload

test('no planted secret, conversation text or account name gets out, and the payload stays small', async () => {
  const f = await plantedInstall();
  try {
    const user = `C:\\Users\\${PLANTED.windowsUser}\\Desktop\\Code Palace`;
    // Lines the way the service logs them, with every planted value in them: keys, ids, the account name, conversation text.
    await appendFile(join(f.state, 'bridge.stderr.log'), [
      `[Addons] judy: remark dropped (it repeated a recent line): "${PLANTED.chat}" ~ "${PLANTED.chat}"`,
      `[TextProvider] text=${PLANTED.chat}`, `{"reply":"${PLANTED.chat}","count":1}`, `userText: ${PLANTED.chat}`,
      `[Mistral] key ${PLANTED.shortKey} refused for ${PLANTED.characterId}`, `token ${PLANTED.base64}`, `${PLANTED.hfToken} ${PLANTED.kaggle}`,
      `plain ${PLANTED.windowsUser} logged on; session ${PLANTED.sessionId}; Authorization: Bearer ${PLANTED.hexKey}`,
      `Error: Convai did not answer for ${PLANTED.userId} in ${user}\\bridge`, ''].join('\n'));
    await writeFile(join(f.state, 'bridge-service.log'), `2026-10-19T10:00:00Z Supervisor started in ${user}\n`);
    await writeFile(join(f.runtime, 'probe.log'), `2026-10-19T10:00:00Z Composer opened by ${PLANTED.windowsUser}: "${PLANTED.chat}"\n`);
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({conversationProvider: 'local', voiceProvider: 'omni', omniSteps: 32,
      localModel: 'bonsai-8b', matureContent: true, uiLanguage: 'de', apiKey: PLANTED.shortKey, note: PLANTED.chat}));
    const record = {signature: errorSignature(event('x')), kind: 'turn-failed', count: 2, firstAt: START, lastAt: START, source: 'bridge',
      message: `convai: Convai did not answer for ${PLANTED.userId} with ${PLANTED.shortKey} in ${user}`, frame: 'realtime-client.mjs:120 connect',
      stack: [`realtime-client.mjs:120 connect ${PLANTED.hexKey}`], detail: {provider: 'convai', note: PLANTED.chat}};
    const {payload, body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state,
      project: f.project, installId: INSTALL, environment: {}, names: [PLANTED.windowsUser], now: () => START,
      graphics: () => [{name: `Card in C:\\Users\\${PLANTED.windowsUser}\\x`, memoryMiB: 12288}], memory: () => ({totalRamMiB: 32768.4, commitLimitMiB: 40960}),
      gameInfo: {game: '2.31', cet: 'v1.35.0', codeware: '1.20.5', setup: ['codeware: ok found']}});
    for (const [name, value] of Object.entries(PLANTED)) assert.ok(!body.includes(value), `planted ${name} got out`);
    assert.ok(!body.includes(INSTALL), 'the raw install id never leaves');
    // The detail of a voice failure (engine, the worker's graphics memory) and of an empty custom answer is kept; a field the recorders do not write is not.
    const voice = await buildErrorPayload({record: {...record, kind: 'voice-failed', detail: {engine: 'omni', gpuDedicatedMiB: 2036, gpuSharedMiB: 518, emptyFinish: 'stop', emptyTokens: 0, note: PLANTED.chat}},
      game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project, installId: INSTALL, environment: {}, names: [PLANTED.windowsUser], now: () => START, graphics: () => []});
    assert.deepEqual(voice.payload.report.detail, {engine: 'omni', gpuDedicatedMiB: 2036, gpuSharedMiB: 518, emptyFinish: 'stop', emptyTokens: 0});
    assert.equal(payload.install, hashInstall(INSTALL));
    assert.match(payload.install, /^[0-9a-f]{32}$/);
    assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES);
    assert.ok(gzipSync(body).length < 64 * 1024, 'under 64 KB compressed');
    assert.ok(payload.report.logs.reduce((sum, item) => sum + item.lines.length, 0) <= MAX_LOG_LINES);
    // What it should say.
    assert.equal(payload.report.choices.matureContent, true, 'Mature content as a boolean only');
    assert.equal(payload.report.choices.provider, 'local');
    assert.equal(payload.report.choices.localModel, 'bonsai-8b');
    assert.equal(payload.report.versions.game, '2.31');
    assert.equal(payload.report.versions.cet, 'v1.35.0');
    assert.equal(payload.report.versions.red4ext, '1.30.0');
    assert.deepEqual(payload.report.system.gpu.map(card => card.memoryMiB), [12288]);
    // Total RAM and the commit limit (RAM plus paging files) tell a "paging file is too small" failure from another one; two numbers and nothing else.
    assert.deepEqual([payload.report.system.totalRamMiB, payload.report.system.commitLimitMiB], [32768, 40960]);
    assert.deepEqual(Object.keys(payload.report.system), ['gpu', 'totalRamMiB', 'commitLimitMiB']);
    const noFacts = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project, installId: INSTALL, environment: {}, names: [PLANTED.windowsUser],
      now: () => START, graphics: () => [], memory: () => { throw Error('powershell is missing'); }});
    assert.deepEqual([noFacts.payload.report.system.totalRamMiB, noFacts.payload.report.system.commitLimitMiB], [null, null], 'a read that fails is two nulls and the report still goes out');
    const junk = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project, installId: INSTALL, environment: {}, names: [PLANTED.windowsUser],
      now: () => START, graphics: () => [], memory: () => ({totalRamMiB: 'lots', commitLimitMiB: -5})});
    assert.deepEqual([junk.payload.report.system.totalRamMiB, junk.payload.report.system.commitLimitMiB], [null, null]);
    assert.ok(payload.report.setup.includes('game codeware: ok found'));
    assert.ok(payload.report.logs.some(item => item.source === 'bridge-stderr' && item.lines.some(line => line.includes('[text removed]'))));
    assert.ok(payload.report.logs.some(item => item.source === 'redscript' && item.lines.some(line => line.includes('Cannot resolve type'))));
    assert.ok(!payload.report.logs.some(item => item.lines.some(line => line.includes('routine line 1000'))), 'only lines around the error');
  } finally { await f.cleanup(); }
});

test('the error-report cleaner hides account names in any path (two-letter ones too), emails and user:pass@host', () => {
  const {clean} = reportCleaner({names: ['Jo', 'Zedmaster'], secrets: [], ids: []});
  const b = '\\';
  assert.equal(clean(`opened E:${b}Jo${b}Games${b}y.lua and D:${b}Zedmaster${b}x`), `opened E:${b}<user>${b}Games${b}y.lua and D:${b}<user>${b}x`);
  assert.equal(clean('then Jo went to Josephine'), 'then Jo went to Josephine', 'a two-letter name is only hidden as a path part');
  assert.equal(clean('Zedmaster logged in'), '<user> logged in', 'a longer name is hidden anywhere');
  const out = clean('proxy https://u:p4ssw0rd@host.example:8080/a mail a.b@c.example.com');
  assert.equal(out, 'proxy https://[redacted]@host.example:8080/a mail [email-redacted]');
  assert.equal(clean('key Q7wE3rT9yU1iO5pA2sD4fG6hJ8kL0zXc here'), 'key [token-redacted] here', 'a 32-character key');
});

test('the conversation filter removes quoted sentences and text fields, and keeps the words an error needs', () => {
  assert.equal(withoutConversation("Type 'MovePolicies' not found."), "Type 'MovePolicies' not found.");
  assert.equal(withoutConversation('Conversation result: generation=1 error=false'), 'Conversation result: generation=1 error=false');
  assert.equal(withoutConversation('said anyway: "Sure thing, choom you bet" ~ "x"'), 'said anyway: "[text removed]" ~ "x"');
  assert.equal(withoutConversation('{"text":"hello there","count":1}'), '{"text":"[text removed]","count":1}');
  assert.equal(withoutConversation('prompt = tell me about the heist'), 'prompt = [text removed]');
});

test('the stuck-reply diagnostic of a Convai turn survives the redactor, and a real transcript does not (2026-10-22 reports f2d59c4a, db4f10eb)', () => {
  const {clean} = reportCleaner({names: []});
  const stuck = 'convai: page.evaluate: Error: Convai did not finish the reply (transcript=true text=false complete=false thinking=true audio=off)';
  assert.equal(clean(stuck), stuck, 'the five flags are written true or false, which the redactor keeps');
  assert.equal(withoutConversation(stuck), stuck);
  assert.equal(clean('did not finish the reply (transcript=false text=false complete=undefined thinking=false audio=false)'),
    'did not finish the reply (transcript=false text=false complete=undefined thinking=false audio=false)');
  assert.equal(withoutConversation('turn failed transcript=Take me to the Afterlife tonight please'), 'turn failed transcript=[text removed]', 'a transcript is still player text');
  assert.equal(withoutConversation('(transcript=yes text=no complete=false)'), '(transcript=[text removed]', 'the old yes/no wording was removed with the rest of the line');
});

test('a large log is cut to fit: the body never passes 60 KB', async () => {
  const f = await folders();
  try {
    await writeFile(join(f.state, 'bridge.stderr.log'), Array.from({length: 3000}, (_, index) => `line ${index} ${'x'.repeat(290)}`).join('\n'));
    await writeFile(join(f.runtime, 'probe.log'), Array.from({length: 3000}, (_, index) => `probe ${index} ${'y'.repeat(290)}`).join('\n'));
    await writeFile(join(f.modRoot, 'AiNpcCyberpunkMod.log'), Array.from({length: 3000}, (_, index) => `mod ${index} ${'z'.repeat(290)}`).join('\n'));
    const record = {signature: 'aaaaaaaaaaaaaaaa', kind: 'bridge-exception', count: 1, firstAt: START, lastAt: START, message: 'boom', frame: '', stack: []};
    const {body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], graphics: () => [], secrets: [], now: () => START});
    assert.ok(Buffer.byteLength(body) <= MAX_BODY_BYTES, `${Buffer.byteLength(body)} bytes`);
    assert.ok(JSON.parse(body).report.logs.length > 0, 'it keeps what fits');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ sending and throttles

test('one report per signature per day and twenty a day: the rest wait, signed like the token endpoint', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock);
  try {
    await recordErrorEvent(f.state, event('the same fault'), {now: clock.now});
    await reporter.flush();
    await recordErrorEvent(f.state, event('the same fault'), {now: clock.now});
    await reporter.flush();
    assert.equal(backend.calls.length, 1, 'one per signature per day');
    assert.equal(backend.calls[0].verdict, 'ok', 'signed with the backend secret');
    assert.equal(backend.calls[0].url, 'https://backend.invalid/api/errors/report');
    assert.equal(DAILY_LIMIT, 20);
    for (let index = 0; index < DAILY_LIMIT + 2; index++) await recordErrorEvent(f.state, event(`fault ${faultLabel(index)}`), {now: clock.now});
    await reporter.flush();
    assert.equal(backend.calls.length, DAILY_LIMIT, 'twenty a day in all (the first went out above)');
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 3, 'the rest wait');
    assert.equal((await errorReportStatus({runtime: f.runtime, stateDirectory: f.state, now: clock.now})).sentToday, DAILY_LIMIT);
    clock.now += DAY;
    await recordErrorEvent(f.state, event('the same fault'), {now: clock.now});
    await reporter.flush();
    assert.equal(backend.calls.length, DAILY_LIMIT + 4, 'a new UTC day: the waiting three and the repeat go out');
  } finally { reporter.close(); await f.cleanup(); }
});

test('a backend without the endpoint (404) stops reports for the session and keeps the queue', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({statuses: [404], clock});
  const logged = [];
  const reporter = reporterFor(f, backend, clock, {log: line => logged.push(line)});
  try {
    await recordErrorEvent(f.state, event('fault one'), {now: clock.now});
    await recordErrorEvent(f.state, event('fault two'), {now: clock.now});
    await reporter.flush();
    await recordErrorEvent(f.state, event('fault three'), {now: clock.now});
    clock.now += 60 * 60_000;
    await reporter.flush();
    assert.equal(backend.calls.length, 1);
    assert.equal(reporter.stopped, 'not-found');
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 3);
    assert.equal(logged.filter(line => /404/.test(line)).length, 1, 'said once, quietly, in the service log');
  } finally { reporter.close(); await f.cleanup(); }
});

test('a failed send waits 15 minutes, a timeout counts as one, three stop it; refused and rate-limited answers never loop', async () => {
  const f = await folders();
  const clock = {now: START};
  const hang = init => new Promise((done, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)));
  const backend = fakeBackend({statuses: [503, hang, 503], clock});
  const reporter = reporterFor(f, backend, clock, {timings: {timeoutMs: 50}});
  // AbortSignal.timeout's timer does not keep a process alive (the supervisor has its own timers); this test's interval does.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await recordErrorEvent(f.state, event('fault one'), {now: clock.now});
    await reporter.flush();
    await reporter.flush();
    assert.equal(backend.calls.length, 1, 'no second try inside the wait');
    clock.now += 15 * 60_000;
    await reporter.flush();
    assert.equal(backend.calls.length, 2, 'the timeout');
    clock.now += 15 * 60_000;
    await reporter.flush();
    assert.equal(reporter.stopped, 'unreachable');
    clock.now += 60 * 60_000;
    await reporter.flush();
    assert.equal(backend.calls.length, 3);
  } finally { reporter.close(); clearInterval(keepAlive); }
  const clock2 = {now: START};
  const refused = fakeBackend({statuses: [400, 429], clock: clock2});
  const second = reporterFor(f, refused, clock2);
  try {
    await rm(join(f.state, 'error-reports'), {recursive: true, force: true});
    await recordErrorEvent(f.state, event('refused body'), {now: clock2.now});
    await recordErrorEvent(f.state, event('rate limited'), {now: clock2.now + 1});
    await second.flush();
    assert.equal(refused.calls.length, 2);
    assert.equal(second.stopped, 'rate');
    assert.deepEqual((await readQueue(f.state, {now: clock2.now})).map(record => record.message), ['rate limited'], 'the refused report was dropped');
  } finally { second.close(); await f.cleanup(); }
});

test('a clock that is off is corrected once from the backend\'s time', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock, statuses: [() => new Response(JSON.stringify({error: 'stale', serverTime: Math.floor(START / 1000) + 600}), {status: 401}), 200]});
  const reporter = reporterFor(f, backend, clock);
  try {
    await recordErrorEvent(f.state, event('fault'), {now: clock.now});
    await reporter.flush();
    assert.equal(backend.calls.length, 2);
    assert.equal(reporter.stopped, null);
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 0);
  } finally { reporter.close(); await f.cleanup(); }
});

test('nothing is sent before the in-game notice was shown: the queue waits, and goes out once the game has marked the notice', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  try {
    for (const text of [null, JSON.stringify({errorReports: true}), JSON.stringify({errorReportsNoticed: false})]) {
      if (text === null) await rm(join(f.runtime, 'settings.json'), {force: true});
      else await writeFile(join(f.runtime, 'settings.json'), text);
      await recordErrorEvent(f.state, event('fault', 'service-failed'), {now: clock.now});
      const reporter = reporterFor(f, backend, clock);
      await reporter.flush();
      await reporter.look({flush: true});
      reporter.close();
      assert.equal(backend.calls.length, 0, `nothing sent with settings ${text}`);
      assert.equal((await readQueue(f.state, {now: clock.now})).length, 1, 'and nothing is dropped: it waits');
      assert.equal(await errorReportsMaySend(f.runtime), false);
      assert.equal((await errorReportStatus({runtime: f.runtime, stateDirectory: f.state})).noticed, false);
    }
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReportsNoticed: true}));
    assert.equal(await errorReportsMaySend(f.runtime), true);
    const after = reporterFor(f, backend, clock);
    await after.flush();
    after.close();
    assert.equal(backend.calls.length, 1, 'sent once the notice was shown');
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 0);
    // The setting off wins over a shown notice.
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false, errorReportsNoticed: true}));
    assert.equal(await errorReportsMaySend(f.runtime), false);
  } finally { await f.cleanup(); }
});

test('an unreadable settings file is an unknown state, never on: nothing is recorded or sent, and the queue is not deleted', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  try {
    await recordErrorEvent(f.state, event('queued before the damage', 'service-failed'), {now: clock.now});
    for (const damaged of ['{"errorReports": fal', '{"errorReports": "false"}', '', '[]', 'null', String.fromCharCode(0, 0)]) {
      await writeFile(join(f.runtime, 'settings.json'), damaged);
      await rm(join(f.runtime, 'settings.json.previous'), {force: true});
      assert.deepEqual(await errorReportsSetting(f.runtime), {state: 'unknown', noticed: false}, JSON.stringify(damaged));
      assert.equal(await errorReportsEnabled(f.runtime), false);
      assert.equal(errorReportsEnabledSync(f.runtime), false);
      const reporter = reporterFor(f, backend, clock);
      assert.equal(await reporter.record(event('new fault', 'service-failed')), null, 'not recorded');
      await reporter.flush();
      reporter.close();
      assert.equal(backend.calls.length, 0, 'not sent');
      assert.equal((await readQueue(f.state, {now: clock.now})).length, 1, 'and the queue is neither sent nor deleted');
      assert.equal((await errorReportStatus({runtime: f.runtime, stateDirectory: f.state})).setting, 'unknown');
    }
    // A bridge crash is not recorded either.
    const script = `import {installCrashCapture} from ${JSON.stringify(new URL('./error-events.mjs', import.meta.url).href)};
installCrashCapture({stateDirectory: ${JSON.stringify(f.state)}, runtime: ${JSON.stringify(f.runtime)}});
throw new Error('not recorded');`;
    await writeFile(join(f.runtime, 'settings.json'), '{broken');
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 20000});
    assert.equal((await readQueue(f.state)).length, 1);
    // The previous copy stands in for a file being replaced: it still decides (here: an opt-out stays an opt-out).
    await writeFile(join(f.runtime, 'settings.json.previous'), JSON.stringify({errorReports: false, errorReportsNoticed: true}));
    assert.deepEqual(await errorReportsSetting(f.runtime), {state: 'off', noticed: true});
    await writeFile(join(f.runtime, 'settings.json.previous'), JSON.stringify({errorReportsNoticed: true}));
    assert.deepEqual(await errorReportsSetting(f.runtime), {state: 'on', noticed: true});
  } finally { await f.cleanup(); }
});

test('with the setting off nothing is sent and the queue is deleted; with no backend address nothing is sent and it waits', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  try {
    await recordErrorEvent(f.state, event('fault'), {now: clock.now});
    const none = reporterFor(f, backend, clock, {target: null});
    await none.flush();
    none.close();
    assert.equal(backend.calls.length, 0);
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 1);
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false}));
    const off = reporterFor(f, backend, clock);
    await off.flush();
    assert.equal(await off.record(event('supervisor fault', 'service-failed')), null);
    off.close();
    assert.equal(backend.calls.length, 0);
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 0);
    assert.equal((await errorReportStatus({runtime: f.runtime, stateDirectory: f.state})).setting, 'off');
  } finally { await f.cleanup(); }
});

test('a crash the bridge recorded itself is not reported twice; one it could not record is reported by the supervisor', async () => {
  const f = await folders();
  const clock = {now: START};
  const reporter = reporterFor(f, fakeBackend({clock}), clock);
  try {
    await recordErrorEvent(f.state, {kind: 'bridge-exception', message: 'TypeError: x is undefined', frame: 'a.mjs:1'}, {now: clock.now});
    assert.equal(await reporter.bridgeExited('exit code 1'), null);
    clock.now += 60_000;
    const crash = await reporter.bridgeExited('exit code 3221225477');
    assert.equal(crash.kind, 'bridge-crash');
    assert.equal(crash.frame, 'exit code 3221225477');
    const failed = await reporter.record({kind: 'service-failed', message: 'bridge-crashed', frame: 'supervisor'});
    assert.equal(failed.source, 'service');
  } finally { reporter.close(); await f.cleanup(); }
});

// ------------------------------------------------------------------ the game's events and the Lua logs

test('the game\'s events are read once, and their versions go into the reports', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock);
  try {
    await writeFile(join(f.runtime, 'error-events.json'), JSON.stringify({version: 1, updated: START,
      game: {game: '2.31', cet: 'v1.35.0', codeware: '1.20.5', setup: ['cet: ok found']},
      events: [{kind: 'service-silent', code: 'service-silent', detail: 'service-silent after service-starting at preparing', frame: 'service', at: START - 1000}]}));
    await reporter.look({flush: true});
    await reporter.look({flush: true});
    assert.equal(backend.calls.length, 1);
    const sent = backend.calls[0].body;
    assert.equal(sent.kind, 'service-silent');
    assert.equal(sent.report.versions.cet, 'v1.35.0');
    assert.ok(sent.report.setup.includes('game cet: ok found'));
    assert.deepEqual(parseGameEvents('{"version":2}'), {game: {}, events: []});
    assert.deepEqual(parseGameEvents('not json'), {game: {}, events: []});
  } finally { reporter.close(); await f.cleanup(); }
});

test('the game\'s setup row "service never" from before this service started is dropped; one from after it, and every other row, is kept', async () => {
  const f = await folders();
  const clock = {now: START};
  const logs = [];
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock, {log: line => logs.push(line)});
  try {
    await writeFile(join(f.runtime, 'error-events.json'), JSON.stringify({version: 1, updated: START,
      game: {game: '2.31'},
      events: [
        {kind: 'setup-problem', code: 'service never', detail: 'plugin-not-loaded', frame: 'game-setup', at: START - 3_600_000},
        {kind: 'setup-problem', code: 'red4ext missing', frame: 'game-setup', at: START - 3_600_000},
        {kind: 'setup-problem', code: 'service never', detail: 'no-launcher-trace', frame: 'game-setup', at: START + 500}]}));
    await reporter.look({flush: false});
    const queue = await readQueue(f.state, {now: clock.now});
    assert.deepEqual(queue.map(record => [record.message, record.detail?.detail]).sort(), [['red4ext missing', undefined], ['service never', 'no-launcher-trace']],
      'the older "service never" is dropped; the newer one stays and carries its reason');
    assert.equal(logs.filter(line => /service never/.test(line)).length, 1, 'said once in the service log');
    await reporter.look({flush: false});
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 2, 'read once: the dropped row does not come back');
  } finally { reporter.close(); await f.cleanup(); }
});

test('a sign-in failure report carries the network cause code in its detail, not in its message, and nothing but a code', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    const failure = cause => Object.assign(Error('Convai sign-in is unavailable (unreachable) [convai-auth:unreachable]'), {authKind: 'unreachable', ...(cause ? {authCause: cause} : {})});
    events.turnFailed(failure('ENOTFOUND'), {provider: 'convai'});
    await untilQueued(f, 1);
    const [record] = await readQueue(f.state, {now: START});
    assert.equal(record.detail.authCause, 'ENOTFOUND');
    assert.ok(!/ENOTFOUND/.test(record.message), 'the signature stays one for every cause');
    // The same message with another cause (or none) is the same signature
    const other = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    other.turnFailed(failure('ECONNRESET'), {provider: 'convai'});
    await new Promise(done => setTimeout(done, 100));
    const queue = await readQueue(f.state, {now: START});
    assert.equal(queue.length, 1);
    assert.equal(queue[0].signature, record.signature);
    assert.equal(queue[0].detail.authCause, 'ECONNRESET', 'the latest occurrence says its cause');
    // Not a code: dropped (a host name or a sentence never goes in)
    assert.deepEqual(authCauseDetail(failure('api.example.com')), {});
    assert.deepEqual(authCauseDetail(failure('connect to 10.0.0.1 failed')), {});
    assert.deepEqual(authCauseDetail(failure()), {});
    assert.deepEqual(authCauseDetail(failure('UND_ERR_CONNECT_TIMEOUT')), {authCause: 'UND_ERR_CONNECT_TIMEOUT'});
    assert.deepEqual(authCauseDetail(failure('TimeoutError')), {authCause: 'TimeoutError'});
    // and it reaches the payload
    const payload = await buildErrorPayload({record: queue[0], game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, gameInfo: {}, secrets: [], graphics: () => [], environment: {}, now: () => START});
    assert.equal(JSON.parse(payload.body).report.detail.authCause, 'ECONNRESET');
  } finally { await f.cleanup(); }
});

test('Lua errors in the mod\'s logs are found from where the last look stopped; older lines and ordinary lines are not', async () => {
  const f = await folders();
  const clock = {now: START};
  const reporter = reporterFor(f, fakeBackend({clock}), clock, {target: null});
  try {
    const probe = join(f.runtime, 'probe.log'), modLog = join(f.modRoot, 'AiNpcCyberpunkMod.log');
    await writeFile(probe, '2026-10-18T10:00:00Z Crowd movement policy hold failed: init.lua:150: attempt to index local \'policy\' (a nil value)\n');
    await writeFile(modLog, '');
    await reporter.look({flush: false});
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 0, 'what was there before is not this session\'s');
    await appendFile(probe, ['2026-10-19T10:00:00Z Conversation result: generation=1 error=false speech=starting',
      '2026-10-19T10:00:01Z Crowd movement policy hold failed: init.lua:150: attempt to index local \'policy\' (a nil value)', ''].join('\n'));
    await appendFile(modLog, '[2026-10-19 10:00:02 UTC+02:00] [error] manager-ui.lua:1201: bad argument #1 to \'ipairs\' (table expected, got nil)\nstack traceback:\n');
    await reporter.look({flush: false});
    const queue = await readQueue(f.state, {now: clock.now});
    assert.deepEqual(queue.map(record => [record.kind, record.frame]).sort(), [['lua-error', 'init.lua:150'], ['lua-error', 'manager-ui.lua:1201']]);
    assert.equal(queue.find(record => record.frame === 'init.lua:150').message, "attempt to index local 'policy' (a nil value)");
    await reporter.look({flush: false});
    assert.equal((await readQueue(f.state, {now: clock.now})).every(record => record.count === 1), true, 'a line is read once');
    assert.deepEqual(luaErrorsIn(['Conversation result: generation=1 error=false']), []);
  } finally { reporter.close(); await f.cleanup(); }
});

// ------------------------------------------------------------------ the address and the support report

test('the address is the sign-in backend\'s, whether or not backend mode is on; only https or a local address', async () => {
  const files = {'auth.json': JSON.stringify({enabled: false, url: 'https://backend.example/api/convai/token', secret: SIGNING_SECRET})};
  const readText = async path => { const name = path.split(/[\\/]/).at(-1); if (!(name in files)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return files[name]; };
  const address = await readBackendAddress({env: {}, path: 'x/auth.json', readText});
  assert.deepEqual(address, {url: 'https://backend.example/api/convai/token', secret: SIGNING_SECRET});
  files['convai-auth.json'] = files['auth.json'];
  assert.deepEqual(await reportTarget({env: {}, stateDirectory: 'x', readText}), {url: 'https://backend.example/api/errors/report', secret: SIGNING_SECRET});
  assert.equal((await reportTarget({env: {CYBERPUNK_CONVAI_ERRORS_URL: 'https://other.example/e'}, stateDirectory: 'x', readText})).url, 'https://other.example/e');
  assert.equal(await reportTarget({env: {CYBERPUNK_CONVAI_ERRORS_URL: 'http://other.example/e'}, stateDirectory: 'x', readText}), null);
  assert.equal(await reportTarget({env: {}, stateDirectory: 'none', readText: async () => { throw Error('missing'); }}), null, 'no secret, no reports');
});

test('the support report says whether error reports are on, with counts only', async () => {
  const f = await fakeInstall();
  try {
    await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({errorReports: false}));
    const {summary} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, reportId: 'r-e',
      request: {id: 'r-e', issuedAt: Date.now()}, secrets: [], environment: {}, graphics: () => []});
    assert.equal(summary.errorReports.setting, 'off');
    assert.equal(summary.errorReports.sentToday, 0);
  } finally { await f.cleanup(); }
});

test('the supervisor reports a failed service and an unexpected exit, and starts the reporter only when asked', async () => {
  const {BridgeSupervisor, MOD_RUNTIME} = await import('./bridge-supervisor.mjs');
  const f = await folders();
  try {
    await mkdir(join(f.game, ...MOD_RUNTIME.split('/')), {recursive: true});
    const options = {project: f.project, stateDirectory: f.state, keyFile: join(f.state, 'convai-key.txt'), gameRoot: f.game, sleep: async () => {}};
    const quiet = new BridgeSupervisor(options);
    await quiet.startErrorReports();
    assert.equal(quiet.reporter, null, 'off unless the entry point asks');
    const seen = [];
    const supervisor = new BridgeSupervisor(options);
    supervisor.reporter = {record: async value => { seen.push(['record', value]); }, bridgeExited: async value => { seen.push(['exit', value]); }};
    await supervisor.fail('missing-key');
    await supervisor.onBridgeExit(4242, {code: 3221225477});
    assert.deepEqual(seen, [['record', {kind: 'service-failed', message: 'missing-key', frame: 'supervisor'}], ['exit', 'exit code 3221225477']]);
    const real = new BridgeSupervisor({...options, errorReports: true});
    await real.startErrorReports();
    assert.ok(real.reporter, 'the reporter runs in the supervisor process');
    assert.equal(real.reporter.runtime, join(f.game, ...MOD_RUNTIME.split('/')));
    await real.reporter.idle(5000);
    real.reporter.close();
  } finally { await f.cleanup(); }
});

test('end to end with the real backend handler: stored once, listed and fetched by the developer, with no raw install id or address', async () => {
  const {createErrorWorld} = await import('../auth-backend/testkit/errors-world.mjs');
  const {mockResponse} = await import('../auth-backend/testkit/harness.mjs');
  const world = createErrorWorld();
  const f = await plantedInstall();
  await writeFile(join(f.state, 'convai-install.json'), JSON.stringify({version: 1, installId: INSTALL}));
  const planted = JSON.parse(await readFile(join(f.runtime, 'settings.json'), 'utf8'));
  await writeFile(join(f.runtime, 'settings.json'), JSON.stringify({...planted, errorReportsNoticed: true}));
  const clock = world.clock;
  // The bridge's request goes straight into the backend's handler, as Vercel would hand it over.
  const fetchImpl = async (url, init) => {
    const response = mockResponse();
    await world.handler({method: init.method, headers: {...init.headers, 'x-vercel-forwarded-for': '198.51.100.23'}, body: init.body}, response);
    return new Response(response.text, {status: response.statusCode});
  };
  const reporter = new ErrorReporter({game: f.game, runtime: f.runtime, modRoot: f.modRoot, stateDirectory: f.state, project: f.project, env: {},
    fetchImpl, now: () => clock.now, graphics: () => [], names: [PLANTED.windowsUser], setTimer: () => null, clearTimer: () => {},
    setRepeat: () => null, clearRepeat: () => {}, target: {url: 'https://backend.invalid/api/errors/report', secret: SIGNING_SECRET}});
  try {
    await recordErrorEvent(f.state, {kind: 'bridge-exception', message: `TypeError: key ${PLANTED.shortKey} failed`, frame: 'a.mjs:1 run'}, {now: clock.now});
    await reporter.flush();
    assert.equal((await readQueue(f.state, {now: clock.now})).length, 0, 'sent and removed from the queue');
    assert.equal(world.store.commands, 1, 'a report costs one Redis command');
    const list = (await world.ask('/api/admin/errors')).json;
    assert.equal(list.total, 1);
    const [row] = list.signatures;
    assert.equal(row.kind, 'bridge-exception');
    assert.equal(row.reports, 1);
    assert.deepEqual(Object.keys(row.versions), ['0.0.0-dev']);
    const fetched = (await world.ask(`/api/admin/errors?signature=${row.signature}&id=${row.ids[0]}`)).json;
    assert.equal(fetched.report.kind, 'bridge-exception');
    assert.ok(fetched.report.report.logs.length > 0);
    const stored = world.contents();
    for (const value of [INSTALL, hashInstall(INSTALL), '198.51.100.23', PLANTED.shortKey]) assert.ok(!stored.includes(value), `${value} is not stored`);
  } finally { reporter.close(); await f.cleanup(); }
});

test('a released Runtime sends to the address in app/defaults/error-reports.json; the data folder\'s settings win; its secret is scrubbed', async () => {
  const {dataFolderSecrets} = await import('./report-secrets.mjs');
  const f = await folders();
  const shipped = `shipped-${SIGNING_SECRET}`;
  try {
    await mkdir(join(f.project, 'defaults'), {recursive: true});
    await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({version: 1, url: 'https://shipped.example/anything', secret: shipped}));
    assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), {url: 'https://shipped.example/api/errors/report', secret: shipped});
    await writeFile(join(f.state, 'convai-auth.json'), JSON.stringify({enabled: false, url: 'https://dev.example/api/convai/token', secret: SIGNING_SECRET}));
    assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), {url: 'https://dev.example/api/errors/report', secret: SIGNING_SECRET});
    await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({url: 'http://shipped.example/', secret: shipped}));
    await rm(join(f.state, 'convai-auth.json'));
    assert.equal(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), null, 'only https');
    await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({url: 'https://shipped.example/', secret: shipped}));
    await writeFile(join(f.state, 'bridge.stderr.log'), `Error: boom with ${shipped} in it\n`);
    const record = {signature: 'bbbbbbbbbbbbbbbb', kind: 'bridge-exception', count: 1, firstAt: START, lastAt: START, message: `boom ${shipped}`, frame: '', stack: []};
    const {body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], graphics: () => [], now: () => START});
    assert.ok(!body.includes(shipped), 'the shipped secret never leaves');
    assert.ok((await dataFolderSecrets({stateDirectory: f.state, project: f.project})).includes(shipped), 'the shipped secret is also returned for scrubbing');
  } finally { await f.cleanup(); }
});

test('the sign-in settings a release ships (defaults/convai-auth.json) never become the error report target or secret', async () => {
  const {dataFolderSecrets} = await import('./report-secrets.mjs');
  const f = await folders();
  const signIn = `signin-${SIGNING_SECRET}`, shipped = `shipped-${SIGNING_SECRET}`;
  try {
    await mkdir(join(f.project, 'defaults'), {recursive: true});
    await writeFile(join(f.project, 'defaults', 'convai-auth.json'), JSON.stringify({version: 1, enabled: true, url: 'https://signin.example/api/convai/token', secret: signIn, fallback: false}));
    // Alone, the request secret is no report target: no secret, no reports (they wait in the queue).
    assert.equal(await readBackendAddress({env: {}, path: join(f.state, 'convai-auth.json')}), null);
    assert.equal(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), null);
    // With the reports' own file, that file decides: its address and its secret, never the request secret.
    await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({version: 1, url: 'https://reports.example/anything', secret: shipped}));
    assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), {url: 'https://reports.example/api/errors/report', secret: shipped});
    // The request secret is still a secret: scrubbed from every report.
    await writeFile(join(f.state, 'bridge.stderr.log'), `Error: boom with ${signIn} in it\n`);
    const record = {signature: 'cccccccccccccccc', kind: 'bridge-exception', count: 1, firstAt: START, lastAt: START, message: `boom ${signIn}`, frame: '', stack: []};
    const {body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], graphics: () => [], now: () => START});
    assert.ok(!body.includes(signIn) && !body.includes(shipped), 'neither shipped secret leaves');
    const secrets = await dataFolderSecrets({stateDirectory: f.state, project: f.project});
    assert.ok(secrets.includes(signIn) && secrets.includes(shipped), 'both are returned for scrubbing');
  } finally { await f.cleanup(); }
});

// ------------------------------------------------------------------ a crash's facts and the Runtime's files

test('a bridge crash report carries the exit code in words, the stage and Node\'s report summary, and every text goes through the redactor', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock);
  try {
    const crash = {exit: {code: 4294967295, hex: '0xFFFFFFFF', meaning: 'usually TerminateProcess by another program'},
      stage: {name: 'turn.llmSent', agoS: 3, previous: ['microphone.finish'], closed: false}, memory: {rssMiB: 380, heapUsedMiB: 90, heapTotalMiB: 140, heapLimitMiB: 4144, agoS: 120},
      uptimeS: 600, nodeReport: {file: 'report.1.json', event: 'Exception', error: ['Error: cannot open C:', 'Users', PLANTED.windowsUser, 'game', 'x.json'].join(String.fromCharCode(92)), frames: ['turn.mjs:41 run'], heapUsedMiB: 96, rssMiB: 412}};
    const record = await reporter.bridgeExited('exit code 4294967295', crash);
    assert.equal(record.kind, 'bridge-crash'); assert.equal(record.crash.exit.hex, '0xFFFFFFFF');
    const {payload, body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [PLANTED.windowsUser], graphics: () => [], secrets: [], now: () => START});
    assert.equal(payload.report.crash.exit.meaning, 'usually TerminateProcess by another program');
    assert.equal(payload.report.crash.stage.name, 'turn.llmSent');
    assert.equal(payload.report.crash.nodeReport.frames[0], 'turn.mjs:41 run');
    assert.equal(payload.report.crash.memory.heapLimitMiB, 4144);
    assert.ok(!body.includes(PLANTED.windowsUser), 'the account name in the Node error text is removed');
    assert.equal(payload.frame, 'exit code 4294967295', 'the signature\'s inputs are as before');
    // A record that is not a crash has no such section.
    const other = await buildErrorPayload({record: {...record, kind: 'turn-failed', signature: 'bbbbbbbbbbbbbbbb'}, game: f.game, modRoot: f.modRoot, runtime: f.runtime,
      stateDirectory: f.state, project: f.project, installId: INSTALL, environment: {}, names: [], graphics: () => [], secrets: [], now: () => START});
    assert.equal(other.payload.report.crash, undefined);
  } finally { reporter.close(); await f.cleanup(); }
});

test('every report says whether the Runtime\'s code files match the release: counts and up to five names, no contents', async () => {
  const f = await folders();
  try {
    const shipped = {'bridge/a.mjs': 'export const a = 1;\n', 'launcher/start-service.mjs': 'start();\n'};
    await mkdir(join(f.project, 'bridge'), {recursive: true}); await mkdir(join(f.project, 'launcher'), {recursive: true}); await mkdir(join(f.project, 'defaults'), {recursive: true});
    for (const [path, text] of Object.entries(shipped)) await writeFile(join(f.project, path), text);
    await writeFile(join(f.project, CODE_LIST), codeListText({version: '0.2.8', rows: Object.entries(shipped).map(([path, text]) => ({path, hash: hashBytes(Buffer.from(text))}))}));
    resetRuntimeIntegrityCache();
    const record = {signature: 'cccccccccccccccc', kind: 'service-failed', count: 1, firstAt: START, lastAt: START, message: 'x', frame: '', stack: []};
    const build = () => buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], graphics: () => [], secrets: [], now: () => START});
    assert.equal((await build()).payload.report.runtimeFiles.state, 'ok');
    await writeFile(join(f.project, 'launcher/start-service.mjs'), 'start(); callHomeToSomewhereElse();\n');
    await writeFile(join(f.project, 'bridge/fesir-ai.mjs'), 'export const services = "Cloud.ru + GigaAM";\n');
    resetRuntimeIntegrityCache();
    const {payload, body} = await build();
    assert.deepEqual(payload.report.runtimeFiles, {state: 'modified', checked: 3, changed: 1, extra: 1, missing: 0, listVersion: '0.2.8',
      names: ['changed launcher/start-service.mjs', 'extra bridge/fesir-ai.mjs']});
    assert.ok(!body.includes('callHomeToSomewhereElse') && !body.includes('Cloud.ru'), 'names only, never contents');
    // No list (a Runtime before 0.2.8) and a check that throws are both harmless.
    await rm(join(f.project, CODE_LIST));
    assert.deepEqual((await build()).payload.report.runtimeFiles, {state: 'no-list'});
    const broken = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project, installId: INSTALL,
      environment: {}, names: [], graphics: () => [], secrets: [], now: () => START, integrity: () => { throw new Error('nope'); }});
    assert.deepEqual(broken.payload.report.runtimeFiles, {state: 'unavailable'});
  } finally { await f.cleanup(); }
});

// ---------------------------------------------- a report that waits keeps the log lines of the moment

test('a report over the daily limit keeps its scrubbed log excerpt from when the event was seen, not the later session\'s lines', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock);
  const logPath = join(f.state, 'bridge.stderr.log');
  const secret = 'PlantedSecretValue0123456789abcdef';
  try {
    // today's limit is used up by other faults
    for (let index = 0; index < DAILY_LIMIT; index++) await recordErrorEvent(f.state, event(`early fault ${faultLabel(index)}`), {now: clock.now});
    await reporter.flush();
    assert.equal(backend.calls.length, DAILY_LIMIT);
    await writeFile(join(f.state, 'player-mistral-key.txt'), secret);
    // the fault that has to wait, with the lines around it in the log (a planted key and the player's account name among them)
    await writeFile(logPath, ['before the fault', `the key is ${secret}`, 'Error: the waiting fault happened here', `at C:/Users/PlantedPlayerName/x.mjs:3:1`, 'after the fault'].join('\n'));
    await recordErrorEvent(f.state, {kind: 'turn-failed', message: 'the waiting fault happened here', frame: 'realtime-client.mjs:120 connect'}, {now: clock.now});
    await reporter.look({flush: true});
    assert.equal(backend.calls.length, DAILY_LIMIT, 'it waits: the limit is reached');
    const [waiting] = await readQueue(f.state, {now: clock.now});
    assert.ok(Array.isArray(waiting.logs), 'the excerpt was taken at the look, while the event was fresh');
    const kept = JSON.stringify(waiting.logs);
    assert.ok(kept.includes('the waiting fault happened here') && kept.includes('before the fault'));
    assert.ok(!kept.includes(secret) && !kept.includes('PlantedPlayerName'), 'scrubbed before it is stored, with the same redactor as a sent report');
    // the next session: the log is another one entirely
    await writeFile(logPath, 'a completely different session\nnothing about the fault\n');
    clock.now += DAY;
    await reporter.flush();
    assert.equal(backend.calls.length, DAILY_LIMIT + 1);
    const sent = backend.calls.at(-1).body.report;
    const lines = sent.logs.flatMap(item => item.lines).join('\n');
    assert.ok(lines.includes('the waiting fault happened here') && lines.includes('before the fault'), 'the excerpt of the moment is what is sent');
    assert.ok(!lines.includes('a completely different session'), 'not the next session\'s log');
    // the same fields as a report sent at once: source ids with their lines
    assert.deepEqual(sent.logs.map(item => Object.keys(item)), sent.logs.map(() => ['source', 'lines']));
    assert.equal(sent.logs[0].source, 'bridge-stderr');
    assert.ok(!backend.calls.at(-1).raw.includes(secret) && !backend.calls.at(-1).raw.includes('PlantedPlayerName'));
  } finally { reporter.close(); await f.cleanup(); }
});

test('the excerpt belongs to the first time the error was seen: a repeat bumps the count and keeps it; an older queue file with none reads the log when sent', async () => {
  const f = await folders();
  const clock = {now: START};
  const backend = fakeBackend({clock});
  const reporter = reporterFor(f, backend, clock);
  const logPath = join(f.state, 'bridge.stderr.log');
  try {
    await writeFile(logPath, 'first sight: Error: a repeating fault happened\n');
    await recordErrorEvent(f.state, {kind: 'turn-failed', message: 'a repeating fault happened', frame: 'x.mjs:1 a'}, {now: clock.now});
    await reporter.look({flush: false});
    await writeFile(logPath, 'second sight: Error: a repeating fault happened\n');
    await recordErrorEvent(f.state, {kind: 'turn-failed', message: 'a repeating fault happened', frame: 'x.mjs:1 a'}, {now: clock.now});
    await reporter.look({flush: false});
    const [record] = await readQueue(f.state, {now: clock.now});
    assert.equal(record.count, 2);
    assert.ok(JSON.stringify(record.logs).includes('first sight') && !JSON.stringify(record.logs).includes('second sight'));
    // a record written before this change (no excerpt): the log is read when it is sent, as before
    await rm(record.path);
    await writeFile(logPath, 'read at send time: Error: an old queue fault happened\n');
    await recordErrorEvent(f.state, {kind: 'turn-failed', message: 'an old queue fault happened', frame: 'x.mjs:2 b'}, {now: clock.now});
    await reporter.flush();
    assert.ok(backend.calls.at(-1).body.report.logs.flatMap(item => item.lines).join('\n').includes('read at send time'));
    // a kept excerpt that was edited is checked again: an unknown source or a non-text line is dropped
    const edited = {...record, logs: [{source: 'not-a-source', lines: ['x']}, {source: 'service', lines: ['fine line', 42, {a: 1}]}]};
    const {payload} = await buildErrorPayload({record: edited, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], graphics: () => [], secrets: [], now: () => START});
    assert.deepEqual(payload.report.logs, [{source: 'service', lines: ['fine line']}]);
  } finally { reporter.close(); await f.cleanup(); }
});

test('a supervisor event is captured at once with its log lines (no wait for the five-minute look)', async () => {
  const f = await folders();
  const clock = {now: START};
  const reporter = reporterFor(f, fakeBackend({clock}), clock);
  try {
    await writeFile(join(f.state, 'bridge-service.log'), 'service log line of the moment\n');
    await reporter.record({kind: 'service-failed', message: 'The service failed to start', frame: 'supervisor'});
    const [record] = await readQueue(f.state, {now: clock.now});
    assert.ok(Array.isArray(record.logs));
    assert.ok(JSON.stringify(record.logs).includes('service log line of the moment'));
  } finally { reporter.close(); await f.cleanup(); }
});

test('an e-mail address in a log line never reaches a report or the queue file; package versions and handles are not mistaken for one', async () => {
  const {createRedactor} = await import('./support-report.mjs');
  const redact = createRedactor({secrets: []});
  assert.equal(redact.text('Mistral said: contact jane.doe+cp@example.co.uk for access'), 'Mistral said: contact [email-redacted] for access');
  assert.equal(redact.text('rate limited for a.b@mail.example.com.'), 'rate limited for [email-redacted].');
  for (const kept of ['pocket-tts@1.2.3 loaded', 'at (file:///x/y.mjs:3:1)', 'user@localhost', '@scope/pkg 2.0', 'ratio 1@2']) assert.equal(redact.text(kept), kept);
  // the kept excerpt of a waiting report is scrubbed at capture
  const f = await folders();
  const clock = {now: START};
  const reporter = reporterFor(f, fakeBackend({clock}), clock);
  try {
    await writeFile(join(f.state, 'bridge.stderr.log'), 'Error: the mail fault happened: provider says write to someone@example.org please\n');
    await recordErrorEvent(f.state, {kind: 'turn-failed', message: 'the mail fault happened', frame: 'x.mjs:1 a'}, {now: clock.now});
    await reporter.look({flush: false});
    const [record] = await readQueue(f.state, {now: clock.now});
    assert.ok(!JSON.stringify(record).includes('someone@example.org'));
    assert.ok(JSON.stringify(record.logs).includes('[email-redacted]'));
  } finally { reporter.close(); await f.cleanup(); }
});

test('the client\'s daily limit stays below what the backend allows per install, in the code defaults (the figure is in no doc)', async () => {
  const {DEFAULTS} = await import('../auth-backend/api/_lib/config.js');
  assert.ok(DEFAULTS.errorInstallPerDay > DAILY_LIMIT, `backend ${DEFAULTS.errorInstallPerDay} must be above the client's ${DAILY_LIMIT}`);
  assert.ok(QUEUE_MAX > DAILY_LIMIT, 'the queue holds more than a day\'s reports');
});

// 2026-10-22 reports c8281dee, 1a895674 and ee4689b6: the player's own setup is already told in the game, so it is no error report.
test('a custom provider that does not know the typed model, and a Local AI server of the player that does not answer, are not reported', async () => {
  const unknownModel = new Error('The custom provider does not know that model: mistralai/mistral-7b-instruct:free is no longer available on OpenRouter [custom:model]');
  assert.equal(reportableTurnFailure(unknownModel), false);
  assert.equal(reportableTurnFailure(unknownModel, {errorCode: 'custom-model'}), false);
  for (const word of ['server-unreachable', 'server-blocked', 'server-key-refused', 'server-bad-address']) {
    const error = new Error(`LocalAiUnavailable: [local:unavailable] the local model server did not start (${word})`);
    assert.equal(reportableTurnFailure(error, {errorCode: 'local-unavailable', localReason: 'start-failed'}), false, word);
  }
  // Our own server failing to start, and other custom provider failures, still count.
  assert.equal(reportableTurnFailure(new Error('[local:unavailable] the local model server did not start (exited)'), {errorCode: 'local-unavailable', localReason: 'start-failed'}), true);
  assert.equal(reportableTurnFailure(new Error('The custom provider did not answer in time [custom:network]')), true);
  assert.equal(reportableTurnFailure(new Error('The custom provider answered with an empty reply [custom:empty]')), true);
  const f = await folders();
  try {
    const deferred = [];
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => deferred.push(fn)});
    events.turnFailed(unknownModel, {provider: 'custom'});
    // The setup check: Local AI that could not start because the player's server is down or blocked is no problem report; our own failed start is.
    events.setupChecked({checks: [{id: 'local-ai', state: 'problem', code: 'start-failed', selected: true, installed: true, playerServer: true}]});
    assert.equal(deferred.length, 0, 'nothing is queued for either');
    events.setupChecked({checks: [{id: 'local-ai', state: 'problem', code: 'start-failed', selected: true, installed: true}]});
    assert.equal(deferred.length, 1);
  } finally { await f.cleanup(); }
});
