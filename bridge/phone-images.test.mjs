import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {buildAtlas, atlasPath, texturePath, KEY_PATTERN} from '../scripts/Build-PhoneImageAtlas.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// A picture in the phone Chat (docs/PHONE_IMAGES.md). The game is not available offline: these check the data (registry, atlas, PNG sizes), the Lua
// that carries a picture on a Chat row, the developer probe and the shape of the redscript. The live check is in docs/PHONE_IMAGES.md.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const registry = JSON.parse(read('../assets/phone-images/images.json'));
const chatLua = read('../mod/phone-chat.lua');
const probeLua = read('../mod/phone-image-probe.lua');
const reds = read('../r6/scripts/CyberpunkConvai/PhoneChat.reds');
const code = reds.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

function pngSize(path) {
  const bytes = readFileSync(new URL(path, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

test('the registry names real PNGs of the stated size, 1024 px or less, with unique safe keys', () => {
  assert.ok(registry.images.length >= 1 && registry.images.length <= 4, 'a small proof archive');
  assert.equal(new Set(registry.images.map(image => image.key)).size, registry.images.length);
  for (const image of registry.images) {
    assert.match(image.key, KEY_PATTERN);
    const size = pngSize('../assets/phone-images/' + image.png);
    assert.deepEqual(size, {width: image.width, height: image.height}, image.png);
    assert.ok(size.width <= 1024 && size.height <= 1024, `${image.png} is larger than 1024 px`);
  }
});

test('each picture gets its own atlas: three identical slots on its own texture, one full-texture part named like the key', () => {
  for (const image of registry.images) {
    const atlas = buildAtlas(registry.folder, image.key).Data.RootChunk;
    assert.equal(atlas.$type, 'inkTextureAtlas');
    assert.equal(atlas.isSingleTextureMode, 1);
    assert.equal(atlas.slots.Elements.length, 3);
    for (const slot of atlas.slots.Elements) {
      assert.equal(slot.texture.DepotPath.$value, texturePath(registry.folder, image.key));
      assert.equal(slot.parts.length, 1);
      assert.equal(slot.parts[0].partName.$value, image.key);
      assert.deepEqual(slot.parts[0].clippingRectInUVCoords, {$type: 'RectF', Bottom: 1, Left: 0, Right: 1, Top: 0});
    }
  }
  assert.equal(atlasPath(registry.folder, 'card_wide'), 'cyberpunk_convai\\phone_images\\card_wide.inkatlas');
  assert.throws(() => buildAtlas(registry.folder, '..\\base\\evil'));
  assert.throws(() => buildAtlas(registry.folder, 'Has Space'));
});

// Runs a Lua program with phone-chat.lua loaded as `chat` and a few stand-ins for the game.
function run(program) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const full = `
    local files = {}
    json = {decode = function(raw) return raw end, encode = function(v) return v end}
    io.open = function(path, mode)
      if mode == 'rb' and files[path] then return {read = function() return files[path] end, close = function() end} end
      return nil
    end
    NewObject = function() return {} end
    os.time = function() return 100 end
    local chat = (function() ${chatLua} end)()
    ${program}
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(full));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(result, lua.LUA_OK, error);
}

test('Lua: only a picture of the mod\'s own folder is accepted, with a sane part and size', () => {
  run(`
    local F = chat.IMAGE_FOLDER
    assert(F == 'cyberpunk_convai\\\\phone_images\\\\')
    local good = chat.cleanImage({atlas = F .. 'card_wide.inkatlas', part = 'card_wide', width = 1024, height = 576.0})
    assert(good and good.atlas == F .. 'card_wide.inkatlas' and good.part == 'card_wide' and good.width == 1024 and good.height == 576)
    assert(chat.cleanImage(nil) == nil and chat.cleanImage('x') == nil and chat.cleanImage({}) == nil)
    for _, bad in ipairs({
      {atlas = 'base\\\\gameplay\\\\gui\\\\x.inkatlas', part = 'x', width = 10, height = 10},
      {atlas = F .. '..\\\\x.inkatlas', part = 'x', width = 10, height = 10},
      {atlas = F .. 'a\\\\b.inkatlas', part = 'x', width = 10, height = 10},
      {atlas = F .. 'Card.inkatlas', part = 'x', width = 10, height = 10},
      {atlas = F .. 'card.xbm', part = 'x', width = 10, height = 10},
      {atlas = F .. 'card.inkatlas', part = 'X Y', width = 10, height = 10},
      {atlas = F .. 'card.inkatlas', part = '', width = 10, height = 10},
      {atlas = F .. 'card.inkatlas', part = 'card', width = 0, height = 10},
      {atlas = F .. 'card.inkatlas', part = 'card', width = 10, height = 5000},
      {atlas = F .. 'card.inkatlas', part = 'card', width = 'wide', height = 10},
      {atlas = 5, part = 'card', width = 10, height = 10},
    }) do assert(chat.cleanImage(bad) == nil, tostring(bad.atlas) .. ' / ' .. tostring(bad.part)) end
  `);
});

test('Lua: a delivered picture is a received row with its picture, a plain row has none, and an unknown contact or a bad picture adds nothing', () => {
  run(`
    chat.catalog = {judy = 'judy-alvarez'}
    local F = chat.IMAGE_FOLDER
    local image = {atlas = F .. 'card_tall.inkatlas', part = 'card_tall', width = 576, height = 1024}
    assert(chat.deliverImage('judy', 'look at this', image) == true)
    local row = chat.history.judy[1]
    assert(row.text == 'look at this' and row.sent == false and row.image.atlas == image.atlas and row.image.height == 1024)
    assert(chat.dirty == true)
    assert(chat.deliverImage('judy', '', image) == true and chat.history.judy[2].text == '')
    assert(chat.deliverImage('nobody', 'x', image) == false)
    assert(chat.deliverImage('judy', 'x', {atlas = 'base\\\\x.inkatlas', part = 'x', width = 1, height = 1}) == false)
    assert(chat.deliverImage('judy', 'x', nil) == false)
    assert(#chat.history.judy == 2)
    -- a line with no picture keeps no picture
    chat.history.judy[#chat.history.judy + 1] = {text = 'plain', sent = true}
    assert(chat.history.judy[3].image == nil)
  `);
});

test('Lua: the chat paint hands the picture to the game on the line, and a plain line carries none', () => {
  const program = `
    local roster = {{key = 'judy-alvarez', name = 'Judy', kind = 'named'}}
    chat.configure(roster, {profileEnabled = function() return true end}, {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    local F = chat.IMAGE_FOLDER
    local presented
    local player = {ConvaiPhoneChatContact = function() return 'judy' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end,
      ConvaiPhoneChatPresent = function(_, contact, lines) presented = lines end,
      ConvaiRequirements = function() return 'codeware codeware-ui codeware-textinput' end}
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    -- The first tick binds the world (and loads the saved chats); the history is set after it.
    for _ = 1, 3 do chat.update(player, 0.2, true) end
    chat.catalog = {judy = 'judy-alvarez'}
    chat.history.judy = {{text = 'hi', sent = true}, {text = 'pic', sent = false,
      image = {atlas = F .. 'card_wide.inkatlas', part = 'card_wide', width = 1024, height = 576}}}
    presented = nil
    chat.dirty = true
    for _ = 1, 4 do chat.update(player, 0.2, true) end
    assert(presented, 'the chat was painted')
    assert(#presented == 2)
    assert(presented[1].imageAtlas == nil and presented[1].imagePart == nil, 'a plain line has no picture')
    assert(presented[2].imageAtlas == F .. 'card_wide.inkatlas' and presented[2].imagePart == 'card_wide'
      and presented[2].imageWidth == 1024 and presented[2].imageHeight == 576)
  `;
  run(program);
});

test('the developer probe sends one picture to the open chat, can be pointed at a contact, and refuses what it does not know', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local chat = {catalog = {judy = 'judy-alvarez', panam = 'panam-palmer'}, history = {}, contact = 'panam', IMAGE_FOLDER = 'cyberpunk_convai\\\\phone_images\\\\'}
    chat.storeReady = function() return true end
    chat.contactFor = function(key) for c, k in pairs(chat.catalog) do if k == key then return c end end end
    chat.deliverImage = function(contact, text, image) chat.sent = {contact = contact, text = text, image = image}; return true end
    convaiPhoneChat = chat
    local probe = (function() ${probeLua} end)()
    local report = probe.run('send:card_wide', {})
    assert(report.sent and report.contact == 'panam' and chat.sent.image.atlas == 'cyberpunk_convai\\\\phone_images\\\\card_wide.inkatlas')
    assert(chat.sent.image.part == 'card_wide' and chat.sent.image.width == 1024 and chat.sent.image.height == 576)
    report = probe.run('send:card_tall:judy-alvarez', {})
    assert(report.sent and report.contact == 'judy' and chat.sent.image.height == 1024)
    report = probe.run('send:card_tall:judy', {})
    assert(report.contact == 'judy')
    chat.contact = ''
    assert(probe.run('send:card_wide', {}).contact == 'judy', 'no open chat: the first contact by id')
    chat.sent = nil
    report = probe.run('send:nope', {})
    assert(report.sent == false and chat.sent == nil)
    assert(probe.run('send:card_wide:stranger', {}).sent == false and chat.sent == nil)
    local listed = probe.run('list', {})
    assert(listed.pictures[1] == 'card_tall' and listed.pictures[2] == 'card_wide' and #listed.contacts == 2)
    assert(not pcall(probe.run, 'boom', {}))
    chat.storeReady = function() return false end
    assert(probe.run('send:card_wide', {}).sent == false)
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

test('the probe pictures are the registry\'s pictures, and the probe is developer only', () => {
  const table = [...probeLua.matchAll(/(\w+) = \{width = (\d+), height = (\d+)\}/g)].map(match => ({key: match[1], width: +match[2], height: +match[3]}));
  assert.deepEqual(table.map(({key, width, height}) => ({key, width, height})).sort((a, b) => a.key.localeCompare(b.key)),
    registry.images.map(({key, width, height}) => ({key, width, height})).sort((a, b) => a.key.localeCompare(b.key)));
  const config = JSON.parse(read('../packaging/release.config.json'));
  assert.ok(config.devOnlyLua.includes('phone-image-probe.lua'), 'not shipped to players');
  const dispatcher = read('../mod/johnny-probe.lua');
  assert.match(dispatcher, /phoneimage = 'phone-image-probe\.lua'/);
  assert.match(dispatcher, /if not manager\.developerMode\(\) then return false end/);
  // Nothing a player runs loads the probe, and no setting or key opens it.
  for (const name of ['init.lua', 'phone-chat.lua', 'manager.lua', 'phone-layout.lua']) {
    assert.doesNotMatch(read('../mod/' + name), /phone-image-probe|phoneimage/, name);
  }
  assert.match(read('../scripts/Send-JohnnyProbe.ps1'), /ValidateSet\([^)]*'phoneimage'/);
});

test('redscript: the row hides the picture slot first, shows a picture only for a line that has one, and sets it once from the line', () => {
  const render = /public final func ConvaiChatRender\(line: ref<ConvaiPhoneChatLine>\) -> Void \{([^]*?)\n\}/.exec(code)?.[1];
  assert.ok(render);
  // Hide first (a recycled row), then the text, then the picture only when both the atlas and the part are given.
  assert.match(render, /^\s*inkImageRef\.SetVisible\(this\.m_image, false\);\s*this\.SetMessageView\(line\.text, line\.sent \? MessageViewType\.Sent : MessageViewType\.Received, ""\);\s*if StrLen\(line\.imageAtlas\) > 0 && StrLen\(line\.imagePart\) > 0 \{ this\.ConvaiChatShowImage\(line\); \};\s*$/);
  const show = /private final func ConvaiChatShowImage\(line: ref<ConvaiPhoneChatLine>\) -> Void \{([^]*?)\n\}/.exec(code)?.[1];
  assert.ok(show);
  assert.match(show, /inkImageRef\.Get\(this\.m_image\) as inkImage/);
  assert.match(show, /image\.SetAtlasResource\(ResRef\.FromString\(line\.imageAtlas\)\);\s*image\.SetTexturePart\(StringToName\(line\.imagePart\)\);/);
  assert.match(show, /MinF\(450\.0 \/ width, 600\.0 \/ height\)/);
  assert.match(show, /image\.SetSize\(new Vector2\(width \* scale, height \* scale\)\);\s*image\.SetVisible\(true\);/);
  // The line class carries the four optional fields, empty by default, and the method carries this mod's prefix.
  for (const field of ['imageAtlas: String', 'imagePart: String', 'imageWidth: Int32', 'imageHeight: Int32']) assert.match(code, new RegExp('public let ' + field));
  assert.match(code, /@addMethod\(MessangerItemRenderer\)\nprivate final func ConvaiChatShowImage/);
  // Built with the row: no per-frame or timer work, no TweakDB record, no game image request.
  assert.doesNotMatch(show, /DelayCallback|DelaySystem|OnUpdate|OnTick|RequestSetImage|TweakDBID|t"/);
});
