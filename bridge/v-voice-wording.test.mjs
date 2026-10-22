// V's typed-line voice follows V's own voice setting (Pocket by default, OmniVoice when offered), whatever voice the companions use. So a cloud
// companion voice (Voxtral) loads no local model FOR THE COMPANIONS, and the words in the menu and the player docs must say that and not "no local model" alone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const menu = read('../mod/manager-ui.lua');
const catalog = JSON.parse(read('../localization/en.json')).strings;

test('the companion voice row says the companions\' voice loads no local model and V follows its own setting', () => {
  const row = Object.keys(catalog).find(key => key.startsWith('Pocket: the lightest, on your CPU'));
  assert(row, 'the Companion voices help is in the catalogue');
  assert(row.includes('The companions’ voice loads no local model; V’s typed lines follow V’s own voice setting.'));
  assert(!/It loads no local voice model/.test(row) && !/It loads no local voice model/.test(menu));
  assert(menu.includes(row.replace(/\n/g, '\\n')), 'the row in the menu is this text');
  // the V row still says what its own engines load
  assert(menu.includes('its own small model if the companions use another voice'));
});

test('every language carries the changed row', () => {
  const row = Object.keys(catalog).find(key => key.startsWith('Pocket: the lightest, on your CPU'));
  const escaped = row.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  for (const name of readdirSync(new URL('../mod/locales/', import.meta.url)).filter(file => file.endsWith('.lua'))) {
    assert(read(`../mod/locales/${name}`).includes(`["${escaped}"] =`), `${name} has no translation of the Companion voices help`);
  }
});

test('the player docs do not say that nothing local runs once the companions use a cloud voice, without the V caveat', () => {
  for (const file of ['../README.md', '../packaging/PLAYER_README.md']) {
    const text = read(file);
    for (const line of text.split('\n').filter(item => /Nothing runs on your PC/.test(item))) {
      assert(/V's voice for typed lines to Off or Voxtral/.test(line), `${file}: ${line.slice(0, 80)}`);
    }
  }
  const readme = read('../README.md');
  assert(readme.includes("The companions' voice loads no local model (V's typed lines follow V's own voice setting, Pocket by default)"));
});
