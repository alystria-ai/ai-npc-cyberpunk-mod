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
  full: ['AI-NPC-LLM-Companions-0.2.9.zip', 'AI-NPC-LLM-Companions.zip'],
  update: ['AI-NPC-LLM-Companions-Update-0.2.8-to-0.2.9.zip', 'AI-NPC-LLM-Companions-Update.zip'],
  runtime: ['Runtime-0.2.9.zip', 'runtime/Runtime.zip'],
  omni: ['OmniPack-OmniVoice-0.6B-0.2.9.zip', 'voice/OmniPack-OmniVoice-0.6B.zip'],
  'localai-standard': ['LocalAI-Standard-Gemma-4-E4B-0.2.9.zip', 'local-ai/LocalAI-Standard-Gemma-4-E4B.zip'],
  'localai-lite': ['LocalAI-Lite-Bonsai-2-4B-0.2.9.zip', 'local-ai/LocalAI-Lite-Bonsai-2-4B.zip'],
  'mature-lite': ['Mature-Lite-Qwen3.5-4B-0.2.9.zip', 'mature/Mature-Lite-Qwen3.5-4B.zip'],
  'mature-standard': ['Mature-Standard-Gemma-4-E4B-0.2.9.zip', 'mature/Mature-Standard-Gemma-4-E4B.zip'],
  'micpack-european': ['MicPack-European-Parakeet-TDT-0.6B-v3-0.2.9.zip', 'mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip'],
  'micpack-asian': ['MicPack-Asian-SenseVoice-Small-234M-0.2.9.zip', 'mic/MicPack-Asian-SenseVoice-Small-234M.zip'],
};
// The same packs built before 0.3.4 (old zip names) are accepted and published under the new names; --also-old-name adds the old path.
const OLD = {
  omni: ['OmniPack-0.2.9.zip', 'voice/OmniPack.zip'], 'localai-standard': ['LocalAI-Standard-0.2.9.zip', 'local-ai/LocalAI-Standard.zip'],
  'localai-lite': ['LocalAI-Lite-0.2.9.zip', 'local-ai/LocalAI-Lite.zip'], 'mature-lite': ['Mature-Lite-0.2.9.zip', 'mature/Mature-Lite.zip'],
  'mature-standard': ['Mature-Standard-0.2.9.zip', 'mature/Mature-Standard.zip'], 'micpack-european': ['MicPack-European-0.2.9.zip', 'mic/MicPack-European.zip'],
  'micpack-asian': ['MicPack-Asian-0.2.9.zip', 'mic/MicPack-Asian.zip'],
};

test('a build folder that still holds a pack under its old name is accepted, and --also-old-name publishes the old path too', {skip: !python && 'no Python'}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hf legacy '));
  try {
    for (const [zip] of Object.values(OLD)) await writeFile(join(directory, zip), 'x');
    for (const [pack, [oldZip, oldRemote]] of Object.entries(OLD)) {
      const plain = py(['packaging/upload-packs.py', '--version', '0.2.9', '--pack', pack, '--packages', directory, '--dry-run']);
      assert.equal(plain.status, 0, plain.stderr);
      assert.deepEqual(plain.stdout.trim().split(/\r?\n/), [`${join(directory, oldZip)} -> alystria-ai/ai-npc-cyberpunk-mod-packs/${UPLOADS[pack][1]}`]);
      const both = py(['packaging/upload-packs.py', '--version', '0.2.9', '--pack', pack, '--packages', directory, '--dry-run', '--also-old-name']);
      assert.equal(both.status, 0, both.stderr);
      assert.deepEqual(both.stdout.trim().split(/\r?\n/), [`${join(directory, oldZip)} -> alystria-ai/ai-npc-cyberpunk-mod-packs/${UPLOADS[pack][1]}`,
        `${join(directory, oldZip)} -> alystria-ai/ai-npc-cyberpunk-mod-packs/${oldRemote}`]);
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

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
    await writeFile(join(directory, 'OmniPack-OmniVoice-0.6B-0.2.9-part1of2.zip'), 'x');
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
    for (const kept of ['LICENSE', '.gitattributes']) assert.match(dry.stdout, new RegExp(`keep {3}${kept.replaceAll('.', '[.]')}`));
    assert.doesNotMatch(dry.stdout, /keep {3}(?:updates\/|multilingual\/)?README\.md/, 'the three README files are replaced, not kept');
    assert.match(dry.stdout, /One commit with 12 copies, 18 deletes and 3 README files \((33 operations)\)/);
    for (const [path, source] of [['README.md', 'packaging/HF_MODEL_CARD.md'], ['updates/README.md', 'packaging/HF_UPDATES_README.md'], ['multilingual/README.md', 'packaging/HF_MULTILINGUAL_README.md']]) {
      assert(dry.stdout.includes(`WRITE  ${path}  (text of ${source})`), `${path} is replaced from ${source}`);
    }
    assert.doesNotMatch(dry.stdout, /\bAI NPC Cyberpunk Mod 0\.2\.9\b/, 'the commit message names no version');
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
  assert.match(builder, /id === 'scripts' \? updateBaseNameFor\(config, version, game\) : `\$\{titles\[id\]\}-\$\{version\}\$\{variant\.suffix\}`/);
  assert.match(await read('packaging/build-full.mjs'), /fullBaseName\(version, game\)/);
  assert.match(await read('packaging/build-runtime-update.mjs'), /const base = `Runtime-Update-\$\{from\}-to-\$\{to\}\$\{GAME_VARIANTS\[game\]\.suffix\}`/);
  assert.match(await read('packaging/build-pocket-models.mjs'), /pocketModelTitle\(RELEASE_CONFIG, languageInfo\(lang\)\.title\)/);
  assert.match(await read('scripts/voice-packs/package_pack.mjs'), /`Voices-\$\{LANGUAGE_NAMES\[language\]\}`/);
});

test('the player texts link the files at their folders and new names, say nothing of checksum files, and the Nexus page has no semicolons and no "18+"', async () => {
  const texts = {};
  for (const rel of ['README.md', 'packaging/PLAYER_README.md', 'packaging/HF_MODEL_CARD.md', 'packaging/HF_MULTILINGUAL_README.md', 'docs/NEXUS_PAGE.md',
    'docs/LOCAL_AI.md', 'docs/PACKAGING.md', 'docs/POCKET_LANGUAGE_MODELS.md', 'packaging/MATURE_PACK_README.md', 'packaging/MATURE_PACK_RELEASE_NOTES.md']) {
    texts[rel] = await read(rel);
    assert.doesNotMatch(texts[rel], /\/blob\/main\/AI-NPC-Cyberpunk-Mod-|\/resolve\/main\/(?:[\w-]+\/)?AI-NPC-Cyberpunk-Mod-/, `${rel}: no link to a file under its old name`);
    // docs/PACKAGING.md names the files once, in the paragraph on moving to this layout.
    if (rel !== 'docs/PACKAGING.md') assert.doesNotMatch(texts[rel], /SHA256SUMS/, `${rel}: no checksum files`);
  }
  const nexus = texts['docs/NEXUS_PAGE.md'];
  assert.doesNotMatch(nexus, /;/, 'no semicolons on Nexus');
  assert.doesNotMatch(nexus, /18\+/, 'no "18+" on Nexus');
  // The mod itself downloads from Nexus only (owner, 2026-10-29): no Hugging Face mirror of the full install or the update.
  for (const link of ['AI-NPC-LLM-Companions.zip', 'AI-NPC-LLM-Companions-Update.zip']) assert(!nexus.includes(`/blob/main/${link}`) && !nexus.includes(`/blob/main/game-2.31/${link}`), `the Nexus page links no Hugging Face ${link}`);
  for (const link of [...Object.values(UPLOADS).map(([, remote]) => remote).filter(remote => /^(?:local-ai|voice|mature|mic)\//.test(remote))]) assert(nexus.includes(`${HF}/blob/main/${link}`), `the Nexus page links ${link}`);
  assert(nexus.includes(`${HF}/tree/main/multilingual`), 'the multilingual folder link is the same as before');
  assert(!nexus.includes('Runtime.zip'), 'managers install the full install as one mod: the Nexus page does not advertise the Runtime alone');
  assert.match(nexus, /Remove both of the old mods, then install the main file/, 'the one step for a manager coming from 0.3.3');
  assert(!nexus.includes(`${HF}/tree/main/updates`), 'the Runtime update zips are no longer offered: the Nexus page does not link them');
  // Every file name on HF has lost the prefix: the model card lists the new paths.
  const card = texts['packaging/HF_MODEL_CARD.md'];
  assert(!card.includes('AI-NPC-LLM-Companions'), 'the model card offers no full install or update (Nexus only)');
  for (const path of ['local-ai/', 'mature/', 'mic/', 'voice/', 'updates/', 'multilingual/']) assert(card.includes(path), `the model card lists ${path}`);
  // The Runtime alone is no longer on Hugging Face (owner, 2026-10-28): the full install holds it.
  assert(!card.includes('runtime/Runtime.zip') &&!card.includes('tree/main/runtime'), 'the model card names no runtime/ folder');
  assert.doesNotMatch(card, /Pocket language model/i, 'the Pocket language models are PocketTTS models in the texts players read');
});

test('game 2.5 is the default and sits at the top of the repository, game 2.31 is the older option in game-2.31/ with -for-2.31 in its file names', {skip: !python && 'no Python'}, async () => {
  const variants = JSON.parse(await read('packaging/game-variants.json')).variants;
  assert.deepEqual([variants['2.5'].suffix, variants['2.5'].hfFolder], ['', '']);
  assert.deepEqual([variants['2.31'].suffix, variants['2.31'].hfFolder], ['-for-2.31', 'game-2.31']);
  const directory = await mkdtemp(join(tmpdir(), 'hf games '));
  try {
    for (const name of ['AI-NPC-LLM-Companions-0.3.4.zip', 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4.zip', 'Runtime-0.3.4.zip', 'AI-NPC-LLM-Companions-0.3.4-for-2.31.zip',
      'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4-for-2.31.zip', 'Runtime-0.3.4-for-2.31.zip']) await writeFile(join(directory, name), 'x');
    const plan = (pack, ...game) => py(['packaging/upload-packs.py', '--version', '0.3.4', '--pack', pack, '--packages', directory, '--dry-run', ...game]);
    const HFR = 'alystria-ai/ai-npc-cyberpunk-mod-packs';
    for (const [pack, zip, remote] of [['full', 'AI-NPC-LLM-Companions-0.3.4.zip', 'AI-NPC-LLM-Companions.zip'],
      ['update', 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4.zip', 'AI-NPC-LLM-Companions-Update.zip'], ['runtime', 'Runtime-0.3.4.zip', 'runtime/Runtime.zip']]) {
      const byDefault = plan(pack), explicit = plan(pack, '--game', '2.5');
      assert.equal(byDefault.status, 0, byDefault.stderr);
      assert.equal(byDefault.stdout.trim(), `${join(directory, zip)} -> ${HFR}/${remote}`);
      assert.equal(explicit.stdout, byDefault.stdout, 'no --game means 2.5');
      const older = plan(pack, '--game', '2.31');
      assert.equal(older.status, 0, older.stderr);
      assert.equal(older.stdout.trim(), `${join(directory, zip.replace('.zip', '-for-2.31.zip'))} -> ${HFR}/game-2.31/${remote}`);
    }
    assert.notEqual(plan('omni', '--game', '2.31').status, 0, 'a shared pack is never uploaded for a game');
    assert.notEqual(plan('scripts').status, 0, 'the Scripts zip is the Update now: there is no scripts pack');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the Update is found whatever its <from> is (a version, or "any"), exactly one of them, and a pre-0.3.4 Scripts zip is still accepted', {skip: !python && 'no Python'}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hf update '));
  try {
    const plan = (...more) => py(['packaging/upload-packs.py', '--version', '0.3.5', '--pack', 'update', '--packages', directory, '--dry-run', ...more]);
    assert.notEqual(plan().status, 0, 'no Update zip');
    await writeFile(join(directory, 'AI-NPC-LLM-Companions-Update-any-to-0.3.5.zip'), 'x');
    await writeFile(join(directory, 'AI-NPC-LLM-Companions-Update-any-to-0.3.5-for-2.31.zip'), 'x');
    assert.equal(plan().stdout.trim(), `${join(directory, 'AI-NPC-LLM-Companions-Update-any-to-0.3.5.zip')} -> alystria-ai/ai-npc-cyberpunk-mod-packs/AI-NPC-LLM-Companions-Update.zip`);
    assert.equal(plan('--game', '2.31').stdout.trim(), `${join(directory, 'AI-NPC-LLM-Companions-Update-any-to-0.3.5-for-2.31.zip')} -> alystria-ai/ai-npc-cyberpunk-mod-packs/game-2.31/AI-NPC-LLM-Companions-Update.zip`);
    await writeFile(join(directory, 'AI-NPC-LLM-Companions-Update-0.3.4-to-0.3.5.zip'), 'x');
    const two = plan();
    assert.notEqual(two.status, 0, 'two Update zips of one version are ambiguous');
    assert.match(two.stderr, /More than one Update zip/);
    // The old links: --also-old-name puts the Update at Scripts.zip and the Runtime at the root again.
    await rm(join(directory, 'AI-NPC-LLM-Companions-Update-0.3.4-to-0.3.5.zip'));
    assert.deepEqual(plan('--also-old-name').stdout.trim().split(/\r?\n/).map(line => line.split(' -> ')[1]),
      ['alystria-ai/ai-npc-cyberpunk-mod-packs/AI-NPC-LLM-Companions-Update.zip', 'alystria-ai/ai-npc-cyberpunk-mod-packs/Scripts.zip']);
    assert.deepEqual(plan('--also-old-name', '--game', '2.31').stdout.trim().split(/\r?\n/).map(line => line.split(' -> ')[1]),
      ['alystria-ai/ai-npc-cyberpunk-mod-packs/game-2.31/AI-NPC-LLM-Companions-Update.zip', 'alystria-ai/ai-npc-cyberpunk-mod-packs/game-2.31/Scripts.zip']);
    await writeFile(join(directory, 'Runtime-0.3.5.zip'), 'x');
    const runtime = py(['packaging/upload-packs.py', '--version', '0.3.5', '--pack', 'runtime', '--packages', directory, '--dry-run', '--also-old-name']);
    assert.deepEqual(runtime.stdout.trim().split(/\r?\n/).map(line => line.split(' -> ')[1]), ['alystria-ai/ai-npc-cyberpunk-mod-packs/runtime/Runtime.zip', 'alystria-ai/ai-npc-cyberpunk-mod-packs/Runtime.zip']);
    // A zip a build before 0.3.4 wrote is accepted for the Update.
    await rm(join(directory, 'AI-NPC-LLM-Companions-Update-any-to-0.3.5.zip'));
    await writeFile(join(directory, 'AI-NPC-Cyberpunk-Mod-Scripts-0.3.5.zip'), 'x');
    assert.equal(plan().stdout.trim(), `${join(directory, 'AI-NPC-Cyberpunk-Mod-Scripts-0.3.5.zip')} -> alystria-ai/ai-npc-cyberpunk-mod-packs/AI-NPC-LLM-Companions-Update.zip`);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the model card and both updates READMEs make game 2.5 the default and 2.31 the older option in game-2.31/, with the 2_31_old note, and no text names the game-2.5 folder', async () => {
  const card = await read('packaging/HF_MODEL_CARD.md');
  for (const needle of ['game-2.31/updates/', 'nexusmods.com/cyberpunk2077/mods/35436?tab=files', 'older game 2.31']) assert(card.includes(needle), `the model card has ${needle}`);
  assert.match(await read('packaging/HF_UPDATES_README.md'), /Runtime-Update-0\.3\.0-to-0\.3\.1-for-2\.5\.zip/);
  assert.match(await read('packaging/HF_UPDATES_README_2_31.md'), /Runtime-Update-0\.2\.2-to-0\.2\.3\.zip/);
  for (const rel of ['README.md', 'packaging/PLAYER_README.md', 'packaging/HF_MODEL_CARD.md', 'packaging/HF_UPDATES_README.md', 'packaging/HF_UPDATES_README_2_31.md', 'docs/NEXUS_PAGE.md']) {
    assert.doesNotMatch(await read(rel), /(?<!codeware-)game-2\.5\//, `${rel}: the game-2.5 folder is gone`);
  }
});
