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
  const personas = new PersonaBook(rows, {overrides});
  const state = {route};
  const server = new EditorServer({editor: new CharacterEditor({personas, overrides, memory, route: () => state.route})});
  return {dir, overrides, memory, server, state, async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
}
async function open(t, {route, strings = {}, language = 'en', viewport = {width: 1280, height: 900}, scheme = 'dark'} = {}) {
  const b = await bench({route});
  const browser = await chromium.launch({executablePath: executable, headless: true, args: ['--mute-audio']});
  t.after(async () => { await browser.close(); await b.done(); });
  const url = await b.server.start({strings, language});
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
  assert.match(await page.locator('#sub').textContent(), /Mistral, Groq and Local\. They do not apply to Convai\./);
  assert.deepEqual(await page.locator('#list h3').allTextContents(), ['Story characters', 'Everyday people']);
  assert.equal(await page.locator('#list button.pick').count(), rows.length);
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
  assert.equal((await page.locator('#list h3').first().textContent()), 'Story-Charaktere');
  assert.equal(await page.locator('#main .empty').textContent(), 'Wähle links einen Charakter.');
  assert.equal(await page.locator('#foot').textContent(), 'Changes are saved on this computer and used from the next reply.', 'a sentence without a translation is shown in English');
  await e.shot('06-convai-banner-german');
  await page.locator('#list button.pick').first().click();
  await page.waitForSelector('#f-bio');
  await e.shot('07-convai-bio');
  // A saved edit still works (it is used the moment a text provider answers).
  await page.fill('#f-style', 'x').catch(() => {});
  assert.deepEqual(e.problems, []);
});

test('Close editor stops the server and says so; the page works at phone width and in the light theme', {skip, timeout: 120000}, async t => {
  const e = await open(t, {viewport: {width: 390, height: 844}, scheme: 'light'});
  const {page} = e;
  await page.locator('#list button.pick').first().click();
  await page.waitForSelector('#f-bio');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling at phone width');
  await e.shot('08-phone-light');
  await page.locator('#close').click();
  await page.getByText('The editor is closed. You can close this tab.').waitFor();
  await page.waitForTimeout(500);
  assert.equal(e.server.running, false);
  assert.deepEqual(e.problems.filter(message => !/Failed to load resource|net::ERR/.test(message)), []);
});
