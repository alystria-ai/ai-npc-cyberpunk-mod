import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {addonFolderName, buildAddon} from './build-addon.mjs';
import {CET_MODS} from '../bridge/addons.mjs';

// What an add-on zip may and may not hold, against docs/ADDON_API.md "Packaging": the guards that stop a broken or unwanted file shipping.
// (The happy path and an outside-the-repository build are in addon-packaging.test.mjs.)
const project = fileURLToPath(new URL('..', import.meta.url));
const FOLDER = `${CET_MODS}/AiNpcCyberpunkModExample/`;

async function withAddon(change, run) {
  const work = await mkdtemp(resolve(tmpdir(), 'convai-addon-guard-'));
  try {
    const dir = resolve(work, 'example');
    await cp(resolve(project, 'addons/example'), dir, {recursive: true});
    await change(dir);
    return await run(dir, resolve(work, 'dist'), work);
  } finally { await rm(work, {recursive: true, force: true}); }
}
const put = async (dir, rel, text = 'x') => { await mkdir(resolve(dir, rel, '..'), {recursive: true}); await writeFile(resolve(dir, rel), text); };
const manifestOf = dir => readFile(resolve(dir, 'convai-addon.json'), 'utf8').then(JSON.parse);
const names = async (change) => withAddon(change, async (dir, out) => (await buildAddon({dir, out})).names.map(name => name.slice(FOLDER.length)).sort());

test('the build refuses what would ship broken: no init.lua, a named bridge or voice that is not there, a bad manifest, or a file type an add-on may not carry', async () => {
  const refused = [
    ['no init.lua', dir => rm(resolve(dir, 'init.lua')), /no init\.lua/],
    ['the bridge module is named and missing', dir => rm(resolve(dir, 'bridge.mjs')), /bridge\.mjs is named in convai-addon\.json but not shipped/],
    ['a voice reference is named and missing', async dir => {
      const manifest = await manifestOf(dir); manifest.speakers[0].voice = {reference: 'voice/echo.wav', transcript: 'Hello.'};
      await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(manifest));
    }, /voice\/echo\.wav is named in convai-addon\.json but not shipped/],
    ['a voice reference that sits in a folder that never ships', async dir => {
      const manifest = await manifestOf(dir); manifest.speakers[0].voice = {reference: 'eval/echo.wav', transcript: 'Hello.'};
      await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(manifest)); await put(dir, 'eval/echo.wav');
    }, /eval\/echo\.wav is named in convai-addon\.json but not shipped/],
    ['no manifest', dir => rm(resolve(dir, 'convai-addon.json')), /convai-addon\.json/],
    ['an empty manifest', dir => writeFile(resolve(dir, 'convai-addon.json'), ''), /JSON/],
    ['a manifest that is not valid', dir => writeFile(resolve(dir, 'convai-addon.json'), '{"schema": 2}'), /schema must be 1/],
    ['a manifest with a Convai speaker', async dir => {
      const manifest = await manifestOf(dir); manifest.speakers[0].convai = {characterId: 'x'};
      await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(manifest));
    }, /Mistral or the local AI only/],
    ['a program', dir => put(dir, 'tool.exe'), /tool\.exe/], ['a library', dir => put(dir, 'bin/native.dll'), /bin\/native\.dll/],
    ['a script', dir => put(dir, 'run.ps1'), /run\.ps1/], ['an archive', dir => put(dir, 'old.zip'), /old\.zip/],
    ['a compressed audio file', dir => put(dir, 'voice/line.mp3'), /voice\/line\.mp3/], ['an image', dir => put(dir, 'logo.png'), /logo\.png/],
    ['Python', dir => put(dir, 'tools/make.py'), /tools\/make\.py/],
  ];
  for (const [label, change, pattern] of refused) {
    await withAddon(change, async (dir, out) => {
      await assert.rejects(buildAddon({dir, out}), pattern, label);
      await assert.rejects(readFile(resolve(out, 'AI-NPC-Cyberpunk-Mod-Example-1.0.0.zip')), {code: 'ENOENT'}, `${label}: no zip is left behind`);
    });
  }
});

test('the zip never carries tests, eval scripts, dotfiles or node_modules, ships every documented file type, and keeps a main mod folder out of reach', async () => {
  const shipped = await names(async dir => {
    await put(dir, '.env', 'secret'); await put(dir, '.git/config'); await put(dir, '.vscode/settings.json'); await put(dir, 'lib/.hidden.lua');
    await put(dir, 'node_modules/dep/index.js'); await put(dir, 'tests/a.bin'); await put(dir, 'test/b.exe'); await put(dir, 'eval/more.json');
    await put(dir, 'lib/helper.test.mjs'); await put(dir, 'lib/helper.lua', '-- ships'); await put(dir, 'addons.lua', '-- a file named like a main mod file');
  });
  assert.deepEqual(shipped, ['addons.lua', 'bridge.mjs', 'convai-addon.json', 'init.lua', 'lib/helper.lua'],
    'a file named like a main mod file lands inside the add-on\'s own folder, not beside the main mod');
  // The documented types: .lua .json .mjs .js .wav .txt .md (a reference is declared, as the build requires).
  const types = await names(async dir => {
    const manifest = await manifestOf(dir); manifest.speakers[0].voice = {reference: 'voice/echo.wav', transcript: 'Hello.'};
    await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(manifest));
    for (const rel of ['voice/echo.wav', 'lib/a.js', 'notes.txt', 'README.md', 'data/table.JSON', 'lib/b.LUA']) await put(dir, rel);
  });
  assert.deepEqual(types, ['README.md', 'bridge.mjs', 'convai-addon.json', 'data/table.JSON', 'init.lua', 'lib/a.js', 'lib/b.LUA', 'notes.txt', 'voice/echo.wav']);
  // Whatever the id, the add-on's folder is never the main mod's own, so an unpacked zip cannot overwrite a main mod file.
  for (const id of ['ab', 'skippy', 'delamain-cab', 'x1', 'a-b-c-d']) {
    assert.notEqual(addonFolderName(id), 'AiNpcCyberpunkMod');
    assert.match(addonFolderName(id), /^AiNpcCyberpunkMod[A-Z0-9][A-Za-z0-9]*$/, id);
  }
});

test('the zip is deterministic and laid out as the docs say, the command line reports its outcome in its exit code, and the voice files stay out of git', async () => {
  await withAddon(async () => {}, async (dir, out, work) => {
    const first = await buildAddon({dir, out: resolve(out, 'one')}), second = await buildAddon({dir, out: resolve(out, 'two')});
    assert.deepEqual(await readFile(first.path), await readFile(second.path), 'the same folder gives the same bytes');
    assert.equal(new Set(first.names).size, first.names.length);
    assert.ok(first.names.every(name => name.startsWith(FOLDER) && !name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/')), first.names.join('\n'));
    const cli = args => spawnSync(process.execPath, [resolve(project, 'packaging/build-addon.mjs'), ...args], {encoding: 'utf8'});
    const ok = cli([dir, '--out', resolve(work, 'cli')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^AI-NPC-Cyberpunk-Mod-Example-1\.0\.0\.zip: 3 files\n(?:  .+\n){3}$/);
    assert.deepEqual(await readFile(resolve(work, 'cli/AI-NPC-Cyberpunk-Mod-Example-1.0.0.zip')), await readFile(first.path));
    const none = cli([]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /^Usage: node packaging\/build-addon\.mjs/);
    const broken = cli([resolve(work, 'no-such-folder'), '--out', resolve(work, 'cli2')]);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /no-such-folder|ENOENT/);
    await assert.rejects(readFile(resolve(work, 'cli2/AI-NPC-Cyberpunk-Mod-Example-1.0.0.zip')), {code: 'ENOENT'});
  });
  // The reference clips are cut from game audio and kept on the developer's machine (docs, Packaging): git ignores them, and the build
  // packs the local copy only when the manifest names it.
  const ignore = await readFile(resolve(project, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/addons\/\*\/voice\/\*\.wav$/m);
  assert.match(ignore, /^\/addons\/\*\/voice\/\*\.voice\.json$/m);
});

test('a voice file the manifest does not name is never shipped, nor are the notes kept beside the voice files out of git', async () => {
  const shipped = await names(async dir => {
    const manifest = await manifestOf(dir); manifest.speakers[0].voice = {reference: 'voice/echo.wav', transcript: 'Hello.'};
    await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(manifest));
    await put(dir, 'voice/echo.wav'); await put(dir, 'voice/stray-candidate.wav'); await put(dir, 'voice/echo.voice.json'); await put(dir, 'voice/echo-reference.json');
  });
  assert.deepEqual(shipped, ['bridge.mjs', 'convai-addon.json', 'init.lua', 'voice/echo.wav']);
});
