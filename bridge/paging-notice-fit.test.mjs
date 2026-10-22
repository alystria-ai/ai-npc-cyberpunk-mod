// The notice of a voice that Windows had no memory for (the paging file is too small, error 1455; mod/manager.lua takeVoiceFallbackNotice, reason 'virtual-memory', the Help row of
// mod/setup-check.lua, docs/NOTIFICATIONS.md) fits the game's warning line: two lines of upper-case text, in English and in all fifteen translations (bridge/notice-fit.mjs measures; it estimates).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICE = 'Windows ran out of memory for the voice. A larger paging file or closing other apps helps.';
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('the English sentence fits two lines and is the one the notice, the Help row, the catalogue and the notification list hold', () => {
  assert.deepEqual(noticeProblems(NOTICE, {english: true}), []);
  assert.ok(read('../mod/manager.lua').includes(`ui.t('${NOTICE}')`), 'mod/manager.lua does not hold the notice');
  assert.ok(read('../mod/setup-check.lua').includes(`ui.t('${NOTICE}')`), 'mod/setup-check.lua does not hold the Help row');
  assert.ok(read('../docs/NOTIFICATIONS.md').includes(NOTICE), 'docs/NOTIFICATIONS.md does not list the notice');
  assert.ok(read('../localization/en.json').includes(`"${NOTICE}"`), 'localization/en.json does not hold the sentence');
  assert.equal(NOTICE.includes(';'), false);
});

for (const code of CODES) {
  test(`${code}: the sentence is translated, keeps the name Windows, and fits two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(NOTICE);
    assert.ok(translated, `${code} has no translation of the sentence`);
    assert.notEqual(translated, NOTICE, `${code}: not translated`);
    assert.ok(translated.includes('Windows'), `${code}: the name Windows is lost: ${translated}`);
    assert.deepEqual(noticeProblems(translated), [], `${code}: ${translated}`);
  });
}
