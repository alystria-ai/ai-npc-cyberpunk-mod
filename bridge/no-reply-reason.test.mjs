// "No reply arrived. The conversation service may not be running." while Help showed the service active (2026-10-19 report). The 90 s
// timeout guessed: the service was up, and the turn had gone to a Local AI still loading its model, or to Convai in place of a Local AI that
// was not ready, or had never been taken. The bridge now names the turn and the provider that took it in its status, and the game reads it once,
// at the timeout, to say which (mod/service-status.lua noReplyMessage). And a Local AI that cannot start, with nobody to take its turns over,
// says so in its own words (init.lua keyReplyNotice: 'local-no-memory', 'local-unavailable') instead of the Convai daily limit.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(`../mod/${file}`, import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8')).strings;

function run(program) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

const TEXT = {
  notTaken: 'The conversation service did not get that message. Try again.',
  loading: 'Local AI is still loading its model. Try again in a moment.',
  slow: 'Local AI did not answer within {seconds} s. Try again, or choose a smaller model in Settings.',
  mismatch: 'Local AI is not ready, so Convai took that message and did not answer in time.',
  generic: 'No reply arrived within {seconds} s. Try again.',
};
const L = value => JSON.stringify(value);

// mod/service-status.lua with files from a table (decoded by a registry, as the other service-status fixtures do) and a ui.t that fills
// {name} placeholders, so the exact sentence the player reads is compared.
const serviceFixture = `
local registry, serial = {}, 0
files = {}
function put(path, value)
    if value == nil then files[path] = nil; return end
    serial = serial + 1; local key = 'json-' .. serial; registry[key] = value; files[path] = key
end
json = {decode = function(raw) return assert(registry[raw], 'unexpected JSON input ' .. tostring(raw)) end}
io = {open = function(path, mode)
    assert(mode == 'rb', 'status reads only')
    if files[path] == nil then return nil end
    return {read = function() return files[path] end, close = function() return true end}
end}
convaiUiLocale = {version = 1, t = function(text, params)
    if params then text = text:gsub('{(%w+)}', function(key) return tostring(params[key]) end) end
    return text
end}
dofile = function(path) error('unexpected dependency ' .. path) end
local status = (function() ${read('service-status.lua')} end)()
`;

test('every reason is a catalogued English UI key, written through ui.t', () => {
  const source = read('service-status.lua');
  for (const text of Object.values(TEXT)) {
    assert.equal(catalog[text], text, text);
    assert.ok(source.includes(`ui.t('${text}'`), `ui.t literal for ${text}`);
  }
});

test('the service never took the turn: its status names another request, or none (lost or replaced before it was read)', () => run(`${serviceFixture}
  put('runtime/bridge-status.json', {state = 'thinking', detail = 'Judy', requestId = 'older-1', provider = 'local', updated = 1})
  assert(status.noReplyMessage('new-2', {provider = 'local', localAi = 'warming'}, 90) == ${L(TEXT.notTaken)})
  put('runtime/bridge-status.json', {state = 'waiting', detail = '', updated = 1})
  assert(status.noReplyMessage('new-2', {}, 90) == ${L(TEXT.notTaken)}, 'a status of the service start names no turn')
`));

test('Local AI took the turn: still loading its model, or loaded and too slow', () => run(`${serviceFixture}
  put('runtime/bridge-status.json', {state = 'thinking', detail = 'Judy', requestId = 'r-1', provider = 'local', updated = 1})
  assert(status.noReplyMessage('r-1', {provider = 'local', effective = 'local', localAi = 'warming'}, 90) == ${L(TEXT.loading)})
  assert(status.noReplyMessage('r-1', {provider = 'local', effective = 'local', localAi = 'ready'}, 90) == ${L(TEXT.slow.replace('{seconds}', '90'))})
  assert(status.noReplyMessage('r-1', nil, 90) == ${L(TEXT.slow.replace('{seconds}', '90'))}, 'no provider status: the loaded case')
`));

test('Convai took the turn while the setting is Local AI (it was not ready): a provider mismatch, said as such', () => run(`${serviceFixture}
  put('runtime/bridge-status.json', {state = 'thinking', detail = 'Judy', requestId = 'r-1', provider = 'convai', updated = 1})
  assert(status.noReplyMessage('r-1', {provider = 'local', effective = 'convai', localAi = 'no-memory'}, 90) == ${L(TEXT.mismatch)})
  -- Convai chosen, or Mistral: no mismatch, the plain sentence with the wait.
  assert(status.noReplyMessage('r-1', {provider = 'convai', effective = 'convai'}, 90) == ${L(TEXT.generic.replace('{seconds}', '90'))})
  put('runtime/bridge-status.json', {state = 'thinking', detail = 'Judy', requestId = 'r-1', provider = 'mistral', updated = 1})
  assert(status.noReplyMessage('r-1', {provider = 'mistral', effective = 'mistral'}, 90) == ${L(TEXT.generic.replace('{seconds}', '90'))})
`));

test('the service finished the turn (ready, error) but no reply was read: the plain sentence; nothing known: nil, and the caller keeps its own', () => run(`${serviceFixture}
  put('runtime/bridge-status.json', {state = 'ready', detail = 'Judy', requestId = 'r-1', updated = 1})
  assert(status.noReplyMessage('r-1', {provider = 'local', localAi = 'warming'}, 90) == ${L(TEXT.generic.replace('{seconds}', '90'))})
  put('runtime/bridge-status.json', {state = 'error', detail = 'boom', requestId = 'r-1', updated = 1})
  assert(status.noReplyMessage('r-1', {}, 90) == ${L(TEXT.generic.replace('{seconds}', '90'))})
  put('runtime/bridge-status.json', nil)
  assert(status.noReplyMessage('r-1', {}, 90) == nil, 'no status file')
  put('runtime/bridge-status.json', {state = 'thinking', requestId = 'r-1', provider = 'local'})
  assert(status.noReplyMessage(nil, {}, 90) == nil and status.noReplyMessage('', {}, 90) == nil, 'no request id')
`));

test('init.lua asks for the reason at the 90 s timeout only when the service texts say nothing, and keeps its old sentence when nothing is known', () => {
  const init = read('init.lua').replace(/\r\n/g, '\n');
  const at = init.indexOf("gameplayActions.revoke('reply-timeout', expired.requestId)");
  const block = init.slice(at, at + 1400);
  assert.match(block, /local explained = serviceLost or serviceCall\('blockedMessage', os\.time\(\)\)\n(\s*--[^\n]*\n)+\s*if not explained then\n\s*local stateOk, providerState = pcall\(manager\.mistral\)\n\s*explained = serviceCall\('noReplyMessage', expired\.requestId, stateOk and providerState or nil, 90\)\n\s*end\n\s*convaiNotices\.send\(player, 'conversation-timeout', explained or ui\.t\('No reply arrived\. The conversation service may not be running\.'\)\)/);
});

const LOCAL = {
  'local-no-memory': 'Not enough free graphics memory to start Local AI. Try a smaller model in Settings.',
  'local-unavailable': 'Local AI could not start. Check Local AI in Settings > Conversation provider.',
};
const BROWSER_FAILED = 'The browser for the conversation page would not start. Try again, or use another Chromium browser.';
test('a browser that would not start: its own words in the game and on the phone, the detail after them, never for an automatic reaction', () => {
  const init = read('init.lua').replace(/\r\n/g, '\n');
  const start = init.indexOf('local function keyNoticeText'), end = init.indexOf('local function reactionCanDeliver');
  assert.ok(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text, params) return text end}
    local function dailyLimitText() return 'x' end
    convaiNotices = {send = function() return true end}
    ${init.slice(start, end)}
    local id, words = keyReplyNotice({errorCode = 'browser-failed', error = 'x', errorDetail = 'Brave was found but would not start: Target closed'})
    assert(id == 'browser-failed', tostring(id))
    assert(words == ${L(BROWSER_FAILED)} .. '\\n(Brave was found but would not start: Target closed)', words)
    local _, bare = keyReplyNotice({errorCode = 'browser-failed', error = 'x'})
    assert(bare == ${L(BROWSER_FAILED)}, 'no detail, no brackets')
    assert(keyReplyNotice({keyNotice = 'browser-failed', text = 'Hello'}) == nil, 'not a key notice')
  `);
  assert.match(init, /keyId == 'browser-failed' then\n\s+if not pending\.reaction then convaiNotices\.send\(player, 'browser-failed', keyText\) end/);
  assert.match(read('notices.lua'), /\['browser-failed'\] = \{class = PLAYER, repeatS = 60\}/);
  assert.ok(read('phone-chat.lua').replace(/\r\n/g, '\n').includes(`['browser-failed'] = '${BROWSER_FAILED}',`));
  assert.ok(read('phone-chat-style.lua').includes(`['${BROWSER_FAILED}'] = true`));
});

test('the two Local AI failures: their own words in the game and on the phone, sent under their own ids, never for an automatic reaction', () => {
  const init = read('init.lua').replace(/\r\n/g, '\n');
  const start = init.indexOf('local function keyNoticeText'), end = init.indexOf('local function reactionCanDeliver');
  assert.ok(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text, params) if params then text = text:gsub('{(%w+)}', function(key) return tostring(params[key]) end) end return text end}
    local function dailyLimitText() return 'Today’s Convai turns are used.' end
    convaiNotices = {send = function() return true end}
    ${init.slice(start, end)}
    for code, text in pairs({${Object.entries(LOCAL).map(([code, text]) => `['${code}'] = ${L(text)}`).join(', ')}}) do
      local id, words = keyReplyNotice({errorCode = code, error = 'x'})
      assert(id == code and words == text, code .. ': ' .. tostring(words))
      assert(keyReplyNotice({keyNotice = code, text = 'Hello'}) == nil, code .. ' is not a key notice')
    end
    -- An older bridge's local-fallback (it said a cloud provider is used) reads as Local AI's own sentence, under the local-unavailable id; there is no per-turn
    -- cloud notice any more. The Convai limit keeps its own notice.
    local id1, words1 = keyReplyNotice({errorCode = 'local-fallback', error = 'x'})
    assert(id1 == 'local-unavailable' and words1 == ${L(LOCAL['local-unavailable'])}, tostring(id1) .. ': ' .. tostring(words1))
    local id2, words2 = keyReplyNotice({keyNotice = 'local-fallback', text = 'Hello'})
    assert(id2 == 'local-unavailable' and words2 == ${L(LOCAL['local-unavailable'])}, tostring(id2))
    assert(keyReplyNotice({keyNotice = 'local-turn-fallback', text = 'Hello'}) == nil)
    assert(keyReplyNotice({errorCode = 'daily-limit', error = 'x'}) == 'daily-limit')
  `);
  assert.doesNotMatch(read('notices.lua'), /\['local-(turn-)?fallback'\] =/, 'no catalog entry for a cloud hand-over');
  assert.ok(read('phone-chat.lua').replace(/\r\n/g, '\n').includes(`['local-fallback'] = '${LOCAL['local-unavailable']}',`), 'an older bridge\'s code reads the same on the phone');
  assert.doesNotMatch(init, /a cloud provider is used|so a cloud provider did/, 'no sentence in the game says a cloud provider takes over');
  for (const code of Object.keys(LOCAL)) {
    assert.match(init, new RegExp(`keyId == '${code}' then\\n\\s+if not pending\\.reaction then convaiNotices\\.send\\(player, '${code}', keyText\\) end`), `${code}: not skipped for an automatic reaction`);
    assert.match(read('notices.lua'), new RegExp(`\\['${code}'\\] = \\{class = PLAYER, repeatS = 30\\}`), `${code}: catalog entry`);
    const chat = read('phone-chat.lua').replace(/\r\n/g, '\n');
    assert.ok(chat.includes(`['${code}'] = '${LOCAL[code]}',`), `${code}: Phone Chat status`);
    assert.ok(read('phone-chat-style.lua').includes(`['${LOCAL[code]}'] = true`), `${code}: Phone Chat status is translated`);
  }
});
