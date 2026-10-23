// The Pocket TTS language model packs (packaging/build-pocket-models.mjs): the configuration edit, the manifest, the notice and the zip layout.
// Tiny stand-in files only; nothing here touches the network or the real models.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BUILT, CHANGES_SENTENCE, INSTALL_NOTE_NAME, LANGUAGES, PROHIBITED_USE, UPSTREAM, buildLanguage, buildManifest, buildNotice, checkConfig, manifestText,
  packBase, parseConfig, relocateConfig, zipEntryNames,
} from './build-pocket-models.mjs';
import {listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';

const ROOT = 'red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const gitId = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

// Kyutai's v4.0.0 french.yaml shape: hf:// paths, a comment, the replace_characters block (quoted keys, non-ASCII), a commented weights line.
const UPSTREAM_YAML = `weights_path: hf://kyutai/pocket-tts/languages/french/model.safetensors@3e82814a68665eec246ff649b14c71331f955c06
weights_path_without_voice_cloning: hf://kyutai/pocket-tts-without-voice-cloning/languages/french/model.safetensors@1e08e6a23401048648a9fdcfde2f89348

remove_semicolons: true
# Replace characters that are absent from the training data.
replace_characters:
  '"': ''
  '“': ''
  '«': ''
  '’': "'"
  ':': ','
  '–': ','

flow_lm:
  insert_bos_before_voice: true
  dtype: float32
  flow:
    depth: 6
    dim: 512
  transformer:
    d_model: 1024
    hidden_scale: 4
    max_period: 10000
    num_heads: 16
    num_layers: 6
  lookup_table:
    dim: 1024
    n_bins: 4000
    tokenizer: tokenizers
    tokenizer_path: hf://kyutai/pocket-tts-without-voice-cloning/languages/french/tokenizer.json@8843db76457a91db32077edf8dfcd1c0e3e755fd
  #weights_path: partial.safetensors

mimi:
  dtype: float32
  sample_rate: 24000
  inner_dim: 32
  outer_dim: 512
  channels: 1
  frame_rate: 12.5
  seanet:
    dimension: 512
    ratios:
    - 6
    - 5
    - 4
  transformer:
    d_model: 512
    num_layers: 2
    output_dimensions:
    - 512
  #weights_path: codec.safetensors
`;

test('the configuration edit changes the three paths and nothing else', () => {
  const edited = relocateConfig(UPSTREAM_YAML);
  const before = UPSTREAM_YAML.split('\n'), after = edited.split('\n');
  assert.equal(after.length, before.length);
  const changed = before.map((line, i) => [line, after[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(changed.map(([, b]) => b), [
    'weights_path: model.safetensors',
    'weights_path_without_voice_cloning: null',
    '    tokenizer_path: tokenizer.json',
  ]);
  // The comments, the replace_characters block (UTF-8) and the commented weights lines are untouched.
  assert.ok(edited.includes('# Replace characters that are absent from the training data.'));
  assert.ok(edited.includes('  \'«\': \'\'\n  \'’\': "\'"'));
  assert.ok(edited.includes('  #weights_path: partial.safetensors') && edited.includes('  #weights_path: codec.safetensors'));
  const config = parseConfig(edited);
  assert.equal(config.weights_path, 'model.safetensors');
  assert.equal(config.weights_path_without_voice_cloning, null);
  assert.equal(config.flow_lm.lookup_table.tokenizer_path, 'tokenizer.json');
  assert.equal(config.flow_lm.transformer.num_layers, 6);
  assert.equal(config.flow_lm.dtype, 'float32');
  assert.equal(config.mimi.dtype, 'float32');
  assert.equal(config.mimi.sample_rate, 24000);
  assert.equal(config.mimi.channels, 1);
  assert.equal(config.replace_characters['’'], '\'');
  assert.deepEqual(config.mimi.seanet.ratios, [6, 5, 4]);
  // CRLF files keep their line ends.
  assert.equal(relocateConfig(UPSTREAM_YAML.replace(/\n/g, '\r\n')), edited.replace(/\n/g, '\r\n'));
});

test('a configuration that is not the 6-layer float32 24 kHz mono model is rejected', () => {
  assert.throws(() => relocateConfig(UPSTREAM_YAML.replace('num_layers: 6', 'num_layers: 24')), /num_layers is 24, expected 6/);
  assert.throws(() => relocateConfig(UPSTREAM_YAML.replace('dtype: float32\n  flow:', 'dtype: bfloat16\n  flow:')), /flow_lm\.dtype/);
  assert.throws(() => relocateConfig(UPSTREAM_YAML.replace('sample_rate: 24000', 'sample_rate: 16000')), /sample_rate/);
  assert.throws(() => relocateConfig(UPSTREAM_YAML.replace('channels: 1\n  frame_rate', 'channels: 2\n  frame_rate')), /mimi\.channels/);
  // A path line that is missing or doubled cannot be edited safely.
  assert.throws(() => relocateConfig(UPSTREAM_YAML.replace(/^weights_path: .*\n/m, '')), /0 "weights_path" lines/);
  assert.throws(() => relocateConfig(UPSTREAM_YAML + 'mimi2:\n  tokenizer_path: x\n'), /2 "flow_lm\.lookup_table\.tokenizer_path" lines/);
  // The checker also refuses the unedited upstream paths.
  assert.throws(() => checkConfig(parseConfig(UPSTREAM_YAML)), /weights_path/);
});

test('the manifest has the fields and values the bridge validates', () => {
  for (const [lang, info] of Object.entries(LANGUAGES)) {
    const files = Object.fromEntries(['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt'].map((name, i) => [name, {bytes: 10 + i, sha256: sha256(name)}]));
    const manifest = buildManifest(lang, files);
    assert.deepEqual(Object.keys(manifest), ['version', 'kind', 'language', 'languageTag', 'pocketLanguage', 'built', 'pocketSource', 'layers', 'files', 'upstream', 'needsVoicePack', 'changes']);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.kind, 'pocket-language-model');
    assert.equal(manifest.language, lang);
    assert.equal(manifest.languageTag, info.tag);
    assert.equal(manifest.pocketLanguage, info.pocket);
    assert.equal(manifest.built, '2026-10-22');
    assert.equal(manifest.pocketSource, '3.3.0');
    assert.equal(manifest.layers, 6);
    assert.deepEqual(Object.keys(manifest.files), ['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt']);
    assert.equal(manifest.files['pocket-model.json'], undefined);
    assert.deepEqual(manifest.upstream, {
      repo: 'kyutai/pocket-tts', revision: 'db04f0e653473e5c7333c69686ac92b7460b0c1d', path: `languages/${info.pocket}/model.safetensors`,
      tokenizerRepo: 'kyutai/pocket-tts-without-voice-cloning', tokenizerRevision: 'a7056f505a4a8ca72d8b5fb1440071d6f1a35739',
      configSource: `kyutai-labs/pocket-tts v4.0.0 pocket_tts/config/${info.pocket}.yaml`, license: 'CC-BY-4.0',
    });
    assert.deepEqual(manifest.needsVoicePack, {language: lang, minManifestVersion: 1});
    assert.equal(manifest.changes, 'inference.yaml: weight and tokenizer paths point at the local files; the weights and the tokenizer are unmodified');
    assert.equal(JSON.parse(manifestText(manifest)).language, lang);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(LANGUAGES).map(([lang, info]) => [lang, [info.tag, info.pocket]])), {
    fr: ['fr', 'french'], it: ['it', 'italian'], de: ['de', 'german'], 'es-es': ['es', 'spanish'], 'pt-br': ['pt', 'portuguese']});
  assert.throws(() => buildManifest('fr', {}), /no size and sha256/);
  assert.throws(() => buildManifest('xx', {}), /unknown language/);
});

test('the notice carries the licence, Kyutai\'s prohibited-use terms and the changes', () => {
  for (const [lang, info] of Object.entries(LANGUAGES)) {
    const notice = buildNotice(lang).replace(/\r\n/g, '\n');
    assert.ok(notice.includes(`Kyutai's Pocket TTS ${info.title} model (kyutai/pocket-tts, languages/${info.pocket}/model.safetensors, revision ${UPSTREAM.revision})`));
    assert.ok(notice.includes('licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/); copyright Kyutai'));
    assert.ok(notice.includes('Kyutai\'s prohibited-use terms'));
    assert.ok(notice.includes(PROHIBITED_USE));
    assert.ok(notice.includes('voice impersonation or cloning without explicit and lawful consent'));
    assert.ok(notice.includes(CHANGES_SENTENCE));
    assert.ok(notice.includes('Changes: model.safetensors and tokenizer.json are unmodified. inference.yaml is Kyutai\'s configuration with the weight and tokenizer paths changed to the local files in this folder.'));
    assert.ok(notice.replace(/\s+/g, ' ').includes(`speak replies in ${info.title} in a character's voice cloned from the game's own dub of that character, from the multilingual pack of the same language`));
    assert.ok(/impersonate a real person/.test(notice));
  }
});

test('the zip layout is the sibling multilingual-pocket folder, sorted, with the install note first', () => {
  for (const lang of Object.keys(LANGUAGES)) {
    const names = zipEntryNames(lang);
    assert.equal(names[0], INSTALL_NOTE_NAME);
    const rest = names.slice(1);
    assert.deepEqual(rest.map(name => name.slice(`${ROOT}/${lang}/`.length)), ['NOTICE.txt', 'inference.yaml', 'model.safetensors', 'pocket-model.json', 'tokenizer.json']);
    for (const name of rest) assert.ok(name.startsWith(`red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket/${lang}/`), name);
    assert.equal(packBase(lang), `PocketTTS-Model-${LANGUAGES[lang].title}`);
  }
});

test('a build from stand-in files writes the zip and the listing (no checksum file), byte-identical on a rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-models-'));
  try {
    const model = randomBytes(4096), tokenizer = Buffer.from('{"tokenizer":"fake"}\n');
    await writeFile(join(dir, 'model.safetensors'), model);
    await writeFile(join(dir, 'tokenizer.json'), tokenizer);
    const pins = {model: {bytes: model.length, sha256: sha256(model)}, tokenizerGit: gitId(tokenizer)};
    const common = {modelPath: join(dir, 'model.safetensors'), tokenizerPath: join(dir, 'tokenizer.json'), configText: UPSTREAM_YAML, pins};
    const first = await buildLanguage('pt-br', {...common, out: join(dir, 'one')});
    const second = await buildLanguage('pt-br', {...common, out: join(dir, 'two')});
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.entries, 6);
    assert.equal(first.zip, join(dir, 'one', 'pt-br', 'PocketTTS-Model-Portuguese.zip'));
    assert.deepEqual((await readdir(join(dir, 'one', 'pt-br'))).sort(), ['PocketTTS-Model-Portuguese.files.json', 'PocketTTS-Model-Portuguese.zip'], 'no loose checksum file');
    assert.equal(sha256(await readFile(first.zip)), first.sha256);

    const entries = await listZip(first.zip);
    assert.deepEqual(entries.map(entry => entry.name), zipEntryNames('pt-br'));
    const read = async name => readEntry(first.zip, entries.find(entry => entry.name === name));
    const folder = `${ROOT}/pt-br`;
    assert.deepEqual(await read(`${folder}/model.safetensors`), model);
    assert.deepEqual(await read(`${folder}/tokenizer.json`), tokenizer);
    assert.equal((await read(`${folder}/inference.yaml`)).toString('utf8'), relocateConfig(UPSTREAM_YAML));
    const manifest = JSON.parse((await read(`${folder}/pocket-model.json`)).toString('utf8'));
    assert.equal(manifest.language, 'pt-br');
    assert.equal(manifest.languageTag, 'pt');
    assert.equal(manifest.built, BUILT);
    for (const name of ['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt']) {
      const data = await read(`${folder}/${name}`);
      assert.deepEqual(manifest.files[name], {bytes: data.length, sha256: sha256(data)}, name);
    }
    // The listing holds path, bytes and sha256 per file, the install note first.
    const listing = JSON.parse(await readFile(join(dir, 'one', 'pt-br', 'PocketTTS-Model-Portuguese.files.json'), 'utf8'));
    assert.deepEqual(listing.map(item => item.path), zipEntryNames('pt-br'));
    assert.deepEqual(listing.find(item => item.path.endsWith('model.safetensors')), {path: `${folder}/model.safetensors`, bytes: model.length, sha256: sha256(model)});
    // The entry timestamp comes from the manifest date: the first local header holds 00:00:00 on 22 October 2026 in DOS format.
    const header = (await readFile(first.zip)).subarray(0, 30);
    assert.equal(header.readUInt16LE(10), 0);
    assert.equal(header.readUInt16LE(12), ((2026 - 1980) << 9) | (10 << 5) | 22);

    // A model or tokenizer that is not the pinned file stops the build.
    await assert.rejects(buildLanguage('pt-br', {...common, out: join(dir, 'bad'), pins: {...pins, tokenizerGit: '0'.repeat(40)}}), /tokenizer\.json is not the pinned file/);
    await assert.rejects(buildLanguage('pt-br', {...common, out: join(dir, 'bad'), pins: {...pins, model: {...pins.model, sha256: 'a'.repeat(64)}}}), /sha256 .* differs from the pinned/);
    await assert.rejects(buildLanguage('pt-br', {...common, out: join(dir, 'bad'), pins: {...pins, model: {...pins.model, bytes: 5}}}), /expected 5/);
    await assert.rejects(buildLanguage('pt-br', {...common, out: join(dir, 'bad'), configText: UPSTREAM_YAML.replace('num_layers: 6', 'num_layers: 24')}), /expected 6/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
