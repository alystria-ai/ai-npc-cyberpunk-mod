// The notice of a voice that is off because the Runtime base is older than the Scripts need (mod/manager.lua takeVoiceFallbackNotice, reason 'runtime-old',
// bridge/runtime-base.mjs, docs/NOTIFICATIONS.md) fits the game's warning line: two lines of upper-case text, in English and in all fifteen translations. It names the Full file
// and nothing else to do: no batch file, no antivirus advice.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noticeProblems} from './notice-fit.mjs';

export const NOTICE = 'The Runtime is too old for voices. Install the Full file from Nexus Mods.';
const CODES = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const unescape = text => text.replace(/\\(["\\n])/g, (_, char) => char === 'n' ? '\n' : char);

test('the English sentence fits two lines, is the one the notice, the catalogue and the notification list hold, and gives no batch file or antivirus advice', () => {
  assert.deepEqual(noticeProblems(NOTICE, {english: true}), []);
  assert.ok(read('../mod/manager.lua').includes(`ui.t('${NOTICE}')`), 'mod/manager.lua does not hold the notice');
  assert.ok(read('../docs/NOTIFICATIONS.md').includes(NOTICE), 'docs/NOTIFICATIONS.md does not list the notice');
  assert.ok(read('../localization/en.json').includes(`"${NOTICE}"`), 'localization/en.json does not hold the sentence');
  assert.equal(NOTICE.includes(';'), false);
  assert.ok(!/\.bat|antivirus|exception|Smart App Control/i.test(NOTICE));
});

for (const code of CODES) {
  test(`${code}: the sentence is translated, names Nexus Mods, and fits two lines`, () => {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(NOTICE);
    assert.ok(translated, `${code} has no translation of the sentence`);
    assert.notEqual(translated, NOTICE, `${code}: not translated`);
    assert.ok(translated.includes('Nexus Mods'), `${code}: Nexus Mods is lost: ${translated}`);
    assert.deepEqual(noticeProblems(translated), [], `${code}: ${translated}`);
  });
}

// The Help row of a Local AI that did not start for want of free system memory (mod/setup-check.lua, cause 'low-ram', 0.4.0 reports 014a3be6 and 316c6d2b) is in every language.
export const LOW_RAM_ROW = 'Not enough free system memory to start Local AI. Close other programs, try a smaller model in Settings, or use the Custom provider.';
test('the low-RAM Local AI Help row is in the Lua check, the catalogue and all fifteen locales, translated and keeping the name Local AI', () => {
  assert.ok(read('../mod/setup-check.lua').includes(`ui.t('${LOW_RAM_ROW}')`));
  assert.ok(read('../localization/en.json').includes(`"${LOW_RAM_ROW}"`));
  assert.equal(LOW_RAM_ROW.includes(';'), false);
  for (const code of CODES) {
    const rows = new Map([...read(`../mod/locales/${code}.lua`).matchAll(/^\s*\["(.*)"\] = "(.*)",\r?$/gmu)].map(([, key, value]) => [unescape(key), unescape(value)]));
    const translated = rows.get(LOW_RAM_ROW);
    assert.ok(translated && translated !== LOW_RAM_ROW, `${code}: not translated`);
    assert.ok(translated.includes('Local AI'), `${code}: the name Local AI is lost: ${translated}`);
    assert.ok(!/[;—–]|--/.test(translated), `${code}: a dash or semicolon: ${translated}`);
  }
});
