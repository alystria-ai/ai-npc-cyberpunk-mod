// The failure sentences the bridge writes into reply files (error: '...') reach the player through the game's notices and Phone Chat. They are English in the
// bridge, so each must be in the UI catalogue, in all 15 menu languages, and mapped to its ui.t sentence on the Lua side (mod/init.lua replyErrorText for the
// notices, the phone status whitelist of mod/phone-chat-style.lua for Phone Chat). A new generic failure sentence in the bridge fails here until it is added.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const catalog = JSON.parse(read('../localization/en.json')).strings;
const codes = readdirSync(new URL('../mod/locales/', import.meta.url)).filter(name => name.endsWith('.lua')).map(name => name.slice(0, -4));
const initLua = read('../mod/init.lua'), phoneStyle = read('../mod/phone-chat-style.lua');

// The sentences of `error: '...'` (single quotes) and error: `...` (templates; ${...} read as {name}) that are whole sentences: a space and a full stop.
function replyErrors(file) {
  const found = [];
  for (const match of read(file).matchAll(/\berror: (?:'((?:[^'\\\n]|\\.)*)'|`([^`\n]*)`)/g)) {
    const text = (match[1] ?? match[2]).replace(/\\'/g, "'").replace(/\$\{[^}]*\}/g, '{name}');
    if (/ /.test(text) && /\.$/.test(text)) found.push(text);
  }
  return found;
}
const localeHas = (code, key) => read(`../mod/locales/${code}.lua`).includes(`[${JSON.stringify(key)}] =`) || read(`../mod/locales/${code}.lua`).includes(`["${key.replace(/"/g, '\\"')}"] =`);

const converse = replyErrors('./convai-bridge.mjs'), phone = replyErrors('./phone-chat.mjs');

test('the bridge words its reply failures as whole sentences, and finds them', () => {
  assert(converse.includes('The conversation service could not reply. Please try again.'), converse.join('\n'));
  assert(converse.includes('Voice conversation failed. Check your microphone and try again.'));
  assert(phone.includes('Message could not be delivered. Please try again.'));
});

test('every failure sentence the bridge sends is in the catalogue and in all 15 languages', () => {
  for (const text of [...converse, ...phone]) {
    assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
    for (const code of codes) assert(localeHas(code, text), `${code} has no translation of: ${text}`);
  }
});

test('the game translates each one before showing it', () => {
  const body = /local function replyErrorText\(reply\)([\s\S]*?)\nend\n/.exec(initLua);
  assert(body, 'replyErrorText moved');
  for (const text of converse) {
    // a sentence with a name in it is mapped by its tail: the Lua keeps the template as the catalogue has it
    const template = text.includes('{name}') ? text : text;
    assert(body[1].includes(`ui.t('${template.replace(/'/g, "\\'")}'`), `replyErrorText does not translate: ${text}`);
  }
  // the notices read the text through it
  assert((initLua.match(/convaiNotices\.send\(player, 'reply-error', replyErrorText\(reply\)\)/g) ?? []).length === 2);
  assert(!/convaiNotices\.send\(player, 'reply-error', reply\.error\)/.test(initLua), 'a raw reply.error is still shown');
  for (const text of phone) assert(phoneStyle.includes(`['${text}'] = true`), `the phone whitelist lacks: ${text}`);
  // the two Local AI sentences of a server that only thinks or has too small a context are shown in Phone Chat in the menu language too
  for (const text of ["Your model only thought and didn't answer. Turn thinking off for it in your model server, or pick a non-thinking model.",
    "Your model server's context is too small for this character. Raise the context length in your server (8192 or more)."]) {
    assert(phoneStyle.includes(`["${text}"] = true`), `the phone whitelist lacks: ${text}`);
  }
});

test('a phone contact that cannot be invited says why in the menu language', () => {
  for (const text of ['This contact has no companion mapping yet.', 'Character unavailable in this game installation.']) {
    assert(initLua.includes(`ui.t('${text}')`), text);
    assert.equal(catalog[text], text);
    for (const code of codes) assert(localeHas(code, text), `${code}: ${text}`);
  }
  assert(initLua.includes("convaiNotices.send(player, 'phone-unavailable', phoneReasonText(reason))"));
});
