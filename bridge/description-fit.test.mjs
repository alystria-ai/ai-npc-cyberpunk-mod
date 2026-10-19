// The help text on the right of the Settings page is MCM's description panel: a rich-text box inside a scroll area that cannot be scrolled
// (McmUiSetDescription in r6/scripts/ModConfigurationMenu/UI/MCMModal.reds: interactive false, scroll position 0), so what does not fit
// is cut off at the bottom. In the 1920 x 1080 layout (MCMLayout.reds) the panel is 414 wide and 762 tall, the text box has a 16 px
// margin each side and 12 px top and bottom, and wraps at 382. At the size our descriptions are drawn (mod/mcm-fonts.lua,
// DESCRIPTION_FONT_SIZE, 22) a line is about 28 px tall and holds about 34 average letters. The test is deliberately more careful
// than that: 32 letters per line and at most 26 lines (738 / 26 = 28.4 px a line), for English and the 15 translations, with the
// longest text a page can build (every optional paragraph present). It estimates; it cannot see the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {optionUnits} from './option-units.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const catalog = JSON.parse(read('../localization/en.json'));
const fontsSource = read('../mod/mcm-fonts.lua');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];

const FONT_SIZE = Number(/DESCRIPTION_FONT_SIZE, DESCRIPTION_FONT_FALLBACK = (\d+), \d+/.exec(fontsSource)[1]);
const UNITS_PER_LINE = 32;
const MAX_LINES = 26;

/** Lines a text takes in the panel: every paragraph wraps on its own and an empty line is a line. */
export function descriptionLines(text) {
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines += 1; continue; }
    // Words and spaces; a Chinese, Japanese or Korean character can end a line anywhere.
    const tokens = paragraph.match(/[⺀-￿]|[^\s⺀-￿]+|\s+/gu) ?? [];
    let used = 0, count = 1;
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) { used += optionUnits(' '); continue; }
      const width = optionUnits(token);
      if (used > 0 && used + width > UNITS_PER_LINE) { count += 1; used = 0; }
      used += width;
      if (used > UNITS_PER_LINE && width > UNITS_PER_LINE) { count += Math.floor(used / UNITS_PER_LINE); used %= UNITS_PER_LINE; }
    }
    lines += count;
  }
  return lines;
}

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

// The strings of the pages that are shown as a description (the rows' own labels are short and fit trivially).
const DESCRIPTION_CONTEXTS = ['mcm.setting', 'mcm.action', 'mcm.readonly', 'mcm.category', 'mcm.keyRow'];
const singles = DESCRIPTION_CONTEXTS.flatMap(name => catalog.contexts[name]).filter(text => text.length > 40);

// Descriptions that mod/mcm.lua builds from several strings, each joined by a blank line, at their longest (every optional paragraph
// present, a few installed models, one custom model and one unusable one). {tokens} are filled with sample values.
const sampleModels = ['Qwen3.5-2B (1.3 GB)', 'Qwen3.5-4B · uncensored (2.6 GB)', 'Gemma 4 E4B (5.0 GB)', 'Gemma 4 E4B · uncensored (5.1 GB)', 'My Model (custom, 4.0 GB, needs 5.2 GB)'].join('\n');
const MATURE_PACK = 'The Mature pack’s uncensored models give the full effect; standard models mostly refuse sex. Pack: not installed (optional, on this mod’s Hugging Face page).';
// A catalog string found by its beginning (the long helps are not repeated here).
const byStart = (start, contains = '') => {
  const hits = Object.keys(catalog.strings).filter(text => text.startsWith(start) && text.includes(contains));
  assert(hits.length >= 1, `no catalog string starts with: ${start}`);
  return hits[hits.length - 1];
};
// A part that starts with this mark continues the previous paragraph (joined by a space, not a blank line).
const SAME = '~';
const providerHelpLongest = byStart('Who writes your companions’ replies.', 'Speech recognition for the voice key is not available yet');
const composites = {
  'Mature content': [
    'Strong language, graphic violence, drugs and, between consenting adults, flirting and sex. Adults only (18+), Local AI only.',
    MATURE_PACK,
    'Never allowed: sex with minors or without consent, sex about real people, hate, real-world weapon or drug instructions. A safety check enforces the minors rule.',
    'Turning it on also selects Local AI, the largest uncensored model that fits and a local voice instead of a cloud one. Turning it off restores your choices.',
    `${SAME}Choosing a cloud provider turns it off.`,
    'Needs Local AI.',
  ],
  // The provider help with its longest note (the free tier's allowance line, the longest of the notes) after it.
  'Conversation provider': [
    providerHelpLongest,
    'Convai free tier: {left} of {limit} left today',
  ],
  // The same help while the daily limit is reached: the status only (what to do is in the Mistral key row's help, below).
  'Conversation provider (daily limit reached)': [
    providerHelpLongest,
    'Convai free tier: daily limit reached',
  ],
  // A key row that is not saved yet, after a paste that failed: the message first, then the help; and one that is saved.
  // While the daily limit is reached the Mistral row ends with what to do (Mistral's estimate and Local AI without a limit).
  'Mistral free API key (failed paste)': ['Mistral did not accept that key.', byStart('Copy your free key from Mistral first')],
  'Mistral free API key (failed paste, daily limit reached)': [
    'Mistral did not accept that key.',
    byStart('Copy your free key from Mistral first'),
    'You have used today’s {limit} turns, which come back tomorrow. To keep talking now, choose Mistral (with your free key, about 5,000 turns a day) or Local AI (unlimited), then Apply.',
  ],
  // The Custom (OpenAI-compatible) rows (mod/custom-provider.lua): the URL help with a failed paste's message first, the helps of a saved row, the long
  // model id, and the failed test with the wait and the provider's own words (at most 160 letters) before the row's own help.
  'Custom endpoint URL (failed paste)': ['Use the base URL only: no password, query or #.', byStart('Copy the base URL from your provider')],
  'Custom endpoint URL (saved, not encrypted)': [byStart('Deletes the saved endpoint URL'), 'This address is not encrypted, which is fine on your own computer or home network.'],
  'Custom API key (failed paste)': ['The clipboard does not hold an API key.', byStart('Copy your API key from your provider first.')],
  'Custom API key (saved)': [byStart('Deletes the saved key. Replies'), 'Saved on this computer only. Only the last four characters are ever shown.'],
  'Custom model ID (failed paste)': ['The clipboard does not hold a model ID.', byStart('Copy the model ID from your provider first')],
  'Custom model ID (saved)': ['Model ID: {model}', byStart('Deletes the saved model ID')],
  'Test connection (failed, rate limit with a wait and the provider’s words)': [
    'The endpoint is rate limiting you. Wait about {seconds} seconds, then try again.', 'The provider said: {detail}', byStart('Sends one tiny message')],
  'Test connection (failed, the longest sentence)': [
    'The endpoint refused the request. Check the model ID and the address.', 'The provider said: {detail}', byStart('Sends one tiny message')],
  'Test connection (service not running)': [byStart('The conversation service is not running, so nothing can be tested.'), byStart('Sends one tiny message')],
  'Inworld API key (failed paste)': ['The clipboard could not be read.', byStart('Copy your key from Inworld first.')],
  'Inworld API key (saved)': ['Mistral did not accept that key.', 'Deletes the saved key. The Inworld cloud voice stops until you add a key again.', 'Saved on this computer only. Only the last four characters are ever shown.'],
  // Developer mode adds a paragraph about the Inworld voice to these helps.
  'Companion voices (developer mode)': [byStart('Pocket: the lightest'), 'Inworld: the same with your own Inworld key, and it also speaks with emotion.'],
  'Natural speech (developer mode)': [byStart('Companions now and then pause'), 'Inworld can voice laughs and sighs too.'],
  'Expressive emotions (developer mode)': [byStart('Each character marks its own feelings'), 'Inworld always speaks with emotion, whatever this says.'],
  'Multilingual conversations (developer mode)': [byStart('Talk in any language'), 'Inworld speaks English only as well.'],
  // Local AI could not start because only Mature models are usable and Mature content is off: this line replaces the generic failure line at the
  // top of the model help. A Mature-only install lists the Mature pack's two models; a server of the player's is one custom model.
  'Local AI model (Mature-only install)': [
    'Only Mature models found. Turn on Mature content to use them.',
    'Until you choose one, Local AI loads the largest model that fits your free graphics memory.\n\nOne model at a time; a change applies when it next loads. A model that is missing, too large or failing is replaced by the largest that fits, with one notice.',
    'LIST_MATURE',
  ],
  'Local AI model (own server marked uncensored)': [
    'Only Mature models found. Turn on Mature content to use them.',
    'Until you choose one, Local AI loads the largest model that fits your free graphics memory.\n\nOne model at a time; a change applies when it next loads. A model that is missing, too large or failing is replaced by the largest that fits, with one notice.',
    'LIST_SERVER',
    'Custom models are ones you added; they join the default choice by size.',
  ],
  'Local AI model': [
    'Until you choose one, Local AI loads the largest model that fits your free graphics memory.\n\nOne model at a time; a change applies when it next loads. A model that is missing, too large or failing is replaced by the largest that fits, with one notice.',
    `LIST`,
    'Custom models are ones you added; they join the default choice by size.',
    'Not usable: Embedder: an embedding model, not a chat model; Gone: file not found. See the Local AI notes, "Add your own model".',
  ],
};
const compositeSources = Object.values(composites).flat().map(text => text.startsWith(SAME) ? text.slice(SAME.length) : text);
for (const text of compositeSources) {
  const known = text === 'LIST' || text === 'LIST_MATURE' || text === 'LIST_SERVER' || text.startsWith('Not usable') || text.startsWith('Until you choose') || text in catalog.strings;
  assert(known, `a composite part is not in the catalog: ${text.slice(0, 50)}`);
}

const translateComposite = (parts, translate) => parts.map((part, index) => {
  const joiner = index === 0 ? '' : part.startsWith(SAME) ? ' ' : '\n\n';
  if (part.startsWith(SAME)) part = part.slice(SAME.length);
  return joiner + translatePart(part, translate);
}).join('');

const translatePart = (part, translate) => {
  if (part === 'LIST_MATURE') return ['Qwen3.5-4B · uncensored (2.6 GB)', 'Gemma 4 E4B · uncensored (5.1 GB)'].join(String.fromCharCode(10));
  if (part === 'LIST_SERVER') return translate('{name} (custom)').replace('{name}', 'My Model');
  if (part === 'LIST') {
    // The installed models: names as the bridge gives them, the custom line from its template.
    return sampleModels.split('\n').map(line => line.includes('custom')
      ? translate('{name} (custom, {size} GB, needs {need} GB)').replace('{name}', 'My Model').replace('{size}', '4.0').replace('{need}', '5.2') : line).join('\n');
  }
  if (part.startsWith('Not usable:')) return translate('Not usable: {models}. See the Local AI notes, "Add your own model".').replace('{models}', 'Embedder: an embedding model, not a chat model; Gone: file not found');
  if (part.startsWith('You have used today’s {limit}')) return translate(part).replace('{limit}', '100');
  if (part.startsWith('Convai free tier: {left}')) return translate(part).replace('{left}', '87').replace('{limit}', '100');
  // The longest values the Custom rows are given: a model id of 120 characters, a wait of two digits, the provider's words (160 characters).
  if (part.startsWith('Model ID: {model}')) return translate(part).replace('{model}', 'meta-llama/llama-3.1-8b-instruct:extended-with-a-long-name-0123456789-0123456789-0123456789-0123456789-0123456789-012345');
  if (part.startsWith('The endpoint is rate limiting you. Wait about {seconds}')) return translate(part).replace('{seconds}', '30');
  if (part.startsWith('The provider said: {detail}')) return translate(part).replace('{detail}', 'Your credits are used up for this month. Add credits or wait until the next billing period starts, then try the same request again. Contact us if this keeps happening.');
  return translate(part);
};

const check = (translate, label) => {
  const tooLong = [];
  for (const text of singles) {
    const shown = translate(text);
    const lines = descriptionLines(shown);
    if (lines > MAX_LINES) tooLong.push(`${lines} lines: ${text.slice(0, 60)}`);
  }
  for (const [name, parts] of Object.entries(composites)) {
    const lines = descriptionLines(translateComposite(parts, translate));
    if (lines > MAX_LINES) tooLong.push(`${lines} lines: ${name} (all optional paragraphs)`);
  }
  assert.deepEqual(tooLong, [], `${label}: descriptions taller than the panel (${MAX_LINES} lines of ${UNITS_PER_LINE} letters at size ${FONT_SIZE})`);
};

test('the description panel text is drawn at 22', () => assert.equal(FONT_SIZE, 22));

test('the line estimate counts paragraphs, blank lines, wrapping and wide characters', () => {
  assert.equal(descriptionLines('One line'), 1);
  assert.equal(descriptionLines('One\n\nTwo'), 3);
  assert.equal(descriptionLines('word '.repeat(20).trim()), 3);
  assert.equal(descriptionLines('日本語'.repeat(8)), 2);
  assert.equal(descriptionLines('x'.repeat(100)), 4);
});

test('English descriptions fit the panel', () => check(text => text, 'en'));

for (const code of codes) {
  test(`${code}: descriptions fit the panel`, () => {
    const rows = localeTable(code);
    check(text => rows[text] ?? assert.fail(`${code} has no translation of ${text.slice(0, 50)}`), code);
  });
}

test('no description is left in the one-block wall of text it was before', () => {
  // Every English description of 140 letters or more is split into short blocks by blank lines.
  const walls = singles.filter(text => text.length >= 140 && !text.includes('\n\n') && !/\{path\}/.test(text));
  assert.deepEqual(walls, []);
});
