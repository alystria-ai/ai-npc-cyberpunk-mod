// Builds the optional PocketTTS models (the Pocket voice speaking another language): PocketTTS-Model-<Language>.zip (French, Italian, German, Spanish, Portuguese).
// They are published in the multilingual/ folder of the Hugging Face repository.
//
//   node packaging/build-pocket-models.mjs --languages fr,it,de,es-es,pt-br --gated-cache <folder> --out E:/SteamLibrary/AiNpc-voice-packs/pocket
//        [--token-file <path>] [--download]
//
// Each zip carries one language of Kyutai's Pocket TTS (CC-BY-4.0, the gated cloning weights of kyutai/pocket-tts) under
// red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket/<lang>/, a sibling of the voice language pack's multilingual/<lang>/ folder:
//   model.safetensors   the gated file, byte for byte
//   tokenizer.json      from kyutai/pocket-tts-without-voice-cloning (the same file as in the gated repo)
//   inference.yaml      Kyutai's v4.0.0 configuration with ONLY the weight and tokenizer paths changed to the local files
//   NOTICE.txt          licence, attribution, Kyutai's prohibited-use terms, the changes
//   pocket-model.json   the manifest the bridge validates (sizes and sha256 of the four files above)
// plus the fixed "HOW TO INSTALL" note every package carries. Written with the release builder's own ZipWriter: the same files always give a
// byte-identical zip (entries sorted, one fixed timestamp from the manifest's `built` date).
//
// Without --download only what is already in the caches is used and a missing file stops the build with a message. With --download the missing
// gated models are fetched from Hugging Face with the token read from --token-file (it only goes into an Authorization header, never into a log
// or a command line), and the missing tokenizers and configurations (public) are fetched too. Every file is checked against the size and
// sha256 pinned below before it is used.
import {mkdir, readFile, rename, stat, writeFile, link, symlink, copyFile, rm} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ZipWriter} from './lib/zip.mjs';

export const BUILT = '2026-10-22';
export const POCKET_SOURCE = '3.3.0';
export const LAYERS = 6;
export const UPSTREAM = {
  repo: 'kyutai/pocket-tts',
  revision: 'db04f0e653473e5c7333c69686ac92b7460b0c1d',
  tokenizerRepo: 'kyutai/pocket-tts-without-voice-cloning',
  tokenizerRevision: 'a7056f505a4a8ca72d8b5fb1440071d6f1a35739',
  configTag: 'v4.0.0',
  license: 'CC-BY-4.0',
};
const MODEL_ROOT = 'red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual-pocket';

// The five languages: the voice-pack folder name, the reply-language code, Kyutai's name, and the pinned files (sizes and sha256 of the upstream
// files; `tokenizerGit` is the git blob id Hugging Face lists for tokenizer.json, which is the same file in both repositories).
export const LANGUAGES = {
  fr: {
    tag: 'fr', pocket: 'french', title: 'French',
    model: {bytes: 219029196, sha256: '08404fdbce73127ef0c2189dc173cc07d8f721389ecc2e2482053479a6ce114c'},
    tokenizerGit: '1b1771e8304a781fef547c86026ad2528cd9ba30',
  },
  it: {
    tag: 'it', pocket: 'italian', title: 'Italian',
    model: {bytes: 219029196, sha256: '11c226c14deb3e403d6a3fb5a52cb5cffdce85b93ba782344cea430370e2d4ab'},
    tokenizerGit: '9f131c421f0d3fea1d364bf06fa099e88f0b9b2b',
  },
  de: {
    tag: 'de', pocket: 'german', title: 'German',
    model: {bytes: 219029196, sha256: '3b6702b36f4387735031226cc012f7b90a7a13e6bee4d3b0ce3929736e5e150a'},
    tokenizerGit: '301669c38c68dbde14598f126b748cc201e980be',
  },
  'es-es': {
    tag: 'es', pocket: 'spanish', title: 'Spanish',
    model: {bytes: 219029196, sha256: 'ca87ef1aadc9280a97358a5250d8a508e15b5c10d502e8e1c1d4afd4d784de96'},
    tokenizerGit: '3688d1dc50e27ea062c46d0472b1ba82fdbcb7c2',
  },
  'pt-br': {
    tag: 'pt', pocket: 'portuguese', title: 'Portuguese',
    model: {bytes: 219029196, sha256: '32ddeaeb06f8e824d85c030d31625e08b0e6b6e2283d20024dcc18786065dbd4'},
    tokenizerGit: '7c07317c6c617d98bfc412473a9b357f83717d76',
  },
};

export const INSTALL_NOTE_NAME = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
// The same fixed text as scripts/voice-packs/package_pack.mjs and packaging/build-release.mjs.
export const INSTALL_NOTE = [
  'AI NPC Cyberpunk Mod',
  '',
  'Extract this zip INTO your Cyberpunk 2077 folder (the folder that has bin, archive and r6 in it), and allow folders to merge.',
  'The zip already starts with the right folders (red4ext or bin).',
  '',
  'Do not extract it into a new folder named after the zip. Windows "Extract All" and 7-Zip "Extract to <name>" do that by default:',
  'change the destination to the Cyberpunk 2077 folder itself. If it happened anyway, the mod moves its optional pack files into',
  'place by itself the next time the game starts.',
  '',
  'You can delete this text file after installing.',
  ''].join('\r\n');

// Kyutai's prohibited-use terms, word for word from the "Prohibited use" section of the kyutai/pocket-tts model card at the pinned revision.
export const PROHIBITED_USE = 'Use of our model must comply with all applicable laws and regulations and must not result in, involve, or facilitate any illegal, harmful, '
  + 'deceptive, fraudulent, or unauthorized activity. Prohibited uses include, without limitation, voice impersonation or cloning without explicit and lawful '
  + 'consent; misinformation, disinformation, or deception (including fake news, fraudulent calls, or presenting generated content as genuine recordings of '
  + 'real people or events); and the generation of unlawful, harmful, libelous, abusive, harassing, discriminatory, hateful, or privacy-invasive content. '
  + 'We disclaim all liability for any non-compliant use.';

export const CHANGES_SENTENCE = 'Changes: model.safetensors and tokenizer.json are unmodified. inference.yaml is Kyutai\'s configuration with the weight and tokenizer '
  + 'paths changed to the local files in this folder.';

const sha256Of = buffer => createHash('sha256').update(buffer).digest('hex');
const sha256File = path => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolveHash(hash.digest('hex')));
});
const gitBlobId = buffer => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function languageInfo(lang) {
  const info = LANGUAGES[lang];
  if (!info) throw Error(`unknown language "${lang}" (expected one of ${Object.keys(LANGUAGES).join(', ')})`);
  return {lang, ...info};
}

// ---- the configuration -------------------------------------------------------------------------------------------------------------

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === '\'') quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function parseScalar(text) {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  if (value.startsWith('\'')) {
    if (!value.endsWith('\'') || value.length < 2) throw Error(`unsupported YAML scalar: ${value}`);
    return value.slice(1, -1).replace(/''/g, '\'');
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw Error(`unsupported YAML scalar: ${value}`);
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (/^[[{|>&*!]/.test(value)) throw Error(`unsupported YAML scalar: ${value}`);
  return value;
}
function splitKey(text) {
  let key, rest;
  if (text[0] === '\'' || text[0] === '"') {
    let end = 1;
    for (; end < text.length; end++) {
      if (text[0] === '"' && text[end] === '\\') end++;
      else if (text[end] === text[0]) {
        if (text[0] === '\'' && text[end + 1] === '\'') end++;
        else break;
      }
    }
    key = parseScalar(text.slice(0, end + 1));
    rest = text.slice(end + 1);
    if (!rest.startsWith(':')) throw Error(`unsupported YAML line: ${text}`);
    rest = rest.slice(1);
  } else {
    const at = text.search(/:(?:\s|$)/);
    if (at < 0) throw Error(`unsupported YAML line: ${text}`);
    key = text.slice(0, at);
    rest = text.slice(at + 1);
  }
  return [String(key), rest.trim()];
}

// A small reader for the subset Kyutai's configuration files use (nested mappings, block lists, plain / quoted scalars, comments). It exists so
// the build can check the file it ships without a YAML package; it throws on anything it does not understand.
export function parseConfig(text) {
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const code = stripComment(raw).replace(/\s+$/, '');
    if (!code.trim()) continue;
    if (/\t/.test(code.match(/^\s*/)[0])) throw Error('unsupported YAML: tab indentation');
    lines.push({indent: code.match(/^ */)[0].length, text: code.trim()});
  }
  let at = 0;
  const isItem = line => line.text === '-' || line.text.startsWith('- ');
  function readList(indent) {
    const list = [];
    while (at < lines.length && lines[at].indent === indent && isItem(lines[at])) {
      list.push(parseScalar(lines[at].text.slice(1)));
      at++;
    }
    return list;
  }
  function readMap(indent) {
    const map = {};
    while (at < lines.length && lines[at].indent === indent && !isItem(lines[at])) {
      const [key, rest] = splitKey(lines[at].text);
      at++;
      if (Object.hasOwn(map, key)) throw Error(`duplicate YAML key: ${key}`);
      if (rest !== '') map[key] = parseScalar(rest);
      else if (at < lines.length && lines[at].indent > indent) map[key] = readMap(lines[at].indent);
      else if (at < lines.length && lines[at].indent === indent && isItem(lines[at])) map[key] = readList(indent);
      else map[key] = null;
    }
    return map;
  }
  if (!lines.length) throw Error('the configuration is empty');
  const root = readMap(lines[0].indent);
  if (at !== lines.length) throw Error(`unsupported YAML near: ${lines[at].text}`);
  return root;
}

// The checks every shipped configuration must pass: the 6-layer Pocket model the mod's runtime is built for, float32, 24 kHz mono, and the
// local paths this pack puts in place.
export function checkConfig(config) {
  const problems = [];
  const expect = (label, actual, wanted) => { if (actual !== wanted) problems.push(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`); };
  expect('flow_lm.transformer.num_layers', config?.flow_lm?.transformer?.num_layers, LAYERS);
  expect('flow_lm.dtype', config?.flow_lm?.dtype, 'float32');
  expect('mimi.dtype', config?.mimi?.dtype, 'float32');
  expect('mimi.sample_rate', config?.mimi?.sample_rate, 24000);
  expect('mimi.channels', config?.mimi?.channels, 1);
  expect('weights_path', config?.weights_path, 'model.safetensors');
  expect('weights_path_without_voice_cloning', config?.weights_path_without_voice_cloning, null);
  expect('flow_lm.lookup_table.tokenizer_path', config?.flow_lm?.lookup_table?.tokenizer_path, 'tokenizer.json');
  if (problems.length) throw Error(`the configuration is not the expected Pocket ${LAYERS}-layer model: ${problems.join('; ')}`);
}

// Kyutai's configuration with only the three paths changed to the local files. Everything else, comments and the replace_characters block
// included, stays byte for byte. Throws when a line to change is missing or ambiguous, or when the result is not the expected 6-layer model.
export function relocateConfig(upstream) {
  const edits = [
    ['weights_path', /^weights_path:.*$/gm, 'weights_path: model.safetensors'],
    ['weights_path_without_voice_cloning', /^weights_path_without_voice_cloning:.*$/gm, 'weights_path_without_voice_cloning: null'],
    ['flow_lm.lookup_table.tokenizer_path', /^( +)tokenizer_path:.*$/gm, '$1tokenizer_path: tokenizer.json'],
  ];
  let text = upstream;
  for (const [label, pattern, replacement] of edits) {
    const found = text.match(pattern) ?? [];
    if (found.length !== 1) throw Error(`the configuration has ${found.length} "${label}" lines, expected exactly one`);
    text = text.replace(pattern, replacement);
  }
  checkConfig(parseConfig(text));
  return text;
}

// ---- notice and manifest -----------------------------------------------------------------------------------------------------------

export function buildNotice(lang) {
  const info = languageInfo(lang);
  const {title, pocket} = info;
  return [
    `Kyutai Pocket TTS - ${title} model`,
    `${'='.repeat(`Kyutai Pocket TTS - ${title} model`.length)}`,
    '',
    `This model is Kyutai's Pocket TTS ${title} model (${UPSTREAM.repo}, languages/${pocket}/model.safetensors, revision ${UPSTREAM.revision}), licensed `
      + `CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/); copyright Kyutai.`,
    '',
    'Attribution',
    '-----------',
    'Pocket TTS by Kyutai. https://kyutai.org/pocket-tts',
    `Model: https://huggingface.co/${UPSTREAM.repo} (languages/${pocket}/model.safetensors, revision ${UPSTREAM.revision}).`,
    `Tokenizer: https://huggingface.co/${UPSTREAM.tokenizerRepo} (languages/${pocket}/tokenizer.json, revision ${UPSTREAM.tokenizerRevision}).`,
    `Configuration: https://github.com/kyutai-labs/pocket-tts (tag ${UPSTREAM.configTag}, pocket_tts/config/${pocket}.yaml). The code is MIT-licensed.`,
    '',
    "Kyutai's prohibited-use terms",
    '-----------------------------',
    'Kyutai publishes the original weights behind a Hugging Face access form that asks for acceptance of the terms below. They are repeated here',
    'word for word, from the "Prohibited use" section of the model card, so they travel with this copy:',
    '',
    `"${PROHIBITED_USE}"`,
    '',
    'Changes',
    '-------',
    CHANGES_SENTENCE,
    '',
    'How this mod uses the model',
    '---------------------------',
    `The AI NPC Cyberpunk Mod uses this model only to speak replies in ${title} in a character's voice cloned from the game's own dub of that character,`,
    `from the voice language pack of the same language. Do not use it, with the mod or on its own, to impersonate a real person or to clone a real`,
    `person's voice without their explicit and lawful consent: Kyutai's terms above prohibit "voice impersonation or cloning without explicit and`,
    `lawful consent".`,
    ''].join('\r\n');
}

export function buildManifest(lang, files) {
  const info = languageInfo(lang);
  const order = ['model.safetensors', 'tokenizer.json', 'inference.yaml', 'NOTICE.txt'];
  for (const name of order) {
    const entry = files?.[name];
    if (!entry || !Number.isInteger(entry.bytes) || entry.bytes <= 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw Error(`no size and sha256 for ${name}`);
  }
  return {
    version: 1,
    kind: 'pocket-language-model',
    language: lang,
    languageTag: info.tag,
    pocketLanguage: info.pocket,
    built: BUILT,
    pocketSource: POCKET_SOURCE,
    layers: LAYERS,
    files: Object.fromEntries(order.map(name => [name, {bytes: files[name].bytes, sha256: files[name].sha256}])),
    upstream: {
      repo: UPSTREAM.repo,
      revision: UPSTREAM.revision,
      path: `languages/${info.pocket}/model.safetensors`,
      tokenizerRepo: UPSTREAM.tokenizerRepo,
      tokenizerRevision: UPSTREAM.tokenizerRevision,
      configSource: `kyutai-labs/pocket-tts ${UPSTREAM.configTag} pocket_tts/config/${info.pocket}.yaml`,
      license: UPSTREAM.license,
    },
    needsVoicePack: {language: lang, minManifestVersion: 1},
    changes: 'inference.yaml: weight and tokenizer paths point at the local files; the weights and the tokenizer are unmodified',
  };
}

export const manifestText = manifest => JSON.stringify(manifest, null, 2) + '\n';
export const packBase = lang => `PocketTTS-Model-${languageInfo(lang).title}`;

// The zip's entries in order: the install note, then the five pack files (sorted by name).
export function zipEntryNames(lang) {
  languageInfo(lang);
  const folder = `${MODEL_ROOT}/${lang}`;
  return [INSTALL_NOTE_NAME, ...['NOTICE.txt', 'inference.yaml', 'model.safetensors', 'pocket-model.json', 'tokenizer.json'].map(name => `${folder}/${name}`).sort(byName)];
}

// Builds one language's zip from the model and tokenizer files and the upstream configuration text. Returns what the caller prints.
// `pins` (tests only) replaces the pinned size, sha256 and tokenizer git id, so the build can run on tiny stand-in files.
export async function buildLanguage(lang, {modelPath, tokenizerPath, configText, out, pins}) {
  const info = {...languageInfo(lang), ...pins};
  const tokenizer = await readFile(tokenizerPath);
  if (gitBlobId(tokenizer) !== info.tokenizerGit) throw Error(`${lang}: tokenizer.json is not the pinned file (git id ${gitBlobId(tokenizer)})`);
  const modelStat = await stat(modelPath);
  if (modelStat.size !== info.model.bytes) throw Error(`${lang}: model.safetensors is ${modelStat.size} bytes, expected ${info.model.bytes}`);
  const modelSha = await sha256File(modelPath);
  if (modelSha !== info.model.sha256) throw Error(`${lang}: model.safetensors sha256 ${modelSha} differs from the pinned ${info.model.sha256}`);

  const yaml = Buffer.from(relocateConfig(configText), 'utf8');
  const notice = Buffer.from(buildNotice(lang), 'utf8');
  const manifest = buildManifest(lang, {
    'model.safetensors': {bytes: modelStat.size, sha256: modelSha},
    'tokenizer.json': {bytes: tokenizer.length, sha256: sha256Of(tokenizer)},
    'inference.yaml': {bytes: yaml.length, sha256: sha256Of(yaml)},
    'NOTICE.txt': {bytes: notice.length, sha256: sha256Of(notice)},
  });
  const manifestBuffer = Buffer.from(manifestText(manifest), 'utf8');

  const folder = `${MODEL_ROOT}/${lang}`;
  const sources = {
    [INSTALL_NOTE_NAME]: {buffer: Buffer.from(INSTALL_NOTE, 'utf8')},
    [`${folder}/NOTICE.txt`]: {buffer: notice},
    [`${folder}/inference.yaml`]: {buffer: yaml},
    [`${folder}/model.safetensors`]: {source: modelPath},
    [`${folder}/pocket-model.json`]: {buffer: manifestBuffer},
    [`${folder}/tokenizer.json`]: {buffer: tokenizer},
  };
  const names = zipEntryNames(lang);
  if (names.length !== Object.keys(sources).length) throw Error('the entry list and the sources disagree');

  const folderOut = resolve(out, lang);
  await mkdir(folderOut, {recursive: true});
  const base = packBase(lang);
  const temporary = resolve(folderOut, `${base}.zip.tmp`);
  const writer = await ZipWriter.create(temporary, {timestamp: new Date(`${BUILT}T00:00:00Z`)});
  const files = [];
  let archive;
  try {
    for (const name of names) {
      const added = await writer.add(name, sources[name]);
      files.push({path: name, bytes: sources[name].buffer ? sources[name].buffer.length : modelStat.size, sha256: added.sha256});
    }
    archive = await writer.close();
  } catch (error) {
    await writer.close().catch(() => {});
    await rm(temporary, {force: true});
    throw error;
  }
  const zipPath = resolve(folderOut, `${base}.zip`);
  await rename(temporary, zipPath);
  const zipSha = await sha256File(zipPath);
  await writeFile(resolve(folderOut, `${base}.files.json`), JSON.stringify(files, null, 1) + '\n');
  return {language: lang, zip: zipPath, bytes: archive.bytes, entries: archive.entries, sha256: zipSha, files: files.length};
}

// ---- caches and downloads ------------------------------------------------------------------------------------------------------------

export const cachePaths = (cacheRoot, lang) => {
  const {pocket} = languageInfo(lang);
  return {
    model: resolve(cacheRoot, 'models--kyutai--pocket-tts', 'snapshots', UPSTREAM.revision, 'languages', pocket, 'model.safetensors'),
    blobs: resolve(cacheRoot, 'models--kyutai--pocket-tts', 'blobs'),
    tokenizer: resolve(cacheRoot, 'public', pocket, 'tokenizer.json'),
    config: resolve(cacheRoot, 'public', pocket, `${pocket}.yaml`),
  };
};
const exists = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };

async function fetchToFile(url, destination, headers = {}) {
  const response = await fetch(url, {headers, redirect: 'follow'});
  if (!response.ok || !response.body) throw Error(`download failed (${response.status}) for ${url.replace(/\?.*$/, '')}`);
  await mkdir(dirname(destination), {recursive: true});
  const part = `${destination}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = async function* (source) { for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; yield chunk; } };
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part));
  return {part, bytes, sha256: hash.digest('hex')};
}

async function downloadModel(lang, cacheRoot, token) {
  const {pocket, model} = languageInfo(lang);
  const paths = cachePaths(cacheRoot, lang);
  const url = `https://huggingface.co/${UPSTREAM.repo}/resolve/${UPSTREAM.revision}/languages/${pocket}/model.safetensors`;
  const got = await fetchToFile(url, resolve(paths.blobs, `${model.sha256}.download`), {Authorization: `Bearer ${token}`});
  if (got.bytes !== model.bytes || got.sha256 !== model.sha256) {
    await rm(got.part, {force: true});
    throw Error(`${lang}: the downloaded model is ${got.bytes} bytes, sha256 ${got.sha256}; expected ${model.bytes} bytes, ${model.sha256}`);
  }
  const blob = resolve(paths.blobs, model.sha256);
  await rename(got.part, blob);
  await mkdir(dirname(paths.model), {recursive: true});
  await rm(paths.model, {force: true});
  // The Hugging Face cache layout: the snapshot entry is a relative link to the blob. Where links are not allowed it is a hard link, then a copy.
  const relative = ['..', '..', '..', '..', 'blobs', model.sha256].join('/');
  try { await symlink(relative, paths.model, 'file'); } catch { try { await link(blob, paths.model); } catch { await copyFile(blob, paths.model); } }
}

async function downloadPublic(lang, cacheRoot) {
  const {pocket, tokenizerGit} = languageInfo(lang);
  const paths = cachePaths(cacheRoot, lang);
  if (!await exists(paths.tokenizer)) {
    const url = `https://huggingface.co/${UPSTREAM.tokenizerRepo}/resolve/${UPSTREAM.tokenizerRevision}/languages/${pocket}/tokenizer.json`;
    const got = await fetchToFile(url, paths.tokenizer);
    const data = await readFile(got.part);
    if (gitBlobId(data) !== tokenizerGit) { await rm(got.part, {force: true}); throw Error(`${lang}: the downloaded tokenizer.json is not the pinned file`); }
    await rename(got.part, paths.tokenizer);
  }
  if (!await exists(paths.config)) {
    const url = `https://raw.githubusercontent.com/kyutai-labs/pocket-tts/${UPSTREAM.configTag}/pocket_tts/config/${pocket}.yaml`;
    const got = await fetchToFile(url, paths.config);
    await rename(got.part, paths.config);
  }
}

function parseArguments(argv) {
  const options = {download: false};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--download') options.download = true;
    else if (['--languages', '--gated-cache', '--out', '--token-file'].includes(argument)) {
      if (i + 1 >= argv.length) throw Error(`${argument} needs a value`);
      options[argument.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw Error(`unknown argument ${argument}`);
  }
  return options;
}

export async function main(argv) {
  const options = parseArguments(argv);
  if (!options.gatedCache || !options.out) throw Error('usage: node packaging/build-pocket-models.mjs --languages fr,it,de,es-es,pt-br --gated-cache <folder> --out <folder> [--token-file <path>] [--download]');
  const languages = (options.languages ?? Object.keys(LANGUAGES).join(',')).split(',').map(value => value.trim()).filter(Boolean);
  languages.forEach(languageInfo);
  const cacheRoot = resolve(options.gatedCache);
  const out = resolve(options.out);

  let token = null;
  const missingModels = [];
  for (const lang of languages) if (!await exists(cachePaths(cacheRoot, lang).model)) missingModels.push(lang);
  if (options.download) {
    if (missingModels.length) {
      if (!options.tokenFile) throw Error('--download needs --token-file for the gated models');
      token = (await readFile(resolve(options.tokenFile), 'utf8')).trim();
      if (!token) throw Error('the token file is empty');
    }
    for (const lang of missingModels) await downloadModel(lang, cacheRoot, token);
    for (const lang of languages) await downloadPublic(lang, cacheRoot);
  }

  const missing = [];
  for (const lang of languages) {
    const paths = cachePaths(cacheRoot, lang);
    for (const [label, path] of [['model', paths.model], ['tokenizer', paths.tokenizer], ['configuration', paths.config]]) if (!await exists(path)) missing.push(`${lang} ${label}: ${path}`);
  }
  if (missing.length) throw Error(`missing files (run with --download${options.tokenFile ? '' : ' and --token-file'} to fetch them):\n  ${missing.join('\n  ')}`);

  const results = [];
  for (const lang of languages) {
    const paths = cachePaths(cacheRoot, lang);
    const configText = await readFile(paths.config, 'utf8');
    results.push(await buildLanguage(lang, {modelPath: paths.model, tokenizerPath: paths.tokenizer, configText, out}));
    console.log(JSON.stringify(results.at(-1)));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
