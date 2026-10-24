import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {MemoryStore} from './memory-store.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {WorldRules} from './world-rules.mjs';
import {CustomCharacters, rosterIndex} from './custom-characters.mjs';
import {PlayerVoices} from './player-voices.mjs';
import {speechWav} from './voice-clip-fixture.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {customProfileId, defaultProfile, renderRules} from './prompt-profiles.mjs';

// The real page in real Edge, muted and headless (no sound, nothing leaves 127.0.0.1): the player's whole path through the editor,
// and the checks that make the page safe (no outside request, no markup from a bio, a warning before unsaved text is lost).
// EDITOR_SHOTS_DIR=<folder> also saves screenshots of the main states there.
const rows = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const executable = process.env.CYBERPUNK_CONVAI_BROWSER
  || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path));
const skip = !executable && 'no Chromium browser found';
const shots = process.env.EDITOR_SHOTS_DIR;

async function bench({route = 'local'} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'character-editor-browser-'));
  await mkdir(join(dir, 'local-memory', 'player'), {recursive: true});
  await writeFile(join(dir, 'local-memory', 'player', 'judy-alvarez.json'), JSON.stringify({version: 1, profileKey: 'judy-alvarez', updated: 5,
    summary: 'V asked me about the clinic and whether the braindance is safe.', overflow: [], channels: {private: [], phone: [], group: []}, embedder: null, pending: [],
    records: [{id: 'a', kind: 'preference', text: 'V likes cheap whiskey after a long night.', created: 1, updated: 2, importance: 0.5, pinned: false, source: 'chat', v: ''},
      {id: 'b', kind: 'promise', text: 'I promised V a free check-up next week.', created: 1, updated: 3, importance: 0.6, pinned: false, source: 'chat', v: ''}]}));
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const memory = await MemoryStore.open({dir: join(dir, 'local-memory')});
  await mkdir(join(dir, 'runtime'), {recursive: true});
  const custom = await CustomCharacters.open({dir: join(dir, 'state'), exchangePath: join(dir, 'runtime', 'custom-characters.json'), roster: rosterIndex(rows)});
  const voices = await PlayerVoices.open({dir: join(dir, 'state')});
  const worldRules = await WorldRules.open({dir: join(dir, 'state')});
  const personas = new PersonaBook(rows, {overrides, custom, worldRules});
  const state = {route};
  // The prompt profiles: the next turn would be Local AI, Standard, with a Custom endpoint configured (so its profile is listed too).
  const profiles = await PromptProfiles.open({dir: join(dir, 'prompt-overrides'), active: () => ({route: 'local', tier: 'standard', mature: false, custom: {origin: 'https://openrouter.ai', model: 'qwen3-8b'}})});
  const server = new EditorServer({editor: new CharacterEditor({personas, overrides, memory, route: () => state.route, custom, voices, worldRules, promptProfiles: profiles})});
  return {dir, overrides, memory, server, state, custom, voices, personas, worldRules, profiles, async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
}
async function open(t, {route, strings = {}, language = 'en', viewport = {width: 1280, height: 900}, scheme = 'dark', facing = null} = {}) {
  const b = await bench({route});
  const browser = await chromium.launch({executablePath: executable, headless: true, args: ['--mute-audio']});
  t.after(async () => { await browser.close(); await b.done(); });
  const url = await b.server.start({strings, language, facing});
  const context = await browser.newContext({viewport, colorScheme: scheme, acceptDownloads: false});
  const requests = [], problems = [], dialogs = [];
  const page = await context.newPage();
  await page.route('**/*', route => { requests.push(route.request().url()); return route.request().url().startsWith(`http://127.0.0.1:${new URL(url).port}/`) ? route.continue() : route.abort(); });
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) problems.push(message.text()); });
  page.on('pageerror', error => problems.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await page.goto(url);
  await page.waitForSelector('#list button.pick');
  return {...b, page, requests, problems, dialogs, url, async shot(name) { if (shots) { await mkdir(shots, {recursive: true}); await page.screenshot({path: join(shots, name + '.png')}); } }};
}
const toast = page => page.locator('#note.show');

test('the whole path: pick a character, edit and save each part, reset, and nothing leaves this computer', {skip, timeout: 180000}, async t => {
  const e = await open(t);
  const {page} = e;
  assert.equal(await page.title(), 'Character editor');
  assert.equal(await page.locator('#banner').isHidden(), true, 'no warning when a text provider answers');
  assert.match(await page.locator('#sub').textContent(), /Mistral, Local AI and Custom\. They do not apply to Convai\./);
  assert.deepEqual(await page.locator('#list h3').allTextContents(), ['V’s voice', 'Story characters', 'Everyday people']);
  assert.equal(await page.locator('#list button.pick').count(), rows.length + 2);
  await e.shot('01-start');

  // Search narrows the list; choosing a character shows the shipped bio and a counter.
  await page.fill('#search', 'judy');
  assert.deepEqual(await page.locator('#list button.pick').allTextContents(), ['Judy Alvarez']);
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.locator('#main h2').textContent(), 'Judy Alvarez');
  assert.equal(await page.locator('.chip').textContent(), 'As shipped');
  assert.match(await page.inputValue('#f-bio'), /green and pink hair/);
  assert.match(await page.locator('.count').first().textContent(), /^\d+ of 9000$/);
  assert.equal(await page.getByRole('button', {name: 'Save'}).isDisabled(), true, 'nothing to save yet');
  await e.shot('02-bio');

  // A bio that is too short is refused with a plain sentence and stores nothing.
  await page.fill('#f-bio', 'Too short.');
  assert.equal(await page.getByRole('tab', {name: 'Bio'}).evaluate(node => node.classList.contains('dirty')), true);
  await page.getByRole('button', {name: 'Save'}).click();
  await toast(page).waitFor();
  assert.match(await toast(page).textContent(), /The bio is too short\. Use at least 40 characters\./);
  assert.deepEqual(e.overrides.keys(), []);

  // A real edit is saved and marked, and the list shows a dot.
  await page.fill('#f-bio', 'Judy runs a quiet clinic on the edge of Watson and fixes people for free, no questions asked. She hates corpos.');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('.chip')?.textContent === 'Edited');
  assert.match(e.overrides.get('judy-alvarez').bio, /quiet clinic/);
  assert.equal(await page.locator('#list button.pick .dot').count(), 1);
  await e.shot('03-saved');

  // Speaking style and example lines.
  await page.getByRole('tab', {name: 'Speaking style'}).click();
  assert.match(await page.inputValue('#f-style'), /^Editorial delivery/);
  assert((await page.locator('.list .row input').count()) >= 5, 'the shipped example lines are listed');
  await page.getByRole('button', {name: 'Add a line'}).click();
  await page.locator('.list .row input').last().fill('Sit down, you look awful. I will fix you up.');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.equal(e.overrides.get('judy-alvarez').examples.at(-1), 'Sit down, you look awful. I will fix you up.');
  assert.equal('style' in e.overrides.get('judy-alvarez'), false, 'an unchanged style is not stored');

  // Rules: add, save, delete one, reset the part.
  await page.getByRole('tab', {name: 'Speaking rules'}).click();
  await page.getByRole('button', {name: 'Add a rule'}).click();
  await page.locator('.list .row input').last().fill('Never swear.');
  await page.getByRole('button', {name: 'Add a rule'}).click();
  await page.locator('.list .row input').last().fill('Answer in one sentence.');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.deepEqual([...e.overrides.get('judy-alvarez').rules], ['Never swear.', 'Answer in one sentence.']);
  await e.shot('04-rules');
  await page.locator('.list .row').first().getByRole('button', {name: 'Delete'}).click();
  await page.getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 1 && document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.deepEqual([...e.overrides.get('judy-alvarez').rules], ['Answer in one sentence.']);
  await page.getByRole('button', {name: 'Reset to default'}).click();
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 0);
  assert.equal('rules' in (e.overrides.get('judy-alvarez') ?? {}), false);
  assert.match(e.dialogs.at(-1), /Go back to the shipped text for Judy Alvarez\? Your changes to this part are removed\./);

  // Memories: written by hand, picked up in talks, and the summary.
  await page.getByRole('tab', {name: 'Memories'}).click();
  await page.getByRole('button', {name: 'Add a memory'}).click();
  await page.locator('.field').first().locator('.row input').last().fill('V has a sister called Lena.');
  await page.locator('.actions.bar').getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.deepEqual([...e.overrides.get('judy-alvarez').memories], ['V has a sister called Lena.']);
  const picked = page.locator('.field').filter({has: page.getByRole('heading', {name: 'Picked up in your talks'})});
  assert.equal(await picked.locator('.row').count(), 2);
  assert.match(await picked.locator('.help').textContent(), /Local AI pack/, 'the page says why nothing is collected without the pack');
  await picked.locator('.row').first().locator('input').fill('I promised V a free check-up on Friday.');
  await picked.locator('.row').first().getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.equal(e.memory.listRecords('judy-alvarez').find(record => record.id === 'b').text, 'I promised V a free check-up on Friday.');
  await e.shot('05-memories');
  await picked.locator('.row').last().getByRole('button', {name: 'Delete'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Deleted.');
  assert.equal(e.memory.listRecords('judy-alvarez').length, 1);
  assert.equal(e.dialogs.at(-1), 'Delete this memory?');
  await page.locator('#f-summary').fill('V is the one who asked about the clinic.');
  await page.locator('.field').filter({has: page.locator('#f-summary')}).getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.equal(e.memory.recall({profileKey: 'judy-alvarez'}).summary, 'V is the one who asked about the clinic.');

  // Reset everything for this character.
  await page.getByRole('button', {name: 'Reset everything'}).click();
  await page.waitForFunction(() => document.querySelector('.chip')?.textContent === 'As shipped');
  assert.deepEqual(e.overrides.keys(), []);
  assert.match(e.dialogs.at(-1), /All your changes to this character are removed\./);

  // Everyday people have no memories of talks.
  await page.fill('#search', 'food vendor');
  await page.locator('#list button.pick').first().click();
  await page.getByRole('tab', {name: 'Memories'}).click();
  assert.match(await page.locator('#main').textContent(), /Everyday people do not keep memories of your talks\./);
  assert.equal(await page.locator('#f-summary').count(), 0);

  assert.deepEqual(e.problems.filter(message => !/status of 422/.test(message)), [], 'no console error or warning (the one refused save is the browser noting the 422 the test asked for)');
  assert(e.requests.length > 0 && e.requests.every(url => url.startsWith(`http://127.0.0.1:${new URL(e.url).port}/`)), 'every request stays on this computer: ' + e.requests.filter(url => !url.startsWith('http://127.0.0.1')).join(', '));
});

test('text from a bio is shown as text, never as markup, and unsaved text asks before it is lost', {skip, timeout: 120000}, async t => {
  const e = await open(t);
  const {page} = e;
  const trap = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script> A long enough bio about a person who lives in Night City and talks to V a lot.';
  await e.overrides.set('panam-palmer', {bio: trap});
  await page.reload();
  await page.waitForSelector('#list button.pick');
  await page.fill('#search', 'panam');
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.inputValue('#f-bio'), trap);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#main img, #main script').count(), 0);

  await page.fill('#f-bio', trap + ' More text.');
  await page.fill('#search', 'judy');
  e.dialogs.length = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => { e.dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#list button.pick').click();
  await page.waitForTimeout(150);
  assert.deepEqual(e.dialogs, ['You have changes that are not saved. Leave without saving?']);
  assert.equal(await page.locator('#main h2').textContent(), 'Panam Palmer', 'dismissing the question stays on the page');
  assert.match(await page.inputValue('#f-bio'), /More text\.$/, 'the typed text is still there');
  assert.deepEqual(e.problems, []);
});

test('with Convai answering the page says the changes do not apply yet, and the strings the game sent are used', {skip, timeout: 120000}, async t => {
  const e = await open(t, {route: 'convai', language: 'de', strings: {'Character editor': 'Charakter-Editor', 'Close editor': 'Editor schließen', 'Search characters': 'Charaktere suchen',
    'Story characters': 'Story-Charaktere', 'Choose a character on the left.': 'Wähle links einen Charakter.'}});
  const {page} = e;
  assert.equal(await page.locator('#banner').isVisible(), true);
  assert.match(await page.locator('#banner').textContent(), /Convai is answering right now, so these changes have no effect yet\./);
  assert.equal(await page.title(), 'Charakter-Editor');
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  assert.equal(await page.locator('#close').textContent(), 'Editor schließen');
  assert.equal(await page.getAttribute('#search', 'placeholder'), 'Charaktere suchen');
  assert.equal((await page.locator('#list h3').nth(1).textContent()), 'Story-Charaktere');
  assert.equal(await page.locator('#main .empty').textContent(), 'Wähle links einen Charakter.');
  assert.equal(await page.locator('#foot').textContent(), 'Changes are saved on this computer and used from the next reply.', 'a sentence without a translation is shown in English');
  await e.shot('06-convai-banner-german');
  await page.locator('#list button.pick').nth(2).click();
  await page.waitForSelector('#f-bio');
  await e.shot('07-convai-bio');
  // A saved edit still works (it is used the moment a text provider answers).
  await page.fill('#f-style', 'x').catch(() => {});
  assert.deepEqual(e.problems, []);
});

test('Close editor stops the server and says so; the page works at phone width and in the light theme', {skip, timeout: 120000}, async t => {
  const e = await open(t, {viewport: {width: 390, height: 844}, scheme: 'light'});
  const {page} = e;
  await page.locator('#list button.pick').nth(2).click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling at phone width');
  await e.shot('08-phone-light');
  await page.locator('#close').click();
  await page.getByText('The editor is closed. You can close this tab.').waitFor();
  await page.waitForTimeout(500);
  assert.equal(e.server.running, false);
  assert.deepEqual(e.problems.filter(message => !/Failed to load resource|net::ERR/.test(message)), []);
});

// ---- the player's own characters

const speechClip = (seconds = 12, rate = 24000) => speechWav({seconds, rate});
const WORDS = 'Hello there, this is me talking. Nothing more to it.';
// The length the audio element reports once the browser has read the preview (no sound: the pages run muted).
const playable = (page, selector) => page.waitForFunction(selector => { const audio = document.querySelector(selector); return audio && audio.readyState >= 1 && Number.isFinite(audio.duration) ? audio.duration : false; }, selector)
  .then(handle => handle.jsonValue());

test('the player makes a character: fill the form, save, give it a voice clip, use the character they face, delete it', {skip, timeout: 180000}, async t => {
  const e = await open(t, {facing: {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'}});
  const {page} = e;
  assert.equal(await page.locator('#new').isVisible(), true);
  assert.equal(await page.locator('#new').textContent(), 'New character');
  await page.locator('#new').click();
  await page.waitForSelector('#f-name');
  assert.equal(await page.locator('#main h2').textContent(), 'New character');
  assert.equal(await page.locator('.chip').textContent(), 'Your character');
  assert.match(await page.locator('#main .panel p.help').first().textContent(), /only with Mistral, Local AI or Custom\. With Convai they speak as an ordinary person\./);
  await e.shot('10-new-character');

  // Nothing filled in: the page says what is missing, and nothing is stored.
  await page.getByRole('button', {name: 'Save', exact: true}).first().click();
  await toast(page).waitFor();
  assert.equal(await toast(page).textContent(), 'Give the character a name.');
  assert.equal(e.custom.size, 0);

  // The character the player was facing when they opened the editor fills in the match rule and the name.
  await page.getByRole('button', {name: 'Use the character I’m facing'}).click();
  await page.waitForFunction(() => document.getElementById('f-name').value === 'Rebecca');
  assert.equal(await page.inputValue('#f-gender'), 'female');
  assert.equal(await page.getByLabel('Record names 1').inputValue(), 'Character.Rebecca');
  assert.equal(await page.getByLabel('Display names 1').inputValue(), 'Rebecca');
  assert.match(await toast(page).textContent(), /Filled in from the character you were facing: Rebecca\./);
  await page.getByRole('button', {name: 'Use the character I’m facing'}).click();
  await page.waitForTimeout(150);
  assert.equal(await page.getByLabel('Record names 2').count(), 0, 'facing the same character twice adds nothing');

  await page.fill('#f-bio', 'I am Rebecca, a small, loud, trigger-happy runner who grew up in Pacifica and still thinks every plan needs more explosions.');
  await page.fill('#f-style', 'Fast, loud, a little rude.');
  await page.getByRole('button', {name: 'Add a line'}).click();
  await page.getByLabel('Example lines 1').fill('Boom. That is how I solve it.');
  await page.getByRole('button', {name: 'Add a memory'}).click();
  await page.getByLabel('Things they always know 1').fill('V once lent me a gun.');
  // The same record as a character of the mod is refused with a plain sentence.
  await page.getByLabel('Record names 1').fill('Character.Judy');
  await page.getByRole('button', {name: 'Save', exact: true}).first().click();
  await page.waitForFunction(() => /already has a profile in the mod/.test(document.getElementById('note').textContent));
  assert.equal(e.custom.size, 0);
  await page.getByLabel('Record names 1').fill('Character.Rebecca');
  await page.getByRole('button', {name: 'Save', exact: true}).first().click();
  await page.waitForFunction(() => document.querySelector('#main h2').textContent === 'Rebecca' && !!document.getElementById('f-clip'));
  assert.equal(e.custom.size, 1);
  assert.match(await page.locator('#main').textContent(), /No clip yet\. This character speaks with a generic voice that fits the gender\./);
  assert.doesNotMatch(await page.locator('#main .voice').textContent(), /\bnull\b|undefined/, 'no missing part is written out as a word');
  assert.equal(await page.locator('#main .voice h3').textContent(), 'Voice');
  const key = e.custom.list()[0].key;
  assert.deepEqual(await page.locator('#list h3').allTextContents(), ['Your characters', 'V’s voice', 'Story characters', 'Everyday people']);
  assert.equal(await page.locator('#list button.pick').first().textContent(), 'Rebecca');
  assert.equal(e.personas.persona(key).name, 'Rebecca', 'the prompt reads it from the next reply');
  await e.shot('11-saved');

  // A voice clip has its own Save clip: a file the browser can read is shown with its length and a preview before anything is sent.
  assert.equal(await page.getByRole('button', {name: 'Save clip'}).isDisabled(), true, 'nothing chosen yet');
  await page.locator('#f-clip').setInputFiles({name: 'tiny.wav', mimeType: 'audio/wav', buffer: speechClip(2)});
  await toast(page).filter({hasText: 'The clip is too short. Use at least 5 seconds.'}).waitFor();
  assert.equal(await page.locator('#main .status').filter({hasText: 'Chosen file'}).count(), 0, 'a clip that is too short is refused in the page, before it is sent');
  assert.equal(e.voices.size, 0);
  await page.locator('#f-clip').setInputFiles({name: 'rebecca.wav', mimeType: 'audio/wav', buffer: speechClip(12)});
  await page.getByText('Chosen file: rebecca.wav, 12 seconds.').waitFor();
  assert.equal(Math.round(await playable(page, 'audio.preview')), 12, 'the preview plays the converted clip');
  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => /at least 8 characters/.test(document.getElementById('note').textContent));
  assert.equal(e.voices.size, 0, 'the words are needed first');
  await page.fill('#f-voiceText', WORDS);
  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => /Saved clip: 12 seconds\./.test(document.querySelector('#main').textContent));
  assert.equal(e.voices.get(key).seconds, 12);
  assert.equal(e.voices.get(key).transcript, WORDS);
  assert.equal(await page.getByRole('button', {name: 'Remove clip'}).count(), 1);
  assert.equal(await page.locator('#f-clip').count(), 1);
  assert.match(await page.locator('#main').textContent(), /A new or removed clip counts from the next line this character speaks, once the current reply is over\. Nothing needs restarting\./);
  await e.shot('12-voice');

  // Unsaved changes ask before they are lost; deleting asks too, and takes the clip with it.
  await page.fill('#f-style', 'Changed but not saved.');
  e.dialogs.length = 0;
  await page.locator('#new').click();
  assert.deepEqual(e.dialogs, ['You have changes that are not saved. Leave without saving?']);
  await page.waitForFunction(() => document.querySelector('#main h2').textContent === 'New character');
  await page.locator('#list button.pick').first().click();
  await page.waitForFunction(() => document.querySelector('#main h2').textContent === 'Rebecca');
  e.dialogs.length = 0;
  await page.getByRole('button', {name: 'Delete character'}).click();
  await page.waitForFunction(() => !document.getElementById('f-name'));
  assert.deepEqual(e.dialogs, ['Delete Rebecca? The character, its voice clip and what it remembers of you are removed.']);
  assert.equal(e.custom.size, 0);
  assert.deepEqual(await page.locator('#list h3').allTextContents(), ['V’s voice', 'Story characters', 'Everyday people']);
  // The only console lines are the browser's own note of the refusals the test provoked (422): no script error, no outside request.
  assert.deepEqual(e.problems.filter(text => !/status of 422/.test(text)), []);
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'nothing left this computer: ' + e.requests.join(', '));
});

test('a story character gets a Voice tab: choose a clip, see its length and a preview, save it, play it back, change the words, remove it; everyday people have none', {skip, timeout: 180000}, async t => {
  const e = await open(t);
  const {page} = e;
  await page.fill('#search', 'food vendor');
  await page.locator('#list button.pick').first().click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.getByRole('tab', {name: 'Voice'}).count(), 0, 'everyday people have no voice tab');
  await page.fill('#search', 'judy');
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-bio');
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Bio', 'Speaking style', 'Speaking rules', 'Memories', 'Voice']);
  await page.getByRole('tab', {name: 'Voice'}).click();
  const main = page.locator('#main');
  await main.getByText('No clip yet.').waitFor();
  const text = await main.textContent();
  assert.doesNotMatch(await main.locator('.voice').textContent(), /\bnull\b|undefined/, 'no missing part is written out as a word');
  assert.match(text, /A clip you add replaces the shipped voice of this character for Pocket, OmniVoice and the Voxtral cloud voice\./);
  assert.match(text, /Use 5 to 20 seconds of one person speaking clearly, with no music or other voices\. 10 to 18 seconds copies best\. WAV, MP3, OGG or FLAC\./);
  assert.match(text, /This character speaks with the shipped voice\./);
  assert.equal(await page.locator('#f-clip').getAttribute('accept'), '.wav,audio/wav,audio/x-wav,.mp3,audio/mpeg,.ogg,.oga,audio/ogg,.flac,audio/flac,audio/x-flac');
  assert.equal(await page.locator('label[for=f-clip]').textContent(), 'Add voice clip');
  assert.equal(await page.getByRole('button', {name: 'Remove clip'}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Play saved clip'}).count(), 0);
  await e.shot('14-voice-tab');

  // A file that is too long is refused by the page itself, with the server's sentence, and nothing is chosen.
  await page.locator('#f-clip').setInputFiles({name: 'long.wav', mimeType: 'audio/wav', buffer: speechClip(22)});
  await toast(page).filter({hasText: 'The clip is too long. Use at most 20 seconds.'}).waitFor();
  assert.equal(await main.locator('audio.preview').count(), 0);

  // A good one: its length and a preview of the converted clip (24 kHz, mono) appear; it counts as an unsaved change until Save clip.
  await page.fill('#f-voiceText', WORDS);
  await page.locator('#f-clip').setInputFiles({name: 'judy.wav', mimeType: 'audio/wav', buffer: speechClip(11, 44100)});
  await page.getByText('Chosen file: judy.wav, 11 seconds.').waitFor();
  assert.equal(Math.round(await playable(page, 'audio.preview')), 11);
  assert.equal(await page.getByRole('tab', {name: 'Voice'}).evaluate(node => node.classList.contains('dirty')), true, 'the tab says there is something to save');
  assert.equal(await page.inputValue('#f-voiceText'), WORDS, 'the typed words stay when a file is chosen');
  await e.shot('15-voice-chosen');
  // Leaving with the chosen clip unsaved asks first.
  await page.fill('#search', 'panam');
  e.dialogs.length = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => { e.dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#list button.pick').click();
  await page.waitForTimeout(150);
  assert.deepEqual(e.dialogs, ['You have changes that are not saved. Leave without saving?']);
  assert.equal(await page.locator('#main h2').textContent(), 'Judy Alvarez');
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => { e.dialogs.push(dialog.message()); await dialog.accept(); });
  assert.equal(e.voices.size, 0, 'nothing is kept before Save clip');

  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => /Saved clip: 11 seconds\./.test(document.querySelector('#main').textContent));
  assert.equal(e.voices.get('judy-alvarez').seconds, 11);
  assert.equal(e.voices.get('judy-alvarez').rate, 24000, 'the browser sent a 24 kHz mono WAV');
  assert.equal(e.voices.get('judy-alvarez').transcript, WORDS);
  assert.equal(await page.locator('#note').textContent(), 'Saved.');
  assert.equal(await main.locator('audio.preview').count(), 0, 'the chosen file is the saved clip now');
  assert.equal(await page.getByRole('tab', {name: 'Voice'}).evaluate(node => node.classList.contains('dirty')), false);
  assert.equal(await page.locator('#list button.pick .dot').count(), 0, 'a clip is not an edit of the text');
  await e.shot('16-voice-saved');

  // Play the saved clip: the page fetches it with the session code and plays a blob address.
  e.requests.length = 0;
  await page.getByRole('button', {name: 'Play saved clip'}).click();
  assert.equal(Math.round(await playable(page, 'audio.saved')), 11);
  assert(await page.evaluate(() => document.querySelector('audio.saved').currentSrc.startsWith('blob:')), 'a blob address, never the clip on a URL');
  assert(e.requests.some(url => url.endsWith('/api/voice/judy-alvarez/audio')), 'fetched through the token route');
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'and only from this computer');

  // Change the words alone: Save clip sends only the words.
  assert.equal(await page.getByRole('button', {name: 'Save clip'}).isDisabled(), true);
  await page.fill('#f-voiceText', 'Other words, said in just the same way.');
  assert.equal(await page.getByRole('button', {name: 'Save clip'}).isDisabled(), false);
  assert.equal(await page.getByRole('tab', {name: 'Voice'}).evaluate(node => node.classList.contains('dirty')), true);
  const before = e.voices.get('judy-alvarez').sha256;
  e.requests.length = 0;
  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.' && document.getElementById('f-voiceText')?.value === 'Other words, said in just the same way.');
  assert.equal(e.voices.get('judy-alvarez').transcript, 'Other words, said in just the same way.');
  assert.equal(e.voices.get('judy-alvarez').sha256, before, 'the clip itself was not sent again');
  assert(e.requests.some(url => url.endsWith('/api/voice/judy-alvarez/text')));

  // The other tabs keep their unsaved text while a clip is saved.
  await page.getByRole('tab', {name: 'Bio'}).click();
  await page.fill('#f-bio', 'Judy runs a quiet clinic on the edge of Watson and fixes people for free, no questions asked.');
  await page.getByRole('tab', {name: 'Voice'}).click();
  await page.fill('#f-voiceText', 'A third set of words for this clip.');
  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.' && document.getElementById('f-voiceText')?.value === 'A third set of words for this clip.');
  await page.getByRole('tab', {name: 'Bio'}).click();
  assert.match(await page.inputValue('#f-bio'), /quiet clinic/, 'the unsaved bio is still there');
  await page.getByRole('tab', {name: 'Voice'}).click();

  // Remove it: the page asks, names the character, and the shipped voice is back.
  e.dialogs.length = 0;
  await page.getByRole('button', {name: 'Remove clip'}).click();
  await main.getByText('No clip yet.').waitFor();
  assert.deepEqual(e.dialogs, ['Remove the voice clip? Judy Alvarez goes back to the shipped voice.']);
  assert.equal(e.voices.size, 0);
  assert.equal(await page.locator('#note').textContent(), 'Clip removed.');
  assert.match(await main.textContent(), /This character speaks with the shipped voice\./);
  assert.equal(await main.locator('audio').count(), 0);

  // A file the browser cannot read is sent as it is and judged by the service, with a sentence that says what to do.
  await page.fill('#f-voiceText', WORDS);
  await page.locator('#f-clip').setInputFiles({name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000)])});
  await page.getByText(/^Chosen file: song\.mp3 \(4 KB\)\. It is checked when you save it\.$/).waitFor();
  assert.equal(await main.locator('audio.preview').count(), 0, 'nothing to preview');
  await page.getByRole('button', {name: 'Save clip'}).click();
  await toast(page).filter({hasText: /^(?:That file is not a recording the voices can read\. Use a WAV, MP3, OGG or FLAC file\.|This computer cannot convert that file\. Save it as a WAV and try again\.)$/}).waitFor();
  assert.equal(e.voices.size, 0);
  await page.fill('#f-voiceText', '');
  assert.equal(await page.getByRole('button', {name: 'Save clip'}).isDisabled(), false, 'the chosen file can still be saved once the words are typed');

  assert.deepEqual(e.problems.filter(message => !/status of 422/.test(message)), [], 'no console error or warning');
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'nothing left this computer: ' + e.requests.join(', '));
});

test('V has two voice-only rows: no tabs, no reset, a clip is saved and removed, and the page says what V uses without one', {skip, timeout: 180000}, async t => {
  const e = await open(t);
  const {page} = e;
  const main = page.locator('#main');
  // The V rows are in the list at once, in a group of their own, before the story characters.
  const groups = await page.locator('#list h3.group').allTextContents();
  assert.deepEqual(groups.slice(0, 2), ['V’s voice', 'Story characters']);
  assert.deepEqual(await page.locator('#list ul').first().locator('button').allTextContents(), ['V (female voice)', 'V (male voice)']);
  await page.fill('#search', 'V (male');
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-clip');
  assert.equal(await page.locator('#main h2').textContent(), 'V (male voice)');
  for (const gone of ['[role=tab]', '#f-bio', '#f-name', '#f-gender']) assert.equal(await page.locator(gone).count(), 0, gone + ' is not on a V row');
  assert.equal(await page.getByRole('button', {name: 'Reset everything'}).count() + await page.getByRole('button', {name: 'Delete character'}).count(), 0, 'no reset, no delete');
  const text = await main.textContent();
  assert.match(text, /Used for V’s typed lines: Pocket, OmniVoice and the Voxtral cloud voice copy it\./);
  assert.match(text, /No clip yet\. V speaks with the voice of your installed V voice mod, or the shipped V voice\./);
  assert.doesNotMatch(await main.locator('.voice').textContent(), /null|undefined/);
  await e.shot('17-v-voice');
  // Save a clip under the V key.
  await page.fill('#f-voiceText', WORDS);
  await page.locator('#f-clip').setInputFiles({name: 'v.wav', mimeType: 'audio/wav', buffer: speechClip(11, 44100)});
  await page.getByText('Chosen file: v.wav, 11 seconds.').waitFor();
  await page.getByRole('button', {name: 'Save clip'}).click();
  await page.waitForFunction(() => /Saved clip: 11 seconds\./.test(document.querySelector('#main').textContent));
  assert.equal(e.voices.get('v-male').seconds, 11);
  assert.equal(e.voices.has('v-female'), false);
  assert.equal(await page.locator('#main h2').textContent(), 'V (male voice)');
  // Leaving to the other V row and back works, and the other row has no clip.
  await page.fill('#search', '');
  await page.getByRole('button', {name: 'V (female voice)'}).click();
  await page.waitForFunction(() => document.querySelector('#main h2')?.textContent === 'V (female voice)');
  await page.getByText('No clip yet.').waitFor();
  await page.getByRole('button', {name: 'V (male voice)'}).click();
  await page.getByText('Saved clip: 11 seconds.').waitFor();
  // Remove it: the page says what V goes back to.
  e.dialogs.length = 0;
  await page.getByRole('button', {name: 'Remove clip'}).click();
  await main.getByText('No clip yet.').waitFor();
  assert.deepEqual(e.dialogs, ['Remove the voice clip? V goes back to the voice of your installed V voice mod, or the shipped V voice.']);
  assert.equal(e.voices.size, 0);
  assert.equal(await page.locator('#note').textContent(), 'Clip removed.');
  assert.deepEqual(e.problems.filter(message => !/status of 422/.test(message)), [], 'no console error or warning');
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'nothing left this computer: ' + e.requests.join(', '));
});

test('the new-character form works at phone width and in the light theme', {skip, timeout: 120000}, async t => {
  const e = await open(t, {viewport: {width: 375, height: 800}, scheme: 'light'});
  await e.page.locator('#new').click();
  await e.page.waitForSelector('#f-name');
  const overflow = await e.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, 'no sideways scroll, got ' + overflow);
  await e.shot('13-phone');
});

test('World rules: a page of its own, saved, reverted and cleared, in force on the next turn, with the Convai note and no warning banner', {skip, timeout: 120000}, async t => {
  const e = await open(t, {route: 'convai'});
  const {page} = e;
  assert.equal(await page.locator('#banner').isHidden(), false, 'the character pages warn while Convai answers');
  await page.getByRole('button', {name: 'World rules'}).click();
  await page.waitForSelector('#f-worldRules');
  assert.equal(await page.locator('#banner').isHidden(), true, 'the world rules reach Convai too, so that page has no warning');
  assert.equal(await page.locator('#main h2').textContent(), 'World rules');
  assert.match(await page.locator('#main').textContent(), /Applies to every provider: Local AI, Mistral and Custom in the character prompt, and Convai through its dynamic info\./);
  assert.match(await page.locator('.count').first().textContent(), /^0 of 2000$/);
  assert.equal(await page.getByRole('button', {name: 'Save'}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name: 'Clear'}).isDisabled(), true);
  await e.shot('14-world-rules');
  // Too long is refused (the counter says so and Save is off); a real text is saved at once.
  await page.fill('#f-worldRules', 'x'.repeat(2001));
  assert.equal(await page.getByRole('button', {name: 'Save'}).isDisabled(), true);
  await page.fill('#f-worldRules', 'Nobody in Night City knows V’s name unless V tells them.');
  await page.getByRole('button', {name: 'Revert changes'}).click();
  assert.equal(await page.inputValue('#f-worldRules'), '', 'revert goes back to the saved text');
  await page.fill('#f-worldRules', 'Nobody in Night City knows V’s name unless V tells them.');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
  assert.equal(e.worldRules.get(), 'Nobody in Night City knows V’s name unless V tells them.');
  assert.equal(e.personas.persona('judy-alvarez').worldRules, e.worldRules.get(), 'the next turn reads it');
  assert.equal(await page.locator('.chip').textContent(), 'Edited');
  // Unsaved words warn before leaving for a character.
  await page.fill('#f-worldRules', 'Everyone speaks casually.');
  e.dialogs.length = 0;
  await page.fill('#search', 'judy');
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-bio');
  assert.deepEqual(e.dialogs, ['You have changes that are not saved. Leave without saving?']);
  assert.equal(e.worldRules.get(), 'Nobody in Night City knows V’s name unless V tells them.', 'nothing was saved by leaving');
  assert.equal(await page.locator('#banner').isHidden(), false, 'the character page warns again');
  // Clear asks first, then empties the box and the store.
  await page.getByRole('button', {name: 'World rules'}).click();
  await page.waitForSelector('#f-worldRules');
  e.dialogs.length = 0;
  await page.getByRole('button', {name: 'Clear'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Cleared.');
  assert.deepEqual(e.dialogs, ['Clear the world rules?']);
  assert.equal(e.worldRules.get(), '');
  assert.equal(await page.inputValue('#f-worldRules'), '');
  assert.deepEqual(e.problems, [], 'no console error or warning');
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'nothing left this computer');
});


// ---- Prompting (docs/CHARACTER_EDITOR.md, "Prompting"): the wording of the prompt per conversation option
// The shipped profiles are read from the profile module (never written out here), so tuning them cannot break these tests.
const STANDARD = defaultProfile('local-standard');
const differs = (shipped, ...options) => options.find(option => option !== shipped);
const withFirstRule = (profile, text) => ({...profile, rules: [{...profile.rules[0], text}, ...profile.rules.slice(1)]});
const saveBar = page => page.locator('.actions.sticky');
const savedToast = page => page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Saved.');
const preview = page => page.locator('.ppreview');
const previewHas = (page, text) => page.waitForFunction(needle => document.querySelector('.ppreview')?.textContent.includes(needle), text);

test('Prompting: the options with their badges, a live preview, edits saved and reset per part and as a whole, and the limits shown as inline errors', {skip, timeout: 300000}, async t => {
  const e = await open(t);
  const {page} = e;
  assert.equal(await page.locator('#prompting').isVisible(), true);
  await page.locator('#prompting').click();
  await page.waitForSelector('.profiles .profile');
  assert.deepEqual(await page.locator('.profiles .profile > span:first-child').allTextContents(),
    ['Mistral', 'Local AI, Lite', 'Local AI, Standard', 'Local AI, Lite, Mature on', 'Local AI, Standard, Mature on', 'Custom: qwen3-8b at openrouter.ai']);
  const picks = page.locator('.profiles .profile');
  assert.match(await picks.nth(2).textContent(), /In use now/, 'the option the next reply would use');
  assert.equal(await picks.nth(2).getAttribute('aria-current'), 'true');
  assert.equal(await page.locator('.profiles .profile .chip').count(), 1, 'no other badge yet');
  assert.deepEqual(await page.locator('#main h2').allTextContents(), ['Prompting', 'Local AI, Standard']);
  const text = await page.locator('#main').textContent();
  assert.match(text, /The facts the characters get from the game and a short list of safety filters cannot be edited here\. Convai’s prompting lives on Convai’s side\./);
  assert.match(text, /Your Custom models and APIs/);
  assert.equal(await page.locator('#list .pick.on').count(), 0);
  await previewHas(page, 'OUTPUT RULES (they outrank everything above about format)');
  assert.equal(await preview(page).locator('pre').first().textContent(), renderRules(STANDARD, {name: 'Judy'}), 'the preview is the shipped rules as the prompt renders them');
  assert.equal(await saveBar(page).getByRole('button', {name: 'Save'}).isDisabled(), true, 'nothing to save yet');
  assert.equal(await page.locator('section[data-field=rules] .phead').getByRole('button', {name: 'Reset to default'}).isDisabled(), true, 'nothing to reset yet');
  await e.shot('20-prompting');

  // Rules: the preview follows the keys before anything is saved.
  const rule1 = page.locator('textarea[aria-label="Rule 1"]');
  assert.equal(await rule1.inputValue(), STANDARD.rules[0].text);
  await rule1.fill('Be short, {name}.');
  await previewHas(page, '1. Be short, Judy.');
  assert.equal(e.profiles.getOverride('local-standard'), null, 'a preview stores nothing');
  assert.equal(await saveBar(page).getByRole('button', {name: 'Save'}).isEnabled(), true);
  await page.fill('#p-sample-name', 'Rogue');
  await previewHas(page, '1. Be short, Rogue.');
  await page.locator('#p-sample-talk').check();
  await page.fill('#p-sample-words', '25');
  await previewHas(page, renderRules(withFirstRule(STANDARD, 'Be short, {name}.'), {name: 'Rogue', talkWords: 25}));
  await page.locator('#p-sample-talk').uncheck();
  await page.locator('#p-sample-mature').check();
  await previewHas(page, renderRules(withFirstRule(STANDARD, 'Be short, {name}.'), {name: 'Rogue', mature: true}));
  await page.locator('#p-sample-mature').uncheck();
  // An added rule is moved up, and a rule with other versions shows them.
  await page.getByRole('button', {name: 'Add a rule'}).click();
  const N = STANDARD.rules.length;
  await page.locator(`textarea[aria-label="Rule ${N + 1}"]`).fill('Never swear.');
  await page.getByRole('button', {name: `Move rule ${N + 1} up`}).click();
  assert.equal(await page.locator(`textarea[aria-label="Rule ${N}"]`).inputValue(), 'Never swear.');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  const stored = e.profiles.getOverride('local-standard');
  assert.equal(stored.rules[0].text, 'Be short, {name}.');
  assert.equal(stored.rules[N - 1].text, 'Never swear.');
  assert.match(stored.rules[N - 1].id, /^own-\d+$/);
  assert.equal(new Set(stored.rules.map(rule => rule.id)).size, stored.rules.length, 'ids stay unique');
  assert.equal(await page.locator('.profiles .profile').nth(2).locator('.chip').count(), 2, 'In use now and Edited');
  assert.equal(await page.locator('section[data-field=rules] .phead').getByRole('button', {name: 'Reset to default'}).isEnabled(), true);
  assert.equal(await saveBar(page).getByRole('button', {name: 'Save'}).isDisabled(), true, 'saved: nothing left to save');
  await e.shot('21-prompting-rules');
  // The talk and Mature versions of the shipped 'brief' rule are there.
  const variantAt = STANDARD.rules.findIndex(rule => rule.talk && rule.mature);
  assert(variantAt >= 0, 'the shipped profile has a rule with a talk and a Mature version');
  const brief = page.locator('.rule').nth(variantAt);
  assert.equal(await brief.locator('details').getAttribute('open'), '', 'a rule with other versions shows them open');
  assert.equal(await brief.locator('textarea').nth(1).inputValue(), STANDARD.rules[variantAt].talk);
  assert.equal(await brief.locator('textarea').nth(2).inputValue(), STANDARD.rules[variantAt].mature);
  await brief.locator('textarea').nth(2).fill('');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  assert.equal('mature' in e.profiles.getOverride('local-standard').rules[variantAt], false, 'an emptied version is gone');
  // Delete the added rule.
  await page.getByRole('button', {name: `Delete rule ${N}`}).click();
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await page.waitForFunction(count => document.querySelectorAll('.rule').length === count, N);
  assert.equal(e.profiles.getOverride('local-standard').rules.length, N);

  // Opening line, closing line, headings, layout, stop texts, examples.
  await page.fill('#p-closing-text', 'Now answer as {name}.');
  await page.fill('#p-labels-rules', 'MY RULES');
  await page.fill('#p-intro-named', 'You are {name}, a fixer.');
  const otherPlace = STANDARD.layout.volatile === 'after' ? 'before' : 'after';
  await page.selectOption('#p-layout-volatile', otherPlace);
  await page.getByRole('button', {name: 'Add a stop text'}).click();
  await page.locator(`textarea[aria-label="Stop text ${STANDARD.stop.length + 1}"]`).fill('\nV says:');
  await page.getByRole('button', {name: 'Add an example reply'}).click();
  await page.locator(`input[aria-label="Example reply ${STANDARD.examples.length + 1}"]`).fill('Fine, V.');
  await previewHas(page, 'MY RULES');
  await previewHas(page, '(Now answer as Rogue.)');
  await previewHas(page, '- Fine, V.');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  const second = e.profiles.getOverride('local-standard');
  assert.equal(second.closing.text, 'Now answer as {name}.');
  assert.equal(second.labels.rules, 'MY RULES');
  assert.equal(second.intro.named, 'You are {name}, a fixer.');
  assert.equal(second.layout.volatile, otherPlace);
  assert.deepEqual([...second.stop], [...STANDARD.stop, '\nV says:']);
  assert.deepEqual([...second.examples], [...STANDARD.examples, 'Fine, V.']);

  // Sampling and limits: numbers with ranges, and Off for Top P and the repeat penalty.
  const shippedTopP = STANDARD.sampling.topP, temperature = differs(STANDARD.sampling.temperature, 0.3, 0.35), topP = differs(shippedTopP, 0.8, 0.85), maxTokens = differs(STANDARD.sampling.maxTokens, 300, 310);
  const persona = differs(STANDARD.limits.persona, 3000, 3100), turns = differs(STANDARD.limits.turns, 4, 5);
  assert.match(await page.locator('#p-sampling-temperature-h').textContent(), new RegExp(`From 0 to 2\\. Shipped: ${STANDARD.sampling.temperature}`));
  assert.match(await page.locator('#p-sampling-topP-h').textContent(), new RegExp(`From 0 to 1\\. Shipped: ${shippedTopP === null ? 'off' : shippedTopP}`));
  assert.equal(await page.locator('#p-sampling-topP').isDisabled(), shippedTopP === null);
  await page.fill('#p-sampling-temperature', String(temperature));
  if (shippedTopP === null) { await page.locator('#p-sampling-topP-off').uncheck(); assert.equal(await page.inputValue('#p-sampling-topP'), '0.9'); }
  await page.fill('#p-sampling-topP', String(topP));
  await page.fill('#p-sampling-maxTokens', String(maxTokens));
  await page.fill('#p-limits-persona', String(persona));
  await page.fill('#p-limits-turns', String(turns));
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  const third = e.profiles.getOverride('local-standard');
  assert.deepEqual({...third.sampling}, {temperature, topP, maxTokens});
  assert.deepEqual({...third.limits}, {persona, turns});
  await page.locator('#p-sampling-topP-off').check();
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  assert.equal(e.profiles.getEffective('local-standard').sampling.topP, null, 'Off is not sent');
  assert.equal('topP' in e.profiles.getOverride('local-standard').sampling, shippedTopP !== null, 'where Off is the shipped value nothing is stored for it');

  // More samplers: Top K and Min P (with Off, like Top P), the penalties, and the advanced parameters as JSON. A bad JSON or a key the form refuses is said in words and nothing is saved.
  assert.equal(await page.locator('#p-sampling-topK').isDisabled(), true, 'off while the shipped value is off');
  assert.match(await page.locator('#p-sampling-topK-h').textContent(), /From 0 to 1000\. Shipped: off/);
  assert.match(await page.locator('#p-sampling-minP-h').textContent(), /From 0 to 1\. Shipped: off/);
  await page.locator('#p-sampling-topK-off').uncheck(); assert.equal(await page.inputValue('#p-sampling-topK'), '40');
  await page.locator('#p-sampling-minP-off').uncheck(); assert.equal(await page.inputValue('#p-sampling-minP'), '0.05');
  await page.fill('#p-sampling-topK', '20');
  await page.locator('#p-sampling-presencePenalty-off').uncheck();
  await page.fill('#p-sampling-presencePenalty', '0.3');
  await page.fill('#p-sampling-extra', '{"typical_p": 0.9,');
  await page.waitForSelector('section[data-field=sampling] .err');
  assert.equal(await page.locator('section[data-field=sampling] .err').textContent(), 'Advanced parameters (JSON): That is not valid JSON.');
  assert.equal(await page.locator('#p-sampling-extra').getAttribute('aria-invalid'), 'true');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await toast(page).waitFor();
  assert.equal(e.profiles.getEffective('local-standard').sampling.topK, null, 'a bad JSON stores nothing, not even the other boxes');
  await page.fill('#p-sampling-extra', '{"typical_p": 0.9, "model": "x", "max_tokens": 5, "top_p": 0.5}');
  await page.waitForFunction(() => document.querySelectorAll('section[data-field=sampling] .err').length === 3);
  assert.deepEqual(await page.locator('section[data-field=sampling] .err').allTextContents(),
    ['Advanced parameters (JSON): “model” is set by the mod and cannot be changed here.', 'Advanced parameters (JSON): Use the Longest reply box for the length of a reply, not “max_tokens”.',
      'Advanced parameters (JSON): “top_p” has its own setting in this form. Use that instead.']);
  await page.fill('#p-sampling-extra', '{"typical_p": 0.9, "dry_multiplier": 0.8, "mirostat": 2}');
  await page.waitForFunction(() => !document.querySelector('section[data-field=sampling] .err'));
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  const more = e.profiles.getEffective('local-standard').sampling;
  assert.deepEqual([more.topK, more.minP, more.presencePenalty, {...more.extra}], [20, 0.05, 0.3, {typical_p: 0.9, dry_multiplier: 0.8, mirostat: 2}]);
  assert.match(await page.inputValue('#p-sampling-extra'), /"typical_p": 0.9/, 'the saved JSON is shown again');
  await page.fill('#p-sampling-extra', '');
  await page.locator('#p-sampling-topK-off').check();
  await page.locator('#p-sampling-minP-off').check();
  await page.locator('#p-sampling-presencePenalty-off').check();
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  const none = e.profiles.getEffective('local-standard').sampling;
  assert.deepEqual([none.topK, none.minP, none.presencePenalty, none.extra], [null, null, null, null]);

  // Errors, in plain words, in the sections they belong to; Save is refused with the same words and stores nothing.
  const before = JSON.stringify(e.profiles.getOverride('local-standard'));
  await page.fill('#p-sampling-temperature', '3');
  await page.waitForSelector('section[data-field=sampling] .err');
  assert.equal(await page.locator('section[data-field=sampling] .err').textContent(), 'Temperature: Use a number from 0 to 2.');
  assert.equal(await page.locator('#p-sampling-temperature').getAttribute('aria-invalid'), 'true');
  assert.match(await preview(page).locator('.stale').textContent(), /waits until the problems/);
  await page.fill('textarea[aria-label="Rule 2"]', 'x'.repeat(2001));
  await page.waitForSelector('section[data-field=rules] .err');
  assert.equal(await page.locator('section[data-field=rules] .err').textContent(), 'Rule 2 is too long. Keep each one under 2000 characters.');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await toast(page).waitFor();
  assert.match(await toast(page).textContent(), /is too long|Use a number/);
  assert.equal(JSON.stringify(e.profiles.getOverride('local-standard')), before, 'nothing was stored');
  await e.shot('22-prompting-errors');
  await saveBar(page).getByRole('button', {name: 'Revert changes'}).click();
  assert.equal(await page.locator('.err').count(), 0, 'reverted: no problem left');
  assert.equal(await page.inputValue('#p-sampling-temperature'), String(temperature));
  await page.waitForFunction(() => !document.querySelector('.ppreview .stale'));

  // Reset one part, then everything.
  e.dialogs.length = 0;
  await page.locator('section[data-field=sampling] .phead').getByRole('button', {name: 'Reset to default'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Back to the shipped prompting.');
  assert.deepEqual(e.dialogs, ['Go back to the shipped prompting for Local AI, Standard? Your changes to this part are removed.']);
  assert.equal('sampling' in e.profiles.getOverride('local-standard'), false);
  assert.equal(await page.inputValue('#p-sampling-temperature'), String(STANDARD.sampling.temperature));
  assert.equal(await page.inputValue('#p-labels-rules'), 'MY RULES', 'the other parts stay');
  // An unsaved edit in another part is kept while one part is reset.
  await page.fill('#p-labels-examples', 'MY EXAMPLES');
  await page.locator('section[data-field=limits] .phead').getByRole('button', {name: 'Reset to default'}).click();
  await page.waitForFunction(value => document.querySelector('#p-limits-persona')?.value === value, String(STANDARD.limits.persona ?? ''));
  assert.equal(await page.inputValue('#p-labels-examples'), 'MY EXAMPLES', 'unsaved text in another part survives a reset of one part');
  await saveBar(page).getByRole('button', {name: 'Revert changes'}).click();
  e.dialogs.length = 0;
  await page.getByRole('button', {name: 'Reset everything'}).last().click();
  await page.waitForFunction(() => document.querySelector('#p-labels-rules')?.value !== 'MY RULES');
  assert.deepEqual(e.dialogs, ['Go back to the shipped prompting for Local AI, Standard? All your changes to it are removed.']);
  assert.equal(e.profiles.getOverride('local-standard'), null);
  assert.deepEqual(e.profiles.list().filter(row => row.changed), []);
  assert.equal(await page.locator('.profiles .profile').nth(2).locator('.chip').count(), 1, 'only In use now');
  assert.deepEqual(JSON.parse(JSON.stringify(e.profiles.getEffective('local-standard'))), JSON.parse(JSON.stringify(e.profiles.getDefault('local-standard'))));
  await e.shot('23-prompting-reset');

  // Another option: unsaved edits ask before they are left; each option keeps its own change; Mature options start with the Mature preview.
  await page.locator('textarea[aria-label="Rule 1"]').fill('Unsaved wording.');
  e.dialogs.length = 0;
  await picks.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('#main h2')[1]?.textContent === 'Mistral');
  assert.deepEqual(e.dialogs, ['You have changes that are not saved. Leave without saving?']);
  assert.equal(await page.locator('textarea[aria-label="Rule 1"]').inputValue(), defaultProfile('mistral').rules[0].text, 'the unsaved text was dropped');
  // Mistral's API takes neither Top K, Min P nor extra fields: they are not offered, with a note; the two penalties are.
  assert.equal(await page.locator('#p-sampling-topK, #p-sampling-minP, #p-sampling-extra').count(), 0);
  assert.equal(await page.locator('#p-sampling-presencePenalty').count(), 1);
  assert.match(await page.locator('section[data-field=sampling]').textContent(), /Mistral takes only the settings shown here/);
  await page.fill('#p-closing-text', 'Mistral closing.');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  await picks.nth(3).click();
  await page.waitForFunction(() => document.querySelectorAll('#main h2')[1]?.textContent === 'Local AI, Lite, Mature on');
  assert.equal(await page.locator('#p-sample-mature').isChecked(), true);
  // The Mature layer's wording: its own section on this option (not on Mistral's), shown in the preview, saved, reset.
  assert.equal(await page.locator('section[data-field=matureLayer] textarea').count(), 11);
  assert.equal(await page.inputValue('#p-mature-tone'), defaultProfile('mature-lite').matureLayer.tone);
  assert.equal(await page.locator('label[for=p-mature-speechFull]').textContent(), 'Speech line, for models that allow explicit sex');
  await previewHas(page, 'MATURE CONTENT IS ON (adults 18+ only)');
  await page.fill('#p-mature-tone', 'MY TONE LINE.');
  await previewHas(page, 'MY TONE LINE.');
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  assert.equal(e.profiles.getOverride('mature-lite').matureLayer.tone, 'MY TONE LINE.');
  await page.fill('#p-mature-tone', 'x'.repeat(1501));
  await page.waitForSelector('section[data-field=matureLayer] .err');
  assert.equal(await page.locator('section[data-field=matureLayer] .err').textContent(), 'Tone line: This text is too long. Keep it under 1500 characters.');
  await saveBar(page).getByRole('button', {name: 'Revert changes'}).click();
  e.dialogs.length = 0;
  await page.locator('section[data-field=matureLayer] .phead').getByRole('button', {name: 'Reset to default'}).click();
  await page.waitForFunction(value => document.querySelector('#p-mature-tone')?.value === value, defaultProfile('mature-lite').matureLayer.tone);
  assert.equal(e.profiles.getOverride('mature-lite'), null);
  await picks.nth(5).click();
  await page.waitForFunction(() => document.querySelectorAll('#main h2')[1]?.textContent === 'Custom: qwen3-8b at openrouter.ai');
  const custom = defaultProfile(customProfileId('https://openrouter.ai', 'qwen3-8b'), {family: 'qwen'}), penalty = differs(custom.sampling.repeatPenalty, 1.1, 1.15);
  if (custom.sampling.repeatPenalty === null) await page.locator('#p-sampling-repeatPenalty-off').uncheck();
  await page.fill('#p-sampling-repeatPenalty', String(penalty));
  await saveBar(page).getByRole('button', {name: 'Save'}).click();
  await savedToast(page);
  assert.equal(e.profiles.getOverride('mistral').closing.text, 'Mistral closing.');
  assert.equal(e.profiles.getOverride('local-standard'), null, 'a change never reaches another option');
  assert.equal(e.profiles.getOverride(customProfileId('https://openrouter.ai', 'qwen3-8b')).sampling.repeatPenalty, penalty);
  assert.deepEqual(await page.locator('.profiles .profile').evaluateAll(nodes => nodes.map(node => node.querySelectorAll('.chip').length)), [1, 0, 1, 0, 0, 1]);
  assert.deepEqual(e.problems, Array(2).fill('Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)'), 'no console message but the browser noting the two refused saves');
  assert(e.requests.every(url => url.startsWith(e.url.slice(0, e.url.indexOf('/editor')))), 'nothing left this computer');
});

test('Prompting: sentences and problems in the player\'s language, text from a rule is only text, and the page works at phone width', {skip, timeout: 180000}, async t => {
  const strings = {Prompting: 'Invite', 'Local AI, Standard': 'IA locale, standard', 'In use now': 'En cours', Temperature: 'Température', 'Use a number from {min} to {max}.': 'Utilisez un nombre de {min} à {max}.',
    '{field}: {message}': '{field} : {message}', 'Output rules': 'Règles de sortie', Preview: 'Aperçu', 'Rule {n} is empty. Write the rule or delete it.': 'La règle {n} est vide. Écrivez-la ou supprimez-la.',
    'Add a rule': 'Ajouter une règle', Save: 'Enregistrer', 'Saved.': 'Enregistré.'};
  const e = await open(t, {strings, language: 'fr', viewport: {width: 375, height: 800}});
  const {page} = e;
  assert.equal(await page.locator('#prompting').textContent(), 'Invite');
  await page.locator('#prompting').click();
  await page.waitForSelector('.profiles .profile');
  assert.equal(await page.locator('.profiles .profile').nth(2).textContent(), 'IA locale, standardEn cours');
  assert.equal(await page.locator('section[data-field=rules] h3').textContent(), 'Règles de sortie');
  // A problem, in French.
  await page.fill('#p-sampling-temperature', '5');
  await page.waitForSelector('section[data-field=sampling] .err');
  assert.equal(await page.locator('section[data-field=sampling] .err').textContent(), 'Température : Utilisez un nombre de 0 à 2.');
  await page.fill('#p-sampling-temperature', String(STANDARD.sampling.temperature));
  await page.waitForFunction(() => !document.querySelector('section[data-field=sampling] .err'));
  // Text with markup in it stays text, in the form and in the preview.
  const markup = '<img src=x onerror="window.__x=1"><script>window.__x=2</script>';
  await page.locator('textarea[aria-label="Rule 1"]').fill(markup);
  await previewHas(page, markup);
  await page.getByRole('button', {name: 'Enregistrer'}).click();
  await page.waitForFunction(() => document.querySelector('#note.show')?.textContent === 'Enregistré.');
  assert.equal(e.profiles.getOverride('local-standard').rules[0].text, markup);
  assert.equal(await page.evaluate(() => window.__x), undefined, 'no script ran');
  assert.equal(await page.locator('#main img').count(), 0, 'no element was made from the text');
  assert.equal((await page.locator('.ppreview pre').first().textContent()).includes(markup), true);
  // An empty rule: the sentence is in French too.
  await page.getByRole('button', {name: 'Ajouter une règle'}).click();
  await page.waitForSelector('section[data-field=rules] .err');
  assert.equal(await page.locator('section[data-field=rules] .err').textContent(), `La règle ${STANDARD.rules.length + 1} est vide. Écrivez-la ou supprimez-la.`);
  // Phone width: no sideways scroll, the preview comes after the form.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, 'no sideways scroll, got ' + overflow);
  assert.equal(await page.evaluate(() => { const form = document.querySelector('.pedit').getBoundingClientRect(), side = document.querySelector('.ppreview').getBoundingClientRect(); return side.top >= form.bottom - 1; }), true, 'one column');
  await e.shot('24-prompting-phone');
  assert.deepEqual(e.problems, [], 'no console error or warning');
});

test('Prompting: in the light theme, wide, the preview sits beside the form; Convai answering keeps the warning; leaving the page leaves nothing behind', {skip, timeout: 180000}, async t => {
  const e = await open(t, {scheme: 'light', route: 'convai'});
  const {page} = e;
  await page.locator('#prompting').click();
  await page.waitForSelector('.pcols');
  assert.equal(await page.locator('#banner').isHidden(), false, 'the warning stays: these changes have no effect while Convai answers');
  assert.equal(await page.evaluate(() => { const form = document.querySelector('.pedit').getBoundingClientRect(), side = document.querySelector('.ppreview').getBoundingClientRect(); return side.left >= form.right - 1; }), true, 'two columns on a wide screen');
  await e.shot('25-prompting-light');
  await page.fill('#search', 'judy');
  await page.locator('#list button.pick').click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.locator('.pcols').count(), 0);
  assert.equal(await page.locator('#prompting').evaluate(node => node.classList.contains('on')), false);
});
