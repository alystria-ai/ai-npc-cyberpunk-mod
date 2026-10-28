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

function luaValue(value) {
  if (Array.isArray(value)) return `{${value.map(luaValue).join(',')}}`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `[${JSON.stringify(k)}]=${luaValue(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
