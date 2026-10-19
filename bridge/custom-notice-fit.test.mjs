// The seven notices of the custom (OpenAI-compatible) provider (mod/custom-provider.lua, docs/NOTIFICATIONS.md) fit the game's warning line:
// two lines of upper-case text, in English and in all fifteen translations (bridge/notice-fit.mjs measures; it estimates, it cannot see the game).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

const NOTICES = [
  'The custom provider did not accept your key. Check it in Settings > Conversation provider.',
  'The custom provider says your account is out of credits. Add credits there, then try again.',
  'The custom provider does not know that model ID. Check it in Settings.',
  'The custom provider is rate limiting you. Try again in a moment.',
  'The custom provider did not answer. Check its address in Settings, or try again.',
  'The custom provider is not set up, so Convai is used. Add its URL and model ID in Settings.',
  'Custom provider replies are spoken by a local voice instead of the Convai cloud voice.',
];
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('each notice is one paragraph that fits two lines of the warning line, and the sources are the ones the game shows', () => {
  const lua = [read('../mod/init.lua'), read('../mod/custom-provider.lua'), read('../mod/phone-chat.lua')].join('\n');
  for (const text of NOTICES) {
    assert.deepEqual(noticeProblems(text, {english: true}), [], text);
    assert.ok(lua.includes(text), `the game scripts do not hold: ${text}`);
  }
});

for (const code of CODES) {
  test(`${code}: the seven notices are translated and fit two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    for (const text of NOTICES) {
      const translated = rows.get(text);
      assert.ok(translated, `${code} has no translation of: ${text}`);
      assert.deepEqual(noticeProblems(translated), [], `${code}: ${text}`);
    }
  });
}

// The notices the custom provider added for a daily limit and for a model that spends its reply on thinking (docs/CUSTOM_PROVIDER.md). The one with a reset time is measured
// with the widest clock time ("23:59" in place of {time}).
const MORE_NOTICES = [
  'The free daily limit for this model was reached. It resets at {time}.',
  'The free daily limit for this model was reached. Try again after it resets.',
  'This model spends its reply on thinking. Choose a non-reasoning model in Settings.',
];
const withTime = text => text.replace('{time}', '23:59');

test('the daily-limit and thinking-model notices are one paragraph each, fit two lines in English, and are in the game scripts', () => {
  const lua = [read('../mod/init.lua'), read('../mod/custom-provider.lua'), read('../mod/phone-chat.lua')].join('\n');
  for (const text of MORE_NOTICES) {
    assert.deepEqual(noticeProblems(withTime(text), {english: true}), [], text);
    assert.ok(lua.includes(text), `the game scripts do not hold: ${text}`);
  }
});

for (const code of CODES) {
  test(`${code}: the daily-limit and thinking-model notices are translated, keep {time}, and fit two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    for (const text of MORE_NOTICES) {
      const translated = rows.get(text);
      assert.ok(translated, `${code} has no translation of: ${text}`);
      assert.equal(translated.includes('{time}'), text.includes('{time}'), `${code}: {time} in: ${text}`);
      assert.deepEqual(noticeProblems(withTime(translated)), [], `${code}: ${text}`);
    }
  });
}
