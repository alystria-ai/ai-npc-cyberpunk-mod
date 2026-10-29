// The value of a select row in Settings sits between the game's two arrows in a fixed-width box; a longer text runs over the arrows.
// This test keeps every option text of every select (English and the 15 translations), and the names of the built-in models, within
// the budget of mod/manager-ui.lua (OPTION_BUDGET, in the units of optionUnits()). The budget is the box minus the two key boxes ("A" at the
// left arrow, "D" at the right one) that the game draws over a FOCUSED selector row, so a label that passes here fits focused as well
// as unfocused. The Lua side is checked in bridge/manager.test.mjs (the live menus in the worst case, the truncation of a custom
// model's name); here the units are re-derived in JavaScript and the two are compared on sample strings there.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {optionUnits} from './option-units.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const catalog = JSON.parse(read('../localization/en.json'));
const releaseConfig = JSON.parse(read('../packaging/release.config.json'));
const pageSource = read('../mod/manager-ui.lua');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];

const [, boxUnits, keyHintUnits] = /local OPTION_BOX_UNITS, KEY_HINT_UNITS = (\d+), (\d+)/.exec(pageSource).map(Number);
assert(/local OPTION_BUDGET = OPTION_BOX_UNITS - 2 \* KEY_HINT_UNITS/.test(pageSource), 'the budget is the box minus two key boxes');
const budget = boxUnits - 2 * keyHintUnits;

// Every English text that reaches a select row through ui.t, as it is built in mod/manager-ui.lua and mod/manager.lua.
const OMNI = ['OmniVoice · Balanced', 'OmniVoice · Quality', 'OmniVoice · High Quality', 'OmniVoice · Ultra Quality'];
const STATIC_OPTIONS = [
  '10 cm higher', '10 cm lower', '5 cm higher', '5 cm lower', 'Above the speaker', 'Auto', 'Casual', 'Cinematic subtitles', 'Convai API key', 'Convai free tier',
  'Custom (OpenAI-compatible)', 'Default', 'Eyes only', 'Gentle (default)', 'Google Gemini (free plan)', 'Local AI', 'Mistral', 'Mistral (your key)', 'No model installed', 'Service not running', 'Service starting',
  'Off', 'Ordinary', 'Romantic', 'Strong', 'Subtle', 'On', 'Speaks up rarely', 'Speaks up normally', 'Speaks up often', 'Pocket · On your PC',
  'Pocket · Performance', ...OMNI, 'Convai · Cloud voice',
  'Voxtral (recommended)', 'Voxtral · Mistral cloud', 'Voxtral · needs Mistral key',
  'OmniVoice', 'OmniVoice · needs Omni voice', 'OmniVoice · needs Omni pack',
  // Settings > Immersive invitations
  'Walk', 'Car', 'Right now', 'In 2 minutes', 'In 5 minutes', 'In 10 minutes', '2 minutes', '5 minutes', '10 minutes',
  // Settings > Housemates: the pause, the chat size, and the Move-in list (Ask me, then the apartments V owns)
  '1 minute', '2 people', '3 people', '4 people', 'Ask me',
  'Megabuilding H10', 'Corpo Plaza', 'Heywood Glen', 'Westbrook Japantown', 'Watson Northside',
];

function localeTable(code) {
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(read(`../mod/locales/${code}.lua`)));
  assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
  const rows = {};
  lua.lua_pushnil(vm);
  while (lua.lua_next(vm, -2) !== 0) {
    rows[to_jsstring(lua.lua_tostring(vm, -2))] = to_jsstring(lua.lua_tostring(vm, -1));
    lua.lua_pop(vm, 1);
  }
  lua.lua_close(vm);
  return rows;
}

const labelsIn = translate => STATIC_OPTIONS.map(text => ({text, shown: translate(text)}));

test('the English option texts are the strings of the catalog, and every option string of the catalog is checked here', () => {
  for (const text of STATIC_OPTIONS) assert(text in catalog.strings, `not in the catalog: ${text}`);
  const checked = new Set(STATIC_OPTIONS);
  for (const text of catalog.contexts['page.options']) assert(checked.has(text), `an option text of the catalog is not checked here: ${text}`);
});

test('every English select option fits the budget', () => {
  assert(boxUnits === 32 && keyHintUnits >= 2 && budget >= 20 && budget <= 28, `budget ${budget} of a box of ${boxUnits}, key boxes ${keyHintUnits}`);
  const tooWide = labelsIn(text => text).filter(({shown}) => optionUnits(shown) > budget).map(({shown}) => `${shown} (${optionUnits(shown)})`);
  assert.deepEqual(tooWide, []);
});

for (const code of codes) {
  test(`${code}: every select option fits the budget`, () => {
    const rows = localeTable(code);
    const tooWide = labelsIn(text => rows[text] ?? assert.fail(`${code} has no translation of ${text}`))
      .filter(({shown}) => optionUnits(shown) > budget).map(({text, shown}) => `${text} -> ${shown} (${optionUnits(shown)})`);
    assert.deepEqual(tooWide, [], `${code} has options wider than ${budget}`);
  });
}

test('the built-in Local AI model names fit the budget (the names of the packs are the display names)', () => {
  const names = [
    releaseConfig.localAi.tiers.standard.name, releaseConfig.localAi.tiers.lite.name,
    releaseConfig.maturePack.tiers.lite.name, releaseConfig.maturePack.tiers.good.name,
  ];
  assert.equal(names.length, 4);
  const tooWide = names.filter(name => optionUnits(name) > budget).map(name => `${name} (${optionUnits(name)})`);
  assert.deepEqual(tooWide, []);
  // Whatever its name, an uncensored model must keep the word the Mature allowance reads (bridge/mature-content.mjs).
  for (const name of [releaseConfig.maturePack.tiers.lite.name, releaseConfig.maturePack.tiers.good.name]) assert(/uncensored/i.test(name), name);
});

test('the units used by the test are the units the game code uses', () => {
  // The Lua estimate is compared on the same strings in bridge/manager.test.mjs ("select option width").
  for (const [text, expected] of [['Pocket · Performance', 18], ['Voxtral · needs Mistral key', 22.3], ['日本語', 6], ['', 0]]) {
    assert(Math.abs(optionUnits(text) - expected) < 1, `${text}: ${optionUnits(text)}`);
  }
});
