import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {clipsLeftOut} from './lib/voice-clips-left-out.mjs';
import {STAND_IN_VOICES, readManifest} from '../bridge/voice-clips.mjs';

// voiceClips.fromGame (packaging/release.config.json): the Runtime and the OmniVoice pack leave out the clips the player's PC builds from the game's own voice files
// (docs/VOICE_EXTRACTION.md) and keep Lucy, the two clips that cannot be rebuilt and the two stand-in voices.

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = path => readFileSync(resolve(project, path), 'utf8');
const config = JSON.parse(read('packaging/release.config.json'));
const sha = seed => String(seed).repeat(64).slice(0, 64);
const spec = seed => ({sha256: sha(seed), samples: 10});
const complete = seed => ({'omni-short': spec(seed), 'omni-long': spec(seed), pocket: {sameAs: 'omni-long'}});
const manifestText = JSON.stringify({version: 1, voices: {
  'judy-alvarez': complete(1), 'resident-male': complete(2), 'resident-female': complete(3), 'spider-murphy': {'omni-short': spec(4), pocket: spec(4)},
}});
const voice = (kind, group, key, extra = {}) => ({reference: `runtime/voice-references/${group}/${kind}/${key}.wav`, sha256: sha(1), transcript: 'x', ...extra});
const configs = kind => ({voices: {
  'judy-alvarez': voice(kind, 'picked/autobest', 'judy-alvarez'), 'resident-male': voice(kind, 'archetypes', 'resident-male'), 'resident-female': voice(kind, 'archetypes', 'resident-female'),
  'spider-murphy': voice(kind, 'picked/autobest', 'spider-murphy'), 'lucy-kushinada': voice(kind, 'picked/autobest', 'lucy-kushinada'),
  'unprepared': voice(kind, 'picked/autobest', 'unprepared', {status: 'unprepared'}),
}});

test('the switch is on for 0.4.0, and the notes say what stays in the packages', () => {
  assert.equal(config.voiceClips.fromGame, true);
  assert.match(config.voiceClips.notes, /Lucy/);
  assert.match(config.voiceClips.notes, /spider-murphy omni-long/);
  assert.match(config.voiceClips.notes, /npc-kang-tao-male omni-short/);
  assert.match(config.voiceClips.notes, /resident-male and resident-female/);
});

test('with the switch off nothing is left out; with it on the clips the manifest rebuilds are', () => {
  const kinds = ['pocket', 'omni-short', 'omni-long'];
  const off = clipsLeftOut({fromGame: false, manifestText, configs: kinds.map(configs)});
  assert.equal(off('picked/autobest/pocket/judy-alvarez.wav'), false);
  const on = clipsLeftOut({fromGame: true, manifestText, configs: kinds.map(configs)});
  for (const kind of kinds) {
    assert.equal(on(`picked/autobest/${kind}/judy-alvarez.wav`), true, `${kind}: a rebuilt character`);
    assert.equal(on(`archetypes/${kind}/resident-male.wav`), false, `${kind}: the male stand-in stays`);
    assert.equal(on(`archetypes/${kind}/resident-female.wav`), false, `${kind}: the female stand-in stays`);
    assert.equal(on(`picked/autobest/${kind}/spider-murphy.wav`), false, `${kind}: a voice that is not complete in the manifest stays`);
    assert.equal(on(`picked/autobest/${kind}/lucy-kushinada.wav`), false, `${kind}: Lucy is not in the manifest`);
    assert.equal(on(`picked/autobest/${kind}/unprepared.wav`), false, `${kind}: a row that is not ready names no clip`);
    assert.equal(on(`picked/autobest/${kind}/nobody.wav`), false, `${kind}: a path no voice uses`);
  }
});

test('a file that a kept voice also uses is kept', () => {
  const shared = {voices: {'judy-alvarez': voice('pocket', 'picked/autobest', 'judy-alvarez'), 'lucy-kushinada': voice('pocket', 'picked/autobest', 'judy-alvarez')}};
  assert.equal(clipsLeftOut({fromGame: true, manifestText, configs: [shared]})('picked/autobest/pocket/judy-alvarez.wav'), false);
});

test('the build uses the library, reads the manifest from the source being packaged, and holds the Runtime clip listing to what is still shipped', () => {
  const source = read('packaging/build-release.mjs');
  assert(source.includes("from './lib/voice-clips-left-out.mjs'"));
  assert(source.includes("resolve(source.root, 'characters/voice-clips-manifest.json')"));
  assert(source.includes('leftOutOmni(rel)') && source.includes('leftOutPocket(rel)'));
  assert(source.includes('const listedKept = [...runtimeClips.keys()].filter(path => !leftOutPaths.has(path)).length;'));
  assert(!source.includes('if (config.voiceClips?.fromGame) continue;'), 'the old rule that left every clip out is gone');
});

// The numbers of the real configurations (the developer runtime folder): skipped on a checkout without it.
const live = ['pocket-voices.autobest.json', 'local-voices.autobest-short.json', 'local-voices.autobest-long.json'];
const haveRuntime = live.every(name => existsSync(resolve(project, 'runtime', name))) && existsSync(resolve(project, 'runtime/voice-references/picked/autobest/pocket'));
test('the real configurations: the clips of every rebuilt voice are left out, Lucy, the two clips that cannot be rebuilt and the two stand-in voices stay (1011 left out, 15 kept on 2026-10-30)', {skip: !haveRuntime && 'runtime folder absent'}, () => {
  const parsed = live.map(name => JSON.parse(read(`runtime/${name}`).replace(/^\uFEFF/, '')));
  const manifest = Object.keys(readManifest(read('characters/voice-clips-manifest.json')));
  const left = clipsLeftOut({fromGame: true, manifestText: read('characters/voice-clips-manifest.json'), configs: parsed});
  let out = 0;
  const keptNames = new Set();
  for (const value of parsed) {
    const seen = new Set();
    for (const [key, descriptor] of Object.entries(value.voices)) {
      const rel = descriptor.reference.replace(/^runtime\/voice-references\//, '');
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (left(rel)) { out++; assert(manifest.includes(key), `${key} is rebuilt`); } else keptNames.add(key);
    }
  }
  for (const key of ['lucy-kushinada', 'npc-kang-tao-male', 'spider-murphy', ...Object.values(STAND_IN_VOICES)]) assert(keptNames.has(key), `${key} stays in the packages`);
  for (const key of keptNames) assert(!manifest.includes(key) || Object.values(STAND_IN_VOICES).includes(key), `${key} stays only when the manifest cannot rebuild it`);
  assert(out >= 1011, `${out} clips left out`);
  // Every clip that is left out has a copy on Hugging Face: the upload list names its three paths.
  const listed = new Set(JSON.parse(read('packaging/voice-clips-upload-list.json')).rows.map(row => row.path));
  for (const [key, descriptor] of Object.entries(parsed[0].voices)) {
    const rel = descriptor.reference.replace(/^runtime\/voice-references\//, '');
    if (!left(rel)) continue;
    for (const kind of ['omni-short', 'omni-long', 'pocket']) assert(listed.has(`voice-clips/${kind}/${key}.wav`), `${kind}/${key} is on the upload list`);
  }
  assert(statSync(resolve(project, 'runtime/voice-references/archetypes/pocket/resident-male.wav')).size > 0, 'the stand-in clip is in the developer store the build packs');
});
