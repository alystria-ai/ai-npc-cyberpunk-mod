// The notice of an OmniVoice that cannot get the graphics memory it needs next to the game (mod/manager.lua takeVoiceFallbackNotice, reason 'omni-memory', docs/NOTIFICATIONS.md)
// fits the game's warning line: two lines of upper-case text, in English and in all fifteen translations (bridge/notice-fit.mjs measures; it estimates, it cannot see the game).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICE = 'OmniVoice needs more graphics memory than is free next to the game. Pocket is used.';
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('the English notice is one paragraph, fits two lines, and is what the game shows', () => {
  assert.deepEqual(noticeProblems(NOTICE, {english: true}), []);
  assert.ok(read('../mod/manager.lua').includes(`ui.t('${NOTICE}')`), 'mod/manager.lua does not hold the notice');
  assert.ok(read('../docs/NOTIFICATIONS.md').includes(NOTICE), 'docs/NOTIFICATIONS.md does not list the notice');
  assert.ok(read('../localization/en.json').includes(`"${NOTICE}"`), 'localization/en.json does not hold the notice');
});

for (const code of CODES) {
  test(`${code}: the notice and the three menu strings are translated, and the notice fits two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(NOTICE);
    assert.ok(translated, `${code} has no translation of the notice`);
    assert.notEqual(translated, NOTICE, `${code}: not translated`);
    assert.deepEqual(noticeProblems(translated), [], `${code}: ${translated}`);
    for (const key of ['OmniVoice needs 12 GB', '{voice} · needs 12 GB card',
      'The graphics card in this PC has less than the 12 GB OmniVoice needs next to the game. If it cannot start, Pocket is used. Choose Pocket to skip the wait.']) {
      assert.ok(rows.get(key), `${code} has no translation of: ${key}`);
    }
    assert.ok(rows.get('{voice} · needs 12 GB card').includes('{voice}'), `${code}: the {voice} placeholder is lost`);
  });
}
