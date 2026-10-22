// The notices that say why a turn got no reply (2026-10-19 report: Local AI saved, the first turn showed the Convai daily limit, and later turns
// said the service "may not be running" while it was up) fit the game's warning line: two lines of upper-case text, in English and in all
// fifteen translations (bridge/notice-fit.mjs measures; it estimates, it cannot see the game). The sources are the game scripts that show them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

// [text, the scripts that hold it]. {seconds} is shown as the game's 90.
const NOTICES = [
  ['Local AI could not start. Check Local AI in Settings > Conversation provider.', ['init.lua', 'phone-chat.lua']],
  ['Not enough free graphics memory to start Local AI. Try a smaller model in Settings.', ['init.lua', 'phone-chat.lua']],
  ['Local AI runs mostly on your processor here, so replies will be slow.', ['init.lua']],   // 'local-cpu': a model mostly on the processor; the bridge's few words after it are data
  ['The yellow border is Windows showing a capture. Choose Mistral or Local AI to stop it.', ['init.lua']],   // 'vision-border': Windows' capture border around the game (Companions can see, Convai)
  ['Local AI is still loading its model. Try again in a moment.', ['service-status.lua']],
  ['Local AI did not answer within {seconds} s. Try again, or choose a smaller model in Settings.', ['service-status.lua']],
  ['Local AI is not ready, so Convai took that message and did not answer in time.', ['service-status.lua']],
  ['No reply arrived within {seconds} s. Try again.', ['service-status.lua']],
  ['The conversation service did not get that message. Try again.', ['service-status.lua']],
];
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);
const shown = text => text.replace('{seconds}', '90');

test('each notice is one paragraph that fits two lines of the warning line, and the scripts that show it hold it', () => {
  for (const [text, files] of NOTICES) {
    assert.deepEqual(noticeProblems(shown(text), {english: true}), [], text);
    for (const file of files) assert.ok(read(`../mod/${file}`).includes(text), `mod/${file} does not hold: ${text}`);
  }
});

for (const code of CODES) {
  test(`${code}: the notices are translated and fit two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    for (const [text] of NOTICES) {
      const translated = rows.get(text);
      assert.ok(translated, `${code} has no translation of: ${text}`);
      assert.notEqual(translated, text, `${code} copies the English: ${text}`);
      assert.equal(translated.includes('{seconds}'), text.includes('{seconds}'), `${code}: {seconds} in ${text}`);
      assert.deepEqual(noticeProblems(shown(translated)), [], `${code}: ${text}`);
    }
  });
}
