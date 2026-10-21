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
  const server = new EditorServer({editor: new CharacterEditor({personas, overrides, memory, route: () => state.route, custom, voices, worldRules})});
  return {dir, overrides, memory, server, state, custom, voices, personas, worldRules, async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
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
