import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import fengari from 'fengari';

// Search on the phone's Chat list (docs/PHONE_CHAT.md, "Search on the Chat list"). The game is not available offline: the matching and the
// request/answer exchange run in Lua against strict fakes, the redscript is checked as text, and the live check is in the TODO.md captain's log.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const text = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const strip = source => source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const search = strip(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'));
const tabs = strip(text('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds'));

function runLua(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const source = text('../mod/phone-chat.lua');
  const program = `
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    io.open = function(path, mode) if mode == 'rb' then return nil end return {write = function() return true end, close = function() return true end} end
    os.rename, os.remove = function() return true end, function() return true end
    NewObject = function() return {} end
    os.time = function() return 100 end
    local chat = (function() ${source} end)()
    chat.configure({
      {key = 'panam-palmer', name = 'Panam Palmer', kind = 'named'},
      {key = 'judy-alvarez', name = 'Judy Alvarez', kind = 'named'},
      {key = 'jose-ramirez', name = 'Jos\\195\\169 Ram\\195\\173rez', kind = 'named'},
      {key = 'rita-wheeler', name = 'Rita Wheeler', kind = 'named'},
      {key = 'life-coach', name = 'Life Coach', kind = 'named'},
      {key = 'takemura-san', name = 'Hanako Takemura-san', kind = 'named'},
    }, {profileEnabled = function() return true end},
      {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    ${body}
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}

const fakePlayer = `
  local seq, query, journal, answers, calls = 0, '', '', {}, 0
  local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
    ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
    ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
    ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
    ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
`;

test('Lua: a word start of the name matches, whatever the case, and every typed word must start a word', () => runLua(`
  local function ids(query, journal) return table.concat(chat.searchIds(query, journal), ',') end
  assert(ids('pan') == 'panam-palmer', ids('pan'))
  assert(ids('palm') == 'panam-palmer', 'the second word of the name: ' .. ids('palm'))
  assert(ids('PANAM palmer') == 'panam-palmer')
  assert(ids('  pal  ') == 'panam-palmer', 'spaces around the word are nothing')
  assert(ids('amer') == '', 'the middle of a word is not a word start')
  assert(ids('panam wheeler') == '', 'both words have to match the same person')
  assert(ids('pal pan') == 'panam-palmer', 'the order of the typed words does not matter')
  assert(ids('ju') == 'judy-alvarez' and ids('al') == 'judy-alvarez', 'the surname starts a word too')
  assert(ids('take') == 'takemura-san' and ids('san') == 'takemura-san', 'a hyphen splits words')
  assert(ids('x') == '')
  assert(#chat.searchIds('') == 6 and #chat.searchIds('   ') == 6, 'no word: everybody')
`));

test('Lua: accents are ignored on both sides', () => runLua(`
  local function ids(query) return table.concat(chat.searchIds(query), ',') end
  assert(ids('jose') == 'jose-ramirez' and ids('ramirez') == 'jose-ramirez', 'plain letters find accented names')
  assert(ids('jos\\195\\169') == 'jose-ramirez' and ids('RAM\\195\\141REZ') == 'jose-ramirez', 'accented letters find the same name')
  assert(ids('jos\\195\\168 ram\\195\\172') == 'jose-ramirez', 'another accent on the same letter')
  assert(chat.foldText('\\195\\156BER \\195\\159 Stra\\195\\159e') == 'uber ss strasse')
  assert(chat.foldText('Plain Text') == 'plain text')
  -- A script with no Latin letters is kept as it is (not mangled, not matched by accident).
  assert(chat.foldText('\\227\\131\\134\\227\\130\\185\\227\\131\\136') == '\\227\\131\\134\\227\\130\\185\\227\\131\\136')
`));

test('Lua: the journal name of a contact counts as well as the profile name', () => runLua(`
  local journal = 'life-coach\\tCoach Fred\\nunknown-id\\tNobody\\n'
  assert(#chat.searchIds('fred') == 0, 'without the journal she is only her profile name')
  local ids = chat.searchIds('fred', journal)
  assert(#ids == 1 and ids[1] == 'life-coach', 'the journal word finds her: ' .. #ids)
  assert(chat.searchIds('life', journal)[1] == 'life-coach', 'the profile name still finds her')
  assert(#chat.searchIds('nobody', journal) == 0, 'a journal id that is no contact of the catalogue is nobody')
  assert(chat.searchJournal(journal) == chat.searchJournal(journal), 'the same journal text is parsed once')
`));

test('Lua: the words of the names are made once, until the contacts change', () => runLua(`
  local first = chat.searchIndex()
  assert(chat.searchIndex() == first and chat.searchIds('pan')[1] == 'panam-palmer')
  chat.setContacts('custom', {{key = 'zed-newcomer', name = 'Zed Newcomer'}})
  assert(chat.searchIndex() ~= first, 'registering contacts again drops the old words')
  assert(chat.searchIds('newc')[1] == 'zed-newcomer')
`));

test('Lua: 700 names are searched in a few milliseconds', () => runLua(`
  local rows = {}
  for i = 1, 720 do rows[i] = {key = 'person-' .. i, name = 'Firstname' .. i .. ' Lastname' .. (i % 17)} end
  chat.setContacts('side', rows)
  chat.searchIds('first')
  local started = os.clock()
  for _ = 1, 20 do chat.searchIds('first lastname3') end
  local per = (os.clock() - started) / 20
  assert(#chat.searchIds('firstname71') >= 11)
  -- fengari is a slow interpreter (tens of times slower than the game's LuaJIT): this only catches a search that has become quadratic.
  assert(per < 0.3, 'one search took ' .. per .. ' s')
`));

test('Lua: the tick answers a new question once, with its number, and a question already answered costs one call', () => runLua(`
  chat.resetPeriod, chat.resetIdlePeriod = 0, 0
  ${fakePlayer}
  player.ConvaiPhoneChatSearchSeq = function() calls = calls + 1; return seq end
  player.ConvaiPhoneChatSearchQuery = function() return query end
  player.ConvaiPhoneChatSearchJournal = function() return journal end
  player.ConvaiPhoneChatSearchResult = function(_, number, ids) answers[#answers + 1] = number .. ':' .. ids end
  local function frames(open) for _ = 1, 8 do chat.update(player, 0, open) end end
  frames(true)
  assert(#answers == 0, 'no question yet')
  seq, query = 7, 'pan'
  frames(true)
  assert(#answers == 1 and answers[1] == '7:panam-palmer', tostring(answers[1]))
  frames(true)
  assert(#answers == 1, 'the same question is not answered twice')
  seq, query = 8, 'rita wheel'
  frames(true)
  assert(#answers == 2 and answers[2] == '8:rita-wheeler', tostring(answers[2]))
  seq, query = 9, 'nobody'
  frames(true)
  assert(answers[3] == '9:', 'an empty answer is still an answer: ' .. tostring(answers[3]))
  -- With the phone shut nothing is asked at all.
  calls = 0
  seq, query = 10, 'judy'
  frames(false)
  assert(calls == 0 and #answers == 3, 'the phone is shut: ' .. calls)
  frames(true)
  assert(answers[4] == '10:judy-alvarez', tostring(answers[4]))
`));

test('Lua: scripts without the methods are given up on once and break nothing', () => runLua(`
  chat.resetPeriod, chat.resetIdlePeriod = 0, 0
  ${fakePlayer}
  for _ = 1, 8 do chat.update(player, 0, true) end
  assert(chat.searchMissing == true, 'a player without the methods is asked once')
  player.ConvaiPhoneChatSearchSeq = function() calls = calls + 1; return 5 end
  for _ = 1, 8 do chat.update(player, 0, true) end
  assert(calls == 0, 'and never again')
`));

const body = (source, signature) => {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, 'missing: ' + signature);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail('unbalanced: ' + signature);
};
const chatReds = strip(text('../r6/scripts/CyberpunkConvai/PhoneChat.reds'));

test('redscript: O, / or a click on the row starts the search on the Chat list, for a keyboard only', () => {
  const open = body(search, 'private final func ConvaiSearchOpen() -> Void');
  assert.match(open, /NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) \{ return; \};/, 'the list only');
  assert.match(open, /if !this\.m_player\.PlayerLastUsedKBM\(\) \|\| !this\.ConvaiSearchAvailable\(\) \{ return; \};/, 'no search on a pad');
  assert.match(search, /Equals\(key, EInputKey\.IK_O\) \|\| Equals\(key, EInputKey\.IK_Slash\)/);
  assert.match(search, /public class ConvaiSearchOpenEvent extends Event/);
  assert.match(search, /private cb func OnConvaiSearchOpenEvent\(evt: ref<ConvaiSearchOpenEvent>\) -> Bool \{\s*this\.ConvaiSearchOpen\(\);/);
  assert.match(search, /row\.RegisterToCallback\(n"OnRelease", this, n"OnConvaiSearchRowClick"\);/);
  assert.match(search, /if evt\.IsAction\(n"click"\) \{\s*this\.QueueEvent\(new ConvaiSearchOpenEvent\(\)\);/);
  // The key targets of the list's callback carry the two opening keys and the two arrows, and it asks the search first, before T, H and F.
  for (const key of ['IK_O', 'IK_Slash', 'IK_Up', 'IK_Down']) assert.match(tabs, new RegExp('AddTarget\\(ConvaiKeyTarget\\(EInputKey\\.' + key + ', EInputAction\\.IACT_Press\\)\\)'), key);
  assert.match(tabs, /if this\.ConvaiSearchKey\(key\) \{ return; \};[^]*?let selected = [^]*?if Equals\(key, EInputKey\.IK_T\)/);
});

test('redscript: the search is the first row of the Chat list, plain widgets at rest, in the scroll area\'s own place, not in the tab strip', () => {
  const make = body(search, 'private final func ConvaiSearchRowMake() -> Bool');
  // The holder is the panel of the scroll area (list, then its scroll area, then the panel), the row is put in front of the list's gradient mask.
  assert.match(make, /let list = inkWidgetRef\.Get\(this\.m_contactsList\);\s*let area = IsDefined\(list\) \? list\.GetParentWidget\(\) : null;\s*let holder = IsDefined\(area\) \? area\.GetParentWidget\(\) as inkCompoundWidget : null;/);
  assert.match(make, /row\.Reparent\(holder, 0\);/);
  assert.match(make, /row\.SetHAlign\(inkEHorizontalAlign\.Right\);[^]*?row\.SetVAlign\(inkEVerticalAlign\.Top\);[^]*?area\.GetMargin\(\)\.right/, 'aligned as the scroll area is');
  assert.match(make, /bar\.SetSize\(new Vector2\(1000\.0, 100\.0\)\)/, 'the size of a Chat row of the game');
  assert.match(make, /n"convaiSearchPlaceholder"[^]*?word\.SetText\("Type a name to search"\);/, 'the hint of the empty row');
  assert.match(make, /ConvaiFavoriteArt\.KeyCap\(n"kb_o"\)/, 'the O key is in the row');
  // At rest the row holds no Codeware widget (its text input runs an animation tick every frame): the box is made only when the search starts.
  assert.doesNotMatch(make, /ConvaiPhoneSearchInput|HubTextInput|TextInput/);
  const boxMake = body(search, 'private final func ConvaiSearchBoxMake() -> Bool');
  assert.match(boxMake, /let row = this\.m_contactListLogicController\.ConvaiSearchRow\(\);/);
  assert.match(boxMake, /box\.Reparent\(row, 2\);/, 'above the row\'s bar and line, under its word and key');
  const open = body(search, 'private final func ConvaiSearchOpen() -> Void');
  assert.match(open, /if !this\.ConvaiSearchBoxMake\(\) \{ return; \};/);
  // The list moves down by the row's height while the row shows, and comes back with it.
  const shift = body(search, 'private final func ConvaiSearchShift(on: Bool) -> Void');
  assert.match(shift, /margin\.top \+ 112\.0/, 'the row\'s 100 and a gap of 12 below it');
  assert.match(shift, /this\.m_convaiSearchArea\.SetMargin\(this\.m_convaiSearchAreaMargin\);/, 'put back exactly');
  // The size of the scroll area is never read or set: on a list just spawned it is not laid out and a size taken then left no room for any row (31 Oct, reopening the phone).
  assert.doesNotMatch(shift.replace(/\/\/.*$/gm, ''), /GetSize|SetSize/);
  assert.doesNotMatch(search, /m_convaiSearchAreaSize/);
  // The tab strip is not touched any more.
  assert.doesNotMatch(search, /ConvaiSearchStrip|m_menuSelectorCtrl|SetVisible\(!visible\)/);
  // The row is built before the rows are, on a keyboard, and only with the text input; it goes with the Chat list.
  assert.match(tabs, /this\.ConvaiSearchRowSync\(\);\s*this\.m_contactListLogicController\.PopulateListData\(shown\);/);
  const sync = body(search, 'private final func ConvaiSearchRowSync() -> Void');
  assert.match(sync, /this\.ConvaiSearchAvailable\(\) && IsDefined\(this\.m_player\) && this\.m_player\.PlayerLastUsedKBM\(\)/);
  const closeAll = body(search, 'public final func ConvaiSearchClose(rebuild: Bool) -> Void');
  assert.match(closeAll, /this\.m_convaiSearchLeaving = false;/);
  assert.match(closeAll, /this\.m_contactListLogicController\.ConvaiSearchRowShow\(false\);/);
});

test('redscript: typing in the box cannot reach T, H, F, J, L, V, R or the tab keys, and no menu key opens', () => {
  // Every key callback of the list stands down while the box has the focus.
  assert.match(search, /private final func ConvaiSearchKey\(key: EInputKey\) -> Bool \{\s*if this\.ConvaiSearchTyping\(\) \{[^]*?return true;\s*\};/);
  const phone = strip(text('../r6/scripts/CyberpunkConvai/PhoneContacts.reds'));
  assert.match(phone, /if this\.ConvaiSearchTyping\(\) \{ return; \};\n\s*if Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Opening\)/);
  // The game's own actions on the list (A and D change tab, F and R open, V calls) are swallowed while typing; the wheel and other releases are not.
  assert.match(tabs, /if this\.ConvaiSearchSwallows\(action\) \{\s*this\.ConvaiSearchHoldsPause\(action, consumer\);\s*ListenerActionConsumer\.Consume\(consumer\);\s*return false;\s*\};/);
  const swallows = body(search, 'private final func ConvaiSearchSwallows(action: ListenerAction) -> Bool');
  assert.match(swallows, /if !this\.ConvaiSearchTyping\(\) \{ return false; \};/);
  assert.match(swallows, /BUTTON_PRESSED\) \|\| Equals\(type, gameinputActionType\.REPEAT\) \{ return true; \};/);
  assert.match(swallows, /if !Equals\(type, gameinputActionType\.BUTTON_RELEASED\) \{ return false; \};/, 'axes (the wheel) pass');
  for (const name of ['click', 'proceed', 'call', 'cancel', 'OpenPauseMenu', 'secondaryAction']) assert.ok(swallows.includes('n"' + name + '"'), name);
  // The menu keys (Esc, J) are shut through the same flag phone-input.lua already reads while a chat is typed.
  assert.match(chatReds, /public final func ConvaiPhoneChatTyping\(\) -> Bool \{\s*return \(IsDefined\(this\.m_convaiChatView\) && this\.m_convaiChatView\.ConvaiChatTyping\(\)\) \|\| this\.ConvaiPhoneChatSearchTyping\(\);/);
  // Never the conversation's composer: the search does not touch it.
  assert.doesNotMatch(search, /m_convaiChatInput|ConvaiChatAutoFocus/);
});

test('redscript: the typing flag is read live and cannot outlive the box (the 31 Oct dead pause menu)', () => {
  // The cause: Esc closed the box, the box let the player forget the list at once, so the flag fell to false while the Esc was still going through the game. The Esc came up
  // as a pause-menu release over the open phone (its press had been swallowed), and the pause menu that opened took no input. The list is now remembered until it is taken down.
  const close = body(search, 'public final func ConvaiSearchClose(rebuild: Bool) -> Void');
  const end = body(search, 'private final func ConvaiSearchEnd(rebuild: Bool, later: Bool) -> Void');
  assert.doesNotMatch(close + end, /ConvaiPhoneChatSearchView\(null\)/, 'ending a search does not make the player forget the list');
  assert.match(body(search, 'public final func ConvaiSearchUninitialize() -> Void'), /this\.m_player\.ConvaiPhoneChatSearchView\(null\);/);
  assert.match(tabs, /this\.ConvaiChatListKeysStop\(\);\s*this\.ConvaiSearchUninitialize\(\);\s*return wrappedMethod\(\);/);
  assert.match(search, /public final func ConvaiPhoneChatSearchTyping\(\) -> Bool \{\s*return IsDefined\(this\.m_convaiSearchView\) && this\.m_convaiSearchView\.ConvaiSearchTyping\(\);/);
  // The press of the Esc the search swallows is marked as the phone itself marks it, so no release comes up to open the pause menu.
  const holds = body(search, 'private final func ConvaiSearchHoldsPause(action: ListenerAction, consumer: ListenerActionConsumer) -> Void');
  assert.match(holds, /n"OpenPauseMenu"[^]*?BUTTON_PRESSED[^]*?ListenerActionConsumer\.DontSendReleaseEvent\(consumer\);/);
  // The flag: the Esc that left the box until it came up (seen by the list's key callback) and two ticks, never more than six ticks or a second and a half.
  const typing = body(search, 'public final func ConvaiSearchTyping() -> Bool');
  assert.match(typing, /if this\.m_convaiSearchLeaving \{\s*if this\.ConvaiSearchNow\(\) - this\.m_convaiSearchLeavingAt < 1\.5 \{ return true; \};\s*this\.m_convaiSearchLeaving = false;\s*\};/);
  assert.match(typing, /return this\.m_convaiSearchOpen && Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) && this\.ConvaiSearchBoxFocused\(\) && this\.ConvaiSearchOnScreen\(\);/);
  const onScreen = body(search, 'private final func ConvaiSearchOnScreen() -> Bool');
  assert.match(onScreen, /this\.m_player\.ConvaiPhoneIsOpen\(\)/, 'the phone is open');
  assert.match(onScreen, /this\.m_contactListLogicController\.ConvaiSearchOnScreen\(\) && this\.GetRootWidget\(\)\.IsVisible\(\)/, 'no menu has hidden the phone');
  const walk = body(search, 'public final func ConvaiSearchOnScreen() -> Bool');
  assert.match(walk, /if !widget\.IsVisible\(\) \{ return false; \};\s*widget = widget\.GetParentWidget\(\);/, 'every widget up to the top is shown');
  assert.match(tabs, /AddTarget\(ConvaiKeyTarget\(EInputKey\.IK_Escape, EInputAction\.IACT_Release\)\)/);
  assert.match(tabs, /AddTarget\(ConvaiKeyTarget\(EInputKey\.IK_Enter, EInputAction\.IACT_Release\)\)/, 'the Enter that left the row is seen coming up too');
  assert.match(tabs, /if Equals\(key, EInputKey\.IK_Escape\) \|\| Equals\(key, EInputKey\.IK_Enter\) \{\s*if !pressed \{ this\.ConvaiSearchKeyReleased\(\); \};\s*return;\s*\};/);
  const escape = body(search, 'public final func ConvaiSearchEscape() -> Void');
  assert.match(escape, /this\.m_convaiSearchLeaving = true;[^]*?this\.ConvaiSearchEnd\(true, true\);/);
  const tick = body(search, 'public final func ConvaiSearchTick() -> Void');
  assert.match(tick, /this\.m_convaiSearchLeavingTicks >= 6 \{ this\.m_convaiSearchLeaving = false; \}/);
  assert.match(tick, /if !this\.ConvaiSearchOnScreen\(\) \{\s*this\.ConvaiSearchClose\(false\);\s*return;\s*\};/, 'the phone or the list is gone: everything is let go of');
  assert.match(tick, /this\.m_convaiSearchDrop \{\s*this\.ConvaiSearchBoxDrop\(\);/);
  assert.match(tick, /m_convaiSearchIdle >= 3 \{ this\.ConvaiSearchEnd\(false, false\); \}/, 'a search nobody uses ends by itself');
  // Lua's 10 Hz tick reaches it, through the player.
  assert.match(chatReds, /public final func ConvaiPhoneChatTick\(\) -> Void \{[^]*?this\.ConvaiPhoneChatSearchTick\(\);/);
  assert.match(search, /public final func ConvaiPhoneChatSearchTick\(\) -> Void \{\s*if IsDefined\(this\.m_convaiSearchView\) \{ this\.m_convaiSearchView\.ConvaiSearchTick\(\); \};/);
});

test('redscript: the box is taken away when the search ends (its tick stops), never from inside its own key callback', () => {
  const stop = body(search, 'public final func Stop() -> Void');
  assert.match(stop, /this\.m_holdTickProxy\.Stop\(\);/);
  const drop = body(search, 'private final func ConvaiSearchBoxDrop() -> Void');
  assert.match(drop, /box\.Stop\(\);/);
  assert.match(drop, /row\.RemoveChild\(root\)/);
  assert.match(drop, /this\.m_convaiSearchBox = null;/);
  const end = body(search, 'private final func ConvaiSearchEnd(rebuild: Bool, later: Bool) -> Void');
  assert.match(end, /if later \{ this\.m_convaiSearchDrop = true; \} else \{ this\.ConvaiSearchBoxDrop\(\); \};/);
  assert.match(end, /^\s*if !this\.m_convaiSearchOpen && !this\.m_convaiSearchDrop && !IsDefined\(this\.m_convaiSearchBox\) \{ return; \};/, 'no search, no cost');
  assert.match(end, /this\.ConvaiShowChatContacts\(selectId\);/, 'the whole list is back around the selected contact');
});

test('redscript: closing and reopening the phone starts from the full list, with no search state left (empty text, text, and after a chat)', () => {
  // Every opening of the phone spawns a new list, and the game sets the screen type for it (SetScreenType, wrapped to close the search): closing the search forgets all of its state.
  assert.match(tabs, /public func SetScreenType\(type: PhoneScreenType\) -> Void \{\s*this\.m_convaiChatState = ConvaiPhoneChatState\.Off;\s*this\.ConvaiSearchClose\(false\);/);
  assert.match(body(search, 'public final func ConvaiSearchClose(rebuild: Bool) -> Void'), /this\.m_contactListLogicController\.ConvaiSearchRowShow\(false\);\s*\};\s*this\.ConvaiSearchReset\(\);/);
  assert.doesNotMatch(search, /wrapMethod\(NewHudPhoneGameController\)\nprotected cb func OnContactListSpawned/, 'no new wrapped method (docs/MOD_COMPATIBILITY.md lists them)');
  const reset = body(search, 'public final func ConvaiSearchReset() -> Void');
  // Every field of a search is put back, whatever it held: nothing is left that could filter the next list or ask for a box that is gone.
  for (const field of ['m_convaiSearchOpen = false', 'm_convaiSearchFilter = false', 'm_convaiSearchLeaveOnAnswer = false', 'm_convaiSearchSeq = -1', 'm_convaiSearchIdle = 0',
    'm_convaiSearchDrop = false', 'm_convaiSearchMuted = false', 'm_convaiSearchLeaving = false', 'm_convaiSearchLeavingTicks = 0', 'm_convaiSearchLeavingFrames = 0', 'm_convaiSearchJournal = ""'])
    assert.ok(reset.includes('this.' + field + ';'), field);
  assert.match(reset, /ArrayClear\(this\.m_convaiSearchIds\);\s*ArrayClear\(this\.m_convaiSearchRows\);/);
  assert.match(reset, /this\.ConvaiSearchBoxForget\(\);/);
  const forget = body(search, 'private final func ConvaiSearchBoxForget() -> Void');
  assert.match(forget, /this\.m_convaiSearchBox\.Stop\(\);\s*\};\s*this\.m_convaiSearchBox = null;/, 'the box of a gone list stops its tick and is forgotten');
  // Closing the phone with a search going (no text, text, a chat open) lets go of it before the list is removed: the same call as a tab change.
  assert.match(tabs, /protected cb func OnContactListClosed\(\) -> Bool \{\s*this\.m_convaiChatState = ConvaiPhoneChatState\.Off;\s*this\.ConvaiSearchClose\(false\);/);
  // A filter is applied to a list only while its box exists: a stale filter cannot empty a list built after the box is gone.
  assert.match(search, /if this\.m_convaiSearchOpen && this\.m_convaiSearchFilter && IsDefined\(this\.m_convaiSearchBox\) \{ return this\.ConvaiSearchFilterRows\(\); \};\s*return rows;/);
  // A new list gets its own row (the fields of the old list's row live in the old list), moved by margin only, and the first build shows the whole list.
  const make = body(search, 'private final func ConvaiSearchRowMake() -> Bool');
  assert.match(make, /if IsDefined\(this\.m_convaiSearchRow\) \{ return true; \};/);
  assert.match(tabs, /let shown = this\.ConvaiSearchRowsBuilt\(contacts\);/);
  assert.match(search, /private final func ConvaiSearchRowsBuilt\(rows: array<ref<IScriptable>>\) -> array<ref<IScriptable>> \{\s*this\.m_convaiSearchRows = rows;/);
});

test('redscript: Enter leaves the row for the first match and opens nothing, Esc and Back end the search first, a second Esc is the game\'s', () => {
  assert.match(search, /Equals\(evt\.GetKey\(\), EInputKey\.IK_Enter\) \{\s*if Equals\(evt\.GetAction\(\), EInputAction\.IACT_Press\) \{ this\.m_owner\.ConvaiSearchEnter\(\); \};\s*return;/);
  assert.match(search, /Equals\(evt\.GetKey\(\), EInputKey\.IK_Escape\) \{\s*if Equals\(evt\.GetAction\(\), EInputAction\.IACT_Press\) \{ this\.m_owner\.ConvaiSearchEscape\(\); \};\s*return;/);
  const enter = body(search, 'public final func ConvaiSearchEnter() -> Void');
  assert.match(enter, /this\.m_convaiSearchLeaveOnAnswer = true;\s*return;/, 'Enter before the answer waits for it');
  assert.match(enter, /this\.ConvaiSearchLeave\(true\);/);
  assert.doesNotMatch(enter, /ConvaiOpenChat/, 'Enter opens no chat');
  const leave = body(search, 'private final func ConvaiSearchLeave(keyDown: Bool) -> Void');
  assert.match(leave, /let first = this\.m_contactListLogicController\.ConvaiChatContactAt\(0u\);\s*if !IsDefined\(first\) \{ return; \};/, 'no match: Enter does nothing');
  assert.match(leave, /this\.m_contactListLogicController\.ConvaiSearchSelectFirst\(\);\s*this\.ConvaiSearchBoxFocus\(false\);/, 'the selection goes to the first match and the box lets go of the keyboard');
  assert.doesNotMatch(leave, /ConvaiOpenChat|ConvaiSearchEnd|ConvaiSearchClose/, 'the search stays in force and no chat opens');
  assert.match(leave, /if keyDown \{\s*this\.m_convaiSearchLeaving = true;/, 'the Enter that left is the search\'s until it has come up (its confirm would open the chat of the row)');
  assert.match(body(search, 'public final func ConvaiSearchApply(seq: Int32, ids: String) -> Void'), /this\.m_convaiSearchLeaveOnAnswer = false;\s*this\.ConvaiSearchLeave\(false\);/);
  const selectFirst = body(search, 'public final func ConvaiSearchSelectFirst() -> Void');
  assert.match(selectFirst, /list\.SelectItem\(0u\);\s*list\.ScrollToIndex\(0u\);/);
  assert.match(search, /public func Back\(\) -> Void \{\s*if this\.ConvaiSearchBackHandled\(\) \{ return; \};\s*wrappedMethod\(\);/);
  const back = body(search, 'private final func ConvaiSearchBackHandled() -> Bool');
  assert.match(back, /if this\.m_convaiSearchLeaving \{ return true; \};/, 'the Esc that just left the box is not a Back');
  assert.match(back, /this\.ConvaiSearchEnd\(true, false\);\s*return true;/);
  // Anything that leaves the Chat list lets go of the search without rebuilding it: tab change, screen type, list closed (the uninitialize has its own).
  assert.equal([...tabs.matchAll(/this\.ConvaiSearchClose\(false\);/g)].length, 3, 'tab change, screen type, list closed');
});

test('redscript: the list is filtered from the rows it already has, only when the text changes, and the F key keeps the filter', () => {
  const changed = body(search, 'private cb func OnConvaiSearchInput(widget: wref<inkWidget>) -> Bool');
  assert.match(changed, /^\s*if !this\.m_convaiSearchOpen \|\| this\.m_convaiSearchMuted/, 'a closed box asks nothing');
  assert.match(changed, /StrLen\(text\) == 0 \{[^]*?ConvaiRefillChat\(this\.m_convaiSearchRows\);/, 'an empty text is the whole list at once');
  assert.match(changed, /this\.m_convaiSearchSeq = this\.m_player\.ConvaiPhoneChatSearchAsk\(text, this\.m_convaiSearchJournal\);/);
  assert.match(search, /if !this\.m_convaiSearchOpen \|\| seq != this\.m_convaiSearchSeq/, 'an answer for older text is dropped');
  // The build keeps every row and shows only the matches while a search is in force (a favorite turned on rebuilds the list).
  assert.match(tabs, /let shown = this\.ConvaiSearchRowsBuilt\(contacts\);[^]*?this\.m_contactListLogicController\.PopulateListData\(shown\);/);
  // Nothing is polled or scheduled by the search: no frame hook, no delay, only Lua's 10 Hz tick and the key callbacks.
  assert.doesNotMatch(search, /DelayCallback|DelaySystem|OnUpdate|OnTick|Schedule|OnAnimation|PlayAnimation/);
  // Lua's questions: the player owns the counter, so a new list never repeats a number Lua has answered.
  assert.match(search, /public final func ConvaiPhoneChatSearchAsk\(query: String, journal: String\) -> Int32 \{\s*this\.m_convaiSearchSeq \+= 1;/);
});

test('redscript: without Codeware\'s text input the search compiles to nothing (stand-ins with the real signatures)', () => {
  const src = text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds');
  for (const name of ['ConvaiSearchAvailable\\(\\) -> Bool', 'ConvaiSearchBoxFocused\\(\\) -> Bool', 'ConvaiSearchBoxMake\\(\\) -> Bool', 'ConvaiSearchBoxDrop\\(\\) -> Void',
    'ConvaiSearchBoxFocus\\(focus: Bool\\) -> Void', 'ConvaiSearchBoxText\\(\\) -> String', 'ConvaiSearchBoxClear\\(\\) -> Void']) {
    assert.match(src, new RegExp('@if\\(ModuleExists\\("Codeware\\.UI\\.TextInput"\\)\\)\\n@addMethod\\(NewHudPhoneGameController\\)\\nprivate final func ' + name), name);
    assert.match(src, new RegExp('@if\\(!ModuleExists\\("Codeware\\.UI\\.TextInput"\\)\\)\\n@addMethod\\(NewHudPhoneGameController\\)\\nprivate final func ' + name), 'stand-in ' + name);
  }
  assert.match(src, /@if\(!ModuleExists\("Codeware\.UI\.TextInput"\)\)\npublic class ConvaiPhoneSearchInput extends IScriptable \{\s*public static func Create\(owner: wref<NewHudPhoneGameController>\) -> ref<ConvaiPhoneSearchInput> \{\s*return null;/);
  // Without the text input no row is shown at all (a field nobody could type in).
  assert.match(src, /@if\(!ModuleExists\("Codeware\.UI\.TextInput"\)\)\n@addMethod\(NewHudPhoneGameController\)\nprivate final func ConvaiSearchAvailable\(\) -> Bool \{\s*return false;/);
  // No Codeware type outside the guarded parts: the key arrives as the game's own EInputKey.
  const unguarded = src.replace(/@if\(ModuleExists\("Codeware\.UI\.TextInput"\)\)\n[^]*?\n\}\n/g, '');
  assert.doesNotMatch(strip(unguarded), /KeyInputEvent|HubTextInput|ConvaiPhoneSearchInput\./);
});

test('redscript: the new file is shipped, catalogued and holds no Input/Key registration of its own', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) assert.ok(text(file).includes('r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), file);
  assert.doesNotMatch(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), /RegisterCallback\(n"Input\/Key"/);
  assert.ok(text('../scripts/Extract-UiCatalog.mjs').includes("'r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'"));
});

test('the words Search and Type a name to search are in the catalogue and in all fifteen other interface languages, and the styler puts them on the hint and on the search row', () => {
  assert.ok(text('../localization/en.json').includes('"Type a name to search": "Type a name to search"'));
  for (const name of readdirSync(new URL('../mod/locales/', import.meta.url)).filter(file => file.endsWith('.lua'))) {
    const hint = new RegExp('^    \\["Type a name to search"\\] = "([^"]+)",$', 'm').exec(text('../mod/locales/' + name));
    assert.ok(hint && hint[1] !== 'Type a name to search' && !/[;–—]|--/.test(hint[1]), name);
  }
  assert.ok(text('../localization/en.json').includes('"Search": "Search"'));
  const files = readdirSync(new URL('../mod/locales/', import.meta.url)).filter(name => name.endsWith('.lua'));
  assert.equal(files.length, 15);
  for (const name of files) {
    const line = new RegExp('^    \\["Search"\\] = "([^"]+)",$', 'm').exec(text('../mod/locales/' + name));
    assert.ok(line && line[1] !== 'Search' && !/[;–—]|--/.test(line[1]), name);
  }
  const style = text('../mod/phone-chat-style.lua');
  assert.match(style, /find\(root, 'convaiSearchHintLabel', 8\)\n\s*if search and search:GetText\(\) == 'Search' then search:SetText\(text\('Search'\)\) end/);
  assert.match(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), /label\.SetText\("Search"\);/);
  assert.match(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), /word\.SetText\("Type a name to search"\);/);
  assert.match(style, /local word = text\('Type a name to search'\)\n\s*if word ~= 'Type a name to search' then\n\s*local placeholder = okRoot and root and find\(root, 'convaiSearchPlaceholder', 16\)\n\s*if placeholder and placeholder:GetText\(\) == 'Type a name to search' then placeholder:SetText\(word\) end/);
});
