// The five "no conversation profile" notices (mod/init.lua convaiUnprofiledNotice, docs/NOTIFICATIONS.md) fit the game's warning line:
// two lines of upper-case text, in English and in all fifteen translations, with a long roster name in {name}
// (bridge/notice-fit.mjs measures; it estimates, it cannot see the game).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICES = [
  '{name} is a story character. Turn on Talk to story characters in Esc > Mods.',
  'Talk to ordinary NPCs is off. Turn it on in Esc > Mods.',
  '{name} is a child and cannot be talked to.',
  '{name} is not a person and cannot be talked to.',
  '{name} cannot be talked to: the mod cannot tell which voice fits.',
];
const NAME = 'Johnny Silverhand';   // the longest roster-style names are about this long
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('the English notices are one paragraph each, fit two lines with a long name, and are what the game shows', () => {
  const init = read('../mod/init.lua'), docs = read('../docs/NOTIFICATIONS.md'), catalog = read('../localization/en.json');
  for (const notice of NOTICES) {
    assert.deepEqual(noticeProblems(notice.replace('{name}', NAME), {english: true}), [], notice);
    assert.ok(init.includes(`ui.t('${notice}'`), `mod/init.lua does not hold: ${notice}`);
    assert.ok(docs.includes(notice), `docs/NOTIFICATIONS.md does not list: ${notice}`);
    assert.ok(catalog.includes(`"${notice}"`), `localization/en.json does not hold: ${notice}`);
  }
});

for (const code of CODES) {
  test(`${code}: the five notices are translated and fit two lines with a long name`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    for (const notice of NOTICES) {
      const translated = rows.get(notice);
      assert.ok(translated, `${code} has no translation of: ${notice}`);
      assert.notEqual(translated, notice, `${code}: not translated: ${notice}`);
      assert.deepEqual(noticeProblems(translated.replace('{name}', NAME)), [], `${code}: ${translated}`);
    }
  });
}
