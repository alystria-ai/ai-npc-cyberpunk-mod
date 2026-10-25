import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionModules, flatNavigation, flatSpatial} from './companion-fixture.mjs';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const catalogRaw = readFileSync(new URL('../characters/phone-contacts.json', import.meta.url), 'utf8');
const catalog = JSON.parse(catalogRaw);

// The phone-contact map is the shipped static catalog, not a copy of what the
// journal has unlocked. A contact the game adds during play is therefore mapped
// from session start, before the player can press J or L on it in Contacts.
test('every catalog contact is mapped at registration, independent of journal unlocks', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    local rawCatalog = ${JSON.stringify(JSON.stringify(catalog))}
    local entries = ${luaTable(catalog)}
    local missingRecords = {['Character.muamar_reyes'] = true}
    io.open = function(path)
      if path == 'phone-contacts.json' then return {read = function() return rawCatalog end, close = function() end} end
      return nil
    end
    json = {decode = function(raw) assert(raw == rawCatalog); return entries end}
    Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
    TweakDBID={new=function(v) return v end}
    CName={new=function(v) return v end}
    TweakDB={GetRecord=function(_, id) if missingRecords[id] then return nil end; return {} end}
    NewObject=function() return {} end
    Enum={new=function(_, value) return value end}
    -- Registration may not consult the journal: this trap fails the test if it does.
    local journalReads = 0
    Game={GetJournalManager=function() journalReads = journalReads + 1; error('journal read') end}
    ${companionModules}
    ${flatSpatial}
    ${flatNavigation}
    local companions = (function() ${source} end)()
    local mapped, clears = {}, 0
    local player = {
      ConvaiPhoneClearContacts = function() clears = clears + 1; mapped = {} end,
      ConvaiPhoneRegisterContact = function(_, id, name, reason) mapped[id] = {name = name, reason = reason} end}
    companions.registerPhoneContacts(player)
    assert(clears == 1 and journalReads == 0)
    local count = 0; for _ in pairs(mapped) do count = count + 1 end
    assert(count == #entries, 'every catalog contact id is registered, found ' .. count)
    -- Contacts the game unlocks later (here a quest contact and a fixer) are in the map already.
    for _, id in ipairs({'wakako_okada', 'regina_jones', 'judy'}) do
      assert(mapped[id] and mapped[id].reason == '', id .. ' must be available before it is unlocked')
    end
    -- A contact without a verified model stays mapped, but with its own reason.
    assert(mapped['delamain'] and #mapped['delamain'].reason > 0)
    assert(mapped['muamar_el_capitan_reyes'] and mapped['muamar_el_capitan_reyes'].reason == 'Character unavailable in this game installation.')
    -- Re-registration replaces the map instead of appending to it.
    companions.registerPhoneContacts(player)
    local again = 0; for _ in pairs(mapped) do again = again + 1 end
    assert(clears == 2 and again == count)
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});

function luaTable(value) {
  if (Array.isArray(value)) return `{${value.map(luaTable).join(',')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `[${JSON.stringify(k)}]=${luaTable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('catalog ids are unique so a later unlock cannot shadow an earlier mapping', () => {
  const ids = catalog.map(c => c.contact);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of catalog) {
    assert.ok(entry.unavailable || (entry.key && entry.record), `${entry.contact} needs a model or a reason`);
  }
});

// A Chat row with no journal contact carries its profile key as id; J and L on it invite and dismiss that profile's copy.
test('a Chat row id that is a profile key resolves to that profile, an unknown id still has no mapping', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `
    io.open = function() return nil end
    json = {decode = function() return {} end}
    Vector4={new=function(x,y,z,w) return {x=x,y=y,z=z,w=w} end}
    TweakDBID={new=function(v) return v end}
    CName={new=function(v) return v end}
    Game={GetJournalManager=function() error('journal read') end}
    local missing = {}
    TweakDB={GetRecord=function(_, id) if missing[id] then return nil end; return {} end}
    NewObject=function() return {} end
    Enum={new=function(_, value) return value end}
    ${companionModules}
    ${flatSpatial}
    ${flatNavigation}
    local companions = (function() ${source} end)()
    local key, reason, name = companions.phoneContactKey('judy-alvarez')
    assert(key == 'judy-alvarez' and reason == nil and name == 'Judy Alvarez')
    local none, why = companions.phoneContactKey('nobody-here')
    assert(none == nil and why == 'This contact has no companion mapping yet.')
    missing['Character.Judy'] = true
    local gone, gonewhy = companions.phoneContactKey('judy-alvarez')
    assert(gone == nil and gonewhy == 'Character unavailable in this game installation.')
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
});
