// Characters the player made are in the lists (docs/CHARACTER_EDITOR.md, "Invite and phone"): Characters to invite (the Companion Manager) and the phone's Chat tab, under their own
// names, and a text to one is answered through the text provider. The real manager.lua, companions.lua, custom-characters.lua, phone-chat.lua and the real wiring block of init.lua
// run here against strict fakes of the game; the bridge half is the real PhoneChat class.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {nsuiFixture, run} from './manager-fixture.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {companionEngine} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8').replace(/^﻿/, '');
const initSource = read('init.lua');

// ---- Characters to invite -------------------------------------------------------------------------------------------------------------------------------------------------

test('a character the player made is listed under Characters to invite and invites the model it was made from; the list follows a rename and a delete', () => run(`${nsuiFixture}
  -- The fake of companions.lua is strict: it takes a definition away only when it exists (as the real one does for a custom character only).
  api.unregisterDefinition = function(key) if not defs[key] then return false end defs[key] = nil; return true end
  local shipped = #manager.snapshot(player).profiles
  assert(#manager.snapshot(player).invitable == shipped and manager.snapshot(player).customSignature == '', 'nothing made, nothing changed')
  manager.setCustomCharacters({
    {key = 'custom-ana-aaaa', name = 'Ana', record = 'Character.Ana_Model'},
    {key = 'custom-byname-bbbb', name = 'Byname'},                           -- found by display name only: there is no model to invite
    {key = 'johnny-silverhand', name = 'Spoof', record = 'Character.Spoof'}, -- a shipped key is never taken over
    {key = 'custom-empty-cccc', name = '', record = 'Character.Empty'}})
  local snapshot = manager.snapshot(player)
  assert(#snapshot.profiles == shipped, 'the shipped list is untouched (memory and relationship pages use it)')
  assert(#snapshot.invitable == shipped + 1 and snapshot.invitable[1].key == 'custom-ana-aaaa' and snapshot.invitable[1].custom == true, 'sorted among the others by name')
  local definition = manager.definition('custom-ana-aaaa')
  assert(definition.id == 'Character.Ana_Model' and definition.name == 'Ana' and definition.custom == true, 'the record it was made from')
  assert(definition.profileKey == nil, 'a model-only invitation like the Model browser: the custom profile is applied to the copy afterwards')
  assert(manager.definition('custom-byname-bbbb') == nil and manager.definition('custom-empty-cccc') == nil)
  assert(manager.definition('johnny-silverhand') ~= nil and manager.definition('johnny-silverhand').id ~= 'Character.Spoof')
  local looks = 0
  convaiCustomCharacters = {refresh = function() looks = looks + 1 end}
  assert(invoke('tab:characters').ok)
  assert(looks == 1, 'opening the page looks at the characters file once, so a character made a moment ago is listed')
  local ana = assert(row('invite:custom-ana-aaaa'), 'a row for her')
  assert(ana.label == 'Ana' and ana.value == 'Invite' and not ana.disabled, ana.label .. '/' .. tostring(ana.value))
  assert(ana.description:find('Your own character, made in the character editor.', 1, true) and ana.description:find('Mistral, Local AI or Custom', 1, true))
  assert(not row('invite:custom-byname-bbbb'), 'a character with no record is not in the invite list')
  -- Invite: the copy of that model joins; the profile is none yet (the settle sweep gives it the custom key afterwards).
  assert(invoke('invite:custom-ana-aaaa').ok)
  local queue = managerUi.party()
  queue.flush()
  assert(spawned[#spawned] == 'custom-ana-aaaa' and members[#members].record == 'Character.Ana_Model' and members[#members].profileKey == nil)
  loaded = registered.loadMod()
  assert(row('invite:custom-ana-aaaa').value:find('Add copy', 1, true), 'a second copy can be added')
  -- Renamed: the same key, a new name and a new record; the page follows.
  local before = manager.snapshot(player).customSignature
  manager.setCustomCharacters({{key = 'custom-ana-aaaa', name = 'Anastasia', record = 'Character.Ana_Two'}})
  assert(manager.snapshot(player).customSignature ~= before and manager.definition('custom-ana-aaaa').name == 'Anastasia' and manager.definition('custom-ana-aaaa').id == 'Character.Ana_Two')
  loaded = registered.loadMod()
  assert(row('invite:custom-ana-aaaa').label == 'Anastasia')
  -- Deleted: the row and the definition are gone; a copy already in the party keeps what it was made with.
  manager.setCustomCharacters({})
  assert(manager.definition('custom-ana-aaaa') == nil and #manager.snapshot(player).invitable == shipped and manager.snapshot(player).customSignature == '')
  loaded = registered.loadMod()
  assert(not row('invite:custom-ana-aaaa') and members[#members].record == 'Character.Ana_Model')
  assert(manager.definition('johnny-silverhand') ~= nil, 'a shipped definition is never taken away')
`));

// ---- the wiring in init.lua: the custom service's change feeds the manager and the phone -------------------------------------------------------------------------------------

const wiring = (() => {
  const start = initSource.indexOf('-- Characters the player made (docs/CHARACTER_EDITOR.md, "Your own characters"): mod/custom-characters.lua reads');
  const end = initSource.indexOf('-- Developer-mode frame-cost probe', start);
  assert(start >= 0 && end > start, 'init.lua no longer has the custom characters block');
  return initSource.slice(start, end);
})();

test('init.lua: a character made, renamed or deleted updates the invite list and the Chat contacts, and a Chat is closed while Convai answers', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local customApi = (function() ${read('custom-characters.lua')} end)()
    local supportedProfiles, catalog = {['judy-alvarez'] = true}, {}
    local calls, provider = {}, true
    local characterCatalog = {CLONE_PREFIXES = {'NCA.'}, isCustomKey = function(key) return key:find('^custom%-') ~= nil end}
    TweakDBID = {new = function(record) return '<' .. record .. '>' end}
    -- strict fakes: only what the block uses
    local manager = {textProviderActive = function() return provider end, configureCustom = function(isCustom) calls.custom = isCustom end,
      setCustomCharacters = function(rows) calls[#calls + 1] = {'manager', rows} end}
    local phoneChat = {setContacts = function(group, rows) calls[#calls + 1] = {'phone', group, rows} end}
    local clock, revision, text = 1000, 0, nil
    json = {decode = function() return text end, encode = function() return '' end}
    io.open = function() return {read = function() return 'revision ' .. revision end, close = function() end} end
    function dofile(path) assert(path == 'custom-characters.lua', path); return customApi end
    function convaiSettleCopyProfiles() calls.settled = (calls.settled or 0) + 1 end
    os.time = function() return clock end
    ${wiring}
    assert(convaiCustomCharacters and calls.custom, 'the service is installed')
    local function publish(rows) revision = revision + 1; text = {version = 1, revision = revision, characters = rows}; clock = clock + 10; convaiCustomCharacters.refresh(true) end
    publish({{key = 'custom-ana-aaaa', name = 'Ana', gender = 'female', records = {'NCA.Character.Ana', 'Character.Ana'}, names = {}},
      {key = 'custom-byname-bbbb', name = 'Byname', gender = 'male', records = {}, names = {'Byname'}}})
    local manager_, phone_ = nil, nil
    for _, call in ipairs(calls) do if call[1] == 'manager' then manager_ = call[2] elseif call[1] == 'phone' then phone_ = call end end
    assert(manager_ and #manager_ == 2 and manager_[1].key == 'custom-ana-aaaa' and manager_[1].name == 'Ana', 'the invite list is given every character')
    assert(manager_[1].record == 'Character.Ana', 'the plain record, not the clone, is the one invited')
    assert(manager_[2].key == 'custom-byname-bbbb' and manager_[2].record == nil, 'a display-name-only character has no record')
    assert(phone_[2] == 'custom' and #phone_[3] == 2, 'both are Chat contacts')
    assert(supportedProfiles['custom-ana-aaaa'] and supportedProfiles['judy-alvarez'] and calls.settled == 1)
    -- A Chat is closed while Convai answers, open while a text provider does: asked now, once per call.
    assert(phoneChat.contactBlocked('custom-ana-aaaa') == false)
    provider = false
    assert(phoneChat.contactBlocked('custom-ana-aaaa') == true and phoneChat.contactBlocked('judy-alvarez') == false, 'only their own characters are held back')
    provider = true
    assert(phoneChat.contactBlocked('custom-ana-aaaa') == false)
    -- Renamed, one deleted: the lists follow.
    local count = #calls
    publish({{key = 'custom-ana-aaaa', name = 'Anastasia', gender = 'female', records = {'Character.Ana'}, names = {}}})
    local last = calls[#calls]
    assert(#calls > count and last[1] == 'phone' and #last[3] == 1 and last[3][1].name == 'Anastasia')
    publish({})
    local lastPhone
    for _, call in ipairs(calls) do if call[1] == 'phone' then lastPhone = call end end
    assert(lastPhone[3] == nil, 'no character left: the Chat group is cleared')
    assert(supportedProfiles['custom-ana-aaaa'] == nil)
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
});

// ---- the phone's Chat tab ---------------------------------------------------------------------------------------------------------------------------------------------------

test('init.lua: opening the phone reads the characters of the player again, once per opening, on the edge', () => {
  const edge = initSource.indexOf('if phoneOpen ~= convaiPhoneWasOpen then');
  assert(edge > 0, 'the phone-open edge is in the update');
  const text = initSource.slice(edge, edge + 260);
  assert.match(text, /convaiPhoneWasOpen = phoneOpen\r?\n\s*if phoneOpen and convaiCustomCharacters then pcall\(convaiCustomCharacters\.refresh\) end/);
});

test('Lua: the Chat tab lists them under their own names, texts go to the custom profile, and the Chat is closed while Convai answers', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local files = {}
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    local written = {}
    io.open = function(path, mode)
      if mode == 'rb' then
        if files[path] then return {read = function() return files[path] end, close = function() return true end} end
        return nil
      end
      return {write = function(_, value) written[path] = value; return true end, close = function() return true end}
    end
    os.rename, os.remove = function() return true end, function() return true end
    NewObject = function() return {} end
    os.time = function() return 100 end
    local chat = (function() ${read('phone-chat.lua')} end)()
    local enabled = {['judy-alvarez'] = true, ['custom-ana-aaaa'] = true}
    chat.configure({{key = 'judy-alvarez', name = 'Judy Alvarez', kind = 'named'}}, {profileEnabled = function(key) return enabled[key] == true end},
      {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    local blocked = false
    chat.contactBlocked = function(key) return key == 'custom-ana-aaaa' and blocked end
    local open, registered, presented, submissions = '', {}, {}, {}
    local player = {ConvaiPhoneChatContact = function() return open end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() registered = {} end,
      ConvaiPhoneChatRegisterContact = function(_, id, name) registered[id] = name end,
      ConvaiPhoneChatDraft = function() return nil end,
      ConvaiPhoneChatTakeSubmission = function() return table.remove(submissions, 1) end,
      ConvaiPhoneChatTyping = function() return false end,
      ConvaiPhoneChatPresent = function(_, contact, lines, status, draft, canType) presented[#presented + 1] = {contact = contact, status = status, canType = canType} end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    local function frames() for _ = 1, 8 do chat.update(player, 0) end end
    frames()
    assert(registered['custom-ana-aaaa'] == nil, 'nothing made yet')
    chat.setContacts('custom', {{key = 'custom-ana-aaaa', name = 'Ana'}, {key = 'custom-byname-bbbb', name = 'Byname'}, {key = 'Bad Key', name = 'x'}})
    frames()
    assert(registered['custom-ana-aaaa'] == 'Ana' and registered['custom-byname-bbbb'] == 'Byname' and registered['Bad Key'] == nil, 'the Chat list has them, under their names')
    assert(chat.catalog['custom-ana-aaaa'] == 'custom-ana-aaaa' and chat.contactFor('custom-ana-aaaa') == 'custom-ana-aaaa', 'the contact id is the profile key')
    -- A text provider answers: the chat is open.
    open = 'custom-ana-aaaa'; chat.dirty = true; frames()
    local shown = presented[#presented]
    assert(shown.contact == 'custom-ana-aaaa' and shown.canType == true and shown.status == '', tostring(shown.status))
    submissions[1] = {contact = 'custom-ana-aaaa', text = 'hello Ana'}; frames()
    assert(chat.pending and chat.pending.profileKey == 'custom-ana-aaaa' and chat.pending.contact == 'custom-ana-aaaa', 'the message is sent to her profile: ' .. tostring((chat.errors or {})['custom-ana-aaaa']))
    -- Convai answers: the chat is listed, closed, and says why; a send is refused with the same line.
    chat.pending = nil; blocked = true; chat.dirty = true; frames()
    shown = presented[#presented]
    assert(shown.canType == false and shown.status == 'This character needs Mistral, Local AI or Custom to answer.', tostring(shown.status))
    submissions[1] = {contact = 'custom-ana-aaaa', text = 'anyone there?'}; frames()
    assert(chat.pending == nil and chat.errors['custom-ana-aaaa'] == 'This character needs Mistral, Local AI or Custom to answer.')
    -- A shipped character is never held back by it.
    open = 'judy-alvarez'; chat.dirty = true; frames()
    assert(presented[#presented].contact == 'judy-alvarez' and presented[#presented].canType == true)
    -- Deleted: the contact is gone.
    chat.setContacts('custom', nil); frames()
    assert(registered['custom-ana-aaaa'] == nil and chat.catalog['custom-ana-aaaa'] == nil)
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
});

test('Lua: a Chat row of one of their characters can invite her (J) through the definition the manager registered', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = companionEngine + `
    companions.registerDefinition('custom-ana-aaaa', {id = 'Character.Ana_Model', name = 'Ana', custom = true})
    companions.registerDefinition('plain-model', {id = 'Character.Plain', name = 'Plain'})
    local key, reason, name = companions.phoneContactKey('custom-ana-aaaa')
    assert(key == 'custom-ana-aaaa' and name == 'Ana' and reason == nil, tostring(reason))
    assert(companions.phoneContactKey('plain-model') == nil, 'a definition that is neither a profile nor a custom character is no Chat contact')
    assert(companions.definition('custom-ana-aaaa').custom == true)
    assert(companions.unregisterDefinition('plain-model') == false and companions.definition('plain-model') ~= nil, 'only a custom character\\'s definition can be taken away')
    assert(companions.unregisterDefinition('custom-ana-aaaa') == true and companions.definition('custom-ana-aaaa') == nil)
    assert(companions.unregisterDefinition('custom-ana-aaaa') == false)
  `;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
});

// ---- the bridge: a text to a character the player made ------------------------------------------------------------------------------------------------------------------------

const now = 100000;
const binding = () => ({version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1', campaignId: 'a'.repeat(32),
  branchId: 'b'.repeat(32), branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)});
const request = (contact, text = 'hello') => {
  const saveIdentity = binding();
  return {version: 2, world: 'world-1', updated: now, active: true, saveIdentity, request: {id: 'world-1-1', contact, text, saveIdentity}};
};

test('PhoneChat: a contact whose id is a custom key is answered through the reply hook with no knowledge route, and an unknown or deleted key is refused', async () => {
  const output = [], calls = [], contexts = [];
  const made = new Set(['custom-ana-aaaa']);
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'}, now: () => now, custom: key => made.has(key),
    contextFor: async options => { contexts.push(options.profileKey); return null; },
    reply: async args => { calls.push(args); return {text: 'Hi, V.'}; }, publish: async value => output.push(value)});
  assert.equal(chat.profileFor('custom-ana-aaaa'), 'custom-ana-aaaa');
  assert.equal(chat.profileFor('custom-gone-zzzz'), undefined, 'a deleted character is no contact');
  assert.equal(chat.profileFor('custom-ana-aaaa; rm'), undefined);
  assert.equal(chat.profileFor('judy'), 'judy-alvarez', 'a shipped contact keeps its own id');
  await chat.accept(request('custom-ana-aaaa', 'hello Ana')); await chat.active?.work;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileKey, 'custom-ana-aaaa');
  assert.equal(calls[0].characterId, undefined, 'there is no Convai character');
  assert.equal(calls[0].input.text, 'hello Ana');
  assert.equal(calls[0].input.channel, 'phone');
  assert.deepEqual(contexts, [], 'no Convai knowledge route is asked for');
  assert.deepEqual(output.filter(row => row.state === 'reply').map(row => row.text), ['Hi, V.']);
  // A key that is not (or no longer) a character of the player's is unsupported, as any unknown contact.
  made.clear();
  const again = request('custom-ana-aaaa', 'still there?'); again.request.id = 'world-1-2';
  await chat.accept(again); await chat.active?.work;
  assert.equal(calls.length, 1);
  assert.equal(output.at(-1).state, 'error');
});

test('the bridge: the phone reply hook sends a custom key through the text provider and builds the phone phoneWarm, contacts and hook from the same service', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /contacts: phoneContacts, ids, custom: key => customCharacters\.has\(key\),/);
  assert.match(bridge, /reply: async options => \{\r?\n\s*\/\/[^\n]*\r?\n\s*if \(customCharacters\.has\(options\.profileKey\)\) return customPhoneReply\(options\);\r?\n\s*const prepared = await phoneKnowledge\.preparedFor\(options\);/);
  assert.match(bridge, /async function customPhoneReply\(options\) \{[\s\S]*?!mistral\.active\)[\s\S]*?code: 'custom-provider'[\s\S]*?intrinsicConversationContext\.blocks\(input\)[\s\S]*?mistralHost\.reply\(\{text: input\.text, context: joinedContext\(blocks\), contextParts: contextPartsOf\(blocks\),\s*local: \{profileKey: input\.profileKey, name: profile\.name, channel: 'phone'\}\}, \{signal: options\.signal\}\)/);
  assert.match(bridge, /profileFor: contact => \{ const profile = phone\.profileFor\(contact\); return customCharacters\.has\(profile\) \? undefined : profile; \}/, 'no Convai warm-up for them');
});
