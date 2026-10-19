// The one-time notice of the automatic error reports (mod/error-reports.lua, docs/ERROR_REPORTS.md) fits the game's warning line: two lines
// of upper-case text, in English and in all fifteen translations (bridge/notice-fit.mjs measures; it estimates, it cannot see the game).
// The setting's row and help are translated in every language too.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICE = 'Error reports go to the developer automatically. Turn them off in Settings > Privacy.';
const ROW = ['Privacy', 'Send error reports automatically'];
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);
const HELP = unescape(/setting\('errorReports', 'Send error reports automatically', 'bool', [^,]+, true,\s*'((?:[^'\\]|\\.)*)'/.exec(read('../mod/manager-ui.lua'))?.[1] ?? '');

test('the notice is one paragraph that fits two lines, and it is the text the game shows', () => {
  assert.deepEqual(noticeProblems(NOTICE, {english: true}), [], NOTICE);
  assert.ok(read('../mod/error-reports.lua').includes(NOTICE), 'mod/error-reports.lua does not hold the notice');
  assert.ok(read('../docs/NOTIFICATIONS.md').includes(NOTICE), 'docs/NOTIFICATIONS.md does not list the notice');
  assert.match(HELP, /never holds keys/, 'the setting has its help text');
});

for (const code of CODES) {
  test(`${code}: the notice, the row and its help are translated, and the notice fits two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(NOTICE);
    assert.ok(translated, `${code} has no translation of: ${NOTICE}`);
    assert.deepEqual(noticeProblems(translated), [], `${code}: ${translated}`);
    for (const text of [...ROW, HELP]) assert.ok(rows.get(text), `${code} has no translation of: ${text.slice(0, 60)}`);
    assert.equal(rows.get(HELP).split('\n\n').length, 3, `${code}: the help keeps its three paragraphs`);
  });
}
