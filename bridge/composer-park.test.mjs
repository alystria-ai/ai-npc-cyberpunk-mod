// Leaving the talk text box (owner 31 Oct 2026, a player on 0.4.0: "I open the text box, type a message, want to leave, and I am frozen in place but everything
// around me is still moving"). Codeware's handler only takes the typing focus off the text field when the mouse is clicked outside the dialog and leaves the box
// up, and the box keeps holding V. Now such a click parks the box: the native box is closed at once (the game's own close path gives V back, cursor and all), the
// words are kept, V can walk and look, and the talk key opens the box again with the words in it. A safety net lets go of a box the game no longer shows.
// Composer.reds is compiled in the game's compiler (scripts/Compile-Redscript.ps1); here its text is checked and the Lua halves run.
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
local clock = 100
os.clock = function() return clock end
local texts = {}
local function box(data, withInput)
  local input = withInput == false and nil or {SetDefaultText = function() end, GetDefaultText = function() return '' end,
    SetLetterCase = function() end, GetLetterCase = function() return 3 end, SetText = function(_, value) texts[#texts + 1] = value end}
  return {m_textInput = input, GetRootWidget = function() return {GetUserData = function() if data == 'throws' then error('torn down') end return data end} end}
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

test('safety net: a box the game tore down while the scripts still call it open is let go after a short grace, a box that never came up after eight seconds, and a live one never', () => runLua(composerFixture + `
  m.install()
  m.expect(clock)
  assert(m.orphaned(clock + 5) == false, 'not shown yet, still within the wait')
  assert(m.orphaned(clock + 9) == true, 'never came up')
  clock = 200; m.expect(clock)
  clock = 201; m.apply(box(talk))         -- the dialog initialises
  assert(m.shownAt == 201)
  assert(m.orphaned(clock + 600) == false, 'on screen, however long: never orphaned')
  observers['GenericMessageNotification.OnUninitialize'](box(search))
  observers['GenericMessageNotification.OnUninitialize'](box('throws'))
  observers['GenericMessageNotification.OnUninitialize'](box({title = 'Some game popup', message = 'x'}))
  assert(m.goneAt == nil, 'another popup closing, or one that cannot be read, frees nothing')
  assert(m.orphaned(clock + 600) == false)
  clock = 230
  observers['GenericMessageNotification.OnUninitialize'](box(talk))
  assert(m.goneAt == 230)
  assert(m.orphaned(231) == false, 'the close callback gets a moment')
  assert(m.orphaned(232) == true, 'then the token is let go')
  clock = 300; m.expect(clock)            -- the next box: the old teardown does not count
  assert(m.orphaned(302) == false)
  clock = 301; m.apply(box(talk))
  assert(m.orphaned(310) == false)
`));

test('the scripts-side halves of a park: the kept words are announced with the key, restored for the same character and chat only, and dropped otherwise', () => {
  const from = initSource.indexOf('convaiComposerWatch = {}');
  const to = initSource.indexOf('-- The scripts refused to open the text box');
  assert.ok(from > 0 && to > from, 'markers');
  const block = initSource.slice(from, to);
  const fixture = `
    local logs, sent = {}, {}
    local function log(line) logs[#logs + 1] = line end
    local ui = {t = function(text, args) return (text:gsub('{(%w+)}', function(key) return tostring(args and args[key]) end)) end}
    convaiNotices = {send = function(_, id, text) sent[#sent + 1] = {id = id, text = text}; return true end}
    function convaiKeyHint(action) return action == 'cyberpunk_convai_group_text' and 'F8' or action == 'cyberpunk_convai_johnny_text' and 'F9' or 'F6' end
    local clock = 10
    os.clock = function() return clock end
    local cleared, forgotten, kept = 0, 0, ''
    local player = {ConvaiDraftText = function() return kept end, ConvaiClearDraft = function() cleared = cleared + 1 end,
      ConvaiForgetComposer = function() forgotten = forgotten + 1 end}
    convaiComposerInput = {orphaned = function() return false end}
    ${block}
  `;
  runLua(fixture + `
    -- words kept: the notice names the key of the chat the box was opened with
    kept = 'hello there'
    convaiComposerWatch.parked(player, {generation = 4, profileKey = 'judy', name = 'Judy'})
    assert(#sent == 1 and sent[1].id == 'talk-draft' and sent[1].text == 'Your message to Judy is kept. Press F6 to type again.', sent[1] and sent[1].text)
    convaiComposerWatch.parked(player, {generation = 5, profileKey = 'judy', name = 'Judy', participants = {}})
    assert(sent[2].text == 'Your message to Judy is kept. Press F8 to type again.')
    -- a park with no words keeps nothing and says nothing
    kept = ''
    convaiComposerWatch.parked(player, {generation = 6, profileKey = 'judy', name = 'Judy'})
    assert(#sent == 2 and convaiComposerWatch.draft == nil)
    -- same character, same chat, soon enough: the words go back
    kept = 'again'
    convaiComposerWatch.parked(player, {generation = 7, profileKey = 'judy', name = 'Judy'})
    clock = 100
    assert(convaiComposerWatch.takeDraft(player, 'judy', false) == true and convaiComposerInput.restoreDraft == true and cleared == 0)
    assert(convaiComposerWatch.draft == nil, 'once')
    -- another character: dropped and cleared
    convaiComposerWatch.parked(player, {generation = 8, profileKey = 'judy', name = 'Judy'})
    assert(convaiComposerWatch.takeDraft(player, 'panam', false) == false and convaiComposerInput.restoreDraft == nil and cleared == 1)
    -- the same character in a group chat: dropped
    convaiComposerWatch.parked(player, {generation = 9, profileKey = 'judy', name = 'Judy'})
    assert(convaiComposerWatch.takeDraft(player, 'judy', true) == false and cleared == 2)
    -- too old: dropped
    convaiComposerWatch.parked(player, {generation = 10, profileKey = 'judy', name = 'Judy'})
    clock = clock + convaiComposerWatch.KEEP_S + 1
    assert(convaiComposerWatch.takeDraft(player, 'judy', false) == false and cleared == 3)
    -- no park at all: a box that opens clears whatever the scripts still hold
    assert(convaiComposerWatch.takeDraft(player, 'judy', false) == false and cleared == 4)
    -- the safety net asks the module and lets the box go only when it says so
    assert(convaiComposerWatch.orphan(player) == false and forgotten == 0)
    convaiComposerInput.orphaned = function() return true end
    assert(convaiComposerWatch.orphan(player) == true and forgotten == 1)
  `);
});

test('a closed box reports how it closed: parked and orphan are not lost messages, and the box that is gone stops the per-frame watch', () => {
  assert.match(initSource, /if result == 'parked' then convaiComposerWatch\.parked\(player, context\) end/);
  assert.match(initSource, /if result == 'empty' or result == 'nodata' then convaiComposerWatch\.notify\(player\) end/, 'only an empty or unreadable close is a lost message');
  // the safety net is asked only while a talk is active and the game says the box is open, in the loop that already reads the flag
  assert.match(initSource, /elseif openOk and composerOpen then\s+pcall\(convaiComposerWatch\.orphan, player\)/);
  // the box that opens registers what it waits for, and the kept words come back in the same press
  assert.match(initSource, /convaiComposerInput\.expect\(os\.clock\(\)\)[^]*?convaiComposerWatch\.takeDraft\(player, key, participants ~= nil\)/);
});

test('Composer.reds: a click outside the dialog of a talk box parks it with the game\'s own close; Esc, Enter and a search box are untouched', () => {
  // the wrapper is guarded like Codeware's own handler of the same event and only acts for a talk box
  assert.match(reds, /@if\(ModuleExists\("Codeware\.UI"\)\)\n@wrapMethod\(GenericMessageNotification\)\nprotected cb func OnHandlePressInput\(evt: ref<inkPointerEvent>\) -> Bool \{/);
  assert.match(reds, /evt\.IsAction\(n"click"\) && this\.m_data\.isInput && StrBeginsWith\(this\.m_data\.title, "TALK TO "\)/);
  assert.match(reds, /!this\.ConvaiClickInsideDialog\(evt\.GetTarget\(\)\)/);
  assert.match(reds, /player\.ConvaiParkRequest\(\) \{\n\s+this\.Close\(GenericMessageNotificationResult\.Cancel\);/);
  // the dialog test walks the parents of the clicked widget up to the "notification" widget and treats an unreadable dialog as inside
  assert.match(reds, /GetChildWidgetByPath\(n"notification"\)[^]*?if !IsDefined\(dialog\) \{\n\s+return true;/);
  // only a talk box can be parked, and the park is never a submission
  assert.match(reds, /ConvaiParkRequest\(\) -> Bool \{\n\s+if !IsDefined\(this\.m_convaiComposerToken\) \|\| !Equals\(this\.m_convaiComposerMode, "talk"\) \{\n\s+return false;/);
  const closed = reds.slice(reds.indexOf('protected cb func OnConvaiComposerClosed'), reds.indexOf('// Without Codeware'));
  assert.match(closed, /if this\.m_convaiParkRequested \{[^}]*m_convaiDraft = IsDefined\(result\) \? result\.input : "";[^}]*m_convaiCloseInfo = "parked";[^}]*return true;/);
  assert.ok(closed.indexOf('m_convaiParkRequested') < closed.indexOf('m_convaiSubmissionReady = true'), 'the park is decided before a submission can be made');
  assert.ok(!/m_convaiSubmissionReady = true/.test(closed.slice(0, closed.indexOf('m_convaiCloseInfo = "parked"'))), 'a park never sets a submission');
  // both boxes clear the flag when they open, so a flag left by an earlier box never turns the next close into a park
  assert.equal((reds.match(/this\.m_convaiParkRequested = false;/g) || []).length >= 4, true);
  // the safety net's method lets the token go
  assert.match(reds, /ConvaiForgetComposer\(\) -> Void \{\n\s+this\.m_convaiComposerToken = null;/);
});
