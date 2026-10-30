import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {GameVoiceClips, STAND_IN_VOICES, applyReadyClips, applyStandIns, generatedReference, readManifest, readWords, standInDescriptors, standInKey} from './voice-clips.mjs';
import {LiveVoices} from './live-voices.mjs';

// The stand-in voices (bridge/voice-clips.mjs): with the shipped clips left out of the packages (voiceClips.fromGame), a character whose own clips are not built yet
// speaks with the archetype voice of its gender for the line it needs before they are, and no error shows. Nothing here starts a process.

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wav = seed => Buffer.concat([Buffer.from('RIFF....WAVEfmt ', 'latin1'), Buffer.alloc(40, seed)]);
const spec = seed => ({sha256: sha(wav(seed)), samples: 1000 + seed, lines: [], writer: 'sf'});
const entry = seed => ({'omni-short': spec(seed), 'omni-long': spec(seed + 1), pocket: {sameAs: 'omni-long'}});
const MANIFEST = JSON.stringify({version: 1, voices: {
  'judy-alvarez': entry(1), 'johnny-silverhand': entry(3), 'npc-valentinos-female': entry(5), 'resident-male': entry(7), 'resident-female': entry(9),
}});
const REFERENCE = {pocket: 'pocket', short: 'omni-short', long: 'omni-long'};
const row = (engine, key, group, seed) => ({reference: `runtime/voice-references/${group}/${REFERENCE[engine]}/${key}.wav`, sha256: sha(wav(seed)), transcript: `${key} ${engine} words.`, status: 'ready'});
const tableOf = () => {
  const groups = {'judy-alvarez': 'picked/autobest', 'johnny-silverhand': 'picked/autobest', 'npc-valentinos-female': 'archetypes', 'resident-male': 'archetypes', 'resident-female': 'archetypes'};
  const seeds = {'judy-alvarez': 1, 'johnny-silverhand': 3, 'npc-valentinos-female': 5, 'resident-male': 7, 'resident-female': 9};
  const tables = {pocket: {}, short: {}, long: {}};
  for (const [key, group] of Object.entries(groups)) for (const engine of Object.keys(tables)) tables[engine][key] = row(engine, key, group, seeds[key]);
  return tables;
};
const genders = {'judy-alvarez': 'female', 'johnny-silverhand': 'male', 'npc-valentinos-female': 'female'};
const makeClips = (present, extra = {}) => new GameVoiceClips({manifest: readManifest(MANIFEST), gameDirectory: 'game', referenceRoot: 'refs', stateDirectory: 'state',
  shippedPresentSync: reference => present.has(reference), run: async () => { throw Error('no process may be started here'); }, ...extra});
const only = (...keys) => new Set(keys.flatMap(key => ['pocket', 'short', 'long'].map(engine => tableOf()[engine][key].reference)));

test('the stand-in voices are the resident voices of the two genders, and a gender that is not female is male', () => {
  assert.deepEqual({...STAND_IN_VOICES}, {female: 'resident-female', male: 'resident-male'});
  assert.equal(standInKey('female'), 'resident-female');
  assert.equal(standInKey('FEMALE'), 'resident-female');
  assert.equal(standInKey('male'), 'resident-male');
  assert.equal(standInKey(null), 'resident-male');
  assert.equal(standInKey('nonbinary'), 'resident-male');
});

test('a character whose shipped clips are gone speaks with the stand-in voice of its gender, per engine, until its own are built', () => {
  const tables = tableOf();
  const clips = makeClips(only('resident-male', 'resident-female'));
  const changed = applyStandIns(clips, tables, key => genders[key]);
  assert.deepEqual(changed.sort(), ['johnny-silverhand', 'judy-alvarez', 'npc-valentinos-female']);
  for (const engine of Object.keys(tables)) {
    const fresh = tableOf()[engine];
    assert.deepEqual({reference: tables[engine]['judy-alvarez'].reference, sha256: tables[engine]['judy-alvarez'].sha256, transcript: tables[engine]['judy-alvarez'].transcript},
      {reference: fresh['resident-female'].reference, sha256: fresh['resident-female'].sha256, transcript: fresh['resident-female'].transcript}, `${engine}: female stand-in`);
    assert.equal(tables[engine]['npc-valentinos-female'].reference, fresh['resident-female'].reference);
    assert.equal(tables[engine]['johnny-silverhand'].reference, fresh['resident-male'].reference, `${engine}: male stand-in`);
    assert.equal(tables[engine]['johnny-silverhand'].status, 'ready', 'the rest of the row is kept');
    assert.deepEqual(tables[engine]['resident-male'], fresh['resident-male'], 'a stand-in voice is never changed');
    assert.deepEqual(tables[engine]['resident-female'], fresh['resident-female']);
  }
});

test('a character keeps its shipped clips when they are there, and one that is ready or unknown is left alone', async () => {
  const tables = tableOf();
  tables.pocket.stranger = row('pocket', 'stranger', 'picked/autobest', 11);
  const present = only('resident-male', 'resident-female', 'judy-alvarez');
  const clips = makeClips(present);
  const changed = applyStandIns(clips, tables, key => genders[key]);
  assert.deepEqual(changed.sort(), ['johnny-silverhand', 'npc-valentinos-female'], 'Judy has her shipped clips, the stranger is not in the manifest');
  assert.equal(tables.pocket['judy-alvarez'].reference, tableOf().pocket['judy-alvarez'].reference);
  assert.equal(tables.pocket.stranger.reference, 'runtime/voice-references/picked/autobest/pocket/stranger.wav');
  // A ready character is named by applyReadyClips, never by a stand-in.
  const ready = makeClips(only('resident-male', 'resident-female'));
  ready.index['johnny-silverhand'] = {'omni-short': {sha256: sha(wav(3)), bytes: 5, source: 'build'}, 'omni-long': {sha256: sha(wav(4)), bytes: 5, source: 'build'}, pocket: {sha256: sha(wav(4)), bytes: 5, source: 'build'}};
  assert.equal(standInDescriptors(ready, 'johnny-silverhand', {pocket: tableOf().pocket['johnny-silverhand']}, tableOf(), 'male'), null);
  assert.equal(standInDescriptors(ready, 'not-in-the-manifest', {pocket: tableOf().pocket.judy}, tableOf(), 'male'), null);
});

test('without a file for the stand-in voice nothing is changed, and an engine whose shipped clip is there keeps it', () => {
  const tables = tableOf();
  assert.deepEqual(applyStandIns(makeClips(new Set()), tables, () => 'male'), [], 'no stand-in clip on disk: the tables are as they were');
  assert.deepEqual(tables, tableOf());
  // Only Pocket's clip of Judy is gone: only Pocket's row follows the stand-in.
  const partial = tableOf();
  const present = only('resident-male', 'resident-female', 'johnny-silverhand', 'npc-valentinos-female');
  present.add(tableOf().short['judy-alvarez'].reference).add(tableOf().long['judy-alvarez'].reference);
  assert.deepEqual(applyStandIns(makeClips(present), partial, key => genders[key]), ['judy-alvarez']);
  assert.equal(partial.pocket['judy-alvarez'].reference, tableOf().pocket['resident-female'].reference);
  assert.equal(partial.short['judy-alvarez'].reference, tableOf().short['judy-alvarez'].reference);
  assert.equal(partial.long['judy-alvarez'].reference, tableOf().long['judy-alvarez'].reference);
});

test('a path outside the references folder (a player clip) counts as there', () => {
  const tables = tableOf();
  for (const engine of Object.keys(tables)) tables[engine]['judy-alvarez'] = {...tables[engine]['judy-alvarez'], reference: 'runtime/player-voices/judy-alvarez.wav'};
  assert.deepEqual(applyStandIns(makeClips(only('resident-male', 'resident-female')), tables, key => genders[key]).sort(), ['johnny-silverhand', 'npc-valentinos-female']);
});

test('the live tables: the stand-in until the clips are ready, then the character\'s own, with the words of the shipped descriptors', async () => {
  const start = tableOf();
  const clips = makeClips(only('resident-male', 'resident-female'));
  const standIns = Object.fromEntries(Object.entries(start).map(([engine, table]) => [engine, {'resident-male': table['resident-male'], 'resident-female': table['resident-female']}]));
  const calls = [];
  const live = new LiveVoices({players: {extras: async () => []}, folder: 'player', voices: start, shipped: async () => tableOf(), apply: update => { calls.push(update); return true; },
    generated: (key, shipped) => clips.descriptors(key, shipped) ?? standInDescriptors(clips, key, shipped, standIns, genders[key])});
  await live.refresh('judy-alvarez');
  assert.equal(calls.at(-1).pocket['judy-alvarez'].reference, tableOf().pocket['resident-female'].reference, 'not built yet: the stand-in voice, not a missing file');
  assert.equal(calls.at(-1).omni.long['judy-alvarez'].sha256, tableOf().long['resident-female'].sha256);
  // The builder has written the clips: the character's own replace the stand-in.
  clips.index['judy-alvarez'] = {'omni-short': {sha256: sha(wav(1)), bytes: 5, source: 'build'}, 'omni-long': {sha256: sha(wav(2)), bytes: 5, source: 'build'}, pocket: {sha256: sha(wav(2)), bytes: 5, source: 'build'}};
  await live.refresh('judy-alvarez');
  assert.equal(calls.at(-1).pocket['judy-alvarez'].reference, generatedReference('pocket', 'judy-alvarez'));
  assert.equal(calls.at(-1).omni.short['judy-alvarez'].reference, generatedReference('omni-short', 'judy-alvarez'));
  assert.equal(calls.at(-1).omni.short['judy-alvarez'].transcript, 'judy-alvarez short words.');
  // The ready characters are named in the start-up tables by applyReadyClips, which runs before the stand-ins and leaves them alone.
  const tables = tableOf();
  assert.deepEqual(applyReadyClips(clips, tables), ['judy-alvarez']);
  assert.deepEqual(applyStandIns(clips, tables, key => genders[key]).sort(), ['johnny-silverhand', 'npc-valentinos-female']);
  assert.equal(tables.short['judy-alvarez'].reference, generatedReference('omni-short', 'judy-alvarez'));
});

test('the bridge puts the stand-ins in before the voice service is built, hands them to the live tables, and checks the pack after', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const standIn = source.indexOf('applyStandIns(gameVoiceClips, tables, genderOfVoiceKey)');
  const readyClips = source.indexOf('applyReadyClips(gameVoiceClips, tables)');
  const voiceService = source.indexOf('const localVoice = new VoiceSelection(');
  assert(readyClips > 0 && standIn > readyClips, 'the ready clips first, then the stand-ins');
  assert(voiceService > standIn, 'before the voice service reads the tables');
  assert(source.includes('standInDescriptors(gameVoiceClips, key, shipped, standInVoices, genderOfVoiceKey(key))'), 'the live tables fall back to the stand-in');
  const check = source.indexOf('missingOmniClips({config: omniVoiceConfigs[mode]');
  assert(check > standIn, 'the missing-clips line is written after the stand-ins are in');
  assert(source.includes("except: gameVoiceClips ? Object.keys(gameVoiceClips.manifest) : []"), 'and never counts the characters the game builds');
});

test('a character with no row in the shipped tables (a Runtime that predates it) speaks with the stand-in too, an engine without a table is left out', () => {
  const tables = tableOf();
  delete tables.pocket['judy-alvarez']; delete tables.short['judy-alvarez']; delete tables.long['judy-alvarez'];
  const changed = applyStandIns(makeClips(only('resident-male', 'resident-female')), tables, key => genders[key]);
  assert.deepEqual(changed.sort(), ['johnny-silverhand', 'judy-alvarez', 'npc-valentinos-female']);
  for (const engine of Object.keys(tables)) assert.equal(tables[engine]['judy-alvarez'].reference, tableOf()[engine]['resident-female'].reference, engine);
  const noOmni = {pocket: tableOf().pocket, short: null, long: null};
  delete noOmni.pocket['judy-alvarez'];
  assert.deepEqual(applyStandIns(makeClips(only('resident-male', 'resident-female')), noOmni, key => genders[key]).sort(), ['johnny-silverhand', 'judy-alvarez', 'npc-valentinos-female']);
  assert.equal(noOmni.short, null);
});

test('the bridge hands the words file to the clip service', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert(source.includes("characters/voice-clips-words.json"));
  assert(source.includes('GameVoiceClips.open({manifest, words,'));
});

test('characters/voice-clips-words.json has the words of every character of the manifest, each from the clip the manifest names', () => {
  const read = name => readFileSync(new URL(`../characters/${name}`, import.meta.url), 'utf8');
  const manifest = Object.keys(readManifest(read('voice-clips-manifest.json')));
  const words = readWords(read('voice-clips-words.json'));
  assert.deepEqual(Object.keys(words).sort(), [...manifest].sort(), 'run node scripts/voice-extract/write_words.mjs after the manifest changes');
  assert(JSON.parse(read('../packaging/release.config.json')).appData.includes('characters/voice-clips-words.json'), 'the words ship with the code');
});
