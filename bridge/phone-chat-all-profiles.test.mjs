import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {rosterContacts, PhoneChat} from './phone-chat.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// Every named character with a profile is a Chat contact, not only the ones the game's journal lists (a player asked for Rita Wheeler).
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\uFEFF/, '');
const roster = JSON.parse(read('../characters/roster.json'));
const contacts = JSON.parse(read('../characters/phone-contacts.json'));
const adapter = read('../mod/phone-chat.lua');
const named = roster.filter(row => row.kind === 'named');

test('bridge: every named profile resolves to a phone contact, Rita included, and the shipped contacts keep their ids', () => {
  const all = [...contacts, ...rosterContacts(contacts, roster)];
  const chat = new PhoneChat({contacts: all, ids: Object.fromEntries(roster.map(row => [row.key, 'id-' + row.key])),
    reply: async () => ({}), publish: async () => {}, now: () => 1});
  const reachable = new Set(all.filter(c => c.key).map(c => chat.profileFor(c.contact)));
  for (const row of named) assert.ok(reachable.has(row.key), `${row.key} must be a Chat contact`);
  assert.equal(chat.profileFor('rita-wheeler'), 'rita-wheeler');
  assert.equal(chat.profileFor('judy'), 'judy-alvarez', 'a shipped contact keeps its own id');
  assert.equal(chat.profileFor('resident-male'), undefined, 'the ambient residents are not contacts');
  assert.equal(new Set(all.map(c => c.contact)).size, all.length, 'contact ids stay unique');
  assert.deepEqual(rosterContacts(contacts, [{key: 'x', kind: 'addon'}, {key: 'Bad Key', kind: 'named'}, {key: 'judy-alvarez', kind: 'named'}]), []);
});

test('Lua: the catalog gains every named profile with its name, keeps the shipped ids, and registers names with the game', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const rows = roster.map(({key, name, kind}) => ({key, name, kind}));
  const program = `
    local files = {}
    local json = {decode = function(raw) return raw end, encode = function(v) return v end}
    local rowsByRaw = {}
    files['phone-contacts.json'] = ${luaValue(contacts)}
    io.open = function(path, mode)
      if mode == 'rb' and files[path] then return {read = function() return files[path] end, close = function() end} end
      return nil
    end
    NewObject = function() return {} end
    os.time = function() return 100 end
    local chat = (function() ${adapter} end)()
    local profiles = ${luaValue(rows)}
    chat.configure(profiles, {profileEnabled = function() return true end}, {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    assert(chat.catalog['rita-wheeler'] == 'rita-wheeler' and chat.names['rita-wheeler'] == 'Rita Wheeler')
    assert(chat.catalog['judy'] == 'judy-alvarez' and chat.names['judy'] == nil, 'shipped contacts keep ids and take the journal name')
    assert(chat.catalog['resident-male'] == nil)
    local mapped = {}
    for _, key in pairs(chat.catalog) do mapped[key] = true end
    for _, p in ipairs(profiles) do if p.kind == 'named' then assert(mapped[p.key], p.key) end end
    assert(chat.contactFor('rita-wheeler') == 'rita-wheeler')
    -- Registration: every contact is offered once, the extras with their names; a later group (a pack's own characters) re-registers.
    local registered, cleared = {}, 0
    local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() cleared = cleared + 1; registered = {} end,
      ConvaiPhoneChatRegisterContact = function(_, id, name) registered[id] = name end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 1 and registered['rita-wheeler'] == 'Rita Wheeler' and registered['judy'] == '')
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 1, 'registered once, not every tick')
    chat.setContacts('pack', {{key = 'rita-wheeler-medieval', name = 'Rita of the Keep'}, {key = 'Bad Key', name = 'x'}})
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 2 and registered['rita-wheeler-medieval'] == 'Rita of the Keep' and registered['rita-wheeler'] == 'Rita Wheeler' and not registered['Bad Key'])
    chat.setContacts('pack', nil)
    assert(chat.catalog['rita-wheeler-medieval'] == nil and chat.catalog['rita-wheeler'] == 'rita-wheeler')
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

test('Lua: favorite characters are handed to the game for the Chat list, again only when the favorites change', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const rows = roster.map(({key, name, kind}) => ({key, name, kind}));
  const program = `
    local files = {}
    files['phone-contacts.json'] = ${luaValue(contacts)}
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    io.open = function(path, mode)
      if mode == 'rb' and files[path] then return {read = function() return files[path] end, close = function() end} end
      return nil
    end
    NewObject = function() return {} end
    os.time = function() return 100 end
    -- The favorites module's surface the Chat reads: a revision, the mark, the count and the lookup.
    local starred, revision, reads = {}, 1, 0
    convaiFavorites = {MARK = '* ',
      revision = function() reads = reads + 1; return revision end,
      count = function(scope) local n = 0 for _ in pairs(starred) do n = n + 1 end return n end,
      isFavorite = function(scope, key) return scope == 'characters' and starred[key] == true end}
    local chat = (function() ${adapter} end)()
    chat.configure(${luaValue(rows)}, {profileEnabled = function() return true end}, {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    local favoriteIds, mark, cleared = {}, nil, 0
    local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatClearFavorites = function(_, m) cleared = cleared + 1; favoriteIds = {}; mark = m end,
      ConvaiPhoneChatAddFavorite = function(_, id) favoriteIds[id] = true end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 1 and next(favoriteIds) == nil and mark == '* ', 'no favorites: the list is cleared once and holds none')
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 1, 'nothing changed, nothing sent')
    -- A shipped contact (its own id, mapped to a profile key) and a profile listed by its key.
    starred['judy-alvarez'], starred['rita-wheeler'] = true, true
    revision = 2
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 2 and favoriteIds['judy'] and favoriteIds['rita-wheeler'] and not favoriteIds['panam'], 'the contact ids of the favorite profiles')
    starred['judy-alvarez'] = nil
    revision = 3
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 3 and not favoriteIds['judy'] and favoriteIds['rita-wheeler'], 'a removed favorite goes')
    -- New contacts are registered again: the favorites go with them.
    chat.setContacts('pack', {{key = 'rita-wheeler-medieval', name = 'Rita of the Keep'}})
    for _ = 1, 8 do chat.update(player, 0) end
    assert(cleared == 4 and favoriteIds['rita-wheeler'], 'sent again after the registration')
    -- Older scripts without the methods: asked once, then left alone, and the Chat keeps working.
    convaiFavorites.revision = function() revision = revision + 1; return revision end
    local old = {ConvaiPhoneChatContact = player.ConvaiPhoneChatContact, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = player.ConvaiRequirements}
    for _ = 1, 8 do chat.update(old, 0) end
    assert(chat.favoritesMissing == true)
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

test('redscript: the Chat list orders favorites first by its own comparison, not by how the marked names sort', () => {
  const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds');
  const wrap = tabs.match(/@wrapMethod\(DialerContactDataView\)\s+public func SortItem\([^)]*\) -> Bool \{([\s\S]*?)\n\}/);
  assert.ok(wrap, 'SortItem of the phone list is wrapped');
  assert.match(wrap[1], /first\.convaiChat && second\.convaiChat/, 'only Chat rows are touched');
  assert.match(wrap[1], /NotEquals\(first\.convaiFavorite, second\.convaiFavorite\)[\s\S]*return first\.convaiFavorite;/, 'a favorite goes before a non-favorite');
  assert.match(wrap[1], /return wrappedMethod\(left, right\);/, 'equal groups keep the game\'s own (by name) order');
  assert.equal((tabs.match(/row\.convaiFavorite = this\.m_player\.ConvaiPhoneChatIsFavorite\(/g) || []).length, 2, 'both kinds of Chat row set the flag');
  assert.doesNotMatch(wrap[1], /OnUpdate|GameInstance|Delay/, 'no per-frame or timed work');
});

test('Lua: a favorite turned on or off with F on the Chat list is kept in the favorites and sent back to the game', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const rows = roster.map(({key, name, kind}) => ({key, name, kind}));
  const program = `
    local files = {}
    files['phone-contacts.json'] = ${luaValue(contacts)}
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    io.open = function(path, mode)
      if mode == 'rb' and files[path] then return {read = function() return files[path] end, close = function() end} end
      return nil
    end
    NewObject = function() return {} end
    os.time = function() return 100 end
    -- The favorites module's surface: set(scope, key, on) keeps the change and moves the revision; a full list refuses it.
    local starred, revision, full, sets = {}, 1, false, {}
    convaiFavorites = {MARK = '* ',
      revision = function() return revision end,
      count = function() local n = 0 for _ in pairs(starred) do n = n + 1 end return n end,
      isFavorite = function(scope, key) return scope == 'characters' and starred[key] == true end,
      set = function(scope, key, on)
        sets[#sets + 1] = scope .. ':' .. key .. ':' .. tostring(on)
        if on and full then return false, false, 'full' end
        starred[key] = on or nil; revision = revision + 1; return on, true
      end}
    local chat = (function() ${adapter} end)()
    chat.configure(${luaValue(rows)}, {profileEnabled = function() return true end}, {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    local queue, favoriteIds, cleared = {}, {}, 0
    local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatClearFavorites = function() cleared = cleared + 1; favoriteIds = {} end,
      ConvaiPhoneChatAddFavorite = function(_, id) favoriteIds[id] = true end,
      ConvaiPhoneChatTakeFavoriteRequest = function() return table.remove(queue, 1) or '' end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    for _ = 1, 8 do chat.update(player, 0) end
    assert(sets[1] == nil and cleared == 1, 'no request, nothing kept')
    -- F on a shipped contact (its id maps to a profile key) and on a roster profile listed by its key.
    queue = {'1judy', '1rita-wheeler'}
    for _ = 1, 8 do chat.update(player, 0) end
    assert(sets[1] == 'characters:judy-alvarez:true' and sets[2] == 'characters:rita-wheeler:true', table.concat(sets, ' '))
    assert(starred['judy-alvarez'] and starred['rita-wheeler'])
    assert(favoriteIds['judy'] and favoriteIds['rita-wheeler'] and cleared == 2, 'the whole list is sent back at once, once')
    -- F again turns it off.
    queue = {'0judy'}
    for _ = 1, 8 do chat.update(player, 0) end
    assert(sets[3] == 'characters:judy-alvarez:false' and not starred['judy-alvarez'] and not favoriteIds['judy'] and favoriteIds['rita-wheeler'] and cleared == 3)
    -- A contact the catalog does not know keeps nothing.
    queue = {'1nobody-here'}
    for _ = 1, 8 do chat.update(player, 0) end
    assert(#sets == 3, 'an unknown contact keeps nothing')
    -- A refused change (a full list) is settled by the list sent back: the game takes the favorite out again.
    full = true
    queue = {'1panam'}
    local before = cleared
    for _ = 1, 8 do chat.update(player, 0) end
    assert(#sets == 4 and not starred['panam-palmer'] and cleared == before + 1 and not favoriteIds['panam'], 'a refused favorite is taken back out of the game list')
    -- Older scripts without the method: asked once, then left alone.
    local old = {ConvaiPhoneChatContact = player.ConvaiPhoneChatContact, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatClearFavorites = function() end, ConvaiPhoneChatAddFavorite = function() end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end,
      ConvaiRequirements = player.ConvaiRequirements}
    for _ = 1, 8 do chat.update(old, 0) end
    assert(chat.favoriteRequestsMissing == true)
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

test('redscript: T chats, H calls and F turns the favorite on or off on a keyboard, from key callbacks that act only on the Chat list', () => {
  const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds').split('\r\n').join('\n');
  const chat = read('../r6/scripts/CyberpunkConvai/PhoneChat.reds').split('\r\n').join('\n');
  const handler = /private cb func OnConvaiChatListKey\(evt: ref<KeyInputEvent>\) -> Void \{([^]*?)\n\}\n/.exec(tabs);
  assert.ok(handler, 'the key handler exists');
  const body = handler[1];
  assert.match(body, /EInputAction\.IACT_Press/);
  assert.match(body, /if NotEquals\(this\.m_convaiChatState, ConvaiPhoneChatState\.List\) \{ return; \};/, 'a conversation owns the keyboard: T, H and F are letters there');
  assert.match(body, /Equals\(key, EInputKey\.IK_T\)[^]*?this\.ConvaiOpenChat\(selected, true\)/);
  assert.match(body, /Equals\(key, EInputKey\.IK_H\)[^]*?this\.ConvaiChatListHolocall\(selected\)/);
  assert.match(body, /Equals\(key, EInputKey\.IK_F\)[^]*?ConvaiPhoneChatFavoriteKey\(true\);[^]*?this\.ConvaiChatListFavorite\(selected\)/);
  assert.match(body, /evt\.IsShiftDown\(\) \|\| evt\.IsControlDown\(\) \|\| evt\.IsAltDown\(\)/, 'Ctrl+F and the like are not the keys');
  assert.match(body, /!selected\.convaiChat/, 'only a Chat row');
  for (const key of ['IK_T', 'IK_H', 'IK_F']) assert.match(tabs, new RegExp(`AddTarget\\(ConvaiKeyTarget\\(EInputKey\\.${key}, EInputAction\\.IACT_Press\\)\\)`));
  assert.match(tabs, /if ConvaiKeyTargetsByAction\(\) \{[^]*?IK_T, EInputAction\.IACT_Release[^]*?IK_H, EInputAction\.IACT_Release[^]*?IK_F, EInputAction\.IACT_Release/, 'game 2.31 filters by action: the releases need targets');
  // Registered with the list's inputs and let go with them; stubs without Codeware so the scripts still compile.
  assert.match(tabs, /public func EnableContactsInput\(\) -> Void \{[^]*?this\.ConvaiChatListKeysStart\(\);/);
  assert.match(tabs, /public func DisableContactsInput\(\) -> Void \{\s*this\.ConvaiChatListKeysStop\(\);/);
  assert.match(tabs, /@if\(!ModuleExists\("Codeware"\)\)\s*@addMethod\(NewHudPhoneGameController\)\s*private final func ConvaiChatListKeysStart\(\) -> Void \{\s*\}/);
  assert.match(tabs, /@if\(!ModuleExists\("Codeware"\)\)\s*@addMethod\(NewHudPhoneGameController\)\s*private final func ConvaiChatListKeysStop\(\) -> Void \{\s*\}/);
  // F: the list shows the change at once, the same row stays selected, and Lua keeps it.
  const favorite = /public final func ConvaiChatListFavorite\(contact: wref<ContactData>\) -> Void \{([^]*?)\n\}\n/.exec(tabs)[1];
  assert.match(favorite, /ConvaiPhoneChatSetFavorite\(id, on\)/);
  assert.match(favorite, /this\.ConvaiShowChatContacts\(id\);/);
  assert.match(tabs, /ConvaiShowChatContacts\(opt selectId: String\)[^]*?ConvaiSelectChatContact\(selectId\)/);
  assert.match(chat, /public final func ConvaiPhoneChatSetFavorite\(contact: String, on: Bool\) -> Void \{\s*ArrayRemove\(this\.m_convaiChatFavorites, contact\);\s*if on \{ ArrayPush\(this\.m_convaiChatFavorites, contact\); \};/);
  assert.match(chat, /public final func ConvaiPhoneChatTakeFavoriteRequest\(\) -> String \{/);
  // F is also the game's confirm: the click of the favorite press opens no chat, from the list's action and from a click on the row.
  assert.match(tabs, /Equals\(name, n"click"\) && this\.m_player\.ConvaiPhoneChatFavoriteKeyActive\(\) \{\s*ListenerActionConsumer\.Consume\(consumer\);\s*return true;/);
  assert.match(tabs, /OnConvaiChatContactClick[^]*?ConvaiPhoneChatFavoriteKeyActive\(\)[^]*?evt\.Handle\(\);\s*return true;/);
  // No per-frame or timed work anywhere in it.
  assert.doesNotMatch(body + favorite, /OnUpdate|DelaySystem|Delay\(/);
});

test('redscript: the Chat list hints show T, H and F from the game\'s keyboard art, with the game\'s own favorite star, on a keyboard only', () => {
  const tabs = read('../r6/scripts/CyberpunkConvai/PhoneChatTabs.reds').split('\r\n').join('\n');
  assert.match(tabs, /ConvaiHintBinding\.Glyph\(inkWidgetRef\.Get\(this\.m_acceptButtonWidget\), n"kb_t"\)/, 'the bottom bar\'s Chat hint is T');
  assert.match(tabs, /ConvaiHintBinding\.Glyph\(inkWidgetRef\.Get\(this\.m_action2ButtonWidget\), n"kb_h"\)/, 'the bottom bar\'s Call hint is H');
  assert.match(tabs, /ConvaiHintBinding\.Glyph\(inkWidgetRef\.Get\(this\.m_showAllButtonWidget\), n"kb_f"\)/, 'the bottom bar\'s favorite hint is F');
  assert.match(tabs, /inkTextRef\.SetText\(this\.m_showAllLabel, "Favorite"\);/);
  assert.match(tabs, /ConvaiHintBinding\.Glyph\(inkWidgetRef\.Get\(this\.m_chatInputHint\), n"kb_t"\)/, 'the row\'s chat hint is T');
  assert.match(tabs, /ConvaiHintBinding\.Glyph\(inkWidgetRef\.Get\(this\.m_callInputHint\), n"kb_h"\)/, 'the row\'s call hint is H');
  assert.match(tabs, /ConvaiFavoriteArt\.KeyCap\(n"kb_f"\)/, 'the row has an F hint');
  assert.ok(tabs.includes('ripperdoc\\\\assets\\\\cw_bars_assets.inkatlas'), 'the Ripperdoc\'s favorite star');
  assert.match(tabs, /SetTexturePart\(n"fav_star"\)/);
  assert.match(tabs, /icons_keyboard\.inkatlas/);
  // A pad (the last device used) keeps the game's key boxes and has no favorite hint; the keyboard's boxes are drawn again when the hints go back.
  assert.match(tabs, /let keyboard = !IsDefined\(player\) \|\| player\.PlayerLastUsedKBM\(\);/);
  assert.match(tabs, /\} else \{\s*this\.ConvaiKeyGlyphsRestore\(\);\s*inkWidgetRef\.SetVisible\(this\.m_showAllButtonWidget, false\);/);
  assert.match(tabs, /ConvaiHintBinding\.Redraw\(inkWidgetRef\.Get\(this\.m_acceptButtonWidget\)\);\s*ConvaiHintBinding\.Redraw\(inkWidgetRef\.Get\(this\.m_action2ButtonWidget\)\);\s*ConvaiHintBinding\.Redraw\(inkWidgetRef\.Get\(this\.m_showAllButtonWidget\)\);/);
  assert.match(tabs, /ConvaiRowGlyphsRestore\(\);\s*this\.ConvaiFavoriteCellShow\(false\);/, 'a recycled row of another list gets the game\'s boxes back');
});

function luaValue(value) {
  if (Array.isArray(value)) return `{${value.map(luaValue).join(',')}}`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `[${JSON.stringify(k)}]=${luaValue(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
