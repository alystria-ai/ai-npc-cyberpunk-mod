import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {VoiceSelection} from './voice-selection.mjs';
import {planTurnVoice} from './multilingual.mjs';
import {describeVoiceRoute, formatVoiceRoute, fallbackReason, requestedLabel, referenceOf, VoiceRoutingLog,
  ROUTING_LOG_NAME, ROUTING_LOG_MAX_LINES} from './voice-routing-log.mjs';
import {collectReport} from './support-report.mjs';
import {fakeInstall} from './support-report-fixture.mjs';

const runtime = Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory']
  .map(key => [key, resolve('fixture', key)]));
const ready = (set, name, seconds) => ({reference: `runtime/voice-references/${set}/${name}.wav`, sha256: 'a'.repeat(64),
  transcript: 'A line that must never reach the routing log.', ...(seconds ? {pick: {seconds}} : {})});
const pocketConfig = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices, runtime,
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});
const omniConfig = voices => ({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices});

const pocketVoices = () => ({'judy-alvarez': ready('picked/autobest/pocket', 'judy-alvarez', 19.58),
  'npc-maelstrom-male': ready('picked/autobest/pocket', 'npc-maelstrom-male', 19.92),
  'npc-maelstrom-male-v2': ready('picked/autobest/pocket', 'npc-maelstrom-male-v2', 18),
  'resident-male': {status: 'unprepared'}, 'resident-female': {status: 'unprepared'}});
const omniVoices = set => ({'judy-alvarez': ready(`picked/autobest/omni-${set}`, 'judy-alvarez', set === 'short' ? 7.79 : 13.38),
  'resident-male': {status: 'unprepared'}});

// Routing is read from the selection's state; a worker that never loads keeps the tests off the GPU and the CPU.
const idleWorker = () => ({loaded: false, async start() {}, async close() {}, setSteps() {}, setKeepPrepared() {},
  hasProfile: () => false, profileReady: () => false});
function fixture({omniPack, settings = {voiceProvider: 'pocket'}} = {}) {
  const pocket = pocketConfig(pocketVoices()), omni = {short: omniConfig(omniVoices('short')), long: omniConfig(omniVoices('long'))};
  const voice = new VoiceSelection(pocket, {omniConfigs: omni, omniPack, previewSettleMs: 0,
    factory: idleWorker, omniFactory: idleWorker});
  voice.update(settings, null, false);
  return {voice, sources: {pocket, omni}};
}
const JUDY = {key: 'judy-alvarez', name: 'Judy Alvarez', voiceName: 'Ava (Warm Young-Adult American Female)'};
const RESIDENT = {key: 'resident-male', name: 'NC Resident', voiceName: 'Julia (Expressive Young-Adult American Female)'};
const planFor = (voice, profile, {enabled = false, language = 'en'} = {}) => planTurnVoice({enabled, language,
  local: {uses: voice.usesProfile(profile), provider: voice.provider, convai: voice.convaiVoiceAllowed}});
const route = (h, profile, reply, extra = {}) => {
  const plan = extra.plan ?? planFor(h.voice, profile.key);
  return describeVoiceRoute({voice: h.voice, input: {profileKey: profile.key}, profile, plan,
    reply: reply ?? {engine: plan.engine, language: plan.language}, sources: h.sources, now: () => new Date(2026, 9, 8, 14, 3, 21).getTime(), ...extra});
};

test('a generic NC resident with no local reference gets a written reply (never the Convai cloud voice) and the line says why', () => {
  const h = fixture();
  const record = route(h, RESIDENT);
  assert.equal(record.engine, 'none');
  assert.equal(record.fallback, 'no local reference for this profile');
  assert.equal(formatVoiceRoute(record),
    '2026-10-08 14:03:21 profile=resident-male name="NC Resident" requested="Pocket · Performance" '
    + 'used="none (written reply only)" ref=- '
    + 'fallback="no local reference for this profile"');
});

test('with the Convai voice chosen on purpose the line names it, with no fallback', () => {
  const h = fixture({settings: {voiceProvider: 'convai'}});
  const record = route(h, RESIDENT);
  assert.equal(record.engine, 'convai'); assert.equal(record.fallback, null);
  assert.equal(formatVoiceRoute(record), '2026-10-08 14:03:21 profile=resident-male name="NC Resident" requested="Convai · Cloud voice" '
    + 'used="Convai cloud (Julia (Expressive Young-Adult American Female))" ref=-');
});

test('a prepared Pocket character reports Pocket, its reference set and seconds, and no fallback', () => {
  const h = fixture();
  const record = route(h, JUDY);
  assert.equal(record.fallback, null);
  assert.equal(formatVoiceRoute(record),
    '2026-10-08 14:03:21 profile=judy-alvarez name="Judy Alvarez" requested="Pocket · Performance" used="Pocket" '
    + 'ref="picked/autobest/pocket 19.58s"');
});

test('an ambient voice variant is named by its own key; routing facts stay on the profile', () => {
  const h = fixture();
  const profile = {key: 'npc-maelstrom-male', name: 'Maelstrom Ganger'};
  const line = formatVoiceRoute(route(h, profile, undefined, {voiceKey: 'npc-maelstrom-male-v2'}));
  assert.match(line, /profile=npc-maelstrom-male voice=npc-maelstrom-male-v2 /);
  assert.match(line, /ref="picked\/autobest\/pocket 18s"/);
  assert.doesNotMatch(line, /fallback=/);
});

test('OmniVoice reports its tier, steps, reference choice and the language of a multilingual reply', () => {
  const h = fixture({settings: {voiceProvider: 'omni', omniSteps: 16, omniReference: 'short'}});
  const plan = planFor(h.voice, 'judy-alvarez', {enabled: true, language: 'es'});
  const line = formatVoiceRoute(route(h, JUDY, {engine: 'omni', language: 'es'}, {plan, voiceKey: 'judy-alvarez', lipText: true}));
  assert.equal(line, '2026-10-08 14:03:21 profile=judy-alvarez name="Judy Alvarez" requested="OmniVoice · Balanced" '
    + 'used="OmniVoice 16 short" ref="picked/autobest/omni-short 7.79s" lang=es lipText=yes');
  assert.equal(requestedLabel('omni', 32, 'long'), 'OmniVoice · Ultra Quality');
  assert.equal(requestedLabel('convai'), 'Convai · Cloud voice');
});

test('fallback reasons: missing Omni pack, failed worker, Multilingual non-English, written reply only', () => {
  const missing = fixture({omniPack: {installed: false, missing: ['python']}, settings: {voiceProvider: 'omni', omniReference: 'short'}});
  assert.equal(missing.voice.provider, 'text');
  assert.equal(formatVoiceRoute(route(missing, JUDY)).includes('used="none (written reply only)"'), true, 'no Pocket and no cloud voice speaks');
  assert.equal(route(missing, JUDY).engine, 'none');
  assert.equal(route(missing, JUDY).fallback, 'Omni pack missing');
  assert.equal(route(missing, RESIDENT).fallback, 'Omni pack missing', 'the pack explains it before the profile does');

  const failed = fixture();
  failed.voice.failedBackends.add('pocket'); failed.voice.applyWhenIdle(false);
  assert.equal(route(failed, JUDY).fallback, 'Pocket worker unavailable');
  // A Pocket that failed is loaded again by the poll (VoiceSelection.pocketRetry), and the log says so until it gives up.
  failed.voice.pocketRetry = {failures: 1, nextAt: 0};
  assert.equal(route(failed, JUDY).fallback, 'Pocket still loading (retrying in the background)');
  failed.voice.pocketRetry = null;

  // An Omni that failed is retried in the background, and the log says so until it gives up.
  const loading = fixture({settings: {voiceProvider: 'omni', omniReference: 'short'}});
  loading.voice.failedBackends.add('omni'); loading.voice.omniRetry = {failures: 1, nextAt: 0}; loading.voice.applyWhenIdle(false);
  assert.equal(loading.voice.provider, 'text');
  assert.equal(route(loading, JUDY).fallback, 'Omni still loading (retrying in the background)');
  loading.voice.omniRetry = null;
  assert.equal(route(loading, JUDY).fallback, 'Omni worker unavailable');

  // A Pocket pairing and a non-English turn: Pocket speaks English only, so the turn is written (never sent to the cloud voice), and the log says why.
  const multi = fixture({settings: {voiceProvider: 'pocket'}});
  const plan = planFor(multi.voice, 'judy-alvarez', {enabled: true, language: 'de'});
  assert.equal(plan.engine, 'none');
  assert.equal(route(multi, JUDY, undefined, {plan}).fallback, 'Multilingual non-English reply: Pocket speaks English only');
  // Pocket still routes but the reply turned out to be non-English: the turn plan names it.
  const english = {engine: 'none', language: 'de', reason: 'english-only-voice'};
  assert.equal(route(fixture(), JUDY, undefined, {plan: english}).fallback, 'Multilingual non-English reply: Pocket speaks English only');
  assert.equal(route(multi, JUDY, {engine: 'none', language: 'de'}, {plan}).used, 'none (written reply only)');

  // The caller knows better than the routing state when a worker dies mid-reply.
  assert.equal(route(fixture(), JUDY, {engine: 'none'}, {reason: 'OmniVoice worker error: written reply only'}).fallback,
    'OmniVoice worker error: written reply only');
  assert.equal(fallbackReason(fixture({settings: {voiceProvider: 'convai'}}).voice, 'judy-alvarez', {engine: 'convai'}), null,
    'choosing Convai is not a fallback');
});

test('an Omni tier change that has not committed yet is called pending, not hidden', () => {
  const h = fixture({settings: {voiceProvider: 'omni', omniSteps: 16, omniReference: 'short'}});
  h.voice.request({voiceProvider: 'omni', omniSteps: 32, omniReference: 'short'});
  const plan = planFor(h.voice, 'judy-alvarez');
  assert.equal(route(h, JUDY, undefined, {plan}).fallback, 'OmniVoice tier change pending');
});

test('the line carries routing facts only: no transcript, no reply text, nothing multi-line', () => {
  const h = fixture();
  const line = formatVoiceRoute(route(h, {...JUDY, name: 'Judy\n"Alvarez"'}));
  assert.doesNotMatch(line, /must never reach|\n/);
  assert.equal(referenceOf(h.voice, 'pocket', 'resident-male', h.sources), null);
});

test('the rolling file keeps the last lines, echoes each line and never blocks the caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-routing-'));
  try {
    const echoed = [], log = new VoiceRoutingLog({path: join(dir, ROUTING_LOG_NAME), maxLines: 20, echo: line => echoed.push(line)});
    const h = fixture();
    for (let index = 0; index < 55; index++) log.record(route(h, {...JUDY, name: `Judy ${index}`}));
    assert.equal(echoed.length, 55);
    await log.flush();
    const lines = (await readFile(join(dir, ROUTING_LOG_NAME), 'utf8')).split('\n').filter(Boolean);
    assert(lines.length <= 22 && lines.length >= 20, `bounded (${lines.length})`);
    assert.match(lines.at(-1), /name="Judy 54"/);
    // A second writer (a restarted bridge) continues the same file and still trims it.
    const again = new VoiceRoutingLog({path: join(dir, ROUTING_LOG_NAME), maxLines: 20, echo: null});
    for (let index = 0; index < 10; index++) again.record(route(h, JUDY));
    await again.flush();
    assert((await readFile(join(dir, ROUTING_LOG_NAME), 'utf8')).split('\n').filter(Boolean).length <= 22);
    assert.equal(ROUTING_LOG_MAX_LINES, 500);
    // An unwritable location is swallowed.
    const broken = new VoiceRoutingLog({path: join(dir, ROUTING_LOG_NAME, 'nope', 'x.log'), echo: null});
    broken.record(route(h, JUDY)); await broken.flush();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the support report includes the tail of the routing log', async () => {
  const f = await fakeInstall();
  try {
    const h = fixture(), lines = [];
    for (let index = 0; index < 600; index++) lines.push(formatVoiceRoute(route(h, index % 2 ? JUDY : RESIDENT)));
    await f.put(join(f.runtime, ROUTING_LOG_NAME), `${lines.join('\n')}\n`);
    const {entries, summary} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-routing', issuedAt: Date.now(), lua: {}}, reportId: 'r-routing'});
    assert(summary.logs.some(row => row.id === 'voice-routing' && row.found), 'listed and found');
    const entry = entries.find(item => /-voice-routing\.txt$/.test(item.name));
    assert(entry, 'in the zip');
    assert.match(entry.data, /requested="Pocket · Performance" used="none \(written reply only\)"/);
    assert.doesNotMatch(entry.data, /used="Convai cloud/);
    assert.match(entry.data, /fallback="no local reference for this profile"/);
    assert.doesNotMatch(entry.data, /must never reach/);
  } finally { await f.cleanup(); }
});

// The bridge wiring: every way a reply ends up spoken (or shown as text) records exactly one line, and a failure to
// log can never change the reply.
const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const between = (start, end) => bridge.slice(bridge.indexOf(start), bridge.indexOf(end, bridge.indexOf(start)));

test('the bridge logs the cloud voice, written-only, Omni and Pocket replies once each at the point of decision', () => {
  const synthesize = between('async function synthesizeReply(', 'async function status(');
  const calls = synthesize.match(/logVoiceRoute\(/g) ?? [];
  assert.equal(calls.length, 7, 'cloud voice, written-only, Pocket without a clip in the language pack, Omni reply, Omni error, no streaming, Pocket');
  assert.match(between('async function convaiReply(', 'const state = await readSpeechState'), /logVoiceRoute\(input, profile, \{engine: 'convai'/);
  // Nothing is logged for a reply that is not spoken (voice playback off).
  assert.ok(synthesize.indexOf('playbackEnabled===false') < synthesize.indexOf('logVoiceRoute('));
  // Lip-sync text stage is only a yes/no receipt, never the text.
  assert.match(synthesize, /lipText: !!generated\.timing\?\.lipText/);
});

test('logVoiceRoute hands the record to the log and swallows any failure', () => {
  const recorded = [];
  const code = bridge.match(/function logVoiceRoute[\s\S]*?\r?\n}\r?\n/)[0];
  const sandbox = {recorded, routingLog: {record: record => recorded.push(record)}, voiceSources: {}, languagePackFor: () => null,
    localVoice: fixture().voice, turnVoice: () => ({engine: 'convai', language: null, reason: 'multilingual-off'}),
    describeVoiceRoute};
  runInNewContext(`${code};globalThis.api={logVoiceRoute};`, sandbox);
  sandbox.api.logVoiceRoute({profileKey: 'resident-male'}, RESIDENT, {engine: 'convai'});
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].profile, 'resident-male');
  assert.equal(recorded[0].fallback, 'no local reference for this profile');
  sandbox.routingLog.record = () => { throw Error('disk full'); };
  assert.doesNotThrow(() => sandbox.api.logVoiceRoute({profileKey: 'resident-male'}, RESIDENT, {engine: 'convai'}));
  assert.doesNotThrow(() => sandbox.api.logVoiceRoute(undefined, undefined, undefined));
});

test('the line names the Convai character the turn went to (original, romantic or multilingual twin)', () => {
  const voice = fixture().voice;
  const twin = describeVoiceRoute({voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy Alvarez'},
    reply: {engine: 'convai'}, character: {key: 'judy-alvarez-romantic-multilingual', id: '60e7c180-c21a-11f1-93e8-42010a7be02f'},
    now: () => Date.UTC(2026, 9, 8, 8, 0, 0)});
  const line = formatVoiceRoute(twin);
  assert.match(line, / character=judy-alvarez-romantic-multilingual characterId=60e7c180-c21a-11f1-93e8-42010a7be02f/);
  assert.ok(line.indexOf(' character=') > line.indexOf(' ref='), 'after the voice facts');
  // Without a known character (no admitted route) the field is left out.
  const unknown = formatVoiceRoute(describeVoiceRoute({voice, input: {profileKey: 'judy-alvarez'}, reply: {engine: 'convai'}}));
  assert.doesNotMatch(unknown, /character=/);
  // The bridge passes the admitted route's provider key and character ID.
  assert.match(bridge, /character = \{key: route\.route\?\.providerProfileKey \?\? input\.profileKey, id: characterId\}/);
});
