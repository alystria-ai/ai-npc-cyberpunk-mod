// The Hugging Face layout from release 0.2.9 (docs/PACKAGING.md, "Hugging Face upload"): folders by kind, no product prefix on any file name,
// the Pocket language models are PocketTTS models, and no SHA256SUMS file anywhere.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HF = 'https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs';
const read = async rel => (await readFile(resolve(project, rel), 'utf8')).replaceAll('\r\n', '\n');

const python = ['python', 'py'].find(name => spawnSync(name, ['-I', '-c', 'import sys'], {encoding: 'utf8'}).status === 0);
const py = (args, options = {}) => spawnSync(python, ['-I', ...args], {encoding: 'utf8', cwd: project, ...options});

// pack id -> [zip a build writes, path in the repository]
const UPLOADS = {
  scripts: ['AI-NPC-Cyberpunk-Mod-Scripts-0.2.9.zip', 'Scripts.zip'],
  runtime: ['Runtime-0.2.9.zip', 'Runtime.zip'],
  omni: ['OmniPack-0.2.9.zip', 'voice/OmniPack.zip'],
  'localai-standard': ['LocalAI-Standard-0.2.9.zip', 'local-ai/LocalAI-Standard.zip'],
  'localai-lite': ['LocalAI-Lite-0.2.9.zip', 'local-ai/LocalAI-Lite.zip'],
  'mature-lite': ['Mature-Lite-0.2.9.zip', 'mature/Mature-Lite.zip'],
  'mature-standard': ['Mature-Standard-0.2.9.zip', 'mature/Mature-Standard.zip'],
  'micpack-european': ['MicPack-European-0.2.9.zip', 'mic/MicPack-European.zip'],
  'micpack-asian': ['MicPack-Asian-0.2.9.zip', 'mic/MicPack-Asian.zip'],
};

test('the uploader puts every pack in the folder of its kind under its unversioned name, and uploads no checksum file', {skip: !python && 'no Python'}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hf layout '));
  try {
    for (const [zip] of Object.values(UPLOADS)) await writeFile(join(directory, zip), 'x');
    await writeFile(join(directory, 'SHA256SUMS.txt'), 'old build leftover');
    for (const [pack, [zip, remote]] of Object.entries(UPLOADS)) {
      const run = py(['packaging/upload-packs.py', '--version', '0.2.9', '--pack', pack, '--packages', directory, '--dry-run']);
      assert.equal(run.status, 0, run.stderr);
      const lines = run.stdout.trim().split('\n');
      assert.equal(lines.length, 1, `${pack}: one file, no checksum file`);
      assert.equal(lines[0], `${join(directory, zip)} -> alystria-ai/ai-npc-cyberpunk-mod-packs/${remote}`);
    }
    // A pack in parts, or a missing zip, is refused.
    await writeFile(join(directory, 'OmniPack-0.2.9-part1of2.zip'), 'x');
    assert.notEqual(py(['packaging/upload-packs.py', '--version', '0.2.9', '--pack', 'omni', '--packages', directory, '--dry-run']).status, 0);
    assert.notEqual(py(['packaging/upload-packs.py', '--version', '0.2.8', '--pack', 'omni', '--packages', directory, '--dry-run']).status, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the migration script plans copies to the new folders and names, deletes the old paths and every checksum file, and changes nothing without --apply', {skip: !python && 'no Python'}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hf reorganize '));
  try {
    const prefix = 'AI-NPC-Cyberpunk-Mod-';
    const old = [
      ...['Scripts', 'Runtime', 'LocalAI-Lite', 'LocalAI-Standard', 'Mature-Lite', 'Mature-Standard', 'MicPack-Asian', 'MicPack-European', 'OmniPack'].map(name => `${prefix}${name}.zip`),
      ...['SHA256SUMS-omni.txt', 'SHA256SUMS-runtime.txt', 'SHA256SUMS-scripts.txt', 'SHA256SUMS-localai-lite.txt', 'updates/SHA256SUMS.txt', 'multilingual/SHA256SUMS.txt'],
      `updates/${prefix}Runtime-Update-0.2.7-to-0.2.8.zip`, `multilingual/${prefix}Voices-French.zip`, `multilingual/${prefix}Pocket-Portuguese.zip`,
      'README.md', 'LICENSE', '.gitattributes', 'updates/README.md', 'multilingual/README.md',
    ];
    const listing = join(directory, 'listing.json');
    await writeFile(listing, JSON.stringify(old.map(path => ({path, size: 10}))));
    const dry = py(['scripts/hf-reorganize-0.2.9.py', '--listing', listing]);
    assert.equal(dry.status, 0, dry.stderr);
    const copies = [...dry.stdout.matchAll(/^ {2}COPY {3}(\S+) {2}->  (\S+)/gm)].map(match => [match[1], match[2]]);
    assert.deepEqual(copies, [
      [`${prefix}LocalAI-Lite.zip`, 'local-ai/LocalAI-Lite.zip'], [`${prefix}LocalAI-Standard.zip`, 'local-ai/LocalAI-Standard.zip'],
      [`${prefix}Mature-Lite.zip`, 'mature/Mature-Lite.zip'], [`${prefix}Mature-Standard.zip`, 'mature/Mature-Standard.zip'],
      [`${prefix}MicPack-Asian.zip`, 'mic/MicPack-Asian.zip'], [`${prefix}MicPack-European.zip`, 'mic/MicPack-European.zip'],
      [`${prefix}OmniPack.zip`, 'voice/OmniPack.zip'], [`${prefix}Runtime.zip`, 'Runtime.zip'], [`${prefix}Scripts.zip`, 'Scripts.zip'],
      [`multilingual/${prefix}Pocket-Portuguese.zip`, 'multilingual/PocketTTS-Model-Portuguese.zip'],
      [`multilingual/${prefix}Voices-French.zip`, 'multilingual/Voices-French.zip'],
      [`updates/${prefix}Runtime-Update-0.2.7-to-0.2.8.zip`, 'updates/Runtime-Update-0.2.7-to-0.2.8.zip'],
    ]);
    const deleted = [...dry.stdout.matchAll(/^ {2}DELETE (\S+)/gm)].map(match => match[1]);
    for (const [from] of copies) assert(deleted.includes(from), `${from} is deleted after the copy`);
    for (const sums of old.filter(path => /SHA256SUMS/.test(path))) assert(deleted.includes(sums), `${sums} is deleted`);
    assert.equal(deleted.length, copies.length + 6);
    for (const kept of ['README.md', 'LICENSE', '.gitattributes', 'updates/README.md', 'multilingual/README.md']) assert.match(dry.stdout, new RegExp(`keep {3}${kept.replace('.', '\\.')}`));
    assert.match(dry.stdout, /One commit with 12 copies and 18 deletes/);
    assert.match(dry.stdout, /Dry run: nothing was changed/);
    // The default is a dry run, and --apply cannot be combined with a saved listing.
    assert.notEqual(py(['scripts/hf-reorganize-0.2.9.py', '--listing', listing, '--apply']).status, 0);
    // A target that already exists is a problem, never an overwrite.
    await writeFile(listing, JSON.stringify([...old, 'Runtime.zip']));
    const clash = py(['scripts/hf-reorganize-0.2.9.py', '--listing', listing]);
    assert.notEqual(clash.status, 0);
    assert.match(clash.stdout, /PROBLEM: .*Runtime\.zip: the target already exists/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the migration script reads its token from the file, never prints it, and does not apply by default', async () => {
  const script = await read('scripts/hf-reorganize-0.2.9.py');
  assert.match(script, /TOKEN_FILE = "runtime\/huggingface-alystria-token\.txt"/);
  assert.doesNotMatch(script, /print\([^)]*token/i, 'the token is never printed');
  assert.doesNotMatch(script, /hf_[A-Za-z0-9]{20,}/, 'no token in the script');
  assert.match(script, /CommitOperationCopy/);
  assert.equal(script.split('create_commit(').length - 1, 1, 'one commit');
  assert.match(script, /if not args\.apply:\n\s+print\("\\nDry run: nothing was changed/);
});

test('no tool writes, uploads or mentions a loose checksum file, and the builders drop the product prefix (the Scripts for Nexus keep it)', async () => {
  for (const rel of ['packaging/build-release.mjs', 'packaging/upload-packs.py', 'packaging/build-pocket-models.mjs', 'scripts/voice-packs/package_pack.mjs',
    'scripts/voice-packs/finish_pack.py', 'scripts/voice-packs/final_pass.py', '.github/workflows/release.yml']) {
    assert.doesNotMatch(await read(rel), /SHA256SUMS/i, rel);
  }
  const builder = await read('packaging/build-release.mjs');
  assert.match(builder, /id === 'scripts' \? `\$\{config\.product\}-Scripts-\$\{version\}` : `\$\{titles\[id\]\}-\$\{version\}`/);
  assert.match(await read('packaging/build-runtime-update.mjs'), /const base = `Runtime-Update-\$\{from\}-to-\$\{to\}`/);
  assert.match(await read('packaging/build-pocket-models.mjs'), /`PocketTTS-Model-\$\{languageInfo\(lang\)\.title\}`/);
  assert.match(await read('scripts/voice-packs/package_pack.mjs'), /`Voices-\$\{LANGUAGE_NAMES\[language\]\}`/);
});

test('the player texts link the files at their folders and new names, say nothing of checksum files, and the Nexus page has no semicolons and no "18+"', async () => {
  const texts = {};
  for (const rel of ['README.md', 'packaging/PLAYER_README.md', 'packaging/HF_MODEL_CARD.md', 'packaging/HF_MULTILINGUAL_README.md', 'docs/NEXUS_PAGE.md',
    'docs/LOCAL_AI.md', 'docs/PACKAGING.md', 'docs/POCKET_LANGUAGE_MODELS.md', 'packaging/MATURE_PACK_README.md', 'packaging/MATURE_PACK_RELEASE_NOTES.md']) {
    texts[rel] = await read(rel);
    assert.doesNotMatch(texts[rel], /\/blob\/main\/AI-NPC-Cyberpunk-Mod-|\/resolve\/main\/(?:[\w-]+\/)?AI-NPC-Cyberpunk-Mod-/, `${rel}: no link to a file under its old name`);
    assert.doesNotMatch(texts[rel], /SHA256SUMS/, `${rel}: no checksum files`);
  }
  const nexus = texts['docs/NEXUS_PAGE.md'];
  assert.doesNotMatch(nexus, /;/, 'no semicolons on Nexus');
  assert.doesNotMatch(nexus, /18\+/, 'no "18+" on Nexus');
  for (const link of ['Runtime.zip', 'local-ai/LocalAI-Standard.zip', 'local-ai/LocalAI-Lite.zip', 'voice/OmniPack.zip', 'mature/Mature-Lite.zip', 'mature/Mature-Standard.zip',
    'mic/MicPack-European.zip', 'mic/MicPack-Asian.zip']) assert(nexus.includes(`${HF}/blob/main/${link}`), `the Nexus page links ${link}`);
  assert(nexus.includes(`${HF}/tree/main/updates`) && nexus.includes(`${HF}/tree/main/multilingual`), 'the updates and multilingual folder links are the same as before');
  // Every file name on HF has lost the prefix: the model card lists the new paths.
  const card = texts['packaging/HF_MODEL_CARD.md'];
  for (const path of ['Scripts.zip', 'Runtime.zip', 'local-ai/', 'mature/', 'mic/', 'voice/', 'updates/', 'multilingual/']) assert(card.includes(path), `the model card lists ${path}`);
  assert.doesNotMatch(card, /Pocket language model/i, 'the Pocket language models are PocketTTS models in the texts players read');
});
