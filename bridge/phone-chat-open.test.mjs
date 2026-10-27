import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Opening a chat from the Chat list (docs/PHONE_CHAT.md, "Opening a chat"): the press that opens it must not be lost, and the redscript's account of
// the opening reaches the probe log. The game is not available offline: static checks of the redscript, and the Lua side against strict fakes.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const text = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const strip = source => source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const tabs = strip(text('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds'));
const chat = strip(text('../r6/scripts/CyberpunkConvai/PhoneChat.reds'));

test('a press on a Chat row opens the chat even when the tab state was reset, and a lost first press is retried by the next one', () => {
  const open = /private final func ConvaiOpenChat\(contact: wref<ContactData>, opt fromKey: Bool\) -> Void \{([^]*?)\n\}\n/.exec(tabs)[1];
  // Not ours: nothing, and no trace.
  assert.match(open, /^\s*if !IsDefined\(contact\) \|\| !contact\.convaiChat \{ return; \};/);
  // The state Off with a Chat row selected is put back to the list before the press is judged.
  assert.match(open, /if Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \{[^]*?this\.m_convaiChatState = ConvaiPhoneChatState\.List;\s*\};/);
  // A key press a second after an opening that never reported ready starts it again; a release or a quick second press does not.
  assert.match(open, /Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Opening\) && fromKey && now - this\.m_convaiChatOpenedAt >= 1\.0 \{[^]*?this\.m_convaiChatState = ConvaiPhoneChatState\.List;/);
  assert.match(open, /this\.m_convaiChatState = ConvaiPhoneChatState\.Opening;\s*this\.m_convaiChatOpenedAt = now;\s*this\.m_convaiChatGeneration \+= 1u;/);
  // The two key entry points pass fromKey and also catch a reset state; the pointer entry (a click release) does not.
  assert.match(tabs, /public func AcceptAction\(\) -> Void \{\s*if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \|\| this\.ConvaiSelectedIsChatRow\(\) \{\s*this\.ConvaiOpenChat\(this\.m_contactListLogicController\.GetSelectedContactData\(\), true\);/);
  assert.match(tabs, /public func AlternativeAcceptAction\(\) -> Void \{\s*if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Off\) \|\| this\.ConvaiSelectedIsChatRow\(\) \{\s*this\.ConvaiOpenChat\(this\.m_contactListLogicController\.GetSelectedContactData\(\), true\);/);
  assert.match(tabs, /private cb func OnConvaiPhoneChatOpen\(evt: ref<ConvaiPhoneChatOpenEvent>\) -> Bool \{\s*this\.ConvaiOpenChat\(evt\.contact\);/);
  // The game's own Contacts and Messages tabs are untouched: a row that is not ours falls through to the game's action.
  assert.match(tabs, /private final func ConvaiSelectedIsChatRow\(\) -> Bool \{[^]*?return IsDefined\(selected\) && selected\.convaiChat;/);
  assert.match(tabs, /public func AcceptAction\(\) -> Void \{[^]*?\};\s*wrappedMethod\(\);\s*\}/);
});

test('every step of opening a chat is traced, once, when it happens: the press, ready or not wanted, the page, the focus, the close', () => {
  for (const step of ['open: contact=', 'open ignored: the page is already open', 'open ignored: not a registered contact', 'page ready but not wanted', 'page closed, back on the list']) {
    assert.ok(tabs.includes(step), step);
  }
  for (const step of ['page focused contact=', 'autofocus asked contact=', 'autofocus skipped contact=']) assert.ok(chat.includes(step), step);
  // The trace is bounded and drained a line at a time; nothing is written per frame.
  assert.match(chat, /public final func ConvaiPhoneChatTrace\(line: String\) -> Void \{\s*if ArraySize\(this\.m_convaiChatTrace\) < 16 \{ ArrayPush\(this\.m_convaiChatTrace, line\); \};/);
  assert.match(chat, /public final func ConvaiPhoneChatTakeTrace\(\) -> String \{\s*if ArraySize\(this\.m_convaiChatTrace\) == 0 \{ return ""; \};/);
});

test('Lua: the lines of the opening reach the log on the 10 Hz tick; scripts without the method are asked once', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const source = text('../mod/phone-chat.lua');
  const program = `
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    io.open = function(path, mode) if mode == 'rb' then return nil end return {write = function() return true end, close = function() return true end} end
    os.rename, os.remove = function() return true end, function() return true end
    NewObject = function() return {} end
    os.time = function() return 100 end
    local chat = (function() ${source} end)()
    chat.configure({{key = 'judy-alvarez', name = 'Judy Alvarez', kind = 'named'}}, {profileEnabled = function() return true end},
      {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    local lines, queue, asked = {}, {'open: contact=adam-smasher journal=no path=spawn', 'page focused contact=adam-smasher'}, 0
    chat.trace = function(line) lines[#lines + 1] = line end
    local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end,
      ConvaiPhoneChatTakeTrace = function() asked = asked + 1; return table.remove(queue, 1) or '' end}
    local function frames() for _ = 1, 8 do chat.update(player, 0) end end
    frames()
    assert(lines[1] == 'open: contact=adam-smasher journal=no path=spawn' and lines[2] == 'page focused contact=adam-smasher' and #lines == 2, #lines)
    local before = asked
    frames()
    assert(#lines == 2 and asked > before, 'an empty queue costs one call per tick and logs nothing')
    -- Scripts without the method: asked once, then never again, and nothing breaks.
    player.ConvaiPhoneChatTakeTrace = nil
    chat.traceMissing = nil
    frames()
    assert(chat.traceMissing == true)
    frames(); assert(#lines == 2)
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
});

test('init.lua logs the lines as "Phone chat: ..." with a session cap and no new local in the main chunk', () => {
  const init = text('../mod/init.lua');
  assert.match(init, /phoneChat\.traced = 0\nphoneChat\.trace = function\(line\)\n\s*if phoneChat\.traced >= 120 then return end\n\s*phoneChat\.traced = phoneChat\.traced \+ 1\n\s*log\('Phone chat: ' \.\. tostring\(line\)\)\nend/);
});
