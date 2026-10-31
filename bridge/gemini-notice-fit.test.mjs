// The seven failure notices of the Google Gemini provider (mod/custom-provider.lua, docs/NOTIFICATIONS.md) fit the game's warning line: two lines of upper-case text, in English and in
// all fifteen translations (bridge/notice-fit.mjs measures; it estimates, it cannot see the game). The daily one is measured with the widest clock time ("23:59" in place of {time}).
// Like the Custom provider's (bridge/custom-notice-fit.test.mjs), they say the next step in plain words and none of them uses the Custom wording.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

const NOTICES = [
  'Google did not accept your Gemini key. Check it in Google AI Studio and add it again.',
  'Your free Gemini allowance for today is used up. It resets at {time}. Use Convai or Local AI.',
  'Your free Gemini allowance for today is used up. It resets tomorrow. Use Convai or Local AI.',
  'Google Gemini is rate limiting you. Wait a minute, then try again.',
  'Google Gemini is not available in your region. Use Convai or Local AI.',
  'Google Gemini is busy right now. Try again in a moment.',
  'Google Gemini could not be reached. Check your internet connection, then try again.',
  'The Gemini model is not available right now. Try again later or use Local AI.',
];
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);
// The widest time: English reads 12-hour clock times ("5:30 AM"; 10:44 AM is the widest of them in the game's font), the other languages 24-hour ("23:59").
const withTime = (text, english = true) => text.replace('{time}', english ? '10:44 AM' : '23:59');

test('each Gemini notice is one paragraph that fits two lines of the warning line, is in the game scripts, and does not use the Custom wording', () => {
  const lua = [read('../mod/init.lua'), read('../mod/custom-provider.lua'), read('../mod/phone-chat.lua')].join('\n');
  for (const text of NOTICES) {
    // The English sentence with a time of day takes two lines with room to spare, but the widest 12-hour time (1,464 px) is 4 px past the 1,460 px English budget:
    // it is held to the translations' 1,560 px budget, which still leaves 136 px for a word that wraps early.
    assert.deepEqual(noticeProblems(withTime(text), {english: !text.includes('{time}')}), [], text);
    assert.ok(lua.includes(text), `the game scripts do not hold: ${text}`);
    assert.ok(!/custom/i.test(text), text);
  }
});

for (const code of CODES) {
  test(`${code}: the Gemini notices are translated, keep {time}, and fit two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    for (const text of NOTICES) {
      const translated = rows.get(text);
      assert.ok(translated, `${code} has no translation of: ${text}`);
      assert.equal(translated.includes('{time}'), text.includes('{time}'), `${code}: {time} must be kept exactly where the English has it: ${text}`);
      assert.deepEqual(noticeProblems(withTime(translated, false)), [], `${code}: ${text}`);
      assert.ok(!/[—–;]|--/.test(translated), `${code}: a dash or a semicolon in: ${translated}`);
    }
  });
}
