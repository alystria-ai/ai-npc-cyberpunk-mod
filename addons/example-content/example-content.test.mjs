import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AddonHost, discoverAddons} from '../../bridge/addons.mjs';
import {AddonContent} from '../../bridge/addon-content.mjs';
import {PromptProfiles} from '../../bridge/prompt-profile-store.mjs';
import {PersonaBook} from '../../bridge/mistral-prompt.mjs';
import {addonEntries, buildAddon} from '../../packaging/build-addon.mjs';
import {CET_MODS} from '../../bridge/addons.mjs';

// The example content pack (docs/ADDON_API.md, "Content packs"): data only, found, applied, switched off and packaged without an init.lua.
const here = fileURLToPath(new URL('.', import.meta.url));

test('the example pack is found as a folder with only its manifest and one data file, and every part of it is valid', async () => {
  const {addons, problems} = await discoverAddons({roots: [{path: here, children: false}]});
  assert.deepEqual(problems, []);
  assert.equal(addons.length, 1);
  const [example] = addons;
  assert.equal(example.id, 'example-content');
  assert.deepEqual(example.speakers, []);
  assert.equal(example.requires.api, '1.1');
  assert.equal(example.content.memory, 'separate');
  assert.equal(example.content.worldRules.length, 2);
  assert.deepEqual(Object.keys(example.content.characters), ['judy-alvarez']);
  assert.equal(example.content.characters['judy-alvarez'].name, 'Judith of the Example');
});

test('on it changes the prompt and Judy; off it is the very prompt of no pack', async () => {
  const {addons} = await discoverAddons({roots: [{path: here, children: false}]});
  const host = new AddonHost({addons});
  const content = new AddonContent({host});
  const rows = [{key: 'judy-alvarez', name: 'Judy Alvarez', aliases: ['Judy'], backstory: 'Shipped backstory of Judy, long enough to be a backstory.', speakingStyleDescription: 'Shipped.', speakingStyleSampleDialogues: 'One.'}];
  const book = new PersonaBook(rows);
  content.bindRoster(rows);
  const store = new PromptProfiles({packs: content}), shipped = new PromptProfiles();
  assert.equal(book.persona('judy-alvarez').name, 'Judith of the Example');
  assert.match(content.worldRulesText(''), /by my cyberware/);
  assert.match(store.resolve({route: 'mistral'}).closing.text, /by my cyberware/);
  assert.equal(content.memoryKey('judy-alvarez'), 'judy-alvarez@example-content');
  host.observeSettings(JSON.stringify({version: 1, addons: {'example-content': {contentEnabled: false}}}));
  assert.equal(book.persona('judy-alvarez').name, 'Judy Alvarez');
  assert.equal(content.worldRulesText(''), '');
  assert.deepEqual(store.resolve({route: 'mistral'}), shipped.resolve({route: 'mistral'}));
  assert.equal(content.memoryKey('judy-alvarez'), 'judy-alvarez');
});

test('the zip has the manifest, the data file and the notes, in the CET folder of the pack, with no init.lua and no game in its name', async () => {
  const out = await mkdtemp(resolve(tmpdir(), 'convai-content-zip-'));
  try {
    const {path, names} = await buildAddon({dir: here, out});
    assert(path.endsWith('AI-NPC-Cyberpunk-Mod-ExampleContent-1.0.0.zip'), path);
    const folder = `${CET_MODS}/AiNpcCyberpunkModExampleContent/`;
    assert.deepEqual(names.sort(), ['README.md', 'characters.json', 'convai-addon.json'].map(name => folder + name));
    assert(!/2\.31|2\.5|for-/.test(path), 'one zip for every supported game');
  } finally { await rm(out, {recursive: true, force: true}); }
});

test('a pack with a LICENSE ships it; a data file named in the manifest must be in the folder; a broken one stops the build; a pack with speakers still needs init.lua', async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'convai-content-build-'));
  try {
    const put = async (name, files) => { const dir = resolve(work, name); await mkdir(dir, {recursive: true}); for (const [file, text] of Object.entries(files)) await writeFile(resolve(dir, file), text); return dir; };
    const manifest = content => JSON.stringify({schema: 1, id: 'tiny', name: 'Tiny', version: '1.0.0', requires: {api: '1.1'}, speakers: [], content});
    const licensed = await put('licensed', {'convai-addon.json': manifest({worldRules: ['One.']}), LICENSE: 'Terms.\n', 'README.md': 'Notes.\n'});
    const {entries} = await addonEntries(licensed);
    assert.deepEqual(entries.map(entry => entry.name.split('/').pop()).sort(), ['LICENSE', 'README.md', 'convai-addon.json']);
    const missing = await put('missing', {'convai-addon.json': manifest({characters: 'characters.json'})});
    await assert.rejects(addonEntries(missing), /characters\.json/);
    const broken = await put('broken', {'convai-addon.json': manifest({characters: 'characters.json'}), 'characters.json': JSON.stringify({'judy-alvarez': {gender: 'MALE'}})});
    await assert.rejects(addonEntries(broken), /gender cannot be changed/);
    const speaker = await put('speaker', {'convai-addon.json': JSON.stringify({schema: 1, id: 'talker', name: 'Talker', version: '1.0.0', requires: {api: '1.1'},
      speakers: [{id: 'a', name: 'A', persona: {backstory: 'Someone.'}}], content: {worldRules: ['One.']}})});
    await assert.rejects(addonEntries(speaker), /no init\.lua/);
    const stray = await put('stray', {'convai-addon.json': manifest({worldRules: ['One.']}), 'notes.exe': 'x'});
    await assert.rejects(addonEntries(stray), /notes\.exe/);
  } finally { await rm(work, {recursive: true, force: true}); }
});
