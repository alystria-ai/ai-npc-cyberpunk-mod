import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readManifest} from './voice-clips.mjs';

// The 45 side characters of the cast sweep that have a game line of their own (27 by a name, 18 by a tag the scenes or the records prove) (characters/cast-sweep-voices.json `clip`) speak with their own voice through the
// clips the player's PC builds (docs/VOICE_EXTRACTION.md, docs/CAST_SWEEP.md). Wiring: three rows in the voice configurations, the release plan's voice list, the upload list.

const url = path => new URL(`../${path}`, import.meta.url);
const text = path => readFileSync(url(path), 'utf8').replace(/^\uFEFF/, '');
const json = path => JSON.parse(text(path));
const sha = value => createHash('sha256').update(value).digest('hex');
const sweep = json('characters/cast-sweep-voices.json').characters;
const own = Object.keys(sweep).filter(key => sweep[key].clip).sort();
const manifest = readManifest(text('characters/voice-clips-manifest.json'));
const KINDS = {pocket: 'pocket-voices.autobest.json', 'omni-short': 'local-voices.autobest-short.json', 'omni-long': 'local-voices.autobest-long.json'};

test('45 cast sweep characters have a line of their own (27 by the full name in the file stem, 18 by a proven voice tag), and every one is complete in the manifest', () => {
  assert.equal(own.length, 45);
  for (const key of own) {
    assert(manifest[key], `${key} in the manifest`);
    assert.equal(manifest[key]['omni-short'].sha256, manifest[key]['omni-long'].sha256, `${key}: one clip serves the three kinds`);
    assert.equal(manifest[key].pocket.sha256, manifest[key]['omni-short'].sha256);
  }
});

test('the release plan lists the 45 as prepared local voices', () => {
  const plan = json('packaging/release-plan.json');
  for (const key of own) assert(plan.voice.localProfiles.includes(key), `${key} in voice.localProfiles`);
  assert.equal(plan.voice.registry.preparedLocalProfiles, plan.voice.localProfiles.length);
  assert.deepEqual([...plan.voice.localProfiles], [...plan.voice.localProfiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'the list stays sorted');
});

test('the 18 characters found by a voice tag name the tag, and no tag or line serves two people', () => {
  const linked = own.filter(key => sweep[key].link);
  assert.equal(linked.length, 18);
  const tags = new Set(), lines = new Set();
  for (const key of own) {
    const {clip, link} = sweep[key];
    assert(!lines.has(clip.id), `${key}: the line is used by another character`);
    lines.add(clip.id);
    if (!link) continue;
    assert(!tags.has(link.tag), `${key}: the tag ${link.tag} belongs to another character`);
    tags.add(link.tag);
    assert(clip.stem === link.tag || clip.stem.startsWith(`${link.tag}_`), `${key}: the stem of the line starts with the tag`);
    assert(link.how.length > 0 && link.how.every(how => ['voiceTag', 'name', 'record', 'record-unique', 'display+group', 'scene', 'scene-actor-name'].includes(how)), `${key}: evidence kinds`);
    assert(!/^(civ|gang|ncpd|sec|merc|ad|crowd|v)_/.test(link.tag), `${key}: a generic voice model is never a person's tag`);
  }
});

// Side characters the scenes tie to a generic voice model (`voiceModel`) speak with the archetype voice of exactly that model (docs/CAST_SWEEP.md, "Voice models").
const mapped = Object.keys(sweep).filter(key => sweep[key].voiceModel).sort();
const receipt = json('characters/archetype-voices.json').voices;
const roster = new Map(json('characters/roster.json').map(row => [row.key, row]));

test('137 side characters point at the archetype voice of the voice model the game gives them', () => {
  assert.equal(mapped.length, 137);
  for (const key of mapped) {
    const {fallback, voiceModel, clip} = sweep[key];
    assert.equal(clip, null, `${key}: a character with a model has no clip of their own`);
    assert.equal(receipt[fallback]?.status, 'ready', `${key}: ${fallback} is a ready archetype voice`);
    assert.equal(receipt[fallback].voiceset, voiceModel.model, `${key}: the fallback voice is the model ${voiceModel.model}`);
    assert(/^(civ|gang|ncpd|sec|merc)_/.test(voiceModel.model), `${key}: a generic voice model`);
    assert(['record', 'actor-name'].includes(voiceModel.how) && voiceModel.lines > 0, `${key}: proof`);
    const gender = roster.get(key).gender;
    if (gender === 'MALE' || gender === 'FEMALE') assert.equal(voiceModel.model.includes('_m_') ? 'MALE' : 'FEMALE', gender, `${key}: the model's gender is the roster's`);
  }
});

test('the 47 model voices built for models no archetype covers are complete in the manifest, the catalogue and the upload list', () => {
  const catalogue = json('characters/model-voices.json').voices;
  const keys = Object.keys(catalogue).sort();
  assert.equal(keys.length, 47);
  const rows = new Map(json('packaging/voice-clips-upload-list.json').rows.map(row => [row.path, row]));
  for (const key of keys) {
    assert.equal(key, `model-${catalogue[key].voiceset.replaceAll('_', '-')}`);
    assert.equal(receipt[key]?.voiceset, catalogue[key].voiceset);
    for (const kind of Object.keys(KINDS)) {
      assert(manifest[key]?.[kind], `${key}/${kind} in the manifest`);
      assert.equal(rows.get(`voice-clips/${kind}/${key}.wav`)?.sha256, (manifest[key][kind].sha256 ?? manifest[key][manifest[key][kind].sameAs].sha256), `${kind}/${key} in the upload list`);
    }
  }
  const used = new Set(mapped.map(key => sweep[key].fallback));
  assert(keys.every(key => used.has(key)), 'every model voice is used by somebody');
});

test('the upload list holds the three paths of each of the 45', () => {
  const rows = new Map(json('packaging/voice-clips-upload-list.json').rows.map(row => [row.path, row]));
  for (const key of own) {
    for (const kind of Object.keys(KINDS)) {
      assert.equal(rows.get(`voice-clips/${kind}/${key}.wav`)?.sha256, manifest[key][kind].sha256, `${kind}/${key}`);
    }
  }
});

const live = Object.values(KINDS).every(name => existsSync(url(`runtime/${name}`)));
test('the live voice configurations hold a ready row for each, with the manifest hash and the words of the game line', {skip: !live && 'runtime configs absent'}, () => {
  for (const [kind, name] of Object.entries(KINDS)) {
    const voices = json(`runtime/${name}`).voices;
    for (const key of own) {
      const entry = voices[key];
      assert.equal(entry?.status, 'ready', `${name}: ${key}`);
      assert.equal(entry.reference, `runtime/voice-references/picked/autobest/${kind}/${key}.wav`);
      assert.equal(entry.sha256, manifest[key][kind].sha256, `${name}: ${key} hash is the manifest's`);
      assert(entry.transcript.trim().split(/\s+/).length >= 6, `${name}: ${key} has the words`);
      assert.equal(entry.transcriptSha256, sha(entry.transcript), `${name}: ${key} words hash`);
      assert.deepEqual(entry.pick.clips, [`${key}/${sweep[key].clip.id}`]);
    }
  }
});

test('the developer store holds each clip with the manifest hash (what the packaging build checks, and what is uploaded)', {skip: !live && 'runtime configs absent'}, () => {
  for (const [kind] of Object.entries(KINDS)) {
    for (const key of own) {
      const file = url(`runtime/voice-references/picked/autobest/${kind}/${key}.wav`);
      assert(existsSync(file), `${kind}/${key}`);
      assert.equal(sha(readFileSync(file)), manifest[key][kind].sha256, `${kind}/${key}`);
    }
  }
});
