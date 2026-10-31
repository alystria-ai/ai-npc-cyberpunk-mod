import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DUB_ARCHIVE_NAMES, readLanguageManifest} from './language-clips.mjs';
import {LANGUAGE_PACKS} from './voice-language-packs.mjs';
import {fallbackAliases, readFallbacks} from './voice-fallbacks.mjs';

// The recipes in characters/voice-language-clips/ (docs/VOICE_LANGUAGE_PACKS.md, "Clips on demand") and the Hugging Face upload list that goes with them. The recipes are proved
// against the shipped packs by scripts/voice-extract/prove_language.py (it needs the dub archives, so it is not part of npm test).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async path => JSON.parse((await readFile(join(ROOT, path), 'utf8')).replace(/^﻿/, ''));
const LOCALES = {fr: 'fr-fr', it: 'it-it', de: 'de-de', 'es-es': 'es-es', ja: 'jp-jp', ko: 'kr-kr', pl: 'pl-pl', 'pt-br': 'pt-br', ru: 'ru-ru', 'zh-cn': 'zh-cn'};
const WEM = /^vo[a-z_]*\\[A-Za-z0-9_.-]+_[fm]_[0-9a-f]{16}[A-Za-z0-9_.-]*\.wem$/;

test('there is a manifest for each of the ten languages and no other file', async () => {
  const files = (await readdir(join(ROOT, 'characters', 'voice-language-clips'))).sort();
  assert.deepEqual(files, Object.keys(LANGUAGE_PACKS).map(language => `${language}.json`).sort());
});

for (const language of Object.keys(LANGUAGE_PACKS)) {
  test(`${language}: every voice is well formed, a recipe has the dub's lines, and the file names are the pack's`, async () => {
    const raw = await read(`characters/voice-language-clips/${language}.json`);
    assert.equal(raw.version, 1);
    assert.equal(raw.language, language);
    assert.equal(raw.languageTag, LANGUAGE_PACKS[language]);
    assert.equal(raw.locale, LOCALES[language]);
    assert.equal(raw.archive, `lang_${DUB_ARCHIVE_NAMES[language]}_voice.archive`);
    const manifest = readLanguageManifest(JSON.stringify(raw), language);
    const keys = Object.keys(raw.voices);
    assert.equal(manifest.voices.size, keys.length, 'the reader keeps every voice of the file');
    assert.ok(keys.length >= 295 + 45 + 47, `${keys.length} voices (the pack's 300 or so, the 45 side characters and the 47 model voices at least)`);
    assert.ok(keys.includes('v-male') && keys.includes('v-female') && keys.includes('johnny-silverhand') && keys.includes('resident-female'));
    const seenFiles = new Set();
    let withGain = 0;
    for (const [key, row] of Object.entries(raw.voices)) {
      assert.equal(row.file, `${row.kind}/${key}.wav`, key);
      assert.ok(!seenFiles.has(row.file), `${key} repeats a file`);
      seenFiles.add(row.file);
      assert.ok(['picked', 'archetypes', 'v-voice'].includes(row.kind), key);
      assert.equal(row.kind === 'v-voice', key === 'v-male' || key === 'v-female', key);
      assert.equal(row.exact, true, `${key} is exact`);
      assert.equal(row.how, row.kind === 'v-voice' ? 'packv' : 'pack', key);
      assert.ok(row.gain === null || (typeof row.gain === 'number' && row.gain > 0.05 && row.gain < 40), `${key} gain ${row.gain}`);
      if (row.gain !== null) withGain++;
      assert.ok(Array.isArray(row.lines) && row.lines.length >= 1 && row.lines.length <= 14, `${key} lines`);
      for (const [archive, path] of row.lines) {
        assert.ok(archive === 'content' || archive === 'ep1', key);
        assert.match(path, WEM, `${key}: ${path}`);
        assert.ok(!path.includes('..'), key);
      }
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(row.samples) && row.samples > 24000 && row.samples <= 20 * 24000, `${key} samples ${row.samples}`);
      assert.ok(Math.abs(row.samples / 24000 - row.seconds) < 0.002, `${key} seconds`);
      assert.ok(typeof row.text === 'string' && row.text.trim().length > 3);
    }
    assert.ok(withGain >= 40 && withGain <= 44, `${withGain} voices with a loudness stage`);
  });
}

test('the manifests agree on the voices every language has, and the Hugging Face list names one file per voice with the manifest hash', async () => {
  const manifests = {};
  for (const language of Object.keys(LANGUAGE_PACKS)) manifests[language] = (await read(`characters/voice-language-clips/${language}.json`)).voices;
  const common = Object.keys(manifests.de).filter(key => Object.keys(manifests).every(language => manifests[language][key]));
  assert.ok(common.length >= 295, `${common.length} voices in all ten`);
  const list = await read('packaging/voice-language-clips-upload-list.json');
  assert.equal(list.repository, 'alystria-ai/ai-npc-cyberpunk-mod-packs');
  const total = Object.values(manifests).reduce((sum, voices) => sum + Object.keys(voices).length, 0);
  assert.equal(list.files, total);
  assert.equal(list.rows.length, total);
  assert.equal(list.bytes, list.rows.reduce((sum, row) => sum + row.bytes, 0));
  const seen = new Set();
  for (const row of list.rows) {
    const [folder, language, kind, name] = row.path.split('/');
    assert.equal(folder, 'voice-clips');
    assert.ok(!seen.has(row.path), row.path);
    seen.add(row.path);
    const voice = manifests[language]?.[name.replace(/\.wav$/, '')];
    assert.ok(voice, row.path);
    assert.equal(kind, voice.kind);
    assert.equal(row.sha256, voice.sha256, row.path);
    assert.equal(row.bytes, voice.samples * 2 + 44, row.path);
  }
});

// ---- the side characters and the generated archetype voices (docs/VOICE_LANGUAGE_PACKS.md, "Side characters and generated archetype voices") ----------------------------------------

const manifestsOf = async () => Object.fromEntries(await Promise.all(Object.keys(LANGUAGE_PACKS).map(async language => [language, (await read(`characters/voice-language-clips/${language}.json`)).voices])));
const hexOfId = id => BigInt(id).toString(16).padStart(16, '0');
const stemOf = path => path.split('\\').pop();

test('every side character with a voice of its own has a one-line clip of the same game line in all ten languages', async () => {
  const sweep = (await read('characters/cast-sweep-voices.json')).characters;
  const roster = Object.fromEntries((await read('characters/roster.json')).map(row => [row.key, row]));
  const own = Object.entries(sweep).filter(([, row]) => row.clip);
  assert.equal(own.length, 45);
  const manifests = await manifestsOf();
  for (const [key, row] of own) {
    for (const language of Object.keys(LANGUAGE_PACKS)) {
      const voice = manifests[language][key];
      assert.ok(voice, `${language} has no clip for ${key}`);
      assert.equal(voice.kind, 'picked');
      assert.equal(voice.file, `picked/${key}.wav`);
      assert.equal(voice.exact, true);
      assert.equal(voice.gain, null);
      assert.equal(voice.lines.length, 1, `${language} ${key}: the English clip is one line`);
      assert.equal(voice.gender, roster[key].gender.toLowerCase(), `${language} ${key}`);
      assert.ok(voice.seconds >= 3 && voice.seconds <= 12, `${language} ${key} ${voice.seconds} s`);
      const [archive, path] = voice.lines[0];
      assert.ok(archive === 'content' || archive === 'ep1');
      assert.ok(path.includes(hexOfId(row.clip.id)), `${language} ${key}: the dub line of the English clip's string id ${hexOfId(row.clip.id)}`);
      assert.ok(stemOf(path).startsWith(row.clip.stem + '_'), `${language} ${key}: the same file stem as the English line`);
    }
  }
});

test('the new model-<model> archetype voices are in all ten languages, built from the dub lines of that voice model', async () => {
  const models = (await read('characters/model-voices.json')).voices;
  assert.equal(Object.keys(models).length, 47);
  const manifests = await manifestsOf();
  for (const [key, model] of Object.entries(models)) {
    for (const language of Object.keys(LANGUAGE_PACKS)) {
      const voice = manifests[language][key];
      assert.ok(voice, `${language} has no clip for ${key}`);
      assert.equal(voice.kind, 'archetypes');
      assert.equal(voice.file, `archetypes/${key}.wav`);
      assert.equal(voice.gender, model.gender.toLowerCase(), `${language} ${key}`);
      assert.equal(voice.gain, null);
      assert.ok(voice.lines.length >= 2, `${language} ${key}: ${voice.lines.length} lines`);
      assert.ok(voice.seconds >= 5 && voice.seconds <= 19.9, `${language} ${key}: ${voice.seconds} s`);
      for (const [, path] of voice.lines) assert.ok(stemOf(path).startsWith(model.voiceset + '_'), `${language} ${key}: ${path} is a line of ${model.voiceset}`);
    }
  }
});

test('every archetype voice the voice service can pick has a clip in all ten languages (the five that were missing from the packs among them)', async () => {
  const english = (await read('characters/voice-clips-manifest.json')).voices;
  const manifests = await manifestsOf();
  const archetypes = Object.keys(english).filter(key => /^(npc|model)-/.test(key));
  assert.ok(archetypes.length >= 230, `${archetypes.length} archetype voices`);
  for (const language of Object.keys(LANGUAGE_PACKS)) {
    const gone = archetypes.filter(key => !manifests[language][key]);
    assert.deepEqual(gone, [], `${language} lacks archetype voices`);
  }
  for (const key of ['npc-joytoy-female', 'npc-joytoy-male', 'npc-maxtac-male', 'npc-maxtac-male-v2', 'npc-nusa-male-v2']) {
    for (const language of Object.keys(LANGUAGE_PACKS)) assert.ok(manifests[language][key], `${language} ${key}`);
  }
});

test('a side character mapped to a voice model speaks that model\'s language entry, whatever the language', async () => {
  const sweep = (await read('characters/cast-sweep-voices.json')).characters;
  const models = (await read('characters/model-voices.json')).voices;
  const manifests = await manifestsOf();
  const mapped = Object.entries(sweep).filter(([, row]) => row.voiceModel && !row.clip);
  assert.ok(mapped.length >= 130, `${mapped.length} mapped people`);
  // the voice service's own alias lookup (bridge/voice-fallbacks.mjs) gives the archetype key a language entry is looked up under
  const alias = fallbackAliases(readFallbacks(await readFile(join(ROOT, 'characters', 'cast-sweep-voices.json'), 'utf8')));
  let onNew = 0;
  for (const [key, row] of mapped) {
    assert.equal(alias(key), row.fallback, key);
    for (const language of Object.keys(LANGUAGE_PACKS)) assert.ok(manifests[language][row.fallback], `${language}: ${key} is mapped to ${row.fallback}, which has no language entry`);
    if (row.fallback.startsWith('model-')) {
      onNew++;
      assert.equal(models[row.fallback].voiceset, row.voiceModel.model, `${key}: the voice model of the alias`);
      for (const language of Object.keys(LANGUAGE_PACKS)) for (const [, path] of manifests[language][row.fallback].lines) assert.ok(stemOf(path).startsWith(row.voiceModel.model + '_'), `${language} ${key}`);
    }
  }
  assert.ok(onNew >= 50, `${onNew} people on the new voices`);
  // the others (guessed from the role) speak their archetype's entry too
  for (const [key, row] of Object.entries(sweep)) for (const language of Object.keys(LANGUAGE_PACKS)) assert.ok(manifests[language][row.fallback] || row.clip, `${language}: ${key} -> ${row.fallback}`);
});
