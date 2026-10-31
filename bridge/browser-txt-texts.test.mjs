import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {NO_BROWSER_MESSAGE} from './system-browser.mjs';

// Nexus report, 31 Oct 2026: Linux and Steam Deck players were told to write the browser path in browser.txt "next to launcher.ini", but launcher.ini is not shipped (a missing
// file means defaults), so they looked for it and could not find it. Every text now names the folder, and says no launcher.ini is needed.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const FOLDER = 'red4ext/plugins/AiNpcCyberpunkMod';
const NEXT_TO = /(?:next to|beside|alongside)\s+`?launcher\.ini/i;

test('the supervisor\'s Wine and Proton message and the no-browser message name the folder and say no launcher.ini is needed', () => {
  const supervisor = read('./bridge-supervisor.mjs');
  const wine = /const WINE_BROWSER_MESSAGE = '([^']*)'/.exec(supervisor)?.[1];
  assert.ok(wine, 'the message exists');
  for (const message of [wine, NO_BROWSER_MESSAGE]) {
    assert.match(message, /browser\.txt/);
    assert.ok(message.includes(FOLDER), message);
    assert.match(message, /\(no launcher\.ini is needed\)/);
    assert.doesNotMatch(message, NEXT_TO);
  }
  assert.match(wine, /Wine or Proton/);
});

test('every English text of the game side that mentions browser.txt names the folder', () => {
  for (const file of ['../mod/manager-ui.lua', '../mod/service-status.lua', '../mod/setup-check.lua', '../mod/support-report.lua']) {
    const source = read(file);
    assert.ok(source.includes('browser.txt'), file);
    assert.doesNotMatch(source, NEXT_TO, file + ' still points at launcher.ini');
    for (const line of source.split('\n').filter(line => line.includes('browser.txt'))) {
      if (line.trim().startsWith('--')) continue;
      assert.ok(line.includes(FOLDER) && line.includes('no launcher.ini is needed'), `${file}: ${line.trim().slice(0, 120)}`);
    }
  }
});

test('all fifteen dictionaries carry the new sentence under the new source text, and no old one', () => {
  const files = readdirSync(new URL('../mod/locales/', import.meta.url)).filter(name => name.endsWith('.lua'));
  assert.equal(files.length, 15);
  for (const name of files) {
    const source = read('../mod/locales/' + name);
    const entries = source.split('\n').filter(line => line.includes('The conversation service needs a Chromium browser'));
    assert.equal(entries.length, 1, name);
    const [key, value] = entries[0].split('"] = "');
    assert.ok(key.includes(FOLDER) && key.includes('(no launcher.ini is needed)'), name + ' key');
    assert.ok(value.includes(FOLDER + ' ') || value.includes(FOLDER), name + ' says the folder');
    assert.ok(value.includes('browser.txt'), name);
    assert.doesNotMatch(source, NEXT_TO);
  }
});

test('the docs and the player README say the same', () => {
  for (const file of ['../README.md', '../bridge/README.md', '../docs/MANAGER_UI.md', '../docs/NEXUS_PAGE.md', '../docs/PACKAGING.md', '../packaging/PLAYER_README.md', '../bridge/system-browser.mjs', '../packaging/runtime/start-service.mjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /browser\.txt[^\n]{0,40}(?:next to|beside)\s+`?launcher\.ini/i, file);
    assert.match(source, /AiNpcCyberpunkMod/, file);
  }
  assert.match(read('../packaging/PLAYER_README.md'), /browser\.txt file in the red4ext\/plugins\/AiNpcCyberpunkMod folder of the game \(no launcher\.ini is needed\)/);
});
