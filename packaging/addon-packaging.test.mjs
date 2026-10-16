import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {addonArchiveName, addonEntries, addonFolderName, buildAddon} from './build-addon.mjs';
import {BRIDGE_MODULES} from './runtime-layout.mjs';
import {CET_MODS} from '../bridge/addons.mjs';

// Each add-on is its own download (its own Nexus page); the main mod's packages never carry one (docs/ADDON_API.md, "Packaging").
const project = fileURLToPath(new URL('..', import.meta.url));

test('an add-on zip is its own CET mod folder with only the add-on\'s shipped files', async () => {
  assert.equal(addonFolderName('skippy'), 'AiNpcCyberpunkModSkippy');
  assert.equal(addonFolderName('delamain-cab'), 'AiNpcCyberpunkModDelamainCab');
  assert.equal(addonArchiveName({id: 'delamain-cab', version: '1.0.0'}), 'AI-NPC-Cyberpunk-Mod-DelamainCab-1.0.0');
  const out = await mkdtemp(resolve(tmpdir(), 'convai-addon-zip-'));
  try {
    const {path, names} = await buildAddon({dir: resolve(project, 'addons/example'), out});
    assert(path.endsWith('AI-NPC-Cyberpunk-Mod-Example-1.0.0.zip'));
    const folder = `${CET_MODS}/AiNpcCyberpunkModExample/`;
    assert.deepEqual(names.sort(), ['bridge.mjs', 'convai-addon.json', 'init.lua'].map(name => folder + name));
    assert(names.every(name => !/\.test\.mjs$|\/eval\//.test(name)), 'tests and evaluation scripts are never shipped');
    assert(names.every(name => !name.includes('/AiNpcCyberpunkMod/')), 'nothing lands in the main mod folder');
  } finally { await rm(out, {recursive: true, force: true}); }
});

test('the main runtime never includes an add-on, and the add-on tools stay out of the bridge closure', async () => {
  const plan = await readFile(resolve(project, 'packaging/release-plan.json'), 'utf8');
  const dev = await readFile(resolve(project, 'scripts/development-files.json'), 'utf8');
  for (const text of [plan, dev]) {
    assert.doesNotMatch(text, /"(?:source|target)": "addons\//, 'an add-on file is in a main mod package');
    assert.doesNotMatch(text, /AiNpcCyberpunkMod(?:Example|Skippy|Delamain)/, 'an add-on folder is in a main mod package');
  }
  assert(BRIDGE_MODULES.includes('bridge/addons.mjs'), 'the host ships with the main mod');
  for (const tool of ['bridge/addon-eval.mjs', 'bridge/addon-lua-harness.mjs']) assert(!BRIDGE_MODULES.includes(tool), `${tool} is a development tool`);
  // A folder that is not a valid add-on is refused rather than zipped.
  await assert.rejects(addonEntries(resolve(project, 'mod')), /convai-addon\.json|ENOENT/);
});

test('an add-on folder outside this repository builds the same way (Skippy and Delamain live in repositories of their own)', async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'convai-addon-external-'));
  try {
    const copy = resolve(work, 'cyberpunk-convai-example');
    await cp(resolve(project, 'addons/example'), copy, {recursive: true});
    await mkdir(resolve(copy, 'voice'), {recursive: true});
    await writeFile(resolve(copy, 'notes.txt'), 'shipped\n');
    await writeFile(resolve(copy, 'extra.bin'), 'x');
    await assert.rejects(buildAddon({dir: copy, out: resolve(work, 'dist')}), /extra\.bin/, 'any other kind of file stops the build');
    await rm(resolve(copy, 'extra.bin'));
    const {names} = await buildAddon({dir: copy, out: resolve(work, 'dist')});
    const folder = `${CET_MODS}/AiNpcCyberpunkModExample/`;
    assert.deepEqual(names.sort(), ['bridge.mjs', 'convai-addon.json', 'init.lua', 'notes.txt'].map(name => folder + name));
  } finally { await rm(work, {recursive: true, force: true}); }
});
