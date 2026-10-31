// The Pocket TTS language model packs (packaging/build-pocket-models.mjs): the configuration edit, the manifest, the notice and the zip layout.
// Tiny stand-in files only; nothing here touches the network or the real models.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BUILT, CHANGES_SENTENCE, INSTALL_NOTE_NAME, LANGUAGES, PROHIBITED_USE, RUSSIAN_CHANGES_SENTENCE, RUSSIAN_UPSTREAM, STRESS_DATA, STRESS_DEFAULT_PATH, STRESS_SOURCE_PATH, UPSTREAM,
  buildLanguage, buildManifest, buildNotice, checkConfig, checkStressDictionary, manifestFiles, manifestText, packBase, parseConfig, parseSums, readRussianSource, relocateConfig,
  repositoryPath, russianFileNames, tokenizerName, zipEntryNames,
} from './build-pocket-models.mjs';
import {listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';

const ROOT = 'red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket';
// Kyutai's own languages (the Russian model is a fine-tune with its own files, tested at the end).
const KYUTAI = Object.entries(LANGUAGES).filter(([, info]) => !info.fineTune);
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
  for (const [lang, info] of KYUTAI) {
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
    fr: ['fr', 'french'], it: ['it', 'italian'], de: ['de', 'german'], 'es-es': ['es', 'spanish'], 'pt-br': ['pt', 'portuguese'], ru: ['ru', 'russian']});
  assert.throws(() => buildManifest('fr', {}), /no size and sha256/);
  assert.throws(() => buildManifest('xx', {}), /unknown language/);
});

test('the notice carries the licence, Kyutai\'s prohibited-use terms and the changes', () => {
  for (const [lang, info] of KYUTAI) {
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
  for (const [lang] of KYUTAI) {
    const names = zipEntryNames(lang);
    assert.equal(names[0], INSTALL_NOTE_NAME);
    const rest = names.slice(1);
    assert.deepEqual(rest.map(name => name.slice(`${ROOT}/${lang}/`.length)), ['NOTICE.txt', 'inference.yaml', 'model.safetensors', 'pocket-model.json', 'tokenizer.json']);
    for (const name of rest) assert.ok(name.startsWith(`red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket/${lang}/`), name);
    assert.equal(packBase(lang), `PocketTTS-Model-100M-${LANGUAGES[lang].title}`);
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
    assert.equal(first.zip, join(dir, 'one', 'pt-br', 'PocketTTS-Model-100M-Portuguese.zip'));
    assert.deepEqual((await readdir(join(dir, 'one', 'pt-br'))).sort(), ['PocketTTS-Model-100M-Portuguese.files.json', 'PocketTTS-Model-100M-Portuguese.zip'], 'no loose checksum file');
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
    const listing = JSON.parse(await readFile(join(dir, 'one', 'pt-br', 'PocketTTS-Model-100M-Portuguese.files.json'), 'utf8'));
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

// ---- the Russian model (genvoice/xVibePocketTTS): SentencePiece tokenizer.model, a stress table, its own notice ----------------------------------------

// The shape of the fine-tune's config.yaml: Kyutai's configuration with `tokenizer: sentencepiece` and a .model file (the key without voice cloning may be absent).
const RUSSIAN_YAML = UPSTREAM_YAML
  .replace(/^weights_path:.*$/m, 'weights_path: hf://genvoice/xVibePocketTTS/model.safetensors@ac4f9f11eb4a110964c75a1e6f4104005455ac18')
  .replace('    tokenizer: tokenizers\n', '    tokenizer: sentencepiece\n')
  .replace(/^( +)tokenizer_path:.*$/m, '$1tokenizer_path: hf://genvoice/xVibePocketTTS/tokenizer.model@ac4f9f11eb4a110964c75a1e6f4104005455ac18');

test('the Russian configuration is relocated to tokenizer.model and must say sentencepiece', () => {
  const edited = relocateConfig(RUSSIAN_YAML, {tokenizer: 'tokenizer.model'});
  const config = parseConfig(edited);
  assert.equal(config.flow_lm.lookup_table.tokenizer_path, 'tokenizer.model');
  assert.equal(config.flow_lm.lookup_table.tokenizer, 'sentencepiece');
  assert.equal(config.weights_path, 'model.safetensors');
  // A SentencePiece file under a configuration that says tokenizers would be read as JSON by the upstream loader: refused.
  assert.throws(() => relocateConfig(RUSSIAN_YAML.replace('tokenizer: sentencepiece', 'tokenizer: tokenizers'), {tokenizer: 'tokenizer.model'}), /tokenizer is "tokenizers", expected "sentencepiece"/);
  // The default stays tokenizer.json, and a key without voice cloning that is absent is accepted only for the fine-tune.
  assert.equal(parseConfig(relocateConfig(UPSTREAM_YAML)).flow_lm.lookup_table.tokenizer_path, 'tokenizer.json');
  const without = RUSSIAN_YAML.replace(/^weights_path_without_voice_cloning:.*\n/m, '');
  assert.throws(() => relocateConfig(without, {tokenizer: 'tokenizer.model'}), /0 "weights_path_without_voice_cloning" lines/);
  assert.equal(parseConfig(relocateConfig(without, {tokenizer: 'tokenizer.model', lenient: true})).flow_lm.lookup_table.tokenizer_path, 'tokenizer.model');
});

test('the Russian files are found from the configuration and the repository\'s checksum list', () => {
  assert.deepEqual(russianFileNames(RUSSIAN_YAML), {weights: 'model.safetensors', tokenizer: 'tokenizer.model'});
  assert.equal(repositoryPath('hf://genvoice/xVibePocketTTS/weights/x.safetensors@ac4f9f1', 'genvoice/xVibePocketTTS'), 'weights/x.safetensors');
  assert.equal(repositoryPath('./tokenizer.model', 'genvoice/xVibePocketTTS'), 'tokenizer.model');
  for (const bad of ['', '/etc/passwd', '../x', 'a\\b', 'https://example.com/x', 'hf://other/repo/x']) assert.throws(() => repositoryPath(bad, 'genvoice/xVibePocketTTS'), /cannot take/, bad);
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.deepEqual(parseSums(`${a}  model.safetensors\n${b.toUpperCase()} *./tokenizer.model\n\n`), {'model.safetensors': a, 'tokenizer.model': b});
  assert.throws(() => parseSums('not a checksum line'), /cannot read/);
});

test('the Russian pack lists tokenizer.model and the stress table, and the pack is named with its 90M parameters', () => {
  assert.equal(tokenizerName('ru'), 'tokenizer.model');
  assert.equal(tokenizerName('fr'), 'tokenizer.json');
  assert.deepEqual(manifestFiles('ru'), ['model.safetensors', 'tokenizer.model', 'inference.yaml', 'NOTICE.txt', 'stress-ru.bin']);
  assert.deepEqual(manifestFiles('fr'), ['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt']);
  const names = zipEntryNames('ru');
  assert.equal(names[0], INSTALL_NOTE_NAME);
  assert.deepEqual(names.slice(1).map(name => name.slice(`${ROOT}/ru/`.length)), ['NOTICE.txt', 'inference.yaml', 'model.safetensors', 'pocket-model.json', 'stress-ru.bin', 'tokenizer.model']);
  assert.equal(packBase('ru'), 'PocketTTS-Model-90M-Russian');
  assert.equal(LANGUAGES.ru.tag, 'ru');
  assert.equal(RUSSIAN_UPSTREAM.revision, 'ac4f9f11eb4a110964c75a1e6f4104005455ac18');
  assert.equal(RUSSIAN_UPSTREAM.tag, 'v0.1.0');
});

test('the Russian notice credits Kyutai and GenVoice, repeats the prohibited-use terms and names the stress data and its licence', () => {
  const notice = buildNotice('ru').replace(/\r\n/g, '\n');
  const flat = notice.replace(/\s+/g, ' ');
  assert.ok(notice.includes(PROHIBITED_USE), 'Kyutai\'s terms word for word');
  assert.ok(notice.includes('voice impersonation or cloning without explicit and lawful consent'));
  assert.ok(flat.includes('xVibePocketTTS by GenVoice') && flat.includes('https://huggingface.co/genvoice/xVibePocketTTS'));
  assert.ok(flat.includes('Code: MIT license'));
  assert.ok(flat.includes('Pocket TTS by Kyutai. https://kyutai.org/pocket-tts') && flat.includes('CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)'));
  assert.ok(flat.includes(RUSSIAN_UPSTREAM.revision) && flat.includes('tag v0.1.0'));
  assert.ok(flat.includes(STRESS_DATA.repository) && flat.includes(STRESS_DATA.commit) && flat.includes('CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/)'));
  assert.ok(flat.includes('Wiktionary'));
  assert.ok(notice.includes(RUSSIAN_CHANGES_SENTENCE));
  assert.ok(/impersonate a real person/.test(notice));
  // The licence of the data is the one the build script records beside the committed table.
  return readFile(STRESS_SOURCE_PATH, 'utf8').then(text => {
    const source = JSON.parse(text).source;
    assert.equal(source.repository, STRESS_DATA.repository);
    assert.equal(source.commit, STRESS_DATA.commit);
    assert.equal(source.license, STRESS_DATA.license);
  });
});

test('the committed stress table is valid and its record matches the file', async () => {
  const table = await readFile(STRESS_DEFAULT_PATH);
  const checked = checkStressDictionary(table);
  const record = JSON.parse(await readFile(STRESS_SOURCE_PATH, 'utf8'));
  assert.equal(checked.entries, record.counts.entries);
  assert.equal(checked.payloadSha256, record.payloadSha256);
  assert.equal(table.length, record.bytes);
  assert.throws(() => checkStressDictionary(Buffer.from('nothing')), /not a Russian stress dictionary/);
  const damaged = Buffer.from(table); damaged[100] ^= 0xff;
  assert.throws(() => checkStressDictionary(damaged));
});

test('a Russian build from stand-in files checks the repository\'s checksum list and writes the seven entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-russian-'));
  try {
    const source = join(dir, 'source');
    const model = randomBytes(4096), tokenizer = randomBytes(300);
    const config = Buffer.from(RUSSIAN_YAML);
    await mkdir(source, {recursive: true});
    await writeFile(join(source, 'model.safetensors'), model);
    await writeFile(join(source, 'tokenizer.model'), tokenizer);
    await writeFile(join(source, 'config.yaml'), config);
    await writeFile(join(source, 'SHA256SUMS'), `${sha256(model)}  model.safetensors\n${sha256(tokenizer)}  tokenizer.model\n${sha256(config)}  config.yaml\n`);
    const read = await readRussianSource(source);
    assert.deepEqual(read.pins, {model: {bytes: model.length, sha256: sha256(model)}, tokenizerSha256: sha256(tokenizer)});
    assert.equal(read.unpinned.length, 2, 'the pins are not in the build yet: the build says which values to pin');

    const first = await buildLanguage('ru', {...read, out: join(dir, 'one')});
    const second = await buildLanguage('ru', {...read, out: join(dir, 'two')});
    assert.equal(first.sha256, second.sha256, 'the same files give the same zip');
    assert.equal(first.entries, 7);
    assert.equal(first.zip, join(dir, 'one', 'ru', 'PocketTTS-Model-90M-Russian.zip'));
    const entries = await listZip(first.zip);
    assert.deepEqual(entries.map(entry => entry.name), zipEntryNames('ru'));
    const get = async name => readEntry(first.zip, entries.find(entry => entry.name === name));
    const folder = `${ROOT}/ru`;
    assert.deepEqual(await get(`${folder}/model.safetensors`), model);
    assert.deepEqual(await get(`${folder}/tokenizer.model`), tokenizer);
    assert.deepEqual(await get(`${folder}/stress-ru.bin`), await readFile(STRESS_DEFAULT_PATH));
    assert.equal(entries.find(entry => entry.name === `${folder}/tokenizer.json`), undefined);
    const yaml = (await get(`${folder}/inference.yaml`)).toString('utf8');
    assert.equal(parseConfig(yaml).flow_lm.lookup_table.tokenizer_path, 'tokenizer.model');
    assert.equal(parseConfig(yaml).flow_lm.lookup_table.tokenizer, 'sentencepiece');
    const manifest = JSON.parse((await get(`${folder}/pocket-model.json`)).toString('utf8'));
    assert.equal(manifest.language, 'ru');
    assert.equal(manifest.languageTag, 'ru');
    assert.equal(manifest.built, '2026-10-31');
    assert.equal(manifest.layers, 6);
    assert.deepEqual(Object.keys(manifest.files), ['model.safetensors', 'tokenizer.model', 'inference.yaml', 'NOTICE.txt', 'stress-ru.bin']);
    for (const name of Object.keys(manifest.files)) { const data = await get(`${folder}/${name}`); assert.deepEqual(manifest.files[name], {bytes: data.length, sha256: sha256(data)}, name); }
    assert.equal(manifest.upstream.repo, 'genvoice/xVibePocketTTS');
    assert.equal(manifest.upstream.revision, 'ac4f9f11eb4a110964c75a1e6f4104005455ac18');
    assert.equal(manifest.upstream.codeLicense, 'MIT');
    assert.deepEqual(manifest.upstream.base, {repo: 'kyutai/pocket-tts', license: 'CC-BY-4.0'});
    assert.deepEqual(manifest.tokenizer, {file: 'tokenizer.model', kind: 'sentencepiece'});
    assert.equal(manifest.stress.source.license, 'CC-BY-SA-4.0');
    assert.equal(manifest.stress.accent, 'U+0301');
    assert.deepEqual(manifest.needsVoicePack, {language: 'ru', minManifestVersion: 1});
    assert.equal((await get(`${folder}/NOTICE.txt`)).toString('utf8'), buildNotice('ru'));

    // A file that is not the one the repository lists stops the build, and so does a pack with no stress table or no checksum for its weights.
    await writeFile(join(source, 'tokenizer.model'), randomBytes(300));
    await assert.rejects(readRussianSource(source), /tokenizer\.model does not match the repository's checksum list/);
    await writeFile(join(source, 'tokenizer.model'), tokenizer);
    await writeFile(join(source, 'SHA256SUMS'), `${sha256(tokenizer)}  tokenizer.model\n${sha256(config)}  config.yaml\n`);
    await assert.rejects(readRussianSource(source), /no line for model\.safetensors/);
    await assert.rejects(buildLanguage('ru', {...read, out: join(dir, 'bad'), pins: {...read.pins, tokenizerSha256: 'f'.repeat(64)}}), /tokenizer\.model is not the expected file/);
    await assert.rejects(buildLanguage('ru', {...read, out: join(dir, 'bad'), stressPath: join(dir, 'missing.bin')}), /ENOENT/);
    await assert.rejects(buildLanguage('ru', {...read, out: join(dir, 'bad'), stressPath: join(source, 'tokenizer.model')}), /not a Russian stress dictionary/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
