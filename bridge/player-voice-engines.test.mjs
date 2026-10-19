import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {AddonHost, inspectReference} from './addons.mjs';
import {PLAYER_REFERENCE_PREFIX, createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {validatePocketConfig} from './pocket-voice.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {InworldVoice} from './inworld-voice.mjs';
import {cloudReferenceOf, describeVoiceRoute, formatVoiceRoute, referenceOf} from './voice-routing-log.mjs';

// The player's own reference clip for a character (a story character, or one the player made): it stays in the player's data folder
// (<state>/player-voices/<key>.wav) and every voice engine resolves the fixed descriptor namespace `runtime/player-voices/` only inside
// that folder. Tiny generated WAVs only; no model, no network, no GPU.

// A 24 kHz mono PCM16 WAV of `seconds` of a sine at `hertz` (a different pitch is a different file, so a different hash).
function tone(seconds = 0.4, hertz = 220) {
  const frames = Math.round(seconds * 24000), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hertz * at / 24000) * 8000), 44 + at * 2);
  return bytes;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SECRET = 'A line the player typed that must never reach a log.';
const shipped = name => ({reference: `runtime/voice-references/picked/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Shipped words.'});

// ---- the registry -----------------------------------------------------------------------------------------------------------

const omniOf = reference => ({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: {'sam-hill': {reference, sha256: 'b'.repeat(64), transcript: 'A line.'}}});

test('registry: the player namespace is accepted in its one fixed shape, and every other spelling still throws', () => {
  assert.equal(PLAYER_REFERENCE_PREFIX, 'runtime/player-voices/');
  for (const good of ['runtime/player-voices/sam-hill.wav', 'runtime/player-voices/a.wav', `runtime/player-voices/${'a'.repeat(80)}.wav`,
    'runtime/voice-references/picked/x.wav', 'runtime/voice-references/x.wav']) {
    assert.ok(createVoiceProfileRegistry(omniOf(good)).has('sam-hill'), good);
  }
  for (const bad of ['runtime/player-voices/../sam-hill.wav', 'runtime/player-voices/a/b.wav', 'runtime/player-voices\\sam-hill.wav',
    'runtime/player-voices/a\\b.wav', 'runtime/player-voices/sam-hill.mp3', 'runtime/player-voices/Sam-Hill.wav', 'runtime/player-voices/.wav',
    'runtime/player-voices/-sam.wav', 'runtime/player-voices//sam-hill.wav', 'runtime/player-voices/sam-hill.wav:stream',
    `runtime/player-voices/${'a'.repeat(81)}.wav`, 'runtime/player-voices/sam hill.wav', 'runtime/player-voices/./sam-hill.wav',
    'runtime/player-voices', 'runtime/player-voices/', 'runtime/other-voices/sam-hill.wav', 'runtime/voice-references/../player-voices/sam-hill.wav',
    '/runtime/player-voices/sam-hill.wav', 'player-voices/sam-hill.wav', 'C:/player-voices/sam-hill.wav', 'runtime/player-voices/sam-hill.wav\n',
    'runtime/player-voices/sam-hill.wav\0', 'runtime/voice-references/a/../../x.wav', 'runtime/voice-references/a\\b.wav']) {
    assert.throws(() => createVoiceProfileRegistry(omniOf(bad)), /Invalid local voice reference/, JSON.stringify(bad));
  }
});

test('Pocket: validatePocketConfig accepts a player voice and the extra runtime field, and does not pass the folder on', () => {
  const runtime = Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory']
    .map(key => [key, resolve('player-fixtures', key)]));
  const folder = resolve('player-fixtures', 'player-voices');
  const config = {version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {...runtime, playerVoiceDirectory: folder},
    model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
      inputIdentity: 'e'.repeat(64), selectedStep: 1500},
    voices: {'sam-hill': {reference: 'runtime/player-voices/sam-hill.wav', sha256: 'f'.repeat(64), transcript: 'A line.'}},
    preparation: {startupProfiles: [], maxCachedProfiles: 2}};
  const checked = validatePocketConfig(config);
  assert.ok(checked.registry.has('sam-hill'));
  assert.deepEqual(Object.keys(checked.runtime).sort(), Object.keys(runtime).sort(), 'the worker reads the folder from its own configuration file');
  assert.throws(() => validatePocketConfig({...config, voices: {'sam-hill': {...config.voices['sam-hill'], reference: 'runtime/player-voices/a/b.wav'}}}),
    /Invalid local voice reference/);
});

// ---- the configuration merge ------------------------------------------------------------------------------------------------

async function rig() {
  const work = await mkdtemp(resolve(tmpdir(), 'convai-player-voices-'));
  const state = resolve(work, 'state'), player = resolve(state, 'player-voices'), pocketRefs = resolve(work, 'game/pocket-refs'), omniRefs = resolve(work, 'game/omni-refs');
  await mkdir(player, {recursive: true});
  const clips = {'sam-hill': tone(0.4, 220), 'judy-alvarez': tone(0.5, 330)};
  for (const [key, bytes] of Object.entries(clips)) await writeFile(resolve(player, `${key}.wav`), bytes);
  const write = (name, value) => writeFile(resolve(state, name), JSON.stringify(value));
  await write('pocket.json', {version: 1, provider: 'pocket', engine: 'pocket-tts',
    runtime: {referenceDirectory: pocketRefs, workDirectory: resolve(work, 'game/pocket-work')},
    preparation: {startupProfiles: ['judy-alvarez', 'panam-palmer'], maxCachedProfiles: 4},
    voices: {'judy-alvarez': shipped('pocket/judy'), 'panam-palmer': shipped('pocket/panam'), 'sam-hill': shipped('pocket/sam')}});
  await write('omni-short.json', {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16,
    preparation: {mode: 'lazy', startupProfiles: ['judy-alvarez', 'sam-hill']},
    voices: {'judy-alvarez': shipped('short/judy'), 'sam-hill': shipped('short/sam'), 'resident-male': {status: 'unprepared'}}});
  // The three original voices and no preparation policy: implicit eager (everything prepared at start) until the merge.
  await write('omni-long.json', {version: 1, provider: 'hybrid', engine: 'omnivoice', steps: 32,
    voices: {'johnny-silverhand': shipped('long/johnny'), 'judy-alvarez': shipped('long/judy'), 'panam-palmer': shipped('long/panam')}});
  const paths = {pocket: resolve(state, 'pocket.json'), omni: {short: resolve(state, 'omni-short.json'), long: resolve(state, 'omni-long.json')}, warnings: []};
  const calls = {copyFile: [], mkdir: []};
  const files = {readFile, writeFile, mkdir: async (...args) => { calls.mkdir.push(args[0]); return mkdir(...args); },
    copyFile: async (...args) => { calls.copyFile.push(args); return copyFile(...args); }};
  const logs = [];
  const host = new AddonHost({addons: [], log: line => logs.push(line)});
  const playerExtra = (key, extra = {}) => ({key, reference: resolve(player, `${key}.wav`), sha256: sha(clips[key]), transcript: SECRET, player: true, ...extra});
  const merge = (extra, options = {}) => host.voiceConfigPaths(paths, {stateDirectory: state, roots: [omniRefs], extra, playerVoiceDirectory: player, files, ...options});
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  return {work, state, player, pocketRefs, omniRefs, clips, paths, calls, logs, host, playerExtra, merge, json,
    cleanup: () => rm(work, {recursive: true, force: true})};
}
const exists = path => stat(path).then(() => true, () => false);

test('merge: a player clip overrides the shipped voice in all three configurations, copies nothing and is not prepared at start', async () => {
  const r = await rig();
  try {
    const merged = await r.merge([r.playerExtra('sam-hill'), r.playerExtra('judy-alvarez')]);
    assert.equal(merged.pocket, resolve(r.state, 'addons.pocket.json'));
    assert.equal(merged.omni.short, resolve(r.state, 'addons.omni-short.json'));
    assert.equal(merged.omni.long, resolve(r.state, 'addons.omni-long.json'));
    const descriptor = key => ({reference: `runtime/player-voices/${key}.wav`, sha256: sha(r.clips[key]), transcript: SECRET});
    // Pocket: both overridden, the other voice untouched, the keys leave the start-up list, the folder is told in runtime.
    const pocket = await r.json(merged.pocket);
    assert.deepEqual(pocket.voices['sam-hill'], descriptor('sam-hill'));
    assert.deepEqual(pocket.voices['judy-alvarez'], descriptor('judy-alvarez'));
    assert.deepEqual(pocket.voices['panam-palmer'], shipped('pocket/panam'));
    assert.deepEqual(pocket.preparation, {startupProfiles: ['panam-palmer'], maxCachedProfiles: 4});
    assert.equal(pocket.runtime.playerVoiceDirectory, r.player);
    assert.equal(pocket.runtime.referenceDirectory, r.pocketRefs, 'the shipped reference folder is unchanged');
    // OmniVoice short: lazy with an explicit, shorter list; top-level folder.
    const short = await r.json(merged.omni.short);
    assert.deepEqual(short.voices['sam-hill'], descriptor('sam-hill'));
    assert.deepEqual(short.voices['judy-alvarez'], descriptor('judy-alvarez'));
    assert.deepEqual(short.voices['resident-male'], {status: 'unprepared'});
    assert.deepEqual(short.preparation, {mode: 'lazy', startupProfiles: []});
    assert.equal(short.playerVoiceDirectory, r.player);
    // OmniVoice long: a v1 configuration of the three original voices; the added and the overridden key both leave the default start-up list.
    const long = await r.json(merged.omni.long);
    assert.equal(long.version, 2);
    assert.deepEqual(long.voices['sam-hill'], descriptor('sam-hill'));
    assert.deepEqual(long.voices['judy-alvarez'], descriptor('judy-alvarez'));
    assert.deepEqual(long.preparation, {mode: 'lazy', startupProfiles: ['johnny-silverhand', 'panam-palmer']});
    assert.equal(long.playerVoiceDirectory, r.player);
    // Each merged file is accepted by the checks the engines run on it.
    for (const config of [short, long]) createVoiceProfileRegistry(config);
    const runtime = Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve(r.work, key)]));
    validatePocketConfig({...pocket, runtime: {...runtime, playerVoiceDirectory: pocket.runtime.playerVoiceDirectory},
      model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1}});
    // Nothing was copied anywhere, no folder was made in the game folders, and the clips and the original files are as they were.
    assert.deepEqual(r.calls.copyFile, []);
    assert.deepEqual(r.calls.mkdir, []);
    assert.equal(await exists(resolve(r.work, 'game')), false);
    assert.deepEqual(await readFile(resolve(r.player, 'sam-hill.wav')), r.clips['sam-hill']);
    assert.deepEqual((await r.json(r.paths.pocket)).voices['sam-hill'], shipped('pocket/sam'));
    assert.deepEqual((await r.json(r.paths.omni.short)).preparation, {mode: 'lazy', startupProfiles: ['judy-alvarez', 'sam-hill']});
    assert.deepEqual(r.logs, []);
  } finally { await r.cleanup(); }
});

test('merge: three original voices with no policy stay valid when one is overridden (not prepared at start, version 2)', async () => {
  const r = await rig();
  try {
    const merged = await r.merge([r.playerExtra('judy-alvarez')]);
    assert.equal(merged.pocket, resolve(r.state, 'addons.pocket.json'));
    const long = await r.json(merged.omni.long);
    assert.equal(Object.keys(long.voices).length, 3);
    assert.deepEqual(long.preparation, {mode: 'lazy', startupProfiles: ['johnny-silverhand', 'panam-palmer']});
    const registry = createVoiceProfileRegistry(long);
    assert.deepEqual(registry.preparation.startupProfiles, ['johnny-silverhand', 'panam-palmer']);
    assert.equal(registry.profiles['judy-alvarez'].reference, 'runtime/player-voices/judy-alvarez.wav');
  } finally { await r.cleanup(); }
});

test('merge: copied voices still go to the reference roots, a player clip does not, and an ordinary extra never replaces a voice', async () => {
  const r = await rig();
  try {
    const vBytes = tone(0.3, 440);
    await mkdir(resolve(r.work, 'clips'), {recursive: true});
    await writeFile(resolve(r.work, 'clips/v-male.wav'), vBytes);
    await writeFile(resolve(r.work, 'clips/judy.wav'), vBytes);
    const extra = [{key: 'v-male', reference: resolve(r.work, 'clips/v-male.wav'), transcript: 'V words.'},
      // An ordinary extra for a key a configuration already names is left alone (today's rule) ...
      {key: 'panam-palmer', reference: resolve(r.work, 'clips/judy.wav'), transcript: 'Not used.'},
      // ... and the player's clip for the same key as another extra replaces the shipped voice.
      r.playerExtra('judy-alvarez')];
    const merged = await r.merge(extra);
    const pocket = await r.json(merged.pocket), short = await r.json(merged.omni.short);
    assert.equal(pocket.voices['v-male'].reference, 'runtime/voice-references/addons/v-male.wav');
    assert.deepEqual(pocket.voices['panam-palmer'], shipped('pocket/panam'));
    assert.equal(short.voices['judy-alvarez'].reference, 'runtime/player-voices/judy-alvarez.wav');
    assert.deepEqual(await readFile(resolve(r.omniRefs, 'addons/v-male.wav')), vBytes);
    assert.deepEqual(await readFile(resolve(r.pocketRefs, 'addons/v-male.wav')), vBytes);
    assert.equal(await exists(resolve(r.omniRefs, 'addons/judy-alvarez.wav')), false, 'the player clip is never copied');
    assert.equal(await exists(resolve(r.pocketRefs, 'addons/judy-alvarez.wav')), false);
    assert.ok(r.calls.copyFile.length > 0 && r.calls.copyFile.every(([source]) => !source.startsWith(r.player)), 'only the ordinary clips were copied');
  } finally { await r.cleanup(); }
});

test('merge: with the clip removed the next start leaves the shipped voice in place, and with nothing to merge the original files are used', async () => {
  const r = await rig();
  try {
    const first = await r.merge([r.playerExtra('sam-hill')]);
    assert.equal((await r.json(first.omni.short)).voices['sam-hill'].reference, 'runtime/player-voices/sam-hill.wav');
    // The clip was deleted: the next start passes no player entry at all.
    assert.equal(await r.merge([]), r.paths, 'no extras: the very same object, so the original shipped files');
    assert.deepEqual((await r.json(r.paths.omni.short)).voices['sam-hill'], shipped('short/sam'));
    // Another extra still merges, but the copy it writes is built from the shipped file again: no override, no folder, the shipped start-up list.
    const bytes = tone(0.3, 500);
    await writeFile(resolve(r.work, 'v.wav'), bytes);
    const second = await r.merge([{key: 'v-male', reference: resolve(r.work, 'v.wav'), transcript: 'V words.'}]);
    const short = await r.json(second.omni.short), pocket = await r.json(second.pocket);
    assert.deepEqual(short.voices['sam-hill'], shipped('short/sam'));
    assert.deepEqual(pocket.voices['sam-hill'], shipped('pocket/sam'));
    assert.equal('playerVoiceDirectory' in short, false);
    assert.equal('playerVoiceDirectory' in pocket.runtime, false);
    assert.deepEqual(short.preparation.startupProfiles, ['judy-alvarez', 'sam-hill']);
    assert.deepEqual(pocket.preparation.startupProfiles, ['judy-alvarez', 'panam-palmer']);
  } finally { await r.cleanup(); }
});

test('merge: a player item that fails a check is left out with a log line that holds no transcript; a good one still merges', async () => {
  const r = await rig();
  try {
    await writeFile(resolve(r.player, 'long.wav'), tone(25, 200));
    await writeFile(resolve(r.work, 'judy-alvarez.wav'), r.clips['judy-alvarez']);
    await writeFile(resolve(r.player, 'other.wav'), r.clips['sam-hill']);
    const bad = [
      r.playerExtra('sam-hill', {sha256: 'c'.repeat(64)}),                                  // not the recorded hash
      r.playerExtra('judy-alvarez', {reference: resolve(r.player, 'other.wav')}),            // not named <key>.wav
      r.playerExtra('judy-alvarez', {reference: resolve(r.work, 'judy-alvarez.wav')}),           // named right, but not in the player folder
      {...r.playerExtra('sam-hill'), key: 'Sam-Hill', reference: resolve(r.player, 'Sam-Hill.wav')},   // not a voice key
      {...r.playerExtra('sam-hill'), key: '__proto__', reference: resolve(r.player, '__proto__.wav')},
      {...r.playerExtra('sam-hill'), key: 'long', reference: resolve(r.player, 'long.wav')},    // 25 s
      {...r.playerExtra('sam-hill'), key: 'gone', reference: resolve(r.player, 'gone.wav')},    // no such file
      r.playerExtra('sam-hill', {transcript: `${SECRET}\u0007`}),                            // a control character
      r.playerExtra('sam-hill', {transcript: '   '}),
    ];
    const none = await r.merge(bad);
    assert.equal(none, r.paths, 'nothing usable: the original files');
    assert.equal(r.logs.length, bad.length);
    assert.ok(r.logs.every(line => /^Player voice \S+ not used: /.test(line)), r.logs.join('\n'));
    assert.ok(!r.logs.join('\n').includes('typed'), 'a transcript is never logged');
    // Without the folder option every player item is skipped.
    r.logs.length = 0;
    assert.equal(await r.merge([r.playerExtra('sam-hill')], {playerVoiceDirectory: undefined}), r.paths);
    assert.equal(await r.merge([r.playerExtra('sam-hill')], {playerVoiceDirectory: 'player-voices'}), r.paths, 'a relative folder is not accepted');
    assert.match(r.logs[0], /no player voice folder was given/);
    assert.ok(!r.logs.join('\n').includes('typed'));
    // A good item next to bad ones merges.
    const merged = await r.merge([...bad, r.playerExtra('judy-alvarez')]);
    assert.equal((await r.json(merged.omni.short)).voices['judy-alvarez'].reference, 'runtime/player-voices/judy-alvarez.wav');
    assert.deepEqual((await r.json(merged.omni.short)).voices['sam-hill'], shipped('short/sam'), 'a refused clip leaves the shipped voice');
    assert.deepEqual(r.calls.copyFile, []);
  } finally { await r.cleanup(); }
});

// ---- the cloud voices ---------------------------------------------------------------------------------------------------------

const KEY = 'k'.repeat(8) + 'Secret0123456789abcdefghijkl';
const REFERENCES = resolve('player-fixtures', 'voice-references'), PLAYER = resolve('player-fixtures', 'player-voices');
const CLIP = tone(0.4, 260);
const registryOf = (reference, bytes = CLIP) => ({profiles: {'sam-hill': {reference, sha256: sha(bytes), transcript: SECRET}}});
function voxtral({registry, playerRoot = PLAYER, files, prepare}) {
  const reads = [], calls = [];
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: REFERENCES, playerRoot, registry, list: async () => { throw Error('ENOENT'); },
    read: async path => { reads.push(path); const bytes = files.get(path); if (!bytes) throw Error('ENOENT'); return bytes; },
    prepare: prepare ?? (async (bytes, options) => { calls.push(options); return null; })});
  return {voice, reads, calls};
}

test('Voxtral: a player entry is read from playerRoot only and prepare is told player: true; a normal entry is as before', async () => {
  const files = new Map([[resolve(PLAYER, 'sam-hill.wav'), CLIP], [resolve(REFERENCES, 'picked/sam-hill.wav'), CLIP]]);
  const player = voxtral({registry: registryOf('runtime/player-voices/sam-hill.wav'), files});
  const found = await player.voice.reference('sam-hill');
  assert.equal(found.source, 'player');
  assert.equal(found.base64, CLIP.toString('base64'));
  assert.deepEqual(player.reads, [resolve(PLAYER, 'sam-hill.wav')]);
  assert.deepEqual(player.calls, [{key: 'sam-hill', sha256: sha(CLIP), player: true}]);
  const normal = voxtral({registry: registryOf('runtime/voice-references/picked/sam-hill.wav'), files});
  assert.equal((await normal.voice.reference('sam-hill')).source, 'omni-long');
  assert.deepEqual(normal.reads, [resolve(REFERENCES, 'picked/sam-hill.wav')]);
  assert.deepEqual(normal.calls, [{key: 'sam-hill', sha256: sha(CLIP)}], 'no player flag for a shipped reference');
  assert.equal(player.voice.hasReference('sam-hill'), true);
});

test('Voxtral: an entry that escapes or splits the player folder, a wrong hash and a missing player folder give no reference', async () => {
  const escape = resolve('player-fixtures', 'escape.wav');
  const files = new Map([[resolve(PLAYER, 'sam-hill.wav'), CLIP], [escape, CLIP], [resolve(PLAYER, 'sub/sam-hill.wav'), CLIP],
    [resolve(REFERENCES, 'sam-hill.wav'), CLIP]]);
  for (const reference of ['runtime/player-voices/../escape.wav', 'runtime/player-voices/sub/sam-hill.wav', 'runtime/player-voices\\..\\escape.wav',
    'runtime/player-voices/SAM-HILL.wav', 'runtime/player-voices/sam-hill.wav:x']) {
    const found = voxtral({registry: registryOf(reference), files});
    assert.equal(await found.voice.reference('sam-hill'), null, reference);
    assert.deepEqual(found.reads, [], `${reference}: nothing outside the player folder is read`);
    assert.deepEqual(found.calls, []);
  }
  // A hash that is not the clip's: the file is read, refused and nothing is prepared or sent.
  const changed = voxtral({registry: registryOf('runtime/player-voices/sam-hill.wav', tone(0.4, 999)), files});
  assert.equal(await changed.voice.reference('sam-hill'), null);
  assert.deepEqual(changed.calls, []);
  // An entry without a hash is not a checked clip either.
  const unhashed = voxtral({registry: {profiles: {'sam-hill': {reference: 'runtime/player-voices/sam-hill.wav'}}}, files});
  assert.equal(await unhashed.voice.reference('sam-hill'), null);
  // No player folder: no reference, and the voice does not claim one.
  const none = voxtral({registry: registryOf('runtime/player-voices/sam-hill.wav'), files, playerRoot: null});
  assert.equal(await none.voice.reference('sam-hill'), null);
  assert.deepEqual(none.reads, []);
  assert.equal(none.voice.hasReference('sam-hill'), false);
  // The next registry still gets its turn, exactly as for shipped entries.
  const fallback = voxtral({registry: [registryOf('runtime/player-voices/sam-hill.wav', tone(0.4, 999)), registryOf('runtime/voice-references/sam-hill.wav')], files});
  assert.equal((await fallback.voice.reference('sam-hill')).source, 'omni-short');
});

test('Inworld: the same player resolution (parity), through its reference reader', async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'convai-player-inworld-'));
  try {
    const player = resolve(work, 'player-voices');
    await mkdir(player, {recursive: true});
    await writeFile(resolve(player, 'sam-hill.wav'), CLIP);
    const voice = new InworldVoice({getKey: () => KEY, referenceRoot: resolve(work, 'voice-references'), playerRoot: player,
      registry: registryOf('runtime/player-voices/sam-hill.wav')});
    const reference = await voice.library.reference('sam-hill');
    assert.equal(reference.source, 'player');
    assert.equal(reference.base64, CLIP.toString('base64'));
    assert.equal(voice.hasReference('sam-hill'), true);
    const without = new InworldVoice({getKey: () => KEY, referenceRoot: resolve(work, 'voice-references'), registry: registryOf('runtime/player-voices/sam-hill.wav')});
    assert.equal(await without.library.reference('sam-hill'), null, 'no playerRoot: no reference');
    assert.equal(without.hasReference('sam-hill'), false);
  } finally { await rm(work, {recursive: true, force: true}); }
});

// ---- the routing log ----------------------------------------------------------------------------------------------------------

test('routing log: a player reference is reported as the set "player", without seconds or any transcript', () => {
  const pocket = {profiles: {'sam-hill': {reference: 'runtime/player-voices/sam-hill.wav', sha256: 'a'.repeat(64), transcript: SECRET},
    'judy-alvarez': shipped('pocket/judy')}};
  // The raw configuration may still hold the shipped voice's length for that key: it must not be shown for the player's clip.
  const sources = {pocket: {voices: {'sam-hill': {pick: {seconds: 19}}, 'judy-alvarez': {pick: {seconds: 12}}}}};
  const voice = {registries: {pocket}, requestedProvider: 'pocket', provider: 'pocket', resolvedProvider: 'pocket',
    configuredByBackend: {pocket: true}, omniVariants: {}};
  assert.deepEqual(referenceOf(voice, 'pocket', 'sam-hill', sources), {set: 'player'});
  assert.deepEqual(referenceOf(voice, 'pocket', 'judy-alvarez', sources), {set: 'picked/pocket', seconds: 12});
  assert.deepEqual(cloudReferenceOf(voice, 'sam-hill', sources), {set: 'player'});
  const record = describeVoiceRoute({voice, input: {profileKey: 'sam-hill'}, profile: {key: 'sam-hill', name: 'Sam Hill'},
    plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, voiceKey: 'sam-hill', sources, now: () => new Date(2026, 9, 19, 12, 0, 0).getTime()});
  assert.deepEqual(record.reference, {set: 'player'});
  const line = formatVoiceRoute(record);
  assert.match(line, / ref="player"$/);
  assert.ok(!JSON.stringify(record).includes('typed') && !line.includes('typed'), 'no transcript in the record or the line');
  assert.ok(!line.includes('sam-hill.wav'), 'no file name either');
});
