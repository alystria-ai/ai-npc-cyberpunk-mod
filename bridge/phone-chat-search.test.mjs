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

test('redscript: O or / opens the box on the Chat list, in the place of the tab strip, for a keyboard only', () => {
  const open = /private final func ConvaiSearchOpen\(\) -> Void \{([^]*?)\n\}\n/.exec(search)[1];
  assert.match(open, /NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) \{ return; \};/, 'the list only');
  assert.match(open, /if !this\.m_player\.PlayerLastUsedKBM\(\) \{ return; \};/, 'no search on a pad');
  assert.match(search, /Equals\(key, EInputKey\.IK_O\) \|\| Equals\(key, EInputKey\.IK_Slash\)/);
  // The key targets of the list's callback carry the two opening keys and the two arrows, and it asks the search first, before T, H and F.
  for (const key of ['IK_O', 'IK_Slash', 'IK_Up', 'IK_Down']) assert.match(tabs, new RegExp('AddTarget\\(ConvaiKeyTarget\\(EInputKey\\.' + key + ', EInputAction\\.IACT_Press\\)\\)'), key);
  assert.match(tabs, /if this\.ConvaiSearchKey\(key\) \{ return; \};[^]*?let selected = [^]*?if Equals\(key, EInputKey\.IK_T\)/);
  // The box takes the strip's place: same parent, same margin, the strip hidden while the box shows.
  assert.match(search, /strip\.GetParentWidget\(\) as inkCompoundWidget/);
  assert.match(search, /root\.SetMargin\(strip\.GetMargin\(\)\);/);
  assert.match(search, /this\.m_convaiSearchStrip\.SetVisible\(!visible\)/);
});

test('redscript: typing in the box cannot reach T, H, F, J, L, V, R or the tab keys, and no menu key opens', () => {
  // Every key callback of the list stands down while the box has the focus.
  assert.match(search, /private final func ConvaiSearchKey\(key: EInputKey\) -> Bool \{\s*if this\.ConvaiSearchTyping\(\) \{[^]*?return true;\s*\};/);
  const phone = strip(text('../r6/scripts/CyberpunkConvai/PhoneContacts.reds'));
  assert.match(phone, /if this\.ConvaiSearchTyping\(\) \{ return; \};\n\s*if Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.Opening\)/);
  // The game's own actions on the list (A and D change tab, F and R open, V calls) are swallowed while typing; the wheel and other releases are not.
  assert.match(tabs, /if this\.ConvaiSearchSwallows\(action\) \{\s*ListenerActionConsumer\.Consume\(consumer\);\s*return false;\s*\};/);
  const swallows = /private final func ConvaiSearchSwallows\(action: ListenerAction\) -> Bool \{([^]*?)\n\}\n/.exec(search)[1];
  assert.match(swallows, /if !this\.ConvaiSearchTyping\(\) \{ return false; \};/);
  assert.match(swallows, /BUTTON_PRESSED\) \|\| Equals\(type, gameinputActionType\.REPEAT\) \{ return true; \};/);
  assert.match(swallows, /if !Equals\(type, gameinputActionType\.BUTTON_RELEASED\) \{ return false; \};/, 'axes (the wheel) pass');
  for (const name of ['click', 'proceed', 'call', 'cancel', 'OpenPauseMenu', 'secondaryAction']) assert.ok(swallows.includes('n"' + name + '"'), name);
  // The menu keys (Esc, J) are shut through the same flag phone-input.lua already reads while a chat is typed.
  const chat = strip(text('../r6/scripts/CyberpunkConvai/PhoneChat.reds'));
  assert.match(chat, /public final func ConvaiPhoneChatTyping\(\) -> Bool \{\s*return \(IsDefined\(this\.m_convaiChatView\) && this\.m_convaiChatView\.ConvaiChatTyping\(\)\) \|\| this\.ConvaiPhoneChatSearchTyping\(\);/);
  // Typing needs the focus in the box, the Chat list state, and an open box; an Esc that just closed it still counts for 0.4 s.
  assert.match(search, /public final func ConvaiSearchTyping\(\) -> Bool \{\s*if this\.m_convaiSearchGuardUntil > 0\.0 && this\.ConvaiSearchNow\(\) < this\.m_convaiSearchGuardUntil \{ return true; \};\s*return this\.m_convaiSearchOpen && Equals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) && this\.ConvaiSearchBoxFocused\(\);/);
  assert.match(search, /this\.m_convaiSearchGuardUntil = this\.ConvaiSearchNow\(\) \+ 0\.4;\s*this\.ConvaiSearchClose\(true\);/);
  // Never the conversation's composer: the search does not touch it.
  assert.doesNotMatch(search, /m_convaiChatInput|ConvaiChatAutoFocus/);
});

test('redscript: Enter opens the selected match, Esc and Back clear the search first, a second Esc is the game\'s', () => {
  assert.match(search, /Equals\(evt\.GetKey\(\), EInputKey\.IK_Enter\) \{\s*if Equals\(evt\.GetAction\(\), EInputAction\.IACT_Press\) \{ this\.m_owner\.ConvaiSearchEnter\(\); \};\s*return;/);
  assert.match(search, /Equals\(evt\.GetKey\(\), EInputKey\.IK_Escape\) \{\s*if Equals\(evt\.GetAction\(\), EInputAction\.IACT_Press\) \{ this\.m_owner\.ConvaiSearchEscape\(\); \};\s*return;/);
  const enter = /public final func ConvaiSearchEnter\(\) -> Void \{([^]*?)\n\}\n/.exec(search)[1];
  assert.match(enter, /this\.m_convaiSearchOpenOnAnswer = true;\s*return;/, 'Enter before the answer waits for it');
  assert.match(enter, /this\.ConvaiOpenChat\(selected, true\)/);
  const close = /public final func ConvaiSearchClose\(rebuild: Bool\) -> Void \{([^]*?)\n\}\n/.exec(search)[1];
  assert.match(close, /^\s*if !this\.m_convaiSearchOpen \{ return; \};/, 'a closed search costs nothing');
  assert.match(close, /this\.ConvaiSearchBoxClear\(\);\s*this\.ConvaiSearchBoxShow\(false, false\);/, 'the text is cleared and the strip is back');
  assert.match(close, /this\.ConvaiShowChatContacts\(selectId\);/, 'the whole list is back around the selected contact');
  assert.match(search, /public func Back\(\) -> Void \{\s*if this\.ConvaiSearchBackHandled\(\) \{ return; \};\s*wrappedMethod\(\);/);
  // Anything that leaves the Chat list closes the search without rebuilding it.
  assert.equal([...tabs.matchAll(/this\.ConvaiSearchClose\(false\);/g)].length, 4, 'tab change, screen type, list closed, uninitialize');
});

test('redscript: the list is filtered from the rows it already has, only when the text changes, and the F key keeps the filter', () => {
  const changed = /private cb func OnConvaiSearchInput\(widget: wref<inkWidget>\) -> Bool \{([^]*?)\n\}\n/.exec(search)[1];
  assert.match(changed, /^\s*if !this\.m_convaiSearchOpen \|\| this\.m_convaiSearchMuted/, 'a closed box asks nothing');
  assert.match(changed, /StrLen\(text\) == 0 \{[^]*?ConvaiRefillChat\(this\.m_convaiSearchRows\);/, 'an empty text is the whole list at once');
  assert.match(changed, /this\.m_convaiSearchSeq = this\.m_player\.ConvaiPhoneChatSearchAsk\(text, this\.m_convaiSearchJournal\);/);
  assert.match(search, /if !this\.m_convaiSearchOpen \|\| seq != this\.m_convaiSearchSeq/, 'an answer for older text is dropped');
  // The build keeps every row and shows only the matches while a search is in force (a favorite turned on rebuilds the list).
  assert.match(tabs, /let shown = this\.ConvaiSearchRowsBuilt\(contacts\);\s*this\.m_contactListLogicController\.PopulateListData\(shown\);/);
  assert.match(search, /if this\.m_convaiSearchOpen && this\.m_convaiSearchFilter \{ return this\.ConvaiSearchFilterRows\(\); \};\s*return rows;/);
  // Nothing is polled or scheduled by the search.
  assert.doesNotMatch(search, /DelayCallback|DelaySystem|OnUpdate|OnTick|Schedule/);
  // Lua's questions: the player owns the counter, so a new list never repeats a number Lua has answered.
  assert.match(search, /public final func ConvaiPhoneChatSearchAsk\(query: String, journal: String\) -> Int32 \{\s*this\.m_convaiSearchSeq \+= 1;/);
});

test('redscript: without Codeware\'s text input the search compiles to nothing (stand-ins with the real signatures)', () => {
  const src = text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds');
  for (const name of ['ConvaiSearchBoxFocused\\(\\) -> Bool', 'ConvaiSearchBoxMake\\(\\) -> Bool', 'ConvaiSearchBoxShow\\(visible: Bool, focus: Bool\\) -> Void',
    'ConvaiSearchBoxText\\(\\) -> String', 'ConvaiSearchBoxClear\\(\\) -> Void']) {
    assert.match(src, new RegExp('@if\\(ModuleExists\\("Codeware\\.UI\\.TextInput"\\)\\)\\n@addMethod\\(NewHudPhoneGameController\\)\\nprivate final func ' + name), name);
    assert.match(src, new RegExp('@if\\(!ModuleExists\\("Codeware\\.UI\\.TextInput"\\)\\)\\n@addMethod\\(NewHudPhoneGameController\\)\\nprivate final func ' + name), 'stand-in ' + name);
  }
  assert.match(src, /@if\(!ModuleExists\("Codeware\.UI\.TextInput"\)\)\npublic class ConvaiPhoneSearchInput extends IScriptable \{\s*public static func Create\(owner: wref<NewHudPhoneGameController>\) -> ref<ConvaiPhoneSearchInput> \{\s*return null;/);
  // No Codeware type outside the guarded parts: the key arrives as the game's own EInputKey.
  const unguarded = src.replace(/@if\(ModuleExists\("Codeware\.UI\.TextInput"\)\)\n[^]*?\n\}\n/g, '');
  assert.doesNotMatch(strip(unguarded), /KeyInputEvent|HubTextInput/);
});

test('redscript: the new file is shipped, catalogued and holds no Input/Key registration of its own', () => {
  for (const file of ['../scripts/development-files.json', '../packaging/release-plan.json']) assert.ok(text(file).includes('r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), file);
  assert.doesNotMatch(text('../r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'), /RegisterCallback\(n"Input\/Key"/);
  assert.ok(text('../scripts/Extract-UiCatalog.mjs').includes("'r6/scripts/CyberpunkConvai/PhoneChatSearch.reds'"));
});

test('the one new word, Search, is in the catalogue and in all fifteen other interface languages, and the styler puts it on the hint', () => {
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
});
