// The talk text box (owner 31 Oct 2026, live test of 0.10.9): Enter must send, as before the click-out work of f69c4d55. That work is reverted: no click
// handler, no park, no safety net. What stays new is a draft: words typed and not sent (Esc, the game closing the box) are put back into the next box
// of the same character within a few minutes, and another character gets an empty box. No notice. Composer.reds is compiled in the game's compiler
// (scripts/Compile-Redscript.ps1); here its text is checked and the Lua halves run.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const reds = read('../r6/scripts/CyberpunkConvai/Composer.reds');
const composerSource = read('../mod/composer-input.lua');
const initSource = read('../mod/init.lua');

function runLua(program) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

const composerFixture = `
local names = {}
CName = {new = function(s) if not names[s] then names[s] = {} end; return names[s] end}
textLetterCase = {OriginalCase = 3}
local observers = {}
ObserveAfter = function(class, method, fn) observers[class .. '.' .. method] = fn end
local drafts = {}
Game = {GetPlayer = function() return {ConvaiTakeDraft = function() local text = drafts[1] or ''; drafts = {}; return text end} end}
local texts = {}
local function box(data)
  local input = {SetDefaultText = function() end, GetDefaultText = function() return '' end,
    SetLetterCase = function() end, GetLetterCase = function() return 3 end, SetText = function(_, value) texts[#texts + 1] = value end}
  return {m_textInput = input, GetRootWidget = function() return {GetUserData = function() return data end} end}
end
local talk = {title = 'TALK TO JUDY', message = 'Type your message to the character.'}
local search = {title = 'Search characters', message = 'Type part of a name.'}
local m = (function() ${composerSource} end)()
`;

test('the kept words are put into the box the talk key opens next: once, only in a talk box, never over a draft the player typed', () => runLua(composerFixture + `
  drafts = {'hello there'}
  m.restoreDraft = true
  m.apply(box(talk))
  assert(#texts == 1 and texts[1] == 'hello there' and m.restoreDraft == nil, 'restored once')
  m.apply(box(talk))                      -- a locale refresh applies the box again: the text is not replaced
  assert(#texts == 1, 'not again')
  drafts = {'kept'}; m.restoreDraft = true
  m.apply(box(search))                    -- a search box never takes talk words
  assert(#texts == 1 and m.restoreDraft == true)
  m.apply(box({title = 'Other mod', message = 'x'}))
  assert(#texts == 1)
  drafts = {''}; m.apply(box(talk))       -- flag set but nothing kept: nothing written
  assert(#texts == 1)
  m.restoreDraft = nil
`));

test('the box has no click handler, no park and no safety net any more: Enter is the game\'s own confirm again', () => {
  assert.doesNotMatch(reds, /OnHandlePressInput|ConvaiParkRequest|ConvaiClickInsideDialog|m_convaiParkRequested|ConvaiForgetComposer/);
  assert.doesNotMatch(composerSource, /orphaned|GONE_GRACE|goneAt|shownAt|OnUninitialize/);
  assert.doesNotMatch(initSource, /convaiComposerWatch\.(parked|orphan)|talk-draft|\.expect\(os\.clock/);
  assert.doesNotMatch(read('../mod/notices.lua'), /talk-draft/);
  // the only ObserveAfter of the box is the one that dresses it
  assert.equal((composerSource.match(/ObserveAfter\(/g) || []).length, 1);
});

test('Composer.reds: Enter with words sends and empties the draft, Esc or the game closing the box keeps the typed words, a search box never touches them', () => {
  const closed = reds.slice(reds.indexOf('protected cb func OnConvaiComposerClosed'), reds.indexOf('// Without Codeware'));
  const search = closed.slice(0, closed.indexOf('if !IsDefined(result)'));
  assert.doesNotMatch(search, /m_convaiDraft/, 'a search box returns before the draft');
  assert.match(closed, /Equals\(result\.result, GenericMessageNotificationResult\.Confirm\) \{\n\s+this\.m_convaiDraft = "";\n\s+if StrLen\(result\.input\) > 0 \{\n\s+this\.m_convaiSubmittedText = result\.input;/);
  assert.match(closed, /\} else \{\n\s+\/\/[^\n]*\n\s+this\.m_convaiDraft = result\.input;\n\s+this\.m_convaiCloseInfo = "closed:"/);
  // the words are handed over once
  assert.match(reds, /ConvaiTakeDraft\(\) -> String \{\n\s+let text = this\.m_convaiDraft;\n\s+this\.m_convaiDraft = "";/);
  // opening a box never empties the draft (the next box shows it)
  const open = reds.slice(reds.indexOf('func ConvaiOpenComposer(characterName: String) -> Bool {'), reds.indexOf('func ConvaiOpenSearchBox() -> Bool {'));
  assert.doesNotMatch(open, /m_convaiDraft/);
});

const watchSource = () => {
  const from = initSource.indexOf('convaiComposerWatch = {}');
  const to = initSource.indexOf('-- The scripts refused to open the text box');
  assert.ok(from > 0 && to > from, 'markers');
  return initSource.slice(from, to);
};
const watchFixture = () => `
  local logs, sent = {}, {}
  local function log(line) logs[#logs + 1] = line end
  local ui = {t = function(text) return text end}
  convaiNotices = {send = function(_, id, text) sent[#sent + 1] = {id = id, text = text}; return true end}
  local clock = 10
  os.clock = function() return clock end
  local cleared, kept, info, held, moves = 0, '', 'closed:0', false, 0
  local player = {ConvaiDraftText = function() return kept end, ConvaiClearDraft = function() cleared = cleared + 1 end,
    ConvaiComposerClosedInfo = function() return info end, ConvaiMoveHeld = function() return held end, ConvaiMoveEvents = function() return moves end}
  function convaiPlayer() return player end
  convaiComposerInput = {}
  ${watchSource()}
`;

test('draft rules: Esc keeps the words for the same character and chat within five minutes, another character or chat gets an empty box, a send or an empty Enter keeps nothing, no notice ever', () => runLua(watchFixture() + `
  local judy = {generation = 4, profileKey = 'judy', name = 'Judy'}
  -- Esc with words
  kept, info = 'hello there', 'closed:0'
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.draft and convaiComposerWatch.draft.key == 'judy')
  assert(#sent == 0, 'no "message kept" notice')
  clock = 100
  assert(convaiComposerWatch.takeDraft(player, 'judy', false) == true and convaiComposerInput.restoreDraft == true and cleared == 0)
  assert(convaiComposerWatch.draft == nil, 'once')
  -- the game closing the box (any other closed:n) keeps them too
  kept, info = 'again', 'closed:2'
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.takeDraft(player, 'judy', false) == true)
  -- another character: dropped and cleared in the scripts
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.takeDraft(player, 'panam', false) == false and convaiComposerInput.restoreDraft == nil and cleared == 1)
  -- the same character in a group chat: dropped
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.takeDraft(player, 'judy', true) == false and cleared == 2)
  -- too old
  convaiComposerWatch.closed(player, judy)
  clock = clock + convaiComposerWatch.KEEP_S + 1
  assert(convaiComposerWatch.takeDraft(player, 'judy', false) == false and cleared == 3)
  -- a group box is kept for the same group chat
  convaiComposerWatch.closed(player, {generation = 5, profileKey = 'judy', name = 'Judy', participants = {}})
  assert(convaiComposerWatch.takeDraft(player, 'judy', true) == true)
  -- Esc on an empty box keeps nothing
  kept, info = '', 'closed:0'
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.draft == nil)
  -- Enter on an empty box (a lost message, as before) and a close without a result keep nothing, and still say the message was not sent
  kept, info = 'words', 'empty'
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.draft == nil and #sent == 1 and sent[1].id == 'message-lost')
  info = 'nodata'
  convaiComposerWatch.closed(player, judy)
  assert(convaiComposerWatch.draft == nil and #sent == 2)
  -- no draft at all: a box that opens clears whatever the scripts still hold
  assert(convaiComposerWatch.takeDraft(player, 'judy', false) == false)
  for _, line in ipairs(logs) do assert(not line:find('parked'), line) end
`));

test('movement evidence: the close line says what the movement axes read and how many movement events arrived while the box was up', () => runLua(watchFixture() + `
  moves = 40
  convaiComposerWatch.opened(7)
  assert(convaiComposerWatch.moveEventsAtOpen == 40)
  moves, held = 46, true
  info, kept = 'closed:0', ''
  convaiComposerWatch.closed(player, {generation = 7, profileKey = 'judy', name = 'Judy'})
  local line = logs[#logs]
  assert(line:find('moveAxis=held', 1, true) and line:find('moveEvents=6', 1, true), line)
  assert(convaiComposerWatch.moveEvidence(player):find('moveAxis=held', 1, true))
  -- scripts without the tracker: n/a, never an error
  player.ConvaiMoveHeld, player.ConvaiMoveEvents = nil, nil
  local text = convaiComposerWatch.moveEvidence(player)
  assert(text:find('moveAxis=n/a', 1, true) and text:find('moveEvents=n/a', 1, true), text)
`));

test('the open path asks for the draft right after the box opens, and the send path logs the movement evidence', () => {
  assert.match(initSource, /player:ConvaiOpenComposer\(name\)[^]*?convaiComposerWatch\.takeDraft\(player, key, participants ~= nil\)/);
  assert.match(initSource, /'Native input captured: generation=' \.\. context\.generation \.\. ' bytes=' \.\. #message \.\. convaiComposerWatch\.moveEvidence\(player\)/);
  assert.match(initSource, /if result == 'empty' or result == 'nodata' then convaiComposerWatch\.notify\(player\) end/, 'only an empty or unreadable close is a lost message');
});
