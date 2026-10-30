import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readManifest} from './voice-clips.mjs';

// The 27 side characters of the cast sweep that have a game line of their own (characters/cast-sweep-voices.json `clip`) speak with their own voice through the
// clips the player's PC builds (docs/VOICE_EXTRACTION.md, docs/CAST_SWEEP.md). Wiring: three rows in the voice configurations, the release plan's voice list, the upload list.

const url = path => new URL(`../${path}`, import.meta.url);
const text = path => readFileSync(url(path), 'utf8').replace(/^\uFEFF/, '');
const json = path => JSON.parse(text(path));
const sha = value => createHash('sha256').update(value).digest('hex');
const sweep = json('characters/cast-sweep-voices.json').characters;
const own = Object.keys(sweep).filter(key => sweep[key].clip).sort();
const manifest = readManifest(text('characters/voice-clips-manifest.json'));
const KINDS = {pocket: 'pocket-voices.autobest.json', 'omni-short': 'local-voices.autobest-short.json', 'omni-long': 'local-voices.autobest-long.json'};

test('27 cast sweep characters have a line of their own, and every one is complete in the manifest', () => {
  assert.equal(own.length, 27);
  for (const key of own) {
    assert(manifest[key], `${key} in the manifest`);
    assert.equal(manifest[key]['omni-short'].sha256, manifest[key]['omni-long'].sha256, `${key}: one clip serves the three kinds`);
    assert.equal(manifest[key].pocket.sha256, manifest[key]['omni-short'].sha256);
  }
});

test('the release plan lists the 27 as prepared local voices', () => {
  const plan = json('packaging/release-plan.json');
  for (const key of own) assert(plan.voice.localProfiles.includes(key), `${key} in voice.localProfiles`);
  assert.equal(plan.voice.registry.preparedLocalProfiles, plan.voice.localProfiles.length);
  assert.deepEqual([...plan.voice.localProfiles], [...plan.voice.localProfiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'the list stays sorted');
});

test('the upload list holds the three paths of each of the 27', () => {
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
