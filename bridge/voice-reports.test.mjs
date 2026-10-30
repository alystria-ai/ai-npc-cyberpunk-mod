import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ErrorEvents, cleanVoice, errorSignature, queueRecord, readQueue} from './error-events.mjs';
import {buildErrorPayload, reportCleaner} from './error-reports.mjs';
import {tailLines} from './voice-failures.mjs';
import {blockedByWindows, permanentVoiceFailure, voiceFailureCause} from './voice-selection.mjs';

// Voice failures as error reports: the facts a triage asks first (which voice, who speaks now, text only or not, the card and its memory, the worker's last lines),
// rebuilt field by field, scrubbed, and sent once per distinct reason.
const START = Date.parse('2026-10-27T09:00:00Z');
const INSTALL = 'a1b2c3d4e5f60718293a4b5c';

async function folders() {
  const base = await mkdtemp(join(tmpdir(), 'voice-reports-'));
  const game = join(base, 'game'), modRoot = join(game, 'mods', 'AiNpcCyberpunkMod'), runtime = join(modRoot, 'runtime'), state = join(base, 'state'), project = join(base, 'app');
  for (const folder of [runtime, state, project]) await mkdir(folder, {recursive: true});
  await writeFile(join(runtime, 'settings.json'), JSON.stringify({errorReportsNoticed: true}));
  return {base, game, modRoot, runtime, state, project, cleanup: () => rm(base, {recursive: true, force: true})};
}

const untilQueued = async (f, count) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await readQueue(f.state, {now: START})).length >= count) return;
    await new Promise(done => setTimeout(done, 5));
  }
};

const FAILURE = {engine: 'omni', reason: 'Local voice worker exited (1): ImportError: DLL load failed while importing _regex: An Application Control policy has blocked this file.',
  cause: 'windows-blocked', requested: 'omni', active: 'text', fellBackTo: 'text', silent: false,
  tail: ['File "C:\\Users\\PlantedPlayerName\\app\\x.py", line 3, in <module>', 'ImportError: DLL load failed while importing _regex: An Application Control policy has blocked this file.']};

test('cleanVoice rebuilds the section: fixed words, bounded numbers, vendors from a list, a few bounded lines; anything else is dropped', () => {
  const clean = cleanVoice({requested: 'omni', active: 'pocket', fellBackTo: 'text', silent: true, cause: 'no-cuda', gpuVendors: ['amd', 'a sentence the player said', 'intel', 'nvidia', 'other', 'amd'],
    vramTotalMiB: 16303.4, vramFreeMiB: -5, turns: 1e12, lastStage: 'ttsSent', reasons: ['omni', 'two words'], tail: Array.from({length: 12}, (_, index) => `line ${index} ${'x'.repeat(300)}`),
    stolen: 'the player said hello to Judy', nested: {text: 'x'}});
  assert.deepEqual(Object.keys(clean).sort(), ['active', 'cause', 'fellBackTo', 'fellBackToText', 'gpuVendors', 'lastStage', 'playbackOff', 'reasons', 'requested', 'tail', 'turns', 'vramFreeMiB', 'vramTotalMiB']);
  assert.equal(clean.fellBackToText, true, 'subtitles only');
  assert.deepEqual(clean.gpuVendors, ['amd', 'intel', 'nvidia', 'other']);
  assert.equal(clean.vramTotalMiB, 16303.4);
  assert.equal(clean.vramFreeMiB, 0, 'a negative number is held at zero');
  assert.equal(clean.turns, 1e6, 'a number is bounded');
  assert.deepEqual(clean.reasons, ['omni']);
  assert.equal(clean.tail.length, 8);
  assert.ok(clean.tail.every(line => line.length <= 200));
  assert.equal(cleanVoice(null), null);
  assert.equal(cleanVoice({stolen: 'x'}), null);
  assert.equal(cleanVoice({fellBackTo: 'pocket'}).fellBackToText, false);
  assert.equal(queueRecord({kind: 'turn-failed', message: 'x', voice: {cause: 'timeout'}}).voice, undefined, 'only a voice failure carries the section');
});

test('tailLines keeps the last lines of a worker\'s stderr, bounded, without control characters', () => {
  assert.deepEqual(tailLines('a\r\n\r\nb\u0000c\nd', 2), ['b c', 'd']);
  assert.deepEqual(tailLines(undefined), []);
  assert.equal(tailLines('x'.repeat(500))[0].length, 200);
  assert.equal(tailLines(Array.from({length: 30}, (_, index) => `l${index}`).join('\n')).length, 8);
});

test('the cause of a voice failure is one word', () => {
  const cases = [['DLL load failed while importing _regex: An Application Control policy has blocked this file.', 'windows-blocked'], ['The paging file is too small for this operation to complete', 'virtual-memory'],
    ['Local voice worker exited (1): needs CUDA', 'unknown'], ['CUDA out of memory. Tried to allocate 2 GiB', 'out-of-memory'], ['Local voice preparation timed out', 'timeout'],
    ['Pocket source differs from the pinned official revision', 'integrity'], ['ModuleNotFoundError: No module named torch', 'missing-files'], ['something else entirely', 'unknown']];
  for (const [reason, cause] of cases) assert.equal(voiceFailureCause(reason), cause, reason);
});

test('a voice failure is queued with the voice section, the card and its free memory, once per reason, and reaches the report scrubbed', async () => {
  const f = await folders();
  try {
    let reads = 0;
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(),
      voiceHardware: async () => { reads += 1; return {gpuVendors: ['nvidia', 'amd'], vramTotalMiB: 16303, vramFreeMiB: 1200}; }});
    events.voiceFailed(FAILURE);
    events.voiceFailed(FAILURE);
    await untilQueued(f, 1);
    await new Promise(done => setTimeout(done, 30));
    const queue = await readQueue(f.state, {now: START});
    assert.equal(queue.length, 1, 'once per reason');
    assert.equal(reads, 2, 'the hardware is asked only when a voice fails');
    const [record] = queue;
    assert.equal(record.kind, 'voice-failed');
    assert.match(record.message, /^omni: Local voice worker exited \(1\)/);
    assert.deepEqual([record.voice.requested, record.voice.active, record.voice.fellBackTo, record.voice.fellBackToText, record.voice.cause],
      ['omni', 'text', 'text', true, 'windows-blocked']);
    assert.deepEqual([record.voice.gpuVendors, record.voice.vramTotalMiB, record.voice.vramFreeMiB], [['nvidia', 'amd'], 16303, 1200]);
    const {payload, body} = await buildErrorPayload({record, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project, installId: INSTALL,
      environment: {}, names: ['PlantedPlayerName'], now: () => START, graphics: () => [{name: 'NVIDIA GeForce RTX 5070 Ti', memoryMiB: 16303}, {name: 'AMD Radeon(TM) Graphics', memoryMiB: 512}],
      memory: () => ({totalRamMiB: 31901, commitLimitMiB: 53405}), gameInfo: {game: '2.5'}});
    assert.equal(payload.report.voice.cause, 'windows-blocked');
    assert.equal(payload.report.voice.tail.length, 2, 'the worker\'s last lines');
    assert.ok(payload.report.voice.tail[1].includes('Application Control'));
    assert.ok(!body.includes('PlantedPlayerName'), 'the account name is scrubbed from the lines');
    assert.equal(payload.report.system.gpu[0].name, 'NVIDIA GeForce RTX 5070 Ti');
    const other = await buildErrorPayload({record: {...record, kind: 'turn-failed'}, game: f.game, modRoot: f.modRoot, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      installId: INSTALL, environment: {}, names: [], now: () => START, graphics: () => [], gameInfo: {}});
    assert.equal(other.payload.report.voice, undefined, 'another kind never carries the voice section');
  } finally { await f.cleanup(); }
});

test('a hardware read that fails, or no reader at all, still sends the failure with the rest', async () => {
  const f = await folders();
  try {
    const broken = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(), voiceHardware: async () => { throw new Error('nvidia-smi is not there'); }});
    broken.voiceFailed({engine: 'pocket', reason: 'Pocket student runtime is unavailable (ImportError)', cause: 'unknown', requested: 'pocket', active: 'text', fellBackTo: 'text'});
    const plain = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    plain.voiceFailed({engine: 'v-helper', reason: 'Pocket student startup stalled', cause: 'unknown', requested: 'omni', active: 'omni', fellBackTo: 'silent'});
    await untilQueued(f, 2);
    const queue = await readQueue(f.state, {now: START});
    assert.equal(queue.length, 2);
    for (const record of queue) assert.equal(record.voice.vramFreeMiB, undefined);
    assert.equal(queue.find(record => /^v-helper/.test(record.message)).voice.fellBackToText, false, 'V\'s own worker is silent, not text');
  } finally { await f.cleanup(); }
});

test('"the voice never played" is one voice-failed report with the counts and the stage, once, and nothing of any turn\'s text', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(), voiceHardware: async () => ({gpuVendors: ['amd'], vramTotalMiB: 16304})});
    const data = {engine: 'omni', requested: 'omni', active: 'omni', fellBackTo: 'omni', turns: 4, silentTurns: 4, playedTurns: 0, lastStage: 'ttsSent', reasons: ['omni', 'omni'],
      text: 'the player said something', tail: ['not allowed to ride along?']};
    events.voiceSilent(data);
    events.voiceSilent(data);
    await untilQueued(f, 1);
    await new Promise(done => setTimeout(done, 30));
    const queue = await readQueue(f.state, {now: START});
    assert.equal(queue.length, 1);
    const [record] = queue;
    assert.deepEqual([record.kind, record.message, record.frame, record.detail.engine], ['voice-failed', 'voice never played this session', 'voice-silence', 'omni']);
    assert.deepEqual([record.voice.cause, record.voice.turns, record.voice.silentTurns, record.voice.playedTurns, record.voice.lastStage], ['never-played', 4, 4, 0, 'ttsSent']);
    assert.deepEqual(record.voice.gpuVendors, ['amd']);
    assert.ok(!JSON.stringify(record).includes('the player said'), 'no text rides along');
  } finally { await f.cleanup(); }
});

// Triage 2026-10-30 (error signature 966a31e3): 4 of the 9 "voice never played" rows came from runs whose voice had already fallen back to text after a voice failure that was reported.
test('"the voice never played" is not reported when the voice fell back to text after a failure that was itself reported; every other silent voice still is', async () => {
  const silent = {engine: 'pocket', requested: 'pocket', active: 'text', fellBackTo: 'text', turns: 3, silentTurns: 3, playedTurns: 0, lastStage: 'published', reasons: ['pocket']};
  // The failure is reported first: one row, no second one for the same fault.
  let f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'pocket', reason: 'Pocket student runtime is unavailable (ImportError)', cause: 'unknown', requested: 'pocket', active: 'text', fellBackTo: 'text'});
    events.voiceSilent(silent);
    await untilQueued(f, 1);
    await new Promise(done => setTimeout(done, 40));
    const queue = await readQueue(f.state, {now: START});
    assert.deepEqual(queue.map(record => record.frame), ['voice-selection']);
  } finally { await f.cleanup(); }
  // The same failure reported earlier in the run and now a repeat of it (already queued): still counts as reported.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    const failure = {engine: 'pocket', reason: 'Pocket student runtime is unavailable (ImportError)', cause: 'unknown', requested: 'pocket', active: 'pocket', fellBackTo: 'pocket'};
    events.voiceFailed(failure);
    events.voiceFailed({...failure, active: 'text', fellBackTo: 'text'});
    events.voiceSilent({...silent, fellBackTo: 'pocket'});
    await untilQueued(f, 1);
    await new Promise(done => setTimeout(done, 40));
    assert.deepEqual((await readQueue(f.state, {now: START})).map(record => record.frame), ['voice-selection']);
  } finally { await f.cleanup(); }
  // No failure behind it: the silent voice is reported, text or not.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceSilent(silent);
    await untilQueued(f, 1);
    assert.deepEqual((await readQueue(f.state, {now: START})).map(record => record.frame), ['voice-silence']);
  } finally { await f.cleanup(); }
  // A failure that did not end as text (Omni failed, Pocket speaks) does not hide a voice that then never played.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'omni', reason: 'OmniVoice timed out', cause: 'timeout', requested: 'omni', active: 'omni', fellBackTo: 'pocket'});
    events.voiceSilent({...silent, active: 'pocket', fellBackTo: 'pocket'});
    await untilQueued(f, 2);
    assert.deepEqual((await readQueue(f.state, {now: START})).map(record => record.frame).sort(), ['voice-selection', 'voice-silence']);
  } finally { await f.cleanup(); }
  // A failure whose report could not be made (V's own worker is 'silent', not text) hides nothing either.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'v-helper', reason: 'Pocket student startup stalled', cause: 'unknown', requested: 'pocket', active: 'text', fellBackTo: 'silent'});
    events.voiceSilent(silent);
    await untilQueued(f, 2);
    assert.deepEqual((await readQueue(f.state, {now: START})).map(record => record.frame).sort(), ['voice-selection', 'voice-silence']);
  } finally { await f.cleanup(); }
});

test('"the voice never played" in a run whose hidden browser would not start says that, with the browser\'s own lines (install 0d0750, 27 Oct 2026)', async () => {
  const f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceSilent({engine: 'pocket', requested: 'pocket', active: 'pocket', fellBackTo: 'pocket', turns: 3, silentTurns: 3, playedTurns: 0, lastStage: 'published', reasons: ['pocket'],
      browser: {message: 'Microsoft Edge was found but would not start: Target page, context or browser has been closed (exit code 21)', diagnostic: ['GPU process isn\'t usable. Goodbye.', '<process did exit: exitCode=21, signal=null>']}});
    await untilQueued(f, 1);
    const [record] = await readQueue(f.state, {now: START});
    assert.equal(record.message, 'voice never played this session: the hidden browser would not start');
    assert.equal(record.voice.cause, 'browser-failed');
    assert.deepEqual(record.voice.tail, ['Microsoft Edge was found but would not start: Target page, context or browser has been closed (exit code 21)', 'GPU process isn\'t usable. Goodbye.', '<process did exit: exitCode=21, signal=null>']);
  } finally { await f.cleanup(); }
});

// Triage 2026-10-30 (install 0d0750): the V line's browser failure (fallback 'silent') and the "voice never played, hidden browser" row were filed in the same second for one fault.
test('"the voice never played" says nothing more when the hidden browser\'s start failure was reported, whatever the fallback was; other silences are still reported', async () => {
  const browser = {message: 'Microsoft Edge was found but would not start: Target page, context or browser has been closed (exit code 3221225477)', diagnostic: ['first try, with the sandbox']};
  const silent = {engine: 'pocket', requested: 'pocket', active: 'pocket', fellBackTo: 'pocket', turns: 3, silentTurns: 3, playedTurns: 0, lastStage: 'published', reasons: ['pocket'], browser};
  const failure = {engine: 'v-line', reason: browser.message, cause: 'browser-failed', requested: 'pocket', active: 'pocket'};
  const rows = async (f, count) => { await untilQueued(f, count); await new Promise(done => setTimeout(done, 40)); return (await readQueue(f.state, {now: START})).map(record => record.frame).sort(); };
  for (const fellBackTo of ['silent', 'pocket', 'text']) {
    const f = await folders();
    try {
      const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
      events.voiceFailed({...failure, fellBackTo});
      events.voiceSilent({...silent, fellBackTo, active: fellBackTo === 'text' ? 'text' : 'pocket'});
      assert.deepEqual(await rows(f, 1), ['voice-selection'], `fallback ${fellBackTo}: one row for one fault`);
    } finally { await f.cleanup(); }
  }
  // The same browser failure noted again (already queued) still counts as reported.
  let f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({...failure, fellBackTo: 'silent'});
    events.voiceFailed({...failure, fellBackTo: 'silent'});
    events.voiceSilent({...silent, fellBackTo: 'silent'});
    assert.deepEqual(await rows(f, 1), ['voice-selection']);
  } finally { await f.cleanup(); }
  // A silence that is not about the browser (it runs now) is still reported after a browser failure, and so is a browser silence with no failure behind it.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({...failure, fellBackTo: 'silent'});
    events.voiceSilent({...silent, browser: undefined});
    assert.deepEqual(await rows(f, 2), ['voice-selection', 'voice-silence']);
  } finally { await f.cleanup(); }
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceSilent(silent);
    assert.deepEqual(await rows(f, 1), ['voice-silence']);
  } finally { await f.cleanup(); }
  // Another voice failure (not the browser) does not hide the browser silence.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn()});
    events.voiceFailed({engine: 'omni', reason: 'OmniVoice timed out', cause: 'timeout', requested: 'omni', active: 'omni', fellBackTo: 'pocket'});
    events.voiceSilent(silent);
    assert.deepEqual(await rows(f, 2), ['voice-selection', 'voice-silence']);
  } finally { await f.cleanup(); }
});

// Triage 2026-10-30 (signature 600c87b4, installs 5905ef, 60d462, afd170): OmniVoice needs CUDA on an AMD card, the replies fall back to text and the settings point to "OmniVoice for AMD".
test('OmniVoice without CUDA on an AMD card files no row, and its text fallback hides the "voice never played" row too; any other card is still reported', async () => {
  const noCuda = {engine: 'omni', reason: 'Local voice worker needs CUDA (no NVIDIA graphics card that works)', cause: 'no-cuda', requested: 'omni', active: 'text', fellBackTo: 'text', silent: false};
  const silent = {engine: 'omni', requested: 'omni', active: 'text', fellBackTo: 'text', turns: 3, silentTurns: 3, playedTurns: 0, lastStage: 'published', reasons: ['omni']};
  const settle = async f => { await new Promise(done => setTimeout(done, 60)); return (await readQueue(f.state, {now: START})).map(record => record.frame); };
  let f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(), voiceHardware: async () => ({gpuVendors: ['amd'], vramTotalMiB: 16304})});
    events.voiceFailed({...noCuda, amdCard: true});
    events.voiceSilent(silent);
    assert.deepEqual(await settle(f), [], 'nothing is queued for an expected fallback');
  } finally { await f.cleanup(); }
  // Any other card (Intel only, an AMD part that is not on the AMD route, no card list): the failure is reported as before.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(), voiceHardware: async () => ({gpuVendors: ['intel']})});
    events.voiceFailed(noCuda);
    await untilQueued(f, 1);
    const [record] = await readQueue(f.state, {now: START});
    assert.deepEqual([record.kind, record.voice.cause, record.voice.fellBackToText], ['voice-failed', 'no-cuda', true]);
  } finally { await f.cleanup(); }
  // The flag is only about the missing CUDA: another failure on the same PC is reported.
  f = await folders();
  try {
    const events = new ErrorEvents({stateDirectory: f.state, runtime: f.runtime, now: () => START, defer: fn => fn(), voiceHardware: async () => ({gpuVendors: ['amd']})});
    events.voiceFailed({...noCuda, reason: 'OmniVoice timed out', cause: 'timeout', amdCard: true});
    await untilQueued(f, 1);
    assert.equal((await readQueue(f.state, {now: START})).length, 1);
  } finally { await f.cleanup(); }
});

test('a failure of the hidden browser is its own cause for a V line or a voice report', () => {
  assert.equal(voiceFailureCause('Microsoft Edge was found but would not start: Target page, context or browser has been closed'), 'browser-failed');
  assert.equal(voiceFailureCause('Brave is set as the browser but its program is not there'), 'browser-failed');
  assert.equal(voiceFailureCause('Local voice preparation timed out'), 'timeout');
});

test('the bridge asks the card for a failed voice only, and V\'s line that failed or finished without any sound is reported by its summary', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /new ErrorEvents\(\{stateDirectory, runtime, voiceHardware\}\)/);
  assert.match(bridge, /summary\.result === 'dropped' && \(summary\.reason === 'failed' \|\| summary\.reason === 'no-audio'\)/);
  const line = await readFile(new URL('./v-voice.mjs', import.meta.url), 'utf8');
  assert.match(line, /this\.failure = String\(error\?\.message \?\? error\)/);
  assert.match(line, /\.\.\.\(this\.failure \? \{failure: this\.failure\} : \{\}\)/);
});

test('a DLL that Windows blocked is recognised in the language of the PC, so it is not retried (a Spanish PC, 27 Oct 2026)', () => {
  const spanish = 'Local voice worker exited (1): ImportError: DLL load failed while importing _regex: Una directiva de Control de aplicaciones bloqueó este archivo.';
  assert.equal(blockedByWindows(spanish), true);
  assert.equal(permanentVoiceFailure(spanish), 'Windows blocked a file of the voice', 'no retry after 45 s, 3 min and 10 min');
  assert.equal(voiceFailureCause(spanish), 'windows-blocked');
  for (const text of ['DLL load failed while importing _regex: Eine Anwendungssteuerungsrichtlinie hat diese Datei blockiert.', 'DLL load failed while importing x: Une stratégie a bloqué ce fichier.',
    'DLL load failed while importing x: Политика заблокировала этот файл.']) assert.equal(blockedByWindows(text), true, text);
  for (const text of ['DLL load failed while importing _minpack: The specified module could not be found.', 'DLL load failed while importing x: No se encontró el módulo especificado.',
    'DLL load failed while importing x: Acceso denegado.', 'Pocket student startup stalled', 'CUDA out of memory']) assert.equal(blockedByWindows(text), false, text);
});

test('the organisation id of a provider is scrubbed from a report, and the same refusal of two accounts is one signature', () => {
  const answer = org => `custom: MistralError: The custom provider refused the request: Request too large for model openai/gpt-oss-120b in organization ${org} service tier on_demand on tokens per minute (TPM): Limit 8000, Requested 8626`;
  assert.equal(errorSignature({kind: 'turn-failed', message: answer('org_01m5w39tn6ewg9f0ccksqgt74h'), frame: 'mistral-client.mjs:239 make'}),
    errorSignature({kind: 'turn-failed', message: answer('org_01abcdefghijk1234567890xyz'), frame: 'mistral-client.mjs:239 make'}));
  const {clean} = reportCleaner({});
  const text = clean(answer('org_01m5w39tn6ewg9f0ccksqgt74h'));
  assert.ok(!text.includes('01m5w39tn6ew') && text.includes('org_[id]') && text.includes('Limit 8000'), text);
});
