// The notice of the manager shortcut beside Mod Configuration Menu (mod/nsui-entry.lua, mod/nsui.lua, docs/NOTIFICATIONS.md, docs/MANAGER_UI.md
// "Beside MCM") fits the game's warning line: two lines of upper-case text, in English and in all fifteen translations
// (bridge/notice-fit.mjs measures; it estimates, it cannot see the game).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICE = 'Open AI Companions in the Mods list.';
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('the notice is one paragraph that fits two lines, and it is the text the game shows', () => {
  assert.deepEqual(noticeProblems(NOTICE, {english: true}), [], NOTICE);
  assert.ok(read('../mod/nsui.lua').includes(`ui.t('${NOTICE}')`), 'mod/nsui.lua does not hold the notice');
  assert.ok(read('../mod/nsui.lua').includes("id = 'manager-in-mcm-list'"), 'mod/nsui.lua does not post it under its catalog id');
  assert.ok(read('../docs/NOTIFICATIONS.md').includes(NOTICE), 'docs/NOTIFICATIONS.md does not list the notice');
  assert.ok(read('../localization/en.json').includes(`"${NOTICE}"`), 'localization/en.json (Extract-UiCatalog.mjs) does not hold the notice');
});

for (const code of CODES) {
  test(`${code}: the notice is translated and fits two lines, and the name of the mod is kept`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(NOTICE);
    assert.ok(translated, `${code} has no translation of: ${NOTICE}`);
    assert.notEqual(translated, NOTICE, `${code}: the notice is not translated`);
    assert.deepEqual(noticeProblems(translated), [], `${code}: ${translated}`);
    assert.ok(translated.includes('AI Companions'), `${code}: the name of the mod is the one on the Mods screen: ${translated}`);
  });
}
