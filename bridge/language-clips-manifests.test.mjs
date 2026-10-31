import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DUB_ARCHIVE_NAMES, readLanguageManifest} from './language-clips.mjs';
import {LANGUAGE_PACKS} from './voice-language-packs.mjs';

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
    assert.ok(keys.length >= 295 && keys.length <= 302, `${keys.length} voices`);
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
